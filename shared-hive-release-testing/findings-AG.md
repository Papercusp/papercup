# Findings AG — Idempotency / determinism / replay audit

**Owner:** su-860d3 · **Date:** 2026-06-19 · **Verdict: 🟢 GREEN** (no non-idempotent
step found at the merge-engine + projection-guard level; all six AG dimensions proven).

## TL;DR

The federation pipeline's foundational guarantee — *re-applying the same op log is
safe* — is **proven idempotent + deterministic** over the REAL incremental merge core
(`mergeAdmittedLogsIncremental` + `createMergeCursor`) and a faithful in-memory
transcription of the projections' PG LWW guard (the shipped `fed_hlc`, the legacy
`fed_ts`, and the `lww` upper bound). Double-apply is a no-op, replay from any cursor
converges to the all-at-once state, duplicate (at-least-once) delivery is absorbed, a
cursor RESET re-fold reconverges (incl. the documented del-transient), and the apply
path is deterministic (no `Math.random` / `Date.now`). No S0/S1 non-idempotency found.

**Deliverable:** `packages/operator-core/lib/sync/hyperbee/__tests__/idempotency-replay-audit.test.ts`
(12 property tests, fast-check + seeded sweeps, **PG-free**, ~140ms — runs on every
unit run, not only when the heavy integration suite runs). Reuses Brief D's
`_convergence-fuzz-rig` (`generateOps` + `FedTsGuardedStore`) without editing it.

## Why this is a distinct lane from Brief D (convergence-fuzz)

Brief D proves CROSS-PEER convergence (every honest peer reaches the same state). AG
proves the property every recovery/churn/partition lane *assumes but never audited*:
re-applying the SAME op log is SAFE. A non-idempotent step would still pass every
happy-path test, then silently double-apply or lose on every reconnect/backfill/crash.

## Scope / properties (all GREEN)

| # | Property | Holds for | Notes |
|---|----------|-----------|-------|
| P1 | **Double-apply identity** — a 2nd full merge pass applies nothing new, state byte-identical | every guard × regime | `applied===0` on the re-pass |
| P2 | **Replay-from-any-cursor** — one-shot == chunked == mid-cursor-resume | order-independent guards (`fed_hlc`/`lww`) | the cold-boot-resume / backfill invariant, generalised |
| P3 | **Reorder-within-LWW** — two distinct delivery orders converge | `fed_hlc`/`lww` + monotone | complements D; skew+`fed_ts` divergence is D's lane |
| P4 | **Duplicate / at-least-once absorption** — every op delivered twice == de-duped fold | every guard × regime | SET semantics; cursor `positions` absorb the re-read |
| P5 | **Cursor-reset idempotency (P-068)** — fresh-cursor full re-fold into the same store is a no-op at the fixpoint; TRUNCATED log → `truncated:true` (reset trigger) | order-independent guards | the LOAD-BEARING invariant the merge docblock calls out |
| P6 | **Determinism across runs** — same seed/order → byte-identical state | every guard × regime | proves no `Math.random`/`Date.now` in generate→fold→apply |
| P2b/P5b | **Multi-op author logs (genuine multi-pass)** — budgeted/deferred fold reaches the one-shot fixpoint; del-transient is OBSERVABLE and reconverges | order-independent guards | see "Methodology delta" below |
| P7 | **Teeth** — a non-idempotent apply sink FAILS double-apply | — | negative control proving P1/P5 aren't vacuous |

## The invariants this audits (from `read-merge.ts`, made executable)

- **"POST-CURSOR-RESET DOUBLE-APPLY SAFETY (audit P-068 — LOAD-BEARING)"** — a reset
  re-folds every log from index 0 against rows already at the final state, so EVERY op
  re-applies. Correctness rests on two floors: (1) the in-memory winners fold (an op
  that doesn't beat the standing winner is never applied), and (2) every projection
  writer being PG-level LWW (`EXCLUDED.fed_ts >= stored.fed_ts`, del ts-guarded). P5
  exercises floor (1) PG-free; floor (2) is the integration layer (see below).
- **"KNOWN BOUNDED TRANSIENT"** — deletes leave no PG tombstone, so a reset replay that
  folds an old put BEFORE its winning del re-INSERTs the row until the del re-applies.
  *AG turns the prose "the fixpoint always converges" into a property* (P2b/P5b: the
  del-transient is observed across passes and is gone at the fixpoint, which equals the
  one-shot fold).
- **EI-79 step 3 truncated log** — `length < cursor` returns `truncated:true` and folds
  nothing; this is the explicit signal the caller uses to reset the cursor. Asserted (P5).

## Methodology delta (an honest scope note, not a bug)

The reusable rig models each op as its OWN single-op log (`sourceLogKeyHex` per op). In
that model the per-pass budget (`maxOpsPerPass`) can NEVER defer an op (every log is
length 1), so the multi-pass merge + the del-transient are unreachable. AG therefore
ALSO folds the op universe into **one append-only log per author** (`byAuthorLogs`) —
the production shape — so a small budget creates REAL backlog. The del-transient is then
genuinely observable (an intermediate pass shows a row the fixpoint removes) and the
fixpoint provably equals the one-shot fold. This is the only PG-free way to exercise the
documented multi-pass path.

## Coverage boundary (PG-free here ↔ existing integration there)

AG's PG-free layer audits the **merge engine + the guard's ordering logic** fast, on
every unit run. The **PG-row-level** LWW guard (the second correctness floor — actual
`ON CONFLICT`/`DELETE WHERE`, the EI-117 `EXCLUDED`-side-NULL hole, the no-tombstone
re-insert against real rows) is covered by the existing integration suite, which AG
relies on and does not duplicate:

- `packages/operator-core/lib/sync/hyperbee/projections/__tests__/fed-ts-lww-guard.integration.test.ts`
  ("post-cursor-reset double-apply safety")
- `…/ei117-replay-revert-guard.integration.test.ts`

**Recommendation (S2, additive):** the merge docblock warns "A NEW projection MUST copy
this [LWW guard] shape or reset replays will clobber." That contract is enforced only by
the per-projection integration tests + code review — there is no single guard that fails
if a newly-registered mutable projection ships WITHOUT the `fed_ts`/`fed_hlc` LWW guard.
A registry-level assertion (every mutable projection's writer carries the guard, à la
the `PEER_LOG_TAG_TO_TABLE` bijection check) would make the P-068 floor (2) un-bypassable
for future projections. Filing as an EI.

## Done / verdict

🟢 **GREEN.** Double-apply, replay-from-any-cursor, reorder-within-LWW, duplicate
delivery, cursor-reset (incl. the bounded del-transient), and determinism are all proven
idempotent + deterministic across the seed sweep at the merge-engine level, with the
PG-row floor covered by the cited integration suite. No non-idempotent step found.
