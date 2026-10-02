// @vitest-environment node
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';

import { closeInspector, createCdpClient, readPinnedState, redactDiagnosticUrl, withFunctionCallTrace } from '../../../scripts/cdp-inspector.mjs';

class FakeWebSocket extends EventEmitter {
  static instances: FakeWebSocket[] = [];

  readyState = 1;
  closed = false;
  sent: Array<{ id: number; method: string; params: Record<string, unknown> }> = [];
  readonly url: string;
  readonly options: unknown;
  readonly responses: Map<string, unknown>;

  constructor(url: string, options: unknown, responses: Map<string, unknown>) {
    super();
    this.url = url;
    this.options = options;
    this.responses = responses;
    FakeWebSocket.instances.push(this);
  }

  send(payload: string) {
    const message = JSON.parse(payload);
    this.sent.push(message);
    const response = this.responses.get(message.method);
    if (response === 'close') {
      queueMicrotask(() => this.close());
      return;
    }
    queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({
      id: message.id,
      result: response ?? {},
    }))));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit('close');
  }
}

function makeClient(responses: Map<string, unknown>, options: Record<string, unknown> = {}) {
  class TestWebSocket extends FakeWebSocket {
    constructor(url: string, socketOptions: unknown) {
      super(url, socketOptions, responses);
    }
  }
  return createCdpClient('ws://127.0.0.1:9229/devtools/page/test', {
    WebSocketImpl: TestWebSocket,
    requestTimeoutMs: 20,
    ...options,
  });
}

