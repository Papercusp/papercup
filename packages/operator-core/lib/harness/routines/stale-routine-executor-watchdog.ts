/**
 * stale-routine-executor-watchdog.ts — EI-19409061552037718: a long-lived host
 * with PAPERCUSP_DBOS_ROUTINES=1 silently keeps executing scheduled routines with
 * FROZEN code (loaded once at process start, never reloaded), so routine fixes
 * committed since that process's boot are not loaded by that process until it is
 * restarted.
 *
 * MEASURED 2026-08-03: a 7h-stale desktop-dev operator (:3270, PAPERCUSP_HONO_PORT
 * unset there but PAPERCUSP_DBOS_ROUTINES=1) kept firing condition-staleness-alarm
 * with pre-fix logic (a dedup key that embeds elapsed-minutes prose) alongside a
 * freshly-restarted papercup-bg-host running the fixed code — 97 pre-fix
 * escalation rows vs 2 post-fix ones in 24h, both shapes minted AFTER the fix
 * landed. `routines-workflow.ts`'s own doc comment already documents this as
 * "SAFE from double-fire" (claimDueRoutine's conditional next_fire_at advance is a
 * real per-tick single-flight guard). This watchdog has no visibility into a
 * different process or which process handled a particular tick; its evidence is
 * only this process's boot-time code snapshot versus the current tree.
 *
 * Two remedies were on the table (see the work-item): (a) refuse to CLAIM a
 * routine from a stale process, or (b) make the staleness LOUD instead of silent.
 * (a) risks the documented, owner-INTENTIONAL redundancy design — ROUTINES=1 was
 * deliberately enabled on the desktop dev operator "to give the Queen a healthy
 * executor when :3070 is saturated" (2026-06-16) — and a wrong staleness
 * heuristic could silently disable that redundancy exactly when it's needed
 * most (a saturated/slow :3070). This module is (b): the same shape as every
 * sibling watchdog already riding routinesTick (release-deploy-staleness,
 * rubric-staleness, session-ingest-lag, …) — detect, page once per episode via
 * the shared urgent-notify + fleet-broadcast + escalation-row trio, and get out
 * of the way. It NEVER touches routine claiming/dispatch — zero risk to the
 * fleet's live routine execution, whatever the verdict.
 *
 * Scoped PER EXECUTOR IDENTITY (PAPERCUSP_HONO_PORT/PORT, falling back to a
 * per-pid identity) so a stale desktop and a healthy :3070 — both running this
 * same sweep independently on their own routinesTick — never clear or flap each
 * other's alert (EI-16071's scopeKey pattern; see `scopedFireReason`'s doc
 * comment for the "reason must literally contain the scope key" trap this
 * avoids by routing through it rather than hand-rolling the LIKE match).
 */
import { claimWatchdogFire, recentWatchdogFires, scopedFireReason } from '../../pot/watchdog';
import { RESTART_TARGET_UNITS } from '../../agent-tools/dev/restart-target-units';
import { operatorHomeHarnessSlug } from '../operator-home-harness';
import {
  processBootCommitSha,
  processBootTimeMs,
  resolveCurrentHeadCommit,
} from '../../dbos/process-boot-identity';

// Throttled — never shell out to git on every 30s routinesTick.
const CURRENT_HEAD_REFRESH_MS = 5 * 60_000;
let cachedCurrentHead: { sha: string | null; atMs: number } | null = null;

async function currentHeadCommit(now: number): Promise<string | null> {
  if (cachedCurrentHead && now - cachedCurrentHead.atMs < CURRENT_HEAD_REFRESH_MS) {
    return cachedCurrentHead.sha;
  }
  const sha = await resolveCurrentHeadCommit();
  cachedCurrentHead = { sha, atMs: now };
  return sha;
}

// ── tunables (env-overridable, like every sibling watchdog) ───────────────────

/** How long a ROUTINES=1 process may run before its boot-commit-vs-tree-HEAD
 *  drift is even considered. Default 2h — long enough that a normal deploy/
 *  restart cadence never trips it, short enough that a genuinely long-lived
 *  stale executor (the measured case: 7h) is caught with real margin. `<=0`
 *  disables the sweep (kill switch). */
