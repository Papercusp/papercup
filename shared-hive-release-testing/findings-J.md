# Brief J — D-001: LWW convergence under clock skew (the hard S0) — findings

Owner: su-46b7a. Lane: D-001 convergence migration (S0 — the release gate).
Status: **IN PROGRESS** (continuous loop). Design locked + landing.

> Read `findings-D.md` (the root-cause) and `brief-J-convergence-d001.md` first.
> This file is the chosen design + the migration + the gate matrix + the live
> witness, and is kept current so a successor can continue mid-flight.

---

## The bug in one paragraph (recap)

A federated write passes through **two** ordering decisions that must agree but
don't: the merge winners-fold (`read-merge.ts` `beatsStored` ≡ `projection.ts`
`lwwPick`) orders by **HLC**; every mutable projection's PG guard
(`WHERE EXCLUDED.fed_ts >= stored.fed_ts`) orders by **`fed_ts`** (wall clock).
The recv-seam (`observeRemoteHlc`) advances a peer's HLC above a later write's
`ts`, decoupling the two orders. The fold hands the HLC-winner to apply; the PG
guard rejects it (lower `fed_ts`) → two honest peers materialize **different
rows for the same key, permanently**. Non-convergence = the one hard S0.

## Chosen design — approach (a): one ordering key of record, `fed_hlc`

`findings-D.md` validated two fixes empirically; I pick **(a)** for semantic
cleanliness and minimal blast radius on `fed_ts`'s existing meaning.

- **New column `fed_hlc TEXT`** on every mutable LWW table. It stores the op's
  **`hlc`** — which is ALREADY a fixed-width, lexicographically-sortable
  `encodeHlc` string (`"<15-digit ms>:<5-digit count>"`, `libs/generic/locks-core/src/hlc.ts`),
  so a SQL `>=` string compare equals `compareHlc`. No new encoding.
- **Guard becomes** (per projection put):
  ```sql
  WHERE (<t>.fed_hlc IS NULL AND <t>.fed_ts IS NULL)                 -- first write
     OR (EXCLUDED.fed_hlc IS NOT NULL AND <t>.fed_hlc IS NOT NULL    -- both HLC → causal
           AND EXCLUDED.fed_hlc >= <t>.fed_hlc)
     OR ((EXCLUDED.fed_hlc IS NULL OR <t>.fed_hlc IS NULL)           -- either lacks → fed_ts
           AND (<t>.fed_ts IS NULL OR EXCLUDED.fed_ts >= <t>.fed_ts))
  ```
  The del ts-guard gets the symmetric HLC-then-fed_ts form.
- **`fed_ts` is left untouched.** It stays the wall-clock value (the back-compat
  fallback, the plan-parts `fed_ts=0` baseline convention, the fleet-monitors
  reader). Approach (b) — overloading `fed_ts = packHlc` — was rejected because
  it changes `fed_ts`'s scale (breaks the `fed_ts=0` convention + any reader).

## The crux — write-time HLC (why the comparator change alone is NOT enough)

`findings-D` flagged it: under (a), a stored **LOCAL** row has a NULL `fed_hlc`
(the local write never went through an op), so an incoming remote op falls back
to `fed_ts` against it → the local-vs-remote divergence (the exact D-001 trace,
where W is a local write) **persists**. The local row MUST carry the same HLC
the federated op carries.

**Design: PG is the HLC clock of record.**
- Migration 314 adds a singleton `harness_shared.hlc_clock` + `hlc_now()` (stamp,
  monotone, counter-rollover) + `hlc_recv(remote)` (advance past a remote HLC).
- The **mig-214 `stamp_local_federated_write` trigger** (already on the 11 CDC
  tables) is extended:
  - LOCAL write branch → also `NEW.fed_hlc := harness_shared.hlc_now()`
    (atomic with `fed_ts`; **no NULL-`fed_hlc` window**).
  - REMOTE-apply branch (`fed_ts` moved) → `PERFORM harness_shared.hlc_recv(NEW.fed_hlc)`
    (the recv-advance, **PG-side**, so a later local write is stamped
    causally-after — no Node apply-path change needed).
