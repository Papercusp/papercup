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
 *   - `convergence`/`convergencePassed` is a SECOND, DELIBERATELY SEPARATE
 *     verdict (EI-20576392705164447). "The host stayed responsive" and "the
 *     mesh converged" are different claims, and a 64-peer run on 2026-08-16
 *     is exactly where they diverge: loop-lag p95 was a healthy 21ms while
 *     many readers never applied all ops and appendToVisible p95 was 601
 *     SECONDS — and the artifact still stamped `sloPassed: true`. Never merge
 *     the two into one boolean, and never read a green `sloPassed` as evidence
 *     that replication kept up.
 */

import { createHash } from 'node:crypto';
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

/**
 * Reader-convergence outcome for a scenario that formed a mesh
 * (EI-20576392705164447).
 *
 * The harness ALREADY detected non-convergence before this existed — it wrote
 * `reader N did not apply all ops in time` into `notes` and then dropped that
 * signal on the floor, because nothing in the pass/fail verdict read `notes`.
 * This makes the same observation structured so a verdict (and a gate) can
 * consult it.
 */
export interface ConvergenceStats {
  /** Readers this scenario waited on (declared via `ScenarioMeter.expectReaders`). */
  expectedReaders: number;
  /** Readers that applied EVERY op inside the scenario's catch-up budget. */
  convergedReaders: number;
  /** The readers that did not — peer index (Tier 1/2) or label (Tier 3). */
  laggingReaders: string[];
  /**
   * appendToVisible p95 ceiling (ms) this run was judged against, or null when
   * no ceiling was set. Deliberately opt-in: a defensible number is a product
   * call per scenario, and an invented one would be its own false verdict.
   */
  p95LimitMs: number | null;
  /** Observed appendToVisible p95 (ms), when the scenario measured it. */
  observedP95Ms: number | null;
  /**
   * The catch-up budget (ms) every reader was judged against, or null when the
   * scenario did not declare one.
   *
   * WHY THIS IS RECORDED (EI-20581532536662596): `convergedReaders` alone is a
   * BINARY, and a binary cannot say whether a run passed with 110s of headroom
   * or with 200ms of it. That makes a pass/fail flip UNATTRIBUTABLE — when the
   * budget and the instrument change in the same edit, a suddenly-green ladder
   * reads identically whether the substrate got faster or the deadline got
   * looser. Recording the budget ALONGSIDE the observed times is what separates
   * those two, so a later reader never has to take on trust that nobody moved
   * the goalpost between runs.
   */
  budgetMs: number | null;
  /**
   * Observed time-to-converge (ms) over the readers that DID converge, measured
   * from the start of the shared deadline — so `max` is directly comparable to
   * `budgetMs`, and `budgetMs - max` is the run's headroom.
   *
   * Null when the scenario recorded no per-reader timings (pre-existing
   * artifacts, or a scenario reporting only the binary). Readers that never
   * converged are absent by construction — they have no elapsed time, only a
   * `laggingReaders` entry — so a `count` falling behind `expectedReaders` is
   * itself the signal, and the surviving percentiles are never diluted by a
   * censored sample stamped at the budget.
   */
  convergedMs: MetricSummary | null;
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
  /**
   * The D-003 SLO verdict: loop-lag p95 < `sloLimitMs` while sync ran. Null
   * when loopLag is null.
   *
   * ⚠ HOST RESPONSIVENESS ONLY. This says the operator stayed usable while
   * sync ran (EI-79) — it says NOTHING about whether replication kept up. Read
   * `convergencePassed` for that; a run can be `sloPassed: true` while readers
   * are ten minutes behind (EI-20576392705164447).
   */
  sloPassed: boolean | null;
  sloLimitMs: number;
  /**
   * Reader convergence for this cell, when the scenario declared how many
   * readers it waits on. Null ⇒ not measured (no mesh formed, or a scenario
   * with no readers) — never read null as "converged".
   */
  convergence: ConvergenceStats | null;
  /**
   * The convergence verdict: every expected reader applied all ops in budget,
   * AND (when a ceiling was set) appendToVisible p95 stayed under it. Null when
   * `convergence` is null. Kept DISTINCT from `sloPassed` on purpose.
   */
  convergencePassed: boolean | null;
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

/**
 * A stable but NON-IDENTIFYING tag for the machine that produced an artifact.
 *
 * Baselines under `baselines/` are COMMITTED to tracked source and ship inside
 * the release bundle, so a raw `os.hostname()` here leaks this box's identity —
 * `lint:no-identity-literals` fails the build on it, and the release cut's
 * box-identity audit (bin/audit-release-bundle.py) fails later and more
 * expensively. A committed baseline carrying the raw hostname red-pinned the
 * green-checkpoint gate on 2026-07-26.
 *
 * A hash keeps the ONLY property the field is actually read for — telling
 * whether two artifacts came from the same machine, so a baseline captured
 * elsewhere is not silently compared against local numbers. Nothing branches on
 * the value (report.ts prints it; compare.ts carries it through), so the digest
 * costs no behaviour.
 */
export function hostTag(rawHostname: string = hostname()): string {
  return `host-${createHash('sha256').update(rawHostname).digest('hex').slice(0, 8)}`;
}

export function currentHostInfo(): ScenarioHostInfo {
  return {
    // NEVER the raw hostname — see hostTag(). This file is the single writer of
    // the field, so redacting here covers every artifact and every baseline.
    hostname: hostTag(),
    platform: process.platform,
    arch: process.arch,
    cpus: cpus().length,
    node: process.version,
  };
}
