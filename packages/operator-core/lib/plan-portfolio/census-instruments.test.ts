/**
 * Registry proof for plan-portfolio-flow-and-weight-2026-11-13 P-001, and the pins that keep
 * the constants census.ts mirrors equal to the ones the platform owns. census.ts stays free of
 * platform imports (the registry imports it), so each mirrored value is pinned here instead.
 */
import { describe, expect, it, vi } from 'vitest';
import { MIGRATION_PLAN_LINE_PARK_BY } from '../agent-tools/plans/plan-admission-preflight';
import { RUBRIC_TEMPLATE_NAME as PLATFORM_RUBRIC_TEMPLATE_NAME } from '../agent-tools/plans/rubric-template';
import * as ledger from '../check-results-ledger';
import { instrumentCheckId, type LatestRubricCheckResult } from '../check-results-ledger';
import {
  auditInstrumentBindings, getRegisteredInstrument, platformComputedInstrumentKeys,
} from '../rubric-instrument-registry';
import {
  CENSUS_MEASURE_IDS, PLAN_LINE_HOLD_BY, RUBRIC_TEMPLATE_NAME,
  type CensusKey, type CensusPlanRow, type CensusPlanStore,
} from './census';
import { PLAN_PORTFOLIO_INSTRUMENT_KEYS, censusMeasureCheckId } from './census-instruments';

/** What the registered resolvers read instead of Postgres. */
const fixture = vi.hoisted(() => ({ store: undefined as unknown }));

vi.mock('./census-store', () => ({ createPgCensusPlanStore: () => fixture.store }));

const WINDOW = {
  workspaceId: 'ws-1', harnessSlug: 'papercusp',
  windowStart: '2026-11-14T00:00:00.000Z', windowEnd: '2026-11-15T00:00:00.000Z',
};

/** A plan with one workable item that only the plan-line hold keeps unclaimable. */
function heldOnlyPlan(planSlug: string, status: string): CensusPlanRow {
  return {
    harnessSlug: 'papercusp', planSlug, status, archived: false, template: null,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-11-10T00:00:00.000Z',
    contentChars: 1_000, decisionCount: 2, hasReadinessBlock: false, hasEmbedding: true,
    items: [{ id: 'P-001', status: 'todo', blockedBy: [] }],
    workItems: [{ planLineId: 'P-001', status: 'open', held: false, claimHold: true, claimHoldBy: PLAN_LINE_HOLD_BY, lane: null }],
  };
}

function storeOf(plans: CensusPlanRow[]): CensusPlanStore {
  const sorted = [...plans].sort((x, y) => (x.planSlug < y.planSlug ? -1 : 1));
  const after = (cursor: CensusKey | null) => sorted.filter((p) => !cursor || p.planSlug > cursor.planSlug);
  return {
    readPlans: async ({ after: cursor, limit }) => after(cursor).slice(0, limit),
    countPlansAfter: async (cursor) => after(cursor).length,
    readNearTwinPairs: async () => [],
  };
}

/** Ledger rows of one labelled run: one per measure, each carrying its definition fingerprint. */
function runRows(ids: readonly string[], finishedAt: string, definitionOf: (id: string) => string) {
  return new Map<string, LatestRubricCheckResult>(ids.map((id, index) => [instrumentCheckId(id), {
    testRunId: index + 1, status: 'pass', finishedAt,
    check: { id: instrumentCheckId(id), value: 1, provenance: { procedure: { sha256: definitionOf(id) } } },
  } as unknown as LatestRubricCheckResult]));
}

function rescoreOf(key: string) {
  const instrument = getRegisteredInstrument(key);
  if (instrument?.evaluator !== 'platform' || !instrument.rescore) throw new Error(`${key} has no registered rescore`);
  return instrument.rescore;
}

