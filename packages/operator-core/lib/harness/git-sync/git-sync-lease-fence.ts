/**
 * WI-10006724: the lease fence a git-sync fire checks before each Git command.
 *
 * A fire holds `git-sync:<slug>` (and its sibling resources) as a TTL lease that a
 * periodic heartbeat refreshes. Before this fence the heartbeat only LOGGED a refresh
 * that threw or came back refused, and the fire kept writing the index and refs. A
 * fire that has lost its lease is no longer the exclusive writer: the next tick or a
 * manual fire may legitimately acquire the resource and touch the same index.
 *
 * The fence turns "this fire can no longer prove it holds its lease" into a hard stop
 * before the NEXT Git command. It trips permanently on either:
 *  - `refused`: a refresh came back not-ok, so another owner holds the resource;
 *  - `unconfirmed`: no refresh was confirmed for `unconfirmedLimitMs`. The row may
 *    already have expired, and another fire may have acquired, written and released
 *    it in that gap, so a refresh that succeeds AFTER such a gap does not re-arm the
 *    fence (a same-owner refresh would silently re-grant an expired row).
 *
 * A refresh is confirmed as of when it was SENT, because the store extends the
 * expiry at statement time; that keeps the age measurement conservative.
 *
 * In-flight Git commands are deliberately not aborted: killing one mid-write can leave
 * an index.lock behind. The fence only refuses to START another one.
 */

export type GitSyncLeaseLossCause = 'refused' | 'unconfirmed';

export class GitSyncLeaseLostError extends Error {
  readonly code = 'git_sync_lease_lost';

  constructor(
    readonly slug: string,
    readonly leaseLossCause: GitSyncLeaseLossCause,
    readonly detail: string,
  ) {
    super(`git-sync ${slug}: lease lost (${leaseLossCause}): ${detail}; refusing further Git commands this fire`);
    this.name = 'GitSyncLeaseLostError';
  }
}

export interface GitSyncLeaseFence {
  /** The loss that tripped the fence, or null while the lease is provably held. */
  readonly lost: GitSyncLeaseLostError | null;
  /** Record a refresh the store accepted for every resource; `sentAt` is when it was sent. */
  confirm(sentAt: number): void;
  /** Trip the fence. The first loss wins; later calls return that same error. */
  markLost(cause: GitSyncLeaseLossCause, detail: string): GitSyncLeaseLostError;
  /** Throw the loss if tripped; first trips the fence if the last confirmation is too old. */
  assertHeld(): void;
}

export function createGitSyncLeaseFence(opts: {
  slug: string;
  /** A time no later than the lease's acquisition, so expiry >= acquiredAt + TTL. */
  acquiredAt: number;
  /** Longest tolerated gap between confirmations. Must be below the lease TTL. */
  unconfirmedLimitMs: number;
  now?: () => number;
}): GitSyncLeaseFence {
  const now = opts.now ?? Date.now;
  let lastConfirmedAt = opts.acquiredAt;
  let lost: GitSyncLeaseLostError | null = null;

  const markLost = (cause: GitSyncLeaseLossCause, detail: string): GitSyncLeaseLostError => {
    if (!lost) lost = new GitSyncLeaseLostError(opts.slug, cause, detail);
    return lost;
  };
  const tripIfStale = (at: number): void => {
    const gap = at - lastConfirmedAt;
    if (gap >= opts.unconfirmedLimitMs) {
      markLost('unconfirmed', `no lease refresh confirmed for ${gap} ms (limit ${opts.unconfirmedLimitMs} ms)`);
    }
  };

  return {
    get lost() {
      return lost;
    },
    confirm(sentAt: number): void {
      if (lost) return;
      tripIfStale(sentAt);
      if (!lost && sentAt > lastConfirmedAt) lastConfirmedAt = sentAt;
    },
    markLost,
    assertHeld(): void {
      if (!lost) tripIfStale(now());
      if (lost) throw lost;
    },
  };
}
