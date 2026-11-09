/** Passive, bounded diagnostics for Vitest's real forks lifecycle protocol. */
import childProcess from 'node:child_process';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import workerThreads, { threadId, isMainThread, getEnvironmentData, setEnvironmentData } from 'node:worker_threads';
import { channel } from 'node:diagnostics_channel';
import { captureConfigurationSnapshot, observeConfigurationReads } from '../../libs/test-config/src/configuration-snapshot.ts';
import { readProcessIdentity } from './process-identity.mjs';
import { nativeSourceRetentionLimits, validateSourcePins, observeEngineScriptExecution }
  from '../../libs/test-config/src/executed-config-load-capture.ts';
import { nativeProcessTraceEnv as candidateNativeProcessTraceEnv } from './native-process-trace-env.mjs';
import { observeProcessTermination } from '../../libs/test-config/src/process-termination-observer.mjs';

export { nativeSourceRetentionLimits };
const sourcePinsEnv = 'PC_NATIVE_LOADER_SOURCE_PINS';
const loaderCensusEnv = 'PC_NATIVE_LOADER_CENSUS';
// An explicitly enrolled census uses the same OUT artifacts and authenticated
// reader. Its count/byte budget fits within that reader's existing bounds.
/** @typedef {{ epoch: string, maxIsolates: number, closeTimeoutMs: number }} CooperativeEnrollment */
/** @typedef {({ events: number, bytes: number } | { batches: number, bytes: number }) & { cooperative?: CooperativeEnrollment }} NativeLoaderCensus */
/** @param {unknown} value @returns {NativeLoaderCensus} */
export function validateNativeLoaderCensus(value) {
  const batched = value && typeof value === 'object' && Object.hasOwn(value, 'batches');
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => ![batched ? 'batches' : 'events', 'bytes', 'cooperative'].includes(key)) ||
      (batched ? !Number.isSafeInteger(value.batches) || value.batches < 1 || value.batches > 1024 :
        !Number.isSafeInteger(value.events) || value.events < 2 || value.events > 8192) ||
      !Number.isSafeInteger(value.bytes) || value.bytes < 1024 || value.bytes > 16 * 1024 ** 2)
    throw new Error('Invalid bounded native loader census');
  if (value.cooperative !== undefined) {
    const c = value.cooperative;
    if (!batched || !c || Object.keys(c).sort().join() !== 'closeTimeoutMs,epoch,maxIsolates' ||
        typeof c.epoch !== 'string' || !/^[a-f0-9-]{36}$/.test(c.epoch) ||
        !Number.isSafeInteger(c.maxIsolates) || c.maxIsolates < 1 || c.maxIsolates > 256 ||
        !Number.isSafeInteger(c.closeTimeoutMs) || c.closeTimeoutMs < 1 || c.closeTimeoutMs > 30_000)
      throw new Error('Invalid cooperative worker enrollment');
  }
  return { ...(batched ? { batches: value.batches } : { events: value.events }), bytes: value.bytes,
    ...(value.cooperative === undefined ? {} : { cooperative: { ...value.cooperative } }) };
}

/** Qualification-only admission accounting. This is deliberately independent
 * of the passive tracer: a balanced table is NOT source-eligibility or kernel
 * death proof. The caller must join those independent observations separately.
 * Shared cells travel through worker environmentData, never workerData/options.
 * @param {{ epoch: string, maxIsolates: number, closeTimeoutMs: number, buffer?: SharedArrayBuffer, admission?: number }} options
 * @param {{ publish: (event: string, fields: any) => boolean, now?: () => number }} io
 */
