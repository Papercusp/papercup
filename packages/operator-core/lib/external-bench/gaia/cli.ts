/**
 * GAIA CLI (plan `benchmark-suite-gaia-2026-06-17`) — the operational entrypoint. Run with tsx:
 *
 *   npx tsx packages/operator-core/lib/external-bench/gaia/cli.ts <verb> [flags]
 *
 * Verbs:
 *   provision   Print/run the gated HF download for a split. GAIA is gated — needs HF_TOKEN whose account
 *               accepted the terms (https://huggingface.co/datasets/gaia-benchmark/GAIA). With --run it
 *               executes the snapshot via `huggingface_hub`; otherwise it just prints the command.
 *   selfcheck   No-LLM wiring smoke: exercises the live web_search / fetch_url / run_python tools (negligible
 *               cost) + probes the inference gateway. Makes ZERO model calls. Use to validate the live
 *               bindings before spending on a pilot.
 *   pilot       Run a stratified subset (default 10 per level) of the validation split through the agent +
 *               self-grade. Needs the provisioned corpus + gateway/Opus capacity.
 *   run         Run the full validation split (or --limit N) through the agent + self-grade.
 *
 * The pilot/run verbs spend Opus (owner-gated: gateway capacity + $). They write predictions JSONL + a
 * report under ~/.papercusp/bench-results/gaia/runs/<ts>/.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gatewayBaseUrl } from '../competitor-live';
import {
  buildGaiaDownloadCommand,
  gaiaLevelCounts,
  loadGaiaValidation,
  stratifiedGaiaSubset,
  type GaiaTask,
} from './dataset';
import { makeLiveGaiaLlm } from './agent-live';
import { makeLiveGaiaToolset } from './tools-live';
import {
  formatGaiaReportLine,
  makeLiveRunAgent,
  predictionsToJsonl,
  runGaiaSuite,
  type GaiaRunResult,
} from './run';

function arg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
function has(flag: string): boolean {
  return process.argv.includes(flag);
}
function log(...a: unknown[]): void {
  // eslint-disable-next-line no-console
  console.log(...a);
}

const DEFAULT_VENV_PYTHON = join(homedir(), '.papercusp', 'competitors', 'venv', 'bin', 'python');

async function provision(): Promise<void> {
  const split = (arg('--split', 'validation') as 'validation' | 'test') ?? 'validation';
  const destRoot = arg('--dest', join(homedir(), '.papercusp', 'bench-results', 'gaia')) as string;
  const pythonBin = arg('--python', DEFAULT_VENV_PYTHON) as string;
  const { cmd, args } = buildGaiaDownloadCommand({ pythonBin, destRoot, split });
  log(`GAIA is a GATED dataset. Ensure HF_TOKEN is set to a token whose account accepted the terms at`);
  log(`  https://huggingface.co/datasets/gaia-benchmark/GAIA`);
  log(`Then set PAPERCUSP_GAIA_${split.toUpperCase()}_DIR=${destRoot}/2023/${split}`);
  log('');
  log('Download command:');
  log(`  ${cmd} -c '<python snapshot_download…>'`);
  if (!has('--run')) {
    log('\n(Dry run — pass --run to execute. Requires HF_TOKEN in env + huggingface_hub installed.)');
    return;
  }
  if (!process.env.HF_TOKEN && !process.env.HUGGING_FACE_HUB_TOKEN) {
    log('\nERROR: --run given but HF_TOKEN is not set. GAIA is gated; aborting.');
    process.exitCode = 2;
    return;
  }
  const { spawn } = await import('node:child_process');
  await new Promise<void>((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit', env: process.env });
    child.on('close', (code) => {
      log(code === 0 ? `\nProvisioned. Set PAPERCUSP_GAIA_${split.toUpperCase()}_DIR=${destRoot}/2023/${split}` : `\nDownload failed (exit ${code}).`);
      if (code !== 0) process.exitCode = 2;
      resolve();
    });
  });
}

async function selfcheck(): Promise<void> {
  log('GAIA wiring self-check (no LLM calls)\n');
  const scratch = join(homedir(), '.papercusp', 'bench-results', 'gaia', '_selfcheck');
  mkdirSync(scratch, { recursive: true });
  const tools = makeLiveGaiaToolset({ scratchDir: scratch });

  // 1) python sandbox
  try {
    const out = await tools.handlers.run_python({ code: 'print("py", 40 + 2)' });
    log(`run_python : ${out.includes('42') ? 'OK' : 'UNEXPECTED'}  ${out.split('\n').join(' ').slice(0, 80)}`);
  } catch (e) {
    log(`run_python : FAIL  ${e instanceof Error ? e.message : String(e)}`);
  }
  // 2) web_search (Brave)
  if (process.env.BRAVE_API_KEY) {
    try {
      const out = await tools.handlers.web_search({ query: 'capital of France', count: 3 });
      log(`web_search : ${/paris/i.test(out) ? 'OK' : 'RETURNED'}  ${out.split('\n')[0].slice(0, 80)}`);
    } catch (e) {
      log(`web_search : FAIL  ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    log('web_search : SKIP (BRAVE_API_KEY not set)');
  }
  // 3) fetch_url
  try {
    const out = await tools.handlers.fetch_url({ url: 'https://example.com' });
    log(`fetch_url  : ${/example/i.test(out) ? 'OK' : 'RETURNED'}  ${out.slice(0, 60).replace(/\n/g, ' ')}`);
  } catch (e) {
    log(`fetch_url  : FAIL  ${e instanceof Error ? e.message : String(e)}`);
  }
  // 4) gateway probe (no model call)
  const base = gatewayBaseUrl();
  try {
    const res = await fetch(base, { method: 'GET' }).catch((e) => {
      throw e;
    });
    log(`gateway    : reachable at ${base} (HTTP ${res.status})`);
  } catch (e) {
    log(`gateway    : NOT reachable at ${base} (${e instanceof Error ? e.message : String(e)}) — pilot/run need it up`);
  }
  log('\nSelf-check done. (Agent loop + LLM mapping are unit-tested; pilot/run additionally need a provisioned corpus + gateway capacity.)');
}

function writeRun(result: GaiaRunResult, label: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(homedir(), '.papercusp', 'bench-results', 'gaia', 'runs', `${label}-${stamp}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'predictions.jsonl'), predictionsToJsonl(result.predictions));
  writeFileSync(join(dir, 'report.json'), JSON.stringify({ report: result.report, totals: result.totals }, null, 2));
  return dir;
}

async function runTasks(tasks: GaiaTask[], label: string): Promise<void> {
  const concurrency = Number(arg('--concurrency', '4'));
  log(`Running ${tasks.length} GAIA tasks (${JSON.stringify(gaiaLevelCounts(tasks))}) @ concurrency ${concurrency}…`);
  const llm = makeLiveGaiaLlm({});
  const runAgent = makeLiveRunAgent({ llm });
  const result = await runGaiaSuite(tasks, { runAgent }, { concurrency });
  const dir = writeRun(result, label);
  log('\n' + formatGaiaReportLine(result));
  log(`\nWrote predictions + report to ${dir}`);
}

async function pilot(): Promise<void> {
  const perLevel = Number(arg('--per-level', '10'));
  const tasks = stratifiedGaiaSubset(loadGaiaValidation(), perLevel);
  await runTasks(tasks, `pilot-${perLevel}`);
}

async function run(): Promise<void> {
  let tasks = loadGaiaValidation();
  const limit = arg('--limit');
  if (limit) tasks = tasks.slice(0, Number(limit));
  await runTasks(tasks, 'validation');
}

async function main(): Promise<void> {
  const verb = process.argv[2];
  switch (verb) {
    case 'provision':
      return provision();
    case 'selfcheck':
      return selfcheck();
    case 'pilot':
      return pilot();
    case 'run':
      return run();
    default:
      log('Usage: tsx gaia/cli.ts <provision|selfcheck|pilot|run> [flags]');
      log('  provision [--split validation|test] [--dest <root>] [--python <bin>] [--run]');
      log('  selfcheck');
      log('  pilot [--per-level N] [--concurrency N]');
      log('  run   [--limit N] [--concurrency N]');
      process.exitCode = verb ? 2 : 0;
  }
}

// Run only when invoked directly (not when imported).
const invokedDirectly = process.argv[1] && /gaia[/\\]cli\.ts$/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e instanceof Error ? e.stack : String(e));
    process.exitCode = 1;
  });
}

export { main };
