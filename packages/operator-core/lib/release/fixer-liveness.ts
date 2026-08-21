/**
 * Is a dispatched release-fixer still alive? (EI-18672078222841101)
 *
 * WHY THIS IS ITS OWN MODULE. This lived in `harness/routines/release-actions.ts`, which
 * calls `registerSystemAction('green-checkpoint', ...)` / `('release-trigger', ...)` at
 * MODULE SCOPE. Importing it registers those system actions as a side effect — fine for the
 * routine host, wrong for a read-side surface like the pipeline snapshot that only wants to
 * report who owns the current red. Splitting the function out (rather than copying it) keeps
 * ONE liveness definition: the renderer that tells agents "someone is on it" and the
 * dispatcher that decides "don't spawn another one" must never be able to disagree.
 */
import type postgres from 'postgres';
import { hostname } from 'node:os';
import { STALE_MS } from '../liveness';
import { isSpawnProcessAlive, launcherBootId } from '../fleet/spawn-reclaim';

/** The durable escalation phase for a release-fixer that died before its first turn. */
export const RELEASE_FIXER_NO_TURN_PHASE = 'green-checkpoint-release-fixer-no-turn';

export interface ReleaseFixerNoTurnEscalationInput {
  installSlug: string;
  workspaceId: string;
  spawnId: string;
  candidate?: string | null;
  failingTests?: readonly string[] | null;
  errorMessage: string;
  nowMs?: number;
}

/**
 * The classifier's no-turn wording is deliberately shared by all spawn paths. Keep this
 * predicate here too, so the release-fixer escalation does not grow a second parser for
 * invoke-outcome's diagnostics.
 */
export function isReleaseFixerNoTurnFailure(errorMessage: string | null | undefined): boolean {
  return typeof errorMessage === 'string' &&
    /(?:produced no turn|before producing a turn|before (?:the agent|it) produced a turn)/i.test(errorMessage);
}

/** Pure, bounded payload for the existing `harness_escalations` surface. */
export function releaseFixerNoTurnEscalationBody(opts: ReleaseFixerNoTurnEscalationInput): string {
  const candidate = typeof opts.candidate === 'string' ? opts.candidate.slice(0, 12) : null;
  const failingTests = (opts.failingTests ?? []).filter((test): test is string => typeof test === 'string').slice(0, 20);
  const errorMessage = opts.errorMessage.slice(-1600);
  const timedOut = /timedOut=true|timed out before/i.test(opts.errorMessage);
  return JSON.stringify({
    kind: 'release-fixer-no-turn',
    harness_slug: opts.installSlug,
    workspace_id: opts.workspaceId,
    spawnId: opts.spawnId,
    candidate,
    failingTests,
    timedOut,
    emitted_at: opts.nowMs ?? Date.now(),
    detail:
      `release-fixer ${opts.spawnId} produced no turn${timedOut ? ' before the invoke timeout expired' : ''}; ` +
      `the release gate remains red and this launch did not provide a diagnosis. Inspect the launcher ` +
      `termination record plus account/gateway telemetry, then allow the liveness-aware dispatcher to ` +
      `send a fresh fixer after the cause is understood.`,
    errorMessage,
  });
}

/**
 * Persist a no-turn escalation idempotently on the existing escalation table. Returns true
 * only when this call opened a previously-clear row; callers can use that edge for a single
 * log/notification without turning repeated retries into an alert storm.
 */
