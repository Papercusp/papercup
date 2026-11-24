/**
 * release-hook-locks — release the AUTOMATIC per-edit file locks one owner holds,
 * leaving every deliberately-acquired lock alone.
 *
 * WHY THIS EXISTS (EI-21878494442396728, measured live 2026-08-30). The `PreToolUse`
 * edit hook acquires a per-file lock before every Edit/Write with a 20-minute TTL and
 * does NOT release it afterwards — the lease is the reclaim mechanism. A carry-respawn
 * (`session:request-compaction`) then kills the CLI child and relaunches it under the
 * SAME ownerId seconds later, so those locks outlive the process that took them.
 *
 * Nothing else frees them, and that is by design rather than by omission:
 *
 *  - `activity:report`'s SessionEnd fast path is deliberately SKIPPED for this
 *    transition by {@link ../../carry-respawn-marker} — the successor is the same
 *    logical agent and must keep its work-item leases.
 *  - the delayed {@link ../../session-end-lease-release-hook} refuses for the same
 *    reason one layer down: it returns `owner-resumed` the moment a newer open adv
 *    session exists for the owner, which a respawn guarantees within ~1-2s.
 *
 * Both refusals are CORRECT for leases and claims and WRONG for hook file locks. A
 * work-item lease denotes ownership of work that continues across the respawn; a
 * `PreToolUse:*` lock denotes an EDIT that died with the process. git-sync (correctly)
 * skips live-locked dirty paths, so the stranded locks silently starve the commit of
 * exactly the files the agent just wrote — for up to the full TTL — and
 * `work_items:complete` then stamps `completionAuthority:'proposed'` because the
 * declared `filesChanged` are uncommitted. Measured: two files skipped across FOUR
 * sweeps while git-sync committed their same-directory siblings.
 *
 * ⚠ WHY THE CALLER MUST BE THE RESPAWN POINT, NOT THE SESSION-END HOOK.
 * {@link ActiveLockRow} carries no session id — only `owner`. So a release keyed on
 * the owner cannot distinguish the DEAD session's locks from a SUCCESSOR's fresh ones,
 * and running it once a successor is live would delete locks protecting an in-flight
 * edit — handing git-sync a half-written file, the exact failure the lock plane exists
 * to prevent. It is safe at the carry-respawn inject point precisely because the cut is
 * idle-gated: the successor does not exist yet, and the current process is between tool
 * calls, so every `PreToolUse:*` lock it holds belongs to an edit that already returned.
 * Do not lift this call to a site where two sessions can share an ownerId.
 *
 * SCOPE. Only `intent LIKE 'PreToolUse:%'` (the label pinned by
 * {@link ./hook-intent-label}) is released. A deliberate `locks:acquire` — the
 * multi-file change a playbook tells an agent to hold across the commit — and every
 * named-resource lock (a `git-sync:<slug>` pause, a `dev:restart` drain) survive
 * untouched. Releasing those on a respawn would break work the successor is meant to
 * resume holding.
 */
import type { ActiveLockRow } from './su-lock-store';
import { ensureBootstrap, getTxPool, readQueue, tryRelease } from './su-lock-store';
import { inWorkspaceTxn } from './in-workspace-txn';
import { acquireWithContentionRetry } from './contention-retry';
import { notifyPlanLockChange } from './notify-lock-change';
import { noteShaTokenRelease } from '../../authority/sha-token-registry';

/** The intent prefix the automatic edit hook writes — see ./hook-intent-label. */
export const HOOK_LOCK_INTENT_PREFIX = 'PreToolUse:';

export interface ReleaseHookLocksResult {
  /** Paths whose hook lock was released, across every coordination domain. */
  released: string[];
  /** Hook locks this owner held before the release (0 ⇒ nothing to do). */
  heldBefore: number;
  /** Deliberate (non-hook) file locks left deliberately untouched. */
  preservedDeliberate: number;
}

/** True for a lock the automatic edit hook took, false for a deliberate acquire. */
export function isHookLockIntent(intent: string | null | undefined): boolean {
  return typeof intent === 'string' && intent.startsWith(HOOK_LOCK_INTENT_PREFIX);
}

/**
 * Partition one owner's active locks into the hook-acquired set and the deliberate
 * remainder. Exported for the test seam so the classification can be asserted without
 * a live lock plane.
 */
