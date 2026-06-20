# findings-PR5 — Internal fork→PR dogfood (Brief PR-5)

**Owner:** pr5-impl (this lane). **Plan:** `PLAN-pr-system-completion-dogfood.md` (Phase PR-5).
**Last updated:** 2026-06-20. **coord MCP:** down — status here + on-disk artifacts is the channel.

## 📓 Autonomous-session work log (pr5-impl, 2026-06-20 — owner asleep, full auto)
After PR-1..5 completed, picked up adjacent PR-system queue work from `ideas-pr-system-followups.md`:
- **#3 inbound-pipeline integration smoke test — SHIPPED** (`pr-host/inbound-pipeline.test.ts`, 5 tests):
  wires the REAL `runAgentReview` (mock LLM) through the daemon → in-memory report store → gate →
  revocation → approve/merge. Complementary to `poll-daemon.test.ts` (which stubs the reviewer);
  reconciled with pr3-impl on the followups doc.
- **GAP-1 per-harness revocation boundary — RESOLVED via consensus (b)+log** with pr3-impl:
  documented the design boundary in `contribution-admission.ts` + a fail-safe observability warn
  (non-hive harness with substrate revocations → loud log, decision unchanged). 3 teeth tests.
- PR-system suite now **378 green** (22 files). Followups queue: #1/#2 offered by pr3-impl, #4 done,
  #5 = live run (owner env). Next per the priority ladder: peer handoffs (`handoff-*.md`) / RELEASE-READINESS.

## 🔁 LOOP WATCHDOG (read first if resuming via /loop "continue where you left off")
**PR-1..5 are ALL complete + verified — there is no implementation work left.** PR-5 is done; PR-1/2/3/4
landed by their lanes; the only remaining step is the LIVE run (needs a running operator install, the
runbook below). So the loop's job is now a **regression watchdog** over the PR-system in this hot,
multi-lane tree (peers actively edit shared files: `auto-approve.ts`, `auto-merge.ts`, `prs.ts`,
`poll-daemon.ts`). Each tick:
1. `cd packages/operator-core && npx vitest run lib/pr-host lib/harness/fork-gc.test.ts lib/agent-tools/platform`
   and `cd apps/operator && npx vitest run app/harness/PrsTab.component.test.tsx app/harness/PrReviewerSettings.test.ts`
