/**
 * rerank-decision.ts — the inferential core of the reranker INTEGRATION
 * benchmark (WI-37653, owner-directed 2026-08-10: "make a much better benchmark
 * of the reranker so we can properly decide how to integrate it" + "make sure it
 * has enough data to be conclusive").
 *
 * Split from the CLI for the reason `corpus-clarity-validity.ts` and
 * `paired-leg-report.ts` were: the CLI half talks to Postgres and the search
 * engine so none of it is unit-testable, and THESE functions are where the run's
 * conclusions are formed. A wrong statistic still looks like a statistic.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS AT ALL — the defect it is built to not repeat
 *
 * D-093 closed P-008 ("rerank: measured and not adopted") on a run whose
 * headline was `known-item admitted 0/7 in both arms`. That decision record
 * states its own ceiling honestly: only **2 of 7** batches were `order-blocked`
 * (in the pool, lost on rank). The other 5 were NOT-RETRIEVED, which no
 * reordering can fix. So the effective sample was 2, and 0/2 is consistent with
 * a true rescue rate up to ~78% (rule of three). The null was a POWER FAILURE
 * being read as a finding.
 *
 * And more runs could not have fixed it: `wi-6512-replay.ts` REPLAY is a FIXED
 * 7-batch RECONSTRUCTION of one investigation session whose raw transcript is
 * gone. n=7 was the size of the entire fixture, not a sampling choice.
 *
 * Two design consequences, both encoded here rather than left to the reader:
 *
 *   1. EVERY null carries its MDE. `pairedDifference` reports the minimum
 *      effect the run could have detected, so "no effect" always reads as "no
 *      effect larger than X" and can never again be published as "no effect".
 *   2. STRATIFY BY OPPORTUNITY. Reranking is a REORDER: it can only act where
 *      the relevant row is in the pool but below the cut. Measuring it over
 *      unstratified traffic dilutes a real effect by 1/share and needs ~1/share²
 *      the samples to recover — which is exactly how a 2/7 signal vanished.
 */

/**
 * Where a query sits relative to what reranking can physically change.
 *
 * This is the same taxonomy `wi-6512-known-item-replay-cli.ts` prints
 * (ADMITTED · ORDER-blocked · FILTER-blocked · NOT-RETRIEVED); it lives here so
 * it is testable and so the two benches cannot drift apart on the one
 * classification the whole decision rests on.
 */
export type RerankOpportunity =
  /** Already above the cut without reranking. A reorder can only LOSE ground. */
  | 'admitted'
  /** In the candidate pool but below the cut. The ONLY stratum rerank can win. */
  | 'order-blocked'
  /** Never in the candidate pool. No reordering can conjure it. */
  | 'not-retrieved';

/**
 * Classify one query by where its known-relevant row landed in the CONTROL arm.
 *
 * `poolRank` is 0-based within the over-fetched candidate pool, or `null` when
 * retrieval never returned the row at all. `cut` is how many rows survive to the
 * consumer (the page size, or the slot count the char budget allows).
 *
 * ⚠ Classification MUST come from the control arm. Classifying on the treatment
 * arm's ranks would define the strata using the very reordering under test, so
 * a query would migrate between strata as a RESULT of the treatment and the
 * comparison would no longer be paired on a fixed population.
 */
export function classifyOpportunity(poolRank: number | null, cut: number): RerankOpportunity {
  if (poolRank === null || poolRank < 0) return 'not-retrieved';
  return poolRank < cut ? 'admitted' : 'order-blocked';
}

/** Two-sided 95% normal quantile. */
const Z_95 = 1.959963985;
/** One-sided normal quantile for 80% power. */
const Z_POWER_80 = 0.841621234;

export interface PairedDifference {
  /** Usable pairs (both arms present). */
  n: number;
  /** mean(treatment − control). Positive = treatment better. */
  meanDiff: number;
  /** Sample SD of the per-pair differences. */
  sdDiff: number;
  /** Standard error of `meanDiff`. */
  se: number;
  /** 95% CI for the true mean difference. */
  ci95: readonly [number, number];
  /**
   * MINIMUM DETECTABLE EFFECT at this n, alpha=0.05 two-sided, power=0.80.
   *
   * THE FIELD THIS MODULE EXISTS FOR. A null result is only interpretable
   * beside it: `meanDiff ≈ 0` with `mde80 = 0.01` is strong evidence of no
   * useful effect, while the same `meanDiff` with `mde80 = 0.35` is evidence of
   * nothing whatsoever. D-093 published the second shape as if it were the
   * first.
   */
  mde80: number;
  /**
   * True when the CI contains 0 AND the MDE is small enough that the null is
   * informative. `null` when the run simply lacked power to say anything —
   * deliberately NOT `false`, because "we could not tell" and "there is no
   * effect" are the two readings this whole file exists to keep apart.
   */
  nullIsInformative: boolean | null;
}

