import { describe, expect, it } from 'vitest';
import {
  buildVerificationHealth,
  runVerificationHealth,
  VERIFICATION_HEALTH_PLANS_QUERY,
  type ContractTriageMeasure,
  type StaleAcceptanceMeasure,
  type VerificationHealth,
  type VerificationHealthPlanRow,
} from './verification-health';

const NOW = new Date('2026-10-11T00:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

const ZERO_TRIAGE: ContractTriageMeasure = { uncoveredActivePlans: 0, uncoveredActivePlansRaw: 0, closureReasonMissing: 0, triageGaps: 0, activePlansConsidered: 4 };
const ZERO_STALE: StaleAcceptanceMeasure = { staleAcceptanceSurfaced: 0, staleAcceptanceNeverSurfaced: 0, staleAcceptanceUndispositioned: 0, acceptancePlansConsidered: 7 };

function plan(over: Partial<VerificationHealthPlanRow>): VerificationHealthPlanRow {
  return {
    harness_slug: 'h', plan_slug: 'p', status: 'active', template: null, acceptance_bar_cohort: null,
    has_contract: false, forced: false, has_val_block: false, updated_at: daysAgo(1),
    active_clauses: 0, bound_clauses: 0, ...over,
  };
}

const BASE_PLANS: VerificationHealthPlanRow[] = [
  plan({ plan_slug: 'a1', acceptance_bar_cohort: 'post-epoch', has_contract: true, active_clauses: '4', bound_clauses: '1' }),
  plan({ plan_slug: 'a2', acceptance_bar_cohort: 'legacy-backfilled', has_contract: true, active_clauses: 2, bound_clauses: 2 }),
  plan({ plan_slug: 'a3' }),
  plan({ plan_slug: 'w1', status: 'awaiting-acceptance', updated_at: daysAgo(3) }),
  plan({ plan_slug: 'w2', status: 'awaiting-acceptance', updated_at: daysAgo(20) }),
  plan({ plan_slug: 's1', status: 'shipped', forced: true }),
  plan({ plan_slug: 's2', status: 'shipped' }),
  plan({ plan_slug: 'r1', template: 'rubric', status: 'active', active_clauses: 9, bound_clauses: 9 }),
];
function build(over: { plans?: VerificationHealthPlanRow[]; triage?: ContractTriageMeasure; stale?: StaleAcceptanceMeasure } = {}): VerificationHealth {
  return buildVerificationHealth({
    plans: over.plans ?? BASE_PLANS,
    triage: over.triage ?? ZERO_TRIAGE, staleAcceptance: over.stale ?? ZERO_STALE, now: NOW,
  });
}

/** Every key whose value differs between two readings (deep, by JSON). */
function changedKeys(a: VerificationHealth, b: VerificationHealth): string[] {
  return (Object.keys(a) as (keyof VerificationHealth)[]).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

describe('verification-health (P-002)', () => {
  it('computes every metric from the fixture rows', () => {
    const h = build();
    expect(h.coverageByCohort).toEqual({
      'post-epoch': { activePlans: 1, withContract: 1 },
      'legacy-backfilled': { activePlans: 1, withContract: 1 },
      none: { activePlans: 1, withContract: 0 },
    });
    expect([h.activePlans, h.activePlansWithContract]).toEqual([3, 2]);
    // the rubric row's 9 clauses are excluded
    expect([h.activeClauses, h.activeClausesEvidenceBound, h.evidenceBoundShare]).toEqual([6, 3, 0.5]);
    expect(h.awaitingAcceptancePlans).toBe(2);
    expect(h.awaitingAcceptanceAgeDays).toEqual({ d0to7: 1, d7to14: 0, d14to21: 1, d21to28: 0, d28plus: 0 });
    expect(h.forcedShips).toBe(1);
    expect([h.valBlockPlans, h.breaches, h.breachCodes]).toEqual([0, 0, []]);
  });

  // SPEC-P-002-HEALTH-CELL / AUTO-BAR-R-2 falsifier: each fixture edit moves its own metric.
  it.each([
    ['contract coverage', (p: VerificationHealthPlanRow[]) => p.map((r) => (r.plan_slug === 'a3' ? { ...r, has_contract: true } : r)), ['coverageByCohort', 'activePlansWithContract']],
    ['evidence binding', (p: VerificationHealthPlanRow[]) => p.map((r) => (r.plan_slug === 'a1' ? { ...r, bound_clauses: 2 } : r)), ['activeClausesEvidenceBound', 'evidenceBoundShare']],
    ['acceptance age', (p: VerificationHealthPlanRow[]) => p.map((r) => (r.plan_slug === 'w2' ? { ...r, updated_at: daysAgo(40) } : r)), ['awaitingAcceptanceAgeDays']],
    ['forced ship', (p: VerificationHealthPlanRow[]) => p.map((r) => (r.plan_slug === 's2' ? { ...r, forced: true } : r)), ['forcedShips']],
    ['VAL block', (p: VerificationHealthPlanRow[]) => p.map((r) => (r.plan_slug === 's2' ? { ...r, has_val_block: true } : r)), ['valBlockPlans', 'breaches', 'breachCodes']],
  ] as const)('a %s fixture edit changes exactly that metric', (_label, edit, expected) => {
    expect(changedKeys(build(), build({ plans: edit(BASE_PLANS) })).sort()).toEqual([...expected].sort());
  });

  it('passes the lane-2 triage and staleness measures through and alerts on them', () => {
    const h = build({
      triage: { uncoveredActivePlans: 2, uncoveredActivePlansRaw: 5, closureReasonMissing: 1, triageGaps: 3, activePlansConsidered: 9 },
      stale: { staleAcceptanceSurfaced: 1, staleAcceptanceNeverSurfaced: 2, staleAcceptanceUndispositioned: 3, acceptancePlansConsidered: 6 },
    });
    expect([h.uncoveredActivePlans, h.uncoveredActivePlansRaw, h.closureReasonMissing, h.triageGaps]).toEqual([2, 5, 1, 3]);
    expect([h.staleAcceptanceSurfaced, h.staleAcceptanceNeverSurfaced, h.staleAcceptanceUndispositioned]).toEqual([1, 2, 3]);
    expect(h.breachCodes).toEqual(['triageGaps', 'staleAcceptanceUndispositioned']);
    expect(h.breaches).toBe(2);
  });

  it('refuses a lane-2 measure that is not an integer instead of reporting it', () => {
    expect(() => build({ triage: { ...ZERO_TRIAGE, triageGaps: null as unknown as number } })).toThrow(/triageGaps is not an integer/);
  });

  // SPEC-P-002-VALUE-SHAPE r4: no matching plans ⇒ every count is an integer, never null,
  // EXCEPT the two D-019 probe readings, which are null because their denominator is 0.
  it('reports integer zeros, never null, when nothing matches (D-019 carve-out only)', () => {
    const h = build({
      plans: [],
      triage: { ...ZERO_TRIAGE, activePlansConsidered: 0 },
      stale: { ...ZERO_STALE, acceptancePlansConsidered: 0 },
    });
    const NULLABLE = new Set(['evidenceBoundShare', 'triageGaps', 'staleAcceptanceUndispositioned']);
    const LISTS = new Set(['breachCodes', 'unmeasuredCodes', 'measurementErrors']);
    const counts: unknown[] = [];
    const walk = (v: unknown, key: string) => {
      if (NULLABLE.has(key) || LISTS.has(key)) return;
      if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
      else counts.push(v);
    };
    walk(h, '');
    expect(counts.length).toBeGreaterThan(20);
    expect(counts.every((v) => Number.isInteger(v))).toBe(true);
    expect([h.evidenceBoundShare, h.triageGaps, h.staleAcceptanceUndispositioned]).toEqual([null, null, null]);
    expect([h.activePlansConsidered, h.acceptancePlansConsidered]).toEqual([0, 0]);
  });

  // D-019: an eq-0 probe must FAIL on a dead or misfiltered measurement, not read a passing 0.
  it('reads the probe values as null when the denominator is zero or not reported', () => {
    const zero = build({ triage: { ...ZERO_TRIAGE, activePlansConsidered: 0 }, stale: { ...ZERO_STALE, acceptancePlansConsidered: 0 } });
    expect([zero.triageGaps, zero.staleAcceptanceUndispositioned]).toEqual([null, null]);
    expect(zero.unmeasuredCodes).toEqual(['triageGaps', 'staleAcceptanceUndispositioned']);
    expect(zero.breaches).toBe(0);
    const { activePlansConsidered: _a, ...noTriageDenominator } = ZERO_TRIAGE;
    const { acceptancePlansConsidered: _b, ...noStaleDenominator } = ZERO_STALE;
    const absent = build({ triage: noTriageDenominator, stale: noStaleDenominator });
    expect([absent.triageGaps, absent.activePlansConsidered, absent.staleAcceptanceUndispositioned, absent.acceptancePlansConsidered])
      .toEqual([null, null, null, null]);
  });

  it('a legitimately empty awaiting-acceptance queue still reads 0', () => {
    const h = build();
    expect([h.triageGaps, h.staleAcceptanceUndispositioned]).toEqual([0, 0]);
    expect([h.activePlansConsidered, h.acceptancePlansConsidered]).toEqual([4, 7]);
    expect(h.unmeasuredCodes).toEqual([]);
  });

  it('a lane-2 measure that throws nulls only its own readings and is named, without blanking the rest', async () => {
    const sql = {
      async unsafe<T>(q: string): Promise<T> {
        if (q !== VERIFICATION_HEALTH_PLANS_QUERY) throw new Error(`unexpected query: ${q}`);
        return BASE_PLANS as unknown as T;
      },
    };
    const report = await runVerificationHealth(sql, { workspaceId: 'ws', now: NOW }, {
      async measureContractTriage() { throw new Error('relation contract_triage does not exist'); },
      async measureStaleAcceptance() { return ZERO_STALE; },
    });
    const h = report.health;
    expect([h.uncoveredActivePlans, h.uncoveredActivePlansRaw, h.closureReasonMissing, h.triageGaps, h.activePlansConsidered])
      .toEqual([null, null, null, null, null]);
    expect(h.measurementErrors).toEqual([{ measure: 'measureContractTriage', message: 'relation contract_triage does not exist' }]);
    expect(h.staleAcceptanceUndispositioned).toBe(0);
    expect(h.activePlans).toBe(build().activePlans);
    expect(report.assessments.verificationHealth).toBe('unmeasured');
  });

  it('ignores non-count metadata on a measure (lane 2 returns a thresholds object)', () => {
    const withMeta = { ...ZERO_STALE, thresholds: { surfaceAfterDays: 14, graceDays: 3, neverSurfacedAfterDays: 17 } };
    expect(build({ stale: withMeta }).staleAcceptanceUndispositioned).toBe(0);
  });

  it('runVerificationHealth binds the scope into its one query and the measures', async () => {
    const calls: { q: string; v: readonly unknown[] | undefined }[] = [];
    const sql = {
      async unsafe<T>(q: string, v?: readonly unknown[]): Promise<T> {
        calls.push({ q, v });
        return BASE_PLANS as unknown as T;
      },
    };
    const seen: unknown[] = [];
    const report = await runVerificationHealth(sql, { workspaceId: 'ws', now: NOW }, {
      async measureContractTriage(s, args) { seen.push(s === sql, args); return ZERO_TRIAGE; },
      async measureStaleAcceptance(s, args) { seen.push(s === sql, args); return ZERO_STALE; },
    });
    expect(calls.map((c) => [c.q === VERIFICATION_HEALTH_PLANS_QUERY, c.v])).toEqual([[true, ['ws', null]]]);
    expect(seen).toEqual([true, { workspaceId: 'ws', now: NOW }, true, { workspaceId: 'ws', now: NOW }]);
    expect(report.assessments.verificationHealth).toBe('healthy');
    expect(report.scope).toEqual({ workspaceId: 'ws', harnessSlug: null });
  });
});
