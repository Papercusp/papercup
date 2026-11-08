/** Diagnostic preload: capture V8's actual parsed source bytes in the main
 * isolate and attached workers, including workers with execArgv: []. Only the
 * main thread owns the receipt; worker sources arrive through NodeWorker events.
 * This parsed-source census is not a claim about native libraries, file opens, subprocesses,
 * unexecuted branches, or the original bytes before a TS loader transforms them.
 * Run with PAPERCUSP_RUNTIME_SOURCE_CAPTURE=<new private file> node --import ...
 * A complete process-tree witness must reconcile these receipts with an
 * independently observed process population.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import inspector from 'node:inspector';
import { isMainThread } from 'node:worker_threads';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bindRuntimeJitDump, bindRuntimeJitMemory, bindRuntimeProcessTree } from './runtime-file-opens.mjs';

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

export function validateRuntimeSourceCapture(rows, expectedWorkerIds = [], processTerminal) {
  const header = rows[0], terminal = rows.at(-1);
  if (header?.kind !== 'start' || header.schemaVersion !== 1 || !Number.isSafeInteger(header.processId)
    || terminal?.kind !== 'terminal' || terminal.processId !== header.processId)
    throw new Error('runtime source capture lacks process/terminal identity');
  if (terminal.exitCode !== 0 || terminal.errors !== 0 || terminal.pending !== 0)
    throw new Error('runtime source capture is incomplete or failed');
  const scripts = rows.filter(row => row.kind === 'source');
  const workers = rows.filter(row => row.kind === 'worker-attached');
  if (!scripts.length || scripts.length !== terminal.sources
    || workers.length !== terminal.workers || rows.some(row => row.kind === 'error'))
    throw new Error('runtime source capture census differs from terminal receipt');
  const identities = new Set(), workerIds = new Set(workers.map(row => row.workerId));
  for (const row of scripts) {
    const key = JSON.stringify([row.target, row.scriptId]);
    if (identities.has(key) || typeof row.scriptId !== 'string' || typeof row.target !== 'string'
      || typeof row.url !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256)
      || !Number.isSafeInteger(row.bytes) || row.bytes < 0
      || row.target !== 'main' && !workerIds.has(row.target))
      throw new Error('runtime source capture has invalid or duplicate source identity');
    identities.add(key);
  }
  const workersClosedByProcessExit = [];
  for (const worker of workers) {
    const detached = rows.filter(row => row.kind === 'worker-detached' && row.workerId === worker.workerId).length;
    // Node's own ESM loader has process lifetime and need not detach before the
    // main exit hook. Require the launcher's independent close/EOF receipt;
    // never apply this exception to an application worker or a pending request.
    const closedByProcess = detached === 0 && worker.url === 'node:internal/modules/esm/worker'
      && processTerminal?.processId === header.processId && processTerminal.exitCode === 0
      && processTerminal.signal === null && processTerminal.eof === true;
    if (closedByProcess) workersClosedByProcessExit.push(worker.workerId);
    if (typeof worker.workerId !== 'string' || !worker.workerId || !worker.waitingForDebugger
      || detached !== 1 && !closedByProcess
      || !scripts.some(row => row.target === worker.workerId))
      throw new Error('runtime source capture lacks a complete worker census');
  }
  if (terminal.liveWorkers !== workersClosedByProcessExit.length)
    throw new Error('runtime source capture is incomplete or failed');
  if (workerIds.size !== workers.length || expectedWorkerIds.some(id => !workerIds.has(String(id))))
    throw new Error('runtime source capture is missing an expected worker');
  return { processId: header.processId, sources: scripts.length, workerIds: [...workerIds], workersClosedByProcessExit,
    parsedSourcePopulationComplete: true, completeRuntimeClosureVerified: false,
    scope: 'V8 parsed sources in the captured main isolate and attached workers only' };
}

/** Join the existing V8 receipts to independently traced process lifetimes.
 * Every process image must have its own complete capture. In particular, a
 * parent receipt cannot account for an uncaptured Node child, a native helper,
 * a fork without exec, or an earlier image replaced by exec. This is still
 * parsed-source evidence only: original loader inputs, executable/native bytes,
 * dependencies and creator exclusion need their separate maintained producers.
 */
