/**
 * WI-6554700010049067: turn the git-sync tick-start sweep's KEPT over-age Git
 * metadata locks into level-triggered coord conditions.
 *
 * The sweep (`sweepStaleGitMetadataLocks`) only unlinks a lock it can prove is an
 * empty, holderless leftover. A lock that is old but nonempty, held open, or of
 * unknown holder is left in place — correctly — but before this module that
 * verdict only reached a log line, so a stuck lock could block every Git write in
 * the repo with nobody told.
 *
 * One condition per lock PATH: two stuck locks are two alarms, and the same lock
 * seen on the next tick is a heartbeat on the open condition, not a new alarm.
 * The summary is deliberately age-free so a repeat tick folds into the open
 * condition instead of re-broadcasting (`broadcastSevereEvent` compares summaries).
 * The condition clears through the family-agnostic resolve-on-absence reconciler
 * (EI-15182 guard #3) once the lock stops being kept and the heartbeat stops.
 */
import { createHash } from 'node:crypto';
import type { SevereEventBroadcast } from '../../severe-event-broadcast';
import type { KeptStaleGitMetadataLock } from './run-git-sync';

export const KEPT_STALE_GIT_LOCK_CONDITION_PREFIX = 'alarm:git-sync-kept-stale-lock';

/** Stable condition key for one kept lock; the full path is hashed, never cut. */
export function keptStaleGitLockConditionKey(slug: string, lockPath: string): string {
  const digest = createHash('sha256').update(lockPath).digest('hex').slice(0, 24);
  return `${KEPT_STALE_GIT_LOCK_CONDITION_PREFIX}:${slug}:${digest}`;
}

export type KeptStaleGitLockBroadcast = (ev: SevereEventBroadcast) => Promise<boolean>;

async function defaultBroadcast(ev: SevereEventBroadcast): Promise<boolean> {
  const { broadcastSevereEvent } = await import('../../severe-event-broadcast');
  return broadcastSevereEvent(ev);
}

/** Raise (or heartbeat) one condition per kept over-age lock. Every lock is
 *  reported; an empty list is a no-op. */
export async function reportKeptStaleGitLocks(
  slug: string,
  repoPath: string,
  keptStale: readonly KeptStaleGitMetadataLock[],
  broadcast: KeptStaleGitLockBroadcast = defaultBroadcast,
): Promise<void> {
  for (const lock of keptStale) {
    const ageMin = Math.round(lock.ageMs / 60_000);
    await broadcast({
      conditionKey: keptStaleGitLockConditionKey(slug, lock.path),
      summary: `git-sync ${slug}: over-age Git lock ${lock.name} kept (${lock.reason}) — needs an operator`,
      body:
        `The git-sync tick-start sweep found ${lock.path} about ${ageMin}m old and left it in place because it ` +
        `could not prove the lock orphaned (reason: ${lock.reason}). While it exists, Git writes in ${repoPath} that ` +
        `need this lock fail. Check for a holder with \`fuser ${lock.path}\`; if no live git process holds it and it ` +
        'is not a write in progress, remove it. git-sync never deletes a nonempty, held, or unprovable lock itself ' +
        '(WI-6554700010049067).',
      data: {
        source: 'git-sync-metadata-lock-sweep',
        slug,
        repoPath,
        lock: lock.name,
        path: lock.path,
        ageMs: lock.ageMs,
        reason: lock.reason,
      },
    });
  }
}
