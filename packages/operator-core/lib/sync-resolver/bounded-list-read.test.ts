import { describe, it, expect, vi } from 'vitest';

/**
 * bounded-list-read — the shared rows+count deadline (WI-39825).
 *
 * Every case HANGS a leg rather than rejecting it, because a hang is the failure
 * the hand-written copies of this fan-out could not survive and a rejection is
 * the one they already could. `Promise.all` waits for the slowest, so a wedged
 * COUNT — the leg the view can perfectly well live without — took the whole list
 * past the sync layer's `RESOLVER_READ_TIMEOUT_MS` and the panel rendered
 * nothing.
 *
 * This suite is the reason the fan-out is a helper and not three extractions:
 * proving a deadline fires means MOVING it, `budgetMs` is a parameter on
 * `readBoundedList`, and every call site inherits the proof instead of needing
 * its own. CONTROL and CALIBRATION are PERMANENT per CLAUDE.md's falsifiability
 * tiers — the deliberately-wrong version lives here as a control rather than
 * being produced by mutating the tree.
 */

import { readBoundedList, LIST_READ_BUDGET_MS } from './bounded-list-read';
import { readListMeta } from './list-meta';

/** A store read that never settles — the wedge, not a rejection. */
const hang = () => new Promise<never>(() => {});

type Row = { id: string };
type Settled =
  | { kind: 'resolved'; rows: Row[] }
  | { kind: 'rejected'; message: string }
  | { kind: 'pending' };

/**
 * Observe WITHOUT waiting forever. "Never settles" is the failure mode under
 * test, so it has to be an assertable OUTCOME (`pending`) rather than a vitest
 * timeout — a timeout would report the control as a broken test instead of as
 * the guard discriminating correctly.
 */
const settleWithin = (p: Promise<Row[]>, ms: number): Promise<Settled> =>
  Promise.race([
    p.then(
      (rows): Settled => ({ kind: 'resolved', rows }),
      (error): Settled => ({ kind: 'rejected', message: String((error as Error)?.message ?? error) }),
    ),
    new Promise<Settled>((resolve) => {
      const t = setTimeout(() => resolve({ kind: 'pending' }), ms);
      (t as unknown as { unref?: () => void }).unref?.();
    }),
  ]);

const read = (
  budgetMs: number,
  legs: { rows?: Promise<Row[]>; count?: Promise<number | null> } = {},
) =>
  readBoundedList<Row>({
    rows: legs.rows ?? Promise.resolve([{ id: 'r1' }]),
    count: legs.count ?? Promise.resolve(42),
    label: 'testList',
    budgetMs,
  });

describe('readBoundedList — the shared rows+count deadline (WI-39825)', () => {
  it('the shipped budget sits under the resolver timeout it exists to beat', async () => {
    // Not a tautology: a budget at or above RESOLVER_READ_TIMEOUT_MS cannot
    // prevent the timeout, so the bound would be decorative. The relationship is
    // the invariant, and it is the one a later "just bump the budget" breaks.
    const { RESOLVER_READ_TIMEOUT_MS } = await import('./read-deadline');
    expect(LIST_READ_BUDGET_MS).toBeLessThan(RESOLVER_READ_TIMEOUT_MS);
  });

  it('a hung ROWS leg is REJECTED at the budget instead of hanging the read', async () => {
    const outcome = await settleWithin(read(25, { rows: hang() }), 500);

    expect(outcome.kind).toBe('rejected');
    // The label is the point: a bare timeout hides WHICH leg wedged.
    expect(outcome.kind === 'rejected' && outcome.message).toContain(
      'testList rows exceeded the read budget',
    );
  });

  it('CONTROL: the same hung leg NEVER settles when the bound is widened — so it is the deadline doing the work', async () => {
    // The deliberately-wrong version: a budget so large it cannot fire, which IS
    // the pre-WI-39825 behaviour. If this ever reports anything but `pending`,
    // the case above has stopped measuring the deadline and passes for some
    // other reason.
    const outcome = await settleWithin(read(10_000_000, { rows: hang() }), 120);

    expect(outcome.kind).toBe('pending');
  });

  it('CALIBRATION: a healthy read still returns its rows AND the true total under the same tight budget', async () => {
    // Guards the opposite failure: a bound that "passes" every case above by
    // breaking every read, healthy or not. Same 25ms budget, working store.
    const outcome = await settleWithin(read(25), 500);

    expect(outcome.kind).toBe('resolved');
    const rows = outcome.kind === 'resolved' ? outcome.rows : [];
    expect(rows.map((r) => r.id)).toEqual(['r1']);
    expect(readListMeta(rows)?.total).toBe(42);
    // A healthy read carries no degraded marker at all — its ABSENCE is what
    // tells the client the total can be trusted.
    expect(readListMeta(rows)?.totalUnavailable).toBeUndefined();
  });

  // The count leg is the whole reason this helper is careful. `readListTotal()`
  // falls back to the PAGE LENGTH when no total is carried, and the hand-written
  // copies coded that fallback themselves (`totalRows[0]?.n ?? rows.length`) — so
  // a failed count rendered as a CONFIDENT WRONG TOTAL equal to the window size,
  // indistinguishable from a store that really holds exactly that many.
  for (const [mode, countLeg] of [
    ['hung', () => hang() as Promise<number>],
    ['rejecting', () => Promise.reject(new Error('count query blew up'))],
  ] as const) {
    it(`a ${mode} COUNT leg still ships the rows, flagged totalUnavailable`, async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const outcome = await settleWithin(
        read(25, { rows: Promise.resolve([{ id: 'r1' }, { id: 'r2' }]), count: countLeg() }),
        500,
      );
      warn.mockRestore();

      expect(outcome.kind).toBe('resolved');
      const rows = outcome.kind === 'resolved' ? outcome.rows : [];
      // The rows are TRUE, not sacrificed to the leg nobody was waiting on.
      expect(rows.map((r) => r.id)).toEqual(['r1', 'r2']);
      const meta = readListMeta(rows);
      expect(meta?.totalUnavailable).toBe(true);
      // THE REGRESSION THIS EXISTS FOR: no total at all, and specifically NOT the
      // page length. A `total: 2` here is the confident-wrong-answer the flag
      // replaced, and it would pass every other assertion in this file.
      expect(meta?.total).toBeUndefined();
      expect(meta?.total).not.toBe(rows.length);
    });
  }

  it('a deliberate null count is reported as unavailable, not as zero', async () => {
    // `null` is the caller saying "there is no total here", which is a different
    // claim from `0`. Rendering it as 0 would assert an empty store.
    const outcome = await settleWithin(read(25, { count: Promise.resolve(null) }), 500);

    const rows = outcome.kind === 'resolved' ? outcome.rows : [];
    expect(readListMeta(rows)?.totalUnavailable).toBe(true);
    expect(readListMeta(rows)?.total).toBeUndefined();
  });

  it('a count of 0 is carried as a REAL total, not mistaken for a missing one', async () => {
    // The falsy-vs-nullish trap: `total ?? unavailable` is right and
    // `total || unavailable` is wrong, and only a genuine 0 tells them apart.
    // An empty-but-healthy store must read as "0 of 0", not "unknown".
    const outcome = await settleWithin(
      read(25, { rows: Promise.resolve([{ id: 'r1' }]), count: Promise.resolve(0) }),
      500,
    );

    const rows = outcome.kind === 'resolved' ? outcome.rows : [];
    expect(readListMeta(rows)?.total).toBe(0);
    expect(readListMeta(rows)?.totalUnavailable).toBeUndefined();
  });
});
