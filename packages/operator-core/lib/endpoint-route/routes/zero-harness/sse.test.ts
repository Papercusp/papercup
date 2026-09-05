import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncEvent } from '../../../sync-sse';

/**
 * Route-level cover for the client interest declaration
 * (P-006 of sse-per-client-invalidation-filtering-2026-09-04).
 *
 * The assertions deliberately stop at the boundary: what does the ROUTE hand
 * to `subscribe`? Whether a handed-over predicate then actually suppresses
 * delivery is the BUS's contract, proven against the real bus in
 * libs/generic/sync/src/server/invalidation-bus.test.ts. Re-deciding it here
 * against a mock would only test a re-implementation of the thing under test.
 */

type SubscribeOpts = { filter?: (e: SyncEvent) => boolean } | undefined;

const subscribeMock = vi.fn(
  async (_send: (e: SyncEvent) => void, _opts?: SubscribeOpts) => ({
    send: () => {},
    close: () => {},
  }),
);

vi.mock('../../../sync-sse', () => ({
  subscribe: (send: (e: SyncEvent) => void, opts?: SubscribeOpts) => subscribeMock(send, opts),
  backfillSince: () => [],
}));

/**
 * Captured `sseResponse` options, so the test can drive `setup` itself.
 *
 * Recorded into an ARRAY rather than a `let x: T | null`: TS cannot see the
 * assignment inside the mock closure, so after `x = null` it narrows the later
 * read to `never` and the `.setup` access stops compiling. `at(-1)` yields a
 * plain `T | undefined` with no narrowing to fight.
 */
type CapturedSse = { setup: (sink: unknown) => Promise<void> };
const sseCalls: CapturedSse[] = [];

vi.mock('@papercusp/sse', () => ({
  // Read lazily at call time, so module hoisting is not a problem.
  sseResponse: (opts: CapturedSse) => {
    sseCalls.push(opts);
    return new Response('stream');
  },
  parseLastEventId: () => null,
}));

vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  defineTool: (input: unknown) => input,
}));

type SseRoute = { handler: (req: Request) => Promise<Response> };

/** Open the stream at `url` and return the opts the route passed to subscribe. */
async function optsForUrl(url: string): Promise<SubscribeOpts> {
  const mod = await import('./sse');
  const route = mod.default as unknown as SseRoute;

  sseCalls.length = 0;
  await route.handler(new Request(url));
  const captured = sseCalls.at(-1);
  if (!captured) throw new Error('sseResponse was never called — route wiring changed');

  // The mocked sseResponse never runs `setup` on its own; drive it the way the
  // real helper does, so the route's actual subscribe() call is exercised.
  await captured.setup({ closed: false, event: () => {}, onClose: () => {} });

  const call = subscribeMock.mock.calls.at(-1);
  if (!call) throw new Error('subscribe was never called');
  return call[1];
}

function ev(name: string): SyncEvent {
  return { id: 1, name, ts: 1000 } as SyncEvent;
}

beforeEach(() => {
  subscribeMock.mockClear();
  vi.resetModules();
});

describe('zero-harness/sse — client interest declaration', () => {
  it('an UNDECLARED client subscribes with no filter and so still receives every event', async () => {
    // The backward-compatibility guarantee: an un-upgraded client, or one that
    // simply has not declared yet, must be indistinguishable from today.
    expect(await optsForUrl('http://x/api/zero-harness/sse')).toBeUndefined();
  });

  it('a declared client subscribes with a predicate matching exactly its names', async () => {
    const opts = await optsForUrl('http://x/api/zero-harness/sse?queries=plans.items,work.items');
    expect(opts?.filter).toBeTypeOf('function');
    expect(opts?.filter?.(ev('plans.items'))).toBe(true);
    expect(opts?.filter?.(ev('work.items'))).toBe(true);
    expect(opts?.filter?.(ev('something.else'))).toBe(false);
  });

  it('an EMPTY declaration means "unfiltered", never "send nothing"', async () => {
    // Read as an empty allow-list this would starve the client completely, and
    // the symptom — a UI that never updates — looks like a dead connection
    // rather than a filter bug. D-002 resolves it to today's behaviour.
    expect(await optsForUrl('http://x/api/zero-harness/sse?queries=')).toBeUndefined();
    expect(await optsForUrl('http://x/api/zero-harness/sse?queries=,,%20,')).toBeUndefined();
  });

  it('other params (token, lastEventId) do not disturb the declaration', async () => {
    const opts = await optsForUrl('http://x/api/zero-harness/sse?token=abc&queries=plans.items');
    expect(opts?.filter?.(ev('plans.items'))).toBe(true);
    expect(opts?.filter?.(ev('other'))).toBe(false);
  });
});

