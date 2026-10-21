import { pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';

export const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
export const MODEL_DTYPE = 'q8';
export const DIM = 384;

/** Turns texts into unit-length vectors. Injectable so tests don't need the model. */
export interface Embedder {
  dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

let extractor: Promise<FeatureExtractionPipeline> | null = null;
let loadMs = 0;

/** The first call downloads the model (once, ~25 MB); after that it loads from the local cache. */
function load(): Promise<FeatureExtractionPipeline> {
  extractor ??= (async () => {
    const t0 = performance.now();
    const p = (await pipeline('feature-extraction', MODEL_ID, { dtype: MODEL_DTYPE })) as FeatureExtractionPipeline;
    loadMs = performance.now() - t0;
    return p;
  })();
  return extractor;
}

export function modelLoadMs(): number {
  return loadMs;
}

export const miniLM: Embedder = {
  dim: DIM,
  async embed(texts) {
    const ex = await load();
    const out: Float32Array[] = [];
    const BATCH = 32;
    for (let i = 0; i < texts.length; i += BATCH) {
      const t = await ex(texts.slice(i, i + BATCH), { pooling: 'mean', normalize: true });
      const data = t.data as Float32Array;
      for (let r = 0; r < t.dims[0]; r++) out.push(data.slice(r * DIM, (r + 1) * DIM));
    }
    return out;
  },
};

/** What gets embedded for a chunk: where it lives, then what it says. */
export function embedTextFor(c: { context: string; body: string }): string {
  return c.context ? `${c.context}: ${c.body}` : c.body;
}
