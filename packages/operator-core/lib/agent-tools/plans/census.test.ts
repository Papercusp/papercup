/**
 * plans:census (plan-portfolio-flow-and-weight-2026-11-13 P-001): the on-demand read and the
 * labelled-run recorder, over an in-memory plan store and an in-memory results ledger.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { RubricCheckResult } from '../../check-results-ledger';
import {
  CENSUS_MEASURE_IDS, PLAN_LINE_HOLD_BY,
  type CensusKey, type CensusPlanRow, type CensusPlanStore,
} from '../../plan-portfolio/census';
import { censusPopulationSnapshotRef, type CensusRunLabel, type CensusRunRow } from '../../plan-portfolio/census-instruments';
import { planCensus, type PlanCensusDeps } from './census';

const SCOPE = { workspaceId: 'ws-1', harnessSlug: 'papercusp' };
const DAY_MS = 24 * 60 * 60_000;

/** A plan with one workable item that only the plan-line hold keeps unclaimable. */
function heldOnlyPlan(planSlug: string, status: string): CensusPlanRow {
  return {
    harnessSlug: 'papercusp', planSlug, status, archived: false, template: null,
    createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-14T00:00:00.000Z',
    contentChars: 1_000, decisionCount: 2, hasReadinessBlock: false, hasEmbedding: true,
    items: [{ id: 'P-001', status: 'todo', blockedBy: [] }],
    workItems: [{ planLineId: 'P-001', status: 'open', held: false, claimHold: true, claimHoldBy: PLAN_LINE_HOLD_BY, lane: null }],
  };
}

function storeOf(plans: CensusPlanRow[]): CensusPlanStore {
  const sorted = [...plans].sort((x, y) => (x.planSlug < y.planSlug ? -1 : 1));
  const after = (cursor: CensusKey | null) => sorted.filter((plan) => !cursor || plan.planSlug > cursor.planSlug);
  return {
    readPlans: async ({ after: cursor, limit }) => after(cursor).slice(0, limit),
    countPlansAfter: async (cursor) => after(cursor).length,
    readNearTwinPairs: async () => [],
  };
}

/** The results ledger as the tool uses it: append-only rows, read back as the latest per measure and label. */
function fixture() {
  const rows: Array<{ id: number; result: RubricCheckResult }> = [];
  const snapshots = new Map<string, string>();
  let clock = Date.parse('2026-11-15T14:00:00.000Z');
  const deps: PlanCensusDeps = {
    store: storeOf([heldOnlyPlan('a', 'ready'), heldOnlyPlan('b', 'active'), heldOnlyPlan('c', 'draft')]),
    now: () => clock,
    saveSnapshot: async content => {
      const sha256 = createHash('sha256').update(content).digest('hex');
      const relPath = `immutable/sha256/${sha256}.json`;
      snapshots.set(relPath, content);
      return { harnessSlug: 'papercusp', sha256, relPath };
    },
    recordResults: async (results) => results.map((result) => {
      rows.push({ id: rows.length + 1, result });
      return rows.length;
    }),
    readRunRows: async (label: CensusRunLabel) => {
      const latest = new Map<string, CensusRunRow>();
      for (const { id, result } of rows) {
        if (result.check.subject?.ref !== label || result.check.value === null || result.check.value === undefined) continue;
        latest.set(result.check.criterionKey, {
          testRunId: id, finishedAt: result.measuredAt ?? '',
          definitionSha256: result.check.provenance?.procedure.sha256 ?? null,
          populationSnapshot: censusPopulationSnapshotRef(result.check.provenance),
        });
      }
      return latest;
    },
  };
  return { deps, rows, snapshots, advance: (ms: number) => { clock += ms; } };
}

