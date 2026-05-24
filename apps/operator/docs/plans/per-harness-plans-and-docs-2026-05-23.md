---
title: Per-harness plans + project-docs adapter — portability beyond the Papercusp codebase
slug: per-harness-plans-and-docs-2026-05-23
status: active
created: 2026-05-23
updated: 2026-05-23
owner: pandawamble@gmail.com
related:
  - apps/operator/docs/plans/agent-plan-tracking-2026-05-20.md
  - apps/operator/docs/plans/plans-system-brief-2026-05-20.md
  - apps/operator/docs/plans/omp-power-user-bundle-2026-05-20.md
  - apps/operator/docs/plans/plan-agent-launch-2026-05-21.md
---

## Now

**State:** Active. Closes the 2 non-identity couplings to the Papercusp codebase identified in the 2026-05-22 catalog audit (`plans:*` global plan dir + `docs:*` no-harness fallback), plus a third correction surfaced 2026-05-23: the `docs:*` engineering branch was leaking Papercusp's docs to any no-harness caller — it should be gated to `papercusp-su` (SU/engineer) callers only. Decisions D-001 through D-005 ratified.
**Next:** Implement P-002 — `genericFsAdapter` in `@papercusp/docs-engine`. Then P-003 (ctx field), P-004 (wire the third + gating branch), P-016 (engineering gate), P-005 (tests).

# Per-harness plans + project-docs adapter

## §1 Why

papercusp-su is already a multi-project system — harnesses are the "other projects." Almost every tool is slug-parameterized; the harness model carries portability for free. But two surfaces leak through and read the operator's own source tree (= the Papercusp codebase) instead of the harness they're pointed at, and a third surface (the `docs:*` engineering fallback) silently serves Papercusp's docs to callers who never asked for them:

1. **`plans:*`** — `plans/source.ts` resolves `<repoRoot>/apps/operator/docs/plans/`. A harness engineer running `plans:list` gets *Papercusp's* plans, not their harness's. Also: no workspace-scope bucket — cross-harness infra plans (coord/locks/bundles) end up in the `papercup` harness by accident.
2. **`docs:*` no-harness branch** — `_engineering-adapter.ts` is hardwired to `<repoRoot>/apps/operator-docs/src/content/docs/`. A caller with no `harnessSlug` falls through to Papercusp engineering docs.
3. **The fallback is wrong, not just unportable** — engineering docs should only surface for `papercusp-su` (SU/engineer) callers. A power engineer running `omp-su` on their own raw repo currently gets Papercusp's docs silently; they should get an error or empty result (until P-001 lets them point at their own docs).

Closing all three makes papercusp-su genuinely portable to any harness without behavioral surprises.

## §2 Scope

- **Phase 1** — `docs:*` gets a third `resolveAdapter` branch (`ctx.projectDocsRoot` → generic adapter) AND the engineering branch gets gated to SU callers.
- **Phase 2** — `plans:*` becomes per-harness + supports a workspace-scope bucket: data model, tool resolution, lock keys, PG schema, migration.

**Not in scope:** `design-phase.list_memos`/`read_memo` (Papercusp-engineering by design); identity/persona rewrite (covered in `playbook-audience-neutral-rewrite-2026-05-23`); per-harness `engineeringAdapter` (no use case identified); the slug rename `papercup`→`papercusp` (decided 2026-05-23: leave the slug as-is for now).

## §3 Decision context (ratified — see ## Decisions)

### D-001 ratified — `ctx.projectDocsRoot` source

Env var `PAPERCUSP_PROJECT_DOCS_ROOT`, set by `omp-su` wrapper / user shell. Explicit, opt-in, survives across processes, one-line in the wrapper. Workspace-setting alternative drags in persistence/UI/migration; convention (walk for `docs/`) is silent magic that fails opaquely.

### D-002 ratified — per-harness plans location + workspace bucket

Per-harness plans live at `<harness.path>/docs/plans/` — they're project artifacts and belong with the project's git history. **Plus:** workspace-scoped plans live at `<workspaceRoot>/.papercusp/plans/` — a first-class second bucket for cross-harness infra work (coord, locks, bundles, this plan) that today lives in `papercup` by accident.

### D-003 ratified — `plans:*` signature

Ctx-only on `plans:*` (mirrors `docs:*`); a new `cross_harness:plans_*` carve-out handles explicit-slug lookups (mirrors `cross_harness:docs_*`). Two tools, two distinct use cases: "your context" vs "look at someone else's." Eliminates the "does arg or ctx win" confusion vector of a single-tool-with-override design.

### D-004 ratified — no-harness fallback (supersedes original P-008 "treat as papercup")

No-harness ctx → workspace bucket (`<workspaceRoot>/.papercusp/plans/`), **not** the `papercup` harness's plans. Removes the conflation between "Papercusp-engineering work" and "workspace-scoped infra work that happens to live in Papercusp's repo today." Cross-harness listing requires `cross_harness:plans_*`.

### D-005 ratified — engineering docs branch is `papercusp-su` only

