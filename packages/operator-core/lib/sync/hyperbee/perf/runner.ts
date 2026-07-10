/**
 * runner.ts — the p2p-perf bench runner CLI (P-001).
 *
 * The registered `node` runner for the `p2p-perf` testing domain
 * (testing-domains-registry.ts) — surfaced in /admin/testing and the /adv
 * Tests tab. Run from the repo root:
 *
 *   npx tsx packages/operator-core/lib/sync/hyperbee/perf/runner.ts --tier1 --profile ci
 *   npx tsx … --scenario merge.idle-tick --profile full
 *   npx tsx … --list
 *
 * Flags:
 *   --tier1 | --tier2 | --scenario <id[,id…]>   what to run
 *   --profile smoke|ci|full|deep                matrix size (default ci)
 *   --sizes 1000,10000                          explicit history-size sweep
 *   --peers 2,5                                 explicit peer-count sweep
 *   --out <dir>                                 artifact dir (default test-results/p2p-perf)
 *   --baseline <file>                           baseline JSON (default baselines/tier1.json next to this file)
 *   --update-baseline                           rewrite the baseline from this run
 *   --gate                                      exit 1 on regressions/SLO violations (OFF by default — D-005)
 *   --slo-only                                  exit 1 only on SLO violations (used by the CI-able invariant path)
 *   --summary-json <file>                       ALSO write a machine-readable run summary (the
 *                                               nightly/weekly routine reads this to auto-file findings — P-014)
 *
 * Output: one JSON artifact per (scenario, params) under
 * `<out>/<runId>/`, a generated `report.md` (P-012), and an advisory
 * comparator summary on stdout (P-003).
 *
 * Tier 3 (real frames) is NOT driven from here — it lives in the cred-gated
 * `tier3-latitude.integration.test.ts` next to the deployment layer (P-010),
 * mirroring `latitude-e2e.integration.test.ts`'s $0-default posture.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadavg, cpus as osCpus } from 'node:os';
import type { PerfArtifact } from './artifact';
import {
  baselineFromArtifacts,
  compareArtifacts,
  formatCompareReport,
  type BaselineFile,
} from './compare';
import type { PerfProfile, PerfScenario, ScenarioRunCtx } from './scenario-types';
import { mergeCostScenarios } from './scenarios/merge-cost';
import { replicationScenarios } from './scenarios/replication';
import { churnScenarios } from './scenarios/churn';
import { netemScenarios } from './scenarios/netem';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * EI-8843: this box is a SHARED interactive dev box (not a dedicated perf
 * host) — 7+ concurrent agent fleets routinely oversubscribe it. A
 * PG-write-heavy scenario (each op awaits a synchronous PG projection commit)
 * measures wall-clock/PG latency, which balloons under contention with ZERO
 * code regression — the 2026-07-09 incident: 2748%-18113% "regressions" at
 * load average 137-167 on a 128-core box (>100% sustained oversubscription),
 * while pure in-memory scenarios in the SAME run improved 58-106%. Sampling
 * `os.loadavg()[0] / cpus` around the run and flagging the comparison
 * uncertain above this ratio lets the nightly routine (p2p-perf-actions.ts)
 * skip auto-filing what would otherwise be a false-positive regression/SLO
 * alarm, without discarding the run's own artifacts/report (still written
 * either way — a human auditing a noisy night still sees the real numbers).
 */
const HOST_OVERSUBSCRIBED_RATIO = 1.0;

function sampleLoadRatio(): number {
  const cpuCount = osCpus().length || 1;
  return loadavg()[0] / cpuCount;
}

/**
 * EI-9145: CPU loadavg (the ratio check above) doesn't catch host MEMORY
 * pressure — a wall-clock-sensitive in-memory scenario (e.g. merge.idle-tick's
 * repeated substrate mergeNow() over a large history) can be dominated by
 * swap-in/out page faults even while loadavg looks "back to normal". Observed
 * 2026-07-10 during EI-9087 triage: three re-runs of the same scenario got
 * progressively WORSE (+187% → +622% → +875%) even as the CPU load ratio fell
 * from 1.62× to 1.13×, because the box was still actively swapping (~150GB
 * used, live `vmstat` si/so in the 100-300k KB/s range) throughout every run.
 * Sample `/proc/vmstat`'s cumulative `pswpin`/`pswpout` counters (Linux-only;
 * `null` elsewhere — best-effort, never throws) at run-start and run-end; a
 * non-trivial page-in/out delta during the run window is an independent
 * "host swapping" signal, orthogonal to the CPU ratio.
 */
