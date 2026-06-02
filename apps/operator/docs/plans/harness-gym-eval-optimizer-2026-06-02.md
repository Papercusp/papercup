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

**State:** Design locked via brainstorming (2026-06-02). All keystone decisions ratified (D-001–D-010); no code yet. The system runs the Papercusp harness's own pipeline on synthetic feature tasks, scores the result with a frozen Opus 4.8 judge that grades the layer the harness *can't* check itself, compares prompt/orchestration variants on equal footing, and closes a fully-autonomous propose→apply→rerun→keep-if-better loop (GEPA-style reflective mutation + Pareto frontier). Build order is **measurement-spine-first** (Phase 0–3 are usable manually for A/B before any optimizer exists), then the autonomous loop (Phase 4–5).

**Next:** Human (avi) reviews this spec; on approval an agent picks up **P-001** (Phase 0 hermetic runner — the riskiest infra, proven first).

## Background

Papercusp can already *judge a single feature internally* (the `validator` + `crosscheck` roles do evidence-based pass/fail against `VAL-###` acceptance criteria; `competition` mode already scores N workers on one feature; the `curator` dedups issues) and already *captures telemetry* (cost, tokens, attempts, pass/fail in `harness_features` + `.jsonl` run logs + the status API). Two adjacent frameworks shipped: `llm-testing-framework-2026-05-14` (a judge + cached-transcript re-evaluation + `ChatTarget`, but aimed at *chat surfaces* over HTTP/SSE, not the feature pipeline) and `su-scenario-suite-2026-05-31` (behavioral prompt testing with a sim-user + *deterministic asserts + LLM judge*, with the hard-won lesson: **don't lean on the judge alone — it's noisy**). Prompts are already swappable per-run via `promptOverrides.<role>` + per-role `models.<role>` in harness config, loaded per-launch.

**The gap:** nothing runs the *whole pipeline* on a benchmark of features, scores the *resulting work*, compares prompt/orchestration *variants* on equal footing, and closes a *propose→apply→rerun* improvement loop. This plan builds that — a **"harness gym"**: an eval-driven optimizer for the harness itself (the coding-agent analogue of DSPy/GEPA).

## Goals / Non-goals

**Goals**
- Run the real multi-agent pipeline on reproducible synthetic feature tasks, hermetically and in parallel.
- Score each run on the dimensions the harness *cannot self-check*: high-level intent achievement, spec gaps/misspecification given the project, subjective code quality, and process correctness — via a frozen Opus 4.8 judge.
- Track cost/tokens/wall-clock deterministically as a side metric + guardrail (never fed to the judge).
- Compare variants (`{promptOverrides, orchestration params, models}`) on equal footing, with per-task breakdowns and a Pareto frontier.
- Close a **fully autonomous** loop: judge-driven reflective proposal → apply as overlay → rerun → keep-if-better → immediate canonical promotion, with deterministic safety gates + circuit-breaker.

**Non-goals**
- Re-checking the literal functional spec the harness's own validator/tester already enforces. If a run fails the strict spec, that is a bug in *that* layer, not something the gym's judge re-litigates.
- Optimizing for cost inside the judge (cost is deterministic and compared by us).
- Driving any UI; this evaluates the backend pipeline only.
- Adopting DSPy/GEPA as a framework (we borrow two of its ideas — see D-007).

## Core concepts

- **Task** — a synthetic feature request `{repo@pinned-commit, spec, intent, planted_bug?}`. `kind` ∈ `train | held_out | probe`. Generated intent-first, then a deliberately-realistic (mildly underspecified) spec, so spec-gaps exist to find.
- **Variant** — the unit the optimizer mutates and you A/B: `{ promptOverrides per role, orchestration params, models per role }`. A versioned overlay config — **never an in-place edit of the canonical prompt files** (D-010).
- **Run** — one `(variant × task)` execution of the full pipeline, hermetic. Produces deterministic signals + a cached trace.
- **Trace** — the full record the judge reads: terminal state, attempts, the diff, every role transcript, tests written, cost/tokens.
- **Score** — frozen Opus judge output: three dimensions + rationale (§ Scoring rubric).
- **Frontier / Champion / Canonical** — three tiers of state (D-005): the Pareto frontier (drives parent selection), the single champion (held-out best, the deploy candidate), and canonical (the live prompt files).

## Architecture

