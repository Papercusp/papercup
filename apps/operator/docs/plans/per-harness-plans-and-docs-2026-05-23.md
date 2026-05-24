---
title: Per-harness plans + project-docs adapter — portability beyond the Papercusp codebase
slug: per-harness-plans-and-docs-2026-05-23
status: draft
created: 2026-05-23
updated: 2026-05-23
owner: pandawamble@gmail.com
related:
  - apps/operator/docs/plans/agent-plan-tracking-2026-05-20.md
  - apps/operator/docs/plans/omp-power-user-bundle-2026-05-20.md
  - apps/operator/docs/plans/plan-agent-launch-2026-05-21.md
---

## Now

**State:** Draft. Closes 2 of the 3 non-identity couplings to the Papercusp codebase identified in the 2026-05-22 catalog audit: `plans:*` (one global plan dir hardcoded into the operator's monorepo) and `docs:*`'s no-harness branch (hardcoded to Papercusp engineering docs). The third coupling (`design-phase.list_memos`/`read_memo`) is out of scope — those are intentionally Papercusp-engineering tools.

**Next:** User review of the 4 open decisions in §3, then P1 (`docs:*` third branch — small, contained) → P2 (`plans:*` per-harness — bigger, gated on decisions).

---

# Per-harness plans + project-docs adapter

## §1 Why

papercusp-su is already a multi-project system — harnesses are the "other projects." Almost every tool is slug-parameterized; the harness model carries portability for free. But two surfaces leak through and read the operator's own source tree (= the Papercusp codebase) instead of the harness they're pointed at:

1. **`plans:*`** — `plans/source.ts` resolves `<repoRoot>/apps/operator/docs/plans/`. A harness engineer running `plans:list` gets *Papercusp's* plans, not their harness's.
2. **`docs:*` no-harness branch** — `_engineering-adapter.ts` is hardwired to `<repoRoot>/apps/operator-docs/src/content/docs/`. A caller with no `harnessSlug` always gets Papercusp engineering docs, even when they have their own project docs available.

Closing these makes papercusp-su genuinely portable to any harness without behavioral surprises.

## §2 Scope

- **P1** — `docs:*` gets a third `resolveAdapter` branch: `ctx.projectDocsRoot` → generic on-disk adapter. (Small.)
- **P2** — `plans:*` becomes per-harness: data model, tool resolution, lock keys, PG schema, migration. (Big.)

**Not in scope:** `design-phase.list_memos`/`read_memo` (Papercusp-engineering by design); identity/persona rewrite (`omp-power-user-bundle` D-008b); per-harness `engineeringAdapter` (no use case identified).

## §3 Open decisions (need your call before P2 lands)

### D-001 — Per-harness plans on-disk location

Where do per-harness plans live on disk?

- **(a)** `<harness.path>/docs/plans/` — sibling of the harness's own source. Pro: travels with the harness repo; harness owners can see/edit them. Con: requires writing into the harness's repo (which may be read-only for the operator, or under separate version control).
- **(b)** `<workspaceRoot>/.papercusp/plans/<harness-slug>/` — workspace-centralized. Pro: operator owns the dir; works regardless of harness repo state. Con: not visible from inside the harness repo; can't be browsed alongside the harness's own docs.
- **(c)** Per-harness override (frontmatter or harness config), default = (b). Most flexible, most code.

**Recommendation: (a)** — `plans:*` is most useful when its output lives next to the project. Papercusp itself follows (a) by accident — its plans are in its own repo.

### D-002 — `plans:*` tool signature

Do `plans:*` tools take an **explicit `harnessSlug` arg**, or **read from `ctx.harnessSlug` only**, or **both with arg override**?

- **(a)** Ctx-only, mirrors `docs:*`. Cross-harness lookups go through a sibling `cross_harness:plans_*` scope (mirrors how cross-harness docs work today).
- **(b)** Explicit arg on every call. More verbose; more direct.
- **(c)** Ctx default + optional arg override.

**Recommendation: (a)** — consistency with `docs:*` is high-value (agents already learned that pattern). Add a `cross_harness:plans_*` carve-out if/when needed.

### D-003 — No-harness fallback for `plans:*`

For agents with no `harnessSlug` (SU, operator, oracle), what does `plans:list` return?

- **(a)** Treat Papercusp as the `papercup` harness — fall through to `papercup` plans. Preserves today's behavior for SU.
- **(b)** Workspace-global plans dir (`<workspaceRoot>/.papercusp/plans/_workspace/`) — a separate bucket for cross-harness / workspace-level plans.
- **(c)** Error — "no harness in context; pass a slug to `cross_harness:plans_*`."

**Recommendation: (a)** — least disruptive; SU plans (this session's work) keep working unchanged. The other two are opt-in via cross_harness:* once that exists.

### D-004 — Where does `ctx.projectDocsRoot` come from (for P1)?

- **(a)** Env var `PAPERCUSP_PROJECT_DOCS_ROOT`, set by `omp-su` wrapper / user shell.
- **(b)** Workspace setting (persisted in operator config).
- **(c)** Convention — walk up from cwd to find a `docs/` or `README.md` and use that.

**Recommendation: (a)** — explicit, simple, opt-in. The wrapper change is one line.

---

## §4 P1 — `docs:*` third adapter branch (small)

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

**Changes:**
- `@papercusp/docs-engine`: add `genericFsAdapter(root, opts)` — a thin FS adapter that walks a `docs/` tree without harness-specific assumptions. Reuses `harnessFsAdapter`'s machinery; just a different name + no harness-registry coupling.
- `outline.ts`/`get.ts`/`search.ts`: add the `ctx.projectDocsRoot` branch (3 files, ~5 lines each).
- `RouteContext` / `AgentContext` type: add `projectDocsRoot?: string`.
- Wire-up: env var `PAPERCUSP_PROJECT_DOCS_ROOT` read at request-context construction time.
- Tests: one each for outline / get / search — set the env var, assert `surface === 'project'`.

**Acceptance:** with `PAPERCUSP_PROJECT_DOCS_ROOT=/path/to/my/docs`, `docs:outline` (no harness context) returns that tree; without it, returns Papercusp engineering docs (unchanged). Harness-set callers unchanged.

**Size:** ~80 LoC + 3 tests. One PR.

## §5 P2 — `plans:*` per-harness (big)

### §5.1 Data model

- `plans/source.ts`: replace single `repoRoot`-based resolution with `resolveHarnessPlansDir(harnessSlug)`. Uses the harness registry to get `<harness.path>`, appends `/docs/plans/`. No-harness callers get the existing behavior via the `papercup` slug (D-003a).
- PG: `plan_revisions` and the launch/run tables — add `harness_slug` column (NOT NULL, default `'papercup'` on backfill). Migrate existing rows to `harness_slug = 'papercup'`. Compound key becomes `(harness_slug, plan_slug, seq)` for revisions.
- `withPlanLock(slug, ...)` → `withPlanLock(harnessSlug, slug, ...)`. Lock key derives from `(harness_slug, plan_slug)`.

### §5.2 Tool changes

All 25 `plans:*` tools:
- Resolve `harnessSlug` from `ctx.harnessSlug` (D-002a). Fall through to `papercup` if absent (D-003a).
- ID allocation (`D-NNN`, `P-NNN`) becomes per-harness — no more cross-harness collisions; each harness has its own counter.
- `plans:list` returns plans for *that harness only*. Cross-harness listing requires `cross_harness:plans_list` (new — sibling carve-out).
- `plans:promote` already passes harnessSlug to the harness it's promoting into; that's unchanged. The new constraint: the source plan must live in the same harness (or `papercup`).

### §5.3 New `cross_harness:plans_*` (mirrors `cross_harness:docs_*`)

Three tools: `cross_harness:plans_list`, `plans_get`, `plans_search`. Takes explicit `harnessSlug` arg; ignores ambient ctx. Read-only — writes always go through ambient `plans:*`. ~150 LoC + 3 tests.

### §5.4 Migration

- One PG migration adding `harness_slug` columns + backfill `= 'papercup'`.
- One filesystem migration: existing `<repoRoot>/apps/operator/docs/plans/` is already inside the `papercup` harness's path, so it's already at the right location for D-001a. **No file moves required** — the existing plans dir IS `<papercup-harness-path>/apps/operator/docs/plans/` and stays there. The path resolution just changes from "operator's `repoRoot`" to "`papercup` harness's `path`" — which happens to be the same dir.
- Plan slugs are unique within a harness; existing slugs unchanged.

### §5.5 Risks

- **Slug collision with `papercup` harness path.** If `papercup` harness path is computed differently from the operator's `repoRoot`, the existing plans appear to "move." Mitigation: verify `harnessRegistry.find('papercup').path === REPO_ROOT` at runtime; abort migration if not.
- **Tool description mass update.** 25 tool descriptions need to mention the per-harness scope. Mechanical.
- **Lock key change is breaking** for any in-flight SU shell holding a `plan-<slug>` lock at deploy time. Mitigation: ship at a quiet moment; locks have a 1200s TTL anyway.

**Size:** ~600 LoC across `plans/source.ts`, all 25 tool files, the cross_harness carve-out, the PG migration, the locks key change. Multiple PRs (data model → tools → cross_harness → migration).

## §6 Out of scope

- `design-phase.list_memos` / `read_memo` — intentionally Papercusp-engineering tools, not per-harness.
- Identity / persona rewrite — covered by `omp-power-user-bundle` D-008b.
- Per-harness `engineeringAdapter` — no use case; harnesses get their own docs via `harnessFsAdapter`.
- Workspace-level plans bucket (D-003b) — not adopted; can add later as a sibling under `<workspaceRoot>/.papercusp/plans/_workspace/` if needed.

## §7 Execution order

1. **D-001…D-004 decisions** — gate, needs user input.
2. **P1** — `docs:*` third branch + env var. Small, independent, ships first.
3. **P2.1** — `plans/source.ts` resolution change (single file, no PG yet, behind a feature flag).
4. **P2.2** — PG migration + backfill.
5. **P2.3** — All 25 `plans:*` tools updated for per-harness resolution; lock-key change.
6. **P2.4** — `cross_harness:plans_*` carve-out.
7. **P2.5** — Remove the feature flag; cut release.

End of plan v1. Awaiting D-001–D-004 verdicts.
