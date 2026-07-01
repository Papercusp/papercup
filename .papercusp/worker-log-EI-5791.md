# Worker log — EI-5791 (ship link staging→main not flowing)

## Verdict: needs-human (protected surface + large scope)

## What I did
Diagnosed only — no code change. Root-caused the watchdog signal.

## Findings (evidence)
- git-sync is HEALTHY — commits flow to staging (dev:pipeline_position: committed✓ staging✓).
  The freeze is NOT git-sync.
- The staging→main ship link is frozen because the GREEN-CHECKPOINT GATE IS RED:
  release:deploy {status} → green:false, consecutiveReds:119, "no GREEN verdict in ~97h",
  lastGreenAt 2026-06-26, readyBehindMain:21.
- PRIMARY blocker: the green-checkpoint DBOS routineFire is "producing no DBOS operation
  output" and being CANCELLED+REQUEUED by the dbos-executor-reaper at its 60m no-output
  window (routines.metadata.last_error, source dbos-executor-reaper, latest 2026-06-30 17:16).
  The gate fire HANGS/OVERRUNS before producing a verdict instead of completing.
- This is a RECURRENCE of insight green-checkpoint-timeout-vs-forks-2026-06-27: memory
  pressure on the shared box forces GREEN_CHECKPOINT_MAX_FORKS down (8→4→2), ~doubling the
  suite wall-clock; the suite then overruns / produces no first-output within
  DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS (60m, dbos-executor-reaper.ts). The documented
  timeout-ordering invariant (suite 55m < reaper 60m < lock 65m) is violated in practice —
  the suite isn't recording a terminal/first-output result before the reaper cancels it.
- COMPOUNDING: real failing/flaky tests — last_fixer signature
  "@papercusp/memory,@papercusp/operator-core"; flake_history web=3, operator-core=5.
- Auto-fixer dispatched repeatedly (last_fixer candidates) but unresolved in 97h.

## Why needs-human (STOP condition)
Every fix lands on PROTECTED surfaces — release/deploy machinery
(green-checkpoint.ts GREEN_CHECKPOINT_MAX_FORKS; release-actions.ts
GREEN_CHECKPOINT_SUITE_TIMEOUT_MS), the routines/DBOS scheduler
(dbos-executor-reaper DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS), and the box memory
baseline. Large multi-system retune of the LIVE deploy gate; a wrong auto-fix wedges
ALL fleet deploys. Beyond an auto-implement worker's self-inline mandate.

## Proposed durable fix (for release-manager / owner)
1. Measure: box memory baseline (the :3070 operator-cluster size) + a manual
   `AFFECTED_BASE=<greenPin> npm run test:affected` wall-clock under live-fleet load —
   is the suite OOMing or just slow at 2 forks?
2. Re-establish the timeout-ordering invariant under current fork concurrency: make the
   suite emit a DBOS first-output (heartbeat) EARLY so the reaper's no-output window can't
   cancel a long-but-live run, OR bump suite-timeout + reaper no-output window + lock-stale
   together (coupled across green-checkpoint.ts / release-actions.ts / dbos-executor-reaper.ts).
3. Free memory on the box (documented deeper root) so MAX_FORKS can rise → faster suite.
4. Fix/quarantine the real failing tests in @papercusp/memory + @papercusp/operator-core
   (accountably) so completed fires actually go green.
