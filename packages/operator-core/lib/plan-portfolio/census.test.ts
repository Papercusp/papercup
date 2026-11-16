/**
 * Unit proof for plan-portfolio-flow-and-weight-2026-11-13 P-001. Each test is named after the
 * spec clause it proves. The registry clause (ITEM-P-001-registers-bar-instruments) is in
 * census-instruments.test.ts, beside the pins that need the registry's import graph.
 */
import { describe, expect, it } from 'vitest';
import {
  CENSUS_MEASURE_IDS,
  DEFAULT_CENSUS_POPULATION,
  PLAN_LINE_HOLD_BY,
  RUBRIC_TEMPLATE_NAME,
  censusManifestFingerprint,
  inCensusPopulation,
  resolveCensusManifest,
  resolveCensusPopulation,
  runPlanPortfolioCensus,
  type CensusKey,
  type CensusPlanRow,
  type CensusPlanStore,
  type CensusRun,
  type CensusWorkItemRow,
} from './census';
import {
  PLAN_PORTFOLIO_INSTRUMENT_KEYS,
  censusInstrumentResult,
  censusRunCheckResults,
  heldOnlyWorkableItemsResult,
  measuresWithoutPairedRuns,
  measuresWithoutPairedRunsResult,
  resolvePlanPortfolioInstrument,
  type CensusRunRow,
} from './census-instruments';

const NOW = Date.parse('2026-11-14T01:10:00.000Z');
const WINDOW = { workspaceId: 'ws-1', harnessSlug: 'papercusp' };

function plan(planSlug: string, over: Partial<CensusPlanRow> = {}): CensusPlanRow {
  return {
    harnessSlug: 'papercusp', planSlug, status: 'ready', archived: false, template: null,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-11-10T00:00:00.000Z',
    contentChars: 1_000, decisionCount: 2, hasReadinessBlock: false, hasEmbedding: true,
    items: [], workItems: [], ...over,
  };
}

function row(planLineId: string, over: Partial<CensusWorkItemRow> = {}): CensusWorkItemRow {
  return { planLineId, status: 'open', held: false, claimHold: true, claimHoldBy: PLAN_LINE_HOLD_BY, lane: null, ...over };
}

const keyOf = (p: CensusKey) => `${p.harnessSlug}/${p.planSlug}`;
const after = (p: CensusKey, cursor: CensusKey | null) => !cursor || p.harnessSlug > cursor.harnessSlug ||
  (p.harnessSlug === cursor.harnessSlug && p.planSlug > cursor.planSlug);

/** In-memory plan store. `reads` lists every plan handed out, in order. Pairs are returned
 * whatever slugs were asked for, so only the census itself can keep an outsider out. */
function fixtureStore(plans: CensusPlanRow[], pairs: Array<{ a: string; b: string; similarity: number }> = []) {
  const sorted = [...plans].sort((x, y) => (keyOf(x) < keyOf(y) ? -1 : 1));
  const reads: string[] = [];
  const store: CensusPlanStore = {
    readPlans: async ({ after: cursor, limit }) => {
      const rows = sorted.filter((p) => after(p, cursor)).slice(0, limit);
      reads.push(...rows.map(keyOf));
      return rows;
    },
    countPlansAfter: async (cursor) => sorted.filter((p) => after(p, cursor)).length,
    readNearTwinPairs: async ({ minSimilarity }) => pairs.filter((pair) => pair.similarity >= minSimilarity),
  };
  return { store, reads };
}

/** A ready plan with one workable item that only the plan-line hold keeps unclaimable. */
function heldOnlyPlan(planSlug: string, over: Partial<CensusPlanRow> = {}): CensusPlanRow {
  return plan(planSlug, { items: [{ id: 'P-001', status: 'todo', blockedBy: [] }], workItems: [row('P-001')], ...over });
}

const values = (run: CensusRun) => Object.fromEntries(Object.values(run.measures).map((m) => [m.id, [m.value, m.components]]));

