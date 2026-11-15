/**
 * Plan-portfolio instruments (plan-portfolio-flow-and-weight-2026-11-13 P-001).
 *
 * Three registered keys, all resolved from the one census in census.ts:
 *   - plan-portfolio:census                       re-reads the nine Background measures;
 *   - plan-portfolio:held-only-workable-items     bar R-4: workable items in ready or active
 *                                                 plans that only the plan-line hold keeps
 *                                                 unclaimable; passes at zero;
 *   - plan-portfolio:measures-without-paired-runs bar R-6: measures that lack a baseline run
 *                                                 or a final run under one definition
 *                                                 fingerprint; passes at zero.
 *
 * A labelled run (baseline, final) is recorded in the results ledger the way every rubric
 * check is: one harness_shared.test_runs row per measure through recordRubricCheckResults, no
 * new table. The label is the row's subject. The row's provenance procedure is the measure's
 * resolved manifest entry plus the manifest version and fingerprint, and holds NO label, so a
 * baseline row and a final row of one measure carry the same `procedure.sha256` exactly when
 * they were measured under one definition. That hash is the pairing key.
 *
 * Every instrument that reads plans reports how many plans its run left out and a cursor for
 * a follow-up run; an incomplete run rates `unknown`, never a pass. The pairing instrument
 * reads ledger rows for the fixed list of measures and no plans, so it leaves none out.
 *
 * check-results-ledger imports the instrument registry, and the registry imports this module,
 * so the ledger is imported lazily here.
 */
import { randomUUID } from 'node:crypto';
import { retainMeasurementProvenance } from '../measurement-provenance';
import type { RubricCheckResult } from '../check-results-ledger';
import type { PlatformInstrument } from '../rubric-instrument-registry';
import {
  DEFAULT_CENSUS_POPULATION,
  resolveCensusManifest,
  runPlanPortfolioCensus,
  type CensusManifest,
  type CensusPlanStore,
  type CensusRun,
} from './census';

export const PLAN_PORTFOLIO_INSTRUMENT_KEYS = {
  census: 'plan-portfolio:census',
  heldOnlyWorkableItems: 'plan-portfolio:held-only-workable-items',
  measuresWithoutPairedRuns: 'plan-portfolio:measures-without-paired-runs',
} as const;

/** Point-in-time instruments; the window only spaces scheduled re-measurements. */
export const PLAN_PORTFOLIO_INSTRUMENT_WINDOW_MS = 24 * 60 * 60_000;
/** Work bound of one instrument run: 500 batches of 200 plans. Past it the run reports omissions. */
export const PLAN_PORTFOLIO_INSTRUMENT_MAX_BATCHES = 500;

/** Ledger namespace of recorded census runs: file_path `rubric-check/plan-portfolio-census/<M-n>:instrument…`. */
export const PLAN_PORTFOLIO_CENSUS_LEDGER_REF = 'plan-portfolio-census';
export const CENSUS_RUN_SUBJECT_KIND = 'plan-portfolio-census-run';
export const CENSUS_RUN_PROCEDURE_KIND = 'plan-portfolio-census-measure-v1';
export const CENSUS_RUN_LABELS = ['baseline', 'final'] as const;
export type CensusRunLabel = (typeof CENSUS_RUN_LABELS)[number];

type SqlLike = { query(strings: TemplateStringsArray, ...values: unknown[]): PromiseLike<unknown> }['query'];

export interface PlanPortfolioInstrumentResult {
  verdict: 'pass' | 'fail' | 'unknown';
  detail: string;
  value?: number;
  evidenceRefs?: string[];
}

/** Mirrors check-results-ledger's instrumentCheckId; census-instruments.test pins the two together. */
export function censusMeasureCheckId(measureId: string): string {
  return `${measureId}:instrument`;
}

function manifestRef(run: Pick<CensusRun, 'manifestVersion' | 'manifestFingerprint'>): string {
  return `plan-portfolio-census-manifest@v${run.manifestVersion}#sha256:${run.manifestFingerprint}`;
}