/**
 * Paired inference over per-query (control, treatment) outcomes.
 *
 * Paired because both arms run the SAME queries against the SAME corpus
 * instant: the per-query variance in retrieval difficulty is enormous compared
 * with the treatment effect, and an unpaired comparison spends all its power
 * measuring that instead.
 *
 * `informativeNullThreshold` is the effect size below which we would not care —
 * the caller's judgement, not a statistical constant. For nDCG, 0.02 (two
 * points) is a conventional floor for "worth shipping".
 *
 * Returns `null` when fewer than 3 pairs survive: an SD from 2 points is not a
 * measurement, and returning a plausible-looking object would invite exactly
 * the over-reading this module was built to prevent.
 */
export function pairedDifference(
  control: readonly number[],
  treatment: readonly number[],
  informativeNullThreshold = 0.02,
): PairedDifference | null {
  if (control.length !== treatment.length) return null;
  const diffs: number[] = [];
  for (let i = 0; i < control.length; i++) {
    const c = control[i];
    const t = treatment[i];
    if (typeof c !== 'number' || typeof t !== 'number') continue;
    if (!Number.isFinite(c) || !Number.isFinite(t)) continue;
    diffs.push(t - c);
  }
  const n = diffs.length;
  if (n < 3) return null;

  const meanDiff = diffs.reduce((a, b) => a + b, 0) / n;
  // Bessel-corrected: these are a SAMPLE of possible queries, not the population.
  const variance = diffs.reduce((acc, d) => acc + (d - meanDiff) ** 2, 0) / (n - 1);
  const sdDiff = Math.sqrt(variance);
  const se = sdDiff / Math.sqrt(n);
  const half = Z_95 * se;
  const mde80 = (Z_95 + Z_POWER_80) * se;

  const ciContainsZero = meanDiff - half <= 0 && meanDiff + half >= 0;
  const nullIsInformative = !ciContainsZero
    ? false
    : mde80 <= informativeNullThreshold
      ? true
      : null;

  return {
    n,
    meanDiff,
    sdDiff,
    se,
    ci95: [meanDiff - half, meanDiff + half] as const,
    mde80,
    nullIsInformative,
  };
}

/**
 * How many PAIRS are needed to detect `delta` at alpha=0.05 two-sided, 80% power,
 * given an expected per-pair SD.
 *
 * Use it to SIZE a run before spending on it — the step D-093's run skipped, and
 * the reason its sample could not have answered its own question.
 */
export function requiredPairs(sdDiff: number, delta: number): number | null {
  if (!(sdDiff > 0) || !(Math.abs(delta) > 0)) return null;
  return Math.ceil(((Z_95 + Z_POWER_80) * sdDiff / Math.abs(delta)) ** 2);
}

export interface Stratum {
  name: RerankOpportunity;
  /** Share of the POPULATION this stratum represents (base rate, sums to ~1). */
  share: number;
  /** Effect measured WITHIN this stratum (mean difference). */
  effect: number;
  /** Standard error of `effect` within this stratum. */
  se: number;
}

export interface PopulationEffect {
  /** Share-weighted population mean difference. */
  effect: number;
  se: number;
  ci95: readonly [number, number];
  /** Strata whose share was supplied but which contributed no measured effect. */
  unmeasured: readonly RerankOpportunity[];
}

/**
 * Reweight per-stratum effects back to the POPULATION.
 *
 * Needed because the run deliberately OVERSAMPLES `order-blocked` — the only
 * stratum where the treatment can act. Oversampling buys power; without this
 * reweighting it would also silently overstate the production effect by the
 * oversampling factor, which is a worse error than the one it fixes.
 *
 * `admitted` and `not-retrieved` are not assumed to contribute 0 — they are
 * measured too (rerank can DEMOTE an already-admitted row, a real cost that an
 * order-blocked-only run would never see). A stratum with no measured effect is
 * reported in `unmeasured` rather than being quietly treated as a zero.
 */
