# Brief N — N-peer (3+) scale, churn & backfill-at-size

**Priority: S1 lane.** Integration (no product decision). Mostly rig-based — the box
has only **2 gh identities**, so the live path tops out at 2 real peers; go beyond 2
in the rigs.

## Objective
Push federation past the happy 2-peer pair: **3+ peers**, **join/leave churn under
load**, and **backfill at size** (hundreds of rows), asserting convergence, no
loss/dup, and monotonic watermarks throughout.

## Why it matters for release
The live proof and most integration coverage is 2-peer. A public hive is N-peer with
members joining/leaving while writes flow. Brief F proved resilience GREEN for
reconnect/backfill/outbox-failure at small scale, but N-peer breadth + churn-under-
load + large backfill were not systematically swept. Scale bugs (cursor resets,
watermark regressions, backfill truncation) hide until peer count and row count grow.

## Live constraint (read before launching a 3rd live instance)
A 3rd live instance that reuses the **owner's** gh identity **corrupts admission**
(it aggregates the wrong same-identity log → nothing crosses; observed, findings
A-NOTE). So the **live** path is 2 distinct identities only. For 3+ peers use the
integration rigs (`composition-rig.ts` `bootCompositionRig`, `_cross-peer-rig.ts`,
`_hive-substrate-rig.ts`) with a local DHT (`createTestnet`), or container peers if
a 3rd identity is provisioned.

## Scope / scenarios
1. **3–5 peer fan-out:** owner + N joiners; every federating content type crosses to
   ALL peers (backfill for late joiners + incremental), `origin=remote` everywhere.
2. **Join/leave churn under load:** peers join and leave repeatedly while writes
   flow; assert no loss/dup, watermarks monotonic, and a re-joiner re-backfills
   correctly (no double-apply, no cursor reset eating rows).
3. **Backfill-at-size:** seed hundreds of rows across types on the owner, then a
   fresh joiner — assert the FULL set backfills (not a truncated/top-N slice), within
   a bounded time, with set-semantics assertions (assert which ids land, never
   re-fold counts).
4. **Watermark monotonicity under churn:** across all of the above, watermarks never
   regress on any peer.

## Method
- `vitest.integration.config.ts` + the N-peer rigs; extend
  `three-peer-partition-rejoin` / `cross-peer-coordination-scale` /
  `merge-scaling` to more peers + more content types. Deterministic seeds (no
  `Math.random` — vary by index/args). Teeth-verify each new assertion.

## Deliverables
- `findings-N.md`: the N-peer matrix (peers × type × {backfill, incremental,
  re-join}), churn results, backfill-at-size latency + completeness, any
  non-convergence/loss (S0/S1).
- Reusable N-peer + churn rigs for regression.

## Done / verdict
GREEN only when 3+ peers converge across all content types under join/leave churn,
large backfill is complete (not truncated), and watermarks stay monotonic throughout.
