---
title: Harness Gym — eval-driven autonomous prompt/orchestration optimizer
slug: harness-gym-eval-optimizer-2026-06-02
status: draft
created: 2026-06-02
updated: 2026-06-02
owner: avi@storewolf.com
---

# Harness Gym — eval-driven autonomous prompt/orchestration optimizer

## Now

**State:** Overnight build COMPLETE for everything safely autonomous: ~all plan items built+TDD'd+committed under apps/operator/lib/gym/ (194 unit tests + live-PG integration, green); the hermetic SPINE is smoke-validated end-to-end; the boot smoke is now RELIABLE (dedicated pgvector container — fixed the shared-reused-container ECONNREFUSED flake). The worker last-mile is now PINNED: pg-bootstrap connects with the CORRECT search_path (harness_<slug>,harness_shared,public) + ctx.pg active + the harness_features view present — so it is NOT slug/search_path/DB (the hyphen-free + basename fixes were right). The remaining failure is a deeper invoke.ts/state-pg.ts path querying harness_features on a non-ctx.pg (no harness search_path) client. Full runbook in lib/gym/README.md.

**Next:** THREE items need avi/owner (autonomous work exhausted): (1) worker last-mile — a ~2-min trace in shared orchestrator code (invoke.ts/state-pg.ts: which query/client throws 'harness_features does not exist'? point it at the harness-scoped ctx.pg) — NOT edited unattended; smoke is reliable for the trace-and-rerun. (2) P-014 real A/B (variance/cost/correlation tools ready). (3) P-024 dashboard UI (data layer ready). Loop continues on a long heartbeat; truly quiet now.

## Background

Papercusp can already *judge a single feature internally* (the `validator` + `crosscheck` roles do evidence-based pass/fail against `VAL-###` acceptance criteria; `competition` mode scores N workers on one feature; the `curator` dedups issues) and already *captures telemetry* (cost, tokens, attempts, pass/fail in `harness_features` + `.jsonl` run logs + the status API). Two adjacent frameworks shipped: `llm-testing-framework-2026-05-14` (judge + cached-transcript re-evaluation + `ChatTarget`, aimed at *chat surfaces*) and `su-scenario-suite-2026-05-31` (behavioral prompt testing, sim-user + *deterministic asserts + LLM judge*, lesson: **don't lean on the judge alone — it's noisy**). Prompts are already swappable per-run via `promptOverrides.<role>` + per-role `models.<role>` in harness config — and that per-harness override mechanism is exactly what promotion writes into (D-012).

**The gap:** nothing runs the *whole pipeline* on a benchmark of features, scores the *resulting work*, compares prompt variants on equal footing, and closes a *propose→apply→rerun* improvement loop. This plan builds that — a **"harness gym"**: an eval-driven optimizer for the harness itself (the coding-agent analogue of DSPy/GEPA).

## Goals / Non-goals

**Goals**
- Run the real multi-agent pipeline on reproducible synthetic feature tasks, hermetically and in parallel.
- Score each run on what the harness *cannot self-check* — high-level intent achievement, spec gaps/misspecification given the project, subjective code quality, process correctness — via a **frozen Opus 4.8 judge using generic, judgment-based reasoning** (not a rigid checkbox rubric).
- Track cost/tokens/wall-clock deterministically as a guardrail + tiebreaker (never fed to the judge).
- Compare variants (prompt overlays) with per-task breakdowns and a Pareto frontier.
- Close a **fully autonomous** loop: judge-driven reflective proposal → apply as overlay → rerun → keep-if-better → **immediate promotion into a dedicated harness's overrides**, with deterministic guardrails + a circuit-breaker.

**Non-goals**
- Re-checking the literal functional spec the harness's own validator/tester already enforces (D-001).
- **Optimizing for pass-count.** "How many features passed" is an observability stat, not a reward — it is gameable by a mutable validator and is deliberately kept out of the optimization signal (D-011).
- Optimizing for cost inside the judge (cost is deterministic, compared by us).
- Writing to the shared default prompt files the live fleet reads (D-012). Driving any UI. Adopting DSPy/GEPA as a framework (D-007).

## Core concepts