/** What an incomplete run reports: the omission count and where a follow-up run starts. */
function incomplete(run: CensusRun): PlanPortfolioInstrumentResult {
  return {
    verdict: 'unknown',
    detail: JSON.stringify({
      unknown: 'the run left plans out; a follow-up run from the cursor reads them',
      omitted: run.omitted, cursor: run.cursor?.after ?? null, plansRead: run.plansRead,
      manifestFingerprint: run.manifestFingerprint,
    }),
  };
}

/** Pure: the census run as an instrument reading. The value is the count of measures that have a value. */
export function censusInstrumentResult(run: CensusRun): PlanPortfolioInstrumentResult {
  if (!run.complete) return incomplete(run);
  const measures = Object.values(run.measures);
  const withValue = measures.filter((measure) => measure.value !== null);
  return {
    verdict: withValue.length === measures.length ? 'pass' : 'fail',
    value: withValue.length,
    detail: JSON.stringify({
      measuresWithValue: withValue.length, measures: measures.length,
      manifestVersion: run.manifestVersion, manifestFingerprint: run.manifestFingerprint,
      runAt: run.runAt, plansRead: run.plansRead, omitted: 0, cursor: null,
      population: run.population.total,
      values: Object.fromEntries(measures.map((m) => [m.id, { value: m.value, unit: m.unit, ...m.components }])),
    }),
    evidenceRefs: [manifestRef(run)],
  };
}

/** Pure: bar R-4's count. Passes only at zero. */
export function heldOnlyWorkableItemsResult(run: CensusRun): PlanPortfolioInstrumentResult {
  if (!run.complete) return incomplete(run);
  const { count, sample } = run.heldOnlyWorkableItems;
  return {
    verdict: count === 0 ? 'pass' : 'fail',
    value: count,
    detail: JSON.stringify({
      heldOnlyWorkableItems: count, bar: 'heldOnlyWorkableItems = 0',
      // Labelled preview; the count above is exact.
      sample, sampleOf: count,
      runAt: run.runAt, plansRead: run.plansRead, omitted: 0, cursor: null,
      manifestFingerprint: run.manifestFingerprint,
    }),
    evidenceRefs: [manifestRef(run)],
  };
}

// ── Recording a labelled run ─────────────────────────────────────────────────

/**
 * Pure: the ledger results of one labelled run, one per measure. Refuses an incomplete run,
 * so a recorded baseline or final never stands for part of the population.
 */
export function censusRunCheckResults(input: {
  run: CensusRun;
  label: CensusRunLabel;
  manifest: CensusManifest;
  startedAt: string;
  finishedAt: string;
}): RubricCheckResult[] {
  const { run, manifest } = input;
  if (!run.complete) throw new Error(`census_run_incomplete: ${run.omitted} plans left out`);
  return manifest.measures.map((entry) => {
    const reading = run.measures[entry.id];
    const provenance = retainMeasurementProvenance({
      // No label and no run instant: equal definitions hash equally across runs.
      procedure: {
        kind: CENSUS_RUN_PROCEDURE_KIND, manifestVersion: run.manifestVersion,
        manifestFingerprint: run.manifestFingerprint, measure: entry,
      },
      result: { value: reading.value, ...reading.components, runAt: run.runAt, plansRead: run.plansRead, omitted: run.omitted },
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
    });
    return {
      check: {
        id: censusMeasureCheckId(entry.id),
        rubricRef: PLAN_PORTFOLIO_CENSUS_LEDGER_REF,
        criterionKey: entry.id,
        kind: 'instrument' as const,
        value: reading.value,
        unit: entry.unit,
        provenance,
        subject: { kind: CENSUS_RUN_SUBJECT_KIND, ref: input.label },
      },
      verdict: reading.value === null ? 'error' as const : 'pass' as const,
      measuredAt: input.finishedAt,
      durationMs: Math.max(0, Date.parse(input.finishedAt) - Date.parse(input.startedAt)),
      ...(reading.value === null ? { detail: `measure ${entry.id} has no value over the population read` } : {}),
    };
  });
}

