# Learning snapshot crash — verified fix

Work: `EI-22569766397606182`, found during `WI-2146962` / `portal-design-iteration-2026-09-05` acceptance.

The Learning tab's Improve view treated the first resolved sync row as a complete digest. An unavailable, metadata-only, or partial snapshot could therefore reach `digest.window.byState` (and array iteration) before the existing error branch rendered. The live failure reproduced after a settled read, with `TypeError: Cannot read properties of undefined (reading 'byState')`. This was a data-shape failure, not an established theme defect.

The fix checks the required digest window before consuming the row and reuses `snapshotFault`. Fault and incomplete rows now take the existing retryable **Improve unavailable** path and report bad status. They cannot become a healthy empty queue. A subsequent complete digest restores the ordinary dashboard. No new parallel error mechanism was introduced.

## Verification

- Three added component cases cover unavailable provenance, metadata without data, and a missing window. Before the change they reproduced array/byState crashes; after it they verify the retry action and recovery when complete data arrives.
- Full `LearningTab.test.tsx`: **110 passed, no skipped tests**. The initial focused reproduction intentionally ran only the three new cases; it is not a full-suite claim.
- Scoped TypeScript: both changed files routed to the operator-vite checker, clean.
- `git diff --check`: clean.
- The guarded Portal build succeeded. New release: `8yDtR949AGueJCPe7Q-EU-20260907030928688-3439458-d4ea1813`.
- `deploy-cloud-portal.sh --handoff` confirmed the source-root digest, restarted the stale service onto the artifact, and passed the health check.
- The new client chunk `1639.3dac924015488716.js` contains the added `Incomplete Improve snapshot` guard.
- A fresh browser on live `:3081` at 1280×800 rendered the Learning interface with **Improve unavailable** and its retry action, rather than the whole-surface crash. It emitted no page errors. The screenshot was opened and inspected. This verifies truthful handling of a unavailable read; it does not assert that the underlying read is healthy.

Before evidence: [settled recheck](acceptance-current-2026-09-07/settled-rechecks.json) and [failure image](acceptance-current-2026-09-07/settled-learning--dark--1440x900.png).
After evidence: [live result](acceptance-final-2026-09-07/learning-fix-live.json) and [live image](acceptance-final-2026-09-07/learning-fix-live.png).

Logs: `/tmp/portal-learning-regression-before.log`, `/tmp/portal-learning-regression-after.log`, `/tmp/portal-learning-types.log`, `/tmp/portal-learning-build.log`, `/tmp/portal-learning-handoff.log`.

The Portal root digest remains `747c93d7b8a102f7237152873f4509114433d5598273f1b7132e4b94e8befc78`. Its writer deliberately excludes linked packages; that value alone cannot establish that a linked LearningTab change shipped. The new compiled marker, release identity, supported handoff and actual live behavior provide that additional evidence. Linked-dependency drift warnings from the guarded build remain in its log.

The new build was required for this newly discovered crash. The previously completed popup and Inbox work `WI-10000338` was not reimplemented or reopened. The plan's final grading and author acceptance remain separate, unfinished steps.
