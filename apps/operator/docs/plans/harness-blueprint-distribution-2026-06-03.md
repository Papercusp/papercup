---
title: Harness Blueprint Distribution — templates, snapshots, marketplace, Cupboard, build
slug: harness-blueprint-distribution-2026-06-03
status: draft
created: 2026-06-03
updated: 2026-06-03
owner: avi@storewolf.com
---

# Harness Blueprint Distribution — templates, snapshots, marketplace, Cupboard, build

## Now

**State:** Companion to `harness-blueprint-orchestration-2026-06-03` (the engine). This is the **packaging + sharing** half: reviving the harness template / snapshot / marketplace / Cupboard / build systems — designed long ago for young infra, **mostly flag-gated OFF** — and reframing them around the **Blueprint as the shareable unit**. Output of a 5-surface codebase audit (2026-06-03). Not started in code.

**Next:** (1) settle the 2 distribution forks (O-1 unit identity; O-2 tool-trust posture); (2) confirm sequencing **after** the orchestration plan's Phase A/B (a blueprint + `harness:create` + `work_items` must exist first); (3) the headline reframe is already captured in the orchestration plan's **D-019** (and the scheduler seam in **D-018**).

## Background

### Why this exists
A Blueprint is only portable if its **dependencies travel with it**: prompts (data) and base blueprints (data) are easy, but **tools are code**. That single fact is why the blueprint system ties into the marketplace/template/snapshot systems — and why they must be revived + redesigned **together** for v1, not separately.

### The three-layer distribution model (the headline)
| Layer | What travels | Carried by | Status today |
|---|---|---|---|
| **Definition** | blueprint YAML + prompts + `extends` | **git** (harness repo) → Cupboard | Entry-4 join already git-clones `.harness/*` |
| **Code (tools)** | the `defineTool`s roles need | **plugins** (`@papercusp/tooldef`, host-agnostic) | 24+ plugins; auto-installed by `init --from` |
| **State (optional)** | work_items, runs, history | **snapshot** (`@papercusp/export-state`) | built, flag-gated off, unfinished |

### What exists today (confirmed) + stale flags
- **Cupboard** — REAL + deployed (`apps/operator-public/`, CF-Worker + D1, `cupboard.papercusp.com`); listings keyed by `github_repository_id` (one per repo); publish via gh-token (rate-limited); operator proxies `/api/cupboard/*`.
- **Two distribution backends** — the Cupboard (public harness listings, git-based) AND a separate "marketplace server" at `:3057` serving template/plugin tarballs (`/v1/catalog` tiered-fallback). Overlapping → **consolidate to one**.
- **Templates** — a file seed bundle (`papercusp.json` + SPEC.md/AGENTS.md/config.json + tree). STALE: still seeds **deprecated** SPEC.md + validation-contract.md; only `sheets-clone` built-in; `FLAGS.TEMPLATES` off.
- **Snapshots** — TWO incompatible systems: `snapshots:*` (portable per-harness PG-subset + `.harness/` tree, **EXCLUDES git history**; `FLAGS.SNAPSHOTS` off) and `backup:*` (kopia, whole-workspace crash recovery, always on). STALE: `harness_snapshots_consolidated` created but **never written**; fork-slug rewrite unwired; **`work_items` (D-013) not in capture scope**.
- **Build** — local-only (no CI; `release-local.sh` + `build-desktop-sidecar.sh`); base blueprints + prompts live in the harness package (`libs/papercusp/packages/harness/`, bundled into the sidecar).
- **Plugins** — THE code-distribution unit (`libs/papercusp/plugins/`, 24+; `papercusp.json` `tools[]`+capabilities; installed to `~/.papercusp/global-plugins/`, capability-gated).
- **Tool framework** — `defineTool` migrated to host-agnostic `@papercusp/tooldef` (`@papercusp/agent-mcp` re-exports); tool *definitions* still in `apps/operator/lib/agent-tools/`. The host-agnostic move is exactly what enables plugin/blueprint-bundled portable tools.

## Plan
*(Sequenced AFTER orchestration Phase A/B. Code anchors from the 2026-06-03 audit; P-items at kickoff.)*

