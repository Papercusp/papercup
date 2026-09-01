/**
 * P-002 — the bulk-run watchdog's rule and its sweep, tested against fakes.
 *
 * The two failures this guards are opposite in direction and both expensive:
 *
 *  - a FALSE strand abandons a resolver that was merely slow, and
 *  - a MISSED strand is the original defect (a dead resolver's items sit on
 *    `pending` forever, indistinguishable from work not yet reached).
 *
 * So every liveness state is asserted, not just the stale one, and the sweep is
 * asserted to record a strand ONLY when the guarded write actually took effect.
 */

import { describe, expect, it, vi } from 'vitest';
import type { RunLiveness } from './bulk-run-store';
import {
  decideWatchdogVerdict,
  diffCounters,
  runBulkRunWatchdog,
  strandReasonText,
  type BulkRunCounters,
  type WatchdogRunFacts,
} from './bulk-run-watchdog';

const ZERO: BulkRunCounters = { autoResolved: 0, recommended: 0, skipped: 0, failed: 0 };

function facts(over: Partial<WatchdogRunFacts> = {}): WatchdogRunFacts {
  return {
    runId: 'bulk-1',
    phase: 'running',
    liveness: { state: 'stale', ageMs: 900_000, measuredFrom: 'heartbeat' },
    undecided: 3,
    stored: { ...ZERO },
    derived: { ...ZERO },
    ...over,
  };
}

describe('decideWatchdogVerdict', () => {
  it('strands a stale executing run that still has undecided items', () => {
    const v = decideWatchdogVerdict(facts());
    expect(v.strand).toEqual({
      reason: 'stale-executing',
      undecided: 3,
      ageMs: 900_000,
      measuredFrom: 'heartbeat',
    });
  });

  it.each<[string, RunLiveness]>([
    ['live', { state: 'live', ageMs: 1_000, measuredFrom: 'heartbeat' }],
    ['not-executing (review)', { state: 'not-executing', phase: 'review' }],
    ['not-executing (complete)', { state: 'not-executing', phase: 'complete' }],
  ])('never strands a %s run — the false-strand direction', (_label, liveness) => {
    expect(decideWatchdogVerdict(facts({ liveness })).strand).toBeNull();
  });

  it('does NOT strand a stale run with nothing undecided — that is the settle path', () => {
    // Failing it here would relabel a run that finished its work as a failure,
    // and `deriveSettleOutcome` already owns the never-ran-vs-nothing-to-do rule.
    expect(decideWatchdogVerdict(facts({ undecided: 0 })).strand).toBeNull();
  });

  it('reports counter drift INDEPENDENTLY of phase — including on terminal runs', () => {
    // The measured motivating case (bulk-7d35ee41) is a run that already reached a
    // terminal phase carrying counters no write could have produced. Checking only
    // active runs would miss exactly the population where the drift is permanent.
    const v = decideWatchdogVerdict(
      facts({
        phase: 'complete',
        liveness: { state: 'not-executing', phase: 'complete' },
        stored: { autoResolved: 5, recommended: 19, skipped: 0, failed: 0 },
        derived: { ...ZERO },
      }),
    );
    expect(v.strand).toBeNull();
    expect(v.counterDrift).toEqual({
      stored: { autoResolved: 5, recommended: 19, skipped: 0, failed: 0 },
      derived: ZERO,
      fields: ['autoResolved', 'recommended'],
    });
  });

  it('reports no drift when the stored counters already match their rows', () => {
    const matched = { autoResolved: 2, recommended: 1, skipped: 0, failed: 0 };
    expect(diffCounters(matched, { ...matched })).toBeNull();
    expect(decideWatchdogVerdict(facts({ stored: matched, derived: { ...matched } })).counterDrift)
      .toBeNull();
  });

  it('a run can need BOTH a strand and a reconcile', () => {
    const v = decideWatchdogVerdict(
      facts({ stored: { ...ZERO, recommended: 4 }, derived: { ...ZERO } }),
    );
    expect(v.strand).not.toBeNull();
    expect(v.counterDrift).not.toBeNull();
  });
});

