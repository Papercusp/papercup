import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * insights-coordtokens-read — the read deadline on the coord-token fan-out
 * (WI-39825).
 *
 * Every case HANGS a leg rather than rejecting it. The three loaders are each
 * already defensive about a missing column or table, so a THROW was survivable
 * before this change; a HANG was not, and slowness is the characteristic symptom
 * of a GROUP BY / COUNT over the two highest-volume telemetry tables in the
 * system. `Promise.all` waits for the slowest, so one wedged aggregate took the
 * whole snapshot with it — and on the PRODUCER path (a 5-minute derived-read TTL,
 * the only caller that actually runs today) it could occupy a scheduled routine
 * with no resolver timeout to eventually cut it loose.
 *
 * The subject is `readCoordTokens` and not the resolver, deliberately: proving a
 * deadline fires means MOVING it, and a resolver's only input is its wire args.
 * CONTROL and CALIBRATION are PERMANENT per CLAUDE.md's falsifiability tiers.
 */

const loadModelPricingBook = vi.fn();
const loadCoordTokenBreakdown = vi.fn();
const loadCoordPollVolume = vi.fn();
vi.mock('../harness-insights/load-token-rollups', () => ({
  loadModelPricingBook: (...a: unknown[]) => loadModelPricingBook(...a),
  loadCoordTokenBreakdown: (...a: unknown[]) => loadCoordTokenBreakdown(...a),
  loadCoordPollVolume: (...a: unknown[]) => loadCoordPollVolume(...a),
}));

import { readCoordTokens, COORD_TOKENS_READ_BUDGET_MS } from './insights-coordtokens-read';

const BREAKDOWN = { windowMs: 7, byTrigger: [], triggerAttributionAvailable: false, byRoleClass: [] };
const POLL = { windowMs: 1, tools: [], wakePollCalls: 327_000, wakePollRowSharePct: 75 };

beforeEach(() => {
  loadModelPricingBook.mockReset().mockResolvedValue([{ model: 'm-1' }]);
  loadCoordTokenBreakdown.mockReset().mockResolvedValue(BREAKDOWN);
  loadCoordPollVolume.mockReset().mockResolvedValue(POLL);
});

/** A store read that never settles — the wedge, not a rejection. */
const hang = () => new Promise<never>(() => {});

type Snapshot = {
  pricingBook: unknown[];
  coordBreakdown: unknown;
  pollVolume: unknown;
  degradedFields?: Array<{ field: string; kind: string; reason: string }>;
};
type Settled =
  | { kind: 'resolved'; snapshot: Snapshot }
  | { kind: 'rejected'; message: string }
  | { kind: 'pending' };

/**
 * Observe WITHOUT waiting forever. "Never settles" is the failure mode under
 * test, so it has to be an assertable OUTCOME (`pending`) rather than a vitest
 * timeout — a timeout would report the control as a broken test instead of as
 * the guard discriminating correctly.
 */
const settleWithin = (p: Promise<unknown[]>, ms: number): Promise<Settled> =>
  Promise.race([
    p.then(
      (rows): Settled => ({ kind: 'resolved', snapshot: rows[0] as Snapshot }),
      (error): Settled => ({ kind: 'rejected', message: String((error as Error)?.message ?? error) }),
    ),
    new Promise<Settled>((resolve) => {
      const t = setTimeout(() => resolve({ kind: 'pending' }), ms);
      (t as unknown as { unref?: () => void }).unref?.();
    }),
  ]);

const runQuery = async <T>(): Promise<T[]> => [];
const read = (budgetMs: number) =>
  readCoordTokens({ runQuery: runQuery as never, workspaceId: 'ws-test', budgetMs });