- The **CDC drain** threads the local row's `fed_hlc` onto the wire op
  (`outboxRowToLocalWriteOp` sets `op.hlc = row.fed_hlc`; `stampOpHlc` already
  PRESERVES a preset `op.hlc`). So the remote peer's projection writes
  `fed_hlc = op.hlc` = the local row's value → **identical key both sides**.
- **Log-first tables** (`shared_presence`, `contributors`, `feature_queue`,
  `feature_working_set`, `harness_feature_prs`) keep the **Node** clock
  (`stampOpHlc`): they have no local-direct-write (rows arrive only via apply),
  so no NULL window and no PG stamp needed — just the column + guard.

### Why NOT back-write `fed_hlc` from the drain (the rejected alternative)
A drain back-write leaves a window between the local write (fed_hlc=NULL) and the
drain. A concurrent remote op applied in that window wins by the `fed_ts`
fallback; because the local write is `skipOwnOps` it **never re-folds to
recover** → permanent divergence. The PG-trigger stamp is atomic → no window.

## Migration 314 — `314-d001-hlc-ordering-key.sql`
1. `harness_shared.hlc_clock` singleton + `hlc_encode/hlc_now/hlc_recv`.
2. `ADD COLUMN IF NOT EXISTS fed_hlc TEXT` on every mutable LWW table (the
   mig-181 set + 186/189/197/270).
3. `CREATE OR REPLACE` the `stamp_local_federated_write` trigger fn (stamp +
   recv-advance).
4. Re-mask the two broad-compare capture UPDATE triggers (features/issues) to
   subtract `fed_hlc` too (so a `fed_hlc`-only delta can't re-enqueue — belt &
   suspenders; `fed_hlc` always moves with the masked `fed_ts`).
Migrates 000→head clean; idempotent (`IF NOT EXISTS` / `CREATE OR REPLACE`).

## Projection guard change (the mechanical bulk)
Thread `provenance.fedHlc` (= `op.hlc`) through `projection.ts` `applyOpVia`, and
per projection: add `fed_hlc` to the INSERT cols + `ON CONFLICT DO UPDATE SET` +
the put-guard WHERE + the del ts-guard. Reference impl: `harness-features.ts`.
Files: harness-features, harness-issues(issues), harness-plans, engineer-issues,
plan-item-assignments, coord-message, coord-thread, coord-thread-post,
coord-conversation, presence, hive-members, hive-settings, contributors,
feature-queue, feature-working-set (+ plan-parts recompose semantics).
> Coordinated with Brief I (su-d2230): I owns the *binding slug* in
> boot.ts/register-all.ts for hive-members/hive-settings — disjoint from the
> guard lines; we serialize via locks if we touch the same file.

## Gate matrix
| Gate | How | State |
|------|-----|-------|
| skew sweep converges | `convergence-fuzz.test.ts` `it.fails`→`it` (rig default guard now models `fed_hlc`) | **GREEN** (6/6) |
| monotone stays green | same file, unchanged | **GREEN** |
| migration 314 applies 000→head | `createFreshTestDb` in the integration twin runs the full migration set | **GREEN** |
| real-PG twin converges | `lww-hlc-fedts-divergence.integration.test.ts` `it.fails`→`it` (real projection + real PG) | **GREEN** (3/3) |
| post-cursor-reset replay safe | `fed-ts-lww-guard.integration.test.ts` no-regression | **GREEN** (9/9) |
| all projection guards swapped | the 15 mutable LWW projections | **GREEN** |
| write-time-HLC gap closed | `d001-write-time-hlc.integration.test.ts` (real local write vs remote) | **GREEN** (3/3) |
| full federation suite | the 48-file `lib/sync/hyperbee` integration suite | **GREEN** (all 48 files) |
| affected lib/ + shared-hive-loop suites | rig-stub no-regression (composition-rig, _hive-substrate-rig, federated-cell-setup, cross-hive, trust-admission) | **GREEN** |
| live clock-skew pair | the :158 pair (real .deb + mig-314): staged the inversion via hlc_recv on A, both peers converged to the HLC-winner | **GREEN** (live-witnessed) |

