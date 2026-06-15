# Papercusp impartial benchmark suite — reproducer

> **What this is.** The clone-and-run reproducer for the Papercusp impartial benchmark
> suite: how to re-execute every result we publish, from public task set to official
> grader to scored report. The *why* — the fairness protocol, the layer model, the
> baselines, contamination handling — is the
> **[methodology doc](../apps/operator-docs/src/content/docs/benchmarks/methodology.mdx)**
> (served at `/internal/docs/benchmarks/methodology`). This README is the *how*.

> ⚠️ **Draft — numbers pending the pilots.** The protocol and commands below are real;
> published *results* do not exist until the pilots run (`P-009` per-task floor;
> `P-032` hive-backlog layer) and the owner signs off (`P-017`). Items that depend on
> peer-owned code still shipping are marked **[provisional — confirm against code]**.

> 🐝 **What we benchmark (D-010): the Hive, not the per-task harness.** The subject is
> the **Queen + bee fleet** draining a whole backlog. The per-task `coding` run is the
> **L1 competence floor** and the atomic unit the fleet places. The **headline baseline
> is the Queen-ablated fleet** (same fleet, naive FIFO scheduler) — *not* the native
> harness, which is now the serial floor.

---

## The one invariant

**Generation is arm-specific; grading is byte-for-byte identical across arms.** Every
arm reduces its per-task work to the *same* submission shape and is graded by the
*same* official grader at the *same* pinned version. Change the grader for one arm and
the comparison is void. Preserve this when you re-run.

---

## What gets measured — five layers, two pilots

| Layer | Metric | Headline comparison | Pilot |
|---|---|---|---|
| **L1 competence** | pass@1 (≥3 seeds, CIs) | papercusp spine vs native / ablation / best-of-N | `P-009` |
| **L2 throughput** | tasks/\$, wall-clock speedup, drain time, autonomy | Hive vs Queen-ablated fleet | `P-032` |
| **L3 value-capture** | \$ captured under fixed budget | Hive vs Queen-ablated fleet | `P-032` |
| **L4 coordination** | MAST duplication / breakdown / misalignment rates | Hive vs published MAS baseline + competitors | `P-032` |
| **L5 long-horizon** | multi-step sequencing | Hive vs Queen-ablated fleet | follow-on |

---

## Prerequisites

- **Docker** (≥ 29.x) — for M1 (SWE-bench Pro / SWE-Lancer) and M2 (Terminal-Bench / Harbor).
- **Disk** — per-instance grader images are GB-scale (~50 images for a 50-task pilot).
  Use a **dedicated scratch volume**, prune between families, and grade on a **dedicated
  host/volume**, never inline with the fleet dev box.
- **`uv`** — for Terminal-Bench / Harbor (M2).
- **A model credential** — the *same* model id for every arm (the controlled variable).
- **The Papercusp tree on `staging`**, operator running. Generation runs on normal
  fleet infra; grading is decoupled.

---

## Layout (canonical — owned by `P-010`, migration `291`)

PG is canonical; the files below are the **publication export**.

```
benchmarks/
├── README.md                      ← this file
├── preregistrations/<run_id>.json ← run config committed to git BEFORE the run (tune-to-test firewall)
├── rollouts/<run_id>/<arm>/<suite>__<task_id>__seed-<n>.json   ← Rollout Cards (the published repro unit)
└── runs/<run_id>/manifest.json    ← per-run manifest
```

Three PG tables back this (`benchmark_run_result`, `benchmark_rollout`,
`benchmark_prereg`). `verifyPreregistration()` checks that each run-result row's
`prereg_hash` matches a prereg row whose git commit **predates** the rollouts.

---

## Reproduce a result in five steps

1. **Check out the pre-registered config** (`benchmarks/preregistrations/<run_id>.json`).
   It pins the suite + split, the arm, the model id + sampling params, the budget, the
   seed list, and the exact `grader_family` + `grader_version`. **Do not edit it** —
   pre-registration is what makes "we did not tune to the test" checkable.

