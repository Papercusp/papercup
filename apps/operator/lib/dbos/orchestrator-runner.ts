/**
 * Phase 3 of `dbos-durable-jobs-2026-05-31` — the REAL invoke runner for the
 * durable feature pipeline (`orchestrator-workflow.ts`). Wires
 * `setPipelineInvokeRunner` to spawn the orchestrator's `invoke-once` bin
 * (headless), passing `IDEMPOTENCY_KEY` so a re-run of a completed agent is
 * reused, not re-spawned (P-015). This is a headless copy of the proven
 * `/harness/:slug/invoke` route logic (`routes/harness/spawn.ts`): resolve the
 * harness → `buildInvokeOnce` → spawn → strip timestamp log lines.
 *
 * Loaded + wired only when `PAPERCUSP_DBOS_ORCHESTRATOR=1` (via the DBOS
 * bootstrap). The end-to-end run (real/fake agent) is the live-validation step
 * (P-012/P-013); this module is the wiring that makes it possible.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { resolveProject } from '@/lib/harness-core';
import { harnessPackageDir } from '@/lib/harness-paths';
import { buildInvokeOnce } from '@/lib/harness-invoke-once';
import { setPipelineInvokeRunner, type PipelineInvokeRunner } from './orchestrator-workflow';

const INVOKE_TIMEOUT_MS = Number(process.env.PAPERCUSP_DBOS_INVOKE_TIMEOUT_MS ?? 600_000);

/**
 * Strip the orchestrator's `[2026-…]` timestamp log lines from invoke-once
 * stdout, leaving the agent's actual output (the decision line + body). Mirrors
 * the filter in `routes/harness/spawn.ts`. Exported for unit testing.
 */
export function extractAgentOutput(stdout: string): string {
  return stdout
    .split('\n')
    .filter((l) => !/^\[20\d\d-\d\d-\d\dT/.test(l))
    .join('\n')
    .trim();
}

const realRunner: PipelineInvokeRunner = async (harnessSlug, role, featureId, idempotencyKey) => {
  const project = await resolveProject(harnessSlug);
  if (!project) {
    // Unknown harness → empty output (the workflow parses '' → terminal → stops).
    return { output: '', exitCode: 1 };
  }
  const { command, args, env } = buildInvokeOnce({
    projectDir: project.path,
    stateDir: join(project.path, '.harness'),
    harnessDir: harnessPackageDir(),
    role,
    extras: featureId ? [`FEATURE_ID=${featureId}`] : [],
    extraEnv: { IDEMPOTENCY_KEY: idempotencyKey },
  });
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: project.path, env });
    let stdout = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    }, INVOKE_TIMEOUT_MS);
    child.stdout?.on('data', (d) => { stdout += String(d); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ output: extractAgentOutput(stdout), exitCode: code ?? 1 });
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ output: '', exitCode: 1 });
    });
  });
};

let _wired = false;
/** Wire the real invoke runner into the durable pipeline. Idempotent. */
export function wireOrchestratorInvokeRunner(): void {
  if (_wired) return;
  _wired = true;
  setPipelineInvokeRunner(realRunner);
}
