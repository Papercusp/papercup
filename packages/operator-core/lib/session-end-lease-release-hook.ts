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
 * heartbeat, host, wake delivery, or process. Claims are deliberately excluded
 * from that oracle: a dead owner's own lease cannot prove the owner alive.
 */
import { getOrgPg } from '@papercusp/db-org';
import { releaseAllWorkItemLeasesForOwner } from './work-item-lease-release';
import { fileLockCoordinationDomain, lockDomainForProjectDir } from './agent-tools/locks/coordination-domain';
import { releaseAllOwnedLocks } from './agent-tools/locks/release-all-owned';

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
  coordOwnerId: string | null;
  cwd: string | null;
  endedAt: Date | null;
  ownerHasOpenSession: boolean;
}

export interface SessionEndLeaseReleaseDeps {
  loadRow?: (advSessionId: number) => Promise<SessionEndLeaseRow | null>;
  loadProtectedOwners?: () => Promise<ReadonlySet<string>>;
  releaseLocks?: typeof releaseAllOwnedLocks;
  releaseWorkItems?: typeof releaseAllWorkItemLeasesForOwner;
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
  failedEffects?: Array<'locks' | 'work-items'>;
}

async function loadSessionEndLeaseRow(advSessionId: number): Promise<SessionEndLeaseRow | null> {
  const { sql } = getOrgPg();
  const rows = await sql<
    Array<{
      id: number;
      coord_owner_id: string | null;
      cwd: string | null;
      ended_at: Date | string | null;
      owner_has_open_session: boolean;
    }>
  >`
    SELECT s.id, s.coord_owner_id, s.cwd, s.ended_at,
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
    coordOwnerId: row.coord_owner_id,
    cwd: row.cwd,
    endedAt: row.ended_at == null ? null : new Date(row.ended_at),
    ownerHasOpenSession: row.owner_has_open_session,
  };
}

async function loadProtectedOwners(): Promise<ReadonlySet<string>> {
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

  const protectedOwners = await (deps.loadProtectedOwners ?? loadProtectedOwners)();
  if (protectedOwners.has(ownerId)) return { ok: false, reason: 'owner-live', ownerId };

  const primaryCoordinationDomain = row.cwd?.trim()
    ? lockDomainForProjectDir(row.cwd.trim())
    : fileLockCoordinationDomain();
  const [locks, workItems] = await Promise.allSettled([
    (deps.releaseLocks ?? releaseAllOwnedLocks)({ ownerId, primaryCoordinationDomain }),
    (deps.releaseWorkItems ?? releaseAllWorkItemLeasesForOwner)(ownerId),
  ]);

  const failedEffects: Array<'locks' | 'work-items'> = [];
  if (locks.status === 'rejected') failedEffects.push('locks');
  if (workItems.status === 'rejected') failedEffects.push('work-items');

  return {
    ok: failedEffects.length === 0,
    ...(failedEffects.length ? { reason: 'partial-failure' as const, failedEffects } : {}),
    ownerId,
    releasedPaths: locks.status === 'fulfilled' ? locks.value.released : [],
    resourcesReleased: locks.status === 'fulfilled' ? locks.value.resourcesReleased : 0,
    releasedWorkItems: workItems.status === 'fulfilled' ? workItems.value.releasedIds : [],
    claimsCleared: workItems.status === 'fulfilled' ? workItems.value.claimsCleared : 0,
  };
}

function scheduleSessionEndLeaseReleaseAttempt(
  advSessionId: number,
  opts: SessionEndLeaseReleaseScheduleOptions,
  ownerLiveRetries: number,
): void {
  const delayMs =
    ownerLiveRetries === 0
      ? (opts.delayMs ?? SESSION_END_LEASE_RELEASE_DELAY_MS)
      : (opts.retryDelayMs ?? SESSION_END_LEASE_RELEASE_RETRY_DELAY_MS);
  const timer = setTimeout(() => {
    void runSessionEndLeaseRelease(advSessionId, opts.deps)
      .then((result) => {
        // An open successor is authoritative: its owner is intentionally
        // protected for this ended row, so retrying would only add timers.
        if (result.reason === 'owner-resumed') return;
        if (result.reason === 'owner-live') {
          const maxRetries = Math.max(
            0,
            opts.maxOwnerLiveRetries ?? SESSION_END_LEASE_RELEASE_MAX_OWNER_LIVE_RETRIES,
          );
          if (ownerLiveRetries < maxRetries) {
            scheduleSessionEndLeaseReleaseAttempt(advSessionId, opts, ownerLiveRetries + 1);
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
          (result.claimsCleared ?? 0);
        if (released > 0) {
          console.log(
            `[session-end-lease-release] adv ${advSessionId} / ${result.ownerId}: released ` +
              `${result.releasedPaths?.length ?? 0} file path(s), ${result.resourcesReleased ?? 0} resource lock(s), ` +
              `${result.releasedWorkItems?.length ?? 0} work-item lease(s), ${result.claimsCleared ?? 0} claim row(s)`,
          );
        }
      })
      .catch((error) => {
        console.warn(
          `[session-end-lease-release] adv ${advSessionId} pass failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }, delayMs);
  timer.unref?.();
}

/** Schedule the post-end pass without delaying the exiting parent/report. */
export function scheduleSessionEndLeaseRelease(
  advSessionId: number,
  opts: SessionEndLeaseReleaseScheduleOptions = {},
): void {
  scheduleSessionEndLeaseReleaseAttempt(advSessionId, opts, 0);
}
