/**
 * THE INTERPRETABILITY RATCHET
 * (agent-state-plane-verification-2026-07-27 P-003).
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * P-015's sweep writes one `agent_plane_measurements` row per window carrying
 * `interpretable_count / metric_count`. On the live series that has read 3/6,
 * then 4/6 from 14:34 onward — the step where P-009's stamp writer came online
 * and `intent-action-divergence-stamped` became measurable for the first time.
 *
 * The plane's whole argument is that an unbuilt metric must report
 * `interpretable: false` rather than a clean zero. That rule is what made WI-6465
 * findable at all. But it only pays off if someone NOTICES when the number moves
 * — in either direction. Two things have to be true and nothing was checking
 * either:
 *
 *   1. A metric that once worked must not quietly stop working. A producer that
 *      dies takes its metric back to `interpretable: false`, and the resulting
 *      "0 conflicts" is indistinguishable on a dashboard from a healthy fleet.
 *   2. A metric known to be unbuilt must become interpretable when its producer
 *      is declared built — otherwise WI-6465 can be closed while the instrument
 *      that would show the fix working is still blind.
 *
 * ── ⚠ THE VACUOUS PASS: RATCHETING THE COUNT ────────────────────────────────
 *
 * The obvious implementation — the one the plan item's own wording invites, and
 * the one this module deliberately does NOT do — is to assert that
 * `interpretable_count` never decreases.
 *
 * `interpretable_count` is an AGGREGATE, and an aggregate cannot see a swap. If
 * `conflicting-assumption-incidence` becomes measurable in the same window that
 * `intent-action-divergence-stamped` dies, the count stays 4 and a count-ratchet
 * reports "holding" — while a producer this plane depends on has just failed.
 * The count is exactly as high as before, which is precisely why it is worthless:
 * the one event the ratchet exists to catch is the one event it cannot see.
 *
 * So the ratchet is PER-METRIC. `interpretable_count` is reported because it is a
 * useful headline, and it is never the thing asserted on.
 *
 * ── ⚠ AND: "NEVER WORKED" IS NOT "STOPPED WORKING" ──────────────────────────
 *
 * These two have the same symptom — `interpretable: false` today — and opposite
 * causes, owners and urgencies. `never-interpretable` is an unbuilt producer: it
 * is a filed, owned gap (WI-6465) and re-failing the build for it teaches the
 * fleet to ignore this gate. `regressed` is a producer that DEMONSTRABLY WORKED
 * and has stopped, which is a live incident nobody has noticed yet.
 *
 * Collapsing them into "not interpretable" is the same mistake as P-001's
 * `no-producer` vs `no-data`, one layer up: it makes a dead producer read like a
 * feature that was never built, so nobody is paged for it.
 */
import { PLANE_METRIC_IDS, type PlaneMetricId, type PlaneZeroReason } from './agent-plane-measurement';

/**
 * `never-interpretable` and `no-data` are NEITHER pass nor fail — they are the
 * two "we cannot say" states, kept apart for the reasons in the header.
 */
export const RATCHET_VERDICTS = [
  /** Interpretable now, and either always was or newly became so. The good state. */
  'holding',
  /** Was interpretable in an earlier window and is NOT now. A producer died. */
  'regressed',
  /** Never once interpretable across the whole series. An unbuilt producer. */
  'never-interpretable',
  /**
   * Claims `interpretable: true` while its OWN funnel says nothing was eligible.
   * A metric cannot have a comparable unit it never made eligible, so this is not
   * a bad reading — it is an incoherent one, and it is the shape a "fix" takes
   * when someone relabels a zero instead of building the producer.
   */
  'incoherent',
  /** No windows to judge. Says nothing about any producer. */
  'no-data',
] as const;
export type RatchetVerdict = (typeof RATCHET_VERDICTS)[number];

/**
 * Which open item explains a metric that has never been interpretable.
 *
 * A metric whose emptiness NOTHING explains is not exempt — it fails. The point
 * of naming the item is that the exemption expires when the item closes: see
 * {@link judgeKnownGap}, which turns the exemption into a hard failure the moment
 * someone reports the producer built.
 */
export const METRIC_KNOWN_GAPS: Readonly<Partial<Record<PlaneMetricId, string>>> = Object.freeze({
  'conflicting-assumption-incidence': 'WI-6465',
  'acted-on-stale-or-wrong-value': 'WI-6465',
  // The two COMMITMENT-backed legs added with the metric ids themselves
  // (WI-6465 / D-102). Their SHAPE exists; their PRODUCER does not yet emit —
  // verified against the live series 2026-07-27, where every recorded window
  // through 18:36 still carries metric_count 6 and does not mention these ids
  // at all. So they are `never-interpretable` for the same open item as the two
  // above, and belong here rather than being assumed interpretable: an
  // unexplained empty metric is designed to FAIL, and WI-6465 closing is
  // exactly what should turn these into hard failures if the producer is still
  // silent (see judgeKnownGap + the ratchet test that pins that).
  'acted-on-stale-declared-basis': 'WI-6465',
  'closed-work-basis-moved': 'WI-6465',
});

/** One metric's state in one window, as read back from a measurement row. */
export interface MetricWindow {
  measuredAt: string;
  interpretable: boolean;
  /** `eligible / population`. Null when nothing was examined. */
  fillRate: number | null;
  zeroReason: PlaneZeroReason | null;
}

