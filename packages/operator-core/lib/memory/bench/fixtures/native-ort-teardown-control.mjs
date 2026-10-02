/** Small native ORT cleanup control for WI-10005599. This reuses upstream
 * ORT's MIT mul_1.onnx fixture, already used by the native worker trace test.
 * It loads no embedding weights and cannot qualify embedding acceptance.
 */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const file = fileURLToPath(import.meta.url);
const graph = Buffer.from('CAMSBmNoZW50YTpwChUKAVgKAVcSAVkaBW11bF8xIgNNdWwSCG11bCB0ZXN0KiMIAwgCEAEiGAAAgD8AAABAAABAQAAAgEAAAKBAAADAQEIBV1oTCgFYEg4KDAgBEggKAggDCgIIAmITCgFZEg4KDAgBEggKAggDCgIIAkIECgAQBw==', 'base64');
const graphSha = '71f431c4e9321ec6fbeb158d02ed240459a7dcc98673fa79a4f439ce42efaf10';
if (createHash('sha256').update(graph).digest('hex') !== graphSha) throw new Error('teardown control graph drift');

function fingerprint(path) {
  const bytes = readFileSync(path);
  return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function run(config) {
  const { ortEntry, device, outcome, release } = config;
  if (!isAbsolute(ortEntry) || !['cpu', 'cuda'].includes(device)
    || !['success', 'shape-error'].includes(outcome) || !['dispose', 'environment'].includes(release)) {
    throw new Error('invalid native teardown control configuration');
  }
  const require = createRequire(ortEntry), ort = require(ortEntry);
  ort.env.logLevel = 'info';
  const session = await ort.InferenceSession.create(graph, {
    executionProviders: [device], intraOpNumThreads: 1, interOpNumThreads: 1, logSeverityLevel: 1,
  });
  const receipt = { formatVersion: 1, workItem: 'WI-10005599', processId: process.pid,
    scope: '130-byte native Mul fixture; no embedding weights', graph: { bytes: graph.length, sha256: graphSha },
    source: fingerprint(file), node: fingerprint(process.execPath), ortEntry: fingerprint(ortEntry),
    device, outcome, release, embeddingModelInferencePerformed: false, disposed: false };
  try {
    try {
      const result = await session.run({ X: new ort.Tensor('float32', Float32Array.from([1, 1, 1, 1, 1, 1]),
        outcome === 'shape-error' ? [2, 3] : [3, 2]) });
      if (outcome !== 'success') throw new Error('shape-error control unexpectedly succeeded');
      if (Array.from(result.Y.data).join(',') !== '1,2,3,4,5,6') throw new Error('native Mul control output mismatch');
      receipt.output = Array.from(result.Y.data);
    } catch (error) {
      if (outcome !== 'shape-error' || !String(error).includes('Got invalid dimensions for input')) throw error;
      receipt.expectedError = String(error);
    }
  } finally {
    if (release === 'dispose') { await session.release(); receipt.disposed = true; }
  }
  return receipt;
}

async function target(config) {
  // Match the shipped parent's native binding pin before the FILE worker loads.
  const ort = createRequire(config.ortEntry)(config.ortEntry);
  if (config.parentLogLevel !== undefined) {
    if (!['warning', 'info'].includes(config.parentLogLevel)) throw new Error('invalid parent initializer log level');
    ort.env.logLevel = config.parentLogLevel;
    // A separate small CPU session exercises the process-global first
    // initializer; it changes no CUDA provider options in the worker.
    const initial = await ort.InferenceSession.create(graph, {
      executionProviders: ['cpu'], intraOpNumThreads: 1, interOpNumThreads: 1,
    });
    await initial.release();
  }
  if (config.terminal !== undefined && !['settled', 'uncaught', 'exit-code'].includes(config.terminal)) {
    throw new Error('invalid native teardown terminal mode');
  }
  const worker = new Worker(new URL(import.meta.url), { workerData: config, execArgv: [] });
  let result;
  try {
    result = await new Promise((resolve, reject) => {
      worker.once('message', message => message.error ? reject(new Error(message.error)) : resolve(message));
      worker.once('error', reject);
      worker.once('exit', code => { if (!result) reject(new Error('control worker exited before receipt: ' + code)); });
    });
  } finally {
    result = result ? { ...result, workerTerminationCode: await worker.terminate() } : undefined;
    if (!result) await worker.terminate();
  }
  process.stdout.write(JSON.stringify(result) + '\n');
  if (['uncaught', 'exit-code'].includes(config.terminal)) {
    if (!result.expectedError) throw new Error('uncaught control requires the retained shape error');
    if (config.terminal === 'uncaught') throw new Error(result.expectedError);
    process.stderr.write(result.expectedError + '\n');
    process.exitCode = 1;
  }
}

async function capture(root, config) {
  const stdout = openSync(join(root, 'target.stdout.log'), 'wx', 0o600);
  const stderr = openSync(join(root, 'target.stderr.log'), 'wx', 0o600);
  const hash = createHash('sha256'); let bytes = 0;
  const child = spawn(process.execPath, [file, 'target', JSON.stringify(config)], {
    env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', data => { if (writeSync(stdout, data) !== data.length) throw new Error('short control stdout write'); });
  child.stderr.on('data', data => {
    if (writeSync(stderr, data) !== data.length) throw new Error('short control stderr write');
    hash.update(data); bytes += data.length;
  });
  child.once('error', error => { throw error; });
  const terminal = await new Promise(resolve => child.once('close', (exitCode, signal) => resolve({
    processId: child.pid, source: 'spawn-pipe', captureStartedBeforeExec: true, eof: true,
    exitCode, signal, bytes, sha256: hash.digest('hex'),
  })));
  closeSync(stdout); closeSync(stderr);
  writeFileSync(join(root, 'target-terminal.json'), JSON.stringify(terminal, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify(terminal) + '\n');
  process.exitCode = terminal.exitCode ?? 1;
}

if (!isMainThread) {
  try { parentPort.postMessage(await run(workerData)); }
  catch (error) { parentPort.postMessage({ error: String(error) }); }
} else if (process.argv[1] === file) {
  if (process.argv[2] === 'target') await target(JSON.parse(process.argv[3]));
  else if (process.argv[2] === 'capture') await capture(process.argv[3], JSON.parse(process.argv[4]));
  else throw new Error('expected native teardown control target or capture mode');
}
