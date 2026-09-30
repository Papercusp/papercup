import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./base-url', () => ({
  resolveCupboardBaseUrl: () => 'https://cupboard.test',
}));

import { browseCupboardListings } from './browse-listings';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

describe('browseCupboardListings pagination envelope', () => {
  it('preserves exact summary metadata and the opaque next cursor', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      results: [{ id: 'deep', listing_kind: 'app' }],
      next_cursor: 'v1:50:deep',
      total: 123,
      kind_facets: { harness: 100, app: 23 },
    }))) as unknown as typeof fetch;

    const result = await browseCupboardListings({ kind: 'app', limit: 100 });
    expect(result).toEqual({
      ok: true,
      listings: [{ id: 'deep', listing_kind: 'app' }],
      next_cursor: 'v1:50:deep',
      total: 123,
      kind_facets: { harness: 100, app: 23 },
    });
  });

  it('keeps summary evidence unknown when a legacy worker omits it', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      harnesses: [{ id: 'legacy' }],
    }))) as unknown as typeof fetch;

    expect(await browseCupboardListings({})).toEqual({
      ok: true,
      listings: [{ id: 'legacy' }],
    });
  });
});

describe('browseCupboardListings catalog filters (migration 018 / P-008)', () => {
  function captureUrl(): { calls: string[]; fetch: typeof fetch } {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: unknown) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ results: [] }));
    }) as unknown as typeof fetch;
    return { calls, fetch: fetchImpl };
  }

  it('passes every catalog axis through as its route query param', async () => {
    const { calls, fetch: fetchImpl } = captureUrl();
    global.fetch = fetchImpl;

    await browseCupboardListings({
      kind: 'app',
      visibility: 'private',
      tenant: 'pot-a',
      pricing: 'per-use',
      paid: true,
      platform: 'linux-x86_64',
      runtime: 'node>=22',
      permission: 'fs:read',
    });

    const url = new URL(calls[0]!);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      kind: 'app',
      limit: '50',
      visibility: 'private',
      tenant: 'pot-a',
      pricing: 'per-use',
      paid: '1',
      platform: 'linux-x86_64',
      runtime: 'node>=22',
      permission: 'fs:read',
    });
  });

  it("sends no catalog param when a filter is omitted or set to 'all'", async () => {
    const { calls, fetch: fetchImpl } = captureUrl();
    global.fetch = fetchImpl;

    await browseCupboardListings({ visibility: 'all', pricing: 'all' });

    const url = new URL(calls[0]!);
    expect(Object.fromEntries(url.searchParams)).toEqual({ limit: '50' });
  });

  it('distinguishes paid:false from an omitted paid filter', async () => {
    const { calls, fetch: fetchImpl } = captureUrl();
    global.fetch = fetchImpl;

    await browseCupboardListings({ paid: false });
    expect(new URL(calls[0]!).searchParams.get('paid')).toBe('0');

    await browseCupboardListings({});
    expect(new URL(calls[1]!).searchParams.has('paid')).toBe(false);
  });

  it('degrades FAIL-CLOSED to empty when a pre-018 worker rejects a filter we sent', async () => {
    // The caller asked to NARROW. A worker with no `visibility` column cannot,
    // so answering with the unfiltered page would return exactly the rows they
    // filtered out. Empty is the only safe answer.
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'invalid_field', field: 'visibility' }), { status: 400 }),
    ) as unknown as typeof fetch;

    expect(await browseCupboardListings({ visibility: 'private' })).toEqual({
      ok: true,
      listings: [],
    });
  });

  it('does NOT degrade on a rejection naming a filter this call never sent', async () => {
    // Otherwise any unrelated 400 that happens to name a catalog field would be
    // silently rendered as "no matches", hiding a real server error.
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'invalid_field', field: 'platform' }), { status: 400 }),
    ) as unknown as typeof fetch;

    expect(await browseCupboardListings({ visibility: 'private' })).toEqual({
      ok: false,
      status: 400,
      error: 'cupboard_http_400',
    });
  });

  it('keeps a non-catalog 400 an error rather than an empty result', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'invalid_field', field: 'cursor' }), { status: 400 }),
    ) as unknown as typeof fetch;

    expect(await browseCupboardListings({ cursor: 'bogus', platform: 'linux-x86_64' })).toEqual({
      ok: false,
      status: 400,
      error: 'cupboard_http_400',
    });
  });
});

describe('browseCupboardListings blueprint facet (worker migrations 009/035)', () => {
  const identity = { id: 'id-1', listing_kind: 'blueprint', blueprint_kind: 'identity' };
  const hive = { id: 'hive-1', listing_kind: 'blueprint', blueprint_kind: 'hive' };
  const plugin = { id: 'plug-1', listing_kind: 'plugin', blueprint_kind: null };

  it('sends ?blueprint_kind= and keeps the summary of a worker that applied it', async () => {
    const calls: string[] = [];
    global.fetch = vi.fn(async (input: unknown) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ results: [identity], total: 1, kind_facets: { blueprint: 1 } }));
    }) as unknown as typeof fetch;

    expect(await browseCupboardListings({ blueprintKind: 'identity' })).toEqual({
      ok: true,
      listings: [identity],
      total: 1,
      kind_facets: { blueprint: 1 },
    });
    expect(new URL(calls[0]).searchParams.get('blueprint_kind')).toBe('identity');
  });

  it('narrows FAIL-CLOSED when an older worker ignores the param, withholding its unfiltered summary', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ results: [identity, hive, plugin], total: 3, kind_facets: { blueprint: 2, plugin: 1 } })),
    ) as unknown as typeof fetch;

    expect(await browseCupboardListings({ blueprintKind: 'identity' })).toEqual({ ok: true, listings: [identity] });
  });

  it('degrades to empty when a worker rejects the facet value it predates', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'invalid_field', field: 'blueprint_kind' }), { status: 400 }),
    ) as unknown as typeof fetch;

    expect(await browseCupboardListings({ blueprintKind: 'identity' })).toEqual({ ok: true, listings: [] });
    // Without the facet in the request the same rejection is a real error.
    expect(await browseCupboardListings({})).toEqual({ ok: false, status: 400, error: 'cupboard_http_400' });
  });
});
