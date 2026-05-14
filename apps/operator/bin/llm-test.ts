#!/usr/bin/env node
/**
 * llm-test — CLI for the LLM testing framework.
 *
 * Usage:
 *   pnpm llm-test --scenario <id>             run one scenario
 *   pnpm llm-test --target operator           run all scenarios for one target
 *   pnpm llm-test --list                      list scenarios + behaviors
 *   pnpm llm-test --no-matrix                 force N=1 even when scenario declares more
 *   pnpm llm-test replay --fixture <id>       (Phase 1.5) re-evaluate stored fixture
 *   pnpm llm-test promote-candidates          (Phase 1.5) list novel_failure shapes ≥3×
 *
 * Reads ANTHROPIC_API_KEY from env. Persists results to PG via storage.ts.
 *
 * Plan §9.1, §12.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { isLlmAvailable } from '../lib/llm-testing/llm-client';
import { runScenario } from '../lib/llm-testing/runner';
import { SCENARIOS, getScenario, listScenarioIds } from '../lib/llm-testing/scenarios';
import { listTargets } from '../lib/llm-testing/targets';
import { persistRunReport } from '../lib/llm-testing/storage';

interface Args {
  scenarioId?: string;
  targetId?: string;
  noMatrix: boolean;
  list: boolean;
  noPersist: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    noMatrix: false,
    list: false,
    noPersist: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--scenario': args.scenarioId = argv[++i]; break;
      case '--target': args.targetId = argv[++i]; break;
      case '--no-matrix': args.noMatrix = true; break;
      case '--no-persist': args.noPersist = true; break;
      case '--list': args.list = true; break;
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
  llm-test --scenario <id>       Run a single scenario
  llm-test --target operator     Run every scenario for a target
  llm-test --list                List scenarios + targets
  llm-test --no-matrix           Force N=1 (overrides runMatrix.repeat)
  llm-test --no-persist          Skip PG persistence (printing only)

Env:
  ANTHROPIC_API_KEY              Required (sim-user + judge)
  PAPERCUSP_OPERATOR_URL         Operator base URL (default http://127.0.0.1:3055)
  LLM_TEST_SUT_MODEL             Override SUT model (default claude-sonnet-4-6)
  LLM_TEST_JUDGE_MODEL           Override judge model (default claude-sonnet-4-6)
  LLM_TEST_SIM_MODEL             Override sim-user model (default claude-haiku-4-5)

Plan: apps/operator/docs/plans/llm-testing-framework-2026-05-14.md
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); return; }

  if (args.list) {
    console.log('Targets:');
    for (const t of listTargets()) console.log(`  - ${t}`);
    console.log('\nScenarios:');
    for (const s of SCENARIOS) {
      console.log(`  - ${s.id}  [${s.target}]  ${s.description.slice(0, 80)}${s.description.length > 80 ? '...' : ''}`);
    }
    return;
  }

  if (!isLlmAvailable()) {
    console.error('ANTHROPIC_API_KEY is not set. Export it before running.');
    process.exit(1);
  }

  const scenarios = args.scenarioId
    ? [getScenario(args.scenarioId)]
    : args.targetId
      ? SCENARIOS.filter((s) => s.target === args.targetId)
      : null;

  if (!scenarios) {
    console.error('Pass --scenario <id> or --target <id>. (See --list.)');
    process.exit(2);
  }
  if (scenarios.length === 0) {
    console.error('No scenarios match the filter.');
    process.exit(2);
  }

  let anyFailed = false;
  for (const scenario of scenarios) {
    const scenarioFilePath = resolveScenarioFilePath(scenario.id);
    process.stdout.write(`\n▶ ${scenario.id}  [${scenario.target}]\n`);

    let report;
    try {
      report = await runScenario(scenario, {
        forceRepeat: args.noMatrix ? 1 : undefined,
        scenarioFilePath,
      });
    } catch (err) {
      console.error(`  ✗ runner error: ${(err as Error).message}`);
      anyFailed = true;
      continue;
    }

    printReport(report);

    if (!args.noPersist) {
      try {
        const scenarioHash = scenarioFilePath
          ? require('node:crypto').createHash('sha256').update(readFileSync(scenarioFilePath, 'utf8')).digest('hex')
          : 'unknown';
        await persistRunReport(report, scenario.rubric.version, scenarioHash);
      } catch (err) {
        console.warn(`  ! persistence failed: ${(err as Error).message}`);
      }
    }

    if (report.verdict === 'fail' || report.verdict === 'errored') anyFailed = true;
  }

  process.exit(anyFailed ? 1 : 0);
}

function resolveScenarioFilePath(scenarioId: string): string | undefined {
  // S01-status-quick → S01-status-quick.ts under scenarios/operator/
  const here = dirname(fileURLToPath(import.meta.url));
  const idPart = scenarioId.replace(/^op-/, '');
  return join(here, '..', 'lib', 'llm-testing', 'scenarios', 'operator', `${idPart}.ts`);
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