export function reweightToPopulation(strata: readonly Stratum[]): PopulationEffect | null {
  if (strata.length === 0) return null;
  const totalShare = strata.reduce((a, s) => a + s.share, 0);
  if (!(totalShare > 0)) return null;

  let effect = 0;
  let varSum = 0;
  const unmeasured: RerankOpportunity[] = [];
  for (const s of strata) {
    const w = s.share / totalShare;
    if (!Number.isFinite(s.effect)) {
      unmeasured.push(s.name);
      continue;
    }
    effect += w * s.effect;
    varSum += (w * s.se) ** 2;
  }
  const se = Math.sqrt(varSum);
  const half = Z_95 * se;
  return { effect, se, ci95: [effect - half, effect + half] as const, unmeasured };
}

export interface InstrumentValidity {
  ok: boolean;
  reasons: readonly string[];
  /** Non-void caveats that MUST be printed beside the verdict, never dropped. */
  warnings: readonly string[];
  /** Pairs the stage did not rerank — EXCLUDED from every delta, never mixed in. */
  excludedNonEngaged: number;
  /** attempted / total, or null when nothing ran. */
  engagementRate: number | null;
}

/**
 * Minimum share of queries on which the rerank stage must have ENGAGED for the
 * run to be analysable at all.
 *
 * Above the floor, non-engaged pairs are EXCLUDED from the delta (they are
 * treatment == control by construction, so mixing them in only dilutes the
 * estimate toward zero). Below it, the engine was substantially unavailable and
 * no subset of the run can be attributed to the reranker.
 */
export const MIN_ENGAGEMENT_RATE = 0.9;

/**
 * Would this run be publishable, or must it be VOIDED?
 *
 * `rerankRows` is fail-soft BY CONTRACT: with no engine it returns the input
 * order, byte-identical to the control arm. So a treatment that silently lost
 * its engine produces a clean 0.000 delta that reads exactly like "reranking
 * does not help" — and the natural response to that null is to abandon the
 * feature. The numbers alone cannot distinguish the two.
 *
 * D-093 already applied this discipline and it is kept deliberately. Added
 * here: `engine`, because `rerank.ts` resolves ZeroEntropy FIRST (:161/:238) and
 * the local cross-encoder only as a FALLBACK (:185) — so a benchmark that does
 * not RECORD which engine ran may be describing a different reranker from the
 * one deployed (WI-37649).
 */
export function instrumentValidity(input: {
  attempted: number;
  total: number;
  ordersMoved: number;
  engine: string | null;
}): InstrumentValidity {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const { attempted, total } = input;
  const engagementRate = total > 0 ? attempted / total : null;
  const excludedNonEngaged = Math.max(0, total - attempted);

  if (total <= 0) reasons.push('no queries ran');
  if (attempted <= 0) reasons.push('the rerank stage NEVER engaged — this is a dead-engine run, not a null result');
  else if (attempted < total) {
    // PARTIAL engagement is NOT a dead engine, and voiding the whole run for it
    // is a power failure of its own: one fail-soft query discarded 389 good
    // pairs on the 2026-08-10 pool=24 run. A fail-soft pair is treatment ==
    // control BY CONSTRUCTION, so the fix is to EXCLUDE it from the delta (see
    // the CLI's `engaged` filter), not to mix it in and not to bin the run.
    // The floor keeps D-093's protection: a substantially dead engine still voids.
    if (engagementRate !== null && engagementRate < MIN_ENGAGEMENT_RATE) {
      reasons.push(
        `the stage engaged on only ${attempted}/${total} queries ` +
          `(${(engagementRate * 100).toFixed(1)}%, floor ${(MIN_ENGAGEMENT_RATE * 100).toFixed(0)}%) — ` +
          `too little engagement to attribute any delta to the reranker`,
      );
    } else {
      warnings.push(
        `${excludedNonEngaged}/${total} queries were fail-soft (the stage did not engage) and are ` +
          `EXCLUDED from every delta below — they are treatment == control by construction, so ` +
          `including them would dilute the estimate toward zero`,
      );
      warnings.push(
        `engagement was ${(engagementRate! * 100).toFixed(1)}% — the excluded pairs are NOT a random ` +
          `sample if the engine drops on the largest/slowest queries, so the estimand is "the effect ` +
          `WHEN the reranker runs", not "the effect of enabling it"`,
      );
    }
  }
  if (input.ordersMoved <= 0)
    reasons.push('the admitted ORDER never moved on any query — indistinguishable from a disabled reranker');
  if (!input.engine) reasons.push('no rerank engine was recorded — the result cannot be attributed to a specific reranker (WI-37649)');
  return { ok: reasons.length === 0, reasons, warnings, excludedNonEngaged, engagementRate };
}