/** Run the census to the end and record it under `label`. Throws rather than record a partial run. */
export async function recordPlanPortfolioCensusRun(input: {
  label: CensusRunLabel;
  workspaceId: string;
  store?: CensusPlanStore;
  now?: () => number;
  sql?: SqlLike;
  record?: (results: RubricCheckResult[], scope: { workspaceId: string; harnessSlug: string; runGroupId: string }) => Promise<number[]>;
}): Promise<{ run: CensusRun; runGroupId: string; testRunIds: number[] }> {
  const now = input.now ?? Date.now;
  const manifest = resolveCensusManifest();
  const store = input.store ?? (await import('./census-store')).createPgCensusPlanStore({
    workspaceId: input.workspaceId, ...(input.sql ? { sql: input.sql } : {}),
  });
  const started = now();
  const run = await runPlanPortfolioCensus({ store, now: started, manifest, maxBatches: PLAN_PORTFOLIO_INSTRUMENT_MAX_BATCHES });
  const results = censusRunCheckResults({
    run, label: input.label, manifest,
    startedAt: new Date(started).toISOString(), finishedAt: new Date(Math.max(started, now())).toISOString(),
  });
  const runGroupId = randomUUID();
  const scope = { workspaceId: input.workspaceId, harnessSlug: DEFAULT_CENSUS_POPULATION.harness, runGroupId };
  const record = input.record ?? (async (rows, to) => {
    const { recordRubricCheckResults } = await import('../check-results-ledger');
    return input.sql ? recordRubricCheckResults(rows, to, input.sql) : recordRubricCheckResults(rows, to);
  });
  return { run, runGroupId, testRunIds: await record(results, scope) };
}

// ── Pairing (bar R-6) ────────────────────────────────────────────────────────

export interface CensusRunRow {
  testRunId: number;
  finishedAt: string;
  /** `provenance.procedure.sha256` of the recorded row: the measure's definition fingerprint. */
  definitionSha256: string | null;
}

export type UnpairedReason = 'no-baseline-run' | 'no-final-run' | 'definition-fingerprints-differ' | 'final-not-after-baseline';

/** Pure: which measures lack a baseline run or a final run under one definition fingerprint. */
export function measuresWithoutPairedRuns(input: {
  measureIds: readonly string[];
  baseline: ReadonlyMap<string, CensusRunRow>;
  final: ReadonlyMap<string, CensusRunRow>;
}): { lacking: Array<{ id: string; reason: UnpairedReason }>; paired: string[] } {
  const lacking: Array<{ id: string; reason: UnpairedReason }> = [];
  const paired: string[] = [];
  for (const id of input.measureIds) {
    const baseline = input.baseline.get(id);
    const final = input.final.get(id);
    if (!baseline?.definitionSha256) lacking.push({ id, reason: 'no-baseline-run' });
    else if (!final?.definitionSha256) lacking.push({ id, reason: 'no-final-run' });
    else if (baseline.definitionSha256 !== final.definitionSha256) lacking.push({ id, reason: 'definition-fingerprints-differ' });
    else if (!(Date.parse(final.finishedAt) > Date.parse(baseline.finishedAt))) lacking.push({ id, reason: 'final-not-after-baseline' });
    else paired.push(id);
  }
  return { lacking, paired };
}

export function measuresWithoutPairedRunsResult(
  pairing: ReturnType<typeof measuresWithoutPairedRuns>,
): PlanPortfolioInstrumentResult {
  return {
    verdict: pairing.lacking.length === 0 ? 'pass' : 'fail',
    value: pairing.lacking.length,
    detail: JSON.stringify({
      measuresWithoutPairedRuns: pairing.lacking.length, bar: 'measuresWithoutPairedRuns = 0',
      lacking: pairing.lacking, paired: pairing.paired.length,
      // Reads the latest recorded row of each measure and label, and no plans.
      omitted: 0, cursor: null,
    }),
  };
}

