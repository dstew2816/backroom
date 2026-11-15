import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { cleanForEmbedding, cleanLine, hasContent, inlineTags } from './clean.js';
import { frontmatterTags, parseFrontmatter } from './frontmatter.js';
import type { Chunk, ChunkKind, ParsedNote } from './types.js';

/** Roughly 225 tokens, safely under the ~256-token window of all-MiniLM-L6-v2. */
export const MAX_CHARS = 900;

export interface ChunkOptions {
  /** Longest idea, in characters, before it is split at sentence boundaries. Default MAX_CHARS. */
  maxChars?: number;
}
const TAB_WIDTH = 4;

const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^(\s*)(?:[-*+•]|\d+[.)])(?:\s+(.*))?$/;
/** A line that is only a bold label ("**The Kingdom of Arcallis**") acts as a heading. */
const BOLD_LABEL = /^\s*(?:\*\*|__)([^*_]{1,80})(?:\*\*|__):?\s*$/;
const BOLD_LABEL_LEVEL = 7;
/** A plain line sitting directly on a numbered entry ("Combat & Ambush Scenarios") names that group of entries. */
const SECTION_LABEL_LEVEL = 8;
/** A plain numbered line sitting directly on its text ("1. The Grand Ambush") names that idea. */
const NUMBERED_TITLE_LEVEL = 9;
const NUMBERED = /^\s*\d+[.)]\s+\S/;
/** Titles and labels are short; a longer line is more likely hard-wrapped prose. */
const LABEL_MAX = 60;
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