- **Task** — a synthetic feature request `{repo@pinned-commit, spec, intent, planted_bug?}`. Generated intent-first, then a deliberately-realistic (mildly underspecified) spec so spec-gaps exist to find.
- **Task pools (D-013)** — `train` (drives the proposer) · **`dev-anchor`** (frozen for the whole run → champion comparison + circuit-breaker are apples-to-apples) · **`monitor`** (regenerated each cycle, never feeds an accept decision — only alarms on overfitting-to-anchor) · `probe` (planted-bug) · **`real-anchor`** (a small fixed set of real shipped features, scored but never optimized — the falsifiability check, D-014).
- **Variant** — a prompt overlay: `{ promptOverrides per role }`. **v1 mutates prompts only** (D-015); `models`/orchestration params exist in the schema but are reserved for a later phase. Never an in-place edit of canonical files (D-010).
- **Run** — one `(variant × task)` execution of the full pipeline, hermetic. Produces deterministic signals + a cached (distilled) trace.
- **Score** — frozen Opus judge output: three dimensions + rationale (§ Scoring rubric). The judge's composite is **the reward**.
- **Frontier / Champion / Promotion target** — three tiers (D-005): the Pareto frontier (train vectors, drives parent selection) → the champion (dev-anchor best, subject to gates) → the **dedicated gym harness's overrides** (immediate, autonomous promotion — D-012).

## Architecture

```
                          ┌─────────────────────────────────────────────┐
                          │              HARNESS GYM (new)                │
                          └─────────────────────────────────────────────┘

  ① TASK GENERATOR ────────► synthetic feature task   (generator model ≠ judge model, D-015)
     (grounded in a real     { repo@pinned-commit, spec, intent, planted-bug? }
      repo, intent-first)          │
                                    ▼
  ② RUNNER / ISOLATION ──► isolated harness instance per (task × variant), headless backend-only
     (worktree + own DB/        runs the REAL pipeline scoper→…→curator with the VARIANT's prompt
      ports; pins substrate     overlay. Validator stays MUTABLE but pass-count is not a reward.
      AND harness commit)            │
                                    ▼
  ③ TRACE COLLECTOR ──────► run record (PG) + cached trace bundle (files, retention) →
     (.jsonl + files)         ③b DISTILLATION: select/summarize into a judge-sized input
                                    │
                        ┌───────────┴───────────┐
                        ▼                        ▼
  ④ DETERMINISTIC SIGNALS          ⑤ OPUS JUDGE (frozen: model+weights+temp+rubric_hash)
     un-gameable: regressions,        generic, judgment-based scoring on the distilled trace:
     planted-bug-caught; cost         intent+spec-gaps · code-quality · process-correctness
     guardrail; pass-count =          → composite = THE REWARD
     OBSERVABILITY ONLY               │
                        └───────────┬───────────┘
                                    ▼
  ⑥ EXPERIMENT STORE (PG) ─► variant × task → {judge scores, signals, frozen run-params}
                                    │
                                    ▼
  ⑦ OPUS PROPOSER ────────► reads worst train traces + judge rationales + changelog,
     (reflective, prompts-only) emits a targeted PROMPT diff → candidate VARIANT
                                    │
                                    ▼
  ⑧ ACCEPT / PROMOTE ─────► rerun; keep on frontier iff judge↑ (margin) AND dev-anchor
     (autonomous)              no-regress AND probe-caught AND no-new-regressions AND cost-ok;
                               champion → write overrides into the DEDICATED gym harness (D-012)
```

The **evaluable unit** is "one full harness run on one synthetic task." The left column (①–⑥) is the **measurement spine** — usable manually to A/B two prompt sets before ⑦–⑧ exist (also the safe build order).

## Scoring rubric

A `(variant × task)` evaluation yields two kinds of signal that never merge into one number.

**A. Deterministic signals** (computed):

| Signal | Meaning | Role |
| --- | --- | --- |
| `regressions` | did the diff break the repo's pre-existing tests? | **un-gameable gate** |
| `planted_bug_caught` | (probe tasks) did the harness catch the injected defect? | **un-gameable guardrail/monitor** |
| `cost_usd`, `tokens`, `wall_clock_s` | deterministic cost | guardrail + tiebreaker (never judged) |
| `terminal_state` / pass-count | the validator's pass/fail verdict | **observability only** — NOT a reward and NOT a gameable gate (the validator is mutable; D-011) |
| `worker_retries`, `escalations`, `architect_calls` | thrash | diagnostic |

Only `regressions` and `planted_bug_caught` are truly un-gameable (the optimizer can't touch the repo's own tests or the planted defect). Pass-count is produced by the mutable validator, so it is deliberately demoted to a watched stat — see D-011.

