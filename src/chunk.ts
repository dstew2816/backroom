import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { cleanForEmbedding, cleanLine, hasContent, inlineTags } from './clean.js';
import { frontmatterTags, parseFrontmatter } from './frontmatter.js';
import type { Chunk, ChunkKind, ParsedNote } from './types.js';

/** Roughly 225 tokens, safely under the ~256-token window of all-MiniLM-L6-v2. */
export const MAX_CHARS = 900;
const TAB_WIDTH = 4;

const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^(\s*)(?:[-*+•]|\d+[.)])(?:\s+(.*))?$/;
/** A line that is only a bold label ("**The Kingdom of Arcallis**") acts as a heading. */
const BOLD_LABEL = /^\s*(?:\*\*|__)([^*_]{1,80})(?:\*\*|__):?\s*$/;
const BOLD_LABEL_LEVEL = 7;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const FENCE = /^\s*(```|~~~)/;

interface SrcLine {
  text: string;
  /** 1-based line number in the original file. */
  line: number;
}

interface Block {
  kind: ChunkKind;
  lines: SrcLine[];
  headings: string[];
  lead?: string;
}

interface Unit {
  text: string;
  line: number;
}

export function chunkNote(file: string, content: string): ParsedNote {
  const lines = content.replace(/^﻿/, '').split(/\r?\n/);
  const fm = parseFrontmatter(lines);
  const title =
    (typeof fm.data.title === 'string' && fm.data.title) || basename(file).replace(/\.md$/i, '');
  const noteTags = frontmatterTags(fm);

  const chunks: Chunk[] = [];
  const seen = new Map<string, number>();

  for (const block of collectBlocks(lines, fm.endIndex + 1)) {
    const dedented = dedent(block.lines);
    const whole = dedented.map((l) => l.text).join('\n');
    const pieces =
      cleanForEmbedding(whole).length <= MAX_CHARS ? [wholePiece(dedented)] : splitLong(block.kind, dedented);
    const parent = block.kind === 'bullet' ? cleanLine(dedented[0].text).slice(0, 120) : '';

    pieces.forEach((piece, i) => {
      const body = cleanForEmbedding(piece.text);
      if (!hasContent(body)) return;

      const ctx = [title, ...block.headings, block.lead, i > 0 && parent ? parent : undefined]
        .filter((s): s is string => Boolean(s))
        .join(' › ');
      const hash = createHash('sha1').update(body.toLowerCase()).digest('hex').slice(0, 10);
      const base = `${file}::${hash}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);

      chunks.push({
        id: n === 1 ? base : `${base}~${n}`,
        file,
        startLine: piece.startLine,
        endLine: piece.endLine,
        kind: block.kind,
        headings: block.headings,
        text: piece.text,
        context: ctx,
        body,
        tags: [...new Set([...noteTags, ...inlineTags(piece.text)])],
      });
    });
  }

  return { file, title, tags: noteTags, chunks };
}

function indentOf(s: string): number {
  let n = 0;
  for (const ch of s) {
    if (ch === ' ') n++;
    else if (ch === '\t') n += TAB_WIDTH;
    else break;
  }
  return n;
}

const isBlank = (s: string) => s.trim() === '';
const isHeading = (s: string) => HEADING.test(s);
const isRule = (s: string) => RULE.test(s);
const isBullet = (s: string) => !isRule(s) && BULLET.test(s);
const isFence = (s: string) => FENCE.test(s);

function collectBlocks(lines: string[], from: number): Block[] {
  const blocks: Block[] = [];
  const stack: { level: number; text: string }[] = [];
  let lead: string | undefined;
  const trail = () => stack.map((h) => h.text);
  const n = lines.length;
  let i = from;

  while (i < n) {
    const line = lines[i];

    if (isBlank(line)) {
      i++;
      continue;
    }

    if (isFence(line)) {
      const fence = FENCE.exec(line)![1];
      const taken: SrcLine[] = [{ text: line, line: i + 1 }];
      i++;
      while (i < n) {
        taken.push({ text: lines[i], line: i + 1 });
        i++;
        if (lines[i - 1].trim().startsWith(fence)) break;
      }
      blocks.push({ kind: 'paragraph', lines: taken, headings: trail() });
      lead = undefined;
      continue;
    }

    const h = HEADING.exec(line);
    if (h) {
      const level = h[1].length;
      while (stack.length && stack.at(-1)!.level >= level) stack.pop();
      stack.push({ level, text: cleanLine(h[2]) });
      lead = undefined;
      i++;
      continue;
    }

    if (isRule(line)) {
      lead = undefined;
      i++;
      continue;
    }

    if (isBullet(line)) {
      // A top-level bullet owns every deeper-indented line (children) beneath it.
      const base = indentOf(line);
      const taken: SrcLine[] = [{ text: line, line: i + 1 }];
      let j = i + 1;
      while (j < n) {
        const l = lines[j];
        if (isBlank(l)) {
          let k = j + 1;
          while (k < n && isBlank(lines[k])) k++;
          if (k < n && indentOf(lines[k]) > base && !isHeading(lines[k])) {
            j = k;
            continue;
          }
          break;
        }
        if (isHeading(l) || isRule(l) || isFence(l)) break;
        if (isBullet(l) && indentOf(l) <= base) break;
        taken.push({ text: l, line: j + 1 });
        j++;
      }
      blocks.push({ kind: 'bullet', lines: taken, headings: trail(), lead });
      i = j;
      continue;
    }

    // Paragraph: consecutive plain lines.
    const taken: SrcLine[] = [];
    let j = i;
    while (j < n && !isBlank(lines[j]) && !isHeading(lines[j]) && !isBullet(lines[j]) && !isRule(lines[j]) && !isFence(lines[j])) {
      taken.push({ text: lines[j], line: j + 1 });
      j++;
    }
    const label = taken.length === 1 ? BOLD_LABEL.exec(taken[0].text) : null;
    if (label) {
      while (stack.length && stack.at(-1)!.level >= BOLD_LABEL_LEVEL) stack.pop();
      stack.push({ level: BOLD_LABEL_LEVEL, text: label[1].trim() });
      lead = undefined;
      i = j;
      continue;
    }
    const nextIsBullet = j < n && isBullet(lines[j]);
    const joined = taken.map((t) => t.text.trim()).join(' ');
    if (nextIsBullet && joined.endsWith(':')) {
      // "Things the party might find:" introduces the bullets below; it is context, not an idea.
      lead = cleanLine(joined).replace(/:$/, '');
    } else {
      blocks.push({ kind: 'paragraph', lines: taken, headings: trail() });
      lead = undefined;
    }
    i = j;
  }
  return blocks;
}

