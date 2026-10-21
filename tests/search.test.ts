import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { IndexedChunk, LoadedIndex } from '../src/indexer.js';
import { clearTop, search } from '../src/search.js';
import { loadState, markUsed, unmarkUsed, type State } from '../src/state.js';

const unit = (...v: number[]) => {
  const norm = Math.hypot(...v);
  return Float32Array.from(v.map((x) => x / norm));
};

function makeIndex(items: { id: string; file: string; tags?: string[]; vec: number[] }[]): LoadedIndex {
  const dim = items[0].vec.length;
  const vectors = new Float32Array(items.length * dim);
  items.forEach((it, i) => vectors.set(unit(...it.vec), i * dim));
  return {
    version: 1,
    model: 'x',
    dtype: 'q8',
    dim,
    notesRoot: '/n',
    builtAt: '',
    files: {},
    vectors,
    chunks: items.map(
      (it) =>
        ({ id: it.id, file: it.file, tags: it.tags ?? [], startLine: 1, endLine: 1, kind: 'bullet', headings: [], text: it.id, context: '', body: it.id, textHash: it.id }) as IndexedChunk,
    ),
  };
}

const empty: State = { version: 1, used: {} };
const q = unit(1, 0);

const index = makeIndex([
  { id: 'near', file: 'world/a.md', tags: ['place'], vec: [1, 0.1] },
  { id: 'mid', file: 'world/b.md', tags: ['npc'], vec: [1, 1] },
  { id: 'far', file: 'plot/c.md', vec: [0, 1] },
  { id: 'far2', file: 'plot/d.md', vec: [0.1, 1] },
]);

describe('search', () => {
  it('ranks by cosine similarity', () => {
    const { results } = search(index, q, empty);
    expect(results.map((r) => r.chunk.id)).toEqual(['near', 'mid', 'far2', 'far']);
    expect(results[0].cosine).toBeGreaterThan(results[1].cosine);
    expect(results[0].z).toBeGreaterThan(0);
  });
  it('respects k', () => {
    expect(search(index, q, empty, { k: 2 }).results).toHaveLength(2);
  });
  it('filters by folder and tag without changing scores', () => {
    const all = search(index, q, empty).results.find((r) => r.chunk.id === 'mid')!;
    const byFolder = search(index, q, empty, { folder: 'plot' });
    expect(byFolder.results.map((r) => r.chunk.id).sort()).toEqual(['far', 'far2']);
    const byTag = search(index, q, empty, { tags: ['#NPC'] });
    expect(byTag.results.map((r) => r.chunk.id)).toEqual(['mid']);
    expect(byTag.results[0].z).toBeCloseTo(all.z, 6);
  });
  it('unused-only drops used ideas', () => {
    const state: State = { version: 1, used: { near: { lastUsed: new Date().toISOString(), count: 1 } } };
    const ids = search(index, q, state, { unusedOnly: true }).results.map((r) => r.chunk.id);
    expect(ids).not.toContain('near');
    expect(search(index, q, state).results[0].used?.count).toBe(1);
  });
  it('stale nudge lifts never-used ideas above recently used ones', () => {
    const now = new Date('2026-06-01T00:00:00Z');
    const state: State = { version: 1, used: { near: { lastUsed: now.toISOString(), count: 1 } } };
    const off = search(index, q, state, { now }).results.map((r) => r.chunk.id);
    const on = search(index, q, state, { now, stale: true, staleWeight: 0.5 }).results.map((r) => r.chunk.id);
    expect(off[0]).toBe('near');
    expect(on[0]).not.toBe('near');
  });
  it('a used idea regains its boost as time passes', () => {
    const used = new Date('2026-01-01T00:00:00Z').toISOString();
    const state: State = { version: 1, used: { near: { lastUsed: used, count: 1 } } };
    const soon = search(index, q, state, { stale: true, now: new Date('2026-01-02T00:00:00Z') }).results.find((r) => r.chunk.id === 'near')!;
    const later = search(index, q, state, { stale: true, now: new Date('2026-08-01T00:00:00Z') }).results.find((r) => r.chunk.id === 'near')!;
    expect(soon.staleness).toBeLessThan(0.05);
    expect(later.staleness).toBe(1);
  });
  it('does not boost when the nudge is off', () => {
    const r = search(index, q, empty).results[0];
    expect(r.score).toBe(r.cosine);
  });
});

describe('clearTop', () => {
  it('finds the biggest drop', () => {
    expect(clearTop([{ score: 0.6 }, { score: 0.58 }, { score: 0.4 }, { score: 0.39 }])).toBe(2);
  });
  it('returns null when scores are bunched', () => {
    expect(clearTop([{ score: 0.5 }, { score: 0.49 }, { score: 0.48 }, { score: 0.47 }])).toBeNull();
  });
});

describe('state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'backroom-state-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('marks, counts and unmarks', () => {
    expect(loadState(dir).used).toEqual({});
    markUsed(dir, 'x', new Date('2026-01-01T00:00:00Z'));
    expect(markUsed(dir, 'x', new Date('2026-02-01T00:00:00Z')).count).toBe(2);
    expect(loadState(dir).used.x.lastUsed).toBe('2026-02-01T00:00:00.000Z');
    expect(unmarkUsed(dir, 'x')).toBe(true);
    expect(unmarkUsed(dir, 'x')).toBe(false);
    expect(loadState(dir).used).toEqual({});
  });
});
