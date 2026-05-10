/**
 * Tests for capability proxy + fetch/secrets gates. Run with:
 *   cd packages/papercusp-plugin-loader && npx tsx --test src/capabilities.test.ts
 */
import { describe, it } from 'vitest';
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

  it('subdomain wildcard `http:fetch:*.foo.com` matches `http:fetch:api.foo.com`', () => {
    const ctx = { pluginName: 'p', capabilities: ['http:fetch:*.foo.com'] as any };
    assert.equal(hasCapability(ctx, 'http:fetch:api.foo.com'), true);
    assert.equal(hasCapability(ctx, 'http:fetch:deep.api.foo.com'), true);
  });

  it('subdomain wildcard does NOT match the bare suffix `foo.com`', () => {
    const ctx = { pluginName: 'p', capabilities: ['http:fetch:*.foo.com'] as any };
    assert.equal(hasCapability(ctx, 'http:fetch:foo.com'), false);
    assert.equal(hasCapability(ctx, 'http:fetch:.foo.com'), false);
  });

  it('subdomain wildcard does NOT cross prefixes', () => {
    const ctx = { pluginName: 'p', capabilities: ['http:fetch:*.foo.com'] as any };
    assert.equal(hasCapability(ctx, 'secrets:read:api.foo.com'), false);
  });

  it('prefix wildcard `secrets:read:YT_*` matches `secrets:read:YT_API_KEY`', () => {
    const ctx = { pluginName: 'p', capabilities: ['secrets:read:YT_*'] as any };
    assert.equal(hasCapability(ctx, 'secrets:read:YT_API_KEY'), true);
    assert.equal(hasCapability(ctx, 'secrets:read:YT_'), false); // empty tail rejected
    assert.equal(hasCapability(ctx, 'secrets:read:OTHER'), false);
  });

  it('degenerate `secrets:read:*` (empty head) is rejected', () => {
    const ctx = { pluginName: 'p', capabilities: ['secrets:read:*'] as any };
    assert.equal(hasCapability(ctx, 'secrets:read:ANY'), false);
  });

  describe('two-tier (Batch B)', () => {
    it('manifest-declared cap with no granted set is allowed (legacy path)', () => {
      const ctx = { pluginName: 'p', capabilities: ['tasks:read'] as any };
      assert.equal(hasCapability(ctx, 'tasks:read'), true);
    });

    it('manifest-declared cap NOT in granted set is denied', () => {
      const ctx = {
        pluginName: 'p',
        capabilities: ['tasks:read'] as any,
        granted: [] as any,
      };
      assert.equal(hasCapability(ctx, 'tasks:read'), false);
    });

    it('manifest + granted both declare the cap → allowed', () => {
      const ctx = {
        pluginName: 'p',
        capabilities: ['tasks:read'] as any,
        granted: ['tasks:read'] as any,
      };
      assert.equal(hasCapability(ctx, 'tasks:read'), true);
    });

    it('granted set with the cap but manifest does NOT → denied (Tier 1 still required)', () => {
      const ctx = {
        pluginName: 'p',
        capabilities: [] as any,
        granted: ['tasks:read'] as any,
      };
      assert.equal(hasCapability(ctx, 'tasks:read'), false);
    });

    it('granted wildcard authorizes anything in its match set the manifest also declared', () => {
      const ctx = {
        pluginName: 'p',
        capabilities: ['http:fetch:api.foo.com', 'http:fetch:cdn.foo.com'] as any,
        granted: ['http:fetch:*.foo.com'] as any,
      };
      assert.equal(hasCapability(ctx, 'http:fetch:api.foo.com'), true);
      assert.equal(hasCapability(ctx, 'http:fetch:cdn.foo.com'), true);
      assert.equal(hasCapability(ctx, 'http:fetch:other.bar.com'), false);
    });
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
    const ctx = { pluginName: 'mytool', capabilities: [] as any };
    const scoped = createPluginHookBus(bus, ctx);
    // Plugin-emitted events MUST be prefixed with the plugin id (Batch
    // A3 namespace rule), so use 'mytool.briefing-ready' not the
    // substrate-style 'briefing.ready'. Bare 'briefing.ready' would now
    // be rejected by the namespace check before the capability check.
    await assert.rejects(
      () => scoped.emit('mytool.briefing-ready', {}),
      /events:emit:mytool\.briefing-ready/,
    );
  });

  it('emit rejects substrate-reserved event names', async () => {
    const bus = new HookBus();
    const ctx = { pluginName: 'mytool', capabilities: ['events:emit:mission.start'] as any };
    const scoped = createPluginHookBus(bus, ctx);
    await assert.rejects(
      () => scoped.emit('mission.start', {}),
      /reserved for the substrate/,
    );
  });

  it('emit rejects events not prefixed with the plugin id', async () => {
    const bus = new HookBus();
    const ctx = { pluginName: 'mytool', capabilities: ['events:emit:something.else'] as any };
    const scoped = createPluginHookBus(bus, ctx);
    await assert.rejects(
      () => scoped.emit('something.else', {}),
      /must prefix emitted events with its plugin id/,
    );
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