describe('named pinned payload attribution on a real Node inspector', () => {
  it('reserves work for a light later root and selects exact owners independently of registry order', async () => {
    const child = spawn(process.execPath, ['--inspect=127.0.0.1:0', '--input-type=module', '-e', `
      globalThis[Symbol.for('@papercusp/module-singleton.slots')] = new Map([
        ['fixture.heavy', { value: new Map(Array.from({ length: 100 }, (_, i) => [i, 'heavy'])) }],
        ['fixture.light', { value: { payload: 'later!' } }]
      ]);
      console.log('ready'); setInterval(() => {}, 1000);
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '', stdout = '', client: ReturnType<typeof createCdpClient> | undefined;
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    try {
      const deadline = Date.now() + 10_000;
      while (!stdout.includes('ready') && Date.now() < deadline && child.exitCode === null) await sleep(20);
      expect(stdout, stderr).toContain('ready');
      client = createCdpClient(stderr.match(/ws:\/\/[^\s]+/)![0]); await client.connect();
      const fair = await readPinnedState(client, { expectedPid: child.pid!, maxEntries: 4, maxObjects: 6, budgetMs: 200 });
      expect(fair.roots[0]).toMatchObject({ owner: 'fixture.heavy', mapEntries: 100, traversalLimited: true });
      expect(fair.roots[1]).toMatchObject({ owner: 'fixture.light', objects: 1, stringCodeUnits: 6, traversalLimited: false });
      expect(fair.entries).toBeLessThanOrEqual(4); expect(fair.objects).toBeLessThanOrEqual(6);
      const selected = await readPinnedState(client, { expectedPid: child.pid!, owners: ['fixture.light'],
        maxSlots: 1, maxEntries: 4, budgetMs: 200 });
      expect(selected).toMatchObject({ population: 2, checked: 1, notChecked: 1, limited: false,
        selection: { requestedOwners: ['fixture.light'], selectedPopulation: 1, missingOwners: [],
          excludedBySelection: 1, selectedNotChecked: 0 } });
      expect(selected.roots).toHaveLength(1);
      expect(selected.roots[0]).toMatchObject({ owner: 'fixture.light', stringCodeUnits: 6, traversalLimited: false });
      const missing = await readPinnedState(client, { expectedPid: child.pid!, owners: ['fixture.absent'] });
      expect(missing).toMatchObject({ checked: 0, selection: { missingOwners: ['fixture.absent'], selectedPopulation: 0 } });
      await expect(readPinnedState(client, { expectedPid: child.pid!, owners: [] })).rejects.toThrow('owners');
      await expect(readPinnedState(client, { expectedPid: child.pid!, owners: ['fixture.light', 'fixture.light'] }))
        .rejects.toThrow('owners');
    } finally {
      client?.close();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM'); await new Promise<void>(resolve => child.once('exit', () => resolve()));
      }
    }
  }, 20_000);

  it('attributes payloads, discloses caps/shared references, and avoids getters/proxy/iterator effects', async () => {
    const child = spawn(process.execPath, ['--inspect=127.0.0.1:0', '--input-type=module', '-e', `
      let effects = 0;
      const shared = Buffer.alloc(19), cache = new Map([['key', 'payload'], ['shared', shared]]);
      cache[Symbol.iterator] = () => { effects++; throw new Error('application iterator'); };
      const root = { cache, rows: ['hello', shared], proxy: new Proxy({}, { ownKeys() { effects++; throw Error('proxy'); } }) };
      Object.defineProperty(root, 'getter', { enumerable: true, get() { effects++; throw Error('getter'); } });
      globalThis[Symbol.for('@papercusp/module-singleton.slots')] = new Map([
        ['fixture.cache', { value: root }], ['fixture.shared', { value: shared }],
        ['fixture.large', { value: new Map(Array.from({length: 20}, (_, i) => [i, 'abc'])) }]
      ]);
      globalThis.effectCount = () => effects;
      console.log('ready'); setInterval(() => {}, 1000);
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '', stdout = '', client: ReturnType<typeof createCdpClient> | undefined;
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    try {
      const deadline = Date.now() + 10_000;
      while (!stdout.includes('ready') && Date.now() < deadline && child.exitCode === null) await sleep(20);
      expect(stdout, stderr).toContain('ready');
      client = createCdpClient(stderr.match(/ws:\/\/[^\s]+/)![0]); await client.connect();
      const methods: string[] = [];
      const observed = { evaluate: async (expression: string, params?: Record<string, unknown>) => {
        methods.push('Runtime.evaluate'); return client!.evaluate(expression, params);
      } };
      const report = await readPinnedState(observed, { expectedPid: child.pid!, budgetMs: 200 });
      expect(report.population).toBe(3); expect(report.checked).toBe(3); expect(report.limited).toBe(false);
      expect(report.roots[0]).toMatchObject({ owner: 'fixture.cache', maps: 1, mapEntries: 2,
        arrays: 1, arrayEntries: 2, stringCodeUnits: 21, byteViewExtents: 19,
        accessorsSkipped: 1, proxiesSkipped: 1, sharedEdges: 1 });
      expect(report.roots[1]).toMatchObject({ owner: 'fixture.shared', byteViewExtents: 0, sharedEdges: 1 });
      expect(report.roots[2]).toMatchObject({ mapEntries: 20, stringCodeUnits: 60 });
      expect(await readPinnedState(observed, { expectedPid: child.pid!, maxSlots: 1, budgetMs: 200 }))
        .toMatchObject({ population: 3, checked: 1, notChecked: 2, limited: true });
      const capped = await readPinnedState(observed, { expectedPid: child.pid!, maxEntries: 1, budgetMs: 200 });
      expect(capped.limited).toBe(true); expect(capped.entries).toBeLessThanOrEqual(1);
      const shallow = await readPinnedState(observed, { expectedPid: child.pid!, maxDepth: 1, budgetMs: 200 });
      expect(shallow.roots[0].depthLimited).toBeGreaterThan(0);
      expect((await client.evaluate('effectCount()', { returnByValue: true })).result.value).toBe(0);
      expect(methods.every(method => method === 'Runtime.evaluate')).toBe(true);
      await expect(readPinnedState(observed, { expectedPid: child.pid! + 1 })).rejects.toThrow('PID mismatch');
      await expect(readPinnedState(observed, { expectedPid: child.pid!, maxEntries: 0 })).rejects.toThrow('limits');
      await client.evaluate("delete globalThis[Symbol.for('@papercusp/module-singleton.slots')]");
      expect(await readPinnedState(observed, { expectedPid: child.pid! })).toMatchObject({ registryPresent: false, population: null });
    } finally {
      client?.close();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM'); await new Promise<void>(resolve => child.once('exit', () => resolve()));
      }
    }
  }, 20_000);
});

describe('bounded function caller attribution on a real Node inspector', () => {
  it('names real compiler callers without pauses and cleans success, partial setup and body failures', async () => {
    const child = spawn(process.execPath, ['--inspect=127.0.0.1:0', '--input-type=module', '-e', `
      globalThis.compiler = await import('esbuild');
      globalThis.namedBuildCaller = () => compiler.build({ stdin: { contents: 'export const value = 1' }, write: false });
      globalThis.namedTransformCaller = () => compiler.transform('const value = 1', { loader: 'ts' });
      console.log('ready'); setInterval(() => {}, 1000);
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '', stdout = '', client: ReturnType<typeof createCdpClient> | undefined;
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    const requests: Array<{ method: string, args?: Record<string, unknown> }> = [];
    let pauses = 0;
    try {
      const deadline = Date.now() + 10_000;
      while (!stdout.includes('ready') && Date.now() < deadline && child.exitCode === null) await sleep(20);
      expect(stdout, stderr).toContain('ready');
      const endpoint = stderr.match(/ws:\/\/[^\s]+/)?.[0];
      expect(endpoint, stderr).toBeTruthy();
      client = createCdpClient(endpoint!);
      await client.connect();
      client.ws.on?.('message', data => { if (JSON.parse(String(data)).method === 'Debugger.paused') pauses++; });
      const traced = { evaluate: client.evaluate, send: async (method: string, args?: Record<string, unknown>) => {
        requests.push({ method, args }); return client!.send(method, args);
      } };
      const options = { expectedPid: child.pid!, targets: [
        { name: 'build', expression: 'compiler.build' }, { name: 'transform', expression: 'compiler.transform' },
      ], maxCalls: 3, maxStacks: 2, maxStackChars: 1400, durationMs: 2000 };
      const roots = async () => (await client!.evaluate(
        "Object.keys(globalThis).filter(key => key.startsWith('__papercuspCdpTrace_'))", { returnByValue: true })).result.value;
      const result = await withFunctionCallTrace(traced, options, async () => {
        await client!.evaluate('namedBuildCaller()', { awaitPromise: true });
        for (let i = 0; i < 8; i++) await client!.evaluate('namedTransformCaller()', { awaitPromise: true });
        return 'completed';
      });
      expect(result?.value).toBe('completed');
      expect(result?.trace.pid).toBe(child.pid);
      expect(result?.trace.total).toBe(3);
      expect(result?.trace.limited).toBe(true);
      expect(result?.trace.calls.build.calls).toBe(1);
      expect(result?.trace.calls.transform.calls).toBe(2);
      expect(result?.trace.calls.build.stacks.join('\n')).toContain('namedBuildCaller');
      expect(result?.trace.calls.transform.stacks.join('\n')).toContain('namedTransformCaller');
      for (const observation of Object.values(result.trace.calls)) {
        expect(observation.stacks.length).toBeLessThanOrEqual(2);
        expect(observation.stacks.every(stack => stack.length <= 1400)).toBe(true);
      }
      expect(result?.trace.observerMs).toBeGreaterThanOrEqual(0);
      expect(pauses).toBe(0);
      expect(await roots()).toEqual([]);
      const created = requests.filter(request => request.method === 'Debugger.setBreakpointOnFunctionCall').length;
      expect(requests.filter(request => request.method === 'Debugger.removeBreakpoint')).toHaveLength(created);
      expect(requests.some(request => /stopSampling|collectGarbage|setSkipAllPauses|Debugger.disable/.test(request.method))).toBe(false);
      for (const during of [async () => { throw new Error('body failed'); }, () => new Promise<never>(() => {})]) {
        await expect(withFunctionCallTrace(traced, { ...options, durationMs: 30 }, during)).rejects.toThrow();
        expect(await roots()).toEqual([]);
      }
      await expect(withFunctionCallTrace(traced, { ...options, targets: [options.targets[0]!,
        { name: 'missing', expression: 'undefined' }] }, async () => {})).rejects.toThrow('not a function');
      expect(await roots()).toEqual([]);
      await expect(withFunctionCallTrace(traced, { ...options, expectedPid: child.pid! + 1 }, async () => {})).rejects.toThrow('PID mismatch');
      await expect(withFunctionCallTrace(traced, { ...options, maxCalls: 0 }, async () => {})).rejects.toThrow('maxCalls');
      const cleanupFailureClient = { evaluate: client.evaluate, send: async (method: string, args?: Record<string, unknown>) => {
        const result = await traced.send(method, args);
        if (method === 'Debugger.removeBreakpoint') throw new Error('cleanup receipt failed');
        return result;
      } };
      try {
        await withFunctionCallTrace(cleanupFailureClient, options, async () => { throw new Error('original body failure'); });
        expect.fail('cleanup failure must be reported');
      } catch (error) {
        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).errors.map((item: Error) => item.message)).toContain('original body failure');
        expect((error as AggregateError).errors.map((item: Error) => item.message)).toContain('cleanup receipt failed');
      }
      expect(await roots()).toEqual([]);
      expect(requests.filter(request => request.method === 'Debugger.removeBreakpoint')).toHaveLength(
        requests.filter(request => request.method === 'Debugger.setBreakpointOnFunctionCall').length);
      await client.evaluate('namedTransformCaller()', { awaitPromise: true });
      expect(pauses).toBe(0);
      const releasedGroup = requests.find(request => request.method === 'Runtime.releaseObjectGroup')!.args!.objectGroup;
      const formerObject = requests.find(request => request.method === 'Debugger.setBreakpointOnFunctionCall')!.args!.objectId;
      expect(releasedGroup).toBeTruthy();
      await expect(client.send('Runtime.getProperties', { objectId: formerObject })).rejects.toThrow();
    } finally {
      if (client && child.exitCode === null && child.signalCode === null) {
        await client.evaluate('compiler.stop()').catch(() => {});
      }
      client?.close();
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGKILL'); await exited;
      }
      child.stdout.destroy(); child.stderr.destroy();
    }
  }, 20_000);
});

describe('CDP inspector seam', () => {
  it('redacts credentials, query strings, and fragments from diagnostic URLs', () => {
    const redacted = redactDiagnosticUrl(
      'wss://user:password@example.test:9229/devtools/page/id?access_token=short-lived&safe=yes#fragment',
    );

    expect(redacted).toBe('wss://example.test:9229/devtools/page/id');
    expect(redacted).not.toContain('access_token');
    expect(redacted).not.toContain('short-lived');
    expect(redacted).not.toContain('password');
  });

  it('does not echo an unparseable diagnostic URL', () => {
    expect(redactDiagnosticUrl('not a URL with token=secret')).toBe('<unparseable-url>');
  });

  it('surfaces Runtime.evaluate exceptionDetails as a failure', async () => {
    const client = makeClient(new Map([
      ['Runtime.evaluate', {
        result: { type: 'undefined' },
        exceptionDetails: {
          text: 'Uncaught',
          exception: { description: 'TypeError: dynamic import is unavailable' },
        },
      }],
    ]));
    await client.connect();

    await expect(client.evaluate('await import("node:inspector")'))
      .rejects.toMatchObject({
        name: 'CdpEvaluationError',
        message: expect.stringContaining('dynamic import is unavailable'),
      });
  });

  it('verifies the inspector port after the expected close-transport loss', async () => {
    const client = makeClient(new Map([['Runtime.evaluate', 'close']]));
    await client.connect();
    const urls: string[] = [];

    await expect(closeInspector(client, 9229, {
      fetchImpl: async (url: string) => {
        urls.push(url);
        throw new Error('ECONNREFUSED');
      },
      sleepImpl: async () => {},
      verifyTimeoutMs: 20,
      pollIntervalMs: 0,
    })).resolves.toEqual({ closed: true });

    expect(urls).toEqual(['http://127.0.0.1:9229/json/list']);
    expect(client.ws.closed).toBe(true);
  });

  it('rejects when the WebSocket closes but /json/list still responds', async () => {
    const client = makeClient(new Map([['Runtime.evaluate', 'close']]));
    await client.connect();

    await expect(closeInspector(client, 9229, {
      fetchImpl: async () => ({ ok: true, json: async () => [] }),
      sleepImpl: async () => {},
      verifyTimeoutMs: 0,
      pollIntervalMs: 0,
    })).rejects.toThrow('inspector still open on port 9229');
  });
});