export interface RatchetRow {
  metric: PlaneMetricId;
  verdict: RatchetVerdict;
  everInterpretable: boolean;
  interpretableNow: boolean;
  /** When it first became measurable — the evidence that it CAN be. */
  firstInterpretableAt: string | null;
  /** The last window it worked in. For a regression, when it died. */
  lastInterpretableAt: string | null;
  windows: number;
  knownGap?: string;
  /** Set when the known gap's item has closed, so the exemption no longer applies. */
  gapClosed?: boolean;
}

/**
 * A metric asserting interpretability its own counts cannot support.
 *
 * `fillRate === 0` means no unit was ever eligible; `comparable` is a subset of
 * eligible, so nothing could have been comparable, so nothing was interpretable.
 * A row claiming otherwise has had its labels moved without its funnel being
 * built — which is the one "fix" for an unbuilt metric that must never pass.
 */
export function isIncoherent(w: MetricWindow): boolean {
  if (!w.interpretable) return false;
  if (w.zeroReason === 'nothing-eligible' || w.zeroReason === 'population-empty') return true;
  return w.fillRate === 0;
}

/**
 * Judge ONE metric across its windows, oldest-first.
 *
 * Pure ({ windows } -> verdict), so every distinction above is testable against
 * literal arrays with no database — which matters because the states that must
 * be told apart (a died-yesterday producer, a never-built one) are exactly the
 * ones a live box will not be in on the day you write the check.
 */
export function judgeMetricRatchet(windows: readonly MetricWindow[]): RatchetVerdict {
  if (windows.length === 0) return 'no-data';
  const latest = windows[windows.length - 1];
  if (isIncoherent(latest)) return 'incoherent';
  const everInterpretable = windows.some((w) => w.interpretable && !isIncoherent(w));
  if (latest.interpretable) return 'holding';
  return everInterpretable ? 'regressed' : 'never-interpretable';
}

/**
 * Does a known gap still excuse this metric?
 *
 * THE RATCHET'S TEETH. While the item is open the metric is REPORTED and passes.
 * The moment it closes, the exemption is gone and an uninterpretable metric FAILS
 * — so the producer fix cannot be reported done while the instrument that would
 * show it working is still blind. That transition is the entire point of P-003;
 * without it, closing WI-6465 silently retires the only evidence anyone had that
 * the assumption vertical was dead.
 */
export function judgeKnownGap(args: {
  verdict: RatchetVerdict;
  knownGap?: string;
  gapClosed?: boolean;
}): 'exempt' | 'fails' | 'not-applicable' {
  if (args.verdict !== 'never-interpretable') return 'not-applicable';
  if (!args.knownGap) return 'fails';
  return args.gapClosed ? 'fails' : 'exempt';
}

export interface RatchetReport {
  rows: RatchetRow[];
  windows: number;
  /** Highest `interpretable_count` the series ever reached — reported, not asserted on. */
  highWaterCount: number;
  currentCount: number;
  metricCount: number;
  /** Verdicts that fail: a regression, an incoherent row, or an unexcused gap. */
  failures: RatchetRow[];
  /** Reported and tolerated: a gap whose item is still open. */
  exempt: RatchetRow[];
}

/**
 * Roll a whole series into a ratchet report.
 *
 * `series` is oldest-first, each entry one measurement window's per-metric state.
 * `closedGaps` names the known-gap items that have since closed — supplied by the
 * caller because whether WI-6465 is open is a live fact, not a property of the
 * numbers, and baking it in would make this untestable.
 */
export function ratchetPlaneSeries(args: {
  series: ReadonlyArray<{ measuredAt: string; metrics: ReadonlyArray<{ id: string } & MetricWindow> }>;
  closedGaps?: ReadonlySet<string>;
}): RatchetReport {
  const { series, closedGaps = new Set<string>() } = args;
  const rows: RatchetRow[] = [];

  for (const metric of PLANE_METRIC_IDS) {
    const windows: MetricWindow[] = [];
    for (const point of series) {
      const found = point.metrics.find((m) => m.id === metric);
      if (found) windows.push(found);
    }
    const interpretableWindows = windows.filter((w) => w.interpretable && !isIncoherent(w));
    const verdict = judgeMetricRatchet(windows);
    const knownGap = METRIC_KNOWN_GAPS[metric];
    rows.push({
      metric,
      verdict,
      everInterpretable: interpretableWindows.length > 0,
      interpretableNow: windows.length > 0 && windows[windows.length - 1].interpretable,
      firstInterpretableAt: interpretableWindows[0]?.measuredAt ?? null,
      lastInterpretableAt: interpretableWindows[interpretableWindows.length - 1]?.measuredAt ?? null,
      windows: windows.length,
      ...(knownGap ? { knownGap, gapClosed: closedGaps.has(knownGap) } : {}),
    });
  }

  const countAt = (point: (typeof series)[number]) =>
    point.metrics.filter((m) => m.interpretable).length;

  const failures = rows.filter((r) => {
    if (r.verdict === 'regressed' || r.verdict === 'incoherent') return true;
    return judgeKnownGap(r) === 'fails';
  });

  return {
    rows,
    windows: series.length,
    highWaterCount: series.length ? Math.max(...series.map(countAt)) : 0,
    currentCount: series.length ? countAt(series[series.length - 1]) : 0,
    metricCount: PLANE_METRIC_IDS.length,
    failures,
    exempt: rows.filter((r) => judgeKnownGap(r) === 'exempt'),
  };
}
