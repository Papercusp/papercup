# findings-PR5 — Internal fork→PR dogfood (Brief PR-5)

**Owner:** pr5-impl (this lane). **Plan:** `PLAN-pr-system-completion-dogfood.md` (Phase PR-5).
**Last updated:** 2026-06-19. **coord MCP:** down — status here + on-disk artifacts is the channel.

## Status: 🟢 PR-5's OWN deliverables BUILT + teeth-verified · 🟡 live round-trip GATED on PR-1

PR-5 is the FINAL phase and its **live** witness depends on the inbound side (PR-1..4). Those are
being built by the fleet IN THIS TREE concurrently (untracked: `feature-pr-producer.ts`,
`agent-reviewer.ts`, `pr-review-report-store.ts`, `agent-trailer.ts`, `operator-rate-key.ts`).
**PR-1 (`pr-host/poll-daemon.ts`) is still ABSENT** — so the autonomous notice→review→merge spine
isn't wired, and the live loop cannot round-trip end-to-end yet. Everything PR-5 owns that does NOT
depend on PR-1..4 is built, typechecked, and teeth-green now.

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
3. **Daemon notices → reviews → owner-mode.**  ⟵ **GATED on PR-1** (`poll-daemon.ts` absent). Once
   PR-1 lands: the daemon upserts `harness_feature_prs` (PR-4), triggers PR-2's agent-review, and in
   `manual` mode surfaces the report in the PRs tab (PR-3) for the owner to Approve.
4. **Merge to canonical.** Owner Approves in the PRs tab → `reviewPr` (`approve_and_merge`) →
   `tryAutoMerge` (checks-green gate) → `stampCompletionRefOnMerge` + `markFeaturePrState('merged')`.
5. **Assert the round-trip.** `verifyDogfoodRoundTrip({ workspaceId, harnessSlug:'papercusp-platform',
   prUrl })` → expect `ok:true` (wire PR-2's report reader for the optional `reviewed` leg).
6. **Tidy.** `platform:fork_gc { reason:"…" }` (dry-run report) → `{ confirm:true }` to collect any
   abandoned forks.

## Asks for the fleet / monitor
- **PR-1 is the critical-path blocker for PR-5's live witness.** Whoever owns PR-1: the decision
  functions it drives (`tryAutoApprove`/`tryAutoMerge`) now take an `authorRevoked` boolean — the
  daemon should resolve it via `isPrAuthorRevoked(...)` and pass it in, so the autonomous path honors
  revocation too (the manual path already does).
- **PR-2 report reader:** expose a `(workspaceId, harnessSlug, prUrl) → {recommendation}` reader from
  `pr-review-report-store.ts`; the round-trip witness will wire it as `readReviewReport` to un-gate the
  `reviewed` leg.
- Shared-file edits coexist cleanly: my `prs.ts` revocation gate sits between PR-4's reviewer-identity
  resolution and its `markFeaturePrState` merge stamp.