describe('plan-portfolio instruments in the rubric instrument registry (P-001)', () => {
  it('ITEM-P-001-registers-bar-instruments: the registry holds both keys the acceptance bars name', async () => {
    // Written out, not read from the module under test: these are the keys the bars name.
    const heldOnlyKey = 'plan-portfolio:held-only-workable-items';
    const pairingKey = 'plan-portfolio:measures-without-paired-runs';
    expect(Object.values(PLAN_PORTFOLIO_INSTRUMENT_KEYS)).toEqual(expect.arrayContaining([heldOnlyKey, pairingKey]));

    for (const key of [heldOnlyKey, pairingKey]) {
      expect(platformComputedInstrumentKeys(), key).toContain(key);
      expect(getRegisteredInstrument(key)?.evaluator, key).toBe('platform');
      // A bar may bind the key: the binding audit refuses an unregistered instrument.
      expect(auditInstrumentBindings({ prior: [], next: [{ key: 'r-x', check: { kind: 'instrument', instrumentKey: key } }] }).refused, key)
        .toEqual([]);
    }

    // Each registered key measures: two ready plans held only by the plan-line hold, one draft.
    fixture.store = storeOf([heldOnlyPlan('a', 'ready'), heldOnlyPlan('b', 'active'), heldOnlyPlan('c', 'draft')]);
    expect(await rescoreOf(heldOnlyKey).resolve(WINDOW)).toMatchObject({ verdict: 'fail', value: 2 });

    // The pairing key reads the ledger's latest rows per run label; the spy stands in for Postgres.
    const latest = new Map<string, Map<string, LatestRubricCheckResult>>();
    const read = vi.spyOn(ledger, 'readLatestRubricCheckResults')
      .mockImplementation(async (query) => latest.get(query.subject?.ref ?? '') ?? new Map());
    try {
      // Baseline for all nine; the final run changed M-2's definition and never measured M-9.
      latest.set('baseline', runRows(CENSUS_MEASURE_IDS, '2026-11-15T00:00:00.000Z', (id) => `definition-${id}`));
      latest.set('final', runRows(CENSUS_MEASURE_IDS.slice(0, 8), '2026-11-16T00:00:00.000Z',
        (id) => (id === 'M-2' ? 'definition-changed' : `definition-${id}`)));
      const unpaired = await rescoreOf(pairingKey).resolve(WINDOW);
      expect(unpaired, unpaired.detail).toMatchObject({ verdict: 'fail', value: 2 });
      expect(JSON.parse(unpaired.detail ?? '{}').lacking).toEqual([
        { id: 'M-2', reason: 'definition-fingerprints-differ' },
        { id: 'M-9', reason: 'no-final-run' },
      ]);

      latest.set('final', runRows(CENSUS_MEASURE_IDS, '2026-11-16T00:00:00.000Z', (id) => `definition-${id}`));
      const paired = await rescoreOf(pairingKey).resolve(WINDOW);
      expect(paired, paired.detail).toMatchObject({ verdict: 'pass', value: 0 });
      // Both labels were read under the census ledger ref, never a rubric-wide read.
      expect(read.mock.calls.map(([query]) => [query.rubricRef, query.subject?.kind, query.subject?.ref]).sort()).toEqual([
        ['plan-portfolio-census', 'plan-portfolio-census-run', 'baseline'],
        ['plan-portfolio-census', 'plan-portfolio-census-run', 'baseline'],
        ['plan-portfolio-census', 'plan-portfolio-census-run', 'final'],
        ['plan-portfolio-census', 'plan-portfolio-census-run', 'final'],
      ]);
    } finally { read.mockRestore(); }
  });

  it('pins the census check id to the ledger instrument check id', () => {
    for (const id of CENSUS_MEASURE_IDS) expect(censusMeasureCheckId(id), id).toBe(instrumentCheckId(id));
  });

  it('pins the plan-line hold name to the one plan admission writes', () => {
    expect(PLAN_LINE_HOLD_BY).toBe(MIGRATION_PLAN_LINE_PARK_BY);
  });

  it('pins the rubric template name to the platform template', () => {
    expect(RUBRIC_TEMPLATE_NAME).toBe(PLATFORM_RUBRIC_TEMPLATE_NAME);
  });
});
