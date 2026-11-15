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
  it('does not mistake an opening divider and a section of notes for frontmatter', () => {
    const text = '---\n\n## Test Section\n\n### 1. Test Title\n\nTest paragraph about a merchant.\n\n---\n\n## Next Section\n\nTest paragraph two.';
    expect(parseFrontmatter(text.split('\n')).endIndex).toBe(-1);
    const n = chunkNote('a.md', text);
    expect(n.chunks.map((c) => c.body)).toEqual(['Test paragraph about a merchant.', 'Test paragraph two.']);
    expect(n.chunks[0].headings).toEqual(['Test Section', 'Test Title']);
  });
  it('does not treat a divider-wrapped block without any key as frontmatter', () => {
    expect(chunkNote('a.md', '---\n- Test idea one\n- Test idea two\n---\nTest paragraph.').chunks).toHaveLength(3);
  });
});

describe('notes pasted without Markdown marks', () => {
  const alpha = 'Test paragraph alpha about a merchant who sells lamps in the market.';
  const beta = 'Test paragraph beta about a guard who sleeps at the gate every night.';
  const gamma = 'Test paragraph gamma about a bridge that collapses when it rains.';
  const plain = [
    'Test Section One',
    '1. Test Title Alpha',
    alpha,
    '',
    '2. Test Title Beta',
    beta,
    '',
    'Test Section Two',
    '3. Test Title Gamma',
    gamma,
  ].join('\n');
  const marked = [
    '## Test Section One',
    '',
    '### 1. Test Title Alpha',
    '',
    alpha,
    '',
    '### 2. Test Title Beta',
    '',
    beta,
    '',
    '---',
    '',
    '## Test Section Two',
    '',
    '### 3. Test Title Gamma',
    '',
    gamma,
  ].join('\n');
  const trails = [
    ['Test Section One', 'Test Title Alpha'],
    ['Test Section One', 'Test Title Beta'],
    ['Test Section Two', 'Test Title Gamma'],
  ];

  it('reads "1. Title" directly above its text as the title, and the line above that as the section', () => {
    const n = chunkNote('a.md', plain);
    expect(n.chunks.map((c) => c.body)).toEqual([alpha, beta, gamma]);
    expect(n.chunks.map((c) => c.headings)).toEqual(trails);
    expect(n.chunks.every((c) => c.kind === 'paragraph')).toBe(true);
  });
  it('gives the plain layout and the Markdown layout the same ideas', () => {
    const a = chunkNote('a.md', plain);
    const b = chunkNote('a.md', marked);
    expect(b.chunks.map((c) => c.headings)).toEqual(trails);
    expect(a.chunks.map((c) => c.id)).toEqual(b.chunks.map((c) => c.id));
    expect(a.chunks.map((c) => c.context)).toEqual(b.chunks.map((c) => c.context));
  });
  it('does not file plain entries under the last Markdown section when both layouts share a note', () => {
    const n = chunkNote('a.md', `${marked}\n\n${plain}`);
    expect(n.chunks.map((c) => c.headings)).toEqual([...trails, ...trails]);
  });
  it('keeps a "# Title" at the top of the note above plain sections', () => {
    const n = chunkNote('a.md', `# Test Note\n\n${plain}`);
    expect(n.chunks.map((c) => c.headings)).toEqual(trails.map((t) => ['Test Note', ...t]));
  });
  it('nests plain numbered entries under a Markdown heading', () => {
    const n = chunkNote('a.md', `## Test Section\n\n1. Test Title Alpha\n${alpha}\n\n2. Test Title Beta\n${beta}`);
    expect(n.chunks.map((c) => c.headings)).toEqual([
      ['Test Section', 'Test Title Alpha'],
      ['Test Section', 'Test Title Beta'],
    ]);
  });
  it('still treats ordinary numbered lists as ideas', () => {
    expect(chunkNote('a.md', '1. Buy rope\nand a lamp').chunks.map((c) => c.body)).toEqual(['Buy rope and a lamp']);
    const wrapped = chunkNote('a.md', '1. Check the players have enough healing\npotions before the boss fight, and restock');
    expect(wrapped.chunks).toHaveLength(1);
    expect(wrapped.chunks[0].body).toContain('healing potions');
    const indented = chunkNote('a.md', '1. Test idea\n   which carries on along an indented line that is longer');
    expect(indented.chunks).toHaveLength(1);
    expect(indented.chunks[0].kind).toBe('bullet');
    const sentence = chunkNote('a.md', `1. Test idea that ends like a sentence.\n${alpha}`);
    expect(sentence.chunks[0].body).toContain('Test idea that ends like a sentence.');
  });
  it('keeps a short loose line as an idea unless it sits directly on a numbered entry', () => {
    const n = chunkNote('a.md', `Test loose idea\n\n1. Test Title Alpha\n${alpha}`);
    expect(n.chunks.map((c) => c.body)).toEqual(['Test loose idea', alpha]);
    expect(n.chunks[1].headings).toEqual(['Test Title Alpha']);
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
  it('never lets the repeated sentence push an idea over the limit', () => {
    const short = 'Test short sentence about a merchant.';
    const long = (i: number) => `Test long sentence number ${i} ${'about a merchant in a town '.repeat(6)}ends here.`;
    const text = [short, long(1), long(2), long(3)].join(' ');
    const n = chunkNote('a.md', text, { maxChars: 300 });
    expect(n.chunks.length).toBeGreaterThan(1);
    for (const c of n.chunks) expect(c.body.length).toBeLessThanOrEqual(300);
    for (const s of [short, long(1), long(2), long(3)]) expect(n.chunks.some((c) => c.body.includes(s))).toBe(true);
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
