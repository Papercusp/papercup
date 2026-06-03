---
title: Harness Blueprint Distribution — Cupboard, snapshots, plugins, sharing, build
slug: harness-blueprint-distribution-2026-06-03
status: draft
created: 2026-06-03
updated: 2026-06-03
owner: avi@storewolf.com
---

# Harness Blueprint Distribution — Cupboard, snapshots, plugins, sharing, build

## Now

**State:** Companion to `harness-blueprint-orchestration-2026-06-03` (the engine) — the **packaging + sharing** half. Reviving the harness template / snapshot / marketplace / Cupboard / plugin / build systems (designed for young infra, mostly flag-gated OFF) around the **Blueprint as the shareable unit**. Revised after an adversarial code audit + the sharing-model clarification; **all three forks ratified 2026-06-03** (O-1/O-2/O-3 → D-008/D-009/D-010). P-item build list populated. Not started in code.

**Next:** Sequenced **after** orchestration Phase A/B (a blueprint + `harness:create` + `work_items` must exist first) — start E1 (templates → blueprints) once the engine slice lands.

## Background

### Why this exists
A Blueprint is portable only if its **dependencies travel with it**: prompts + base blueprints are data (easy); **tools are code**. That's why blueprints tie into the marketplace/template/snapshot/plugin systems — revive + redesign them **together**.

### Three independent capabilities (the sharing model)
Orthogonal axes; any harness can be any combination:
1. **Define** — every harness has a **Blueprint** (its shape). Always.
2. **Copy = snapshot + fork** — **local**. Capture *any* harness (blueprint + optional state) → instantiate a new independent copy. Shared *or* non-shared; **no Cupboard, no collaboration** needed. Templating/cloning.
3. **Collaborate = share + join** — **only for shared harnesses**. Publish a harness as a *live collaborative instance* (contributors, git-as-sync, peer-mirror); others **join** the *same* instance. `join` exists only here.

**Sharing ≠ snapshotting; join ≠ fork.** You can snapshot+fork a purely local harness with no Cupboard. The Cupboard only enters when you **publish**.

