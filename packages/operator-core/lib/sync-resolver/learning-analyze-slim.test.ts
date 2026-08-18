// learning.analyze summary-slim + learning.analyzeCycle on-demand (P-007,
// precompute-sync-reads-phase2). learning.analyze now ships lightweight cycle
// SUMMARIES (counts + verdicts + spend, no full artifact arrays); the panel
// fetches ONE cycle's full ideas/scored/proposals via learning.analyzeCycle when
// its disclosure expands. PG seam is an injected Sql, stubbed like
// learning-scout-read.test.ts — no DB runs.

import { describe, it, expect } from 'vitest';
import type { Sql } from 'postgres';
import { readAnalyzeSnapshot, readAnalyzeCycle } from './learning-analyze-read';
import { knownQueryNamesV2 } from './index';

type Handler = () => Promise<Array<Record<string, unknown>>>;

function fakeSql(opts: { artifacts?: Handler; ticks?: Handler; routed?: Handler }): Sql {
  const fn = (strings: TemplateStringsArray | unknown, ..._vals: unknown[]) => {
    // sql(cycleIds) list-helper form: called with a plain array, not a template.
    if (!Array.isArray((strings as TemplateStringsArray)?.raw)) return [] as unknown;
    const text = (strings as TemplateStringsArray).join(' ');
    if (text.includes('scout_cycle_stage_artifacts')) return (opts.artifacts ?? (async () => []))();
    if (text.includes('scout_ticks')) return (opts.ticks ?? (async () => []))();
    if (text.includes('scout_routed_ideas')) return (opts.routed ?? (async () => []))();
    return Promise.resolve([]);
  };
  return fn as unknown as Sql;
}

const ART_ROW = {
  cycle_id: 'cyc-1',
  created_at: new Date('2026-07-19T00:00:00Z'),
  ideas: [{ id: 'i1' }, { id: 'i2' }, { id: 'i3' }],
  scored: [
    { id: 'i1', verdict: 'keep', notes: 'X'.repeat(400) },
    { id: 'i2', verdict: 'moonshot', notes: 'Y'.repeat(400) },
    { id: 'i3', verdict: 'reject', notes: 'Z'.repeat(400) },
  ],
  proposals: [{ id: 'p1' }, { id: 'p2' }],
  ideator_slots: [{ lens: 'risk', ok: true, raw: 5, produced: 3 }],
};

describe('learning.analyze P-007 (summary-slim + analyzeCycle detail)', () => {
  it('registers both query names', () => {
    const names = knownQueryNamesV2();
    expect(names).toContain('learning.analyze');
    expect(names).toContain('learning.analyzeCycle');
  });

  it('readAnalyzeSnapshot ships COUNTS + verdicts, NOT the heavy artifact arrays', async () => {
    const sql = fakeSql({
      artifacts: async () => [ART_ROW],
      routed: async () => [{ cycle_id: 'cyc-1', idea_id: 'cyc-1:p1', rail: 'plan', routed_ref: 'F-1', title: 't' }],
    });
    const snap = await readAnalyzeSnapshot(sql, 'ws');
    expect(snap.cycles).toHaveLength(1);
    const c = snap.cycles[0];
    expect(c.cycleId).toBe('cyc-1');
    expect(c.ideasCount).toBe(3);
    expect(c.proposalsCount).toBe(2);
    expect(c.routedCount).toBe(1);
    expect(c.verdicts).toEqual(['keep', 'moonshot', 'reject']);
    // The heavy arrays must NOT be present on the wire summary.
    expect((c as unknown as Record<string, unknown>).ideas).toBeUndefined();
    expect((c as unknown as Record<string, unknown>).scored).toBeUndefined();
    expect((c as unknown as Record<string, unknown>).proposals).toBeUndefined();
  });

  it('readAnalyzeCycle returns the FULL single-cycle artifacts (with scored notes)', async () => {
    const sql = fakeSql({ artifacts: async () => [ART_ROW] });
    const cycle = await readAnalyzeCycle(sql, 'ws', 'cyc-1');
    expect(cycle).not.toBeNull();
    expect(cycle!.ideas).toHaveLength(3);
    expect(cycle!.proposals).toHaveLength(2);
    expect(cycle!.scored[0].verdict).toBe('keep');
    expect((cycle!.scored[0] as unknown as { notes: string }).notes.length).toBe(400);
    expect(cycle!.ideatorSlots).toHaveLength(1);
  });

  it('readAnalyzeCycle returns null when the cycle is absent', async () => {
    const sql = fakeSql({ artifacts: async () => [] });
    expect(await readAnalyzeCycle(sql, 'ws', 'nope')).toBeNull();
  });
});

