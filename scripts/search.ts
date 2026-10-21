// Scene search from the command line.
//   npm run search -- "two party members split off and are hiding in the highlands"
//   options: -n 8   --unused   --tag <t> (repeatable)   --folder <path>   --stale   --stale-weight 0.05   --reindex   --json
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { cleanForEmbedding } from '../src/clean.js';
import { miniLM, modelLoadMs } from '../src/embed.js';
import { buildIndex, loadIndex, logTiming } from '../src/indexer.js';
import { search } from '../src/search.js';
import { loadState } from '../src/state.js';

const DATA = 'data';
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    n: { type: 'string', short: 'n' },
    unused: { type: 'boolean' },
    tag: { type: 'string', multiple: true },
    folder: { type: 'string' },
    stale: { type: 'boolean' },
    'stale-weight': { type: 'string' },
    reindex: { type: 'boolean' },
    json: { type: 'boolean' },
  },
});

const scene = positionals.join(' ').trim();
if (!scene) {
  console.error('usage: npm run search -- "<the current scene>" [-n 8] [--unused] [--tag t] [--folder path] [--stale] [--reindex]');
  process.exit(1);
}

const t0 = performance.now();
if (values.reindex) {
  const cfg = existsSync(`${DATA}/config.json`) ? JSON.parse(readFileSync(`${DATA}/config.json`, 'utf8')) : null;
  if (!cfg?.notesRoot) {
    console.error('No notes folder saved yet. Run: npm run index -- "<notes folder>"');
    process.exit(1);
  }
  const s = await buildIndex(cfg.notesRoot, DATA, miniLM);
  console.error(`re-indexed: ${s.filesChanged} changed files, ${s.chunksEmbedded} new chunks, ${s.totalMs.toFixed(0)} ms`);
}

const index = loadIndex(DATA);
if (!index) {
  console.error('No index yet. Run: npm run index -- "<notes folder>"');
  process.exit(1);
}
const state = loadState(DATA);
const tLoad = performance.now();

const [qvec] = await miniLM.embed([scene]);
const tEmbed = performance.now();

const out = search(index, qvec, state, {
  k: values.n ? Number(values.n) : 8,
  unusedOnly: values.unused,
  tags: values.tag,
  folder: values.folder,
  stale: values.stale,
  staleWeight: values['stale-weight'] ? Number(values['stale-weight']) : undefined,
});
const tDone = performance.now();

const timing = {
  indexLoadMs: tLoad - t0,
  modelLoadMs: modelLoadMs(),
  queryEmbedMs: tEmbed - tLoad - modelLoadMs(),
  scoreMs: tDone - tEmbed,
  totalMs: tDone - t0,
  chunksSearched: index.chunks.length,
};
logTiming('search', { ...timing, resultCount: out.results.length });

mkdirSync(DATA, { recursive: true });
writeFileSync(`${DATA}/last-search.json`, JSON.stringify(out.results.map((r) => r.chunk.id)));

if (values.json) {
  console.log(JSON.stringify({ scene, distribution: out.distribution, clearTop: out.clearTop, timing, results: out.results.map((r) => ({ ...r, chunk: { ...r.chunk } })) }, null, 1));
  process.exit(0);
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
const { mean, std } = out.distribution;
console.log(`\nScene: ${scene}`);
console.log(`Typical idea scores ${mean.toFixed(2)} (±${std.toFixed(2)}); "z" = how far above typical a match is.\n`);

if (!out.results.length) console.log('No ideas match those filters.');
for (const r of out.results) {
  if (out.clearTop !== null && r.rank === out.clearTop + 1) console.log('   ───────── clear drop in relevance ─────────\n');
  const c = r.chunk;
  const where = [c.file.replace(/\.md$/i, ''), c.headings.length ? c.headings.join(' › ') : null].filter(Boolean).join(' › ');
  const lines = c.endLine > c.startLine ? `L${c.startLine}-${c.endLine}` : `L${c.startLine}`;
  const badge = r.used ? `  ✓ used ${r.used.lastUsed.slice(0, 10)}${r.used.count > 1 ? ` (×${r.used.count})` : ''}` : '';
  console.log(`${String(r.rank).padStart(2)}. z ${r.z.toFixed(1)}  cos ${r.cosine.toFixed(2)}${values.stale ? `  boost +${(r.score - r.cosine).toFixed(3)}` : ''}${badge}`);
  console.log(`    ${where}  (${lines})`);
  console.log(`    ${clip(cleanForEmbedding(c.text), 240)}\n`);
}
if (out.results.length && out.clearTop === null) console.log('Note: no clear drop in relevance among these results.\n');
console.log(`searched ${index.chunks.length} ideas: query embed ${timing.queryEmbedMs.toFixed(0)} ms, scoring ${timing.scoreMs.toFixed(1)} ms` +
  (modelLoadMs() ? ` (+ ${timing.modelLoadMs.toFixed(0)} ms one-time model load for this command)` : ''));
console.log('Mark one used: npm run used -- <number above>');
