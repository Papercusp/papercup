---
title: Let a promote wave spawn a child harness (wave-level spawn_child)
slug: promote-spawn-child-harness-2026-05-31
status: draft
created: 2026-05-31
updated: 2026-05-31
owner: avi@storewolf.com
---

# Let a promote wave spawn a child harness (wave-level spawn_child)

## Now

**State:** Draft for pressure-testing the contract before any code. Goal: extend the existing `## Promote` YAML policy so a single wave can declare `spawn_child`, routing that wave's features into a **newly-created child harness** (parented to the current one) instead of only into a pre-existing `target_harness`. This makes "an agent spins up a sub-harness for a chunk of sub-work" a first-class, plan-backed act that reuses everything we already have (promote → import → assertions → DBOS pickup), rather than a parallel spawn subsystem. The whole point of routing it through promote (not a standalone `harness:spawn_child` tool) is that **a child is only ever born from a grouped set of plan items** — never a casual one-off (Claude Code already handles those). The hard part is NOT the schema; it's the **guidance that stops over-spawning** (D-001) and the **child-plan/provenance model** (D-002).

**Next:** human decisions on D-001 (when is a child justified — the anti-over-spawn rule), D-002 (child gets an auto-synthesized seed plan vs. inherits parent provenance), and D-003 (repo boundary: own repo / submodule / shared tree). Then implement P-001…P-006.

## Background — why this shape, grounded in the code

**Live engine (verified from source, 2026-05-31):** the operator orchestrates via the **DBOS durable per-feature pipeline** (`apps/operator/lib/dbos/orchestrator-workflow.ts`, default-on; `main-loop.ts` is RETIRED). The dispatcher (`orchestrator-dispatcher.ts`, 30s tick) reads `harness_features` for each opted-in harness and runs up to `PAPERCUSP_DBOS_MAX_PIPELINES` (default 4) feature pipelines **concurrently**. So intra-harness parallelism already exists — a child harness is **not** the way to get more concurrency.

**A child harness only earns its overhead at a boundary** (own schema + worktree + crew + recursion risk). The four axes, only the first two strong:
1. **Repo/worktree boundary** — workers operate on the harness's tree; different repo/submodule work *cannot* be features-in-parent.
2. **Independent lifecycle** — own queue, own done/escalation accounting, snapshot/rollback as one unit.
3. Settings/crew/budget — weak; agents won't hand-tune; templates only half-fix.
4. Blast-radius / recursion (depth-8 org model) — secondary.

**Therefore the schema must default to features-in-parent and treat `spawn_child` as the exception**, or it becomes a "every task is a microservice" footgun.

