---
title: Reconcile substrate role prompts to the live DBOS director pipeline
slug: dbos-pipeline-prompt-reconciliation-2026-06-01
status: draft
created: 2026-06-01
updated: 2026-06-01
owner: avi@storewolf.com
---

# Reconcile substrate role prompts to the live DBOS director pipeline

## Now

**State:** Draft for review before any code. The `substrate-prompt-modernization` plan fixed what the prompts SAY about deprecated *files and ports* (SPEC.md→plan, contract→VAL-*, :3055→:3070). This plan fixes what they say about the **engine** — and that's a deeper, behavior-changing problem. Code review (2026-06-01, all verified against source) found the role prompts still describe the **RETIRED main-loop architecture**, so live agents are being told how a pipeline that no longer runs works. The personas themselves are mostly sound; the *control-flow narrative* is wrong.

**Next:** human decision on D-001 (retire-vs-merge `orchestrator.md`) and D-002 (is the pre-loop scoper/plan-gate flow actually dead under DBOS, or just unmodeled?) — both need a code/intent call before editing. Then P-001…P-007.

## Background — the gap, grounded in source (verified 2026-06-01)

**The live engine** (`apps/operator/lib/dbos/orchestrator-workflow.ts`, default-on since P-009 `dbos-retire-legacy-orchestrator-2026-05-31`):
- A **DBOS durable per-feature pipeline**. The 30s dispatcher (`orchestrator-dispatcher.ts`) reads `harness_features`, runs up to `PAPERCUSP_DBOS_MAX_PIPELINES` (default 4) pipelines concurrently.
- Each pipeline turn runs the **`director`** role (`orchestrator-workflow.ts:106`, `orchestratorRole ?? 'director'`) — `director.md` is 47 lines, "You are the **director** for a SINGLE feature inside a durable pipeline."
- `classifyDecision()` (`orchestrator-decide.ts`) maps the director's verb to a role dispatch. It explicitly classifies `NEXT_HARNESS`, `NEXT_WORKER_CEO_MODE`, and `NEXT_WORKER N=k` (parallel lanes) as **`unsupported`** — the pipeline stops rather than running them.
- There is **no pre-loop** in the DBOS path (`grep runPreLoop apps/operator/lib/dbos/` → 0 hits). The scoper-`MODE=initial` gate and reviewer-`MODE=plan` gate that `pre-loop.ts` runs are **legacy-only**.

**The retired engine** (`libs/papercusp/packages/orchestrator/src/main-loop.ts`, banner line 1: "⚠️ RETIRED … Do not extend"):
- `orchestrator.md` (259 lines, "You are the **ORCHESTRATOR** in a 3-agent autonomous coding harness") is its persona. It is **6× the size of `director.md`** and still presents itself as the live decision driver.
- The legacy loop is reachable only via `PAPERCUSP_DBOS_ORCHESTRATOR=0` + `bin/run.ts` (a revert path the operator never invokes).

**The concrete inaccuracies in the live-loaded prompts:**
1. `orchestrator.md` describes itself as the live driver — but `director.md` is. Two prompts, overlapping job, one retired.
2. `orchestrator.md` (and `README.md`) teach verbs the DBOS path rejects as `unsupported` (`NEXT_HARNESS`, `CEO_MODE`, `N=` lanes). An agent emitting them gets a silent pipeline stop.
3. `scoper.md` / `reviewer.md` / `plan-gate.md` present `MODE=initial` / `MODE=plan` as the operating flow — but the pre-loop that triggers those isn't in the DBOS path. (Scoper IS still reachable via `NEXT_SCOPER` + the `/replan`,`/product-review` endpoints, so it's not dead — but its *self-description* as a pre-loop gate is.)
4. The "scoper→architect→worker→validator→reviewer→documenter→curator" fixed sequence several prompts imply is not how `director` decides — the director picks per-turn; curator/documenter are terminal-only; reviewer-`MODE=plan` is pre-loop (legacy).

