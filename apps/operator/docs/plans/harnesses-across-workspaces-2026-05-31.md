---
title: Harnesses across workspaces — membership model + easy move
slug: harnesses-across-workspaces-2026-05-31
status: draft
created: 2026-05-31
updated: 2026-05-31
owner: aviynw3@gmail.com
---

## Now

**State:** Design plan. Two load-bearing decisions are now LOCKED by the owner
(2026-05-31): **D-1 = SHARED results** (a harness's run data is one set, shared
across workspaces — no per-harness-schema fork) and **config becomes fully
workspace-owned** (the per-harness `.harness/` overrides move into workspace PG,
keyed by `(workspace, harness, role)`; the harness folder holds only code). The
model: a **project** is a folder referenced by link; a **workspace** owns all
config (3-tier: repo base → workspace default → per-(workspace,harness) override)
and is the config/settings boundary; **results are shared** by slug. This
collapses the hardest migration (no per-harness data fork) and makes "different
prompts per workspace on the same harness" fall out of the workspace-owned config.

**Next:** Confirm the one remaining sub-decision (D-6: seed-from-repo vs pure
workspace state for per-harness prompt overrides), then build per §6. The
slug-identity blockers (§3.1) + workspace addressing (§3.4) are still required
regardless.

---

# Harnesses across workspaces

## 1. The goal (user's framing)

- A **workspace** = a grouping of projects you want to share settings across and
  work on simultaneously.
- A **harness should be able to live in multiple workspaces** — e.g. to test
  different prompts/backends on the same codebase and compare.
- Installing a **local** harness should **link** the folder (reference in place),
  not move/copy it, and the UI should make that clear.
- Moving a harness between workspaces should be **easy**.

**Assessment: the goal is good and internally coherent.** It matches how the
system is *already* partly built (settings are workspace-scoped; local installs
already link, not copy). The hard part is one unstated decision (§4 D-1) and a
set of slug-identity assumptions (§3) that were laid down before multi-workspace
was a goal.

## 2. What's already in our favor (don't rebuild these)

- **Local install already links, not copies.** The "Existing local repo" flow
  (`apps/operator/lib/endpoint-route/routes/harness/projects.ts:251-263`) stores
  the absolute path in the registry as-is — no copy/move. Evidence: `restart →
  /home/marsh-office/Restart`, `sheets → /home/marsh-office/sheets-clone` (both
  outside any workspace dir). Only "New local dir" + marketplace scaffold create
  *inside* `<workspace>/.papercusp/projects/`. So "link not move" is ~80% a
  **UX/labeling** change, not a refactor: say "Linked in place — your folder
  stays at <path>; removing the harness won't delete it."
- **Settings are already workspace-scoped.** `operator_agent_config` (backend +
  per-role models + the new per-surface backends/models), `operator_voice_prefs`,
  credentials, oracle prompt/memory, budget, preferences — all keyed by
  `workspace_id`. This is the exact mechanism the "test different prompts per
  workspace" use case needs; it already exists.
- **The registry is already per-workspace** (`harness_shared.harness_registry`,
  one JSONB row per `workspace_id`) and its PK does **not** forbid the same slug
  in two workspaces. The blocker is elsewhere (§3).

## 3. Why moving is hard / why multi-workspace is blocked — the tie-in points

Identity is the slug, and the slug is assumed globally unique + resolved against
the active workspace. Concretely:

1. **Global-unique-by-slug constraints (hard blockers).**
   - `harness_shared.projects.slug` — `UNIQUE INDEX projects_slug_idx`
     (`001-shared.sql:51`). Two workspaces can't both have a `projects` row for
     the same slug.
   - `harness_shared.token_index.harness_slug` — `UNIQUE`
     (`008-multi-harness-spawning.sql:20`). This is the exact error we hit trying
     to provision the operator principal in a second workspace
     (`token_index_harness_slug_key`). System principals + harness tokens can
     exist in only one workspace per slug.

2. **The per-harness PG schema is keyed by slug, not (workspace, slug).**
   `slugToSchemaName(slug)` → `harness_<slug>` (`libs/papercusp/libs/db/src/schema/index.ts:153`).
   The per-harness tables (`harness_features`, `harness_issues`, `agent_runs`,
   `agent_chats`, …) carry `harness_slug` but **no `workspace_id`**. So on a
   *shared* PG, two workspaces referencing the same slug would **share** this
   data (features/runs commingle) — which breaks "different results per
   workspace." (On the *desktop* per-workspace-PG model, each workspace's PG has
   its own `harness_<slug>` schema → naturally forked. See §5 topology.)

