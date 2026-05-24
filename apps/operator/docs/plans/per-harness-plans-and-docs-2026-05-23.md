---
title: Per-harness plans + project-docs adapter — portability beyond the Papercusp codebase
slug: per-harness-plans-and-docs-2026-05-23
status: active
created: 2026-05-23
updated: 2026-05-24
owner: pandawamble@gmail.com
related:
  - apps/operator/docs/plans/agent-plan-tracking-2026-05-20.md
  - apps/operator/docs/plans/plans-system-brief-2026-05-20.md
  - apps/operator/docs/plans/omp-power-user-bundle-2026-05-20.md
  - apps/operator/docs/plans/plan-agent-launch-2026-05-21.md
---

## Now

**State:** Active. Closes the 2 non-identity couplings to the Papercusp codebase identified in the 2026-05-22 catalog audit (`plans:*` global plan dir + `docs:*` no-harness fallback) plus the 2026-05-23 correction that the `docs:*` engineering branch should only serve SU/engineer callers. Design simplified 2026-05-24 (D-002R / D-004R): **no workspace-scope bucket** — every plan belongs to a harness; cross-harness planning is organized via sub-harnesses (a parent harness whose children are the affected harnesses). P-002 (`genericFsAdapter`) shipped at `a4ccbed8`.
**Next:** P-003 — extend `RouteContext`/`AgentContext` with `projectDocsRoot?: string` + `isSuperuser?: boolean`; populate from env var + `?superuser=1`.

# Per-harness plans + project-docs adapter

## §1 Why

papercusp-su is already a multi-project system — harnesses are the "other projects." Almost every tool is slug-parameterized; the harness model carries portability for free. But two surfaces leak through and read the operator's own source tree (= the Papercusp codebase) instead of the harness they're pointed at, and a third surface (the `docs:*` engineering fallback) silently serves Papercusp's docs to callers who never asked for them:

1. **`plans:*`** — `plans/source.ts` resolves `<repoRoot>/apps/operator/docs/plans/`. A harness engineer running `plans:list` gets *Papercusp's* plans, not their harness's.
2. **`docs:*` no-harness branch** — `_engineering-adapter.ts` is hardwired to `<repoRoot>/apps/operator-docs/src/content/docs/`. A caller with no `harnessSlug` falls through to Papercusp engineering docs.
3. **The fallback is wrong, not just unportable** — engineering docs should only surface for `papercusp-su` (SU/engineer) callers. A power engineer running `omp-su` on their own raw repo currently gets Papercusp's docs silently; they should get an error or empty result (until P-001 lets them point at their own docs).

**Cross-harness planning** (the case I originally tried to model with a "workspace-scope bucket") is handled by the **sub-harness** structure already being implemented: a parent harness's plans cover work that affects its children. Today, all currently-"workspace-scoped" plans (coord, locks, bundles, this plan) naturally belong to `papercup` — the harness that builds the platform other harnesses inherit from. No separate bucket needed.

## §2 Scope

- **Phase 1** — `docs:*` gets a third `resolveAdapter` branch (`ctx.projectDocsRoot` → generic adapter) AND the engineering branch gets gated to SU callers.
- **Phase 2** — `plans:*` becomes per-harness. Resolution rule: `ctx.harnessSlug` set → that harness's plans; absent → the workspace's primary/root harness (today = `papercup`, the harness whose path == `REPO_ROOT`).

**Not in scope:** `design-phase.list_memos`/`read_memo` (Papercusp-engineering by design); identity/persona rewrite (covered in `playbook-audience-neutral-rewrite-2026-05-23`); per-harness `engineeringAdapter` (no use case identified); the slug rename `papercup`→`papercusp` (decided 2026-05-23: leave as-is for now); a workspace-scope plans bucket (decided 2026-05-24: sub-harnesses cover it).

## §3 Decision context (ratified — see ## Decisions)

### D-001 ratified — `ctx.projectDocsRoot` source

Env var `PAPERCUSP_PROJECT_DOCS_ROOT`, set by `omp-su` wrapper / user shell. Explicit, opt-in, survives across processes, one-line in the wrapper. Workspace-setting alternative drags in persistence/UI/migration; convention (walk for `docs/`) is silent magic that fails opaquely.

### D-002R revised (2026-05-24) — per-harness plans only

Per-harness plans live at `<harness.path>/docs/plans/`. **No workspace bucket** — every plan belongs to a harness. The original revision (2026-05-23) added a workspace bucket; that was reverted 2026-05-24 in favor of using sub-harnesses to organize cross-harness planning. A parent harness's plans cover work that affects its children (e.g., `papercup` builds the platform that other harnesses inherit).

### D-003 ratified — `plans:*` signature

Ctx-only on `plans:*` (mirrors `docs:*`); a new `cross_harness:plans_*` carve-out handles explicit-slug lookups (mirrors `cross_harness:docs_*`). Two tools, two distinct use cases: "your context" vs "look at someone else's." Eliminates the "does arg or ctx win" confusion vector of a single-tool-with-override design.