const HOST_SWAPPING_PAGES_THRESHOLD = 1000; // ~4MB of swap I/O (4KB pages) over the run

/** Pure parse of /proc/vmstat text — exported for unit testing without touching the fs. */
export function parseSwapPages(vmstatText: string): { pswpin: number; pswpout: number } | null {
  const pswpin = Number(/^pswpin (\d+)$/m.exec(vmstatText)?.[1] ?? NaN);
  const pswpout = Number(/^pswpout (\d+)$/m.exec(vmstatText)?.[1] ?? NaN);
  if (!Number.isFinite(pswpin) || !Number.isFinite(pswpout)) return null;
  return { pswpin, pswpout };
}

function sampleSwapPages(): { pswpin: number; pswpout: number } | null {
  try {
    return parseSwapPages(readFileSync('/proc/vmstat', 'utf8'));
  } catch {
    return null; // non-Linux host, /proc unavailable, or permission denied — best-effort
  }
}

/**
 * Combine the CPU-ratio and swap-delta signals into one host-health verdict.
 * Pure + exported for unit testing (EI-9145) — the two confounds are
 * independent: either alone should mark the comparison UNCERTAIN.
 */
export function computeHostHealth(input: {
  ratio1m: number;
  swapPagesDelta: number | null;
}): { oversubscribed: boolean; swapping: boolean } {
  const swapping = input.swapPagesDelta !== null && input.swapPagesDelta > HOST_SWAPPING_PAGES_THRESHOLD;
  const oversubscribed = input.ratio1m > HOST_OVERSUBSCRIBED_RATIO || swapping;
  return { oversubscribed, swapping };
}

const TIER1: PerfScenario[] = [...mergeCostScenarios, ...replicationScenarios, ...churnScenarios];
const TIER2: PerfScenario[] = [...netemScenarios];
const ALL: PerfScenario[] = [...TIER1, ...TIER2];

const PROFILES: Record<PerfProfile, { sizes: number[]; peerCounts: number[] }> = {
  smoke: { sizes: [1_000], peerCounts: [2] },
  ci: { sizes: [1_000, 10_000], peerCounts: [2, 5] },
  full: { sizes: [1_000, 10_000, 100_000], peerCounts: [2, 5, 10] },
  deep: { sizes: [1_000, 10_000, 100_000, 1_000_000], peerCounts: [2, 5, 10, 25] },
};

interface Args {
  scenarios: PerfScenario[];
  profile: PerfProfile;
  sizes: number[] | null;
  peers: number[] | null;
  out: string;
  baseline: string;
  updateBaseline: boolean;
  gate: boolean;
  sloOnly: boolean;
  summaryJson: string | null;
}

/** Machine-readable run summary (consumed by the P-014 routine handler). */
export interface RunSummary {
  runId: string;
  profile: string;
  outDir: string;
  reportPath: string;
  artifacts: number;
  scenarioFailures: string[];
  sloViolations: Array<{ scenario: string; paramsKey: string; p95Ms: number; limitMs: number }>;
  regressions: Array<{ scenario: string; paramsKey: string; metric: string; baseline: number; current: number; relChange: number }>;
  improvements: number;
  baselineCompared: boolean;
  /** EI-8843/EI-9145: host contention sampled around the run (max of a
   *  start/end os.loadavg() sample, /cpus; plus a start/end /proc/vmstat
   *  swap-page delta). `oversubscribed` ⇒ the baseline comparison above is
   *  UNCERTAIN — a wall-clock/PG-latency-sensitive scenario could be
   *  measuring shared-box CPU contention OR swap thrashing, not a code
   *  regression. `swapping` isolates which confound fired. */
  hostLoad: {
    loadavg1m: number;
    cpus: number;
    ratio1m: number;
    oversubscribed: boolean;
    swapPagesDelta: number | null;
    swapping: boolean;
  };
}

