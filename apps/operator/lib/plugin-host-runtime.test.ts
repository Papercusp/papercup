/**
 * Unit tests for the in-process plugin host runtime.
 *
 * Bypasses filesystem discovery via `_injectPluginHostForTests`, so each
 * test feeds the runtime a fixed set of fake `LoadedPlugin` records and
 * asserts on the lifecycle / action / spawn behavior.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { LoadedPlugin } from '@papercusp/plugin-loader';
import {
  _injectPluginHostForTests,
  _resetPluginHostForTests,
  firePluginLifecycle,
  firePluginEvent,
  invokePluginAction,
  pluginHostStatus,
  warmUpPluginsForSlug,
  buildPapercuspContext,
} from './plugin-host-runtime';

const SLUG_ARGS = {
  installSlug: 'test-harness',
  projectDir: '/tmp/papercusp-host-test',
  stateDir: '/tmp/papercusp-host-test/.harness',
};

function makePlugin(overrides: Partial<LoadedPlugin['plugin']> = {}): LoadedPlugin {
  const base: LoadedPlugin['plugin'] = {
    name: 'fixture',
    version: '0.1.0',
    papercusp: '^0.1.0',
    capabilities: [],
    ...overrides,
  } as LoadedPlugin['plugin'];
  return { plugin: base, path: '/fake/' + base.name, source: 'global' };
}

beforeEach(() => {
  _resetPluginHostForTests();
});

describe('buildPapercuspContext', () => {
  it('builds a ctx with pluginDataDir under stateDir', () => {
    const ctx = buildPapercuspContext({
      pluginName: 'foo',
      installSlug: 's',
      projectDir: '/p',
      stateDir: '/p/.harness',
    });
    expect(ctx.pluginDataDir).toBe('/p/.harness/plugins/foo');
    expect(typeof ctx.log).toBe('function');
  });
});

describe('firePluginLifecycle', () => {
  it('fires the named hook on every plugin that declares it', async () => {
    const calls: string[] = [];
    const a = makePlugin({
      name: 'a',
      hooks: {
        async beforeMissionStart(ctx) { calls.push(`a:${ctx.installSlug}`); },
      },
    });
    const b = makePlugin({
      name: 'b',
      hooks: {
        async beforeMissionStart(ctx) { calls.push(`b:${ctx.installSlug}`); },
      },
    });
    const c = makePlugin({ name: 'c' }); // no hooks
    _injectPluginHostForTests([a, b, c]);

    await firePluginLifecycle('beforeMissionStart', SLUG_ARGS);

    expect(calls.sort()).toEqual(['a:test-harness', 'b:test-harness']);
  });

  it('passes positional payload (onFeaturePassed receives featureId)', async () => {
    const seen: string[] = [];
    const p = makePlugin({
      name: 'recorder',
      hooks: {
        async onFeaturePassed(_ctx, featureId) { seen.push(featureId); },
      },
    });
    _injectPluginHostForTests([p]);

    await firePluginLifecycle('onFeaturePassed', SLUG_ARGS, 'F-001');

    expect(seen).toEqual(['F-001']);
  });

  it('one plugin throwing does not abort the others', async () => {
    const calls: string[] = [];
    const bad = makePlugin({
      name: 'bad',
      hooks: { async beforeMissionStart() { throw new Error('boom'); } },
    });
    const good = makePlugin({
      name: 'good',
      hooks: { async beforeMissionStart() { calls.push('good'); } },
    });
    _injectPluginHostForTests([bad, good]);

    await firePluginLifecycle('beforeMissionStart', SLUG_ARGS);

    expect(calls).toEqual(['good']);
  });

  it('init + onLoad fire exactly once per (plugin, harness)', async () => {
    let initCount = 0;
    let onLoadCount = 0;
    const p = makePlugin({
      name: 'lifecycle',
      async init() { initCount++; },
      hooks: {
        async onLoad() { onLoadCount++; },
        async beforeMissionStart() { /* no-op */ },
        async onFeaturePassed() { /* no-op */ },
      },
    });
    _injectPluginHostForTests([p]);

    await firePluginLifecycle('beforeMissionStart', SLUG_ARGS);
    await firePluginLifecycle('onFeaturePassed', SLUG_ARGS, 'F-1');
    await firePluginLifecycle('beforeMissionStart', SLUG_ARGS);

    expect(initCount).toBe(1);
    expect(onLoadCount).toBe(1);
  });
});

describe('warmUpPluginsForSlug', () => {
  it('initializes plugins that declare no hooks', async () => {
    let inited = false;
    const p = makePlugin({
      name: 'warmup-only',
      async init() { inited = true; },
      // no hooks
    });
    _injectPluginHostForTests([p]);

    await warmUpPluginsForSlug(SLUG_ARGS);

    expect(inited).toBe(true);
  });
});

