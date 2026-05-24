---
title: Papercusp dogfood — Phase 5b (Hyperbee UI integration + clobber-toast)
slug: papercusp-dogfood-phase5b-hyperbee-ui-integration-2026-05-24
status: draft
created: 2026-05-24
updated: 2026-05-24
owner: avi@storewolf.com
---

# Papercusp dogfood — Phase 5b (Hyperbee UI integration + clobber-toast)

## Now

**State:** **draft execution plan.** Phase 5b consumes Phase 5a's plumbing and lights up the user-visible Hyperbee surfaces: per-user feature queue, contributors list with user branches, Entry 4 wizard hook-up, and the LWW clobber-toast that surfaces silent overrides honestly per D-012.

**Next action:** wait for Phase 5a P-029-P-031 done; then start P-032.

## Background

Phase 5b implements `## Phase 5b — Hyperbee UI integration + clobber-toast [M]` from v5 (~line 1247). It's a UI-heavy phase — most of the work is wiring existing PG-backed components to also see the new HYPERBEE-projected rows.

**Gate:** Phase 5a complete.

## Phase tasks

### P-032 — `feature_queue` HYPERBEE table + Features tab UI [M]

v5: the queue-as-pointer table from §7.1; UI shows per-user queue + cross-user "who else has this queued."

**Files:**
- `apps/operator/app/harness/FeaturesTab.tsx` — extend the existing features list with queue-membership avatars per row.
- `apps/operator/app/harness/PullToQueueButton.tsx` (new) — writes a `feature_queue` row via the HYPERBEE-bucket write path (P-031b from 5a).
- Tests: render tests + integration against a fake Hyperbee fixture.

**Sub-acceptances:**
- **P-032a** — Per-row "Pull into my queue" / "Remove from my queue" buttons work, with optimistic UI.
- **P-032b** — Each row shows up to 5 avatars of users with this feature queued; "+N more" overflow.
- **P-032c** — Filter chips per v5 §9.1: `mine`, `working`, `available`, `shipped`.

### P-033 — `contributors` HYPERBEE + `user/<id>` branch + worktree [M]

v5: on join, create the long-lived `user/<github_user_id>` branch + worktree.

**Files:**
- `apps/operator/lib/harness/user-branch.ts` (new) — `ensureUserBranchAndWorktree(harness, github_user_id)`: idempotent create + checkout + worktree-add.
- Wired into `apps/operator/lib/harness/join-shared-harness.ts` (Phase 1b P-009) as step 6 of the §3 Entry 4 flow.
- Also wired into `apps/operator/app/harness/ShareWizard.tsx` (Phase 5a P-029) as the post-wizard contributor publication step.

**Sub-acceptances:**
- **P-033a** — Branch creation is idempotent; re-joining the same harness does not crash or duplicate the branch.
- **P-033b** — Worktree lives at `<harness-root>/.papercusp/user-trees/<github_user_id>/` per v5 §0.4.
- **P-033c** — Contributor row in HYPERBEE appears for every joiner; visible in §9.2 Contributors tab via Phase 8 P-048.

### P-034 — Entry 4 link-join wizard bootstrap hook [S]

v5: Phase 1b P-009 wires the link-paste flow; Phase 5b adds the Hyperbee bootstrap hand-off so the join flow waits for Hyperbee replication to be far enough along to render meaningful state before routing to Insights.

**Files:** patch to `apps/operator/lib/harness/join-shared-harness.ts` (P-009).

**Sub-acceptances:**
- **P-034a** — Step 4 (Hyperbee bootstrap) waits until at least the `contributors` row count matches what `harness_feature_prs` reports as the contributor count (rough catch-up signal).
- **P-034b** — If bootstrap exceeds 2 minutes, show "still syncing" + offer "continue anyway" (lets user explore with partial state rather than indefinite wait).

### P-035 — LWW clobber-toast UI [S]

v5: detect remote write that overrode my recent local write → toast with diff link.

**Files:** `apps/operator/app/harness/ClobberToast.tsx` (new); subscriber on the clobber event from Phase 5a P-031d.

**Sub-acceptances:**
- **P-035a** — When my write to a HYPERBEE row is overridden by a remote write with a later `(ts, writer_pubkey)` tuple within 60s, the toast appears within 200ms.
- **P-035b** — Toast text: "Your change to `<field>` on `<row>` was overridden by `<contributor>`. View diff."
- **P-035c** — "View diff" opens an inline panel showing my-write vs their-write side-by-side.
- **P-035d** — Toast is dismissible + the dismissal is per-event (not "never show again" — that would suppress real conflicts).

## Decisions

(None yet.)

## Named fallback rollout

None — UI-only phase, no substrate failure mode.

## Cross-references

- Index: `papercusp-dogfood-execution-plan-index-2026-05-24.md`.
- Master: v5 `## Phase 5b`, `### §0.4 — User branch + worktree`, `### §9.1 — Features tab`, `### §9.2 — Contributors tab`, D-010 (numeric branches), D-012 (LWW honesty).
- Prereq plans: `phase5a`, `phase1b`.

## Open questions

### Q-1 — Worktree disk footprint?

Each contributor gets a worktree under `.papercusp/user-trees/<id>/`. For a harness with 10 contributors, that's 10 full checkouts of the repo. Acceptable for v1; flag if size complaints come up.

### Q-2 — Clobber-toast trust tier?

Per §17, the toast itself is reporting a tier-C event (Hyperbee-claimed override). The clobber detection is reliable; the *interpretation* "they overrode me intentionally" is not. Toast copy should say "was overridden" not "was rejected by".

## For the next agent (Phase 6)

Phase 6 (orchestrator distributed claim) consumes:
- Autobase append-then-await-merge primitives from Phase 5a P-030.
- `feature_claims` Autobase log structure.

Phase 6 is mostly orchestrator-logic; the UI surfaces (lanes, working indicators) already exist.
