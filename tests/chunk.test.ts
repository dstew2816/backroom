import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanForEmbedding } from '../src/clean.js';
import { chunkNote, MAX_CHARS } from '../src/chunk.js';
import { parseFrontmatter, frontmatterTags } from '../src/frontmatter.js';
import { parseNoteFile, scanFolder } from '../src/scan.js';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');

describe('frontmatter', () => {
  it('reads list, inline-array and string tags', () => {
    expect(frontmatterTags(parseFrontmatter(['---', 'tags:', '  - a', '  - "b"', '---']))).toEqual(['a', 'b']);
    expect(frontmatterTags(parseFrontmatter(['---', 'tags: [x, #y]', '---']))).toEqual(['x', 'y']);
    expect(frontmatterTags(parseFrontmatter(['---', 'tags: p q', '---']))).toEqual(['p', 'q']);
  });
  it('ignores an unclosed fence', () => {
    expect(parseFrontmatter(['---', 'tags: a', 'text']).endIndex).toBe(-1);
  });
});

describe('bullets', () => {
  const note = chunkNote('loose-bullets.md', fixture('loose-bullets.md'));

  it('keeps one-line bullets', () => {
    expect(note.chunks.map((c) => c.body)).toContain('Short one');
  });
  it('folds children into their top-level bullet', () => {
    const c = note.chunks.find((x) => x.body.startsWith('A longer'))!;
    expect(c.text).toContain('child detail two');
    expect(c.startLine).toBe(3);
    expect(c.endLine).toBe(5);
  });
  it('keeps a bullet after a blank line as its own chunk', () => {
    expect(note.chunks.at(-1)!.body).toBe('Idea after a blank line');
    expect(note.chunks).toHaveLength(4);
  });
});

describe('headings, lead-ins, tags, links', () => {
  const note = chunkNote('with-frontmatter.md', fixture('with-frontmatter.md'));

  it('uses frontmatter title and tags', () => {
    expect(note.title).toBe('Placeholder Note');
    expect(note.tags).toEqual(['alpha', 'beta']);
  });
  it('reports absolute line numbers past the frontmatter', () => {
    expect(note.chunks[0].startLine).toBe(9);
  });
  it('records the heading trail', () => {
    expect(note.chunks[0].headings).toEqual(['Section One']);
    expect(note.chunks[1].headings).toEqual(['Section One', 'Sub Section']);
  });
  it('treats "lead-in:" as context, not an idea', () => {
    expect(note.chunks.map((c) => c.body)).not.toContain('Things to try:');
    expect(note.chunks[1].context).toContain('Things to try');
  });
  it('strips wiki links for embedding but keeps them for display', () => {
    expect(note.chunks[0].text).toContain('[[Placeholder Place|the place]]');
    expect(note.chunks[0].body).toBe('Test paragraph one about a the place with inline.');
  });
  it('picks up inline tags and merges note tags', () => {
    expect(note.chunks[0].tags).toEqual(['alpha', 'beta', 'inline']);
  });
  it('drops horizontal rules and keeps prose after them', () => {
    expect(note.chunks.at(-1)!.body).toBe('Last test paragraph.');
  });
});