// ── WI-39823: the read deadline ────────────────────────────────────────────
//
// Both Analyze reads fan out over `Promise.all` after their primary artifacts
// read. Each enrichment leg already tolerated a THROW (warn + empty map) — the
// gap was a leg that HANGS, which `Promise.all` waits on regardless, taking an
// otherwise-successful read past the sync layer's ~10s resolver timeout.
//
// `readAnalyzeCycle` is the sharper case and the reason the timeout must NOT be
// swallowed into its `null`: the consumer renders `!cycle` as "Loading cycle
// artifacts…", so returning null on a timeout is a permanent spinner — the same
// shape as the owner-reported "Loading retained items… forever". Propagating
// instead reaches the resolver's `degraded(…)`, which says the read failed.
//
// Controls are PERMANENT and tier-1 (CLAUDE.md): the "wrong implementation" is
// the real function with its budget widened past firing, which is a real,
// production-reachable branch rather than a copy that can rot.
describe('learning.analyze — read deadline (WI-39823)', () => {
  /** Never settles — a wedged store, not a failing one. */
  const hang = (): Promise<Array<Record<string, unknown>>> => new Promise(() => {});

  type Settled<T> = { kind: 'resolved'; value: T } | { kind: 'rejected'; message: string } | { kind: 'pending' };

  /** "Never settled" has to be an assertable OUTCOME, not a vitest timeout. */
  const settleWithin = <T>(p: Promise<T>, ms: number): Promise<Settled<T>> =>
    Promise.race([
      p.then(
        (value): Settled<T> => ({ kind: 'resolved', value }),
        (error): Settled<T> => ({ kind: 'rejected', message: String((error as Error)?.message ?? error) }),
      ),
      new Promise<Settled<T>>((resolve) => {
        const t = setTimeout(() => resolve({ kind: 'pending' }), ms);
        (t as unknown as { unref?: () => void }).unref?.();
      }),
    ]);

  it('snapshot: a hung ENRICHMENT leg still ships the cycles, minus that leg', async () => {
    const sql = fakeSql({ artifacts: async () => [ART_ROW], ticks: hang });

    const outcome = await settleWithin(readAnalyzeSnapshot(sql, 'ws', { budgetMs: 25 }), 500);

    // The partial IS the point: the artifacts read already succeeded, so losing
    // the economics must not cost the cycles it had in hand.
    expect(outcome.kind).toBe('resolved');
    if (outcome.kind !== 'resolved') return;
    expect(outcome.value.cycles).toHaveLength(1);
    expect(outcome.value.cycles[0].cycleId).toBe('cyc-1');
    expect(outcome.value.cycles[0].tick).toBeNull();
  });

  it('CONTROL: the same hung leg NEVER settles when the bound is widened — so it is the deadline doing the work', async () => {
    const sql = fakeSql({ artifacts: async () => [ART_ROW], ticks: hang });

    const outcome = await settleWithin(readAnalyzeSnapshot(sql, 'ws', { budgetMs: 10_000_000 }), 120);

    expect(outcome.kind).toBe('pending');
  });

  it('analyzeCycle: a hung PRIMARY read rejects — it must never degrade to the null the consumer renders as a spinner', async () => {
    const sql = fakeSql({ artifacts: hang });

    const outcome = await settleWithin(readAnalyzeCycle(sql, 'ws', 'cyc-1', { budgetMs: 25 }), 500);

    expect(outcome.kind).toBe('rejected');
    expect(outcome.kind === 'rejected' && outcome.message).toContain(
      'analyze-cycle artifacts exceeded the read budget',
    );
  });

  it('CONTROL: that same hung primary read NEVER settles with the bound widened', async () => {
    const sql = fakeSql({ artifacts: hang });

    const outcome = await settleWithin(readAnalyzeCycle(sql, 'ws', 'cyc-1', { budgetMs: 10_000_000 }), 120);

    expect(outcome.kind).toBe('pending');
  });

  it('CALIBRATION: healthy reads are unaffected by the same tight budget', async () => {
    // Guards the opposite failure — a bound that "passes" the tests above by
    // breaking every read. Also pins that a MISSING cycle still yields null
    // (absent is not the same as timed out, and only one of them is an error).
    const sql = fakeSql({ artifacts: async () => [ART_ROW] });

    const snap = await readAnalyzeSnapshot(sql, 'ws', { budgetMs: 25 });
    expect(snap.cycles).toHaveLength(1);

    const cycle = await readAnalyzeCycle(sql, 'ws', 'cyc-1', { budgetMs: 25 });
    expect(cycle).not.toBeNull();
    expect(cycle!.ideas).toHaveLength(3);

    const absent = await readAnalyzeCycle(fakeSql({ artifacts: async () => [] }), 'ws', 'nope', { budgetMs: 25 });
    expect(absent).toBeNull();
  });
});
