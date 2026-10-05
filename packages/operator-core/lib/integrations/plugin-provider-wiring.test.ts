/**
 * Plugin host ⇄ provider registry lifecycle (generalized-integrations-google-
 * migration-cupboard-workflows-2026-10-05, D-006 / P-001).
 *
 * Load registers a plugin's provider; re-discovery re-registers without a
 * duplicate collision; a refused adapter is reported, not thrown; daemon
 * providers are deferred to the daemon bridge; every unload path (the host
 * reset) removes the plugin's providers from the process-wide registry.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { LoadedPlugin } from '@papercusp/plugin-loader';
import type { Plugin, ProviderAdapter, ProviderDescriptor } from '@papercusp/plugin-sdk';
import {
  _injectPluginHostForTests,
  _resetPluginHostForTests,
  registerPluginProviders,
  unregisterPluginProviders,
  type ProviderRegistrationFailure,
} from '../plugin-host-runtime';
import { createProviderRegistry, providerRegistry } from './provider-registry';

function descriptor(id: string): ProviderDescriptor {
  return {
    id,
    contractVersion: 1,
    datatypes: ['calendar-event'],
    capabilities: ['calendar.read'],
    egressHosts: ['calendar.example.com'],
  };
}

function adapter(d: ProviderDescriptor): ProviderAdapter {
  return {
    describe: () => d,
    syncPage: async () => ({ records: [], nextCursor: null, hasMore: false }),
    invoke: async () => ({ ok: true }),
  };
}

function loaded(
  name: string,
  opts: { provider?: ProviderDescriptor; adapter?: unknown; runtime?: 'js' | 'daemon' | 'wasm' } = {},
): LoadedPlugin {
  const plugin = {
    name,
    version: '0.1.0',
    papercusp: '^0.1.0',
    capabilities: [],
    providerAdapter: opts.adapter,
  } as unknown as Plugin;
  return {
    plugin,
    path: `/tmp/${name}`,
    source: 'global',
    runtime: { kind: opts.runtime ?? 'js' } as LoadedPlugin['runtime'],
    provider: opts.provider,
  };
}

afterEach(() => {
  _resetPluginHostForTests();
  providerRegistry().clear();
});

describe('registerPluginProviders', () => {
  it('registers a js provider and ignores plugins without one', async () => {
    const registry = createProviderRegistry();
    const d = descriptor('fixture-cal');
    const errors: ProviderRegistrationFailure[] = [];
    const ids = await registerPluginProviders(
      [loaded('plain'), loaded('cal', { provider: d, adapter: adapter(d) })],
      (e) => errors.push(e),
      registry,
    );
    expect(ids).toEqual(['fixture-cal']);
    expect(errors).toEqual([]);
    expect(registry.get('fixture-cal')?.pluginName).toBe('cal');
    expect(registry.forDatatype('calendar-event').map((p) => p.descriptor.id)).toEqual(['fixture-cal']);
  });

  it('re-discovery re-registers the same plugin without a duplicate-provider refusal', async () => {
    const registry = createProviderRegistry();
    const d = descriptor('fixture-cal');
    const lp = loaded('cal', { provider: d, adapter: adapter(d) });
    const errors: ProviderRegistrationFailure[] = [];
    await registerPluginProviders([lp], (e) => errors.push(e), registry);
    await registerPluginProviders([lp], (e) => errors.push(e), registry);
    expect(errors).toEqual([]);
    expect(registry.list()).toHaveLength(1);
  });

  it('reports a second plugin claiming a taken provider id as duplicate-provider', async () => {
    const registry = createProviderRegistry();
    const d = descriptor('fixture-cal');
    const errors: ProviderRegistrationFailure[] = [];
    await registerPluginProviders(
      [loaded('cal-a', { provider: d, adapter: adapter(d) }), loaded('cal-b', { provider: d, adapter: adapter(d) })],
      (e) => errors.push(e),
      registry,
    );
    expect(errors.map((e) => [e.plugin, e.code])).toEqual([['cal-b', 'duplicate-provider']]);
    expect(registry.get('fixture-cal')?.pluginName).toBe('cal-a');
  });

  it('reports a missing adapter without throwing and leaves nothing registered', async () => {
    const registry = createProviderRegistry();
    const errors: ProviderRegistrationFailure[] = [];
    const ids = await registerPluginProviders(
      [loaded('cal', { provider: descriptor('fixture-cal') })],
      (e) => errors.push(e),
      registry,
    );
    expect(ids).toEqual([]);
    expect(errors.map((e) => e.code)).toEqual(['invalid-adapter']);
    expect(registry.list()).toEqual([]);
  });

  it('defers daemon providers to the daemon bridge and refuses wasm providers', async () => {
    const registry = createProviderRegistry();
    const errors: ProviderRegistrationFailure[] = [];
    await registerPluginProviders(
      [
        loaded('d', { provider: descriptor('fixture-daemon'), runtime: 'daemon' }),
        loaded('w', { provider: descriptor('fixture-wasm'), runtime: 'wasm' }),
      ],
      (e) => errors.push(e),
      registry,
    );
    expect(registry.list()).toEqual([]);
    expect(errors.map((e) => [e.plugin, e.code])).toEqual([['w', 'unsupported-runtime']]);
  });

  it('unregisterPluginProviders removes only the named plugins', async () => {
    const registry = createProviderRegistry();
    const a = descriptor('fixture-a');
    const b = descriptor('fixture-b');
    const lpA = loaded('a', { provider: a, adapter: adapter(a) });
    const lpB = loaded('b', { provider: b, adapter: adapter(b) });
    await registerPluginProviders([lpA, lpB], () => {}, registry);
    expect(unregisterPluginProviders([lpA], registry)).toEqual(['fixture-a']);
    expect(registry.list().map((p) => p.descriptor.id)).toEqual(['fixture-b']);
  });
});

describe('plugin host unload', () => {
  it('the host reset (every unload path) removes the loaded plugins’ providers', async () => {
    const d = descriptor('fixture-host-cal');
    const lp = loaded('host-cal', { provider: d, adapter: adapter(d) });
    _injectPluginHostForTests([lp]);
    await registerPluginProviders([lp], () => {});
    expect(providerRegistry().get('fixture-host-cal')).toBeDefined();
    _resetPluginHostForTests();
    expect(providerRegistry().get('fixture-host-cal')).toBeUndefined();
  });
});
