---
title: Modernize the stale harness substrate role prompts
slug: substrate-prompt-modernization-2026-05-31
status: shipped
created: 2026-05-31
updated: 2026-06-01
owner: avi@storewolf.com
---

# Modernize the stale harness substrate role prompts

## Now

**State:** **String-modernization axis DONE across all 17 role prompts** (this is what shipped 2026-05-31; submodule commits 8adae67 / 7785bee / 63bb673 / 5d21822, gitlink bumps to 01c615fca). Every prompt's stale *strings* were corrected: SPEC.md (D-004) → the owning plan; validation-contract.md (D-005) → inline VAL-* assertions; the file-proposal "auto-applied to SPEC.md / goes into SPEC.md" wording → "folded into the owning plan"; `http://localhost:3055` → `http://localhost:3070` (the hono API host — verified the spawned role-agent env does NOT carry `$OPERATOR_BASE`, so a literal port was correct); reviewer.md's stale SQLite `store.db @ ~/.restart-org` header → the canonical PG header; scoper.md dropped the deleted-`run.sh` shim. Verified: 0 `http://localhost:3055`, 0 `$OPERATOR_BASE`, 0 `run.sh`/`store.db`/`restart-org`/`sqlite3`, ~59 `:3070/api` refs. No `:3070` restart needed — prompts are read per agent-spawn.

**What this plan did NOT do — carved out to a follow-up (D-002):** the *architectural* reframing. The string scrub fixed what the prompts SAY about files/ports; it did not fix what they say about the **pipeline engine**. The review (2026-06-01) found the prompts still describe the **RETIRED** main-loop architecture: `orchestrator.md` (259 lines, "You are the ORCHESTRATOR") still presents itself as the live driver though the live engine is the DBOS per-feature pipeline driven by `director.md` (47 lines); prompts still teach DBOS-`unsupported` verbs (`NEXT_HARNESS`, `CEO_MODE`, `N=` parallel lanes); and `scoper`/`reviewer`/`plan-gate` present `MODE=initial`/`MODE=plan` as live though the pre-loop they belong to does not exist in the DBOS path. That work is **`dbos-pipeline-prompt-reconciliation-2026-06-01`**.

**Next:** This plan is effectively shipped for its (string) scope — recommend marking `shipped` once the carve-out (D-002) is acknowledged. The architectural reframing continues in the DBOS-reconciliation plan.

## Background

The stale axes per prompt (grep-verified against source 2026-05-31; counts = matching lines at audit time):

| prompt | SPEC.md | validation-contract | store.db / features.json | :3055 | notes |
|---|---|---|---|---|---|
| `scoper` | 0 | 0 | 11 | 8 | worst overall, but **dead-infra**, not SPEC.md |
| `reviewer` | 8 | 3 | 2 | 3 | worst on SPEC.md/contract |
| `plan-gate` | 5 | 3 | 2 | 1 | |
| `orchestrator` | 0 | 1 | 2 | 7 | retired engine — see D-002 |
| `curator` | 1 | 1 | 3 | 5 | |
| `validator` | 1 | 0 | 2 | 4 | the 1 SPEC ref is the per-expert `.harness/experts/<id>/SPEC.md` (a *different*, live concept — left intact) |
| `crosscheck` | 0 | 2 | 2 | 3 | |
| `debugger` | 0 | 2 | 2 | 2 | |
| `documenter` | 0 | 2 | 2 | 1 | |
| `architect` | 0 | 0 | 2 | 3 | |
| `worker` | 0 | 0 | 2 | 3 | |
| `synthesizer` | 1 | 1 | 0 | 0 | nearly clean |
| `project_manager` | 1 | 0 | 0 | 0 | the 1 ref is the live `projects.spec` PG column — left intact |
| `scanner` | 0 | 0 | 0 | 0 | already clean |

Target architecture the strings were rewritten to:
- **SPEC.md (D-004) → the owning plan** (authoritative scope/north-star).
- **validation-contract.md (D-005) → inline VAL-\* assertions** (`harness_plan_assertions`; resolve via `GET /api/harness/:slug/assertion/:valId`).
- **SQLite `store.db` / `features.json` → `harness_features` in Postgres**.
- **retired `:3055` webapp API → the operator API on `:3070`** (the hono host).

## Phase 1 — Per-prompt string modernization (DONE)

- **P-001** `done` `reviewer.md` — SPEC.md→plan, contract→VAL-*, :3055→:3070, store.db header → PG header, file-proposal "goes into SPEC.md"→"folded into owning plan". (Deeper: whether reviewer's `MODE=plan`/`MODE=proposal` framing is even live → D-002 / DBOS plan.)
- **P-002** `done` `plan-gate.md` — SPEC.md→plan, contract→VAL-*, dead `GOAL.md`→plan, :3055→:3070. (reviewer-vs-plan-gate role overlap → D-002 / DBOS plan.)
- **P-003** `done` `scoper.md` — :3055→:3070, dropped deleted-`run.sh` shim + run.sh env refs. (Whether the scoper's `MODE=initial` ingestion role is still live under DBOS → D-002 / DBOS plan.)
- **P-004** `done` `orchestrator.md` — :3055→:3070 strings only. The **retirement/merge into `director.md`** is the core of the DBOS plan, NOT done here (D-002).
- **P-005** `done` `curator.md` — SPEC.md+contract deprecation notes, store.db→work-queue, :3055→:3070.
- **P-006** `done` `validator.md` + `crosscheck.md` + `debugger.md` — contract→VAL-*, :3055→:3070. validator's per-expert SPEC ref left intact.
- **P-007** `done` `documenter.md` + `architect.md` + `worker.md` — contract→VAL-*, :3055→:3070.
- **P-008** `done` `synthesizer.md` + `project_manager.md` — residual deprecation notes; project_manager's `projects.spec` (live PG column) left intact.

## Phase 2 — Verification (DONE for the string axis)

- **P-009** `done` Re-grepped all prompts for the 4 string axes → zero remaining (except the deliberately-kept per-expert SPEC.md, `projects.spec`, and scoper.md:128's sample-app `/auth/login` VAL example). NOT done: the "spot-run a harness pipeline turn to confirm agent behavior" — moved to the DBOS plan's verification (D-002), since behavior correctness depends on the architectural reframing, not the strings.

## Decisions

### D-001 — Full modernization green-lit; one submodule commit per batch
Date: 2026-05-31. avi green-lit modernizing all stale axes (not just SPEC.md). Executed as batched submodule commits + gitlink bumps, verifying each against source. The string axes (SPEC.md, validation-contract.md, dead-infra ports/files) were completed this session.

### D-002 — Architectural reframing carved out to the DBOS-reconciliation plan
Date: 2026-06-01. This plan's items were originally scoped as "full modernization," but in practice only the **string axes** were completed — the deeper **architectural** inaccuracies (prompts describe the retired main-loop/orchestrator engine, teach DBOS-unsupported verbs, and present a pre-loop scoper/plan-gate sequence that the live DBOS path does not run) are a distinct, behavior-changing effort. Rather than silently leave the Phase-1 items half-true, they are marked `done` for the string scope they actually achieved, and the architectural work is tracked in **`dbos-pipeline-prompt-reconciliation-2026-06-01`**. Rationale: keeps this plan honest (it did finish the deprecation-string cleanup that the SPEC.md/validation-contract arc required) without conflating it with the larger engine-accuracy question.
