/**
 * CLI behind bin/vh.sh, so shell harnesses share the TS selection rules and result schema
 * instead of re-implementing them in bash.
 *
 *   cli.ts plan --run-dir <dir> [--only a,b | --from x] [--reuse <prior run dir>]
 *     reads <dir>/contract.json, writes <dir>/plan.json, prints `phase<TAB>action<TAB>reuseFromRunId`
 *   cli.ts finalize --run-dir <dir> --evidence-root <root>
 *     reads contract.json + plan.json + phases.jsonl, writes result.json, repoints <root>/latest,
 *     prints the HARNESS_RESULT line; exit 0 on pass, 1 otherwise
 */
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type HarnessContract, type HarnessRunResult, type PhaseResult, validateContract } from './contract.js';
import { deriveVerdict, formatSummaryLine, linkLatest, loadRunResult, PREFLIGHT_PHASE_ID, writeRunResult } from './runner.js';
import { type PlannedPhase, parseSelectionArgs, planSelection } from './select.js';

interface StoredPlan {
  runId: string;
  selection: HarnessRunResult['selection'];
  reuseFromRunId: string | null;
  startedAt: string;
  phases: PlannedPhase[];
}

function flag(argv: string[], name: string): string {
  const i = argv.indexOf(name);
  const v = i >= 0 ? argv[i + 1] : undefined;
  if (!v) throw new Error(`missing ${name}`);
  return v;
}

async function readContract(runDir: string): Promise<HarnessContract> {
  const contract = JSON.parse(await readFile(path.join(runDir, 'contract.json'), 'utf8')) as HarnessContract;
  validateContract(contract);
  return contract;
}

export async function planCommand(argv: string[]): Promise<string> {
  const runDir = flag(argv, '--run-dir');
  const contract = await readContract(runDir);
  const sel = parseSelectionArgs(argv.filter((a, i) => a !== '--run-dir' && argv[i - 1] !== '--run-dir'));
  const prior = sel.reuse ? await loadRunResult(sel.reuse) : null;
  const selection = { only: sel.only, from: sel.from };
  const phases = planSelection(contract, selection, prior);
  const stored: StoredPlan = {
    runId: path.basename(runDir),
    selection,
    reuseFromRunId: prior?.runId ?? null,
    startedAt: new Date().toISOString(),
    phases,
  };
  await writeFile(path.join(runDir, 'plan.json'), `${JSON.stringify(stored, null, 2)}\n`);
  await appendFile(path.join(runDir, 'phases.jsonl'), '');
  return phases.map((p) => `${p.phase}\t${p.action}\t${p.reuseFromRunId ?? ''}`).join('\n');
}

export async function finalizeCommand(argv: string[]): Promise<{ line: string; result: HarnessRunResult }> {
  const runDir = flag(argv, '--run-dir');
  const evidenceRoot = flag(argv, '--evidence-root');
  const contract = await readContract(runDir);
  const plan = JSON.parse(await readFile(path.join(runDir, 'plan.json'), 'utf8')) as StoredPlan;
  const raw = await readFile(path.join(runDir, 'phases.jsonl'), 'utf8');
  const recorded = new Map<string, Partial<PhaseResult>>();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as Partial<PhaseResult>;
    if (row.phase) recorded.set(row.phase, row);
  }
  const toResult = (id: string, row: Partial<PhaseResult> | undefined, fallback: PhaseResult['status'], reason: string): PhaseResult => ({
    phase: id,
    status: row?.status ?? fallback,
    step: row?.step ?? null,
    reasonCode: row ? (row.reasonCode ?? null) : reason,
    ...(row?.detail ? { detail: row.detail } : {}),
    evidenceDir: path.join(runDir, 'phases', id),
    startedAt: row?.startedAt ?? null,
    endedAt: row?.endedAt ?? null,
    elapsedMs: row?.elapsedMs ?? 0,
    ...(row?.reusedFromRunId ? { reusedFromRunId: row.reusedFromRunId } : {}),
  });
  const pre = recorded.get(PREFLIGHT_PHASE_ID);
  const result: HarnessRunResult = {
    schemaVersion: 1,
    harness: contract.name,
    runId: plan.runId,
    evidenceDir: runDir,
    selection: plan.selection,
    reuseFromRunId: plan.reuseFromRunId,
    preflight: pre ? toResult(PREFLIGHT_PHASE_ID, pre, 'failed', 'not-recorded') : null,
    // A planned phase the harness never reported (it exited early) is a FAILURE, not a skip:
    // silence must never read as success.
    phases: contract.phases.map((p) => toResult(p.id, recorded.get(p.id), 'failed', 'not-reported')),
    verdict: 'fail',
    firstFailure: null,
    startedAt: plan.startedAt,
    endedAt: new Date().toISOString(),
  };
  Object.assign(result, deriveVerdict(result));
  await writeRunResult(result);
  await linkLatest(evidenceRoot, runDir);
  return { line: formatSummaryLine(result), result };
}

async function main(): Promise<number> {
  const [cmd, ...argv] = process.argv.slice(2);
  if (cmd === 'plan') {
    process.stdout.write(`${await planCommand(argv)}\n`);
    return 0;
  }
  if (cmd === 'finalize') {
    const { line, result } = await finalizeCommand(argv);
    process.stdout.write(`${line}\n`);
    return result.verdict === 'pass' ? 0 : 1;
  }
  process.stderr.write('usage: cli.ts plan|finalize --run-dir <dir> [...]\n');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`verification-harness: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(2);
    },
  );
}
