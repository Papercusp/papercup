/**
 * GET /api/harness/search — P-018 of semantic-search-fingerprint-coverage-2026-08-03.
 *
 * These pin the two properties the migration is ABOUT, both of which are
 * silently losable by a later edit that still typechecks and still passes the
 * conformance census:
 *
 *  1. The retired `messages` corpus stays unreachable, and says so. An empty
 *     200 would read as "no matching messages" rather than "that corpus is
 *     gone" — the one wrong conclusion available at this endpoint (D-029).
 *  2. The delegation passes NO `harness` filter. Cross-harness is this route's
 *     entire reason to exist, and to `searchWorkItems` that is expressed by an
 *     ABSENT key — so a well-meaning edit adding a scope would narrow the
 *     route to one harness while every other assertion here still passed.
 *
 * `searchWorkItems` is mocked because what is under test is the routing and
 * the shape of the delegation, not the engine. That the route genuinely
 * reaches the engine AND the P-017 floor is derived independently from the
 * real import graph by `search/search-surface-conformance.test.ts`, so this
 * mock cannot launder that claim.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const searchWorkItems = vi.fn();
vi.mock('../../../work-items', () => ({
  searchWorkItems: (...args: unknown[]) => searchWorkItems(...args),
}));

import route from './search';

const call = (qs: string): Promise<Response> =>
  (route as unknown as { handler: (req: Request) => Promise<Response> }).handler(
    new Request(`http://127.0.0.1:3070/api/harness/search${qs}`),
  );

const okResult = {
  items: [
    {
      id: 'F-1',
      kind: 'chunk',
      family: 'feature',
      harness: 'oddsmith',
      title: 'a chunk',
      summary: 'body text',
      state: 'open',
    },
  ],
  legs: { degraded: false },
  applied: { minScore: 0.45 },
};

beforeEach(() => {
  searchWorkItems.mockReset();
  searchWorkItems.mockResolvedValue(okResult);
});

describe('GET /api/harness/search — query validation', () => {
  it('rejects a missing or too-short q with 400', async () => {
    expect((await call('')).status).toBe(400);
    expect((await call('?q=')).status).toBe(400);
    expect((await call('?q=a')).status).toBe(400);
    expect(searchWorkItems).not.toHaveBeenCalled();
  });

  it('rejects an over-long q with 400', async () => {
    expect((await call(`?q=${'x'.repeat(201)}`)).status).toBe(400);
    expect(searchWorkItems).not.toHaveBeenCalled();
  });

  it('rejects an unknown kind with 400', async () => {
    expect((await call('?q=test&kind=bananas')).status).toBe(400);
    expect(searchWorkItems).not.toHaveBeenCalled();
  });
});

describe('GET /api/harness/search — the retired messages corpus', () => {
  it('answers kind=messages with 410 Gone, naming the retirement and where the traffic went', async () => {
    const res = await call('?q=test&kind=messages');
    expect(res.status).toBe(410);

    const body = (await res.json()) as { error: string };
    // Naming WI-6097 is the point: a caller must be able to find out WHY
    // rather than concluding the corpus is merely empty.
    expect(body.error).toContain('WI-6097');
    expect(body.error).toContain('coord:send');

    // The retired corpus must not be reachable by any path, including a
    // fall-through into the feature search.
    expect(searchWorkItems).not.toHaveBeenCalled();
  });
});

describe('GET /api/harness/search — delegation to the shared engine', () => {
  it('searches the whole feature family CROSS-HARNESS (no harness filter)', async () => {
    await call('?q=widget');

    expect(searchWorkItems).toHaveBeenCalledTimes(1);
    const [query, opts] = searchWorkItems.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toBe('widget');
    expect(opts.family).toBe('feature');
    // THE CROSS-HARNESS ASSERTION: absence of the key is what means
    // "every harness" — asserted explicitly because a narrowing edit would
    // otherwise be invisible to every other test in this file.
    expect('harness' in opts).toBe(false);
  });

  it('defaults to the features corpus, and treats kind=all as the same thing', async () => {
    await call('?q=widget');
    expect((searchWorkItems.mock.calls[0] as [string, { family: string }])[1].family).toBe('feature');

    searchWorkItems.mockClear();
    const res = await call('?q=widget&kind=all');
    expect(res.status).toBe(200);
    expect(searchWorkItems).toHaveBeenCalledTimes(1);
  });

  it('clamps limit into 1..200 and passes it through', async () => {
    await call('?q=widget&limit=9999');
    expect((searchWorkItems.mock.calls[0] as [string, { limit: number }])[1].limit).toBe(200);

    searchWorkItems.mockClear();
    await call('?q=widget&limit=0');
    expect((searchWorkItems.mock.calls[0] as [string, { limit: number }])[1].limit).toBe(1);

    // A non-numeric limit falls back to the DEFAULT, not to 1 and not to NaN.
    // The obvious clamp — `Math.min(200, Math.max(1, Number(x)))` — returns
    // NaN for this input, because both Math.max and Math.min propagate it.
    // The pre-P-018 route had exactly that bug and passed NaN into `LIMIT`;
    // this case exists so the sanitisation cannot silently regress to it.
    searchWorkItems.mockClear();
    await call('?q=widget&limit=notanumber');
    expect((searchWorkItems.mock.calls[0] as [string, { limit: number }])[1].limit).toBe(20);

    // A fractional limit must not reach the engine as a float.
    searchWorkItems.mockClear();
    await call('?q=widget&limit=7.9');
    expect((searchWorkItems.mock.calls[0] as [string, { limit: number }])[1].limit).toBe(7);
  });

  it('maps engine items onto the hit shape and RETURNS legs', async () => {
    const res = await call('?q=widget');
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      featureHits: Array<Record<string, unknown>>;
      legs: unknown;
      messageHits?: unknown;
    };
    expect(body.featureHits).toEqual([
      {
        kind: 'feature',
        harness_slug: 'oddsmith',
        feature_id: 'F-1',
        item_kind: 'chunk',
        title: 'a chunk',
        summary: 'body text',
        status: 'open',
      },
    ]);

    // `legs` is returned rather than discarded so a caller can tell a DEGRADED
    // search from a genuine absence — the confusion this whole plan exists to
    // remove.
    expect(body.legs).toEqual({ degraded: false });
    // The retired half leaves no vestigial key behind.
    expect(body.messageHits).toBeUndefined();
  });
});
