/**
 * agent-plane-measurement.ts — P-015 of unified-agent-state-plane-2026-07-27:
 * the baseline + standing measurement for the whole plane.
 *
 * P-015's own text names the failure it exists to prevent: *"the non-monotonic
 * 47.1% → 59.1% → 34.9% evidence-compliance curve … the signature of a rule
 * carried by prose rather than structure."* So this module carries its rules in
 * TYPES, not in comments — see {@link MetricSpec.vacuousPassWhen}, which the
 * compiler will not let a metric omit.
 *
 * ── IT COMPOSES; IT DOES NOT RE-DERIVE (D-038 axis 5) ───────────────────────
 *
 * Every number here is produced by a detector that ALREADY computes it:
 * `agent-state-divergence.ts`'s {@link DivergenceCoverage} (which documents
 * `stampFillRate` as "THE number P-015 measures"), `agent-facts/conflicts.ts`'s
 * `ConflictCoverage.comparedPairs`, and `agent-tools/facts/dependency-staleness.ts`'s
 * fresh/changed verdicts. This module owns the FUNNEL and the disclosure; it owns
 * no derivation of its own. D-046 also forbids a fourth pull read over
 * `tool_invocations`, so re-reading would be wrong twice over.
 *
 * ── THE THREE-LEVEL FUNNEL, AND WHY TWO DENOMINATORS ARE NOT ONE ────────────
 *
 *   population  — units examined in the window
 *   eligible    — of those, the units carrying the INPUT this metric needs
 *   comparable  — of those, the units on which a verdict was actually POSSIBLE
 *   observed    — the finding
 *
 * `fillRate = eligible/population` and `rate = observed/comparable` are DIFFERENT
 * questions and collapsing them is the exact defect D-089 was written about:
 *
 * > "'Structurally always-NULL' and 'nobody declared anything' are different
 * >  facts; only the measurement separates them."
 *
 * A metric can examine 176,784 calls and still be uncomputable because none of
 * them carried a stamp. With one denominator that reads as `0.0 — healthy`. With
 * two it reads as `fillRate 0.0 — the producer has never written`, which is the
 * truth. Hence also {@link PlaneMetric.rate} being **null, never 0**, when
 * `comparable` is 0: a rate of zero is a finding, and this is the absence of one.
 *
 * ── PRE-REGISTRATION IS A FROZEN TABLE, NOT A PROMISE (D-030 §3) ────────────
 *
 * D-030 requires P-015 to "pre-register the metric and the N". {@link METRIC_SPECS}
 * is that pre-registration: the id, the question, the producer and the vacuous-pass
 * answer are FIXED CONSTANTS, and {@link composePlaneMeasurement} may only fill in
 * counts. A run therefore cannot invent a metric, quietly restate its question to
 * match a number it happens to have, or ship one without declaring how it could
 * mislead. `agent-plane-measurement.test.ts` asserts the table is total.
 *
 * ── WHAT THIS MEASURES IS NOT WHAT P-015's ITEM TEXT SAYS (D-032) ───────────
 *
 * The item lists "cells-read vs values-transcribed-into-prose". **D-032 corrects
 * that metric and this module implements the correction**: counting transcriptions
 * measures PRESENTATION — the very question D-030 was settling, and one this
 * fleet's own data now DISFAVOURS as the cell plane's justification. The corrected
 * quantity is *how often an agent acts on a value that was already stale or wrong
 * at the moment it acted* ({@link 'acted-on-stale-or-wrong-value'}), and D-032 is
 * explicit that staleness and wrongness are ONE defect class to be counted
 * together, not two axes.
 */

/**
 * The pre-registered metric set. Two divergence legs rather than one, because
 * D-091 gates delivery PER LEG: the sampling leg is live today while the stamped
 * leg cannot run at all, and a single fused metric would either suppress the
 * working leg or report from the dead one.
 */
