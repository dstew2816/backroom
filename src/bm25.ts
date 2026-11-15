// Keyword matching (BM25), fully local. Scores how well the exact words of a scene appear in each idea:
// rare words count for more, and a word repeated in a short idea counts for more than in a long one.

const K1 = 1.5;
const B = 0.75;
const STOP = new Set(
  'a an and are as at be but by for from had has have he her his i if in into is it its of on or our she so than that the their them they this to was we were what when where which who will with you your'.split(' '),
);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length > 1 && !STOP.has(t));
}

export class Bm25Index {
  private readonly tf: Map<string, number>[];
  private readonly len: number[];
  private readonly df = new Map<string, number>();
  private readonly avgLen: number;

  constructor(docs: string[]) {
    this.tf = docs.map((d) => {
      const m = new Map<string, number>();
      for (const t of tokenize(d)) m.set(t, (m.get(t) ?? 0) + 1);
      return m;
    });
    this.len = this.tf.map((m) => [...m.values()].reduce((a, b) => a + b, 0));
    for (const m of this.tf) for (const t of m.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.avgLen = this.len.reduce((a, b) => a + b, 0) / (docs.length || 1) || 1;
  }

  /** One score per document, in the order the documents were given. Zero means no query word appears. */
  scores(query: string): number[] {
    const n = this.tf.length;
    const out = new Array<number>(n).fill(0);
    for (const term of new Set(tokenize(query))) {
      const df = this.df.get(term);
      if (!df) continue;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      for (let i = 0; i < n; i++) {
        const f = this.tf[i].get(term);
        if (f) out[i] += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * this.len[i]) / this.avgLen));
      }
    }
    return out;
  }
}

/**
 * Reciprocal rank fusion: each ranking gives an idea 1 / (60 + its rank) points and the points are added.
 * It uses positions rather than raw scores, so cosine similarity and BM25 (different scales) mix fairly.
 * `rankings` are lists of idea positions, best first. Returns all positions seen, best first.
 */
export function fuseRankings(rankings: number[][], k = 60): number[] {
  const points = new Map<number, number>();
  for (const r of rankings) r.forEach((idx, pos) => points.set(idx, (points.get(idx) ?? 0) + 1 / (k + pos + 1)));
  return [...points.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([idx]) => idx);
}

/** Positions of the documents with a non-zero score, best first. */
export function rankByScore(scores: number[]): number[] {
  return scores
    .map((s, i) => [s, i] as const)
    .filter(([s]) => s > 0)
    .sort((a, b) => b[0] - a[0] || a[1] - b[1])
    .map(([, i]) => i);
}
