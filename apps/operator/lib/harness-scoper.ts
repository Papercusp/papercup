/**
 * Background scoper invocation — fires a detached TS `invoke-once` process
 * (the orchestrator's single-invoke entry) that runs `invoke scoper
 * MODE=<mode>`. Returns an opaque invocationId; the child writes to
 * `scoper-results/<mode>-<id>.log` with a trailing `__INVOCATION_DONE__`
 * sentinel (appended by invoke-once when RESULT_PATH is set).
 *
 * Relocated from `app/api/_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 29 — prereq for the proposals/product-review/replan/cleanup
 * routes which all call this helper).
 *
 * Ported off the legacy `bash -c 'source <(awk ... run.sh); invoke scoper'`
 * shell-out onto the TS orchestrator's `invoke-once.ts` (run.sh retirement).
 */
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { harnessDir } from '@/lib/harness-core';
import { type ProjectEntry } from '@/lib/harness-registry';
import { harnessPackageDir } from '@/lib/harness-paths';
import { buildInvokeOnce } from '@/lib/harness-invoke-once';

/** Read scoper.outputMode from .harness/config.json (default: 'proposal'). */
function readScoperOutputMode(stateDir: string): 'proposal' | 'plan' {
  try {
    const raw = readFileSync(join(stateDir, 'config.json'), 'utf8');
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    const scoper = cfg.scoper as Record<string, unknown> | undefined;
    return scoper?.outputMode === 'plan' ? 'plan' : 'proposal';
  } catch {
    return 'proposal';
  }
}

export function invokeScoperBackground(
  project: ProjectEntry,
  mode: 'proposal' | 'replan' | 'cleanup',
): { invocationId: string } {
  const invocationId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const stateDir = join(project.path, '.harness');
  const resultsDir = join(harnessDir(project), 'scoper-results');
  const resultPath = join(resultsDir, `${mode}-${invocationId}.log`);
  const outputMode = mode === 'proposal' ? readScoperOutputMode(stateDir) : 'proposal';
  // The scoper agent writes proposals here; invoke-once creates logDir +
  // the RESULT_PATH dir itself, but not the proposals dir.
  try { mkdirSync(join(stateDir, 'proposals'), { recursive: true }); } catch { /* ignore */ }
  const { command, args, env } = buildInvokeOnce({
    projectDir: project.path,
    stateDir,
    harnessDir: harnessPackageDir(),
    role: 'scoper',
    extras: [`MODE=${mode}`, `OUTPUT_MODE=${outputMode}`],
    resultPath, // invoke-once tees output here + appends __INVOCATION_DONE__
    extraEnv: { SCOPER_INVOCATION_ID: invocationId, SCOPER_OUTPUT_MODE: outputMode },
  });
  const child = spawn(command, args, {
    cwd: project.path,
    env,
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  child.unref();
  return { invocationId };
}