export function partitionHookLocks(rows: readonly ActiveLockRow[], ownerId: string): {
  hookLocks: ActiveLockRow[];
  preservedDeliberate: number;
} {
  const mine = rows.filter((row) => row.owner === ownerId);
  const hookLocks = mine.filter((row) => isHookLockIntent(row.intent));
  return { hookLocks, preservedDeliberate: mine.length - hookLocks.length };
}

/**
 * Release every `PreToolUse:*` file lock held by `ownerId`, in every coordination
 * domain that holds one.
 *
 * Reads across ALL domains (`coordinationDomain: null`) for the reason
 * {@link ./live-lock-paths} documents: the domain resolves from whichever checkout the
 * operator process loaded, so a domain-scoped read reports a genuinely-held lock as
 * absent (observed live — an agent editing the staging tree had its lock recorded under
 * `…/papercup-release`). Missing a real holder is the whole failure mode here.
 *
 * Fail-soft is the caller's contract, not this function's: it throws on a lock-plane
 * fault so a caller that wants to distinguish "nothing held" from "could not read" can.
 * The carry-respawn caller swallows it — a missed release degrades to today's behaviour
 * (the lease expires) rather than failing the compaction the agent asked for.
 */
export async function releaseOwnerHookFileLocks(params: {
  ownerId: string;
  /**
   * Release only the hook locks on these files (repository-relative, or absolute). The
   * work-item close passes the files it declares: the close itself says those edits are
   * finished, while the same session may have another edit in flight elsewhere. Omitted, every
   * hook lock the owner holds is released, which is right only where no edit can be in flight
   * (the carry-respawn point).
   */
  paths?: readonly string[];
}): Promise<ReleaseHookLocksResult> {
  const ownerId = params.ownerId.trim();
  if (!ownerId) return { released: [], heldBefore: 0, preservedDeliberate: 0 };
  if (params.paths && params.paths.length === 0) return { released: [], heldBefore: 0, preservedDeliberate: 0 };

  await ensureBootstrap();
  const queue = await readQueue(getTxPool(), { coordinationDomain: null });
  const owned = partitionHookLocks(queue.active_locks, ownerId);
  const named = params.paths ? new Set(params.paths.map((path) => path.replace(/^\.\//, ''))) : null;
  const hookLocks = named
    ? owned.hookLocks.filter((row) => named.has(row.path) || named.has(`${row.coordination_domain.replace(/\/$/, '')}/${row.path}`))
    : owned.hookLocks;
  const { preservedDeliberate } = owned;
  if (hookLocks.length === 0) {
    return { released: [], heldBefore: 0, preservedDeliberate };
  }

  // One release per lock set. The store releases by `lock_id` (optionally narrowed to paths)
  // or everything an owner holds, and nothing else: a selector of paths alone is refused with
  // "locks:release requires lock_id or all_mine". This function passed paths alone, so from
  // the day the store dropped that selector every call here threw, the carry-respawn caller
  // swallowed it, and no hook lock was released at any respawn. `all_mine` is not the answer
  // either: it would drop the deliberate holds this function exists to keep. Naming the
  // paths with the id keeps the release exact when a deliberate acquire shares a lock id
  // with a hook's (the store reuses an owner's id for a path it already holds).
  const byLockSet = new Map<string, { domain: string; lockId: string; paths: string[] }>();
  for (const row of hookLocks) {
    const key = `${row.coordination_domain}\0${row.lock_id}`;
    const set = byLockSet.get(key) ?? { domain: row.coordination_domain, lockId: row.lock_id, paths: [] };
    set.paths.push(row.path);
    byLockSet.set(key, set);
  }

  const released: string[] = [];
  for (const { domain, lockId, paths } of byLockSet.values()) {
    const outcome = await acquireWithContentionRetry(() =>
      inWorkspaceTxn(domain, ownerId, (tx) =>
        tryRelease(tx, { coordinationDomain: domain, owner: ownerId, lockId, paths }),
      ),
    );
    if (outcome.released.length > 0) {
      released.push(...outcome.released);
      // Mirror the all-owned seam: a released path must wake its waiters and drop any
      // sha token, or the next holder sees a stale plan-lock view.
      noteShaTokenRelease(domain, outcome.released, null, Date.now());
      notifyPlanLockChange(outcome.released);
    }
  }

  return { released, heldBefore: hookLocks.length, preservedDeliberate };
}
