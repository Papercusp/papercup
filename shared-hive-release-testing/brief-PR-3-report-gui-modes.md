# Brief PR-3 — Review-report GUI + manual/auto modes

**Implementation brief.** Plan: `PLAN-pr-system-completion-dogfood.md` (Phase PR-3). The
owner-facing surface for the "human OR agent review" model. Depends on PR-2 (the report) +
the claimed-owner authority (gating the mode toggle). nuqs for all view state (AGENTS.md rule).

## Build
1. **Render the agent report** on the existing PRs surface (`PrsTab.tsx` / `PrRow.tsx`): show
   PR-2's `{summary, recommendation, rationale, risks, checksObserved}` + the linked WI (PR-4)
   + the live check status. The recommendation is visually prominent (approve/request-changes/reject).
2. **Manual mode — human acts on the report:** a **Approve** + **Approve-and-merge** action
   (the existing `POST /api/harness/:slug/prs/:number/review`) shown when the viewer is authorized;
   the human reads the agent's report, then clicks. (This is the path that exists today — keep it.)
3. **Auto mode — per-pot toggle (owner-gated):** an **"Auto-apply agent recommendations"** toggle
   that flips `pr_reviewer_settings.auto_review`/`auto_merge` — GATED on **claimed-owner authority**
   (reuse `useHarnessClaimStatus`; an unclaimed/non-owner viewer sees it read-only). When ON, the
   daemon (PR-1) auto-applies the recommendation; the GUI shows "auto" + the audit trail.
4. **Honesty:** the GUI shows WHY a PR is/ isn't auto-mergeable (checks red, untrusted author,
   manual mode) — never a misleading "merged" state (the Brief-G/G-004 honesty discipline).
5. nuqs: selected-PR id, filter, the report-expanded flag → URL (agent-controllable per AGENTS.md).

## Reuses
- `PrsTab.tsx`/`PrRow.tsx`, `POST .../prs/:number/review`, `useHarnessClaimStatus` (authority),
  `pr_reviewer_settings`. PR-2's report; PR-4's WI link.

## Tests (teeth-verified + GUI E2E, never :0)
- Manual mode: report renders, Approve/merge button gated on authority, click → merge fires.
- Auto-mode toggle: only a claimed owner can flip it (teeth: non-owner → toggle read-only/403).
- The GUI never shows a false "merged"/"approved" state; it shows the honest blocker reason.

## Done
GREEN when an owner can read the agent's report and either manually approve OR flip a
claimed-owner-gated auto toggle, with honest status and full audit — the owner-configurable
review model, surfaced.