export async function recordReleaseFixerNoTurnEscalation(
  sql: postgres.Sql,
  opts: ReleaseFixerNoTurnEscalationInput,
): Promise<boolean> {
  try {
    const prior = (await sql<Array<{ escalation?: string | null }>>`
      SELECT escalation FROM harness_shared.harness_escalations
        WHERE harness_slug = ${opts.installSlug} AND phase = ${RELEASE_FIXER_NO_TURN_PHASE}
        LIMIT 1
    `) as Array<{ escalation?: string | null }>;
    await sql`
      INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, mtime_ms, workspace_id)
      VALUES (${opts.installSlug}, ${RELEASE_FIXER_NO_TURN_PHASE}, ${releaseFixerNoTurnEscalationBody(opts)}, ${opts.nowMs ?? Date.now()}, ${opts.workspaceId})
      ON CONFLICT (harness_slug, phase)
      DO UPDATE SET escalation = EXCLUDED.escalation, mtime_ms = EXCLUDED.mtime_ms
    `;
    return !prior[0]?.escalation;
  } catch (error) {
    // A diagnostic escalation must never turn a failed fixer into a second workflow failure.
    console.warn(
      `[release-fixer] no-turn escalation write failed (${opts.installSlug}/${opts.spawnId}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

/**
 * Is the recorded release-fixer spawn still ALIVE? Prefer the task-manager's
 * named-scope row when present: `systemd-run --scope` can finish its client while
 * the real agent payload keeps running, and the task reconciler is the authority
 * that follows that handoff (WI-37509 / EI-21065737245117808). Otherwise retain
 * the existing `running`/`restarting` + fresh-heartbeat/PID rules.
 * Returns `null` when there's no spawn id to check (a DBOS-durable fire / legacy
 * record), which the decision treats as "presumed covered". Fail-soft: a query
 * error returns null (presumed covered) rather than hammering a re-dispatch.
 */
export async function releaseFixerSpawnAlive(
  sql: postgres.Sql,
  spawnId: string | null | undefined,
): Promise<boolean | null> {
  if (!spawnId) return null;
  const graceSec = Math.max(1, Math.round(STALE_MS / 1000));
  try {
    const rows = (await sql.unsafe(
      `SELECT sa.launcher_host, sa.launcher_boot_id, sa.pid,
              (sa.status IN ('running','restarting')
                AND sa.heartbeat_at IS NOT NULL
                AND (now() - sa.heartbeat_at) < make_interval(secs => $2)) AS spawn_lease_live,
              EXISTS (
                SELECT 1
                  FROM harness_shared.task_ledger tl
                 WHERE tl.workspace_id = sa.workspace_id
                   AND tl.class = 'agent-session'
                   AND tl.launched_by = 'orchestrator:release-fixer'
                   AND tl.state IN ('pending','running')
                   AND tl.detail->>'spawnRecordId' = sa.spawn_id
                   AND tl.last_seen_at IS NOT NULL
                   AND (now() - tl.last_seen_at) < make_interval(secs => $2)
              ) AS live_task_scope
         FROM harness_shared.spawned_agents sa
        WHERE sa.spawn_id = $1
        LIMIT 1`,
      [spawnId, graceSec],
    )) as Array<{
      launcher_host?: string | null;
      launcher_boot_id?: string | null;
      pid?: number | string | null;
      spawn_lease_live?: boolean;
      live_task_scope?: boolean;
    }>;
    const row = rows[0];
    if (!row) return false;

    // The named scope owns the real payload after systemd-run's client handoff.
    // It outranks a terminal/stale spawn row until the task reconciler proves the
    // scope ended; otherwise a second fixer can mutate the same frozen candidate.
    if (row.live_task_scope) return true;
    if (!row.spawn_lease_live) return false;

    // A PID is only meaningful within the launcher boot that recorded it. A
    // same-host row from an earlier boot is provably orphaned even when its
    // heartbeat was refreshed before the host noticed the restart; treating the
    // heartbeat as proof here is exactly how release:trace rendered a dead
    // release-fixer as owned-live (EI-20984152070842112).
    const localHost = hostname();
    const sameHost = row.launcher_host === localHost;
    if (sameHost && row.launcher_boot_id && row.launcher_boot_id !== launcherBootId()) return false;

    // For a same-host row with a recorded child, use the existing PID-reuse-
    // hardened probe. Missing/invalid PIDs retain the heartbeat fallback for
    // legacy and admission-gap rows; the boot mismatch check above handles the
    // cross-restart case even when that PID is absent.
    if (sameHost && row.pid != null) return isSpawnProcessAlive(Number(row.pid));
    return true;
  } catch {
    return null;
  }
}