export function staleExecutorThresholdSec(): number {
  const n = Number(process.env.PAPERCUSP_STALE_ROUTINE_EXECUTOR_THRESHOLD_SEC ?? 7_200);
  return Number.isFinite(n) ? n : 7_200;
}

function routinesEnabledHere(): boolean {
  return process.env.PAPERCUSP_DBOS_ROUTINES === '1';
}

/** A stable-across-ticks, per-process identity so the debounce/escalation/paging
 *  never conflates two DIFFERENT executors (a stale desktop and a healthy
 *  :3070 must never clear each other's alert). Prefers the operator's own port
 *  (stable across restarts of "the same" logical service — :3070/:3170/:3270);
 *  falls back to a pid-scoped identity when no port is resolvable. */
export function executorIdentity(): string {
  const port = process.env.PAPERCUSP_HONO_PORT ?? process.env.PORT;
  return port ? `port-${port}` : `pid-${process.pid}`;
}

export interface ExecutorAlarmContext {
  unit: string;
  restartLever: string;
  identityLabel: string;
}

/**
 * Resolve the user-facing identity and sanctioned remediation for an executor.
 *
 * The routines primary is a child of `papercup-bg-host.service`; its worker PID
 * is therefore not the systemd MainPID and is unsafe as a standalone alarm
 * identity. Keep the mapping pure so the alarm text has a focused regression
 * bar and unknown identities fail visibly instead of suggesting a PID action.
 */
export function executorAlarmContext(identity: string): ExecutorAlarmContext {
  const knownByIdentity: Record<string, { unit: string; target: string }> = {
    'port-3070': { unit: RESTART_TARGET_UNITS.dev, target: 'dev' },
    'port-3170': { unit: RESTART_TARGET_UNITS.staging, target: 'staging' },
    'port-3271': { unit: RESTART_TARGET_UNITS['bg-host'], target: 'bg-host' },
  };
  const known = knownByIdentity[identity];
  if (known) {
    return {
      unit: known.unit,
      restartLever: `dev:restart { target: '${known.target}', confirm: true }`,
      identityLabel: `${known.unit} (executor identity ${identity})`,
    };
  }

  const configuredUnit = process.env.PAPERCUSP_SYSTEMD_UNIT?.trim();
  const unit = configuredUnit || 'systemd unit unresolved';
  return {
    unit,
    restartLever: configuredUnit
      ? `the sanctioned dev:restart target for ${configuredUnit}`
      : 'resolve the owning service before choosing its sanctioned dev:restart target',
    identityLabel: `${unit} (executor identity ${identity})`,
  };
}

// ── pure decider (no DB, no git — everything injected) ────────────────────────

export interface ExecutorStalenessInput {
  routinesEnabled: boolean;
  bootCommit: string | null;
  currentCommit: string | null;
  bootTimeMs: number;
  now: number;
  thresholdMs: number;
}

export interface ExecutorStalenessVerdict {
  stale: boolean;
  reason: string;
  ageMs: number;
}

/**
 * PURE: is this process a stale routine executor right now?
 *
 * Deliberately conservative in every ambiguous direction — a false alert here
 * pages a human for nothing, but a false SILENCE is the exact bug this exists
 * to close, so the asymmetry is: fail toward not-stale whenever the inputs are
 * incomplete, and only alert on a positively-confirmed commit divergence.
 */
export function evaluateExecutorStaleness(input: ExecutorStalenessInput): ExecutorStalenessVerdict {
  const ageMs = Math.max(0, input.now - input.bootTimeMs);
  if (!input.routinesEnabled) {
    return { stale: false, reason: 'PAPERCUSP_DBOS_ROUTINES is not enabled on this process', ageMs };
  }
  if (input.thresholdMs <= 0) {
    return { stale: false, reason: 'kill switch (thresholdMs <= 0)', ageMs };
  }
  if (ageMs < input.thresholdMs) {
    return {
      stale: false,
      reason: `process uptime ${Math.round(ageMs / 60_000)}m is under the ${Math.round(input.thresholdMs / 60_000)}m threshold`,
      ageMs,
    };
  }
  if (!input.bootCommit || !input.currentCommit) {
    return {
      stale: false,
      reason: 'boot or current tree commit unresolvable (no git checkout, or a read failed) — skipping, fail-safe',
      ageMs,
    };
  }
  if (input.bootCommit === input.currentCommit) {
    return { stale: false, reason: 'boot commit still matches this checkout\'s tree HEAD — nothing has moved since boot', ageMs };
  }
  const ageHours = Math.round(ageMs / 3_600_000);
  return {
    stale: true,
    reason:
      `this process has run ${ageHours}h with PAPERCUSP_DBOS_ROUTINES=1, code loaded at boot commit ` +
      `${input.bootCommit.slice(0, 10)}, while this checkout's tree HEAD has since moved to ` +
      `${input.currentCommit.slice(0, 10)} — scheduled-routine fixes committed since boot are not loaded by this process ` +
      `(EI-19409061552037718). Restart this host to pick up current code, or, if it no longer needs to run ` +
      `routines, unset PAPERCUSP_DBOS_ROUTINES on it.`,
    ageMs,
  };
}

