export type ChunkKind = 'paragraph' | 'bullet';

export interface Chunk {
  /** Stable across line shifts: file path plus a hash of the chunk's own text. */
  id: string;
  /** Path relative to the notes root, forward slashes. */
  file: string;
  /** 1-based, inclusive. Display only; never used as identity. */
  startLine: number;
  endLine: number;
  kind: ChunkKind;
  /** Heading trail above the chunk, outermost first. */
  headings: string[];
  /** Raw text as written (wiki links intact), for display. */
  text: string;
  /** Note title and heading trail (and any "lead-in:" line), for embedding context. */
  context: string;
  /** Markdown stripped, for embedding. */
  body: string;
  /** Note tags plus any inline #tags inside this chunk. */
  tags: string[];
}

export interface ParsedNote {
  file: string;
  title: string;
  tags: string[];
  chunks: Chunk[];
}

export interface NoteFile {
  file: string;
  abs: string;
  mtimeMs: number;
  size: number;
}
