---
title: Per-harness plans + project-docs adapter — portability beyond the Papercusp codebase
slug: per-harness-plans-and-docs-2026-05-23
status: draft
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

**State:** Draft. Closes 2 of 3 non-identity couplings to the Papercusp codebase identified in the 2026-05-22 catalog audit: `plans:*` (one global plan dir hardcoded into the operator's monorepo) and `docs:*` no-harness branch (engineering adapter hardwired). The third coupling (`design-phase.list_memos`/`read_memo`) is out of scope by design.
**Next:** User ratifies P-001 / P-006 / P-007 / P-008 (four `needs-human` items). P-001 ungates Phase 1; P-006..P-008 ungate Phase 2.

# Per-harness plans + project-docs adapter

## §1 Why

papercusp-su is already a multi-project system — harnesses are the "other projects." Almost every tool is slug-parameterized; the harness model carries portability for free. But two surfaces leak through and read the operator's own source tree (= the Papercusp codebase) instead of the harness they're pointed at:

1. **`plans:*`** — `plans/source.ts` resolves `<repoRoot>/apps/operator/docs/plans/`. A harness engineer running `plans:list` gets *Papercusp's* plans, not their harness's.
2. **`docs:*` no-harness branch** — `_engineering-adapter.ts` is hardwired to `<repoRoot>/apps/operator-docs/src/content/docs/`. A caller with no `harnessSlug` always gets Papercusp engineering docs.

Closing these makes papercusp-su genuinely portable to any harness without behavioral surprises.

## §2 Scope

- **Phase 1** — `docs:*` gets a third `resolveAdapter` branch: `ctx.projectDocsRoot` → generic on-disk adapter. (Small.)
- **Phase 2** — `plans:*` becomes per-harness: data model, tool resolution, lock keys, PG schema, migration. (Big.)

**Not in scope:** `design-phase.list_memos`/`read_memo` (Papercusp-engineering by design); identity/persona rewrite (`omp-power-user-bundle` D-008b); per-harness `engineeringAdapter` (no use case identified).

## §3 Decision context (alternatives behind the needs-human items)

### context for P-001 — where does `ctx.projectDocsRoot` come from?

- **(a)** Env var `PAPERCUSP_PROJECT_DOCS_ROOT`, set by `omp-su` wrapper / user shell. **Recommended** — explicit, simple, opt-in. One-line addition to the wrapper.
- **(b)** Workspace setting persisted in operator config.
- **(c)** Convention — walk up from cwd to find `docs/` or `README.md`.

### context for P-006 — per-harness plans on-disk location

- **(a)** `<harness.path>/docs/plans/` — sibling of the harness's own source. **Recommended** — travels with the harness repo; matches how Papercusp does it today (Papercusp's plans are in its own repo).
- **(b)** `<workspaceRoot>/.papercusp/plans/<harness-slug>/` — workspace-centralized. Operator owns the dir; works regardless of harness repo state. Con: not visible from inside the harness repo.
- **(c)** Per-harness override (frontmatter or harness config), default (b).

### context for P-007 — `plans:*` tool signature

- **(a)** Ctx-only, mirrors `docs:*`. Cross-harness lookups go through a sibling `cross_harness:plans_*` scope. **Recommended** — consistency with `docs:*` is high-value; agents already learned the pattern.
- **(b)** Explicit `harnessSlug` arg on every call.
- **(c)** Ctx default + optional arg override.

### context for P-008 — no-harness fallback for `plans:*`

- **(a)** Treat Papercusp as the `papercup` harness — fall through to `papercup` plans. **Recommended** — preserves today's behavior for SU; least disruptive.
- **(b)** Workspace-global plans dir (`<workspaceRoot>/.papercusp/plans/_workspace/`).
- **(c)** Error — "no harness in context; pass a slug to `cross_harness:plans_*`."

## §4 Phase 1 design — `docs:*` third adapter branch

Add to `outline.ts` / `get.ts` / `search.ts`'s shared `resolveAdapter`:

```ts
if (!harnessSlug) {
  if (ctx.projectDocsRoot) {
    return {
      adapter: genericFsAdapter(ctx.projectDocsRoot, { name: 'project' }),
      scope: '_project',
      surface: 'project',
    };
  }
  return { adapter: engineeringAdapter, scope: '_engineering', surface: 'engineering' };
}
```

Acceptance: with `PAPERCUSP_PROJECT_DOCS_ROOT=/path/to/my/docs`, `docs:outline` (no harness context) returns that tree; without it, returns Papercusp engineering docs (unchanged). Harness-set callers unchanged. ~80 LoC + 3 tests, one PR.

## §5 Phase 2 design — `plans:*` per-harness

### §5.1 Data model

