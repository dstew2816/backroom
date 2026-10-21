const INLINE_TAG = /(^|[\s(])#([A-Za-z][\w/-]*)/g;

/** Inline `#tags` (not headings, which have a space after the #). */
export function inlineTags(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(INLINE_TAG)) out.push(m[2]);
  return out;
}

/** Strips Markdown and Obsidian syntax down to plain prose for embedding. */
export function cleanForEmbedding(raw: string): string {
  return raw
    .split('\n')
    .map(cleanLine)
    .filter((l) => l.length > 0)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function cleanLine(line: string): string {
  return line
    .replace(/^\s*>+\s?/, '') // blockquote / callout marker
    .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/, '') // list marker
    .replace(/^\[[ xX]\]\s+/, '') // task checkbox
    .replace(/^\[![\w-]+\][+-]?\s*/, '') // callout type
    .replace(/%%.*?%%/g, '') // Obsidian comments
    .replace(/<!--.*?-->/g, '')
    .replace(/!\[\[[^\]]*\]\]/g, '') // embeds
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2') // [[target|alias]] -> alias
    .replace(/\[\[([^\]#]*)#?([^\]]*)\]\]/g, (_m, page: string, sec: string) => `${page} ${sec}`.trim())
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // [text](url) -> text
    .replace(/(\*\*|__|\*|_|~~|==|`)/g, '') // emphasis, highlight, code ticks
    .replace(INLINE_TAG, '$1$2') // #tag -> tag
    .replace(/\s+/g, ' ')
    .trim();
}

export function hasContent(s: string): boolean {
  return /[\p{L}\p{N}]/u.test(s);
}
