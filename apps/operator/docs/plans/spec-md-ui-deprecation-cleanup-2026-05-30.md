---
title: Finish SPEC.md UI + health-subsystem deprecation cleanup
slug: spec-md-ui-deprecation-cleanup-2026-05-30
status: draft
created: 2026-05-30
updated: 2026-05-30
owner: avi@storewolf.com
---

# Finish SPEC.md UI + health-subsystem deprecation cleanup

## Now

**State:** The backend + agent-prompt half of the SPEC.md/validation-contract.md deprecation (`plans-central-harness-ux-2026-05-26`, D-004/D-005, P-015/16/17) was finished this session — commits `30bc9eeb` (dead `plans:promote` SPEC mutator, `getHealth()` checks, agent prompts) and `3bf3acf2` (SpecEditor save-filter token, support FAQ). The SPEC.md *editor tab* was already gone. What's left is the live `/adv` `HarnessDashboard` UI and a **second** file-presence health subsystem (`HealthBadge` + fs-watcher + PG columns) that still reference the tombstones — including a live empty-state that tells users to write SPEC.md and ~10 scoper-action labels claiming the scoper reads SPEC.md (it reads plans now).

**Next:** human decision needed on D-002 (the post-SPEC.md onboarding empty-state). Once that's settled, an agent picks up P-001 (audit the scoper actions) → P-002. Phase 1 (label fixes) can start independently of D-002.

## Background

`plans-central-harness-ux-2026-05-26` made plans the authoritative scope/acceptance document and deprecated both `SPEC.md` (D-004) and `validation-contract.md` (D-005). No agent role reads SPEC.md after P-015/16/17 — verified: the scoper/architect/worker/orchestrator prompts have zero SPEC.md references. But the deprecation was applied piecemeal and several live surfaces were missed. This plan finishes them. It does **not** re-litigate D-004 — SPEC.md stays a read-only tombstone on disk; this is purely about removing stale code/labels that still point at it.

All line numbers are against `apps/operator/app/harness/HarnessDashboard.tsx` (5,270 lines, consumed live by `/adv` via the `@/app/harness/*` alias) unless noted.

## Phase 1 — Misleading scoper + config labels

- **P-001** `todo` Audit the Propose / Replan / Cleanup scoper actions surfaced in HarnessDashboard — confirm each one's *current* plan-based behavior (which scoper modes still exist, what they read now) so the replacement copy is accurate rather than a blind find-replace. Record the mapping in D-001.
- **P-002** `todo` Rewrite the ~10 scoper-action tooltips/labels that say the scoper reads / folds "SPEC.md bullets" (lines ~3504, 3525, 3536, 3546, 3780, 3788, 4259, 4264, 4269, 4362) to reference plan items instead. blocked-by: P-001
- **P-003** `todo` Fix the Config-button tooltip (line 4417, "Edit SPEC.md / AGENTS.md / config.json") — drop SPEC.md; the Config tab no longer has a SPEC.md sub-tab.

## Phase 2 — Onboarding empty-state (needs a UX call)

- **P-004** `needs-human` Decide the post-SPEC.md empty-state onboarding flow. The current bootstrap (lines 2744, 2772) tells a new user to "open Config → Harness → SPEC.md to describe what this project should accomplish" — that surface no longer exists. What should the empty state prompt instead? See D-002.
- **P-005** `todo` Implement the chosen empty-state in HarnessDashboard — replace the empty-SPEC bootstrap toast/CTA at lines 2744/2772 with the D-002 direction. blocked-by: P-004

## Phase 3 — File-presence health subsystem

- **P-006** `todo` `HealthBadge.tsx` client checks (lines 128-137): drop `contract_present` (validation-contract.md, deprecated D-005). `spec_present` is already gone here. Note: `no_pending_checkpoints` (line 132) is also stale (checkpoints removed in D-003/P-009 of the parent plan) — fix in the same pass or split it out if it needs separate sign-off.
- **P-007** `todo` Stop the fs-watcher writing the tombstone columns: `harness-fs-watcher.ts` (lines 677-702) + the `spec_present` / `contract_present` columns in `ensure-schema.ts` (lines 1068-1069). Drop the columns via a migration in `libs/papercusp/libs/db/sql/<NNN>-*.sql` (embedded-pg applies it on boot). blocked-by: P-006

## Phase 4 — Minor stale strings + redirect routes

- **P-008** `todo` Minor stale copy: `apps/operator/app/harness/h-proposals.css:2472` ("Applied is in SPEC.md") and the `FeatureEditor.tsx:310` placeholder example mentioning SPEC.md.
- **P-009** `todo` The friendly `/harness/<slug>/spec` redirect routes (`app/harness/[slug]/spec/page.tsx` + `apps/operator-vite/src/routes/harness/$slug/spec.tsx`) still target the removed `specTab=spec` (coerces to the AGENTS.md default — stale but harmless). Default: let `adv-harness-tab-migration-2026-05-30` delete them when it removes the `/harness` route; only act here if that migration stalls.

## Phase 5 — Templates (out of scope — own plan)

- **P-010** `needs-human` Decide whether harness templates migrate from SPEC.md to plan-based seeds. `TemplatesModal.tsx` (lines 46-163) still reads/previews `SPEC.md` from templates, the on-disk template projects still ship `SPEC.md`, and the save-as-template recipe text (HarnessDashboard 1109/1178/3844) lists it. This is a larger separate question and should be its own plan, not folded into this cleanup. See D-001.

## Out of scope (do not touch)

- `ExpertsPanel.tsx`'s "SPEC.md" — a *different* concept (each expert's own authored spec slice in the design-phase/experts system), unrelated to the harness-root SPEC.md.

## Decisions

### D-001 — This plan finishes UI + health cleanup only; templates are a separate plan
Date: 2026-05-30
The SPEC.md→plans migration touches three rings: (a) backend/prompts — done this session; (b) live `/adv` UI labels + onboarding + the file-presence health subsystem — this plan; (c) the template system, which still seeds/previews SPEC.md and would need plan-based template seeds to migrate. Ring (c) is a larger product question (what does "start from template" mean once SPEC.md is gone?) and gets its own plan rather than bloating this cleanup. P-010 is the placeholder hand-off. The P-001 scoper-action audit findings are also recorded against this decision when they land.

### D-002 — Post-SPEC.md onboarding empty-state direction (OPEN — needs avi)
Date: 2026-05-30
When a harness has no work yet, the old empty-state told the user to write SPEC.md (HarnessDashboard 2744/2772). With SPEC.md retired the prompt must change, but the right replacement is a product call, not an agent call. Candidates on the table: (a) "Create your first plan" CTA that opens the Plans surface / `plans:new`; (b) route to Brainstorm to explore before committing; (c) a minimal "no work yet — open the Plans tab" pointer. Recommendation pending avi's input on P-004; P-005 implements whatever is chosen.
