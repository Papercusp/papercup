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
import postgres from 'postgres';
import {
  readConfig,
  configGet,
  resolvePhase,
  runHook,
  firePluginHook,
  postCuratorOutputs,
  postArchiveEvent,
  captureDebuggerOutput,
  materializeFeatureDebugNote,
} from '@papercusp/orchestrator';
import { resolveProject } from '@/lib/harness-core';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { getHarnessAdminUrl } from '@/lib/embedded-pg-discovery';
import { harnessPackageDir } from '@/lib/harness-paths';
import { buildInvokeOnce } from '@/lib/harness-invoke-once';
import {
  setPipelineInvokeRunner,
  setPipelineFinalizer,
  setPipelineSettledHook,
  setPipelineDebuggerHook,
  type PipelineInvokeRunner,
  type PipelineFinalizer,
  type PipelineDebuggerHook,
} from './orchestrator-workflow';
import { planFinalization, needsHumanGateUrl } from './orchestrator-finalize';
import { buildPipelineExtraEnv } from './orchestrator-spawn-env';
import {
  emitFeatureWorkedStart,
  emitFeatureWorkedEnd,
  emitAgentRunCompleted,
} from '../harness/usage-emitters';
import { refillHarnessOnSettle } from './orchestrator-loop';
import { wireAuditorLane } from './auditor-lane-wiring';
import { governorForBackend, classifyTurnError } from '@papercusp/papercup-shared/agent';
import { resolveSpawnBackendModel } from '../harness-invoke-once';
import { initAgentGovernorObserver } from '../agent-governor-observer';

const INVOKE_TIMEOUT_MS = Number(process.env.PAPERCUSP_DBOS_INVOKE_TIMEOUT_MS ?? 600_000);
// How long an orchestrator spawn will wait on a shared rate-limit pause before giving up
// (the director re-tries later). Unattended → wait generously, but bounded.
const GOVERNOR_MAX_WAIT_MS = Number(process.env.PAPERCUSP_AGENT_GOVERNOR_MAX_WAIT_MS ?? 1_800_000);

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

/** Max chars of child stderr to surface on a failed invoke (P-005). */
const STDERR_SURFACE_LIMIT = 4000;

/**
 * Build the stderr-surfacing log line for a non-zero `invoke-once` exit (P-005).
 * Returns `null` on a clean exit (code 0) or when the child wrote nothing to
 * stderr. Exported for unit testing.
 *
 * Why this exists: a subprocess that THROWS during boot (e.g. the
 * `source_plan_slug` column / `paths.map` runtime bugs the retire plan's D-014
 * fixed) writes its message to the child's stderr and exits non-zero BEFORE it
 * ever records a `harness_run_output` row — so the parent saw only an empty
 * stdout + exit 1 and the real cause was invisible. Capturing + logging the
 * child's stderr here makes those throw-before-run failures debuggable, which the
 * debugger-before-worker (P-012) and CONVERT_ISSUES (P-011) fills depend on.
 */
export function formatInvokeStderr(role: string, exitCode: number, stderr: string): string | null {
  const trimmed = stderr.trim();
  if (exitCode === 0 || !trimmed) return null;
  const body =
    trimmed.length > STDERR_SURFACE_LIMIT
      ? `${trimmed.slice(0, STDERR_SURFACE_LIMIT)}\n... [stderr truncated: ${trimmed.length} chars]`
      : trimmed;
  return `[dbos-invoke] role=${role} exited ${exitCode} — stderr:\n${body}`;
}

/**
 * Spawn one headless `invoke-once` run for `role` with the given `extras`
 * (complete KEY=value list) inside `projectDir`. Shared by the role runner and
 * the finalizer (curator/documenter). Resolves to the agent's output + exit code
 * + captured stderr; never rejects. On a non-zero exit the child's stderr is
 * surfaced to the operator run log (P-005) so a throw-before-run isn't silent.
 */
