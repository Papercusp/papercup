/**
 * quality-metrics.ts — Scout standing quality metrics (scout-loop-test-plan
 * P-015): the report that answers "is the Scout loop still producing GOOD ideas,
 * at a sane cost, or has it quietly degraded?".
 *
 * Three layers, the pure-decision-functions-pulled-from-daemons split:
 *
 *  1. **Pure core** — {@link computeScoutQualityReport} folds injected snapshots
 *     of the tick ledger (tick-ledger.ts rows), the routed-idea ledger
 *     (RoutedIdeaProvenance), and the lens-outcome report (outcome-feedback's
 *     gatherLensOutcomes output) into one {@link ScoutQualityReport}; and
 *     {@link evaluateQualityDegradation} compares a report against an INJECTED
 *     baseline + tolerances. No PG, no clock, no network — fully unit-tested.
 *
 *  2. **Assembly** — {@link buildQualityReportInputs} reads the real ledgers
 *     (readScoutTicks / readRoutedIdeas / gatherLensOutcomes over the production
 *     reader bag) via LAZY imports, so importing this module never touches the
 *     PG edge (the scheduler's buildScoutTickDeps pattern). Reuses the existing
 *     ledgers only — the baseline is NOT new PG state; the Phase-2 recorded
 *     baseline arrives injected (routine payload), and a prior
 *     {@link ScoutQualityReport} satisfies {@link ScoutQualityBaseline}
 *     structurally, so "record a baseline" = "keep a past report".
 *
 *  3. **Composition** — {@link checkAndFlagQuality} runs read → report →
 *     evaluate and, on degradation, files ONE improvements capture through an
 *     injected {@link QualityCapturePort} (structurally compatible with
 *     captureImprovement / the improvements:capture tool — this module never
 *     imports agent-tools). One capture per breach SET, with a stable
 *     sorted-metric title, so re-runs over the same degradation dedup cleanly
 *     downstream (capture-core's search-first dedup sees the same title).
 */

import type { RoutedIdeaProvenance, LensOutcomeReport, LensWeightOptions } from './outcome-feedback';
import { gatherLensOutcomes } from './outcome-feedback';
import type { ScoutTickRecord } from './tick-ledger';
import type { ScoutLedgerOpts } from './routed-ledger';
import { CREATIVE_LENSES, type CreativeLens } from './types';

// ── pure core: the report ─────────────────────────────────────────────────────

/**
 * The self-gates a 'gated' tick can name (scheduler.ts runScoutTick):
 * 'min-interval' / 'no-trigger' from the cadence verdict, 'circuit' from the
 * autoloop fire-gate, 'claim-lost' from the EI-304 single-flight claim. The
 * breakdown always carries all four keys (zeroed), so a dashboard / baseline
 * diff never sees a key appear out of nowhere.
 */
export const SCOUT_TICK_GATES = ['min-interval', 'no-trigger', 'circuit', 'claim-lost'] as const;

/** Injected snapshots the pure core folds — production via {@link buildQualityReportInputs}, tests via fixtures. */
export interface ScoutQualityInputs {
  /** Tick-ledger window snapshot (readScoutTicks rows; ScoutTickRecord is the load-bearing subset). */
  ticks: readonly ScoutTickRecord[];
  /** Routed-idea ledger snapshot (readRoutedIdeas). */
  routedIdeas: readonly RoutedIdeaProvenance[];
  /** The per-lens outcome report (gatherLensOutcomes / getScoutLensOutcomes). */
  lensOutcomes: LensOutcomeReport;
}

/** The standing quality report — every rate is null (never NaN) when its denominator is zero. */
export interface ScoutQualityReport {
  /** Full cycles in the tick window (status 'ran'). */
  windowCycles: number;
  /** All ticks in the window (ran + gated + error). */
  totalTicks: number;
  /** Ticks that fired but threw (status 'error'). */
  errorTicks: number;
  /** Gated ticks per self-gate — all {@link SCOUT_TICK_GATES} keys always present (zeroed). */
  gatedTickBreakdown: Record<string, number>;
  /** Routed ideas in the ledger snapshot. */
  totalRouted: number;
  /** Routed ideas that won (accepted) / lost (rejected) / are still pending, summed across lenses. */
  accepted: number;
  rejected: number;
  pending: number;
  /** Ideas the ideators produced across the window's full cycles. */
  totalIdeasGenerated: number;
  /** LLM spend summed over the window's ticks (USD). */
  totalSpendUsd: number;
  /** accepted / (accepted + rejected) over DECIDED outcomes; null when nothing decided. */
  triageAcceptanceRate: number | null;
  /** accepted / totalIdeasGenerated — how many raw ideas actually ship; null when none generated. */
  ideaToShippedConversion: number | null;
  /** Per-lens win rate over decided outcomes (outcome-feedback's winRate); null when undecided. */
  perLensWinRates: Record<CreativeLens, number | null>;
  /** totalSpendUsd / accepted; null when nothing accepted (zero-division guard). */
  costPerAcceptedIdeaUsd: number | null;
}

