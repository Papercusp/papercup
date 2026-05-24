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

**State:** **Phase 1 + Phase 2a + Phase 2b ALL SHIPPED.** Phase 1 closes the docs:* leaks (`ff2327bf`). Phase 2a delivers the per-harness resolver + runtime guard (`4016d828`) and the cross_harness:plans_* read-only carve-out (`7a4866f2`). Phase 2b executed per explicit user override 2026-05-24: PG migration with multi-process race-safe ALTER (`26309aa8`), harness-discriminated lock key (`e67fe112`), central helpers (`4b57d13e`), 7 write-tool handlers (`cdb3526b`), 5 read-tool handlers + `_ctx-opts.ts` (`6baf7866`), PG SELECT/UPDATE helpers (`eeb95141`), revisions-list/runs-list/launch (`2b458123`), context-bundle/launch/resume (`afa35b60`). All defaults preserve papercup behavior. 167/177 plans suite green throughout.
**Next:** none — plan complete.

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
- **P-003** `done` Plumbing verified: `ctx.isSuperuser` is already populated by `http-projection.ts` from `?superuser=1` and spread into handlerCtx by `dispatch-stack.ts`. `projectDocsRoot` is read inline from `process.env.PAPERCUSP_PROJECT_DOCS_ROOT` in `resolveAdapter` — no per-call ctx field needed (process-level config). Folded into `ff2327bf`.
- **P-004** `done` Third branch added to `resolveAdapter` in `outline.ts`/`get.ts`/`search.ts` — commit `ff2327bf`.
- **P-016** `done` Engineering branch gated on `ctx.isSuperuser`; non-SU/non-projectDocsRoot returns `error: { code: 'no_docs_source', detail: ... }`. Folded into `ff2327bf`.
- **P-005** `done` `routing.test.ts` grew 9 → 16 cases covering all three no-harness surfaces per tool. Folded into `ff2327bf`.

## Phase 2 — plans:* per-harness

- **P-006** `done` Decided D-002R: per-harness plans at `<harness.path>/docs/plans/`. No workspace bucket.
- **P-007** `done` Decided D-003: `plans:*` ctx-only + `cross_harness:plans_*` carve-out.
- **P-008** `done` Decided D-004R: no-harness fallback = workspace's primary/root harness (today = `papercup`).
- **P-009** `done` `resolveHarnessPlansDir(harnessSlug, opts)` shipped at `4016d828`. Async, registry-backed, papercup-special-case for the legacy `apps/operator/docs/plans/` location.
- **P-013** `done` `cross_harness:plans_list / plans_get / plans_search` shipped at `7a4866f2`. 8 new tests; mirrors `cross_harness:docs_*` pattern; uses new `plansDir`/`archiveDir` overrides on `PlanSourceOpts`.
- **P-014** `done` Runtime guard inline in `resolveHarnessPlansDir` (`4016d828`): for `papercup` resolution, asserts `project.path === detectPapercupRoot()`. Skipped when detection returns null (packaged install).
- **P-010** `done` PG migration shipped at `26309aa8`. `harness_slug` columns added to `plan_revisions` + `plan_runs` with multi-process race-safe ALTER (pg_advisory_xact_lock + IF NOT EXISTS). Fresh installs get the new schema directly; existing operators apply the ALTER on first ensure call after restart. UNIQUE on `plan_revisions` switches to `(harness_slug, plan_slug, seq)`; `plan_runs` gets a second index on `(harness_slug, plan_slug)`.
- **P-011** `done` Harness-discriminated lock key shipped at `e67fe112`. `withPlanLock` accepts `harnessSlug`; default = 'papercup' preserves the legacy `apps/operator/docs/plans/<slug>.md` key for back-compat with in-flight callers. Other harnesses use synthetic `harnesses/<slug>/docs/plans/<slug>.md` keys so the same plan slug in different harnesses never collides.
- **P-012** `done` 25-tool refactor shipped across stages 1–3d: central helpers (`4b57d13e`), 7 write tools (`cdb3526b`), 5 read tools + `_ctx-opts.ts` (`6baf7866`), PG SELECT/UPDATE helpers (`eeb95141`), revisions-list + runs-list + launch (`2b458123`), context-bundle + launch + resume (`afa35b60`). Every tool extracts `ctx.harnessSlug` and passes it through to its `source.ts` / `withPlanLock` / PG-helper calls. Default = papercup preserves behavior for every existing SU caller.
- **P-017** `done` Per-tool descriptions left intentionally as-is. The per-harness behavior is correctly hidden behind the papercup default — describing it in every tool's `description` field would be wordy without informing typical usage. The architectural note lives here in this plan + in `plans-system-brief-2026-05-20`; for an agent that *is* in a harness ctx, the tool behaves harness-scoped automatically without prose disclosure.

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
