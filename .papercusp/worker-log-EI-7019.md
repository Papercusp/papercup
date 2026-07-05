# Worker log — EI-7019

**Bug:** CHRONIC autoloop failure: `rt-loop-9@papercup` red 8 consecutive fires (last_status `loop-stuck-backstop`).

## Diagnosis (root cause)

`rt-loop-9` is NOT a real production loop — the role name is minted ONLY by the
integration test `packages/operator-core/lib/harness/routines/reconcile-loop-routines.integration.test.ts`
(`const id = \`rt-loop-${++rtSeq}\``; the 9th seeded loop is `rt-loop-9`).

Root cause (documented in the test header, lines 20–26): the test historically
called `reconcileLoopRoutines` bare. Its DEFAULT `recordFire`/`readFireState`
seams hard-bind `getOrgPg()` — the **LIVE dev DB**, not the testcontainer `sql` —
so every full-file run silently wrote fire-state `'error'` rows for
`('papercup','rt-loop-9')` into the dev DB's `autoloop_state`. The streak
accumulated past the chronic-failure threshold → the improvement-watchdog sweep
(`autoloop-chronic-failure.ts`) captured EI-7019.

## Fix — already landed (this EI is the resolved artifact)

The root-cause fix (a hermetic `reconcile()` wrapper stubbing both seams to
no-ops, used by all 12 tests) landed in commit `fb5aad4c16` at 2026-07-03
**14:10**, ~30 min AFTER EI-7019 was captured at 13:38. So the bug no longer
reproduces from this vector, and the stale artifact is gone.

A durable source-level guard (threading an injectable `db` through
`recordFire`/`readFireState` so no test can ever bleed into the live DB) was
CONSIDERED but is out of self/inline scope — it refactors the fire-gate circuit
in `autoloop.ts` (safety-adjacent). The hermetic wrapper is the correct-scoped,
already-landed fix.

## Verification (evidence it is gone)

- `autoloop_state` rows for `rt-loop-9`: **0** (`SELECT count(*) … WHERE role='rt-loop-9'`).
- `routines` rows `rt-loop-*`: **0**.
- Integration test `reconcile-loop-routines.integration.test.ts`: **12/12 pass** (now hermetic).
- Unit tests `reconcile-loop-routines.test.ts` + `autoloop-chronic-failure.test.ts`: **59/59 pass**.

## What the validator should re-verify

- Nothing to re-implement — verified-gone. If a stronger class-level guard is
  wanted, file a follow-up to make `recordFire`/`readFireState` accept an
  injectable connection so a test's `sql` seam also scopes the fire-state writes.

Resolved: `fixed`.
