# Papercusp impartial benchmark suite — reproducer

> **What this is.** The clone-and-run reproducer for the Papercusp impartial
> benchmark suite: how to re-execute every result we publish, from public task
> set to official grader to scored report. The *why* — the fairness protocol, the
> three baselines, the cost model, contamination handling — is the
> **[methodology doc](../apps/operator-docs/src/content/docs/benchmarks/methodology.mdx)**
> (served at `/internal/docs/benchmarks/methodology`). This README is the *how*.

> ⚠️ **Draft — numbers pending the pilot (`P-009`).** The protocol and commands
> below are real; published *results* do not exist until the pilot run lands and
> the owner signs off (`P-017`). Sections that depend on peer-owned code still
> shipping are marked **[provisional — confirm against code]**.

---

## The one invariant

**Generation is arm-specific; grading is byte-for-byte identical across arms.**
Every arm (Papercusp + Baselines A/B/C) reduces its work to the *same* submission
shape and is graded by the *same* official grader at the *same* pinned version. If
you change the grader for one arm, the comparison is void. This is the whole
fairness claim — preserve it when you re-run.

---

## Prerequisites

- **Docker** (≥ 29.x) — required for Modality M1 (SWE-bench Pro) and M2
  (Terminal-Bench / Harbor). The dev box has 29.4.0.