export function bindRuntimeSourcePopulation(trace, terminal, captures, fileInputs, jitCaptures) {
  const processTree = bindRuntimeProcessTree(trace, terminal);
  const processes = processTree.tasks.filter(task => task.taskId === task.threadGroupId);
  if (!Array.isArray(captures) || !captures.length || captures.length !== processes.length)
    throw new Error('runtime source process population differs from independent trace');
  const byProcess = new Map();
  let sourceRows = 0;
  for (const rows of captures) {
    if (!Array.isArray(rows) || !rows.length || (sourceRows += rows.length) > 100_000)
      throw new Error('runtime source process capture population incomplete or oversized');
    const id = rows[0]?.processId;
    if (byProcess.has(id) || !processes.some(task => task.taskId === id))
      throw new Error('runtime source process capture duplicate or outside traced population');
    byProcess.set(id, rows);
  }
  const receipts = processes.map(task => {
    const rows = byProcess.get(task.taskId), header = rows?.[0], end = rows?.at(-1);
    if (!rows || task.execs.length !== 1 || task.execs[0].executable !== header.executable)
      throw new Error('runtime source process image missing, replaced or mismatched');
    const startedAtMs = Date.parse(header.startedAt), finishedAtMs = Date.parse(end?.finishedAt);
    // ISO receipts have millisecond precision; strace records microseconds.
    if (!Number.isFinite(startedAtMs) || !Number.isFinite(finishedAtMs)
      || startedAtMs < Math.floor(task.execs[0].atMs) || finishedAtMs < startedAtMs
      || finishedAtMs > Math.ceil(task.terminalAtMs))
      throw new Error('runtime source capture lies outside traced process lifetime');
    return validateRuntimeSourceCapture(rows, [], {
      processId: task.taskId, exitCode: 0, signal: null, eof: terminal.eof,
    });
  });
  let jitBindings;
  if (jitCaptures !== undefined) {
    if (!Array.isArray(jitCaptures) || jitCaptures.length !== processes.length)
      throw new Error('runtime JIT capture population differs from independent trace');
    const seen = new Set();
    let retainedBytes = 0, retainedMemoryBytes = 0;
    jitBindings = jitCaptures.map(capture => {
      const witness = capture?.witness, task = processes.find(task => task.taskId === witness?.processId);
      if (!task || seen.has(task.taskId) || !Buffer.isBuffer(capture.bytes)
        || (retainedBytes += capture.bytes.length) > 64*1024*1024)
        throw new Error('runtime JIT capture duplicate, foreign or oversized');
      seen.add(task.taskId);
      const taskIds = processTree.tasks.filter(member => member.threadGroupId === task.taskId)
        .map(member => member.taskId).sort((a,b) => a-b);
      // A child process cannot borrow its parent's dump, and a sibling's thread
      // cannot become an allowed CODE_LOAD writer through a caller's task list.
      if (!Array.isArray(witness.taskIds) || JSON.stringify([...witness.taskIds].sort((a,b) => a-b)) !== JSON.stringify(taskIds))
        throw new Error('runtime JIT task population differs from traced thread group');
      const proof = bindRuntimeJitDump(capture.bytes, witness);
      const rows = byProcess.get(task.taskId), start = rows[0], end = rows.at(-1);
      const ns = value => typeof value === 'string' && /^[1-9]\d*$/.test(value);
      if (!ns(start.monotonicNs) || !ns(end.monotonicNs)
        || BigInt(start.monotonicNs) > BigInt(end.monotonicNs)
        || BigInt(start.monotonicNs) < BigInt(witness.startedMonotonicNs)
        || BigInt(end.monotonicNs) > BigInt(witness.finishedMonotonicNs)
        || !Number.isSafeInteger(witness.startedEpochMs) || witness.startedEpochMs <= 0
        || !Number.isSafeInteger(witness.finishedEpochMs) || witness.finishedEpochMs < witness.startedEpochMs
        || witness.startedEpochMs > Math.floor(task.execs[0].atMs)
        || witness.finishedEpochMs < Math.ceil(task.terminalAtMs))
        throw new Error('runtime JIT witness does not enclose traced process and source clocks');
      let selectedMemory;
      if (capture.memory !== undefined) {
        const observation = capture.memory?.observation, identity = capture.memory?.launchIdentity;
        const parent = processTree.tasks.find(member => member.taskId === task.parentTaskId);
        if (!identity || identity.processId !== task.taskId || identity.executable !== task.execs[0].executable
          || !Number.isSafeInteger(identity.parentProcessId) || identity.parentProcessId <= 0
          || parent && identity.parentProcessId !== parent.threadGroupId
          || observation?.observerProcessId !== identity.parentProcessId
          || !ns(observation?.startedMonotonicNs) || !ns(observation?.finishedMonotonicNs)
          || BigInt(observation.startedMonotonicNs) < BigInt(start.monotonicNs)
          || BigInt(observation.finishedMonotonicNs) > BigInt(end.monotonicNs)
          || !Array.isArray(observation.samples) || observation.samples.some(sample => !Buffer.isBuffer(sample?.bytes)
            || (retainedMemoryBytes += sample.bytes.length) > 64*1024*1024))
          throw new Error('runtime JIT memory identity, source interval or byte extent differs');
        // Reparse raw terminal dump and raw parent observation. A precomputed
        // proof cannot stand in for either; selected ranges confer no custody,
        // original-source origin or process-lifetime population authority.
        selectedMemory = bindRuntimeJitMemory(capture.bytes, witness, observation, identity, capture.memory.tracerIdentity);
      }
      return { ...proof, ...(selectedMemory ? { selectedMemory } : {}),
        tracedTaskIds: taskIds, sourceCaptureSha256: digest(JSON.stringify(rows)),
        witnessSha256: digest(JSON.stringify(witness)) };
    });
  }
  return { schema: 'runtime-traced-source-population/v1', processId: processTree.processId,
    processes: receipts, tracedTaskPopulationComplete: true,
    memoryTransitions: processTree.memoryTransitions,
    mappingOrigins: processTree.mappingOrigins,
    executableMemoryQualification: processTree.executableMemoryQualification,
    jitByteCapture: jitBindings ? 'runtime-reported-code-loads-for-traced-processes' : 'not-observed',
    ...(jitBindings ? { jitBindings } : {}),
    parsedSourceProcessPopulationComplete: true, completeRuntimeClosureVerified: false,
    ...(fileInputs === undefined ? {} : { fileInputs: bindParsedFiles(captures, fileInputs) }),
    sourceQualification: 'required', dependencyQualification: 'required', creatorFence: 'required',
    scope: 'V8 parsed sources and attached workers in every independently traced single-image process' };
}

