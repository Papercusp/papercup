/**
 * metrics.ts — measurement plumbing for the p2p-perf suite (P-001).
 *
 * Three concerns, deliberately tiny:
 *   - `summarize(samples)` — percentile/mean math for a measured series.
 *   - `Series` — an append-only sample collector with a `summarize()` view.
 *   - `ScenarioMeter` — the per-scenario envelope every scenario runs inside:
 *     starts the EI-79 event-loop-lag gauge (D-003's SLO instrument), tracks
 *     CPU + peak-RSS, and assembles the final `PerfArtifact`.
 *
 * The lag gauge is the SHIPPED `startEventLoopLagMonitor` — the suite must
 * measure with the same instrument production runs (P-007), not a parallel
 * implementation that could drift.
 */

import {
  startEventLoopLagMonitor,
  type LagMonitorHandle,
} from '../../../event-loop-lag-monitor';
import {
  currentHostInfo,
  type LoopLagStats,
  type MetricSummary,
  type PerfArtifact,
} from './artifact';

/** Default D-003 SLO: host event-loop lag p95 must stay under this while sync runs. */
export const DEFAULT_SLO_LIMIT_MS = 100;

/** Nearest-rank percentile over a sorted copy. Empty input → all zeros. */
export function summarize(samples: number[], unit: MetricSummary['unit'] = 'ms'): MetricSummary {
  if (samples.length === 0) {
    return { unit, count: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
  const sum = sorted.reduce((a, b) => a + b, 0);
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return {
    unit,
    count: sorted.length,
    p50: round(at(50)),
    p95: round(at(95)),
    p99: round(at(99)),
    max: round(sorted[sorted.length - 1]),
    mean: round(sum / sorted.length),
  };
}

/** Append-only sample series. */
export class Series {
  private samples: number[] = [];
  constructor(readonly unit: MetricSummary['unit'] = 'ms') {}
  push(v: number): void {
    this.samples.push(v);
  }
  get count(): number {
    return this.samples.length;
  }
  summarize(): MetricSummary {
    return summarize(this.samples, this.unit);
  }
}

/** Await-able high-res timer: `const done = startTimer(); …; series.push(done())`. */
export function startTimer(): () => number {
  const t0 = process.hrtime.bigint();
  return () => Number(process.hrtime.bigint() - t0) / 1e6;
}

export interface ScenarioMeterOpts {
  scenario: string;
  tier: 1 | 2 | 3;
  params: Record<string, string | number | boolean>;
  /** D-003 SLO limit override (ms). Default 100. */
  sloLimitMs?: number;
  /**
   * Lag-gauge sampling interval. The scenario window IS the histogram window
   * (we never reset mid-scenario), so this only controls the gauge's internal
   * warn cadence — keep it long to stay silent.
   */
  lagIntervalMs?: number;
}

/**
 * The per-scenario measurement envelope. Construct at scenario start, call
 * `metric(name)` for each series, then `finish()` for the artifact.
 */
export class ScenarioMeter {
  private readonly lag: LagMonitorHandle;
  private readonly cpu0 = process.cpuUsage();
  private readonly startedAtMs = Date.now();
  private readonly t0 = process.hrtime.bigint();
  private readonly series = new Map<string, Series>();
  private peakRss = process.memoryUsage().rss;
  private rssTimer: ReturnType<typeof setInterval>;
  readonly notes: string[] = [];
  opsDecoded = 0;

  constructor(private readonly opts: ScenarioMeterOpts) {
    this.lag = startEventLoopLagMonitor({
      intervalMs: opts.lagIntervalMs ?? 60 * 60 * 1000, // window = whole scenario; warn timer effectively off
      warnP95Ms: Number.POSITIVE_INFINITY, // scenarios judge the SLO themselves
      log: () => {},
    });
    this.rssTimer = setInterval(() => {
      const rss = process.memoryUsage().rss;
      if (rss > this.peakRss) this.peakRss = rss;
    }, 250);
    this.rssTimer.unref();
  }

  metric(name: string, unit: MetricSummary['unit'] = 'ms'): Series {
    let s = this.series.get(name);
    if (!s) {
      s = new Series(unit);
      this.series.set(name, s);
    }
    return s;
  }

  note(line: string): void {
    this.notes.push(line);
  }

  /** Read the lag gauge without finishing (children report mid-run). */
  sampleLag(): LoopLagStats {
    const s = this.lag.sample();
    return { p50Ms: s.p50Ms, p95Ms: s.p95Ms, p99Ms: s.p99Ms, maxMs: s.maxMs };
  }

  finish(): PerfArtifact {
    clearInterval(this.rssTimer);
    const lag = this.sampleLag();
    this.lag.stop();
    const cpu = process.cpuUsage(this.cpu0);
    const rss = process.memoryUsage().rss;
    if (rss > this.peakRss) this.peakRss = rss;
    const sloLimitMs = this.opts.sloLimitMs ?? DEFAULT_SLO_LIMIT_MS;
    const metrics: Record<string, MetricSummary> = {};
    for (const [name, s] of this.series) metrics[name] = s.summarize();
    return {
      schema: 1,
      scenario: this.opts.scenario,
      tier: this.opts.tier,
      params: this.opts.params,
      startedAt: new Date(this.startedAtMs).toISOString(),
      durationMs: Number(process.hrtime.bigint() - this.t0) / 1e6,
      host: currentHostInfo(),
      metrics,
      loopLag: lag,
      sloPassed: lag.p95Ms < sloLimitMs,
      sloLimitMs,
      cpu: { userMs: cpu.user / 1000, systemMs: cpu.system / 1000 },
      rss: { peakBytes: this.peakRss },
      opsDecoded: this.opsDecoded || undefined,
      notes: this.notes,
    };
  }
}