**Why this matters (answers the review's Q2 — "do the prompts make sense for what Papercusp is trying to achieve"):** a worker/validator reading an accurate persona is cheap; one reading a retired-engine persona wastes turns on dead verbs and mis-models who decides what. This is the highest-value correctness work left on the prompt surface — bigger than the string scrub, because it's about *behavior*, not *vocabulary*.

## Phase 1 — Decide the engine-prompt topology (needs-human gates)

- **P-001** `needs-human` Decide `orchestrator.md`'s fate: (a) **retire** it (move to `_archived/`, since the legacy loop that loads it is retired) and make `director.md` the sole decision persona; (b) **merge** the still-relevant guidance from orchestrator.md into director.md, then retire; (c) keep both, clearly labelled legacy-vs-live. Recommendation: (b) — salvage the genuinely-useful decision heuristics into director.md, then archive orchestrator.md. See D-001.
- **P-002** `needs-human` Decide the scoper/pre-loop framing: is the pre-loop (scoper-`MODE=initial`, reviewer-`MODE=plan`) intended to return under DBOS, or is it gone for good? This determines whether `scoper.md`/`reviewer.md`/`plan-gate.md` get *reframed* (scoper = on-demand re-scope via `NEXT_SCOPER`/`/replan`; no auto-gate) or *rewritten around a planned DBOS pre-loop*. Recommendation: reframe to the current reality (no auto pre-loop; scoper is on-demand) — don't document an aspiration. See D-002.

## Phase 2 — Director-engine accuracy (the core rewrite)

- **P-003** `todo` Audit `director.md` (47 lines) against `orchestrator-decide.ts`: confirm every verb it can emit is one the DBOS classifier actually `dispatch`es, and that it does NOT advertise `NEXT_HARNESS`/`CEO_MODE`/`N=` lanes (which classify as `unsupported`). Add the verbs the classifier supports but director may under-use (`NEXT_TESTER`, `NEXT_SECURITY`, `GENERATE_TESTS`, `NEXT_MONITOR`, `NEXT_EXPERT`, `NEXT_FEEDBACK`). Tighten it to the per-feature durable-pipeline reality. blocked-by: P-001
- **P-004** `todo` Retire/merge `orchestrator.md` per the P-001 decision. If merged: lift the still-true decision heuristics (when to architect vs worker, escalation criteria, issue-conversion) into director.md; drop everything about the multi-iteration global loop, `IDLE`/`READY_FOR_PROD`/`FEATURE_FREEZE`/`RUN_TESTS` verbs, and the 3-agent framing. Then `git mv` orchestrator.md to `prompts/_archived/`. blocked-by: P-001
- **P-005** `todo` Reframe `scoper.md` / `reviewer.md` / `plan-gate.md` per the P-002 decision: drop the pre-loop self-description; state scoper is invoked on-demand (`NEXT_SCOPER`, `/replan`, `/product-review`) and that plan→promote is the primary ingestion path (not scoper-`MODE=initial`). Resolve the reviewer-vs-plan-gate overlap (which one is live? both load — confirm from `role-registry.ts` + decide if one should be archived). blocked-by: P-002
- **P-006** `todo` Sweep the remaining prompts + `README.md` for the retired-sequence narrative and the unsupported verbs: any "scoper→…→curator" fixed-pipeline language, any `NEXT_HARNESS`/`CEO_MODE` mention, reframed to "the director decides each turn." Grep target: `NEXT_HARNESS|CEO_MODE|NEXT_WORKER N=` → 0 in live prompts (README may keep them with a clear "legacy" label).

## Phase 3 — Verify behavior, not just text

- **P-007** `todo` The verification the string-plan deferred: spot-run a harness pipeline turn (per the testing docs — `/internal/docs/testing` + agent-e2e) on a scratch harness and confirm the director's emitted verbs are all `dispatch`-classified (no `unsupported` stops), and that worker/validator behave against the reframed personas. This is the real "do the prompts make sense" check. blocked-by: P-003, P-004, P-005

## Decisions

### D-001 — orchestrator.md: retire vs merge into director.md (OPEN — needs avi)
Date: 2026-06-01. `orchestrator.md` (259 lines) is the persona of the RETIRED main loop; `director.md` (47 lines) drives the live DBOS pipeline. Keeping both risks an agent loading the wrong mental model. Options: (a) hard-retire orchestrator.md to `_archived/`; (b) merge its still-true heuristics into director.md then retire; (c) keep both labelled. Recommendation: (b). Note the legacy loop can still be re-enabled via `PAPERCUSP_DBOS_ORCHESTRATOR=0` — if that revert path must keep working, orchestrator.md should be archived (preserved) not deleted, so a revert still has its persona.

### D-002 — Is the pre-loop (scoper-initial / reviewer-plan gate) dead under DBOS? (OPEN — needs avi)
Date: 2026-06-01. The DBOS path has no `runPreLoop`, so the scoper-`MODE=initial` ingestion gate and reviewer-`MODE=plan` plan-review gate do not auto-run. But the scoper is still reachable on-demand (`NEXT_SCOPER`, `/replan`, `/product-review`) and plans:promote is now the primary ingestion path. Decision: do we (a) reframe the prompts to "no auto pre-loop; scoper is on-demand; plans:promote ingests" (matches current code), or (b) treat the missing pre-loop as a DBOS gap to be filled and keep the prompts describing the intended gate? Recommendation: (a) — document reality, not aspiration; if a DBOS pre-loop is later wanted, that's its own feature + plan. This decision gates P-005.
