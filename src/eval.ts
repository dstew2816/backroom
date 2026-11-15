// Evaluation harness logic: does the right idea come back near the top for a scene?
// An "expected idea" is named by file + a distinctive snippet of its text (see README, "Evaluation").
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { Bm25Index, fuseRankings, rankByScore } from './bm25.js';
import { cleanForEmbedding } from './clean.js';
import type { Embedder } from './embed.js';
import type { IndexedChunk, IndexOptions, LoadedIndex } from './indexer.js';
import { search } from './search.js';

export interface Scene {
  scene: string;
  /** Optional: the note the idea lives in (path relative to the notes folder). Narrows the match. */
  file?: string;
  /** A distinctive snippet of the expected idea's text. Any one of several snippets counts. */
  expect: string | string[];
}

export interface SceneSet {
  label?: string;
  /** false marks synthetic or private sets: the CLI prints a "do not publish" banner. */
  publishable?: boolean;
  scenes: Scene[];
}

export function loadSceneSet(path: string): SceneSet {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Scene[] | SceneSet;
  const set: SceneSet = Array.isArray(raw) ? { scenes: raw } : raw;
  for (const [i, s] of set.scenes.entries()) {
    const snippets = [s.expect].flat();
    if (!s.scene?.trim() || !snippets.length || snippets.some((t) => !t?.trim())) {
      throw new Error(`Scene ${i + 1} needs a "scene" and a non-empty "expect" snippet.`);
    }
  }
  return set;
}

const norm = (s: string) => cleanForEmbedding(s).toLowerCase().replace(/\s+/g, ' ').trim();
const slash = (s: string) => s.replace(/\\/g, '/').toLowerCase();

/** The idea (or a fragment of it, when chunks are small) that contains one of the expected snippets. */
export function isExpected(chunk: Pick<IndexedChunk, 'file' | 'body'>, scene: Scene): boolean {
  if (scene.file && slash(chunk.file) !== slash(scene.file)) return false;
  const body = norm(chunk.body);
  return [scene.expect].flat().some((s) => body.includes(norm(s)));
}

/** 1-based rank of the first expected idea in `ranked`, or null if it is not there. */
export function rankOf(ranked: Pick<IndexedChunk, 'file' | 'body'>[], scene: Scene): number | null {
  const i = ranked.findIndex((c) => isExpected(c, scene));
  return i < 0 ? null : i + 1;
}

/** For results from another tool (for example Smart Connections): text of each result, best first. */
export function externalRank(results: string[], scene: Scene): number | null {
  const stem = scene.file ? basename(scene.file).replace(/\.md$/i, '').toLowerCase() : null;
  const snippets = [scene.expect].flat().map(norm);
  const i = results.findIndex((r) => {
    const n = norm(r);
    return snippets.some((s) => n.includes(s)) || (stem !== null && n === stem);
  });
  return i < 0 ? null : i + 1;
}

export interface Metrics {
  n: number;
  recall5: number;
  recall10: number;
  mrr: number;
  /** Scenes whose expected idea was not found anywhere in the ranking. */
  notFound: number;
}

/** Recall at k = share of scenes whose idea is in the top k. MRR = mean of 1/rank (0 when not found). */
export function metrics(ranks: (number | null)[]): Metrics {
  const n = ranks.length;
  const within = (k: number) => ranks.filter((r) => r !== null && r <= k).length / (n || 1);
  return {
    n,
    recall5: within(5),
    recall10: within(10),
    mrr: ranks.reduce<number>((s, r) => s + (r ? 1 / r : 0), 0) / (n || 1),
    notFound: ranks.filter((r) => r === null).length,
  };
}

export type Strategy = 'dense' | 'keyword' | 'hybrid';

export interface Variant extends IndexOptions {
  name: string;
  strategy: Strategy;
}

/** The baseline first, then one change at a time. */
export const VARIANTS: Variant[] = [
  { name: 'baseline (900 chars, headings, meaning)', strategy: 'dense' },
  { name: 'ideas up to 300 chars', maxChars: 300, strategy: 'dense' },
  { name: 'ideas up to 600 chars', maxChars: 600, strategy: 'dense' },
  { name: 'ideas up to 1500 chars', maxChars: 1500, strategy: 'dense' },
  { name: 'no heading context', headingContext: false, strategy: 'dense' },
  { name: 'keywords only (BM25)', strategy: 'keyword' },
  { name: 'meaning + keywords (hybrid)', strategy: 'hybrid' },
];

const emptyState = { version: 1, used: {} } as const;

/** Every idea in the index, best first, using the same search code as the app. `queryVec` is the embedded scene. */
export function rankScene(index: LoadedIndex, strategy: Strategy, scene: string, queryVec: Float32Array, bm25: Bm25Index): IndexedChunk[] {
  const byPos = index.chunks;
  const keyword = rankByScore(bm25.scores(scene));
  if (strategy === 'keyword') return keyword.map((i) => byPos[i]);

  const dense = search(index, queryVec, emptyState as never, { k: byPos.length }).results.map((r) => r.chunk);
  if (strategy === 'dense') return dense;

  const pos = new Map(byPos.map((c, i) => [c.id, i]));
  return fuseRankings([dense.map((c) => pos.get(c.id)!), keyword]).map((i) => byPos[i]);
}

/** BM25 reads the same text the embedding model sees: note title, headings, then the idea. */
export const bm25For = (index: LoadedIndex) => new Bm25Index(index.chunks.map((c) => `${c.context} ${c.body}`));

export async function embedScenes(embedder: Embedder, scenes: Scene[]): Promise<Float32Array[]> {
  return embedder.embed(scenes.map((s) => s.scene));
}

export interface Row {
  name: string;
  m: Metrics;
  ranks: (number | null)[];
}

export function formatTable(rows: Row[]): string {
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
  const head = ['Design', 'Recall@5', 'Recall@10', 'MRR', 'Not found'];
  const body = rows.map((r) => [r.name, pct(r.m.recall5), pct(r.m.recall10), r.m.mrr.toFixed(3), `${r.m.notFound}/${r.m.n}`]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(w[i]) : c.padStart(w[i]))).join('  ');
  return [line(head), w.map((x) => '-'.repeat(x)).join('  '), ...body.map(line)].join('\n');
}
