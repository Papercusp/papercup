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
import { spawnInvokeOnceBackground } from './governed-background-spawn';
import { loadHarnessKnobs } from '@papercusp/orchestrator';
import { join } from 'node:path';
import { harnessDir } from './harness-core';
import { type ProjectEntry } from './harness-registry';
import { harnessPackageDir } from './harness-paths';
import { buildInvokeOnce } from './harness-invoke-once';

/**
 * Resolve scoper.outputMode: config.json `scoper.outputMode` (instance override)
 * wins, else the blueprint knob `scoper.outputMode` (cloud-deployment-layer P-006
 * — the scoper config moved to a first-class knob), else 'proposal'.
 */
function readScoperOutputMode(stateDir: string): 'proposal' | 'plan' {
  try {
    const raw = readFileSync(join(stateDir, 'config.json'), 'utf8');
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    const scoper = cfg.scoper as Record<string, unknown> | undefined;
    if (scoper?.outputMode === 'plan' || scoper?.outputMode === 'proposal') return scoper.outputMode;
  } catch {
    /* no config.json (or unreadable) — fall through to the blueprint knob */
  }
  try {
    const knobScoper = loadHarnessKnobs(stateDir)?.scoper as { outputMode?: string } | undefined;
    return knobScoper?.outputMode === 'plan' ? 'plan' : 'proposal';
  } catch {
    return 'proposal';
  }
}

export function invokeScoperBackground(
  project: ProjectEntry,
  mode: 'proposal' | 'replan' | 'cleanup',
): { invocationId: string } {
  const invocationId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const stateDir = join(project.path, '.papercusp');
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
  // Fire-and-forget detached spawn, governed (RB-012): paced through the shared governor
  // when PAPERCUSP_AGENT_GOVERNOR=1 so a background scoper doesn't pile onto a pipeline
  // burst; flag OFF = the legacy synchronous detached spawn. The result is polled via
  // resultPath's __INVOCATION_DONE__ sentinel (no child handle needed).
  spawnInvokeOnceBackground({ command, args, cwd: project.path, env, resultPath });
  return { invocationId };
}
