import type { LoadedIndex, IndexedChunk } from './indexer.js';
import type { State, UsedEntry } from './state.js';

export interface SearchOptions {
  k?: number;
  unusedOnly?: boolean;
  /** Match any of these tags (case-insensitive). */
  tags?: string[];
  /** Only notes under this folder (relative to the notes root). */
  folder?: string;
  /** Boost ideas that are unused or haven't come up in a while. */
  stale?: boolean;
  /** Max boost, in cosine units. Default 0.05. */
  staleWeight?: number;
  /** Days of rest after which a used idea counts as fully stale. Default 90. */
  staleDays?: number;
  now?: Date;
}

export interface Result {
  rank: number;
  chunk: IndexedChunk;
  /** Raw cosine similarity between the scene and the idea. */
  cosine: number;
  /** How many standard deviations above the average idea this scene scores. */
  z: number;
  /** 0 (just used) to 1 (never used or long rested). Only affects ranking when stale is on. */
  staleness: number;
  /** cosine plus the stale boost; what the ranking sorts on. */
  score: number;
  used?: UsedEntry;
}

export interface SearchOutput {
  results: Result[];
  /** Mean and standard deviation of the scene's similarity to every idea in the index. */
  distribution: { mean: number; std: number; max: number };
  /**
   * Number of leading results that sit above the largest drop in score,
   * or null if no drop stands out (the top results are not clearly separated).
   */
  clearTop: number | null;
}

/** A drop at least this large (in cosine units) between neighbours counts as a clear separation. */
export const MIN_GAP = 0.04;

export function search(index: LoadedIndex, query: Float32Array, state: State, opts: SearchOptions = {}): SearchOutput {
  const { chunks, vectors, dim } = index;
  const n = chunks.length;
  const now = (opts.now ?? new Date()).getTime();
  const k = opts.k ?? 8;
  const weight = opts.stale ? (opts.staleWeight ?? 0.05) : 0;
  const staleDays = opts.staleDays ?? 90;
  const wantTags = opts.tags?.map((t) => t.toLowerCase().replace(/^#/, ''));
  const folder = opts.folder?.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase();

  // Vectors are unit length, so cosine similarity is a dot product.
  const sims = new Float32Array(n);
  let sum = 0;
  let max = -1;
  for (let i = 0; i < n; i++) {
    let dot = 0;
    const off = i * dim;
    for (let d = 0; d < dim; d++) dot += vectors[off + d] * query[d];
    sims[i] = dot;
    sum += dot;
    if (dot > max) max = dot;
  }
  const mean = n ? sum / n : 0;
  let varSum = 0;
  for (let i = 0; i < n; i++) varSum += (sims[i] - mean) ** 2;
  const std = n ? Math.sqrt(varSum / n) || 1e-9 : 1e-9;

  const scored: Result[] = [];
  for (let i = 0; i < n; i++) {
    const chunk = chunks[i];
    const used = state.used[chunk.id];
    if (opts.unusedOnly && used) continue;
    if (folder && !(chunk.file.toLowerCase() === folder || chunk.file.toLowerCase().startsWith(folder + '/'))) continue;
    if (wantTags?.length && !chunk.tags.some((t) => wantTags.includes(t.toLowerCase()))) continue;

    const staleness = used ? Math.min(1, (now - Date.parse(used.lastUsed)) / 86_400_000 / staleDays) : 1;
    scored.push({
      rank: 0,
      chunk,
      cosine: sims[i],
      z: (sims[i] - mean) / std,
      staleness,
      score: sims[i] + weight * Math.max(0, staleness),
      used,
    });
  }
  scored.sort((a, b) => b.score - a.score);
  const results = scored.slice(0, k);
  results.forEach((r, i) => (r.rank = i + 1));

  return { results, distribution: { mean, std, max }, clearTop: clearTop(results) };
}

/** The JSON shape the web page renders, shared by the local server and the static demo. */
export function toApiResult(r: Result, text: string) {
  return {
    id: r.chunk.id,
    rank: r.rank,
    file: r.chunk.file,
    headings: r.chunk.headings,
    startLine: r.chunk.startLine,
    endLine: r.chunk.endLine,
    text,
    tags: r.chunk.tags,
    cosine: r.cosine,
    z: r.z,
    boost: r.score - r.cosine,
    used: r.used ?? null,
  };
}

/** Looks for the biggest score drop between neighbouring results; returns how many results sit above it. */
export function clearTop(results: Pick<Result, 'score'>[]): number | null {
  let best = 0;
  let at = -1;
  for (let i = 0; i < results.length - 1; i++) {
    const gap = results[i].score - results[i + 1].score;
    if (gap > best) {
      best = gap;
      at = i + 1;
    }
  }
  return best >= MIN_GAP ? at : null;
}
