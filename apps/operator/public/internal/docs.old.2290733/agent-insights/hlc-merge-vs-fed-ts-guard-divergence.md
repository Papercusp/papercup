# HLC merge order must match the PG fed_ts LWW guard (or cells diverge)
URL: /internal/docs/agent-insights/hlc-merge-vs-fed-ts-guard-divergence

Why two federated cells can "converge" to DIFFERENT values — the merge winners-fold orders by HLC (P-010) but the projection PG LWW guard orders by fed_ts, and HLC stamped at DRAIN disagrees with fed_ts stamped at WRITE. Fix - seed the HLC from the op's own write-time `ts`.

## What

A federated write goes through **two** ordering decisions, and they must agree:

1. **The merge winners-fold** (`read-merge.ts` `mergeAdmittedLogs`, whose
   `beatsStored` comparator — defined in `read-merge.ts` as a hand-mirror of
   `projection.ts`'s `lwwPick` — decides winners) — since P-010 this
   orders by the op's **HLC** when
   both ops carry one, else falls back to wall-clock `ts`.
2. **The PG projection LWW guard** (`harness-features.ts` etc.) — the
   `INSERT … ON CONFLICT … WHERE stored.fed_ts IS NULL OR EXCLUDED.fed_ts >=
   stored.fed_ts` clause — orders by **`fed_ts`**.

If these two disagree under same-key contention, the system **silently
diverges**: the merge picks op X as the winner and hands it to `apply`, but the
PG guard rejects X (its `fed_ts` lost) → no write → the cell keeps its own
value. Each cell keeps its own → the two cells "converge" (no more ops to
drain, `fixedPoint=true`) to **different** values. The tripwire was
`split-brain-queen.integration.test.ts` (both Queens steer opposite orders;
cell A ended with a mix, cell B with all-its-own).

## Why they disagreed

* **`fed_ts`** is stamped at the **local write** (migration 214
  `stamp_local_federated_write`, `clock_timestamp()`).
* **HLC** was stamped at **DRAIN** (`stampOpHlc` in `hlc-stamp.ts` called from
  `boot.ts`'s `handle.append`, using a bare `clock.now()` = wall-clock-at-drain).

Drain happens later than — and in a different order than — the writes (the CDC
outbox drains in batches, concurrently across cells), so the HLC ordered ops by
**drain-interleave** while `fed_ts` ordered them by **write time**. An op could
win the HLC fold but lose the `fed_ts` guard.

## Fix

Seed the HLC's physical component from the op's **own recorded write-time `ts`**
(the outbox row's capture `ts`, ≈ `fed_ts`), not the wall clock at stamp time:

```ts
// hlc-stamp.ts
export function stampOpHlc(op, clock = processHlc()) {
  if (op.hlc) return op;
  return { ...op, hlc: encodeHlc(clock.now(op.ts)) }; // was clock.now()
}
```

`HlcClock.send(physicalNow)` is built for exactly this ("seed from an event's
own recorded ms") and stays monotone via `bumpCount` when `ts` is in the past,
so causality (the RECV-seam `observeRemoteHlc` advance) is preserved. The
merge's HLC order matches the PG guard's `fed_ts` order → no silent rejection
**FOR THE DRAIN-INTERLEAVE CASE**.

> ⚠️ **This 2026-06-14 patch was INCOMPLETE (it closed only the drain-interleave
> trigger) and was later REOPENED then fully RESOLVED — see "## REOPENED (D-001)"
> and "## RESOLVED" below.** Seeding the HLC from `op.ts` only guarantees
> `HLC.physical ≥ op.ts` for the SAME op. It does NOT make the HLC ORDER of two
> CONCURRENT ops match their `fed_ts` order, because the RECV-seam advance this
> patch DELIBERATELY PRESERVES raises a peer's clock ABOVE a later write's `ts`
> (`send(ts)` returns `max(clock.physical, ts)`). The split-brain was still
> reachable until the D-001 ordering-key fix shipped.

## Gotchas when reproducing in a rig

`composition-rig.ts` simulates **two swarms in ONE process**. Real swarms are
separate processes with **independent** HLC clocks, but the rig shared the
process-global `processHlc()` singleton — so the two cells' concurrent drains
raced the same counter and decided cross-swarm LWW by drain-interleave. Give
each cell its **own** `HlcClock` (gated `hlcClock` seams on `boot.ts`
`BootHarnessOpts`, `projection.ts` `ApplyOpOpts`, `hlc-stamp.ts`; default
`processHlc()` so production is unchanged). See
\[\[substrate-hlc-and-capture-coverage]] and
\[\[two-federation-paths-cannot-share-one-fed-ts]].

## Smell test

If two federated cells end a converge() with DIFFERENT values for the same key
(and `fixedPoint=true`), suspect an ordering-key mismatch between the merge fold
and a projection's PG LWW guard — they must use the SAME key.

## REOPENED (D-001, 2026-06-19, shared-hive-release-testing Brief D)

The 2026-06-14 fix closed the **drain-interleave** trigger but NOT the root
cause: the merge fold orders by **HLC** and the PG guard orders by **fed\_ts =
op.ts**, and these are still two different clocks. Seeding HLC from `op.ts` makes
`HLC.physical ≥ op.ts` for one op, but the RECV seam (`observeRemoteHlc`, kept on
purpose) advances a peer's `HlcClock` ABOVE a later write's `ts`. Then:

* Winner **W**: its author observed a remote op at HLC.physical = 9000 (recv
  advance), then wrote KEY at wall `ts = 1000` → HLC `(9000,·)`, **fed\_ts 1000**.
* Loser **L**: a fresh-clock peer wrote KEY at `ts = 5000` → HLC `(5000,0)`,
  **fed\_ts 5000**.

`lwwPick`/`beatsStored` pick W (higher HLC); the PG guard prefers L (higher
fed\_ts). The merge SUPPRESSES the HLC-loser once the HLC-winner is the standing
winner, and the PG guard REJECTS the HLC-winner when its fed\_ts lost — so the two
authors materialise different rows and never reconcile:

* W's author folds W first → PG = W; L arrives, beatsStored(L,W)=false → suppressed.
* L's author folds L first → PG = L; W arrives, handed to apply → `WHERE
  EXCLUDED.fed_ts(1000) >= stored.fed_ts(5000)` is FALSE → rejected → PG stays L.

**Reachability:** HLC.physical is monotone and propagates the GLOBAL-max wall-ts
seen anywhere (recv takes `max`). A single forward clock excursion on ANY peer
(NTP overshoot, fast VM, manual set) raises the HLC floor for everyone
permanently; thereafter any concurrent same-key writes whose wall-`ts` order
differs across peers can diverge. The window self-heals only once every peer's
wall clock advances past the floor.

**Why the green suite missed it (still):** `split-brain-queen` and the
composition rig share one wall clock (`physical: () => this.now()`), so they
can't construct recv-advance + skew. `three-peer-partition-rejoin` asserts
convergence at the read-merge layer with a TEST-LOCAL ts-only LWW and an injected
sink — it exercises neither the HLC fold nor the PG guard, the two layers whose
disagreement IS the bug.

**Repro (current `staging`):**
`packages/operator-core/lib/sync/hyperbee/__tests__/lww-hlc-fedts-divergence.test.ts`
(fast, real merge + faithful guard), its `.integration.test.ts` twin (real PG
projection), and the seeded `convergence-fuzz.test.ts` (monotone sweep GREEN,
skew sweep finds it).

## RESOLVED (D-001 fix shipped)

The one-ordering-key-of-record fix landed. Migration
`314-d001-hlc-ordering-key.sql` adds a **`fed_hlc`** column to the mutable LWW
tables, and the projection PG guards now order by it (the HLC), with `fed_ts`
kept only as a fallback when a row predates the column — so the merge fold and
the PG guard finally use the SAME key. The HLC-winner can no longer be silently
rejected by a `fed_ts`-loser guard, so concurrent same-key writes converge to one
value across cells even under recv-advance skew. The seeded `convergence-fuzz`
suite asserts it: `S0 (D-001) FIXED: the skew sweep fully converges under the
shipped fed_hlc guard`
(`packages/operator-core/lib/sync/hyperbee/__tests__/convergence-fuzz.test.ts`).
The original `lww-hlc-fedts-divergence.test.ts` repro is now the regression
tripwire.
