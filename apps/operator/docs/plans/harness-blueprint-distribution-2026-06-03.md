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

**State:** Companion to `harness-blueprint-orchestration-2026-06-03` (the engine). The **packaging + sharing** half: reviving the harness template / snapshot / marketplace / Cupboard / plugin / build systems (designed for young infra, mostly flag-gated OFF) and reframing them around the **Blueprint as the shareable unit**. Revised 2026-06-03 after an adversarial code audit + the sharing-model clarification. Not started in code; sequenced **after** orchestration Phase A/B.

**Next:** (1) settle the 2 forks (O-1 unit identity; O-2 tool-trust); (2) confirm sequencing after orchestration Phase A/B (blueprint + `harness:create` + `work_items` must exist first).

## Background

### Why this exists
A Blueprint is only portable if its **dependencies travel with it**: prompts (data) and base blueprints (data) are easy, but **tools are code**. That's why blueprints tie into the marketplace/template/snapshot/plugin systems — they must be revived + redesigned **together**.

### Three independent capabilities (the sharing model — corrected)
These are **orthogonal axes**; any harness can be any combination:
1. **Define** — every harness has a **Blueprint** (its shape). Always.
2. **Copy = snapshot + fork** — **local**. Capture *any* harness (blueprint + optional state) → instantiate a new independent copy. Works on shared *or* non-shared harnesses; **needs no Cupboard, no collaboration**. This is templating/cloning.
3. **Collaborate = share + join** — **only for shared harnesses**. Publish a harness as a *live collaborative instance* (contributors, git-as-sync, peer-mirror); others **join** to work the *same* instance. `join` exists only here.

**Sharing ≠ snapshotting; join ≠ fork.** You can snapshot+fork a purely local harness with no Cupboard. The Cupboard only enters when you **publish**.

