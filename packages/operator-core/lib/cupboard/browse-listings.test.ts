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
