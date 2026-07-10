/**
 * stage-stall-log.ts — named-hop pipeline observability, formalized as a
 * shared primitive (fleet-reliability-verification-2026-07-10 P-012).
 *
 * ORIGIN: `outbox-drain.ts`'s WI-3619 fix. WI-2009's `DRAIN_PASS_TIMEOUT_MS`
 * watchdog could name that a drain PASS hung, but not WHICH stage inside it
 * (the journal said "hung await (keychain unwrap / epoch-key resolution /
 * append)" and left the operator guessing). WI-3619 wrapped every await
 * inside the send-side drain pass with a one-shot stall logger: if the await
 * is still pending after `STAGE_STALL_LOG_MS`, a loud grep-able line names
 * the exact stage — turning "a pass hung" into "THIS specific await hung",
 * diagnosable from the journal alone even when the await never settles (a
 * log-after-completion line would never fire on a truly wedged await).
 *
 * This module lifts that pattern out of outbox-drain.ts (its one prior
 * consumer) so every OTHER federation hop can adopt the same instrumentation
 * without re-deriving it. Generalize: any pipeline stage with a serialized,
 * single-flight-per-tick await loop (capture → drain → replicate → merge →
 * member-guard → project) is a candidate — wrap its awaits with
 * `logIfStageStalls(scope, stageName, promise)` so a wedged hop NAMES ITSELF
 * in the journal instead of presenting only as "the whole pipeline went
 * quiet". See also: `hive-git-p2p-ops-runbook-2026-07-09.mdx` § Named-hop
 * pipeline observability.
 *
 * Current adopters:
 *   - `outbox-drain.ts` (send-side / drain stage) — the original WI-3619 site.
 *   - `read-merge.ts` (merge stage / `applyRecordingWinner`) — the projection
 *     `apply()` call is an unbounded PG write with the same hang shape as the
 *     drain's `append()` (a wedged connection / lock never resolves), so it
 *     gets the same treatment (P-012).
 *
 * NOT yet adopted (candidates for a follow-up, scoped deliberately out of
 * P-012's first pass — see the work-item's completion notes):
 *   - capture (Stage 1, a synchronous PG trigger — no long-lived await to name);
 *   - Hypercore replication itself (framework-internal, not this codebase's
 *     await to wrap);
 *   - member-guard / admission checks (github-ingress-admission.ts,
 *     contribution-admission.ts) — worth a pass once a live wedge is observed
 *     there, per this module's "log the failure class you've actually seen"
 *     philosophy rather than pre-emptively wrapping every await in the repo.
 */

/** Default stall-log threshold: an await pending this long gets a named,
 *  grep-able journal line. Shared across every adopter unless a specific
 *  stage has a reason to override it (pass a different `thresholdMs`). */
export const STAGE_STALL_LOG_MS = 15_000;

/**
 * Race `p` against a one-shot logging timer: if `p` has not settled after
 * `thresholdMs`, emit a loud `console.error` naming `scope` + `stage` (so a
 * hung pipeline names the exact await that's wedged), then keep waiting for
 * `p` itself — this NEVER times out or rejects `p`; it only adds an
 * observability side-channel. Silent on the healthy path (the timer is
 * cleared as soon as `p` settles, one way or the other).
 *
 * `scope` should identify the pipeline instance (e.g.
 * `${workspaceId}::${harnessSlug}`); `stage` should name the specific await
 * (e.g. `hypercore-append (row id=… table=…)`, `merge-apply (table=… key=…)`)
 * so the resulting line is directly actionable: "THIS stage, on THIS scope,
 * has been hung for THIS long."
 */
export async function logIfStageStalls<T>(
  scope: string,
  stage: string,
  p: PromiseLike<T>,
  thresholdMs: number = STAGE_STALL_LOG_MS,
): Promise<T> {
  const timer = setTimeout(() => {
    console.error(
      `[stage-stall] STAGE STALL for ${scope}: '${stage}' still pending after ` +
        `${thresholdMs}ms — this is the hung await (named-hop pipeline observability, P-012)`,
    );
  }, thresholdMs);
  timer.unref?.();
  try {
    return await p;
  } finally {
    clearTimeout(timer);
  }
}