// ── paging rails (same trio every sibling pipeline/staleness watchdog uses) ───

function phaseFor(identity: string): string {
  return `stale-routine-executor-watchdog:${identity}`;
}

function conditionKeyFor(identity: string): string {
  return `stale-routine-executor:${identity}`;
}

async function raiseExecutorStalenessAlarm(opts: {
  workspaceId: string;
  installSlug: string;
  identity: string;
  verdict: ExecutorStalenessVerdict;
  now: number;
}): Promise<boolean> {
  const { workspaceId, installSlug, identity, verdict, now } = opts;
  const phase = phaseFor(identity);
  const alarmContext = executorAlarmContext(identity);
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    const existing = await sql<{ escalation: unknown }[]>`
      SELECT escalation FROM harness_shared.harness_escalations
       WHERE harness_slug = ${installSlug} AND phase = ${phase}`;
    if (existing.length > 0 && existing[0].escalation != null) return false; // already paged this episode

    const ageHours = Math.round(verdict.ageMs / 3_600_000);

    try {
      const { notifyAttention } = await import('../../attention-notify');
      await notifyAttention({
        kind: 'intervention',
        title: `Stale routine executor (${alarmContext.identityLabel}) is running code older than the checkout`,
        body: verdict.reason,
        importance: 'urgent',
        workspaceId,
        harnessSlug: installSlug,
        data: { ageHours, identity, unit: alarmContext.unit, restartLever: alarmContext.restartLever },
      });
    } catch (e) {
      console.warn(`[stale-routine-executor] notify failed: ${e instanceof Error ? e.message : e}`);
    }

    const { broadcastSevereEvent } = await import('../../severe-event-broadcast');
    await broadcastSevereEvent({
      summary:
        `stale routine executor ${alarmContext.identityLabel} has run ${ageHours}h with code from its boot while ` +
        `PAPERCUSP_DBOS_ROUTINES=1 and the checkout has moved — scheduled-routine fixes committed since boot ` +
        `are not loaded by this process; restart ${alarmContext.unit} with ${alarmContext.restartLever} to pick up current code.`,
      body:
        `${verdict.reason}\n\nThe worker identity is not necessarily the systemd MainPID. Do NOT kill or duplicate a worker PID ` +
        `to "fix" this; restart ${alarmContext.unit} with ${alarmContext.restartLever}, or stop carrying ` +
        `PAPERCUSP_DBOS_ROUTINES=1 on that service if it no longer needs to run routines.`,
      category: 'severe-event',
      conditionKey: conditionKeyFor(identity),
      oneShot: true,
    });

    try {
      await sql`
        INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, mtime_ms, workspace_id)
        VALUES (${installSlug}, ${phase}, ${JSON.stringify({
          kind: phase,
          harness_slug: installSlug,
          identity,
          ageHours,
          detail: verdict.reason,
          emitted_at: now,
        })}, ${now}, ${workspaceId})
        ON CONFLICT (harness_slug, phase)
        DO UPDATE SET escalation = EXCLUDED.escalation, mtime_ms = EXCLUDED.mtime_ms`;
    } catch (e) {
      console.warn(`[stale-routine-executor] escalation write failed: ${e instanceof Error ? e.message : e}`);
    }
    return true;
  } catch (e) {
    console.warn(`[stale-routine-executor] alarm failed (non-fatal): ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

/** Recovery leg — mirrors clearDeployStalenessAlarm. Fires on every HEALTHY tick
 *  from THIS identity (idempotent; a no-op unless this identity was previously
 *  alarmed), so a restarted (freshly-booted) executor retracts its own stale page
 *  the moment it re-runs the sweep and finds itself no longer stale. */
async function clearExecutorStalenessAlarm(opts: { installSlug: string; identity: string; now: number }): Promise<boolean> {
  const { installSlug, identity, now } = opts;
  const phase = phaseFor(identity);
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    const cleared = await sql`
      UPDATE harness_shared.harness_escalations
         SET escalation = NULL, mtime_ms = ${now}
       WHERE harness_slug = ${installSlug}
         AND phase = ${phase}
         AND escalation IS NOT NULL`;
    if (cleared.count === 0) return false;
    const { broadcastSevereEventResolved } = await import('../../severe-event-broadcast');
    await broadcastSevereEventResolved({
      conditionKey: conditionKeyFor(identity),
      summary: `stale routine executor (${identity}) RECOVERED — it is running current code again (restart, most likely).`,
    });
    return true;
  } catch (e) {
    console.warn(`[stale-routine-executor] recovery failed (non-fatal): ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

// ── the sweep ───────────────────────────────────────────────────────────────

export interface StaleExecutorSweepResult {
  outcome: 'alerted' | 'skipped' | 'healthy' | 'error';
  verdict?: ExecutorStalenessVerdict;
  reason: string;
  paged?: boolean;
  recovered?: boolean;
}

/**
 * Runs on this process's own routinesTick. Judges only THIS process (never a
 * peer's) via its own boot-commit-vs-tree-HEAD drift + uptime — no cross-process
 * coordination, no lease, no change to claiming/dispatch. Fail-soft throughout;
 * kill switch PAPERCUSP_STALE_ROUTINE_EXECUTOR_THRESHOLD_SEC<=0.
 */
export async function staleRoutineExecutorSweep(opts: {
  now?: number;
  workspaceId?: string;
  installSlug?: string;
}): Promise<StaleExecutorSweepResult> {
  const thresholdSec = staleExecutorThresholdSec();
  if (thresholdSec <= 0) return { outcome: 'skipped', reason: 'kill switch' };
  const enabled = routinesEnabledHere();
  if (!enabled) return { outcome: 'skipped', reason: 'PAPERCUSP_DBOS_ROUTINES not enabled on this process' };

  const workspaceId = opts.workspaceId ?? 'papercusp-workspace';
  const installSlug = opts.installSlug ?? operatorHomeHarnessSlug();
  const now = opts.now ?? Date.now();
  const identity = executorIdentity();

  try {
    const [bootCommit, currentCommit] = await Promise.all([processBootCommitSha(), currentHeadCommit(now)]);
    const verdict = evaluateExecutorStaleness({
      routinesEnabled: enabled,
      bootCommit,
      currentCommit,
      bootTimeMs: processBootTimeMs(),
      now,
      thresholdMs: thresholdSec * 1_000,
    });

    if (!verdict.stale) {
      const recovered = await clearExecutorStalenessAlarm({ installSlug, identity, now });
      return { outcome: 'healthy', verdict, reason: verdict.reason, recovered };
    }

    const windowHours = Math.max(1, Math.round(thresholdSec / 3_600));
    const alreadyFiredRecently =
      (await recentWatchdogFires(workspaceId, installSlug, windowHours, 'stale-routine-executor', identity)) > 0;
    if (alreadyFiredRecently) {
      return { outcome: 'skipped', verdict, reason: 'debounced' };
    }

    const reason = scopedFireReason(`stale routine executor: ${verdict.reason}`, identity, 'stale-routine-executor');
    const claimed = await claimWatchdogFire({
      workspaceId,
      installSlug,
      source: 'stale-routine-executor',
      reason,
      wakeAt: null,
      windowHours,
      scopeKey: identity,
    });
    if (!claimed) {
      return { outcome: 'skipped', verdict, reason: 'debounced (raced or backed off)' };
    }

    const paged = await raiseExecutorStalenessAlarm({ workspaceId, installSlug, identity, verdict, now });
    console.warn(`[stale-routine-executor] ALERT (${identity}): ${reason}`);
    return { outcome: 'alerted', verdict, reason, paged };
  } catch (e) {
    return { outcome: 'error', reason: e instanceof Error ? e.message : String(e) };
  }
}