export function createCooperativeWorkerCensus(options, io) {
  const { epoch, maxIsolates, closeTimeoutMs } = options;
  if (typeof epoch !== 'string' || !/^[a-f0-9-]{36}$/.test(epoch) ||
      !Number.isSafeInteger(maxIsolates) || maxIsolates < 1 || maxIsolates > 256 ||
      !Number.isSafeInteger(closeTimeoutMs) || closeTimeoutMs < 1 || closeTimeoutMs > 30_000)
    throw new Error('Invalid cooperative worker enrollment');
  // phase, constructing, next admission, faults, active hooks, fixed count,
  // release, wake sequence; then status/active hooks/thread id/parent per slot.
  const buffer = options.buffer ?? new SharedArrayBuffer((16 + 4 * maxIsolates) * 4);
  if (!(buffer instanceof SharedArrayBuffer) || buffer.byteLength !== (16 + 4 * maxIsolates) * 4)
    throw new Error('Invalid cooperative worker shared cells');
  const cells = new Int32Array(buffer), admission = options.admission ?? 0;
  if (!Number.isSafeInteger(admission) || admission < 0 || admission >= maxIsolates)
    throw new Error('Invalid cooperative worker admission');
  const epochBytes = createHash('sha256').update(JSON.stringify({ epoch, maxIsolates, closeTimeoutMs })).digest();
  if (!options.buffer) {
    Atomics.store(cells, 2, 1); Atomics.store(cells, 16, 2);
    for (let index = 0; index < 8; index++) Atomics.store(cells, 8 + index, epochBytes.readInt32LE(index * 4));
  }
  const now = io.now ?? (() => performance.now());
  const slot = id => 16 + 4 * id;
  const wake = () => { Atomics.add(cells, 7, 1); Atomics.notify(cells, 7); };
  const fault = reason => {
    Atomics.add(cells, 3, 1); wake();
    try { io.publish('cooperative-unknown', { epoch, admission, reason }); } catch {}
    return false;
  };
  const publish = (event, fields) => {
    try { if (io.publish(event, { epoch, admission, ...fields }) === true) return true; } catch {}
    return fault('failed-publication');
  };
  if (Array.from({ length: 8 }, (_, index) => Atomics.load(cells, 8 + index))
      .some((value, index) => value !== epochBytes.readInt32LE(index * 4))) fault('epoch-or-budget-mismatch');
  const snapshot = () => {
    const count = Atomics.load(cells, 2);
    return { epoch, phase: ['OPEN', 'CLOSING', 'CLOSED'][Atomics.load(cells, 0)] ?? 'UNKNOWN',
      constructing: Atomics.load(cells, 1), activeHooks: Atomics.load(cells, 4),
      faults: Atomics.load(cells, 3), fixedCount: Atomics.load(cells, 5), released: Atomics.load(cells, 6) !== 0,
      slots: Array.from({ length: Math.min(count, maxIsolates) }, (_, id) => ({ admission: id,
        status: ['missing', 'reserved', 'joined', 'aborted', 'ack'][Atomics.load(cells, slot(id))] ?? 'unknown',
        activeHooks: Atomics.load(cells, slot(id) + 1), threadId: Atomics.load(cells, slot(id) + 2),
        parent: Atomics.load(cells, slot(id) + 3) })) };
  };
  const join = id => {
    if (Atomics.compareExchange(cells, slot(admission), 1, 2) !== 1)
      return fault('missing-or-duplicate-admission');
    Atomics.store(cells, slot(admission) + 2, id); wake();
    return publish('cooperative-join', { threadId: id });
  };
  const enterHook = () => {
    Atomics.add(cells, 4, 1); Atomics.add(cells, slot(admission) + 1, 1);
    if (Atomics.load(cells, 0) !== 0 || Atomics.load(cells, slot(admission)) !== 2)
      fault('hook-after-close');
    let ended = false;
    return () => {
      if (ended) { fault('duplicate-hook-return'); return; }
      ended = true;
      Atomics.sub(cells, slot(admission) + 1, 1); Atomics.sub(cells, 4, 1); wake();
    };
  };
  // Increment BEFORE reading admission state, and reserve BEFORE native
  // construction. Even late and throwing constructors consume an identity.
  const wrap = (target, withAdmission) => new Proxy(target, {
    construct(target, args, newTarget) {
      Atomics.add(cells, 1, 1);
      const id = Atomics.add(cells, 2, 1), bounded = id < maxIsolates;
      if (Atomics.load(cells, 0) !== 0) fault('late-construction');
      if (!bounded) fault('admission-bound');
      if (bounded) {
        Atomics.store(cells, slot(id), 1); Atomics.store(cells, slot(id) + 3, admission);
        publish('cooperative-reserve', { childAdmission: id });
      }
      try {
        return withAdmission({ epoch, maxIsolates, closeTimeoutMs, buffer, admission: id },
          () => Reflect.construct(target, args, newTarget));
      } catch (error) {
        if (bounded && Atomics.compareExchange(cells, slot(id), 1, 3) !== 1)
          fault('constructor-threw-after-admission');
        publish('cooperative-abort', { childAdmission: id });
        throw error; // Never inspect or replace the native thrown value.
      } finally { Atomics.sub(cells, 1, 1); wake(); }
    },
  });
  let closeDeadline = null;
  const close = () => {
    if (admission !== 0 || Atomics.compareExchange(cells, 0, 0, 1) !== 0)
      return fault('duplicate-or-non-main-close');
    const started = now();
    closeDeadline = started + closeTimeoutMs;
    publish('cooperative-closing', { monotonicMs: started }); wake();
    for (;;) {
      const seen = Atomics.load(cells, 7), count = Atomics.load(cells, 2);
      const pending = count > maxIsolates || Atomics.load(cells, 1) !== 0 ||
        Array.from({ length: Math.min(count, maxIsolates) }, (_, id) => Atomics.load(cells, slot(id)))
          .some(status => status !== 2 && status !== 3);
      if (!pending) {
        Atomics.store(cells, 5, count); Atomics.store(cells, 0, 2); wake();
        return publish('cooperative-closed', { monotonicMs: now(), population: snapshot() });
      }
      const left = closeDeadline - now();
      if (left <= 0) return fault('close-timeout');
      Atomics.wait(cells, 7, seen, Math.min(left, 10));
    }
  };
  let acknowledged = false;
  const acknowledge = finish => {
    if (acknowledged || Atomics.load(cells, 0) !== 2 || Atomics.load(cells, slot(admission)) !== 2 ||
        Atomics.load(cells, slot(admission) + 1) !== 0)
      return fault('duplicate-missing-or-pending-end-ack');
    acknowledged = true;
    let end;
    try { end = finish(); } catch { return fault('failed-publication'); }
    if (!end || !publish('cooperative-end-ack', { threadId, end, monotonicMs: now() })) return false;
    Atomics.store(cells, slot(admission), 4); wake();
    return true;
  };
  const awaitAcknowledgements = () => {
    for (;;) {
      const seen = Atomics.load(cells, 7), state = snapshot();
      if (state.phase === 'CLOSED' && state.constructing === 0 && state.activeHooks === 0 &&
          state.slots.length === state.fixedCount && state.slots.every(row => ['ack', 'aborted'].includes(row.status)))
        return state.faults === 0 && publish('cooperative-held', { population: state, monotonicMs: now() });
      const left = (closeDeadline ?? now()) - now();
      if (left <= 0) return fault('close-timeout');
      Atomics.wait(cells, 7, seen, Math.min(left, 10));
    }
  };
  const hold = () => {
    while (Atomics.load(cells, 6) === 0) Atomics.wait(cells, 6, 0);
    // Only a failed native kill releases a live isolate. A release can NEVER
    // produce qualification; successful holds end at independent kernel K.
    return fault('observer-released-before-kernel-death');
  };
  const release = () => {
    fault('native-kill-failed'); Atomics.store(cells, 6, 1); Atomics.notify(cells, 6); wake();
  };
  const waitForClose = async () => {
    for (;;) {
      const seen = Atomics.load(cells, 7);
      if (Atomics.load(cells, 6) !== 0) return false;
      if (Atomics.load(cells, 0) === 2) return true;
      await Atomics.waitAsync(cells, 7, seen).value;
    }
  };
  return { buffer, admission, epoch, snapshot, fault, join, enterHook, wrap, close,
    acknowledge, awaitAcknowledgements, hold, release, waitForClose };
}
/** Reuse the OUT channel and this preload without enabling stderr diagnostics.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ enabled?: boolean, pinnedSources?: Array<{ path: string, sha256: string, byteLength: number }>, loaderCensus?: NativeLoaderCensus }} [options]
 * Source-owned prediction and independent artifact pins before launch. The
 * default diagnostic limits stay unchanged; an enrolled census declares its
 * own finite event/byte budget and reports exhaustion instead of completeness.
 */
export function nativeProcessTraceEnv(env = process.env, options = {}) {
  const traced = candidateNativeProcessTraceEnv(env, options);
  if (traced === env) return traced;
  return { ...traced,
    ...(options.pinnedSources === undefined ? {} :
      { [sourcePinsEnv]: JSON.stringify(validateSourcePins(options.pinnedSources)) }),
    ...(options.loaderCensus === undefined ? {} :
      { [loaderCensusEnv]: JSON.stringify(validateNativeLoaderCensus(options.loaderCensus)) }),
  };
}

