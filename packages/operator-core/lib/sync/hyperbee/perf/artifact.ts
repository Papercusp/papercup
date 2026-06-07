/**
 * artifact.ts — the structured result every p2p-perf scenario emits, across
 * ALL tiers (p2p-performance-suite-2026-06-07 P-001 + P-012).
 *
 * One JSON shape from Tier 1 (local loopback benches) through Tier 2 (netem
 * WAN sim) to Tier 3 (real Latitude/Hetzner frames), so curves from any tier
 * overlay directly. Artifacts are written under `test-results/p2p-perf/` by
 * the runner; committed baselines live next to the suite in `baselines/`.
 *
 * Design notes:
 *   - `metrics` is a flat name → summary map (not nested per-phase objects):
 *     the comparator (compare.ts) walks it generically, and a new metric in a
 *     scenario needs no comparator change.
 *   - `loopLag` is first-class, not just another metric: D-003 makes the
 *     host-responsiveness SLO (event-loop lag p95 < 100ms while sync runs)
 *     the headline gate, and `sloPassed` records the verdict per artifact.
 */

import { hostname, cpus } from 'node:os';

/** Distribution summary for one measured series. All latencies in ms. */
export interface MetricSummary {
  /** What the numbers mean — latency distributions are 'ms', rates 'ops/sec', sizes 'bytes', counts 'count'. */
  unit: 'ms' | 'ops/sec' | 'bytes' | 'count';
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

/** Event-loop-lag window stats, straight off the EI-79 gauge. */
export interface LoopLagStats {
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface PerfArtifact {
  /** Artifact schema version — bump on breaking shape changes. */
  schema: 1;
  /** Scenario id, e.g. 'merge.idle-tick' / 'replication.sustained' / 'tier3.cross-region'. */
  scenario: string;
  /** 1 = local loopback, 2 = netem WAN sim, 3 = real machines. */
  tier: 1 | 2 | 3;
  /** Scenario parameters (history size, peer count, rate, netem profile, region…). */
  params: Record<string, string | number | boolean>;
  startedAt: string; // ISO
  durationMs: number;
  host: {
    hostname: string;
    platform: string;
    arch: string;
    cpus: number;
    node: string;
  };
  /** Named measured series. Keys are stable per scenario — the comparator matches on them. */
  metrics: Record<string, MetricSummary>;
  /**
   * Event-loop lag over the scenario window, from the shipped EI-79 gauge
   * (`event-loop-lag-monitor.ts`). Null only when a scenario genuinely cannot
   * host the gauge (it should be rare — D-003 makes this the headline metric).
   */
  loopLag: LoopLagStats | null;
  /** The D-003 SLO verdict: loop-lag p95 < `sloLimitMs` while sync ran. Null when loopLag is null. */
  sloPassed: boolean | null;
  sloLimitMs: number;
  /** Process CPU consumed over the scenario (parent process; children report their own). */
  cpu: { userMs: number; systemMs: number };
  /** Peak RSS observed over the scenario (bytes). */
  rss: { peakBytes: number };
  /** Total ops decoded/applied across the scenario, when the scenario counts them. */
  opsDecoded?: number;
  /** Free-form observations (capability skips, capped logs, anomalies). */
  notes: string[];
}

export interface ScenarioHostInfo {
  hostname: string;
  platform: string;
  arch: string;
  cpus: number;
  node: string;
}

export function currentHostInfo(): ScenarioHostInfo {
  return {
    hostname: hostname(),
    platform: process.platform,
    arch: process.arch,
    cpus: cpus().length,
    node: process.version,
  };
}
