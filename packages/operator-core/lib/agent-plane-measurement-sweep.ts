/**
 * agent-plane-measurement-sweep.ts — P-015's DELIVERY half
 * (unified-agent-state-plane-2026-07-27 P-015, per D-030 / D-032 / D-089 / D-091).
 *
 * The composition is pure and lives in `agent-plane-measurement.ts`; this module
 * is the PG read, the once-per-window record, and the log line. Same chassis as
 * its sibling `agent-state-divergence-sweep.ts`.
 *
 * ── IT CONSUMES THE DIVERGENCE REPORT; IT DOES NOT RECOMPUTE IT ─────────────
 *
 * `DivergenceSweepResult.report` is documented as being "carried out so a caller
 * can log the fill rate without re-running anything", and this is that caller.
 * Recomputing the divergence numbers here would be wrong twice: it would be a
 * second read of `tool_invocations` in the same tick, and — worse — a SECOND
 * DERIVATION of a quantity that already has one, which is the axis-5 violation
 * (D-038) this plan has ruled against repeatedly. Two derivations that drift
 * apart produce a measurement that disagrees with the detector it is measuring,
 * and neither is wrong on its own terms.
 *
 * That is also why the window is not a parameter with its own default: it is
 * {@link SWEEP_LOOKBACK_MS}, the divergence sweep's own window. A row that mixed
 * a 24h clarification rate with a 30-minute divergence rate would not describe
 * any window at all.
 *
 * ── WHAT IS DELIBERATELY NOT EVALUATED HERE ────────────────────────────────
 *
 * The `acted-on-stale-or-wrong-value` VERDICT leg needs live cell reads
 * (`markStaleDependencyFacts` re-resolves each declared cell to re-digest it),
 * and a cell read passes two access gates keyed to a reader identity that a
 * background sweep does not have. Manufacturing a synthetic principal to get
 * one is precisely how P-030's enrichment broke (`resolveAgentIdentity` throws
 * for an unattributable caller), so the verdict leg is INJECTED
 * ({@link PlaneMeasurementDeps.evaluateStaleness}) and absent by default.
 *
 * This is disclosed rather than hidden, and it cannot masquerade as a clean
 * result: with the leg absent, `comparable` is 0, so the metric reports
 * `nothing-comparable` — a STRUCTURAL zero that is explicitly not good news —
 * and never a rate. Today the question is moot in any case (`eligible` is 0:
 * no fact has ever declared `dependsOn`), and the counts that ARE computed here
 * (population, eligible) are exact.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { SWEEP_LOOKBACK_MS } from './agent-state-divergence-sweep';
import type { DivergenceReport } from './agent-state-divergence';
import { listAssumptionFacts } from './agent-facts/store';
import { detectAssumptionConflicts } from './agent-facts/conflicts';
import {
  composePlaneMeasurement,
  isStructuralZero,
  isConcerningZero,
  explainZero,
  type MetricCounts,
  type PlaneCounts,
  type PlaneMeasurement,
} from './agent-plane-measurement';

/**
 * Record at most one row per this interval. The routines tick runs far more often
 * than the sweep window is long, and a row per tick would produce a series of
 * heavily-overlapping windows in which the same failure is counted many times —
 * a trend line made of duplicates. One reading per window keeps the series
 * additive, which is what D-030's variance requirement needs.
 */
export const PLANE_MEASUREMENT_INTERVAL_MS = SWEEP_LOOKBACK_MS;

/** Bumped when the metric set or a derivation changes, so no trend is silently
 *  drawn across a definition change. */
export const PLANE_MEASUREMENT_PRODUCER_VERSION = 1;

/**
 * The calls that count as an agent stopping to ask rather than proceeding on an
 * unverified premise.
 *
 * ⚠ Deliberately NOT a substring match on "ask". `work_items:request_release`
 * asks a peer for an item, and `coord:ask-owner` and `coord:ask` are the two
 * genuine clarification verbs; a looser predicate would sweep in every tool whose
 * name happens to contain the word and make the rate uninterpretable in the
 * direction that flatters it.
 */
export const CLARIFICATION_TOOLS = [
  'coord:ask',
  'coord:ask-owner',
  'conversations:post',
  'conversations:answer',
] as const;

