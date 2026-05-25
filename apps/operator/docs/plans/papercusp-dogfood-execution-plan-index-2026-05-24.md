---
title: Papercusp dogfood — execution-plan index
slug: papercusp-dogfood-execution-plan-index-2026-05-24
status: draft
created: 2026-05-24
updated: 2026-05-24
owner: avi@storewolf.com
---

# Papercusp dogfood — execution-plan index

## Now

**State:** **navigation index** for the per-phase execution plans split out of `papercusp-dogfood-v5-2026-05-23.md`. **All 11 phase execution plans written** as of 2026-05-24 (Phase 3 deliberately has none — substantially done in-tree). Implementation can now proceed phase-by-phase against these plans.

**Next action:** authors update status fields here as work moves through PASS/PARTIAL/DONE. Plan-doc edits land in their own commits; index status edits ride alongside.

## Start here if you're new

**`papercusp-dogfood-overview-2026-05-24.md`** — 5-minute orientation across the entire arc. Why, what, how-rolled-out, what's done, what's deferred, what success looks like. Read this BEFORE the master plan or any individual phase plan.

## How to use this index

1. **Picking what to work on next:** scan the Status column for `🟢 ready` rows (gate passed, prerequisites met, not started). Lowest-numbered phase wins ties; otherwise size-S/M before L/XL.
2. **Writing a new execution plan:** copy the per-phase plan template from v5's `## For the implementing agent splitting this into execution plans` section. Slug convention: `papercusp-dogfood-phase<N>-<short-name>-<YYYY-MM-DD>.md`.
3. **Updating an existing plan's status:** edit its `## Now` block + bump the `Status` cell here. Plan-revision via `plans:set-now` is preferred over raw `set-content` when only the Now line changes.

## Execution plans

