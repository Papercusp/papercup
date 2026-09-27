// @vitest-environment jsdom
/**
 * use-su-launch-options — WI-6321.
 *
 * Covers the part the launcher tests stub out: turning psu's options endpoint
 * payload into picker rows, and staying usable when that endpoint is unavailable.
 * `normalizeAccountChoices` is pure, so it is tested directly rather than through
 * a rendered component.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { normalizeAccountChoices, normalizeOmpCatalog, useIdentityLaunchCatalog } from './use-su-launch-options';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; cleanup(); });

describe('identity launch catalog', () => {
  it('loads successive source pages without losing earlier installed choices', async () => {
    const first = { status: 'ok', identities: [{ id: 'one', tier: 'installed', version: '1.0.0',
      sourceRevision: 'a'.repeat(64), slots: [{ slot: 'domain', cardinality: 'exclusive' }] }],
      unreadable: [], nextAfter: 'one' };
    const second = { status: 'ok', identities: [{ id: 'two', tier: 'installed', version: '2.0.0',
      sourceRevision: 'b'.repeat(64), slots: [{ slot: 'domain', cardinality: 'exclusive' }] }],
      unreadable: [{ id: 'broken', error: 'attestation-missing' }], nextAfter: null };
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(first)).mockResolvedValueOnce(Response.json(second));
    globalThis.fetch = fetch as typeof globalThis.fetch;
    const { result } = renderHook(() => useIdentityLaunchCatalog());
    await waitFor(() => expect(result.current.identities.map((entry) => entry.id)).toEqual(['one']));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.identities.map((entry) => entry.id)).toEqual(['one', 'two']));
    expect(result.current.unreadable).toEqual([{ id: 'broken', error: 'attestation-missing' }]);
    expect(result.current.nextAfter).toBeNull();
    expect(String(fetch.mock.calls[1]?.[0])).toContain('after=one');
  });
});

describe('normalizeAccountChoices (WI-6321)', () => {
  it('accepts the bare-array shape', () => {
    expect(normalizeAccountChoices([{ id: 'a1', label: 'One' }])).toEqual([
      { id: 'a1', label: 'One', detail: null },
    ]);
  });

  it("accepts psu's { pool: [...] } shape — the form promptAccount receives", () => {
    // Both shapes appear across the account-routing work; assuming one would make
    // the whole picker vanish against the other.
    expect(normalizeAccountChoices({ pool: [{ id: 'a2' }] }).map((a) => a.id)).toEqual(['a2']);
  });

  it('preserves measured and unknown pool states from the shared psu options response', () => {
    expect(normalizeAccountChoices({
      pool: ['used', 'stale', 'fresh'],
      accountStates: { used: 'unavailable', stale: 'unknown', fresh: 'available' },
    })).toEqual([
      { id: 'used', availability: 'unavailable' },
      { id: 'stale', availability: 'unknown' },
      { id: 'fresh', availability: 'available' },
    ]);
  });

  it('accepts plain string ids', () => {
    expect(normalizeAccountChoices(['a3']).map((a) => a.id)).toEqual(['a3']);
  });

  it('takes `value` as the id when `id` is absent', () => {
    expect(normalizeAccountChoices([{ value: 'a4' }]).map((a) => a.id)).toEqual(['a4']);
  });

  it('drops rows with no resolvable id rather than rendering a blank option', () => {
    expect(normalizeAccountChoices([{ label: 'nameless' }, { id: 'ok' }]).map((a) => a.id)).toEqual([
      'ok',
    ]);
  });

  it('degrades to an empty list for a missing/unexpected payload, never throwing', () => {
    // Fail-soft is the contract: a launcher that will not open because the pool
    // list came back odd is worse than one offering just the default account.
    expect(normalizeAccountChoices(undefined)).toEqual([]);
    expect(normalizeAccountChoices(null)).toEqual([]);
    expect(normalizeAccountChoices('nonsense')).toEqual([]);
    expect(normalizeAccountChoices({ unexpected: true })).toEqual([]);
  });
});

const OMP_MODEL = {
  provider: 'openai-codex',
  id: 'gpt-5.6-terra',
  selector: 'openai-codex/gpt-5.6-terra',
  name: 'GPT-5.6-Terra',
  contextWindow: 200_000,
  maxTokens: 128_000,
  reasoning: true,
  thinking: ['low', 'medium', 'high', 'xhigh', 'max'],
  input: ['text', 'image'],
  cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
};

describe('normalizeOmpCatalog', () => {
  it('preserves exact provider/id selector and launch metadata', () => {
    expect(normalizeOmpCatalog({ status: 'available', models: [OMP_MODEL] })).toEqual({
      status: 'available',
      availability: 'enabled-configured',
      credentials: 'unchecked',
      upstream: 'unchecked',
      models: [OMP_MODEL],
      error: null,
    });
  });

  it('preserves OMP dynamic-router cost sentinels', () => {
    const dynamicRouter = {
      ...OMP_MODEL,
      provider: 'openrouter',
      id: 'openrouter/auto',
      selector: 'openrouter/openrouter/auto',
      name: 'Auto Router',
      cost: { input: -1_000_000, output: -1_000_000, cacheRead: 0, cacheWrite: 0 },
    };

    expect(normalizeOmpCatalog({ status: 'available', models: [dynamicRouter] })).toMatchObject({
      status: 'available',
      models: [dynamicRouter],
      error: null,
    });
  });

  it('keeps unavailable distinct from an available empty catalog', () => {
    expect(normalizeOmpCatalog({ status: 'unavailable', models: [], error: 'omp missing' })).toMatchObject({
      status: 'unavailable',
      models: [],
      error: 'omp missing',
    });
    expect(normalizeOmpCatalog({ status: 'available', models: [] })).toMatchObject({
      status: 'available',
      models: [],
      error: null,
    });
  });

  it('fails closed instead of repairing a mismatched selector', () => {
    expect(normalizeOmpCatalog({
      status: 'available',
      models: [{ ...OMP_MODEL, selector: 'openai-codex/not-terra' }],
    })).toMatchObject({
      status: 'unavailable',
      models: [],
      error: 'Invalid OMP model metadata',
    });
  });
});
