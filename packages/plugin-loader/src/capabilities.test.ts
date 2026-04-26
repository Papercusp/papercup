/**
 * Tests for capability proxy + fetch/secrets gates. Run with:
 *   cd packages/papercusp-plugin-loader && npx tsx --test src/capabilities.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasCapability,
  requireCapability,
  wrapServiceWithCaps,
  makeFetchProxy,
  makeSecretsProxy,
  MissingCapabilityError,
  UnknownMethodError,
} from './capabilities.ts';
import { HookBus, createPluginHookBus } from './hookbus.ts';

// Inline service def — equivalent to `defineService({...})` from @papercusp/plugin-sdk
// but avoids cross-package imports in tsx --test which has resolution issues.
function defineService<T extends { name: string; methods: Record<string, { capability: any }> }>(def: T): T {
  return def;
}

describe('hasCapability / requireCapability', () => {
  it('returns true for declared cap', () => {
    const ctx = { pluginName: 'p', capabilities: ['tasks:read'] as any };
    assert.equal(hasCapability(ctx, 'tasks:read'), true);
  });

  it('returns false for undeclared cap', () => {
    const ctx = { pluginName: 'p', capabilities: ['tasks:read'] as any };
    assert.equal(hasCapability(ctx, 'tasks:write'), false);
  });

  it('requireCapability throws MissingCapabilityError for undeclared cap', () => {
    const ctx = { pluginName: 'p', capabilities: [] as any };
    assert.throws(
      () => requireCapability(ctx, 'tasks:write'),
      (e: Error) => e instanceof MissingCapabilityError,
    );
  });
});

describe('wrapServiceWithCaps', () => {
  const TasksDef = defineService({
    name: 'tasks',
    methods: {
      list:   { capability: 'tasks:read' },
      get:    { capability: 'tasks:read' },
      create: { capability: 'tasks:write' },
    },
  });

  const realService = {
    list: () => ['a', 'b'],
    get: (id: string) => ({ id }),
    create: (input: any) => ({ created: input }),
  };

  it('passes through method calls when cap is held', () => {
    const ctx = { pluginName: 'p', capabilities: ['tasks:read'] as any };
    const proxied = wrapServiceWithCaps(ctx, realService as any, TasksDef);
    assert.deepEqual(proxied.list(), ['a', 'b']);
  });

  it('throws MissingCapabilityError when cap is missing', () => {
    const ctx = { pluginName: 'p', capabilities: ['tasks:read'] as any };
    const proxied = wrapServiceWithCaps(ctx, realService as any, TasksDef);
    assert.throws(
      () => proxied.create({ title: 'x' }),
      (e: Error) => e instanceof MissingCapabilityError,
    );
  });

  it('throws UnknownMethodError for non-existent method', () => {
    const ctx = { pluginName: 'p', capabilities: ['tasks:read'] as any };
    const proxied = wrapServiceWithCaps(ctx, realService as any, TasksDef);
    assert.throws(
      () => (proxied as any).bogusMethod(),
      (e: Error) => e instanceof UnknownMethodError,
    );
  });
});

describe('makeFetchProxy', () => {
  it('allows a hostname when http:fetch:<host> is declared', async () => {
    const ctx = { pluginName: 'p', capabilities: ['http:fetch:youtube.com'] as any };
    const calls: string[] = [];
    const fakeFetch = (async (input: any) => {
      calls.push(typeof input === 'string' ? input : input.toString());
      return new Response('ok');
    }) as typeof fetch;
    const proxy = makeFetchProxy(ctx, fakeFetch);
    const r = await proxy('https://youtube.com/api/videos');
    assert.equal(r.status, 200);
    assert.deepEqual(calls, ['https://youtube.com/api/videos']);
  });

  it('blocks a hostname not in the allowlist', async () => {
    const ctx = { pluginName: 'p', capabilities: ['http:fetch:youtube.com'] as any };
    const proxy = makeFetchProxy(ctx);
    await assert.rejects(
      () => proxy('https://api.openai.com/v1/chat'),
      (e: Error) => e instanceof MissingCapabilityError,
    );
  });
});

describe('makeSecretsProxy', () => {
  it('reads when secrets:read:<NAME> is declared', async () => {
    const ctx = { pluginName: 'p', capabilities: ['secrets:read:YOUTUBE_API_KEY'] as any };
    const proxy = makeSecretsProxy(ctx, async () => 'abc123');
    assert.equal(await proxy.read('YOUTUBE_API_KEY'), 'abc123');
  });

  it('throws on unscoped secret read', async () => {
    const ctx = { pluginName: 'p', capabilities: ['secrets:read:YOUTUBE_API_KEY'] as any };
    const proxy = makeSecretsProxy(ctx, async () => 'abc123');
    await assert.rejects(
      () => proxy.read('OPENAI_API_KEY'),
      (e: Error) => e instanceof MissingCapabilityError,
    );
  });
});

describe('HookBus + createPluginHookBus', () => {
  it('addAction requires events:listen:<event>', () => {
    const bus = new HookBus();
    const ctx = { pluginName: 'p', capabilities: [] as any };
    const scoped = createPluginHookBus(bus, ctx);
    assert.throws(() => scoped.addAction('task.passed', () => {}), /events:listen:task\.passed/);
  });

  it('runAction fires registered handlers', async () => {
    const bus = new HookBus();
    const ctx = { pluginName: 'p', capabilities: ['events:listen:task.passed'] as any };
    const scoped = createPluginHookBus(bus, ctx);

    let received: unknown = null;
    scoped.addAction<{ taskId: string }>('task.passed', (arg) => {
      received = arg;
    });
    await bus.runAction('task.passed', { taskId: 'F-001' });
    assert.deepEqual(received, { taskId: 'F-001' });
  });

  it('applyFilter chains transformations', async () => {
    const bus = new HookBus();
    const ctxA = { pluginName: 'plugin-a', capabilities: ['events:listen:task.title'] as any };
    const ctxB = { pluginName: 'plugin-b', capabilities: ['events:listen:task.title'] as any };
    createPluginHookBus(bus, ctxA).addFilter<string>('task.title', (s) => `[A] ${s}`);
    createPluginHookBus(bus, ctxB).addFilter<string>('task.title', (s) => `${s} [B]`);
    const out = await bus.applyFilter('task.title', 'hello');
    assert.equal(out, '[A] hello [B]');
  });

  it('emit checks events:emit:<event>', async () => {
    const bus = new HookBus();
    const ctx = { pluginName: 'p', capabilities: [] as any };
    const scoped = createPluginHookBus(bus, ctx);
    await assert.rejects(() => scoped.emit('briefing.ready', {}), /events:emit:briefing\.ready/);
  });

  it('unregisterPlugin removes all that plugin\'s registrations', async () => {
    const bus = new HookBus();
    const ctxA = { pluginName: 'plugin-a', capabilities: ['events:listen:x'] as any };
    const ctxB = { pluginName: 'plugin-b', capabilities: ['events:listen:x'] as any };
    let calls = 0;
    createPluginHookBus(bus, ctxA).addAction('x', () => { calls++; });
    createPluginHookBus(bus, ctxB).addAction('x', () => { calls++; });
    await bus.runAction('x', {});
    assert.equal(calls, 2);
    bus.unregisterPlugin('plugin-a');
    await bus.runAction('x', {});
    assert.equal(calls, 3);    // only plugin-b's handler ran
  });
});