### D-004R revised (2026-05-24) — no-harness fallback

No-harness ctx → fall through to the workspace's primary/root harness (today = `papercup`, the harness whose path == `REPO_ROOT`). Preserves the existing SU-agent workflow unchanged (those calls currently get `papercup`'s plans by accident; now they get them by design). Cross-harness listing requires `cross_harness:plans_*` with an explicit slug. The earlier "workspace bucket" answer is dropped along with D-002's bucket.

### D-005 ratified — engineering docs branch is `papercusp-su` only

The current `docs:*` fallback silently serves `apps/operator-docs/src/content/docs/` to any caller without a `harnessSlug`. That leaks Papercusp's engineering docs to power-engineer callers who never asked for them. Fix: gate the engineering branch on SU/engineer ctx (e.g., `ctx.isSuperuser` from the `?superuser=1` route param). For non-SU callers with no harness and no `projectDocsRoot`, return an empty/error result.

## §4 Phase 1 design — `docs:*` third adapter branch + engineering-branch gate

Add `genericFsAdapter` to `@papercusp/docs-engine` (✓ done, `a4ccbed8`), extend ctx with `projectDocsRoot?: string` and `isSuperuser?: boolean`, and update `resolveAdapter` in `outline.ts`/`get.ts`/`search.ts`:

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

## §5 Phase 2 design — `plans:*` per-harness

### §5.1 Data model

- `plans/source.ts`: replace single `repoRoot`-based resolution with `resolveHarnessPlansDir(harnessSlug)`. Uses the harness registry to get `<harness.path>`, appends `/docs/plans/`. For no-harness callers, the resolution chooses the workspace's primary/root harness (today: `papercup`).
- PG: `plan_revisions` and the launch/run tables — add a `harness_slug` column NOT NULL, backfill `= 'papercup'`. Compound key becomes `(harness_slug, plan_slug, seq)`.
- `withPlanLock(harnessSlug, slug, ...)` — lock key includes the slug.

### §5.2 Tool changes

All 25 `plans:*` tools:
- Resolve `harnessSlug` from `ctx.harnessSlug`; absent → root harness. Per-harness ID counters — no cross-harness collisions.
- `plans:list` returns plans for *that harness only*. Cross-harness listing → new `cross_harness:plans_*`.
- `plans:promote` already passes a target harnessSlug; unchanged.

### §5.3 `cross_harness:plans_*` carve-out

Three new tools mirroring `cross_harness:docs_*`: `cross_harness:plans_list`, `plans_get`, `plans_search`. Explicit `harnessSlug` arg; read-only — writes go through ambient `plans:*`. ~150 LoC + 3 tests.

### §5.4 Migration

- One PG migration adding `harness_slug` column + backfill `= 'papercup'`.
- **Filesystem: no file moves required.** All existing plans stay where they are — the existing `apps/operator/docs/plans/` is `<papercup-harness-path>/apps/operator/docs/plans/`. The resolution rule changes from "operator's `repoRoot`" to "`papercup` harness's `path`" — same directory.

### §5.5 Risks

- **Slug collision with `papercup` harness path.** If `papercup` harness path is computed differently from `REPO_ROOT`, existing plans appear to "move." Mitigation: P-014 runtime guard.
- **Lock key change is breaking** for any in-flight SU shell holding a `plan-<slug>` lock at deploy time. Mitigation: ship at a quiet moment; locks have a 1200s TTL.

## Phase 1 — docs:* third adapter branch + engineering-branch gate

- **P-001** `done` Decided D-001: `ctx.projectDocsRoot` source = env var `PAPERCUSP_PROJECT_DOCS_ROOT`.
- **P-002** `done` `genericFsAdapter` added to `@papercusp/docs-engine` — commit `a4ccbed8`. 13/13 new tests green, existing suite unchanged, tsc clean.
- **P-003** `todo` Extend `RouteContext`/`AgentContext` with `projectDocsRoot?: string` AND `isSuperuser?: boolean`; populate both from the request (env var + `?superuser=1`).
- **P-004** `todo` Add the `ctx.projectDocsRoot` branch to `docs/outline.ts`, `docs/get.ts`, `docs/search.ts`'s `resolveAdapter` (3 files). blocked-by: P-002, P-003
- **P-016** `todo` Gate the engineering-adapter branch on `ctx.isSuperuser` per D-005; non-SU/non-projectDocsRoot callers get an empty/error response, not Papercusp's docs. blocked-by: P-003, P-004
- **P-005** `todo` Tests: outline/get/search asserting `surface === 'project'` when env var set; SU-mode unchanged (engineering surface); non-SU + no-project gets error. blocked-by: P-016

## Phase 2 — plans:* per-harness

