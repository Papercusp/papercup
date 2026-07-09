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
  configGet,
  resolvePhase,
  runHook,
  postCuratorOutputs,
  postArchiveEvent,
  captureDebuggerOutput,
  materializeFeatureDebugNote,
} from '@papercusp/orchestrator';
import { emitPipelineEvent } from '../events/pipeline-events';
import { firePluginLifecycle } from '../plugin-host-runtime';
import { readEffectiveHarnessConfig } from '../harness-effective-config';
import { loadBlueprintFromFile, type Blueprint } from '@papercusp/orchestrator/blueprint';
import { resolveProject } from '../harness-core';
import { activeWorkspaceId } from '../workspace-registry';
import { adminClientForHarness } from './admin-pg-cache';
import { harnessPackageDir } from '../harness-paths';
import { buildInvokeOnce } from '../harness-invoke-once';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import {
  setPipelineInvokeRunner,
  setPipelineFinalizer,
  setPipelineSettledHook,
  setPipelineDebuggerHook,
  setPipelineFeaturePassedHook,
  setPipelineTestDigestHook,
  setPipelineLeaseHeartbeatHook,
  type PipelineInvokeRunner,
  type PipelineFinalizer,
  type PipelineDebuggerHook,
  type PipelineTestDigestHook,
} from './orchestrator-workflow';
import { heartbeatClaim } from '../work-item-claims';
import { digestTestOutput } from './pre-validator-test-digest';
import { saveTextArtifact } from '../text-artifacts';
import { handleFeaturePassed, type FeaturePassedDeps } from '../harness/fork-pr-on-feature-pass';
import {
  planFinalization,
  needsHumanGateUrl,
  reconcileDoneStatus,
  parseAcceptanceVerdict,
  type FinalizeRecipe,
  type ReconcileDbClient,
} from './orchestrator-finalize';
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
  setStatelessUsageSink,
  modelClassOf,
} from '@papercusp/papercusp-shared/agent';
import { resolveSpawnBackendModel } from '../harness-invoke-once';
import { initAgentGovernorObserver } from '../agent-governor-observer';
import { maybeInstallPgGovernorStore } from '../agent-governor-pg-store';
import { initRateLimitConfig } from '../rate-limit-config';
import { recordUsageHeaders } from '../agent-usage-telemetry';
import { buildIsolatedScopeArgv, SCOPE_LAUNCH_FAILURE_RE } from '../systemd-scope';

// Audit P-015 (EI-172): read these env knobs LAZILY, per spawn — as module-init
// consts they froze at first import, so setting/changing the env after host boot
// (or per test case) was silently ignored. Exported for unit testing.
// Default 2700000ms (45 min) to support improvement workers (implementTimeoutMs
// defaults to 45 min; D-010). Prior default 600000ms (10 min) was insufficient.
export const invokeTimeoutMs = (): number =>
  Number(process.env.PAPERCUSP_DBOS_INVOKE_TIMEOUT_MS ?? 2_700_000);
// How long an orchestrator spawn will wait on a shared rate-limit pause before giving up
// (the director re-tries later). Unattended → wait generously, but bounded.
export const governorMaxWaitMs = (): number =>
  Number(process.env.PAPERCUSP_AGENT_GOVERNOR_MAX_WAIT_MS ?? 1_800_000);

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
 * D-007 (shared-hive-loop-e2e-testing) fail-open wrapper for the pipeline's
 * lease-heartbeat hook: run the heartbeat and pass its `{renewed,reason}` through,
 * but map ANY throw to `renewed:true` — a transient PG/authority error must NEVER
 * make a live pipeline self-abort (the next turn re-checks; completion-adoption
 * rule 2 is the backstop for an un-aborted zombie). Exported so the contract is
 * unit-tested directly (the `real*` hooks themselves do I/O and are integration-only).
 */