/** The latest measured row of every measure for one label. An errored row falls back to the last measured one. */
export async function readCensusRunRows(input: {
  label: CensusRunLabel; workspaceId: string; measureIds: readonly string[]; sql?: SqlLike;
}): Promise<Map<string, CensusRunRow>> {
  const { readLatestRubricCheckResults } = await import('../check-results-ledger');
  const query = {
    rubricRef: PLAN_PORTFOLIO_CENSUS_LEDGER_REF, workspaceId: input.workspaceId,
    subject: { kind: CENSUS_RUN_SUBJECT_KIND, ref: input.label },
  };
  const latest = input.sql ? await readLatestRubricCheckResults(query, input.sql) : await readLatestRubricCheckResults(query);
  const out = new Map<string, CensusRunRow>();
  for (const id of input.measureIds) {
    const row = latest.get(censusMeasureCheckId(id));
    const measured = row?.status === 'error' ? row.lastMeasurement : row;
    if (!measured || measured.check.value === null) continue;
    out.set(id, {
      testRunId: measured.testRunId, finishedAt: measured.finishedAt,
      definitionSha256: measured.check.provenance?.procedure.sha256 ?? null,
    });
  }
  return out;
}

// ── Registry resolvers ───────────────────────────────────────────────────────

export function isPlanPortfolioInstrumentKey(key: string): boolean {
  return (Object.values(PLAN_PORTFOLIO_INSTRUMENT_KEYS) as string[]).includes(key);
}

export interface PlanPortfolioResolveDeps {
  store?: CensusPlanStore;
  now?: number;
  batchSize?: number;
  maxBatches?: number;
  readRunRows?: (label: CensusRunLabel) => Promise<Map<string, CensusRunRow>>;
}

/** Measure one registered key. A failed read rates `unknown` with the error named. */
export async function resolvePlanPortfolioInstrument(
  key: string,
  window: { workspaceId: string; harnessSlug?: string },
  deps: PlanPortfolioResolveDeps = {},
): Promise<PlanPortfolioInstrumentResult> {
  const workspaceId = window.workspaceId.trim();
  if (!workspaceId) return { verdict: 'unknown', detail: 'Exact workspace required.' };
  if ((window.harnessSlug ?? '').trim() !== DEFAULT_CENSUS_POPULATION.harness) {
    return { verdict: 'unknown', detail: `The census manifest records the ${DEFAULT_CENSUS_POPULATION.harness} harness only.` };
  }
  try {
    if (key === PLAN_PORTFOLIO_INSTRUMENT_KEYS.measuresWithoutPairedRuns) {
      const measureIds = resolveCensusManifest().measures.map((entry) => entry.id);
      const read = deps.readRunRows ?? ((label: CensusRunLabel) => readCensusRunRows({ label, workspaceId, measureIds }));
      const [baseline, final] = await Promise.all([read('baseline'), read('final')]);
      return measuresWithoutPairedRunsResult(measuresWithoutPairedRuns({ measureIds, baseline, final }));
    }
    const store = deps.store ?? (await import('./census-store')).createPgCensusPlanStore({ workspaceId });
    const run = await runPlanPortfolioCensus({
      store,
      ...(deps.now !== undefined ? { now: deps.now } : {}),
      ...(deps.batchSize !== undefined ? { batchSize: deps.batchSize } : {}),
      maxBatches: deps.maxBatches ?? PLAN_PORTFOLIO_INSTRUMENT_MAX_BATCHES,
    });
    if (key === PLAN_PORTFOLIO_INSTRUMENT_KEYS.heldOnlyWorkableItems) return heldOnlyWorkableItemsResult(run);
    if (key === PLAN_PORTFOLIO_INSTRUMENT_KEYS.census) return censusInstrumentResult(run);
    return { verdict: 'unknown', detail: `Not a plan-portfolio instrument: ${key}` };
  } catch (error) {
    return { verdict: 'unknown', detail: JSON.stringify({ unknown: `plan-portfolio read failed: ${error instanceof Error ? error.message : String(error)}` }) };
  }
}

/** The registry's scheduled-measurement entry for one plan-portfolio key. */
export function planPortfolioRescore(key: string): NonNullable<PlatformInstrument['rescore']> {
  return {
    windowMs: PLAN_PORTFOLIO_INSTRUMENT_WINDOW_MS,
    unit: 'count',
    scope: 'harness',
    resolve: async (window) => resolvePlanPortfolioInstrument(key, window),
  };
}
