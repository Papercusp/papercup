/**
 * The shared verification-harness runner.
 *
 * Runs a contract's phases in declaration order under never-abort discipline (the
 * eval-battery rule, applied to a phase graph): a failing or throwing phase is recorded and
 * the run continues, and only the phases whose dependencies did not pass are marked
 * `blocked`. Every run owns ONE evidence dir (`<evidenceRoot>/<runId>`, a `phases/<id>/`
 * subdir per phase, `result.json` rewritten after every phase so a killed run still leaves
 * its partial result) and repoints `<evidenceRoot>/latest` at it when it ends.
 */
import { mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type HarnessContract,
  type HarnessRunResult,
  type HarnessSelection,
  type PhaseResult,
  validateContract,
} from './contract.js';
import { planSelection } from './select.js';

export type PhaseOutcome = { ok: true; detail?: string } | { ok: false; reasonCode: string; step?: string; detail?: string };

export interface PhaseContext {
  phase: string;
  runId: string;
  /** This phase's own evidence directory (created before the phase runs). */
  evidenceDir: string;
  /** Record the step the phase is in; a failure or throw reports the last one marked. */
  markStep(step: string): void;
}

export interface RunHarnessArgs {
  contract: HarnessContract;
  /** Parent of every run dir; the run lands at `<evidenceRoot>/<runId>`. */
  evidenceRoot: string;
  runPhase: (ctx: PhaseContext) => Promise<PhaseOutcome>;
  /** Fast checks that run before any phase; a failure blocks every phase. */
  preflight?: (ctx: PhaseContext) => Promise<PhaseOutcome>;
  selection?: HarnessSelection;
  /** A prior run (result or its dir) whose passed reusable phases may satisfy dependencies. */
  reuseFrom?: HarnessRunResult | string | null;
  runId?: string;
  now?: () => Date;
}

export const PREFLIGHT_PHASE_ID = 'preflight';

export function newRunId(now: Date): string {
  return `${now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${process.pid}`;
}

export async function loadRunResult(runDir: string): Promise<HarnessRunResult> {
  const parsed = JSON.parse(await readFile(path.join(runDir, 'result.json'), 'utf8')) as HarnessRunResult;
  if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.phases)) {
    throw new Error(`${runDir}/result.json is not a verification-harness result (schemaVersion 1)`);
  }
  return parsed;
}

export async function writeRunResult(result: HarnessRunResult): Promise<void> {
  await mkdir(result.evidenceDir, { recursive: true });
  const file = path.join(result.evidenceDir, 'result.json');
  await writeFile(`${file}.tmp`, `${JSON.stringify(result, null, 2)}\n`);
  await rename(`${file}.tmp`, file);
}

/** Point `<evidenceRoot>/latest` at the run dir (relative link, replaced atomically). */
export async function linkLatest(evidenceRoot: string, runDir: string): Promise<void> {
  const tmp = path.join(evidenceRoot, `.latest-${process.pid}`);
  await rm(tmp, { force: true });
  await symlink(path.relative(evidenceRoot, runDir), tmp);
  await rename(tmp, path.join(evidenceRoot, 'latest'));
}

export function deriveVerdict(result: Pick<HarnessRunResult, 'preflight' | 'phases'>): {
  verdict: HarnessRunResult['verdict'];
  firstFailure: HarnessRunResult['firstFailure'];
} {
  if (result.preflight && result.preflight.status !== 'passed') {
    const p = result.preflight;
    return { verdict: 'preflight-failed', firstFailure: { phase: p.phase, step: p.step, reasonCode: p.reasonCode } };
  }
  const bad = result.phases.find((p) => p.status === 'failed') ?? result.phases.find((p) => p.status === 'blocked');
  if (!bad) return { verdict: 'pass', firstFailure: null };
  return { verdict: 'fail', firstFailure: { phase: bad.phase, step: bad.step, reasonCode: bad.reasonCode } };
}

/** One greppable line: `HARNESS_RESULT harness=… verdict=… first_failure=phase/step/reason … evidence=…`. */
export function formatSummaryLine(result: HarnessRunResult): string {
  const count = (s: PhaseResult['status']) => result.phases.filter((p) => p.status === s).length;
  const ff = result.firstFailure;
  const first = ff ? `${ff.phase}/${ff.step ?? '-'}/${ff.reasonCode ?? '-'}` : 'none';
  return (
    `HARNESS_RESULT harness=${result.harness} verdict=${result.verdict} run=${result.runId} first_failure=${first}` +
    ` passed=${count('passed')} failed=${count('failed')} blocked=${count('blocked')} skipped=${count('skipped')}` +
    ` reused=${count('reused')} evidence=${result.evidenceDir}`
  );
}

