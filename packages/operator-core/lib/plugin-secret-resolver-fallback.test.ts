/**
 * plugin-secret-resolver-fallback.test.ts — the PG-OUTAGE fallback branch of
 * makeSecretResolver (revive-plugin-system-2026-06-04 D-004) that
 * plugin-spawn-impl.test.ts explicitly SKIPPED (see its NOTE: a throwing
 * loadPluginConfig mock was thought to trip vitest-fail-on-console).
 *
 * The resolver's contract under a config-store outage: `loadPluginConfig`
 * rejecting (PG down) OR throwing synchronously (e.g. the dynamic import itself
 * failing) must be caught and the resolver must fall back to `process.env` —
 * never crash, never leak the error. This file covers exactly that branch; the
 * value paths (config-beats-env, no-key, empty, memoize-success) stay in the
 * sibling plugin-spawn-impl.test.ts.
 *
 * No PG: `./plugin-configs-pg` is mocked, so this is a pure unit test.
 *
 * Test-harness note (why this file was skippable before): a `vi.fn` that is
 * configured to reject in a test body AFTER a `beforeEach` `mockReset()` makes
 * Vitest flag the SUT-caught rejection as an *unhandled* rejection, even though
 * the resolver's try/catch genuinely swallows it (verified: the resolver returns
 * the env value). The fix is to reset + configure the mock INSIDE each test
 * (never across the beforeEach boundary) — then the only reference to the
 * rejected promise is the one the SUT awaits and catches.
 *
 * Run: cd packages/operator-core && npx vitest run lib/plugin-secret-resolver-fallback.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// makeSecretResolver dynamically imports './plugin-configs-pg' — mock it so we
// can drive the loader into both failure shapes (async reject + sync throw).
const loadPluginConfigMock = vi.hoisted(() =>
  vi.fn<(harness: string, plugin: string) => Promise<Record<string, unknown> | null>>(),
);
vi.mock('./plugin-configs-pg', () => ({ loadPluginConfig: loadPluginConfigMock }));

import { makeSecretResolver } from './plugin-spawn-impl';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('makeSecretResolver — PG-outage fallback (D-004 catch branch)', () => {
  it('falls back to process.env when loadPluginConfig REJECTS (PG down)', async () => {
    // Suppress console: the SUT swallows the failure, but vitest-fail-on-console
    // is strict — guard the one path that could surface an error log.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('D004_OUTAGE_KEY', 'from-env');
    loadPluginConfigMock.mockReset();
    loadPluginConfigMock.mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:5432'));

    const resolve = makeSecretResolver({ harnessSlug: 'sheets', pluginName: '@papercupai/firecrawl-bridge' });
    await expect(resolve('D004_OUTAGE_KEY')).resolves.toBe('from-env');
    expect(loadPluginConfigMock).toHaveBeenCalledWith('sheets', '@papercupai/firecrawl-bridge');
    errSpy.mockRestore();
  });

  it('returns null (not throw) when loadPluginConfig rejects and env also lacks the key', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    loadPluginConfigMock.mockReset();
    loadPluginConfigMock.mockRejectedValue(new Error('PG outage'));

    const resolve = makeSecretResolver({ harnessSlug: 'sheets', pluginName: 'p' });
    await expect(resolve('NEVER_SET_OUTAGE_VAR')).resolves.toBeNull();
    errSpy.mockRestore();
  });

  it('falls back to process.env when loadPluginConfig THROWS synchronously', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('D004_SYNC_THROW_KEY', 'env-value');
    loadPluginConfigMock.mockReset();
    loadPluginConfigMock.mockImplementation(() => {
      throw new Error('synchronous boom (e.g. module-init failure)');
    });

    const resolve = makeSecretResolver({ harnessSlug: 'sheets', pluginName: 'p' });
    await expect(resolve('D004_SYNC_THROW_KEY')).resolves.toBe('env-value');
    errSpy.mockRestore();
  });

  it('memoizes a failed config load — a second read does NOT re-hit the failing store', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('D004_MEMO_A', 'a');
    vi.stubEnv('D004_MEMO_B', 'b');
    loadPluginConfigMock.mockReset();
    loadPluginConfigMock.mockRejectedValue(new Error('PG down'));

    const resolve = makeSecretResolver({ harnessSlug: 'sheets', pluginName: 'p' });
    expect(await resolve('D004_MEMO_A')).toBe('a');
    expect(await resolve('D004_MEMO_B')).toBe('b');
    // The cfgPromise is memoized; the failing loader is invoked exactly once.
    expect(loadPluginConfigMock).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });
});