/** Compare parsed file bytes with the existing source/dependency census format.
 * This is a join, not a producer or an immutability attestation. The caller must
 * retain the original census and its sealed/build custody separately. Transformed
 * TS cannot be qualified by a matching URL or a loader's claimed source map.
 * Keep every non-file script explicit for subsequent runtime/build qualification.
 */
function bindParsedFiles(captures, input) {
  if (!input || typeof input.root !== 'string' || !isAbsolute(input.root)
    || resolve(input.root) !== input.root || !Array.isArray(input.files)
    || !input.files.length || input.files.length > 500_000)
    throw new Error('runtime source file census invalid');
  const files = new Map();
  for (const file of input.files) {
    if (!file || typeof file.path !== 'string' || !file.path || file.path.includes('\\')
      || file.path.includes('\0') || file.path.split('/').some(part => !part || part === '.' || part === '..')
      || !['file', 'symlink'].includes(file.kind) || !/^[a-f0-9]{64}$/.test(file.sha256)
      || files.has(file.path)) throw new Error('runtime source file census ambiguous');
    files.set(file.path, file);
  }
  const byUrl = new Map([...files].map(([path, file]) => [pathToFileURL(resolve(input.root, path)).href, file]));
  const bindings = [], unboundSources = [];
  for (const rows of captures) for (const row of rows.filter(row => row.kind === 'source')) {
    const identity = { processId: rows[0].processId, target: row.target, scriptId: row.scriptId,
      url: row.url, sha256: row.sha256 };
    if (!row.url.startsWith('file:') && !isAbsolute(row.url)) { unboundSources.push(identity); continue; }
    let url;
    try {
      url = isAbsolute(row.url) ? pathToFileURL(row.url).href : pathToFileURL(fileURLToPath(row.url)).href;
    } catch { throw new Error('runtime source file URL unresolved'); }
    // Queries, fragments, host aliases and noncanonical paths are not another
    // way to name an original file. In particular, loader cache URLs cannot
    // silently reuse the underlying source file's authority.
    if (!isAbsolute(row.url) && url !== row.url || isAbsolute(row.url) && resolve(row.url) !== row.url)
      throw new Error('runtime source file URL unresolved');
    const file = byUrl.get(url);
    if (!file || file.kind !== 'file' || file.sha256 !== row.sha256)
      throw new Error('runtime parsed file differs from original file census');
    bindings.push({ ...identity, path: file.path });
  }
  if (!bindings.length) throw new Error('runtime source has no file inputs to bind');
  return { censusSha256: digest(JSON.stringify(input)), bindings, unboundSources,
    originalSourceQualification: 'required', nativeDependencyQualification: 'required' };
}

