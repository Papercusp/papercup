---
title: Playbook audience-neutral rewrite — papercusp-su.tools.md for the power-engineer audience
slug: playbook-audience-neutral-rewrite-2026-05-23
status: shipped
created: 2026-05-23
updated: 2026-05-24
owner: pandawamble@gmail.com
related:
  - apps/operator/docs/plans/omp-power-user-bundle-2026-05-20.md
  - apps/operator/docs/plans/per-harness-plans-and-docs-2026-05-23.md
  - apps/operator/docs/plans/desktop-app-install-integration-2026-05-23.md
---

## Now

**State:** SHIPPED 2026-05-24. All 11 items done. Phase 1 (interim neutralization) + Phase 2 (full split: two playbooks, installer --profile flag, wrapper update) complete. MCP-server-side tool gating continues in `omp-profile-system-2026-05-24`.

**Next:** No further action in this plan. See `omp-profile-system-2026-05-24` for the MCP gating work that completes the power-profile tool surface.

# Playbook audience-neutral rewrite

## §1 Why

`apps/operator/prompts/papercusp-su.tools.md` is the engineer-collaborator playbook injected into OMP's system prompt. It opens with *"You are an agent working with the engineers who build Papercusp"* and assumes the agent's subject of work is the Papercusp codebase. The omp-power-user-bundle ships the same playbook to end-users whose subject of work is **any harness** — making the framing wrong from the first sentence, and surfacing ~150 Papercusp-only tools (catalog audit, 2026-05-22) that do nothing for that audience.

D-008b was always going to need framing work. The catalog-split discussion gives it the framing: there are three audiences (Papercusp engineer / Papercusp operator / power engineer on any harness) and two clean profiles (the third folds into "any harness" once the per-harness portability work — separate plan — lands).

## §2 Scope

