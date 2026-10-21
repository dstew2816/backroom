// Read-only preview of how a notes folder gets chunked.
//   npm run chunks -- "<notes folder>"          summary + the first few chunks per file
//   npm run chunks -- "<notes folder>" --all    every chunk
// The full dump is also written to data/chunks-preview.json (git-ignored).
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseNoteFile, scanFolder } from '../src/scan.js';

const args = process.argv.slice(2);
const root = args.find((a) => !a.startsWith('--'));
const all = args.includes('--all');
if (!root) {
  console.error('usage: npm run chunks -- "<notes folder>" [--all]');
  process.exit(1);
}

const t0 = performance.now();
const files = scanFolder(root);
const notes = files.map(parseNoteFile);
const ms = performance.now() - t0;

const clip = (s: string, n = 90) => (s.replace(/\s+/g, ' ').length > n ? s.replace(/\s+/g, ' ').slice(0, n - 1) + '…' : s.replace(/\s+/g, ' '));

let total = 0;
for (const note of notes) {
  total += note.chunks.length;
  console.log(`\n${note.file}  (${note.chunks.length} chunks${note.tags.length ? `, tags: ${note.tags.join(', ')}` : ''})`);
  for (const c of all ? note.chunks : note.chunks.slice(0, 4)) {
    console.log(`  L${c.startLine}${c.endLine !== c.startLine ? `-${c.endLine}` : ''} [${c.kind}] ${clip(c.text)}`);
  }
  if (!all && note.chunks.length > 4) console.log(`  … ${note.chunks.length - 4} more`);
}

const lens = notes.flatMap((n) => n.chunks.map((c) => c.body.length)).sort((a, b) => a - b);
console.log(`\n${files.length} files, ${total} chunks in ${ms.toFixed(1)} ms`);
if (lens.length) console.log(`chunk length (chars): min ${lens[0]}, median ${lens[Math.floor(lens.length / 2)]}, max ${lens.at(-1)}`);

mkdirSync('data', { recursive: true });
writeFileSync('data/chunks-preview.json', JSON.stringify(notes, null, 1));
console.log('full dump: data/chunks-preview.json');