/**
 * The surfaces this plane enriches, and therefore the ones whose payload is the
 * token cost it adds. Measured 2026-07-27 over 7d as the PRE-enrichment baseline:
 * work_items:get 2,591 calls @ ~7.5 KB · work_items:list 1,972 @ ~16.9 KB ·
 * coord:send 1,943 @ ~1.0 KB · scheduler:get_next 1,749 @ ~4.4 KB ·
 * coord:orient 1,675 @ ~17.3 KB · facts:assert 1,100 @ ~1.8 KB ·
 * locks:queue 647 @ ~0.2 KB · work_items:claim 602 @ ~5.2 KB ·
 * coord:presence 97 @ ~36.8 KB.
 */
export const ENRICHED_SURFACES = [
  'coord:orient',
  'coord:presence',
  'coord:send',
  'work_items:list',
  'work_items:get',
  'work_items:claim',
  'scheduler:get_next',
  'locks:queue',
  'facts:assert',
  'state:read',
] as const;

interface CallAggregateRow {
  calls: string | number;
  attributed: string | number;
  clarification_calls: string | number;
  enriched_calls: string | number;
  enriched_sized: string | number;
  enriched_bytes: string | number;
}

interface FactAggregateRow {
  live_facts: string | number;
  with_deps: string | number;
}

/** postgres-js returns count()/sum() as strings; coercing at the boundary is the
 *  same trap `loadRecentCalls` documents for bigint columns. */
function num(v: string | number | null | undefined): number {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

/** ONE aggregate over the window — not a row-level read, and not a second copy of
 *  the divergence sweep's scan. */
export async function loadCallAggregates(opts: {
  workspaceId: string;
  windowStartMs: number;
  windowEndMs: number;
  sql?: Sql;
}): Promise<CallAggregateRow> {
  const sql = opts.sql ?? getOrgPg().sql;
  const start = new Date(opts.windowStartMs).toISOString();
  const end = new Date(opts.windowEndMs).toISOString();
  const clarification = [...CLARIFICATION_TOOLS];
  const enriched = [...ENRICHED_SURFACES];
  const rows = await sql<CallAggregateRow[]>`
    SELECT count(*)                                                       AS calls,
           count(coord_owner_id)                                          AS attributed,
           count(*) FILTER (WHERE tool_name = ANY(${clarification}))       AS clarification_calls,
           count(*) FILTER (WHERE tool_name = ANY(${enriched}))            AS enriched_calls,
           count(*) FILTER (WHERE tool_name = ANY(${enriched})
                              AND output_size IS NOT NULL)                 AS enriched_sized,
           coalesce(sum(output_size) FILTER (WHERE tool_name = ANY(${enriched})), 0) AS enriched_bytes
      FROM harness_shared.tool_invocations
     WHERE workspace_id = ${opts.workspaceId}
       AND invoked_at >= ${start}
       AND invoked_at <  ${end}
  `;
  return rows[0] ?? { calls: 0, attributed: 0, clarification_calls: 0, enriched_calls: 0, enriched_sized: 0, enriched_bytes: 0 };
}

/**
 * Live-fact totals — the POPULATION for the two fact-backed metrics.
 *
 * Scoped with exactly the liveness predicate `listAssumptionFacts` uses, so the
 * population and the eligible subset are counted over the same set. A population
 * that included retracted rows would deflate every fill rate by a drifting amount.
 */
export async function loadFactAggregates(opts: {
  workspaceId: string;
  sql?: Sql;
}): Promise<FactAggregateRow> {
  const sql = opts.sql ?? getOrgPg().sql;
  const rows = await sql<FactAggregateRow[]>`
    SELECT count(*)                                        AS live_facts,
           count(*) FILTER (WHERE depends_on IS NOT NULL)   AS with_deps
      FROM harness_shared.agent_facts
     WHERE workspace_id = ${opts.workspaceId}
       AND superseded_at IS NULL AND retracted_at IS NULL AND expires_at > now()
  `;
  return rows[0] ?? { live_facts: 0, with_deps: 0 };
}

/** The verdict half of `acted-on-stale-or-wrong-value`, injected — see header. */
export interface StalenessVerdictCounts {
  /** Facts whose dependency comparison produced a usable verdict. EXCLUDES
   *  `undeterminable`: counting a cell that no longer resolves as "fresh" turns
   *  an instrument failure into a clean bill of health. */
  determinable: number;
  /** Of those, the ones resting on a value that has since moved. */
  stale: number;
}

export interface PlaneMeasurementDeps {
  workspaceId?: string;
  harnessSlug?: string;
  now?: number;
  sql?: Sql;
  /** The divergence sweep's own report — CONSUMED, never recomputed. */
  divergence?: DivergenceReport | null;
  loadCallAggregates?: typeof loadCallAggregates;
  loadFactAggregates?: typeof loadFactAggregates;
  listAssumptionFacts?: typeof listAssumptionFacts;
  /** Absent by default; see the header for why the verdict leg is not run here. */
  evaluateStaleness?: (facts: unknown[]) => Promise<StalenessVerdictCounts>;
  /** Injected for tests; the default reads the series' newest row. */
  lastMeasuredAtMs?: () => Promise<number | null>;
  recordMeasurement?: (m: PlaneMeasurement, ctx: { workspaceId: string; harnessSlug: string }) => Promise<void>;
}

export type PlaneSweepOutcome =
  | { outcome: 'recorded'; measurement: PlaneMeasurement }
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'error'; reason: string };