### Phase E1 — Templates → Blueprints
- Reframe: a "template" = a **blueprint (shape) + optional seed content** (starter plans/work-items). Drop SPEC.md/validation-contract seeding (stale, agents don't read it).
- Base blueprints (`base`, `coding`, `research-base`) live in the harness package `libs/papercusp/packages/harness/blueprints/` alongside `prompts/`; `extends` resolves local → installed → built-in (mirrors prompt resolution).
- `papercusp init --from <X>` becomes "instantiate a harness from a blueprint (+ seed)" rather than a directory copy.

### Phase E2 — Tool portability (dep manifest + plugins)
- Blueprint declares its **tool/plugin dependencies**. Add **import-time validation** (the missing manifest — today only `dispatch-stack.ts:192` fails, at call-time): on import/clone, resolve required tools/capabilities against the catalog + installable plugins; fail upfront with a clear "needs plugin X."
- Portable custom tools are authored as **plugins** on `@papercusp/tooldef`; wire `init --from` plugin auto-install to the blueprint's declared deps. (Core/private tools stay `defineTool` in `apps/operator` — not portable.)

### Phase E3 — Clone = git(definition) + snapshot(state)
- Reconcile D-006 (blueprint git-canonical) with snapshots-exclude-git: a blueprint **share** = a git clone (Entry-4 join — carries blueprint + prompts + history); a **fork-with-data** = git clone + a state snapshot.
- Narrow `snapshots:*` to **runtime state** (work_items + runs); ADD `work_items` (D-013) to the capture scope (audit: not captured today); **wire-or-drop** the orphaned `harness_snapshots_consolidated` (O-3).

### Phase E4 — Backend consolidation + Cupboard reframe
- Consolidate the two distribution backends (the `:3057` tarball marketplace + the Cupboard) into one.
- Reframe the Cupboard's listed unit as a **Blueprint**; flip `FLAGS.TEMPLATES/SNAPSHOTS/MARKETPLACE` on for v1 once reframed.

### Phase E5 — Trust / sandboxing posture
- Shared blueprints pulling plugin **code** is a supply-chain surface. v1 posture = capability-gate + install-consent (the existing plugin model); flag signing/review for later (O-2).

## Open decisions (need avi's call)
- **O-1 Shareable-unit identity** — GitHub-repo-backed (Cupboard's current model; reuses Entry-4 + git) vs content-addressed blueprint package (decoupled from GitHub; a real package registry). **Rec: git-repo-backed for v1, package-registry later.**
- **O-2 Tool trust/sandboxing** — capability-gate + install-consent (v1, current plugin model) vs stricter signing/review. **Rec: capability-gate + consent for v1 (no users yet), flag explicitly.**
- **O-3 Snapshot home** — wire `harness_snapshots_consolidated` (a PG index) vs keep filesystem-based (`.harness/snapshots/*.tar.gz`). **Rec: decide in E3.**

## Risks & mitigations
- **Two backends + flag-gated-off systems = much stale code** → redesign, don't patch; treat code that conflicts with current infra as wrong (per the audit brief).
- **Supply chain** (plugin code in shared blueprints) → capability-gate + install-consent (E5); revisit signing.
- **Sequencing** → depends on orchestration Phase A/B (blueprint + `harness:create` + `work_items`); don't start E-phases before they land.
- **Snapshot/git reconciliation must not lose blueprint history** → git carries definition + history; the snapshot carries state only (E3).

## Decisions

### D-001 Three-layer distribution (git / plugins / snapshot)

Date: 2026-06-03

The shareable unit is a Blueprint, distributed across three layers mapped onto existing systems: definition = git (harness repo) + the Cupboard listings service; code (custom tools) = plugins; optional state (work_items, runs, history) = a narrowed snapshot. Mirror of orchestration-plan D-019.

### D-002 Templates subsumed by blueprints

Date: 2026-06-03

A "template" = a blueprint (shape) + optional seed content; drop the SPEC.md/file-copy model (stale). Base blueprints live in the harness package (`libs/papercusp/packages/harness/blueprints/`), `extends`-resolved local → installed → built-in.

### D-003 Portable tools = plugins on @papercusp/tooldef; import-time dep manifest required

Date: 2026-06-03

Core/private tools = `defineTool` in `apps/operator/lib/agent-tools/` (built-in, not portable). Shareable tools = plugins (the runtime-installable, capability-gated code unit), authored on the now-host-agnostic `@papercusp/tooldef`. A blueprint declares its tool/plugin deps, and import-time validation resolves them against the catalog + installable plugins — closing the gap where a missing tool fails only at call-time (`dispatch-stack.ts:192`, `unknown_tool`).

### D-004 Blueprint share = git clone; fork-with-data = git + state snapshot

Date: 2026-06-03

Reconciles D-006 (blueprint git-canonical) with snapshots-exclude-git. A blueprint *share* is a git clone (Entry-4 join — definition + prompts + history). A *fork with data* is a git clone + a state snapshot. Narrow `snapshots:*` to runtime state; add `work_items` (D-013) to the capture scope.

### D-005 Consolidate the two distribution backends; the Cupboard lists Blueprints

Date: 2026-06-03

The `:3057` tarball "marketplace server" and the Cupboard listings service overlap — collapse to one backend. Reframe the Cupboard's listed unit as a Blueprint; flip `FLAGS.TEMPLATES/SNAPSHOTS/MARKETPLACE` on for v1 once reframed.

### D-006 v1 trust = capability-gate + install-consent (defer signing)

Date: 2026-06-03

Shared blueprints pulling plugin code is a supply-chain surface. v1 posture = the existing plugin model (capability-gated + user-consent on install); signing/review is deferred (O-2), acceptable because there are no users yet.