2. **Generate** — run each arm (L1 per-task, or the fleet driver for L2–L5) under the
   budget. Each per-task unit emits the same submission record (M1: `{ instance_id,
   patch, prefix }`, `prefix` = seed). See [the arms](#the-arms).

3. **Grade** — hand every arm's submissions to the *same* `OfficialGrader`. See
   [grading](#grading).

4. **Emit + score** — every runner calls the single emit entry point
   `emitRollout(input)` (writes the run-result row + Rollout Card in one tx, derives
   `cost_usd`); then `buildSuiteReport(rows)` from `@papercusp/bench-metrics` computes
   pass@1 + CIs + the cost/accuracy Pareto (and, at L2–L5, throughput / value / MAST
   rates).

5. **Compare against the published Rollout Cards.** A faithful re-run reproduces
   `resolved` per `(task, seed, arm)`; small cost/turn variance is expected, `resolved`
   should not drift for a deterministic grader.

---

## The arms

Both vocabularies are **LOCKED** in `@papercusp/bench-metrics`. L1 (on `TaskRunResult`):
`papercusp` · `baseline-a-ablation` · `baseline-b-native` · `baseline-c-bestofn`. Fleet
(on `FleetRunSummary`): `hive` · `queen-ablated` · `native-serial` · `openhands-async` ·
`crewai` · `langgraph`.

### L1 per-task arms

| Arm | What it is | Generation |
|---|---|---|
| `papercusp` | Full `coding` spine as a throwaway harness | `external-bench` blueprint (**`extends: coding`, overrides nothing**) |
| `baseline-a-ablation` | Spine collapsed to a single worker | `coding-solo` blueprint (**`extends: single-agent`**) |
| `baseline-b-native` | Provider's own harness (Claude Code), elicited to best | Standalone native runner — spawns the `claude` CLI's own loop |
| `baseline-c-bestofn` | N samples + a **visible-only** test-verifier, matched budget | Best verifier-selected diff |

> **D-009 — there is NO `external-bench:run` op.** `papercusp` and `baseline-a-ablation`
> are spun by **one shared `instantiateBenchHarness` port** (`external-bench/run-loop.ts`)
> and differ **only by `blueprintId`** (`external-bench` | `coding-solo`) — so any L1
> delta is attributable to coordination itself. The clone→instantiate→extract-diff→
> grade→emit loop is `arm-generation.ts` (`P-005`), not a blueprint op. The live harness
> driver is bound at the pilot via `setBenchHarnessDriver`. `baseline-b-native` is its
> own primitive (`native-harness-runner.ts`), **not** the single-worker arm — that
> "we didn't nerf the baseline" property is the whole point.

### Fleet-layer arms (Phase 5)

| Arm | What it is | Owner |
|---|---|---|
| `hive` (treatment) | A **fleet driver** hands the whole task SET to a Hive (Queen places/ranks/evicts; bees run the L1 unit), bound at the pilot via `setBenchHarnessDriver` | `P-022` |
| `queen-ablated` (**headline baseline**) | Same fleet + same per-task unit, **naive FIFO/round-robin** in place of the Queen | `P-023` |
| `native-serial` (floor) | One Claude Code session draining the whole backlog serially — the speedup denominator | `P-024` |
| `openhands-async` / `crewai` / `langgraph` | Competitor orchestrators over the same backlog + grader | `P-028` |

The **`hive` − `queen-ablated`** delta is the Queen's value, measured apples-to-apples.
Each fleet arm emits one **`FleetRunSummary`** per backlog run (`runId`, `suite`, `arm`,
`tasks`, `resolved`, `wallClockMs`, `costUsd`, `tokensTotal`, `tasksZeroHumanGate`,
`peakConcurrency?`); the per-task unit it places still emits the locked `TaskRunResult`.
`buildHiveReport(HiveArmInput[]) → HiveBacklogReport` produces per-arm
`{ throughput, value, mast }` + `queenDelta`.

**Submission shape (M1, every per-task unit):**

```json
[ { "instance_id": "instance_astropy__astropy-12345", "patch": "diff --git ...", "prefix": "seed1" } ]
```

`prefix` carries the seed (≥3 per task). The diff is `git diff` of the harness worktree
against `base_commit`, excluding the grader's test files.

---

## Grading

### M1 — SWE-bench Pro (offline diff-batch) — the pilot backbone

Source of truth: `scaleapi/SWE-bench_Pro-os`; dataset `ScaleAI/SWE-bench_Pro`
(`split='test'`); images `jefzda/sweap-images`. Arm-agnostic Docker batch over the
predictions JSON:

```bash
python swe_bench_pro_eval.py \
    --raw_sample_path=swe_bench_pro_full.csv \
    --patch_path=<patches>.json \
    --output_dir=<out> \
    --scripts_dir=run_scripts \
    --num_workers=100 \
    --dockerhub_username=jefzda
```

`resolved` = **all `FAIL_TO_PASS` pass AND all `PASS_TO_PASS` still pass.**

> ⚠️ "Bash runs by default in these images; do not manually invoke bash." Drive grading
> **only** through `swe_bench_pro_eval.py` — never `docker exec bash` into a sweap image.

Grading is a pure function of the predictions JSON — run it long after generation,
re-run freely, identical for every arm. Same path for SWE-rebench / SWE-bench-Live.

### M1 — SWE-Lancer (L3 value-capture)

SWE-Lancer (arXiv 2502.12115) — \$1M of real freelance SWE tasks, **automated E2E
test grading**, reuses the M1 diff→grader path. Run the \$-weighted backlog under a
**fixed budget** and report \$ captured (`P-027`). **[provisional — runner is `P-027`]**

### M2 — Terminal-Bench 2.0 / Harbor (online in-container)

```bash
uv run harbor run --dataset terminal-bench@2.0 --agent oracle --n-concurrent 4   # sanity check
harbor run -d "terminal-bench@2.0" --agent claude-code                            # baseline-b-native (built in)
harbor run -d "terminal-bench@2.0" --agent-import-path papercusp_harbor:PapercuspAgent  # [provisional — P-005]
```

Competitor orchestrators (`P-028`) likewise plug in via Harbor's adapters. `resolved` =
Harbor's pass/fail; no `FAIL_TO_PASS`/`PASS_TO_PASS` split.

### L4 — MAST coordination-quality (re-implemented, license-clean)

The MAST repo has **no declared license**, so we **do not run their judge code**.
Instead we **re-implement the published 14-mode / 3-category rubric** (system-design ·
inter-agent-misalignment · task-verification) and score it with our own judge. Two legs
(`scoreMast({ arm, tasks, trace, verdicts }) → MastReport`):

- **Objective substrate-signal rates (no judge):** every fleet arm emits a raw
  `CoordEvent[]` trace (`{ ts?, kind, agent?, taskId?, detail? }`); `substrateSignalRates()`
  counts the mechanical failure signals `duplicate_completion` / `orphaned_claim` /
  `stranded_item` / `lost_handoff` / `claim_conflict` / `superseded_work` / `rework`.
- **LLM-judge per-category rates:** our judge emits `MastVerdict[]` → `MastReport.byCategory`.

Report both against the **published MAST baseline** (`MastReport.masBaselineBand` =
`[0.41, 0.86]` — re-confirm the exact figures verbatim against arXiv 2503.13657 before
publishing) + the `queen-ablated` fleet + competitors. `P-010` captures the
`CoordEvent[]` into the rollout; `P-026` scores it.

### M2-local — Harness-Bench (`clawbench_v2`)

28/106 tasks public + no license ⇒ **methodology citation + a labeled 28-task
cross-check only**, never a headline. Full 106-task run deferred (`P-014`).

---

## The run-result schema (LOCKED v1)

One row per `(run_id, suite, task_id, arm, seed)` — `UNIQUE` on that tuple (idempotent
re-emit). **All arms emit through one function:**

```
emitRollout(input) → { rollout_id, run_id }
// packages/operator-core/lib/external-bench/reproducibility/emit.ts
```

It writes the `benchmark_run_result` row **and** the `benchmark_rollout` card in one
transaction, derives `cost_usd` via `priceRun()`, and fires
`notifySyncInvalidate('evals.runs', …)`. Key fields:

| field | source | notes |
|---|---|---|
| `run_id` / `prereg_hash` / `suite` / `task_id` / `arm` / `seed` / `modality` | runner | identity; `prereg_hash` must match a `benchmark_prereg` row |
| `generation_status` | runner | `completed` \| `error` \| `timeout` \| `budget_exhausted` |
| `resolved` (**nullable**) | grader | headline; `NULL` ⇒ infra failure, **excluded from accuracy** |
| `grader_status` / `grader_family` / `grader_version` / `grader_error` | grader | `grader_error` is **distinct** from `resolved=false` |
| `tokens_in` / `tokens_out` / `tokens_total` | runner | `tokens_total` = **SUM over ALL roles / candidates + verifier** |
| `tokens_cache_read` / `tokens_cache_write` | runner | material to \$ on Opus |
| `cost_usd` / `price_table_version` | derived | `priceRun()` at emit; tokens canonical, \$ re-derivable |
| `wall_clock_ms` / `turns` / `budget_tokens` / `capped` | runner | `budget_tokens` caps **generation only**; `capped` ≠ infra fail |
| `model_id` / `harness_version` / `arm_meta` (jsonb) | runner | best-of-N puts `{n, candidates, verifier_tokens}` in `arm_meta`; fleet/coordination events for MAST |

**Scoring rules (the aggregator honors these):** a row is **scoreable** iff
`generation_status='completed'` AND `grader_status ∈ {passed, failed}` (so `resolved`
is non-null). Infra rows (generation error/timeout/budget-exhausted, or grader
error/timeout) → `resolved=NULL` → excluded from accuracy, reported as separate counts
(retry first; never score an infra failure as a genuine fail). pass@1 = mean(`resolved`)
over a task's ≥3 seeds; same k for every arm.

**Type source of truth:** `TaskRunResult` → `@papercusp/bench-metrics/schema` (`P-011`);
`RolloutRecord` + `PreregConfig` + `emitRollout` →
`packages/operator-core/lib/external-bench/reproducibility/` (`P-010`); migration
`libs/papercusp/libs/db/sql/291-benchmark-reproducibility.sql`. **Do not redefine.**

---

## Cost accounting (don't cheat this)

Each arm's `tokens_total` (and so `cost_usd`) includes **every** token the system
spends — every Queen decision, every bee, every hand-off, every coordination message
(and for best-of-N, all N candidates + the verifier). Under-counting coordination
overhead is the single easiest way to fake a win; the suite counts it all and reports
*"net of all coordination overhead, better per dollar."* `cost_usd` is **derived** from
raw tokens at a pinned `price_table_version`.

---

## Pre-registration & the gym firewall (the anti-tuning guarantees)

- **Pre-registration:** each run config is committed to git
  (`benchmarks/preregistrations/<run_id>.json`) **before** the run, keyed by
  `prereg_hash` (sha256 of the canonical config). A re-runner diffs the published config
  against the live run to confirm nothing was tuned after results were seen.
- **Gym ↔ report firewall** (`packages/operator-core/lib/gym/report-set-firewall.ts`):
  the gym's optimize-on sets (`gym-synthetic`, `gym-real-anchor`) and the report-on
  suites (`REPORT_ON_SUITES`, which *is* the `suite` vocabulary) are **statically proven
  disjoint in CI**, and the gym's task-ingestion choke point refuses any task that
  fingerprints to a report-on benchmark.

---

## Provenance & links

- **Methodology:** `/internal/docs/benchmarks/methodology`.
- **Overview:** `/internal/docs/benchmarks/`.
- **Feasibility spikes:** L1 grader interface — D-008 /
  `apps/operator/docs/external-bench-grader-feasibility-2026-06-15.md`; fleet instruments
  — D-011 / `apps/operator/docs/hive-instrument-feasibility-2026-06-15.md`.
- **Plan:** `impartial-benchmark-suite-2026-06-15` (decisions D-001 … D-011).
- **Ownership:** `external-bench` blueprint (`P-019`), grader adapter (`P-005`),
  Baseline A (`P-006`), Baseline B (`P-007`), Baseline C (`P-008`), cost/scoring +
  schema (`P-011`), reproducibility + pre-registration (`P-010`), gym firewall (`P-012`),
  hive-backlog runner (`P-022`), Queen-ablation (`P-023`), native serial floor (`P-024`),
  fleet metrics (`P-025`), MAST (`P-026`), SWE-Lancer value (`P-027`), competitors
  (`P-028`), eval views (`P-030`).