/** Newest reading in the series, for the once-per-window gate. */
async function defaultLastMeasuredAtMs(
  workspaceId: string,
  harnessSlug: string,
  sql?: Sql,
): Promise<number | null> {
  const db = sql ?? getOrgPg().sql;
  const rows = await db<Array<{ measured_at: string | Date }>>`
    SELECT measured_at
      FROM harness_shared.agent_plane_measurements
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
     ORDER BY measured_at DESC
     LIMIT 1
  `;
  if (rows.length === 0) return null;
  const t = new Date(rows[0].measured_at).getTime();
  return Number.isFinite(t) ? t : null;
}

async function defaultRecordMeasurement(
  m: PlaneMeasurement,
  ctx: { workspaceId: string; harnessSlug: string },
  sql?: Sql,
): Promise<void> {
  const db = sql ?? getOrgPg().sql;
  await db`
    INSERT INTO harness_shared.agent_plane_measurements
      (workspace_id, harness_slug, measured_at, window_start, window_end,
       metrics, interpretable_count, metric_count, summary, producer_version)
    VALUES (${ctx.workspaceId}, ${ctx.harnessSlug}, ${m.measuredAt},
            ${new Date(m.windowStartMs).toISOString()}, ${new Date(m.windowEndMs).toISOString()},
            ${db.json(m.metrics as unknown as object)}, ${m.interpretableCount}, ${m.metrics.length},
            ${m.summary}, ${PLANE_MEASUREMENT_PRODUCER_VERSION})
  `;
}

/**
 * Assemble one window's counts. PURE given its inputs — every read is injected —
 * so the whole funnel is unit-testable without PG.
 */
export function composeCounts(input: {
  divergence: DivergenceReport | null;
  calls: CallAggregateRow;
  facts: FactAggregateRow;
  assumptionsExamined: number;
  comparedPairs: number;
  conflicts: number;
  staleness: StalenessVerdictCounts | null;
}): PlaneCounts {
  const cov = input.divergence?.coverage ?? null;
  const callsExamined = cov?.callsExamined ?? num(input.calls.calls);

  // ⚠ Counted from the findings list, which DIVERGENCE_LIMIT can cut. `coverage`
  // carries no per-kind numerator, so on a truncated report this is a floor, not
  // an exact count — surfaced via the report's own `truncated` flag rather than
  // silently rounded away. Structurally 0 today (fill rate 0).
  const goalDrift =
    input.divergence?.divergences.filter((d) => d.kind === 'goal-drift-within-intent').length ?? 0;

  const attributed = num(input.calls.attributed);
  const enrichedCalls = num(input.calls.enriched_calls);

  const m = (population: number, eligible: number, comparable: number, observed: number): MetricCounts => ({
    population,
    eligible,
    comparable,
    observed,
  });

  return {
    'intent-action-divergence-stamped': m(
      callsExamined,
      cov?.stampedCalls ?? 0,
      cov?.comparableBuckets ?? 0,
      goalDrift,
    ),
    'intent-action-divergence-sampling': m(
      callsExamined,
      cov?.failuresSeen ?? 0,
      cov?.failuresSeen ?? 0,
      cov?.thrashRuns ?? 0,
    ),
    // Every attributed call is an opportunity to have asked instead of assumed,
    // so eligible === comparable === the attributed population and fillRate is 1.
    // This metric needs no producer of its own — which is exactly why it is the
    // one that stays interpretable while the stamped metrics wait for P-009.
    'clarification-rate': m(
      num(input.calls.calls),
      attributed,
      attributed,
      num(input.calls.clarification_calls),
    ),
    'conflicting-assumption-incidence': m(
      num(input.facts.live_facts),
      input.assumptionsExamined,
      input.comparedPairs,
      input.conflicts,
    ),
    'acted-on-stale-or-wrong-value': m(
      num(input.facts.live_facts),
      num(input.facts.with_deps),
      input.staleness?.determinable ?? 0,
      input.staleness?.stale ?? 0,
    ),
    // `observed` is BYTES and `comparable` is CALLS, so `rate` reads as mean
    // payload per enriched call — the baseline the eventual enrichment delta is
    // measured against. `verdictUnit: 'output byte'` on the spec says so.
    'plane-token-cost': m(
      num(input.calls.calls),
      enrichedCalls,
      num(input.calls.enriched_sized),
      num(input.calls.enriched_bytes),
    ),
  };
}