export async function leaseHeartbeatFailOpen(
  run: () => Promise<{ renewed: boolean; reason?: string }>,
): Promise<{ renewed: boolean; reason?: string }> {
  try {
    return await run();
  } catch (e) {
    return { renewed: true, reason: `heartbeat-error-fail-open: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Max chars of child stderr to surface on a failed invoke (P-005). */
const STDERR_SURFACE_LIMIT = 4000;
/** Max chars of raw child stdout to carry across the invoke boundary for diagnostics. */
export const RAW_STDOUT_TAIL_LIMIT = 2000;

export interface SpawnInvokeOnceResult {
  output: string;
  exitCode: number;
  stderr: string;
  timedOut?: boolean;
  /**
   * Bounded, unfiltered stdout tail from the child process. `output` strips
   * timestamp/log transport lines for normal action parsing; this keeps the
   * exact CLI failure text available when an agent exits before emitting a turn.
   */
  rawStdoutTail?: string;
}

function rawStdoutTail(stdout: string): string {
  return stdout.length > RAW_STDOUT_TAIL_LIMIT ? stdout.slice(-RAW_STDOUT_TAIL_LIMIT) : stdout;
}

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
 * (curator/documenter), the operator nursery (`cup:spawn`), and the coord-program
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
 *     (routine fires, launch-blueprints, `cup:spawn`) are wrapped in a durable,
 *     idempotency-keyed DBOS step so a crash re-runs them once (P-010); INTERACTIVE
 *     `psu` is NOT made durable — a human is the durability, and auto-retrying their
 *     session would be wrong — but it STILL passes admission + the safety floor.
 *
 * ── What this chokepoint does NOT own: model-turn retry (D-005) ──
 *   The model-turn rate-limit retry (`runWithRetry`/`runAgentTurn`) is a SEPARATE
 *   layer that wraps our IN-PROCESS `anthropic-direct` calls. It physically CANNOT reach
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
  /** `onChildPid`: fired once with the child OS pid right after spawn (EI-85) —
   *  the caller records it on the nursery row so the reclaim sweep can liveness-
   *  check the process instead of blindly reclaiming a stale-heartbeat row. */
  opts?: {
    signal?: AbortSignal;
    timeoutMs?: number;
    resultPath?: string;
    forceSessionId?: string;
    onChildPid?: (pid: number) => void;
    /** Fired on EVERY stdout/stderr chunk the child emits (liveness-hardening
     *  P-008) — the in-process mid-turn signal. The caller throttles (the
     *  spawn engine folds it into the nursery heartbeat tick); this layer
     *  just reports. Best-effort: a throwing callback is ignored. */
    onOutputActivity?: () => void;
  },
): Promise<SpawnInvokeOnceResult> {
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
  // EI-286 leg (b): pin the child's MCP config to THIS host. spawn-mcp resolves
  // its operator URL as PAPERCUSP_OPERATOR_URL ?? :3070/:3055 — and the child
  // INHERITS the host process env (buildInvokeOnce spreads process.env), where
  // .env.local sets PAPERCUSP_OPERATOR_URL=:3070. So agents spawned by the
  // staging host (:3170) handshook the GREEN host's MCP: wrong code version,
  // wrong role catalog (P-071 smoke: four consecutive Queen launches saw no
  // placement tools). The host's own env value is the HOST's config, not a
  // per-child directive — when this host knows its serving port it OVERRIDES
  // the inherited value so children always talk to their spawner. An explicit
  // caller pin (extraEnv) still wins.
  if (!resolvedExtraEnv.PAPERCUSP_OPERATOR_URL && process.env.PAPERCUSP_HONO_PORT) {
    resolvedExtraEnv = {
      ...resolvedExtraEnv,
      PAPERCUSP_OPERATOR_URL: `http://127.0.0.1:${process.env.PAPERCUSP_HONO_PORT}/api/mcp`,
    };
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

  // B-18 fleet cutover (agent-capability-confinement P-020): resolve the
  // papercusp-fleet-capability-only flag PER-SPAWN and thread it to the
  // invoke-once child as PAPERCUSP_FLEET_CAPABILITY_ONLY. invoke()/claudeMcpArgs
  // (which runs in that child) reads it to drop native write/exec/fetch tools
  // from a confined role's --allowed-tools and route them to the gated
  // capability:* tools. DEFAULT-OFF (getFlag falls back to FLAG_DEFAULTS=false on
  // any PostHog miss, and a thrown lookup degrades to off) — so a flag hiccup can
  // never silently confine the fleet; the owner's flip is the only thing that arms it.
  try {
    if (await getFlag(FLAGS.FLEET_CAPABILITY_ONLY, 'system')) {
      resolvedExtraEnv = { ...resolvedExtraEnv, PAPERCUSP_FLEET_CAPABILITY_ONLY: '1' };
    }
  } catch {
    /* flag lookup failure ⇒ cutover stays off (current behavior) */
  }

  // domain-generic-agent-personas-2026-06-17 P-013: resolve the papercusp-replace-claude-base
  // flag PER-SPAWN and thread it to the invoke-once child as PAPERCUSP_REPLACE_CLAUDE_BASE.
  // invoke() reads it (replaceClaudeBaseEnabled) to REPLACE the Claude coding base with our
  // neutral preamble (+ blueprint overlay) via --system-prompt-file; the assembled prompt
  // still rides stdin. DEFAULT-OFF (getFlag falls back to FLAG_DEFAULTS=false on a PostHog
  // miss; a thrown lookup degrades to off) — so a flag hiccup can never silently swap the
  // fleet's base; the owner's post-smoke flip is the only thing that arms it.
  try {
    if (await getFlag(FLAGS.REPLACE_CLAUDE_BASE, 'system')) {
      resolvedExtraEnv = { ...resolvedExtraEnv, PAPERCUSP_REPLACE_CLAUDE_BASE: '1' };
    }
  } catch {
    /* flag lookup failure ⇒ replace-base stays off (Claude default stands) */
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

    // RB-012 / EI-86: the SHARED governor that paces + tracks this spawn's account budget.
    // Key the bucket to the backend+model the spawn ACTUALLY uses (the default `omp -p`
    // self-paces → its own concurrency-only bucket; claude → the Anthropic per-class bucket)
    // rather than the old hardcoded `('claude-code','')` which mis-bucketed everything.
    // P-019: on a frame launched under a bound account, key the bucket to that account so its
    // separate subscription tracks its separate rate limits (and its pauses carry the account
    // id, driving the Queen's scale-out). Unset locally ⇒ the global bucket.
    // PAPERCUSP_SPAWN_MODEL / _BACKEND (per-spawn escalation) shift the child onto a
    // different model class or CLI — key the bucket to what it ACTUALLY runs.
    const { backend, model } = resolveSpawnBackendModel(
      role, extraEnv.PAPERCUSP_SPAWN_MODEL, extraEnv.PAPERCUSP_SPAWN_BACKEND,
    );
    // account-aware-rate-governor-routing Phase 1: prefer the PER-SPAWN selected account (set in
    // `extraEnv.PAPERCUSP_ACCOUNT_ID` by operator-spawn's selectSpawnAccount) over the parent
    // operator's process env. A bee spawned from the MAIN operator has no PAPERCUSP_ACCOUNT_ID in
    // process.env, so this used to fall onto the account-BLIND global `anthropic:opus` bucket — and
    // one account's 429 then paused that bucket fleet-wide, the bee waited past maxWait, and failed
    // ("rate-limit pause exceeded max wait") even with six idle accounts. Keying per-account makes an
    // available account's bucket admit; the class only blocks when EVERY account is genuinely tapped.
    const gov = governorForBackend(
      backend,
      model,
      undefined,
      extraEnv.PAPERCUSP_ACCOUNT_ID || process.env.PAPERCUSP_ACCOUNT_ID || undefined,
    );
    // The back-edge EI-86 closes: classify the child's outcome and, on an account-wide stop
    // (429 / overload / usage-cap), PENALIZE the shared governor so the AIMD + the rate
    // read-model react to the DOMINANT (spawned claude-CLI) traffic class — not just the
    // in-process anthropic-direct lane. The claude/codex CLIs print these to STDOUT, so
    // classifyTurnError folds it in on a failed exit. This feedback is ALWAYS-ON: pacing
    // (acquire, below) is opt-in, but without the penalize back-edge the governor stays blind
    // to bee 429s, buckets read green while the account chokes, and the AIMD never engages.
    // A usage_limit carries its reset, so the fleet parks until reset (D-001). No retry here —
    // the director owns turn-retries (avoid double-retry).
    const feedGovernor = (inner: { output: string; exitCode: number; stderr: string }): void => {
      const te = classifyTurnError(backend, { exitCode: inner.exitCode, signal: null, stderr: inner.stderr, stdout: inner.output });
      if (isAccountWide(te.class)) gov.penalize({ retryAfterMs: te.retryAfterMs, resetAt: te.resetAt });
    };

    // PACING is opt-in (PAPERCUSP_AGENT_GOVERNOR=1, default OFF → unchanged): when enabled,
    // gate the spawn through the governor's concurrency/rate budget on top of the always-on
    // feedback, so the whole operator's agent spawns stay under the account's rate limit.
    if (process.env.PAPERCUSP_AGENT_GOVERNOR === '1') {
      const release = await gov.acquire({}, { maxWaitMs: governorMaxWaitMs() });
      if (!release) {
        // The per-account spawn-admission bucket is paused past maxWait. DON'T fail the spawn $0 when the
        // inference gateway owns egress: it does per-account failover + internal retry, so the bee reaches a
        // HEALTHY account anyway (the owner's "route around a paused account, don't fail with headroom" — the
        // spawn-side per-account gate must not veto what the gateway can serve; otherwise a single account's
        // pause kills spawns with five idle accounts). The gateway's admission queue + pacing still bound
        // egress. Only with NO gateway egress (no failover safety net) is the hard $0 fail correct.
        const gatewayEgress = !!(extraEnv.ANTHROPIC_BASE_URL ?? process.env.ANTHROPIC_BASE_URL);
        if (!gatewayEgress) {
          return { output: '', exitCode: 1, stderr: 'agent governor: rate-limit pause exceeded max wait', rawStdoutTail: '' };
        }
        console.warn(`[dbos-invoke] role=${role} spawn-governor bucket paced past maxWait → proceeding via inference-gateway failover`);
        const inner = await runChild(command, args, projectDir, env, role, opts?.signal, opts?.timeoutMs, opts?.onChildPid, opts?.onOutputActivity);
        feedGovernor(inner);
        return inner;
      }
      try {
        const inner = await runChild(command, args, projectDir, env, role, opts?.signal, opts?.timeoutMs, opts?.onChildPid, opts?.onOutputActivity);
        feedGovernor(inner);
        return inner;
      } finally {
        release();
      }
    }
    // Pacing off (the default): run directly, but STILL feed the child's 429/overload back into
    // the shared governor (EI-86). The await happens here (inside the try) so the display
    // lease's finally releases AFTER the child exits, not when the promise is handed back.
    const inner = await runChild(command, args, projectDir, env, role, opts?.signal, opts?.timeoutMs, opts?.onChildPid, opts?.onOutputActivity);
    feedGovernor(inner);
    return inner;
  } finally {
    displayLease?.release();
  }
}

type AdminPgClient = ReturnType<typeof adminClientForHarness>;

function toPostgresPlaceholders(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function reconcileClientFromPostgres(pg: AdminPgClient): ReconcileDbClient {
  return {
    prepare: (sql: string) => {
      const query = toPostgresPlaceholders(sql);
      return {
        get: async (...params: unknown[]) => {
          const rows = (await pg.unsafe(query, params as never[])) as unknown[];
          return rows[0];
        },
        run: async (...params: unknown[]) => {
          await pg.unsafe(query, params as never[]);
        },
      };
    },
  };
}

/** SIGKILL grace after the SIGTERM on abort/timeout — gives the child a moment
 *  to flush + exit cleanly before we hard-kill. */
const KILL_GRACE_MS = 2_000;

/** Per-agent-turn memory cap (GiB) for the isolated spawn scope (systemd-run --user
 *  --scope). Sized generously above a single CLI turn's real working set — the point
 *  isn't to squeeze the turn but to keep a runaway/leaking agent's OOM inside ITS OWN
 *  cgroup, away from the launching host's cage (WI-1499: bg-host-agent-spawn-scope-
 *  isolation-2026-07-02). Override: PAPERCUSP_AGENT_SPAWN_MEMORY_MAX_G. */
function agentSpawnScopeMemoryMaxG(): number {
  const raw = Number(process.env.PAPERCUSP_AGENT_SPAWN_MEMORY_MAX_G);
  return Number.isFinite(raw) && raw > 0 ? raw : 6;
}

/** Isolation kill-switch (peer of release-actions.ts's PAPERCUSP_CHECKPOINT_SCOPE):
 *  PAPERCUSP_AGENT_SPAWN_SCOPE=0 forces the pre-hardening same-cgroup spawn (ops
 *  escape hatch). Linux-only — systemd-run has no analog elsewhere, and every
 *  deployment target for this operator is Linux hosts (dev box + prod). */
function agentSpawnScopeEnabled(): boolean {
  return process.platform === 'linux' && process.env.PAPERCUSP_AGENT_SPAWN_SCOPE !== '0';
}

/** The raw subprocess spawn + timeout-kill + stdout/stderr capture (never rejects).
 *
 * WI-1499: every bee/queen turn is spawned inside its own transient systemd user
 * SCOPE (own cgroup, per-agent MemoryMax) — see `buildIsolatedScopeArgv`. Before this,
 * every agent child ran inside papercup-bg-host.service's OWN cgroup, so a bg-host
 * restart or OOM (systemd's default KillMode=control-group) killed every in-flight
 * bee/queen turn along with it, reclaiming them at the next boot reconcile even
 * though nothing about THEIR work actually failed. Scope-isolating them means a
 * bg-host restart no longer touches their cgroup, so they simply keep running —
 * `reconcileSpawnAdmissionOnBoot` (spawn-reclaim.ts) re-attaches to them instead of
 * reclaiming. `--scope` (not `--unit`, mirroring release-actions.ts's precedent):
 * the payload stays OUR CHILD — piped stdio, full env inheritance, and the existing
 * pgid tree-kill below still covers it (systemd-run remains the process-group
 * leader; the payload inherits its pgid). On a SCOPE LAUNCH failure (no user bus,
 * no systemd-run binary, …) this retries DIRECT once, exactly like
 * release-actions.ts's runScript, so a box without a reachable user bus degrades to
 * the pre-hardening behavior instead of failing every agent turn outright. */
function runChild(
  command: string,
  args: string[],
  projectDir: string,
  env: NodeJS.ProcessEnv,
  role: string,
  signal?: AbortSignal,
  timeoutMs?: number,
  onChildPid?: (pid: number) => void,
  onOutputActivity?: () => void,
  useScope: boolean = agentSpawnScopeEnabled(),
): Promise<SpawnInvokeOnceResult> {
  return new Promise((resolve) => {
    // Already-aborted before we spawn → don't launch at all.
    if (signal?.aborted) {
      resolve({ output: '', exitCode: 1, stderr: 'aborted before start', rawStdoutTail: '' });
      return;
    }
    let timedOut = false;
    const launchedAt = Date.now();
    const [spawnCommand, ...spawnArgs] = useScope
      ? buildIsolatedScopeArgv([command, ...args], agentSpawnScopeMemoryMaxG())
      : [command, ...args];
    // `detached: true` puts the child in its OWN process group so we can reap the
    // WHOLE tree on abort/timeout, not just the immediate child. In dev the spawn is
    // `node <tsx-cli> invoke-once.ts`, and the tsx CLI forks a worker (invoke-once,
    // which spawns the agent) — a single-PID kill hits only the wrapper and orphans
    // the agent (EI-40). Group-kill (`process.kill(-pid)`) takes out wrapper +
    // invoke-once + agent together (and, under the scope wrapper, systemd-run +
    // that same tree — it inherits the group's pgid). The new group is the child's
    // alone, so it can never signal the operator host (a different group).
    const child = spawn(spawnCommand, spawnArgs, { cwd: projectDir, env, detached: true });
    // EI-85: surface the child OS pid so the caller can record it on the nursery
    // row — the reclaim sweep liveness-checks /proc/<pid> rather than blindly
    // reclaiming a stale-heartbeat row whose child is actually still alive. Under
    // the scope wrapper this is systemd-run's own pid (the group leader), which is
    // exactly the pid the pgid tree-kill needs and whose /proc/<pid>/cmdline still
    // carries the wrapped invoke-once argv (isSpawnProcessAlive's 'invoke-once'
    // substring check keeps working unmodified).
    if (child.pid != null) {
      try { onChildPid?.(child.pid); } catch { /* recording is best-effort */ }
    }
    let stdout = '';
    let stderr = '';
    let killGrace: ReturnType<typeof setTimeout> | null = null;
    let aborted = false;
    let settled = false;
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
    }, timeoutMs ?? invokeTimeoutMs());
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
    // P-008: every emitted chunk is the mid-turn signal — stderr counts too
    // (some backends log progress there while stdout buffers).
    const reportActivity = () => { try { onOutputActivity?.(); } catch { /* best-effort */ } };
    child.stdout?.on('data', (d) => { reportActivity(); stdout += String(d); });
    child.stderr?.on('data', (d) => { reportActivity(); stderr += String(d); });
    // Scope-launch failure (fast systemd-run exit with a launch-shaped stderr, before
    // any real agent turn could plausibly have run) → retry DIRECT once, exactly like
    // release-actions.ts's runScript, so a box without a reachable user bus degrades
    // to the pre-hardening same-cgroup spawn instead of failing the agent turn.
    const isScopeLaunchFailure = (code: number | null): boolean =>
      useScope &&
      !aborted &&
      !timedOut &&
      code !== 0 &&
      Date.now() - launchedAt < 5_000 &&
      SCOPE_LAUNCH_FAILURE_RE.test(stderr);
    child.on('close', (code) => {
      cleanup();
      if (settled) return;
      if (isScopeLaunchFailure(code)) {
        settled = true;
        resolve(runChild(command, args, projectDir, env, role, signal, timeoutMs, onChildPid, onOutputActivity, false));
        return;
      }
      settled = true;
      // A child we aborted may exit 0 (it caught SIGTERM and shut down) or via the
      // signal — normalize to a non-zero "aborted" outcome so callers don't read a
      // cancelled run as a clean success.
      if (aborted) {
        resolve({
          output: extractAgentOutput(stdout),
          exitCode: 1,
          stderr: stderr.trim() || 'aborted (fleet:cancel)',
          rawStdoutTail: rawStdoutTail(stdout),
        });
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
      } else if (stderr.trim()) {
        // Exit 0 with non-empty stderr: surface it so the operator log shows why
        // the bee vanished (e.g. "You've hit your session limit"). Without this,
        // exit-0 runs are completely silent even when the stderr carries the cause.
        const stderrHead = stderr.trim().slice(0, 500);
        console.warn(`[dbos-invoke] role=${role} exited 0 with stderr (${stderr.length} chars): ${stderrHead}`);
      }
      resolve({ output: extractAgentOutput(stdout), exitCode, stderr, timedOut, rawStdoutTail: rawStdoutTail(stdout) });
    });
    child.on('error', (err) => {
      cleanup();
      if (settled) return;
      if (useScope && !aborted) {
        settled = true;
        resolve(runChild(command, args, projectDir, env, role, signal, timeoutMs, onChildPid, onOutputActivity, false));
        return;
      }
      settled = true;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[dbos-invoke] role=${role} spawn error: ${msg}`);
      resolve({ output: '', exitCode: 1, stderr: msg, rawStdoutTail: rawStdoutTail(stdout) });
    });
  });
}

const realRunner: PipelineInvokeRunner = async (harnessSlug, role, featureId, idempotencyKey, extras, workspaceId) => {
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
  // P-004 (plugin-system-hive-port D-003): spine step transitions are event
  // emissions — `pipeline:step-start` / `pipeline:step-done` serve reaction
  // rules + events:await + UI in one fire. This runner executes INSIDE a
  // checkpointed DBOS step, so a workflow replay does not re-emit for
  // completed role runs. (These supersede the bash-era pre-/post-role hook
  // points lost in the DBOS migration — known-hooks.ts EI-95 backlog.)
  emitPipelineEvent({
    name: 'step-start', harnessSlug, featureId, role, runId,
    ...(workspaceId ? { workspaceId } : {}),
  });
  // Brief 15 (worker-chunk-loop-operator-hosted-2026-06-14 P-010 / D-006): when the
  // staged-rollout flag is ON *and* this harness has opted in, run the coding worker
  // turn as the operator-hosted `worker:chunk-loop` op (the same `runWorkerChunkLoop`)
  // instead of the subprocess. Behavior-identical for ROUTING — the op makes the same
  // feature/repo state changes and the director re-decides from state next turn (the
  // workflow discards a dispatch result). TWO gates so the dark-launch is a single
  // NON-CRITICAL harness, never a workspace-wide blind cutover: the flag's stored
  // override is workspace-scoped, so the flag is the master kill-switch and the
  // per-harness `workerChunkLoop` config knob is the cohort. DARK by default (flag
  // default-OFF, D-003) ⇒ the else-branch below is byte-identical to today.
  let useWorkerOp = false;
  if (role === 'worker') {
    const flagEnabled = await getFlag(FLAGS.WORKER_CHUNK_LOOP_BLUEPRINT, `harness:${harnessSlug}`);
    if (flagEnabled) {
      const ws = workspaceId ?? activeWorkspaceId();
      const cfg = await readEffectiveHarnessConfig(
        harnessSlug,
        ws,
        project.path,
      );
      const cohortPercent = configGet<number | string>(
        cfg,
        'workerChunkLoopCohortPercent',
        configGet<number | string>(cfg, 'workerModeCohortPercent', 100),
      );
      useWorkerOp = useWorkerChunkLoopOp({
        role,
        flagEnabled,
        harnessOptIn: configGet<boolean>(cfg, 'workerChunkLoop', false) === true,
        cohortPercent,
        cohortKey: `${ws}:${harnessSlug}:${featureId}`,
      });
    }
  }
  const startedAt = Date.now();
  // HARNESS_SLUG = the registry slug (not basename(project.path)) so invoke-once's
  // pg-bootstrap resolves harness_<slug> correctly; PAPERCUSP_WORKSPACE_ID pins the
  // agent's feature reads to the pipeline's captured workspace.
  const result = useWorkerOp
    ? await runWorkerChunkLoopOpResult(harnessSlug, featureId, workspaceId)
    : await spawnInvokeOnce(
        project.path,
        role,
        extras,
        buildPipelineExtraEnv({ harnessSlug, idempotencyKey, workspaceId }),
      );
  const durationMs = Date.now() - startedAt;
  if (runId) {
    void emitAgentRunCompleted(harnessSlug, runId, { role, durationMs });
    if (role === 'worker') {
      void emitFeatureWorkedEnd(harnessSlug, runId, {
        outcome: result.exitCode === 0 ? 'completed' : 'failed',
      });
    }
  }
  emitPipelineEvent({
    name: 'step-done', harnessSlug, featureId, role, runId,
    exitCode: result.exitCode, durationMs,
    ...(workspaceId ? { workspaceId } : {}),
  });
  return result;
};

/**
 * Pure routing guard (Brief 15, worker-chunk-loop-operator-hosted-2026-06-14
 * P-010 / D-006), mirroring `debuggerGateDecision`'s pure-guard pattern: route a
 * coding WORKER dispatch to the operator-hosted `worker:chunk-loop` op iff BOTH the
 * workspace master flag is on AND this harness opted in. Two gates because the
 * flag's stored override is workspace-scoped — without the per-harness opt-in one
 * flip would route EVERY coding harness (incl. critical ones) through the op, the
 * blind cutover the staged rollout forbids. Exported for unit testing.
 */
export function useWorkerChunkLoopOp(input: {
  role: string;
  flagEnabled: boolean;
  harnessOptIn: boolean;
  cohortPercent?: number | string | null;
  cohortKey?: string | null;
}): boolean {
  if (input.role !== 'worker' || !input.flagEnabled || !input.harnessOptIn) return false;
  const percent = workerChunkLoopCohortPercent(input.cohortPercent);
  if (percent <= 0) return false;
  if (percent >= 100) return true;
  return workerChunkLoopCohortBucket(input.cohortKey ?? '') < percent;
}

/**
 * Clamp rollout config into a percentage. Omitted preserves the legacy
 * workerChunkLoop:true behavior: an opted-in harness routes 100% of worker turns.
 */
export function workerChunkLoopCohortPercent(raw: number | string | null | undefined): number {
  if (raw == null || raw === '') return 100;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.floor(n)));
}

/**
 * Stable 0..99 bucket for feature-level cohorting. FNV-1a keeps this dependency-free
 * and deterministic across processes/retries.
 */
export function workerChunkLoopCohortBucket(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 100;
}

/**
 * Run one coding worker turn as the operator-hosted `worker:chunk-loop` op instead
 * of the subprocess (Brief 15). Builds a CoordOpCtx + invokes the op — which ports
 * `runWorkerChunkLoop` operator-side and governs the run as a unit (D-002/D-006) —
 * then maps the bound `ChunkLoopOutcome` into the `PipelineInvokeRunner`'s
 * `{ output, exitCode }`. The workflow DISCARDS a dispatch result, so the director
 * re-decides from feature state next turn; `exitCode 0` means the loop RAN (an
 * escalate/abort is a feature-state outcome, not a crash). The op + ctx modules are
 * dynamic-imported so this runner stays test-light — the heavy operator-side ctx
 * construction loads only when the dark path actually fires.
 */
async function runWorkerChunkLoopOpResult(
  harnessSlug: string,
  featureId: string,
  workspaceId: string | undefined,
): Promise<{ output: string; exitCode: number }> {
  const { workerChunkLoopOp } = await import('../blueprint-steps/ops/worker-chunk-loop.js');
  const { buildCoordOpCtx } = await import('../coord-ops/prod-caps.js');
  const ctx = buildCoordOpCtx({
    harnessSlug,
    workspaceId: workspaceId ?? activeWorkspaceId(),
    identity: { ownerId: `orchestrator:${harnessSlug}`, ownerLabel: 'coding-director' },
  });
  const res = await workerChunkLoopOp.run({ featureId }, ctx);
  const detail =
    res.outcome === 'completed'
      ? ` (${res.chunksCommitted ?? 0} committed)`
      : res.outcome === 'escalated'
        ? ` (chunk ${res.escalatedChunkId ?? '?'}, ${res.strikes ?? 0} strikes)`
        : res.reason ?? res.error
          ? ` (${res.reason ?? res.error})`
          : '';
  return { output: `worker:chunk-loop ${featureId} → ${res.outcome}${detail}`, exitCode: 0 };
}

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

/**
 * The harness blueprint's `acceptance.kind` (hive-blueprint-generalization P-009),
 * read from `.papercusp/blueprint.yaml`. Undefined for a pre-blueprint / coding harness
 * (which declares no `acceptance`), so the finalizer's acceptance gate is a no-op there —
 * behavior-preserving, exactly like harnessFinalizeRecipe.
 */
function harnessAcceptanceKind(projectDir: string): 'tests' | 'judge' | 'human-gate' | 'none' | undefined {
  try {
    const f = join(projectDir, '.papercusp', 'blueprint.yaml');
    if (!existsSync(f)) return undefined;
    return loadBlueprintFromFile(f).blueprint.acceptance?.kind;
  } catch {
    return undefined;
  }
}

/**
 * The harness blueprint's `output.kind` (hive-blueprint-generalization P-010), read from
 * `.papercusp/blueprint.yaml`. Undefined for a pre-blueprint / coding harness (⇒ repo-commit
 * default, no OUTPUT_KIND extra), so the finalizer is behavior-preserving there.
 */
function harnessOutputKind(
  projectDir: string,
): 'repo-commit' | 'artifacts' | 'external-action' | 'work-item-payload' | undefined {
  try {
    const f = join(projectDir, '.papercusp', 'blueprint.yaml');
    if (!existsSync(f)) return undefined;
    return loadBlueprintFromFile(f).blueprint.output?.kind;
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

  // Audit P-036: the debugger gate runs on every pipeline invocation past the
  // attempt threshold — opening a fresh pool each time burned a connection slot +
  // startup round-trips per spawn. Reuse the shared admin-client LRU instead (one
  // client per (url, harness), shared with the orchestrator dispatch loop).
  const pg = adminClientForHarness(harnessSlug);
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
  }
  // No pg.end() here — the client is cached per harness (P-036).
};

/**
 * Pre-validator test-digest hook (token-usage-reduction-audit-2026-06-09
 * P-010). Runs the harness's `knobs.testCommand` once, deterministically,
 * digests the result (pre-validator-test-digest.ts), saves it as the
 * PG-canonical text artifact `.papercusp/test-digest/<feature>.md` (disk-
 * mirrored where the validator reads it), and returns a `TEST_DIGEST=…`
 * runtime-context extra for the validator spawn. Best-effort everywhere: no
 * testCommand → no extra; a hook error never blocks the validator.
 */
const TEST_DIGEST_TIMEOUT_MS = 10 * 60 * 1000;
const realTestDigestHook: PipelineTestDigestHook = async ({ harnessSlug, featureId, workspaceId }) => {
  try {
    const project = await resolveProject(harnessSlug, workspaceId);
    if (!project) return { extras: [] };
    const projectDir = project.path;
    const ws = workspaceId ?? activeWorkspaceId();
    const cfg = await readEffectiveHarnessConfig(harnessSlug, ws, projectDir);
    const testCommand =
      configGet<string | undefined>(cfg, 'testCommand', undefined) ??
      harnessBlueprintKnobs(projectDir)?.testCommand;
    if (!testCommand || !testCommand.trim()) return { extras: [] };

    console.log(`[dbos-test-digest] ${harnessSlug}/${featureId} running: ${testCommand}`);
    const started = Date.now();
    const run = spawnSync('bash', ['-lc', testCommand], {
      cwd: projectDir,
      timeout: TEST_DIGEST_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
      env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
    });
    const durationMs = Date.now() - started;
    const exitCode = run.status ?? (run.signal ? 124 : 1);
    const raw = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
    const { summary, body } = digestTestOutput(raw, exitCode, testCommand);

    const relPath = `test-digest/${featureId}.md`;
    await saveTextArtifact(
      harnessSlug,
      relPath,
      `${body}\n\n- Duration: ${Math.round(durationMs / 1000)}s\n- Generated: ${new Date().toISOString()} (pre-validator, run once per validation round)\n`,
    );
    console.log(
      `[dbos-test-digest] ${harnessSlug}/${featureId} exit=${exitCode} in ${Math.round(durationMs / 1000)}s — ${summary}`,
    );
    return {
      extras: [
        `TEST_DIGEST=.papercusp/${relPath} (exit=${exitCode}; ${summary}) — pre-digested full-suite result; read it INSTEAD of re-running the whole suite`,
      ],
    };
  } catch (err) {
    console.warn(
      `[dbos-test-digest] ${harnessSlug}/${featureId} non-fatal:`,
      err instanceof Error ? err.message : err,
    );
    return { extras: [] };
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
    // hive-blueprint-generalization P-009: the acceptance model gates DONE — undefined for
    // a coding/pre-blueprint harness, so this is a no-op there (behavior-preserving).
    acceptanceKind: harnessAcceptanceKind(projectDir),
    // P-010: the output sink — undefined/repo-commit for a coding harness ⇒ no change.
    outputKind: harnessOutputKind(projectDir),
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
      const pg = adminClientForHarness(harnessSlug);
      const flipped = await reconcileDoneStatus(harnessSlug, featureId, reconcileClientFromPostgres(pg), (m) =>
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
        // P-009 acceptance gate: a judge step whose verdict is `revise` HARD-BLOCKS the
        // rest of the finalize recipe (onDone — artifacts:save / documenter), so a
        // deliverable that fails the rubric is NOT published. The work item is left
        // non-terminal for the Queen to re-place; a `pass` (or a fail-open missing
        // marker) falls through to the output recipe unchanged. Only fires for a
        // judge-acceptance hive (the step carries acceptanceGate); coding is untouched.
        if (step.acceptanceGate && parseAcceptanceVerdict(r.output) === 'revise') {
          console.warn(
            `[dbos-finalize] acceptance gate: ${step.role} returned REVISE for ${featureId} — blocking the output recipe (deliverable not published); left for re-placement`,
          );
          emitPipelineEvent({
            name: 'escalate',
            harnessSlug,
            featureId: featureId ?? '-',
            reason: `acceptance: judge verdict REVISE — ${featureId} needs revision before its deliverable is published`,
            ...(workspaceId ? { workspaceId } : {}),
          });
          break;
        }
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
          // P-004: the terminal transition is an event emission (reaction rules +
          // events:await + UI in one fire). Inside the checkpointed finalize step.
          emitPipelineEvent({
            name: 'escalate', harnessSlug, featureId: featureId ?? '-',
            ...(reason ? { reason } : {}), ...(workspaceId ? { workspaceId } : {}),
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
          // P-006 (plugin-system-hive-port D-003): the deprecated `firePluginHook`
          // shell-out (per-plugin child process via the papercusp-fire-hook CLI)
          // is replaced by the in-process typed fire — `afterDone` is one of the
          // FROZEN legacy fire-points D-003 keeps for back-compat. Best-effort:
          // a plugin hook failure is logged by the host, never sinks finalization.
          await firePluginLifecycle('afterDone', {
            installSlug: harnessSlug,
            projectDir,
            stateDir,
          }).catch((e) => console.warn(`[dbos-finalize] afterDone plugin hooks failed: ${e instanceof Error ? e.message : e}`));
          // P-004: the terminal transition as an event emission — the extension
          // surface plugins actually subscribe to (capability-scoped reaction
          // rules), plus events:await wakes on `pipeline:done:<slug>:<feature>`.
          emitPipelineEvent({
            name: 'done', harnessSlug, featureId: featureId ?? '-',
            ...(workspaceId ? { workspaceId } : {}),
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
    // P-013 (hive-from-github-url): the gate is no longer shared.json-only —
    // a hive member with registry coords (a URL-created harness) is upstream-
    // bound too. A standalone private harness stays out (upstreamGateAllows).
    const project = await resolveProject(harnessSlug, workspaceId);
    if (!project) return null;
    const { resolveUpstreamRepoSource, upstreamGateAllows } = await import(
      '../harness/upstream-repo-context'
    );
    const src = await resolveUpstreamRepoSource(project);
    if (!src || !upstreamGateAllows(project, src)) return null;
    return {
      github_remote: src.github_remote,
      github_repository_id: src.github_repository_id ?? 0,
    };
  },
  resolveRepoContext: async ({ harnessSlug, workspaceId }) => {
    const project = await resolveProject(harnessSlug, workspaceId);
    if (!project) return null;
    const { resolveUpstreamRepoSource } = await import('../harness/upstream-repo-context');
    const src = await resolveUpstreamRepoSource(project);
    if (!src) return null;
    const { resolveLocalGithubIdentity } = await import('../identity/resolve-local-github-identity');
    const id = await resolveLocalGithubIdentity();
    if (id.kind !== 'ok') return null;
    return {
      repoPath: project.path,
      // P-013: the detected upstream default branch — 'main' only as the true
      // last resort (the old hardcode mis-targeted master upstreams).
      baseBranch: src.default_branch ?? 'main',
      token: id.token,
      upstreamOwner: src.owner,
      upstreamRepo: src.repo,
      // PR-4 (c): the SAME resolved gh identity that authors the PR — recorded as
      // the human operator on the harness_feature_prs row (attributable; the EN-2
      // P-RATE bucket key).
      authorGithubUserId: id.githubUserId,
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
  // PR-4 (b): the live WI↔PR producer — UPSERT the harness_feature_prs row at
  // PR-open so the merge-time completion stamp resolves the feature from the row
  // (not the empty fallback) and the report GUI can link WI→PR→merged.
  recordFeaturePrOpened: async (row) => {
    const { upsertFeaturePrOnOpen } = await import('../harness/feature-pr-producer');
    await upsertFeaturePrOnOpen(row);
  },
  log: (msg) => console.error(msg),
};

export function wireOrchestratorInvokeRunner(): void {
  if (_wired) return;
  _wired = true;
  // RB-009: surface rate-limit-governor pauses to coord + the toast stream. Idempotent; the
  // governor is shared by the pipeline spawn, stateless LLM calls, and the gym, so one init here
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
  // rate-limit-layer-v2 D-002 (capture point 1): the stateless anthropic-direct path reports per-call token usage
  // + any anthropic-ratelimit-* headers; persist each as a usage sample for the fleet read-model.
  setStatelessUsageSink((ev) => {
    const modelClass = modelClassOf(ev.model);
    void recordUsageHeaders(`anthropic:${modelClass}`, 'anthropic', modelClass, ev.headers ?? {}, {
      inputTokens: ev.inputTokens,
      outputTokens: ev.outputTokens,
      cacheReadTokens: ev.cacheReadTokens,
      cacheCreationTokens: ev.cacheCreationTokens,
      costUsd: ev.costUsd,
      model: ev.model,
      accountId: process.env.PAPERCUSP_ACCOUNT_ID,
      // Caller attribution (the stateless usageAttribution seam) — before this,
      // every source:'headers' row was anonymous (null role/run/session).
      ...(ev.attribution ?? {}),
    });
  });
  setPipelineInvokeRunner(realRunner);
  setPipelineFinalizer(realFinalizer);
  // P-012: fire the read-only debugger before a worker when the feature has
  // failed ≥ debugger.threshold times and has no debug note yet.
  setPipelineDebuggerHook(realDebuggerHook);
  // token-usage-reduction P-010: run the harness's test command once before a
  // validator spawn and hand it the digest, replacing run-and-reread loops.
  setPipelineTestDigestHook(realTestDigestHook);
  // D-007 (shared-hive-loop-e2e-testing): at each dispatching turn, RENEW + verify the
  // executor's per-Hive work-item lease through the real authority-routed heartbeat.
  // `renewed:false` (lapsed / stolen by another Swarm) makes the pipeline self-abort
  // before its next side effect. FAIL-OPEN: any PG/authority error returns `renewed:true`
  // — the lease check must NEVER kill a live pipeline (the next turn re-checks; adoption
  // rule 2 is the backstop for an un-aborted zombie).
  setPipelineLeaseHeartbeatHook(({ harnessSlug, featureId, workspaceId, claim }) =>
    leaseHeartbeatFailOpen(async () => {
      const r = await heartbeatClaim({
        workspaceId: workspaceId ?? activeWorkspaceId(),
        harnessSlug,
        workItemId: featureId,
        potSlug: claim.potSlug,
        claimId: claim.claimId,
        owner: claim.owner,
        holderPubkey: claim.holderPubkey,
      });
      return { renewed: r.renewed, reason: r.reason };
    }),
  );
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

/**
 * spawnInvokeOnceWithFallback — the SPAWNER_SIDECAR-gated front door to the agent
 * spawn chokepoint (WI-344 ③, plan spawner-sidecar-offload-2026-06-30).
 *
 * Mirrors substrate's `bootSubstrateWithFallback`. OFF (the default + correct state
 * until the sidecar is wired + verified) ⇒ byte-identical in-process spawnInvokeOnce.
 * ON ⇒ ensure the spawner sidecar is up, then route the spawn over IPC so the
 * `child_process.spawn` of bee/queen children + the synchronous `buildInvokeOnce`
 * run in the sidecar process — OFF the bg-host main event loop that they currently
 * saturate (the ~24.5% main-loop CPU that freezes routinesTick). The mid-turn
 * signals the in-process path emits (child pid, output-activity) are delivered back
 * over the sidecar's push channel and re-fired into the SAME `opts` callbacks; an
 * `opts.signal` abort is forwarded as a `spawn:cancel` for the captured request id.
 *
 * INERT until deliberately wired: nothing calls this yet (operator-spawn.ts /
 * serve.ts / host-bootstrap.ts are wired by the orchestrator separately), and the
 * sidecar machinery is loaded via DYNAMIC import only on the ON path — so loading
 * orchestrator-runner.ts (the hot bg-host module) pulls in NONE of it. ANY error
 * (flag read, sidecar spawn, or the IPC call) falls back to in-process — the sidecar
 * is strictly optional, exactly like the substrate sidecar.
 *
 * Return type is unchanged (SpawnInvokeOnceResult); spawnInvokeOnce is NOT modified.
 */
export async function spawnInvokeOnceWithFallback(
  projectDir: string,
  role: string,
  extras: string[],
  extraEnv: Record<string, string>,
  opts?: {
    signal?: AbortSignal;
    timeoutMs?: number;
    resultPath?: string;
    forceSessionId?: string;
    onChildPid?: (pid: number) => void;
    onOutputActivity?: () => void;
  },
): Promise<SpawnInvokeOnceResult> {
  // v1 rollout control is a PER-HOST env opt-in (PAPERCUSP_SPAWNER_SIDECAR=1), NOT
  // the global papercusp-spawner-sidecar flag: post the 2026-06-29 flag-default
  // inversion that flag derives default-ON and is system-scope (global) + is not
  // settable via the MCP flags tool, so it can neither stage a per-host rollout nor
  // offer an off-switch. The env gate is set ONLY on the bg-host systemd unit (the
  // host whose main loop the spawn CPU saturates), default-unset everywhere else ⇒
  // byte-identical, instantly reversible (unset + restart). The flag stays registered
  // as a future global control once it is in DARK_FLAGS + the MCP enum.
  const on = process.env.PAPERCUSP_SPAWNER_SIDECAR === '1';
  if (!on) {
    // Env unset (the default): in-process spawn, byte-identical to today.
    return spawnInvokeOnce(projectDir, role, extras, extraEnv, opts);
  }

  try {
    // Dynamic import keeps the sidecar machinery OFF the hot path's module graph —
    // it is loaded only when the flag is ON and this wrapper is actually called.
    const { spawnSpawnerSidecar } = await import('../fleet/spawner-sidecar-spawn');
    const { getSpawnerIpcClient } = await import('../fleet/spawner-ipc-client');

    await spawnSpawnerSidecar();
    const client = getSpawnerIpcClient();

    // Capture the request id the client assigns so an abort can cancel ACROSS the
    // IPC boundary (the sidecar holds the AbortController for that request id).
    let requestId: number | undefined;
    const onAbort = (): void => {
      if (requestId !== undefined) {
        void client.call('spawn:cancel', { requestId }).catch(() => {
          /* best-effort cancel; the timeout in the sidecar is the backstop */
        });
      }
    };
    const signal = opts?.signal;
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      return await client.call<SpawnInvokeOnceResult>(
        'spawn:invokeOnce',
        {
          projectDir,
          role,
          extras,
          extraEnv,
          timeoutMs: opts?.timeoutMs,
          resultPath: opts?.resultPath,
          forceSessionId: opts?.forceSessionId,
        },
        {
          onPid: opts?.onChildPid,
          onOutputActivity: opts?.onOutputActivity,
          onRequestId: (id) => {
            requestId = id;
          },
          // No client RPC timeout: spawn:invokeOnce resolves only when the bee EXITS
          // (the whole agent run, minutes). The sidecar's own spawn timeout is the
          // real bound; a fixed client timeout would spuriously fall back → double-spawn.
          timeoutMs: 0,
        },
      );
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  } catch (e) {
    console.warn('[spawner-sidecar] fell back to in-process:', e);
    return spawnInvokeOnce(projectDir, role, extras, extraEnv, opts);
  }
}
