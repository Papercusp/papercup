/**
 * Phase 3 of `dbos-durable-jobs-2026-05-31` + Phase F of
 * `dbos-retire-legacy-orchestrator-2026-05-31` — the operator-side wiring for the
 * durable feature pipeline (`orchestrator-workflow.ts`):
 *
 *  - the REAL invoke runner (`setPipelineInvokeRunner`): spawns the orchestrator's
 *    `invoke-once` bin (headless) for one agent run, passing `IDEMPOTENCY_KEY` so a
 *    re-run of a completed agent is reused, not re-spawned (P-015), and the
 *    classifier-built `extras` verbatim;
 *  - the REAL terminal finalizer (`setPipelineFinalizer`, P-001/P-002): ports the
 *    legacy main-loop's `handleDone` / `handleEscalate` — needs-human gate, then
 *    curator + documenter + archive + afterDone hook on DONE, or the on-escalate
 *    hook + curator on ESCALATE — so the durable pipeline distills run memory and
 *    writes docs instead of just stopping at DONE.
 *
 * Loaded + wired only when `PAPERCUSP_DBOS_ORCHESTRATOR=1` (via the DBOS bootstrap).
 */
import { spawn } from 'node:child_process';
import { join, basename } from 'node:path';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  readConfig,
  configGet,
  resolvePhase,
  runHook,
  firePluginHook,
  postCuratorOutputs,
  postArchiveEvent,
} from '@papercusp/orchestrator';
import { resolveProject } from '@/lib/harness-core';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { harnessPackageDir } from '@/lib/harness-paths';
import { buildInvokeOnce } from '@/lib/harness-invoke-once';
import {
  setPipelineInvokeRunner,
  setPipelineFinalizer,
  setPipelineSettledHook,
  type PipelineInvokeRunner,
  type PipelineFinalizer,
} from './orchestrator-workflow';
import { planFinalization, needsHumanGateUrl } from './orchestrator-finalize';
import { buildPipelineExtraEnv } from './orchestrator-spawn-env';
import { refillHarnessOnSettle } from './orchestrator-dispatcher';

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

/**
 * Spawn one headless `invoke-once` run for `role` with the given `extras`
 * (complete KEY=value list) inside `projectDir`. Shared by the role runner and
 * the finalizer (curator/documenter). Resolves to the agent's output + exit code;
 * never rejects.
 */
async function spawnInvokeOnce(
  projectDir: string,
  role: string,
  extras: string[],
  extraEnv: Record<string, string>,
): Promise<{ output: string; exitCode: number }> {
  const { command, args, env } = buildInvokeOnce({
    projectDir,
    stateDir: join(projectDir, '.harness'),
    harnessDir: harnessPackageDir(),
    role,
    extras,
    extraEnv,
  });
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: projectDir, env });
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
}

const realRunner: PipelineInvokeRunner = async (harnessSlug, role, _featureId, idempotencyKey, extras, workspaceId) => {
  // Resolve in the pipeline's CAPTURED workspace, not the volatile active one
  // (which can switch mid-pipeline and make `resolveProject` return null →
  // empty output → a spurious ERROR on a later turn).
  const project = await resolveProject(harnessSlug, workspaceId);
  if (!project) {
    // Unknown harness → empty output (the workflow parses '' → terminal → stops).
    return { output: '', exitCode: 1 };
  }
  // HARNESS_SLUG = the registry slug (not basename(project.path)) so invoke-once's
  // pg-bootstrap resolves harness_<slug> correctly; PAPERCUSP_WORKSPACE_ID pins the
  // agent's feature reads to the pipeline's captured workspace.
  return spawnInvokeOnce(
    project.path,
    role,
    extras,
    buildPipelineExtraEnv({ harnessSlug, idempotencyKey, workspaceId }),
  );
};

/**
 * Substrate base for the needs-human DONE-gate (mirrors legacy handleDone).
 */
function substrateBase(): string {
  return (
    process.env.PAPERCUSP_SUBSTRATE_BASE ??
    process.env.PAPERCUSP_HONO_BASE ??
    'http://localhost:3070'
  );
}

/** True iff the harness has an open needs-human plan item for ITS OWN plans (blocks DONE). */
async function needsHumanOpen(slug: string): Promise<boolean> {
  try {
    const url = needsHumanGateUrl(substrateBase(), slug);
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return false;
    const body = (await res.json()) as { items?: unknown[] };
    return Array.isArray(body.items) && body.items.length > 0;
  } catch {
    // Gate is advisory; a fetch failure must not strand a finished feature.
    return false;
  }
}