export const PLANE_METRIC_IDS = [
  'intent-action-divergence-stamped',
  'intent-action-divergence-sampling',
  'clarification-rate',
  'conflicting-assumption-incidence',
  'acted-on-stale-or-wrong-value',
  'plane-token-cost',
] as const;
export type PlaneMetricId = (typeof PLANE_METRIC_IDS)[number];

/**
 * Why a metric reported nothing. Only `'clean'` is an informative zero — the
 * others all mean "nothing was measured", which is the misread this whole module
 * exists to prevent. Same shape and same rule as the sibling detectors'
 * `DIVERGENCE_ZERO_REASONS` / `CONFLICT_ZERO_REASONS`.
 */
export const PLANE_ZERO_REASONS = [
  /** Nothing was examined at all — an idle window, not a verdict. */
  'population-empty',
  /**
   * Units were examined but none carried the metric's input. THE D-089 case: the
   * producer has never written, so the metric is not merely zero, it is unbuilt.
   */
  'nothing-eligible',
  /**
   * The input was present but no unit admitted a verdict (e.g. stamps exist but
   * no bucket holds two comparable calls). A partial answer wearing a zero.
   */
  'nothing-comparable',
  /** `comparable > 0` and `observed === 0`. The ONLY zero that is good news. */
  'clean',
] as const;
export type PlaneZeroReason = (typeof PLANE_ZERO_REASONS)[number];

/** True when the zero means "nothing was measured", not "nothing was wrong". */
export function isStructuralZero(reason: PlaneZeroReason | null): boolean {
  return reason !== null && reason !== 'clean';
}

/**
 * D-030 §3 requires a minimum of TWO batches per condition before any trend is
 * reported, because in su-07374's experiment *"within-arm variance >= between-arm
 * variance"* — the same arm scored 2/3 then 0/3. A single-batch delta "will report
 * noise with a straight face".
 */
export const MIN_BATCHES_FOR_VARIANCE = 2;

/** The immutable half of a metric: everything fixed BEFORE any data is seen. */
export interface MetricSpec {
  id: PlaneMetricId;
  /** The question, in one line. Frozen so a run cannot restate it to fit a number. */
  question: string;
  /**
   * The surface that must WRITE for this metric to become computable. Named, not
   * described, so a `fillRate` of 0 points at a producer instead of reading as a
   * clean result (D-089).
   */
  inputProducer: string;
  /** Unit of `population` / `eligible`. */
  unit: string;
  /** Unit of `comparable` / `observed` — often, but not always, the same as `unit`. */
  verdictUnit: string;
  /**
   * ⚠ D-030 §3, REQUIRED OF EVERY METRIC BEFORE IT SHIPS A NUMBER: *"what state of
   * the world makes this pass for the WRONG reason?"*
   *
   * It is a required field rather than a doc comment on purpose. D-030 observed
   * two metrics passing vacuously — *no-contradiction* passed 6/6 only because the
   * agent never reached a proposal (you cannot contradict a plan you never
   * formed), and *surfaces-the-undetermined-question* passed at ceiling in the
   * control precisely BECAUSE the control was told nothing. Both read as passes on
   * a dashboard. A prose convention would not have caught either; a required field
   * means the question cannot go unanswered for a metric that ships.
   */
  vacuousPassWhen: string;
}

/** The counts a run supplies for one metric. All four are required — an omitted
 *  denominator is how a rate silently becomes uninterpretable. */
export interface MetricCounts {
  population: number;
  eligible: number;
  comparable: number;
  observed: number;
}

/** A pre-registered metric with one window's counts attached. */
export interface PlaneMetric extends MetricSpec, MetricCounts {
  /** `eligible / population` — D-089's number. Null only when nothing was examined. */
  fillRate: number | null;
  /**
   * `observed / comparable`. **Null, never 0, when `comparable` is 0** — see the
   * module header: a zero rate is a finding and this is the absence of one.
   */
  rate: number | null;
  zeroReason: PlaneZeroReason | null;
  /** False when the number must not be read as a verdict about the fleet. */
  interpretable: boolean;
}