describe('interestFilterFor — the fail-open parse table', () => {
  async function filterFor(url: string) {
    return (await import('./sse')).interestFilterFor(url);
  }

  it('returns undefined for every ambiguous input (D-002)', async () => {
    expect(await filterFor('http://x/sse')).toBeUndefined(); // absent
    expect(await filterFor('http://x/sse?queries=')).toBeUndefined(); // empty
    expect(await filterFor('http://x/sse?queries=%20%20')).toBeUndefined(); // whitespace only
    expect(await filterFor('not a url at all')).toBeUndefined(); // unparseable
  });

  it('trims and de-duplicates declared names', async () => {
    const f = await filterFor('http://x/sse?queries=%20a%20,a,%20b%20');
    expect(f?.(ev('a'))).toBe(true);
    expect(f?.(ev('b'))).toBe(true);
    expect(f?.(ev('c'))).toBe(false);
  });

  it('an over-cap declaration falls back to unfiltered rather than TRUNCATING', async () => {
    // Truncating would silently starve whichever names fell off the end —
    // exactly the failure the cap is meant to avoid. Falling back to no filter
    // is merely today's behaviour, which is always safe.
    const mod = await import('./sse');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tooMany = Array.from({ length: mod.MAX_DECLARED_QUERY_NAMES + 1 }, (_, i) => `q${i}`);
    expect(mod.interestFilterFor(`http://x/sse?queries=${tooMany.join(',')}`)).toBeUndefined();

    // The crossing is VISIBLE. Every fail-open case delivers the same observable
    // behaviour — full fan-out — so without this the one case where the client
    // ASKED for filtering and silently did not get it is indistinguishable from
    // a client that never asked, and from the feature being switched off.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/OVER CAP/);
    warn.mockRestore();

    // Calibration: one fewer name is under the cap and DOES produce a filter,
    // so the assertion above is about the cap and not about a broken URL.
    const atCap = tooMany.slice(0, mod.MAX_DECLARED_QUERY_NAMES);
    expect(mod.interestFilterFor(`http://x/sse?queries=${atCap.join(',')}`)).toBeTypeOf('function');
  });
});

describe('interest declaration observability — the fail-open cases are distinguishable', () => {
  /**
   * Every fail-open disposition produces the SAME observable stream behaviour:
   * full fan-out. So from the outside, a client that asked for filtering and
   * silently did not get it looks exactly like a client that never asked, and
   * exactly like the feature being off. The counters are the only place that
   * difference is recorded — which is what makes the reversion reportable
   * rather than merely survivable.
   */
  async function mod() {
    return await import('./sse');
  }

  beforeEach(async () => {
    (await mod()).resetInterestObservations();
  });

  it('separates over-cap from absent, empty and unreadable', async () => {
    const m = await mod();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tooMany = Array.from({ length: m.MAX_DECLARED_QUERY_NAMES + 1 }, (_, i) => `q${i}`);

    m.interestDeclarationFor('http://x/sse'); // absent
    m.interestDeclarationFor('http://x/sse?queries='); // empty
    m.interestDeclarationFor('not a url at all'); // unreadable
    m.interestDeclarationFor('http://x/sse?queries=a,b'); // declared
    m.interestDeclarationFor(`http://x/sse?queries=${tooMany.join(',')}`); // over-cap

    const { counts, lastOverCap } = m.interestObservations();
    expect(counts).toEqual({
      absent: 1,
      empty: 1,
      unreadable: 1,
      declared: 1,
      'over-cap': 1,
    });
    expect(lastOverCap?.declaredCount).toBe(m.MAX_DECLARED_QUERY_NAMES + 1);
    warn.mockRestore();
  });

  it('reports the disposition that matches the filter actually applied', async () => {
    const m = await mod();

    // The recorded reason and the delivered behaviour come from ONE resolution,
    // so they cannot drift into saying different things about one connection.
    const declared = m.interestDeclarationFor('http://x/sse?queries=a,b');
    expect(declared.disposition).toBe('declared');
    expect(declared.failsOpen).toBe(false);
    expect(m.interestFilterFor('http://x/sse?queries=a,b')).toBeTypeOf('function');

    m.resetInterestObservations();
    const absent = m.interestDeclarationFor('http://x/sse');
    expect(absent.disposition).toBe('absent');
    expect(absent.failsOpen).toBe(true);
    expect(m.interestFilterFor('http://x/sse')).toBeUndefined();
  });

  it('a reset actually clears — otherwise every count above is cumulative noise', async () => {
    const m = await mod();
    m.interestDeclarationFor('http://x/sse');
    expect(m.interestObservations().counts.absent).toBeGreaterThan(0); // positive control
    m.resetInterestObservations();
    expect(m.interestObservations().counts.absent).toBe(0);
  });
});
