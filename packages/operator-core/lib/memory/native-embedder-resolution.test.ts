import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

/** Fresh-process source: the engine's native libraries currently mapped into that process. */
const MAPPED_ENGINE_LIBS = 'process.report.getReport().sharedObjects.filter(p => /onnxruntime|sharp|vips/i.test(p))';

/** Run `script` in a fresh tsx process at the repo root; parse the JSON on its last stdout line. */
async function runFresh(script: string): Promise<unknown> {
  const { stdout } = await execFileAsync(process.execPath, [require.resolve('tsx/cli'), '--eval', script], {
    cwd: repoRoot,
    timeout: 30_000,
  });
  return JSON.parse(stdout.trim().split('\n').pop() ?? '');
}

it('the native shared-memory importer can load the operator’s installed local embedder', async () => {
  // Operator-core declares this dependency. A host-local installation must also
  // be reachable by the shared memory library, whose import has a different base.
  // WI-6554700010050711: both availability checks answer by module resolution, so
  // afterwards the fresh process must not have mapped onnxruntime, sharp or libvips.
  expect(require.resolve('@huggingface/transformers')).toBeTruthy();
  const result = await runFresh(
    'import { localAvailable } from "./packages/operator-core/lib/memory/configure.ts"; ' +
      `const mapped = () => ${MAPPED_ENGINE_LIBS}; ` +
      '(async () => { const available = await localAvailable(); const afterEmbed = mapped(); ' +
      'const { localRerankAvailable } = await import("@papercusp/rerank"); ' +
      'const rerankAvailable = await localRerankAvailable(); const afterRerank = mapped(); ' +
      'console.log(JSON.stringify({ available, afterEmbed, rerankAvailable, afterRerank })); process.exit(0); })()' +
      '.catch(error => { console.error(error.message); process.exit(1); });',
  );
  expect(result).toEqual({ available: true, afterEmbed: [], rerankAvailable: true, afterRerank: [] });
}, 40_000);

it('positive control: really importing the engine maps onnxruntime, so the empty lists above are a measurement', async () => {
  const result = await runFresh(
    'import("@huggingface/transformers").then(() => { ' +
      `console.log(JSON.stringify({ onnxruntime: ${MAPPED_ENGINE_LIBS}.some(p => /onnxruntime/i.test(p)) })); ` +
      'process.exit(0); }).catch(error => { console.error(error.message); process.exit(1); });',
  );
  expect(result).toEqual({ onnxruntime: true });
}, 40_000);
