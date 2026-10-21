import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chunkNote } from './chunk.js';
import { embedTextFor, MODEL_DTYPE, MODEL_ID, type Embedder } from './embed.js';
import { scanFolder } from './scan.js';
import type { Chunk } from './types.js';

const FORMAT_VERSION = 1;

export interface IndexedChunk extends Chunk {
  /** Hash of the exact text that was embedded; lets edited files reuse vectors for unchanged chunks. */
  textHash: string;
}

interface FileEntry {
  hash: string;
  mtimeMs: number;
  size: number;
}

interface IndexFile {
  version: number;
  model: string;
  dtype: string;
  dim: number;
  notesRoot: string;
  builtAt: string;
  files: Record<string, FileEntry>;
  chunks: IndexedChunk[];
}

export interface LoadedIndex extends IndexFile {
  /** One row per entry in `chunks`, same order. */
  vectors: Float32Array;
}

export interface IndexStats {
  filesTotal: number;
  filesChanged: number;
  filesRemoved: number;
  chunksTotal: number;
  chunksEmbedded: number;
  chunksReused: number;
  totalMs: number;
  scanParseMs: number;
  embedMs: number;
}

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

export function loadIndex(dataDir: string): LoadedIndex | null {
  const metaPath = join(dataDir, 'index.json');
  const vecPath = join(dataDir, 'vectors.bin');
  if (!existsSync(metaPath) || !existsSync(vecPath)) return null;
  const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as IndexFile;
  if (meta.version !== FORMAT_VERSION) return null;
  const buf = readFileSync(vecPath);
  const vectors = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  if (vectors.length !== meta.chunks.length * meta.dim) return null;
  return { ...meta, vectors };
}

function saveIndex(dataDir: string, meta: IndexFile, vectors: Float32Array): void {
  mkdirSync(dataDir, { recursive: true });
  // Write to temp files then rename, so a crash mid-write can't leave a half-built index.
  const metaTmp = join(dataDir, 'index.json.tmp');
  const vecTmp = join(dataDir, 'vectors.bin.tmp');
  writeFileSync(vecTmp, Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength));
  writeFileSync(metaTmp, JSON.stringify(meta));
  renameSync(vecTmp, join(dataDir, 'vectors.bin'));
  renameSync(metaTmp, join(dataDir, 'index.json'));
}

/**
 * Re-indexes `notesRoot` into `dataDir`. Reads notes, never writes to them.
 * Only files whose content changed are re-chunked, and only chunks whose embedded text is new are re-embedded.
 */
export async function buildIndex(
  notesRoot: string,
  dataDir: string,
  embedder: Embedder,
  opts: { logTimings?: boolean } = {},
): Promise<IndexStats> {
  const t0 = performance.now();
  const prev = loadIndex(dataDir);
  const compatible =
    prev && prev.model === MODEL_ID && prev.dtype === MODEL_DTYPE && prev.dim === embedder.dim && prev.notesRoot === notesRoot;
  const old = compatible ? prev : null;

  const oldByFile = new Map<string, IndexedChunk[]>();
  const oldVec = new Map<string, Float32Array>();
  if (old) {
    old.chunks.forEach((c, i) => {
      (oldByFile.get(c.file) ?? oldByFile.set(c.file, []).get(c.file)!).push(c);
      oldVec.set(c.textHash, old.vectors.subarray(i * old.dim, (i + 1) * old.dim));
    });
  }

  const files = scanFolder(notesRoot);
  const fileEntries: Record<string, FileEntry> = {};
  const chunks: IndexedChunk[] = [];
  const rows: (Float32Array | null)[] = [];
  const toEmbed: { row: number; text: string }[] = [];
  let filesChanged = 0;

  for (const f of files) {
    const prevEntry = old?.files[f.file];
    // Cheap check first: unchanged size + mtime means unchanged content.
    if (prevEntry && prevEntry.mtimeMs === f.mtimeMs && prevEntry.size === f.size) {
      fileEntries[f.file] = prevEntry;
      for (const c of oldByFile.get(f.file) ?? []) {
        chunks.push(c);
        rows.push(oldVec.get(c.textHash)!);
      }
      continue;
    }
    const content = readFileSync(f.abs, 'utf8');
    const hash = sha1(content);
    fileEntries[f.file] = { hash, mtimeMs: f.mtimeMs, size: f.size };
    if (prevEntry && prevEntry.hash === hash) {
      for (const c of oldByFile.get(f.file) ?? []) {
        chunks.push(c);
        rows.push(oldVec.get(c.textHash)!);
      }
      continue;
    }
    filesChanged++;
    for (const c of chunkNote(f.file, content).chunks) {
      const text = embedTextFor(c);
      const textHash = sha1(text);
      chunks.push({ ...c, textHash });
      const cached = oldVec.get(textHash) ?? null;
      rows.push(cached);
      if (!cached) toEmbed.push({ row: rows.length - 1, text });
    }
  }
  const scanParseMs = performance.now() - t0;

  // Identical text appearing twice should only be embedded once.
  const unique = new Map<string, number[]>();
  for (const e of toEmbed) (unique.get(e.text) ?? unique.set(e.text, []).get(e.text)!).push(e.row);

  const te = performance.now();
  if (unique.size) {
    const texts = [...unique.keys()];
    const vecs = await embedder.embed(texts);
    texts.forEach((t, i) => unique.get(t)!.forEach((row) => (rows[row] = vecs[i])));
  }
  const embedMs = performance.now() - te;

  const dim = embedder.dim;
  const vectors = new Float32Array(chunks.length * dim);
  rows.forEach((v, i) => vectors.set(v!, i * dim));

  const present = new Set(files.map((f) => f.file));
  const filesRemoved = old ? Object.keys(old.files).filter((f) => !present.has(f)).length : 0;

  saveIndex(
    dataDir,
    {
      version: FORMAT_VERSION,
      model: MODEL_ID,
      dtype: MODEL_DTYPE,
      dim,
      notesRoot,
      builtAt: new Date().toISOString(),
      files: fileEntries,
      chunks,
    },
    vectors,
  );

  const stats: IndexStats = {
    filesTotal: files.length,
    filesChanged,
    filesRemoved,
    chunksTotal: chunks.length,
    chunksEmbedded: toEmbed.length,
    chunksReused: chunks.length - toEmbed.length,
    totalMs: performance.now() - t0,
    scanParseMs,
    embedMs,
  };
  if (opts.logTimings ?? true) logTiming('index', stats);
  return stats;
}

export function logTiming(kind: string, data: object): void {
  mkdirSync('logs', { recursive: true });
  appendFileSync('logs/timings.jsonl', JSON.stringify({ at: new Date().toISOString(), kind, ...data }) + '\n');
}