```
                          ┌─────────────────────────────────────────────┐
                          │              HARNESS GYM (new)                │
                          └─────────────────────────────────────────────┘

  ① TASK GENERATOR ────────► synthetic feature task
     (Opus, grounded in       { repo@pinned-commit, spec, intent,
      a real repo)              optional planted-bug }
                                    │
                                    ▼
  ② RUNNER / ISOLATION ──► spins an isolated harness instance per (task × variant)
     (worktree + own DB/        runs the REAL pipeline: scoper→…→curator
      ports, hermetic)          applying VARIANT's promptOverrides+models
                                    │
                                    ▼
  ③ TRACE COLLECTOR ──────► { terminal state, attempts, tests written,
     (reuses .jsonl + PG)       diff, full role transcript, cost, tokens }
                                    │
                        ┌───────────┴───────────┐
                        ▼                        ▼
  ④ DETERMINISTIC SIGNALS          ⑤ OPUS JUDGE (frozen)
     reached-pass? cost?              scores 3 dims on the TRACE:
     planted-bug caught?             intent+spec-gaps · code-quality ·
     regressions? (un-gameable)       process-correctness → composite
                        └───────────┬───────────┘
                                    ▼
  ⑥ EXPERIMENT STORE (PG) ─► variant × task → {score breakdown, signals}
                                    │   (the comparison/dashboard surface)
                                    ▼
  ⑦ OPUS PROPOSER ────────► reads worst-scoring traces + breakdown,
     (reflective mutation)     emits targeted prompt diffs for specific
                                roles → candidate VARIANT
                                    │
                                    ▼
  ⑧ ACCEPT / ROLLBACK ────► rerun benchmark on candidate; keep on Pareto
     (the autonomous gate)     frontier iff train↑ AND held-out no-regress
                                AND probe-caught AND cost-ok; else rollback
```

The **evaluable unit** is "one full harness run on one synthetic task." The left column (①–⑥) is the **measurement spine** — usable *manually* to A/B two prompt sets before ⑦–⑧ exist (also the safe build order).

## Scoring rubric

A `(variant × task)` evaluation yields **two independent kinds of signal that never merge into one number** — this separation is what stops "buy a higher judge score with 5× the cost or a weakened validator" from ever looking like a win.

**A. Deterministic signals** (computed, never judged, un-gameable):

| Signal | Meaning | Role |
| --- | --- | --- |
| `terminal_state` | passed / escalated / timed-out / cost-capped | success-rate gate |
| `worker_retries`, `escalations`, `architect_calls` | thrash to get there | efficiency context |
| `cost_usd`, `tokens`, `wall_clock_s` | deterministic cost metric | guardrail + tiebreaker |
| `regressions` | did the diff break previously-passing repo tests? | gate |
| `planted_bug_caught` | (probe tasks) did the harness's own validator flag the injected defect? | **anti-gaming backstop** |

**B. The frozen Opus 4.8 judge** (extra-high thinking) scores the *trace*, three dimensions, 0–10 each with explicit rubric anchors + a written rationale (the anchors cut judge variance; the rationale is the signal the proposer reflects on):