function parseArgs(argv: string[]): Args | 'list' {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
  };
  if (argv.includes('--list')) return 'list';
  const profile = (get('--profile') ?? 'ci') as PerfProfile;
  if (!PROFILES[profile]) throw new Error(`unknown --profile ${profile}`);

  let scenarios: PerfScenario[];
  const named = get('--scenario');
  if (named) {
    const ids = named.split(',').map((s) => s.trim());
    scenarios = ids.map((id) => {
      const s = ALL.find((x) => x.id === id);
      if (!s) throw new Error(`unknown scenario '${id}' — try --list`);
      return s;
    });
  } else if (argv.includes('--tier2')) {
    scenarios = TIER2;
  } else {
    scenarios = TIER1; // --tier1 is also the default
  }

  const nums = (v: string | null): number[] | null =>
    v ? v.split(',').map((x) => Number(x.trim())).filter((n) => Number.isFinite(n) && n > 0) : null;

  return {
    scenarios,
    profile,
    sizes: nums(get('--sizes')),
    peers: nums(get('--peers')),
    out: get('--out') ?? join(process.cwd(), 'test-results', 'p2p-perf'),
    baseline: get('--baseline') ?? join(HERE, 'baselines', 'tier1.json'),
    updateBaseline: argv.includes('--update-baseline'),
    gate: argv.includes('--gate'),
    sloOnly: argv.includes('--slo-only'),
    summaryJson: get('--summary-json'),
  };
}

function shortSummary(a: PerfArtifact): string {
  const keys = Object.entries(a.metrics)
    .filter(([, m]) => m.count > 0)
    .slice(0, 3)
    .map(([n, m]) => `${n} p95=${m.p95}${m.unit === 'ops/sec' ? ' ops/s' : m.unit}`)
    .join(' · ');
  const slo =
    a.sloPassed === null ? 'slo=n/a' : a.sloPassed ? `slo✓(${a.loopLag?.p95Ms}ms)` : `slo✖(${a.loopLag?.p95Ms}ms)`;
  return `${a.scenario} [${Object.entries(a.params).map(([k, v]) => `${k}=${v}`).join(' ')}] ${keys} ${slo}`;
}

