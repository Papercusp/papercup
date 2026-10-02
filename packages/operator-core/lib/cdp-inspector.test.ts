// @vitest-environment node
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';

import { closeInspector, createCdpClient, readPinnedState, readProcessMemory, redactDiagnosticUrl, withFunctionCallTrace } from '../../../scripts/cdp-inspector.mjs';

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

describe('PID-bound host configuration facts', () => {
  it('normalizes only fixed boot flags and observes worker state without leaking arbitrary environment', async () => {
    const effects: string[] = [];
    const inspect = async (env: Record<string, string>, cluster: object, hostFacts = true) => {
      const client = { evaluate: async (expression: string) => ({ result: { value: runInNewContext(expression, {
        process: { pid: 7, env, uptime: () => 1, memoryUsage: () => ({ heapUsed: 100 }),
          getBuiltinModule: (name: string) => {
            effects.push(name);
            if (name === 'v8') return { getHeapStatistics: () => ({ used_heap_size: 100 }) };
            if (name === 'cluster') return cluster;
            throw Error('Unexpected builtin');
          } },
      }) } }) };
      return readProcessMemory(client, { expectedPid: 7, hostFacts });
    };
    const env = { PAPERCUSP_BACKGROUND_WORKERS: 'private-enabled-value', PAPERCUSP_HONO_PORT: '3170',
      PAPERCUSP_SPAWNER_SIDECAR_MODE: '1', PRIVATE_TOKEN: 'never-export-this' };
    const primary = await inspect(env, { isPrimary: true, isWorker: false, workers: { 1: {}, 2: {} } });
    expect(primary.hostFacts).toMatchObject({ backgroundWorkersOverride: 'enabled', stagingPort: true,
      cluster: { isPrimary: true, isWorker: false, workerId: null, primaryWorkerCount: 2 },
      sidecarFlags: { spawner: true, substrate: false } });
    expect(JSON.stringify(primary)).not.toMatch(/private-enabled-value|never-export-this|PRIVATE_TOKEN/);
    expect((await inspect({ PAPERCUSP_BACKGROUND_WORKERS: '0' },
      { isPrimary: false, isWorker: true, worker: { id: 3 } })).hostFacts).toMatchObject({
      backgroundWorkersOverride: 'disabled', stagingPort: false,
      cluster: { isPrimary: false, isWorker: true, workerId: 3, primaryWorkerCount: null } });
    expect((await inspect({}, { isPrimary: true, isWorker: false })).hostFacts.backgroundWorkersOverride).toBe('unset');
    effects.length = 0;
    expect(await inspect(env, {}, false)).not.toHaveProperty('hostFacts');
    expect(effects).toEqual(['v8']);
  });

  it('rejects invalid opt-in and wrong targets before accepting host facts', async () => {
    let evaluations = 0;
    const client = { evaluate: async () => { evaluations++; return { result: { value: { pid: 8 } } }; } };
    await expect(readProcessMemory(client, { expectedPid: 7, hostFacts: 'yes' as any })).rejects.toThrow('boolean');
    expect(evaluations).toBe(0);
    await expect(readProcessMemory(client, { expectedPid: 7, hostFacts: true })).rejects.toThrow('PID mismatch');
  });
});

