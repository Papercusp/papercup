/**
 * Confidence intervals — domain-free. The impartial-benchmark-suite reports
 * "pass@1 averaged over ≥3 seeds WITH confidence intervals" because these
 * benchmarks are noisy (plan: "Statistics" + fairness trap "Noise"). Two
 * complementary intervals:
 *
 *  - `wilsonInterval` — the score interval for ONE binomial proportion. Correct
 *    near p=0/1 and for small n (where the normal approximation fails). Use for
 *    the pooled resolved-rate of an arm (all task×seed outcomes as Bernoulli).
 *  - `bootstrapMeanCI` — a percentile bootstrap over a sample of values. Use to
 *    put a CI on a per-arm mean that is itself an average of per-TASK rates,
 *    where task heterogeneity (not just within-task seed noise) is the dominant
 *    variance — the methodologically correct interval for "mean over tasks of
 *    per-task pass@1" (cf. "AI Agents That Matter", arXiv 2407.01502). It is
 *    DETERMINISTIC: seed the PRNG so a re-run reproduces the same interval.
 */

export interface Interval {
  /** Point estimate the interval is centered on / drawn around. */
  point: number;
  lower: number;
  upper: number;
  /** Two-sided confidence level, e.g. 0.95. */
  ci: number;
}

/** z critical values for common two-sided confidence levels. */
const Z: Record<string, number> = {
  '0.90': 1.6448536269514722,
  '0.95': 1.959963984540054,
  '0.99': 2.5758293035489004,
};

function zFor(ci: number): number {
  const z = Z[ci.toFixed(2)];
  if (z === undefined) {
    throw new Error(`bench-metrics: unsupported ci ${ci}; use one of ${Object.keys(Z).join(', ')}`);
  }
  return z;
}

/**
 * Wilson score interval for a binomial proportion p̂ = successes / n.
 *
 *   center = (p̂ + z²/2n) / (1 + z²/n)
 *   half   = (z / (1 + z²/n)) · √( p̂(1-p̂)/n + z²/4n² )
 *
 * `point` is the raw p̂ (not the Wilson center) so callers report the observed
 * rate; the interval bounds use the Wilson shrinkage. n=0 → a degenerate
 * [0,1] interval with point 0.
 */
export function wilsonInterval(successes: number, n: number, ci = 0.95): Interval {
  if (!Number.isInteger(successes) || !Number.isInteger(n)) {
    throw new Error(`wilsonInterval: successes and n must be integers (got ${successes}, ${n})`);
  }
  if (n < 0 || successes < 0 || successes > n) {
    throw new Error(`wilsonInterval: need 0 ≤ successes ≤ n (got successes=${successes}, n=${n})`);
  }
  if (n === 0) return { point: 0, lower: 0, upper: 1, ci };
  const z = zFor(ci);
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return {
    point: p,
    lower: Math.max(0, center - half),
    upper: Math.min(1, center + half),
    ci,
  };
}

/** Arithmetic mean and standard error of the mean (σ/√n, sample sd). */
export function meanStderr(values: readonly number[]): { mean: number; stderr: number; n: number } {
  const n = values.length;
  if (n === 0) return { mean: 0, stderr: 0, n: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (n === 1) return { mean, stderr: 0, n: 1 };
  const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1);
  return { mean, stderr: Math.sqrt(variance / n), n };
}

/** mulberry32 — a tiny deterministic PRNG so bootstrap CIs are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Percentile bootstrap CI for the MEAN of `values`. Resamples the sample with
 * replacement `iterations` times, takes the mean each time, and reads the
 * (α/2, 1-α/2) percentiles of the bootstrap distribution. Deterministic given
 * `seed`. `point` is the observed mean of `values`.
 *
 * Use this on the per-TASK pass@1 vector (one value per task) so the interval
 * reflects task-to-task variance — the dominant noise on these suites.
 */
export function bootstrapMeanCI(
  values: readonly number[],
  opts: { ci?: number; iterations?: number; seed?: number } = {},
): Interval {
  const ci = opts.ci ?? 0.95;
  const iterations = opts.iterations ?? 10_000;
  const seed = opts.seed ?? 12345;
  const n = values.length;
  if (n === 0) return { point: 0, lower: 0, upper: 0, ci };
  const observed = values.reduce((a, b) => a + b, 0) / n;
  if (n === 1) return { point: observed, lower: observed, upper: observed, ci };

  const rng = mulberry32(seed);
  const means = new Float64Array(iterations);
  for (let it = 0; it < iterations; it++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += values[Math.floor(rng() * n)];
    }
    means[it] = sum / n;
  }
  means.sort();
  const alpha = (1 - ci) / 2;
  return {
    point: observed,
    lower: percentile(means, alpha),
    upper: percentile(means, 1 - alpha),
    ci,
  };
}

/** Linear-interpolated percentile of a pre-SORTED Float64Array. q ∈ [0,1]. */
function percentile(sorted: Float64Array, q: number): number {
  const n = sorted.length;
  if (n === 1) return sorted[0];
  const idx = q * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
