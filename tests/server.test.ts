import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Embedder } from '../src/embed.js';
import { buildIndex } from '../src/indexer.js';
import { createApp } from '../src/server.js';

const DIM = 16;
// Bag-of-words hashing: texts sharing words get similar vectors, so searches are meaningful without the real model.
const fake: Embedder = {
  dim: DIM,
  async embed(texts) {
    return texts.map((t) => {
      const v = new Float32Array(DIM);
      for (const w of t.toLowerCase().match(/[a-z]+/g) ?? []) v[createHash('sha1').update(w).digest()[0] % DIM] += 1;
      const n = Math.hypot(...v) || 1;
      return v.map((x) => x / n);
    });
  },
};

describe('web server', () => {
  let notes: string, data: string, base: string, close: () => void;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

  beforeAll(async () => {
    notes = mkdtempSync(join(tmpdir(), 'backroom-web-notes-'));
    data = mkdtempSync(join(tmpdir(), 'backroom-web-data-'));
    mkdirSync(join(notes, 'places'));
    writeFileSync(join(notes, 'places', 'a.md'), '---\ntags: [harbor]\n---\n- merchant sells rope at the harbor\n- quiet farm far inland\n');
    writeFileSync(join(notes, 'b.md'), '- a stranger asks about the merchant guild\n');
    await buildIndex(notes, data, fake, { logTimings: false });
    const server = createApp({ dataDir: data, embedder: fake, webDir: join(__dirname, '..', 'web'), notesRoot: notes, logTimings: false });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  afterAll(() => {
    close();
    rmSync(notes, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  });

  it('serves the page and status', async () => {
    expect(await (await fetch(base + '/')).text()).toContain('Backroom');
    const s = await (await fetch(base + '/api/status')).json();
    expect(s.ideas).toBe(3);
    expect(s.folders).toEqual(['places']);
    expect(s.tags).toEqual(['harbor']);
  });

  let firstId = '';
  it('searches and ranks the matching idea first', async () => {
    const out = await (await post('/api/search', { scene: 'the merchant at the harbor' })).json();
    expect(out.results[0].text).toContain('merchant sells rope');
    firstId = out.results[0].id;
    expect(out.timing.chunksSearched).toBe(3);
  });
  it('rejects an empty scene', async () => {
    expect((await post('/api/search', { scene: '  ' })).status).toBe(400);
  });
  it('filters by folder', async () => {
    const out = await (await post('/api/search', { scene: 'merchant', folder: 'places' })).json();
    expect(out.results.every((r: { file: string }) => r.file.startsWith('places/'))).toBe(true);
  });
  it('marks used, hides it from unused-only, and undoes', async () => {
    const u = await (await post('/api/used', { id: firstId })).json();
    expect(u.used.count).toBe(1);
    const unusedOnly = await (await post('/api/search', { scene: 'the merchant at the harbor', unusedOnly: true })).json();
    expect(unusedOnly.results.map((r: { id: string }) => r.id)).not.toContain(firstId);
    expect((await (await post('/api/used', { id: firstId, undo: true })).json()).used).toBeNull();
  });
  it('rejects unknown ids', async () => {
    expect((await post('/api/used', { id: 'nope' })).status).toBe(404);
  });
  it('picks up a new note on re-index', async () => {
    writeFileSync(join(notes, 'c.md'), '- the lighthouse keeper owes a debt\n');
    const t = new Date(Date.now() + 10_000);
    utimesSync(join(notes, 'c.md'), t, t);
    const r = await (await post('/api/reindex', {})).json();
    expect(r.stats.chunksEmbedded).toBe(1);
    expect(r.status.ideas).toBe(4);
    const out = await (await post('/api/search', { scene: 'lighthouse keeper' })).json();
    expect(out.results[0].file).toBe('c.md');
  });
  it('refuses cross-origin and non-JSON posts', async () => {
    expect((await post('/api/search', { scene: 'x' }, { Origin: 'http://evil.example' })).status).toBe(403);
    const res = await fetch(base + '/api/search', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
    expect(res.status).toBe(415);
  });
});