// Exported for unit testing (P-012): the subprocess spawn + timeout-kill +
// stdout/stderr-capture path. Tests mock `buildInvokeOnce` to drive a fake
// process; production callers go through realRunner / realFinalizer.
export async function spawnInvokeOnce(
  projectDir: string,
  role: string,
  extras: string[],
  extraEnv: Record<string, string>,
): Promise<{ output: string; exitCode: number; stderr: string }> {
  const { command, args, env } = buildInvokeOnce({
    projectDir,
    stateDir: join(projectDir, '.harness'),
    harnessDir: harnessPackageDir(),
    role,
    extras,
    extraEnv,
  });

  // RB-012: pace pipeline spawns through the SHARED governor when enabled (default OFF →
  // unchanged). PACING ONLY — concurrency/rate gate + penalize the governor on a detected
  // 429, so the whole operator's agent spawns stay under the account's rate limit. We do
  // NOT retry here: the orchestrator/director already owns turn retries (avoid double-retry).
  // Key the bucket to the backend+model the spawn ACTUALLY uses (the default `omp -p`
  // self-paces → its own concurrency-only bucket; claude → the Anthropic per-class bucket)
  // rather than the old hardcoded `('claude-code','')` which mis-bucketed everything.
  if (process.env.PAPERCUSP_AGENT_GOVERNOR === '1') {
    const { backend, model } = resolveSpawnBackendModel(role);
    const gov = governorForBackend(backend, model);
    const release = await gov.acquire({}, { maxWaitMs: GOVERNOR_MAX_WAIT_MS });
    if (!release) {
      return { output: '', exitCode: 1, stderr: 'agent governor: rate-limit pause exceeded max wait' };
    }
    try {
      const inner = await runChild(command, args, projectDir, env, role);
      // Classify the outcome; on a detected 429/overload, pause the SHARED governor so the
      // operator's other agent spawns back off too. No retry here — the director owns that.
      const te = classifyTurnError(backend, { exitCode: inner.exitCode, signal: null, stderr: inner.stderr, stdout: inner.output });
      if (te.class === 'rate_limited' || te.class === 'overloaded') gov.penalize({ retryAfterMs: te.retryAfterMs, resetAt: te.resetAt });
      return inner;
    } finally {
      release();
    }
  }
  return runChild(command, args, projectDir, env, role);
}

