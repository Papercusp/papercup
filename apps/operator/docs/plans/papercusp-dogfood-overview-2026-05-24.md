---
title: Papercusp dogfood — overview (5-minute read across the arc)
slug: papercusp-dogfood-overview-2026-05-24
status: ready
created: 2026-05-24
updated: 2026-05-24
owner: avi@storewolf.com
---

# Papercusp dogfood — overview

> The 5-minute read across the whole arc. Read this if you're new to the corpus and want to understand WHY before diving into HOW.

## Now

**State:** The dogfood arc is in **planning complete, implementation 5% landed** state. Master plan + 11 phase execution plans + 3 design memos + 2 carve-outs + 1 index = **18 plan documents, all lint-clean, ~6000 lines total**. The substrate work for Phase 0, 1a, 2, 3 is partially in-tree (commit hashes recorded in each phase plan); the user-visible collab surfaces (Phases 5-9) are greenfield.

**Next action:** start implementation. The natural first deliverable is closing Phase 0's macOS + Windows + Tauri-bundle verification (P-001b/c/d/e), which unblocks every other phase.

## What is the dogfood arc?

**One sentence**: turn Papercusp from a single-engineer harness into a multi-engineer collaborative substrate that runs Papercusp's own development through Papercusp.

**Why**: until Papercusp's own team uses it daily for real work, every feature ships on hope. The dogfood loop is the forcing function that finds what's actually broken vs. what's theoretically broken.

**Constraint**: collaboration is the **substrate**, not a sync layer over a single-engineer model. Every design choice — branches per contributor, queue as a pointer table, orchestrator distributed claim, GitHub as the canonical PR surface, P2P via Holepunch primitives — flows from making multi-engineer the default.

## The architectural shape (10 things to know)

1. **Identity is per-human, not per-machine.** Root id = `github_user_id` (numeric, stable across renames). Devices bind via GitHub-published gists per §0.2. New devices for a trusted human auto-trust per §0.2 step 5-6.

2. **Two-channel binding** (§0.2.7). Channel 1 = server-side `gh api /user` OAuth re-check. Channel 2 = signed `.harness/contributors/<github_login>.json` pushed via GitHub-verified commit to the user's branch. Both required to count in stats. Sybil cost: one real GitHub account per Sybil. (D-031.)

3. **Hybrid sync: HYPERBEE for 8 live tables, GIT for ~20 doc tables.** Live state (feature queue, contributors, PR status, activity events) propagates sub-second via Hyperbee CRDT. Slow-changing document state (decisions, summaries, design artifacts) lives as files in `.harness/state/`. Conflicts in HYPERBEE resolve LWW with honest clobber toasts (D-012). (D-007.)

4. **Each contributor gets a long-lived `user/<github_user_id>` branch + worktree.** Branches are GitHub-pushed; the branch is the unit of in-progress work isolation. Numeric ids per D-010 — usernames change, ids don't.

5. **Orchestrator distributed claim via Autobase merge-order arbitration** (D-002, §0.6). Append claim → await own merge → check first-in-order → fire or drop. Mathematical guarantee no two peers fire workers for the same feature.

6. **GitHub-forced for shared harnesses, behind a `PrHost` abstraction** (D-009). GitHub is the canonical PR + permission + commit-attribution surface. GitLab/Gitea drop in later as `PrHost` implementations.

7. **Stat trust tiers (§17, D-030).** Tier A = GitHub-derived ✓. Tier B = `completion_ref`-verified ✓. Tier C = Hyperbee-claimed (unmarked). Tier D = self-reported ⏱. **Tiers never aggregate across boundaries.** Cupboard listings use tier-A only. Unverified contributors contribute to no tier.

8. **Insights tab is the post-install default landing** (§9.0, D-029). After joining a shared harness, the operator force-routes to `/harness/<slug>/insights` until dismissed. Six cards: Project, Activity feed, People, Your place, How it works here, Spend (self-reported with proxy-witness deferral banner).

9. **Canonical shared-harness binding by stable GitHub `repository.id`** (addendum 1, D-026). Existing binding → join existing. Missing binding → create unclaimed with provisional owner. GitHub `maintain`/`admin` users can claim; `admin` can supersede. Claimed/unclaimed status visible everywhere harnesses surface.