// These are observations, not a shell parser or a complete execution census.
// Preserve each Node entry/exit and npm's actual exported spawn calls, including
// lifecycle scripts. Missing preloads, shell builtins, signals and private spawn
// implementations remain gaps in the parent receipt. Never alter stdio/options.
function installNativeProcessTrace(out) {
  const identity = randomUUID();
  const runGroupId = process.env.PAPERCUSP_TEST_RUN_GROUP ?? null;
  // A trace channel has its own UUID (including worker threads). The kernel
  // identity independently pins the OS process; neither can stand in for the other.
  const kernelProcessIdentity = readProcessIdentity(process.pid);
  let root;
  try {
    const path = `${out}.native-processes`;
    mkdirSync(path, { recursive: true, mode: 0o700 });
    if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) return;
    root = realpathSync(path);
  } catch { return; }
  const lifecycle = env => ({ event: env.npm_lifecycle_event ?? null,
    script: env.npm_lifecycle_script ?? null });
  // An interrupted direct write leaves a final hash-named file empty or partial.
  // Publish completed bytes by a no-replace hard link; interrupted staging files
  // stay outside the trusted event directory and are removed with the run root.
  const publish = (path, bytes) => {
    const temporary = `${root}.pending-${identity}-${randomUUID()}`;
    try {
      writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
      try { linkSync(temporary, path); }
      catch (error) { if (error?.code !== 'EEXIST') throw error; }
    } finally {
      try { unlinkSync(temporary); } catch { /* A killed writer may leave only staging evidence. */ }
    }
  };
  // Keep the 512 ordinary-event allowance, reserving process evidence so
  // loader traffic cannot hide a later spawn/close. Each exhausted portion
  // has its own marker; module gaps cannot establish complete imports.
  const remaining = { module: 384, general: 128 };
  let loaderCensus = null, invalidLoaderCensus = false;
  try {
    const encoded = process.env[loaderCensusEnv];
    if (encoded !== undefined) {
      if (encoded.length > 256) throw new Error('loader census enrollment too large');
      loaderCensus = validateNativeLoaderCensus(JSON.parse(encoded));
    }
  } catch { invalidLoaderCensus = true; }
  const censusUsage = { events: 0, bytes: 0, batches: 0, stopped: false };
  // Lossless packets reuse the authenticated OUT event protocol. The byte
  // allowance is unchanged; packing removes one-file-per-event amplification.
  // An unsealed final packet is never evidence of a complete census.
  let censusRows = [], censusPacketBytes = 2;
  const censusHash = createHash('sha256');
  const flushCensus = () => {
    if (!censusRows.length) return;
    const events = censusRows;
    censusRows = []; censusPacketBytes = 2;
    const batchId = ++censusUsage.batches;
    if (emit('module-census-batch', { batchId, events }, true) !== true) {
      censusUsage.stopped = true;
      emit('module-census-unavailable', { batchId }, true);
    }
  };
  let cooperativeSequence = 0;
  const emit = (event, fields = {}, terminal = false) => {
    const observationScope = event.startsWith('module-') ? 'module' : 'general';
    const censusEvent = !terminal && observationScope === 'module' && loaderCensus;
    if (censusEvent ? censusUsage.stopped : !terminal && remaining[observationScope]-- < 0) return;
    try {
      let row = { schemaVersion: 1, kind: 'native-node-process-event', event,
        processIdentity: identity, kernelProcessIdentity,
        pid: process.pid, ppid: process.ppid, atMs: Date.now(), ...fields, threadId, runGroupId,
        ...(loaderCensus?.cooperative ? { cooperativeSequence: ++cooperativeSequence } : {}) };
      if (!censusEvent && !terminal && remaining[observationScope] === -1)
        row = { ...row, event: 'trace-limit', observationScope };
      let bytes = Buffer.from(JSON.stringify(row));
      if (censusEvent) {
        const batched = Object.hasOwn(loaderCensus, 'batches');
        if (batched && censusRows.length &&
            (censusRows.length === 128 || censusPacketBytes + bytes.length + 1 > 120 * 1024)) flushCensus();
        const eventLimit = !batched && censusUsage.events >= loaderCensus.events;
        const batchLimit = batched && !censusRows.length && censusUsage.batches >= loaderCensus.batches;
        if (censusUsage.stopped || eventLimit || batchLimit || bytes.length > 120 * 1024 ||
            bytes.length > loaderCensus.bytes - censusUsage.bytes) {
          censusUsage.stopped = true;
          row = { ...row, event: 'trace-limit', observationScope,
            reason: eventLimit ? 'loader-census-events' : batchLimit ? 'loader-census-batches' : 'loader-census-bytes',
            limits: loaderCensus, retained: { events: censusUsage.events, bytes: censusUsage.bytes } };
          bytes = Buffer.from(JSON.stringify(row));
        } else {
          censusUsage.events++;
          censusUsage.bytes += bytes.length;
          if (batched) {
            censusHash.update(bytes).update('\n');
            censusRows.push(row); censusPacketBytes += bytes.length + 1;
            return true;
          }
        }
      }
      if (event === 'engine-script-execution' && bytes.length > 128 * 1024 &&
          row.observation && bytes.length <= nativeSourceRetentionLimits.processBytes) {
        const observationBytes = Buffer.from(JSON.stringify(row.observation));
        const sha256 = createHash('sha256').update(observationBytes).digest('hex');
        const ref = `${sha256}.engine`;
        publish(join(root, ref), observationBytes);
        // Attachments use the same no-replace custody as event files.
        if (!lstatSync(join(root, ref)).isFile() || lstatSync(join(root, ref)).isSymbolicLink() ||
            !readFileSync(join(root, ref)).equals(observationBytes)) throw new Error('engine observation changed');
        const { observation, ...envelope } = row;
        row = { ...envelope, observationArtifact: { ref, sha256, byteLength: observationBytes.length } };
        bytes = Buffer.from(JSON.stringify(row));
      }
      if (bytes.length > 128 * 1024) {
        bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: row.kind,
          event: 'trace-event-too-large', processIdentity: identity, kernelProcessIdentity, pid: process.pid,
          ppid: process.ppid, atMs: row.atMs, omittedEvent: event, threadId, runGroupId }));
      }
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const path = join(root, `${sha256}.json`);
      publish(path, bytes);
      // Do not replace redirected or changed evidence on a repeated write.
      if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() ||
          !readFileSync(path).equals(bytes)) return;
      return true;
    } catch { /* Observation failures never change the native command. */ }
  };
  if (invalidLoaderCensus) emit('module-census-invalid', {}, true);
  // Record inputs accepted by each process's Writable API, without adding data
  // listeners, changing its stdio, or replacing callbacks/return/error values.
  // Direct fd/native writes and inherited child output remain outside this scope.
  const streams = {};
  for (const role of ['stdout', 'stderr']) {
    const stream = process[role], originalWrite = stream.write;
    const state = streams[role] = { chunks: [], observedByteLength: 0, capturedBytes: 0,
      captureComplete: true, sequence: 0 };
    stream.write = function(chunk, ...args) {
      let bytes = null;
      const order = state.sequence++;
      try {
        if (this === stream) bytes = typeof chunk === 'string' ? Buffer.from(chunk,
          typeof args[0] === 'string' ? args[0] : stream._writableState?.defaultEncoding ?? 'utf8') :
          ArrayBuffer.isView(chunk) ? Buffer.from(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)) : null;
      } catch { /* The original write owns validation and errors. */ }
      const result = originalWrite.call(this, chunk, ...args);
      try {
        if (this === stream) {
          if (bytes === null) state.captureComplete = false;
          else {
            state.observedByteLength += bytes.length;
            const available = Math.max(0, 16 * 1024 * 1024 - state.capturedBytes);
            if (bytes.length > available || state.chunks.length >= 16384) state.captureComplete = false;
            if (available > 0 && bytes.length > 0 && state.chunks.length < 16384) {
              const retained = bytes.subarray(0, available);
              state.chunks.push({ order, bytes: retained });
              state.capturedBytes += retained.length;
            }
          }
        }
      } catch { state.captureComplete = false; }
      return result;
    };
  }
  const retainStreams = () => Object.fromEntries(Object.entries(streams).map(([role, state]) => {
    const scope = 'node-writable-call-inputs';
    try {
      const bytes = Buffer.concat(state.chunks.sort((a, b) => a.order - b.order).map(row => row.bytes));
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const ref = `${sha256}.stream`, path = join(root, ref);
      publish(path, bytes);
      if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || !readFileSync(path).equals(bytes))
        throw new Error('redirected or changed stream artifact');
      return [role, { scope, ref, sha256, byteLength: bytes.length,
        observedByteLength: state.observedByteLength, captureComplete: state.captureComplete }];
    } catch { return [role, { scope, captureComplete: false, artifactUnavailable: true }]; }
  }));
  let migrationSequence = 0, migrationBytes = 0;
  channel('papercusp:migration-transaction').subscribe(message => {
    try {
      if (!message || !['planned', 'returned', 'failed'].includes(message.phase)
        || typeof message.attemptId !== 'string' || !/^[a-f0-9-]{36}$/.test(message.attemptId)
        || typeof message.file !== 'string' || message.file.length > 512 || !message.file.endsWith('.sql')
        || typeof message.migrationPath !== 'string' || !isAbsolute(message.migrationPath)
        || message.migrationPath.length > 4096
        || !Number.isSafeInteger(message.chunkIndex) || message.chunkIndex < 0
        || !Number.isSafeInteger(message.chunkCount) || message.chunkCount <= message.chunkIndex
        || message.chunkCount > 256 || !Number.isSafeInteger(message.attempt) || message.attempt < 1
        || message.attempt > 256 || message.isFinalChunk !== (message.chunkIndex === message.chunkCount - 1))
        throw new Error('invalid migration observation');
      const retain = value => {
        if (typeof value !== 'string') throw new Error('missing migration bytes');
        const bytes = Buffer.from(value);
        if (!bytes.length || bytes.length > 8 * 1024 * 1024
          || migrationBytes + bytes.length > 64 * 1024 * 1024) throw new Error('migration byte limit');
        migrationBytes += bytes.length;
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const ref = `${sha256}.source`, path = join(root, ref);
        publish(path, bytes);
        if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || !readFileSync(path).equals(bytes))
          throw new Error('redirected or changed migration artifact');
        return { ref, sha256, byteLength: bytes.length };
      };
      const rawSource = retain(message.rawSource), query = retain(message.query);
      if (rawSource.sha256 !== message.rawSourceSha256) throw new Error('migration raw source digest differs');
      emit('migration-transaction', { runGroupId, scope: 'migration-client-unsafe-query',
        sequence: ++migrationSequence, phase: message.phase, attemptId: message.attemptId,
        file: message.file, migrationPath: message.migrationPath,
        chunkIndex: message.chunkIndex, chunkCount: message.chunkCount, attempt: message.attempt,
        isFinalChunk: message.isFinalChunk, rawSource, query });
    } catch { emit('migration-transaction-unavailable', { runGroupId }); }
  });
  // Extend the existing per-process trace rather than creating a second
  // evidence writer. Only catalogue bytes returned in this process are hashed;
  // endpoint scans and the parent's schema prediction never enter this channel.
  channel('papercusp:api-worker-schema').subscribe(message => {
    try {
      if (!message || message.unavailable || !Array.isArray(message.rows)
        || message.rows.length === 0 || message.rows.length > 32768
        || !Number.isSafeInteger(message.backendPid) || message.backendPid <= 0
        || typeof message.query !== 'string' || message.query.length > 4096)
        throw new Error('schema observation unavailable or limited');
      const schema = {};
      let inputBytes = 0;
      for (const row of message.rows) {
        if (row.table_schema !== 'harness_shared'
          || !['table_name', 'column_name', 'data_type', 'udt_name', 'is_nullable'].every(key =>
            typeof row[key] === 'string' && row[key].length > 0 && row[key].length <= 256)
          || !['YES', 'NO'].includes(row.is_nullable)
          || !(row.column_default === null || typeof row.column_default === 'string' && row.column_default.length <= 65536)
          || !Number.isSafeInteger(row.ordinal_position) || row.ordinal_position <= 0)
          throw new Error('invalid schema column');
        const key = `${row.table_schema}.${row.table_name}.${row.column_name}`;
        if (Object.hasOwn(schema, key)) throw new Error('duplicate schema column');
        const columnBytes = Buffer.from(JSON.stringify({ table_schema: row.table_schema,
          table_name: row.table_name, column_name: row.column_name, data_type: row.data_type,
          udt_name: row.udt_name, is_nullable: row.is_nullable, column_default: row.column_default,
          ordinal_position: row.ordinal_position }));
        inputBytes += columnBytes.length;
        if (inputBytes > 8 * 1024 * 1024) throw new Error('schema input byte limit');
        schema[key] = createHash('sha256').update(columnBytes).digest('hex');
      }
      const bytes = Buffer.from(JSON.stringify(schema));
      if (bytes.length > 8 * 1024 * 1024) throw new Error('schema byte limit');
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const ref = `${sha256}.schema`, path = join(root, ref);
      publish(path, bytes);
      if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || !readFileSync(path).equals(bytes))
        throw new Error('redirected or changed schema artifact');
      emit('api-worker-schema', { runGroupId, scope: 'api-worker-information-schema-columns',
        backendPid: message.backendPid, querySha256: createHash('sha256').update(message.query).digest('hex'),
        columns: message.rows.length, artifact: { ref, sha256, byteLength: bytes.length } });
    } catch { emit('api-worker-schema-unavailable', { runGroupId }); }
  });
  try {
    emit('node-entry', { executable: process.execPath, argv: process.argv.slice(),
      execArgv: process.execArgv.slice(), cwd: process.cwd(), lifecycle: lifecycle(process.env),
      nodeOptions: loaderIdentity(process.env.NODE_OPTIONS), reporterOut: process.env.PC_EXECUTED_SOURCE_MAP_OUT ?? null,
      runGroupId, loaderCensus,
      // Reuse the ledger's hashed configuration-input contract. This is the
      // original process at entry, not resolved config or later mutations.
      configuration: captureConfigurationSnapshot(process.env) });
  } catch { /* Even an unavailable cwd must not prevent the native entry. */ }
  let configurationReads = null;
  try {
    configurationReads = observeConfigurationReads(process.env);
    process.env = configurationReads.environment;
  } catch { /* A missing observer remains unknown in the terminal receipt. */ }
  let cooperative = null;
  const cooperativeKey = 'papercusp.cooperative-worker-census.v1';
  if (loaderCensus?.cooperative) {
    try {
      const inherited = getEnvironmentData(cooperativeKey);
      cooperative = createCooperativeWorkerCensus({ ...loaderCensus.cooperative,
        ...(isMainThread ? {} : inherited) }, { publish: (event, fields) => emit(event, fields, true) === true });
      if (!isMainThread) {
        if (!inherited || inherited.epoch !== loaderCensus.cooperative.epoch)
          cooperative.fault('unaccounted-worker');
        else cooperative.join(threadId);
      }
      const originalWorker = workerThreads.Worker;
      workerThreads.Worker = cooperative.wrap(originalWorker, (enrollment, construct) => {
        const previous = getEnvironmentData(cooperativeKey);
        setEnvironmentData(cooperativeKey, enrollment);
        try {
          const worker = construct();
          const terminate = worker.terminate;
          worker.terminate = function(...args) {
            cooperative.fault('early-worker-termination-request');
            return Reflect.apply(terminate, this, args);
          };
          worker.once('exit', () => cooperative.fault('early-unexpected-exit'));
          return worker;
        } finally { setEnvironmentData(cooperativeKey, previous); }
      });
      syncBuiltinESMExports();
      emit('cooperative-installed', { epoch: cooperative.epoch, admission: cooperative.admission,
        threadId, supportedViews: 6, installationScope: 'pre-application-public-worker-views' }, true);
    } catch { emit('cooperative-unknown', { reason: 'installation-failed' }, true); }
  }
  // A preload's exit listener would run before the program's later listeners
  // and silently lose their writes. Delegate the original emission first and
  // retain bytes after its synchronous listeners, preserving its return/throw.
  const originalEmit = process.emit;
  let engine = null;
  process.emit = function(event, ...args) {
    if (this !== process || event !== 'exit') return originalEmit.call(this, event, ...args);
    // The program's own exit listeners can block. Preserve entry before calling
    // them so a killed process is distinguishable from one that never emitted
    // exit. This does not assert that shutdown or stream retention completed.
    emit('node-exit-start', { code: args[0] }, true);
    let listenersComplete = false;
    try {
      const result = originalEmit.call(this, event, ...args);
      listenersComplete = true;
      return result;
    } finally {
      if (!listenersComplete) for (const state of Object.values(streams)) state.captureComplete = false;
      if (loaderCensus && Object.hasOwn(loaderCensus, 'batches')) {
        try {
          flushCensus();
          emit('module-census-end', { ...censusUsage, sha256: censusHash.copy().digest('hex') }, true);
        } catch { emit('module-census-unavailable', {}, true); }
      }
      try {
        if (engine) emit('engine-script-execution', { observation: engine.snapshot(),
          termination: { phase: 'exit', exitCode: args[0], signal: null } }, true);
      } catch { emit('engine-script-execution-unavailable', {}, true); }
      finally { engine?.disconnect(); }
      try {
        if (configurationReads) emit('configuration-reads', {
          runGroupId,
          observation: configurationReads.finish(process.env),
        }, true);
        else emit('configuration-reads-unavailable', {}, true);
      } catch { emit('configuration-reads-unavailable', {}, true); }
      emit('node-exit', { code: args[0], exitListenersComplete: listenersComplete, streams: retainStreams() }, true);
    }
  };
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = function(command, ...args) {
    const childIdentity = randomUUID();
    let nativeChannel;
    try {
      const argv = Array.isArray(args[0]) ? args[0] : [];
      const optionsIndex = Array.isArray(args[0]) ? 1 : 0;
      const options = args[optionsIndex] ?? {};
      const env = options.env ?? process.env;
      const plan = readNativeEnrollment(`${out}.native-channels.json`);
      if (plan?.kind === 'qualification-native-channels' && plan.outPath === out &&
          plan.cwd === String(options.cwd ?? process.cwd()) &&
          Array.isArray(plan.channels) && plan.channels.length <= 64 &&
          ['sh', '/bin/sh'].includes(command) && argv.length === 2 && argv[0] === '-c' && !options.shell) {
        for (const channel of plan.channels) {
          if (channel.script !== env.npm_lifecycle_event || channel.command !== env.npm_lifecycle_script ||
              channel.command !== argv[1] || !Number.isSafeInteger(channel.step) || channel.step < 0 ||
              channel.outPath !== `${out}.step-${channel.step}`) continue;
          const claim = { schemaVersion: 1, kind: 'native-channel-binding', traceOut: out,
            outPath: channel.outPath, processIdentity: identity, childIdentity,
            parentPid: process.pid, script: channel.script, command: channel.command, step: channel.step };
          const bytes = Buffer.from(JSON.stringify(claim));
          const path = `${channel.outPath}.binding.json`;
          publish(path, bytes);
          // A repeated invocation takes the next unused matching occurrence.
          if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() ||
              lstatSync(path).size > 16 * 1024) throw new Error('native-channel-binding-unreadable');
          const retained = readFileSync(path);
          if (!retained.equals(bytes)) {
            const previous = JSON.parse(retained.toString('utf8'));
            if (previous.kind !== claim.kind || previous.schemaVersion !== 1 ||
                previous.traceOut !== out || previous.outPath !== channel.outPath ||
                previous.script !== channel.script || previous.command !== channel.command ||
                previous.step !== channel.step || !Number.isSafeInteger(previous.parentPid) ||
                typeof previous.processIdentity !== 'string' || typeof previous.childIdentity !== 'string')
              throw new Error('native-channel-binding-conflict');
            continue;
          }
          nativeChannel = claim;
          args[optionsIndex] = { ...options, env: { ...env, PC_EXECUTED_SOURCE_MAP_OUT: channel.outPath } };
          break;
        }
      }
    } catch {
      emit('native-channel-unavailable', { childIdentity });
      // Observation failures preserve the original command and cannot settle a channel.
    }
    let child;
    try { child = originalSpawn.call(this, command, ...args); }
    catch (error) {
      emit('child-spawn-error', { childIdentity, errorCode: error?.code ?? null });
      throw error;
    }
    try {
      const argv = Array.isArray(args[0]) ? args[0].slice() : [];
      const options = (Array.isArray(args[0]) ? args[1] : args[0]) ?? {};
      emit('child-spawn', { childIdentity, childPid: child.pid ?? null, command, argv,
        cwd: options.cwd == null ? process.cwd() : String(options.cwd),
        shell: options.shell ?? false, lifecycle: lifecycle(options.env ?? process.env),
        stdioAccessible: { stdout: Boolean(child.stdout), stderr: Boolean(child.stderr) },
        ...(nativeChannel ? { nativeChannel } : {}) });
      child.once('close', (code, signal) => emit('child-close', {
        childIdentity, childPid: child.pid ?? null, code, signal }));
    } catch { /* Return the exact native child even if observation fails. */ }
    return child;
  };
  // Synchronous probes bypass spawn's exported wrapper. Retain their call
  // boundary even when a preload never reaches our node-entry observation.
  // An absent child entry remains unknown; only the native result supplies
  // its PID, exit/signal and transport error. Never alter arguments or result.
  const originalSpawnSync = childProcess.spawnSync;
  childProcess.spawnSync = function(command, ...args) {
    const childIdentity = randomUUID(), started = performance.now();
    try {
      const argv = Array.isArray(args[0]) ? args[0].slice() : [];
      const options = (Array.isArray(args[0]) ? args[1] : args[0]) ?? {};
      emit('child-spawn-sync-start', { childIdentity, command, argv,
        cwd: options.cwd == null ? process.cwd() : String(options.cwd),
        shell: options.shell ?? false, timeout: options.timeout ?? null,
        lifecycle: lifecycle(options.env ?? process.env) });
    } catch { /* Observation cannot prevent the native call. */ }
    let result;
    try { result = originalSpawnSync.call(this, command, ...args); }
    catch (error) {
      // A diagnostic must not invoke a user error's getter or replace the
      // original exception if inspecting it throws (including a Proxy trap).
      let errorCode = null;
      try {
        const descriptor = Object.getOwnPropertyDescriptor(error ?? {}, 'code');
        if (descriptor && 'value' in descriptor && typeof descriptor.value === 'string') errorCode = descriptor.value;
      } catch { /* The native thrown value is still authoritative. */ }
      emit('child-spawn-sync-error', { childIdentity, errorCode,
        elapsedMs: performance.now() - started });
      throw error;
    }
    try {
      emit('child-spawn-sync-return', { childIdentity, childPid: result.pid ?? null,
        code: result.status, signal: result.signal, errorCode: result.error?.code ?? null,
        elapsedMs: performance.now() - started });
    } catch { /* Return the exact native result despite observation failure. */ }
    return result;
  };
  syncBuiltinESMExports();

  // Process entry alone cannot distinguish a loader wait from Vitest startup.
  // A synchronous hook observes the call into the remaining loader chain,
  // including async hooks on Node's loader thread. Persist the attempt before
  // delegation so a killed/stuck child still names its last file boundary.
  // These are load observations, never claims that a module was evaluated.
  let loadSequence = 0, resolveSequence = 0, observedLoadSequence = 0;
  const sourceByteLimit = nativeSourceRetentionLimits.sourceBytes;
  const sourceTotalByteLimit = nativeSourceRetentionLimits.processBytes;
  let sourceBytesHashed = 0, pinnedBytesHashed = 0;
  let sourcePins = [];
  try {
    const encoded = process.env[sourcePinsEnv] ?? '[]';
    if (encoded.length > 8192) throw new Error('source pin enrollment too large');
    sourcePins = validateSourcePins(JSON.parse(encoded));
  } catch { emit('module-source-pins-invalid'); }
  // Reuse the bounded independent prelaunch pins and the existing V8 observer.
  // Loader return and script parsing alone never establish execution.
  if (sourcePins.length) {
    try { engine = observeEngineScriptExecution(process.cwd(), {
      pinnedSources: sourcePins, repositorySources: false,
    }); } catch { emit('engine-script-execution-unavailable'); }
  }
  const finishCooperativeCensus = termination => {
    try {
      if (engine && emit('engine-script-execution', { observation: engine.snapshot(), termination }, true) !== true)
        return null;
      if (!configurationReads || emit('configuration-reads', {
        runGroupId, observation: configurationReads.finish(process.env), termination,
      }, true) !== true) return null;
      flushCensus();
      const end = { ...censusUsage, sha256: censusHash.copy().digest('hex'), termination };
      return !end.stopped && emit('module-census-end', end, true) === true ? end : null;
    } catch { return null; }
  };
  if (cooperative && !isMainThread) {
    cooperative.waitForClose().then(closed => {
      if (!closed) return;
      cooperative.acknowledge(() => finishCooperativeCensus({ phase: 'cooperative-close',
        epoch: cooperative.epoch, admission: cooperative.admission }));
      cooperative.hold();
    }).catch(() => cooperative.fault('closure-wait-failed'));
    process.once('exit', () => cooperative.fault('early-unexpected-exit'));
  }
  if (engine || loaderCensus) {
    const observedSignals = new Set();
    observeProcessTermination(termination => {
      if (termination.phase !== 'signal' || observedSignals.has(termination.signal)) return;
      observedSignals.add(termination.signal);
      flushCensus();
      // An application handler may SIGKILL itself without emitting exit. Keep
      // this bounded signal-time prefix distinct from a completed shutdown;
      // the existing observer preserves application/default signal semantics.
      try { if (engine) emit('engine-script-execution', { observation: engine.snapshot(), termination }, true); }
      catch { emit('engine-script-execution-unavailable', { termination }, true); }
    }, { beforeSelfKill(request) {
      const termination = { ...request, requestId: randomUUID() };
      // This is a request prefix. A reader needs the independently observed
      // native parent result before it can accept this census as terminal.
      emit('node-self-kill-request', { termination }, true);
      if (cooperative) {
        if (!isMainThread) cooperative.fault('worker-self-kill');
        else if (cooperative.close()) {
          cooperative.acknowledge(() => finishCooperativeCensus(termination));
          cooperative.awaitAcknowledgements();
        }
        return; // The unchanged native kill runs even after a failed close.
      }
      try { if (engine) emit('engine-script-execution', { observation: engine.snapshot(), termination }, true); }
      catch { emit('engine-script-execution-unavailable', { termination }, true); }
      try {
        if (configurationReads) emit('configuration-reads', {
          runGroupId, observation: configurationReads.finish(process.env), termination,
        }, true);
      } catch { emit('configuration-reads-unavailable', { termination }, true); }
      if (loaderCensus && Object.hasOwn(loaderCensus, 'batches')) {
        try {
          flushCensus();
          emit('module-census-end', { ...censusUsage, sha256: censusHash.copy().digest('hex'), termination }, true);
        } catch { emit('module-census-unavailable', { termination }, true); }
      }
    }, selfKillFailed() { cooperative?.release(); } });
  }
  // Retain loader-returned bytes in bounded chunks. In particular, do not make
  // another full UTF-8 copy of the product bundle already owned by the loader.
  function* chunks(source) {
    if (typeof source === 'string') {
      for (let offset = 0; offset < source.length;) {
        let end = Math.min(source.length, offset + 16 * 1024);
        if (end < source.length && source.charCodeAt(end - 1) >= 0xd800 &&
            source.charCodeAt(end - 1) <= 0xdbff) end--;
        yield Buffer.from(source.slice(offset, end));
        offset = end;
      }
    } else {
      const bytes = ArrayBuffer.isView(source) ?
        new Uint8Array(source.buffer, source.byteOffset, source.byteLength) : new Uint8Array(source);
      for (let offset = 0; offset < bytes.length; offset += 64 * 1024)
        yield bytes.subarray(offset, offset + 64 * 1024);
    }
  }
  const fingerprintSource = (result, url) => {
    const observation = { scope: 'node-loader-returned-source', byteLimit: sourceByteLimit,
      totalByteLimit: sourceTotalByteLimit };
    try {
      // Hash the loader's returned bytes, which may differ from the file on disk.
      // Missing source is an explicit gap; never re-read the URL as a substitute.
      const source = result.source, text = typeof source === 'string';
      if (source == null) return { ...observation, status: 'unavailable' };
      const view = ArrayBuffer.isView(source);
      if (!text && !view && !(source instanceof ArrayBuffer))
        return { ...observation, status: 'unsupported' };
      const expected = sourcePins.find(pin => fileURLToPath(url) === pin.path);
      if (expected) {
        const pin = { ...observation, admission: 'independently-pinned-large-source-v1',
          byteLimit: nativeSourceRetentionLimits.pinnedSourceBytes,
          totalByteLimit: nativeSourceRetentionLimits.pinnedProcessBytes };
        if ((text ? source.length : source.byteLength) > pin.byteLimit)
          return { ...pin, status: 'limit', limit: 'pinned-source-byte-limit' };
        const byteLength = text ? Buffer.byteLength(source) : source.byteLength;
        if (byteLength > pin.byteLimit || byteLength > pin.totalByteLimit - pinnedBytesHashed)
          return { ...pin, status: 'limit', byteLength, limit: 'pinned-source-byte-limit' };
        pinnedBytesHashed += byteLength; // Failed attempts consume their budget too.
        if (byteLength !== expected.byteLength)
          return { ...pin, status: 'unavailable', reason: 'pinned-source-length-mismatch' };
        const temporary = `${root}.pending-${identity}-${randomUUID()}`;
        let fd;
        try {
          fd = openSync(temporary, 'wx', 0o600);
          const hash = createHash('sha256');
          for (const chunk of chunks(source)) {
            hash.update(chunk);
            for (let offset = 0; offset < chunk.length;)
              offset += writeSync(fd, chunk, offset, chunk.length - offset);
          }
          closeSync(fd); fd = undefined;
          const sha256 = hash.digest('hex');
          if (sha256 !== expected.sha256)
            return { ...pin, status: 'unavailable', reason: 'pinned-source-digest-mismatch' };
          const ref = `${sha256}.source`;
          try { linkSync(temporary, join(root, ref)); }
          catch (error) { if (error?.code !== 'EEXIST') throw error; }
          return { ...pin, status: 'hashed', sha256, byteLength, ref };
        } finally {
          if (fd !== undefined) closeSync(fd);
          try { unlinkSync(temporary); } catch { /* Unfinished captures remain untrusted. */ }
        }
      }
      const remaining = sourceTotalByteLimit - sourceBytesHashed;
      // UTF-8 is at least as long as a string's UTF-16 code-unit count. Bound
      // even the byte-length scan before touching a very large returned string.
      const minimumByteLength = text ? source.length : source.byteLength;
      const limit = minimumByteLength > sourceByteLimit ? 'source-byte-limit' :
        minimumByteLength > remaining ? 'process-byte-limit' : null;
      if (limit) return { ...observation, status: 'limit', limit, minimumByteLength };
      const byteLength = text ? Buffer.byteLength(source) : source.byteLength;
      if (byteLength > sourceByteLimit || byteLength > remaining)
        return { ...observation, status: 'limit', byteLength,
          limit: byteLength > sourceByteLimit ? 'source-byte-limit' : 'process-byte-limit' };
      const bytes = text ? source : view ?
        new Uint8Array(source.buffer, source.byteOffset, source.byteLength) : new Uint8Array(source);
      sourceBytesHashed += byteLength; // Failed hashing attempts consume the same budget.
      const pin = { ...observation, status: 'hashed', byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex') };
      // The reader authenticates this reference before archival. A collision
      // never overwrites an existing artifact or changes the native load.
      const ref = `${pin.sha256}.source`;
      try {
        publish(join(root, ref), text ? Buffer.from(source) :
          Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
        return { ...pin, ref };
      } catch { return { ...pin, artifactUnavailable: true }; }
    } catch {
      // Observation must not convert a successful loader return into a failure.
      return { ...observation, status: 'unavailable', reason: 'source-fingerprint-failed' };
    }
  };
  // Independently enrolled paths have their own existing count/byte bounds.
  // Retain each once even when unrelated imports exhaust generic diagnostics.
  // Neither population can masquerade as complete loader-chain coverage.
  const observedPinnedLoads = new Set();
  try {
    registerHooks({ resolve(specifier, context, nextResolve) {
      const leave = cooperative?.enterHook();
      try {
      // Observe the resolver's return directly. A build graph, lockfile or
      // later require.resolve call cannot supply this worker's actual edge.
      if (loaderCensus ? censusUsage.stopped : resolveSequence >= 128) {
        // Each limit marker is emitted once, even when the shared event budget
        // ran out first. Missing population must remain explicit in the receipt.
        if (!loaderCensus && resolveSequence++ === 128) emit('module-resolve-limit', { limit: 128 }, true);
        return nextResolve(specifier, context);
      }
      const resolveId = ++resolveSequence;
      const fields = { resolveId, specifier, parentURL: context.parentURL ?? null,
        conditions: [...context.conditions], scope: 'node-sync-resolve-hook' };
      emit('module-resolve-start', fields);
      try {
        const result = nextResolve(specifier, context);
        emit('module-resolve-return', { ...fields, url: result.url, format: result.format ?? null });
        return result;
      } catch (error) {
        emit('module-resolve-error', { ...fields,
          errorCode: typeof error?.code === 'string' ? error.code : null });
        throw error;
      }
      } finally { leave?.(); }
    }, load(url, context, nextLoad) {
      const leave = cooperative?.enterHook();
      try {
      if (!url.startsWith('file:')) return nextLoad(url, context);
      const enrolled = sourcePins.some(pin => pathToFileURL(pin.path).href === url) &&
        !observedPinnedLoads.has(url);
      if (enrolled) observedPinnedLoads.add(url);
      if (!enrolled && (loaderCensus ? censusUsage.stopped : loadSequence >= 128)) {
        if (!loaderCensus && loadSequence++ === 128) emit('module-load-limit', { limit: 128 }, true);
        return nextLoad(url, context);
      }
      if (!enrolled) loadSequence++;
      const loadId = ++observedLoadSequence;
      const started = performance.now();
      const fields = { loadId, url, scope: 'node-sync-load-hook' };
      emit('module-load-start', fields, enrolled);
      try {
        const result = nextLoad(url, context);
        emit('module-load-return', { ...fields, elapsedMs: performance.now() - started,
          format: result.format ?? null, source: fingerprintSource(result, url) }, enrolled);
        return result;
      } catch (error) {
        emit('module-load-error', { ...fields, elapsedMs: performance.now() - started,
          errorCode: typeof error?.code === 'string' ? error.code : null,
          errorName: typeof error?.name === 'string' ? error.name : typeof error }, enrolled);
        throw error;
      }
      } finally { leave?.(); }
    } });
  } catch (error) {
    emit('module-load-unavailable', { errorCode: error?.code ?? null });
  }
}

// Channel children keep their reporter output separate while their native
// process observations stay with the original npm tree. The enrollment is
// published before spawn; no race against a parent's post-spawn write is needed.
function readNativeEnrollment(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) return null;
    const { integrity, ...value } = JSON.parse(readFileSync(path, 'utf8'));
    return integrity?.schemaVersion === 1 && integrity.sha256 ===
      createHash('sha256').update(JSON.stringify(value)).digest('hex') ? value : null;
  } catch { return null; }
}