- **Disk** — per-instance grader images are GB-scale. A ~50-task pilot pulls ~50
  images. Use a **dedicated scratch volume**, not the shared checkout's disk, and
  prune images between benchmark families. Do grading on a **dedicated host/volume**,
  never inline with the fleet dev box (it will evict the shared tree's disk).
- **`uv`** — for Terminal-Bench / Harbor (M2).
- **A model credential** for the arm under test (the same model id for every arm —
  this is the controlled variable).
- **The Papercusp tree on `staging`**, operator running. Benchmark generation runs
  on normal coding-harness infra; grading is decoupled.

---

## Layout

```
benchmarks/
├── README.md            ← this file
├── configs/             ← pre-registered run configs (committed BEFORE each run)   [provisional path — owned by P-010]
├── predictions/         ← M1 predictions JSON per (benchmark, arm, seed)
├── results/             ← raw grader output, stored verbatim
└── reports/             ← scored reports (pass@1 + CIs, cost/accuracy Pareto)      [owned by P-011]
```

The **run-result rows** (one per `task × seed × arm`) and the scored reports are
produced by the cost/scoring lib (`P-011`) and the reproducibility harness
(`P-010`); the run-result schema is documented in
[§ run-result schema](#the-run-result-schema) below and canonically owned by those
two briefs.

---

## Reproduce a result in five steps

1. **Check out the pre-registered config.** Every published result names a config
   committed to git **before** its run (`benchmarks/configs/<run-id>.yaml`). It pins
   the benchmark + split, the arm, the model id + sampling params, the iso-budget
   cap, the seed list, and the exact `graderFamily` + `graderVersion`. Re-running =
   re-applying that config. **Do not edit it** — pre-registration is what makes
   "we did not tune to the test" checkable.

2. **Generate** — run each arm against the task set under the iso-budget cap. Each
   arm emits the same submission record (M1: `{ instance_id, patch, prefix }`). See
   [per-arm generation](#per-arm-generation).

3. **Grade** — hand every arm's submissions to the *same* official grader. See
   [grading](#grading).

4. **Score** — feed the graded rows to the scoring lib for pass@1 over ≥3 seeds
   with confidence intervals + the cost/accuracy Pareto.  **[provisional — P-011]**

5. **Compare against the published rollout records** — the rollout is the unit of
   reproducibility (Rollout Cards). A faithful re-run reproduces `resolved` per
   `(task, seed, arm)`; small cost/turn variance is expected, `resolved` should not
   drift for a deterministic grader.

---

## Per-arm generation

All four arms hold the **model / base tools / web-access / task set / grader /
retry policy / automation level** constant — only the harness differs (the
[methodology](../apps/operator-docs/src/content/docs/benchmarks/methodology.mdx)
lists the full held-constant set). The iso-budget cap lives on **generation**;
grading is uncapped.

| Arm | Harness | How it generates |
|---|---|---|
| **Papercusp** (treatment) | Full multi-agent spine + coordination substrate | `external-bench` blueprint → throwaway `coding` harness per task → run to DONE → extract diff |
| **Baseline A** (ablation) | Papercusp spine collapsed to a single worker | Same blueprint, orchestration OFF — identical tools/model/infra/budget |
| **Baseline B** (native, headline) | Claude Code (provider's own harness), elicited to best | Native run → extract diff. On Terminal-Bench: Harbor `--agent claude-code` |
| **Baseline C** (best-of-N) | Single agent sampled N× + test-verifier, matched budget | Pick the verifier-selected sample's diff |

**[provisional — confirm against code]** The Papercusp/A/C generation entry point
is the `external-bench:run` op (BRIEF 2/`P-019`) over the `external-bench`
blueprint; the native arm is a standalone runner (BRIEF 5/`P-007`); best-of-N is
BRIEF 6/`P-008`. This README will pin the exact commands/flags once those land.

**Submission shape (M1, every arm):**

```json
[ { "instance_id": "instance_astropy__astropy-12345", "patch": "diff --git ...", "prefix": "seed1" } ]
```

`prefix` carries the seed — **one `prefix` per seed**, ≥3 seeds per task. The diff
is `git diff` of the harness worktree against `base_commit`, excluding the test
files the grader supplies.

---

## Grading

### Modality M1 — SWE-bench Pro (offline diff-batch) — **the pilot backbone**

Source of truth: repo `scaleapi/SWE-bench_Pro-os`; dataset `ScaleAI/SWE-bench_Pro`
(`split='test'`); prebuilt images `jefzda/sweap-images`; leaderboards at
`scale.com/leaderboard/swe_bench_pro_public`.

The grader is a **separate, arm-agnostic Docker batch** over the predictions JSON:

```bash
python swe_bench_pro_eval.py \
    --raw_sample_path=swe_bench_pro_full.csv \
    --patch_path=<patches>.json \
    --output_dir=<out> \
    --scripts_dir=run_scripts \
    --num_workers=100 \
    --dockerhub_username=jefzda
```

Per instance it pulls `jefzda/sweap-images:{dockerhub_tag}`, applies the patch
(git apply → git apply --reject → patch fallbacks), runs the repo tests via
`run_scripts/`, and reports **resolved** on the inherited SWE-bench rule: **all
`FAIL_TO_PASS` tests pass AND all `PASS_TO_PASS` tests still pass.**

> ⚠️ "Bash runs by default in these images; do not manually invoke bash." Drive
> grading **only** through `swe_bench_pro_eval.py` — never `docker exec bash` into a
> sweap image.

Grading is a pure function of the predictions JSON: run it long after generation,
re-run it freely, and it is identical for every arm. The same applies to classic
SWE-bench, SWE-rebench, and SWE-bench-Live (all M1).

### Modality M2 — Terminal-Bench 2.0 / Harbor (online in-container)

Source of truth: framework `harbor-framework/harbor` (`uv`-based); dataset
`harborframework/terminal-bench-2.0` (89 hand-audited Docker tasks). No diff — the
agent mutates the container; the verifier grades it in-container.

```bash
# Sanity-check the harness end-to-end first:
uv run harbor run --dataset terminal-bench@2.0 --agent oracle --n-concurrent 4

# Native-harness baseline (Baseline B) is built in:
harbor run -d "terminal-bench@2.0" --agent claude-code

# Papercusp arm via the custom-agent adapter:
harbor run -d "terminal-bench@2.0" --agent-import-path papercusp_harbor:PapercuspAgent   # [provisional — adapter is BRIEF 3/P-005]
```

The Papercusp adapter implements Harbor's external `BaseAgent`; its worker tools
(read/edit/bash/test-exec) are shimmed to proxy into the container via
`environment.exec(...)`. `resolved` = Harbor's pass/fail; there is no
`FAIL_TO_PASS`/`PASS_TO_PASS` split.

### Modality M2-local — Harness-Bench (`clawbench_v2`)

```bash
PYTHONPATH=src python3 -m clawbench_v2.cli run-task --task 01-file --model papercusp --mode <mode>
```

**Scope:** only **28 of the 106 tasks are public and there is no committed
license** — so Harness-Bench is a **methodology citation + an internal 28-task
cross-check (labeled partial / unaudited-license)**, *not* a headline impartial
result. The full 106-task run is deferred (`P-014`) until upstream publishes the
complete set + a license. See methodology § Harness-Bench.

---

## The run-result schema

One row per `(task, seed, arm)`. **Canonically owned by `P-011` (cost/scoring) +
`P-010` (reproducibility); this table is the documented contract and is kept in
sync with their code.**

| field | source | meaning |
|---|---|---|
| `instanceId` | task | benchmark task id |
| `benchmark` | task | `swe-bench-pro` / `terminal-bench` / … |
| `arm` | runner | `papercusp` / `baseline-a` / `baseline-b` / `baseline-c` |
| `seed` / `prefix` | runner | the seed (≥3 per task) |
| `resolved` | **grader** | headline pass/fail |
| `tokensIn` / `tokensOut` | runner | per-arm tokens — **coordination overhead included** |
| `costUsd` | runner | dollar cost at the priced model rate |
| `wallClockMs` | runner | generation wall-clock |
| `turns` | runner | agent turns |
| `trajectoryRef` | runner | pointer to the stored rollout/trajectory |
| `submission` | runner | M1: the graded `patch`; M2: the env ref |
| `failToPass[]` / `passToPass[]` | **grader** | M1 per-test detail (null for M2) |
| `rawGraderOutput` | **grader** | the benchmark's own report JSON, stored **verbatim** |
| `graderFamily` / `graderVersion` | **grader** | pinned grader identity (pre-registration) |
| `graderError` | **grader** | infra failure — **distinct from "not resolved"**, excluded from accuracy |

**`graderError` vs `resolved=false`:** an image-pull failure or grader timeout is an
*infra* failure, not a task failure. It is excluded from the accuracy numerator and
surfaced in the reproducibility records; it must never be silently scored as
"not resolved."

---

## Cost accounting (don't cheat this)

The Papercusp arm's `costUsd` / `tokensIn` / `tokensOut` include **every** token the
system spends — every role spawn, every hand-off, every coordination message — not
just the worker's. Under-counting coordination overhead is the single easiest way to
fake a win, so the suite counts it all and reports *"net of all coordination
overhead, better per dollar."* When you re-run, confirm your cost figures include the
full coordination tail.

---

## Pre-registration (the anti-tuning guarantee)

Before each run, the run config is committed to git (`benchmarks/configs/<run-id>.yaml`)
**before** the run executes. It is immutable. A re-runner can diff the published
config against the live run to confirm nothing was tuned to the test after results
were seen. Paired with the gym↔report firewall (the `gym` never optimizes on a set
this suite reports on), this is what makes the impartiality claim checkable rather
than asserted.

---

## Provenance & links

- **Methodology:** `/internal/docs/benchmarks/methodology` (or
  `apps/operator-docs/src/content/docs/benchmarks/methodology.mdx`).
- **Overview:** `/internal/docs/benchmarks/`.
- **Feasibility + grader-interface spec (D-008):**
  `apps/operator/docs/external-bench-grader-feasibility-2026-06-15.md` — the
  authoritative grader-interface contract and per-family command reference.
- **Plan:** `impartial-benchmark-suite-2026-06-15`.
- **Ownership of code surfaces:** `external-bench` blueprint (`P-019`), grader
  adapter (`P-005`), Baseline A (`P-006`), Baseline B (`P-007`), Baseline C
  (`P-008`), cost/scoring lib + run-result schema (`P-011`), reproducibility harness
  + pre-registration (`P-010`).