describe('plan-portfolio census (P-001)', () => {
  it('ITEM-P-001-census-reports-every-measure: a run reports a value for each of the nine Background measures', async () => {
    // The nine rows of the plan's Background table, by measure id and row label.
    const background: Array<[string, string]> = [
      ['M-1', 'Plans created vs shipped'],
      ['M-2', 'Workable items that are held'],
      ['M-3', 'Workable items behind a claim hold'],
      ['M-4', 'Plans carrying a system-written readiness block'],
      ['M-5', 'Plans with open items and no edit in 30 days'],
      ['M-6', 'Plans with every item closed that have not shipped'],
      ['M-7', 'Plan size'],
      ['M-8', 'Decisions per plan'],
      ['M-9', 'Near-twin pairs'],
    ];
    expect(resolveCensusManifest().measures.map((entry) => [entry.id, entry.title])).toEqual(background);

    const { store } = fixtureStore([
      plan('a', { createdAt: '2026-11-05T00:00:00.000Z', hasReadinessBlock: true, contentChars: 150_000, decisionCount: 25,
        items: [{ id: 'P-001', status: 'todo', blockedBy: [] }, { id: 'P-002', status: 'wip', blockedBy: [] }],
        workItems: [row('P-001'), row('P-002', { held: true, claimHold: false, claimHoldBy: null })] }),
      plan('b', { status: 'draft', updatedAt: '2026-09-02T00:00:00.000Z', items: [{ id: 'P-001', status: 'todo', blockedBy: [] }] }),
      plan('c', { status: 'awaiting-acceptance', items: [{ id: 'P-001', status: 'done', blockedBy: [] }] }),
      plan('d', { status: 'shipped', updatedAt: '2026-11-06T00:00:00.000Z' }),
    ], [{ a: 'a', b: 'b', similarity: 0.95 }, { a: 'a', b: 'c', similarity: 0.5 }]);
    const run = await runPlanPortfolioCensus({ store, now: NOW });

    expect(Object.keys(run.measures)).toEqual([...CENSUS_MEASURE_IDS]);
    for (const id of CENSUS_MEASURE_IDS) expect(run.measures[id].value, id).not.toBeNull();
    expect(values(run)).toEqual({
      'M-1': [1, { shippedUpperBound: 1 }],
      'M-2': [1, { workable: 3 }],
      'M-3': [1, { inReadyOrActive: 1, planLineHoldOnly: 1, planLineHoldOnlyInReadyOrActive: 1, otherHold: 0, noWorkItem: 1, openUnheld: 0 }],
      'M-4': [1, { withOpenItems: 1, population: 3 }],
      'M-5': [1, { plansWithOpenItems: 2 }],
      'M-6': [1, { archived: 0, withOpenItems: 0 }],
      'M-7': [1_000, { overLarge: 1, largest: 150_000, plans: 3 }],
      'M-8': [2, { withMany: 1, largest: 25, plans: 3 }],
      'M-9': [1, { plans: 2, withoutEmbedding: 0, candidates: 3 }],
    });
    expect(censusInstrumentResult(run)).toMatchObject({ verdict: 'pass', value: 9 });
  });

  it('ITEM-P-001-measures-carry-one-manifest: every run is stamped with the fingerprint of one manifest that states six fields per measure', async () => {
    const manifest = resolveCensusManifest();
    expect(manifest.measures).toHaveLength(9);
    for (const entry of manifest.measures) {
      for (const field of ['definition', 'unit', 'countingRule', 'source'] as const) {
        expect(entry[field].trim().length, `${entry.id}.${field}`).toBeGreaterThan(0);
      }
      expect(['point-in-time', 'trailing-utc-days'], `${entry.id}.window`).toContain(entry.window.kind);
      expect(Object.keys(entry.population).sort(), `${entry.id}.population`).toEqual(['archived', 'harness', 'rubricTemplates', 'statuses']);
    }
    const fingerprint = censusManifestFingerprint(manifest);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);

    const run = await runPlanPortfolioCensus({ store: fixtureStore([plan('a'), plan('b')]).store, now: NOW });
    expect(run.manifestFingerprint).toBe(fingerprint);
    expect(run.manifestVersion).toBe(manifest.version);

    // The fingerprint covers every field: a reworded counting rule is another definition.
    const reworded = resolveCensusManifest();
    reworded.measures[4]!.countingRule += ' Reworded.';
    expect(censusManifestFingerprint(reworded)).not.toBe(fingerprint);

    // Recorded rows carry it: one definition hashes equally under both labels, another does not.
    const stamp = { startedAt: new Date(NOW).toISOString(), finishedAt: new Date(NOW + 5).toISOString() };
    const baseline = censusRunCheckResults({ run, label: 'baseline', manifest, ...stamp });
    const final = censusRunCheckResults({ run, label: 'final', manifest, ...stamp });
    const other = censusRunCheckResults({ run: { ...run, manifestFingerprint: censusManifestFingerprint(reworded) }, label: 'final', manifest: reworded, ...stamp });
    expect(baseline).toHaveLength(9);
    for (let i = 0; i < 9; i += 1) {
      const procedure = baseline[i]!.check.provenance!.procedure;
      expect(JSON.parse(procedure.snapshot).manifestFingerprint).toBe(fingerprint);
      expect(final[i]!.check.provenance!.procedure.sha256).toBe(procedure.sha256);
      expect(other[i]!.check.provenance!.procedure.sha256).not.toBe(procedure.sha256);
      expect(baseline[i]!.check.subject).toEqual({ kind: 'plan-portfolio-census-run', ref: 'baseline' });
    }
  });

  it('ITEM-P-001-manifest-default-population: an entry that names no population records the open non-archived non-template papercusp plans', async () => {
    const population = resolveCensusPopulation({});
    expect(population).toEqual({ harness: 'papercusp', statuses: 'open', archived: 'exclude', rubricTemplates: 'exclude' });
    expect(population).toEqual(DEFAULT_CENSUS_POPULATION);
    // Seven of the nine entries name none and so record the default.
    expect(resolveCensusManifest().measures.filter((entry) => JSON.stringify(entry.population) === JSON.stringify(population))
      .map((entry) => entry.id)).toEqual(['M-2', 'M-3', 'M-4', 'M-5', 'M-7', 'M-8', 'M-9']);

    const plans = [
      plan('open'),
      plan('template', { template: RUBRIC_TEMPLATE_NAME }),
      plan('archived', { archived: true }),
      plan('elsewhere', { harnessSlug: 'portal' }),
      plan('shipped', { status: 'shipped' }),
      plan('superseded', { status: 'superseded' }),
    ];
    expect(plans.filter((p) => inCensusPopulation(p, population)).map((p) => p.planSlug)).toEqual(['open']);
    const run = await runPlanPortfolioCensus({ store: fixtureStore(plans).store, now: NOW });
    expect(run.population).toEqual({ total: 1, byStatus: { ready: 1 } });
    expect(run.measures['M-7'].components.plans).toBe(1);
  });

  it('ITEM-P-001-measures-use-recorded-population: a measure counts a plan of an excluded kind only when its entry includes that kind', async () => {
    // Each outsider would move every measure if it were counted, and is a near-twin of 'normal'.
    const loud: Partial<CensusPlanRow> = {
      status: 'awaiting-acceptance', createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
      contentChars: 900_000, decisionCount: 90, hasReadinessBlock: true,
      items: [{ id: 'P-001', status: 'todo', blockedBy: [] }, { id: 'P-002', status: 'wip', blockedBy: [] }],
      workItems: [row('P-001'), row('P-002', { held: true, claimHold: false, claimHoldBy: null })],
    };
    const normal = plan('normal');
    const base = values(await runPlanPortfolioCensus({ store: fixtureStore([normal]).store, now: NOW }));
    const moved = async (outsider: CensusPlanRow) => {
      const { store } = fixtureStore([normal, outsider], [{ a: 'normal', b: outsider.planSlug, similarity: 0.99 }]);
      const withOutsider = values(await runPlanPortfolioCensus({ store, now: NOW }));
      return CENSUS_MEASURE_IDS.filter((id) => JSON.stringify(withOutsider[id]) !== JSON.stringify(base[id]));
    };

    expect(await moved(plan('template', { ...loud, template: RUBRIC_TEMPLATE_NAME }))).toEqual([]);
    expect(await moved(plan('elsewhere', { ...loud, harnessSlug: 'portal' }))).toEqual([]);
    // Only M-1 and M-6 record a population that includes archived plans.
    expect(await moved(plan('archived', { ...loud, archived: true }))).toEqual(['M-1', 'M-6']);
    // Positive control: the same plan inside the default population moves every measure.
    expect(await moved(plan('insider', loud))).toEqual([...CENSUS_MEASURE_IDS]);
  });

  it('ITEM-P-001-instruments-report-omissions: a bounded run reports the plans it left out and a cursor a follow-up run reads them from', async () => {
    const BATCH = 3;
    const population = (n: number) => Array.from({ length: n }, (_, i) => plan(`p-${i + 1}`));
    // One below, at, and one above the batch size, with one batch of work allowed.
    for (const [size, omitted] of [[BATCH - 1, 0], [BATCH, 0], [BATCH + 1, 1]] as const) {
      const { store, reads } = fixtureStore(population(size));
      const first = await runPlanPortfolioCensus({ store, now: NOW, batchSize: BATCH, maxBatches: 1 });
      expect([first.plansRead, first.omitted, first.complete], `size ${size}`).toEqual([size - omitted, omitted, omitted === 0]);
      expect(first.source.plans.map(keyOf)).toEqual(reads);
      expect(first.cursor === null, `size ${size}`).toBe(omitted === 0);
      if (!first.resume) continue;
      expect(first.cursor!.after).toEqual({ harnessSlug: 'papercusp', planSlug: `p-${BATCH}` });
      const followUp = await runPlanPortfolioCensus({ store, batchSize: BATCH, resume: first.resume });
      expect(reads.slice(first.plansRead)).toEqual([`papercusp/p-${BATCH + 1}`]);
      expect([followUp.plansRead, followUp.omitted, followUp.cursor]).toEqual([size, 0, null]);
      expect(followUp.source.plans.map(keyOf)).toEqual(population(size).map(keyOf));
    }

    // Three batches; the one plan that fails bar R-4 sits after the second batch boundary.
    const plans = [...population(6), heldOnlyPlan('p-7')];
    for (const key of [PLAN_PORTFOLIO_INSTRUMENT_KEYS.heldOnlyWorkableItems, PLAN_PORTFOLIO_INSTRUMENT_KEYS.census]) {
      const bounded = await resolvePlanPortfolioInstrument(key, WINDOW, { store: fixtureStore(plans).store, now: NOW, batchSize: BATCH, maxBatches: 2 });
      // Six of seven plans read: the reading is unknown, never a pass over a partial population.
      expect(bounded.verdict, key).toBe('unknown');
      expect(bounded.value, key).toBeUndefined();
      expect(JSON.parse(bounded.detail), key).toMatchObject({ omitted: 1, plansRead: 6, cursor: { harnessSlug: 'papercusp', planSlug: 'p-6' } });
    }
    const { store } = fixtureStore(plans);
    const first = await runPlanPortfolioCensus({ store, now: NOW, batchSize: BATCH, maxBatches: 2 });
    expect(first.heldOnlyWorkableItems.count).toBe(0);
    const followUp = await runPlanPortfolioCensus({ store, batchSize: BATCH, resume: first.resume! });
    expect(heldOnlyWorkableItemsResult(followUp)).toMatchObject({ verdict: 'fail', value: 1 });
    expect(JSON.parse(heldOnlyWorkableItemsResult(followUp).detail)).toMatchObject({ omitted: 0, cursor: null, sample: ['p-7#P-001'] });

    // The pairing instrument reads ledger rows for the nine measures and no plans.
    const pairing = await resolvePlanPortfolioInstrument(PLAN_PORTFOLIO_INSTRUMENT_KEYS.measuresWithoutPairedRuns, WINDOW,
      { readRunRows: async () => new Map() });
    expect(JSON.parse(pairing.detail)).toMatchObject({ omitted: 0, cursor: null, measuresWithoutPairedRuns: 9 });
  });

  it('ITEM-P-001-instrument-restart-reads-each-plan-once: a run restarted from its cursor reads every remaining plan once', async () => {
    const plans = [
      heldOnlyPlan('p-1'), plan('p-2', { contentChars: 5 }), plan('p-3', { decisionCount: 40 }), plan('p-4', { hasReadinessBlock: true }),
      heldOnlyPlan('p-5', { status: 'active' }), plan('p-6', { status: 'awaiting-acceptance', archived: true }), plan('p-7', { contentChars: 9 }),
    ];
    const pairs = [{ a: 'p-1', b: 'p-7', similarity: 0.93 }];
    const whole = await runPlanPortfolioCensus({ store: fixtureStore(plans, pairs).store, now: NOW, batchSize: 3 });

    const { store, reads } = fixtureStore(plans, pairs);
    const first = await runPlanPortfolioCensus({ store, now: NOW, batchSize: 3, maxBatches: 1 });
    expect([first.plansRead, first.omitted]).toEqual([3, 4]);
    const readByFirst = [...reads];
    // A later clock must not move the windows of a restarted run.
    const second = await runPlanPortfolioCensus({ store, now: NOW + 86_400_000 * 40, batchSize: 3, resume: first.resume! });
    const readBySecond = reads.slice(readByFirst.length);

    expect(readByFirst).toEqual(['papercusp/p-1', 'papercusp/p-2', 'papercusp/p-3']);
    expect(readBySecond).toEqual(['papercusp/p-4', 'papercusp/p-5', 'papercusp/p-6', 'papercusp/p-7']);
    expect([...reads].sort()).toEqual(plans.map(keyOf).sort());
    expect(new Set(reads).size).toBe(reads.length);
    expect(second.complete).toBe(true);
    expect(second.runAt).toBe(whole.runAt);
    expect(values(second)).toEqual(values(whole));
    expect(second.heldOnlyWorkableItems).toEqual(whole.heldOnlyWorkableItems);
    expect(second.source).toEqual(whole.source);
    expect(second.source.nearTwinPairs).toEqual(pairs);

    // A store that hands a plan out again is refused, not counted twice.
    const repeating: CensusPlanStore = { ...store, readPlans: async () => [plans[0]!, plans[0]!] };
    await expect(runPlanPortfolioCensus({ store: repeating, now: NOW })).rejects.toThrow('census_store_order_violation');
    // A cursor cut under another definition cannot be continued.
    const reworded = resolveCensusManifest();
    reworded.measures[0]!.definition += ' Reworded.';
    await expect(runPlanPortfolioCensus({ store, resume: first.resume!, manifest: reworded })).rejects.toThrow('census_cursor_manifest_mismatch');
  });

  it('retains intact identities over many serialized restarts and refuses legacy source gaps', async () => {
    const plans = Array.from({ length: 11 }, (_, i) => plan(`plan-${String(i).padStart(2, '0')}`, {
      revision: String(i + 1), items: [{ id: 'P-001', status: 'todo', blockedBy: [] }],
    }));
    for (const ordered of [plans, [...plans].reverse()]) {
      const { store, reads } = fixtureStore(ordered);
      let run = await runPlanPortfolioCensus({ store, now: NOW, batchSize: 2, maxBatches: 1 });
      const legacy = JSON.parse(JSON.stringify(run.resume!));
      delete legacy.partial.sourcePlans;
      await expect(runPlanPortfolioCensus({ store, resume: legacy })).rejects.toThrow('census_cursor_source_missing');
      while (run.resume) {
        expect(run.source.plans).toHaveLength(run.plansRead);
        expect(run.omitted).toBe(plans.length - run.plansRead);
        run = await runPlanPortfolioCensus({ store, batchSize: 2, maxBatches: 1,
          resume: JSON.parse(JSON.stringify(run.resume)) });
      }
      expect(reads).toEqual(plans.map(keyOf));
      expect(run.source.plans).toEqual(plans);
      expect(run.source.plans.at(-1)!.revision).toBe('11');
    }
    const run = await runPlanPortfolioCensus({ store: fixtureStore(plans).store, now: NOW });
    plans[0]!.items[0]!.status = 'done';
    expect(run.source.plans[0]!.items[0]!.status).toBe('todo');
  });

  it('ITEM-P-001-instruments-count-failing-case: each bar instrument counts a case built to fail its bar and not the near-misses', async () => {
    // Bar R-4. Two failing cases; the second proves a held row whose status is blocked is not left out.
    const failing = plan('live', {
      status: 'active',
      items: [
        { id: 'P-001', status: 'todo', blockedBy: [] },
        { id: 'P-002', status: 'wip', blockedBy: ['P-009'] },
        { id: 'P-003', status: 'todo', blockedBy: [] },   // mixed held and unheld rows
        { id: 'P-004', status: 'todo', blockedBy: [] },   // hold released
        { id: 'P-005', status: 'todo', blockedBy: [] },   // only an observation row carries the hold
        { id: 'P-006', status: 'todo', blockedBy: ['P-001'] }, // not workable: its blocker is open
        { id: 'P-007', status: 'todo', blockedBy: [] },   // held by another hold, not the plan-line one
        { id: 'P-008', status: 'todo', blockedBy: [] },   // an agent holds it
        { id: 'P-009', status: 'done', blockedBy: [] },
      ],
      workItems: [
        row('P-001'),
        row('P-002', { status: 'blocked' }),
        row('P-003'), row('P-003', { claimHold: false, claimHoldBy: null }),
        row('P-004', { claimHold: false, claimHoldBy: null }),
        row('P-005', { lane: 'observation' }),
        row('P-006'),
        row('P-007', { claimHoldBy: 'su-agent-1' }),
        row('P-008', { held: true }),
        row('P-001', { status: 'done', claimHold: false, claimHoldBy: null }), // a closed row is not an open work item
      ],
    });
    const nearMissPlan = heldOnlyPlan('parked-draft', { status: 'draft' }); // same shape, plan not ready or active
    const run = await runPlanPortfolioCensus({ store: fixtureStore([failing, nearMissPlan]).store, now: NOW });
    expect(run.heldOnlyWorkableItems).toEqual({ count: 2, sample: ['live#P-001', 'live#P-002'] });
    expect(heldOnlyWorkableItemsResult(run)).toMatchObject({ verdict: 'fail', value: 2 });
    expect(run.measures['M-3'].components).toMatchObject({ planLineHoldOnly: 3, planLineHoldOnlyInReadyOrActive: 2, otherHold: 1, noWorkItem: 1, openUnheld: 2 });
    const cleared = await runPlanPortfolioCensus({ store: fixtureStore([nearMissPlan,
      plan('live', { ...failing, workItems: failing.workItems.filter((w) => !['P-001', 'P-002'].includes(w.planLineId)) })]).store, now: NOW });
    expect(heldOnlyWorkableItemsResult(cleared)).toMatchObject({ verdict: 'pass', value: 0 });

    // Bar R-6. One definition under both labels pairs; a final run under another definition does not.
    const ids = resolveCensusManifest().measures.map((entry) => entry.id);
    const rows = (sha: string, finishedAt: string) => new Map<string, CensusRunRow>(ids.map((id, i) => [id, { testRunId: i + 1, finishedAt, definitionSha256: `${sha}-${id}` }]));
    const baseline = rows('def-1', '2026-11-15T13:00:00.000Z');
    const final = rows('def-1', '2026-12-01T09:00:00.000Z');
    expect(measuresWithoutPairedRunsResult(measuresWithoutPairedRuns({ measureIds: ids, baseline, final }))).toMatchObject({ verdict: 'pass', value: 0 });

    const redefined = new Map(final).set('M-3', { ...final.get('M-3')!, definitionSha256: 'def-2-M-3' });
    const missingFinal = new Map(redefined); missingFinal.delete('M-8');
    const stale = new Map(missingFinal).set('M-1', { ...final.get('M-1')!, finishedAt: '2026-11-15T13:00:00.000Z' });
    const pairing = measuresWithoutPairedRuns({ measureIds: ids, baseline: new Map([...baseline].filter(([id]) => id !== 'M-5')), final: stale });
    expect(pairing.lacking).toEqual([
      { id: 'M-1', reason: 'final-not-after-baseline' },
      { id: 'M-3', reason: 'definition-fingerprints-differ' },
      { id: 'M-5', reason: 'no-baseline-run' },
      { id: 'M-8', reason: 'no-final-run' },
    ]);
    expect(measuresWithoutPairedRunsResult(pairing)).toMatchObject({ verdict: 'fail', value: 4 });
  });
});
