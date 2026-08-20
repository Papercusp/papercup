/**
 * git-sync-events — the git-sync commit/egress signals through the await-event primitive
 * (event-await-discoverability-and-coverage-2026-07-03 P-102).
 *
 * When git-sync actually commits the shared tree (`status: 'synced'`), two LOCAL
 * commit keys fire:
 *
 *   `git-sync:committed` — the GLOBAL "a commit just landed" signal: any agent that
 *   left an edit in the tree and wants to know "is my edit a local git commit yet"
 *   awaits this and is WOKEN on the next successful local sync. The waiter checks
 *   `payload.sha`, `payload.installSlug`, and `payload.workspaceId` to see which
 *   commit and harness produced it.
 *
 *   `git-sync:committed:<sha>` — the PRECISE per-sha key: an agent that already knows
 *   the head sha it cares about (e.g. handed one by a peer) awaits exactly it and wakes
 *   only for that local commit — no payload-filtering the global stream.
 *
 * A BRIDGED hive has a distinct, later proof point. After the GitHub bridge confirms
 * that canonical staging was pushed (or was already at the same sha), these fire:
 *
 *   `git-sync:egressed` and `git-sync:egressed:<sha>` — truthful origin/staging
 *   egress signals. A local commit must never imply these; p2p-only hives do not have
 *   a GitHub egress leg at all. Both global keys carry the same harness/workspace
 *   scope so a waiter in one harness cannot wake on another harness's tick.
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

export interface GitSyncEventScope {
  /** The local harness/install slug that owns the git-sync routine. */
  installSlug: string;
  /** The workspace that owns the harness/install. */
  workspaceId: string;
}

/** Injectable seam for tests. */
export interface GitSyncEventsDeps {
  emit?: typeof emitAwaitedEvent;
  /** Production callers must provide the concrete harness/workspace scope. */
  scope: GitSyncEventScope;
}

function emitGitSyncEventPair(
  kind: 'committed' | 'egressed',
  sha: string,
  summary: string,
  deps: GitSyncEventsDeps,
): void {
  const emit = deps.emit ?? emitAwaitedEvent;
  const shortSha = sha.slice(0, 12);
  void Promise.resolve()
    .then(async () => {
      const payload = { sha, ...deps.scope };
      await emit({ key: `git-sync:${kind}`, summary, payload, source: 'git-sync' });
      await emit({ key: `git-sync:${kind}:${sha}`, summary, payload, source: 'git-sync' });
    })
    .catch((e: unknown) => failSoft(`${kind}-event for ${shortSha}`, e));
}

/**
 * Fire the git-sync commit events for a landed head `sha`. Emits BOTH the global
 * `git-sync:committed` (payload-filtered) and the precise `git-sync:committed:<sha>`.
 * Fire-and-forget; never throws.
 */
export function emitGitSyncCommittedEvent(sha: string, deps: GitSyncEventsDeps): void {
  const shortSha = sha.slice(0, 12);
  emitGitSyncEventPair('committed', sha, `git-sync committed ${shortSha} in the local harness checkout`, deps);
}

/**
 * Fire only after the GitHub bridge proves `sha` is the remote staging head by a
 * successful push or an up-to-date comparison. Emits BOTH the global
 * `git-sync:egressed` key and the precise `git-sync:egressed:<sha>` key.
 * Fire-and-forget; never throws.
 */
export function emitGitSyncEgressedEvent(sha: string, deps: GitSyncEventsDeps): void {
  const shortSha = sha.slice(0, 12);
  emitGitSyncEventPair('egressed', sha, `git-sync egressed ${shortSha} to origin/staging`, deps);
}
