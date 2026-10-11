# FrontierSWE — ultra-long-horizon implementation / perf-eng / ML-research
URL: /internal/docs/benchmarks/frontier-swe

How Papercusp integrates the FrontierSWE benchmark (Proximal Labs) — v2 (current) grades each task in a separate digest-pinned verifier image, v1 is in-container history; continuous [0,1] score, reported as mean@5 / best@5 + AVG-RANK / dominance across a coordination-topology arm pool. v1 and v2 rows never mix.

import { Aside } from '@astrojs/starlight/components';

**FrontierSWE** ([Proximal Labs](https://github.com/Proximal-Labs/frontier-swe-v2);
[leaderboard](https://www.frontierswe.com)) is an *ultra-long-horizon* coding-agent
benchmark with **multi-hour agent budgets per trial**. No model fully solves the
implementation tasks, so it is scored on a **continuous \[0,1]** scale over **5 trials**
per (model, harness) and reported as **mean\@5 / best\@5**; the leaderboard ranks models
by **AVG RANK** (mean position, lower = better) + **dominance** (win rate vs a random
opponent on a task). Plans: `benchmark-suite-frontier-swe-2026-06-18` (v1 integration),
`benchmark-coverage-frontierswe-v2-2026-10-10` (v2).

* **v2** — the separate repo `Proximal-Labs/frontier-swe-v2`, pinned at
  `da83f84f8fbcec3cbf0f2b17c98ebc811355c2df`: **34 tasks**, each assigned by the upstream
  README to one or two of five suite categories (Implementation, Scientific Computing,
  Performance Optimisation, Visual Reasoning, AI Research). Coarse buckets at that pin:
  19 implementation / 8 performance / 7 research.
* **v1** — `Proximal-Labs/frontier-swe`: **17 tasks** = 7 implementation / 7 performance /
  3 research. HISTORY: kept for old results, never aggregated or compared with v2.

Counts are derived from the ingested corpus (`frontier-swe-ingest.ts`), not hand-copied.
Every graded row carries its scorer pin (`graderVersion`), and the corpus reader, the
task-set loader and the report all refuse to mix versions.

FrontierSWE is **M2 + own-scorer** (the METR-HCAST shape), NOT the SWE-bench diff-batch
(M1) shape: the agent works *inside* the task's Docker image over hours, and each task
ships its OWN verifier. We **do not author a verifier** — every arm hits the byte-identical
task scorer (the fairness invariant).

* **v2 (Harbor flow)** — the verifier is baked at `/root/tests` (root-only) in both
  images; only the published **verifier image** adds a `/tests/test.sh` shim. So grading
  starts a **fresh container from `[verifier.environment].docker_image`** as root, copies
  every `task.toml` `artifacts` entry out of the agent container and re-materializes it at
  its ORIGINAL source path (emptied first), then runs `/tests/test.sh` with `[verifier.env]`.
  `docker exec` into the arm's own container cannot grade a v2 task.
* **v1** — `tests/test.sh` runs inside the arm's own container (`docker exec`).

## How the integration is shaped

| Concern      | Where                                                                                                                                      | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Suite vocab  | `external-bench/types.ts` (`BenchmarkFamily`), `bench-metrics/schema.ts` (`BenchSuite`), `gym/report-set-firewall.ts` (`REPORT_ON_SUITES`) | `'frontier-swe'` in all 3 lock-step places — a published, gym-fenced suite. The version lives on each row's `graderVersion`, not in the suite id.                                                                                                                                                                                                                                                                                                                                                                                                    |
| Ingest       | `external-bench/frontier-swe-ingest.ts` (+ `scripts/frontier-swe-ingest.ts`)                                                               | Reads the pinned checkout's `task.toml` files + README category table → the corpus JSONL (verifier mode/image/env, artifacts, suite categories, GPU and external needs).                                                                                                                                                                                                                                                                                                                                                                             |
| Grader       | `external-bench/grader/frontier-swe.ts`                                                                                                    | `OfficialGrader`. **Reward precedence (Harbor):** `reward.json` is PRIMARY whenever it exists (a dict of name → finite number, or a bare number); `reward.txt` is read only when `reward.json` is absent. An empty / non-numeric / non-finite file, or neither file, is a `grader_error` (score null) — never 0, and a malformed `reward.json` never falls back to `reward.txt`. Every row is pinned: `frontier-swe@v2+<commit12> verifier=<image@sha256:…>` (v2) or `frontier-swe@v1 <pin>` (v1); an unpinnable row is a grader error, not a guess. |
| Live binding | `external-bench/grader/frontier-swe-live.ts`                                                                                               | `resolveFrontierSweConfigFromEnv` + `buildLiveFrontierSweGrader` + `preflightFrontierSwe` + `describeFrontierSweRun`. v2: prepares the separate verifier container and copies artifacts, torn down in a `finally`; v1: `docker exec` shell-free.                                                                                                                                                                                                                                                                                                     |
| Task sets    | `external-bench/task-sets.ts`                                                                                                              | v2: `frontier-swe-v2` (full) · `frontier-swe-v2-pilot` (one DISTINCT task per README suite category → 5 tasks, scarcest category first) · `frontier-swe-v2-cpu` (no GPU and no external service) · `frontier-swe-v2-custom`. Corpus at `~/.papercusp/bench-results/frontier-swe-v2/tasks.jsonl`. v1 (history): `frontier-swe` · `frontier-swe-pilot` (1/bucket) · `frontier-swe-cpu` · `frontier-swe-custom`, corpus at `~/.papercusp/bench-results/frontier-swe/tasks.jsonl`.                                                                       |
| Report       | `external-bench/report/frontier-report.ts`                                                                                                 | `buildFrontierSweSuiteData` → `suiteData['frontier-swe']`. **Refuses** rows graded against both corpus versions, and any task whose scored rows carry more than one scorer pin (arms graded by different verifier images are not comparable). Task / per-bucket counts and the small-N caveat are derived from the rows.                                                                                                                                                                                                                             |
| Aggregation  | `@papercusp/bench-metrics` `frontier-rank.ts`                                                                                              | `meanAtK` / `bestAtK` (unbiased), `avgRank`, `dominance`, `frontierRankReport`. `pass-k` is binary, `pareto` is cost/accuracy.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Arms         | the shared coordination-topology runtime (su-37e53a76)                                                                                     | FrontierSWE supplies only its task-set + clone/grade; it does NOT roll its own arms (D-007).                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## Scoring & the headline

Each task's verifier emits a continuous reward in `[0,1]`. Per task we report **mean\@5**
(expected mean of a random 5-subset = the trial mean) and **best\@5** (the unbiased
expected max of a random 5-subset; `best@1 = mean`, `best@n = max`). Across tasks the
suite headline is the **coordination-topology comparison**: per-arm **mean\@5 / best\@5**,
**AVG RANK**, and **dominance**, optionally per bucket (implementation / performance /
research).

The public AVG RANK / dominance are relative to a fixed competitor pool (the upstream
`job.yaml` models). By default we report the **central-Mug vs distributed-peer vs ensemble
vs single-agent** comparison on the same tasks + same scorers under **iso-budget** — where
FrontierSWE's real headroom (no model fully solves the implementation tasks) makes a
topology lift measurable. Reproducing the absolute public rank requires running that
competitor pool (an optional, owner-gated step).

## Fairness (binding)

Every FrontierSWE number passes the **C1–C10 pre-claim audit** in
[Benchmark Fairness Criteria](/benchmarks/fairness-criteria) (use
`buildFairnessAudit` from `@papercusp/bench-metrics`). FrontierSWE-specific points:

* **C1 same denominator** — an empty / no-progress workspace scores **0** (it COUNTS); a
  verifier that *fails to run* (image/OOM/timeout) or writes no valid reward is a
  `graderError`, excluded *symmetrically* across arms and disclosed — never a vanished row.
* **C3 iso-budget** — cap all arms to the same per-task budget; **wall-clock is a
  first-class cap dimension** here (tasks run hours), alongside calls + `$`.
* **C5 one scorer** — every arm of a task must be graded by the same pinned verifier; the
  report refuses otherwise.
* **C8** — the native 5-trial protocol satisfies ≥2 seeds; report per bucket.
* **C9** — validate against a published number using a task's `solution/solve.sh` gold
  control (or a reference model) before any cross-arm claim.

## Hard gates (read before launching)

* **GPUs and external services (v2)** — at the pinned commit 11 tasks need GPUs and 5 need
  Modal or a registry secret (one needs both), leaving **19 CPU-only tasks** with no external
  needs: that is `frontier-swe-v2-cpu`. GPU passthrough for v2 GPU verifiers is not wired yet.
* **GPUs (v1 history)** — 5 of 17 tasks need datacenter GPUs (B200:
  `granite-mamba2-inference-optimization`, `inference-system-optimization`; H100:
  `modular-stack-wan21`, `optimizer-design`, `pcqm4mv2-autoresearch`); `frontier-swe-cpu`
  is the GPU-free remainder.
* **Wall-clock + disk** — multi-hour agent + up to 24 h verifier per trial; per-task images
  are GB-scale, memory up to 128 GB, storage up to 150 GB. Grade on a **dedicated volume**,
  prune between tasks.
* **Reliability (D-009)** — long big-repo trials are the worst case for the slow-but-alive
  heartbeat-reclaim gap; the liveness-conditioned reclaim fix (F-FIX-038 / EI-1293) shipped,
  and infra non-completions are excluded + disclosed symmetrically (C6).
* **License (D-005)** — the v1 repo ships **no LICENSE**: research/eval use only, no
  redistribution of derived data without owner sign-off.

## Running it

The full run is **owner-gated** (compute / `$` / wall-clock). Build + smoke first; see the
operational runbook (`external-bench/grader/FRONTIER-SWE-PILOT.md`) for the exact ingest,
preflight, gold/empty controls, env vars, and the per-task GPU/timeout envelope.
