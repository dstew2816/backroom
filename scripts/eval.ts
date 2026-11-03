// Evaluation harness: how often does the right idea come back near the top?
//   npm run eval -- --notes <folder> --scenes <scenes.json>
//   options: --work <dir>   where per-design indexes go (default eval/.work/<scenes file name>; keep it git-ignored)
//            --external "Smart Connections=<file.json>"   results from another tool (repeatable), see README
//            --verbose      list scenes where the baseline missed the top 10
//            --json <file>  also write the numbers as JSON
// Each design gets its own index folder, because indexes reuse vectors by text hash.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { miniLM } from '../src/embed.js';
import {
  bm25For,
  embedScenes,
  externalRank,
  formatTable,
  loadSceneSet,
  metrics,
  rankOf,
  rankScene,
  VARIANTS,
  type Row,
} from '../src/eval.js';
import { buildIndex, loadIndex } from '../src/indexer.js';

const { values } = parseArgs({
  options: {
    notes: { type: 'string' },
    scenes: { type: 'string' },
    work: { type: 'string' },
    external: { type: 'string', multiple: true },
    verbose: { type: 'boolean' },
    json: { type: 'string' },
  },
});
if (!values.notes || !values.scenes) {
  console.error('usage: npm run eval -- --notes <folder> --scenes <scenes.json> [--work <dir>] [--external "Name=file.json"] [--verbose] [--json out.json]');
  process.exit(1);
}

const notes = resolve(values.notes);
const set = loadSceneSet(values.scenes);
const work = resolve(values.work ?? join('eval', '.work', basename(values.scenes).replace(/\.json$/i, '')));
mkdirSync(work, { recursive: true });

if (set.publishable === false) {
  console.log('*** NOT PUBLISHABLE: synthetic or private scenes. Use these numbers to test the harness only. Never quote them. ***\n');
}
console.log(`${set.label ?? basename(values.scenes)}: ${set.scenes.length} scenes, notes in ${notes}\n`);

const queryVecs = await embedScenes(miniLM, set.scenes);
const rows: Row[] = [];
const baselineMisses: string[] = [];
const indexes = new Map<string, ReturnType<typeof loadIndex>>();

for (const v of VARIANTS) {
  const key = `chars${v.maxChars ?? 'default'}-${v.headingContext === false ? 'bare' : 'headings'}`;
  if (!indexes.has(key)) {
    const dir = join(work, key);
    const s = await buildIndex(notes, dir, miniLM, { logTimings: false, maxChars: v.maxChars, headingContext: v.headingContext });
    console.error(`index ${key}: ${s.chunksTotal} ideas (${s.chunksEmbedded} newly embedded)`);
    indexes.set(key, loadIndex(dir));
  }
  const index = indexes.get(key)!;
  const bm25 = bm25For(index);
  const ranks = set.scenes.map((sc, i) => rankOf(rankScene(index, v.strategy, sc.scene, queryVecs[i], bm25), sc));
  rows.push({ name: v.name, m: metrics(ranks), ranks });
  if (v === VARIANTS[0]) ranks.forEach((r, i) => (r === null || r > 10) && baselineMisses.push(`  rank ${r ?? 'not found'}: ${set.scenes[i].scene}`));
}

for (const spec of values.external ?? []) {
  const eq = spec.indexOf('=');
  const name = spec.slice(0, eq);
  // File shape: [{ "scene": "<same text as in the scenes file>", "results": ["text or note name of result 1", ...] }, ...]
  const given = JSON.parse(readFileSync(spec.slice(eq + 1), 'utf8')) as { scene: string; results: string[] }[];
  const byScene = new Map(given.map((g) => [g.scene.trim(), g.results]));
  const ranks = set.scenes.map((sc) => externalRank(byScene.get(sc.scene.trim()) ?? [], sc));
  const missing = set.scenes.filter((sc) => !byScene.has(sc.scene.trim())).length;
  if (missing) console.error(`${name}: no results given for ${missing} scene(s); they count as misses.`);
  rows.push({ name: `${name} (top ${Math.max(0, ...given.map((g) => g.results.length))} given)`, m: metrics(ranks), ranks });
}

console.log('\n' + formatTable(rows));
console.log('\nRecall@5 / @10: share of scenes whose expected idea is in the top 5 / 10. MRR: mean of 1 / rank of the expected idea (higher is better; 1.000 = always first).');
console.log('Not found: expected idea missing from the ranking entirely (also counts snippets cut in two by small ideas, and keywords-only scenes sharing no word).');
if (values.verbose) console.log(`\nBaseline missed the top 10:\n${baselineMisses.join('\n') || '  none'}`);
if (values.json) writeFileSync(values.json, JSON.stringify({ label: set.label, publishable: set.publishable ?? true, rows }, null, 1));