describe('readCoordTokens — the read deadline (WI-39825)', () => {
  it('the shipped budget sits under the resolver timeout it exists to beat', async () => {
    // Not a tautology: a budget at or above RESOLVER_READ_TIMEOUT_MS cannot
    // prevent the timeout, so the bound would be decorative.
    const { RESOLVER_READ_TIMEOUT_MS } = await import('./read-deadline');
    expect(COORD_TOKENS_READ_BUDGET_MS).toBeLessThan(RESOLVER_READ_TIMEOUT_MS);
  });

  // PRIMARY leg. `coordBreakdown` IS the snapshot — the coord-cost rollup
  // everything else annotates — so a lapse PROPAGATES rather than shipping a
  // payload empty of the only thing it exists to carry.
  it('a hung PRIMARY leg (coordBreakdown) is REJECTED at the budget instead of hanging the read', async () => {
    loadCoordTokenBreakdown.mockReturnValue(hang());

    const outcome = await settleWithin(read(25), 500);

    expect(outcome.kind).toBe('rejected');
    // The label is the point: a bare timeout hides WHICH aggregate wedged.
    expect(outcome.kind === 'rejected' && outcome.message).toContain(
      'coordTokens coordBreakdown exceeded the read budget',
    );
  });

  it('CONTROL: the same hung leg NEVER settles when the bound is widened — so it is the deadline doing the work', async () => {
    loadCoordTokenBreakdown.mockReturnValue(hang());

    // The deliberately-wrong version: a budget so large it cannot fire, which IS
    // the pre-WI-39825 behaviour on both the read AND producer paths.
    const outcome = await settleWithin(read(10_000_000), 120);

    expect(outcome.kind).toBe('pending');
  });

  it('CALIBRATION: a healthy read still returns its snapshot under the same tight budget', async () => {
    // Guards the opposite failure: a bound that "passes" every case above by
    // breaking every read, healthy or not. Same 25ms budget, working store.
    const outcome = await settleWithin(read(25), 500);

    expect(outcome.kind).toBe('resolved');
    const snapshot = outcome.kind === 'resolved' ? outcome.snapshot : null;
    expect(snapshot?.pricingBook).toEqual([{ model: 'm-1' }]);
    expect(snapshot?.coordBreakdown).toEqual(BREAKDOWN);
    expect(snapshot?.pollVolume).toEqual(POLL);
    // A healthy snapshot stays byte-identical to what it was before the bound.
    expect(snapshot?.degradedFields).toBeUndefined();
  });

  it('a hung pricingBook leg degrades to an EMPTY rate table, named, and the breakdown still ships', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadModelPricingBook.mockReturnValue(hang());

    const outcome = await settleWithin(read(25), 500);
    warn.mockRestore();

    expect(outcome.kind).toBe('resolved');
    const snapshot = outcome.kind === 'resolved' ? outcome.snapshot : null;
    // The intact legs are TRUE, not sacrificed to the wedged one.
    expect(snapshot?.coordBreakdown).toEqual(BREAKDOWN);
    expect(snapshot?.pricingBook).toEqual([]);
    const degraded = snapshot?.degradedFields ?? [];
    expect(degraded.map((d) => d.field)).toEqual(['pricingBook']);
    expect(degraded[0]?.reason).toContain('coordTokens pricingBook exceeded the read budget');
    expect(degraded[0]?.kind).toBe('read-failed');
  });

  it('a hung pollVolume leg degrades to NULL — never to a zeroed shape asserting "no coord polls happened"', async () => {
    // THE ASYMMETRY THIS FILE EXISTS TO PIN. CoordPollVolume's fields are
    // `wakePollCalls` and `wakePollRowSharePct`, so the "obvious" synthetic empty
    // ({ tools: [], wakePollCalls: 0, ... }) would assert ZERO coordination polls
    // in the one payload whose entire purpose is quantifying that number — a
    // confident wrong answer, and one no consumer could distinguish from a real
    // quiet hour. `null` says the only true thing available: not read.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadCoordPollVolume.mockReturnValue(hang());

    const outcome = await settleWithin(read(25), 500);
    warn.mockRestore();

    expect(outcome.kind).toBe('resolved');
    const snapshot = outcome.kind === 'resolved' ? outcome.snapshot : null;
    expect(snapshot?.coordBreakdown).toEqual(BREAKDOWN);
    expect(snapshot?.pollVolume).toBeNull();
    // Specifically NOT a zeroed shape: an object here would pass a mere
    // "is it falsy-ish" check while re-introducing the false zero.
    expect(snapshot?.pollVolume).not.toEqual({
      windowMs: 0,
      tools: [],
      wakePollCalls: 0,
      wakePollRowSharePct: 0,
    });
    const degraded = snapshot?.degradedFields ?? [];
    expect(degraded.map((d) => d.field)).toEqual(['pollVolume']);
    expect(degraded[0]?.reason).toContain('coordTokens pollVolume exceeded the read budget');
  });

  it('two hung supplementary legs are BOTH named, not just the first to lose', async () => {
    // The accumulator is shared across legs, so a per-leg catch that overwrote
    // rather than pushed would silently report one casualty out of two.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadModelPricingBook.mockReturnValue(hang());
    loadCoordPollVolume.mockReturnValue(hang());

    const outcome = await settleWithin(read(25), 500);
    warn.mockRestore();

    const snapshot = outcome.kind === 'resolved' ? outcome.snapshot : null;
    expect((snapshot?.degradedFields ?? []).map((d) => d.field).sort()).toEqual([
      'pollVolume',
      'pricingBook',
    ]);
  });
});