async function runOne(
  id: string,
  fn: (ctx: PhaseContext) => Promise<PhaseOutcome>,
  runId: string,
  runDir: string,
  now: () => Date,
): Promise<PhaseResult> {
  const evidenceDir = path.join(runDir, 'phases', id);
  await mkdir(evidenceDir, { recursive: true });
  let step: string | null = null;
  const started = now();
  let outcome: PhaseOutcome;
  try {
    outcome = await fn({ phase: id, runId, evidenceDir, markStep: (s) => { step = s; } });
  } catch (err) {
    outcome = { ok: false, reasonCode: 'threw', detail: err instanceof Error ? err.message : String(err) };
  }
  const ended = now();
  const base = {
    phase: id,
    evidenceDir,
    startedAt: started.toISOString(),
    endedAt: ended.toISOString(),
    elapsedMs: Math.max(0, ended.getTime() - started.getTime()),
  };
  if (outcome.ok) return { ...base, status: 'passed', step, reasonCode: null, ...(outcome.detail ? { detail: outcome.detail } : {}) };
  return {
    ...base,
    status: 'failed',
    step: outcome.step ?? step,
    reasonCode: outcome.reasonCode,
    ...(outcome.detail ? { detail: outcome.detail } : {}),
  };
}

function notRun(id: string, runDir: string, status: 'blocked' | 'skipped' | 'reused', reasonCode: string | null, extra: Partial<PhaseResult> = {}): PhaseResult {
  return {
    phase: id,
    status,
    step: null,
    reasonCode,
    evidenceDir: path.join(runDir, 'phases', id),
    startedAt: null,
    endedAt: null,
    elapsedMs: 0,
    ...extra,
  };
}

export async function runHarness(args: RunHarnessArgs): Promise<HarnessRunResult> {
  const { contract } = args;
  validateContract(contract);
  const now = args.now ?? (() => new Date());
  const selection: HarnessSelection = args.selection ?? { only: null, from: null };
  const prior =
    typeof args.reuseFrom === 'string' ? await loadRunResult(args.reuseFrom) : (args.reuseFrom ?? null);
  const plan = planSelection(contract, selection, prior);
  const startedAt = now();
  const runId = args.runId ?? newRunId(startedAt);
  const runDir = path.join(args.evidenceRoot, runId);
  await mkdir(runDir, { recursive: true });

  const result: HarnessRunResult = {
    schemaVersion: 1,
    harness: contract.name,
    runId,
    evidenceDir: runDir,
    selection,
    reuseFromRunId: prior?.runId ?? null,
    preflight: null,
    phases: [],
    verdict: 'fail',
    firstFailure: null,
    startedAt: startedAt.toISOString(),
    endedAt: null,
  };
  const checkpoint = async () => {
    Object.assign(result, deriveVerdict(result));
    await writeRunResult(result);
  };

  if (args.preflight) {
    result.preflight = await runOne(PREFLIGHT_PHASE_ID, args.preflight, runId, runDir, now);
    await checkpoint();
  }
  const preflightFailed = result.preflight !== null && result.preflight.status !== 'passed';

  const statusOf = new Map<string, PhaseResult['status']>();
  for (const step of plan) {
    const spec = contract.phases.find((p) => p.id === step.phase)!;
    let r: PhaseResult;
    if (step.action === 'skip') {
      r = notRun(spec.id, runDir, 'skipped', step.reason ?? 'not-selected');
    } else if (step.action === 'reuse') {
      r = notRun(spec.id, runDir, 'reused', null, { reusedFromRunId: step.reuseFromRunId! });
    } else if (preflightFailed) {
      r = notRun(spec.id, runDir, 'blocked', 'preflight-failed');
    } else {
      const unmet = (spec.dependsOn ?? []).find((d) => statusOf.get(d) !== 'passed' && statusOf.get(d) !== 'reused');
      r = unmet
        ? notRun(spec.id, runDir, 'blocked', `dependency:${unmet}:${statusOf.get(unmet) ?? 'unknown'}`)
        : await runOne(spec.id, args.runPhase, runId, runDir, now);
    }
    statusOf.set(spec.id, r.status);
    result.phases.push(r);
    await checkpoint();
  }

  result.endedAt = now().toISOString();
  await checkpoint();
  await linkLatest(args.evidenceRoot, runDir);
  return result;
}