2. **Baseline = 367 (operator-core) + 15 (UI) green.** If all green → report one line ("watchdog green")
   and do nothing else. If a peer broke a PR-5 invariant (revocation gate, fork GC, witness, the daemon
   `authorRevoked` refusal), FIX it (it's mine) and re-verify; otherwise flag the owning lane in this file.
3. Do NOT invent new scope or re-polish complete lanes. If the owner wants the live run or new work, they
   will say so. Consider stopping the loop (CronDelete) if it adds no value.

## Status: 🟢 PR-5 BUILT + teeth-verified · 🟢 inbound spine (PR-1..4) LANDED · 🟡 live run needs a running operator

PR-5 is the FINAL phase; its live witness depended on the inbound side (PR-1..4). As of 2026-06-19
the fleet landed all of it IN THIS TREE: **PR-1** `pr-host/poll-daemon.ts` + `pr-poll-routine.ts`
(the autonomous notice→review→merge spine — `registerSystemAction('pr-poll')`, last-seen guard,
backoff, `decideAutoReview`→`tryAutoApprove`/`tryAutoMerge`, reviewer trigger, report veto);
**PR-2** `agent-reviewer.ts` + `pr-review-report-store.ts`; **PR-4** `feature-pr-producer.ts` +
`agent-trailer.ts` + `operator-rate-key.ts`. So the loop can now round-trip autonomously. The only
thing left for the LIVE witness is running it on an operator install with `gh` auth (runbook below) —
that's the monitor/owner's environment, not a code gap.

**108 tests green** across the PR-system: `npx vitest run lib/pr-host/{contribution-admission,
dogfood-roundtrip,auto-approve,auto-merge,poll-daemon,pr-poll-routine}.test.ts
lib/harness/fork-gc.test.ts lib/agent-tools/platform/fork_gc.test.ts`.

### S0 gap I FOUND + CLOSED in PR-1 (cross-lane integration)
PR-1's `pollHarnessPrs` built `approveCtx`/`mergeCtx` WITHOUT `authorRevoked` — so the **autonomous**
path bypassed the revocation gate (only the manual `reviewPr` route was protected). A revoked
contributor's trusted+green PR would have auto-merged. Closed it: added an `isAuthorRevoked` seam
(default `isPrAuthorRevoked`) + a per-PR refusal in the loop (`counts.revoked`, ahead of trust/checks/
report) + 3 teeth tests. Revocation now has teeth on BOTH paths — the S0 invariant holds end-to-end.

## What landed this lane (62 teeth tests green)

| Item | What | Files | Teeth |
|---|---|---|---|
| **PR-5.4** Revocation has teeth (code plane) | A revoked Hive contributor now LOSES contribution admission on the fork→PR path. Was a silent no-op: substrate read-revocation shipped, but `tryAutoApprove`/`tryAutoMerge` + the manual `reviewPr` route never consulted the revoked set. | `pr-host/contribution-admission.ts` (+`.test`), edits to `auto-approve.ts`, `auto-merge.ts`, `routes/harness/prs.ts` | 13 + 4 |
| **PR-5.3** Fork cleanup / GC | KEEP-on-merge + stale-fork GC (plan D-3). Never deletes an active fork (open PR), a recently-pushed one, or another account's repo. Dry-run by default. | `harness/fork-gc.ts` (+`.test`), `agent-tools/platform/fork_gc.ts` (+`.test`), registered in `agent-tools/index.ts` | 13 + 6 |
| **PR-5.2** Round-trip WITNESS | Programmatic "did the loop round-trip" check — the brief's Done assertion (WI shows shipped + linked PR). Decoupled from PR-2/PR-4's landing modules via injected reader seams. | `pr-host/dogfood-roundtrip.ts` (+`.test`) | 8 |

Run them: `cd packages/operator-core && npx vitest run lib/pr-host/contribution-admission.test.ts lib/harness/fork-gc.test.ts lib/agent-tools/platform/fork_gc.test.ts lib/pr-host/dogfood-roundtrip.test.ts lib/pr-host/auto-merge.test.ts lib/pr-host/auto-approve.test.ts`

## The S0 invariants (PR-5 owns these)
- **A revoked contributor cannot merge.** `isHiveContributorRevoked` ⇒ `reviewPr` returns 403 +
  `tryAutoApprove`/`tryAutoMerge` short-circuit `skipped_revoked` BEFORE the trust/checks gates.
  Teeth: drop the `authorRevoked` gate → a revoked author's approved+green PR merges = RED.
- **GC never touches an active or foreign fork.** Teeth: an open-PR fork / recent push → `keep_*`;
  only an abandoned (no PR, stale) operator-owned fork → `collect`; deletion is off without `confirm`.
- **The loop round-trips** = `verifyDogfoodRoundTrip().ok` (prTracked ∧ merged ∧ shipped ∧ linked).

## The LIVE dogfood loop — runbook (run on the operator install with `gh` auth)

PR-5.1 (stand papercup up as its own self-hive) is step 1 here — the code (`enable-platform-mode.ts`,
`platform:enable`, slug `papercusp-platform`) is packaged + tested; it has just never been RUN
internally. Standing it up is a runtime action, not a code gap.

1. **Enable platform mode.** `platform:enable { confirm:true, reason:"dogfood the member path" }`
   → stands `papercup` up as a `kind:'hive'` self-hive (`papercusp-platform` / home
   `papercusp-platform-hive`, canonical `github.com/Papercusp/papercup.git`), flag on, loops armed dark.
2. **Contribute AS A MEMBER (no canonical write).** A Bee makes a real change in the self-hive member
   clone, then `platform:contribute { kind:'pr', confirm:true, reason:"…" }` → commits to the
   operator's FORK + opens a fork→canonical PR. (Outbound leg — BUILT.)
3. **Daemon notices → reviews → owner-mode.** PR-1's `system:pr-poll` routine (per harness with
   `pr_reviewer_role_enabled`) notices the PR, upserts `harness_feature_prs` (PR-4), refreshes the
   check cache, triggers PR-2's agent-review (report stored), and evaluates `decideAutoReview`. In
   `manual` mode it surfaces the report in the PRs tab (PR-3) for the owner to Approve; in `auto` mode
   it drives `tryAutoApprove`+`tryAutoMerge` — gated on checks-green + trusted author + **not revoked**.
4. **Merge to canonical.** Owner Approves in the PRs tab → `reviewPr` (`approve_and_merge`) →
   `tryAutoMerge` (checks-green gate) → `stampCompletionRefOnMerge` + `markFeaturePrState('merged')`.
5. **Assert the round-trip.** `platform:dogfood_verify { prUrl }` (defaults harness to
   `papercusp-platform`, wires PR-2's report reader) → expect `ok:true`. (Equivalent to calling
   `verifyDogfoodRoundTrip({...prUrl, readReviewReport: defaultReadReviewReport})` directly.)
6. **Tidy.** `platform:fork_gc { reason:"…" }` (dry-run report) → `{ confirm:true }` to collect any
   abandoned forks.

## Asks for the fleet / monitor
- **Run the LIVE witness.** Everything is code-complete + teeth-green; the remaining step is running
  the runbook on an operator install with `gh` auth (the monitor's .deb/Xvfb environment). Drive
  steps 1–6 and assert `verifyDogfoodRoundTrip(...).ok === true` for the contributed PR.
- **PR-1 owner — heads up:** I added an `isAuthorRevoked` seam to `pollHarnessPrs` + a per-PR
  revocation refusal (the autonomous path was missing it; the manual `reviewPr` path already had it).
  Coexists with your last-seen/backoff/decide flow; 3 new teeth tests in `poll-daemon.test.ts` and a
  `revoked: number[]` field on `PollOutcome`. Please keep the gate when iterating.
- **Already wired:** PR-2's `readLatestReviewReport` → `defaultReadReviewReport` (the witness's
  optional `reviewed` leg). PR-4's producer + my `prs.ts` revocation gate coexist (the gate sits
  between PR-4's reviewer-identity resolution and its `markFeaturePrState` merge stamp).