if (process.env.PC_EXECUTED_SOURCE_MAP_OUT?.trim()) {
  const reporterOut = process.env.PC_EXECUTED_SOURCE_MAP_OUT.trim();
  const producer = readNativeEnrollment(`${reporterOut}.producer.json`);
  const channel = producer?.nativeChannel;
  const traceOut = producer?.outPath === reporterOut && isAbsolute(channel?.traceOut ?? '') &&
    Number.isSafeInteger(channel.step) && reporterOut === `${channel.traceOut}.step-${channel.step}` &&
    channel.script === process.env.npm_lifecycle_event && channel.command === process.env.npm_lifecycle_script
    ? channel.traceOut : reporterOut;
  installNativeProcessTrace(traceOut);
}

export function loaderIdentity(value = '') {
  const text = String(value);
  return {
    sha256: createHash('sha256').update(text).digest('hex'),
    bytes: Buffer.byteLength(text),
    // Never print option values: paths/URLs can contain credentials.
    switches: [...new Set(text.match(/--(?:import|loader|experimental-loader|require|conditions)(?=[=\s]|$)|(?:^|\s)-r(?=[=\s]|$)/g) ?? [])].map(s => s.trim()),
  };
}

export function startupTraceEnv(env = process.env) {
  // A timeout cannot enable a preload retroactively. Keep the bounded lifecycle
  // trace in the router's existing captured stderr unless explicitly disabled.
  if (env.PAPERCUSP_TEST_STARTUP_TRACE === '0') return env;
  const preload = `--import=${JSON.stringify(new URL('./vitest-startup-trace.mjs', import.meta.url).href)}`;
  const options = env.NODE_OPTIONS ?? '';
  return { ...env, PAPERCUSP_TEST_STARTUP_TRACE: '1',
    NODE_OPTIONS: options.includes(preload) ? options : `${options} ${preload}`.trim() };
}

