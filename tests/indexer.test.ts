import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Embedder } from '../src/embed.js';
import { buildIndex, loadIndex } from '../src/indexer.js';

const DIM = 8;
let embeddedTexts: string[] = [];
const fake: Embedder = {
  dim: DIM,
  async embed(texts) {
    embeddedTexts.push(...texts);
    return texts.map((t) => {
      const h = createHash('sha1').update(t).digest();
      return Float32Array.from({ length: DIM }, (_, i) => h[i] / 255);
    });
  },
};
// The real model name is baked into the index; the fake only checks dimensions.

describe('incremental indexing', () => {
  let notes: string;
  let data: string;
  const bump = (file: string) => {
    const t = new Date(Date.now() + 5000 * Math.random() + 5000);
    utimesSync(join(notes, file), t, t);
  };

  beforeAll(() => {
    notes = mkdtempSync(join(tmpdir(), 'backroom-notes-'));
    data = mkdtempSync(join(tmpdir(), 'backroom-data-'));
    mkdirSync(join(notes, 'sub'));
    writeFileSync(join(notes, 'a.md'), '- Test idea about a merchant\n- Test idea about a harbor\n');
    writeFileSync(join(notes, 'sub', 'b.md'), 'Test paragraph about a road.\n');
  });
  afterAll(() => {
    rmSync(notes, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  });

  it('embeds everything on the first run', async () => {
    embeddedTexts = [];
    const s = await buildIndex(notes, data, fake, { logTimings: false });
    expect(s.chunksTotal).toBe(3);
    expect(s.chunksEmbedded).toBe(3);
    const idx = loadIndex(data)!;
    expect(idx.vectors.length).toBe(3 * DIM);
    expect(idx.chunks.map((c) => c.file)).toEqual(['a.md', 'a.md', 'sub/b.md']);
  });

  it('embeds nothing when nothing changed', async () => {
    embeddedTexts = [];
    const s = await buildIndex(notes, data, fake, { logTimings: false });
    expect(s.filesChanged).toBe(0);
    expect(s.chunksEmbedded).toBe(0);
    expect(embeddedTexts).toEqual([]);
  });

  it('re-embeds only the new chunk when one file gains a line', async () => {
    writeFileSync(join(notes, 'a.md'), '- Test idea about a merchant\n- Test idea about a harbor\n- Test idea about a tavern\n');
    bump('a.md');
    embeddedTexts = [];
    const s = await buildIndex(notes, data, fake, { logTimings: false });
    expect(s.filesChanged).toBe(1);
    expect(s.chunksEmbedded).toBe(1);
    expect(embeddedTexts[0]).toContain('tavern');
    expect(s.chunksTotal).toBe(4);
  });

  it('keeps vectors aligned with chunks after changes', async () => {
    const idx = loadIndex(data)!;
    const i = idx.chunks.findIndex((c) => c.body.includes('tavern'));
    const expected = (await fake.embed([idx.chunks[i].context + ': ' + idx.chunks[i].body]))[0];
    expect(Array.from(idx.vectors.subarray(i * DIM, (i + 1) * DIM))).toEqual(Array.from(expected));
  });

  it('drops chunks from deleted files', async () => {
    rmSync(join(notes, 'sub', 'b.md'));
    const s = await buildIndex(notes, data, fake, { logTimings: false });
    expect(s.filesRemoved).toBe(1);
    expect(loadIndex(data)!.chunks.every((c) => c.file === 'a.md')).toBe(true);
  });

  it('never modifies the notes folder', async () => {
    const before = loadIndex(data)!.files['a.md'];
    await buildIndex(notes, data, fake, { logTimings: false });
    expect(loadIndex(data)!.files['a.md']).toEqual(before);
  });
});
