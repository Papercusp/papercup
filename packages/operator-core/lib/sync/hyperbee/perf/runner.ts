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

function renderReport(runId: string, profile: string, artifacts: PerfArtifact[], compareText: string | null): string {
  const lines: string[] = [
    `# p2p-perf run \`${runId}\``,
    '',
    `- profile: **${profile}**`,
    `- host: ${artifacts[0]?.host.hostname} (${artifacts[0]?.host.platform}, ${artifacts[0]?.host.cpus} cpus, node ${artifacts[0]?.host.node})`,
    `- artifacts: ${artifacts.length}`,
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

  if (args.updateBaseline && artifacts.length) {
    const baseline = baselineFromArtifacts(artifacts, args.profile);
    mkdirSync(dirname(args.baseline), { recursive: true });
    writeFileSync(args.baseline, JSON.stringify(baseline, null, 2));
    console.log(`\nbaseline updated: ${args.baseline} (${baseline.entries.length} entries)`);
  }

  const reportPath = join(outDir, 'report.md');
  writeFileSync(reportPath, renderReport(runId, args.profile, artifacts, compareText));
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
  };
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  if (args.summaryJson) {
    mkdirSync(dirname(args.summaryJson), { recursive: true });
    writeFileSync(args.summaryJson, JSON.stringify(summary, null, 2));
  }

  if (failed) process.exitCode = 1;
  else if (args.gate && (regressionCount > 0 || sloViolations.length > 0)) process.exitCode = 1;
  else if (args.sloOnly && sloViolations.length > 0) process.exitCode = 1;
}

void main();
