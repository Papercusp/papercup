/**
 * resolveCupboardPluginNames — the dep-validator's only live source of "plugins
 * installable from the Cupboard" (revive-cupboard-distribution-2026-06-04 D-003 /
 * P2). The whole file was untested; the only assertions on it before were the
 * leaf snapshot-blob/publish-listing tests of its SIBLINGS. This covers:
 *
 *   - GET /listings?kind=plugin → a names set built from `listing_ref`, with a
 *     `title` fallback when a row lacks a ref;
 *   - reachable:false on a non-2xx upstream (so the caller downgrades to a warning);
 *   - reachable:false when fetch throws / times out;
 *
 * THEN the cross-module round-trip that is the point of the file: feed a real
 * /listings?kind=plugin body through resolveCupboardPluginNames and hand the
 * resulting names set in as `cupboardPlugins` to the blueprint dep-validator —
 * a declared plugin that exists in the Cupboard must land in `installable`, not
 * `missing` (the false-fail this module was built to kill).
 *
 * resolveCupboardBaseUrl is mocked to a fixed origin; fetch is stubbed. Hermetic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./base-url', () => ({
  resolveCupboardBaseUrl: () => 'https://cupboard.test',
}));

import { resolveCupboardPluginNames } from './plugin-listings';
import { validateBlueprintDependencies } from '@papercusp/blueprint-distribution';

const originalFetch = global.fetch;
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  // Belt-and-suspenders for the module mock above: another cupboard test file
  // that also `vi.mock('./base-url')` can, under a shared worker, defeat this
  // file's mock (the real resolveCupboardBaseUrl then runs and returns the
  // default cupboard.papercusp.com) — green alone, red when batched. Pinning
  // the env the REAL resolver reads makes the assertion hold either way.
  vi.stubEnv('PAPERCUSP_CUPBOARD_URL', 'https://cupboard.test');
});
afterEach(() => {
  global.fetch = originalFetch;
  vi.unstubAllEnvs();
});

function listingsBody(results: Array<{ listing_kind?: string; listing_ref?: string | null; title?: string | null }>) {
  return new Response(JSON.stringify({ results }), { status: 200 });
}

describe('resolveCupboardPluginNames', () => {
  it('GETs /listings?kind=plugin and builds the names set from listing_ref', async () => {
    fetchMock.mockResolvedValueOnce(
      listingsBody([
        { listing_kind: 'plugin', listing_ref: 'shopify-sync', title: 'Shopify Sync' },
        { listing_kind: 'plugin', listing_ref: 'stripe-pay', title: 'Stripe Pay' },
      ]),
    );

    const r = await resolveCupboardPluginNames();
    expect(r.reachable).toBe(true);
    expect([...r.names].sort()).toEqual(['shopify-sync', 'stripe-pay']);

    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toBe('https://cupboard.test/listings?kind=plugin&limit=200');
  });

  it('falls back to title only when listing_ref is null/undefined (?? semantics)', async () => {
    fetchMock.mockResolvedValueOnce(
      listingsBody([
        { listing_kind: 'plugin', listing_ref: null, title: 'Legacy Plugin' },
        // A present-but-whitespace ref is kept by `??` (not null) then trimmed to
        // '' and dropped — title does NOT rescue it. Documents the `??` (not `||`)
        // semantics so a future refactor to `||` is caught here.
        { listing_kind: 'plugin', listing_ref: '  ', title: 'Whitespace Ref Plugin' },
      ]),
    );
    const r = await resolveCupboardPluginNames();
    expect(r.reachable).toBe(true);
    expect([...r.names]).toEqual(['Legacy Plugin']);
  });

  it('tolerates a missing/empty results array', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
    const r = await resolveCupboardPluginNames();
    expect(r.reachable).toBe(true);
    expect(r.names.size).toBe(0);
  });

  it('reachable:false on a non-2xx upstream (no hard-fail on a server blip)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('upstream down', { status: 503 }));
    const r = await resolveCupboardPluginNames();
    expect(r.reachable).toBe(false);
    expect(r.names.size).toBe(0);
  });

  it('reachable:false when fetch throws / times out', async () => {
    fetchMock.mockRejectedValueOnce(new Error('AbortError: timeout'));
    const r = await resolveCupboardPluginNames();
    expect(r.reachable).toBe(false);
    expect(r.names.size).toBe(0);
  });

  it('passes a timeout signal to fetch', async () => {
    fetchMock.mockResolvedValueOnce(listingsBody([]));
    await resolveCupboardPluginNames({ timeoutMs: 1234 });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('round-trip: resolveCupboardPluginNames → validateBlueprintDependencies', () => {
  it('a Cupboard-listed plugin lands in `installable`, NOT `missing`', async () => {
    // The exact wire body the live worker returns for GET /listings?kind=plugin.
    fetchMock.mockResolvedValueOnce(
      listingsBody([
        { listing_kind: 'plugin', listing_ref: 'cupboard-plugin', title: 'Cupboard Plugin' },
      ]),
    );

    const { names } = await resolveCupboardPluginNames();

    // Wire the resolved set in as the validator's `cupboardPlugins` host set —
    // exactly the seam the dep-validator gate uses at harness:create time.
    const validation = validateBlueprintDependencies(
      { plugins: ['cupboard-plugin', 'nowhere-plugin'] },
      {
        availableTools: new Set<string>(),
        installedPlugins: new Set<string>(),
        cupboardPlugins: names,
      },
    );

    // cupboard-plugin is resolvable from the Cupboard → advisory installable,
    // does NOT block. nowhere-plugin is in neither set → hard missing.
    expect(validation.installable.plugins).toEqual(['cupboard-plugin']);
    expect(validation.missing.plugins).toEqual(['nowhere-plugin']);
    expect(validation.ok).toBe(false); // still false because nowhere-plugin is missing
  });

  it('with ONLY Cupboard-resolvable plugins, validation is ok (installable does not block)', async () => {
    fetchMock.mockResolvedValueOnce(
      listingsBody([{ listing_kind: 'plugin', listing_ref: 'cupboard-plugin', title: 'Cupboard Plugin' }]),
    );
    const { names } = await resolveCupboardPluginNames();
    const validation = validateBlueprintDependencies(
      { plugins: ['cupboard-plugin'] },
      { availableTools: new Set(), installedPlugins: new Set(), cupboardPlugins: names },
    );
    expect(validation.ok).toBe(true);
    expect(validation.installable.plugins).toEqual(['cupboard-plugin']);
    expect(validation.missing.plugins).toEqual([]);
  });

  it('an unreachable Cupboard (empty names set) makes a declared plugin hard-missing', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 502 }));
    const { names, reachable } = await resolveCupboardPluginNames();
    expect(reachable).toBe(false);

    const validation = validateBlueprintDependencies(
      { plugins: ['cupboard-plugin'] },
      { availableTools: new Set(), installedPlugins: new Set(), cupboardPlugins: names },
    );
    // With an empty resolved set the plugin is neither installed nor installable.
    expect(validation.missing.plugins).toEqual(['cupboard-plugin']);
    expect(validation.ok).toBe(false);
  });
});
