import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, execFileSync, fork, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createTextCollector } from '../child-output';
import { controlForkStartupOnly, createCooperativeWorkerCensus, loaderIdentity, nativeProcessTraceEnv, observeEsbuildStartup, observeForkStartup, startupTraceEnv } from '../../../../scripts/lib/vitest-startup-trace.mjs';
import { readPartialNativeChannelCustody, readPartialNativeCompletion,
  registerPartialNativeProducerChannels } from '../../../../scripts/lib/partial-task-resume.mjs';
import { writeRelatedFilterList } from '../../../../scripts/lib/related-tests.mjs';
import { readNativeProcessTraceArtifacts } from '../../../../scripts/lib/budgeted-task-scheduler.mjs';

function retainNativeStartupFailure(dir: string, error: unknown) {
  // Preserve the actual execFile result as well as the source/trace fixture.
  // A timeout's killed flag alone does not establish closed descendant pipes.
  const failure = error as Error & { code?: string | number; signal?: string;
    killed?: boolean; stdout?: string | Buffer; stderr?: string | Buffer };
  let retentionError: string | null = null;
  try {
    writeFileSync(join(dir, 'failure.stdout'), failure.stdout ?? '', { mode: 0o600 });
    writeFileSync(join(dir, 'failure.stderr'), failure.stderr ?? '', { mode: 0o600 });
    writeFileSync(join(dir, 'failure.json'), JSON.stringify({ code: failure.code ?? null,
      signal: failure.signal ?? null, killed: failure.killed ?? null,
      terminationObserved: false }), { mode: 0o600 });
  } catch (cause) { retentionError = String(cause); }
  failure.message += `\nNATIVE_STARTUP_FAILURE ${JSON.stringify({ retainedRoot: dir, retentionError })}`;
}

function cleanupNativeReporterFixture(dir: string, completed: boolean,
  reportRetained: (message: string) => void = message => { process.stderr.write(message); }) {
  if (completed) rmSync(dir, { recursive: true, force: true });
  else reportRetained(`[native-reporter-channel] retained failure evidence: ${dir}\n`);
}

