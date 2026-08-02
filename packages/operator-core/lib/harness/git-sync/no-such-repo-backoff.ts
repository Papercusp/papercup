/**
 * no-such-repo-backoff.ts — EI-15333: don't re-dial a peer that definitively
 * said it does not have the store.
 *
 * `no-such-repo` is serve-wiring's `pathExists(join(repoPath, 'HEAD'))` verdict:
 * the peer genuinely does not have this repo's store on disk. That is not a
 * transient dial/connectivity failure, so re-dialing on the git-sync tick
 * cadence cannot change it — the answer only changes when something about the
 * PEER'S store changes, which does not happen on a ~5-minute clock.
 *
 * Both dialing legs share this state, and that is the point. It is the same
 * store on the same peer, so a refusal learned on either leg is evidence for
 * both:
 *
 *   - `runBootstrapLeg` — where EI-15333 originally landed. It returns early on
 *     an already-seeded store, so it storms only while a store is missing.
 *   - `runRefAnnounceLeg` — the leg that actually storms. It re-drives EVERY
 *     pending announcement on EVERY tick, and the fed-event cursor is HELD below
 *     the oldest failed row (EI-15335), so a permanently-refused announcement
 *     pins the cursor and the held backlog is re-dialed forever, growing as new
 *     announcements accumulate behind it. Live-caught 2026-08-02 on the tower:
 *     `hello-world-3-pot` held its cursor at 7431042 and re-dialed nine
 *     announcements from `Lm1ABoMRKVoo` every tick, each refused `no-such-repo`,
 *     for 8470 minutes (~5.9 days) without local progress. Wiring the backoff
 *     into the bootstrap leg alone was itself the bug — structurally the same
 *     miss as WI-6364 (fix C): a repair the stuck machine cannot reach is not a
 *     repair.
 *
 * BACKOFF, NOT CURSOR-ADVANCE. Advancing the fed-event cursor past a refused
 * announcement would silently drop a namespace that was never mirrored, which is
 * exactly what EI-15335's cursor hold exists to prevent. The hold is correct;
 * re-dialing INSIDE the hold is what was wrong. One dial per window still
 * self-heals the moment the peer gains the store.
 *
 * In-memory, per-process: resets harmlessly on restart (one extra dial next tick
 * costs nothing).
 */

/** 30 min ≈ 6 ticks at the ~5-min git-sync cadence: long enough to stop the
 *  spam and the wasted handshakes, short enough that a peer which later gains
 *  the store is picked up without operator action. */
export const NO_SUCH_REPO_BACKOFF_MS = 30 * 60 * 1000;

/**
 * Keyed by `repoKey`, the FEDERATED cross-device repo identity (WI-5168,
 * repo-identity.ts's `canonicalRepoKey`) — NOT the local install slug, which can
 * differ per device for the same repo. Pairing it with the peer's device pubkey
 * is what makes "this peer does not have THIS store" the unit being suppressed,
 * rather than the peer or the repo alone.
 */
export function noSuchRepoBackoffKey(repoKey: string, peerDevicePubkeyBase64: string): string {
  return `${repoKey}:${peerDevicePubkeyBase64}`;
}

const backoffUntil = new Map<string, number>();

/** Is this exact (repoKey, peer) pair inside its backoff window right now? */
export function isNoSuchRepoBackoffActive(key: string, nowMs: number = Date.now()): boolean {
  const until = backoffUntil.get(key);
  return until !== undefined && until > nowMs;
}

/** Seconds left in the window — for the operator line that explains the skip. */
export function noSuchRepoBackoffSecondsLeft(key: string, nowMs: number = Date.now()): number {
  const until = backoffUntil.get(key);
  return until === undefined ? 0 : Math.max(0, Math.ceil((until - nowMs) / 1000));
}

/** Arm (or re-arm) the window for a pair that just refused. */
export function armNoSuchRepoBackoff(key: string, nowMs: number = Date.now()): void {
  backoffUntil.set(key, nowMs + NO_SUCH_REPO_BACKOFF_MS);
}

/** A fetch failure as the arming decision needs to see it. */
export interface NoSuchRepoFailure {
  device: string;
  stderr: string;
}

/**
 * Which devices from this tick's failures should have their backoff armed.
 *
 * `dialed` is LOAD-BEARING, not defensive. A backoff SKIP is itself surfaced as
 * a fetch failure whose stderr NAMES `no-such-repo` — it has to, because that is
 * the diagnosis the operator needs to read. So arming off the stderr alone would
 * push the deadline to `now + WINDOW` on every single tick and the window would
 * never expire: a bounded backoff silently becomes PERMANENT suppression, and
 * the pair would never be retried even after the peer gains the store. Requiring
 * a real dial is the only thing that separates "the peer just told us" from "we
 * are quoting ourselves".
 *
 * Returned rather than applied so the decision is assertable without reaching
 * into module state.
 */
export function devicesToArmForNoSuchRepo(
  failures: readonly NoSuchRepoFailure[],
  dialed: ReadonlySet<string>,
): string[] {
  const armed: string[] = [];
  for (const f of failures) {
    if (!dialed.has(f.device)) continue;
    if (!f.stderr.includes('no-such-repo')) continue;
    if (!armed.includes(f.device)) armed.push(f.device);
  }
  return armed;
}

/** Test-only: clear all backoff state so cases don't leak into each other. */
export function __resetNoSuchRepoBackoffForTest(): void {
  backoffUntil.clear();
}