/**
 * @param {any} child - a forked child process (its `send` is wrapped in place).
 * @param {(row: Record<string, unknown>) => void} emit - receives one diagnostic row per startup event.
 * @param {() => number} [now]
 * @returns {() => void} stops observing.
 */
export function observeForkStartup(child, emit, now = () => performance.now()) {
  const origin = now();
  const originalSend = child.send;
  const originalKill = child.kill;
  let closed = false;
  let start = null;
  let stop = null;
  let seenStarted = false;
  let seenStopped = false;
  let executionSends = 0;
  let executionTraceLimited = false;
  const record = (event, fields = {}) => {
    try { emit({ event, childPid: child.pid, elapsedMs: Math.round(now() - origin), ...fields }); }
    catch { /* A passive observer must not change the runner's IPC or signals. */ }
  };
  child.send = function(message, ...args) {
    if (message?.type === 'start' && start === null) {
      start = now();
      record('start-sent');
    }
    if (message?.type === 'stop' && stop === null) {
      stop = now();
      record('stop-sent');
    }
    const request = message?.type;
    if (request !== 'run' && request !== 'collect')
      return originalSend.call(this, message, ...args);
    // Observe only the local transport call, never payloads, callbacks or
    // Promise settlement. A return does not prove worker pickup or execution.
    if (executionSends >= 16) {
      if (!executionTraceLimited) {
        executionTraceLimited = true;
        record('execution-send-limit', { limit: 16 });
      }
      return originalSend.call(this, message, ...args);
    }
    const fields = { request, sendSequence: ++executionSends };
    try {
      const result = originalSend.call(this, message, ...args);
      record('execution-send-return', { ...fields, returnType: typeof result,
        returnValue: typeof result === 'boolean' ? result : null });
      return result;
    } catch (error) {
      // Even error names/codes may contain payload data or invoke getters.
      record('execution-send-error', { ...fields, thrownType: typeof error });
      throw error;
    }
  };
  if (typeof originalKill === 'function') {
    child.kill = function(signal, ...args) {
      const sent = originalKill.call(this, signal, ...args);
      record('worker-signal', { signal: signal ?? 'SIGTERM', sent });
      return sent;
    };
  }
  const onMessage = message => {
    if (message?.type === 'started' && !seenStarted) {
      seenStarted = true;
      record('started-received', { startupMs: start === null ? null : Math.round(now() - start), error: Boolean(message.error) });
    }
    if (message?.type === 'stopped' && !seenStopped) {
      seenStopped = true;
      record('stopped-received', { stopMs: stop === null ? null : Math.round(now() - stop), error: Boolean(message.error) });
    }
  };
  const onExit = (code, signal) => record('worker-exit', { code, signal, started: seenStarted });
  const onDisconnect = () => record('worker-disconnect');
  const cleanup = () => {
    if (closed) return;
    closed = true;
    child.send = originalSend;
    if (typeof originalKill === 'function') child.kill = originalKill;
    child.removeListener('message', onMessage);
    child.removeListener('exit', onExit);
    child.removeListener('disconnect', onDisconnect);
    child.removeListener('close', onClose);
  };
  const onClose = (code, signal) => { record('worker-close', { code, signal }); cleanup(); };
  child.on('message', onMessage);
  child.once('exit', onExit);
  child.once('disconnect', onDisconnect);
  child.once('close', onClose);
  return cleanup;
}

