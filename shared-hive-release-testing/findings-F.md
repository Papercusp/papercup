# Findings F — Resilience, recovery & scale

**Lane:** Brief F (S1). **Author:** su-c690a. **Date:** 2026-06-19.
**Method:** integration + the merge-core driver, all new tests teeth-verified
(write green → neuter the invariant → confirm RED → restore → confirm GREEN).
No live-instance harness needed (pure integration/perf).

## Verdict: **GREEN** (ready) — with three documented, non-blocking caveats

Reconnect, restart/cold-boot, long-offline backfill, and outbox-failure all
converge with **no loss**; the stale-reclaim bound holds; scale numbers are
strong (idle merge stays ~0.01 ms at 16 peers / 800k ops); and schema-skew is
**known and safe** for rolling public upgrades (old peers drop + alert newer
ops without corruption; upgraded peers recover dropped ops via the restart's
fresh-cursor re-fold). One stale, load-bearing doc comment was found and **fixed
in-lane**, with a regression guard added. No S0/S1 found in this dimension.

> Cross-lane note: Lane A reported an **S0 in the packaged `.deb`** (does not
> boot — luxon `createRequire` not bundled). That is a packaging blocker for the
> release as a whole, but it is **not** a resilience-substrate finding and is
> out of this lane's scope.

---

## Resilience matrix