export function chunkNote(file: string, content: string, opts: ChunkOptions = {}): ParsedNote {
  const max = opts.maxChars ?? MAX_CHARS;
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
      cleanForEmbedding(whole).length <= max ? [wholePiece(dedented)] : splitLong(block.kind, dedented, max);
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
const isPlain = (s: string) => !isBlank(s) && !isHeading(s) && !isBullet(s) && !isRule(s) && !isFence(s);

/** The cleaned text if the line reads as a name for what follows: short, and not a sentence or a "lead-in:". */
function labelLike(raw: string): string | null {
  const text = cleanLine(raw);
  return hasContent(text) && text.length <= LABEL_MAX && !/[.,;:]$/.test(text) ? text : null;
}

/**
 * Notes pasted without Markdown marks look like
 *     1. The Grand Ambush
 *     A trusted informant sets up a meeting ...
 * There the numbered line is the idea's title, the same as "### 1. The Grand Ambush", not a list item.
 * It counts as a title only when the text directly beneath is not indented (that would be a list item
 * continuing) and clearly outweighs it: at least 40 characters and twice the title's length. Anything
 * less ("1. Buy rope / and a lamp") stays an ordinary list item, with both lines kept as one idea.
 */
function numberedTitle(lines: string[], i: number): string | null {
  if (!NUMBERED.test(lines[i])) return null;
  const title = labelLike(lines[i]);
  if (!title) return null;
  let below = 0;
  for (let j = i + 1; j < lines.length && isPlain(lines[j]); j++) {
    if (j === i + 1 && indentOf(lines[j]) > indentOf(lines[i])) return null;
    below += cleanLine(lines[j]).length;
  }
  return below >= 40 && below >= 2 * title.length ? title : null;
}

interface Heading {
  level: number;
  text: string;
  /** Written with a number in front, like "### 3. Title" or a plain "3. Title". */
  numbered?: boolean;
  /** Has an idea directly beneath it. */
  hasBody?: boolean;
}

function collectBlocks(lines: string[], from: number): Block[] {
  const blocks: Block[] = [];
  const stack: Heading[] = [];
  let lead: string | undefined;
  const trail = () => stack.map((h) => h.text);
  const emit = (block: Block) => {
    blocks.push(block);
    if (stack.length) stack.at(-1)!.hasBody = true;
  };
  /**
   * A numbered heading with its own text is one entry in a run ("38. ..."). The next plain numbered
   * title or section label is its sibling, not something inside it, so the entry is closed first.
   */
  const closeEntry = () => {
    const at = stack.findIndex((h) => h.numbered && h.hasBody);
    if (at === -1) return false;
    stack.length = at;
    return true;
  };
  const push = (h: Heading) => {
    while (stack.length && stack.at(-1)!.level >= h.level) stack.pop();
    stack.push(h);
    lead = undefined;
  };
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
      emit({ kind: 'paragraph', lines: taken, headings: trail() });
      lead = undefined;
      continue;
    }

    const h = HEADING.exec(line);
    if (h) {
      push({ level: h[1].length, text: cleanLine(h[2]), numbered: /^\d+[.)]\s/.test(h[2]) });
      i++;
      continue;
    }

    if (isRule(line)) {
      lead = undefined;
      i++;
      continue;
    }

    const title = numberedTitle(lines, i);
    if (title) {
      closeEntry();
      push({ level: NUMBERED_TITLE_LEVEL, text: title, numbered: true });
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
      emit({ kind: 'bullet', lines: taken, headings: trail(), lead });
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
      push({ level: BOLD_LABEL_LEVEL, text: label[1].trim() });
      i = j;
      continue;
    }
    const section = taken.length === 1 && j < n && numberedTitle(lines, j) ? labelLike(taken[0].text) : null;
    if (section) {
      // After a run of entries, the label opens a new section beside the one that held them.
      // A top-level "# Title" stays: it names the whole note, not one section of it.
      if (closeEntry() && stack.length && stack.at(-1)!.level > 1) stack.pop();
      push({ level: SECTION_LABEL_LEVEL, text: section });
      i = j;
      continue;
    }
    const nextIsBullet = j < n && isBullet(lines[j]);
    const joined = taken.map((t) => t.text.trim()).join(' ');
    if (nextIsBullet && joined.endsWith(':')) {
      // "Things the party might find:" introduces the bullets below; it is context, not an idea.
      lead = cleanLine(joined).replace(/:$/, '');
    } else {
      emit({ kind: 'paragraph', lines: taken, headings: trail() });
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

/** Packs sentences/lines into windows under the maximum; prose windows share one sentence of overlap. */
function splitLong(kind: ChunkKind, src: SrcLine[], max: number): Piece[] {
  const units = kind === 'bullet' ? bulletUnits(src, max) : paragraphUnits(src, max);
  const sep = kind === 'bullet' ? '\n' : ' ';
  const windows: Unit[][] = [];
  let cur: Unit[] = [];
  let len = 0;

  for (const u of units) {
    const add = cleanLine(u.text).length + 1;
    if (cur.length && len + add > max) {
      windows.push(cur);
      // Prose repeats its last sentence for continuity, unless that would push the next window over the limit.
      const last = cur.at(-1)!;
      const lastLen = cleanLine(last.text).length + 1;
      const carry = kind === 'paragraph' && cur.length > 1 && lastLen + add <= max ? [last] : [];
      cur = [...carry];
      len = carry.length ? lastLen : 0;
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

function bulletUnits(src: SrcLine[], max: number): Unit[] {
  const out: Unit[] = [];
  for (const l of src) {
    if (isBlank(l.text)) continue;
    for (const part of hardCut(l.text, max)) out.push({ text: part, line: l.line });
  }
  return out;
}

function paragraphUnits(src: SrcLine[], max: number): Unit[] {
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
    for (const part of hardCut(text, max)) out.push({ text: part, line: lines[idx].line });
  }
  return out;
}

/** A single run of text with no break points still has to fit the window. */
function hardCut(text: string, max: number): string[] {
  if (cleanLine(text).length <= max) return [text];
  const out: string[] = [];
  let cur = '';
  for (const word of text.split(/\s+/)) {
    if (cur && cur.length + word.length + 1 > max) {
      out.push(cur);
      cur = word;
    } else {
      cur = cur ? `${cur} ${word}` : word;
    }
  }
  if (cur) out.push(cur);
  return out;
}
