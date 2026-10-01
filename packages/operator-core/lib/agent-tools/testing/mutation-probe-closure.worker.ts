/** One closure check, one compiler isolate; staged by the shared host worker recipe. */
import { parentPort, workerData } from 'node:worker_threads';
import { stop } from 'esbuild';
import { computeImportClosures, type Closure } from './mutation-probe-closure.ts';

if (!parentPort) throw new Error('mutation-probe-closure.worker requires a worker thread');
let result: Closure;
try {
  result = await computeImportClosures(workerData.root, workerData.tests);
} catch (error) {
  result = { status: 'incomplete', reason: String(error).slice(0, 200) };
} finally {
  // Only this isolate's service. The caller's service and concurrent workers
  // have independent esbuild module state and remain available.
  await stop();
}
parentPort.postMessage(result);
parentPort.close();