/** An active control, deliberately separate from the passive observer above.
 * Only attach to an identified Vitest forks transport. Start/stop retain their
 * exact native arguments, receiver, return value and errors. Execution refusal
 * uses the native pool's error path, never a fabricated test completion.
 * @param {any} child
 * @param {(row: Record<string, any>) => void} emit
 */
export function controlForkStartupOnly(child, emit) {
  const originalSend = child.send;
  const record = row => { try { emit(row); } catch { /* Diagnostics cannot disable the fence. */ } };
  const send = function(message, ...args) {
    if (message?.__vitest_worker_request__ === true && ['start', 'stop'].includes(message.type)) {
      let inputSha256 = null;
      try { inputSha256 = createHash('sha256').update(JSON.stringify(message)).digest('hex'); }
      catch { /* Native advanced serialization, not JSON, owns the actual payload. */ }
      record({ event: 'lifecycle-request', childPid: child.pid, type: message.type,
        inputSha256 });
      return originalSend.call(this, message, ...args);
    }
    record({ event: 'execution-request-refused', childPid: child.pid,
      request: ['run', 'collect'].includes(message?.type) ? message.type : 'unknown' });
    const error = Object.assign(new Error('Vitest startup-only diagnostic refused execution'),
      { code: 'VITEST_STARTUP_ONLY_EXECUTION_REFUSED' });
    // PoolRunner subscribes before sending start/run. An error rejects its real
    // resolver and lets its native stop/signal/500ms-kill cleanup run normally.
    if (!child.listenerCount('error')) throw error;
    child.emit('error', error);
    return false;
  };
  child.send = send;
  const detach = () => {
    if (child.send === send) child.send = originalSend;
    child.removeListener('close', detach);
  };
  child.once('close', detach);
  return detach;
}

