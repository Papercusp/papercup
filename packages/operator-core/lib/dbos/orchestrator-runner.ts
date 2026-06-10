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
  configGet,
  resolvePhase,
  runHook,
  firePluginHook,
  postCuratorOutputs,
  postArchiveEvent,
  captureDebuggerOutput,
  materializeFeatureDebugNote,
} from '@papercusp/orchestrator';
import { readEffectiveHarnessConfig } from '../harness-effective-config';
import { loadBlueprintFromFile, type Blueprint } from '@papercusp/orchestrator/blueprint';
import { resolveProject } from '../harness-core';
import { activeWorkspaceId } from '../workspace-registry';
import { getHarnessAdminUrl } from '../embedded-pg-discovery';
import { harnessPackageDir } from '../harness-paths';
import { buildInvokeOnce } from '../harness-invoke-once';
import {
  setPipelineInvokeRunner,
  setPipelineFinalizer,
  setPipelineSettledHook,
  setPipelineDebuggerHook,
  setPipelineFeaturePassedHook,
  type PipelineInvokeRunner,
  type PipelineFinalizer,
  type PipelineDebuggerHook,
} from './orchestrator-workflow';
import { handleFeaturePassed, type FeaturePassedDeps } from '../harness/fork-pr-on-feature-pass';
import { planFinalization, needsHumanGateUrl, reconcileDoneStatus, type FinalizeRecipe } from './orchestrator-finalize';
import { buildPipelineExtraEnv } from './orchestrator-spawn-env';
import { acquireAgentDisplay, agentDisplayPool } from '../deployment/display-allocator';
import {
  emitFeatureWorkedStart,
  emitFeatureWorkedEnd,
  emitAgentRunCompleted,
} from '../harness/usage-emitters';
import { refillHarnessOnSettle } from './orchestrator-loop';
import { wireAuditorLane } from './auditor-lane-wiring';
import {
  governorForBackend,
  classifyTurnError,
  isAccountWide,
  setGovernorStore,
  setMeridianUsageSink,
  modelClassOf,
} from '@papercusp/papercup-shared/agent';
import { resolveSpawnBackendModel } from '../harness-invoke-once';
import { initAgentGovernorObserver } from '../agent-governor-observer';
import { maybeInstallPgGovernorStore } from '../agent-governor-pg-store';
import { initRateLimitConfig } from '../rate-limit-config';
import { recordUsageHeaders } from '../agent-usage-telemetry';

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
 * spawnInvokeOnce — THE single agent-spawn chokepoint. Spawn one headless
 * `invoke-once` run for `role` with the given `extras` (complete KEY=value list)
 * inside `projectDir`. Shared by the pipeline role runner, the finalizer
 * (curator/documenter), the operator nursery (`fleet:spawn`), and the coord-program
 * fan-out. Resolves to the agent's output + exit code + captured stderr; never
 * rejects. On a non-zero exit the child's stderr is surfaced to the operator run
 * log so a throw-before-run isn't silent.
 *
 * ── What this chokepoint owns (unify-agent-spawn-chokepoint-2026-06-06) ──
 *   • ADMISSION — "is this spawn worth it right now?" is the BRAIN's judgment
 *     (the deterministic governor is only a floor), routed as a typed role-gated
 *     new_subagent request; the requester awaits the grant (D-002/D-004/D-008).
 *   • PACING / SAFETY FLOOR — the optional SHARED governor below (RB-012): a
 *     concurrency permit + reactive 429-penalty so the whole operator stays under
 *     the provider's rate limits, plus the single hard ceiling (rate_limit_config
 *     `maxSimultaneousAgents`, D-002/P-007). Reactive physics, never the worth-it call.
 *   • DELIVERY / DURABILITY — opt-in BY SPAWN CLASS (D-003): AUTONOMOUS spawns
 *     (routine fires, launch-blueprints, `fleet:spawn`) are wrapped in a durable,
 *     idempotency-keyed DBOS step so a crash re-runs them once (P-010); INTERACTIVE
 *     `psu` is NOT made durable — a human is the durability, and auto-retrying their
 *     session would be wrong — but it STILL passes admission + the safety floor.
 *
 * ── What this chokepoint does NOT own: model-turn retry (D-005) ──
 *   The model-turn rate-limit retry (`runWithRetry`/`runAgentTurn`) is a SEPARATE
 *   layer that wraps our IN-PROCESS `meridian` calls. It physically CANNOT reach
 *   inside a spawned `claude`/`omp`/`codex` subprocess's turns — we only see the
 *   process boundary. The CLI self-retries its own turns and the director owns
 *   turn-retries; folding subprocess-turn retry in HERE would be our-retry ×
 *   CLI-retry amplification. The chokepoint's "delivery" guarantee is whole-spawn
 *   re-run on crash (DBOS), a DIFFERENT thing from in-turn retry. Do NOT add
 *   per-turn retry to this function.
 */
