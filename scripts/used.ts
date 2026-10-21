// Mark an idea as used (stored in data/state.json, never in your notes).
//   npm run used -- 2            the #2 result from your last search
//   npm run used -- 2 --undo
//   npm run used -- "<chunk id>"
import { existsSync, readFileSync } from 'node:fs';
import { loadIndex } from '../src/indexer.js';
import { markUsed, unmarkUsed } from '../src/state.js';

const DATA = 'data';
const args = process.argv.slice(2);
const undo = args.includes('--undo');
const ref = args.find((a) => !a.startsWith('--'));
if (!ref) {
  console.error('usage: npm run used -- <result number | chunk id> [--undo]');
  process.exit(1);
}

let id = ref;
if (/^\d+$/.test(ref)) {
  const last = existsSync(`${DATA}/last-search.json`) ? (JSON.parse(readFileSync(`${DATA}/last-search.json`, 'utf8')) as string[]) : [];
  id = last[Number(ref) - 1];
  if (!id) {
    console.error(`No result #${ref} in your last search.`);
    process.exit(1);
  }
}

const chunk = loadIndex(DATA)?.chunks.find((c) => c.id === id);
if (!chunk) {
  console.error(`No idea with id ${id} in the index.`);
  process.exit(1);
}
const label = `${chunk.file} L${chunk.startLine}: ${chunk.body.slice(0, 70)}`;
if (undo) console.log(unmarkUsed(DATA, id) ? `Unmarked: ${label}` : `Was not marked used: ${label}`);
else console.log(`Marked used (${markUsed(DATA, id).count}×): ${label}`);
