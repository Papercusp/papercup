---
title: Modernize the stale harness substrate role prompts
slug: substrate-prompt-modernization-2026-05-31
status: draft
created: 2026-05-31
updated: 2026-05-31
owner: avi@storewolf.com
---

# Modernize the stale harness substrate role prompts

## Now

**State:** **Both axes complete + verified.** (1) SPEC.md (D-004) + validation-contract.md (D-005): scrubbed from all prompts (submodule 8adae67/7785bee/63bb673). (2) Dead-infra axis: done + corrected (final submodule 8d8f6f5, gitlink 9697ff79e). All 17 role prompts' operator-API curls now use **http://localhost:3070** (the hono API host); reviewer.md's stale SQLite 'store.db @ ~/.restart-org' header → canonical PG header; scoper.md dropped the deleted-run.sh shim + run.sh env refs; curator.md reads the work queue not features.json. IMPORTANT correction made mid-pass: I first used `$OPERATOR_BASE` but verified against source (harness-launch.ts:43-79 + invoke.ts:1176 spawnEnv) that the spawned ROLE-AGENT env does NOT carry OPERATOR_BASE — that var is injected only for hook shell scripts (hooks.ts:108) — so `$OPERATOR_BASE` would expand empty in an agent shell. Switched everything to the literal :3070 (CLAUDE.md-canonical, reachable without the Vite :3055 dev proxy). Verified: 0 `http://localhost:3055`, 0 `$OPERATOR_BASE`, 0 run.sh/store.db/restart-org/sqlite3, 51 :3070/api refs. No `:3070` restart needed — prompts are read per agent-spawn.

**Next:** Plan complete for its full scope. Recommend marking shipped. Optional follow-ups if wanted: (a) scoper.md has a duplicated migration-note header block (harmless structural dedup); (b) consider adding OPERATOR_BASE (or a single API-base var) to the role-agent spawnEnv in invoke.ts so prompts could use a var instead of a literal port — but the literal :3070 is correct + simplest today; (c) spot-run a harness pipeline turn to confirm agents behave. Left intentionally: scoper.md:128 localhost:3055 sample-app /auth/login VAL example (illustrative target-app endpoint, not operator infra).

## Background

The stale axes per prompt (grep-verified against current source 2026-05-31; counts = matching lines):

| prompt | SPEC.md | validation-contract | store.db / features.json | :3055 | notes |
|---|---|---|---|---|---|
| `scoper` | 0 | 0 | 11 | 8 | worst overall, but **dead-infra**, not SPEC.md |
| `reviewer` | 8 | 3 | 2 | 3 | worst on SPEC.md/contract |
| `plan-gate` | 5 | 3 | 2 | 1 | |
| `orchestrator` | 0 | 1 | 2 | 7 | |
| `curator` | 1 | 1 | 3 | 5 | |
| `validator` | 1 | 0 | 2 | 4 | the 1 SPEC ref is the per-expert `.harness/experts/<id>/SPEC.md` (a *different*, live concept — leave it) |
| `crosscheck` | 0 | 2 | 2 | 3 | |
| `debugger` | 0 | 2 | 2 | 2 | |
| `documenter` | 0 | 2 | 2 | 1 | |
| `architect` | 0 | 0 | 2 | 3 | |
| `worker` | 0 | 0 | 2 | 3 | |
| `synthesizer` | 1 | 1 | 0 | 0 | nearly clean |
| `project_manager` | 1 | 0 | 0 | 0 | nearly clean (PM curates `projects.spec`, a live PG column — verify the 1 ref isn't that) |
| `scanner` | 0 | 0 | 0 | 0 | already clean |

The current architecture these must be rewritten to:
- **SPEC.md (D-004) → the owning plan** is the authoritative scope/north-star.
- **validation-contract.md (D-005) → inline VAL-\* assertions** (`harness_plan_assertions`; resolve via `GET /api/harness/:slug/assertion/:valId`).
- **SQLite `store.db` / `features.json` → `harness_features` in Postgres** (query via the harness status API / `features:*` tools; agent writes via `messages:feature_send`).
- **retired `:3055` webapp API → the current operator API** (`:3070` host; the desktop is the product).
- **file-proposal → SPEC.md flow → the plans flow** (proposals file-mode is being retired; see the SPEC.md audit follow-ups).

## Approach (per prompt — NOT a find-replace)

For each role prompt: (1) read it fully; (2) map every stale reference to its current mechanism using the table above; (3) rewrite to the current architecture while **preserving the role's actual job** (the personas are otherwise sound); (4) verify against *source* (e.g. confirm a `SPEC.md` ref is the harness-root file, not the per-expert spec); (5) one submodule commit per logical batch + a superproject gitlink bump. The substrate is a clean, editable submodule (`libs/papercusp`, on `main`).

## Items

- **P-001** `todo` `reviewer.md` — heaviest (8 SPEC.md + 3 contract + dead store.db/:3055/file-proposal). Full modernization to plans + inline VAL-* + PG features + `:3070`.
- **P-002** `todo` `plan-gate.md` — 5 SPEC.md + 3 contract + dead infra. (Confirm reviewer vs plan-gate role split first — they overlap.)
- **P-003** `todo` `scoper.md` — 11 store.db/features.json + 8 `:3055`. No SPEC.md, but the worst dead-infra offender; the scoper is central, so high value.
- **P-004** `todo` `orchestrator.md` — 7 `:3055` + dead infra. The pipeline driver; correctness matters most here.
- **P-005** `todo` `curator.md` — SPEC.md + contract + store.db + `:3055`.
- **P-006** `todo` `validator.md` + `crosscheck.md` + `debugger.md` — contract + dead infra. (validator's lone SPEC ref is the per-expert spec — leave it.)
- **P-007** `todo` `documenter.md` + `architect.md` + `worker.md` — dead infra (store.db/features.json/:3055), no SPEC.md.
- **P-008** `todo` `synthesizer.md` + `project_manager.md` — near-clean residuals (1 SPEC/contract each); confirm project_manager's ref isn't the live `projects.spec` PG column.
- **P-009** `todo` Verification pass: re-grep all prompts for the 5 stale axes → expect zero (except the per-expert SPEC.md + `projects.spec`); spot-run a harness pipeline turn to confirm agents behave.

## Decisions

### D-001 — Approach + go-ahead needed before execution (OPEN — needs avi)
Date: 2026-05-31. These prompts are loaded live by the pipeline, so rewriting them changes agent behavior across the whole harness fleet. Open questions for avi: (a) green-light a full modernization (not just SPEC.md) of all stale axes? (b) one-prompt-per-commit with a review gate, or batch? (c) any prompts to leave frozen (e.g. if a role is itself being retired)? Recommendation: full modernization, reviewer→scoper→orchestrator first (highest leverage), one submodule commit per batch, verify against source each time.