/** Run the installed Vitest pipeline with its resolved options, fencing only
 * its identified forks transport. The router owns the external timeout/scope.
 * No list/collect, copied worker options, pool override, or general Worker hook.
 * @param {string[]} argv Native Vitest run arguments (including selected files).
 * @param {(row: Record<string, any>) => void} emit
 * @param {{ control?: typeof controlForkStartupOnly }} [options] Narrow negative-control seam; the CLI always uses the fence.
 */
export async function diagnoseVitestStartup(argv, emit, { control = controlForkStartupOnly } = {}) {
  const record = row => { try { emit(row); } catch { /* Fail closed independently of the sink. */ } };
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const require = createRequire(join(process.cwd(), 'package.json'));
  const nodeEntry = require.resolve('vitest/node');
  const workerEntry = realpathSync(join(dirname(nodeEntry), 'workers/forks.js'));
  const packagePath = require.resolve('vitest/package.json');
  const installed = JSON.parse(readFileSync(packagePath, 'utf8'));
  if (!installed.version.startsWith('4.')) throw new Error('Unsupported Vitest startup protocol');
  const { createVitest, parseCLI } = await import(pathToFileURL(nodeEntry).href);
  const parsed = parseCLI(['vitest', 'run', ...argv]);
  if (!parsed.filter.length || parsed.options.watch || parsed.options.browser?.enabled || parsed.options.poolRunner)
    throw new Error('Unsupported startup-only command');
  const originalFork = childProcess.fork;
  const workers = [];
  const closedWorkers = [];
  let context;
  let forkControl;
  try {
    context = await createVitest('test', parsed.options);
    const specifications = await context.globTestSpecifications(parsed.filter);
    const requested = new Set(parsed.filter.map(file => resolve(file)));
    if (!specifications.length || specifications.some(spec => spec.pool !== 'forks' ||
        spec.project.config.poolRunner || !requested.has(resolve(spec.moduleId))) ||
        [...requested].some(file => !specifications.some(spec => resolve(spec.moduleId) === file)))
      throw new Error('Unsupported or ambiguous startup-only specification; verified forks required');
    record({ event: 'startup-only-contract', mode: 'native-vitest-forks-execution-fence',
      vitestVersion: installed.version, nodeVersion: process.version,
      runtime: [packagePath, nodeEntry, workerEntry].map(path => ({ path, sha256: sha(readFileSync(path)) })),
      config: context.vite.config.configFile ? { path: context.vite.config.configFile,
        sha256: sha(readFileSync(context.vite.config.configFile)) } : null,
      argvSha256: sha(JSON.stringify(argv)), specifications: specifications.map(spec => ({
        file: spec.moduleId, pool: spec.pool, project: spec.project.name ?? null,
        sha256: sha(readFileSync(spec.moduleId)), configSha256: sha(JSON.stringify(spec.project.serializedConfig)),
      })) });
    forkControl = function(modulePath, ...args) {
      // Match the actual installed entrypoint, not a filename substring. Native
      // utility workers and every unrelated child retain their normal behavior.
      let selected = false;
      try { selected = realpathSync(modulePath instanceof URL ? fileURLToPath(modulePath) : modulePath) === workerEntry; }
      catch { /* The original fork owns validation and errors. */ }
      const child = originalFork.call(this, modulePath, ...args);
      if (!selected) return child;
      const options = (Array.isArray(args[0]) ? args[1] : args[0]) ?? {};
      const state = { childPid: child.pid, started: false, closed: false, refused: 0 };
      workers.push(state);
      closedWorkers.push(new Promise(resolve => child.once('close', resolve)));
      record({ event: 'controlled-worker-forked', childPid: child.pid, entrypoint: workerEntry,
        execArgv: loaderIdentity((options.execArgv ?? process.execArgv).join(' ')),
        envSha256: sha(JSON.stringify(options.env ?? process.env)),
        optionsSha256: sha(JSON.stringify(options)) });
      const detachObservation = observeForkStartup(child, row => {
        if (row.event === 'started-received' && !row.error) state.started = true;
        if (row.event === 'worker-close') state.closed = true;
        record(row);
      });
      const detachControl = control(child, row => {
        if (row.event === 'execution-request-refused') state.refused++;
        record(row);
      });
      child.once('close', () => { detachControl(); detachObservation(); });
      return child;
    };
    childProcess.fork = forkControl;
    syncBuiltinESMExports();
    await context.start(parsed.filter);
  } finally {
    // Leave observation/fencing installed through native stop and owned cleanup.
    try { await context?.close(); await Promise.all(closedWorkers); }
    finally {
      if (childProcess.fork === forkControl) childProcess.fork = originalFork;
      syncBuiltinESMExports();
    }
  }
  const outcome = { event: 'startup-only-outcome', testVerdict: 'not-measured', workers,
    status: workers.length > 0 && workers.every(row => row.started && row.closed && row.refused > 0)
      ? 'startup-observed' : 'startup-incomplete' };
  record(outcome);
  return outcome;
}

