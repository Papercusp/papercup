# Brief PR-1 — PR poll daemon + reviewer trigger (the missing spine)

**Implementation brief.** Plan: `PLAN-pr-system-completion-dogfood.md` (Phase PR-1). The
single biggest gap: P-042 was marked "shipped" but **never built** (EI-479). Independent —
the decision functions it drives already exist. Start now.

## Build
1. **`pr-host/poll-daemon.ts` (un-vaporware P-042).** A routine (mirror the git-sync routine
   pattern — `system:pr-poll` target, jittered cron / backoff) that, per shared harness with
   `pr_reviewer_role_enabled`: lists open PRs on the upstream (Octokit), diffs against last-seen,
   and for each new/updated PR → (a) upsert `harness_feature_prs` (PR-4 producer), (b) refresh
   `pr_check_status_cache` (currently nothing populates it), (c) trigger the agent-reviewer (PR-2),
   (d) evaluate `decideAutoReview(pr, settings)` and, in AUTO mode, call the EXISTING
   `tryAutoApprove` + `tryAutoMerge`. 60s poll + exponential backoff (the spec P-042 claimed).
2. **Fix the false plan record.** `papercusp-dogfood-phase7-pr-lifecycle` P-042 is marked shipped
   but the file never existed — correct the record (don't silently re-ship; note it was vaporware).
3. **Idempotent + crash-safe.** Re-poll never double-approves/merges (lean on the existing
   idempotency in `tryAutoApprove`/`auto_review_audit`); a restart resumes from last-seen.

## Reuses (already built — DON'T rebuild)
- `decideAutoReview` / `tryAutoApprove` / `tryAutoMerge` (`pr-host/`), `pr_reviewer_settings`,
  `auto_review_audit`, `GitHubPrHost`. The routines engine + git-sync routine as the pattern.

## Tests (teeth-verified)
- New PR appears → daemon upserts `harness_feature_prs` + triggers the reviewer + (auto mode,
  trusted author, checks green) auto-approves+merges; (manual mode) does NOT merge.
- Re-poll is idempotent (no double-merge; teeth: neuter the last-seen guard → double-fire RED).
- Checks RED / untrusted author → never merges (the S0 gate).
- Daemon restart resumes without re-acting on already-handled PRs.

## Done
GREEN when a real fork→PR is autonomously noticed, tracked, reviewed-triggered, and (in owner
auto-mode with checks-green + trusted author) merged — with no daemon = no autonomy proven gone.