describe('cooperative worker census qualification controls', () => {
  const fixture = (overrides: Record<string, any> = {}, publish?: (event: string, fields: any) => boolean) => {
    const rows: any[] = [];
    const options = { epoch: randomUUID(), maxIsolates: 8, closeTimeoutMs: 20, ...overrides };
    const census = createCooperativeWorkerCensus(options, { publish: (event, fields) => {
      rows.push({ event, ...fields }); return publish?.(event, fields) ?? true;
    } });
    return { census, rows, options };
  };

  it('synchronous-throw-exact-identity preserves arguments, new.target, returned instance and opaque thrown value', () => {
    const f = fixture(), args = [{ private: true }, { workerData: { preserved: true } }];
    const calls: any[] = [], expected = new Proxy({}, { get() { throw new Error('inspected native error'); } });
    let shouldThrow = false;
    class Native {
      constructor(...values: any[]) {
        calls.push({ target: new.target, values });
        if (shouldThrow) throw expected;
      }
    }
    const Wrapped = f.census.wrap(Native, (_: unknown, construct: () => any) => construct());
    class Derived extends Wrapped { constructor(...values: any[]) { super(...values); } }
    const value = new Derived(...args);
    expect(value).toBeInstanceOf(Native);
    expect(calls[0].target).toBe(Derived);
    args.forEach((value, index) => expect(calls[0].values[index]).toBe(value));
    shouldThrow = true;
    let caught;
    try { new Wrapped(...args); } catch (error) { caught = error; }
    expect(caught).toBe(expected);
    expect(f.census.snapshot()).toMatchObject({ constructing: 0, faults: 0 });
    expect(f.census.snapshot().slots.map(row => row.status)).toEqual(['joined', 'reserved', 'aborted']);
  });

  it('constructor-pending-at-close remains unknown while preserving the original native return', () => {
    const f = fixture();
    class Native { constructor() { expect(f.census.close()).toBe(false); } }
    const Wrapped = f.census.wrap(Native, (_: unknown, construct: () => any) => construct());
    expect(new Wrapped()).toBeInstanceOf(Native);
    expect(f.census.snapshot()).toMatchObject({ phase: 'CLOSING', constructing: 0, fixedCount: 0 });
    expect(f.rows.some(row => row.reason === 'close-timeout')).toBe(true);
  });

  it('construction-ledger binds source, original argument fingerprints and return/abort to one admission', () => {
    const f = fixture(), args: [URL, { execArgv: string[]; env: Record<string, string>; workerData: { original: number } }] = [new URL('file:///worker.mjs'), { execArgv: [],
      env: { NODE_OPTIONS: '', PRIVATE_TOKEN: 'must-never-be-retained' }, workerData: { original: 7 } }];
    let thrown = false;
    const failure = Object.create(null);
    class Native { constructor(...values: any[]) {
      values.forEach((value, index) => expect(value).toBe(args[index]));
      if (thrown) throw failure;
    } }
    const Wrapped = f.census.wrap(Native, (_: unknown, construct: () => any) => construct());
    new Wrapped(...args);
    thrown = true;
    let caught;
    try { new Wrapped(...args); } catch (error) { caught = error; }
    expect(caught).toBe(failure);
    const reserves = f.rows.filter(row => row.event === 'cooperative-reserve');
    expect(reserves).toHaveLength(2);
    expect(reserves[0].construction.arguments).toMatchObject({ status: 'complete', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(reserves[0].construction.arguments).toEqual(reserves[1].construction.arguments);
    expect(reserves[0].construction.source).toMatchObject({ status: 'observed', stack: expect.arrayContaining([
      expect.objectContaining({ scriptName: expect.stringContaining('vitest-startup-trace.test.ts'),
        lineNumber: expect.any(Number), columnNumber: expect.any(Number), scriptId: expect.any(String) }),
    ]) });
    for (const [index, event] of ['cooperative-constructed', 'cooperative-abort'].entries()) {
      const outcome = f.rows.find(row => row.event === event);
      expect(outcome).toMatchObject({ childAdmission: reserves[index].childAdmission,
        constructionId: reserves[index].constructionId, epoch: f.options.epoch, admission: 0 });
    }
    expect(JSON.stringify(f.rows)).not.toContain('must-never-be-retained');
    args[1].workerData!.original = 8;
    try { new Wrapped(...args); } catch (error) { expect(error).toBe(failure); }
    expect(f.rows.filter(row => row.event === 'cooperative-reserve')[2].construction.arguments.sha256)
      .not.toBe(reserves[0].construction.arguments.sha256);
  });

  it('construction-ledger never evaluates getters or proxies and leaves opaque or bounded arguments unknown', () => {
    const f = fixture(); let inspected = 0;
    const accessor = { get workerData() { inspected++; throw new Error('accessor evaluated'); } };
    const proxy = new Proxy({}, { ownKeys() { inspected++; throw new Error('proxy evaluated'); },
      getPrototypeOf() { inspected++; throw new Error('proxy evaluated'); } });
    class Native { constructor(...args: any[]) { expect(args).toHaveLength(1); } }
    const Wrapped = f.census.wrap(Native, (_: unknown, construct: () => any) => construct());
    for (const arg of [accessor, proxy, 'x'.repeat(65537), { callback() {} }]) new Wrapped(arg);
    expect(inspected).toBe(0);
    expect(f.rows.filter(row => row.event === 'cooperative-reserve').map(row => row.construction.arguments.status))
      .toEqual(['unknown', 'unknown', 'unknown', 'unknown']);
    expect(f.census.snapshot().constructing).toBe(0);
  });

  it('late-construction cannot enlarge an already fixed population or suppress the native constructor', () => {
    const f = fixture();
    expect(f.census.close()).toBe(true);
    let calls = 0;
    class Native { constructor() { calls++; } }
    const Wrapped = f.census.wrap(Native, (_: unknown, construct: () => any) => construct());
    expect(new Wrapped()).toBeInstanceOf(Native);
    expect(calls).toBe(1);
    expect(f.census.snapshot()).toMatchObject({ fixedCount: 1, faults: 1, constructing: 0 });
    expect(f.rows.some(row => row.reason === 'late-construction')).toBe(true);
    expect(f.census.awaitAcknowledgements()).toBe(false);
  });

  it('duplicate-missing-orphan-end-ack cannot stand in for a reserved sibling', () => {
    const f = fixture();
    const Wrapped = f.census.wrap(class {}, (_: unknown, construct: () => any) => construct());
    new Wrapped();
    expect(f.census.acknowledge(() => ({ sha256: 'a'.repeat(64) }))).toBe(false);
    expect(f.census.close()).toBe(false);
    const main = fixture();
    expect(main.census.close()).toBe(true);
    expect(main.census.acknowledge(() => ({ sha256: 'a'.repeat(64) }))).toBe(true);
    expect(main.census.acknowledge(() => ({ sha256: 'a'.repeat(64) }))).toBe(false);
    expect(main.census.awaitAcknowledgements()).toBe(false);
  });

  it('failed-publication never changes an unrecorded END into an acknowledged isolate', () => {
    for (const mode of ['return-false', 'throw', 'finish-throws'] as const) {
      const f = fixture({}, event => {
        if (event !== 'cooperative-end-ack') return true;
        if (mode === 'throw') throw new Error('disk publication failed');
        return mode !== 'return-false';
      });
      expect(f.census.close()).toBe(true);
      expect(f.census.acknowledge(() => {
        if (mode === 'finish-throws') throw new Error('END unavailable');
        return { sha256: 'a'.repeat(64) };
      })).toBe(false);
      expect(f.census.snapshot().slots[0].status).toBe('joined');
      expect(f.census.awaitAcknowledgements()).toBe(false);
    }
  });

  it('pending-hooks refuses END until the actual hook returns and never hides its work', () => {
    const f = fixture(), leave = f.census.enterHook();
    expect(f.census.close()).toBe(true);
    let finished = false;
    expect(f.census.acknowledge(() => { finished = true; return {}; })).toBe(false);
    expect(finished).toBe(false);
    expect(f.census.snapshot().activeHooks).toBe(1);
    leave();
    expect(f.census.snapshot().activeHooks).toBe(0);
    expect(f.census.awaitAcknowledgements()).toBe(false);
  });

  it('close-timeout preserves a missing bootstrap as unknown with a finite close budget', () => {
    const f = fixture({ closeTimeoutMs: 10 });
    const Wrapped = f.census.wrap(class {}, (_: unknown, construct: () => any) => construct());
    new Wrapped();
    const start = performance.now();
    expect(f.census.close()).toBe(false);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(f.census.snapshot()).toMatchObject({ phase: 'CLOSING', fixedCount: 0, faults: 1 });
  });

  it('post-ack-activity invalidates an otherwise balanced closed census', () => {
    const f = fixture();
    expect(f.census.close()).toBe(true);
    expect(f.census.acknowledge(() => ({}))).toBe(true);
    expect(f.census.awaitAcknowledgements()).toBe(true);
    f.census.enterHook()();
    expect(f.census.awaitAcknowledgements()).toBe(false);
    expect(f.rows.some(row => row.reason === 'hook-after-close')).toBe(true);
  });

  it('epoch-admission mismatch and admission exhaustion remain unknown without replacing construction', () => {
    const f = fixture({ maxIsolates: 2 });
    const other = fixture({ ...f.options, epoch: randomUUID(), buffer: f.census.buffer, admission: 1 });
    expect(other.census.snapshot().faults).toBeGreaterThan(0);
    expect(other.census.join(19)).toBe(false);
    const Wrapped = f.census.wrap(class {}, (_: unknown, construct: () => any) => construct());
    expect(new Wrapped()).toBeInstanceOf(Wrapped);
    expect(new Wrapped()).toBeInstanceOf(Wrapped);
    expect(f.rows.some(row => row.reason === 'admission-bound')).toBe(true);
    expect(f.census.close()).toBe(false);
  });

  it('a failed native kill releases held isolates only into UNKNOWN', () => {
    const f = fixture();
    expect(f.census.close()).toBe(true);
    expect(f.census.acknowledge(() => ({}))).toBe(true);
    f.census.release();
    expect(f.census.hold()).toBe(false);
    expect(f.census.snapshot()).toMatchObject({ released: true });
    expect(f.census.awaitAcknowledgements()).toBe(false);
  });

  it('terminal ACK and failed-kill hold do not call replaced application intrinsics or IO properties', () => {
    const apply = Reflect.apply, define = Object.defineProperty;
    const own = Object.getOwnPropertyDescriptor, remove = Reflect.deleteProperty;
    const clock = performance, oldClock = own(clock, 'now'), originalNow = clock.now;
    const rows: string[] = [];
    const io = { publish(event: string) { rows.push(event); return true; } };
    const census = createCooperativeWorkerCensus({ epoch: randomUUID(), maxIsolates: 2,
      closeTimeoutMs: 1000 }, io);
    expect(census.close()).toBe(true);
    const originals: Array<[object, string, PropertyDescriptor]> = [];
    let terminal = false, callbacks = 0;
    const replace = (target: object, key: string) => {
      const descriptor = own(target, key)!;
      originals.push([target, key, descriptor]);
      define(target, key, { ...descriptor, value: function(this: unknown, ...args: unknown[]) {
        if (terminal) callbacks++;
        return apply(descriptor.value, this, args);
      } });
    };
    for (const key of ['load', 'store', 'add', 'sub', 'notify', 'wait', 'waitAsync', 'compareExchange'])
      replace(Atomics, key);
    replace(Array, 'from');
    replace(Array.prototype, 'every');
    replace(Array.prototype, 'includes');
    replace(Math, 'min');
    replace(io, 'publish');
    define(clock, 'now', { configurable: true, value() {
      if (terminal) callbacks++;
      return apply(originalNow, clock, []);
    } });
    let acknowledged = false, held = false, releasedHold = true;
    let state: ReturnType<typeof census.snapshot> | undefined;
    try {
      acknowledged = census.acknowledge(() => { terminal = true; return { sealed: true }; });
      held = census.awaitAcknowledgements();
      census.release();
      releasedHold = census.hold();
      state = census.snapshot();
    } finally {
      terminal = false;
      for (let index = originals.length - 1; index >= 0; index--)
        define(originals[index][0], originals[index][1], originals[index][2]);
      if (oldClock) define(clock, 'now', oldClock);
      else remove(clock, 'now');
    }
    expect(callbacks).toBe(0);
    expect(acknowledged).toBe(true);
    expect(held).toBe(true);
    expect(releasedHold).toBe(false);
    expect(state).toMatchObject({ phase: 'CLOSED', fixedCount: 1, released: true, faults: 2 });
    expect(rows).toContain('cooperative-end-ack');
    expect(rows).toContain('cooperative-held');
  });

  it('native self-kill failure delegates unchanged inputs and preserves the exact thrown identity after release', () => {
    const observer = new URL('../../../../libs/test-config/src/process-termination-observer.mjs', import.meta.url).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { observeProcessTermination } from ${JSON.stringify(observer)};
      const calls = [], expected = new Proxy({}, { get() { throw Error('error inspected'); } });
      process.kill = function(...args) { calls.push({ receiver: this, args }); throw expected; };
      let released = 0, requested = 0;
      observeProcessTermination(() => {}, { beforeSelfKill() { requested++; }, selfKillFailed() { released++; } });
      let caught; const receiver = {};
      try { process.kill.call(receiver, process.pid, 9, 'original-extra-argument'); } catch (error) { caught = error; }
      if (caught !== expected || calls.length !== 1 || calls[0].receiver !== receiver ||
        calls[0].args.length !== 3 || calls[0].args[0] !== process.pid || calls[0].args[1] !== 9 ||
        calls[0].args[2] !== 'original-extra-argument' || requested !== 1 || released !== 1) process.exitCode = 1;
      process.stdout.write('native-throw-identity-preserved');`], {
      env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 5000,
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('native-throw-identity-preserved');
  });

  const workerViews = [
    "(await import('node:module')).createRequire(import.meta.url)('node:worker_threads').Worker",
    "(await import('node:module')).createRequire(import.meta.url)('worker_threads').Worker",
    "(await import('node:worker_threads')).Worker",
    "(await import('worker_threads')).Worker",
    "(await import('node:worker_threads')).default.Worker",
    "(await import('worker_threads')).default.Worker",
  ];
  it.each(['retained-functions', 'stats-constructor-setter', 'stats-chain-tail-getter', 'inspector-prototype-hook'])(
    'terminal publication avoids application callbacks or withholds the take for %s', mode => {
    const dir = mkdtempSync(join(tmpdir(), 'native-terminal-publication-'));
    const out = join(dir, 'sources.json'), app = join(dir, 'app.mjs');
    const marker = join(dir, 'callbacks'), takeMarker = join(dir, 'take');
    const capture = join(dir, 'capture.mjs');
    writeFileSync(capture, `import { Session } from 'node:inspector';
      import { openSync, writeSync } from 'node:fs';
      const apply = Reflect.apply, post = Session.prototype.post;
      const callbackFd = openSync(${JSON.stringify(marker)}, 'wx');
      const takeFd = openSync(${JSON.stringify(takeMarker)}, 'wx');
      const byte = Buffer.from('x');
      let taken = false;
      globalThis.terminalCallback = () => { if (taken) writeSync(callbackFd, byte, 0, 1); };
      Session.prototype.post = function(method) {
        const result = apply(post, this, arguments);
        if (method === 'Profiler.takePreciseCoverage') { taken = true; writeSync(takeFd, byte, 0, 1); }
        return result;
      };`);
    const source = `import fs from 'node:fs';
      import { createHash } from 'node:crypto';
      function entered() { return 8; } function dormant() { return 7; } entered();
      const apply = Reflect.apply, define = Object.defineProperty;
      const hashInstance = createHash('sha256'), hash = Object.getPrototypeOf(hashInstance);
      let stats = Object.getPrototypeOf(fs.lstatSync(${JSON.stringify(app)}));
      while (stats && !Object.hasOwn(stats, 'isFile')) stats = Object.getPrototypeOf(stats);
      const mutations = [
        [JSON, 'stringify'], [Date, 'now'], [Buffer, 'from'], [Buffer, 'byteLength'],
        [Buffer.prototype, 'equals'], [String.prototype, 'startsWith'], [Array.prototype, 'some'],
        [hash, 'update'], [hash, 'digest'], [hash, 'copy'],
        [fs, 'openSync'], [fs, 'writeSync'], [fs, 'closeSync'], [fs, 'writeFileSync'],
        [fs, 'readFileSync'], [fs, 'linkSync'], [fs, 'unlinkSync'], [fs, 'lstatSync'],
        [stats, 'isFile'], [stats, 'isSymbolicLink'],
      ];
      for (let index = 0; index < mutations.length; index++) {
        const [target, name] = mutations[index], descriptor = Object.getOwnPropertyDescriptor(target, name);
        define(target, name, { ...descriptor, value: function() {
          globalThis.terminalCallback(); return apply(descriptor.value, this, arguments);
        } });
      }
      if (${JSON.stringify(mode)} === 'inspector-prototype-hook')
        for (const target of [Object.prototype, Array.prototype]) define(target, 'toJSON', {
          configurable: true, value() { globalThis.terminalCallback(); return this; },
        });
      // Hash/copy construct a new receiver and assign internal symbol fields.
      // Retained .update/.digest functions alone do not exclude these setters.
      for (const key of Reflect.ownKeys(hashInstance)) {
        if (typeof key !== 'symbol') continue;
        define(hash, key, { configurable: true, set(value) {
          globalThis.terminalCallback();
          define(this, key, { value, configurable: true, enumerable: true, writable: true });
        } });
      }
      const installStatsSetter = () => {
        define(stats, 'mode', { configurable: true, set(value) {
          globalThis.terminalCallback();
          define(this, 'mode', { value, configurable: true, enumerable: true, writable: true });
        } });
      };
      if (${JSON.stringify(mode)} === 'stats-constructor-setter') installStatsSetter();
      if (${JSON.stringify(mode)} === 'stats-chain-tail-getter') {
        let chainLength = 0;
        for (let prototype = fs.Stats.prototype; prototype !== null; prototype = Object.getPrototypeOf(prototype))
          chainLength++;
        // The old final look-ahead read this absent index after checking Stats.
        // Its getter can then install a setter that lstat invokes after take.
        define(Array.prototype, String(chainLength), { configurable: true,
          get() { installStatsSetter(); return undefined; },
          set(value) { define(this, String(chainLength), {
            value, configurable: true, enumerable: true, writable: true,
          }); },
        });
      }
      const environment = process.env;
      define(process, 'env', { configurable: true, get() { globalThis.terminalCallback(); return environment; } });
      process.kill(process.pid, 'SIGKILL');`;
    writeFileSync(app, source);
    try {
      const result = spawnSync(process.execPath, [app], {
        env: nativeProcessTraceEnv({ ...process.env, NODE_OPTIONS: `--import=${capture}`,
          PC_EXECUTED_SOURCE_MAP_OUT: out, PAPERCUSP_TEST_STARTUP_TRACE: '0' }, {
          pinnedSources: [{ path: app, sha256: createHash('sha256').update(source).digest('hex'),
            byteLength: Buffer.byteLength(source) }],
          loaderCensus: { batches: 128, bytes: 16 * 1024 ** 2,
            cooperative: { epoch: randomUUID(), maxIsolates: 2, closeTimeoutMs: 2000, preciseCoverage: true } },
        }), encoding: 'utf8', timeout: 10_000,
      });
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.signal, result.stderr).toBe('SIGKILL');
      expect(readFileSync(marker, 'utf8')).toBe('');
      const rows = readNativeProcessTraceArtifacts(out).rows.map(({ row }: any) => row);
      const terminal = rows.find((row: any) => row.observation?.schemaVersion === 'node-engine-precise-terminal-v1');
      const end = rows.find((row: any) => row.event === 'module-census-end');
      const ack = rows.find((row: any) => row.event === 'cooperative-end-ack');
      const held = rows.find((row: any) => row.event === 'cooperative-held');
      if (mode === 'stats-constructor-setter' || mode === 'inspector-prototype-hook') {
        expect(readFileSync(takeMarker, 'utf8')).toBe('');
        if (mode === 'stats-constructor-setter')
          expect(rows.some((row: any) => row.event === 'cooperative-unknown' &&
            row.reason === 'terminal-stat-constructor-drift')).toBe(true);
        expect(terminal).toBeUndefined();
        expect(end).toBeUndefined();
        expect(ack).toBeUndefined();
        expect(held).toBeUndefined();
        return;
      }
      expect(readFileSync(takeMarker, 'utf8')).toBe('x');
      expect(terminal?.observation.phase).toBe('taken');
      expect(terminal?.cooperativeSequence).toBeLessThan(end?.cooperativeSequence);
      expect(end?.cooperativeSequence).toBeLessThan(ack?.cooperativeSequence);
      expect(ack?.cooperativeSequence).toBeLessThan(held?.cooperativeSequence);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 20_000);

  const runWorkerControl = (view: string, mode = 'sibling') => {
    const dir = mkdtempSync(join(tmpdir(), 'native-cooperative-control-'));
    const out = join(dir, 'sources.json'), workerPath = join(dir, 'worker.mjs');
    const nestedPath = join(dir, 'nested.mjs');
    writeFileSync(nestedPath, `import { parentPort } from 'node:worker_threads';
      parentPort.postMessage('ready'); setTimeout(() => {}, 60000);`);
    writeFileSync(workerPath, `import { parentPort, Worker } from 'node:worker_threads';
      import { once } from 'node:events';
      ${mode === 'nested' ? `const child = new Worker(${JSON.stringify(nestedPath)}, { execArgv: [] });
        await once(child, 'message');` : ''}
      parentPort.postMessage('ready'); ${mode === 'early-exit' ? '' : 'setTimeout(() => {}, 60000);'}`);
    const capture = join(dir, 'capture.mjs');
    const fault = /^precise-(?:worker-)?(?:start|take)-(?:pending|failed|partial)$/.test(mode);
    writeFileSync(capture, fault ? `import { Session } from 'node:inspector';
      import { isMainThread } from 'node:worker_threads';
      const original = Session.prototype.post;
      Session.prototype.post = function(method, ...args) {
        const mode = ${JSON.stringify(mode)}, parts = mode.split('-');
        const phase = parts.at(-2), kind = parts.at(-1);
        if (mode.includes('-worker-') && isMainThread || method !== 'Profiler.' + phase + 'PreciseCoverage')
          return Reflect.apply(original, this, [method, ...args]);
        if (kind === 'pending') return;
        args.at(-1)(kind === 'failed' ? new Error('controlled protocol failure') : null,
          kind === 'partial' ? { result: [] } : undefined);
      };` : `import { Worker } from 'node:worker_threads'; globalThis.capturedWorker = Worker;`);
    const epoch = randomUUID();
    try {
      const result = spawnSync(process.execPath, [
        ...(mode === 'captured' ? [`--import=${capture}`] : []), '--input-type=module', '-e', `
        import { once } from 'node:events';
        const Worker = ${mode === 'captured' ? 'globalThis.capturedWorker' : view};
        const worker = new Worker(${JSON.stringify(workerPath)}, { execArgv: [],
          ${mode === 'bootstrap-dropped' ? "env: { NODE_OPTIONS: '' }," : ''} workerData: { original: 7 } });
        await once(worker, ${JSON.stringify(mode === 'early-exit' ? 'exit' : 'message')});
        process.kill(process.pid, 'SIGKILL');`], {
        env: nativeProcessTraceEnv({ ...process.env, NODE_OPTIONS: mode === 'captured' || fault ? `--import=${capture}` : '',
          PC_EXECUTED_SOURCE_MAP_OUT: out, PAPERCUSP_TEST_STARTUP_TRACE: '0',
        }, {
          ...(mode.startsWith('precise') && mode !== 'precise-missing-pins' ? {
            pinnedSources: [{ path: workerPath,
              sha256: createHash('sha256').update(readFileSync(workerPath)).digest('hex'),
              byteLength: readFileSync(workerPath).length }],
          } : {}),
          loaderCensus: { batches: 128, bytes: 16 * 1024 ** 2,
            cooperative: { epoch, maxIsolates: 8, closeTimeoutMs: 2000,
              ...(mode.startsWith('precise') ? { preciseCoverage: true as const } : {}) } },
        }),
        encoding: 'utf8', timeout: 10_000,
      });
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stderr).toBeNull();
      expect(result.signal, result.stderr).toBe('SIGKILL');
      const initial = readNativeProcessTraceArtifacts(out);
      const main = initial.rows.find(({ row }: any) => row.event === 'node-entry' && row.threadId === 0)!.row;
      const termination = { pid: result.pid, kernelProcessIdentity: main.kernelProcessIdentity,
        code: result.status, signal: result.signal };
      return { dir, out, epoch, initial, termination,
        trace: readNativeProcessTraceArtifacts(out, 0, Number.MAX_SAFE_INTEGER, { terminations: [termination] }) };
    } catch (error) { retainNativeStartupFailure(dir, error); throw error; }
  };

  it.each(workerViews)('live-sibling-main-self-kill seals and holds the actual supported public view %s', view => {
    const f = runWorkerControl(view);
    try {
      expect(f.initial.population.complete).toBe(false);
      expect(f.trace.population).toMatchObject({ complete: true, truncatedBy: null });
      const rows = f.trace.rows.map(({ row }: any) => row);
      const reserve = rows.find((row: any) => row.event === 'cooperative-reserve');
      const constructed = rows.find((row: any) => row.event === 'cooperative-constructed');
      const child = rows.find((row: any) => row.event === 'cooperative-join');
      expect(reserve.construction.arguments.status).toBe('complete');
      expect(reserve.construction.source.status).toBe('observed');
      expect(constructed).toMatchObject({ constructionId: reserve.constructionId,
        childAdmission: child.admission, childThreadId: child.threadId });
      expect(rows.filter((row: any) => row.event === 'cooperative-end-ack')).toHaveLength(2);
      expect(rows.filter((row: any) => row.event === 'cooperative-held')[0].population)
        .toMatchObject({ phase: 'CLOSED', fixedCount: 2, constructing: 0, activeHooks: 0, faults: 0, released: false });
      expect(rows.filter((row: any) => row.event === 'node-exit')).toHaveLength(0);
      // K is an independent falsifier. A different native outcome cannot
      // certify even this narrow artifact protocol, much less full closure.
      for (const terminal of [{ ...f.termination, signal: 'SIGTERM' },
        { ...f.termination, kernelProcessIdentity: 'other-kernel-process' }])
        expect(readNativeProcessTraceArtifacts(f.out, 0, Number.MAX_SAFE_INTEGER,
          { terminations: [terminal] }).population.complete).toBe(false);
      const returned = f.trace.rows.find(({ row }: any) => row.event === 'cooperative-constructed')!;
      rmSync(join(f.out + '.native-processes', createHash('sha256').update(returned.bytes).digest('hex') + '.json'));
      expect(readNativeProcessTraceArtifacts(f.out, 0, Number.MAX_SAFE_INTEGER,
        { terminations: [f.termination] }).population.complete).toBe(false);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  }, 20_000);

  it('nested-worker contributes its own admission and END instead of borrowing its parent seal', () => {
    const f = runWorkerControl(workerViews[2], 'nested');
    try {
      expect(f.trace.population.complete).toBe(true);
      const acks = f.trace.rows.filter(({ row }: any) => row.event === 'cooperative-end-ack');
      expect(acks).toHaveLength(3);
      const sibling = acks.find(({ row }: any) => row.admission === 2)!;
      const bytes = sibling.bytes, name = createHash('sha256').update(bytes).digest('hex') + '.json';
      rmSync(join(f.out + '.native-processes', name));
      expect(readNativeProcessTraceArtifacts(f.out, 0, Number.MAX_SAFE_INTEGER,
        { terminations: [f.termination] }).population.complete).toBe(false);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  }, 20_000);

  it('precise protocol durably publishes one complete own response before each isolate END and ACK', () => {
    const f = runWorkerControl(workerViews[2], 'precise');
    try {
      expect(f.trace.population.complete).toBe(true); // authenticated OUT protocol only
      const rows = f.trace.rows.map(({ row }: any) => row);
      const precise = rows.filter((row: any) => row.observation?.schemaVersion === 'node-engine-precise-terminal-v1');
      expect(precise).toHaveLength(2);
      for (const receipt of precise) {
        const observation = receipt.observation;
        expect(observation).toMatchObject({ epoch: f.epoch, phase: 'taken', runtimeQualification: 'unknown',
          fence: 'terminal-entered-suffix-unverified' });
        const end = rows.find((row: any) => row.event === 'module-census-end' && row.processIdentity === receipt.processIdentity);
        const ack = rows.find((row: any) => row.event === 'cooperative-end-ack' && row.processIdentity === receipt.processIdentity);
        expect(receipt.cooperativeSequence).toBeLessThan(end.cooperativeSequence);
        expect(end.cooperativeSequence).toBeLessThan(ack.cooperativeSequence);
        expect(Array.isArray(observation.raw.result)).toBe(true);
        const tracePath = join(f.out + '.native-processes', createHash('sha256').update(
          f.trace.rows.find(({ row }: any) => row === receipt)!.bytes).digest('hex') + '.json');
        const bytes = readFileSync(tracePath);
        rmSync(tracePath);
        expect(readNativeProcessTraceArtifacts(f.out, 0, Number.MAX_SAFE_INTEGER,
          { terminations: [f.termination] }).population.complete).toBe(false);
        writeFileSync(tracePath, bytes);
      }
      // Rehash the event and attachment so these fail on isolate/epoch binding,
      // not merely on custody corruption. A parent's valid response cannot
      // discharge the worker's own terminal obligation.
      const child = f.trace.rows.find(({ row }: any) => row.threadId > 0 &&
        row.observation?.schemaVersion === 'node-engine-precise-terminal-v1')!;
      const parent = precise.find((row: any) => row.threadId === 0)!;
      const originalPath = join(f.out + '.native-processes', createHash('sha256').update(child.bytes).digest('hex') + '.json');
      for (const observation of [{ ...child.row.observation, epoch: randomUUID() }, parent.observation]) {
        const envelope = JSON.parse(child.bytes.toString('utf8'));
        const changed = Buffer.from(JSON.stringify(observation));
        const sha256 = createHash('sha256').update(changed).digest('hex');
        const attachmentPath = join(f.out + '.native-processes', sha256 + '.engine');
        writeFileSync(attachmentPath, changed);
        delete envelope.observation;
        envelope.observationArtifact = { ref: sha256 + '.engine', sha256, byteLength: changed.length };
        const bytes = Buffer.from(JSON.stringify(envelope));
        const changedPath = join(f.out + '.native-processes', createHash('sha256').update(bytes).digest('hex') + '.json');
        rmSync(originalPath);
        writeFileSync(changedPath, bytes);
        try {
          expect(readNativeProcessTraceArtifacts(f.out, 0, Number.MAX_SAFE_INTEGER,
            { terminations: [f.termination] }).population.complete).toBe(false);
        } finally {
          rmSync(changedPath);
          writeFileSync(originalPath, child.bytes);
        }
      }
      expect(readNativeProcessTraceArtifacts(f.out, 0, Number.MAX_SAFE_INTEGER,
        { terminations: [f.termination] }).population.complete).toBe(true);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  }, 20_000);

  it('precise protocol cannot publish END/ACK without an armed pinned-source observer', () => {
    const f = runWorkerControl(workerViews[2], 'precise-missing-pins');
    try {
      const rows = f.trace.rows.map(({ row }: any) => row);
      expect(f.trace.population.complete).toBe(false);
      expect(rows.some((row: any) => row.event === 'module-census-end')).toBe(false);
      expect(rows.some((row: any) => row.event === 'cooperative-end-ack')).toBe(false);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  }, 20_000);

  it.each(['start-pending', 'start-failed', 'take-pending', 'take-failed', 'take-partial'])(
    'precise protocol forbids END/ACK for a pending, failed or incomplete response (%s)', fault => {
      const f = runWorkerControl(workerViews[2], 'precise-' + fault);
      try {
        const rows = f.trace.rows.map(({ row }: any) => row);
        expect(f.trace.population.complete).toBe(false);
        expect(rows.some((row: any) => row.event === 'module-census-end')).toBe(false);
        expect(rows.some((row: any) => row.event === 'cooperative-end-ack')).toBe(false);
      } finally { rmSync(f.dir, { recursive: true, force: true }); }
    }, 20_000);

  it('precise protocol keeps a failed worker UNKNOWN even when the main isolate has a complete own response', () => {
    const f = runWorkerControl(workerViews[2], 'precise-worker-take-failed');
    try {
      const rows = f.trace.rows.map(({ row }: any) => row);
      expect(f.trace.population.complete).toBe(false);
      expect(rows.some((row: any) => row.event === 'engine-script-execution' && row.threadId === 0 &&
        row.observation?.schemaVersion === 'node-engine-precise-terminal-v1')).toBe(true);
      expect(rows.filter((row: any) => row.event === 'cooperative-end-ack')).toHaveLength(1);
      expect(rows.some((row: any) => row.event === 'cooperative-end-ack' && row.threadId > 0)).toBe(false);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  }, 20_000);

  it.each(['captured', 'bootstrap-dropped', 'early-exit'])(
    'previously-captured-or-bypassed-constructor / unsupported-cjs-esm-view / early-unexpected-exit stays unknown (%s)', mode => {
      const f = runWorkerControl(workerViews[2], mode);
      try {
        expect(f.trace.population.complete).toBe(false);
        if (mode === 'bootstrap-dropped') {
          const rows = f.trace.rows.map(({ row }: any) => row);
          const reserve = rows.find((row: any) => row.event === 'cooperative-reserve');
          expect(reserve.construction.arguments.status).toBe('complete');
          expect(reserve.construction.source.status).toBe('observed');
          expect(rows.find((row: any) => row.event === 'cooperative-constructed'))
            .toMatchObject({ constructionId: reserve.constructionId, childAdmission: reserve.childAdmission,
              childThreadId: expect.any(Number) });
          expect(rows.some((row: any) => row.event === 'cooperative-join')).toBe(false);
        }
      }
      finally { rmSync(f.dir, { recursive: true, force: true }); }
    }, 20_000);
});

describe('esbuild startup pipe observation', () => {
  it('preserves backpressure, arguments, receivers and payload identity without starting a reader', () => {
    const child = Object.assign(new EventEmitter(), { pid: 42, stdin: { write: () => false }, stdout: new EventEmitter() }) as any;
    const calls: unknown[][] = [];
    const write = function(this: unknown, ...args: unknown[]) { calls.push([this, ...args]); return false; };
    child.stdin.write = write;
    const originalEmit = child.stdout.emit;
    const rows: any[] = [];
    const cleanup = observeEsbuildStartup(child, row => rows.push(row));
    expect(child.stdout.listenerCount('data')).toBe(0);
    const input = Buffer.from('private request'), output = Buffer.from('private response'), callback = () => {};
    expect(child.stdin.write(input, callback)).toBe(false);
    expect(calls).toEqual([[child.stdin, input, callback]]);
    let received: unknown;
    child.stdout.on('data', (value: unknown) => { received = value; });
    expect(child.stdout.emit('data', output)).toBe(true);
    expect(received).toBe(output);
    expect(rows).toEqual([
      { event: 'esbuild-spawned', childPid: 42, writtenBytes: 0, receivedBytes: 0 },
      { event: 'esbuild-input', childPid: 42, writtenBytes: input.length, receivedBytes: 0 },
      { event: 'esbuild-output', childPid: 42, writtenBytes: input.length, receivedBytes: output.length },
    ]);
    expect(JSON.stringify(rows)).not.toContain('private');
    cleanup();
    expect(child.stdin.write).toBe(write);
    expect(child.stdout.emit).toBe(originalEmit);
  });

  it('preserves an opaque native throw and ignores diagnostic failures', () => {
    const failure = Object.create(null);
    const write = () => { throw failure; };
    const child = Object.assign(new EventEmitter(), { stdin: { write }, stdout: new EventEmitter() }) as any;
    observeEsbuildStartup(child, () => { throw new Error('diagnostic unavailable'); });
    let caught;
    try { child.stdin.write(); } catch (error) { caught = error; }
    expect(caught).toBe(failure);
    child.emit('close', 1, null);
    expect(child.stdin.write).toBe(write);
  });

  it('bounds startup output while preserving every native write and restores streams on close', () => {
    let writes = 0;
    const write = () => { writes++; return true; };
    const child = Object.assign(new EventEmitter(), { stdin: { write }, stdout: new EventEmitter() }) as any;
    const originalEmit = child.stdout.emit, rows: unknown[] = [];
    observeEsbuildStartup(child, row => rows.push(row));
    for (let index = 0; index < 40; index++) child.stdin.write(Buffer.alloc(2));
    child.emit('close', 0, null);
    expect(writes).toBe(40);
    expect(rows).toHaveLength(8);
    expect(child.stdin.write).toBe(write);
    expect(child.stdout.emit).toBe(originalEmit);
  });
});

describe('focused runner startup tracing', () => {
  it.each(['run', 'collect'])('passive execution transport preserves %s call and result identities without inspecting data', request => {
    const child = new EventEmitter() as any;
    child.pid = 42;
    const rows: any[] = [], calls: any[] = [];
    const receiver = { transport: 'native' }, handle = { secret: 'never-log' };
    const options = { keepOpen: true };
    const expectedError = new Error('never-log');
    Object.defineProperty(expectedError, 'name', { get() { throw new Error('error inspected'); } });
    let callbackCalls = 0, nativeResult: unknown, nativeThrows = false;
    const callback = (error: unknown) => { expect(error).toBe(expectedError); callbackCalls++; };
    const originalSend = child.send = function(this: unknown, ...args: unknown[]) {
      calls.push({ receiver: this, args });
      if (nativeThrows) throw expectedError;
      (args[3] as typeof callback)(expectedError);
      return nativeResult;
    };
    const message = { type: request, context: { secret: 'never-log' } };
    Object.defineProperty(message, 'payload', { get() { throw new Error('payload inspected'); } });
    const opaque = { toJSON() { throw new Error('return inspected'); } };
    const detach = observeForkStartup(child, row => rows.push(row), () => 0);
    for (const result of [false, true, Promise.resolve('never-log'), opaque, undefined]) {
      nativeResult = result;
      expect(child.send.call(receiver, message, handle, options, callback)).toBe(result);
    }
    nativeThrows = true;
    let caught: unknown;
    try { child.send.call(receiver, message, handle, options, callback); }
    catch (error) { caught = error; }
    expect(caught).toBe(expectedError);
    expect(callbackCalls).toBe(5);
    expect(calls).toHaveLength(6);
    for (const call of calls) {
      expect(call.receiver).toBe(receiver);
      expect(call.args).toHaveLength(4);
      [message, handle, options, callback].forEach((value, index) => expect(call.args[index]).toBe(value));
    }
    expect(rows.map(row => row.event)).toEqual([
      ...Array(5).fill('execution-send-return'), 'execution-send-error',
    ]);
    expect(rows.map(row => row.returnType)).toEqual(['boolean', 'boolean', 'object', 'object', 'undefined', undefined]);
    expect(rows.slice(0, 5).map(row => row.returnValue)).toEqual([false, true, null, null, null]);
    expect(rows[5]).toMatchObject({ request, sendSequence: 6, thrownType: 'object' });
    expect(JSON.stringify(rows)).not.toContain('never-log');
    detach(); detach();
    expect(child.send).toBe(originalSend);
    expect(child.eventNames()).toEqual([]);
  });

  it('passive execution transport bounds observations while forwarding every request and error', () => {
    const child = new EventEmitter() as any, rows: any[] = [];
    let calls = 0;
    const expected = new Error('native-send-failed');
    const originalSend = child.send = () => { if (++calls === 40) throw expected; return false; };
    const detach = observeForkStartup(child, row => rows.push(row), () => 0);
    for (let index = 0; index < 39; index++)
      expect(child.send({ type: index % 2 ? 'run' : 'collect' })).toBe(false);
    expect(() => child.send({ type: 'run' })).toThrow(expected);
    expect(calls).toBe(40);
    expect(rows).toHaveLength(17);
    expect(rows.at(-1)).toMatchObject({ event: 'execution-send-limit', limit: 16 });
    expect(rows.filter(row => row.event === 'execution-send-return')).toHaveLength(16);
    detach();
    expect(child.send).toBe(originalSend);
  });

  it.each(['observer-first', 'fence-first'])('passive execution transport preserves startup-only refusal with a throwing sink: %s', order => {
    const child = new EventEmitter() as any, calls: unknown[] = [], errors: any[] = [];
    const originalSend = child.send = (...args: unknown[]) => { calls.push(args); return false; };
    child.on('error', (error: unknown) => errors.push(error));
    const sink = () => { throw new Error('diagnostics unavailable'); };
    const attachObserver = () => observeForkStartup(child, sink);
    const attachFence = () => controlForkStartupOnly(child, sink);
    const detaches = order === 'observer-first' ? [attachObserver(), attachFence()] : [attachFence(), attachObserver()];
    const start = { type: 'start', __vitest_worker_request__: true };
    expect(child.send(start)).toBe(false);
    for (const type of ['run', 'collect']) expect(child.send({ type, __vitest_worker_request__: true })).toBe(false);
    expect(calls).toEqual([[start]]);
    expect(errors.map(error => error.code)).toEqual(Array(2).fill('VITEST_STARTUP_ONLY_EXECUTION_REFUSED'));
    detaches.reverse().forEach(detach => { detach(); detach(); });
    expect(child.send).toBe(originalSend);
    expect(child.listenerCount('close')).toBe(0);
    expect(child.listenerCount('message')).toBe(0);
  });

  it('startup-only preserves native lifecycle send inputs, returns and errors even with a throwing sink', () => {
    const child = new EventEmitter() as any;
    const expected = new Error('native-send-error');
    const calls: unknown[] = [];
    const original = child.send = function(...args: unknown[]) {
      calls.push([this, ...args]);
      if ((args[0] as any).type === 'stop') throw expected;
      return false;
    };
    const detach = controlForkStartupOnly(child, () => { throw new Error('sink unavailable'); });
    const start = { type: 'start', __vitest_worker_request__: true, context: { secret: 'private' } };
    const callback = () => {};
    expect(child.send(start, callback)).toBe(false);
    expect(calls).toEqual([[child, start, callback]]);
    const cyclic = { ...start, context: {} as any };
    cyclic.context.self = cyclic;
    expect(child.send(cyclic, callback)).toBe(false);
    expect(() => child.send({ type: 'stop', __vitest_worker_request__: true })).toThrow(expected);
    for (const type of ['run', 'collect', 'unknown']) {
      expect(() => child.send({ type, __vitest_worker_request__: true })).toThrow('refused execution');
    }
    expect(calls).toHaveLength(3);
    detach(); detach();
    expect(child.send).toBe(original);
    expect(child.listenerCount('close')).toBe(0);
  });

  it('startup-only rejects the real pool resolver through an error, without forging test results', () => {
    const child = new EventEmitter() as any;
    child.pid = 42;
    const forwarded: unknown[] = [], errors: any[] = [], rows: any[] = [];
    child.send = (message: unknown) => { forwarded.push(message); return true; };
    child.on('error', (error: unknown) => errors.push(error));
    const detach = controlForkStartupOnly(child, row => rows.push(row));
    for (const type of ['run', 'collect', 'other']) expect(child.send({ type })).toBe(false);
    expect(forwarded).toEqual([]);
    expect(errors.map(error => error.code)).toEqual(Array(3).fill('VITEST_STARTUP_ONLY_EXECUTION_REFUSED'));
    expect(rows.map(row => row.request)).toEqual(['run', 'collect', 'unknown']);
    detach();
  });

  it.each(['enabled', 'disabled-fence', 'unsupported-pool', 'custom-pool', 'ambiguous'] as const)(
    'startup-only real installed Vitest independent execution oracle: %s', async mode => {
      const root = fileURLToPath(new URL('../../../../', import.meta.url));
      const dir = mkdtempSync(join(tmpdir(), 'vitest-startup-only-'));
      const top = join(dir, 'selected-top-level'), body = join(dir, 'selected-test-body');
      const utility = join(dir, 'native-utility'), unrelated = join(dir, 'unrelated-fork');
      const test = join(dir, 'selected.test.mjs'), config = join(dir, 'vitest.config.mjs');
      symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
      writeFileSync(test, `import { writeFileSync } from 'node:fs'; import { test } from 'vitest';
        writeFileSync(${JSON.stringify(top)}, 'selected-module-entered');
        test('independent body sentinel', () => writeFileSync(${JSON.stringify(body)}, JSON.stringify({
          value: process.env.STARTUP_FIXTURE_VALUE, execArgv: process.execArgv })));
      `);
      writeFileSync(join(dir, 'unrelated.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(unrelated)}, 'native-fork');`);
      writeFileSync(join(dir, 'setup.mjs'), `import { Worker } from 'node:worker_threads';
        import nativeThreads from 'node:worker_threads'; import { fork } from 'node:child_process';
        import { writeFileSync } from 'node:fs';
        export default async function() {
          if (Worker !== nativeThreads.Worker) throw new Error('Worker identity changed');
          const worker = new Worker('require("node:worker_threads").parentPort.postMessage(73)', { eval: true });
          await new Promise((resolve, reject) => { worker.once('error', reject);
            worker.once('message', value => { writeFileSync(${JSON.stringify(utility)}, String(value)); });
            worker.once('exit', code => code === 0 ? resolve() : reject(new Error('utility failed'))); });
          const child = fork(${JSON.stringify(join(dir, 'unrelated.cjs'))}, [], { execArgv: [], stdio: 'ignore' });
          await new Promise((resolve, reject) => { child.once('error', reject);
            child.once('close', code => code === 0 ? resolve() : reject(new Error('fork failed'))); });
        }`);
      writeFileSync(config, `export default { test: { pool: '${mode === 'unsupported-pool' ? 'threads' : 'forks'}',
        ${mode === 'custom-pool' ? "poolRunner: { name: 'custom', createPoolWorker() { throw new Error('CUSTOM_PAYLOAD_RAN'); } }," : ''}
        include: ['selected.test.mjs'], maxWorkers: 1, globalSetup: ['./setup.mjs'],
        execArgv: ['--conditions=d042-fixture-input'], env: { STARTUP_FIXTURE_VALUE: 'resolved-from-config' } } };`);
      const module = new URL('../../../../scripts/lib/vitest-startup-trace.mjs', import.meta.url).href;
      const rows: any[] = [];
      let complete = false;
      try {
        const source = `import { diagnoseVitestStartup } from ${JSON.stringify(module)};
          try { await diagnoseVitestStartup(${JSON.stringify(['--config', config, mode === 'ambiguous' ? dir : test])},
            row => console.log('DIAGNOSTIC=' + JSON.stringify(row)),
            ${mode === 'disabled-fence' ? '{ control: () => () => {} }' : '{}'}); }
          catch (error) { console.log('REFUSED=' + error.message); }
          process.exitCode = 2;`;
        const driver = join(dir, 'driver.mjs');
        writeFileSync(driver, source);
        const result = await new Promise<{ stdout: string; stderr: string; code: number | string | null }>(resolve => {
          execFile(process.execPath, [driver], {
            cwd: dir, env: { ...process.env, NODE_OPTIONS: '', PC_EXECUTED_SOURCE_MAP_OUT: '',
              PAPERCUSP_TEST_STARTUP_TRACE: '0' }, timeout: 90_000, maxBuffer: 4 * 1024 * 1024,
          }, (error, stdout, stderr) => resolve({ stdout, stderr, code: error?.code ?? 0 }));
        });
        expect(result.code, result.stdout + result.stderr).toBe(2);
        rows.push(...result.stdout.split('\n').filter(line => line.startsWith('DIAGNOSTIC='))
          .map(line => JSON.parse(line.slice('DIAGNOSTIC='.length))));
        // This filesystem oracle is independent of controller counters and of
        // Vitest's synthetic/test-result protocol. A collection leak trips top.
        const oracle = () => ({ moduleEntered: existsSync(top), testBodyEntered: existsSync(body) });
        if (mode === 'disabled-fence') {
          expect(oracle()).toEqual({ moduleEntered: true, testBodyEntered: true });
          expect(JSON.parse(readFileSync(body, 'utf8'))).toMatchObject({ value: 'resolved-from-config',
            execArgv: expect.arrayContaining(['--conditions=d042-fixture-input']) });
        } else {
          expect(oracle()).toEqual({ moduleEntered: false, testBodyEntered: false });
        }
        if (['unsupported-pool', 'custom-pool', 'ambiguous'].includes(mode)) {
          expect(result.stdout).toContain('verified forks required');
          expect(result.stdout + result.stderr).not.toContain('CUSTOM_PAYLOAD_RAN');
          expect(rows.some(row => row.event === 'controlled-worker-forked')).toBe(false);
          expect(existsSync(utility)).toBe(false);
        } else {
          expect(readFileSync(utility, 'utf8')).toBe('73');
          expect(readFileSync(unrelated, 'utf8')).toBe('native-fork');
          expect(rows.find(row => row.event === 'startup-only-contract')).toMatchObject({
            mode: 'native-vitest-forks-execution-fence',
            specifications: [expect.objectContaining({ pool: 'forks' })] });
          expect(rows.some(row => row.event === 'started-received' && !row.error)).toBe(true);
          expect(rows.find(row => row.event === 'startup-only-outcome')).toMatchObject({
            status: mode === 'enabled' ? 'startup-observed' : 'startup-incomplete', testVerdict: 'not-measured',
            workers: [expect.objectContaining({ started: true, closed: true })] });
        }
        complete = true;
      } catch (error) {
        retainNativeStartupFailure(dir, error);
        writeFileSync(join(dir, 'diagnostic-rows.json'), JSON.stringify(rows, null, 2));
        throw error;
      } finally { if (complete) rmSync(dir, { recursive: true, force: true }); }
    }, 120_000);

  it('predicts the exact native preload environment before OUT allocation without fabricating a channel', () => {
    const plain = { NODE_OPTIONS: '--stack-trace-limit=30' };
    const predicted = nativeProcessTraceEnv(plain, { enabled: true });
    const actual = nativeProcessTraceEnv({ ...plain, PC_EXECUTED_SOURCE_MAP_OUT: '/tmp/native.json' });
    expect(predicted.NODE_OPTIONS).toBe(actual.NODE_OPTIONS);
    expect(predicted.PC_EXECUTED_SOURCE_MAP_OUT).toBeUndefined();
    expect(nativeProcessTraceEnv(predicted, { enabled: true }).NODE_OPTIONS).toBe(predicted.NODE_OPTIONS);
    expect(nativeProcessTraceEnv(plain, { enabled: false })).toBe(plain);
  });

  it.each(['chain', 'simple'].flatMap(route => [0, 7].map(guardExit => ({ route, guardExit }))))(
    'runs an original empty native step without enrolling a producer and preserves owed guard exit $guardExit via $route', async ({ route, guardExit }) => {
    const root = fileURLToPath(new URL('../../../../', import.meta.url));
    const dir = mkdtempSync(join(tmpdir(), 'native-banked-step-')), out = join(dir, 'out.json');
    const command = 'vitest run --passWithNoTests --config vitest.config.mjs --configLoader native';
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!['PC_', 'VITEST', 'PAPERCUSP_TEST_', 'PAPERCUSP_CHECKPOINT_', 'PAPERCUSP_MUTATION_', 'AFFECTED_']
        .some(prefix => key.startsWith(prefix))) env[key] = value;
    }
    try {
      symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'banked-step-fixture', scripts: {
        ...(route === 'chain' ? { test: 'npm run first && npm run owed', first: command, owed: 'node owed.cjs' }
          : { test: command, posttest: 'node owed.cjs' }),
      } }));
      writeFileSync(join(dir, 'vitest.config.mjs'),
        `import {defineVitestConfig} from ${JSON.stringify(pathToFileURL(join(root, 'libs/test-config/src/vitest-config.ts')).href)};\n` +
        `export default defineVitestConfig({layer:'unit',include:['**/*.test.ts']});\n`);
      writeFileSync(join(dir, 'a.test.ts'), "throw new Error('banked file executed again');\n");
      writeFileSync(join(dir, 'owed.cjs'), `console.log('OWED_GUARD');process.exit(${guardExit});\n`);
      const source = readFileSync(join(root, 'scripts/affected-tests.mjs'), 'utf8');
      const begin = source.indexOf('  const relatedFilterList =');
      const end = source.indexOf('  // P-008 (gate-file-level-test-reuse', begin);
      expect(begin).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(begin);
      const filter = new Function('extraArgs', 'spawnTask', 'RUN_LOG_ROOT', 'writeRelatedFilterList',
        `${source.slice(begin, end)}\nreturn relatedFilterList;`)([],
      { relatedFiles: [], qualificationSelection: {} }, dir, writeRelatedFilterList);
      expect(JSON.parse(readFileSync(filter.path, 'utf8'))).toEqual([]);
      const traced = nativeProcessTraceEnv({ ...env, PC_TEST_FILTER_LIST: filter.path,
        PC_EXECUTED_SOURCE_MAP_OUT: out, PC_EXECUTED_SOURCE_MAP_NO_PERSIST: '1',
        PAPERCUSP_TEST_STARTUP_TRACE: '0' });
      const registered = route === 'chain' ? registerPartialNativeProducerChannels(out, { status: 'ready', channels: [{
        taskKey: 'ws :: test:step:0', script: 'first', command, step: 0, outPath: `${out}.step-0`,
        selectedSpecifications: [], bankedSpecifications: [{ testFile: 'a.test.ts', pool: 'forks',
          projectName: null, testNamePattern: null, testIds: null, testTagsFilter: null, testLines: null }],
      }] }, { attemptId: 'attempt', runGroupId: 'group', root: dir, workspaceName: 'ws',
        sourceCommit: 'a'.repeat(40), registeredAtMs: Date.now(),
        command: { cmd: 'npm', argv: ['run', '--silent', 'test'], cwd: dir } }, traced) : null;
      if (registered) expect(registered.producers).toEqual([]);
      const result = await promisify(execFile)('npm', ['run', '--silent', 'test'], {
        cwd: dir, env: traced, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
      }).then(value => ({ ...value, code: 0 }), error => ({ stdout: error.stdout, stderr: error.stderr, code: error.code }));
      expect(result.code, result.stderr).toBe(guardExit);
      expect(result.stdout).toContain('OWED_GUARD');
      expect(result.stdout + result.stderr).not.toContain('banked file executed again');
      expect(existsSync(`${out}.producer.json`)).toBe(false);
      expect(existsSync(`${out}.step-0.producer.json`)).toBe(false);
      const rows = readdirSync(`${out}.native-processes`).filter(name => name.endsWith('.json'))
        .map(name => JSON.parse(readFileSync(join(`${out}.native-processes`, name), 'utf8')));
      if (route === 'chain') expect(rows.find(row => row.event === 'child-spawn' && row.nativeChannel))
        .toMatchObject({ argv: ['-c', command], nativeChannel: { step: 0, command } });
      else {
        expect(rows.find(row => row.event === 'child-spawn' && row.lifecycle?.event === 'test' &&
          ['sh', '/bin/sh'].includes(row.command)))
          .toMatchObject({ argv: ['-c', command] });
        expect(rows.some(row => row.nativeChannel)).toBe(false);
      }
      const owed = rows.find(row => row.event === 'child-spawn' && row.lifecycle?.event === (route === 'chain' ? 'owed' : 'posttest'));
      expect(owed).toBeDefined();
      expect(rows.find(row => row.event === 'child-close' && row.childIdentity === owed.childIdentity))
        .toMatchObject({ code: guardExit, signal: null });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 180_000);

  it('retains native reporter diagnostics when verification fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-reporter-retention-'));
    const trace = join(dir, 'trace.json');
    const retainedMessages: string[] = [];
    writeFileSync(trace, '{"event":"reporter-started"}');
    try {
      cleanupNativeReporterFixture(dir, false, message => retainedMessages.push(message));
      expect(existsSync(trace)).toBe(true);
      expect(retainedMessages).toEqual([`[native-reporter-channel] retained failure evidence: ${dir}\n`]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('binds an actual native Vitest reporter through the original npm channel before reading outcomes', async () => {
    const root = fileURLToPath(new URL('../../../../', import.meta.url));
    const fixture = join(root, 'libs/test-config/src/__fixtures__/armed-capture');
    const config = join(fixture, 'vitest.config.ts');
    const dir = mkdtempSync(join(tmpdir(), 'native-reporter-channel-')), out = join(dir, 'out.json');
    let completed = false;
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!['PC_', 'VITEST', 'PAPERCUSP_TEST_', 'PAPERCUSP_CHECKPOINT_', 'PAPERCUSP_MUTATION_', 'AFFECTED_']
        .some(prefix => key.startsWith(prefix))) env[key] = value;
    }
    try {
      const candidate = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 10_000 }).trim();
      const discovery = execFileSync(process.execPath, [join(root, 'scripts/resolve-vitest-config-contracts.mjs')], {
        cwd: root, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
        input: JSON.stringify({ requests: [{ root: fixture, repositoryRoot: root, config,
          enumerateFiles: true, enumerateSpecifications: true }] }),
      });
      const marker = 'PC_VITEST_CONFIG_CONTRACTS=';
      const line = discovery.split(/\r?\n/).find(value => value.startsWith(marker));
      const selected = JSON.parse(line!.slice(marker.length)).results[0];
      expect(selected.ok, discovery).toBe(true);
      expect(selected.selectedSpecifications).toHaveLength(1);
      Object.assign(env, {
        PC_EXECUTED_SOURCE_MAP_WORKSPACE: '@papercusp/native-channel-fixture',
        PC_EXECUTED_SOURCE_MAP_OUT: out, PC_EXECUTED_SOURCE_MAP_NO_PERSIST: '1',
        PC_EXECUTED_INPUTS_DIR: join(dir, 'inputs'), PAPERCUSP_TEST_RUN_GROUP: 'native-channel-run',
        PAPERCUSP_CHECKPOINT_QUALIFICATION_ATTEMPT_ID: 'native-channel-attempt',
        PAPERCUSP_TEST_RUNS_DB_URL: 'postgresql://127.0.0.1:1/native-channel-fixture',
        PAPERCUSP_TEST_STARTUP_TRACE: '0',
      });
      const traced = nativeProcessTraceEnv(env);
      const command = JSON.parse(readFileSync(join(fixture, 'package.json'), 'utf8')).scripts.native;
      const enrollment = registerPartialNativeProducerChannels(out, { status: 'ready', channels: [{
        taskKey: 'fixture :: test:step:0', script: 'native', command, step: 0, outPath: `${out}.step-0`,
        selectedSpecifications: selected.selectedSpecifications,
      }] }, { attemptId: 'native-channel-attempt', runGroupId: 'native-channel-run', root,
        workspaceName: '@papercusp/native-channel-fixture', sourceCommit: candidate, registeredAtMs: Date.now(),
        command: { cmd: 'npm', argv: ['run', '--silent', 'test'], cwd: fixture } }, traced);
      await promisify(execFile)('npm', ['run', '--silent', 'test'], {
        cwd: fixture, env: traced, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
      });
      const { producer, path } = enrollment.producers[0]!;
      const snapshot = JSON.parse(readFileSync(producer.outPath, 'utf8'));
      const custody = readPartialNativeChannelCustody(producer, snapshot.nativeRun);
      expect(custody, JSON.stringify(custody)).toMatchObject({ status: 'bound',
        custody: { terminal: true, reporterPid: snapshot.nativeRun.pid } });
      // This real reporter exceeds the module-event budget. Only that scoped
      // gap is compatible with complete physical channel custody.
      const traceRoot = `${out}.native-processes`;
      const moduleLimit = readdirSync(traceRoot).filter(name => name.endsWith('.json'))
        .map(name => ({ name, row: JSON.parse(readFileSync(join(traceRoot, name), 'utf8')) }))
        .find(({ row }) => row.event === 'trace-limit' && row.observationScope === 'module' &&
          row.pid === snapshot.nativeRun.pid && row.threadId === 0)!;
      expect(moduleLimit).toBeDefined();
      const originalLimit = readFileSync(join(traceRoot, moduleLimit.name));
      for (const observationScope of [undefined, 'general']) {
        const altered = { ...moduleLimit.row, observationScope };
        const bytes = Buffer.from(JSON.stringify(altered));
        const name = `${createHash('sha256').update(bytes).digest('hex')}.json`;
        rmSync(join(traceRoot, moduleLimit.name));
        writeFileSync(join(traceRoot, name), bytes);
        try {
          expect(readPartialNativeChannelCustody(producer, snapshot.nativeRun))
            .toMatchObject({ status: 'refused', reason: 'native-channel-trace-gap' });
        } finally {
          rmSync(join(traceRoot, name));
          writeFileSync(join(traceRoot, moduleLimit.name), originalLimit);
        }
      }
      const expected = { attemptId: producer.attemptId, root, taskKey: producer.taskKey,
        workspaceName: producer.workspaceName, producerPath: path,
        selectedSpecifications: selected.selectedSpecifications, manifest: { schemaVersion: 1,
          units: selected.selectedSpecifications.map((spec: any) => ({
            id: `test:${spec.testFile}`, kind: 'test', path: spec.testFile })) } };
      const read = () => readPartialNativeCompletion(producer.outPath, expected, {
        requireTerminal: true, classifyReadPaths: () => ({ readPaths: [], opaqueReasons: [] }),
      });
      const completion = read();
      // A shared, unpinned install deliberately has no reusable runtime identity.
      // Physical custody still binds, but cannot supply that independent proof.
      if (snapshot.completionCheckpoint.runnerIdentity === null) {
        expect(snapshot.rows[0].opaqueReasons).toContain('worker-runtime-unavailable');
        expect(completion, JSON.stringify(completion)).toMatchObject({ status: 'refused',
          reason: 'snapshot-identity-mismatch', receipts: [], currentEvidence: [] });
      } else {
        expect(completion, JSON.stringify(completion)).toMatchObject({ status: 'ready',
          origin: { terminal: 'passed' }, receipts: [expect.objectContaining({ state: 'pass' })] });
      }
      const { completionIntegrity: _missingSeal, ...missingIdentity } = snapshot;
      missingIdentity.completionCheckpoint = { ...missingIdentity.completionCheckpoint, runnerIdentity: null };
      writeFileSync(producer.outPath, JSON.stringify({ ...missingIdentity, completionIntegrity: { schemaVersion: 1,
        sha256: createHash('sha256').update(JSON.stringify(missingIdentity)).digest('hex') } }));
      expect(read()).toMatchObject({ status: 'refused', reason: 'snapshot-identity-mismatch',
        receipts: [], currentEvidence: [] });
      const { completionIntegrity: _seal, ...foreign } = snapshot;
      foreign.nativeRun.pid += 10_000_000;
      expect(readPartialNativeChannelCustody(producer, foreign.nativeRun)).toMatchObject({ status: 'refused' });
      writeFileSync(producer.outPath, JSON.stringify({ ...foreign, completionIntegrity: { schemaVersion: 1,
        sha256: createHash('sha256').update(JSON.stringify(foreign)).digest('hex') } }));
      expect(read()).toMatchObject({ status: 'refused', receipts: [] });
      completed = true;
    } finally {
      cleanupNativeReporterFixture(dir, completed);
    }
  }, 180_000);

  it.each(['clean', 'corrupt-plan', 'changed-script', 'claimed-channel'])(
    'binds original npm occurrences to distinct reporter channels, %s', async fault => {
      const dir = mkdtempSync(join(tmpdir(), 'native-npm-channels-'));
      const out = join(dir, 'sources.json');
      const command = 'node leaf.cjs';
      const scripts = { test: 'npm run first && npm run second && npm run first',
        first: command, second: command };
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'channel-fixture', scripts }));
      writeFileSync(join(dir, 'leaf.cjs'), `const fs = require('node:fs');
        const startedAtMs = Date.now(); console.log(process.env.PC_EXECUTED_SOURCE_MAP_OUT);
        fs.writeFileSync(process.env.PC_EXECUTED_SOURCE_MAP_OUT, JSON.stringify({
          schemaVersion: 'native-vitest-run-v1', scope: 'vitest-reporter-callbacks',
          pid: process.pid, ppid: process.ppid, startedAtMs, finishedAtMs: Date.now(),
          terminalHook: 'onTestRunEnd', reason: 'passed', unhandledErrorCount: 0,
          modulePopulationMatched: true, gaps: [], files: [] }));`);
      const env = nativeProcessTraceEnv({ ...process.env, PC_EXECUTED_SOURCE_MAP_OUT: out,
        PAPERCUSP_TEST_STARTUP_TRACE: '0' });
      const channels = ['first', 'second', 'first'].map((script, step) => ({
        taskKey: `ws :: test:step:${step}`, script, command, step, outPath: `${out}.step-${step}`,
        selectedSpecifications: [{ testFile: `file-${step}.test.ts`, pool: 'forks', projectName: null,
          testNamePattern: null, testIds: null, testTagsFilter: null, testLines: null }],
      }));
      let completed = false;
      try {
        const enrolled = registerPartialNativeProducerChannels(out, { status: 'ready', channels }, {
          attemptId: 'attempt', runGroupId: 'group', root: dir, workspaceName: 'ws',
          sourceCommit: 'a'.repeat(40), registeredAtMs: Date.now(),
          command: { cmd: 'npm', argv: ['run', '--silent', 'test'], cwd: dir },
        }, env);
        expect(enrolled.operationalAcceptance).toBe(false);
        if (fault === 'corrupt-plan') writeFileSync(enrolled.path, '{}');
        if (fault === 'changed-script') {
          scripts.first += ' # changed';
          writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'channel-fixture', scripts }));
        }
        if (fault === 'claimed-channel') writeFileSync(`${out}.step-0.binding.json`, 'earlier-claim');
        const { stdout, stderr } = await promisify(execFile)('npm', ['run', '--silent', 'test'],
          { cwd: dir, env, timeout: 20_000 });
        const expected = fault === 'clean' ? channels.map(channel => channel.outPath) :
          fault === 'corrupt-plan' ? [out, out, out] :
          fault === 'changed-script' ? [out, channels[1]!.outPath, out] :
          [out, channels[1]!.outPath, out];
        expect(stdout.trim().split('\n')).toEqual(expected);
        expect(stderr).toBe('');
        const rows = readdirSync(`${out}.native-processes`).filter(name => name.endsWith('.json'))
          .map(name => JSON.parse(readFileSync(join(`${out}.native-processes`, name), 'utf8')));
        const leaves = rows.filter(row => row.event === 'node-entry' && row.argv[1]?.endsWith('leaf.cjs'));
        expect(leaves).toHaveLength(3);
        expect(leaves.map(row => row.reporterOut).sort()).toEqual([...expected].sort());
        const routed = rows.filter(row => row.event === 'child-spawn' && row.nativeChannel);
        expect(routed).toHaveLength(fault === 'clean' ? 3 : fault === 'corrupt-plan' ? 0 : 1);
        for (const spawn of routed) {
          const binding = JSON.parse(readFileSync(`${spawn.nativeChannel.outPath}.binding.json`, 'utf8'));
          expect(binding).toMatchObject({ childIdentity: spawn.childIdentity,
            processIdentity: spawn.processIdentity, parentPid: spawn.pid });
          expect(rows.find(row => row.event === 'child-close' && row.childIdentity === spawn.childIdentity))
            .toMatchObject({ code: 0, signal: null, childPid: spawn.childPid });
          expect(leaves.some(row => row.reporterOut === binding.outPath &&
            (row.ppid === spawn.childPid || row.pid === spawn.childPid))).toBe(true);
        }
        if (fault === 'claimed-channel')
          expect(readFileSync(`${out}.step-0.binding.json`, 'utf8')).toBe('earlier-claim');
        if (fault === 'clean') {
          for (const { producer } of enrolled.producers) {
            const native = JSON.parse(readFileSync(producer.outPath, 'utf8'));
            expect(readPartialNativeChannelCustody(producer, native)).toMatchObject({ status: 'bound',
              custody: { reporterPid: native.pid, terminal: true } });
          }
          const producer = enrolled.producers[0]!.producer;
          const native = JSON.parse(readFileSync(producer.outPath, 'utf8'));
          const read = () => readPartialNativeChannelCustody(producer, native);
          const editEvent = (event: any, mutate: (row: any) => void) => {
            const original = Buffer.from(JSON.stringify(event));
            const file = join(`${out}.native-processes`, `${createHash('sha256').update(original).digest('hex')}.json`);
            const changed = structuredClone(event); mutate(changed);
            const bytes = Buffer.from(JSON.stringify(changed));
            const replacement = join(`${out}.native-processes`, `${createHash('sha256').update(bytes).digest('hex')}.json`);
            rmSync(file); writeFileSync(replacement, bytes);
            try { expect(read().status).toBe('refused'); }
            finally { rmSync(replacement); writeFileSync(file, original); }
          };
          const spawn = routed.find(row => row.nativeChannel.outPath === producer.outPath)!;
          const close = rows.find(row => row.event === 'child-close' && row.childIdentity === spawn.childIdentity)!;
          const entry = leaves.find(row => row.pid === native.pid)!;
          const exit = rows.find(row => row.event === 'node-exit' && row.pid === native.pid)!;
          editEvent(spawn, row => { row.argv[1] += ' # foreign'; });
          editEvent(spawn, row => { row.nativeChannel.step++; });
          editEvent(close, row => { row.signal = 'SIGTERM'; row.code = null; });
          editEvent(close, row => { row.atMs = native.startedAtMs - 1; });
          editEvent(entry, row => { row.reporterOut = out; });
          editEvent(entry, row => { row.ppid = 1; row.pid = 1; });
          editEvent(exit, row => { row.streams.stdout.captureComplete = false; });
          editEvent(exit, row => { row.exitListenersComplete = false; });
          const stream = join(`${out}.native-processes`, exit.streams.stdout.ref);
          const bytes = readFileSync(stream);
          writeFileSync(stream, Buffer.alloc(bytes.length, 120));
          expect(read().status).toBe('refused');
          writeFileSync(stream, bytes);
          const bindingPath = `${producer.outPath}.binding.json`, binding = readFileSync(bindingPath);
          writeFileSync(bindingPath, '{}');
          expect(read().status).toBe('refused');
          writeFileSync(bindingPath, binding);
          expect(readPartialNativeChannelCustody(producer, { ...native, pid: native.pid + 10_000_000 }).status).toBe('refused');
          expect(readPartialNativeChannelCustody({ ...producer,
            command: { ...producer.command, argv: ['run', 'foreign'] } }, native).status).toBe('refused');
          expect(read().status).toBe('bound');
        }
        completed = true;
      } catch (error) {
        retainNativeStartupFailure(dir, error);
        throw error;
      } finally { if (completed) rmSync(dir, { recursive: true, force: true }); }
    }, 30_000);

  it.each(['event', 'stream'])('never publishes partial %s artifacts when killed after opening the output', async kind => {
    const dir = mkdtempSync(join(tmpdir(), 'native-interrupted-write-'));
    const out = join(dir, 'sources.json');
    const preload = new URL('../../../../scripts/lib/vitest-startup-trace.mjs?interrupted-write', import.meta.url).href;
    const env: NodeJS.ProcessEnv = { ...process.env, PAPERCUSP_TEST_STARTUP_TRACE: '0' };
    delete env.PC_EXECUTED_SOURCE_MAP_OUT;
    const source = `import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const write = fs.writeFileSync;
      fs.writeFileSync = function(path, bytes, ...args) {
        const content = Buffer.from(bytes).toString();
        if (String(path).startsWith(${JSON.stringify(out + '.native-processes')}) &&
            (${JSON.stringify(kind)} === 'event' ? content.startsWith('{') : content === 'fixture-body')) {
          fs.closeSync(fs.openSync(path, 'wx'));
          process.stdout.write('NATIVE_WRITE_OPEN');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        }
        return write.call(this, path, bytes, ...args);
      };
      syncBuiltinESMExports();
      process.env.PC_EXECUTED_SOURCE_MAP_OUT = ${JSON.stringify(out)};
      await import(${JSON.stringify(preload)});
      process.stdout.write('fixture-body');`;
    try {
      let entered = false, output = '';
      await new Promise<void>((resolve, reject) => {
        const child = execFile(process.execPath, ['--input-type=module', '-e', source],
          { env, timeout: 10_000, killSignal: 'SIGKILL' }, error => {
            if (entered && error?.signal === 'SIGKILL') resolve();
            else reject(error ?? new Error('interrupted writer unexpectedly returned'));
          });
        createTextCollector(child.stdout, { retainText: false, onDecodedText: text => {
          output += text;
          if (output.includes('NATIVE_WRITE_OPEN')) { entered = true; child.kill('SIGKILL'); }
        } });
      });
      expect(entered).toBe(true);
      const names = readdirSync(`${out}.native-processes`);
      if (kind === 'stream') expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        const bytes = readFileSync(join(`${out}.native-processes`, name));
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(name.split('.')[0]);
        if (name.endsWith('.json')) expect(JSON.parse(bytes.toString())).toHaveProperty('schemaVersion', 1);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('arms native observation only on the existing OUT channel, without changing stderr trace mode', () => {
    const plain = { NODE_OPTIONS: '--conditions=test' };
    expect(nativeProcessTraceEnv(plain)).toBe(plain);
    const armed = nativeProcessTraceEnv({ ...plain, PC_EXECUTED_SOURCE_MAP_OUT: '/tmp/native.json' });
    expect(armed.NODE_OPTIONS).toContain(plain.NODE_OPTIONS);
    expect(armed.PAPERCUSP_TEST_STARTUP_TRACE).toBeUndefined();
    expect(nativeProcessTraceEnv(armed).NODE_OPTIONS).toBe(armed.NODE_OPTIONS);
  });

  it('collects real Vitest tests with native source capture and startup tracing both armed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-capture-collection-'));
    const out = join(dir, 'sources.json');
    const vitest = fileURLToPath(new URL('../../../../node_modules/vitest/vitest.mjs', import.meta.url));
    const api = new URL('../../../../node_modules/vitest/dist/index.js', import.meta.url).href;
    writeFileSync(join(dir, 'vitest.config.mjs'),
      "export default { test: { include: ['capture.test.mjs'], pool: 'forks', maxWorkers: 1 } };\n");
    writeFileSync(join(dir, 'capture.test.mjs'),
      `import { test } from ${JSON.stringify(api)}; test('capture collection reached', () => {});\n`);
    let completed = false;
    try {
      const { stdout, stderr } = await promisify(execFile)(process.execPath,
        [vitest, 'list', '--root', dir, '--config', join(dir, 'vitest.config.mjs'), '--json'], {
          env: nativeProcessTraceEnv({ PATH: process.env.PATH, HOME: process.env.HOME,
            NODE_OPTIONS: '', PC_EXECUTED_SOURCE_MAP_OUT: out, PAPERCUSP_TEST_STARTUP_TRACE: '1' }),
          timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
        });
      expect(JSON.parse(stdout)).toEqual([expect.objectContaining({ name: 'capture collection reached' })]);
      expect(stderr).not.toContain('ERR_INVALID_OBJECT_DEFINE_PROPERTY');
      expect(stderr).toContain('TEST_FILE_STARTUP_TRACE ');
      const rows = readdirSync(`${out}.native-processes`).filter(name => name.endsWith('.json'))
        .map(name => JSON.parse(readFileSync(join(`${out}.native-processes`, name), 'utf8')));
      expect(rows.some(row => row.event === 'node-entry' && row.argv[1] === vitest)).toBe(true);
      expect(rows.some(row => row.event === 'node-exit' && row.code === 0)).toBe(true);
      completed = true;
    } catch (error) {
      retainNativeStartupFailure(dir, error);
      throw error;
    } finally { if (completed) rmSync(dir, { recursive: true, force: true }); }
  }, 45_000);

  it('distinguishes worker threads from process entries while retaining thread source bytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-thread-source-'));
    const out = join(dir, 'sources.json');
    const worker = join(dir, 'worker.mjs'), main = join(dir, 'main.mjs');
    const source = "import { parentPort } from 'node:worker_threads'; parentPort.postMessage('loaded');";
    writeFileSync(worker, source);
    writeFileSync(main, `import { Worker } from 'node:worker_threads';
      const worker = new Worker(new URL('./worker.mjs', import.meta.url));
      worker.once('error', error => { throw error; });
      worker.once('message', value => { if (value !== 'loaded') process.exitCode = 1; });`);
    try {
      await promisify(execFile)(process.execPath, [main], {
        env: nativeProcessTraceEnv({ ...process.env, PC_EXECUTED_SOURCE_MAP_OUT: out,
          PAPERCUSP_TEST_STARTUP_TRACE: '0' }), timeout: 30_000,
      });
      const rows = readdirSync(`${out}.native-processes`).filter(name => name.endsWith('.json')).map(name =>
        JSON.parse(readFileSync(join(`${out}.native-processes`, name), 'utf8')));
      const entries = rows.filter(row => row.event === 'node-entry');
      const processes = entries.filter(row => row.threadId === 0);
      const threads = entries.filter(row => row.threadId > 0);
      expect(processes).toHaveLength(1);
      expect(threads).toHaveLength(1);
      expect(threads[0].pid).toBe(processes[0].pid);
      expect(threads[0].processIdentity).not.toBe(processes[0].processIdentity);
      expect(processes[0].kernelProcessIdentity).toEqual(expect.any(String));
      expect(threads[0].kernelProcessIdentity).toBe(processes[0].kernelProcessIdentity);
      expect(processes[0].kernelProcessIdentity).not.toBe(processes[0].processIdentity);
      const loaded = rows.find(row => row.event === 'module-load-return' && row.url === pathToFileURL(worker).href);
      expect(loaded).toMatchObject({ threadId: threads[0].threadId, processIdentity: threads[0].processIdentity,
        source: { status: 'hashed', sha256: createHash('sha256').update(source).digest('hex') } });
      expect(readFileSync(join(`${out}.native-processes`, loaded.source.ref), 'utf8')).toBe(source);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 45_000);

  it.each(['string', 'view', 'array-buffer'])('fingerprints returned %s source and preserves a delegated loader error object', async representation => {
    const dir = mkdtempSync(join(tmpdir(), 'native-module-load-'));
    const out = join(dir, 'sources.json');
    const good = pathToFileURL(join(dir, 'good.mjs')).href;
    const bad = pathToFileURL(join(dir, 'bad.mjs')).href;
    const preload = new URL('../../../../scripts/lib/vitest-startup-trace.mjs?module-load-contract', import.meta.url).href;
    const returnedSource = 'export const value = 42; // λ';
    writeFileSync(join(dir, 'good.mjs'), 'export const value = -1;');
    writeFileSync(join(dir, 'bad.mjs'), 'export const unreachable = true;');
    const env: NodeJS.ProcessEnv = { ...process.env, PAPERCUSP_TEST_STARTUP_TRACE: '0' };
    delete env.PC_EXECUTED_SOURCE_MAP_OUT;
    try {
      const source = `import { registerHooks } from 'node:module';
        const expected = Object.assign(new Error('fixture loader error'), {code:'FIXTURE_LOAD'});
        registerHooks({load(url, context, nextLoad) {
          if (url === ${JSON.stringify(bad)}) throw expected;
          if (url === ${JSON.stringify(good)}) {
            const source = ${JSON.stringify(returnedSource)};
            const padded = Buffer.from('padding' + source + 'suffix');
            return { ...nextLoad(url, context), source:
              ${JSON.stringify(representation)} === 'string' ? source :
              ${JSON.stringify(representation)} === 'view' ? padded.subarray(7, padded.length - 6) :
              new TextEncoder().encode(source).buffer };
          }
          return nextLoad(url, context);
        }});
        process.env.PC_EXECUTED_SOURCE_MAP_OUT = ${JSON.stringify(out)};
        await import(${JSON.stringify(preload)});
        const { value } = await import(${JSON.stringify(good)});
        let sameError = false;
        try { await import(${JSON.stringify(bad)}); } catch (error) { sameError = error === expected; }
        process.stdout.write(JSON.stringify({value,sameError}));`;
      const { stdout, stderr } = await promisify(execFile)(process.execPath,
        ['--input-type=module', '-e', source], { env, timeout: 10_000 });
      expect(JSON.parse(stdout)).toEqual({ value: 42, sameError: true });
      expect(stderr).toBe('');
      const rows = readdirSync(`${out}.native-processes`).filter(name => name.endsWith('.json')).map(name =>
        JSON.parse(readFileSync(join(`${out}.native-processes`, name), 'utf8')));
      const start = rows.find(row => row.event === 'module-load-start' && row.url === good);
      expect(start).toMatchObject({ scope: 'node-sync-load-hook' });
      expect(rows.find(row => row.event === 'module-load-return' && row.url === good))
        .toMatchObject({ loadId: start.loadId, processIdentity: start.processIdentity, format: 'module', elapsedMs: expect.any(Number),
          source: { scope: 'node-loader-returned-source', status: 'hashed',
            byteLength: Buffer.byteLength(returnedSource),
            sha256: createHash('sha256').update(returnedSource).digest('hex') } });
      const pin = rows.find(row => row.event === 'module-load-return' && row.url === good).source;
      expect(pin.ref).toBe(`${pin.sha256}.source`);
      expect(readFileSync(join(`${out}.native-processes`, pin.ref)).equals(Buffer.from(returnedSource))).toBe(true);
      expect(rows.find(row => row.event === 'module-load-error' && row.url === bad))
        .toMatchObject({ errorCode: 'FIXTURE_LOAD', errorName: 'Error' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('bounds per-module and per-process source hashing without changing native loads', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-module-source-bounds-'));
    const out = join(dir, 'sources.json');
    const urls = Array.from({ length: 6 }, (_, i) => pathToFileURL(join(dir, `${i}.mjs`)).href);
    // Resolution precedes load hooks; these bytes must exist but must not be
    // mistaken for the transformed source returned by the fixture loader.
    for (let i = 0; i < urls.length; i++) writeFileSync(join(dir, `${i}.mjs`), 'export default -1;');
    const preload = new URL('../../../../scripts/lib/vitest-startup-trace.mjs?source-bounds', import.meta.url).href;
    const env: NodeJS.ProcessEnv = { ...process.env, PAPERCUSP_TEST_STARTUP_TRACE: '0' };
    delete env.PC_EXECUTED_SOURCE_MAP_OUT;
    try {
      const source = `import { registerHooks } from 'node:module';
        const urls = ${JSON.stringify(urls)}, prefix = 'export default 42;';
        const bounded = prefix + '/*' + 'x'.repeat(16 * 1024 * 1024 - prefix.length - 4) + '*/';
        registerHooks({load(url, context, nextLoad) {
          const index = urls.indexOf(url);
          if (index < 0) return nextLoad(url, context);
          return { format:'module', shortCircuit:true,
            source: index === 0 ? bounded + ' ' : index === 5 ? prefix : bounded };
        }});
        process.env.PC_EXECUTED_SOURCE_MAP_OUT = ${JSON.stringify(out)};
        await import(${JSON.stringify(preload)});
        const values = [];
        for (const url of urls) values.push((await import(url)).default);
        process.stdout.write(JSON.stringify(values));`;
      const { stdout, stderr } = await promisify(execFile)(process.execPath,
        ['--input-type=module', '-e', source], { env, timeout: 15_000 });
      expect(JSON.parse(stdout)).toEqual([42, 42, 42, 42, 42, 42]);
      expect(stderr).toBe('');
      const rows = readdirSync(`${out}.native-processes`).filter(name => name.endsWith('.json')).map(name =>
        JSON.parse(readFileSync(join(`${out}.native-processes`, name), 'utf8')));
      const observations = urls.map(url => rows.find(row => row.event === 'module-load-return' && row.url === url).source);
      expect(observations[0]).toMatchObject({ status: 'limit', limit: 'source-byte-limit' });
      expect(observations.slice(1, 5)).toEqual(Array.from({ length: 4 }, () => expect.objectContaining({
        status: 'hashed', byteLength: 16 * 1024 * 1024, sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      })));
      expect(observations[5]).toMatchObject({ status: 'limit', limit: 'process-byte-limit' });
      expect(observations.filter(row => row.status === 'limit').every(row => !('sha256' in row))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('retains the attempted file load when a child blocks before the loader returns', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-module-stall-'));
    const out = join(dir, 'sources.json');
    const target = pathToFileURL(join(dir, 'blocked.mjs')).href;
    const preload = new URL('../../../../scripts/lib/vitest-startup-trace.mjs?module-load-stall', import.meta.url).href;
    writeFileSync(join(dir, 'blocked.mjs'), 'export const unreachable = true;');
    const env: NodeJS.ProcessEnv = { ...process.env, PAPERCUSP_TEST_STARTUP_TRACE: '0' };
    delete env.PC_EXECUTED_SOURCE_MAP_OUT;
    const source = `import { registerHooks } from 'node:module';
      registerHooks({load(url, context, nextLoad) {
        if (url === ${JSON.stringify(target)}) {
          process.stdout.write('LOAD_BLOCKED');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        }
        return nextLoad(url, context);
      }});
      process.env.PC_EXECUTED_SOURCE_MAP_OUT = ${JSON.stringify(out)};
      await import(${JSON.stringify(preload)});
      await import(${JSON.stringify(target)});`;
    try {
      let entered = false;
      await new Promise<void>((resolve, reject) => {
        const child = execFile(process.execPath, ['--input-type=module', '-e', source],
          { env, timeout: 10_000, killSignal: 'SIGKILL' }, error => {
            if (entered && error?.signal === 'SIGKILL') resolve();
            else reject(error ?? new Error('blocked loader unexpectedly returned'));
          });
        child.stdout?.on('data', chunk => {
          if (String(chunk).includes('LOAD_BLOCKED')) { entered = true; child.kill('SIGKILL'); }
        });
      });
      const rows = readdirSync(`${out}.native-processes`).filter(name => name.endsWith('.json')).map(name =>
        JSON.parse(readFileSync(join(`${out}.native-processes`, name), 'utf8')));
      expect(rows.filter(row => row.event === 'module-load-start' && row.url === target)).toHaveLength(1);
      expect(rows.filter(row => ['module-load-return', 'module-load-error'].includes(row.event) && row.url === target))
        .toHaveLength(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each(['complete', 'events', 'bytes', 'invalid'] as const)(
    'enrolled loader census retains its declared population or explicit %s gap', async mode => {
      const dir = mkdtempSync(join(tmpdir(), 'native-loader-census-'));
      const out = join(dir, 'sources.json');
      const preload = new URL('../../../../scripts/lib/vitest-startup-trace.mjs?loader-census', import.meta.url).href;
      const modules = Array.from({ length: 180 }, (_, index) => {
        const path = join(dir, `module-${index}.mjs`);
        writeFileSync(path, `export const value = ${index};`);
        return pathToFileURL(path).href;
      });
      const census = { events: mode === 'events' ? 8 : 2048, bytes: mode === 'bytes' ? 1024 : 2 * 1024 ** 2 };
      const env = { ...process.env, NODE_OPTIONS: '', PC_EXECUTED_SOURCE_MAP_OUT: '',
        PAPERCUSP_TEST_STARTUP_TRACE: '0', PC_NATIVE_LOADER_SOURCE_PINS: '[]',
        PC_NATIVE_LOADER_CENSUS: mode === 'invalid' ? '{"events":-1,"bytes":1024}' : JSON.stringify(census) };
      try {
        const source = `process.env.PC_EXECUTED_SOURCE_MAP_OUT = ${JSON.stringify(out)};
          await import(${JSON.stringify(preload)});
          let sum = 0;
          for (const url of ${JSON.stringify(modules)}) sum += (await import(url)).value;
          process.stdout.write(String(sum));`;
        const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], {
          env, timeout: 15_000,
        });
        expect(result.stdout).toBe('16110');
        expect(result.stderr).toBe('');
        const trace = readNativeProcessTraceArtifacts(out);
        expect(trace.population.complete).toBe(true);
        const rows = trace.rows.map(({ row }: any) => row);
        expect(rows.find((row: any) => row.event === 'node-exit')).toMatchObject({ code: 0 });
        if (mode === 'invalid') {
          expect(rows.filter((row: any) => row.event === 'module-census-invalid')).toHaveLength(1);
          expect(rows.find((row: any) => row.event === 'node-entry').loaderCensus).toBeNull();
        } else if (mode === 'complete') {
          expect(rows.find((row: any) => row.event === 'node-entry').loaderCensus).toEqual(census);
          expect(rows.filter((row: any) => ['trace-limit', 'module-load-limit', 'module-resolve-limit'].includes(row.event)))
            .toEqual([]);
          for (const url of modules) {
            const loads = rows.filter((row: any) => row.event === 'module-load-return' && row.url === url);
            expect(loads).toHaveLength(1);
            const pin = loads[0].source;
            expect(readFileSync(join(`${out}.native-processes`, pin.ref)).toString())
              .toBe(readFileSync(fileURLToPath(url), 'utf8'));
            expect(rows.filter((row: any) => row.event === 'module-resolve-return' && row.url === url)).toHaveLength(1);
          }
        } else {
          const limits = rows.filter((row: any) => row.event === 'trace-limit' && row.observationScope === 'module');
          expect(limits).toHaveLength(1);
          expect(limits[0]).toMatchObject({ reason: `loader-census-${mode}`, limits: census });
          expect(limits[0].retained.events).toBeLessThanOrEqual(census.events);
          expect(limits[0].retained.bytes).toBeLessThanOrEqual(census.bytes);
          expect(rows.filter((row: any) => row.event === 'module-load-return').length).toBeLessThan(modules.length);
        }
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

  it.each(['complete', 'batches', 'bytes'] as const)(
    'batched loader census retains more than 8192 events or an explicit %s gap', async mode => {
      const dir = mkdtempSync(join(tmpdir(), 'native-loader-batches-'));
      const out = join(dir, 'sources.json');
      const preload = new URL('../../../../scripts/lib/vitest-startup-trace.mjs?loader-batches', import.meta.url).href;
      const census = { batches: mode === 'batches' ? 1 : 128,
        bytes: mode === 'bytes' ? 1024 : 16 * 1024 ** 2 };
      try {
        const source = `process.env.PC_EXECUTED_SOURCE_MAP_OUT = ${JSON.stringify(out)};
          await import(${JSON.stringify(preload)});
          for (let i = 0; i < 4300; i++) await import('node:fs');
          process.stdout.write('all imports completed');`;
        const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], {
          env: { ...process.env, NODE_OPTIONS: '', PC_EXECUTED_SOURCE_MAP_OUT: '',
            PAPERCUSP_TEST_STARTUP_TRACE: '0', PC_NATIVE_LOADER_SOURCE_PINS: '[]',
            PC_NATIVE_LOADER_CENSUS: JSON.stringify(census) }, timeout: 15_000,
        });
        expect(result.stdout).toBe('all imports completed');
        expect(result.stderr).toBe('');
        const trace = readNativeProcessTraceArtifacts(out);
        expect(trace.population.artifactsVisited).toBeLessThan(150);
        const rows = trace.rows.map(({ row }: any) => row);
        const end = rows.find((row: any) => row.event === 'module-census-end');
        expect(end).toMatchObject({ stopped: mode !== 'complete' });
        if (mode !== 'complete') {
          expect(trace.population.complete).toBe(false);
          expect(rows.filter((row: any) => row.event === 'trace-limit'))
            .toEqual([expect.objectContaining({ reason: `loader-census-${mode}` })]);
          return;
        }
        expect(trace.population.complete).toBe(true);
        const starts = rows.filter((row: any) => row.event === 'module-resolve-start');
        const returned = rows.filter((row: any) => row.event === 'module-resolve-return');
        expect(starts).toHaveLength(4300);
        expect(returned).toHaveLength(4300);
        expect(end.events).toBe(8600);
        expect(new Set(starts.map((row: any) => row.resolveId))).toEqual(new Set(returned.map((row: any) => row.resolveId)));
        const root = `${out}.native-processes`;
        const originals = readdirSync(root).filter(name => name.endsWith('.json'))
          .map(name => ({ name, bytes: readFileSync(join(root, name)) }));
        const batch = originals.find(({ bytes }) => JSON.parse(bytes.toString()).event === 'module-census-batch')!;
        // Rehashing an altered packet still fails its independently retained
        // terminal digest. A missing packet or seal cannot pass as a prefix.
        const changed = JSON.parse(batch.bytes.toString());
        changed.events[0].specifier = 'node:changed';
        const replacement = Buffer.from(JSON.stringify(changed));
        const replacementName = createHash('sha256').update(replacement).digest('hex') + '.json';
        rmSync(join(root, batch.name)); writeFileSync(join(root, replacementName), replacement);
        expect(readNativeProcessTraceArtifacts(out).population.complete).toBe(false);
        rmSync(join(root, replacementName)); writeFileSync(join(root, batch.name), batch.bytes);
        rmSync(join(root, batch.name));
        try { expect(readNativeProcessTraceArtifacts(out).population.complete).toBe(false); }
        catch (error) { expect(String(error)).toContain('batch sequence incomplete'); }
        writeFileSync(join(root, batch.name), batch.bytes);
        const exited = originals.find(({ bytes }) => JSON.parse(bytes.toString()).event === 'node-exit')!;
        rmSync(join(root, exited.name));
        expect(readNativeProcessTraceArtifacts(out).population.complete).toBe(false);
        writeFileSync(join(root, exited.name), exited.bytes);
        const terminal = originals.find(({ bytes }) => JSON.parse(bytes.toString()).event === 'module-census-end')!;
        rmSync(join(root, terminal.name));
        expect(readNativeProcessTraceArtifacts(out).population.complete).toBe(false);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

  it.each(['SIGKILL', 9, 'external'] as const)(
    'binds a self-kill census only to the independently observed native termination (%s)', mode => {
      const dir = mkdtempSync(join(tmpdir(), 'native-loader-self-kill-'));
      const out = join(dir, 'sources.json');
      const source = `import { spawnSync } from 'node:child_process';
        await import('node:fs');
        process.stdout.write('imports completed');
        ${mode === 'external' ? "spawnSync('/bin/kill', ['-KILL', String(process.pid)]);" :
          `process.kill(process.pid, ${JSON.stringify(mode)});`}`;
      try {
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
          env: nativeProcessTraceEnv({ ...process.env, NODE_OPTIONS: '',
            PC_EXECUTED_SOURCE_MAP_OUT: out, PAPERCUSP_TEST_STARTUP_TRACE: '0',
          }, { loaderCensus: { batches: 128, bytes: 16 * 1024 ** 2 } }),
          encoding: 'utf8', timeout: 10_000,
        });
        expect(result.error, result.stderr).toBeUndefined();
        expect(result.stdout).toBe('imports completed');
        expect(result.status).toBeNull();
        expect(result.signal).toBe('SIGKILL');
        const unbound = readNativeProcessTraceArtifacts(out);
        expect(unbound.population.complete).toBe(false);
        const entry = unbound.rows.find(({ row }: any) => row.event === 'node-entry')!.row;
        const terminal = { pid: entry.pid, kernelProcessIdentity: entry.kernelProcessIdentity,
          code: result.status, signal: result.signal };
        const read = (termination = terminal) => readNativeProcessTraceArtifacts(out, 0,
          Number.MAX_SAFE_INTEGER, { terminations: [termination] });
        if (mode === 'external') {
          expect(unbound.rows.filter(({ row }: any) => row.event === 'node-self-kill-request')).toEqual([]);
          expect(read().population.complete).toBe(false);
          return;
        }
        expect(unbound.population.truncatedBy).toBe('module-census-terminal-unverified');
        expect(read().population.complete).toBe(true);
        expect(read({ ...terminal, pid: terminal.pid + 1 }).population.complete).toBe(false);
        expect(read({ ...terminal, kernelProcessIdentity: 'wrong-process' }).population.complete).toBe(false);
        expect(read({ ...terminal, signal: 'SIGTERM' }).population.complete).toBe(false);
        expect(read({ ...terminal, code: 0 }).population.complete).toBe(false);
        expect(unbound.rows.filter(({ row }: any) => row.event === 'node-exit')).toEqual([]);
        const request = unbound.rows.find(({ row }: any) => row.event === 'node-self-kill-request')!.row;
        const seal = unbound.rows.find(({ row }: any) => row.event === 'module-census-end')!.row;
        expect(seal.termination).toEqual(request.termination);
        const root = `${out}.native-processes`;
        const requestBytes = Buffer.from(JSON.stringify(request));
        rmSync(join(root, createHash('sha256').update(requestBytes).digest('hex') + '.json'));
        expect(read().population.complete).toBe(false);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

  it('keeps an unsealed sibling worker incomplete despite a verified main self-kill seal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-loader-worker-self-kill-'));
    const out = join(dir, 'sources.json'), workerPath = join(dir, 'worker.mjs');
    writeFileSync(workerPath, `import { parentPort } from 'node:worker_threads';
      parentPort.postMessage('ready'); setInterval(() => {}, 1000);`);
    try {
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import { Worker } from 'node:worker_threads';
        import { once } from 'node:events';
        const worker = new Worker(${JSON.stringify(workerPath)}, { execArgv: [] });
        await once(worker, 'message'); process.kill(process.pid, 'SIGKILL');`], {
        env: nativeProcessTraceEnv({ ...process.env, NODE_OPTIONS: '',
          PC_EXECUTED_SOURCE_MAP_OUT: out, PAPERCUSP_TEST_STARTUP_TRACE: '0',
        }, { loaderCensus: { batches: 128, bytes: 16 * 1024 ** 2 } }),
        encoding: 'utf8', timeout: 10_000,
      });
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status).toBeNull();
      expect(result.signal).toBe('SIGKILL');
      const initial = readNativeProcessTraceArtifacts(out);
      const entries = initial.rows.filter(({ row }: any) => row.event === 'node-entry');
      const main = entries.find(({ row }: any) => row.threadId === 0)!.row;
      const worker = entries.find(({ row }: any) => row.threadId > 0)!.row;
      expect(worker.pid).toBe(main.pid);
      expect(worker.kernelProcessIdentity).toBe(main.kernelProcessIdentity);
      expect(worker.processIdentity).not.toBe(main.processIdentity);
      const observed = readNativeProcessTraceArtifacts(out, 0, Number.MAX_SAFE_INTEGER, {
        terminations: [{ pid: result.pid, kernelProcessIdentity: main.kernelProcessIdentity,
          code: result.status, signal: result.signal }],
      });
      expect(observed.rows.filter(({ row }: any) => row.event === 'module-census-end'
        && row.processIdentity === main.processIdentity)).toHaveLength(1);
      expect(observed.rows.filter(({ row }: any) => row.event === 'module-census-end'
        && row.processIdentity === worker.processIdentity)).toHaveLength(0);
      expect(observed.population).toMatchObject({ complete: false, truncatedBy: 'module-census-incomplete' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('rejects an unbounded loader census before launch', () => {
    for (const loaderCensus of [{ events: 8193, bytes: 1024 }, { events: 2, bytes: 16 * 1024 ** 2 + 1 },
      { events: 1, bytes: 1024 }, { events: 2, bytes: 1023 },
      { batches: 0, bytes: 1024 }, { batches: 1025, bytes: 1024 }, { batches: 1, events: 2, bytes: 1024 }]) {
      expect(() => nativeProcessTraceEnv({ PC_EXECUTED_SOURCE_MAP_OUT: '/tmp/unused-census.json' }, { loaderCensus }))
        .toThrow('Invalid bounded native loader census');
    }
    const loaderCensus = { events: 8192, bytes: 16 * 1024 ** 2 };
    const env = nativeProcessTraceEnv({ PC_EXECUTED_SOURCE_MAP_OUT: '/tmp/unused-census.json' }, { loaderCensus });
    expect(JSON.parse(env.PC_NATIVE_LOADER_CENSUS!)).toEqual(loaderCensus);
  });

  it('bounds load evidence while allowing the complete module population to execute', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-module-bound-'));
    const out = join(dir, 'sources.json');
    const preload = new URL('../../../../scripts/lib/vitest-startup-trace.mjs?module-load-bound', import.meta.url).href;
    const modules = Array.from({ length: 140 }, (_, index) => {
      const path = join(dir, `module-${index}.mjs`);
      writeFileSync(path, `export const value = ${index};`);
      return pathToFileURL(path).href;
    });
    const env: NodeJS.ProcessEnv = { ...process.env, PAPERCUSP_TEST_STARTUP_TRACE: '0',
      PAPERCUSP_TEST_RUN_GROUP: 'trace-limit-original-run' };
    delete env.PC_EXECUTED_SOURCE_MAP_OUT;
    try {
      const source = `process.env.PC_EXECUTED_SOURCE_MAP_OUT = ${JSON.stringify(out)};
        await import(${JSON.stringify(preload)});
        process.env.PAPERCUSP_TEST_RUN_GROUP = 'changed-after-entry';
        const { spawnSync } = await import('node:child_process');
        const child = spawnSync(process.execPath, ['-e', '', 'x'.repeat(70 * 1024), 'y'.repeat(70 * 1024)], {
          env: { ...process.env, NODE_OPTIONS: '', PC_EXECUTED_SOURCE_MAP_OUT: '' },
          encoding: 'utf8', timeout: 5000,
        });
        if (child.status !== 0) throw new Error(child.stderr || String(child.error));
        let sum = 0;
        for (const url of ${JSON.stringify(modules)}) sum += (await import(url)).value;
        const { channel } = await import('node:diagnostics_channel');
        for (let index = 0; index < 200; index++)
          channel('papercusp:api-worker-schema').publish({ unavailable: true });
        process.stdout.write(String(sum));`;
      const { stdout, stderr } = await promisify(execFile)(process.execPath,
        ['--input-type=module', '-e', source], { env, timeout: 10_000 });
      expect(stdout).toBe('9730');
      expect(stderr).toBe('');
      const rows = readdirSync(`${out}.native-processes`).filter(name => name.endsWith('.json')).map(name =>
        JSON.parse(readFileSync(join(`${out}.native-processes`, name), 'utf8')));
      const starts = rows.filter(row => row.event === 'module-load-start');
      expect(starts.length).toBeGreaterThan(0);
      expect(starts.length).toBeLessThanOrEqual(128);
      expect(rows.filter(row => row.event === 'module-load-limit')).toHaveLength(1);
      expect(rows.filter(row => row.event === 'trace-limit').map(row => row.observationScope).sort())
        .toEqual(['general', 'module']);
      expect(rows.filter(row => row.event === 'trace-event-too-large')).toEqual([
        expect.objectContaining({ omittedEvent: 'child-spawn-sync-start', runGroupId: 'trace-limit-original-run' }),
      ]);
      expect(rows.every(row => row.runGroupId === 'trace-limit-original-run')).toBe(true);
      expect(rows.filter(row => row.event.startsWith('module-') &&
        !['module-load-limit', 'module-resolve-limit'].includes(row.event)).length).toBeLessThanOrEqual(384);
      expect(rows.filter(row => row.event === 'api-worker-schema-unavailable').length).toBeLessThanOrEqual(128);
      expect(rows.find(row => row.event === 'node-exit')).toMatchObject({ code: 0 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each(['SIGTERM', 'SIGINT', 'application-kill', 'application-exit', 'SIGKILL'] as const)(
    'retains a scoped engine snapshot at a signal or self-kill request without changing %s', mode => {
      const dir = mkdtempSync(join(tmpdir(), 'native-engine-signal-'));
      const out = join(dir, 'sources.json'), main = join(dir, 'main.mjs');
      const signal = mode === 'SIGINT' || mode === 'SIGKILL' ? mode : 'SIGTERM';
      const source = `globalThis.__nativeSignalMarker = 42;
        ${mode === 'application-kill' ? "process.once('SIGTERM', () => process.kill(process.pid, 'SIGKILL'));" : ''}
        ${mode === 'application-exit' ? "process.once('SIGTERM', () => process.exit(23));" : ''}
        setImmediate(() => process.kill(process.pid, ${JSON.stringify(signal)}));
        setInterval(() => {}, 1000);`;
      writeFileSync(main, source);
      try {
        const result = spawnSync(process.execPath, [main], {
          env: nativeProcessTraceEnv({ ...process.env, NODE_OPTIONS: '',
            PC_EXECUTED_SOURCE_MAP_OUT: out, PAPERCUSP_TEST_STARTUP_TRACE: '0' }, {
            pinnedSources: [{ path: main, sha256: createHash('sha256').update(source).digest('hex'),
              byteLength: Buffer.byteLength(source) }],
          }), encoding: 'utf8', timeout: 10_000,
        });
        expect(result.error, result.stderr).toBeUndefined();
        expect(result.status).toBe(mode === 'application-exit' ? 23 : null);
        expect(result.signal).toBe(mode === 'application-exit' ? null :
          mode === 'application-kill' ? 'SIGKILL' : signal);
        const rows = readdirSync(`${out}.native-processes`).filter(name => name.endsWith('.json')).map(name =>
          JSON.parse(readFileSync(join(`${out}.native-processes`, name), 'utf8')));
        const snapshots = rows.filter(row => row.event === 'engine-script-execution');
        if (mode === 'SIGKILL') {
          expect(snapshots).toEqual([expect.objectContaining({
            termination: expect.objectContaining({ phase: 'self-kill-request', signal: 'SIGKILL' }),
          })]);
        }
        else {
          const snapshot = snapshots.find(row => row.termination?.phase === 'signal');
          expect(snapshot).toMatchObject({ threadId: 0,
            termination: { phase: 'signal', signal, exitCode: null },
            observation: { populationStatus: 'unknown' } });
          expect(snapshot.observation.scripts).toContainEqual(expect.objectContaining({
            path: main, execution: 'observed', sourceTextSha256: createHash('sha256').update(source).digest('hex'),
          }));
        }
        expect(rows.filter(row => row.event === 'node-exit')).toHaveLength(mode === 'application-exit' ? 1 : 0);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

  it('retains complete pinned engine ranges beyond the event bound and authenticates their attachment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-engine-ranges-'));
    const out = join(dir, 'sources.json'), main = join(dir, 'main.mjs');
    // V8 best-effort coverage can omit one-shot straight-line callee counters.
    // Warm each call site so the late-range assertion has a positive entry
    // control, while untouched_suffix remains the zero-entry control.
    const source = Array.from({ length: 2000 }, (_, index) =>
      `function retained_${index}() { return ${index}; } for (let call = 0; call < 16; call++) retained_${index}();`).join('\n') +
      '\nfunction untouched_suffix() { return 7; } console.log("complete");';
    writeFileSync(main, source);
    try {
      const result = spawnSync(process.execPath, [main], {
        env: nativeProcessTraceEnv({ ...process.env, NODE_OPTIONS: '',
          PC_EXECUTED_SOURCE_MAP_OUT: out, PAPERCUSP_TEST_STARTUP_TRACE: '0' }, {
          pinnedSources: [{ path: main, sha256: createHash('sha256').update(source).digest('hex'),
            byteLength: Buffer.byteLength(source) }],
        }), encoding: 'utf8', timeout: 10_000,
      });
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('complete\n');
      const trace = readNativeProcessTraceArtifacts(out);
      const snapshot = trace.rows.find(({ row }: any) => row.event === 'engine-script-execution')!.row;
      expect(snapshot.observationArtifact.byteLength).toBeGreaterThan(128 * 1024);
      const observed = snapshot.observation.scripts.find((row: any) => row.path === main);
      expect(observed).toMatchObject({ execution: 'observed', coverageRangesComplete: true,
        sourceTextSha256: createHash('sha256').update(source).digest('hex') });
      expect(observed.coverageRanges).toContainEqual(expect.objectContaining({ functionName: 'retained_1999', count: 1 }));
      expect(observed.coverageRanges).toContainEqual(expect.objectContaining({ functionName: 'untouched_suffix', count: 0 }));
      expect(snapshot.observation.populationStatus).toBe('unknown');
      expect(trace.rows.some(({ row }: any) => row.event === 'trace-event-too-large')).toBe(false);
      const attachment = join(`${out}.native-processes`, snapshot.observationArtifact.ref);
      const original = readFileSync(attachment);
      writeFileSync(attachment, Buffer.from(original.map((value, index) => index === 0 ? 32 : value)));
      expect(() => readNativeProcessTraceArtifacts(out)).toThrow('native engine observation hash mismatch');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('retains an independently enrolled late source after the generic observation budget is exhausted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-late-pin-'));
    const out = join(dir, 'sources.json'), pinned = join(dir, 'pinned.mjs');
    const source = 'export const value = 777;';
    const modules = Array.from({ length: 140 }, (_, index) => {
      const path = join(dir, `generic-${index}.mjs`);
      writeFileSync(path, `export const value = ${index};`);
      return pathToFileURL(path).href;
    });
    writeFileSync(pinned, source);
    const preload = new URL('../../../../scripts/lib/vitest-startup-trace.mjs?late-pin', import.meta.url).href;
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: '', PAPERCUSP_TEST_STARTUP_TRACE: '0' };
    delete env.PC_EXECUTED_SOURCE_MAP_OUT;
    try {
      const script = `process.env.PC_EXECUTED_SOURCE_MAP_OUT = ${JSON.stringify(out)};
        process.env.PC_NATIVE_LOADER_SOURCE_PINS = ${JSON.stringify(JSON.stringify([{
          path: pinned, sha256: createHash('sha256').update(source).digest('hex'), byteLength: Buffer.byteLength(source),
        }]))};
        await import(${JSON.stringify(preload)});
        for (const url of ${JSON.stringify(modules)}) await import(url);
        process.stdout.write(String((await import(${JSON.stringify(pathToFileURL(pinned).href)})).value));`;
      const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
        env, timeout: 10_000,
      });
      expect(result.stdout).toBe('777');
      expect(result.stderr).toBe('');
      const rows = readdirSync(`${out}.native-processes`).filter(name => name.endsWith('.json')).map(name =>
        JSON.parse(readFileSync(join(`${out}.native-processes`, name), 'utf8')));
      expect(rows.filter(row => row.event === 'module-load-limit')).toHaveLength(1);
      expect(rows.filter(row => row.event === 'module-load-start' && row.url !== pathToFileURL(pinned).href).length)
        .toBeLessThanOrEqual(128);
      const loaded = rows.find(row => row.event === 'module-load-return' && row.url === pathToFileURL(pinned).href);
      expect(loaded).toMatchObject({ source: { status: 'hashed',
        sha256: createHash('sha256').update(source).digest('hex'), byteLength: Buffer.byteLength(source) } });
      expect(readFileSync(join(`${out}.native-processes`, loaded.source.ref), 'utf8')).toBe(source);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each([false, true])('retains actual npm lifecycle and compound-script Node entries, failure=%s', async fail => {
    const dir = mkdtempSync(join(tmpdir(), 'native-npm-process-'));
    const out = join(dir, 'sources.json');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'native-process-fixture', scripts: {
      pretest: 'node pre.cjs', test: 'node first.cjs && node second.cjs', posttest: 'node post.cjs',
    } }));
    for (const name of ['pre', 'first', 'second', 'post']) {
      writeFileSync(join(dir, `${name}.cjs`), `process.stdout.write(${JSON.stringify(name + '\n')});` +
        (fail && name === 'second' ? 'process.exitCode = 7;' : ''));
    }
    try {
      const env = nativeProcessTraceEnv({ ...process.env, PC_EXECUTED_SOURCE_MAP_OUT: out,
        PAPERCUSP_TEST_STARTUP_TRACE: '0' });
      let stdout = '', stderr = '', code = 0;
      try { ({ stdout, stderr } = await promisify(execFile)('npm', ['run', '--silent', 'test'], {
        cwd: dir, env, timeout: 15_000,
      })); } catch (error: any) { stdout = error.stdout; stderr = error.stderr; code = error.code; }
      expect(code).toBe(fail ? 7 : 0);
      expect(stdout).toBe(fail ? 'pre\nfirst\nsecond\n' : 'pre\nfirst\nsecond\npost\n');
      expect(stderr).toBe('');
      const rows = readdirSync(`${out}.native-processes`).filter(name => name.endsWith('.json')).map(name =>
        JSON.parse(readFileSync(join(`${out}.native-processes`, name), 'utf8')));
      const leaves = rows.filter(row => row.event === 'node-entry' && row.argv[1]?.endsWith('.cjs'))
        .sort((a, b) => a.atMs - b.atMs);
      expect(leaves.map(row => row.argv[1].slice(dir.length + 1))).toEqual(
        fail ? ['pre.cjs', 'first.cjs', 'second.cjs'] : ['pre.cjs', 'first.cjs', 'second.cjs', 'post.cjs']);
      expect(leaves.map(row => row.lifecycle.event)).toEqual(fail ? ['pretest', 'test', 'test'] :
        ['pretest', 'test', 'test', 'posttest']);
      for (const leaf of leaves) {
        const exit = rows.find(row => row.event === 'node-exit' && row.processIdentity === leaf.processIdentity);
        expect(exit).toMatchObject({ code: fail && leaf.argv[1].endsWith('second.cjs') ? 7 : 0 });
        const expected = leaf.argv[1].slice(dir.length + 1).replace('.cjs', '\n');
        expect(exit.streams.stdout).toMatchObject({ scope: 'node-writable-call-inputs',
          byteLength: Buffer.byteLength(expected), captureComplete: true });
        expect(readFileSync(join(`${out}.native-processes`, exit.streams.stdout.ref), 'utf8')).toBe(expected);
        expect(exit.streams.stderr).toMatchObject({ byteLength: 0, captureComplete: true });
      }
      expect(rows.filter(row => row.event === 'child-spawn').map(row => row.lifecycle.script))
        .toEqual(expect.arrayContaining(['node pre.cjs', 'node first.cjs && node second.cjs']));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 25_000);

  it('records exit entry before a blocked listener without claiming completion', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-blocked-exit-'));
    const out = join(dir, 'sources.json');
    try {
      let entered = false, output = '';
      await new Promise<void>((resolve, reject) => {
        const child = execFile(process.execPath, ['-e',
          "process.on('exit', () => { process.stdout.write('EXIT_LISTENER_ENTERED'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); }); process.exitCode = 3;"], {
          env: nativeProcessTraceEnv({ ...process.env, PC_EXECUTED_SOURCE_MAP_OUT: out,
            PAPERCUSP_TEST_STARTUP_TRACE: '0' }), timeout: 10_000, killSignal: 'SIGKILL',
        }, error => {
          if (entered && error?.signal === 'SIGKILL') resolve();
          else reject(error ?? new Error('blocked exit listener unexpectedly returned'));
        });
        createTextCollector(child.stdout, { retainText: false, onDecodedText: text => {
          output += text;
          if (output.includes('EXIT_LISTENER_ENTERED')) { entered = true; child.kill('SIGKILL'); }
        } });
      });
      expect(entered).toBe(true);
      const rows = readdirSync(`${out}.native-processes`).filter(name => name.endsWith('.json')).map(name => {
        const bytes = readFileSync(join(`${out}.native-processes`, name));
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(name.slice(0, 64));
        return JSON.parse(bytes.toString('utf8'));
      });
      const entry = rows.find(row => row.event === 'node-entry');
      expect(rows.filter(row => row.event === 'node-exit-start')).toEqual([
        expect.objectContaining({ pid: entry.pid, processIdentity: entry.processIdentity, code: 3 }),
      ]);
      expect(rows.filter(row => row.event === 'node-exit')).toHaveLength(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('retains binary and encoded Writable inputs without changing native output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-binary-streams-'));
    const out = join(dir, 'sources.json');
    try {
      const { stdout, stderr } = await promisify(execFile)(process.execPath, ['-e',
        "process.stdout.write(Buffer.from([0,255,10])); process.stdout.write('ff00','hex'); process.stderr.write(new Uint8Array([254,13,10])); process.on('exit',()=>process.stdout.write('late'));"], {
        env: nativeProcessTraceEnv({ ...process.env, PC_EXECUTED_SOURCE_MAP_OUT: out,
          PAPERCUSP_TEST_STARTUP_TRACE: '0' }), encoding: 'buffer', timeout: 10_000,
      });
      const rows = readdirSync(`${out}.native-processes`).filter(name => name.endsWith('.json')).map(name =>
        JSON.parse(readFileSync(join(`${out}.native-processes`, name), 'utf8')));
      const exit = rows.find(row => row.event === 'node-exit');
      const exitStart = rows.find(row => row.event === 'node-exit-start');
      expect(exitStart).toMatchObject({ pid: exit.pid, processIdentity: exit.processIdentity, code: 0 });
      expect(exitStart.atMs).toBeLessThanOrEqual(exit.atMs);
      expect(stdout).toEqual(Buffer.from([0,255,10,255,0,108,97,116,101]));
      expect(stderr).toEqual(Buffer.from([254,13,10]));
      for (const role of ['stdout','stderr']) expect(readFileSync(join(`${out}.native-processes`,
        exit.streams[role].ref))).toEqual(role === 'stdout' ? stdout : stderr);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('delegates write receiver, callback, return and thrown error unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-write-contract-'));
    const out = join(dir, 'sources.json');
    const preload = new URL('../../../../scripts/lib/vitest-startup-trace.mjs?native-write-contract', import.meta.url).href;
    try {
      const source = `const native = process.stdout.write; const callback = () => {}; const error = new Error('original');
        const calls = []; process.stdout.write = function(...args) {
          calls.push({receiver:this === process.stdout, chunk:args[0], encoding:args[1], callback:args[2] === callback});
          if (args[0] === 'throw') throw error; return false;
        };
        process.env.PC_EXECUTED_SOURCE_MAP_OUT = ${JSON.stringify(out)};
        await import(${JSON.stringify(preload)});
        const returned = process.stdout.write('accepted','utf8',callback) === false;
        process.stdout.write.call({},'other','utf8',callback);
        let sameError = false; try { process.stdout.write('throw','utf8',callback); } catch (caught) { sameError = caught === error; }
        native.call(process.stdout,JSON.stringify({returned,sameError,calls}));`;
      const env: Record<string, string> = { ...process.env, PAPERCUSP_TEST_STARTUP_TRACE: '0' } as Record<string, string>;
      delete env.PC_EXECUTED_SOURCE_MAP_OUT;
      const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], {
        env, timeout: 10_000,
      });
      expect(JSON.parse(stdout)).toEqual({ returned: true, sameError: true, calls: [
        {receiver:true,chunk:'accepted',encoding:'utf8',callback:true},
        {receiver:false,chunk:'other',encoding:'utf8',callback:true},
        {receiver:true,chunk:'throw',encoding:'utf8',callback:true},
      ] });
      const exits = readdirSync(`${out}.native-processes`).filter(name => name.endsWith('.json')).map(name =>
        JSON.parse(readFileSync(join(`${out}.native-processes`, name), 'utf8'))).filter(row => row.event === 'node-exit');
      expect(exits).toHaveLength(1);
      expect(readFileSync(join(`${out}.native-processes`, exits[0].streams.stdout.ref), 'utf8')).toBe('accepted');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('retains synchronous subprocess success and timeout without inventing child entry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-sync-child-'));
    const out = join(dir, 'sources.json');
    const stall = join(dir, 'stall.cjs');
    writeFileSync(stall, 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000);');
    try {
      const source = `const cp=require('node:child_process');
        const success=cp.spawnSync(process.execPath,['-e',"process.stdout.write('ok')"],{encoding:'utf8'});
        const timeout=cp.spawnSync(process.execPath,['--require',${JSON.stringify(stall)},'-e',''],{timeout:300});
        process.stdout.write(JSON.stringify({success:{pid:success.pid,status:success.status,stdout:success.stdout},
          timeout:{pid:timeout.pid,status:timeout.status,signal:timeout.signal,errorCode:timeout.error?.code}}));`;
      const { stdout } = await promisify(execFile)(process.execPath, ['-e', source], {
        env: nativeProcessTraceEnv({ ...process.env, PC_EXECUTED_SOURCE_MAP_OUT: out,
          PAPERCUSP_TEST_STARTUP_TRACE: '0' }), timeout: 15_000,
      });
      const result = JSON.parse(stdout);
      expect(result.success).toMatchObject({ status: 0, stdout: 'ok' });
      expect(result.timeout).toMatchObject({ status: null, signal: 'SIGTERM', errorCode: 'ETIMEDOUT' });
      const rows = readdirSync(`${out}.native-processes`).filter(name => name.endsWith('.json')).map(name =>
        JSON.parse(readFileSync(join(`${out}.native-processes`, name), 'utf8')));
      const starts = rows.filter(row => row.event === 'child-spawn-sync-start');
      expect(starts).toHaveLength(2);
      for (const [index, native] of [result.success, result.timeout].entries()) {
        const start = starts.find(row => index === 0 ? row.argv[0] === '-e' : row.argv[0] === '--require');
        const end = rows.find(row => row.event === 'child-spawn-sync-return' && row.childIdentity === start.childIdentity);
        expect(end).toMatchObject({ pid: start.pid, processIdentity: start.processIdentity,
          childPid: native.pid, code: native.status, signal: native.signal ?? null, errorCode: native.errorCode ?? null });
        expect(end.atMs).toBeGreaterThanOrEqual(start.atMs);
        expect(end.elapsedMs).toBeGreaterThanOrEqual(0);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each(['plain', 'getter', 'proxy'])('delegates synchronous subprocess receiver, arguments, result and thrown %s error unchanged', async errorKind => {
    const dir = mkdtempSync(join(tmpdir(), 'native-sync-contract-'));
    const out = join(dir, 'sources.json');
    const preload = new URL('../../../../scripts/lib/vitest-startup-trace.mjs?sync-contract', import.meta.url).href;
    try {
      const source = `import cp from 'node:child_process';
        const receiver={}, argv=['argument'], options={timeout:123}, nativeError=new Error('native');
        let getterCalls=0;
        const error=${JSON.stringify(errorKind)}==='proxy' ? new Proxy(nativeError,{
          getOwnPropertyDescriptor(){throw new Error('observation trap');}
        }) : nativeError;
        if(${JSON.stringify(errorKind)}==='getter')Object.defineProperty(error,'code',{
          get(){getterCalls++;throw new Error('observation getter');}
        });
        const result={pid:321,status:null,signal:'SIGTERM',error:{code:'ETIMEDOUT'}}, calls=[];
        cp.spawnSync=function(...args){calls.push({receiver:this===receiver,command:args[0],argv:args[1]===argv,options:args[2]===options});
          if(args[0]==='throw')throw error;return result;};
        process.env.PC_EXECUTED_SOURCE_MAP_OUT=${JSON.stringify(out)};
        await import(${JSON.stringify(preload)});
        const sameResult=cp.spawnSync.call(receiver,'probe',argv,options)===result;
        let sameError=false;try{cp.spawnSync.call(receiver,'throw',argv,options);}catch(caught){sameError=caught===error;}
        process.stdout.write(JSON.stringify({sameResult,sameError,getterCalls,calls}));`;
      const env: NodeJS.ProcessEnv = { ...process.env, PAPERCUSP_TEST_STARTUP_TRACE: '0' };
      delete env.PC_EXECUTED_SOURCE_MAP_OUT;
      const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], { env, timeout: 10_000 });
      expect(JSON.parse(stdout)).toEqual({ sameResult: true, sameError: true, getterCalls: 0, calls: [
        { receiver: true, command: 'probe', argv: true, options: true },
        { receiver: true, command: 'throw', argv: true, options: true },
      ] });
      const rows = readdirSync(`${out}.native-processes`).filter(name => name.endsWith('.json')).map(name =>
        JSON.parse(readFileSync(join(`${out}.native-processes`, name), 'utf8')));
      const thrown = rows.find(row => row.event === 'child-spawn-sync-start' && row.command === 'throw');
      expect(rows.find(row => row.event === 'child-spawn-sync-error' && row.childIdentity === thrown.childIdentity))
        .toMatchObject({ errorCode: null, pid: thrown.pid, processIdentity: thrown.processIdentity });
      expect(rows.some(row => row.event === 'child-spawn-sync-return' && row.childIdentity === thrown.childIdentity)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('marks the stream bound explicitly while leaving the full native write intact', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-write-bound-'));
    const out = join(dir, 'sources.json');
    try {
      const { stdout } = await promisify(execFile)(process.execPath, ['-e',
        'process.stdout.write(Buffer.alloc(16 * 1024 * 1024 + 1, 65));'], {
        env: nativeProcessTraceEnv({ ...process.env, PC_EXECUTED_SOURCE_MAP_OUT: out,
          PAPERCUSP_TEST_STARTUP_TRACE: '0' }), encoding: 'buffer', maxBuffer: 20 * 1024 * 1024, timeout: 10_000,
      });
      expect(stdout.length).toBe(16 * 1024 * 1024 + 1);
      const rows = readdirSync(`${out}.native-processes`).filter(name => name.endsWith('.json')).map(name =>
        JSON.parse(readFileSync(join(`${out}.native-processes`, name), 'utf8')));
      const pin = rows.find(row => row.event === 'node-exit').streams.stdout;
      expect(pin).toMatchObject({ captureComplete: false, observedByteLength: stdout.length, byteLength: 16 * 1024 * 1024 });
      // Compare bytes directly: generic deep equality enumerates a 16 MiB Buffer
      // as millions of properties and can exhaust the test's own deadline.
      expect(readFileSync(join(`${out}.native-processes`, pin.ref)).equals(stdout.subarray(0, pin.byteLength))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps native output and exit status when the evidence directory is unavailable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-process-unavailable-'));
    const out = join(dir, 'sources.json');
    writeFileSync(`${out}.native-processes`, 'not a directory');
    try {
      const env = nativeProcessTraceEnv({ ...process.env, PC_EXECUTED_SOURCE_MAP_OUT: out,
        PAPERCUSP_TEST_STARTUP_TRACE: '0' });
      const result = await promisify(execFile)(process.execPath, ['-e',
        "process.stdout.write('native stdout'); process.stderr.write('native stderr');"], {
        env, timeout: 10_000,
      });
      expect(result).toMatchObject({ stdout: 'native stdout', stderr: 'native stderr' });
      expect(readFileSync(`${out}.native-processes`, 'utf8')).toBe('not a directory');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('retains diagnostics by default and preserves inherited options without exposing values', () => {
    const env = { NODE_OPTIONS: '--import=https://secret:password@example.test/private --require=/private/key' };
    const enabled = startupTraceEnv(env);
    expect(enabled.PAPERCUSP_TEST_STARTUP_TRACE).toBe('1');
    expect(enabled.NODE_OPTIONS).toContain(env.NODE_OPTIONS);
    expect(enabled.NODE_OPTIONS).toContain('vitest-startup-trace.mjs');
    expect(startupTraceEnv(enabled).NODE_OPTIONS).toBe(enabled.NODE_OPTIONS);
    const disabled = { ...env, PAPERCUSP_TEST_STARTUP_TRACE: '0' };
    expect(startupTraceEnv(disabled)).toBe(disabled);
    const identity = loaderIdentity(env.NODE_OPTIONS);
    expect(identity.switches).toEqual(['--import', '--require']);
    expect(identity.sha256).toHaveLength(64);
    expect(JSON.stringify(identity)).not.toMatch(/secret|password|private|example/);
  });

  it('leaves ordinary inherited Node children and grandchildren output untouched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vitest-ordinary-child-'));
    const ordinary = join(dir, 'ordinary.cjs');
    const leaf = "process.stdout.write('abc'); process.stderr.write('xyz');";
    writeFileSync(ordinary, leaf);
    const branch = `const { spawnSync } = require('node:child_process');
      const child = spawnSync(process.execPath, ['-e', ${JSON.stringify(leaf)}], { encoding: 'utf8' });
      process.stdout.write(JSON.stringify({ stdout: child.stdout, stderr: child.stderr, status: child.status }));`;
    const root = `const { spawnSync } = require('node:child_process');
      const direct = spawnSync(process.execPath, [${JSON.stringify(ordinary)}], { encoding: 'utf8' });
      const branch = spawnSync(process.execPath, ['-e', ${JSON.stringify(branch)}], { encoding: 'utf8' });
      process.stdout.write(JSON.stringify({
        direct: { stdout: direct.stdout, stderr: direct.stderr, status: direct.status },
        nested: JSON.parse(branch.stdout), branchStderr: branch.stderr, branchStatus: branch.status,
      }));`;
    const env = startupTraceEnv({ ...process.env, PAPERCUSP_TEST_STARTUP_TRACE: undefined });
    try {
      const { stdout, stderr } = await promisify(execFile)(process.execPath, ['-e', root], { env, timeout: 10_000 });
      expect(JSON.parse(stdout)).toEqual({
        direct: { stdout: 'abc', stderr: 'xyz', status: 0 },
        nested: { stdout: 'abc', stderr: 'xyz', status: 0 },
        branchStderr: '', branchStatus: 0,
      });
      expect(stderr).toContain('TEST_FILE_STARTUP_TRACE ');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('captures the real preload and fork handshake without an opt-in switch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vitest-startup-preload-'));
    const worker = join(dir, 'vitest', 'dist', 'workers', 'forks.js');
    mkdirSync(join(dir, 'vitest', 'dist', 'workers'), { recursive: true });
    const parent = join(dir, 'parent.cjs');
    writeFileSync(worker, `process.on('message', message => {
      if (message.type === 'start') process.send({ type: 'started' });
      if (message.type === 'stop') process.send({ type: 'stopped' }, () => process.disconnect());
    });`);
    writeFileSync(parent, `const { fork } = require('node:child_process');
      const child = fork(${JSON.stringify(worker)}, { execArgv: [] });
      child.on('message', message => {
        if (message.type === 'started') child.send({ type: 'stop' });
      });
      child.send({ type: 'start', config: { secret: 'never-log' } });`);
    let completed = false;
    try {
      const env = startupTraceEnv({ ...process.env, PAPERCUSP_TEST_STARTUP_TRACE: undefined });
      const { stderr } = await promisify(execFile)(process.execPath, [parent], { env, timeout: 10_000 });
      const rows = stderr.split('\n').filter(line => line.startsWith('TEST_FILE_STARTUP_TRACE '))
        .map(line => JSON.parse(line.slice('TEST_FILE_STARTUP_TRACE '.length)));
      expect(rows.map(row => row.event)).toEqual(expect.arrayContaining([
        'node-loaded', 'worker-forked', 'start-sent', 'started-received',
        'stop-sent', 'stopped-received', 'worker-exit', 'worker-close',
      ]));
      const workerPid = rows.find(row => row.event === 'worker-forked')?.childPid;
      expect(rows.filter(row => row.event === 'node-loaded')).toHaveLength(2);
      expect(rows.some(row => row.event === 'node-loaded' && row.pid === workerPid)).toBe(true);
      expect(rows.find(row => row.event === 'started-received')).toMatchObject({ error: false });
      expect(stderr).not.toContain('never-log');
      completed = true;
    } catch (error) {
      retainNativeStartupFailure(dir, error);
      throw error;
    } finally {
      if (completed) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('observes the real start/started exchange without changing send semantics', () => {
    const child = new EventEmitter() as any;
    child.pid = 42;
    const calls: unknown[] = [];
    const rows: any[] = [];
    let clock = 100;
    const original = child.send = function(...args: unknown[]) { calls.push(args); return false; };
    observeForkStartup(child, row => rows.push(row), () => clock);
    const payload = { type: 'start', config: { secret: 'never-log' } };
    expect(child.send(payload, 'callback-placeholder')).toBe(false);
    clock = 279;
    child.emit('message', { type: 'rpc', secret: 'never-log' });
    child.emit('message', { type: 'started', error: null });
    child.emit('message', { type: 'started', error: null });
    child.emit('exit', 0, null);
    child.emit('close');
    expect(calls).toEqual([[payload, 'callback-placeholder']]);
    expect(rows.map(row => row.event)).toEqual(['start-sent', 'started-received', 'worker-exit', 'worker-close']);
    expect(rows[1]).toMatchObject({ childPid: 42, startupMs: 179, error: false });
    expect(rows.every(row => row.childPid === 42)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('never-log');
    expect(child.send).toBe(original);
    expect(child.listenerCount('message')).toBe(0);
    expect(child.listenerCount('exit')).toBe(0);
    expect(child.listenerCount('close')).toBe(0);
  });

  it('reports a worker exit before the handshake and cleans up idempotently', () => {
    const child = new EventEmitter() as any;
    child.pid = 43;
    child.send = () => true;
    const rows: any[] = [];
    const stop = observeForkStartup(child, row => rows.push(row), () => 0);
    child.emit('exit', 1, null);
    expect(rows).toEqual([{ event: 'worker-exit', childPid: 43, elapsedMs: 0, code: 1, signal: null, started: false }]);
    stop(); stop();
    expect(child.eventNames()).toEqual([]);
  });

  it('distinguishes an unacknowledged stop from an acknowledged stop awaiting process exit', () => {
    const child = new EventEmitter() as any;
    child.pid = 44;
    const payloads: unknown[] = [];
    const signals: unknown[] = [];
    const originalSend = child.send = (payload: unknown) => { payloads.push(payload); return false; };
    const originalKill = child.kill = (signal: unknown) => { signals.push(signal); return true; };
    const rows: any[] = [];
    let clock = 0;
    const detach = observeForkStartup(child, row => rows.push(row), () => clock);
    const payload = { type: 'stop', otelCarrier: { secret: 'never-log' } };
    expect(child.send(payload)).toBe(false);
    expect(rows.map(row => row.event)).toEqual(['stop-sent']);
    clock = 37;
    child.emit('message', { type: 'stopped', error: { secret: 'never-log' } });
    child.emit('message', { type: 'stopped' });
    expect(rows[1]).toMatchObject({ event: 'stopped-received', stopMs: 37, error: true });
    expect(rows.some(row => row.event === 'worker-exit')).toBe(false);
    expect(child.kill('SIGTERM')).toBe(true);
    expect(signals).toEqual(['SIGTERM']);
    expect(payloads).toEqual([payload]);
    expect(rows[2]).toMatchObject({ event: 'worker-signal', signal: 'SIGTERM', sent: true });
    expect(JSON.stringify(rows)).not.toContain('never-log');
    detach();
    expect(child.send).toBe(originalSend);
    expect(child.kill).toBe(originalKill);
    expect(child.eventNames()).toEqual([]);
  });

  it('keeps IPC and termination semantics when diagnostic output throws', () => {
    const child = new EventEmitter() as any;
    child.send = () => false;
    child.kill = () => true;
    const detach = observeForkStartup(child, () => { throw new Error('unavailable output'); });
    expect(child.send({ type: 'stop' })).toBe(false);
    expect(() => child.emit('message', { type: 'stopped' })).not.toThrow();
    expect(child.kill()).toBe(true);
    detach();
  });

  it('captures the stop acknowledgement, IPC disconnect, exit and close of a real fork', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vitest-lifecycle-'));
    const fixture = join(dir, 'worker.cjs');
    writeFileSync(fixture, `process.on('message', message => {
      if (message.type === 'stop') process.send({ type: 'stopped' }, () => process.disconnect());
    });`);
    const child = fork(fixture, { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] });
    const rows: any[] = [];
    observeForkStartup(child, row => rows.push(row));
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', code => code === 0 ? resolve() : reject(new Error(`worker exited ${code}`)));
        child.send({ type: 'stop' });
      });
      expect(rows.map(row => row.event)).toEqual([
        'stop-sent', 'stopped-received', 'worker-disconnect', 'worker-exit', 'worker-close',
      ]);
      expect(rows[1]).toMatchObject({ error: false });
    } finally {
      if (child.exitCode === null) child.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
