# Brief W — Performance, throughput & resource-leak at scale

**Priority: S1 lane (S0 if a leak/OOM).** Bench + soak. No perf testing exists today.

## Objective
Establish that shared-hive federation is **performant and leak-free under sustained
load**: bounded memory/CPU/disk over hours, acceptable throughput + latency at write
volume, and that log/outbox growth is compacted — not unbounded.

## Why it matters
There is **zero** perf/leak coverage. And the failure mode is proven real: the
EI-126 unbounded-outbox class hit **102 GB / hours** when drain mis-routed, and bg-host
**OOM-self-recycled at 3.2 GB** THIS session. A public hive that leaks memory/disk or
degrades under a busy team is a release-blocker that correctness tests never catch.
The peer-log also grows unbounded without compaction (P-009 flagged `replayCostOps`).

## Scope / scenarios
1. **Sustained write throughput:** drive N writes/sec across content types for a long
   window; measure federation latency p50/p95/p99, ops/sec ceiling, and that it stays
   converged. Find the throughput where latency degrades.
2. **Memory/CPU soak (hours):** keep a hive federating under steady load; sample RSS +
   CPU over time; assert NO monotonic growth (leak). (bg-host OOM'd — watch the drain/
   merge/projection paths + corestore handles.)
3. **Disk / outbox / peer-log growth:** assert `substrate_outbox` drains (no
   drained_at=NULL accumulation), and the peer log + corestore don't grow unbounded —
   compaction shrinks `replayCostOps` (P-001/P-002). The EI-126 class must be bounded.
4. **Big-hive backfill:** a hive with a LOT of history (10k–100k ops) — a fresh joiner's
   backfill time + memory; assert it completes + the fold stays trivial after (the
   merge-scaling idle-tick guard).
5. **Many concurrent hives/harnesses per box:** resource scaling (FDs, ports, memory)
   as hive count rises (2 → 10 → 50); find the ceiling.

## Method
- **k6** (HTTP write driver) + **Vitest bench** (`*.bench.ts`) for micro-paths
  (merge/projection/drain), **nightly-only** (never per-PR). Soak via a long-running
  rig with RSS sampling. Reuse `merge-scaling` / `_hive-substrate-rig`. `log()` any
  cap/sampling. Verify outbox drain + log size via embedded PG / corestore stats.

## Deliverables
- `findings-W.md`: throughput/latency curves, soak RSS trend (leak or flat), outbox +
  peer-log growth-vs-compaction, big-hive backfill numbers, the per-box hive ceiling.
  Any leak/OOM/unbounded-growth = S0/S1 with repro.

## Done / verdict
GREEN only when federation sustains realistic load with bounded memory/disk (no leak),
acceptable p95 latency, outbox + peer-log stay compacted, and big-hive backfill completes.