const realFinalizer: PipelineFinalizer = async ({ harnessSlug, workspaceId, outcome, reason }) => {
  const project = await resolveProject(harnessSlug, workspaceId);
  if (!project) {
    console.warn(`[dbos-finalize] unknown harness ${harnessSlug} — skipping finalization`);
    return;
  }
  const projectDir = project.path;
  const stateDir = join(projectDir, '.harness');
  const logDir = join(stateDir, 'logs');
  const cfg = readConfig(stateDir);
  // Curator/documenter run with the registry slug too (correct schema) + the
  // pipeline's workspace; no idempotency key (they run once at finalization).
  const extraEnv = buildPipelineExtraEnv({ harnessSlug, workspaceId });

  // Gates only apply to DONE; ESCALATE always distills memory.
  const blocked = outcome === 'done' ? await needsHumanOpen(harnessSlug) : false;
  const plan = planFinalization({
    outcome,
    reason,
    needsHumanOpen: blocked,
    // Smoke gate is config-gated-off for ~all harnesses; not yet ported into the
    // durable finalizer (runSmokeTest is a main-loop-internal). Tracked as a Phase
    // F follow-up; pass not-run so it never blocks here.
    smokeEnabled: false,
    smokePassed: null,
    archiveOnDone: configGet<boolean>(cfg, 'archiveOnDone', false) === true,
  });

  if (plan.blocked) {
    console.log(
      `[dbos-finalize] DONE blocked for ${harnessSlug} (open needs-human plan item) — skipping curator/documenter`,
    );
    return;
  }

  for (const step of plan.steps) {
    try {
      if (step.kind === 'invoke') {
        const r = await spawnInvokeOnce(projectDir, step.role, step.extras, extraEnv);
        console.log(`[dbos-finalize] ${step.role}: ${(r.output || '').slice(0, 160) || '(no output)'}`);
      } else if (step.kind === 'postCuratorOutputs') {
        await postCuratorOutputs({ stateDir, harnessDir: harnessPackageDir() }).catch(() => {});
      } else if (step.kind === 'archive') {
        archiveStateDir(stateDir, resolvePhase(cfg).phase || 'staging');
      } else if (step.kind === 'hook') {
        if (step.hook === 'on-escalate') {
          runHook('on-escalate', {
            stateDir,
            projectDir,
            logDir,
            env: { REASON: reason ?? '', PROJECT_DIR: projectDir, STATE_DIR: stateDir },
            log: (m) => console.log(`[dbos-finalize] ${m}`),
            harnessSlug,
            ...(workspaceId ? { workspaceId } : {}),
          });
        } else if (step.hook === 'afterDone') {
          firePluginHook({
            hookName: 'afterDone',
            projectDir,
            stateDir,
            pluginsLogPath: join(logDir, 'plugins.log'),
            log: (m) => console.log(`[dbos-finalize] ${m}`),
          });
        }
      }
    } catch (err) {
      console.warn(`[dbos-finalize] step ${step.kind} error (non-fatal):`, err instanceof Error ? err.message : err);
    }
  }
};

/** Archive the state dir to `<stateDir>/archives/<ts>-done.tar.gz` + post the event. */
function archiveStateDir(stateDir: string, phase: string): void {
  const archivesDir = join(stateDir, 'archives');
  mkdirSync(archivesDir, { recursive: true });
  const archivePath = join(archivesDir, `${Math.floor(Date.now() / 1000)}-done.tar.gz`);
  const tarRes = spawnSync(
    'tar',
    ['czf', archivePath, '-C', stateDir, '--exclude=archives', '--exclude=./archives', '.'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (tarRes.status === 0 && existsSync(archivePath)) {
    const sz = (() => { try { return statSync(archivePath).size; } catch { return 0; } })();
    console.log(`[dbos-finalize] archiveOnDone: saved ${basename(archivePath)} (${sz} bytes)`);
    void postArchiveEvent({ stateDir, archivePath, phase }).catch(() => {});
  } else {
    console.log(`[dbos-finalize] archiveOnDone: tar failed (rc=${tarRes.status})`);
  }
}

let _wired = false;
/** Wire the real invoke runner + terminal finalizer + on-completion refill into
 * the durable pipeline. Idempotent. */
export function wireOrchestratorInvokeRunner(): void {
  if (_wired) return;
  _wired = true;
  setPipelineInvokeRunner(realRunner);
  setPipelineFinalizer(realFinalizer);
  // #1: a finished feature immediately refills its harness's freed slot with the
  // next queued feature, instead of waiting up to 30s for the periodic tick.
  setPipelineSettledHook((slug, workspaceId) =>
    refillHarnessOnSettle(slug, workspaceId ?? activeWorkspaceId()),
  );
}