3. **A workspace-scoped consolidated/shared layer that must be re-scoped on a
   move.** ~12+ `harness_shared` tables carry `workspace_id`: `projects`,
   `harness_features_consolidated`, `audit_log`, `plugin_enables`,
   `plugin_configs`, `goals`, `pending_events`, `routines`,
   `project_spec_revisions`, `token_index`, `system_principals`, `pi_sessions`,
   plus compound-key tables `harness_feature_notes`, `plugin_trust_store`,
   `harness_chunk_plans`, `harness_plan_status`, `harness_plan_assertions`.
   Moving a harness = re-scoping every one of these from the old `workspace_id`
   to the new — with RLS policies (`010-workspace-scoping-rls.sql`) and a
   workspace_id-populating trigger (`012`) in the loop.

4. **Runtime resolves a harness by slug-in-active-workspace.**
   `resolveProject(slug)` (`harness-core.ts:203`) loads `loadHarnessRegistry()`
   which defaults to `activeWorkspaceId()` — the **process-global**
   `registry.current` (`workspace-registry.ts:77`). Harness API routes are
   `/api/harness/:slug/...` with **no workspace in the path** — workspace is
   implicit. So even if two workspaces had the same slug, the URL can't address
   "sheets in workspace B"; `~30+` call sites read the global active workspace.

5. **No move tool exists.** `saveHarnessRegistry` defaults to the active
   workspace; there is no endpoint/CLI that atomically de-registers from A,
   registers in B, and re-scopes the data in §3.3.

**So "moving is hard" = (a) the data is spread across a slug-keyed per-harness
schema + a dozen workspace_id-keyed shared tables with RLS, (b) slug is
globally unique so you can't even transiently have it in both, and (c) the
runtime can't address a harness except via the one active workspace.**

## 4. Proposed model + the decisions it forces

**Reframe identity: separate the Project from the Harness-instance.**

- A **Project** = a folder/repo on disk (referenced by absolute path = a *link*).
  Global, workspace-independent. Stable identity = the path (or a generated
  `project_id`), **not** the slug.
- A **Harness-instance** = a Project **included in** a Workspace. This is the
  thing that owns per-workspace data + settings (runs, feature pass/fail,
  backend/prompt config). Keyed by **(workspace_id, project_id)**.
- "Harness in N workspaces" = one Project, N instances (N membership edges).
- "Move" = re-point / add / remove a membership edge (+ optionally migrate
  instance data). "Link not move" = adding a Project to a workspace never
  touches the folder.

### Decisions (need owner sign-off)

- **D-1 — Per-workspace data: shared or forked? → LOCKED: SHARED (2026-05-31).**
  The per-harness `harness_<slug>` schema stays **one shared data set** (features,
  issues, runs) across all workspaces that reference the slug. NO per-harness
  schema fork. Rationale: the "different prompts per workspace" use case is served
  by workspace-owned **config** (D-7), not by forking results; the user is fine
  observing different agent behavior against one shared work-data set. This
  removes the single largest migration from the plan.

- **D-7 — Config is workspace-owned; the harness folder holds only code → LOCKED
  (2026-05-31).** Move the per-harness overrides out of the harness folder
  (`.harness/config.json promptOverrides`, `.harness/prompts/<role>.md`) into
  workspace PG, keyed by `(workspace_id, harness_slug, role)`. Final resolution
  is 3-tier: **repo base role prompt** (`apps/operator/prompts/<role>.md`, global)
  → **workspace default** (`operator_agent_config`) → **per-(workspace,harness)
  override** (new PG store). Feasible because these overrides are consumed
  **orchestrator-side** at prompt-build time (`prompt-build.ts` /
  `role-prompt-from-slug.ts` / `invoke.ts:129`), not by the agent subprocess — so
  the orchestrator reads them from workspace PG instead of the folder. Effect: the
  same harness in two workspaces gets independent overrides; linking a folder into
  N workspaces no longer shares its prompt tuning.