- `plans/source.ts`: replace single `repoRoot`-based resolution with `resolveHarnessPlansDir(harnessSlug)`. Uses the harness registry to get `<harness.path>`, appends `/docs/plans/`. No-harness callers get the existing behavior via the `papercup` slug (per P-008a).
- PG: `plan_revisions` and the launch/run tables — add `harness_slug` column (NOT NULL, default `'papercup'` on backfill). Compound key becomes `(harness_slug, plan_slug, seq)`.
- `withPlanLock(slug, ...)` → `withPlanLock(harnessSlug, slug, ...)`. Lock key derives from `(harness_slug, plan_slug)`.

### §5.2 Tool changes

All 25 `plans:*` tools:
- Resolve `harnessSlug` from `ctx.harnessSlug` (per P-007a). Fall through to `papercup` if absent (per P-008a).
- ID allocation becomes per-harness — no cross-harness collisions.
- `plans:list` returns plans for *that harness only*. Cross-harness listing → new `cross_harness:plans_list`.
- `plans:promote` already passes harnessSlug to the promotion target; unchanged. New constraint: source plan must live in the same harness (or `papercup`).

### §5.3 `cross_harness:plans_*` carve-out

Three new tools mirroring `cross_harness:docs_*`: `cross_harness:plans_list`, `plans_get`, `plans_search`. Explicit `harnessSlug` arg; read-only — writes always go through ambient `plans:*`. ~150 LoC + 3 tests.

### §5.4 Migration

- One PG migration adding `harness_slug` columns + backfill `= 'papercup'`.
- **Filesystem: no file moves required.** The existing `apps/operator/docs/plans/` is already inside the `papercup` harness's path; the resolution rule changes from "operator's `repoRoot`" to "`papercup` harness's `path`" — same directory.
- Plan slugs unique within a harness; existing slugs unchanged.

### §5.5 Risks

- **Slug collision with `papercup` harness path.** If `papercup` harness path is computed differently from `REPO_ROOT`, existing plans appear to "move." Mitigation: P-014 runtime guard.
- **Lock key change is breaking** for any in-flight SU shell holding a `plan-<slug>` lock at deploy time. Mitigation: ship at a quiet moment; locks have a 1200s TTL.

## Phase 1 — docs:* third adapter branch

- **P-001** `needs-human` Decide where `ctx.projectDocsRoot` comes from. Recommendation: env var `PAPERCUSP_PROJECT_DOCS_ROOT`. See §3.
- **P-002** `todo` Add `genericFsAdapter(root, opts)` to `@papercusp/docs-engine` — a thin FS adapter without harness-registry coupling. blocked-by: P-001
- **P-003** `todo` Extend `RouteContext`/`AgentContext` with `projectDocsRoot?: string`; read from env var at request-context construction. blocked-by: P-001
- **P-004** `todo` Add the `ctx.projectDocsRoot` branch to `docs/outline.ts`, `docs/get.ts`, `docs/search.ts`'s `resolveAdapter` (3 files). blocked-by: P-002, P-003
- **P-005** `todo` Tests: one each for outline/get/search asserting `surface === 'project'` when env var set. blocked-by: P-004

## Phase 2 — plans:* per-harness

- **P-006** `needs-human` Decide per-harness plans on-disk location. Recommendation: `<harness.path>/docs/plans/`. See §3.
- **P-007** `needs-human` Decide `plans:*` tool signature (ctx vs arg vs both). Recommendation: ctx-only + `cross_harness:plans_*`. See §3.
- **P-008** `needs-human` Decide no-harness fallback. Recommendation: treat Papercusp as harness `papercup`. See §3.
- **P-009** `todo` Repoint `plans/source.ts` to `resolveHarnessPlansDir(harnessSlug)` using the harness registry. blocked-by: P-006
- **P-010** `todo` PG migration: add `harness_slug` NOT NULL DEFAULT `'papercup'` to plan_revisions + plan runs tables; backfill; compound key `(harness_slug, plan_slug, seq)`. blocked-by: P-006
- **P-011** `todo` Update `withPlanLock` to include `harnessSlug` in the lock key. blocked-by: P-006
- **P-012** `todo` Update all 25 `plans:*` tools to resolve `harnessSlug` from ctx; per-harness ID counters. blocked-by: P-007, P-009, P-011
- **P-013** `todo` Build `cross_harness:plans_*` (list/get/search) carve-out — explicit `harnessSlug` arg, read-only. blocked-by: P-007
- **P-014** `todo` Runtime guard: verify `harnessRegistry.find('papercup').path === REPO_ROOT` at startup; abort migration on mismatch. blocked-by: P-010
- **P-015** `todo` Update all 25 `plans:*` tool descriptions to mention per-harness scope. blocked-by: P-012

## §7 Out of scope

- `design-phase.list_memos` / `read_memo` — intentionally Papercusp-engineering tools.
- Identity / persona rewrite — covered by `omp-power-user-bundle` D-008b.
- Per-harness `engineeringAdapter` — no use case; harnesses get their own docs via `harnessFsAdapter`.
- Workspace-level plans bucket (P-008b alternative).

## Decisions

(none yet — appended as `### D-NNN — title` entries when the four `needs-human` items above are ratified.)