describe('action registry via init()', () => {
  it('registers declared actions and seals after init returns', async () => {
    const p = makePlugin({
      name: 'has-actions',
      capabilities: [],
      // PluginSDK doesn't type `actions` on Plugin, but the loader reads it.
      ...({ actions: [{ name: 'do-x' }] } as any),
      async init(ctx) {
        ctx.actions!.register('do-x', async () => ({ ok: true, result: 42 }));
      },
    });
    _injectPluginHostForTests([p]);

    const r = await invokePluginAction({
      pluginName: 'has-actions',
      actionName: 'do-x',
      ...SLUG_ARGS,
    });

    expect(r.ok).toBe(true);
    expect(r.result).toBe(42);
  });

  it('rejects registering an undeclared action', async () => {
    let initError: any = null;
    const p = makePlugin({
      name: 'undeclared',
      ...({ actions: [{ name: 'declared' }] } as any),
      async init(ctx) {
        try {
          ctx.actions!.register('undeclared-action', async () => ({ ok: true }));
        } catch (e: any) {
          initError = e;
        }
      },
    });
    _injectPluginHostForTests([p]);

    await warmUpPluginsForSlug(SLUG_ARGS);
    expect(initError).toBeTruthy();
    expect(String(initError?.message)).toMatch(/not declared/);
  });

  it('returns "not loaded" envelope when plugin is unknown', async () => {
    _injectPluginHostForTests([]);
    const r = await invokePluginAction({
      pluginName: 'ghost',
      actionName: 'any',
      ...SLUG_ARGS,
    });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/not loaded/);
  });
});

describe('ctx.spawn capability gating', () => {
  it('rejects path-bearing bins before checking capabilities', async () => {
    let captured: any = null;
    const p = makePlugin({
      name: 'spawn-tester',
      capabilities: ['compute:exec:echo'],
      async init(ctx) {
        try { await ctx.spawn!('/bin/echo', []); } catch (e: any) { captured = e; }
      },
    });
    _injectPluginHostForTests([p]);
    await warmUpPluginsForSlug(SLUG_ARGS);
    expect(String(captured?.message)).toMatch(/must be a basename/);
  });

  it('rejects when the cap is missing', async () => {
    let captured: any = null;
    const p = makePlugin({
      name: 'no-cap',
      capabilities: [],
      async init(ctx) {
        try { await ctx.spawn!('echo', []); } catch (e: any) { captured = e; }
      },
    });
    _injectPluginHostForTests([p]);
    await warmUpPluginsForSlug(SLUG_ARGS);
    expect(String(captured?.message)).toMatch(/missing capability "compute:exec:echo"/);
  });

  it('runs an allowed binary and captures stdout', async () => {
    let result: any = null;
    const p = makePlugin({
      name: 'echo-runner',
      capabilities: ['compute:exec:echo'],
      async init(ctx) {
        result = await ctx.spawn!('echo', ['hello-from-test']);
      },
    });
    _injectPluginHostForTests([p]);
    await warmUpPluginsForSlug(SLUG_ARGS);

    expect(result).toBeTruthy();
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('hello-from-test');
    expect(result.killed).toBe(false);
  });

  it('honors prefix-wildcard cap (compute:exec:ec*)', async () => {
    let result: any = null;
    const p = makePlugin({
      name: 'wildcard-tester',
      capabilities: ['compute:exec:ec*'],
      async init(ctx) {
        result = await ctx.spawn!('echo', ['wildcard-ok']);
      },
    });
    _injectPluginHostForTests([p]);
    await warmUpPluginsForSlug(SLUG_ARGS);
    expect(result?.code).toBe(0);
  });
});

describe('firePluginEvent (free-form bus)', () => {
  it('returns without error even when no plugin subscribes', async () => {
    _injectPluginHostForTests([]);
    await firePluginEvent('arbitrary.event', { x: 1 });
    // No assertion needed — this just must not throw.
  });
});

describe('pluginHostStatus', () => {
  it('reports loaded count + initialized pairs', async () => {
    const p = makePlugin({
      name: 'status-tester',
      hooks: { async beforeMissionStart() {} },
    });
    _injectPluginHostForTests([p]);

    const before = await pluginHostStatus();
    expect(before.loaded).toBe(1);
    expect(before.initializedPairs).toEqual([]);

    await firePluginLifecycle('beforeMissionStart', SLUG_ARGS);

    const after = await pluginHostStatus();
    expect(after.initializedPairs).toContain('status-tester::test-harness');
  });
});

describe('_resetPluginHostForTests clears require.cache', () => {
  it('drops cached entries under ~/.papercusp/global-plugins/', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');

    // Place a fake plugin under the real ~/.papercusp/global-plugins dir
    // (test cleans it up). The reset path resolves symlinks and clears
    // matching require.cache entries — we verify by populating require.cache
    // with a key inside the global-plugins tree and checking it's gone.
    const pluginsDir = path.join(os.homedir(), '.papercusp', 'global-plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    const fixtureDir = fs.mkdtempSync(path.join(pluginsDir, '__cache_clear_test_'));
    const fakeEntry = path.join(fixtureDir, 'fake.js');
    fs.writeFileSync(fakeEntry, 'module.exports = { marker: 1 };');

    try {
      // Force Node to require + cache it.
      const realFakeEntry = fs.realpathSync(fakeEntry);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require(realFakeEntry);
      expect(require.cache[realFakeEntry]).toBeDefined();

      _resetPluginHostForTests();

      expect(require.cache[realFakeEntry]).toBeUndefined();
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it('does not touch unrelated require.cache entries', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');

    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-cache-'));
    const fakeEntry = path.join(outsideDir, 'outside.js');
    fs.writeFileSync(fakeEntry, 'module.exports = { marker: 2 };');

    try {
      const realFakeEntry = fs.realpathSync(fakeEntry);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require(realFakeEntry);
      expect(require.cache[realFakeEntry]).toBeDefined();

      _resetPluginHostForTests();

      // Unrelated entries should survive the reset.
      expect(require.cache[realFakeEntry]).toBeDefined();
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