describe('messy input', () => {
  it('handles CRLF and a BOM', () => {
    const n = chunkNote('a.md', '﻿# H\r\n\r\n- one\r\n- two\r\n');
    expect(n.chunks.map((c) => c.body)).toEqual(['one', 'two']);
  });
  it('returns nothing for empty or symbol-only files', () => {
    expect(chunkNote('a.md', '').chunks).toEqual([]);
    expect(chunkNote('a.md', '---\n- \n***\n').chunks).toEqual([]);
  });
  it('handles a note that is only a heading', () => {
    expect(chunkNote('a.md', '# Title only').chunks).toEqual([]);
  });
  it('treats numbered lists and checkboxes as bullets', () => {
    const n = chunkNote('a.md', '1. first\n2. second\n- [ ] todo item');
    expect(n.chunks.map((c) => c.body)).toEqual(['first', 'second', 'todo item']);
  });
  it('keeps IDs stable when lines shift', () => {
    const a = chunkNote('a.md', '- Test idea about a merchant');
    const b = chunkNote('a.md', '# New heading\n\n\n- Test idea about a merchant');
    expect(a.chunks[0].id).toBe(b.chunks[0].id);
    expect(a.chunks[0].startLine).not.toBe(b.chunks[0].startLine);
  });
  it('gives duplicate text in one file distinct IDs', () => {
    const n = chunkNote('a.md', '- same\n- same');
    expect(new Set(n.chunks.map((c) => c.id)).size).toBe(2);
  });
  it('treats a bold-only line as a heading and • as a bullet', () => {
    const n = chunkNote('a.md', '**Test Region**\n\nTest paragraph.\n\n• Test bullet');
    expect(n.chunks.map((c) => c.body)).toEqual(['Test paragraph.', 'Test bullet']);
    expect(n.chunks[0].headings).toEqual(['Test Region']);
    expect(n.chunks[1].kind).toBe('bullet');
  });
  it('cleans callouts, comments and markdown links', () => {
    expect(cleanForEmbedding('> [!note] Test **bold** %%hidden%% [site](http://x)')).toBe('Test bold site');
  });
});

describe('long text', () => {
  const sentence = (i: number) => `Test sentence number ${i} about a merchant in town.`;

  it('splits a long paragraph under the limit with one sentence of overlap', () => {
    const text = Array.from({ length: 40 }, (_, i) => sentence(i)).join(' ');
    const n = chunkNote('a.md', text);
    expect(n.chunks.length).toBeGreaterThan(1);
    for (const c of n.chunks) expect(c.body.length).toBeLessThanOrEqual(MAX_CHARS);
    const [first, second] = n.chunks;
    const lastOfFirst = first.body.split('. ').at(-1)!.replace(/\.$/, '');
    expect(second.body).toContain(lastOfFirst);
    // every sentence survives somewhere
    for (let i = 0; i < 40; i++) expect(n.chunks.some((c) => c.body.includes(sentence(i)))).toBe(true);
  });
  it('splits a long bullet with children at line boundaries and keeps the parent as context', () => {
    const kids = Array.from({ length: 30 }, (_, i) => `\t- ${sentence(i)}`).join('\n');
    const n = chunkNote('a.md', `- Parent test idea\n${kids}`);
    expect(n.chunks.length).toBeGreaterThan(1);
    expect(n.chunks[1].context).toContain('Parent test idea');
    for (const c of n.chunks) expect(c.body.length).toBeLessThanOrEqual(MAX_CHARS);
  });
  it('hard-cuts text with no break points', () => {
    const n = chunkNote('a.md', Array.from({ length: 400 }, () => 'word').join(' '));
    for (const c of n.chunks) expect(c.body.length).toBeLessThanOrEqual(MAX_CHARS);
    expect(n.chunks.length).toBeGreaterThan(1);
  });
  it('maps paragraph pieces back to source lines', () => {
    const lines = Array.from({ length: 40 }, (_, i) => sentence(i));
    const n = chunkNote('a.md', lines.join('\n'));
    expect(n.chunks[0].startLine).toBe(1);
    expect(n.chunks.at(-1)!.endLine).toBe(40);
  });
});

describe('scanFolder', () => {
  it('finds markdown recursively, skips dot-folders, never writes', () => {
    const root = mkdtempSync(join(tmpdir(), 'backroom-'));
    mkdirSync(join(root, 'sub'));
    mkdirSync(join(root, '.obsidian'));
    writeFileSync(join(root, 'a.md'), '- one');
    writeFileSync(join(root, 'sub', 'b.md'), '- two');
    writeFileSync(join(root, 'sub', 'c.txt'), 'nope');
    writeFileSync(join(root, '.obsidian', 'd.md'), '- hidden');
    const files = scanFolder(root);
    expect(files.map((f) => f.file)).toEqual(['a.md', 'sub/b.md']);
    expect(parseNoteFile(files[1]).chunks[0].body).toBe('two');
    expect(readFileSync(join(root, 'a.md'), 'utf8')).toBe('- one');
  });
});
