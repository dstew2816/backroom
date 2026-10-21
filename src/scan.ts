import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { chunkNote } from './chunk.js';
import type { NoteFile, ParsedNote } from './types.js';

/** Lists .md files under `root`. Read-only. Skips dot-folders (.obsidian, .trash, .git) and node_modules. */
export function scanFolder(root: string): NoteFile[] {
  const out: NoteFile[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        const st = statSync(abs);
        out.push({
          file: relative(root, abs).split(/[\\/]/).join('/'),
          abs,
          mtimeMs: st.mtimeMs,
          size: st.size,
        });
      }
    }
  };
  walk(root);
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

export function parseNoteFile(note: NoteFile): ParsedNote {
  return chunkNote(note.file, readFileSync(note.abs, 'utf8'));
}