/** The raw subprocess spawn + timeout-kill + stdout/stderr capture (never rejects). */
function runChild(
  command: string,
  args: string[],
  projectDir: string,
  env: NodeJS.ProcessEnv,
  role: string,
): Promise<{ output: string; exitCode: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: projectDir, env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    }, INVOKE_TIMEOUT_MS);
    child.stdout?.on('data', (d) => { stdout += String(d); });
    child.stderr?.on('data', (d) => { stderr += String(d); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const exitCode = code ?? 1;
      const failLog = formatInvokeStderr(role, exitCode, stderr);
      if (failLog) console.error(failLog);
      resolve({ output: extractAgentOutput(stdout), exitCode, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[dbos-invoke] role=${role} spawn error: ${msg}`);
      resolve({ output: '', exitCode: 1, stderr: msg });
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
  // P-070 usage ledger (best-effort, never throws): a worker run starting is
  // `feature_worked_start`; ANY role run ending is `agent_run_completed` and a
  // worker run ending is `feature_worked_end`. run_id = the run's idempotency
  // key. Actor = the local machine identity (the orchestrator host). The
  // finalizer's curator/documenter runs are a separate path with no run id —
  // their agent_run_completed is a tracked follow-up, not wired here.
  const runId = idempotencyKey || '';
  if (runId && role === 'worker') {
    void emitFeatureWorkedStart(harnessSlug, runId, { role });
  }
  const startedAt = Date.now();
  // HARNESS_SLUG = the registry slug (not basename(project.path)) so invoke-once's
  // pg-bootstrap resolves harness_<slug> correctly; PAPERCUSP_WORKSPACE_ID pins the
  // agent's feature reads to the pipeline's captured workspace.
  const result = await spawnInvokeOnce(
    project.path,
    role,
    extras,
    buildPipelineExtraEnv({ harnessSlug, idempotencyKey, workspaceId }),
  );
  if (runId) {
    const durationMs = Date.now() - startedAt;
    void emitAgentRunCompleted(harnessSlug, runId, { role, durationMs });
    if (role === 'worker') {
      void emitFeatureWorkedEnd(harnessSlug, runId, {
        outcome: result.exitCode === 0 ? 'completed' : 'failed',
      });
    }
  }
  return result;
};

/**
 * Pure guard for debugger-before-worker (P-012 / D-005), mirroring the legacy
 * main-loop guard (`main-loop.ts:1061-1065`): fire the read-only debugger before
 * the worker iff the debugger is enabled, the feature has failed enough times
 * (`attempts ≥ threshold`), and no debug note exists yet (fires at most once).
 * Exported for unit testing.
 */
export function debuggerGateDecision(input: {
  enabled: boolean;
  attempts: number;
  threshold: number;
  noteExists: boolean;
}): boolean {
  return input.enabled && input.attempts >= input.threshold && !input.noteExists;
}

/**
 * The real debugger-before-worker hook (P-012). Resolves the harness in the
 * pipeline's captured workspace, reads `debugger.enabled`/`debugger.threshold`
 * from config + the feature's current `attempts` from PG, and — when the gate
 * fires — runs the read-only `debugger` role then captures its `<stateDir>/debug/
 * <fid>.md` output to PG (canonical). The note (PG-canonical, materialized to FS)
 * is the once-only dedup the worker also reads. Best-effort: any failure returns
 * `{ fired: false }` so a debugger problem never blocks the worker.
 */
const realDebuggerHook: PipelineDebuggerHook = async ({ harnessSlug, featureId, workspaceId }) => {
  const project = await resolveProject(harnessSlug, workspaceId);
  if (!project) return { fired: false };
  const projectDir = project.path;
  const stateDir = join(projectDir, '.harness');
  const cfg = readConfig(stateDir);
  if (configGet<boolean>(cfg, 'debugger.enabled', true) !== true) return { fired: false };
  const threshold = Number(configGet<unknown>(cfg, 'debugger.threshold', 3));
  const ws = workspaceId ?? activeWorkspaceId();

  const pg = postgres(getHarnessAdminUrl(), {
    max: 1,
    connect_timeout: 5,
    connection: { search_path: `harness_${harnessSlug},harness_shared,public` },
  });
  try {
    const attRows = await pg<Array<{ attempts: number | bigint | null }>>`
      SELECT attempts FROM harness_features
       WHERE workspace_id = ${ws} AND feature_id = ${featureId}
       LIMIT 1
    `;
    const attempts = Number(attRows[0]?.attempts ?? 0);
    if (attempts < threshold) return { fired: false };

    // PG is canonical for debug notes; materialize PG → FS so (a) the worker
    // prompt's "read .harness/debug/<fid>.md" sees prior analysis and (b) a note
    // from an earlier run/process counts as "already debugged" without an
    // expensive re-run. A note on disk (this same epoch) also counts.
    const debugNotePath = join(stateDir, 'debug', `${featureId}.md`);
    const mat = await materializeFeatureDebugNote({ pg: pg as never, workspaceId: ws, harnessSlug, featureId, stateDir });
    const noteExists = mat.written || existsSync(debugNotePath);

    if (!debuggerGateDecision({ enabled: true, attempts, threshold, noteExists })) {
      return { fired: false };
    }

    console.log(`[dbos-debugger] ${harnessSlug}/${featureId} starting (attempts=${attempts} ≥ ${threshold})`);
    const extraEnv = buildPipelineExtraEnv({ harnessSlug, workspaceId: ws });
    const r = await spawnInvokeOnce(projectDir, 'debugger', [`FEATURE_ID=${featureId}`], extraEnv);
    console.log(`[dbos-debugger] ${(r.output || '').slice(0, 200) || '(no output)'}`);
    // Capture whatever the debugger wrote at <stateDir>/debug/<fid>.md → PG.
    await captureDebuggerOutput({ pg: pg as never, workspaceId: ws, harnessSlug, featureId, stateDir }).catch(() => {});
    return { fired: true };
  } catch (err) {
    console.warn(`[dbos-debugger] ${harnessSlug}/${featureId} gate error (non-fatal):`, err instanceof Error ? err.message : err);
    return { fired: false };
  } finally {
    await pg.end({ timeout: 2 }).catch(() => {});
  }
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

const realFinalizer: PipelineFinalizer = async ({ harnessSlug, featureId, workspaceId, outcome, reason }) => {
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
    featureId,
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
        const finalizeStartedAt = Date.now();
        const r = await spawnInvokeOnce(projectDir, step.role, step.extras, extraEnv);
        // P-070 (best-effort): the finalizer's curator/documenter runs are agent
        // runs too. They carry no idempotency key (run once per finalization), so
        // synthesize a stable run_id from feature+role+phase.
        void emitAgentRunCompleted(harnessSlug, `${featureId}:${step.role}:finalize`, {
          role: step.role,
          durationMs: Date.now() - finalizeStartedAt,
        });
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

  // P-043 / D-019: completion-time generator safety net. The producing feature's
  // worker normally expands its generative wave at generators:publish-time; this
  // re-runs that expansion on DONE — idempotent (deterministic child ids), so it's
  // a no-op if already expanded, but it (a) catches a publish that failed to
  // expand and (b) ESCALATES if a feature that a `for_each: { from_feature: <this> }`
  // wave sources from finished WITHOUT publishing any items (never silently yields
  // zero children — D-012a). Best-effort; never sinks finalization.
  if (outcome === 'done' && featureId && featureId !== '-') {
    try {
      const { expandGeneratorsForFeature } = await import('@/lib/agent-tools/plans/expand-generators');
      const r = await expandGeneratorsForFeature({
        harnessSlug,
        featureId,
        workspaceId: workspaceId ?? activeWorkspaceId(),
        requireItems: true,
      });
      if (r.expanded > 0) {
        console.log(`[dbos-finalize] expanded ${r.expanded} generated child feature(s) from ${featureId}`);
      }
      for (const esc of r.escalations) {
        console.warn(`[dbos-finalize] generator escalation (${harnessSlug}/${featureId}): ${esc}`);
      }
    } catch (err) {
      console.warn(`[dbos-finalize] generator expansion error (non-fatal):`, err instanceof Error ? err.message : err);
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
/** Wire the real invoke runner + terminal finalizer + on-completion refill +
 * G2 auditor lane into the durable pipeline. Idempotent. */
export function wireOrchestratorInvokeRunner(): void {
  if (_wired) return;
  _wired = true;
  // RB-009: surface rate-limit-governor pauses to coord + the toast stream. Idempotent; the
  // governor is shared by the pipeline spawn, meridian calls, and the gym, so one init here
  // (on operator boot) covers them all.
  initAgentGovernorObserver();
  setPipelineInvokeRunner(realRunner);
  setPipelineFinalizer(realFinalizer);
  // P-012: fire the read-only debugger before a worker when the feature has
  // failed ≥ debugger.threshold times and has no debug note yet.
  setPipelineDebuggerHook(realDebuggerHook);
  // #1: a finished feature immediately refills its harness's freed slot with the
  // next queued feature, instead of waiting up to 30s for the periodic tick.
  setPipelineSettledHook((slug, workspaceId) =>
    refillHarnessOnSettle(slug, workspaceId ?? activeWorkspaceId()),
  );
  // G2 P-007: wire the real auditor spawn + escalation functions so the
  // orchestrator loop's audit lane can screen remote-pending features.
  wireAuditorLane();
}
