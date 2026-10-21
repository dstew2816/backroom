// Summarises logs/timings.jsonl so you can quote real numbers.
//   npm run timings
import { existsSync, readFileSync } from 'node:fs';

const FILE = 'logs/timings.jsonl';
if (!existsSync(FILE)) {
  console.error('No timings yet. Run an index or a search first.');
  process.exit(1);
}
const rows = readFileSync(FILE, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Record<string, number | string>);

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};
const num = (r: Record<string, number | string>, k: string) => Number(r[k]);

const full = rows.filter((r) => r.kind === 'index' && num(r, 'chunksEmbedded') > 0);
const noop = rows.filter((r) => r.kind === 'index' && num(r, 'chunksEmbedded') === 0);
const searches = rows.filter((r) => r.kind === 'search');
const web = searches.filter((r) => r.via === 'web');

console.log(`Index runs that embedded something: ${full.length}`);
for (const r of full) console.log(`  ${num(r, 'chunksEmbedded')} of ${num(r, 'chunksTotal')} ideas embedded in ${num(r, 'embedMs').toFixed(0)} ms (total ${num(r, 'totalMs').toFixed(0)} ms)`);
if (full.length) {
  const rate = full.map((r) => (num(r, 'chunksEmbedded') / num(r, 'embedMs')) * 1000);
  console.log(`  embedding speed, median: ${median(rate).toFixed(0)} ideas/second`);
}
console.log(`Index runs with nothing to do: ${noop.length}, median ${median(noop.map((r) => num(r, 'totalMs'))).toFixed(0)} ms`);
console.log(`Searches: ${searches.length}`);
if (web.length) {
  console.log(`  web (model already loaded), median: embed ${median(web.map((r) => num(r, 'queryEmbedMs'))).toFixed(1)} ms + score ${median(web.map((r) => num(r, 'scoreMs'))).toFixed(1)} ms over ${num(web.at(-1)!, 'chunksSearched')} ideas`);
}
const cli = searches.filter((r) => r.via !== 'web');
if (cli.length) {
  console.log(`  command line, median: total ${median(cli.map((r) => num(r, 'totalMs'))).toFixed(0)} ms (includes loading the model each run)`);
}