The current `docs:*` fallback silently serves `apps/operator-docs/src/content/docs/` to any caller without a `harnessSlug`. That leaks Papercusp's engineering docs to power-engineer callers who never asked for them. Fix: gate the engineering branch on SU/engineer ctx (e.g., `ctx.isSuperuser` from the `?superuser=1` route param). For non-SU callers with no harness and no `projectDocsRoot`, return an empty/error result.

## §4 Phase 1 design — `docs:*` third adapter branch + engineering-branch gate

Add `genericFsAdapter` to `@papercusp/docs-engine`, extend ctx with `projectDocsRoot?: string` and a SU-mode flag, and update `resolveAdapter` in `outline.ts`/`get.ts`/`search.ts`:

```ts
if (!harnessSlug) {
  if (ctx.projectDocsRoot) {
    return {
      adapter: genericFsAdapter(ctx.projectDocsRoot, { name: 'project' }),
      scope: '_project',
      surface: 'project',
    };
  }
  if (ctx.isSuperuser) {
    // SU/engineer (papercusp-su) callers fall through to Papercusp docs
    return { adapter: engineeringAdapter, scope: '_engineering', surface: 'engineering' };
  }
  // Power-engineer with no project docs — don't leak Papercusp's docs
  return { error: { code: 'no_docs_source', detail: 'No harness, no projectDocsRoot, not SU' } };
}
```

Acceptance: with `PAPERCUSP_PROJECT_DOCS_ROOT=/path/to/my/docs`, `docs:outline` returns that tree (`surface: 'project'`). Without it, an SU caller still gets Papercusp engineering docs (unchanged for that audience); a non-SU caller gets the new `no_docs_source` error. Harness-set callers unchanged. ~120 LoC + 5 tests, one PR.

## §5 Phase 2 design — `plans:*` per-harness + workspace bucket

### §5.1 Data model

- `plans/source.ts`: replace single `repoRoot`-based resolution with `resolveScope(ctx)`:
  - `ctx.harnessSlug` set → `<harness.path>/docs/plans/` (looked up via harness registry).
  - no harness → `<workspaceRoot>/.papercusp/plans/` (workspace bucket).
  - explicit `scope: 'workspace'` arg overrides harness ctx for `plans:new`.
- PG: `plan_revisions` and the launch/run tables — add a single `scope` column carrying either `harness:<slug>` or `workspace:<workspaceId>`. NOT NULL with backfill via the rules below.
- `withPlanLock(scope, slug, ...)` — lock key includes the scope string.

### §5.2 Tool changes

All 25 `plans:*` tools:
- Resolve scope from `ctx.harnessSlug` (harness) or fall through to the workspace bucket. Per-scope ID counters — no cross-scope collisions.
- `plans:list` returns plans for the resolved scope only. Cross-scope listing → new `cross_harness:plans_*`.
- `plans:new`/`plans:set-now`/etc. all route through `withPlanLock(scope, slug, …)`.
- `plans:promote` already passes a target harnessSlug; unchanged.

### §5.3 `cross_harness:plans_*` carve-out

Three new tools mirroring `cross_harness:docs_*`: `cross_harness:plans_list`, `plans_get`, `plans_search`. Explicit `harnessSlug` arg (or `workspace: true` for the workspace bucket); read-only — writes go through ambient `plans:*`. ~150 LoC + 3 tests.

### §5.4 Migration

