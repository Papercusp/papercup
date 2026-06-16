# Evaluation UI — run, monitor, grade, compare & export
URL: /internal/docs/benchmarks/evaluation-ui

The operator's Evaluation dock tab — launch a real SWE-bench Pro run, monitor it live, grade it with the official grader, compare arms with the validity gate + honest caveats, and export a 3rd-party-reproducible bundle.

import { Aside } from '@astrojs/starlight/components';

The **Evaluation** dock tab (`?tab=evals`, registered in `AdvShell.tsx`) is the
full UI for the impartial benchmark: launch a real run, watch it live, grade it
with the official grader, compare arms, and export a reproducible bundle. Built
on `benchmark-evaluation-ui-2026-06-16`.

The Evaluation UI is part of the desktop app. Drive it through the running Tauri
shell (`cd papercusp-desktop && npm run dev` → the Evaluation tab), per
[testing](/internal/docs/testing) — not a browser against `:3055`/`:3070`.

## The two stores (why there are two)

* **Operational run store** — `bench_runs` / `bench_run_tasks` / `bench_run_events`
  (migration 296). MUTABLE, lifecycle-driven (`pending → running → grading → done | error | cancelled`), lenient while in-flight. This is the live source the UI
  reads via `@papercusp/sync` (`evals.benchRuns`, `evals.benchRun`,
  `evals.benchRunLive`). Preserved file-dir runs are imported one-way (dir → store).
* **Reproducibility cards** — `benchmark_rollout` / `benchmark_run_result` /
  `benchmark_fleet_run` (migrations 291–293). IMMUTABLE, firewall-gated
  (`prereg_hash`), for PUBLISHED graded results. Distinct concern — a live run
  exists long before any reproducibility card.

## Subtabs

| Subtab             | What it does                                                                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Launch**         | Pick arm / task set / cap / `$`-budget, see a cost+time estimate, owner-confirm above a spend threshold, launch. opus is pinned (fail-closed).                  |
| **Preserved runs** | Browse runs (imports + live) — id · arm · resolved% · status. Per-run: Grade, Export, Re-run, Delete. Validity badges, live fleet panel, coordination timeline. |
| **Compare**        | Arm-vs-arm over the same task set: resolved% delta + Frontier + per-task table + the honest-caveats panel.                                                      |

## Launch a run (P-004 / P-005)

The launch form posts to `POST /api/external-bench/runs/launch`. The run goes
through the **real bench engine** (not a `/tmp` launcher) as a detached managed
job: it persists `status=running`, returns a `run_id` immediately, and streams
live. Only **one run at a time** (spend-safety). Launches are gated on the
`papercusp-external-bench` flag (default OFF — the owner's spend gate; enable at
`/admin/features`).

Every launched run dissolves its hive on completion/cancel — stopping the Queen
wake, cancelling bees, and DELETING the gym/scout learning-loop rows
(`teardownHiveLearningLoop`) so no orphan re-spins opus. A run left in flight by
a CRASHED host is reaped on the next operator boot (heartbeat-gated, so a run
legitimately running in another live host is untouched). A UI run can never
orphan-respin opus on a `:3170` restart.

## Monitor live (P-007 / P-008 / P-009)

While a run is active the detail view polls `evals.benchRunLive` (the manual PG
checks made visual, from `spawned_agents` / `agent_usage_samples` scoped to the
run's hive):

* **Queen survival** — alive / age / reclaims.
* **Bee status** — placed / working / done / evicted / failed.
* **Per-task progress**, cumulative spend, wall-clock.
* **Coordination timeline** — placements, evictions, recoveries, wakes, event by event.

### Validity badges — the integrity guarantee (D-003)

Every run shows red/green validity badges (`computeValiditySignals`):
`OPUS-ONLY`, `QUEEN-SURVIVAL`, `EMPTY-DIFF`, `FLEET-CAP`, `SUBSET-SIZE`,
`SINGLE-SEED`. A **fail** (a non-opus leak, a queen reclaim, a 0-work arm) means
the run is NOT a clean result — and the Compare view will refuse to render it as
a valid delta. Warn/unknown are honest caveats, not invalidating.

## Grade (P-010)

**Grade** runs the OFFICIAL `swe_bench_pro_eval` (`--use_local_docker`, jefzda
images) over the run's collected diffs — the proven `_xbench_grade.py` path. It
persists the per-instance resolved map + `resolvedCount`/`resolvedPct`, and is
re-gradeable (`status: grading → done`). Requires the run's on-disk snapshot
(written on launch completion; preserved/imported runs already have it).

## Compare arms (P-011 / P-012)

Pick run **A** (baseline) and **B** (treatment). The headline comparison is
**hive-realqueen vs mini-swe-agent** (the SWE-bench Pro reference harness), same
model + same tasks (D-005). The view shows the resolved% delta, the cost/accuracy
Frontier, and the per-task table.

* **The validity gate (D-003):** if EITHER arm fails a validity check, the view
  renders **“No valid delta”** + the failing badges — never a fabricated number.
* **Honest caveats (P-012):** auto-surfaced per-arm (opus-leak, empty-diff,
  subset, seed, cap) + cross-arm (task-set mismatch, task-count mismatch,
  cap-asymmetry, spawn-path parity). A delta is never presented cleaner than its
  caveats.

## Export for 3rd-party reproduction (P-013)

**Export** downloads `predictions.json` (`[{instance_id, patch, prefix}]`) + a
`README.md` with the EXACT public re-grade command. A third party reproduces the
resolved verdicts with the public `swe_bench_pro_eval` + public images, with zero
access to our harness — also the shape for a SWE-bench Pro / SEAL leaderboard
submission.

## Verifying changes

* Unit/integration: `run-store`, `run-launcher` (incl. the kill-mid-run hard
  gate), `grade-runner`, `live-state`, `validity`, `export-bundle`, `AdvEvalsTab`.
* A full **live** walkthrough (launch → monitor → grade → compare → export with a
  real opus run) is **owner-gated** — it spends real budget and needs the
  `papercusp-external-bench` flag on. Drive it through the Tauri shell.
