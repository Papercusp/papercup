/**
 * carry-respawn-marker.ts — tell the SessionEnd/Stop lease-release fast path
 * (session-death-claim-release-2026-07-11 P-002) that an ending owner's
 * process is about to come back as the SAME logical agent, not die.
 *
 * ROOT CAUSE (EI-18676518990229124, evidenced live 2026-07-25): a carry-respawn
 * (`session:request-compaction` — deterministic-context-carry P-018/P-022)
 * KILLS the CLI child and relaunches it in the same pane under the SAME
 * `ownerId` seconds later. The killed child still fires the ordinary
 * SessionEnd/Stop lifecycle hook (`lifecycle-report.sh` → `activity:report`),
 * and `report.ts`'s P-002 branch treats EVERY SessionEnd as "this owner's
 * session just ended" / "this owner is confirmed dead" (its own doc comment,
 * work-item-lease-release.ts) — so it force-releases every work-item lease and
 * coordination claim the owner holds, UNCONDITIONALLY, via
 * `releaseAllWorkItemLeasesForOwner`. For a real death that is exactly right
 * (the P-001 backstop otherwise waits ~hourly). For a carry-respawn it is
 * wrong: the SAME owner resumes within ~1-2s (confirmed live: "■ session
 * ended" at 22:37:46.909, "▶ session started" at 22:37:48.321, same
 * `owner_id`) holding claims that just evaporated out from under it with no
 * notification — the exact 4x-in-45-minutes symptom the filer reported.
 *
 * Fix: `session:request-compaction` (the ONE place that both knows a
 * same-owner respawn is coming AND triggers the kill) marks the owner
 * "respawn expected" the instant its `injectIntoHost` call succeeds — BEFORE
 * the old process's SessionEnd hook can fire. `report.ts`'s P-002 branch
 * consumes (checks-and-clears) the marker first; when present, it skips the
 * force-release entirely (the successor keeps holding exactly what it held)
 * instead of stripping and silently orphaning the claim.
 *
 * Fail-safe by construction: the marker is single-use (consumed on read) and
 * short-TTL, so a respawn that never actually completes (the injected socket
 * write succeeded but the host never relaunched) still gets its claims freed —
 * just via the P-001 scheduled backstop instead of the P-002 fast path, which
 * is the ORIGINAL (pre-P-002) coverage for that case, not a new gap.
 *
 * In-memory + per-process: `session:request-compaction`'s `injectIntoHost`
 * call and the subsequent SessionEnd `activity:report` call both execute
 * in-process on the SAME operator (the psu-pty socket connect happens from
 * this process, and the ending child's hook POSTs back to this same
 * `PAPERCUSP_OPERATOR_URL`), so a module-scoped map is sufficient — no PG
 * round-trip needed for a signal that only ever needs to survive seconds
 * within one process.
 */

/** How long a "respawn expected" mark survives before it is treated as stale
 *  and ignored (the respawn either already happened — consumed — or failed,
 *  in which case P-001's backstop sweep is the correct recovery path). */
export const RESPAWN_EXPECTED_TTL_MS = 60_000;

const expected = new Map<string, number /* expiresAtMs */>();

/** Mark `ownerId` as about to be carry-respawned (its imminent SessionEnd is
 *  a scheduled continuation, not a death). Call this ONLY once the respawn is
 *  actually queued (e.g. after a successful `injectIntoHost`) — marking
 *  speculatively would suppress a real death's fast-path release. */
export function markRespawnExpected(ownerId: string, ttlMs = RESPAWN_EXPECTED_TTL_MS): void {
  if (!ownerId?.trim()) return;
  expected.set(ownerId, Date.now() + Math.max(0, ttlMs));
}

/** Check-and-clear: true iff `ownerId` was marked AND the mark hasn't expired.
 *  Single-use — a second SessionEnd for the same owner (e.g. a genuine death
 *  shortly after a completed respawn) is never suppressed by a stale mark. */
export function consumeRespawnExpected(ownerId: string): boolean {
  const exp = expected.get(ownerId);
  if (exp === undefined) return false;
  expected.delete(ownerId);
  return exp >= Date.now();
}

/** Test-only: drop every mark (isolate suites that share this module-level map). */
export function __resetRespawnExpectedMarkers(): void {
  expected.clear();
}
