/**
 * compare.ts — baseline/regression comparator for p2p-perf artifacts (P-003).
 *
 * ADVISORY by design (D-005): the comparator reports, it never gates — exactly
 * like `lint:knip` / `lint:generic-first`. Promotion to a CI gate is a
 * separate owner decision after baselines prove stable across a week of
 * nightlies. (`--gate` exists on the runner for that future, off by default.)
 *
 * Matching: artifacts pair with baseline entries on `scenario` + a stable
 * params key. Comparison is per metric on p95 (latency-shaped, lower-better)
 * or inverted for ops/sec (higher-better), with a relative tolerance AND an
 * absolute floor so sub-noise metrics never flag. The D-003 loop-lag SLO is
 * absolute and always reported, baseline or not.
 *
 * The floor is PER UNIT (WI-2788). It used to be one scalar (`absFloorMs ?? 5`)
 * applied to the raw value of every metric whatever its unit — inert against
 * bytes (RSS baselines ~3.7e8) and ops/sec (~1.4e4), and actively harmful for
 * sub-floor `ms` baselines, where clearing the floor mathematically guarantees
 * exceeding the tolerance. Metrics in that regime are now reported as
 * `notComparable` rather than flagged as regressions: a relative verdict on
 * them cannot carry information, so we say so instead of manufacturing one.
 */

import type { MetricSummary, PerfArtifact } from './artifact';

export interface BaselineEntry {
  scenario: string;
  params: Record<string, string | number | boolean>;
  metrics: Record<string, MetricSummary>;
  loopLagP95Ms: number | null;
}

export interface BaselineFile {
  schema: 1;
  capturedAt: string;
  profile: string;
  host: { hostname: string; platform: string; cpus: number };
  entries: BaselineEntry[];
}

/**
 * Default absolute floors PER UNIT. A single scalar cannot guard metrics whose
 * natural scale spans ~8 orders of magnitude: a 5-"unit" floor is ~30x the
 * baseline of a sub-millisecond timer but ~0.0000013% of an RSS byte count.
 */
export const DEFAULT_ABS_FLOOR: Record<MetricSummary['unit'], number> = {
  ms: 5,
  'ops/sec': 1,
  bytes: 32 * 1024 * 1024,
};

export interface CompareOpts {
  /** Relative regression tolerance (0.35 = +35% on p95). */
  tolerance?: number;
  /** Absolute floor for `ms` metrics under which differences never flag. */
  absFloorMs?: number;
  /** Per-unit absolute floors; overrides `absFloorMs` for `ms`. */
  absFloorByUnit?: Partial<Record<MetricSummary['unit'], number>>;
}

/** A metric whose relative comparison is mathematically uninformative — see `reason`. */
export interface NotComparable {
  scenario: string;
  paramsKey: string;
  metric: string;
  unit: MetricSummary['unit'];
  baseline: number;
  current: number;
  floor: number;
  reason: 'baseline-below-floor';
}

export interface MetricDelta {
  scenario: string;
  paramsKey: string;
  metric: string;
  unit: MetricSummary['unit'];
  baseline: number;
  current: number;
  /** Signed relative change (positive = worse). */
  relChange: number;
}

export interface CompareReport {
  regressions: MetricDelta[];
  improvements: MetricDelta[];
  sloViolations: Array<{ scenario: string; paramsKey: string; p95Ms: number; limitMs: number }>;
  newEntries: string[];
  missingEntries: string[];
  /**
   * Metrics skipped because a relative verdict on them cannot carry information
   * (WI-2788). Reported rather than silently dropped: a metric we cannot judge
   * is a fact the reader needs, not an absence.
   */
  notComparable: NotComparable[];
}

export function paramsKey(params: Record<string, string | number | boolean>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join(',');
}

export function entryKey(scenario: string, params: Record<string, string | number | boolean>): string {
  return `${scenario}|${paramsKey(params)}`;
}

export function baselineFromArtifacts(
  artifacts: PerfArtifact[],
  profile: string,
): BaselineFile {
  const first = artifacts[0];
  return {
    schema: 1,
    capturedAt: new Date().toISOString(),
    profile,
    host: {
      hostname: first?.host.hostname ?? 'unknown',
      platform: first?.host.platform ?? 'unknown',
      cpus: first?.host.cpus ?? 0,
    },
    entries: artifacts.map((a) => ({
      scenario: a.scenario,
      params: a.params,
      metrics: a.metrics,
      loopLagP95Ms: a.loopLag?.p95Ms ?? null,
    })),
  };
}