// Exported for unit testing (P-012): the subprocess spawn + timeout-kill +
// stdout/stderr-capture path. Tests mock `buildInvokeOnce` to drive a fake
// process; production callers go through realRunner / realFinalizer.
export async function spawnInvokeOnce(
  projectDir: string,
  role: string,
  extras: string[],
  extraEnv: Record<string, string>,
  /** Optional abort: when the signal fires, the child is SIGTERM'd (then SIGKILL
   *  after a grace period). Lets a caller (e.g. fleet:cancel via the operator
   *  spawn engine, EI-40) actually STOP the running agent, not just flip its row.
   *  Omitted by the pipeline runner / finalizer, which never abort mid-run.
   *  `resultPath`: when set, invoke-once tees its output here and appends the
   *  `__INVOCATION_DONE__` sentinel on exit — for a BACKGROUND caller that
   *  fire-and-forgets the spawn and polls the result FILE for completion (the
   *  scoper). Routing such a caller here (rather than a private raw spawn) is
   *  what keeps the scoper governed by the one chokepoint (P-008 / D-013). */
  opts?: { signal?: AbortSignal; timeoutMs?: number; resultPath?: string; forceSessionId?: string },
): Promise<{ output: string; exitCode: number; stderr: string; timedOut?: boolean }> {
  // P-008 (cloud-deployment-layer): deliver the per-install instance config to the
  // child via env-transport (workspace PG is canonical; config.json is the
  // back-compat fallback). Gated on HARNESS_SLUG + PAPERCUSP_WORKSPACE_ID (set by
  // buildPipelineExtraEnv on every pipeline spawn). Best-effort + behavior-
  // preserving: for an un-migrated harness the assembled config IS that harness's
  // config.json, and any failure falls through to the child reading the file.
  let resolvedExtraEnv = extraEnv;
  const cfgSlug = extraEnv.HARNESS_SLUG;
  const cfgWs = extraEnv.PAPERCUSP_WORKSPACE_ID;
  if (cfgSlug && cfgWs && !extraEnv.HARNESS_CONFIG_JSON) {
    try {
      const { instanceConfigEnv } = await import('../deployment/instance-config');
      const instEnv = await instanceConfigEnv(cfgSlug, cfgWs);
      if (instEnv.HARNESS_CONFIG_JSON) resolvedExtraEnv = { ...extraEnv, ...instEnv };
    } catch {
      /* fall back to the child reading .papercusp/config.json */
    }
  }
  // P-002 (hive-frame-desktops-live-view): on a desktop-enabled frame the
  // bootstrap stood up one Xvfb display per agent slot and advertised the pool
  // via PAPERCUSP_DESKTOP_DISPLAYS/_DISPLAY_BASE — lease one for this agent so
  // concurrent GUI agents never share a screen (D-001). Off-frame this is a
  // no-op; pool exhausted → headless spawn (logged), never queued.
  const displayLease = acquireAgentDisplay({ role });
  if (displayLease) {
    resolvedExtraEnv = {
      ...resolvedExtraEnv,
      DISPLAY: displayLease.display,
      // The explicit capability marker — DISPLAY alone can leak in from a dev
      // box's own session; this says "leased for THIS agent by the frame".
      PAPERCUSP_AGENT_DISPLAY: displayLease.display,
    };
  } else if (agentDisplayPool()) {
    console.warn(`[dbos-invoke] role=${role} desktop display pool exhausted — spawning headless`);
  }

  try {
    const { command, args, env } = buildInvokeOnce({
      projectDir,
      stateDir: join(projectDir, '.papercusp'),
      harnessDir: harnessPackageDir(),
      role,
      extras,
      extraEnv: resolvedExtraEnv,
      resultPath: opts?.resultPath,
      // P-016/D-007: when set (claude bees), bakes `--session-id <uuid>` into the
      // agent command so the headless run is resumable by exact id for the
      // hive-tabs bee attach (`claude --resume`). No-op for omp/codex.
      forceSessionId: opts?.forceSessionId,
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
      // P-019: on a frame launched under a bound account, key the bucket to that account
      // so its separate subscription tracks its separate rate limits (and its pauses carry
      // the account id, driving the Queen's scale-out). Unset locally ⇒ the global bucket.
      const gov = governorForBackend(backend, model, undefined, process.env.PAPERCUSP_ACCOUNT_ID || undefined);
      const release = await gov.acquire({}, { maxWaitMs: GOVERNOR_MAX_WAIT_MS });
      if (!release) {
        return { output: '', exitCode: 1, stderr: 'agent governor: rate-limit pause exceeded max wait' };
      }
      try {
        const inner = await runChild(command, args, projectDir, env, role, opts?.signal, opts?.timeoutMs);
        // Classify the outcome; on a detected account-wide stop (429/overload/usage-cap), pause the
        // SHARED governor so the operator's other agent spawns back off too. No retry here — the
        // director owns that. A usage_limit carries its reset, so the fleet parks until reset (D-001).
        const te = classifyTurnError(backend, { exitCode: inner.exitCode, signal: null, stderr: inner.stderr, stdout: inner.output });
        if (isAccountWide(te.class)) gov.penalize({ retryAfterMs: te.retryAfterMs, resetAt: te.resetAt });
        return inner;
      } finally {
        release();
      }
    }
    // `return await` (not bare `return`) so the display lease's finally releases
    // AFTER the child exits, not when the promise is handed back.
    return await runChild(command, args, projectDir, env, role, opts?.signal, opts?.timeoutMs);
  } finally {
    displayLease?.release();
  }
}

/** SIGKILL grace after the SIGTERM on abort/timeout — gives the child a moment
 *  to flush + exit cleanly before we hard-kill. */
const KILL_GRACE_MS = 2_000;

/** The raw subprocess spawn + timeout-kill + stdout/stderr capture (never rejects). */
function runChild(
  command: string,
  args: string[],
  projectDir: string,
  env: NodeJS.ProcessEnv,
  role: string,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<{ output: string; exitCode: number; stderr: string; timedOut?: boolean }> {
  return new Promise((resolve) => {
    // Already-aborted before we spawn → don't launch at all.
    if (signal?.aborted) {
      resolve({ output: '', exitCode: 1, stderr: 'aborted before start' });
      return;
    }
    let timedOut = false;
    // `detached: true` puts the child in its OWN process group so we can reap the
    // WHOLE tree on abort/timeout, not just the immediate child. In dev the spawn is
    // `node <tsx-cli> invoke-once.ts`, and the tsx CLI forks a worker (invoke-once,
    // which spawns the agent) — a single-PID kill hits only the wrapper and orphans
    // the agent (EI-40). Group-kill (`process.kill(-pid)`) takes out wrapper +
    // invoke-once + agent together. The new group is the child's alone, so it can
    // never signal the operator host (a different group).
    const child = spawn(command, args, { cwd: projectDir, env, detached: true });
    let stdout = '';
    let stderr = '';
    let killGrace: ReturnType<typeof setTimeout> | null = null;
    let aborted = false;
    // Kill the child's whole process group; fall back to a single-PID kill if the
    // group send fails (e.g. the child already exited / no group).
    const killTree = (sigName: NodeJS.Signals) => {
      const pid = child.pid;
      if (pid) { try { process.kill(-pid, sigName); return; } catch { /* fall through */ } }
      try { child.kill(sigName); } catch { /* ignore */ }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
    }, timeoutMs ?? INVOKE_TIMEOUT_MS);
    // Caller-driven abort (EI-40: fleet:cancel of an operator spawn): SIGTERM the
    // tree now, SIGKILL it after a grace period if it ignores the term.
    const onAbort = () => {
      aborted = true;
      killTree('SIGTERM');
      killGrace = setTimeout(() => { killTree('SIGKILL'); }, KILL_GRACE_MS);
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      if (killGrace) clearTimeout(killGrace);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    child.stdout?.on('data', (d) => { stdout += String(d); });
    child.stderr?.on('data', (d) => { stderr += String(d); });
    child.on('close', (code) => {
      cleanup();
      // A child we aborted may exit 0 (it caught SIGTERM and shut down) or via the
      // signal — normalize to a non-zero "aborted" outcome so callers don't read a
      // cancelled run as a clean success.
      if (aborted) {
        resolve({ output: extractAgentOutput(stdout), exitCode: 1, stderr: stderr.trim() || 'aborted (fleet:cancel)' });
        return;
      }
      const exitCode = code ?? 1;
      const failLog = formatInvokeStderr(role, exitCode, stderr);
      if (failLog) console.error(failLog);
      // A non-zero exit with EMPTY stderr is otherwise completely silent (the
      // upstream "exit=1 empty=true" hides whether the agent even produced output).
      else if (exitCode !== 0) {
        const dbg =
          process.env.PAPERCUSP_DBOS_INVOKE_DEBUG === '1'
            ? `\n--- stdout tail (${role}) ---\n${stdout.length > 2000 ? stdout.slice(-2000) : stdout}`
            : '';
        console.error(`[dbos-invoke] role=${role} exited ${exitCode} with empty stderr (stdout ${stdout.length} chars)${dbg}`);
      }
      resolve({ output: extractAgentOutput(stdout), exitCode, stderr, timedOut });
    });
    child.on('error', (err) => {
      cleanup();
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
    // Surface it: an unresolved harness and an agent that exits empty are otherwise
    // indistinguishable upstream (both → "invoke failed exit=1 empty=true").
    console.error(`[dbos-invoke] role=${role} resolveProject NULL — unknown harness slug=${harnessSlug} ws=${workspaceId ?? '(none)'}`);
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
/**
 * Resolve the harness's blueprint knobs from its git-canonical
 * `.papercusp/blueprint.yaml` (P-004 — the blueprint is authoritative for shape
 * knobs like debuggerThreshold; instance config still overrides). null when the
 * harness has no blueprint file. Fail-safe (any error → null → config/default).
 */
function harnessBlueprintKnobs(projectDir: string): Blueprint['knobs'] | null {
  try {
    const f = join(projectDir, '.papercusp', 'blueprint.yaml');
    return existsSync(f) ? loadBlueprintFromFile(f).blueprint.knobs : null;
  } catch {
    return null;
  }
}

/**
 * unify-agent-launches-as-blueprints D-001/D-003: the debugger is the degenerate
 * single-role launch DECLARED as the coding blueprint's reactive-before-worker
 * overlay role (`reactive: [{ role: debugger, when: { beforeRole: worker } }]`). So
 * the launched role is resolved from that declaration rather than a hardcoded
 * literal — a fork that swaps the reactive role (a different debugger persona) is
 * honored without code. Falls back to `'debugger'` (the coding default) when the
 * harness has no blueprint file or no before-worker reactive rule — behavior-
 * preserving for every harness on the coding fallback.
 */
export function pickReactiveBeforeWorkerRole(reactive: Blueprint['reactive']): string {
  return reactive.find((r) => r.when.beforeRole === 'worker')?.role ?? 'debugger';
}

function reactiveDebuggerRole(projectDir: string): string {
  try {
    const f = join(projectDir, '.papercusp', 'blueprint.yaml');
    if (!existsSync(f)) return 'debugger';
    return pickReactiveBeforeWorkerRole(loadBlueprintFromFile(f).blueprint.reactive);
  } catch {
    return 'debugger';
  }
}

/**
 * unify-agent-launches-as-blueprints P-007: the finalize recipe is the harness
 * blueprint's `gates.finalize` (`onDone`/`onEscalate`), resolved from its
 * git-canonical `.papercusp/blueprint.yaml` (extends merged). `undefined` when the
 * harness has no blueprint file or declares no finalize recipe → planFinalization
 * applies the DEFAULT_FINALIZE_RECIPE (the coding recipe), behavior-preserving for
 * every pre-blueprint harness. This is what makes finalization declarative: a `gym`
 * harness's `onDone: [committer]` is now HONORED (it was masked by the old hardcode).
 */
function harnessFinalizeRecipe(projectDir: string): FinalizeRecipe | undefined {
  try {
    const f = join(projectDir, '.papercusp', 'blueprint.yaml');
    if (!existsSync(f)) return undefined;
    const fin = loadBlueprintFromFile(f).blueprint.gates.finalize;
    return fin ? { onDone: fin.onDone, onEscalate: fin.onEscalate } : undefined;
  } catch {
    return undefined;
  }
}

const realDebuggerHook: PipelineDebuggerHook = async ({ harnessSlug, featureId, workspaceId }) => {
  const project = await resolveProject(harnessSlug, workspaceId);
  if (!project) return { fired: false };
  const projectDir = project.path;
  const stateDir = join(projectDir, '.papercusp');
  const ws = workspaceId ?? activeWorkspaceId();
  // Effective config from the blueprint (⊕ workspace-PG instance overrides), not
  // config.json (deprecate-harness-config-json-2026-06-06).
  const cfg = await readEffectiveHarnessConfig(harnessSlug, ws, projectDir);
  if (configGet<boolean>(cfg, 'debugger.enabled', true) !== true) return { fired: false };
  // P-004: the debugger threshold is a blueprint knob (knobs.debuggerThreshold);
  // instance config OVERRIDES it when explicitly set. Precedence:
  // config-explicit ?? blueprint ?? 3 — behavior-preserving (config-set wins as
  // before; unset → the blueprint's coding default 3 = the old hardcoded 3).
  const cfgThreshold = configGet<number | undefined>(cfg, 'debugger.threshold', undefined);
  const threshold = Number(cfgThreshold ?? harnessBlueprintKnobs(projectDir)?.debuggerThreshold ?? 3);

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
    // prompt's "read .papercusp/debug/<fid>.md" sees prior analysis and (b) a note
    // from an earlier run/process counts as "already debugged" without an
    // expensive re-run. A note on disk (this same epoch) also counts.
    const debugNotePath = join(stateDir, 'debug', `${featureId}.md`);
    const mat = await materializeFeatureDebugNote({ pg: pg as never, workspaceId: ws, harnessSlug, featureId, stateDir });
    const noteExists = mat.written || existsSync(debugNotePath);

    if (!debuggerGateDecision({ enabled: true, attempts, threshold, noteExists })) {
      return { fired: false };
    }

    const debugRole = reactiveDebuggerRole(projectDir);
    console.log(`[dbos-debugger] ${harnessSlug}/${featureId} starting role=${debugRole} (attempts=${attempts} ≥ ${threshold})`);
    const extraEnv = buildPipelineExtraEnv({ harnessSlug, workspaceId: ws });
    const r = await spawnInvokeOnce(projectDir, debugRole, [`FEATURE_ID=${featureId}`], extraEnv);
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
  const stateDir = join(projectDir, '.papercusp');
  const logDir = join(stateDir, 'logs');
  // Effective config from the blueprint (⊕ workspace-PG instance overrides), not
  // config.json (deprecate-harness-config-json-2026-06-06).
  const cfg = await readEffectiveHarnessConfig(harnessSlug, workspaceId ?? activeWorkspaceId(), projectDir);
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
    // P-007: the finalize roles come from the blueprint's gates.finalize (declarative),
    // defaulting to the coding recipe when the harness declares none.
    finalize: harnessFinalizeRecipe(projectDir),
  });

  if (plan.blocked) {
    console.log(
      `[dbos-finalize] DONE blocked for ${harnessSlug} (open needs-human plan item) — skipping curator/documenter`,
    );
    return;
  }

  // Unblocked DONE: close the status loop if the validator omitted its
  // validating→passed PG write (live on frame 138838461, 2026-06-09 — see
  // reconcileDoneStatus). Best-effort: a reconcile hiccup must not block the
  // curator/documenter finalization steps.
  if (outcome === 'done') {
    try {
      const { getLegacyClient } = await import('@papercusp/db-org');
      const flipped = await reconcileDoneStatus(harnessSlug, featureId, getLegacyClient(harnessSlug), (m) =>
        console.log(m),
      );
      if (flipped) {
        const { auditFeatureChange } = await import('../feature-audit');
        auditFeatureChange(harnessSlug, featureId, 'status', 'validating', 'passed', 'dbos-finalize');
      }
    } catch (e) {
      console.warn(`[dbos-finalize] status reconcile failed (non-fatal): ${(e as Error).message}`);
    }
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
          // P-004 (promote-spawn-child-harness): the parent-notification BUILTIN.
          // A per-harness hooks/afterDone.sh overrides it entirely (parity with
          // the retired run.sh builtin resolver); when no user hook ran, the TS
          // builtin posts a `Completion` message to this harness's sealed parent
          // once the feature queue drains — so a parent that spawn_child'ed this
          // harness learns its sub-work is done. Plugins fire regardless.
          const userHook = runHook('afterDone', {
            stateDir,
            projectDir,
            logDir,
            env: { TRIGGER: 'done', FEATURE_ID: featureId ?? '', PROJECT_DIR: projectDir, STATE_DIR: stateDir },
            log: (m) => console.log(`[dbos-finalize] ${m}`),
            harnessSlug,
            ...(workspaceId ? { workspaceId } : {}),
          });
          if (!userHook.ran) {
            const { notifyParentOnDone } = await import('./notify-parent-done');
            await notifyParentOnDone({
              harnessSlug,
              workspaceId: workspaceId ?? activeWorkspaceId(),
              ...(featureId && featureId !== '-' ? { featureId } : {}),
              log: (m) => console.log(`[dbos-finalize] ${m}`),
            });
          }
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
      const { expandGeneratorsForFeature } = await import('../agent-tools/plans/expand-generators');
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
/**
 * Real deps for the feature-passed → fork-PR handler (B3 / P-002). Each external
 * effect is lazily imported (the runner module is import-sensitive). The handler
 * logic + fork-mode gating is unit-tested via injected seams in
 * lib/harness/fork-pr-on-feature-pass.test.ts; these are the live wires.
 */
const realFeaturePassedDeps: FeaturePassedDeps = {
  loadSharedConfig: async ({ harnessSlug, workspaceId }) => {
    const project = await resolveProject(harnessSlug, workspaceId);
    if (!project) return null;
    const { loadSharedConfigFromProjectDir } = await import('../harness/load-shared-config');
    const cfg = loadSharedConfigFromProjectDir(project.path);
    return cfg
      ? { github_remote: cfg.github_remote, github_repository_id: cfg.github_repository_id }
      : null;
  },
  resolveRepoContext: async ({ harnessSlug, workspaceId }) => {
    const project = await resolveProject(harnessSlug, workspaceId);
    if (!project) return null;
    const { loadSharedConfigFromProjectDir } = await import('../harness/load-shared-config');
    const cfg = loadSharedConfigFromProjectDir(project.path);
    if (!cfg) return null;
    const { parseGithubUrl } = await import('../harness/clone-github');
    const parsed = parseGithubUrl(cfg.github_remote);
    if (!parsed) return null;
    const { resolveLocalGithubIdentity } = await import('../identity/resolve-local-github-identity');
    const id = await resolveLocalGithubIdentity();
    if (id.kind !== 'ok') return null;
    return {
      repoPath: project.path,
      baseBranch: 'main',
      token: id.token,
      upstreamOwner: parsed.owner,
      upstreamRepo: parsed.repo,
    };
  },
  getPermission: async ({ owner, repo }) => {
    const { getOctokit } = await import('../identity/octokit-client');
    const oc = await getOctokit();
    if (!oc) return 'none';
    try {
      const { data } = await oc.rest.repos.get({ owner, repo });
      const p = (data as {
        permissions?: { admin?: boolean; maintain?: boolean; push?: boolean; pull?: boolean };
      }).permissions;
      if (p?.admin) return 'admin';
      if (p?.maintain) return 'maintain';
      if (p?.push) return 'write';
      if (p?.pull) return 'read';
      return 'none';
    } catch {
      return 'none';
    }
  },
  ensureFeatureBranch: async ({ repoPath, featureBranch }) => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    // Move/create the feature branch to the current HEAD WITHOUT checking it out
    // (the integration HEAD holds the feature's committed work).
    await run('git', ['-C', repoPath, 'branch', '-f', featureBranch, 'HEAD']);
  },
  openForkPr: async (opts) => {
    const { openForkPr } = await import('../harness/open-fork-pr');
    return openForkPr(opts);
  },
  log: (msg) => console.error(msg),
};

export function wireOrchestratorInvokeRunner(): void {
  if (_wired) return;
  _wired = true;
  // RB-009: surface rate-limit-governor pauses to coord + the toast stream. Idempotent; the
  // governor is shared by the pipeline spawn, meridian calls, and the gym, so one init here
  // (on operator boot) covers them all.
  initAgentGovernorObserver();
  // cloud-deployment-layer Phase 7 (P-019/P-021): bridge the governor's per-account pause
  // signal into the account pool — record each account's rate state, and when an account is
  // SUSTAINEDLY limited, scale out onto a fresh account instead of only pausing. A no-op until
  // a process runs under PAPERCUSP_ACCOUNT_ID (i.e. account-keyed buckets exist).
  void import('../deployment/account-pool-store')
    .then(({ initAccountScaleObserver }) => initAccountScaleObserver())
    .catch((err) => console.error('[account-pool] observer init failed:', err));
  // RB-007: when PAPERCUSP_AGENT_GOVERNOR_PG=1, route the governor's rate+pause budget through a
  // PG-backed store so every operator process + the gym share ONE account budget (no co-burst).
  maybeInstallPgGovernorStore(setGovernorStore);
  // rate-limit-layer-v2 D-004: load the user's live fleet cap (maxSimultaneousAgents) + AIMD
  // floor from PG into the governor's global gate, and subscribe to live edits (no restart).
  void initRateLimitConfig().catch((err) => console.error('[rate-limit-config] init failed:', err));
  // rate-limit-layer-v2 D-002 (capture point 1): the meridian path reports per-call token usage
  // + any anthropic-ratelimit-* headers; persist each as a usage sample for the fleet read-model.
  setMeridianUsageSink((ev) => {
    const modelClass = modelClassOf(ev.model);
    void recordUsageHeaders(`anthropic:${modelClass}`, 'anthropic', modelClass, ev.headers ?? {}, {
      inputTokens: ev.inputTokens,
      outputTokens: ev.outputTokens,
      cacheReadTokens: ev.cacheReadTokens,
      cacheCreationTokens: ev.cacheCreationTokens,
      costUsd: ev.costUsd,
    });
  });
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
  // B3 (non-collaborator-join-fork-pr P-002): when a feature ships in FORK MODE
  // (the local identity lacks upstream write), push the feature branch to the
  // contributor's fork + open a cross-fork PR. No-op in owner/integration mode
  // and for non-shared harnesses. Best-effort (handleFeaturePassed never throws).
  setPipelineFeaturePassedHook(async (input) => {
    await handleFeaturePassed(input, realFeaturePassedDeps);
  });
  // G2 P-007: wire the real auditor spawn + escalation functions so the
  // orchestrator loop's audit lane can screen remote-pending features.
  wireAuditorLane();
}