describe('plans:census (P-001)', () => {
  it('reads the nine measures on demand and records nothing', async () => {
    const { deps, rows } = fixture();
    const out = await planCensus(SCOPE, deps);
    if (!out.ok) throw new Error(out.error);

    expect(out.mode).toBe('read');
    expect(out.measures.map((measure) => measure.id)).toEqual([...CENSUS_MEASURE_IDS]);
    expect(out.omitted).toBe(0);
    expect(out.plansRead).toBe(3);
    // Two of the three plans are ready or active; the draft plan's item does not count.
    expect(out.heldOnlyWorkableItems.count).toBe(2);
    expect(out.pairing).toMatchObject({ paired: 0, baselineMeasures: 0, finalMeasures: 0 });
    expect(out.pairing.lacking.map((entry) => entry.reason)).toEqual(CENSUS_MEASURE_IDS.map(() => 'no-baseline-run'));
    expect(rows).toHaveLength(0);
  });

  it('records a baseline once, then pairs it with a later final run under one definition', async () => {
    const { deps, rows, advance } = fixture();

    const baseline = await planCensus({ ...SCOPE, record: 'baseline' }, deps);
    if (!baseline.ok) throw new Error(baseline.error);
    expect(baseline).toMatchObject({ mode: 'recorded', label: 'baseline' });
    expect(baseline.testRunIds).toHaveLength(CENSUS_MEASURE_IDS.length);
    expect(rows).toHaveLength(CENSUS_MEASURE_IDS.length);
    const measured: string[] = baseline.measures.filter((measure) => measure.value !== null).map((measure) => measure.id);
    expect(measured.length).toBeGreaterThan(0);
    expect(baseline.pairing.baselineMeasures).toBe(measured.length);
    expect(baseline.pairing.lacking.filter((entry) => entry.reason === 'no-final-run').map((entry) => entry.id)).toEqual(measured);

    // A second baseline would move the comparison point: refused, and nothing is written.
    const again = await planCensus({ ...SCOPE, record: 'baseline' }, deps);
    expect(again).toMatchObject({
      ok: false, error: 'label_already_recorded', label: 'baseline', recordedMeasures: measured.length,
    });
    expect(rows).toHaveLength(CENSUS_MEASURE_IDS.length);

    advance(DAY_MS);
    const final = await planCensus({ ...SCOPE, record: 'final' }, deps);
    if (!final.ok) throw new Error(final.error);
    expect(final).toMatchObject({ mode: 'recorded', label: 'final' });
    expect(rows).toHaveLength(2 * CENSUS_MEASURE_IDS.length);
    expect(final.pairing.paired).toBe(measured.length);
    expect(final.pairing.lacking.filter((entry) => measured.includes(entry.id))).toEqual([]);
  });

  it('keeps the earlier rows when a label is recorded again with replace', async () => {
    const { deps, rows, advance } = fixture();
    await planCensus({ ...SCOPE, record: 'baseline' }, deps);
    advance(DAY_MS);
    const replaced = await planCensus({ ...SCOPE, record: 'baseline', replace: true }, deps);
    if (!replaced.ok) throw new Error(replaced.error);
    expect(replaced.mode).toBe('recorded');
    expect(rows).toHaveLength(2 * CENSUS_MEASURE_IDS.length);
  });

  for (const reverse of [false, true]) {
    it.each([199, 200, 201])('recovers exact baseline identities for %i plans, reverse=' + reverse, async count => {
      const { deps, rows, snapshots } = fixture();
      const plans = Array.from({ length: count }, (_, i) => ({
        ...heldOnlyPlan(`plan-${String(i).padStart(3, '0')}`, 'active'), revision: '12345678901234567890',
      }));
      deps.store = storeOf(reverse ? [...plans].reverse() : plans);
      const pair = { a: plans[0]!.planSlug, b: plans.at(-1)!.planSlug, similarity: 0.99 };
      deps.store.readNearTwinPairs = async () => [pair];
      const baseline = await planCensus({ ...SCOPE, record: 'baseline' }, deps);
      if (!baseline.ok) throw new Error(baseline.error);
      const ref = baseline.populationSnapshot;
      if (!ref) throw new Error('Baseline population not retained');
      const content = snapshots.get(ref.relPath)!;
      expect(createHash('sha256').update(content).digest('hex')).toBe(ref.sha256);
      const snapshot = JSON.parse(content);
      expect(snapshot).toMatchObject({ workspaceId: SCOPE.workspaceId, label: 'baseline',
        runGroupId: baseline.runGroupId, plansRead: count, omitted: 0 });
      expect(snapshot.source.plans.map((p: CensusPlanRow) => p.planSlug)).toEqual(plans.map(p => p.planSlug));
      expect(snapshot.source.plans.at(-1).revision).toBe('12345678901234567890');
      expect(snapshot.source.nearTwinPairs).toEqual([pair]);
      expect(rows.every(row => JSON.stringify(censusPopulationSnapshotRef(row.result.check.provenance)) === JSON.stringify(ref))).toBe(true);
      plans.at(-1)!.revision = '12345678901234567891';
      const reread = await planCensus(SCOPE, deps);
      if (!reread.ok) throw new Error(reread.error);
      expect(reread.populationSnapshots.baseline).toEqual({ refs: [ref], missing: [] });
      expect(snapshots.get(ref.relPath)).toBe(content);
      expect(JSON.parse(content).source.plans.at(-1).revision).toBe('12345678901234567890');
    });
  }

  it('publishes no labelled rows when immutable population retention fails', async () => {
    const { deps, rows } = fixture();
    deps.saveSnapshot = async () => { throw new Error('snapshot_write_failed'); };
    await expect(planCensus({ ...SCOPE, record: 'baseline' }, deps)).rejects.toThrow('snapshot_write_failed');
    expect(rows).toEqual([]);
  });

  it('refuses a final run before any baseline', async () => {
    const { deps, rows } = fixture();
    expect(await planCensus({ ...SCOPE, record: 'final' }, deps)).toMatchObject({ ok: false, error: 'no_baseline_run' });
    expect(rows).toHaveLength(0);
  });

  it('refuses an unresolved workspace and a harness the manifest does not record', async () => {
    const { deps } = fixture();
    expect(await planCensus({ ...SCOPE, workspaceId: '*' }, deps)).toMatchObject({ ok: false, error: 'exact_workspace_required' });
    expect(await planCensus({ ...SCOPE, workspaceId: null }, deps)).toMatchObject({ ok: false, error: 'exact_workspace_required' });
    expect(await planCensus({ ...SCOPE, harnessSlug: 'portal' }, deps)).toMatchObject({ ok: false, error: 'census_harness_only' });
  });
});