/**
 * Fold the three ledger snapshots into the standing quality report. Pure —
 * deterministic over the inputs, no IO. Acceptance comes from the lens-outcome
 * report (won = accepted, lost = rejected — the change-feed classification);
 * volume + spend come from the tick window; the routed total from the ledger.
 */
export function computeScoutQualityReport(inputs: ScoutQualityInputs): ScoutQualityReport {
  let windowCycles = 0;
  let errorTicks = 0;
  let totalIdeasGenerated = 0;
  let totalSpendUsd = 0;
  const gatedTickBreakdown: Record<string, number> = Object.fromEntries(
    SCOUT_TICK_GATES.map((g) => [g, 0]),
  );

  for (const t of inputs.ticks) {
    if (t.status === 'ran') {
      windowCycles += 1;
      totalIdeasGenerated += t.ideasGenerated ?? 0;
    } else if (t.status === 'gated') {
      const gate = t.gate ?? 'unknown';
      gatedTickBreakdown[gate] = (gatedTickBreakdown[gate] ?? 0) + 1;
    } else if (t.status === 'error') {
      errorTicks += 1;
    }
    if (typeof t.budgetUsedUsd === 'number' && Number.isFinite(t.budgetUsedUsd)) {
      totalSpendUsd += t.budgetUsedUsd;
    }
  }

  let accepted = 0;
  let rejected = 0;
  let pending = 0;
  const perLensWinRates = {} as Record<CreativeLens, number | null>;
  for (const lens of CREATIVE_LENSES) {
    const s = inputs.lensOutcomes.byLens[lens];
    perLensWinRates[lens] = s?.winRate ?? null;
    if (!s) continue;
    accepted += s.won;
    rejected += s.lost;
    pending += s.pending;
  }
  const decided = accepted + rejected;

  return {
    windowCycles,
    totalTicks: inputs.ticks.length,
    errorTicks,
    gatedTickBreakdown,
    totalRouted: inputs.routedIdeas.length,
    accepted,
    rejected,
    pending,
    totalIdeasGenerated,
    totalSpendUsd,
    triageAcceptanceRate: decided > 0 ? accepted / decided : null,
    ideaToShippedConversion: totalIdeasGenerated > 0 ? accepted / totalIdeasGenerated : null,
    perLensWinRates,
    costPerAcceptedIdeaUsd: accepted > 0 ? totalSpendUsd / accepted : null,
  };
}

// ── pure core: degradation ────────────────────────────────────────────────────

/**
 * The recorded baseline a fresh report is compared against. A structural SUBSET
 * of {@link ScoutQualityReport} — a prior report IS a valid baseline, so the
 * Phase-2 "record a baseline" step is just keeping a past report (no new PG
 * schema; the routine payload carries it). Null/absent metrics are skipped
 * (you can't degrade from a baseline that never measured).
 */
export interface ScoutQualityBaseline {
  triageAcceptanceRate?: number | null;
  ideaToShippedConversion?: number | null;
  costPerAcceptedIdeaUsd?: number | null;
  perLensWinRates?: Partial<Record<CreativeLens, number | null>>;
}

/**
 * Per-metric degradation tolerances. Rates use ABSOLUTE drop (they live in
 * [0,1]); cost uses RELATIVE increase (it's an open-ended USD amount). A metric
 * exactly AT its tolerance is NOT degraded — only strictly past it breaches.
 */
export interface QualityTolerances {
  /** Max absolute drop in triageAcceptanceRate (default 0.10). */
  triageAcceptanceRate?: number;
  /** Max absolute drop in ideaToShippedConversion (default 0.05). */
  ideaToShippedConversion?: number;
  /** Max RELATIVE increase in costPerAcceptedIdeaUsd — 0.5 = +50% (default 0.5). */
  costPerAcceptedIdeaUsd?: number;
  /** Max absolute drop in any single lens's win rate (default 0.20). */
  perLensWinRate?: number;
}

