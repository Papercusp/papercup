/**
 * Delayed lease cleanup for the authoritative tracked-session end writer.
 *
 * `activity:report` remains the seconds-fast path for a normal SessionEnd hook,
 * but that hook is intentionally best-effort. The psu parent independently
 * records the child exit through `markAdvSessionEnded`; before this hook, an end
 * report that arrived without the lifecycle report left file/resource locks and
 * work-item leases alive until their TTL or the hourly reaper.
 *
 * The settle + liveness check is load-bearing. A carry-respawn can briefly mark
 * the old process ended while a successor starts under the SAME owner id. We
 * release only when the recorded row is still ended, no newer/open adv session
 * exists for the owner, and the shared liveness oracle does not see a live
 * heartbeat, host, wake delivery, armed engine loop, or process. Claims are
 * deliberately excluded
 * from that oracle: a dead owner's own lease cannot prove the owner alive.
 */
import { getOrgPg } from '@papercusp/db-org';
import { releaseAllWorkItemLeasesForOwner } from './work-item-lease-release';
import { fileLockCoordinationDomain, lockDomainForProjectDir } from './agent-tools/locks/coordination-domain';
import { releaseAllOwnedLocks } from './agent-tools/locks/release-all-owned';
import { closeAdoptedTerminalSessions } from './task-manager/adopt-terminal-session';
import { killTask } from './task-manager/control';
import { listTasks } from './task-manager/store';
import { isAutoReapExempt, type TaskRow } from './task-manager/types';

export const SESSION_END_LEASE_RELEASE_DELAY_MS = 15_000;
/**
 * A liveness signal can still belong to the ending process when the first
 * settle pass runs. Retry that protected result instead of leaving the lock
 * until the periodic reaper, but keep the retry window bounded.
 */
export const SESSION_END_LEASE_RELEASE_RETRY_DELAY_MS = 15_000;
export const SESSION_END_LEASE_RELEASE_MAX_OWNER_LIVE_RETRIES = 3;

export interface SessionEndLeaseRow {
  id: number;
  workspaceId: string;
  coordOwnerId: string | null;
  sessionId: string | null;
  cwd: string | null;
  endedAt: Date | null;
  ownerHasOpenSession: boolean;
}

export interface SessionEndLeaseReleaseDeps {
  loadRow?: (advSessionId: number) => Promise<SessionEndLeaseRow | null>;
  /**
   * Receives the ENDING owner's id so the protection query can ignore that
   * owner's own (still-fresh) presence row — EI-22651749738479868.
   */
  loadProtectedOwners?: (endingOwnerId: string) => Promise<ReadonlySet<string>>;
  releaseLocks?: typeof releaseAllOwnedLocks;
  releaseWorkItems?: typeof releaseAllWorkItemLeasesForOwner;
  listTasks?: typeof listTasks;
  killTask?: typeof killTask;
  closeAdoptedTerminalSessions?: typeof closeAdoptedTerminalSessions;
}

interface SessionEndLeaseReleaseScheduleOptions {
  delayMs?: number;
  retryDelayMs?: number;
  maxOwnerLiveRetries?: number;
  deps?: SessionEndLeaseReleaseDeps;
}

export type SessionEndLeaseReleaseReason =
  | 'row-not-found'
  | 'row-not-ended'
  | 'owner-missing'
  | 'owner-resumed'
  | 'owner-live'
  | 'partial-failure';

export interface SessionEndLeaseReleaseResult {
  ok: boolean;
  reason?: SessionEndLeaseReleaseReason;
  ownerId?: string;
  releasedPaths?: string[];
  resourcesReleased?: number;
  releasedWorkItems?: string[];
  claimsCleared?: number;
  agentSessionTaskIds?: string[];
  reapedTaskIds?: string[];
  failedTaskIds?: string[];
  /** Live rows this session owned that were deliberately NOT reaped because they
   *  are auto-reap exempt (terminal-launched psu sessions — D-001). Reported
   *  rather than silently dropped: "we skipped 3" and "there were none" are
   *  different facts, and only one of them means the exemption is working. */
  exemptTaskIds?: string[];
  failedEffects?: Array<'locks' | 'work-items' | 'tasks'>;
}