export interface PlaneMeasurement {
  measuredAt: string;
  windowStartMs: number;
  windowEndMs: number;
  metrics: PlaneMetric[];
  /** Metrics that could report a rate at all. */
  interpretableCount: number;
  /** Metrics whose input producer has never written — the headline, not a footnote. */
  awaitingProducer: PlaneMetricId[];
  /** One line stating how much of the plane is actually measurable right now. */
  summary: string;
}

/**
 * THE PRE-REGISTRATION (D-030 §3). Frozen before data.
 *
 * Every `vacuousPassWhen` below was written against the LIVE corpus measured on
 * 2026-07-27, not imagined: 176,784 calls in 24h carrying 0 stamps of any kind,
 * and 2,148 `agent_facts` rows carrying 0 assumptions, 0 `dependsOn` and 0 typed
 * claims. Four of these six metrics are structurally unmeasurable today, and
 * saying so IS the baseline.
 */
export const METRIC_SPECS: Readonly<Record<PlaneMetricId, MetricSpec>> = Object.freeze({
  'intent-action-divergence-stamped': {
    id: 'intent-action-divergence-stamped',
    question:
      'Within one declared intent, how often do an agent’s calls span two different goals without a re-declaration?',
    inputProducer: 'P-009’s stamp writer → tool_invocations.intent_event_id + goal_ref',
    unit: 'tool call',
    verdictUnit: 'intent bucket',
    vacuousPassWhen:
      'The P-009 stamp writer is not deployed, so fillRate is 0, no bucket holds two comparable calls, and the leg reports nothing for the same reason a perfectly-disciplined fleet would. Read `fillRate`, never `rate`, until the stamp is live.',
  },
  'intent-action-divergence-sampling': {
    id: 'intent-action-divergence-sampling',
    question:
      'How often does an agent fail the same tool ≥3× in 10 minutes — acting without its reasoning converging (MAST FM-2.6)?',
    inputProducer: 'tool_invocations failure rows — needs no stamp, so this leg is live today',
    unit: 'tool call',
    verdictUnit: 'observed failure',
    vacuousPassWhen:
      'A window in which the fleet was IDLE produces the same clean zero as a window in which every agent converged. `population` separates them; `rate` alone does not. A fleet that has learned to retry more SLOWLY also improves this number without converging any better.',
  },
  'clarification-rate': {
    id: 'clarification-rate',
    question: 'How often does an agent stop and ask rather than proceed on an unverified premise?',
    inputProducer: 'coord:ask · coord:ask-owner · conversations:post · conversations:answer',
    unit: 'attributed tool call',
    verdictUnit: 'clarification-shaped call',
    vacuousPassWhen:
      'A LOW rate is ambiguous BY CONSTRUCTION — equally consistent with agents having enough context (the win) and with agents guessing instead of asking (the loss). It is only interpretable read ALONGSIDE `acted-on-stale-or-wrong-value`, never on its own. D-030 §4 adds the opposite hazard: clarification-seeking measurably WIDENS prompt-injection exposure, so a rising rate is not automatically good either.',
  },
  'conflicting-assumption-incidence': {
    id: 'conflicting-assumption-incidence',
    question: 'How often do two live assumptions over the same referent contradict each other?',
    inputProducer: 'facts:assert { kind:"assumption", claim, dependsOn } → harness_shared.agent_facts',
    unit: 'agent_facts row',
    verdictUnit: 'compared pair',
    vacuousPassWhen:
      'ZERO assumptions have ever been filed (0 of 2,148 rows, measured 2026-07-27 and unchanged since D-087 measured 0 of 2,088), so `comparedPairs` is 0 and the detector reports no conflict for precisely the same reason it would in a perfectly-aligned fleet. This is D-087’s "read with no producer" — the metric is unbuilt, not clean.',
  },
  'acted-on-stale-or-wrong-value': {
    id: 'acted-on-stale-or-wrong-value',
    question:
      'How often does an agent act on a value that was ALREADY stale or wrong at the moment it acted? (D-032’s correction of this item’s literal text.)',
    inputProducer:
      'facts:assert { dependsOn } → dependency-staleness capture (captureFactDependencies), re-digested by markStaleDependencyFacts',
    unit: 'agent_facts row',
    verdictUnit: 'fact carrying a dependency observation',
    vacuousPassWhen:
      'No fact has ever declared `dependsOn` (0 of 2,148), so there is nothing to re-digest. Worse in the non-empty case: an `undeterminable` verdict — the declared cell no longer resolves — is EXCLUDED from `comparable` rather than counted fresh, because counting a broken resolver as fresh converts an instrument failure into a clean bill of health, which is this metric’s own failure mode.',
  },
  'plane-token-cost': {
    id: 'plane-token-cost',
    question: 'What payload does the plane actually add to the surfaces it enriches?',
    inputProducer: 'tool_invocations.output_size on the enriched surfaces',
    unit: 'tool call on an enriched surface',
    verdictUnit: 'output byte',
    vacuousPassWhen:
      'NONE of the plane’s enrichments are deployed yet, so this window is the PRE-enrichment baseline. Reading a low number as "the plane is cheap" is exactly backwards — the cost is the DELTA against this row once the enrichments are live, and there is no delta to read until then.',
  },
});