export function compareArtifacts(
  baseline: BaselineFile,
  artifacts: PerfArtifact[],
  opts: CompareOpts = {},
): CompareReport {
  const tolerance = opts.tolerance ?? 0.35;
  const msFloor = opts.absFloorMs ?? DEFAULT_ABS_FLOOR.ms;
  const floorFor = (unit: MetricSummary['unit']): number =>
    opts.absFloorByUnit?.[unit] ?? (unit === 'ms' ? msFloor : DEFAULT_ABS_FLOOR[unit] ?? 0);

  const baseByKey = new Map<string, BaselineEntry>();
  for (const e of baseline.entries) baseByKey.set(entryKey(e.scenario, e.params), e);
  const curByKey = new Map<string, PerfArtifact>();
  for (const a of artifacts) curByKey.set(entryKey(a.scenario, a.params), a);

  const report: CompareReport = {
    regressions: [],
    improvements: [],
    sloViolations: [],
    newEntries: [],
    missingEntries: [],
    notComparable: [],
  };

  for (const a of artifacts) {
    if (a.sloPassed === false && a.loopLag) {
      report.sloViolations.push({
        scenario: a.scenario,
        paramsKey: paramsKey(a.params),
        p95Ms: a.loopLag.p95Ms,
        limitMs: a.sloLimitMs,
      });
    }
    const key = entryKey(a.scenario, a.params);
    const base = baseByKey.get(key);
    if (!base) {
      report.newEntries.push(key);
      continue;
    }
    for (const [name, cur] of Object.entries(a.metrics)) {
      const b = base.metrics[name];
      if (!b || b.count === 0 || cur.count === 0) continue;
      const lowerIsBetter = cur.unit !== 'ops/sec';
      const baseVal = b.p95;
      const curVal = cur.p95;
      const absFloor = floorFor(cur.unit);
      // The floor gate and the relative test must each carry information. When
      // `absFloor > tolerance * baseVal` they cannot: clearing the gate ALREADY
      // implies relChange >= absFloor/baseVal > tolerance, so every sample that
      // survives the floor is a guaranteed "regression" and every sample that
      // would show the metric healthy is filtered out first. That inverts the
      // floor's stated purpose — it selects FOR outliers instead of suppressing
      // noise. Measured on 54 nightlies (WI-2788): deltaTick1Ms (baseline p95
      // 0.170ms), appendCallMs (2.000ms) and deltaTick100Ms (5.233ms) each fired
      // on 100% of their comparisons, by construction rather than by regression.
      // Such a metric is not comparable in RELATIVE terms at all; say so.
      if (absFloor > tolerance * baseVal) {
        report.notComparable.push({
          scenario: a.scenario,
          paramsKey: paramsKey(a.params),
          metric: name,
          unit: cur.unit,
          baseline: baseVal,
          current: curVal,
          floor: absFloor,
          reason: 'baseline-below-floor',
        });
        continue;
      }
      if (Math.abs(curVal - baseVal) < absFloor) continue;
      const relChange = lowerIsBetter
        ? (curVal - baseVal) / Math.max(baseVal, 0.001)
        : (baseVal - curVal) / Math.max(baseVal, 0.001);
      const delta: MetricDelta = {
        scenario: a.scenario,
        paramsKey: paramsKey(a.params),
        metric: name,
        unit: cur.unit,
        baseline: baseVal,
        current: curVal,
        relChange: Math.round(relChange * 1000) / 1000,
      };
      if (relChange > tolerance) report.regressions.push(delta);
      else if (relChange < -tolerance) report.improvements.push(delta);
    }
  }

  for (const key of baseByKey.keys()) {
    if (!curByKey.has(key)) report.missingEntries.push(key);
  }

  return report;
}

export function formatCompareReport(report: CompareReport): string {
  const lines: string[] = [];
  const pct = (r: number) => `${r > 0 ? '+' : ''}${Math.round(r * 100)}%`;
  if (report.sloViolations.length) {
    lines.push(`✖ SLO VIOLATIONS (loop-lag p95 over limit) — ${report.sloViolations.length}:`);
    for (const v of report.sloViolations) {
      lines.push(`  ${v.scenario} [${v.paramsKey}] p95=${v.p95Ms}ms (limit ${v.limitMs}ms)`);
    }
  } else {
    lines.push('✓ loop-lag SLO held on every scenario');
  }
  if (report.regressions.length) {
    lines.push(`▲ regressions vs baseline — ${report.regressions.length} (advisory):`);
    for (const d of report.regressions) {
      lines.push(
        `  ${d.scenario} [${d.paramsKey}] ${d.metric}: ${d.baseline} → ${d.current} ${d.unit} (${pct(d.relChange)} worse)`,
      );
    }
  } else {
    lines.push('✓ no metric regressed past tolerance');
  }
  if (report.improvements.length) {
    lines.push(`▼ improvements — ${report.improvements.length}:`);
    for (const d of report.improvements) {
      lines.push(
        `  ${d.scenario} [${d.paramsKey}] ${d.metric}: ${d.baseline} → ${d.current} ${d.unit} (${pct(-d.relChange)} better)`,
      );
    }
  }
  if (report.notComparable.length) {
    lines.push(
      `· not comparable — ${report.notComparable.length} metric(s) whose baseline sits under the absolute floor, so a relative verdict would be meaningless:`,
    );
    for (const n of report.notComparable) {
      lines.push(
        `  ${n.scenario} [${n.paramsKey}] ${n.metric}: baseline ${n.baseline}${n.unit} < floor ${n.floor}${n.unit} (current ${n.current}${n.unit}) — needs an absolute budget, not a % tolerance`,
      );
    }
  }
  if (report.newEntries.length) lines.push(`new (no baseline): ${report.newEntries.join('; ')}`);
  if (report.missingEntries.length) lines.push(`in baseline but not run: ${report.missingEntries.join('; ')}`);
  return lines.join('\n');
}
