export interface Frontmatter {
  data: Record<string, string | string[]>;
  /** Index of the last frontmatter line (the closing fence), or -1 if there is none. */
  endIndex: number;
}

const FENCE = /^(---|\.\.\.)\s*$/;

/** Reads the small YAML subset Obsidian writes: `key: value`, `key: [a, b]`, and `key:` followed by `- item` lines. */
export function parseFrontmatter(lines: string[]): Frontmatter {
  if (lines.length === 0 || lines[0].trim() !== '---') return { data: {}, endIndex: -1 };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (FENCE.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (end === -1) return { data: {}, endIndex: -1 };

  const data: Record<string, string | string[]> = {};
  let listKey: string | null = null;
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    const item = /^\s+-\s+(.*)$/.exec(line) ?? /^-\s+(.*)$/.exec(line);
    if (item && listKey) {
      const arr = data[listKey];
      if (Array.isArray(arr)) arr.push(unquote(item[1]));
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    const value = rawValue.trim();
    if (value === '') {
      data[key] = [];
      listKey = key;
    } else if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = value
        .slice(1, -1)
        .split(',')
        .map((s) => unquote(s))
        .filter(Boolean);
      listKey = null;
    } else {
      data[key] = unquote(value);
      listKey = null;
    }
  }
  return { data, endIndex: end };
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/** Frontmatter `tags` / `tag`, accepting a list, `[a, b]`, or a comma/space separated string. */
export function frontmatterTags(fm: Frontmatter): string[] {
  const raw = fm.data.tags ?? fm.data.tag;
  if (raw === undefined) return [];
  const parts = Array.isArray(raw) ? raw : raw.split(/[,\s]+/);
  return parts.map((t) => t.replace(/^#/, '').trim()).filter(Boolean);
}
