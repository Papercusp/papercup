# Findings AC — Clock/time CHAOS & HLC internals robustness

**Owner:** su-860d3 · **Date:** 2026-06-19 · **Verdict: 🟢 GREEN (HLC core + convergence
under chaos)**, with the heavy real-PG/real-clock integration scenarios DEFERRED (box
was overloaded; PG-free layer landed first — see "Coverage boundary").

## TL;DR

The HLC clock-of-record (`HlcClock` + `fed_hlc`, mig-314) — the load-bearing S0 LWW
ordering fix D-001 shipped, and now the C-001 re-key key-ordering key — stays **monotone
and convergence-preserving under clock CHAOS** D-001's static-skew test assumed away:
a clock running BACKWARDS, NTP steps (both directions), the 16-bit logical counter at
overflow, same-physical-ms ties, and chaotic per-author clocks driving federation. No
monotonicity break, no divergence, no counter corruption found.

**Deliverable:** `packages/operator-core/lib/sync/hyperbee/__tests__/clock-hlc-chaos.test.ts`
— 12 fast-check/exhaustive property + unit tests, **PG-free**, ~1.7s (the 65k-send
counter-overflow sweep is the one heavy case). Reuses Brief D's `FedTsGuardedStore` +
the REAL `HlcClock`/`stampOpHlc`/`observeRemoteHlc` seams without editing any shared file.

## Properties (all GREEN)

| # | Property | What it proves |
|---|----------|----------------|
| AC.1 | **Monotonicity under chaos** — `send()` strictly increases for ANY chaotic physical sequence (backwards jumps + NTP steps); explicit down-then-up step never regresses `ms` | the core HLC guarantee; a backwards clock cannot resurrect a stale write |
| AC.2 | **Counter overflow** — >`HLC_MAX_COUNT` sends in one physical ms carry `ms` forward, never exceed the 16-bit ceiling, never collide; `recv` at the ceiling carries too | the 65 536-ops-per-ms wrap is safe, not corruption |
| AC.3 | **recv dominance** — `recv(remote)` ≥ local, ≥ remote, ≥ physical, and a later `send()` strictly follows | the cross-machine happens-before that makes ordering causal, not skew-dependent |
| AC.4 | **encode sort-consistency** — string compare of `encodeHlc` has the SAME sign as `compareHlc`; `decode∘encode` exact; `pack/unpack` round-trips; malformed → `HLC_ZERO` (never throws) | **foundational**: `fed_hlc` is a TEXT column ordered by string compare, so this IS what makes the production PG LWW guard order causally |
| AC.5 | **Convergence under clock chaos (S0 core)** — ops stamped on per-author clocks with chaotic physical time, folded in two distinct delivery orders via the REAL merge + shipped `fed_hlc` guard, converge to identical state; the recv seam advances past a remote frontier | D-001's convergence guarantee survives backwards/stepped clocks — divergence here would be the brief's headline S0 |
| AC.6 | **Teeth** — a clock without the physical-vs-logical monotone carry REGRESSES under a backwards step | proves AC.1 isn't vacuous (the exact failure mode it forbids goes RED) |

## Why GREEN (the mechanism)

`HlcClock.send()` is `pt > last.ms ? {ms:pt,count:0} : bumpCount(last)` — a backwards or
stepped physical clock can never lower `ms`; it only bumps the logical counter, which
`bumpCount` rolls into `ms+1` at the 16-bit ceiling. `recv()` takes `max(local, remote,
physical)` then bumps, so it dominates all three. `encodeHlc`'s fixed-width
`"<15-digit ms>:<5-digit count>"` makes lexical string order equal `compareHlc` — the
single fact that lets the `fed_hlc` text column be ordered correctly by Postgres. All
verified by property sweep, not by inspection.

## Coverage boundary (PG-free landed ↔ integration deferred)

This is the **PG-free core layer** (the HLC math + the merge-fold convergence), authored
first because the box was overloaded (load ~50–66 during the A-003 witness/re-key runs)
and this layer adds negligible load (~1.7s). The following AC scenarios are
**INTEGRATION** (real embedded-PG + the live clock seam) and are DEFERRED — they belong
on a calm box and partly overlap other lanes:

- **Long-drift SOAK** (AC scenario 5, full): two real peers, continuously drifting clocks
  over a long run, asserting no unbounded counter growth on the live `fed_hlc` column.
  (The PG-free AC.2 already proves the counter is bounded per-tick; the soak is the
  end-to-end confirmation.)
- **Mixed pre-314 / no-HLC rows under chaos** (AC scenario 6) — the back-compat `fed_ts`
  fallback under clock chaos, **ties directly to Brief Y (version-skew)** — recommend it
  lands with Y to avoid duplication.
- **Real `_setNowForTests` / wall-clock integration** through the actual capture→drain→PG
  path (vs the PG-free fold model here).

These do not change the verdict on the HLC core; they are the end-to-end confirmations.

## Done / verdict

🟢 **GREEN at the HLC core + federation-fold level.** Monotonicity holds under backwards
clocks, NTP steps, counter overflow, and same-ms ties; the encode ordering is provably
causal; federation converges under chaotic clocks. No S0/monotonicity break found.
Integration soak + the pre-314 back-compat-under-chaos case are deferred (calm-box /
Brief Y co-land) and tracked here. Complements my Brief AG (idempotency/replay) — AC
proves the HLC ordering key AG's properties assume.