describe('strandReasonText', () => {
  it('distinguishes a resolver that never beat from one that stopped beating', () => {
    const never = strandReasonText({
      reason: 'stale-executing',
      undecided: 2,
      ageMs: 600_000,
      measuredFrom: 'start',
    });
    expect(never).toContain('never reported a heartbeat after launch');

    const stopped = strandReasonText({
      reason: 'stale-executing',
      undecided: 2,
      ageMs: 600_000,
      measuredFrom: 'heartbeat',
    });
    expect(stopped).toContain('stopped reporting');
    // Both must say how to recover; a terminal state with no next step is why an
    // owner would otherwise re-launch a whole new run and lose the decided items.
    for (const text of [never, stopped]) expect(text).toContain('restart the run');
  });
});

describe('runBulkRunWatchdog', () => {
  function deps(rows: WatchdogRunFacts[], over: Partial<Parameters<typeof runBulkRunWatchdog>[0]> = {}) {
    return {
      listRuns: vi.fn(async () => rows),
      strandRun: vi.fn(async () => ({ marked: 2 })),
      reconcileCounters: vi.fn(async () => {}),
      note: vi.fn(),
      ...over,
    };
  }

  it('strands, then reconciles — in that order, so the recompute sees the new rows', async () => {
    const order: string[] = [];
    const d = deps([facts()], {
      strandRun: vi.fn(async () => {
        order.push('strand');
        return { marked: 2 };
      }),
      reconcileCounters: vi.fn(async () => {
        order.push('reconcile');
      }),
    });
    const result = await runBulkRunWatchdog(d);
    expect(order).toEqual(['strand', 'reconcile']);
    expect(result.stranded).toEqual(['bulk-1']);
    expect(result.itemsMarked).toBe(2);
  });

  it('does NOT report a strand when the guarded write refused (marked: 0)', async () => {
    // `marked: 0` means the resolver heartbeated between the decision and the
    // write, so it won the race. Recording it as stranded would be a false
    // positive in the one direction that actually costs work.
    const d = deps([facts()], { strandRun: vi.fn(async () => ({ marked: 0 })) });
    const result = await runBulkRunWatchdog(d);
    expect(result.stranded).toEqual([]);
    expect(result.itemsMarked).toBe(0);
  });

  it('reconciles a drifted run that needs no strand', async () => {
    const d = deps([
      facts({
        liveness: { state: 'not-executing', phase: 'complete' },
        undecided: 0,
        stored: { autoResolved: 5, recommended: 19, skipped: 0, failed: 0 },
        derived: { ...ZERO },
      }),
    ]);
    const result = await runBulkRunWatchdog(d);
    expect(d.strandRun).not.toHaveBeenCalled();
    expect(result.countersReconciled).toEqual(['bulk-1']);
  });

  it('touches nothing when every run is healthy and consistent', async () => {
    const d = deps([facts({ liveness: { state: 'live', ageMs: 10, measuredFrom: 'heartbeat' } })]);
    const result = await runBulkRunWatchdog(d);
    expect(d.strandRun).not.toHaveBeenCalled();
    expect(d.reconcileCounters).not.toHaveBeenCalled();
    expect(result).toMatchObject({ examined: 1, stranded: [], countersReconciled: [] });
  });

  it('one run failing must not abort the sweep — the rest are why it exists', async () => {
    const d = deps([facts({ runId: 'bad' }), facts({ runId: 'good' })], {
      strandRun: vi.fn(async ({ runId }: { runId: string }) => {
        if (runId === 'bad') throw new Error('deadlock');
        return { marked: 1 };
      }),
    });
    const result = await runBulkRunWatchdog(d);
    expect(result.examined).toBe(2);
    expect(result.stranded).toEqual(['good']);
    expect(result.errors).toEqual([{ runId: 'bad', error: 'deadlock' }]);
  });
});
