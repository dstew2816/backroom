// Static-demo backend: same API the local server offers, but search runs in this browser tab.
// Files it needs are served alongside the page (data/, vendor/, model/); it calls no outside service.
import type { IndexedChunk, LoadedIndex } from '../src/indexer.js';
import { search, toApiResult } from '../src/search.js';
import type { State } from '../src/state.js';

interface Pub {
  id: string;
  file: string;
  headings: string[];
  startLine: number;
  endLine: number;
  text: string;
  tags: string[];
}

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const DIM = 384;
const USED_KEY = 'backroom.demo.used';
const say = (msg: string) => {
  const el = document.getElementById('meta');
  if (el) el.textContent = msg;
};

let dataP: Promise<{ index: LoadedIndex; builtAt: string }> | null = null;
function loadData() {
  dataP ??= (async () => {
    const [meta, buf] = await Promise.all([
      fetch('data/chunks.json').then((r) => r.json() as Promise<{ builtAt: string; chunks: Pub[] }>),
      fetch('data/vectors.bin').then((r) => r.arrayBuffer()),
    ]);
    const chunks = meta.chunks.map((c) => ({ ...c, kind: 'bullet', context: '', body: c.text, textHash: c.id }) as unknown as IndexedChunk);
    const files: Record<string, unknown> = {};
    for (const c of chunks) files[c.file] = {};
    const index = { chunks, vectors: new Float32Array(buf), dim: DIM, files } as unknown as LoadedIndex;
    return { index, builtAt: meta.builtAt };
  })();
  return dataP;
}

type Extractor = (texts: string[], opts: object) => Promise<{ data: Float32Array }>;
let extractorP: Promise<Extractor> | null = null;
function loadModel() {
  extractorP ??= (async () => {
    say('Loading the search model (a one-time download of about 36 MB, then cached)…');
    const url = './vendor/transformers.min.js'; // variable, so the bundler leaves it as a runtime import
    const tf = await import(/* @vite-ignore */ url);
    const abs = (p: string) => new URL(p, location.href).href;
    tf.env.allowRemoteModels = false;
    tf.env.allowLocalModels = true;
    tf.env.localModelPath = './model/'; // a relative path (not a full URL) is what the library's local-file check accepts
    tf.env.backends.onnx.wasm.wasmPaths = { mjs: abs('./vendor/ort-wasm-simd-threaded.mjs'), wasm: abs('./vendor/ort-wasm-simd-threaded.wasm') };
    tf.env.backends.onnx.wasm.numThreads = 1; // static hosting can't enable shared memory threads
    return (await tf.pipeline('feature-extraction', MODEL_ID, { dtype: 'q8', device: 'wasm' })) as Extractor;
  })();
  return extractorP;
}

function loadState(): State {
  try {
    return JSON.parse(localStorage.getItem(USED_KEY) ?? '') as State;
  } catch {
    return { version: 1, used: {} };
  }
}
function saveState(s: State) {
  try {
    localStorage.setItem(USED_KEY, JSON.stringify(s));
  } catch {
    /* private mode: marks last until the tab closes */
    memory = s;
  }
}
let memory: State | null = null;
const state = () => memory ?? loadState();

(window as unknown as { backroomApi: unknown }).backroomApi = async function api(path: string, body?: Record<string, unknown>) {
  const { index, builtAt } = await loadData();

  if (path === '/api/status') {
    const folders = new Set<string>();
    for (const f of Object.keys(index.files)) {
      const parts = f.split('/').slice(0, -1);
      for (let i = 1; i <= parts.length; i++) folders.add(parts.slice(0, i).join('/'));
    }
    return {
      demo: true,
      ready: true,
      ideas: index.chunks.length,
      notes: Object.keys(index.files).length,
      builtAt,
      vault: null,
      folders: [...folders].sort((a, b) => a.localeCompare(b)),
      tags: [...new Set(index.chunks.flatMap((c) => c.tags))].sort((a, b) => a.localeCompare(b)),
      usedCount: Object.keys(state().used).length,
    };
  }

  if (path === '/api/search') {
    const scene = String(body?.scene ?? '').trim();
    if (!scene) throw new Error('Type a scene first.');
    const ex = await loadModel();
    const t0 = performance.now();
    const out = await ex([scene], { pooling: 'mean', normalize: true });
    const t1 = performance.now();
    const r = search(index, out.data.slice(0, DIM), state(), {
      k: Math.min(50, Math.max(1, Number(body?.k) || 8)),
      unusedOnly: body?.unusedOnly === true,
      tags: Array.isArray(body?.tags) ? body.tags.map(String) : undefined,
      folder: typeof body?.folder === 'string' && body.folder ? body.folder : undefined,
      stale: body?.stale === true,
    });
    const t2 = performance.now();
    return {
      timing: { queryEmbedMs: t1 - t0, scoreMs: t2 - t1, chunksSearched: index.chunks.length },
      distribution: r.distribution,
      clearTop: r.clearTop,
      results: r.results.map((x) => toApiResult(x, x.chunk.text)),
    };
  }

  if (path === '/api/used') {
    const id = String(body?.id ?? '');
    const s = state();
    if (body?.undo === true) delete s.used[id];
    else s.used[id] = { lastUsed: new Date().toISOString(), count: (s.used[id]?.count ?? 0) + 1 };
    saveState(s);
    return { used: s.used[id] ?? null };
  }

  throw new Error('Not available in the demo');
};
