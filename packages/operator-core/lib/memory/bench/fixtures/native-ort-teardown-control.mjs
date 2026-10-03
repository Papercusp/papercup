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

function observedProcessEnvironment() {
  // Observation, not admission: the governed parent validates/owns the typed
  // context. Retain its exact serialization so the parent can check forwarding
  // all the way through the debugger and FILE worker without guessing lineage.
  const allocator = Object.fromEntries(['GLIBC_TUNABLES', 'MALLOC_CHECK_', 'MALLOC_PERTURB_', 'LD_PRELOAD']
    .map(key => [key, process.env[key] ?? null]));
  const libraries = process.platform === 'linux'
    ? [...new Set(readFileSync('/proc/self/maps', 'utf8').split('\n')
      .map(line => line.trim().split(/\s+/).at(-1))
      .filter(path => path && /\/(?:libc\.so\.6|libc_malloc_debug\.so(?:\.0)?|ld-linux-x86-64\.so\.2)$/.test(path)))]
      .sort().map(fingerprint)
    : [];
  return { serializedAdmissionContext: process.env.PAPERCUSP_ADMISSION_CONTEXT ?? null, allocator, libraries };
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
    observation: observedProcessEnvironment(),
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
  if (config.terminal !== undefined && !['settled', 'uncaught', 'exit-code', 'abort-control'].includes(config.terminal)) {
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
  // Positive debugger-protocol control, confined to this 130-byte fixture.
  if (config.terminal === 'abort-control') process.abort();
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
  const child = spawn(process.execPath, [file, config.allocatorControl ? 'allocator-target' : 'target', JSON.stringify(config)], {
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

async function allocatorTarget(config) {
  const { binding, fault } = config.allocatorControl ?? {};
  if (process.platform !== 'linux' || !isAbsolute(binding ?? '') || !binding.endsWith('.node')
    || !['clean', 'tail-overwrite'].includes(fault)) throw new Error('invalid allocator detector control');
  const native = createRequire(file)(binding);
  if (typeof native.detect !== 'function') throw new Error('invalid allocator detector binding');
  writeSync(1, 'PC_NATIVE_ALLOCATOR\t' + JSON.stringify({ event: 'start', processId: process.pid,
    fault, requestedBytes: 64, mutationBytes: fault === 'clean' ? 0 : 1,
    binding: fingerprint(binding), source: fingerprint(file), node: fingerprint(process.execPath),
    observation: observedProcessEnvironment(), embeddingModelInferencePerformed: false }) + '\n');
  if (native.detect(fault) !== true) throw new Error('allocator detector control did not release');
  writeSync(1, 'PC_NATIVE_ALLOCATOR\t' + JSON.stringify({ event: 'released', processId: process.pid }) + '\n');
}

export function inspectAllocatorDetectorCapture(stdout, stderr, terminal, expected) {
  const records = stdout.split('\n').filter(line => line.startsWith('PC_NATIVE_ALLOCATOR\t'))
    .map(line => JSON.parse(line.slice('PC_NATIVE_ALLOCATOR\t'.length)));
  const starts = records.filter(row => row.event === 'start');
  const releases = records.filter(row => row.event === 'released');
  const start = starts[0], observation = start?.observation;
  const samePin = (actual, desired) => actual && desired && actual.path === desired.path
    && actual.bytes === desired.bytes && actual.sha256 === desired.sha256;
  const once = marker => stdout.split('\n').filter(line => line === marker).length === 1;
  if (!['clean', 'tail-overwrite'].includes(expected.fault) || starts.length !== 1
    || records.length !== (expected.fault === 'clean' ? 2 : 1)
    || !Number.isSafeInteger(start.processId) || start.processId <= 0 || terminal.processId !== start.processId
    || terminal.eof !== true || terminal.captureStartedBeforeExec !== true
    || start.fault !== expected.fault || start.requestedBytes !== 64
    || start.mutationBytes !== (expected.fault === 'clean' ? 0 : 1)
    || start.embeddingModelInferencePerformed !== false || !samePin(start.binding, expected.binding)
    || observation?.serializedAdmissionContext !== expected.serializedAdmissionContext
    || observation?.allocator?.MALLOC_CHECK_ !== '3'
    || !observation.allocator.GLIBC_TUNABLES?.split(':').includes('glibc.malloc.check=3')
    || observation.allocator.LD_PRELOAD !== expected.debugAllocator.path
    || !observation.libraries?.some(row => samePin(row, expected.debugAllocator))
    || !once('PC_NATIVE_ALLOCATOR_CORE_LIMIT_ZERO') || !once('PC_NATIVE_ALLOCATOR_BEFORE_FREE')) {
    throw new Error('incomplete allocator detector process evidence');
  }
  const corruptionMessage = /free\(\): invalid pointer|double free or corruption|corrupted double-linked list|malloc\(\): memory corruption/.test(stderr);
  if (expected.fault === 'tail-overwrite') {
    if (releases.length !== 0 || terminal.exitCode !== null || terminal.signal !== 'SIGABRT'
      || !once('PC_NATIVE_ALLOCATOR_TAIL_OVERWRITE') || !corruptionMessage) {
      throw new Error('unqualified allocator corruption positive control');
    }
  } else if (releases.length !== 1 || releases[0].processId !== start.processId
    || terminal.exitCode !== 0 || terminal.signal !== null || corruptionMessage
    || stdout.includes('PC_NATIVE_ALLOCATOR_TAIL_OVERWRITE')) {
    throw new Error('invalid allocator clean control');
  }
  return { processId: start.processId, source: 'native-allocator-control', fault: expected.fault,
    exitCode: terminal.exitCode, signal: terminal.signal, pipeEof: true, debugAllocatorMapped: true,
    detectorTriggered: expected.fault === 'tail-overwrite', requestedBytes: 64,
    embeddingModelInferencePerformed: false, heapCorruptionRootCauseConfirmed: false };
}

export function inspectHostDebuggerCapture(stdout, debuggerTerminal) {
  const records = stdout.split('\n').filter(line => line.startsWith('PC_NATIVE_DEBUGGER\t'))
    .map(line => JSON.parse(line.slice('PC_NATIVE_DEBUGGER\t'.length)));
  const starts = records.filter(row => row.event === 'start');
  const exits = records.filter(row => row.event === 'exit');
  const stops = records.filter(row => row.event === 'signal');
  if (debuggerTerminal.eof !== true || debuggerTerminal.exitCode !== 0 || debuggerTerminal.signal !== null
    || starts.length !== 1 || exits.length !== 1 || records.some(row => row.event === 'error')
    || !Number.isSafeInteger(starts[0].processId) || starts[0].processId <= 0
    || exits[0].processId !== starts[0].processId || exits[0].signalDelivered !== true) {
    throw new Error('incomplete native debugger process evidence');
  }
  const exit = exits[0];
  if (exit.exitCode === null) {
    const fatal = stops.at(-1);
    if (!fatal || fatal.processId !== starts[0].processId || fatal.signal !== 'SIGABRT'
      || exit.signal !== fatal.signal || !stdout.includes('PC_NATIVE_BACKTRACE_BEGIN\n')
      || !stdout.includes('PC_NATIVE_BACKTRACE_END\n')) throw new Error('unbound native debugger abort evidence');
  } else if (!Number.isInteger(exit.exitCode) || exit.signal !== null) {
    throw new Error('invalid native debugger exit evidence');
  }
  return { processId: starts[0].processId, source: 'gdb-events', exitCode: exit.exitCode,
    signal: exit.signal, signalDelivered: true, debuggerPipeEof: true,
    hostBacktraceCaptured: exit.signal === 'SIGABRT', embeddingModelInferencePerformed: false };
}

async function debugCapture(root, config, debuggerConfig) {
  if (!isAbsolute(debuggerConfig.binary) || !isAbsolute(debuggerConfig.commands)) {
    throw new Error('native debugger requires absolute binary and command paths');
  }
  const invocation = { binary: fingerprint(debuggerConfig.binary), commands: fingerprint(debuggerConfig.commands),
    source: fingerprint(file), node: fingerprint(process.execPath), configuration: config,
    observation: observedProcessEnvironment(),
    scope: 'small native teardown control only; debugger changes observation', embeddingModelInferencePerformed: false };
  writeFileSync(join(root, 'debugger-invocation.json'), JSON.stringify(invocation, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const stdoutFd = openSync(join(root, 'debugger.stdout.log'), 'wx', 0o600);
  const stderrFd = openSync(join(root, 'debugger.stderr.log'), 'wx', 0o600);
  const child = spawn(debuggerConfig.binary, ['-q', '-nx', '-batch', '-x', debuggerConfig.commands,
    '--args', process.execPath, file, 'target', JSON.stringify(config)], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', data => {
    if (writeSync(stdoutFd, data) !== data.length) throw new Error('short debugger stdout write');
  });
  child.stderr.on('data', data => {
    if (writeSync(stderrFd, data) !== data.length) throw new Error('short debugger stderr write');
  });
  child.once('error', error => { throw error; });
  const terminal = await new Promise(resolve => child.once('close', (exitCode, signal) => resolve({
    processId: child.pid, source: 'spawn-pipe-debugger', eof: true, exitCode, signal,
  })));
  closeSync(stdoutFd); closeSync(stderrFd);
  terminal.stdout = fingerprint(join(root, 'debugger.stdout.log'));
  terminal.stderr = fingerprint(join(root, 'debugger.stderr.log'));
  writeFileSync(join(root, 'debugger-terminal.json'), JSON.stringify(terminal, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const receipt = inspectHostDebuggerCapture(readFileSync(join(root, 'debugger.stdout.log'), 'utf8'), terminal);
  writeFileSync(join(root, 'native-debugger-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify(receipt) + '\n');
  process.exitCode = receipt.exitCode ?? 1;
}

if (!isMainThread) {
  try { parentPort.postMessage(await run(workerData)); }
  catch (error) { parentPort.postMessage({ error: String(error) }); }
} else if (process.argv[1] === file) {
  if (process.argv[2] === 'target') await target(JSON.parse(process.argv[3]));
  else if (process.argv[2] === 'allocator-target') await allocatorTarget(JSON.parse(process.argv[3]));
  else if (process.argv[2] === 'capture') await capture(process.argv[3], JSON.parse(process.argv[4]));
  else if (process.argv[2] === 'debug-capture') await debugCapture(process.argv[3], JSON.parse(process.argv[4]), JSON.parse(process.argv[5]));
  else throw new Error('expected native teardown control target or capture mode');
}