10. **Phase 0 is a real substrate gate, with a named fallback.** If Hyperbee/Autobase don't bundle and work cross-platform, "HYPERBEE bucket collapses into GIT bucket" — concrete 8-step rollout spec in the Phase 0 plan. The fallback being **real and specced** is itself the gate guarantee.

## What's deferred

Two threads carved into standalone plans, NOT shipped in v5:

- **Proxy-witness pattern** (`proxy-witness-pattern-2026-05-24.md`). Cross-engineer verifiable LLM-side stats (token spend, latency, model attribution, refusals) require a shared witness. The team proxy (Claude Bridge / Meridian) is the natural fit. Until built, **spend ships as tier-D self-reported ⏱** on the Insights "Spend" card. Don't pretend spend is verifiable when it isn't.

- **Plans become harness-scoped + fork-on-drag** (`plans-harness-scoped-2026-05-24.md`). Plans currently are workspace-scoped; the carve-out plan rewrites them as harness-scoped HYPERBEE rows with author-only edits and drag-to-fork mechanics. Until that lands, **plans remain workspace-scoped exactly as today**, including for shared harnesses. The new `papercusp` harness is the migration target when it ships.

Both are deferred not abandoned. Spec is in their plans; implementation queues behind the v5 critical path.

## Phase shape — how implementation rolls out

```
Phase 0 — substrate gate (M)
   │ verifies Holepunch primitives on all OSes + in Tauri bundle
   │ FALLBACK if fails: HYPERBEE bucket collapses into GIT bucket
   ▼
Phase 1a — workspace + create-harness UI (M)
Phase 1b — OAuth + clone + device attestation + binding service (L)
Phase 2  — completion_ref + status verifier (M)
Phase 3  — reactivity migration (M, substantially done in-tree)
   │ Phases 1a + 1b + 2 + 3 can run in parallel after Phase 0 passes
   │ Three design memos required before Phase 1b implementation
   ▼
Phase 4 — single-engineer dogfood on papercup as state:private (M)
   │ FIRST REAL-USE PHASE
   │ Pain-capture pattern: F-DOGFOOD-001 as accumulator
   ▼
Phase 5a — Hyperbee plumbing (L)
Phase 5b — Hyperbee UI integration + clobber-toast (M)
Phase 6  — orchestrator distributed claim (M)
Phase 7  — PR lifecycle (L)
Phase 8  — sidebar tabs + Insights + user profile (L→XL split candidate)
   │ MANDATORY: P-075 two-channel binding done before any tier-A/B/C stat surface
   ▼
Phase 9 — Cupboard + Discord + sync-with-main (L)
   │ Ships new public-facing service: apps/operator-public/
   ▼
Phase 10 — Hyperdrive peer-mirror (M, OPTIONAL — defer indefinitely)
Phase 11 — multi-engineer dogfood (L)
   │ SECOND REAL-USE PHASE — capstone of the arc
   │ 2-week sustained use with multiple engineers
```