- **D-6 — Per-harness prompt overrides: seed-from-repo or pure workspace state?
  (OPEN — last sub-decision.)** When D-7 moves live config to workspace PG, what
  happens to a harness that *ships* `.harness/prompts/<role>.md` in its repo?
  - **Recommendation: seed-from-repo.** Treat repo `.harness/prompts/` +
    `config.json promptOverrides` as **default seeds**: on install/link into a
    workspace, import them into that workspace's `(workspace,harness,role)` store;
    thereafter the workspace owns the live config (edits are per-workspace, never
    touch the repo). Preserves "a harness can ship recommended prompts" while
    keeping live tuning workspace-scoped. Matters for the publish plan: a published
    harness carries seed defaults, not the publisher's workspace tuning.
  - *Counter-option:* pure workspace state — prompts never travel with a harness;
    `.harness/prompts/` is ignored/removed. Simpler, but loses shippable defaults.

- **D-2 — Identity key.** Make `projects` unique on `(workspace_id, slug)` (drop
  the global `projects_slug_idx`), and `token_index` unique on
  `(workspace_id, harness_slug)`. Introduce a stable `project_id` so the same
  folder in two workspaces is *recognizably the same project* (for "is this
  already linked elsewhere?" UX) rather than two coincidentally-same slugs.

- **D-3 — Workspace addressing in the runtime.** Harness routes/tools must accept
  an explicit workspace (path segment `/api/ws/:wsId/harness/:slug/...` or a
  required `?workspace=`), and `resolveProject` must take `(workspace, slug)`.
  Keep `activeWorkspaceId()` only as the default when none is supplied.

- **D-4 — Topology reconciliation.** Decide whether the product is
  shared-PG-with-workspace_id (dev today) or per-workspace-PG (desktop switch
  restarts the sidecar). The membership model is cleaner if we **commit to one**.
  Per-workspace-PG makes D-1 "forked" almost free (separate schemas already) but
  makes cross-workspace *views* (e.g. "all my harnesses") harder; shared-PG is
  the reverse. (See §5.)

- **D-5 — Slug vs path collisions.** If a user links the *same folder* into two
  workspaces, keep the same slug (it's the same Project). If two *different*
  folders want the same slug in different workspaces, that's allowed under
  `(workspace, slug)` uniqueness — but warn, since cross-workspace UIs key on
  slug today.

## 5. Topology note (must resolve — D-4)

Two PG topologies coexist in the codebase:
- **Shared embedded-pg (this dev box now):** one `postgres 18/main` serving db
  `papercusp`; all workspaces in one PG, isolated by `workspace_id` columns +
  RLS (`app.workspace_id` GUC). Cross-workspace queries are natural; per-harness
  schema is slug-keyed → **shared data across workspaces** (the §3.2 problem).
- **Per-workspace embedded-pg (desktop intent):** `workspaces/switch.ts` notes
  the Tauri `workspaces_switch` command "kills the sidecar + pglite-server first"
  and restarts in the new workspace's home → **separate PG per workspace** →
  data naturally forked, but "show all harnesses across workspaces" needs
  fan-out across instances, and `workspace_id` columns become near-redundant.

The membership model's difficulty (and the move difficulty) is partly *because
the code straddles both*. Picking one (D-4) is a prerequisite for a clean design.

## 6. Phased plan (after decisions)

**Phase 0 — Decisions.** D-1 (shared) + D-7 (workspace-owned config) LOCKED.
Remaining: D-6 (seed vs pure) + D-4 (topology). D-4 still needs a call but no
longer gates Phase 1 the way forked-data would have.

**Phase 1 — Identity + constraints (schema).**
- Add `project_id` (stable) to `projects`; make uniqueness `(workspace_id, slug)`;
  drop global `projects_slug_idx`. Migration + backfill.
- Make `token_index` unique `(workspace_id, harness_slug)`; fix
  `readSystemPrincipal`/provision to be workspace-scoped + idempotent (this also
  fixes the operator-principal bug we hit).
- **D-1 = shared → the per-harness `harness_<slug>` schema is NOT re-scoped.**
  The largest migration is OFF the table. Run data stays shared by slug.

**Phase 1b — Workspace-owned config (D-7).**
- New PG store for per-(workspace, harness, role) overrides (prompt + aiBackend).
- Repoint `prompt-build.ts` / `role-prompt-from-slug.ts` / `invoke.ts` override
  reads from `.harness/config.json`+`.harness/prompts/` → the workspace PG store
  (3-tier resolution). Keep the on-disk read as the D-6 seed path / fallback.
- `/api/harness/:slug/prompts/*` (PromptsTab) writes to the workspace store
  instead of the folder.
- D-6 seed: on install/link, import repo `.harness/prompts/` into the workspace
  store for that harness.

**Phase 2 — Runtime addressing.**
- `resolveProject(workspace, slug)`; thread workspace through harness routes
  (path or required param); default to `activeWorkspaceId()` only when absent.
- Audit the ~30+ `activeWorkspaceId()` call sites; convert harness-scoped ones to
  explicit workspace.

**Phase 3 — Membership operations (the actual feature).**
- `harness:add_to_workspace { project, workspace }` (link — never touches files).
- `harness:remove_from_workspace { project, workspace }` (unlink — never deletes
  the folder; warn if last reference + offer data archive).
- `harness:move { project, fromWs, toWs }` = add + remove + (D-1) migrate
  instance data in one transaction.
- `harness:copy_into_workspace` (link + seed instance data from another
  workspace's instance — the "fork an experiment" path for prompt testing).

**Phase 4 — UX.**
- Install UI: explicit "Linked in place" vs "Created inside workspace" labeling;
  "this folder stays at <path>; removing the harness won't delete it."
- Show which workspaces a Project is in; a "members" affordance on the harness.
- Move/copy actions in the harness menu + WorkspaceSwitcher.

**Phase 5 — Verification.** Move `restart` default→papercusp-workspace cleanly;
have the same Project live in two workspaces with independent runs; confirm
removing it from one workspace leaves the folder + the other workspace intact.

## 7. Gaps in the current thinking (called out honestly)

- **D-1 is unstated but decisive.** "A harness in multiple workspaces" is
  ambiguous until you say whether its *data* is shared or forked. The "test
  different prompts" use case only works if **runs are forked** — so the simple
  "it's the same harness everywhere" mental model needs the nuance "same code,
  independent results per workspace."
- **Folder-level shared state.** Even with forked PG data, anything the harness
  writes *into the folder* (`.harness/*.json`, brainstorm canvas, pi-sessions) is
  shared across workspaces that link the same folder. Mostly fine (it's the
  code's state), but worth being explicit: linking shares the folder, so
  file-based state is shared; only PG-backed run data is per-workspace.
- **Slug as identity is leaky.** Cross-workspace UIs, logs, and the per-harness
  schema name all key on slug. A stable `project_id` is needed so "same folder
  in two workspaces" is recognized as one project, not two.
- **Operator/oracle principals** are workspace-scoped *and* globally-unique-by-
  slug — this contradiction is the bug we already hit. Fixing it (Phase 1) is a
  prerequisite, not a side quest.

## 8. Alternatives to the membership model

- **A. Workspace = a saved view/filter + settings overlay over a global Project
  pool.** Projects live globally; a workspace is a selection + a settings layer.
  Simplest mentally and makes "in N workspaces" free — but does **not** isolate
  runs (D-1 = shared), so it doesn't serve the prompt-testing use case unless
  paired with a per-(workspace,project) run namespace. Effectively collapses to
  the proposed model once you add run isolation.
- **B. Keep one-workspace-per-harness; make MOVE first-class, skip multi-membership.**
  Smaller: just build a robust `harness:move` (re-scope the dozen tables + the
  per-harness schema in a transaction) and don't allow N-workspace membership.
  Satisfies "easy move" but not "test different prompts simultaneously" (you'd
  copy the folder + make a second harness — the thing the user wants to avoid).
- **C. "Experiment" as a first-class concept instead of a workspace.** If the
  *only* multi-workspace use case is prompt/backend A/B testing, model that
  directly: one harness, N "experiment" configs (prompt/backend sets) with
  per-experiment run namespaces — no workspace duplication at all. Narrower, but
  if A/B-on-same-harness is the real need, it's the most direct fit. Worth
  considering vs. overloading "workspace."

**Recommendation:** the proposed Project/Harness-instance model (forked data,
link-not-move, (workspace,slug) identity) is the right long-term shape — it
serves the stated goal, fixes the move problem and the principal bug, and
generalizes A/B testing. But **confirm D-1 and D-4 first**; and seriously weigh
**Alt C** if "test different prompts" is the *primary* driver, since an
Experiment concept could deliver that value without a workspace-membership
refactor.