export const DEFAULT_QUALITY_TOLERANCES: Required<QualityTolerances> = {
  triageAcceptanceRate: 0.1,
  ideaToShippedConversion: 0.05,
  costPerAcceptedIdeaUsd: 0.5,
  perLensWinRate: 0.2,
};

/** One metric past its tolerance: which metric, and the baseline → current pair. */
export interface QualityBreach {
  /** 'triageAcceptanceRate' | 'ideaToShippedConversion' | 'costPerAcceptedIdeaUsd' | 'perLensWinRates.<lens>'. */
  metric: string;
  baseline: number;
  current: number;
}

export interface QualityDegradationVerdict {
  degraded: boolean;
  breaches: QualityBreach[];
}

/** FP guard so "exactly at tolerance" never breaches on representation error (0.8 − 0.1 ≠ 0.7 in FP). */
const EPS = 1e-9;

/**
 * Compare a report against the injected baseline. Pure. Missing baseline →
 * never degraded (a Scout with no recorded baseline can't have regressed);
 * per-metric null/absent on EITHER side → that metric is skipped.
 */
export function evaluateQualityDegradation(
  report: ScoutQualityReport,
  baseline: ScoutQualityBaseline | null | undefined,
  tolerances: QualityTolerances = {},
): QualityDegradationVerdict {
  if (!baseline) return { degraded: false, breaches: [] };
  const tol = { ...DEFAULT_QUALITY_TOLERANCES, ...tolerances };
  const breaches: QualityBreach[] = [];

  const lowerIsWorse = (
    metric: string,
    base: number | null | undefined,
    current: number | null | undefined,
    allowedDrop: number,
  ): void => {
    if (base == null || current == null || !Number.isFinite(base) || !Number.isFinite(current)) return;
    if (current < base - allowedDrop - EPS) breaches.push({ metric, baseline: base, current });
  };

  lowerIsWorse(
    'triageAcceptanceRate',
    baseline.triageAcceptanceRate,
    report.triageAcceptanceRate,
    tol.triageAcceptanceRate,
  );
  lowerIsWorse(
    'ideaToShippedConversion',
    baseline.ideaToShippedConversion,
    report.ideaToShippedConversion,
    tol.ideaToShippedConversion,
  );

  // Cost: HIGHER is worse, relative headroom (a $0.02 → $0.04 jump on a tiny
  // baseline should flag the same as $2 → $4; an absolute band would not).
  const baseCost = baseline.costPerAcceptedIdeaUsd;
  const curCost = report.costPerAcceptedIdeaUsd;
  if (baseCost != null && curCost != null && Number.isFinite(baseCost) && Number.isFinite(curCost)) {
    if (curCost > baseCost * (1 + tol.costPerAcceptedIdeaUsd) + EPS) {
      breaches.push({ metric: 'costPerAcceptedIdeaUsd', baseline: baseCost, current: curCost });
    }
  }

  for (const lens of CREATIVE_LENSES) {
    lowerIsWorse(
      `perLensWinRates.${lens}`,
      baseline.perLensWinRates?.[lens],
      report.perLensWinRates[lens],
      tol.perLensWinRate,
    );
  }

  return { degraded: breaches.length > 0, breaches };
}

// ── composition: check + flag through an injected capture port ────────────────

/**
 * The capture request the degradation path files — a structural subset of
 * capture-core's CaptureImprovementInput, so production wires the port as
 * `(req) => captureImprovement(req)` (or the improvements:capture tool) without
 * this module importing either (the injected-port pattern — same reason
 * scheduler.ts lazy-imports the autoloop instead of binding it).
 */
export interface QualityCaptureRequest {
  title: string;
  kind: 'bug' | 'change' | 'feature';
  body: string;
  subTopic?: string;
  sourceRole?: 'Queen' | 'bee' | 'system' | 'human';
}

/** The injected improvements-capture port. */
export type QualityCapturePort = (req: QualityCaptureRequest) => Promise<unknown>;

export interface CheckAndFlagQualityDeps {
  /** Read the three ledger snapshots (production: () => buildQualityReportInputs(opts)). */
  readInputs: () => Promise<ScoutQualityInputs>;
  /** The recorded baseline (routine payload); null/undefined → never degraded. */
  baseline: ScoutQualityBaseline | null | undefined;
  tolerances?: QualityTolerances;
  /** Files the improvement on degradation — called at most ONCE per check. */
  capture: QualityCapturePort;
}

