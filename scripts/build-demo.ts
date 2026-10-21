// Builds the static GitHub Pages demo into ./docs from a sample notes folder.
//   npm run build:demo -- demo-sample
// Everything in the sample folder becomes public text in docs/data/chunks.json.
// By design this only accepts a folder inside ./demo-sample (pass --allow-outside to override on purpose).
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { cleanForEmbedding } from '../src/clean.js';
import { MODEL_ID, miniLM } from '../src/embed.js';
import { buildIndex, loadIndex, logTiming } from '../src/indexer.js';

const args = process.argv.slice(2);
const folderArg = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--out');
const outIdx = args.indexOf('--out');
const out = resolve(outIdx >= 0 ? args[outIdx + 1] : 'docs');
if (!folderArg) {
  console.error('usage: npm run build:demo -- <sample folder inside demo-sample> [--out docs]');
  process.exit(1);
}
const sample = resolve(folderArg);
const allowed = resolve('demo-sample');
if (!args.includes('--allow-outside') && relative(allowed, sample).startsWith('..')) {
  console.error(`Refusing: ${sample} is not inside ${allowed}.\nThe demo publishes every word of the folder you build from, so only demo-sample/ is allowed by default.`);
  process.exit(1);
}
if (!existsSync(sample)) {
  console.error(`Folder not found: ${sample}`);
  process.exit(1);
}

const t0 = performance.now();
const tmp = mkdtempSync(join(tmpdir(), 'backroom-demo-'));
const stats = await buildIndex(sample, tmp, miniLM, { logTimings: false });
const index = loadIndex(tmp)!;
const tIndex = performance.now();

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'data'), { recursive: true });
writeFileSync(
  join(out, 'data', 'chunks.json'),
  JSON.stringify({
    builtAt: index.builtAt,
    chunks: index.chunks.map((c) => ({
      id: c.id,
      file: c.file,
      headings: c.headings,
      startLine: c.startLine,
      endLine: c.endLine,
      text: cleanForEmbedding(c.text),
      tags: c.tags,
    })),
  }),
);
writeFileSync(join(out, 'data', 'vectors.bin'), Buffer.from(index.vectors.buffer, index.vectors.byteOffset, index.vectors.byteLength));
rmSync(tmp, { recursive: true, force: true });

await build({
  entryPoints: ['web/demo.ts'],
  outfile: join(out, 'demo.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
});

const html = readFileSync('web/index.html', 'utf8')
  .replace('<title>Backroom</title>', '<title>Backroom (demo)</title>')
  .replace('<!--DEMO_SCRIPT-->', '<script src="demo.js"></script>');
writeFileSync(join(out, 'index.html'), html);

const tf = 'node_modules/@huggingface/transformers';
const ort = 'node_modules/onnxruntime-web/dist';
const modelDir = `${tf}/.cache/${MODEL_ID}`;
const copies: [string, string][] = [
  [`${tf}/dist/transformers.min.js`, 'vendor/transformers.min.js'],
  [`${ort}/ort-wasm-simd-threaded.mjs`, 'vendor/ort-wasm-simd-threaded.mjs'],
  [`${ort}/ort-wasm-simd-threaded.wasm`, 'vendor/ort-wasm-simd-threaded.wasm'],
  ...['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'].map(
    (f) => [`${modelDir}/${f}`, `model/${MODEL_ID}/${f}`] as [string, string],
  ),
];
for (const [from, to] of copies) {
  if (!existsSync(from)) {
    console.error(`Missing ${from}. Run "npm run index" once so the model is downloaded, then retry.`);
    process.exit(1);
  }
  mkdirSync(dirname(join(out, to)), { recursive: true });
  cpSync(from, join(out, to));
}

writeFileSync(join(out, '.nojekyll'), '');
writeFileSync(
  join(out, 'NOTICE.txt'),
  `Backroom demo bundles third-party software and a model, unmodified:
- all-MiniLM-L6-v2 (sentence-transformers), ONNX conversion by Xenova: Apache-2.0
- transformers.js (Hugging Face): Apache-2.0
- ONNX Runtime Web (Microsoft): MIT
`,
);

const totalMs = performance.now() - t0;
const build_ = { notes: stats.filesTotal, ideas: stats.chunksTotal, indexMs: tIndex - t0, totalMs };
logTiming('build-demo', build_);
console.log(`Demo built in ${out}: ${stats.filesTotal} notes, ${stats.chunksTotal} ideas, ${totalMs.toFixed(0)} ms`);
console.log('Preview: npm run preview:demo');