### The Cupboard = the publish/discover storefront (three listing kinds)
The **Cupboard** (the bidirectional merge of the old Cupboard + the old marketplace, keeping the name — D-005) hosts **three distinct listing kinds**:
- **shared-harness listings → join** (collaborate) — old Cupboard.
- **blueprint/snapshot listings → fork** (instantiate your own copy) — old marketplace templating.
- **plugin listings → install** (extend / satisfy a blueprint's tool deps) — old marketplace plugin distribution.

### The three distribution layers
| Layer | What travels | Carried by | Status today |
|---|---|---|---|
| **Definition** | blueprint YAML + prompts + `extends` | **git** (harness repo) → Cupboard | Entry-4 join git-clones `.papercusp/*` |
| **Code (tools)** | the `defineTool`s roles need | **plugins** (`@papercusp/tooldef`) → Cupboard | 22 plugins; auto-installed by `init --from` |
| **State (optional)** | work_items, runs, history | **snapshot** (`@papercusp/export-state`) | built, flag-gated off, unfinished |

### What exists today (audit-confirmed) + stale flags
- **Cupboard** — REAL + deployed (`apps/operator-public/`, CF-Worker + D1, `cupboard.papercusp.com`); keyed by `github_repository_id`; publish via gh-token (rate-limited); operator proxies `/api/cupboard/*`.
- **NOT two backends** (audit): no separate `:3057` server. `PAPERCUSP_MARKETPLACE_URL ?? 'http://localhost:3057'` is vestigial; `/v1/catalog` is never implemented; `/catalog` only existed on the retired web app; the real fallback is a bundled `FALLBACK_CATALOG`. **One backend (Cupboard) + dead wiring** — cleaned up *as part of* the merge.
- **Templates** — `papercusp.json` + seed files; `PROJECT_FILES_TO_COPY` still includes deprecated **`SPEC.md`** (audit: `validation-contract.md` is NOT in that list); only `sheets-clone` built-in; `FLAGS.TEMPLATES` off.
- **Snapshots** — `snapshots:*` (portable, `@papercusp/export-state`, per-harness PG subset + `.papercusp/` tree, **EXCLUDES git history**; `FLAGS.SNAPSHOTS` off) vs `backup:*` (kopia, whole-workspace). The orphan is **`harness_snapshots_consolidated`** (created but never written; live writes go to `harness_snapshots`). `work_items` not in capture scope.
- **Plugins** — THE code-distribution unit (`libs/papercusp/plugins/`, **22**; `papercusp.json` `tools[]` + capabilities + roles + guidance; installed to `~/.papercusp/global-plugins/`; capability-gated).
- **Tool framework** — `defineTool` in host-agnostic `@papercusp/tooldef` (`@papercusp/agent-mcp` re-exports); definitions in `apps/operator/lib/agent-tools/`; role gating `dispatch-stack.ts:192`; a missing tool fails at **call-time** (`unknown_tool`) — no import-time manifest.
- **Build** — local-only (`release-local.sh` + `build-desktop-sidecar.sh`); base blueprints would live in `libs/papercusp/packages/harness/blueprints/` (a `blueprints/` sibling to `prompts/`/`templates/` — **doesn't exist yet**), bundled into the sidecar.

## Phase E1 — Templates → Blueprints
- **P-001** `todo` A "template" = a **blueprint (shape) + optional seed content**. Drop the `SPEC.md`/file-copy seeding (stale). Base blueprints (`base`, `coding`, `research-base`) live in `libs/papercusp/packages/harness/blueprints/`; `extends` resolves local → installed → built-in.
- **P-002** `todo` `papercusp init --from` becomes blueprint-instantiation (not a directory copy).

## Phase E2 — Tool portability (dep manifest + plugins, via the Cupboard)
- **P-003** `todo` Blueprint declares its **tool/plugin deps**; add **import-time validation** (resolve required tools/capabilities against the catalog + Cupboard plugin listings; fail upfront with "needs plugin X") — closing the call-time-only `unknown_tool` gap (`dispatch-stack.ts:192`).
- **P-004** `todo` Portable custom tools = **plugins** on `@papercusp/tooldef`; wire `init --from` plugin auto-install to declared deps; **reuse the old snapshot manifest machinery** (`versionPin`, `migrationManifest`, capability declaration) as the dep-manifest basis.

## Phase E3 — Clone = git(definition) + snapshot(state); migrate snapshots
- **P-005** `todo` **Narrow `snapshots:*` to runtime state** (`work_items` + runs); ADD `work_items` (the orchestration plan's canonical work-item table) to the capture scope; the old plugin/tool-def *bundling* moves up to the E2 dep-manifest (declare + resolve from the Cupboard, don't embed code).
- **P-006** `todo` Snapshot home = **hybrid** (FS tarballs `.papercusp/snapshots/*.tar.gz` + a PG index row, D-010); wire-or-drop the orphaned `harness_snapshots_consolidated`.

## Phase E4 — Cupboard merge (bidirectional; keep the name)
- **P-007** `todo` Merge the old marketplace into the **Cupboard** (keep the name): fold in `spawnable`/install, catalog/versioning, and **plugin distribution** → one storefront, **three listing kinds** (shared-harness→join, blueprint/snapshot→fork, plugin→install). Clean the vestigial `:3057`/dead-`/v1/catalog` wiring as part of the merge.
- **P-008** `todo` Flip `FLAGS.TEMPLATES/SNAPSHOTS/MARKETPLACE` on once reframed.

## Phase E5 — Trust / sandboxing posture
- **P-009** `todo` Forking a blueprint pulls plugin **code** = a supply-chain surface. v1 = capability-gate + install-consent (the existing plugin model, D-009); signing/review deferred.

## Risks & mitigations
- **Flag-gated-off + vestigial systems = stale code** → redesign, don't patch; the `:3057` "second backend" is dead wiring (audit).
- **Supply chain** (plugin code in forked blueprints) → capability-gate + install-consent (E5/D-009).
- **Sequencing** → depends on orchestration Phase A/B.
- **Snapshot/git reconciliation must not lose blueprint history** → git carries definition + history; the snapshot carries state only (E3).

## Decisions

### D-001 Three-layer distribution (git / plugins / snapshot)
Date: 2026-06-03
The shareable unit is a Blueprint, distributed across three layers: definition = git (harness repo) + the Cupboard; code (custom tools) = plugins (Cupboard-distributed); optional state = a narrowed snapshot. Mirror of orchestration-plan D-019.

### D-002 Templates subsumed by blueprints
Date: 2026-06-03
A "template" = a blueprint (shape) + optional seed content; drop the SPEC.md/file-copy model. Base blueprints live in `libs/papercusp/packages/harness/blueprints/`, `extends`-resolved local → installed → built-in.

### D-003 Portable tools = plugins on @papercusp/tooldef; import-time dep manifest; Cupboard-distributed
Date: 2026-06-03
Core/private tools = `defineTool` in `apps/operator/lib/agent-tools/` (not portable). Shareable tools = **plugins** (runtime-installable, capability-gated, `@papercusp/tooldef`), **distributed via the Cupboard** (its third listing kind). A blueprint declares its tool/plugin deps; import-time validation resolves them — closing the call-time `unknown_tool` gap (`dispatch-stack.ts:192`).

### D-004 Snapshot = the monolithic precursor; narrow to state; lift its manifest machinery into the dep-manifest
Date: 2026-06-03
The old snapshot bundled **state + plugin-defs + tool-defs + a manifest** in one tarball — the three layers, conflated. Migrate: (a) **narrow capture to state**; (b) its plugin/tool-def *bundling* → the blueprint plugin-dependency model (declare + resolve from the Cupboard); (c) **reuse its machinery** (`versionPin`, `migrationManifest`, capability declaration) as the E2 dep-manifest. The orphan `harness_snapshots_consolidated` (never written; live = `harness_snapshots`) gets wired-or-dropped (D-010). Touches app-state + build + plugin systems.

### D-005 Cupboard ⟂ marketplace = bidirectional merge (keep the Cupboard name)
Date: 2026-06-03
Merge, keeping the Cupboard name, best of each. From the Cupboard: identity (`github_repository_id`), claim/ownership, discovery, reports, the `papercusp://` link. From the marketplace: `spawnable`/install, catalog/versioning, **plugin distribution**. Result: one storefront, **three listing kinds** (join/fork/install). Audit: no real `:3057` second server — clean that dead wiring as part of the merge.

### D-006 Sharing ≠ snapshotting; the three axes are independent
Date: 2026-06-03
**Define** (blueprint, always) ⟂ **copy** (snapshot+fork — local, any harness, no Cupboard) ⟂ **collaborate** (share+join — shared harnesses only, via the Cupboard + the dogfood federation). `join` = collaboration on a live instance; `fork` = an independent local copy. The Cupboard is the storefront for the two publish paths + plugin install; not required for a local snapshot/fork.

### D-007 v1 trust = capability-gate + install-consent (defer signing)
Date: 2026-06-03
Forking a blueprint pulls plugin code = a supply-chain surface. v1 = the existing plugin model (capability-gated + user-consent on install); signing/review deferred (D-009 ratifies), acceptable because there are no users yet.

### D-008 O-1 ratified: shareable-unit identity = GitHub-repo-backed for v1
Date: 2026-06-03
avi ratified. The Cupboard's `github_repository_id`-keyed model for v1 (reuses the Entry-4 join + git). A content-addressed blueprint package registry (decoupled from GitHub) is a later option. Resolves distribution O-1.

### D-009 O-2 ratified: tool trust = capability-gate + install-consent for v1
Date: 2026-06-03
avi ratified. The existing plugin model (manifest capabilities + user consent on install); plugin signing / a review process deferred. Resolves distribution O-2.

### D-010 O-3 ratified: snapshot home = hybrid (FS tarballs + PG index row)
Date: 2026-06-03
avi ratified. Snapshot tarballs on the filesystem (`.papercusp/snapshots/*.tar.gz`) + a PG row for discovery/index (the orphaned `harness_snapshots_consolidated` becomes that index, or is dropped for a new table) — finalized in Phase E3. Resolves distribution O-3.
