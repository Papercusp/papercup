/**
 * git-sync-events — the git-sync commit signal through the await-event primitive
 * (event-await-discoverability-and-coverage-2026-07-03 P-102).
 *
 * When git-sync actually commits the shared tree (`status: 'synced'`), two keys fire:
 *
 *   `git-sync:committed` — the GLOBAL "a commit just landed" signal: any agent that
 *   left an edit in the tree and wants to know "is my edit committed to origin/staging
 *   yet" awaits this and is WOKEN on the next successful sync, instead of polling
 *   `dev:pipeline_position`. The waiter checks `payload.sha` to see which commit.
 *
 *   `git-sync:committed:<sha>` — the PRECISE per-sha key: an agent that already knows
 *   the head sha it cares about (e.g. handed one by a peer) awaits exactly it and wakes
 *   only for that commit — no payload-filtering the global stream.
 *
 * Called fire-and-forget from the git-sync action's per-tick funnel; an emit failure
 * can never break a sync. A duplicate emit (a resumed DBOS fire replaying past the
 * record checkpoint) is benign: await keys are one-shot WAKE subscriptions, so a
 * second fire with no live waiter is a no-op and a re-fire just re-wakes.
 */

import { emitAwaitedEvent } from '../../events/await/engine';

/**
 * Errors that are EXPECTED for a best-effort, fire-and-forget notification and so must
 * never warn (vitest-fail-on-console would then flake any rig test): a partial test
 * schema (a projection table the emit touches is absent → "… does not exist"), or the
 * emit's async query outliving the Postgres pool it ran on (a rig tearing down mid-emit
 * → postgres.js CONNECTION_ENDED/CONNECTION_DESTROYED). Anything else is a real surprise.
 */
function failSoft(scope: string, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  if (/does not exist/.test(msg)) return;
  const code = (e as { code?: unknown } | null)?.code;
  if (
    code === 'CONNECTION_ENDED' ||
    code === 'CONNECTION_DESTROYED' ||
    /CONNECTION_ENDED|CONNECTION_DESTROYED|Connection ended/i.test(msg)
  ) {
    return;
  }
  console.warn(`[git-sync-events] ${scope} emit failed: ${msg}`);
}

/** Injectable seam for tests. */
export interface GitSyncEventsDeps {
  emit?: typeof emitAwaitedEvent;
}

/**
 * Fire the git-sync commit events for a landed head `sha`. Emits BOTH the global
 * `git-sync:committed` (payload-filtered) and the precise `git-sync:committed:<sha>`.
 * Fire-and-forget; never throws.
 */
export function emitGitSyncCommittedEvent(sha: string, deps: GitSyncEventsDeps = {}): void {
  const emit = deps.emit ?? emitAwaitedEvent;
  const shortSha = sha.slice(0, 12);
  void Promise.resolve()
    .then(async () => {
      const summary = `git-sync committed ${shortSha} to origin/staging`;
      const payload = { sha };
      // GLOBAL key — wake on the NEXT commit of any sha (payload.sha says which).
      await emit({ key: 'git-sync:committed', summary, payload, source: 'git-sync' });
      // PER-SHA key — wake only for THIS commit.
      await emit({ key: `git-sync:committed:${sha}`, summary, payload, source: 'git-sync' });
    })
    .catch((e: unknown) => failSoft(`committed-event for ${shortSha}`, e));
}