describe('named pinned payload attribution on a real Node inspector', () => {
  it('attributes individual cache values fairly with protected keys, stable digests and no application effects', async () => {
    const key = 'private-workspace\u0000plans:get|private-payload';
    const child = spawn(process.execPath, ['--inspect=127.0.0.1:0', '--input-type=module', '-e', `
      let effects = 0;
      const shared = Buffer.alloc(19), accessor = {};
      Object.defineProperty(accessor, 'value', { get() { effects++; throw Error('accessor'); } });
      const proxy = new Proxy({}, { getOwnPropertyDescriptor() { effects++; throw Error('proxy'); } });
      const map = new Map([
        [${JSON.stringify(key)}, { value: { rows: Array.from({length: 100}, () => 'heavy') }, hardExpiresAt: 0 }],
        ['private-workspace\\0orders:list|private-payload', { value: { payload: 'later!', shared }, softExpiresAt: Infinity }],
        ['private-workspace\\0coord:feed|private-payload', { value: shared }],
        ['private-workspace\\0facts:list|private-payload', accessor],
        ['private-workspace\\0plans:items|private-payload', proxy],
        ['legacy/private-payload', { value: 'legacy' }],
        ['private-payload'.repeat(20), { value: 'long' }],
        [proxy, { value: 'non-string' }]
      ]);
      map[Symbol.iterator] = () => { effects++; throw Error('iterator'); };
      const root = { cache: { l1: { map } } };
      globalThis[Symbol.for('@papercusp/module-singleton.slots')] = new Map([
        ['@papercusp/operator-core.operatorCache', { value: root }]
      ]);
      globalThis.effectCount = () => effects;
      globalThis.keyOrder = () => Array.from(Map.prototype.keys.call(map)).map(key => typeof key === 'string' ? key : null);
      globalThis.hideMap = () => Object.defineProperty(root.cache.l1, 'map', { get() { effects++; throw Error('path getter'); } });
      console.log('ready'); setInterval(() => {}, 1000);
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '', stdout = '', client: ReturnType<typeof createCdpClient> | undefined;
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    try {
      const deadline = Date.now() + 10_000;
      while (!stdout.includes('ready') && Date.now() < deadline && child.exitCode === null) await sleep(20);
      expect(stdout, stderr).toContain('ready');
      client = createCdpClient(stderr.match(/ws:\/\/[^\s]+/)![0]); await client.connect();
      const options = { expectedPid: child.pid!, owners: ['@papercusp/operator-core.operatorCache'],
        operatorCacheEntries: true, maxEntries: 128, maxEntryEntries: 10, maxEntryObjects: 12,
        maxKeyCodeUnits: 60, budgetMs: 200 };
      const before = (await client.evaluate('keyOrder()', { returnByValue: true })).result.value;
      const report = await readPinnedState(client, options), cache = report.roots[0].cacheEntries;
      expect(cache).toMatchObject({ status: 'map', population: 8, checked: 8, notChecked: 0 });
      expect(cache.values[0]).toMatchObject({ toolNamespace: 'plans:get', keyFormat: 'workspace-nul-tool-pipe',
        keyDigest: createHash('sha256').update(key).digest('hex'), hardExpiry: 'expired', traversalLimited: true });
      expect(cache.values[1]).toMatchObject({ toolNamespace: 'orders:list', softExpiry: 'infinite',
        stringCodeUnits: 6, byteViewExtents: 19, traversalLimited: false });
      expect(cache.values[2]).toMatchObject({ sharedEdges: 1, byteViewExtents: 0 });
      expect(cache.values[3].valueStatus).toBe('accessor-skipped');
      expect(cache.values[4].valueStatus).toBe('proxy-skipped');
      expect(cache.values[5]).toMatchObject({ keyFormat: 'unknown', toolNamespace: null });
      expect(cache.values[6]).toMatchObject({ keyDigest: null, keyDigestUnavailable: 'key-length-limit' });
      expect(cache.values[7]).toMatchObject({ keyDigest: null, keyDigestUnavailable: 'non-string-key' });
      expect(report.entries).toBeLessThanOrEqual(options.maxEntries);
      expect(cache.values.every((value: any) => value.entries <= 10 && value.objects <= 12)).toBe(true);
      expect(JSON.stringify(report)).not.toMatch(/private-workspace|private-payload/);
      const again = await readPinnedState(client, options);
      expect(again.roots[0].cacheEntries.values.map((value: any) => value.keyDigest))
        .toEqual(cache.values.map((value: any) => value.keyDigest));
      expect((await client.evaluate('keyOrder()', { returnByValue: true })).result.value).toEqual(before);
      const capped = await readPinnedState(client, { ...options, maxCacheEntries: 2 });
      expect(capped.roots[0].cacheEntries).toMatchObject({ population: 8, checked: 2, notChecked: 6 });
      expect(capped.limited).toBe(true);
      const page = await readPinnedState(client, { ...options, maxCacheEntries: 2, cacheEntryOffset: 5 });
      expect(page.roots[0].cacheEntries).toMatchObject({ scanned: 7, checked: 2,
        selection: { mode: 'offset', offset: 5, nextOffset: 7, selectedNotChecked: 0, scanComplete: false } });
      expect(page.roots[0].cacheEntries.values[0].keyFormat).toBe('unknown');
      const digest = cache.values[1].keyDigest;
      const selected = await readPinnedState(client, { ...options, cacheKeyDigests: [digest] });
      expect(selected.roots[0].cacheEntries).toMatchObject({ scanned: 2, checked: 1,
        selection: { mode: 'digests', nextOffset: null, unresolvedKeyDigests: [] } });
      expect(selected.roots[0].cacheEntries.values[0]).toMatchObject({ keyDigest: digest,
        toolNamespace: 'orders:list', stringCodeUnits: 6, byteViewExtents: 19 });
      const unresolved = await readPinnedState(client, { ...options, cacheKeyDigests: ['f'.repeat(64)] });
      expect(unresolved.roots[0].cacheEntries).toMatchObject({ scanned: 8, checked: 0, undigestibleKeys: 2,
        selection: { scanComplete: true, unresolvedKeyDigests: ['f'.repeat(64)], unresolvedAreMissing: false } });
      for (const invalid of [{ cacheEntryOffset: -1 }, { cacheEntryOffset: 32769 },
        { cacheKeyDigests: [] }, { cacheKeyDigests: ['private-payload'] },
        { cacheKeyDigests: [digest, digest] }, { cacheKeyDigests: [digest], cacheEntryOffset: 1 },
        { cacheKeyDigests: [digest], operatorCacheEntries: false }]) {
        await expect(readPinnedState(client, { ...options, ...invalid })).rejects.toThrow('limits');
      }
      await expect(readPinnedState(client, { ...options, maxEntryEntries: 0 })).rejects.toThrow('limits');
      await expect(readPinnedState(client, { ...options, expectedPid: child.pid! + 1 })).rejects.toThrow('PID mismatch');
      await client.evaluate('hideMap()');
      expect((await readPinnedState(client, options)).roots[0].cacheEntries.status).toBe('accessor-skipped');
      expect((await client.evaluate('effectCount()', { returnByValue: true })).result.value).toBe(0);
    } finally {
      client?.close();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM'); await new Promise<void>(resolve => child.once('exit', () => resolve()));
      }
    }
  }, 20_000);

  it('attributes the direct Jev writer without treating private or malformed suffixes as tool namespaces', async () => {
    const digest = 'a'.repeat(64);
    const keys = [
      'private-workspace\u0000jev-memory:' + digest,
      'private-workspace\u0000jev-memory:' + digest.slice(1),
      'private-workspace\u0000jev-memory:' + digest.toUpperCase(),
      'private-workspace\u0000jev-memory:' + digest + '\n',
      '\u0000jev-memory:' + digest,
      'private-workspace\u0000private-prefix-jev-memory:' + digest,
      'private-workspace\u0000jev-memory:' + digest + '|private-payload',
      'private-workspace\u0000memory-inject-block:private-payload',
      'private-workspace\u0000plans:get|private-payload',
    ];
    const child = spawn(process.execPath, ['--inspect=127.0.0.1:0', '--input-type=module', '-e', `
      const map = new Map(${JSON.stringify(keys)}.map(key => [key,
        { value: { scores: [['private-memory-id', 0.8]], model: 'private-model' } }]));
      globalThis[Symbol.for('@papercusp/module-singleton.slots')] = new Map([
        ['@papercusp/operator-core.operatorCache', { value: { cache: { l1: { map } } } }]
      ]);
      console.log('ready'); setInterval(() => {}, 1000);
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '', stdout = '', client: ReturnType<typeof createCdpClient> | undefined;
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    try {
      const deadline = Date.now() + 10_000;
      while (!stdout.includes('ready') && Date.now() < deadline && child.exitCode === null) await sleep(20);
      expect(stdout, stderr).toContain('ready');
      client = createCdpClient(stderr.match(/ws:\/\/[^\s]+/)![0]); await client.connect();
      const report = await readPinnedState(client, { expectedPid: child.pid!,
        owners: ['@papercusp/operator-core.operatorCache'], operatorCacheEntries: true,
        maxCacheEntries: keys.length, maxEntries: 512, maxObjects: 128, budgetMs: 200 });
      const cache = report.roots[0].cacheEntries;
      expect(cache).toMatchObject({ checked: keys.length, notChecked: 0 });
      expect(cache.values[0]).toMatchObject({ cacheOwner: 'jev-memory', toolNamespace: null,
        keyFormat: 'workspace-nul-jev-memory-sha256',
        keyDigest: createHash('sha256').update(keys[0]).digest('hex'), traversalLimited: false });
      for (const value of cache.values.slice(1, -1)) {
        expect(value).toMatchObject({ cacheOwner: null, toolNamespace: null, keyFormat: 'unknown' });
      }
      expect(cache.values.at(-1)).toMatchObject({ cacheOwner: 'plans:get', toolNamespace: 'plans:get',
        keyFormat: 'workspace-nul-tool-pipe' });
      expect(JSON.stringify(report)).not.toMatch(/private-|a{64}/);
    } finally {
      client?.close();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM'); await new Promise<void>(resolve => child.once('exit', () => resolve()));
      }
    }
  }, 20_000);

  it('reaches cache values beyond the prefix cap and charges skipped edges to the unchanged work budget', async () => {
    const child = spawn(process.execPath, ['--inspect=127.0.0.1:0', '--input-type=module', '-e', `
      const map = new Map(Array.from({ length: 300 }, (_, index) =>
        ['private-workspace\\0coord:inbox|private-payload-' + index, { value: { payload: 'row-' + index } }]));
      globalThis[Symbol.for('@papercusp/module-singleton.slots')] = new Map([
        ['@papercusp/operator-core.operatorCache', { value: { cache: { l1: { map } } } }]
      ]);
      console.log('ready'); setInterval(() => {}, 1000);
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '', stdout = '', client: ReturnType<typeof createCdpClient> | undefined;
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    try {
      const deadline = Date.now() + 10_000;
      while (!stdout.includes('ready') && Date.now() < deadline && child.exitCode === null) await sleep(20);
      expect(stdout, stderr).toContain('ready');
      client = createCdpClient(stderr.match(/ws:\/\/[^\s]+/)![0]); await client.connect();
      const options = { expectedPid: child.pid!, owners: ['@papercusp/operator-core.operatorCache'],
        operatorCacheEntries: true, maxEntries: 512, maxCacheEntries: 8, budgetMs: 200 };
      const page = await readPinnedState(client, { ...options, cacheEntryOffset: 256 });
      expect(page.roots[0].cacheEntries).toMatchObject({ population: 300, scanned: 264, checked: 8,
        selection: { nextOffset: 264, scanComplete: false, selectedNotChecked: 0 } });
      expect(page.roots[0].cacheEntries.values[0]).toMatchObject({ stringCodeUnits: 7,
        keyDigest: createHash('sha256').update('private-workspace\u0000coord:inbox|private-payload-256').digest('hex') });
      const digest = createHash('sha256').update('private-workspace\u0000coord:inbox|private-payload-299').digest('hex');
      const selected = await readPinnedState(client, { ...options, cacheKeyDigests: [digest] });
      expect(selected.roots[0].cacheEntries).toMatchObject({ scanned: 300, checked: 1,
        selection: { unresolvedKeyDigests: [], selectedNotChecked: 0, scanComplete: true } });
      expect(selected.entries).toBe(301);
      expect(selected.roots[0].cacheEntries.values[0].keyDigest).toBe(digest);
      const partial = await readPinnedState(client, { ...options, maxEntries: 12, cacheKeyDigests: [digest] });
      expect(partial.entries).toBe(12);
      expect(partial.roots[0].cacheEntries).toMatchObject({ scanned: 12, checked: 0,
        selection: { unresolvedKeyDigests: [digest], unresolvedAreMissing: false, scanComplete: false } });
      const missing = await readPinnedState(client, { ...options, cacheKeyDigests: ['f'.repeat(64)] });
      expect(missing.roots[0].cacheEntries).toMatchObject({ scanned: 300, checked: 0,
        selection: { unresolvedAreMissing: true, scanComplete: true } });
      const pastEnd = await readPinnedState(client, { ...options, cacheEntryOffset: 300 });
      expect(pastEnd.roots[0].cacheEntries).toMatchObject({ scanned: 0, checked: 0,
        selection: { nextOffset: null, selectedNotChecked: 0 } });
      expect(JSON.stringify([page, selected, partial, missing])).not.toMatch(/private-workspace|private-payload/);
    } finally {
      client?.close();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM'); await new Promise<void>(resolve => child.once('exit', () => resolve()));
      }
    }
  }, 20_000);

  it('reserves work for a light later root and selects exact owners independently of registry order', async () => {
    const child = spawn(process.execPath, ['--inspect=127.0.0.1:0', '--input-type=module', '-e', `
      globalThis[Symbol.for('@papercusp/module-singleton.slots')] = new Map([
        ['fixture.heavy', { value: new Map(Array.from({ length: 100 }, (_, i) => [i, 'heavy'])) }],
        ['fixture.light', { value: { payload: 'later!' } }]
      ]);
      console.log('ready'); setInterval(() => {}, 1000);
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '', stdout = '', client: ReturnType<typeof createCdpClient> | undefined;
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
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
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
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
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
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
      const counters = await readProcessMemory(client, { expectedPid: child.pid!, hostFacts: true });
      expect(counters.hostFacts.cluster).toMatchObject({ isPrimary: true, isWorker: false, workerId: null });
      expect(counters.memory.heapUsed).toBeGreaterThan(0);
      expect(await readProcessMemory(client, { expectedPid: child.pid! })).not.toHaveProperty('hostFacts');
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
