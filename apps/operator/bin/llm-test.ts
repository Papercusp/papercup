#!/usr/bin/env node
/**
 * llm-test — CLI for the LLM testing framework.
 *
 * Usage:
 *   pnpm llm-test --scenario <id>             run one scenario
 *   pnpm llm-test --target operator           run all scenarios for one target
 *   pnpm llm-test --list                      list scenarios + behaviors
 *   pnpm llm-test lint                        static scenario-registry validator
 *   pnpm llm-test --no-matrix                 force N=1 even when scenario declares more
 *   pnpm llm-test replay --fixture <id>       (Phase 1.5) re-evaluate stored fixture
 *   pnpm llm-test promote-candidates          (Phase 1.5) list novel_failure shapes ≥3×
 *
 * Reads ANTHROPIC_API_KEY from env. Persists results to PG via storage.ts.
 *
 * Plan §9.1, §12.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { runScenario } from '@papercusp/testing-shell/llm';

import { isLlmAvailable } from '@papercusp/operator-core/lib/llm-testing/llm-client';
import { operatorRunnerDeps } from '@papercusp/operator-core/lib/llm-testing/deps';
import { SCENARIOS, getScenario, listScenarioIds } from '@papercusp/operator-core/lib/llm-testing/scenarios';
import { listTargets } from '@papercusp/operator-core/lib/llm-testing/targets';
import { findPromotionCandidates, formatCandidatesReport } from '@papercusp/operator-core/lib/llm-testing/promotion/candidates';
import { promoteShape } from '@papercusp/operator-core/lib/llm-testing/promotion/promote';
import { replayFixture, reEvaluateRun } from '@papercusp/operator-core/lib/llm-testing/replay';

type Verb = 'run' | 'promote-candidates' | 'promote' | 'replay' | 'export-fixture' | 'lint';

interface Args {
  verb: Verb;
  scenarioId?: string;
  targetId?: string;
  shape?: string;
  fixture?: string;
  reEvaluate?: string;
  runId?: string;
  fixtureSlug?: string;
  noMatrix: boolean;
  list: boolean;
  noPersist: boolean;
  help: boolean;
  all: boolean;
  seed?: number;
  parallel?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    verb: 'run',
    noMatrix: false,
    list: false,
    noPersist: false,
    help: false,
    all: false,
  };
  // First positional non-flag arg may be a verb.
  if (
    argv[0] === 'promote-candidates'
    || argv[0] === 'promote'
    || argv[0] === 'replay'
    || argv[0] === 'export-fixture'
    || argv[0] === 'lint'
  ) {
    args.verb = argv[0] as Verb;
    argv = argv.slice(1);
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--scenario': args.scenarioId = argv[++i]; break;
      case '--target': args.targetId = argv[++i]; break;
      case '--shape': args.shape = argv[++i]; break;
      case '--fixture': args.fixture = argv[++i]; break;
      case '--re-evaluate': args.reEvaluate = argv[++i]; break;
      case '--run': args.runId = argv[++i]; break;
      case '--as': args.fixtureSlug = argv[++i]; break;
      case '--no-matrix': args.noMatrix = true; break;
      case '--no-persist': args.noPersist = true; break;
      case '--list': args.list = true; break;
      case '--all': args.all = true; break;
      case '--seed': args.seed = Number(argv[++i]); break;
      case '--parallel': args.parallel = Math.max(1, Number(argv[++i])); break;
      case '-h':
      case '--help': args.help = true; break;
      default:
        if (a?.startsWith('-')) {
          console.error(`Unknown flag: ${a}`);
          process.exit(2);
        }
    }
  }
  return args;
}

function usage(): void {
  console.log(`llm-test — LLM testing framework

Usage:
  llm-test --scenario <id>            Run a single scenario
  llm-test --target operator          Run every scenario for a target
  llm-test --all                      Run every scenario across all targets
  llm-test --list                     List scenarios + targets
  llm-test --no-matrix                Force N=1 (overrides runMatrix.repeat)
  llm-test --no-persist               Skip PG persistence (printing only)
  llm-test --seed <n>                 Determinism hint: forces sim-user
                                      temperature to 0 (SDK has no seed
                                      param; this is the closest we get).
  llm-test --parallel <n>             Batch scenarios into Promise.all
                                      groups of size N. Bounded by SUT
                                      single-flight per conversationId.

  llm-test lint                       Static scenario-registry validator —
                                      assert kinds, persona refs, rubric
                                      shape, trigger values, scripted-
                                      trigger params vs caps, fixture
                                      paths, etc. No LLM calls. Exits
                                      non-zero on any error.
  llm-test lint --scenario <id>       Lint one scenario.
  llm-test lint --target <id>         Lint every scenario for a target.

  llm-test promote-candidates         List novel_failure shapes seen
                                      in ≥3 scenarios over the last 14d
  llm-test promote --shape <hash>     Scaffold an asserts/<id>.ts stub
                                      from a candidate shape

  llm-test replay --fixture <id> --scenario <id>
                                      Re-evaluate a stored .sse fixture
                                      (+ optional sibling .telemetry.json)
                                      against the current rubric.
                                      No SUT or sim-user calls — just
                                      asserts + judge. ~$0.10/run.

  llm-test replay --re-evaluate <run-uuid> --scenario <id>
                                      Re-judge a historical run row
                                      (e.g. after a rubric edit).

  llm-test export-fixture --run <uuid> --as <slug>
                                      Export a stored run as a paired
                                      <slug>.sse + <slug>.telemetry.json
                                      under fixtures/operator/. Used to
                                      freeze a good (or bad) transcript
                                      for replay-driven regression.

Env:
  ANTHROPIC_API_KEY                   Required (sim-user + judge). Falls
                                      back to
                                      harness_shared.operator_credentials
                                      .anthropic_api_key when unset.
  PAPERCUSP_LLM_TEST_SKIP_CLAIM=1     Skip the parallel-runner claim
                                      ledger (unit tests without PG).
  PAPERCUSP_LLM_TEST_OPERATOR_URL     Operator HTTP origin the targets POST to
                                      (default http://127.0.0.1:3070).
                                      PAPERCUSP_OPERATOR_URL is honored as a
                                      fallback but reduced to its ORIGIN — its
                                      fleet-wide meaning is the MCP endpoint
                                      (…/api/mcp), not an API base.
  LLM_TEST_SUT_MODEL                  Override SUT model (default claude-sonnet-4-6)
  LLM_TEST_JUDGE_MODEL                Override judge model (default claude-sonnet-4-6)
  LLM_TEST_SIM_MODEL                  Override sim-user model (default claude-haiku-4-5)

Plan: apps/operator/docs/plans/llm-testing-framework-2026-05-14.md
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); return; }

  if (args.verb === 'lint') {
    const { lintScenarios, formatViolations } = await import('@papercusp/testing-shell/llm');
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const scope = args.scenarioId
      ? [getScenario(args.scenarioId)]
      : args.targetId
        ? SCENARIOS.filter((s) => s.target === args.targetId)
        : [...SCENARIOS];
    const violations = lintScenarios(scope, {
      fileExists: (p) => existsSync(p),
      fixtureRoot: resolve(__dirname, '../lib/llm-testing'),
      // The lib lint skips the target-registration check when this is absent;
      // pass the operator's registry so unknown-target scenarios still error
      // (matches the pre-P-073 behavior, which imported listTargets directly).
      registeredTargets: listTargets(),
    });
    console.log(formatViolations(violations));
    process.exit(violations.some((v) => v.severity === 'error') ? 1 : 0);
  }

  if (args.verb === 'promote-candidates') {
    const cs = await findPromotionCandidates();
    console.log(formatCandidatesReport(cs));
    return;
  }

  if (args.verb === 'promote') {
    if (!args.shape) {
      console.error('promote requires --shape <hash>. Use `llm-test promote-candidates` to find one.');
      process.exit(2);
    }
    const result = await promoteShape(args.shape);
    console.log(`Promoted shape ${args.shape.slice(0, 12)}…`);
    console.log(`  Created: ${result.filePath}`);
    console.log(`  Linked findings: ${result.findingsLinkedCount}`);
    console.log(`  Example claim: ${result.exampleClaim.slice(0, 100)}`);
    console.log(`\nNext: implement the predicate in the stub, then reference it`);
    console.log(`from a scenario with { kind: 'custom', name: '${result.assertId}', eval: evaluate }`);
    return;
  }

  if (args.verb === 'export-fixture') {
    if (!args.runId || !args.fixtureSlug) {
      console.error('export-fixture requires --run <runId> and --as <fixture-slug>.');
      process.exit(2);
    }
    const { exportFixtureFromRun } = await import('@papercusp/operator-core/lib/llm-testing/replay');
    const result = await exportFixtureFromRun({ runId: args.runId, fixtureId: args.fixtureSlug });
    console.log(`exported run ${args.runId} → fixture '${args.fixtureSlug}'`);
    console.log(`  ${result.ssePath} (${result.bytesSse}B)`);
    console.log(`  ${result.telemetryPath} (${result.bytesTelemetry}B)`);
    return;
  }

  if (args.verb === 'replay') {
    if (!args.scenarioId) {
      console.error('replay requires --scenario <id> (drives asserts + rubric).');
      process.exit(2);
    }
    if (!args.fixture && !args.reEvaluate) {
      console.error('replay requires --fixture <id|path> or --re-evaluate <run-uuid>.');
      process.exit(2);
    }
    if (!(await isLlmAvailable())) {
      console.error('ANTHROPIC_API_KEY required (replay still calls the judge).');
      process.exit(1);
    }
    const scenario = getScenario(args.scenarioId);
    const judgeModel = process.env.LLM_TEST_JUDGE_MODEL ?? 'claude-sonnet-4-6';

    const result = args.fixture
      ? await replayFixture({ fixture: args.fixture, scenario, judgeModel })
      : await reEvaluateRun({ runId: args.reEvaluate!, scenarioOverride: scenario, judgeModel });

    const icon = result.status === 'passed' ? '✓' : result.status === 'errored' ? '!' : '✗';
    console.log(`${icon} replay status=${result.status}`);
    console.log(`  scores: ${JSON.stringify(result.judge.scores)}`);
    console.log(`  asserts: ${result.violations.filter((v) => v.severity === 'error').length} error, ${result.violations.filter((v) => v.severity === 'warn').length} warn`);
    console.log(`  judge:   ${result.judge.findings.filter((f) => f.severity === 'error').length} error, ${result.judge.findings.filter((f) => f.severity === 'warn').length} warn`);
    for (const v of result.violations.filter((x) => x.severity === 'error')) {
      console.log(`    ✗ [${v.assertKind}] ${v.claim}`);
    }
    for (const f of result.judge.findings.filter((x) => x.severity === 'error').slice(0, 3)) {
      console.log(`    ✗ judge[${f.axis}]: ${f.claim}`);
    }
    process.exit(result.status === 'passed' ? 0 : 1);
  }

  if (args.list) {
    console.log('Targets:');
    for (const t of listTargets()) console.log(`  - ${t}`);
    console.log('\nScenarios:');
    for (const s of SCENARIOS) {
      console.log(`  - ${s.id}  [${s.target}]  ${s.description.slice(0, 80)}${s.description.length > 80 ? '...' : ''}`);
    }
    return;
  }

  if (!(await isLlmAvailable())) {
    console.error('ANTHROPIC_API_KEY is not set (env or harness_shared.operator_credentials).');
    process.exit(1);
  }

  const scenarios = args.scenarioId
    ? [getScenario(args.scenarioId)]
    : args.targetId
      ? SCENARIOS.filter((s) => s.target === args.targetId)
      : args.all
        ? [...SCENARIOS]
        : null;

  if (!scenarios) {
    console.error('Pass --scenario <id>, --target <id>, or --all. (See --list.)');
    process.exit(2);
  }
  if (scenarios.length === 0) {
    console.error('No scenarios match the filter.');
    process.exit(2);
  }

  const concurrency = Math.max(1, args.parallel ?? 1);
  if (concurrency > 1) {
    console.log(`[llm-test] --parallel ${concurrency} — scenarios run in batches of ${concurrency}.`);
  }

  // Operator seams for the generic runner. `--no-persist` omits the store seam
  // so the runner skips PG persistence; otherwise the runner persists each run
  // report once at end-of-run (it computes the scenario hash internally from
  // `scenarioFilePath`).
  const deps = operatorRunnerDeps({ persist: !args.noPersist });

  const runOne = async (scenario: typeof scenarios[number]): Promise<boolean> => {
    const scenarioFilePath = resolveScenarioFilePath(scenario);
    process.stdout.write(`\n▶ ${scenario.id}  [${scenario.target}]\n`);
    let report;
    try {
      report = await runScenario(scenario, {
        forceRepeat: args.noMatrix ? 1 : undefined,
        scenarioFilePath,
        ...(args.seed !== undefined && { seed: args.seed }),
      }, deps);
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (msg.startsWith('claim_busy')) {
        process.stdout.write(`  ⊘ skipped [${scenario.id}]: ${msg}\n`);
        return false; // not a failure — another runner is on it
      }
      console.error(`  ✗ runner error [${scenario.id}]: ${msg}`);
      return true;
    }
    printReport(report);
    // Verdict for the UI/PG ('preview' for single-run per plan §2.4);
    // exit-code from the per-run status so CI still flags single-run
    // failures.
    if (report.verdict === 'fail' || report.verdict === 'errored') return true;
    return report.runs.some((r) => r.status === 'failed' || r.status === 'errored');
  };

  let anyFailed = false;
  for (let i = 0; i < scenarios.length; i += concurrency) {
    const batch = scenarios.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(runOne));
    if (results.some(Boolean)) anyFailed = true;
  }

  process.exit(anyFailed ? 1 : 0);
}

function resolveScenarioFilePath(scenario: { id: string; target: string }): string | undefined {
  // Strip the target prefix to recover the file basename.
  // Operator scenarios: 'op-S01-...' → files 'S01-...'
  // Oracle scenarios:   'oracle-O1-...' → files 'O1-...'
  // Architect:          'architect-A1-...' → files 'A1-...'
  const here = dirname(fileURLToPath(import.meta.url));
  const idPart = scenario.id.replace(/^(op|oracle|architect|su)-/, '');
  return join(here, '..', 'lib', 'llm-testing', 'scenarios', scenario.target, `${idPart}.ts`);
}

function printReport(report: ReturnType<typeof runScenario> extends Promise<infer R> ? R : never): void {
  const verdict = report.verdict;
  const icon = verdict === 'pass' ? '✓' : verdict === 'preview' ? '○' : verdict === 'errored' ? '!' : '✗';
  console.log(`  ${icon} verdict=${verdict} (${report.runs.length} run${report.runs.length === 1 ? '' : 's'})`);
  for (let i = 0; i < report.runs.length; i++) {
    const r = report.runs[i];
    console.log(`     run #${i + 1} status=${r.status} cost=$${r.summary.totalCostUsd.toFixed(4)} turns=${r.summary.turns.length}`);
    const errs = r.violations.filter((v) => v.severity === 'error');
    const warns = r.violations.filter((v) => v.severity === 'warn');
    if (errs.length) console.log(`       asserts: ${errs.length} error / ${warns.length} warn`);
    const fErrs = r.judge.findings.filter((f) => f.severity === 'error');
    const fWarns = r.judge.findings.filter((f) => f.severity === 'warn');
    if (fErrs.length || fWarns.length) {
      console.log(`       judge:   ${fErrs.length} error / ${fWarns.length} warn`);
    }
    for (const a of errs) {
      console.log(`         ✗ [${a.assertKind}] ${a.claim}`);
    }
    for (const f of fErrs.slice(0, 3)) {
      console.log(`         ✗ judge[${f.axis}]: ${f.claim}`);
    }
  }
  if (Object.keys(report.varianceByAxis).length > 0) {
    const high = Object.entries(report.varianceByAxis).filter(([, v]) => v > 0.5);
    if (high.length > 0) {
      console.log(`     variance: ${high.map(([k, v]) => `${k}=${v.toFixed(2)}`).join(', ')}`);
    }
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
