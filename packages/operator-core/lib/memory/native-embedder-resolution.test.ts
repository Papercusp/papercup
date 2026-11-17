import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
// The child entry is a temp file outside the checkout, where no bare specifier resolves,
// so every module it loads is resolved here and handed to it as an absolute URL.
const tsxEsmUrl = pathToFileURL(require.resolve('tsx/esm')).href;
const configureUrl = new URL('./configure.ts', import.meta.url).href;
const rerankUrl = pathToFileURL(require.resolve('@papercusp/rerank')).href;
const transformersUrl = pathToFileURL(require.resolve('@huggingface/transformers')).href;

/** Fresh-process source: the engine's native libraries currently mapped into that process. */
const MAPPED_ENGINE_LIBS = 'process.report.getReport().sharedObjects.filter(p => /onnxruntime|sharp|vips/i.test(p))';

/**
 * Run `script` as a fresh ES-module tsx process at the repo root; parse the JSON on its last stdout line.
 *
 * The child is a temp `.mts` entry, never `tsx --eval`: tsx compiles `--eval` as CommonJS, and
 * test:file's committed-source loader (inherited through NODE_OPTIONS) refuses any checkout module
 * that reaches it through CommonJS with tsx-rewritten text (scripts/lib/committed-source-loader.mjs,
 * "commonjs"). Through ESM the loader hands tsx the committed bytes to transform.
 */
async function runFresh(script: string): Promise<unknown> {
  const dir = mkdtempSync(join(tmpdir(), 'native-embedder-resolution-'));
  try {
    const child = join(dir, 'child.mts');
    writeFileSync(child, script);
    const { stdout } = await execFileAsync(process.execPath, ['--import', tsxEsmUrl, child], {
      cwd: repoRoot,
      timeout: 30_000,
    });
    return JSON.parse(stdout.trim().split('\n').pop() ?? '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

it('the native shared-memory importer can load the operator’s installed local embedder', async () => {
  // Operator-core declares this dependency. A host-local installation must also
  // be reachable by the shared memory library, whose import has a different base.
  // WI-6554700010050711: both availability checks answer by module resolution, so
  // afterwards the fresh process must not have mapped onnxruntime, sharp or libvips.
  expect(require.resolve('@huggingface/transformers')).toBeTruthy();
  const result = await runFresh(
    `import { localAvailable } from ${JSON.stringify(configureUrl)};\n` +
      `const mapped = () => ${MAPPED_ENGINE_LIBS};\n` +
      'const available = await localAvailable();\n' +
      'const afterEmbed = mapped();\n' +
      `const { localRerankAvailable } = await import(${JSON.stringify(rerankUrl)});\n` +
      'const rerankAvailable = await localRerankAvailable();\n' +
      'const afterRerank = mapped();\n' +
      'console.log(JSON.stringify({ available, afterEmbed, rerankAvailable, afterRerank }));\n' +
      'process.exit(0);\n',
  );
  expect(result).toEqual({ available: true, afterEmbed: [], rerankAvailable: true, afterRerank: [] });
}, 40_000);

it('positive control: really importing the engine maps onnxruntime, so the empty lists above are a measurement', async () => {
  const result = await runFresh(
    `await import(${JSON.stringify(transformersUrl)});\n` +
      `console.log(JSON.stringify({ onnxruntime: ${MAPPED_ENGINE_LIBS}.some(p => /onnxruntime/i.test(p)) }));\n` +
      'process.exit(0);\n',
  );
  expect(result).toEqual({ onnxruntime: true });
}, 40_000);