| # | Scenario | Status | Evidence |
|---|----------|--------|----------|
| 1 | **Reconnect** (kill/restore swarm repeatedly) | 🟢 GREEN (caveat) | `swarm-chaos.test.ts` ✅ live — 6 seeded kill/reconnect rounds over a **real DHT**, converges with no loss/no dup, admission + mid-session revocation stay enforced. Caveat C1 below. |
| 2 | **Restart / cold boot** (kill mid-sync, reboot) | 🟢 GREEN | **NEW** `cold-boot-resume.test.ts` ✅ (teeth-verified) — persisted own log survives the restart (same key + length read from disk), fresh-cursor re-fold re-applies the **identical winner set** (no loss/corruption, del still wins), revocation set **re-seeds from its loader on boot**, idle skip survives the restart. |
| 3 | **Long-offline catch-up / backfill** | 🟢 GREEN | **NEW** `multi-peer-scale.test.ts` (50k-op-gap rejoin) ✅ — full backfill then **10 idle ticks decode/apply 0**; extends existing `merge-scaling.test.ts` (20k, own-log) to a large remote gap. |
| 4 | **Outbox drain exactly-once under failure** | 🟢 GREEN | `outbox-drain.integration.test.ts` ✅ live (15) + 6 more seams. `drained_at` is the idempotency anchor — set **only after** the hypercore append succeeds; a crash between append and `drained_at` re-appends on restart (at-least-once at the log) but the projection apply is **fed_ts-LWW idempotent**, so it lands **exactly-once at PG**. Stop-on-error, fan-out isolation, coalescing, bounded GC, stress-convergence all covered. |
| 5 | **Stale-reclaim / dead-letter bound** | 🟢 GREEN | `work-items-stale-claims.integration.test.ts` ✅ live (22). cap=3 (env-overridable): a dead holder's mid-flight item requeues to `todo` up to the cap, then **dead-letters to `blocked` with requeue_count≥cap**; `blocked` is never requeued again → **no poison loop**. Alias-aware liveness (coord_presence ∪ RUNNING spawned_agents) + `FOR UPDATE SKIP LOCKED` re-check (no double-bump). |
| 6 | **Scale** (8–16 peers, 10k–50k ops) | 🟢 GREEN | **NEW** `multi-peer-scale.test.ts` ✅ (teeth-verified). Numbers below. Convergence exact (winner-map size = Σ distinct keys); idle tick **O(#logs), not O(history)** — stays 0.01–0.03 ms at every scale. |
| 7 | **Schema-version skew** (adjacent versions, rolling upgrade) | 🟢 GREEN (constraint) | **NEW** `schema-skew-rolling-upgrade.test.ts` ✅ (teeth-verified) + `version-gate-merge.integration.test.ts` ✅. Safe + recoverable; one stale doc fixed. Detail + constraint C2 below. |

---

## Measured scale numbers (Scenario 6)

Driving the **production merge core** (`mergeAdmittedLogsIncremental` — the exact
function boot.ts calls every tick) over N synthetic peer logs, ~50% re-writes per
key (real LWW fold work). Single-host, deterministic; isolates merge CPU/memory/
fold cost (WAN convergence latency is additive — see C3).

| peers × ops/peer | total ops | backfill | **idle tick** | decoded (backfill) | winners (distinct keys) | RSS Δ (winner map) |
|---|---|---|---|---|---|---|
| 8 × 10k | 80k | 142 ms | **0.03 ms** | 80,000 | 40,000 | +31 MB |
| 16 × 10k | 160k | 214 ms | **0.01 ms** | 160,000 | 80,000 | +30 MB |
| 8 × 50k | 400k | 599 ms | **0.01 ms** | 400,000 | 200,000 | +76 MB |
| 16 × 50k | 800k | **1,059 ms** | **0.01 ms** | 800,000 | 400,000 | +105 MB |
| 1 × 50k (offline-rejoin, S3) | 50k | 47 ms | 0.01 ms | 50,000 | 8,000 | +5 MB |

**Reads:**
- Backfill is **linear in total ops** (~0.75M ops/s on this host) — a one-time
  cost paid once per cold boot / fresh join, then never again.
- The **idle tick is flat at ~0.01 ms regardless of history** (16 peers / 800k
  ops). This is the EI-79 invariant — the 1 Hz production poll costs O(#logs),
  not O(total-history). "Merge stays ~idle when nothing changed" is met decisively.
- Memory is **~275 bytes per distinct live key** in the standing winner map
  (400k keys → +105 MB). Linear in distinct keys, not in op-history. Fine for
  expected hive sizes; very large public hives are the snapshot-compaction path's
  job (flag-gated today).

---

## Schema-skew finding + the one fix made in-lane (Scenario 7)

**Behavior (verified against `boot.ts` `versionGatedLog` + `read-merge.ts`
`mergeAdmittedLogsIncremental` + `schema-version.ts`):**

- An op with `schema_version > known` is dropped by the gate (`get()` → `null`)
  and the merge **advances the cursor past it** (read-merge.ts: `if (!op)
  continue; // version-gated drop — advance past it`), firing one
  "upgrade available" alert per (slug, version). No corruption, no partial apply.
- The merge cursor is **in-memory and never persisted**; boot.ts creates a
  **fresh** cursor every boot. So "resume" is a full idempotent re-fold from 0.
- **Therefore rolling upgrades are SAFE:** an old peer drops + alerts a newer
  peer's op; when it **upgrades (= new build = process restart)**, the fresh
  cursor re-folds the whole log with the now-higher `known` and the previously-
  dropped op **applies → recovered, no permanent loss.** Forward-compat
  (upgraded peer applying an old peer's older ops) holds trivially (`older ≤ known`).

**The catch (a latent footgun, fixed in-lane):** that safety rests on an
**implicit, previously-undocumented invariant** — *the known schema version can
only rise via a process restart.* The `schema-version.ts` header doc described an
in-session writer `notedHigherSchemaVersion(...)` that **does not exist** (never
built). If anyone implemented in-session version learning (raise `known` without
a restart) **without resetting the merge cursors**, every op gate-dropped earlier
in that session would be lost permanently — a latent S0-shaped trap, dormant only
because the writer doesn't exist.

**Fixed (clearly in scope, comment + test only — zero behavior change):**
1. Rewrote the `schema-version.ts` header to state the invariant explicitly and
   warn that any future in-session version learning **must reset every live merge
   cursor**.
2. Added `schema-skew-rolling-upgrade.test.ts` Phase 3 as the **regression guard**:
   it asserts that raising `known` without a cursor reset leaves the dropped op
   lost — so if someone wires the trap, this test goes red.

Severity of the as-found state: **S2-minor (latent)** — not a live bug (the real
upgrade path is a restart and is safe), but a documentation/contract gap that
invited a future S0. Now closed.

---

## Gaps left open (caveats — none release-blocking)

- **C1 (Scenario 1):** `swarm-chaos` asserts convergence **once after all churn**
  and no-dup, with revocation enforced under churn — but not **per-cycle** "no
  missed ops", and presence/heartbeat recovery is implicit in convergence, not an
  explicit assertion. *Recommend* a follow-up extending the real-DHT rig to assert
  per-cycle no-missed-ops + an explicit heartbeat-recovery check. Not blocking:
  the strong properties (no-dup, final convergence, revocation-under-churn) hold.
- **C2 (Scenario 7):** the **snapshot-compaction × schema-skew** interaction is
  untested — an upgraded peer recovering a gate-dropped op whose log prefix was
  later compacted behind a `__snapshot__` op (so the fresh cursor seeds *past* the
  dropped index). Recovery should still hold via the snapshot's reconstituted
  rows, but it is unverified. Snapshots are **flag-gated** (off by default), so
  this is only relevant if snapshot compaction ships enabled. *Recommend* a test
  before enabling snapshots in a public release.
- **C3 (Scenario 6):** the scale numbers measure the **merge core** (CPU/memory/
  fold) over synthetic logs — not WAN replication/convergence latency. That
  latency is additive and is exercised by the perf rig's netem scenarios + the
  live lanes (A/E). The merge core is the scale-critical piece; this bounds it.

## New tests added (all teeth-verified)

- `packages/operator-core/lib/sync/hyperbee/__tests__/schema-skew-rolling-upgrade.test.ts` (4)
- `packages/operator-core/lib/sync/hyperbee/__tests__/cold-boot-resume.test.ts` (1)
- `packages/operator-core/lib/sync/hyperbee/__tests__/multi-peer-scale.test.ts` (5)

## Source change (in-lane, low-risk, comment-only)

- `packages/operator-core/lib/sync/hyperbee/schema-version.ts` — corrected the
  stale header doc (removed the non-existent `notedHigherSchemaVersion`; documented
  the restart-recovery invariant + the cursor-reset requirement for any future
  in-session learning).