### The Cupboard = the publish/discover storefront (three listing kinds)
The **Cupboard** (the bidirectional merge of the old Cupboard + the old marketplace, keeping the Cupboard name, D-005) is the single storefront, hosting **three distinct listing kinds**:
- **shared-harness listings → join** (collaborate) — the old Cupboard.
- **blueprint/snapshot listings → fork** (instantiate your own copy) — the old marketplace's templating.
- **plugin listings → install** (extend capabilities / satisfy a blueprint's tool deps) — the old marketplace's plugin distribution.

### The three distribution layers (what travels when you fork/join)
| Layer | What travels | Carried by | Status today |
|---|---|---|---|
| **Definition** | blueprint YAML + prompts + `extends` | **git** (harness repo) → Cupboard | Entry-4 join git-clones `.papercusp/*` |
| **Code (tools)** | the `defineTool`s roles need | **plugins** (`@papercusp/tooldef`, host-agnostic) → Cupboard | 22 plugins; auto-installed by `init --from` |
| **State (optional)** | work_items, runs, history | **snapshot** (`@papercusp/export-state`) | built, flag-gated off, unfinished |

### What exists today (audit-confirmed) + stale flags
- **Cupboard** — REAL + deployed (`apps/operator-public/`, CF-Worker + D1, `cupboard.papercusp.com`); listings keyed by `github_repository_id`; publish via gh-token (rate-limited); operator proxies `/api/cupboard/*`.
- **NOT two backends** (audit): there is **no separate `:3057` server**. `PAPERCUSP_MARKETPLACE_URL ?? 'http://localhost:3057'` is a vestigial default; `/v1/catalog` is never implemented; `/catalog` only existed on the retired web app; the real fallback is a bundled `FALLBACK_CATALOG`. So it's **one backend (the Cupboard) + dead wiring** — cleaned up *as part of* the merge, not "delete one of two live servers."
- **Templates** — a `papercusp.json` + seed-files bundle; `PROJECT_FILES_TO_COPY` still includes deprecated **`SPEC.md`** (audit: `validation-contract.md` is NOT in that copy list, only in reset/backup lists); only `sheets-clone` built-in; `FLAGS.TEMPLATES` off.
- **Snapshots** — TWO systems: `snapshots:*` (portable, `@papercusp/export-state`, per-harness PG subset + `.papercusp/` tree, **EXCLUDES git history**; `FLAGS.SNAPSHOTS` off) vs `backup:*` (kopia, whole-workspace). The orphan is **`harness_snapshots_consolidated`** (created but never written; live writes go to `harness_snapshots`). `work_items` not in capture scope.
- **Plugins** — THE code-distribution unit (`libs/papercusp/plugins/`, **22**; `papercusp.json` `tools[]` + capabilities + roles + guidance; installed to `~/.papercusp/global-plugins/`; capability-gated).
- **Tool framework** — `defineTool` in host-agnostic `@papercusp/tooldef` (`@papercusp/agent-mcp` re-exports); definitions still in `apps/operator/lib/agent-tools/`; role gating at `dispatch-stack.ts:192`; a missing tool fails at **call-time** (`unknown_tool`) — no import-time manifest.
- **Build** — local-only (no CI; `release-local.sh` + `build-desktop-sidecar.sh`); base blueprints + prompts would live in the harness package (`libs/papercusp/packages/harness/` — has `prompts/` + `templates/`; a `blueprints/` sibling **doesn't exist yet**), bundled into the sidecar.

## Plan
*(Sequenced AFTER orchestration Phase A/B. P-items at kickoff.)*

### Phase E1 — Templates → Blueprints
- A "template" = a **blueprint (shape) + optional seed content**. Drop the `SPEC.md`/file-copy seeding (stale). Base blueprints (`base`, `coding`, `research-base`) live in **`libs/papercusp/packages/harness/blueprints/`** (new sibling to `prompts/`/`templates/`); `extends` resolves local → installed → built-in. `papercusp init --from` becomes blueprint-instantiation.

### Phase E2 — Tool portability (dep manifest + plugins, via the Cupboard)
- Blueprint declares its **tool/plugin dependencies**. Add **import-time validation** (the missing manifest — `dispatch-stack.ts:192` only fails at call-time): on fork/clone, resolve required tools/capabilities against the catalog + **Cupboard plugin listings**; fail upfront with "needs plugin X."
- Portable custom tools = **plugins** on `@papercusp/tooldef`; wire `init --from` plugin auto-install to the declared deps. **Reuse the old snapshot manifest's machinery** (`versionPin`, `migrationManifest`/migration-reconcile, capability declaration) as the basis for this dep-manifest (M6).

### Phase E3 — Clone = git(definition) + snapshot(state); migrate snapshots to the new design
- A blueprint **fork** = a git clone (definition + prompts + history); a **fork-with-data** = git clone + a state snapshot. **Narrow `snapshots:*` to runtime state** (`work_items` + runs); the snapshot's old plugin-def/tool-def *bundling* moves up to the E2 dep-manifest (don't embed code in the tarball — declare + resolve from the Cupboard).
- ADD `work_items` (D-013) to the capture scope; **wire-or-drop** the orphaned `harness_snapshots_consolidated` (O-3) — the live table is `harness_snapshots`.

### Phase E4 — Cupboard merge (bidirectional; keep the name)
- **Merge the old marketplace into the Cupboard, keeping the Cupboard name, best of each:** from the Cupboard — identity (`github_repository_id`), claim/ownership, discovery, abuse reports, the `papercusp://` link; from the marketplace — the `spawnable`/install flow, the catalog/versioning, and **plugin distribution**. Result: one storefront with **three listing kinds** (shared-harness→join, blueprint/snapshot→fork, plugin→install). Clean the vestigial `:3057`/dead-`/v1/catalog` wiring as part of the merge. Flip `FLAGS.TEMPLATES/SNAPSHOTS/MARKETPLACE` on once reframed.

### Phase E5 — Trust / sandboxing posture
- Forking a blueprint pulls plugin **code** = a supply-chain surface. v1 posture = capability-gate + install-consent (the existing plugin model); signing/review deferred (O-2).

## Open decisions (need avi's call)
- **O-1 Shareable-unit identity** — GitHub-repo-backed (the Cupboard's current model; reuses Entry-4 + git) vs content-addressed blueprint package (decoupled from GitHub; a real package registry). **Rec: git-repo-backed for v1.**
- **O-2 Tool trust/sandboxing** — capability-gate + install-consent (v1) vs signing/review. **Rec: capability-gate + consent for v1.**
- **O-3 Snapshot home** — wire `harness_snapshots_consolidated` (a PG index) vs keep filesystem-based (`.papercusp/snapshots/*.tar.gz`). **Rec: decide in E3.**

## Risks & mitigations
- **Flag-gated-off + vestigial systems = much stale code** → redesign, don't patch; the `:3057` "second backend" is dead wiring, not a live server (audit).
- **Supply chain** (plugin code in forked blueprints) → capability-gate + install-consent (E5).
- **Sequencing** → depends on orchestration Phase A/B (blueprint + `harness:create` + `work_items`).
- **Snapshot/git reconciliation must not lose blueprint history** → git carries definition + history; the snapshot carries state only (E3).

## Decisions

### D-001 Three-layer distribution (git / plugins / snapshot)
Date: 2026-06-03
The shareable unit is a Blueprint, distributed across three layers: definition = git (harness repo) + the Cupboard; code (custom tools) = plugins (Cupboard-distributed); optional state = a narrowed snapshot. Mirror of orchestration-plan D-019.

### D-002 Templates subsumed by blueprints
Date: 2026-06-03
A "template" = a blueprint (shape) + optional seed content; drop the SPEC.md/file-copy model. Base blueprints live in `libs/papercusp/packages/harness/blueprints/`, `extends`-resolved local → installed → built-in.

### D-003 Portable tools = plugins on @papercusp/tooldef; import-time dep manifest; distributed via the Cupboard
Date: 2026-06-03
Core/private tools = `defineTool` in `apps/operator/lib/agent-tools/` (not portable). Shareable tools = **plugins** (runtime-installable, capability-gated, `@papercusp/tooldef`), **distributed via the Cupboard** (its third listing kind). A blueprint declares its tool/plugin deps; import-time validation resolves them — closing the call-time-only `unknown_tool` gap (`dispatch-stack.ts:192`).

### D-004 Snapshot = the monolithic precursor; narrow to state; lift its manifest machinery into the dep-manifest
Date: 2026-06-03
The old snapshot bundled **state + plugin-defs + tool-defs + a manifest** in one tarball — the three layers, conflated. Migrate: (a) **narrow capture to state** (work_items/runs/history); (b) its plugin/tool-def *bundling* → the blueprint's plugin-dependency model (declare + resolve from the Cupboard, don't embed code); (c) **reuse its good machinery** (`versionPin`, `migrationManifest`/migration-reconcile, capability declaration) as the basis for the E2 import-time dep-manifest. The orphan `harness_snapshots_consolidated` (never written; live = `harness_snapshots`) gets wired-or-dropped (O-3). Touches app-state capture + build + plugin systems.

### D-005 Cupboard ⟂ marketplace = bidirectional merge (keep the Cupboard name)
Date: 2026-06-03
Don't fold one into the other one-directionally — **merge, keeping the Cupboard name, best of each.** From the Cupboard: identity (`github_repository_id`), claim/ownership, discovery, reports, the `papercusp://` link. From the marketplace: `spawnable`/install, catalog/versioning, **plugin distribution**. Result: one storefront, **three listing kinds** (shared-harness→join, blueprint/snapshot→fork, plugin→install). **Audit:** there is no real `:3057` second server (vestigial default + dead `/v1/catalog`; the real fallback is a bundled list) — clean that wiring *as part of* the merge.

### D-006 Sharing ≠ snapshotting; the three axes are independent
Date: 2026-06-03
**Define** (blueprint, always) ⟂ **copy** (snapshot+fork — local, any harness, no Cupboard) ⟂ **collaborate** (share+join — shared harnesses only, via the Cupboard + the dogfood federation: contributors, git-as-sync, peer-mirror). `join` is collaboration on a live instance; `fork` is an independent local copy. The Cupboard is the storefront for the two *publish* paths (share-to-join, list-to-fork) + plugin install; it is not required for a local snapshot/fork.

### D-007 v1 trust = capability-gate + install-consent (defer signing)
Date: 2026-06-03
Forking a blueprint pulls plugin code = a supply-chain surface. v1 posture = the existing plugin model (capability-gated + user-consent on install); signing/review deferred (O-2), acceptable because there are no users yet.