- **D1 — Intent & spec fidelity** *(primary)*: did the work achieve the high-level intent, and — given the rest of the project — was the spec itself gappy/misspecified? Penalizes literal-but-useless, missed implied requirements, broken unstated invariants. This is the "stress what the harness's own tests don't cover" layer.
- **D2 — Code quality** *(subjective, Opus's call)*: clarity, minimality, convention-fit, no needless complexity/tech-debt.
- **D3 — Process correctness**: did each role behave well — scoper chunked sensibly, worker didn't thrash, **validator caught real issues / didn't rubber-stamp**, architect diagnosed correctly, orchestrator routed efficiently. The judge must cite specific trace evidence. *This dimension is where a weakened internal grader gets penalized.*

`composite = 0.5·D1 + 0.2·D2 + 0.3·D3` (weights configurable; D1 dominant per the intent steer, D3 weighted real because it is the anti-gaming dimension). The judge never sees cost. Runs that didn't ship get D1/D2 floored (nothing to assess) but D3 still scored (was the failure handled/escalated well?); success-rate is enforced as an aggregate gate, not folded into per-run composite. A and B combine only as **gates/tiebreakers at accept-time** (§ Autonomous loop), never as one scalar.

## The autonomous loop

Three tiers of state (D-005): **Frontier** (Pareto-non-dominated on train task vectors; drives parent selection so diversity isn't collapsed) → **Champion** (single best by held-out aggregate, subject to all gates; the deploy candidate) → **Canonical** (the real prompt files; immediate promotion on champion update — D-006). Variants are **overlays**; baseline files always intact, so "rollback" = don't advance the pointer (nothing destructive).

One cycle:

1. **Select parent** from the frontier (biased toward under-served task categories).
2. **Reflect & propose** (⑦): Opus reads the parent's worst-scoring train traces + judge rationales + the running changelog, picks **one or few** role prompts to mutate, emits a diff + rationale → `candidate`.
3. **Evaluate** candidate × train tasks → traces, deterministic signals, judge scores.
4. **Gates — accept into frontier iff ALL hold:**
   - **Improvement**: train composite ≥ parent + ε (ε margin beats single-run noise), **or** Pareto-expands (best on ≥1 task, no large loss elsewhere).
   - **Held-out no-regress**: on a **fresh** held-out set (cheap synthetic generation ⇒ can't overfit the frozen judge), aggregate ≥ champion − δ.
   - **Probe**: still catches *all* planted-bug probes — deterministic hard reject otherwise. (The anti-gaming firewall: a variant that quietly weakened the validator dies here regardless of judge opinion.)
   - **Cost guardrail**: mean cost ≤ baseline × `cost_ceiling` (e.g. 1.5×).
5. **Accept** → add to frontier, prune dominated; update champion if a new held-out best; **immediately promote champion to canonical** (a git commit). **Reject** → record the diff + failing gate as a *negative example* the proposer avoids repeating.
6. Loop until budget spent / K cycles with no accept / human stop.

**Two safety mechanisms make immediate promotion safe (D-006):**
- **Judge running-changelog** (*augmentation, not the safety net*): a per-cycle entry **anchored to hard numbers** (held-out Δ, cost Δ, probe status) plus narrative, fed into proposer + judge context. Job: avoid dead-ends + detect non-stationarity/oscillation. Anchoring to numbers (not the judge's prose impressions) prevents self-reference poisoning.
- **Arithmetic circuit-breaker** (*the actual safety net*): keep a `baseline-of-record` held-out score; track canonical's held-out aggregate over a rolling window; if it drifts below baseline-of-record by more than a threshold, **auto-revert canonical to last-known-good + flag**. Deterministic, doesn't slow the loop, catches slow-Goodhart drift that no LLM self-summary reliably catches over noise.

## Data model (new `harness_gym` PG schema)

| Table | Holds | Note |
| --- | --- | --- |
| `gym_tasks` | `{kind, repo_url, repo_commit, spec, intent, planted_bug?, generated_by}` | synthetic task defs |
| `gym_variants` | `{parent_id, label, config(jsonb), diff_from_parent, proposer_rationale, status}` | optimizer lineage tree |
| `gym_runs` | `{variant_id, task_id, cycle, terminal_state, deterministic_signals(jsonb), trace_ref}` | one per `variant×task`; trace cached |
| `gym_scores` | `{run_id, judge_model, rubric_hash, d1, d2, d3, composite, rationale}` | **separate from runs** |
| `gym_cycles` | `{parent_id, candidate_id, decision, gate_results(jsonb), budget_spent}` | loop audit trail |

The `gym_runs` (cached trace) / `gym_scores` (references `rubric_hash`) split is deliberate — it reuses the `llm-testing-framework` "judge-only re-evaluation" trick: change the rubric → re-score cached traces cheaply without re-running the expensive pipeline.

## Reuse map

- `promptOverrides.<role>` + `models.<role>` harness config → the variant overlay mechanism (already exists).
- Isolated harness instances (own DB/ports, Xvfb/dedicated-port patterns) + git worktrees → the hermetic runner.
- `.jsonl` run logs + status API (cost/tokens/attempts) → deterministic signals + trace collector.
- `llm-testing-framework` judge + cached-transcript re-eval + `ChatTarget` → the judge + re-judge-from-cache.
- `competition` mode's scoring instincts → prior art for multi-variant comparison.

## Risks & mitigations

- **Judge noise at 1 run/task** → rubric anchors + accept only on a clear margin + held-out no-regress + tolerant judge tests (rank, don't pin exact scores).
- **Reward hacking / weakened internal grader** → D3 process-correctness penalty + deterministic probe gate + circuit-breaker; only the judge is frozen.
- **Overfitting the frozen judge** → fresh held-out tasks every cycle (synthetic makes this cheap).
- **Bad synthetic tasks pollute signal** → task-validation filter (drop tasks the baseline can't even attempt).
- **Runner isolation at scale** → bounded by "small & fast"; parallel isolated instances; never the live working tree (D-009).
- **Wall-clock honesty** → "small & fast" = few tasks + parallelism; one cycle is still tens-of-minutes-to-hours, not seconds.

## Phase 0 — Hermetic runner

- **P-001** `todo` Hermetic runner: given `(repo@commit, spec, variant config)`, spin an isolated harness instance (own DB/ports/worktree) on a throwaway clone and run the real scoper→…→curator pipeline applying the variant's `promptOverrides`+`models`. importance: high
- **P-002** `todo` Trace collector: capture terminal_state, attempts/retries/escalations, the diff, full per-role transcript, cost/tokens/wall-clock into a structured run record + a cached trace bundle. blocked-by: P-001
- **P-003** `todo` Deterministic signal computation: reached-pass, regressions (run the repo's existing tests pre/post), `planted_bug_caught` probe check. blocked-by: P-002
- **P-004** `todo` Parallel isolation: run N `(task×variant)` evaluations concurrently without port/DB/worktree collision. blocked-by: P-001

## Phase 1 — Task generator

- **P-005** `todo` Opus task generator: intent-first, then derive a deliberately-realistic (mildly underspecified) spec so spec-gaps exist to find; grounded in a real substrate repo. Emit `gym_tasks` rows. importance: high
- **P-006** `todo` Planted-bug probe generator: synthesize tasks carrying a known injected defect for the deterministic anti-gaming gate. blocked-by: P-005
- **P-007** `todo` Task validation/filtering + held-out generation: drop tasks the baseline can't even attempt; keep a stable train pool + a fresh-per-cycle held-out generator. blocked-by: P-005

## Phase 2 — Judge + scoring

- **P-008** `todo` Frozen Opus judge: rubric prompt (D1 intent+spec-gaps, D2 code quality, D3 process correctness) scoring the trace; structured per-dim scores + rationale; `rubric_hash` pinned. importance: high
- **P-009** `todo` Composite + gate computation: weighted composite (0.5/0.2/0.3), success-rate aggregate gate, cost guardrail, probe gate. blocked-by: P-008, P-003
- **P-010** `todo` Re-judge-from-cache: re-score cached traces when the rubric changes, no pipeline rerun. blocked-by: P-008
- **P-011** `todo` Judge ranking tests: pin cached traces with known good/bad outcomes; assert the judge *ranks* them correctly (tolerant ranges, not exact scores). blocked-by: P-008

## Phase 3 — Experiment store + comparison

- **P-012** `todo` PG schema `harness_gym`: gym_tasks, gym_variants, gym_runs, gym_scores, gym_cycles. importance: high
- **P-013** `todo` Comparison read API: variant-A-vs-B per-task score diff, frontier view, cycle history. blocked-by: P-012
- **P-014** `needs-human` Milestone gate: review the measurement spine (P0–3) on a real A/B (two prompt sets, scored) before building the autonomous loop. importance: urgent blocked-by: P-013

## Phase 4 — Proposer

- **P-015** `todo` Reflective proposer: Opus reads worst-scoring train traces + judge rationales, mutates one/few role prompts, emits diff + rationale → candidate variant. blocked-by: P-014
- **P-016** `todo` Variant overlay model: variant = `{promptOverrides, orchestration params, models}`; never edits canonical files in place. blocked-by: P-012
- **P-017** `todo` Judge running-changelog: per-cycle entry anchored to hard numbers (held-out Δ, cost Δ, probe status) + narrative, fed into proposer+judge context. blocked-by: P-015

## Phase 5 — Autonomous loop

- **P-018** `todo` Accept/reject gate engine: improvement+margin OR Pareto-expand; held-out no-regress; probe; cost guardrail. blocked-by: P-009, P-015
- **P-019** `todo` Three-tier state: Pareto frontier (parent selection) + champion (held-out best) + canonical pointer. blocked-by: P-018
- **P-020** `todo` Immediate canonical promotion: champion update commits to the real prompt files (git). blocked-by: P-019
- **P-021** `todo` Arithmetic circuit-breaker: rolling held-out drift vs baseline-of-record → auto-revert canonical to last-known-good + flag. blocked-by: P-020
- **P-022** `todo` Continuous loop driver: `gym optimize --repo R --budget $X` — propose→evaluate→gate→accept/rollback→frontier, budget-capped, unattended. blocked-by: P-018, P-019
- **P-023** `needs-human` Pre-autonomy sign-off: eyeball the first proposer outputs + dry-run the loop before enabling unattended canonical promotion. importance: urgent blocked-by: P-022

## Phase 6 — Later

- **P-024** `todo` nuqs operator dashboard for variants/scores/frontier/cycles. importance: low blocked-by: P-013
- **P-025** `todo` Repeats-per-task knob + variance handling (scale up from 1 run). importance: low
- **P-026** `todo` Real-feature *replay* tasks alongside synthetic. importance: low

## Decisions

### D-001 — The judge sits ABOVE the harness's own gate
Date: 2026-06-02
Functional pass/fail against the literal spec is already the harness's job (validator/tester). If a run doesn't meet the strict spec, that's a bug in *that* layer, not something the gym judge re-litigates. So Opus judges what the harness can't check itself: high-level intent achievement, spec gaps/misspecification given the project, subjective code quality, and process correctness. Stress the layer the harness's own features don't cover.

### D-002 — Rubric: three judge dimensions, cost excluded
Date: 2026-06-02
Judge dims = D1 intent & spec fidelity (primary, weight 0.5), D2 code quality (subjective, 0.2), D3 process correctness (0.3). Cost is computed deterministically and compared by us as a side metric + guardrail; it is never fed to the judge. Weights configurable.

### D-003 — Anti-gaming: freeze ONLY the judge; probes are the deterministic backstop
Date: 2026-06-02
The external Opus judge is the only grader of record, so the optimizer may mutate every `AGENT_ROLES` role (incl. validator). Weakening the internal validator doesn't raise the external score, and D3 actively penalizes a rubber-stamp. This holds only if the judge (a) scores the full trace, (b) is backed by un-gameable deterministic signals — reached-pass, cost, and **planted-bug probe tasks** the validator must catch — and (c) faces fresh held-out tasks each cycle. A frozen-but-blind judge rubber-stamps as easily as a lenient validator; the trace + probes + held-out are what make "the judge polices it" real.

### D-004 — Synthetic tasks, intent-first, grounded in real repos
Date: 2026-06-02
Benchmark tasks are synthetically generated against real repos as substrate (that's the "real-world data"). Generate the high-level intent first, then derive a deliberately-realistic, mildly-underspecified spec from it, so spec-gap detection (D1) has something to find. Fresh held-out tasks each cycle defend the frozen judge against overfitting. Real-feature replay is a later add (P-026), not v1.

### D-005 — Three tiers: frontier / champion / canonical
Date: 2026-06-02
Pareto frontier (non-dominated on train vectors) drives parent selection so diversity isn't collapsed (a variant best only on one task category survives). Champion = single best by held-out aggregate subject to all gates = the deploy candidate. Canonical = the live prompt files. This gives GEPA's exploration diversity without losing a single deployable answer.

### D-006 — Immediate canonical promotion + judge changelog + arithmetic circuit-breaker
Date: 2026-06-02
Champion updates promote to canonical immediately (the speed win; pre-alpha + git-reversible makes the downside cheap). Safe because what promotes already cleared four gates. The judge-written running-changelog (anchored to hard numbers) makes the *search* smarter (avoids dead-ends, detects oscillation) but is an augmentation, NOT the safety net. The load-bearing safety is a deterministic circuit-breaker: rolling held-out drift below baseline-of-record auto-reverts canonical to last-known-good. Trivially flippable to a sustained-win bar or manual promotion if churn proves bad.

### D-007 — Borrow GEPA's ideas, don't adopt the framework
Date: 2026-06-02
We reimplement GEPA's two load-bearing mechanisms — reflective mutation (LLM reads the trace, diagnoses, rewrites one prompt) and the Pareto frontier (keep candidates each best on ≥1 task, sample parents from the set) — against our own evaluable-unit. We do NOT adopt DSPy/GEPA: it optimizes pipelines of single cheap LLM calls, whereas one evaluation here is an entire multi-hour, worktree-isolated, multi-agent run. The impedance mismatch (cost, isolation, statefulness) is severe.

### D-008 — Small & fast scale for v1
Date: 2026-06-02
~15 train + ~5 fresh held-out + ~3 probes, 1 run each, 1 candidate/cycle ≈ ~23 full pipeline runs/cycle, parallelized. Fast iteration to prove the loop; per-task signal is noisy, so v1 accepts only on a clear aggregate train improvement AND no held-out regression. Repeats-per-task is a deferred knob (P-025).

### D-009 — Substrate = throwaway clones at pinned commits
Date: 2026-06-02
The runner operates on throwaway clones at pinned commits in an isolated scratch dir, never the user's live working trees. Proposer + task-generator both run on Opus.

### D-010 — Variant = overlay config, never in-place prompt edits
Date: 2026-06-02
A variant is a `{promptOverrides, orchestration params, models}` overlay object in PG; the canonical prompt files are mutated only by the explicit promotion step (D-006). This makes every non-promotion operation cheap and reversible, and keeps the baseline always intact as the measuring stick.