### Test-stub blast radius (resolved)
The projection writeToPg now INSERTs `fed_hlc`, so EVERY hand-rolled CREATE TABLE
stub with a `fed_ts` column needed `fed_hlc` too. Added it to ~22 rig/test files
(composition-rig, _cross-peer-rig, federated-cell-setup, ei117-replay, the
projection `*.integration.test.ts`, the two-peer-federation tests,
federation-edge-cases/adversarial, plan-part-cutover, wire-outbox-drain-online,
the lib/ cross-hive + trust-admission + work-items-admission + lifecycle stubs).
The outbox drain reads `op_hlc` RESILIENTLY (`to_jsonb(...)->>'op_hlc'`) so a
pre-314 outbox (older boot snapshot / a rig loading archive/102 only) degrades to
NULL instead of crashing — no op_hlc needed in those rigs. `federated-column-
completeness` got `fed_hlc` added to its PROVENANCE set (set-by-projection, like
fed_ts). The fast twin (`lww-hlc-fedts-divergence.test.ts`) now PROVES the fix
converges + keeps a legacy `fed_ts` characterisation of the old divergence.

### Progress log (continued)
- Projection guard swap landed: harness-features, hive-members, hive-settings
  (mine), presence, contributors, feature-queue, feature-working-set (subagent C,
  verified). coord-* + harness-plans/engineer-issues/issues/plan-item-assignments
  in flight (subagents A/B). NEW test `d001-write-time-hlc.integration.test.ts`
  written (the local-write-vs-remote gap — the comparator-only fix doesn't close
  it; proves the mig-314 write-time stamp + the fed_hlc guard converge a
  local-W-high-HLC vs remote-L-high-fed_ts conflict).

### Progress log
- Migration 314 written (hlc_clock + hlc_now/hlc_recv + fed_hlc cols + extended
  mig-214 stamp trigger + capture op_hlc + capture-mask). Applies clean 000→head.
- Core seam landed: `projection.ts` (ProvenanceContext.fedHlc + applyOpVia + del
  signature), `feature-issue-op-keys.ts` (op.hlc from outbox.op_hlc),
  `outbox-drain.ts` (SELECT op_hlc), `harness-features.ts` (reference guard).
- Fuzz rig: added `fed_hlc` mode modelling the shipped guard, made it the default;
  flipped the skew `it.fails`→passing; teeth test re-pointed to legacy `fed_ts`.
- Integration twin flipped to assert convergence — **GREEN on real PG**.

### G1b — a real semantic change (worth knowing)
`federation-edge-cases` G1b asserted "a STALE delete must not erase a newer put",
constructing staleness via **fed_ts**. Under D-001 the ordering key is **HLC**, so
a delete that is causally-LATER (higher HLC — e.g. drained after the put) now
CORRECTLY wins even with a forced-lower fed_ts. The no-clobber floor still holds,
but "stale" now means **HLC-stale**: rewrote G1b to force the del's `op_hlc` below
B's put `fed_hlc` → the guard refuses it → row survives. This is the intended
behaviour change, not a regression: deletes order by causality, not wall clock.

### NOW (cold-resume anchor) — COMPLETE
All gates GREEN. Code on staging (in-tree, git-sync flushing). Migration 314
applies 000→head. Unit suite 878 pass; convergence-fuzz skew sweep + monotone +
real-PG twin + NEW write-time-HLC test + fed-ts-lww-guard + ei117 + column-
completeness all green; full 48-file `lib/sync/hyperbee` integration suite green;
the affected lib/ + shared-hive-loop rig suites green. **Live D-001 skew witness
PASSED** on the real .deb :158 pair (mig-314): a hand-staged inversion (A high-HLC
/ low-fed_ts vs B low-HLC / higher-fed_ts) converged to the HLC-winner on BOTH
peers — B accepted A's lower-fed_ts write because the guard orders by fed_hlc.
Nothing outstanding. (One left-behind: the :158 pair's PG HLC clocks were advanced
~54h into the future by the witness's hlc_recv — harmless, resets on teardown.)

## Done / verdict — **GREEN**
D-001 is FIXED. Federated LWW now converges under clock skew: one ordering key of
record (the HLC `fed_hlc`) end to end — the merge fold and the PG projection guard
order by the same key, and write-time HLC stamping (the PG clock-of-record via the
mig-314 trigger + threaded op_hlc) ensures local rows carry it so local-vs-remote
conflicts converge too. The one hard S0 among the shared-hive release blockers is
closed; the dimension is GREEN (skew sweep converges, monotone green, full
federation suite green, live clock-skew pair converges to one row).