- **P-006** `done` Decided D-002R: per-harness plans at `<harness.path>/docs/plans/`. No workspace bucket.
- **P-007** `done` Decided D-003: `plans:*` ctx-only + `cross_harness:plans_*` carve-out.
- **P-008** `done` Decided D-004R: no-harness fallback = workspace's primary/root harness (today = `papercup`).
- **P-009** `todo` Repoint `plans/source.ts` to `resolveHarnessPlansDir(harnessSlug)` per §5.1 — looks up `<harness.path>` via the harness registry; no-harness ctx → root harness.
- **P-010** `todo` PG migration: add `harness_slug` NOT NULL DEFAULT `'papercup'` to plan_revisions + plan runs tables; backfill; compound key `(harness_slug, plan_slug, seq)`.
- **P-011** `todo` Update `withPlanLock` to include `harnessSlug` in the lock key. blocked-by: P-009
- **P-012** `todo` Update all 25 `plans:*` tools to resolve `harnessSlug` from ctx; per-harness ID counters. blocked-by: P-009, P-011
- **P-013** `todo` Build `cross_harness:plans_*` (list/get/search) carve-out — explicit `harnessSlug` arg, read-only.
- **P-014** `todo` Runtime guard: verify `harnessRegistry.find('papercup').path === REPO_ROOT` at startup; abort migration on mismatch.
- **P-017** `todo` Update all 25 `plans:*` tool descriptions to mention per-harness scope. blocked-by: P-012

## §7 Out of scope

- `design-phase.list_memos` / `read_memo` — intentionally Papercusp-engineering tools.
- Identity / persona rewrite — covered by `playbook-audience-neutral-rewrite-2026-05-23`.
- Per-harness `engineeringAdapter` — no use case; harnesses get their own docs via `harnessFsAdapter`.
- Slug rename `papercup`→`papercusp` — decided 2026-05-23 to defer; the dir + slug stay as-is.
- Workspace-scope plans bucket — decided 2026-05-24: sub-harnesses already cover cross-harness planning.

## Decisions

### D-001 — `ctx.projectDocsRoot` is provided via env var `PAPERCUSP_PROJECT_DOCS_ROOT`

Date: 2026-05-23

Refs: P-001

Set by the `omp-su` wrapper (or the user's shell). Explicit and opt-in. Alternatives considered: workspace setting (drags in persistence + UI + migration), convention walk-up for `docs/` (silent magic, fails opaquely). Env var is the lowest-friction explicit option and matches the wrapper's existing idiom.

### D-002R — Per-harness plans live at `<harness.path>/docs/plans/`; no workspace bucket

Date: 2026-05-24

Refs: P-006

Supersedes the 2026-05-23 D-002 (which introduced a workspace bucket at `<workspaceRoot>/.papercusp/plans/`). Reverted on user direction: cross-harness planning is organized via **sub-harnesses** (a parent harness's plans cover work that affects its children) rather than a separate bucket. Today, all currently-"workspace-scoped" plans (coord, locks, bundles, this plan) naturally belong to `papercup` — the harness that builds the platform other harnesses inherit from. No separate bucket needed; the conflation objection is dissolved because these plans really *are* `papercup`-the-platform's plans.

### D-003 — `plans:*` uses ctx-only signatures; `cross_harness:plans_*` carve-out for explicit-slug lookups

Date: 2026-05-23

Refs: P-007

Direct mirror of `docs:*`/`cross_harness:docs_*`. Agents on their own harness don't repeat the slug they're already in; cross-harness lookups are an opt-in act ("I'm peeking at somebody else's harness"). One mental model: no `cross_harness:` prefix = your scope; with prefix = somebody else's.

### D-004R — No-harness fallback for `plans:*` resolves to the workspace's primary/root harness

Date: 2026-05-24

Refs: P-008

Supersedes the 2026-05-23 D-004 (workspace bucket) along with D-002. With no workspace bucket, no-harness ctx falls through to the workspace's primary harness — today, `papercup` (the harness whose path == `REPO_ROOT`). Preserves the existing SU-agent workflow unchanged (those calls currently get `papercup`'s plans by accident; now they get them by design). Cross-harness listing requires `cross_harness:plans_*` with an explicit slug.

### D-005 — `docs:*` engineering branch is gated on SU/engineer ctx, not the silent default

Date: 2026-05-23

Refs: P-016

The current `docs:*` code silently serves Papercusp's engineering docs (`apps/operator-docs/src/content/docs/`) for **any** caller without a `harnessSlug`. That's wrong: engineering docs should surface only for `papercusp-su` (SU/engineer) callers — agents launched via the SU MCP at `?superuser=1`. A power-engineer caller on their own raw repo (no harness, no `projectDocsRoot`) should get an error/empty response, not Papercusp's docs leaked silently. The gate signal: `ctx.isSuperuser` (or equivalent) plumbed through from the route's `?superuser=1` param.
