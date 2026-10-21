import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface UsedEntry {
  /** ISO timestamp of the most recent time this idea was marked used. */
  lastUsed: string;
  count: number;
}

export interface State {
  version: 1;
  used: Record<string, UsedEntry>;
}

const file = (dataDir: string) => join(dataDir, 'state.json');

/** Usage lives here, not in the notes. The notes are never touched. */
export function loadState(dataDir: string): State {
  const p = file(dataDir);
  if (!existsSync(p)) return { version: 1, used: {} };
  return JSON.parse(readFileSync(p, 'utf8')) as State;
}

function save(dataDir: string, state: State): void {
  mkdirSync(dataDir, { recursive: true });
  const tmp = file(dataDir) + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, file(dataDir));
}

export function markUsed(dataDir: string, id: string, now = new Date()): UsedEntry {
  const state = loadState(dataDir);
  const entry = { lastUsed: now.toISOString(), count: (state.used[id]?.count ?? 0) + 1 };
  state.used[id] = entry;
  save(dataDir, state);
  return entry;
}

export function unmarkUsed(dataDir: string, id: string): boolean {
  const state = loadState(dataDir);
  if (!(id in state.used)) return false;
  delete state.used[id];
  save(dataDir, state);
  return true;
}