/** 4dp, matching `DivergenceCoverage.stampFillRate`, so the two agree on the wire. */
function ratio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(denominator) || denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

function zeroReasonFor(c: MetricCounts): PlaneZeroReason | null {
  if (c.observed > 0) return null;
  if (c.population <= 0) return 'population-empty';
  if (c.eligible <= 0) return 'nothing-eligible';
  if (c.comparable <= 0) return 'nothing-comparable';
  return 'clean';
}

/** Guard against a negative or non-finite count silently poisoning a rate. */
function clamp(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Attach one window's counts to a pre-registered spec.
 *
 * Total: an out-of-range count is clamped rather than thrown on, because this runs
 * inside a sweep and a measurement that throws takes the tick down with it.
 */
export function buildMetric(id: PlaneMetricId, raw: MetricCounts): PlaneMetric {
  const spec = METRIC_SPECS[id];
  const counts: MetricCounts = {
    population: clamp(raw.population),
    eligible: clamp(raw.eligible),
    comparable: clamp(raw.comparable),
    observed: clamp(raw.observed),
  };
  const zeroReason = zeroReasonFor(counts);
  return {
    ...spec,
    ...counts,
    fillRate: ratio(counts.eligible, counts.population),
    rate: ratio(counts.observed, counts.comparable),
    zeroReason,
    // A metric is interpretable exactly when a verdict was possible. `observed > 0`
    // implies it was, so a finding is never suppressed by a mis-supplied denominator.
    interpretable: counts.observed > 0 || counts.comparable > 0,
  };
}

/** Every metric's counts for one window, keyed by id — total by construction, so a
 *  new metric id cannot be forgotten at a call site. */
export type PlaneCounts = Readonly<Record<PlaneMetricId, MetricCounts>>;

/**
 * Compose the whole measurement. PURE and deterministic — same counts, same row.
 *
 * The `summary` leads with how much of the plane is measurable rather than with a
 * rate, because on today's corpus four of six metrics are structurally empty and a
 * summary that opened with "0 divergences, 0 conflicts" would be the precise
 * misreading D-089 and D-087 were both written to prevent.
 */
export function composePlaneMeasurement(args: {
  counts: PlaneCounts;
  windowStartMs: number;
  windowEndMs: number;
  measuredAt?: string;
}): PlaneMeasurement {
  const metrics = PLANE_METRIC_IDS.map((id) => buildMetric(id, args.counts[id]));
  const interpretableCount = metrics.filter((m) => m.interpretable).length;
  const awaitingProducer = metrics
    .filter((m) => m.zeroReason === 'nothing-eligible' || m.zeroReason === 'population-empty')
    .map((m) => m.id);

  const findings = metrics.filter((m) => m.observed > 0);
  const summary =
    `${interpretableCount}/${PLANE_METRIC_IDS.length} plane metrics are measurable in this window` +
    (awaitingProducer.length
      ? `; ${awaitingProducer.length} awaiting a producer (${awaitingProducer.join(', ')})`
      : '') +
    (findings.length
      ? `; findings: ${findings.map((m) => `${m.id}=${m.observed}/${m.comparable}`).join(', ')}`
      : '; no findings in the measurable metrics');

  return {
    measuredAt: args.measuredAt ?? new Date(args.windowEndMs).toISOString(),
    windowStartMs: args.windowStartMs,
    windowEndMs: args.windowEndMs,
    metrics,
    interpretableCount,
    awaitingProducer,
    summary,
  };
}

/** The verdict of looking at one metric ACROSS windows. */
export interface SeriesAssessment {
  n: number;
  mean: number | null;
  min: number | null;
  max: number | null;
  /** max - min. The number D-030 says must be visible before any delta is believed. */
  spread: number | null;
  verdict: 'insufficient-batches' | 'reportable';
  note: string;
}

/**
 * Assess a metric across windows — the standing half of "baseline and standing
 * measurement".
 *
 * ⚠ IT REFUSES TO REPORT A TREND FROM ONE BATCH, and that refusal is the point.
 * D-030 measured within-arm variance at or above between-arm variance (arm C
 * scored 2/3 then 0/3 on the same scenario), so a single-window delta is noise
 * presented as a result.
 *
 * ⚠ D-035 (STANDING RULE) — *"an effect size may NEVER be inferred from a power
 * requirement."* `insufficient-batches` therefore means "this instrument has not
 * been read enough times to say anything", NEVER "the effect is small". A caller
 * that renders it as the latter has re-introduced exactly the inference D-035
 * forbids.
 */
export function assessSeries(values: readonly (number | null)[]): SeriesAssessment {
  const usable = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (usable.length < MIN_BATCHES_FOR_VARIANCE) {
    return {
      n: usable.length,
      mean: null,
      min: null,
      max: null,
      spread: null,
      verdict: 'insufficient-batches',
      note:
        `Fewer than ${MIN_BATCHES_FOR_VARIANCE} windows carry a rate, so variance is invisible and no ` +
        'trend may be reported (D-030 §3). This says nothing about the SIZE of any effect — inferring ' +
        'a small effect from a thin series is the inference D-035 forbids.',
    };
  }
  const min = Math.min(...usable);
  const max = Math.max(...usable);
  const mean = usable.reduce((a, b) => a + b, 0) / usable.length;
  return {
    n: usable.length,
    mean: Math.round(mean * 10_000) / 10_000,
    min,
    max,
    spread: Math.round((max - min) * 10_000) / 10_000,
    verdict: 'reportable',
    note: `${usable.length} windows; spread ${Math.round((max - min) * 10_000) / 10_000} must be read alongside any claimed change.`,
  };
}

/** Render a zero honestly, in one line, wherever a reader meets it. */
export function explainZero(reason: PlaneZeroReason): string {
  switch (reason) {
    case 'population-empty':
      return 'nothing was examined in this window — an idle instrument, not a verdict';
    case 'nothing-eligible':
      return 'units were examined but none carried this metric’s input — the producer has not written, so the metric is unbuilt rather than clean';
    case 'nothing-comparable':
      return 'the input was present but no unit admitted a verdict — a partial answer wearing a zero';
    case 'clean':
      return 'a verdict was possible and nothing was found — the only zero that is good news';
  }
}