function dedent(src: SrcLine[]): SrcLine[] {
  const widths = src.filter((l) => !isBlank(l.text)).map((l) => indentOf(l.text));
  const min = widths.length ? Math.min(...widths) : 0;
  return src.map((l) => ({
    line: l.line,
    text: isBlank(l.text) ? '' : ' '.repeat(Math.max(0, indentOf(l.text) - min)) + l.text.trim(),
  }));
}

interface Piece {
  text: string;
  startLine: number;
  endLine: number;
}

function wholePiece(src: SrcLine[]): Piece {
  const nonBlank = src.filter((l) => !isBlank(l.text));
  return {
    text: src.map((l) => l.text).join('\n').trim(),
    startLine: nonBlank[0]?.line ?? src[0].line,
    endLine: nonBlank.at(-1)?.line ?? src[0].line,
  };
}

/** Packs sentences/lines into windows under MAX_CHARS; prose windows share one sentence of overlap. */
function splitLong(kind: ChunkKind, src: SrcLine[]): Piece[] {
  const units = kind === 'bullet' ? bulletUnits(src) : paragraphUnits(src);
  const sep = kind === 'bullet' ? '\n' : ' ';
  const windows: Unit[][] = [];
  let cur: Unit[] = [];
  let len = 0;

  for (const u of units) {
    const add = cleanLine(u.text).length + 1;
    if (cur.length && len + add > MAX_CHARS) {
      windows.push(cur);
      const carry = kind === 'paragraph' && cur.length > 1 ? [cur.at(-1)!] : [];
      cur = [...carry];
      len = carry.reduce((s, c) => s + cleanLine(c.text).length + 1, 0);
    }
    cur.push(u);
    len += add;
  }
  if (cur.length) windows.push(cur);

  return windows.map((w) => ({
    text: w.map((u) => u.text).join(sep),
    startLine: w[0].line,
    endLine: w.at(-1)!.line,
  }));
}

function bulletUnits(src: SrcLine[]): Unit[] {
  const out: Unit[] = [];
  for (const l of src) {
    if (isBlank(l.text)) continue;
    for (const part of hardCut(l.text)) out.push({ text: part, line: l.line });
  }
  return out;
}

function paragraphUnits(src: SrcLine[]): Unit[] {
  const lines = src.filter((l) => !isBlank(l.text));
  const starts: number[] = [];
  let joined = '';
  for (const l of lines) {
    starts.push(joined.length);
    joined += (joined ? ' ' : '') + l.text.trim();
    // starts[] must point at the first character of each line within `joined`
    starts[starts.length - 1] = joined.length - l.text.trim().length;
  }
  const out: Unit[] = [];
  const re = /[^.!?]*[.!?]+["')\]]*(?:\s+|$)|[^.!?]+$/g;
  for (const m of joined.matchAll(re)) {
    const text = m[0].trim();
    if (!text) continue;
    let idx = 0;
    for (let k = 0; k < starts.length; k++) if (starts[k] <= m.index!) idx = k;
    for (const part of hardCut(text)) out.push({ text: part, line: lines[idx].line });
  }
  return out;
}

/** A single run of text with no break points still has to fit the window. */
function hardCut(text: string): string[] {
  if (cleanLine(text).length <= MAX_CHARS) return [text];
  const out: string[] = [];
  let cur = '';
  for (const word of text.split(/\s+/)) {
    if (cur && cur.length + word.length + 1 > MAX_CHARS) {
      out.push(cur);
      cur = word;
    } else {
      cur = cur ? `${cur} ${word}` : word;
    }
  }
  if (cur) out.push(cur);
  return out;
}
