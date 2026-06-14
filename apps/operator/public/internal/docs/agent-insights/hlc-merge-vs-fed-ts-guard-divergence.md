# HLC merge order must match the PG fed_ts LWW guard (or cells diverge)
URL: /internal/docs/agent-insights/hlc-merge-vs-fed-ts-guard-divergence

Why two federated cells can "converge" to DIFFERENT values — the merge winners-fold orders by HLC (P-010) but the projection PG LWW guard orders by fed_ts, and HLC stamped at DRAIN disagrees with fed_ts stamped at WRITE. Fix - seed the HLC from the op's own write-time `ts`.

## What

A federated write goes through **two** ordering decisions, and they must agree:

1. **The merge winners-fold** (`read-merge.ts` `mergeAdmittedLogsIncremental` →
   `lwwPick`/`beatsStored`) — since P-010 this orders by the op's **HLC** when
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
so causality (the RECV-seam `observeRemoteHlc` advance) is preserved. Now the
merge's HLC order matches the PG guard's `fed_ts` order → no silent rejection.

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