- **Phase 1 — interim audience-neutralization** (shippable now). Patch the playbook's intro + add an orientation section so it works passably for both audiences. Tool descriptions stay as-is (they're tool-level docs, mostly neutral). Re-run installer to refresh the shipped file.
- **Phase 2 — full split** (gated on profile-system plan). Two playbooks: `papercusp-su-engineer.tools.md` (today's content, audience = Papercusp engineer/operator) + `papercusp-su-power.tools.md` (subset for power-engineer audience: Group B + generalized Group C; drops Group A). Install script picks one based on `--profile=power` vs default; MCP server profile-gates the tool surface.

**Not in scope:** the profile system itself (designing how `--profile=power` filters tools at the MCP layer) — separate plan, dependency for Phase 2.

## §3 Decision context (alternatives behind the needs-human items)

### context for P-001 — interim approach

- **(a)** **Interim audience-neutralization now + full split later.** **Recommended** — small change, immediate win, doesn't commit to a profile system before that system is designed. Phase 2 supersedes when profiles land.
- **(b)** Wait — don't touch the playbook until profiles are designed; ship the audience mismatch as-is in the meantime.
- **(c)** Single audience-neutral rewrite (no split) — try to make one playbook serve both audiences forever. Risk: collapses to a low-common-denominator that doesn't serve either well.

### context for P-006 — profile system dependency

- **(a)** **Phase 2 blocked on a separate `omp-profile-system` plan.** **Recommended** — the profile mechanism is large (MCP-server-side tool filtering, per-profile install paths, settings UI for switching). Belongs in its own plan; this plan tracks the *playbook rewrite*, not the profile machinery.
- **(b)** Inline the profile design into this plan. Pro: one document. Con: scope creep — playbook rewrite waits on profile design.

### context for P-007 — split filename convention

- **(a)** **`papercusp-su-engineer.tools.md` + `papercusp-su-power.tools.md`.** **Recommended** — the `-engineer` / `-power` suffix maps 1:1 to the profile id.
- **(b)** Keep `papercusp-su.tools.md` as the engineer one (no rename); add `papercusp-su-power.tools.md` as the new one. Pro: zero rename churn. Con: asymmetric naming hides the structural symmetry.

## §4 Phase 1 design — interim audience-neutralization

Two patches to `apps/operator/prompts/papercusp-su.tools.md`:

**Intro section** (current opening line):

> Before: "You are an agent working with the engineers who build Papercusp."
> After: "You are an engineer-collaborator agent operating Papercusp. Papercusp manages projects ('harnesses') for you; you may be working on the Papercusp codebase itself, or on any other harness Papercusp manages. The §X orientation section below tells you how to know which."

**New "Working on Papercusp vs working on a harness" orientation section** (insert after intro, before tool patterns):

- If `ctx.harnessSlug` is set, you're scoped to one harness. Tools like `docs:*`, `features:*`, `issues:*` serve that harness.
- If not, you're at the operator level (working on Papercusp itself or operating across harnesses). The same tools fall through to Papercusp-wide views.
- This is the same model as `docs:*`/`cross_harness:docs_*` — your context determines scope.

Tool descriptions stay as-is — they're per-tool, mostly neutral, and the few that say "Papercusp" already do so accurately.

**Refresh:** re-run `install-standalone-mcp.sh` (idempotent, no token rotation — commit `a03fb875`). This rewrites `~/.papercusp/engineer-collaborator.md` from the patched source.

## §5 Phase 2 design — full split (after profile system lands)

Two playbooks:

**`papercusp-su-engineer.tools.md`** — today's content, refined for the Papercusp-engineer/operator audience. Keeps all 238 tools, framed for "operating Papercusp."

**`papercusp-su-power.tools.md`** — new. Subset for power-engineer-on-any-harness:
- Group B (~42 generic tools): `coord:*`, `locks:*`, `fetch_plus`, `firecrawl.*`, `gitnexus.*`, `repomix.pack`, `hindsight:recall`.
- Generalized Group C (43 tools, contingent on per-harness portability landing): `plans:*` per-harness, `docs:*` with project root, `memory:*` (mostly already generic), `search:*` (TBD generalization), `tasks:*`, `artifacts:*`.
- Excludes Group A (~150 Papercusp-only tools — won't surface to this profile via MCP-server gating).

**Install:** `install-standalone-mcp.sh --profile=power` writes `papercusp-su-power.tools.md` instead. Default profile is `engineer` (today's behavior).

**MCP gating:** profile-system plan owns this; specifies how `papercusp-su` at `?profile=power` filters its tool surface. The playbook describes what the profile sees.

## Phase 1 — interim audience-neutralization

- **P-001** `done` Decide interim approach → D-001: neutralize-now + full-split-later (auto-ratified 2026-05-24).
- **P-002** `done` Patched playbook intro framing in `apps/operator/prompts/papercusp-su-engineer.tools.md` per §4.
- **P-003** `done` Added "Working context: Papercusp vs a harness" orientation section.
- **P-004** `done` Re-ran `install-standalone-mcp.sh`; `~/.papercusp/engineer-collaborator.md` refreshed.
- **P-005** `done` Updated `omp-power-user-bundle-2026-05-20` D-008b note to reflect Phase 1 shipped + Phase 2 blocked.

## Phase 2 — full split

- **P-006** `done` Decide whether Phase 2 blocks on a separate profile-system plan → D-002: separate `omp-profile-system` plan (auto-ratified 2026-05-24).
- **P-007** `done` Decide split filename convention → D-003: `-engineer` + `-power` suffixes (auto-ratified 2026-05-24).
- **P-008** `done` Wrote `apps/operator/prompts/papercusp-su-power.tools.md` — power-engineer subset per §5.
- **P-009** `done` Renamed `papercusp-su.tools.md` → `papercusp-su-engineer.tools.md`; updated all runtime references (install script, 4 TS files, 2 test files).
- **P-010** `done` Extend `install-standalone-mcp.sh` with `--profile=engineer|power` (default engineer). (shipped `b85d4739`)
- **P-011** `done` Update `omp-su` wrapper template to bake profile-specific playbook path. (shipped `b85d4739`)

## §6 Dependencies & out of scope

- **Depends on:** a separate `omp-profile-system` plan (not yet drafted) for the MCP-server-side tool filtering. Phase 2 blocks on it; Phase 1 doesn't.
- **Depends on:** `per-harness-plans-and-docs-2026-05-23` for the Group-C generalization that makes `papercusp-su-power.tools.md` meaningful. Phase 2's tool subset assumes that's landed.
- **Out of scope:** the profile system mechanics (separate plan). Per-tool refactoring beyond per-harness portability (separate plans per tool). UI for profile switching (settings panel — covered by `desktop-app-install-integration-2026-05-23`).

## Decisions

### D-001 — Interim audience-neutralization now, full split later

Auto-ratified 2026-05-24. Rationale: minimal change, immediate correctness win for power-user sessions, doesn't commit to a profile system design before that system is designed. Phase 2 supersedes when `omp-profile-system` lands.

### D-002 — Phase 2 blocked on a separate `omp-profile-system` plan

Auto-ratified 2026-05-24. Rationale: the profile mechanism (MCP-server-side tool filtering, per-profile install paths, settings UI) is large enough to warrant its own plan. This plan tracks the playbook rewrite; the profile machinery is a dependency, not in scope here.

### D-003 — Filename convention: `-engineer` + `-power` suffixes

Auto-ratified 2026-05-24. Rationale: the `-engineer` / `-power` suffix maps 1:1 to the profile id, making the symmetry explicit. Asymmetric naming (`papercusp-su.tools.md` kept as engineer + new `-power` file) hides the structural symmetry and complicates future profile-system tooling.