**Parallelism**: Phases 1a, 1b, 2, 3 can all run in parallel after Phase 0. Phase 4 then gates Phase 5+. Within Phase 5+, the dependency graph (in each plan's `## Gate`) controls sequencing.

**Total estimated effort**: rough sizing across the 11 phases sums to ~6-10 months of focused work for one engineer; less in parallel with a small team.

## What's already done

- **Substrate work for Phases 0-4 is partially landed** with commit hashes recorded in each phase plan.
- **Phase 0**: Linux x64 Node 25 smoke verified (`libs/holepunch-spike/`, commits `fa887946`..`ff2cdd3f`). macOS/Windows/Tauri-bundle pending.
- **Phase 1a**: P-006 (sentinel workspace, `805a2e70`), P-007 (5-rule classifier, `4725cf93`), most of P-013 (PG schema for dogfood tables, `556b37d7`). Remaining: P-010 (Entry 1+3 handlers), P-012 (4-entry picker UI).
- **Phase 1b**: P-008 (clone helper via `gh auth`, `6cc4f6c9`). Remaining: P-009 (Entry 4 link-join), P-011 (device attestation), P-068 (binding service), P-075 (two-channel verifier).
- **Phase 2**: P-014 + P-015 (schema work in migration `080-...`, `2d9439ea`). Remaining: P-016 (verifier daemon), P-017 (UI).
- **Phase 3**: P-018 (PG-side `emit_change_notify` trigger), P-019 parts 1+2 (trigger wiring), P-020 (dropped — discovered existing infra), most of P-023 (docs). Remaining: P-021/P-022 (Zero retirement), P-067 (camelCase bridge).
- **Phase 4**: P-024 (papercup registered in `papercusp-workspace`, `b53185ee`). Remaining: P-025-P-028 (seed features + run end-to-end + observe + gate).

## The corpus — what to read in what order

For a new contributor landing on the dogfood arc cold, here's the recommended read order:

1. **This doc** (you are here). 5-minute orientation.
2. **`papercusp-dogfood-execution-plan-index-2026-05-24.md`** — index across all phase plans. Lets you navigate to whatever you need next without back-tracking.
3. **`papercusp-dogfood-v5-2026-05-23.md`** (the master plan) — read the `## Now`, the three addenda, and `## Decisions` (D-001 through D-031). Skim the design sections; come back when working on a specific phase.
4. **`papercusp-dogfood-phase<N>-...-2026-05-24.md`** for whichever phase you're implementing.
5. **Carve-out plans** (`proxy-witness-pattern-...`, `plans-harness-scoped-...`) — read when working on the corresponding deferred surfaces, or to understand why v5 ships spend as tier-D / plans as workspace-scoped.
6. **Design memos** (`dogfood-design-memo-...`) — three memos cover Phase 1b's pending design decisions; convert to MDX under `apps/operator/content/internal-docs/design/` when implementation begins.

For someone implementing Phase 0 right now, the read order is just: this doc → Phase 0 plan. Don't read the rest until needed; the index will tell you when to.

## The big risks

1. **Phase 0 fails** → named fallback fires; HYPERBEE collapses into GIT; arc still ships but with higher latency on live state. Spec is real.
2. **Phase 1b two-channel binding turns out to be too friction-heavy for real users** → re-evaluate channel 2 (the branch-push step) for whether it's worth the trust win vs. the join-flow complexity. Mitigation: design memos cover the UX explicitly.
3. **Phase 4 verdict is PAUSE + fix more than twice** → the substrate may need deeper rethink before shared dogfood. Mitigation: pause and fix; don't grind on the same gate.
4. **Phase 8's binding-vs-Insights ordering gets ignored** → Insights ships with tier-C numbers that look like tier-A to readers; trust collapses. Mitigation: P-073 blocks-by P-075 explicitly + plan repeats this constraint in three places.
5. **Phase 11 multi-engineer dogfood reveals that LWW is too lossy at team scale** → per-field CRDT redesign in Phase 12+. Acceptable; that's what dogfooding is for.

## What success looks like

When the arc is complete:

- A team can paste a Papercusp `papercusp://harness?...` link, OAuth, and within 5 minutes be in a working shared harness viewing the project's Insights page.
- Every contributor's binding is two-channel-verified before their stats count toward any aggregate.
- Features filed by Alice get picked up by Bob's orchestrator without race-condition; the PR appears in Alice's view sub-second; her trust-list-driven auto-approve fires when the checks go green.
- The Papercusp team is running Papercusp's own development queue through this substrate, daily, for two weeks without bypassing it.
- Pain found during the dogfood loop becomes Phase 12+ feature rows on the `F-DOGFOOD-001` / `F-DOGFOOD-002` accumulators, not lost.

If those five conditions hold, the arc is done. Everything in the corpus exists to get there.

## Cross-references

- Master: `papercusp-dogfood-v5-2026-05-23.md`.
- Index: `papercusp-dogfood-execution-plan-index-2026-05-24.md`.
- Phase plans: see index.
- Deferrals: `proxy-witness-pattern-2026-05-24.md`, `plans-harness-scoped-2026-05-24.md`.
- Design memos: `dogfood-design-memo-device-attestation-ux-2026-05-24.md`, `dogfood-design-memo-two-channel-binding-ux-2026-05-24.md`, `dogfood-design-memo-binding-service-api-2026-05-24.md`.