function renderReport(
  runId: string,
  profile: string,
  artifacts: PerfArtifact[],
  compareText: string | null,
  hostLoad?: {
    loadavg1m: number;
    cpus: number;
    ratio1m: number;
    oversubscribed: boolean;
    swapPagesDelta: number | null;
    swapping: boolean;
  },
): string {
  const lines: string[] = [
    `# p2p-perf run \`${runId}\``,
    '',
    `- profile: **${profile}**`,
    `- host: ${artifacts[0]?.host.hostname} (${artifacts[0]?.host.platform}, ${artifacts[0]?.host.cpus} cpus, node ${artifacts[0]?.host.node})`,
    `- artifacts: ${artifacts.length}`,
    ...(hostLoad
      ? [
          `- host load: ${hostLoad.loadavg1m.toFixed(1)} / ${hostLoad.cpus} cpus (ratio ${hostLoad.ratio1m.toFixed(2)}×)` +
            (hostLoad.swapPagesDelta !== null ? `, swap Δ ${hostLoad.swapPagesDelta} pages` : '') +
            (hostLoad.oversubscribed
              ? ` — **⚠ OVERSUBSCRIBED (${hostLoad.swapping ? 'swap thrashing, EI-9145' : 'CPU, EI-8843'}${
                  hostLoad.swapping && hostLoad.ratio1m > 1.0 ? ' + CPU' : ''
                }): baseline comparison below is UNCERTAIN, auto-filing skipped**`
              : ''),
        ]
      : []),
    '',
    '| scenario | params | key metric (p95) | loop-lag p95 | SLO | notes |',
    '|---|---|---|---|---|---|',
  ];
  for (const a of artifacts) {
    const params = Object.entries(a.params)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    const main = Object.entries(a.metrics).find(([, m]) => m.count > 0);
    const metricCell = main ? `${main[0]}: ${main[1].p95} ${main[1].unit}` : '—';
    const slo = a.sloPassed === null ? 'n/a' : a.sloPassed ? '✓' : '**✖**';
    const notes = a.notes.length ? a.notes.join('; ').slice(0, 200) : '';
    lines.push(
      `| ${a.scenario} | ${params} | ${metricCell} | ${a.loopLag?.p95Ms ?? '—'} ms | ${slo} | ${notes} |`,
    );
  }
  if (compareText) {
    lines.push('', '## Baseline comparison (advisory — D-005)', '', '```', compareText, '```');
  }
  lines.push('', `_Generated by perf/runner.ts (p2p-performance-suite-2026-06-07)._`);
  return lines.join('\n');
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === 'list') {
    for (const s of ALL) {
      console.log(`${s.id}  [tier ${s.tier}]  ${s.describe}`);
    }
    return;
  }
  const args = parsed;
  const prof = PROFILES[args.profile];
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = join(args.out, runId);
  mkdirSync(outDir, { recursive: true });

  // EI-8843: sample at start too — a run that STARTS oversubscribed but drains
  // by the time it finishes is still a run whose early scenarios' numbers are
  // suspect; the max of the two samples is the conservative call.
  const startLoadRatio = sampleLoadRatio();
  const startSwap = sampleSwapPages();

  const artifacts: PerfArtifact[] = [];
  const ctx: ScenarioRunCtx = {
    profile: args.profile,
    sizes: args.sizes ?? prof.sizes,
    peerCounts: args.peers ?? prof.peerCounts,
    seed: 1234,
    log: (line) => console.log(`  ${line}`),
    async emit(artifact) {
      artifacts.push(artifact);
      const n = artifacts.length;
      const file = join(outDir, `${String(n).padStart(3, '0')}-${artifact.scenario.replace(/[^a-z0-9.-]/gi, '_')}.json`);
      writeFileSync(file, JSON.stringify(artifact, null, 2));
      console.log(`  ✔ ${shortSummary(artifact)}`);
    },
  };

  console.log(
    `p2p-perf runner — ${args.scenarios.length} scenario(s), profile=${args.profile} sizes=[${ctx.sizes}] peers=[${ctx.peerCounts}]`,
  );
  let failed = false;
  const scenarioFailures: string[] = [];
  for (const s of args.scenarios) {
    console.log(`\n▶ ${s.id} — ${s.describe}`);
    try {
      await s.run(ctx);
    } catch (e) {
      failed = true;
      scenarioFailures.push(`${s.id}: ${e instanceof Error ? e.message : String(e)}`);
      console.error(`  ✖ ${s.id} FAILED: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    }
  }

  // Baseline comparison (advisory — D-005).
  let compareText: string | null = null;
  let compared = false;
  let compareReport: ReturnType<typeof compareArtifacts> | null = null;
  if (existsSync(args.baseline) && !args.updateBaseline) {
    try {
      const baseline = JSON.parse(readFileSync(args.baseline, 'utf8')) as BaselineFile;
      compareReport = compareArtifacts(baseline, artifacts);
      compared = true;
      compareText = formatCompareReport(compareReport);
      console.log('\n— baseline comparison (advisory) —');
      console.log(compareText);
    } catch (e) {
      console.warn(`baseline comparison failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else if (!args.updateBaseline) {
    console.log(`\n(no baseline at ${args.baseline} — run with --update-baseline to create one)`);
  }
  const sloViolations =
    compareReport?.sloViolations ??
    artifacts
      .filter((a) => a.sloPassed === false)
      .map((a) => ({
        scenario: a.scenario,
        paramsKey: Object.entries(a.params)
          .sort(([x], [y]) => (x < y ? -1 : 1))
          .map(([k, v]) => `${k}=${v}`)
          .join(','),
        p95Ms: a.loopLag?.p95Ms ?? -1,
        limitMs: a.sloLimitMs,
      }));
  const regressionCount = compareReport?.regressions.length ?? 0;

  // EI-8843: max(start, end) load sample — conservative call on whether the
  // comparison above is trustworthy or shared-box CPU contention.
  const endLoadRatio = sampleLoadRatio();
  const ratio1m = Math.max(startLoadRatio, endLoadRatio);
  // EI-9145: swap-page delta over the SAME run window — an independent
  // memory-pressure confound loadavg alone can miss (see computeHostHealth).
  const endSwap = sampleSwapPages();
  const swapPagesDelta =
    startSwap && endSwap ? endSwap.pswpin - startSwap.pswpin + (endSwap.pswpout - startSwap.pswpout) : null;
  const { oversubscribed, swapping } = computeHostHealth({ ratio1m, swapPagesDelta });
  const hostLoad = { loadavg1m: loadavg()[0], cpus: osCpus().length, ratio1m, oversubscribed, swapPagesDelta, swapping };
  if (oversubscribed) {
    const reasons = [
      ratio1m > HOST_OVERSUBSCRIBED_RATIO ? `CPU load ratio ${ratio1m.toFixed(2)}× cpus (limit ${HOST_OVERSUBSCRIBED_RATIO}×, EI-8843)` : null,
      swapping ? `host swapping (Δ${swapPagesDelta} pages over the run, EI-9145)` : null,
    ].filter(Boolean);
    console.warn(
      `\n⚠ host oversubscribed during this run (${reasons.join(' AND ')}) — the baseline comparison ` +
        `above is UNCERTAIN: a wall-clock/PG-latency-sensitive scenario may be measuring shared-box ` +
        `contention, not a code regression. The nightly routine will skip auto-filing findings from this run.`,
    );
  }

  if (args.updateBaseline && artifacts.length) {
    const baseline = baselineFromArtifacts(artifacts, args.profile);
    mkdirSync(dirname(args.baseline), { recursive: true });
    writeFileSync(args.baseline, JSON.stringify(baseline, null, 2));
    console.log(`\nbaseline updated: ${args.baseline} (${baseline.entries.length} entries)`);
  }

  const reportPath = join(outDir, 'report.md');
  writeFileSync(reportPath, renderReport(runId, args.profile, artifacts, compareText, hostLoad));
  console.log(`\nartifacts: ${outDir}`);
  console.log(`report:    ${reportPath}`);

  const summary: RunSummary = {
    runId,
    profile: args.profile,
    outDir,
    reportPath,
    artifacts: artifacts.length,
    scenarioFailures,
    sloViolations,
    regressions: (compareReport?.regressions ?? []).map((d) => ({
      scenario: d.scenario,
      paramsKey: d.paramsKey,
      metric: d.metric,
      baseline: d.baseline,
      current: d.current,
      relChange: d.relChange,
    })),
    improvements: compareReport?.improvements.length ?? 0,
    baselineCompared: compared,
    hostLoad,
  };
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  if (args.summaryJson) {
    mkdirSync(dirname(args.summaryJson), { recursive: true });
    writeFileSync(args.summaryJson, JSON.stringify(summary, null, 2));
  }

  if (failed) process.exitCode = 1;
  else if (args.gate && (regressionCount > 0 || sloViolations.length > 0)) process.exitCode = 1;
  else if (args.sloOnly && sloViolations.length > 0) process.exitCode = 1;

  // Scenarios can leave hyperswarm/corestore internals (DHT sockets, gc
  // timers) open even after every peer/handle we own has been closed — the
  // report + artifacts are already on disk at this point (EI-7253), so force
  // the exit rather than hang waiting for those to drain. Same idiom as
  // peer-child.ts's spawned-child main().
  process.exit(process.exitCode ?? 0);
}

// EI-9145: only auto-run the CLI when this file is executed directly (`tsx
// runner.ts ...`) — NOT when imported as a module (e.g. a unit test pulling
// in the pure `parseSwapPages`/`computeHostHealth` helpers above). Before
// this guard, importing this file for its exports had the side effect of
// kicking off a live perf run (writing real artifacts, eventually calling
// `process.exit()`) racing against the importer's own code.
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