export function startRuntimeSourceCapture(destination) {
  // The existing destination may opt into per-process receipts. Inherited
  // subprocess preloads then retain independent evidence instead of racing to
  // reopen the parent's write-once file. The historical exact-path mode stays
  // write-once, including its existing refusal on a second process.
  const fd = fs.openSync(destination.replaceAll('%p', String(process.pid)), 'wx', 0o600);
  const session = new inspector.Session();
  const targets = new Map(), errors = [];
  let sourceCount = 0, workerCount = 0, finished = false;
  const emit = row => fs.writeSync(fd, JSON.stringify(row) + '\n');
  const fail = (target, message) => {
    errors.push(message); emit({ kind: 'error', target, message });
  };
  emit({ kind: 'start', schemaVersion: 1, processId: process.pid,
    node: process.version, executable: process.execPath, startedAt: new Date().toISOString(),
    monotonicNs: process.hrtime.bigint().toString(),
    scope: 'parsed source bytes; native libraries, model files and other processes excluded' });
  session.connect();

  const main = { id: 'main', sources: new Set(), pending: new Map(), nextId: 0, live: true };
  main.post = (method, params, callback) => session.post(method, params, callback);
  targets.set(main.id, main);

  const capture = (target, parsed) => {
    if (target.sources.has(parsed.scriptId)) return;
    target.sources.add(parsed.scriptId);
    target.sourcePending = (target.sourcePending ?? 0) + 1;
    target.post('Debugger.getScriptSource', { scriptId: parsed.scriptId }, (error, result) => {
      target.sourcePending--;
      if (error) fail(target.id, 'getScriptSource: ' + error.message);
      else if (typeof result?.scriptSource !== 'string') fail(target.id, 'missing parsed source bytes');
      else {
        const bytes = parsed.scriptLanguage === 'WebAssembly'
          ? typeof result.bytecode === 'string' ? Buffer.from(result.bytecode, 'base64') : null
          : Buffer.from(result.scriptSource, 'utf8');
        if (!bytes) fail(target.id, 'missing WebAssembly bytecode');
        else {
          sourceCount++;
          emit({ kind: 'source', target: target.id, scriptId: parsed.scriptId, url: parsed.url,
            language: parsed.scriptLanguage ?? 'JavaScript', bytes: bytes.length, sha256: digest(bytes),
            ...(parsed.sourceMapURL ? { sourceMapSha256: digest(parsed.sourceMapURL) } : {}) });
        }
      }
      resume(target);
    });
  };
  const resume = target => {
    if (!target.paused || target.sourcePending || !target.live) return;
    target.paused = false;
    target.post('Debugger.resume', {}, error => { if (error) fail(target.id, 'resume: ' + error.message); });
  };
  const notification = (target, method, params) => {
    if (method === 'Debugger.scriptParsed') capture(target, params);
    else if (method === 'Debugger.scriptFailedToParse') fail(target.id, 'script failed to parse: ' + params.url);
    else if (method === 'Debugger.paused') { target.paused = true; resume(target); }
    else if (method === 'NodeWorker.attachedToWorker') attach(target, params);
    else if (method === 'NodeWorker.detachedFromWorker') {
      const child = [...targets.values()].find(item => item.parent === target && item.sessionId === params.sessionId);
      if (!child) return fail(target.id, 'detached unknown worker');
      child.live = false;
      if (child.pending.size || child.sourcePending) fail(child.id,
        'worker detached with pending source/protocol requests: ' + JSON.stringify({
          methods: [...child.pending.values()].map(request => request.method), sources: child.sourcePending ?? 0,
        }));
      emit({ kind: 'worker-detached', workerId: child.id });
    } else if (method === 'NodeWorker.receivedMessageFromWorker') {
      const child = [...targets.values()].find(item => item.parent === target && item.sessionId === params.sessionId);
      if (!child) return fail(target.id, 'message from unknown worker');
      let message;
      try { message = JSON.parse(params.message); } catch { return fail(child.id, 'invalid worker protocol message'); }
      if (message.id !== undefined) {
        const request = child.pending.get(message.id);
        child.pending.delete(message.id);
        if (!request) return fail(child.id, 'unknown worker protocol response');
        request.callback(message.error ? new Error(message.error.message) : null, message.result);
      } else notification(child, message.method, message.params);
    }
  };
  const attach = (parent, params) => {
    const id = params.workerInfo.workerId;
    if (targets.has(id)) return fail(id, 'duplicate worker identity');
    const target = { id, parent, sessionId: params.sessionId, sources: new Set(), pending: new Map(), nextId: 0, live: true };
    targets.set(id, target); workerCount++;
    emit({ kind: 'worker-attached', workerId: id, parent: parent.id,
      waitingForDebugger: params.waitingForDebugger, url: params.workerInfo.url });
    if (!params.waitingForDebugger) fail(id, 'worker was not paused before application execution');
    target.post = (method, args, callback) => {
      const requestId = ++target.nextId;
      target.pending.set(requestId, { method, callback });
      parent.post('NodeWorker.sendMessageToWorker', { sessionId: target.sessionId,
        message: JSON.stringify({ id: requestId, method, params: args }) }, error => {
        if (error && target.pending.delete(requestId)) callback(error);
      });
    };
    target.post('Debugger.enable', {}, error => {
      if (error) { fail(id, error.message); return; }
      // Pause before script execution so a short-lived eval/import cannot exit
      // before getScriptSource returns. Main-isolate protocol calls are local.
      target.post('Debugger.setInstrumentationBreakpoint', { instrumentation: 'beforeScriptExecution' }, error => {
        if (error) fail(id, error.message);
        target.post('Runtime.runIfWaitingForDebugger', {}, error => { if (error) fail(id, error.message); });
      });
    });
  };
  session.on('inspectorNotification', message => notification(main, message.method, message.params));
  session.post('Debugger.enable', {}, error => { if (error) fail('main', error.message); });
  session.post('NodeWorker.enable', { waitForDebuggerOnStart: true }, error => { if (error) fail('main', error.message); });

  process.once('exit', code => {
    if (finished) return;
    finished = true;
    const pending = [...targets.values()].reduce((sum, target) => sum + target.pending.size + (target.sourcePending ?? 0), 0);
    const liveWorkers = [...targets.values()].filter(target => target.id !== 'main' && target.live).length;
    emit({ kind: 'terminal', processId: process.pid, exitCode: code, sources: sourceCount,
      workers: workerCount, errors: errors.length, pending, liveWorkers, finishedAt: new Date().toISOString(),
      monotonicNs: process.hrtime.bigint().toString() });
    fs.fsyncSync(fd); fs.closeSync(fd); session.disconnect();
  });
}

if (isMainThread && process.env.PAPERCUSP_RUNTIME_SOURCE_CAPTURE)
  startRuntimeSourceCapture(process.env.PAPERCUSP_RUNTIME_SOURCE_CAPTURE);