**What already exists (reuse, don't rebuild):**
- `scaffold_harness` (`apps/operator/lib/execute-action.ts:543`, `doScaffoldHarness`) — fully implemented: creates schema (`scaffoldHarnessSchema`), registry entry, `.harness/config.json` with `parent_slug` **sealed from the caller's bearer token** (not body-spoofable), token in `token_index`, `harness_shared.projects.parent_slug`. Has `detectCycleOrTooDeep` (`execute-action.ts:513`, `MAX_SPAWN_DEPTH` default 8) and partial-state rollback.
- `## Promote` policy + waves (`apps/operator/lib/agent-tools/plans/promote-policy.ts`) — Zod-validated `target_harness` + `waves[]`, each wave `features[] / generate`, `blocked_by` ordering, wave-drain via `harness_shared.harness_plan_status` + `wave-advance-sweep-live.ts`.
- `plans:promote` (`apps/operator/lib/agent-tools/coordination/tools/promote.ts`) — `postFeaturesImport()` → `POST /api/harness/:slug/features/import` (`features.ts:332`, INSERT ~line 413), provenance UPDATE of `source_plan_slug`/`source_plan_item_ids`/`wave` on `harness_features_consolidated`, VAL-* UPSERT into `harness_plan_assertions`, plan write-back (`## Promoted`, items→done, draft→active).
- DBOS auto-pickup: `PAPERCUSP_DBOS_DISPATCH_HARNESSES` defaults to **all** harnesses, so a freshly-created child is dispatched automatically once it has eligible features — **no explicit launch needed**.

**The eligibility fact that makes a plan mandatory:** the orchestrator's feature read (`libs/papercusp/packages/orchestrator/src/state-pg.ts:83-94`) is `source_plan_slug IS NULL OR source_plan_slug IN (started plans)`. A child whose features carry a started child-plan slug run with acceptance + provenance; NULL-slug features would run with **no acceptance contract**. So the child must get a plan (D-002). Same plans-central principle the D-004/D-005 SPEC.md/validation-contract deprecation just finished enforcing.

## Phase 1 — Schema + parse (pure, testable, no side effects)

- **P-001** `todo` Extend `WaveSchema` in `apps/operator/lib/agent-tools/plans/promote-policy.ts` with an optional `spawn_child` object: `{ slug: kebab-regex, template?: string, repo?: url, goal?: string(≤280) }`. Reuse the existing kebab slug regex (`^[a-z0-9][a-z0-9-]*[a-z0-9]$`). A wave with `spawn_child` still requires `features[]`/`generate` (those populate the child). Add `superRefine`: `spawn_child.slug` unique across waves AND differs from `target_harness`. Update `PromoteWave`/`BuiltFeature` types. Unit tests: valid spawn_child wave parses; bad slug → fail-safe null + warning (never throws); spawn_child still requires features.
- **P-002** `todo` `plans:lint` (`apps/operator/lib/agent-tools/plans/lint.ts`): emit a **warning** (not error) when a `spawn_child` wave is declared, prompting the author to confirm the boundary justification (D-001). Sharper warning if neither `spawn_child.repo` nor `spawn_child.template` is given (ambiguous target tree).

## Phase 2 — Promote branch (scaffold → synth-plan → import → start)

- **P-003** `todo` In `apps/operator/lib/agent-tools/coordination/tools/promote.ts`, when the resolved wave carries `spawn_child` and `apply:true`: (1) call `scaffold_harness` for `spawn_child.slug` via the existing execute-action path — parent **sealed from the promote caller's identity, NOT from YAML**; reuse `detectCycleOrTooDeep`; (2) synthesize the child seed plan per D-002 (goal + items + acceptance→VAL-*) and write it to the child's plans scope; (3) `postFeaturesImport()` the wave's features into the **child** slug with `source_plan_slug = <child-seed-slug>`; (4) `plans:start` the child seed plan. On `apply:false` (preview): report what *would* be created (child slug, seed plan, feature count) with **no** side effects. All failures → `warnings[]`, never throw (D-004). blocked-by: P-001
- **P-004** `todo` Parent write-back: in the parent plan's `## Promoted` block, annotate the wave's rows with `→ spawned child <slug> (plan <seed-slug>)`; mark parent `from_items` done as today. Verify the `afterDone` builtin hook posts a `Completion` message back to the parent when the child finishes (so the parent agent learns sub-work is done); wire it if missing. blocked-by: P-003

## Phase 3 — Guidance + template + verification

- **P-005** `todo` Author the anti-over-spawn guidance (D-001) in: (a) the `plans:promote` tool `guidance` field, (b) the plan-template `## Promote` block comments (the surface the agent reads when authoring a plan — locate it; this is the "we recently added promote instructions" surface), and (c) the promote-policy module doc-comment. Rule: *spawn_child only for cross-repo or own-lifecycle work; same-repo sub-work stays as features in the current harness.*
- **P-006** `todo` End-to-end verification per the testing docs — Vitest for the parse/promote unit + an integration test that promotes a spawn_child wave against a scratch workspace and asserts: child schema exists, child seed plan started, child features carry the seed slug, dispatcher would pick them up. No new `.mjs`/tsx scripts — Vitest homes only. blocked-by: P-003

## Decisions

### D-001 — When is a child justified? (the anti-over-spawn rule) — OPEN, needs avi
Date: 2026-05-31. A wave should `spawn_child` ONLY when the work crosses a **repo/worktree boundary** OR needs its **own lifecycle/done-definition**. Same-repo "more stuff to build" → plain features in the current harness (the DBOS loop already parallelizes up to 4 pipelines). This rule must live in (a) the promote-agent guidance, (b) the plan-template `## Promote` comments, and (c) `plans:lint` as a *warning* when a `spawn_child` wave looks same-repo with no lifecycle reason. Recommendation: guidance + soft lint warning, not a hard block — "needs own lifecycle" isn't mechanically detectable.

### D-002 — Child provenance: auto-synthesized seed plan vs. NULL slug — OPEN, needs avi
Date: 2026-05-31. Features routed into the child need a `source_plan_slug` the child's DBOS loop accepts, else they run contract-less (NULL) or never run. Recommendation: **promote auto-synthesizes a minimal child seed plan** (slug `<child-slug>-seed-<date>`, goal = `spawn_child.goal` or wave id, items = the wave's features, acceptance arrays → inline VAL-* assertions), writes it to the child's plans scope, promotes the wave's features against it, and `plans:start`s it — atomic. Gives child agents a real plan to fetch via the existing `worker.md`/`architect.md` `source_plan_slug` flow. Alternative (NULL slug, always-eligible) is simpler but loses the acceptance contract — rejected on the same grounds as the SPEC.md deprecation.

### D-003 — Repo boundary for the child — OPEN, needs avi
Date: 2026-05-31. (a) **own repo** (template clones/inits a fresh repo — cleanest isolation, matches `scaffold_harness`'s `papercusp init --from <template>` today); (b) **submodule of parent** (the `classify-tree.ts` sub-harness model — shares parent repo, path-qualified slug); (c) shared parent tree + separate queue (awkward middle ground). Recommendation: **(a) own repo via template** as the only v1 path — it's what `doScaffoldHarness` already does and it's the boundary that justifies a child per D-001. `spawn_child.template` names the spawnable template; `spawn_child.repo` (optional git URL) overrides. Defer (b).

### D-004 — Atomicity + failure model — OPEN, needs avi
Date: 2026-05-31. `spawn_child` is multi-step (scaffold → synth plan → import → start); a mid-sequence failure must not leave an orphan. Recommendation: idempotent + best-effort: scaffold is already idempotent on slug (`token_index` uniqueness); on a later-step failure, log + surface in promote `warnings[]` and leave the child "scaffolded-but-unseeded" for retry, rather than hard-deleting a PG schema mid-flight. Promote is preview-first (`apply:false`) so the agent sees the plan before committing.

## Out of scope (do not fold in)
- Submodule-style children (D-003 option b) — defer.
- Cross-workspace children — `doScaffoldHarness` uses `activeWorkspaceId()`; a child lands in the active workspace. Cross-workspace placement is a separate known gap.
- A standalone `harness:spawn_child` MCP tool — explicitly rejected; spawning rides promote so it's always plan-backed + boundary-gated.
- Reviving `orchestrator.spawn` MCP / `NEXT_HARNESS` in the DBOS path — not needed; DBOS auto-dispatches the new child.
