import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { basename, join } from 'node:path';
import { cleanForEmbedding } from './clean.js';
import type { Embedder } from './embed.js';
import { buildIndex, loadIndex, logTiming, type LoadedIndex } from './indexer.js';
import { search, type SearchOptions } from './search.js';
import { loadState, markUsed, unmarkUsed } from './state.js';

export interface AppOptions {
  dataDir: string;
  embedder: Embedder;
  /** Folder holding index.html. */
  webDir: string;
  /** Where the notes live; needed for the re-index button. */
  notesRoot?: string;
  logTimings?: boolean;
}

const MAX_BODY = 100_000;

export function createApp(opts: AppOptions): Server {
  let index: LoadedIndex | null = loadIndex(opts.dataDir);
  const notesRoot = () => opts.notesRoot ?? index?.notesRoot;

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const readJson = (req: IncomingMessage) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      let size = 0;
      const parts: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new Error('Request too large'));
          req.destroy();
        } else parts.push(c);
      });
      req.on('end', () => {
        try {
          resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {});
        } catch {
          reject(new Error('Invalid JSON'));
        }
      });
      req.on('error', reject);
    });

  const status = () => ({
    ready: index !== null,
    ideas: index?.chunks.length ?? 0,
    notes: index ? Object.keys(index.files).length : 0,
    builtAt: index?.builtAt ?? null,
    vault: notesRoot() ? basename(notesRoot()!) : null,
    folders: index ? folderList(index) : [],
    tags: index ? [...new Set(index.chunks.flatMap((c) => c.tags))].sort((a, b) => a.localeCompare(b)) : [],
    usedCount: Object.keys(loadState(opts.dataDir).used).length,
  });

  async function handleSearch(body: Record<string, unknown>) {
    if (!index) return { error: 'No index yet. Click Re-index.' };
    const scene = String(body.scene ?? '').trim();
    if (!scene) return { error: 'Type a scene first.' };
    const t0 = performance.now();
    const [q] = await opts.embedder.embed([scene]);
    const t1 = performance.now();
    const sOpts: SearchOptions = {
      k: clampInt(body.k, 1, 50, 8),
      unusedOnly: body.unusedOnly === true,
      tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
      folder: typeof body.folder === 'string' && body.folder ? body.folder : undefined,
      stale: body.stale === true,
    };
    const out = search(index, q, loadState(opts.dataDir), sOpts);
    const t2 = performance.now();
    const timing = { queryEmbedMs: t1 - t0, scoreMs: t2 - t1, chunksSearched: index.chunks.length };
    if (opts.logTimings ?? true) logTiming('search', { ...timing, resultCount: out.results.length, via: 'web' });
    return {
      timing,
      distribution: out.distribution,
      clearTop: out.clearTop,
      results: out.results.map((r) => ({
        id: r.chunk.id,
        rank: r.rank,
        file: r.chunk.file,
        headings: r.chunk.headings,
        startLine: r.chunk.startLine,
        endLine: r.chunk.endLine,
        text: cleanForEmbedding(r.chunk.text),
        tags: r.chunk.tags,
        cosine: r.cosine,
        z: r.z,
        boost: r.score - r.cosine,
        used: r.used ?? null,
      })),
    };
  }

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/') {
        const html = readFileSync(join(opts.webDir, 'index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
        return;
      }
      if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found' });

      if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, status());

      if (req.method === 'POST') {
        // Only our own page may call the API: JSON content type, and any Origin must match the Host.
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) return json(res, 403, { error: 'Cross-origin request refused' });
        if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 415, { error: 'JSON only' });
        const body = await readJson(req);

        if (url.pathname === '/api/search') {
          const out = await handleSearch(body);
          return json(res, 'error' in out ? 400 : 200, out);
        }
        if (url.pathname === '/api/used') {
          const id = String(body.id ?? '');
          if (!index?.chunks.some((c) => c.id === id)) return json(res, 404, { error: 'Unknown idea' });
          if (body.undo === true) unmarkUsed(opts.dataDir, id);
          else markUsed(opts.dataDir, id);
          return json(res, 200, { used: loadState(opts.dataDir).used[id] ?? null });
        }
        if (url.pathname === '/api/reindex') {
          const root = notesRoot();
          if (!root || !existsSync(root)) return json(res, 400, { error: 'Notes folder not found. Start with: npm start -- "<notes folder>"' });
          const stats = await buildIndex(root, opts.dataDir, opts.embedder, { logTimings: opts.logTimings });
          index = loadIndex(opts.dataDir);
          return json(res, 200, { stats, status: status() });
        }
      }
      json(res, 404, { error: 'Not found' });
    } catch (e) {
      json(res, 400, { error: e instanceof Error ? e.message : 'Bad request' });
    }
  });
}

function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}

/** Every folder that contains at least one note, including parents ("a", "a/b"). */
function folderList(index: LoadedIndex): string[] {
  const set = new Set<string>();
  for (const f of Object.keys(index.files)) {
    const parts = f.split('/').slice(0, -1);
    for (let i = 1; i <= parts.length; i++) set.add(parts.slice(0, i).join('/'));
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}