| # | Phase | Plan slug | Size | Status | Gate / blockers |
|---|---|---|---|---|---|
| 0 | Spike (substrate gate) | [`papercusp-dogfood-phase0-spike-2026-05-24`](./papercusp-dogfood-phase0-spike-2026-05-24.md) | M | 🟡 PARTIAL (Linux smoke pass; macOS/Windows/Tauri-bundle pending) | none (this IS the gate) |
| 1a | Workspace + create-harness UI shell + classifier | [`papercusp-dogfood-phase1a-workspace-ui-shell-2026-05-24`](./papercusp-dogfood-phase1a-workspace-ui-shell-2026-05-24.md) | M | ✅ COMPLETE (P-006/P-007/P-010/P-012/P-013 all shipped) | Phase 0 `GATE: PASS` |
| 1b | OAuth + clone + device attestation + binding service + two-channel verifier | [`papercusp-dogfood-phase1b-oauth-clone-attestation-2026-05-24`](./papercusp-dogfood-phase1b-oauth-clone-attestation-2026-05-24.md) | L | ✅ COMPLETE (P-008/P-068/P-011/P-075/P-009 all shipped) | Phase 0 `GATE: PASS`. |
| 2 | `completion_ref` + status verification | [`papercusp-dogfood-phase2-completion-ref-2026-05-24`](./papercusp-dogfood-phase2-completion-ref-2026-05-24.md) | M | ✅ COMPLETE (P-014/P-015/P-016/P-017 all shipped) | Phase 0 `GATE: PASS`. **Runs in parallel with Phase 1b.** |
| 3 | Reactivity migration | _no execution plan needed_ | M | 🟡 SUBSTANTIALLY DONE (P-018/P-019/P-023/P-067 shipped; P-021b + P-022 Phase B blocked on user decision — delete `apps/papercup/` webapp or refactor) | Phase 0 `GATE: PASS`. |
| 4 | Single-engineer dogfood (papercup as `state: private`) | [`papercusp-dogfood-phase4-single-engineer-dogfood-2026-05-24`](./papercusp-dogfood-phase4-single-engineer-dogfood-2026-05-24.md) | M | 🟡 PARTIAL (P-024/P-025 done; P-026 requires user-initiated e2e run; P-027/P-028 follow) | Phase 1a + Phase 2 + Phase 3 enough to run a feature end-to-end. **First real-use phase — P-026 requires user action.** |
| 5a | Hyperbee plumbing | [`papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24`](./papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24.md) | L | 🔴 NOT STARTED | Phase 0 `GATE: PASS`, Phase 1b done (P-068, P-075), Phase 2, Phase 3, Phase 4 verdict PROCEED. |
| 5b | Hyperbee UI integration + clobber-toast | [`papercusp-dogfood-phase5b-hyperbee-ui-integration-2026-05-24`](./papercusp-dogfood-phase5b-hyperbee-ui-integration-2026-05-24.md) | M | 🔴 NOT STARTED | Phase 5a done. |
| 6 | Orchestrator distributed claim | [`papercusp-dogfood-phase6-orchestrator-claim-2026-05-24`](./papercusp-dogfood-phase6-orchestrator-claim-2026-05-24.md) | M | 🔴 NOT STARTED | Phase 5a done (Autobase log primitives in place). |
| 7 | PR lifecycle | [`papercusp-dogfood-phase7-pr-lifecycle-2026-05-24`](./papercusp-dogfood-phase7-pr-lifecycle-2026-05-24.md) | L | ✅ COMPLETE (P-040/042/043/044/045/046 shipped `f7d4cf24`; P-041 auto-rebase deferred) | Phase 1b done (Octokit + OAuth). |
| 8 | Sidebar tabs + Insights + contributor stats + user profile | [`papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24`](./papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24.md) | L (XL — Phase 8a/8b split recommended) | 🔴 NOT STARTED | Phase 5b + Phase 7 + **P-075 two-channel binding** done. v5 §9.0 ordering: do not ship Insights before binding. |
| 9 | Cupboard + Discord + sync-with-main | [`papercusp-dogfood-phase9-cupboard-discord-sync-2026-05-24`](./papercusp-dogfood-phase9-cupboard-discord-sync-2026-05-24.md) | L | 🟡 PARTIAL (P-052/054/055 shipped `48d73102`+`c5b1da85`+`6bf0930c`; P-051a/b/053/076 deferred — Cupboard server needs infra decision) | Phase 7 + Phase 1b P-068 done. Ships a new public-facing service (`apps/operator-public/`). |
| 10 | Path B Hyperdrive peer-mirror (optional opt-in) | [`papercusp-dogfood-phase10-hyperdrive-peer-mirror-2026-05-24`](./papercusp-dogfood-phase10-hyperdrive-peer-mirror-2026-05-24.md) | M | 🔴 NOT STARTED | Phase 5a done. **Explicitly optional** — defer indefinitely unless code-propagation latency becomes a real bottleneck. |
| 11 | Multi-engineer dogfood | [`papercusp-dogfood-phase11-multi-engineer-dogfood-2026-05-24`](./papercusp-dogfood-phase11-multi-engineer-dogfood-2026-05-24.md) | L | 🔴 NOT STARTED | All of Phases 5a/5b/6/7/8/9 done. **Capstone of the arc** — 2-week sustained multi-engineer use. |

## Status legend

- 🟢 **ready** — gate passed, prerequisites met, can start now
- 🟡 **partial** — some sub-tasks done, others pending; or substantially done in-tree but not formally closed
- 🔴 **not started** — no work landed yet
- ✅ **complete** — all sub-acceptances passed and recorded

## Standalone plans (carved out of v5, not phases)

These ride alongside the phase plans but don't fit the per-phase sequence:

| Plan slug | Status | Scope |
|---|---|---|
| [`proxy-witness-pattern-2026-05-24`](./proxy-witness-pattern-2026-05-24.md) | draft stub | Substrate for cross-engineer-verifiable LLM-side stats (token spend, latency, etc.). Picks up after v5's non-spend collab layer ships. v5 ships spend as tier-D self-reported until this lands. |
| [`plans-harness-scoped-2026-05-24`](./plans-harness-scoped-2026-05-24.md) | draft | Plans become harness-scoped + author-owned + fork-on-drag. Until this lands, v5 leaves plans workspace-scoped exactly as today. |

## Design memos (Phase 1b prerequisites)

Three design memos required to be reviewed + accepted before Phase 1b implementation begins. Per Phase 1b plan's `## Now`:

| Memo slug | Scope |
|---|---|
| [`dogfood-design-memo-device-attestation-ux-2026-05-24`](./dogfood-design-memo-device-attestation-ux-2026-05-24.md) | UX flow for §0.2 device binding via GitHub-Gist attestation. Three-screen modal, error states, revocation flow, multi-device cross-trust. |
| [`dogfood-design-memo-two-channel-binding-ux-2026-05-24`](./dogfood-design-memo-two-channel-binding-ux-2026-05-24.md) | UX for verified/pending/unverified state across Contributors tab, Insights People card, feature/PR avatars, user profile. Avatar-overlay vocabulary + daily re-check handling. |
| [`dogfood-design-memo-binding-service-api-2026-05-24`](./dogfood-design-memo-binding-service-api-2026-05-24.md) | API shape for the canonical binding service (P-068). Five-operation interface, typed errors, HTTP endpoints, permission-verification flow, embedded vs Cupboard deployment. |

When implementation begins, convert each to MDX under `apps/operator/content/internal-docs/design/` and promote their D-decisions into the Phase 1b plan's `## Decisions` section.

## Historical (superseded, archived)

The dogfood arc went through four full plan revisions before landing on v5. All four are in `archive/` — read them only for lineage / "what was tried and rejected" archaeology, not as current-state references.

| Slug | Date | Why superseded |
|---|---|---|
| `archive/papercusp-dogfood-2026-05-22.md` | 2026-05-22 | First-pass plan; v2 reorganized scope. |
| `archive/papercusp-dogfood-v2-2026-05-22.md` | 2026-05-22 | v3 added collaboration-first reframe (user branches, GitHub-forced PRs). |
| `archive/papercusp-dogfood-v3-2026-05-23.md` | 2026-05-23 | v4 incorporated second-round multi-agent review (GitHub-Gist attestation, Autobase merge-order, auto-approve+auto-merge as independent toggles, deferred issue-collab schema, github_user_id everywhere, bulk PR poll, state:private Phase 4, pr_reviewer_settings identity unification, current_worker derived, peer-mirror conflict-escalation, vditor). |
| `archive/papercusp-dogfood-v4-2026-05-23.md` | 2026-05-23 | v5 folded in v4 audit findings + answered 8 of 9 open questions + 2026-05-24 addenda (canonical shared harnesses, deferral carve-outs, Insights/anti-fakery/contributor-stats/profile). |

The supersession chain is recorded in each plan's frontmatter (`supersedes: <prev_slug>`). v5 is the current canonical plan; all phase plans + design memos build on it.

## Cross-phase coordination — read this before starting any phase

The v5 plan's `## For the implementing agent splitting this into execution plans` section is the canonical guidance. The cross-cutting items it flags:

- **Two-channel binding (P-075)** lands in Phase 1b but gates Phase 8's Insights and all tier-A/B/C stat surfaces.
- **Trust tiers (§17)** referenced from §9.0 (Insights), §9.2 (Contributors), §10 (Cupboard), §18 (User profile) — every UI plan that surfaces a stat needs to reference §17.
- **`contributor_usage_events` ledger (P-070)** in Phase 5a; every later phase that emits an activity event writes to it.
- **`completion_ref` + GitHub poll (P-016, P-042)** feed the tier-B verification. Without those running, "features shipped ✓" rows render as tier-C until verification catches up.
- **Cupboard tier-A-only rule (P-076)** is Phase 9 but its data source (GitHub APIs) needs cache + rate-limit thinking that coordinates with Phase 7's PR poll budget.

## How phase plans should reference this index

Each per-phase execution plan's `## Cross-references` section should include this index doc as the first link, so a reader who lands on a phase plan can navigate to siblings without back-tracking through v5.

## For the next agent (whoever picks up next)

When you finish a phase, update this index in the same commit as your phase plan's `## Now` update. The index is the single navigation surface for the dogfood arc; keeping it fresh is the discipline that prevents the cohort from devolving into "we have 12 plans, which one is real?" confusion.

If you write a new execution plan, add its row to the table above before committing. The slug convention (`papercusp-dogfood-phase<N>-<short-name>-<YYYY-MM-DD>.md`) is the only naming rule — short-name should be 2-4 hyphenated words capturing the phase's main deliverable.