- One PG migration adding `scope` column + backfill rules per plan frontmatter (see P-014).
- **Filesystem migration is real this time** (the original draft's "no-op" claim was wrong once we added the workspace bucket): identify each existing plan as harness-scoped or workspace-scoped, move workspace-scoped ones to `<workspaceRoot>/.papercusp/plans/`. The bulk are workspace-scoped (coord, locks, bundles, this plan) and get moved; the few that are genuinely about Papercusp-the-product stay in `<papercup-path>/docs/plans/`.
- Adopting a `scope: workspace|harness` frontmatter field gives the migration a clean rule + future plan authors a clear choice.

### §5.5 Risks

- **Misclassification during migration.** A plan moved to the wrong bucket is hard to find. Mitigation: P-014 enumerates each existing plan with the proposed bucket before the move; reviewable as a pre-migration PR.
- **Lock key change is breaking** for any in-flight SU shell holding a `plan-<slug>` lock at deploy time. Mitigation: ship at a quiet moment; locks have a 1200s TTL.

## Phase 1 — docs:* third adapter branch + engineering-branch gate

- **P-001** `done` Decided D-001: `ctx.projectDocsRoot` source = env var `PAPERCUSP_PROJECT_DOCS_ROOT`.
- **P-002** `todo` Add `genericFsAdapter(root, opts)` to `@papercusp/docs-engine` — a thin FS adapter without harness-registry coupling.
- **P-003** `todo` Extend `RouteContext`/`AgentContext` with `projectDocsRoot?: string` AND `isSuperuser?: boolean`; populate both from the request (env var + `?superuser=1`).
- **P-004** `todo` Add the `ctx.projectDocsRoot` branch to `docs/outline.ts`, `docs/get.ts`, `docs/search.ts`'s `resolveAdapter` (3 files). blocked-by: P-002, P-003
- **P-016** `todo` Gate the engineering-adapter branch on `ctx.isSuperuser` per D-005; non-SU/non-projectDocsRoot callers get an empty/error response, not Papercusp's docs. blocked-by: P-003, P-004
- **P-005** `todo` Tests: outline/get/search asserting `surface === 'project'` when env var set; SU-mode unchanged (engineering surface); non-SU + no-project gets error. blocked-by: P-016

## Phase 2 — plans:* per-harness + workspace bucket

- **P-006** `done` Decided D-002: per-harness plans at `<harness.path>/docs/plans/`; workspace plans at `<workspaceRoot>/.papercusp/plans/`.
- **P-007** `done` Decided D-003: `plans:*` ctx-only + `cross_harness:plans_*` carve-out.
- **P-008** `done` Decided D-004: no-harness fallback = workspace bucket (supersedes original "treat as papercup").
- **P-009** `todo` Repoint `plans/source.ts` to `resolveScope(ctx)` per §5.1 — harness or workspace.
- **P-010** `todo` PG migration: replace per-plan keying with `(scope, plan_slug, seq)` on plan_revisions + plan runs; backfill via frontmatter `scope` field (see P-014).
- **P-011** `todo` Update `withPlanLock` to include `scope` in the lock key. blocked-by: P-009
- **P-012** `todo` Update all 25 `plans:*` tools to resolve scope from ctx; per-scope ID counters. blocked-by: P-009, P-011
- **P-013** `todo` Build `cross_harness:plans_*` (list/get/search) carve-out — explicit `harnessSlug` or `workspace: true` arg, read-only.
- **P-014** `todo` Enumerate every existing plan with its proposed bucket (harness vs workspace); produce a reviewable migration manifest before any file moves. Adopt `scope:` frontmatter field.
- **P-015** `todo` Execute the filesystem migration per P-014's manifest; move workspace-scoped plans to `<workspaceRoot>/.papercusp/plans/`. blocked-by: P-014
- **P-017** `todo` Update all 25 `plans:*` tool descriptions to mention scope resolution. blocked-by: P-012

## §7 Out of scope

- `design-phase.list_memos` / `read_memo` — intentionally Papercusp-engineering tools.
- Identity / persona rewrite — covered by `playbook-audience-neutral-rewrite-2026-05-23`.
- Per-harness `engineeringAdapter` — no use case; harnesses get their own docs via `harnessFsAdapter`.
- Slug rename `papercup`→`papercusp` — decided 2026-05-23 to defer; the dir + slug stay as-is.

## Decisions

### D-001 — `ctx.projectDocsRoot` is provided via env var `PAPERCUSP_PROJECT_DOCS_ROOT`

Date: 2026-05-23

Refs: P-001

Set by the `omp-su` wrapper (or the user's shell). Explicit and opt-in. Alternatives considered: workspace setting (drags in persistence + UI + migration), convention walk-up for `docs/` (silent magic, fails opaquely). Env var is the lowest-friction explicit option and matches the wrapper's existing idiom.

### D-002 — Per-harness plans live at `<harness.path>/docs/plans/`; workspace-scoped plans live at `<workspaceRoot>/.papercusp/plans/`

Date: 2026-05-23

Refs: P-006

Two first-class buckets. Per-harness plans are project artifacts that travel with the project's git history (this is what Papercusp does by accident today — its plans are in its own repo path). Workspace-scoped plans get their own bucket for cross-harness infra work (coord/locks/bundles/this plan) instead of being misfiled into `papercup` by default.

### D-003 — `plans:*` uses ctx-only signatures; `cross_harness:plans_*` carve-out for explicit-slug lookups

Date: 2026-05-23

Refs: P-007

Direct mirror of `docs:*`/`cross_harness:docs_*`. Agents on their own harness don't repeat the slug they're already in; cross-harness lookups are an opt-in act ("I'm peeking at somebody else's harness"). One mental model: no `cross_harness:` prefix = your scope; with prefix = somebody else's.

### D-004 — No-harness fallback for `plans:*` resolves to the workspace bucket (NOT the `papercup` harness)

Date: 2026-05-23

Refs: P-008

Supersedes the original P-008(a) recommendation. With D-002 introducing a first-class workspace bucket, falling through to `papercup` would conflate "Papercusp-engineering work" with "workspace-scoped infra work that happens to live in Papercusp's repo today." Default for a no-harness `plans:list` is the workspace bucket; cross-harness listing requires `cross_harness:plans_*`.

### D-005 — `docs:*` engineering branch is gated on SU/engineer ctx, not the silent default

Date: 2026-05-23

Refs: P-016

The current `docs:*` code silently serves Papercusp's engineering docs (`apps/operator-docs/src/content/docs/`) for **any** caller without a `harnessSlug`. That's wrong: engineering docs should surface only for `papercusp-su` (SU/engineer) callers — agents launched via the SU MCP at `?superuser=1`. A power-engineer caller on their own raw repo (no harness, no `projectDocsRoot`) should get an error/empty response, not Papercusp's docs leaked silently. The gate signal: `ctx.isSuperuser` (or equivalent) plumbed through from the route's `?superuser=1` param.