export interface QualityCheckResult {
  report: ScoutQualityReport;
  verdict: QualityDegradationVerdict;
  /** True when the capture port was invoked (degraded). */
  captured: boolean;
}

/**
 * Stable capture title for a breach set: sorted, deduped metric names — the
 * same degradation always produces the SAME title, so capture-core's
 * search-first dedup recognizes a re-run instead of filing a twin.
 */
export function qualityBreachTitle(verdict: QualityDegradationVerdict): string {
  const metrics = [...new Set(verdict.breaches.map((b) => b.metric))].sort();
  return `Scout quality degradation: ${metrics.join(', ')}`;
}

const fmt = (v: number): string => String(Number(v.toFixed(4)));

/** Human-readable capture body: the breach lines + the window summary. */
export function qualityBreachBody(report: ScoutQualityReport, verdict: QualityDegradationVerdict): string {
  return [
    `Scout standing quality check: ${verdict.breaches.length} metric(s) past tolerance vs the recorded baseline.`,
    '',
    ...verdict.breaches.map((b) => `- ${b.metric}: baseline ${fmt(b.baseline)} -> current ${fmt(b.current)}`),
    '',
    `Window: ${report.windowCycles} cycles over ${report.totalTicks} ticks (${report.errorTicks} errors); ` +
      `${report.accepted} accepted / ${report.rejected} rejected / ${report.pending} pending of ` +
      `${report.totalRouted} routed; spend $${report.totalSpendUsd.toFixed(2)}.`,
  ].join('\n');
}

/**
 * The composed standing check: read snapshots → compute report → evaluate vs
 * baseline → on degradation file EXACTLY ONE improvements capture (kind
 * 'change', sourceRole 'system', sub-topic 'scout-quality') through the
 * injected port. Returns the report + verdict either way so the caller (the
 * standing routine) can log/persist the fresh report as the next baseline.
 */
export async function checkAndFlagQuality(deps: CheckAndFlagQualityDeps): Promise<QualityCheckResult> {
  const inputs = await deps.readInputs();
  const report = computeScoutQualityReport(inputs);
  const verdict = evaluateQualityDegradation(report, deps.baseline, deps.tolerances ?? {});
  if (!verdict.degraded) return { report, verdict, captured: false };
  await deps.capture({
    title: qualityBreachTitle(verdict),
    kind: 'change',
    body: qualityBreachBody(report, verdict),
    subTopic: 'scout-quality',
    sourceRole: 'system',
  });
  return { report, verdict, captured: true };
}

// ── assembly: the production reader (thin, PG edge stays lazy) ────────────────

export interface BuildQualityInputsOptions extends ScoutLedgerOpts {
  /** Max tick rows in the window snapshot (newest-first). Default 500. */
  tickLimit?: number;
  /** Lens-weight options forwarded to gatherLensOutcomes. */
  weights?: LensWeightOptions;
}

/**
 * Read the real ledgers into {@link ScoutQualityInputs}: the tick window
 * (readScoutTicks), the routed-idea ledger (readRoutedIdeas), and the lens
 * outcomes over the production reader bag (gatherLensOutcomes — which already
 * degrades each reader to empty on failure). Lazy imports keep this module's
 * pure core importable without the PG edge. Assembly only — no derivation here.
 */
export async function buildQualityReportInputs(
  opts: BuildQualityInputsOptions = {},
): Promise<ScoutQualityInputs> {
  const [tickLedger, routedLedger] = await Promise.all([
    import('./tick-ledger'),
    import('./routed-ledger'),
  ]);
  const ledgerOpts: ScoutLedgerOpts = {
    ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
    ...(opts.harnessSlug ? { harnessSlug: opts.harnessSlug } : {}),
    ...(opts.cycleId ? { cycleId: opts.cycleId } : {}),
    ...(opts.limit != null ? { limit: opts.limit } : {}),
  };
  const [ticks, routedIdeas, lensOutcomes] = await Promise.all([
    tickLedger.readScoutTicks({
      ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
      ...(opts.harnessSlug ? { installSlug: opts.harnessSlug } : {}),
      ...(opts.tickLimit != null ? { limit: opts.tickLimit } : {}),
    }),
    routedLedger.readRoutedIdeas(ledgerOpts),
    gatherLensOutcomes(routedLedger.buildScoutOutcomeReaders(ledgerOpts), opts.weights ?? {}),
  ]);
  return { ticks, routedIdeas, lensOutcomes };
}