**B. The frozen Opus 4.8 judge** (extra-high thinking) is **the reward**. It reads the *distilled* trace (③b) and scores three dimensions with **generic, judgment-based reasoning** — given the intent + project context + a definition of each dimension, it reasons and justifies rather than ticking a rigid 0–10 anchor table (leaning on the model's actual judgment; it drifts less than the weak models the "noisy judge" literature was built on). It emits a score per dimension + a written rationale (the rationale is the signal the proposer reflects on):

- **D1 — Intent & spec fidelity** *(primary)*: did the work achieve the high-level intent, and was the spec itself gappy/misspecified given the project? The layer the harness's own tests don't cover.
- **D2 — Code quality** *(subjective)*: clarity, minimality, convention-fit, no needless complexity/tech-debt.
- **D3 — Process correctness**: did each role behave well — incl. did the (mutable) validator catch real issues / not rubber-stamp. With pass-count out of the reward, this is a quality observation, not the anti-gaming linchpin.

`composite` is the judge's weighted aggregate. **Weights, model, sampling temperature, and rubric are all frozen for an optimization run** (alongside `rubric_hash`, D-016) — configurable only between runs. A and B combine only as **gates/tiebreakers at accept-time**, never as one scalar.

## The autonomous loop

Three tiers (D-005): **Frontier** (Pareto-non-dominated on train vectors; drives parent selection) → **Champion** (best on the **frozen dev-anchor**, subject to gates) → **Promotion target** = a dedicated gym harness's `promptOverrides` (immediate, autonomous — D-012). Variants are overlays; baseline always intact.

One cycle:

1. **Select parent** from the frontier (biased toward under-served task categories).
2. **Reflect & propose** (⑦): Opus reads the parent's worst-scoring train traces + judge rationales + the running changelog, emits a **prompt-only** diff (one/few roles) → `candidate`.
3. **Evaluate** candidate × train tasks → distilled traces, deterministic signals, judge scores.
4. **Gates — accept into frontier iff ALL hold:**
   - **Improvement**: train judge-composite ≥ parent + ε, **or** Pareto-expands. ε is **derived from measured variance** (D-013), not guessed.
   - **Dev-anchor no-regress**: on the **frozen** dev-anchor (apples-to-apples vs champion), aggregate ≥ champion − δ.
   - **No new regressions** + **probe-caught** (un-gameable deterministic gates).
   - **Cost guardrail**: mean cost ≤ baseline × `cost_ceiling`.
5. **Accept** → frontier (prune dominated); update champion if a new dev-anchor best; **immediately write the champion's overrides into the dedicated gym harness** (D-012). **Reject** → record diff + failing gate as a negative example.
6. Loop until budget spent / K cycles with no accept / human stop.

**Safety (D-006 as revised by D-012):**
- **Judge running-changelog** (augmentation): per-cycle entry anchored to hard numbers (dev-anchor Δ, cost Δ, probe status) + narrative, fed into proposer + judge context. Avoids dead-ends + detects oscillation.
- **Arithmetic circuit-breaker** (the real safety net): track the dedicated harness's **dev-anchor** aggregate (frozen set ⇒ valid comparison) vs `baseline-of-record`; on drift below threshold, **auto-revert the harness's overrides to last-known-good** (a cheap config rewrite, not a fleet-racing git revert) + flag.
- **Monitor-set alarm**: if the dev-anchor keeps climbing while the fresh `monitor` set stalls, that is overfitting-to-anchor → flag / pause / refresh anchor.
- **Real-anchor correlation** (D-014): periodically score the champion on the fixed real-feature set; if gym score rises but real-anchor doesn't move, the loop is optimizing a proxy — surface it.

## Data model (new `harness_gym` PG schema)

| Table | Holds | Note |
| --- | --- | --- |
| `gym_tasks` | `{pool: train/dev-anchor/monitor/probe/real-anchor, repo_url, repo_commit, spec, intent, planted_bug?, generated_by}` | task defs |
| `gym_variants` | `{parent_id, label, prompt_overrides(jsonb), diff_from_parent, proposer_rationale, status}` | overlay lineage |
| `gym_runs` | `{variant_id, task_id, cycle, terminal_state, deterministic_signals(jsonb), trace_ref, distilled_ref}` | trace bundles stored as **files** (high-volume-log exception) + retention; PG holds refs |
| `gym_scores` | `{run_id, judge_model, rubric_hash, judge_temp, weights, d1, d2, d3, composite, rationale}` | re-judge-from-cache keyed on rubric_hash |
| `gym_cycles` | `{parent_id, candidate_id, decision, gate_results(jsonb), budget_spent}` | loop audit trail |
| `gym_runs_params` | `{run_id, harness_commit, substrate_commit, mutable_roles, judge_model, judge_temp, weights, rubric_hash}` | the frozen run-params that make variants comparable (D-016) |

## Reuse map

- **`promptOverrides.<role>` harness config → both the variant overlay AND the promotion target** (D-012 writes the champion here for one dedicated harness).
- Isolated harness instances (own DB/ports) + git worktrees → the hermetic, headless runner.
- `.jsonl` run logs + status API → deterministic signals + trace collector.
- `llm-testing-framework` judge + cached-transcript re-eval → the judge + re-judge-from-cache.

## Risks & mitigations

- **Judge noise / unquantified variance** → P-014 measures per-run SD of the judge composite; ε/δ/min-n derived from it; repeats (P-025) promoted to v1 if 1-run is too noisy.
- **Optimizer overfits the frozen judge** (independent of model smartness — the optimizer is adversarial and hunts blind spots) → fresh `monitor` set + `real-anchor` correlation + frozen `dev-anchor` for honest comparison.
- **Proxy ≠ reality** → the `real-anchor` falsifiability check (D-014).
- **Correlated Opus bias** (generator plants gaps the judge rewards finding) → generator model ≠ judge model (D-015).
- **Comparison drift on the shared tree** → pin BOTH substrate and harness-under-test commits per run (D-016).
- **Cost** → instrument $/run; P-014 produces a $/cycle + $/converged-run estimate before the loop is built.
- **Trace too big for context** → distillation step (③b) — itself a noise source, validated in P-029.

## Phase 0 — Hermetic runner

- **P-001** `done` Hermetic runner: given `(repo@commit, spec, variant overlay)`, spin an isolated **headless backend-only** harness instance (operator-sidecar + orchestrator/DBOS + PG per instance; no Tauri/Xvfb) on a throwaway clone and run the real scoper→…→curator pipeline. **Pin both the substrate commit AND the harness-under-test commit.** State the minimal bootable unit. importance: high (DONE 2026-06-02: validated END-TO-END with ZERO LLM via `lib/gym/smoke.ts` — full fake-agent pipeline (25 runs, worker commits) → workflow SUCCESS + terminal feature status + clean teardown. Keystone bug fixed (commit `7eb79a46d`): the worker subprocess's `pg-bootstrap` reads `PAPERCUSP_DATABASE_URL` (not `DATABASE_URL`), so it connected to the LIVE dev DB → `UPDATE harness_features` 42P01; boot-spec + harness-invoke-once now pin `PAPERCUSP_DATABASE_URL` to the gym PG. NOTE: plan per-item `todo` markers below are STALE — P-002–P-030 logic is code-built + unit-tested; the real-LLM validation is concentrated at the P-014 human gate.)
- **P-002** `todo` Trace collector: capture terminal_state, attempts/retries/escalations, the diff, full per-role transcript, cost/tokens/wall-clock; store trace bundles as **files** (+ retention), PG holds refs. blocked-by: P-001
- **P-003** `todo` Deterministic signals: regressions (repo's own tests pre/post), `planted_bug_caught`, cost; pass-count recorded as observability only. blocked-by: P-002
- **P-004** `todo` Parallel isolation: run N `(task×variant)` evaluations concurrently without port/DB/worktree collision. blocked-by: P-001
- **P-027** `todo` Cost instrumentation: per-run $/token accounting feeding a $/cycle + $/converged-run estimate. blocked-by: P-002

## Phase 1 — Task generator

- **P-005** `wip` Task generator (model ≠ judge model): intent-first, then a deliberately-realistic, mildly-underspecified spec so spec-gaps exist; grounded in a real substrate repo. importance: high (core built+unit-tested buildTaskGenPrompt/parseGeneratedTask/generateGymTask, generator≠judge guard D-015; real generation validated at P-014)
- **P-006** `todo` Planted-bug probe generator: spell out **where the planted bug lives and what the harness must do with it** so the gate is not vacuous (e.g. a pre-existing defect in the touched area the validator must catch). blocked-by: P-005
- **P-007** `todo` Task pools + filter: produce `train`, a **frozen `dev-anchor`** (fixed for the run), and a **fresh `monitor`** set (regenerated each cycle); drop tasks the baseline can't even attempt. blocked-by: P-005
- **P-028** `todo` Real-feature correlation anchor: a small **fixed** `real-anchor` set of real shipped features, scored but never optimized — the falsifiability check (D-014). importance: high

## Phase 2 — Judge + scoring

- **P-008** `wip` Frozen Opus judge: **generic, judgment-based** prompt (D1 intent+spec-gaps, D2 code quality, D3 process correctness); pin model + weights + **sampling temperature** + `rubric_hash`; emit per-dim scores + rationale. importance: high (core built+unit-tested rubric/rubricHash/composite/parse/prompt/judgeGymRun, opus-4-8+thinking plumbing; real opus-4-8 call validated at P-014)
- **P-029** `todo` Trace distillation: select/summarize a multi-hour multi-agent run into a judge-sized input; validate it as a noise source. blocked-by: P-002
- **P-009** `todo` Composite + gates: judge composite = reward; pass-count = observability; gates = dev-anchor no-regress + probe + no-new-regressions + cost. blocked-by: P-008, P-003
- **P-010** `todo` Re-judge-from-cache: re-score cached distilled traces on rubric change, no pipeline rerun. blocked-by: P-008
- **P-011** `todo` Judge tests: assert ranking **and absolute stability** (the circuit-breaker compares absolute aggregates over time). blocked-by: P-008

## Phase 3 — Experiment store + comparison

- **P-012** `done` PG schema `harness_gym`: gym_tasks (with pool), gym_variants, gym_runs, gym_scores, gym_cycles, gym_runs_params (frozen run-params). importance: high (harness_gym schema 6 tables + idempotent gym-PG-resident ensureGymSchema; 6 live-PG sentinel tests green)
- **P-013** `todo` Comparison read API: variant-A-vs-B per-task diff, frontier view, cycle history, real-anchor + monitor surfacing. blocked-by: P-012
- **P-014** `harness-ready-run-deferred` Milestone gate: review the spine (P0–3) on a real A/B; **measure judge-composite variance → derive ε/δ/min-n; produce the cost estimate; confirm real-anchor correlation** before building the loop. importance: urgent blocked-by: P-013, P-028 (2026-06-02 human said GO. Built+fake-validated the bounded A/B executor: `ab-runner.ts`/`ab-runner-real.ts`/`ab-run.ts` (+ repeat/variance support, meridian streaming fix `d352a68`). Fake-mode end-to-end AB-RUN OK ~20s, zero-LLM. REAL run = `GYM_AB_REPEATS=2 npx tsx lib/gym/ab-run.ts` (real agents + real opus judge). DEFERRED: shared Claude session is 429-rate-limited (cap probe timed out in retries); run on capacity / off-peak. The variance→ε/δ/min-n + cost + real-anchor correlation numbers come out of that real run.)

## Phase 4 — Proposer

- **P-015** `todo` Reflective proposer (**prompts-only in v1**): reads worst train traces + judge rationales + changelog, emits a prompt diff → candidate. blocked-by: P-014
- **P-016** `todo` Variant overlay model: `{promptOverrides}`; models/orchestration params reserved (not mutated in v1). blocked-by: P-012
- **P-017** `todo` Judge running-changelog: per-cycle entry anchored to hard numbers (dev-anchor Δ, cost Δ, probe status) + narrative. blocked-by: P-015

## Phase 5 — Autonomous loop

- **P-018** `todo` Accept/reject gate engine: judge improvement+margin OR Pareto-expand; dev-anchor no-regress; probe; no-new-regressions; cost. blocked-by: P-009, P-015
- **P-019** `todo` Three-tier state: frontier (train vectors) + champion (dev-anchor best) + dedicated-harness promotion target. blocked-by: P-018
- **P-020** `todo` Immediate promotion: write champion overrides into the **dedicated gym harness's config** (D-012); never the shared default prompt files. blocked-by: P-019
- **P-021** `todo` Circuit-breaker + monitor alarm: dev-anchor drift vs baseline-of-record → auto-revert the harness override; monitor-set stall while dev-anchor climbs → overfitting flag. blocked-by: P-020
- **P-022** `todo` Continuous loop driver: `gym optimize --repo R --budget $X` — propose→evaluate→gate→accept/rollback→frontier, budget-capped, unattended. blocked-by: P-018, P-019
- **P-023** `signed-off` Opt-in sign-off: human approval before pointing a **real production harness** at the gym champion (the gym's own harness is promoted unattended). importance: urgent blocked-by: P-022 (DONE 2026-06-02: gate built+tested — `optin.ts` `assertProductionOptIn`; human (avi) GRANTED sign-off authority. The concrete `ChampionOptIn{approvedBy:'avi', championVariantId, targetHarnessSlug, approvedAt}` is instantiated at actual champion-promotion time once P-014 yields a champion + a prod target is chosen. No production harness exists today (CLAUDE.md), so nothing is repointed now; the gate stays closed until that concrete opt-in is recorded.)

## Phase 6 — Later

- **P-024** `mockup-done` nuqs operator dashboard for variants/scores/frontier/cycles. importance: low blocked-by: P-013 (mockup + designer brief + nuqs/data-binding spec at `apps/operator/lib/gym/DASHBOARD-MOCKUP.md` 2026-06-02; data layer ready in `read-api.ts`. Implementation deferred until scheduled — visual craft → designer; conceptually post-P-014 go/no-go.)
- **P-025** `todo` Repeats-per-task / variance handling — promote into v1 if P-014 shows 1-run is too noisy. importance: normal
- **P-026** `todo` Expand real-feature replay as a *training* source (beyond the P-028 anchor). importance: low
- **P-030** `todo` Grader-optimization phase: optimize validator/crosscheck/tester in a **separate run with an inverted objective** (recall on held-out planted defects — catch *more*, never fewer), external judge as arbiter. importance: low

## Decisions

### D-001 — The judge sits ABOVE the harness's own gate
Date: 2026-06-02
Functional pass/fail against the literal spec is already the harness's job (validator/tester). If a run doesn't meet the strict spec, that's a bug in *that* layer, not something the gym judge re-litigates. So Opus judges what the harness can't check itself: high-level intent achievement, spec gaps/misspecification given the project, subjective code quality, and process correctness.

### D-002 — Rubric: three judge dimensions, cost excluded
Date: 2026-06-02
Judge dims = D1 intent & spec fidelity (primary), D2 code quality (subjective), D3 process correctness. Cost is computed deterministically and compared by us as a side metric + guardrail; never fed to the judge. *Refined by D-011:* pass-count is demoted from any reward, the judge composite is the sole reward, and the judge reasons generically rather than against a rigid anchor table; weights are frozen per run (D-016).

### D-003 — Anti-gaming: freeze ONLY the judge
Date: 2026-06-02
The external Opus judge is the only grader of record, so the optimizer may mutate every `AGENT_ROLES` role (incl. validator). *Reaffirmed after review round 1:* the review showed the anti-gaming firewall (probe + D3) is thinner than first claimed, but the right fix is to remove the *incentive* to weaken the validator — pass-count is no longer a reward (D-011) — not to freeze the validator. Weakening a mutable validator now only lets junk through, which the judge scores low. Producer roles and the validator all stay mutable; only the judge (model+weights+temp+rubric) is frozen.

### D-004 — Synthetic tasks, intent-first, grounded in real repos
Date: 2026-06-02
Benchmark tasks are synthetically generated against real repos. Generate the high-level intent first, then derive a deliberately-realistic, mildly-underspecified spec, so spec-gap detection (D1) has something to find. *Refined by D-013 (the train/dev-anchor/monitor pool split) and D-014 (a fixed real-feature anchor added to v1 as a falsifiability check).*

### D-005 — Three tiers: frontier / champion / promotion target
Date: 2026-06-02
Pareto frontier (non-dominated on train vectors) drives parent selection so diversity isn't collapsed. Champion = single best on the held-out set, subject to gates. *Promotion tier revised by D-012:* the third tier is a dedicated harness's overrides, not the shared default prompt files; and "held-out" is specifically the frozen `dev-anchor` pool (D-013) so champion comparison is apples-to-apples.

### D-006 — Immediate canonical promotion + judge changelog + arithmetic circuit-breaker
Date: 2026-06-02
*Superseded by D-012.* Original intent — promote champions immediately and unattended, with a judge running-changelog (smarter search) and a deterministic circuit-breaker (the real safety net) — is kept. What changed: the promotion *target* is no longer the shared canonical prompt files (that collides with the live fleet on the shared `main` tree); it is a dedicated harness's `promptOverrides` (D-012).

### D-007 — Borrow GEPA's ideas, don't adopt the framework
Date: 2026-06-02
Reimplement GEPA's two load-bearing mechanisms — reflective mutation and the Pareto frontier — against our own evaluable-unit. Don't adopt DSPy/GEPA: it optimizes pipelines of single cheap LLM calls, whereas one evaluation here is an entire multi-hour, worktree-isolated, multi-agent run.

### D-008 — Small & fast scale for v1
Date: 2026-06-02
~15 train + a small dev-anchor + a few probes + a real-anchor, 1 run each, 1 candidate/cycle, parallelized. *Refined by D-013:* per-task signal is noisy and 1-run may be insufficient — accept thresholds (ε/δ) are derived from variance measured at P-014, not guessed, and repeats-per-task (P-025) is promoted into v1 if that measurement shows 1-run is too noisy.

### D-009 — Substrate = throwaway clones at pinned commits
Date: 2026-06-02
The runner operates on throwaway clones at pinned commits in an isolated scratch dir, never the user's live working trees. *Refined by D-015 (the task generator runs on a model distinct from the judge) and D-016 (pin the harness-under-test commit too, not just the substrate).*

### D-010 — Variant = overlay config, never in-place prompt edits
Date: 2026-06-02
A variant is a prompt-override overlay object in PG; canonical prompt files are never mutated. Every non-promotion operation is cheap and reversible, and the baseline stays intact as the measuring stick. (Promotion itself, per D-012, writes only to a dedicated harness's override config — still not the shared default files.)

### D-011 — Pass-count is observability, not a reward; the judge is the reward
Date: 2026-06-02
"How many features passed" is produced by the mutable validator and is therefore gameable (a lenient validator passes more). Rather than freeze the validator, we remove the incentive: **pass-count is demoted to a watched stat and is not part of the optimization signal.** The frozen Opus 4.8 judge's holistic scores (intent, code quality, process) are the sole reward — and the judge uses **generic, judgment-based reasoning** (intent + context + dimension definitions), not a rigid checkbox rubric, because a frontier model's judgment is more reliable and lower-drift than the weak-model era the "noisy judge" caution came from. Deterministic `regressions` + `planted_bug_caught` remain as cheap un-gameable guardrails/monitors, not targets. (Decided by avi, 2026-06-02, overriding the freeze-the-validator option.)

### D-012 — Promotion writes to a dedicated harness's overrides, not the shared default files (supersedes D-006)
Date: 2026-06-02
The canonical default prompt files are shared live-fleet state on the same `main` tree every concurrent agent uses; an autonomous git-commit to them collides with the lock/coord discipline and the circuit-breaker's auto-revert would race other agents. Instead, reuse the existing per-harness `promptOverrides` mechanism: **immediate, autonomous promotion writes the champion overrides into one dedicated gym harness's config.** That harness runs the optimized prompts; the global defaults and the rest of the fleet are untouched; the circuit-breaker's revert is a cheap config rewrite. The human gate (P-023) moves to the *opt-in* step — a human pointing a real production harness at the champion. (Decided by avi, 2026-06-02.)

### D-013 — Three task pools + variance-derived gate thresholds
Date: 2026-06-02
A single "fresh held-out each cycle" set cannot serve both overfitting-defense (wants fresh tasks) and regression-detection (wants a fixed anchor) — comparing scores across different task draws conflates variant effect with luck of the draw. So: `train` (drives the proposer), a **frozen `dev-anchor`** held fixed for the whole run (champion comparison + circuit-breaker are apples-to-apples), and a **fresh `monitor`** set regenerated each cycle that never feeds an accept decision (it only alarms when the dev-anchor climbs while the monitor stalls — the signature of overfitting *to the anchor*). The system is doubly-stochastic (pipeline + judge), so accept thresholds ε/δ and a minimum task/repeat count are **derived from variance measured at P-014**, not guessed. (Resolves review #1 + #2.)

### D-014 — A fixed real-feature correlation anchor in v1
Date: 2026-06-02
Without any tie to reality the headline metric is unfalsifiable — the loop could "improve 20%" on an Opus-judged proxy and mean nothing. v1 includes a small **fixed** set of real shipped features (`real-anchor`) that is **scored but never optimized**: a non-training falsifiability check answering "does gym score move with real-feature success?" If gym score rises while the real-anchor doesn't, the loop is surfaced as optimizing a proxy. (Resolves review #6; pulls a slice of P-026 forward.)

### D-015 — v1 mutates prompts only; generator model decorrelated from the judge
Date: 2026-06-02
The variant schema carries `promptOverrides`, `models`, and orchestration params, but the v1 proposer's action space is **prompt overrides only** — model swaps and orchestration-param mutation (routing/attempt thresholds, competition N, chunk size, crosscheck on/off) are enumerated and deferred to a later phase. Separately, to avoid correlated bias (a spec-gap the Opus generator plants is one the Opus judge is primed to reward finding), the **task generator runs on a model distinct from the judge model.** (Resolves review #5 + #7.)

### D-016 — Reproducibility pins: harness commit + judge weights + judge temperature
Date: 2026-06-02
A variant = (harness-under-test code + prompt overlay); if harness code on the shared `main` tree shifts mid-run, comparisons drift — so each run **pins the harness-under-test commit** as well as the substrate commit (D-009). The circuit-breaker compares absolute aggregates over time, so the **judge's sampling temperature** must be pinned (and stated), and the **rubric weights frozen** alongside `rubric_hash`, for the duration of an optimization run. All frozen run-params live in `gym_runs_params`. (Resolves the review's pin-version / freeze-weights / pin-temp points.)

### D-017 — Trace distillation + file storage + a cost model
Date: 2026-06-02
A full multi-hour multi-agent transcript doesn't fit the judge's context even at 1M tokens, so a **distillation step** (③b) selects/summarizes each run into a judge-sized input — itself a noise source, validated in P-029. Trace bundles are stored as **files** with a retention policy (the storage policy's high-volume-log exception), with PG holding refs. The economics are non-trivial (~tens of full pipeline runs/cycle + Opus judge/proposer/generator), so a **$/cycle + $/converged-run estimate** is a required P-014 deliverable before the loop is built. (Resolves review #8 + trace-storage.)

### D-018 — Runner isolation = one dedicated pinned gym-operator instance (Option A)
Date: 2026-06-02
Date: 2026-06-02. Decided by avi after a three-way comparison.

P-001's "minimal bootable unit" is **one dedicated gym-operator instance** — a single extra operator+DBOS process booted from a PINNED papercup checkout (a git worktree/clone parked at a fixed, recorded SHA, NOT the live `main`, which concurrent agents commit to constantly), with its **own PG database** and **own port**, and DBOS autoloop **scoped to gym harnesses only** (`PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES`). This instance is **reused across runs**; each `(task×variant)` run = throwaway substrate clone@pinned-commit (D-009) + a throwaway harness (its own `harness_<slug>` schema in the gym PG) + `setPromptOverride` of the variant + a filed synthetic feature + pipeline-to-terminal + capture + teardown.

Why not the alternatives:
- **Reuse the live :3070 operator** — rejected: cannot pin the harness-under-test commit (it's whatever `main` HEAD is, which drifts mid-A/B), pollutes the live PG with gym schemas/runs, and lets the live autoloop/fleet interfere with gym runs. Conflicts with D-016 and the "never touch the live fleet/PG" non-goal; a migration dead-end.
- **Fresh operator+PG per run** ("literal PG per instance") — deferred: maximal hermeticity but pays N× cold-starts plus a per-run port allocator and per-run embedded-PG lifecycle (neither exists today). Run-level isolation is already provided by separate `harness_<slug>` schemas + separate substrate clones, so there is no measured need yet. Option A is a strict subset — we can layer per-run instances on top later if P-014's variance numbers demand it.

This satisfies D-016 (the pinned checkout's SHA is recorded as `gym_runs_params.harness_commit`; no drift for the duration of an optimization run) and D-009 (substrate = throwaway clones at pinned commits), at the lowest viable build/runtime cost. "PG per instance" in the data-model prose is read as a dedicated gym PG *database*, not one PG per run (all `gym_*` tables live in a single `harness_gym` schema). Gym code lives under `apps/operator/lib/gym/` (paralleling the reused `apps/operator/lib/llm-testing/`).
Related: P-001, P-004, P-012

### D-019 — Unattended autonomous build — bounded real spend + fake-agent-first validation
Date: 2026-06-02
Date: 2026-06-02. avi put the implementing agent on an overnight loop to complete + test EVERY plan item, explicitly authorizing judgment calls ("I trust your judgement"). Policy the agent adopts for safe unattended operation:

1. **Build + TDD all items' code** — the bulk of "complete and tested" is achievable with zero real LLM spend.
2. **Fake-agent-first:** validate the full runner→capture→signals→judge plumbing end-to-end with a DETERMINISTIC stub agent (no LLM spend, fast, no multi-hour waits) before any real pipeline run. This stub is itself a committed test artifact.
3. **Bounded real runs:** a minimal real smoke (1 task × 1 variant × 1 opus-4-8 judge call) to obtain cost-per-run + cost-per-judge numbers and confirm real integration; then a SMALL real A/B (≤2 variants × ≤3 tasks, 1 run each) for the P-014 judge-variance measurement — only if the smoke's cost/wall-clock is sane (soft caps; if a single pipeline run is excessively costly/slow, scale down to fake-agent validation + document).
4. **Loop runs capped:** P-022 autonomous loop is exercised only under a hard budget cap / few cycles to prove it works, NOT an unbounded overnight optimization. Honors the plan's own "cost estimate before the loop" gate (P-014 / D-017).
5. **Human gates (P-014, P-023):** the agent PRODUCES all deliverables + makes the threshold judgment calls itself and documents them for morning review. But it does NOT point any real production harness at the champion (P-023's outward action) — that stays for explicit human opt-in; and there is no production anyway (CLAUDE.md). The gym's own dedicated harness is promoted unattended per D-012.
6. **Don't disrupt the sleeping user's environment:** the gym-operator is isolated (separate PG database + port + scoped autoloop, D-018); the live :3070 fleet is never restarted or touched; scratch clones + the gym DB + spawned processes are torn down; a free high port is chosen.
Related: P-014, P-022, P-023
