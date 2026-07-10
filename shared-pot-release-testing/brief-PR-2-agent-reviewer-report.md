# Brief PR-2 — Agent-reviewer + review report

**Implementation brief.** Plan: `PLAN-pr-system-completion-dogfood.md` (Phase PR-2). The
agent half of the owner's "human OR agent review" model. Depends on PR-1 (trigger) + PR-4
(WI↔PR link for context). The reviewer that produces the report the owner reads/auto-applies.

## Build
1. **The agent-reviewer task.** Triggered by the poll daemon (PR-1) for a new/updated PR: a
   Mug/Cup task that reads the PR **diff** + its **WI/feature context** (which work-item it
   satisfies — via PR-4's `harness_feature_prs`) + the repo conventions, and produces a
   **structured review report**:
   `{ summary: string, recommendation: 'approve' | 'request_changes' | 'reject',
      rationale: string, risks: string[], checksObserved: {...} }`.
2. **Store it** (a `pr_review_reports` row keyed by PR + a fed-friendly shape, or attach to
   `harness_feature_prs`) so the GUI (PR-3) renders it and the daemon (PR-1) reads the
   `recommendation` to feed `decideAutoReview` in AUTO mode.
3. **Safety rails:** the reviewer NEVER posts the GitHub approval itself (that stays in
   `tryAutoApprove`, gated) — it only PRODUCES a recommendation; the gate + owner mode decide
   whether it's applied. The reviewer must surface risk honestly (no rubber-stamp — flag
   untested changes, scope creep, secrets, the Brief-G honesty discipline).
4. **Determinism/audit:** record the model + inputs in `auto_review_audit` so a recommendation
   is traceable (who/what reviewed, on what diff).

## Reuses
- The pot's existing agent/Cup task machinery; `harness_feature_prs` (PR-4) for WI context;
  `pr_check_status_cache` (PR-1) for the checks signal.

## Tests (teeth-verified)
- A clean PR → recommendation `approve` + a faithful summary; a PR with a planted defect
  (failing test / secret / out-of-scope) → `request_changes`/`reject` + the risk flagged (teeth:
  plant the defect → assert the reviewer does NOT recommend approve).
- The reviewer never posts an approval directly (only the gated path does).
- Report links to the correct WI (via PR-4).

## Done
GREEN when the agent reliably reviews a PR, links it to its WI, and emits an honest
summary+recommendation+risks — strong enough that the owner can either read it (manual) or
trust it (auto), and a defective PR is never recommended for approval.
