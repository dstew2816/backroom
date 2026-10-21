// Builds or refreshes the search index. Reads the notes folder; writes only to ./data.
//   npm run index -- "<notes folder>"     (the folder is remembered after the first run)
//   npm run index
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { miniLM, modelLoadMs } from '../src/embed.js';
import { buildIndex } from '../src/indexer.js';

const DATA = 'data';
const CONFIG = `${DATA}/config.json`;

const arg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const saved = existsSync(CONFIG) ? (JSON.parse(readFileSync(CONFIG, 'utf8')).notesRoot as string) : undefined;
const root = arg ?? saved;
if (!root) {
  console.error('usage: npm run index -- "<notes folder>"');
  process.exit(1);
}
mkdirSync(DATA, { recursive: true });
writeFileSync(CONFIG, JSON.stringify({ notesRoot: root }, null, 2));

console.log(`Indexing ${root}`);
const s = await buildIndex(root, DATA, miniLM);
const r = (n: number) => `${n.toFixed(0)} ms`;
console.log(`${s.filesTotal} files (${s.filesChanged} changed, ${s.filesRemoved} removed), ${s.chunksTotal} chunks`);
console.log(`embedded ${s.chunksEmbedded}, reused ${s.chunksReused}`);
console.log(`total ${r(s.totalMs)}  |  scan+parse ${r(s.scanParseMs)}  |  embed ${r(s.embedMs)}  |  model load ${r(modelLoadMs())}`);
console.log('timings appended to logs/timings.jsonl');