// No clients, intervals, or extra processes: existing runner shutdown owns the
// process group. This preload only observes IPC; it never changes the payload.
function isVitestEntry(value) {
  const entry = String(value ?? '').replaceAll('\\', '/');
  return /(?:^|\/)(?:vitest\/(?:vitest\.mjs|dist\/(?:workers\/[^/]+|worker)\.[cm]?js)|\.bin\/vitest)$/.test(entry);
}

const traceMode = process.env.PAPERCUSP_TEST_STARTUP_TRACE;
if (traceMode === '1' || (traceMode === 'vitest-descendant'
    && isVitestEntry(process.argv[1]))) {
  // startupTraceEnv explicitly selects a root (including generic diagnostic
  // fixtures). Its descendants retain the preload and all source/admission
  // guards, but ordinary Node payloads must not receive diagnostic stderr.
  process.env.PAPERCUSP_TEST_STARTUP_TRACE = 'vitest-descendant';
  let remainingStartup = 24;
  let remainingShutdown = 24;
  const emit = row => {
    // Startup traffic cannot exhaust the evidence needed for a later stop hang.
    const shutdown = ['stop-sent', 'stopped-received', 'worker-signal',
      'worker-exit', 'worker-disconnect', 'worker-close'].includes(row.event);
    if (shutdown ? remainingShutdown-- <= 0 : remainingStartup-- <= 0) return;
    try { process.stderr.write(`TEST_FILE_STARTUP_TRACE ${JSON.stringify({ pid: process.pid, ...row })}\n`); } catch { /* diagnostics cannot break execution */ }
  };
  emit({ event: 'node-loaded', nodeOptions: loaderIdentity(process.env.NODE_OPTIONS), execArgv: loaderIdentity(process.execArgv.join(' ')) });
  const originalFork = childProcess.fork;
  childProcess.fork = function(modulePath, ...args) {
    const child = originalFork.call(this, modulePath, ...args);
    if (isVitestEntry(modulePath)) {
      emit({ event: 'worker-forked', childPid: child.pid });
      observeForkStartup(child, emit);
    }
    return child;
  };
  syncBuiltinESMExports();
}