/**
 * Split the session's live agent-session rows into the ones this reaper may
 * signal and the ones it must not.
 *
 * Pulled out as a pure function on purpose. The exemption is an OWNER RULING
 * (plan terminal-psu-session-enrolment-2026-08-24 D-001, avi 2026-08-24:
 * "Visible only — never auto-reap"), and a ruling that lives as an inline
 * `.filter()` inside an async cleanup pass can only be tested through the whole
 * hook, which makes it easy to delete and hard to notice. Here it is one named,
 * directly-testable decision — and the test file keeps a deliberately-wrong
 * partition beside it as a permanent control, so the guard is provably
 * falsifiable without ever mutating this shared tree.
 *
 * `exempt` is RETURNED rather than dropped because "we skipped one" and "there
 * were none" are different facts, and only the first proves the rule ran.
 */
export function partitionReapableTasks(rows: readonly TaskRow[]): {
  reapable: TaskRow[];
  exempt: TaskRow[];
} {
  const reapable: TaskRow[] = [];
  const exempt: TaskRow[] = [];
  for (const row of rows) (isAutoReapExempt(row) ? exempt : reapable).push(row);
  return { reapable, exempt };
}

async function loadSessionEndLeaseRow(advSessionId: number): Promise<SessionEndLeaseRow | null> {
  const { sql } = getOrgPg();
  const rows = await sql<
    Array<{
      id: number;
      workspace_id: string;
      coord_owner_id: string | null;
      session_id: string | null;
      cwd: string | null;
      ended_at: Date | string | null;
      owner_has_open_session: boolean;
    }>
  >`
    SELECT s.id, s.workspace_id, s.coord_owner_id, s.session_id, s.cwd, s.ended_at,
           EXISTS (
             SELECT 1
               FROM harness_shared.adv_sessions newer
              WHERE newer.coord_owner_id = s.coord_owner_id
                AND newer.ended_at IS NULL
           ) AS owner_has_open_session
      FROM harness_shared.adv_sessions s
     WHERE s.id = ${advSessionId}
     LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    coordOwnerId: row.coord_owner_id,
    sessionId: row.session_id,
    cwd: row.cwd,
    endedAt: row.ended_at == null ? null : new Date(row.ended_at),
    ownerHasOpenSession: row.owner_has_open_session,
  };
}

async function loadProtectedOwners(endingOwnerId: string): Promise<ReadonlySet<string>> {
  // Dynamic imports avoid turning adv-sessions -> this hook -> idle-session-reaper
  // -> adv-sessions into an eager module cycle. This path runs only after an end.
  const [{ gatherProtectedSessionOwners, liveHostOwnerSet }, { listLiveHosts }] = await Promise.all([
    import('./idle-session-reaper'),
    import('./events/await/psu-pty-discovery'),
  ]);
  let liveHostOwners = new Set<string>();
  try {
    liveHostOwners = liveHostOwnerSet(listLiveHosts());
  } catch {
    // A missing host signal protects nobody, but the heartbeat/wake/PID legs
    // below still fail closed for any owner they can establish as live.
  }
  return gatherProtectedSessionOwners(getOrgPg().sql, {
    includeClaimHolders: false,
    liveHostOwners,
    confirmDeadPids: true,
    ignoreOwnPresenceFor: endingOwnerId,
  });
}

/**
 * Run one liveness-checked cleanup pass for a tracked session end.
 *
 * Both effects are independently fail-open, matching activity:report: a lock
 * database fault must not strand the work-item cleanup, and vice versa. The
 * ordinary TTL/hourly reaper remains the final backstop for a failed effect.
 */
export async function runSessionEndLeaseRelease(
  advSessionId: number,
  deps: SessionEndLeaseReleaseDeps = {},
): Promise<SessionEndLeaseReleaseResult> {
  const row = await (deps.loadRow ?? loadSessionEndLeaseRow)(advSessionId);
  if (!row) return { ok: false, reason: 'row-not-found' };
  if (!row.endedAt) return { ok: false, reason: 'row-not-ended' };
  const ownerId = row.coordOwnerId?.trim() ?? '';
  if (!ownerId) return { ok: false, reason: 'owner-missing' };
  if (row.ownerHasOpenSession) return { ok: false, reason: 'owner-resumed', ownerId };

  const protectedOwners = await (deps.loadProtectedOwners ?? loadProtectedOwners)(ownerId);
  if (protectedOwners.has(ownerId)) return { ok: false, reason: 'owner-live', ownerId };

  const reapAgentSessionTasks = async () => {
    const sessionId = row.sessionId?.trim() ?? '';
    if (!sessionId) {
      return {
        taskIds: [] as string[],
        reapedTaskIds: [] as string[],
        failedTaskIds: [] as string[],
        exemptTaskIds: [] as string[],
      };
    }
    const listed = await (deps.listTasks ?? listTasks)({
      workspaceId: row.workspaceId,
      sessionId,
      states: ['pending', 'running'],
      classes: ['agent-session'],
      limit: 2_000,
    });
    // ⛔ OWNER RULING (terminal-psu-session-enrolment-2026-08-24 D-001, avi
    // 2026-08-24): a TERMINAL-launched session enrolled by
    // `adopt-terminal-session` is VISIBLE ONLY and must never be auto-reaped.
    //
    // This is the ONE automated killer of live `agent-session` rows, so it is
    // where the exemption has to live. It deliberately does NOT live inside
    // `killTask`: a DELIBERATE `processes:kill { taskId }` by an agent or the
    // owner must keep working, and that kill path is the entire reason those
    // sessions are enrolled in the first place.
    //
    // The stakes are asymmetric and physical. We do not own a `vte-spawn`
    // scope's lifetime — the terminal window does — so reaping one of these
    // rows closes the owner's terminal window and takes the live agent inside
    // it with it. Auto-reaping was put to the owner in two forms
    // (reap-when-provably-dead, reap-fleet-spawned-only) and both were
    // declined. Do not widen this without a fresh owner ruling.
    const { reapable: tasks, exempt } = partitionReapableTasks(listed);
    const outcomes = await Promise.allSettled(
      tasks.map((task) => (deps.killTask ?? killTask)(task.taskId, { reapTerminalResidue: true })),
    );
    // Exempt rows are never SIGNALLED, but a row whose supervisor is provably
    // gone is still CLOSED — closing a ledger row touches no process, so the
    // exemption is intact. Without this every ordinary psu exit would reach the
    // reconciler as a `stranded` row, and a steady drip of routine shutdowns
    // filed as strands is exactly what buries the one real escape. A row whose
    // launcher is STILL ALIVE after its session ended is deliberately left open:
    // that is the zombie this feature exists to make visible.
    await (deps.closeAdoptedTerminalSessions ?? closeAdoptedTerminalSessions)(exempt).catch(() => ({
      closedTaskIds: [],
      stillLiveTaskIds: [],
    }));
    const reapedTaskIds: string[] = [];
    const failedTaskIds: string[] = [];
    for (let index = 0; index < tasks.length; index += 1) {
      const outcome = outcomes[index];
      if (outcome?.status === 'fulfilled' && outcome.value.ok) reapedTaskIds.push(tasks[index].taskId);
      else failedTaskIds.push(tasks[index].taskId);
    }
    return {
      taskIds: tasks.map((task) => task.taskId),
      reapedTaskIds,
      failedTaskIds,
      exemptTaskIds: exempt.map((task) => task.taskId),
    };
  };

  const primaryCoordinationDomain = row.cwd?.trim()
    ? lockDomainForProjectDir(row.cwd.trim())
    : fileLockCoordinationDomain();
  const [locks, workItems, tasks] = await Promise.allSettled([
    (deps.releaseLocks ?? releaseAllOwnedLocks)({ ownerId, primaryCoordinationDomain }),
    (deps.releaseWorkItems ?? releaseAllWorkItemLeasesForOwner)(ownerId),
    reapAgentSessionTasks(),
  ]);

  const failedEffects: Array<'locks' | 'work-items' | 'tasks'> = [];
  if (locks.status === 'rejected') failedEffects.push('locks');
  if (workItems.status === 'rejected') failedEffects.push('work-items');
  if (tasks.status === 'rejected' || tasks.value.failedTaskIds.length > 0) failedEffects.push('tasks');

  return {
    ok: failedEffects.length === 0,
    ...(failedEffects.length ? { reason: 'partial-failure' as const, failedEffects } : {}),
    ownerId,
    releasedPaths: locks.status === 'fulfilled' ? locks.value.released : [],
    resourcesReleased: locks.status === 'fulfilled' ? locks.value.resourcesReleased : 0,
    releasedWorkItems: workItems.status === 'fulfilled' ? workItems.value.releasedIds : [],
    claimsCleared: workItems.status === 'fulfilled' ? workItems.value.claimsCleared : 0,
    agentSessionTaskIds: tasks.status === 'fulfilled' ? tasks.value.taskIds : [],
    reapedTaskIds: tasks.status === 'fulfilled' ? tasks.value.reapedTaskIds : [],
    failedTaskIds: tasks.status === 'fulfilled' ? tasks.value.failedTaskIds : [],
    exemptTaskIds: tasks.status === 'fulfilled' ? tasks.value.exemptTaskIds : [],
  };
}

interface ScheduledLeaseCleanup {
  stopped: boolean;
  timer?: ReturnType<typeof setTimeout>;
  running?: Promise<void>;
}

function scheduleSessionEndLeaseReleaseAttempt(
  advSessionId: number,
  opts: SessionEndLeaseReleaseScheduleOptions,
  ownerLiveRetries: number,
  job: ScheduledLeaseCleanup,
): void {
  if (job.stopped) return;
  const delayMs =
    ownerLiveRetries === 0
      ? (opts.delayMs ?? SESSION_END_LEASE_RELEASE_DELAY_MS)
      : (opts.retryDelayMs ?? SESSION_END_LEASE_RELEASE_RETRY_DELAY_MS);
  job.timer = setTimeout(() => {
    job.timer = undefined;
    job.running = runSessionEndLeaseRelease(advSessionId, opts.deps)
      .then((result) => {
        // Resume can reopen the SAME row before this delayed pass, or create
        // a successor row. Both are successful continuation, not cleanup
        // failures, and neither should schedule another attempt or warn.
        if (result.reason === 'owner-resumed' || result.reason === 'row-not-ended') return;
        if (result.reason === 'owner-live') {
          const maxRetries = Math.max(
            0,
            opts.maxOwnerLiveRetries ?? SESSION_END_LEASE_RELEASE_MAX_OWNER_LIVE_RETRIES,
          );
          if (ownerLiveRetries < maxRetries) {
            scheduleSessionEndLeaseReleaseAttempt(advSessionId, opts, ownerLiveRetries + 1, job);
          } else {
            console.warn(
              `[session-end-lease-release] adv ${advSessionId} owner ${result.ownerId ?? 'unknown'} ` +
                `remained live after ${maxRetries} retry(ies); periodic lease reaper remains the backstop`,
            );
          }
          return;
        }
        if (!result.ok) {
          console.warn(
            `[session-end-lease-release] adv ${advSessionId} cleanup did not fully apply: ${result.reason ?? 'unknown'}`,
          );
          return;
        }
        const released =
          (result.releasedPaths?.length ?? 0) +
          (result.resourcesReleased ?? 0) +
          (result.releasedWorkItems?.length ?? 0) +
          (result.claimsCleared ?? 0) +
          (result.reapedTaskIds?.length ?? 0);
        if (released > 0) {
          console.log(
            `[session-end-lease-release] adv ${advSessionId} / ${result.ownerId}: released ` +
              `${result.releasedPaths?.length ?? 0} file path(s), ${result.resourcesReleased ?? 0} resource lock(s), ` +
              `${result.releasedWorkItems?.length ?? 0} work-item lease(s), ${result.claimsCleared ?? 0} claim row(s), ` +
              `${result.reapedTaskIds?.length ?? 0} agent-session task(s)`,
          );
        }
      })
      .catch((error) => {
        console.warn(
          `[session-end-lease-release] adv ${advSessionId} pass failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }, delayMs);
  job.timer.unref?.();
}

/** Schedule the post-end pass without delaying the exiting parent/report. */
export function scheduleSessionEndLeaseRelease(
  advSessionId: number,
  opts: SessionEndLeaseReleaseScheduleOptions = {},
): { stop(): Promise<void> } {
  const job: ScheduledLeaseCleanup = { stopped: false };
  scheduleSessionEndLeaseReleaseAttempt(advSessionId, opts, 0, job);
  return {
    async stop() {
      job.stopped = true;
      clearTimeout(job.timer);
      await job.running;
    },
  };
}
