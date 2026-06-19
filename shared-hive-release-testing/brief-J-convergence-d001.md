# Brief J — D-001: LWW peers diverge under clock skew (the hard S0)

**Priority: S0 lane** — the critical path to release. Integration + a migration +
all-projection change. No product decision needed; this is engineering.

## Objective
Make federated LWW **converge under clock skew** by giving every federated row a
single ordering key of record — the **HLC tuple, in Postgres** — and changing every
projection's conflict guard to compare it. Gate on the skew sweep going green while
monotone + the full federation suite stay green.

## Why it matters for release
Independent machines have skewed clocks — the *normal* case. Today the merge fold
(`read-merge.ts beatsStored ≡ lwwPick`) orders by **HLC**, but every mutable
projection's PG guard (`ON CONFLICT … WHERE EXCLUDED.fed_ts >= stored.fed_ts`,
`fed_ts` = wall clock — `projection.ts:249`, `harness-features.ts:140,212`) orders
by **`fed_ts`**. The recv-seam (`observeRemoteHlc`, `projection.ts:208`) decouples
the two orders, so the merge suppresses the HLC-loser while the PG guard rejects the
HLC-winner → **two honest peers materialize different rows for the same key,
permanently.** A single historical forward clock excursion raises the global HLC
floor and reaches it. This is non-convergence — the one hard S0 among the blockers.

## Constraints (lead-investigated — read before designing)
- **The shortcut is RULED OUT.** Making the merge order by `fed_ts`/`ts` instead of
  HLC loses HLC's causal ordering (a write that observed a remote op is ordered
  causally-after it; `hlc-stamp.ts`, P-010). The fix must keep HLC as the key.
- **Two viable fixes, both empirically validated** (su-75f52): (a) carry an `hlc`
  column to the PG guard, OR (b) derive `fed_ts` from `packHlc`. The skew sweep
  converges under an `lwwPick`-ordered guard, diverges under `fed_ts`.
- **Write-time assignment is required.** HLC is assigned only at the drain/append
  seam (`boot.ts:1465`), so a local write's PG row carries **no** hlc. Both fixes
  must move HLC assignment to **write-time** so the local row has the key too.
- Back-compat for pre-P-010 rows that have no HLC (fall back to `fed_ts` for those).

## Scope / scenarios
1. **Migration:** add the HLC tuple (physical, counter) to every federated mutable
   table (or a derivation that makes `fed_ts` carry it). Migrate 000→head clean.
2. **Projection guards:** change every `WHERE EXCLUDED.fed_ts >= stored.fed_ts` to
   compare the HLC tuple, with the pre-P-010 fallback.
3. **Write-time HLC:** stamp HLC when the local row is written, not only at drain.
4. **Convergence gate:** `convergence-fuzz.test.ts` skew sweep flips from `it.fails`
   to passing; the monotone case stays green; `lww-hlc-fedts-divergence.*` green;
   the full 862-test hyperbee suite no-regression.
5. **Live skew test:** on a 2-instance pair, set the two embedded clocks skewed,
   write conflicting LWW on the same key both sides, assert both peers converge to
   the **same** row.

## Method
- Reuse `_convergence-fuzz-rig.ts` (the seeded fuzz harness — monotone GREEN, skew
  finds it). SET-semantics assertions; never re-fold counts.

## Deliverables
- `findings-J.md`: the chosen ordering-key design, the migration, the gate matrix,
  the live skew witness.
- The migration + all-projection guard change + the now-green skew sweep.

## Done / verdict
GREEN only when the skew sweep converges, monotone stays green, the full federation
suite is green, and the live clock-skew pair converges to one row.