/**
 * One measurement: read the window's aggregates, compose, record at most once per
 * window. Fail-soft throughout — a measurement that throws would take down the
 * tick that carries the detector it is measuring.
 */
export async function planeMeasurementSweep(
  deps: PlaneMeasurementDeps = {},
): Promise<PlaneSweepOutcome> {
  const now = deps.now ?? Date.now();
  const workspaceId = deps.workspaceId ?? 'papercusp-workspace';
  const harnessSlug = deps.harnessSlug ?? 'papercusp';

  try {
    const lastAt = await (deps.lastMeasuredAtMs
      ? deps.lastMeasuredAtMs()
      : defaultLastMeasuredAtMs(workspaceId, harnessSlug, deps.sql));
    if (lastAt != null && now - lastAt < PLANE_MEASUREMENT_INTERVAL_MS) {
      return {
        outcome: 'skipped',
        reason: `last reading ${Math.round((now - lastAt) / 60_000)}min ago (< ${Math.round(PLANE_MEASUREMENT_INTERVAL_MS / 60_000)}min window)`,
      };
    }

    const windowStartMs = now - SWEEP_LOOKBACK_MS;
    const [calls, facts] = await Promise.all([
      (deps.loadCallAggregates ?? loadCallAggregates)({
        workspaceId,
        windowStartMs,
        windowEndMs: now,
        sql: deps.sql,
      }),
      (deps.loadFactAggregates ?? loadFactAggregates)({ workspaceId, sql: deps.sql }),
    ]);

    // P-011's detector, consumed — not a second contradiction comparison.
    const assumptions = await (deps.listAssumptionFacts ?? listAssumptionFacts)(
      { workspaceId },
      deps.sql,
    );
    const conflictReport = detectAssumptionConflicts(assumptions);

    const staleness =
      deps.evaluateStaleness && num(facts.with_deps) > 0
        ? await deps.evaluateStaleness([])
        : null;

    const measurement = composePlaneMeasurement({
      counts: composeCounts({
        divergence: deps.divergence ?? null,
        calls,
        facts,
        assumptionsExamined: assumptions.length,
        comparedPairs: conflictReport.coverage.comparedPairs,
        conflicts: conflictReport.conflicts.length,
        staleness,
      }),
      windowStartMs,
      windowEndMs: now,
    });

    await (deps.recordMeasurement
      ? deps.recordMeasurement(measurement, { workspaceId, harnessSlug })
      : defaultRecordMeasurement(measurement, { workspaceId, harnessSlug }, deps.sql));

    return { outcome: 'recorded', measurement };
  } catch (e) {
    return { outcome: 'error', reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * The log line. Leads with how much is MEASURABLE, then names each structural
 * zero and its producer — because a line reading "0 divergences, 0 conflicts" is
 * the exact misread D-087 and D-089 were both written to prevent.
 */
export function formatMeasurementLog(m: PlaneMeasurement): string {
  const parts = m.metrics.map((metric) => {
    if (metric.zeroReason && isStructuralZero(metric.zeroReason)) {
      return `${metric.id}=UNMEASURED(${metric.zeroReason}; fill=${metric.fillRate ?? 'n/a'}; awaiting ${metric.inputProducer})`;
    }
    // Measured, and the desirable behaviour did not occur. It must not print like
    // a defect count of 0, which is what "0/4142 (0)" reads as at a glance.
    if (metric.zeroReason === 'none-observed') {
      return `${metric.id}=NEVER-OBSERVED(0 of ${metric.comparable} ${metric.unit}s — measured, not a pass)`;
    }
    return `${metric.id}=${metric.observed}/${metric.comparable}${metric.rate == null ? '' : ` (${metric.rate})`}`;
  });
  return `[plane-measurement] ${m.summary} | ${parts.join(' · ')}`;
}

export { isStructuralZero, isConcerningZero, explainZero };
