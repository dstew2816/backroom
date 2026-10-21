// Local web page for Backroom.
//   npm start -- "<notes folder>"     first time (the folder is remembered)
//   npm start
// Listens on 127.0.0.1 only. Reads your notes; writes only to ./data and ./logs.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { miniLM, modelLoadMs } from '../src/embed.js';
import { buildIndex } from '../src/indexer.js';
import { createApp } from '../src/server.js';

const DATA = 'data';
const CONFIG = `${DATA}/config.json`;
const PORT = Number(process.env.PORT ?? 5127);

const arg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const saved = existsSync(CONFIG) ? (JSON.parse(readFileSync(CONFIG, 'utf8')).notesRoot as string) : undefined;
const notesRoot = arg ?? saved;
if (!notesRoot) {
  console.error('First run: npm start -- "<notes folder>"');
  process.exit(1);
}
if (!existsSync(notesRoot)) {
  console.error(`Notes folder not found: ${notesRoot}`);
  process.exit(1);
}
mkdirSync(DATA, { recursive: true });
writeFileSync(CONFIG, JSON.stringify({ notesRoot }, null, 2));

console.log('Checking for new or changed notes…');
const s = await buildIndex(notesRoot, DATA, miniLM);
console.log(`${s.chunksTotal} ideas indexed (${s.filesChanged} changed files, ${s.chunksEmbedded} new) in ${s.totalMs.toFixed(0)} ms`);
await miniLM.embed(['warm up']);
console.log(`model ready (${modelLoadMs().toFixed(0)} ms)`);

const server = createApp({
  dataDir: DATA,
  embedder: miniLM,
  webDir: fileURLToPath(new URL('../web/', import.meta.url)),
  notesRoot,
});
server.listen(PORT, '127.0.0.1', () => console.log(`\nBackroom is running: http://127.0.0.1:${PORT}\nPress Ctrl+C to stop.`));
