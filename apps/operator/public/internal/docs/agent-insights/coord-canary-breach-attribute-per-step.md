# Coord-canary SLO breach: attribute per-step before optimizing — a slow INSERT ≠ a slow read
URL: /internal/docs/agent-insights/coord-canary-breach-attribute-per-step

When the coord-probe-canary breaches its cycle SLO, read each step's latency before picking a culprit. EI-401 was 'fixed' by optimizing a read path (readAckedMsgIds full-table scan) — but the breach numbers showed the full-table READ (inbox, 477ms) was fine while a pure single-INSERT step (ping, 12.9s) and the ack INSERT (~9s) dominated. The probe carries harness_slug=NULL so its insert is minimal (one row + one pg_notify) — a minimal insert taking 12.9s is EXTERNAL contention: NOTIFY-queue commit serialization across the fleet + substrate_outbox capture cost + pool/IO pressure. Optimizing the read neither explains nor prevents a write-contention breach.

## The mistake this prevents

`system:coord-probe-canary` (coord-system-e2e P-012) files an EI when its
ping → inbox → ack → lock cycle blows the 10s total SLO, and the issue body
**lists per-step latencies**. EI-401 breached at 23108ms and was resolved by
optimizing `readAckedMsgIds` (it loaded the whole `messages` surface and filtered
acks in JS). Reasonable-sounding — but wrong as the breach driver, and the
per-step numbers said so:

```
✓ ping  12895ms   ← sendMessage = ONE INSERT, no reads at all
✓ inbox   477ms   ← readInbox = full readLines('messages'), ALL ~6000 rows
✓ ack    9648ms   ← appendAck (INSERT) + readAckedMsgIds (the read that was "fixed")
```

`inbox` does the *exact* full-table read the fix targeted, over every message
row, in **477ms**. So the read was never the bottleneck. `ack`'s 9.6s is its
**INSERT**, and `ping` is a pure INSERT at **12.9s**. \~22s of the 23s cycle was
write latency.

## Why a tiny insert stalls for seconds

Probe messages carry `harness_slug = NULL`, so the `capture_substrate_outbox`
AFTER-INSERT trigger **does not fire for the probe's own insert** (verify:
`SELECT writer_key, count(*), count(harness_slug) FROM
harness_shared.coord_event_log WHERE writer_key LIKE 'coord-probe-canary-%'
GROUP BY 1` → `with_slug = 0`). The probe insert is therefore minimal: one row +
the unconditional `notify_coord_event_log` → `pg_notify('coord_inbox', …)`. A
*minimal* insert taking 12.9s is **external contention**, not anything in the
coord code the probe exercises:

* **NOTIFY-queue commit serialization.** Every `coord_event_log` insert
  pg\_notify's `coord_inbox`; every federated (harness-slugged) fleet message
  *also* inserts into `substrate_outbox` (multi-GB) and pg\_notify's
  `substrate_outbox`. Postgres serializes async-notify delivery at commit, so
  under a fleet write spike a tiny insert waits behind the whole fleet's
  commit+NOTIFY traffic.
* **Pool / IO pressure** from the same spike (`max_connections` is 100; the
  always-on fleet also hammers `route_invocations`, `substrate_outbox`).

When you investigate later the box is usually calm
(`SELECT pg_notification_queue_usage()` ≈ 0, conns well under max), so the
breach is **not reproducible on demand** — which is itself the tell of a
transient peak-load event. That is the canary doing its job: coord writes
genuinely spiked to \~10–13s under load.

## What to do

1. **Read the per-step latencies first.** A pure-INSERT step (`ping`) being slow
   while the full-table-read step (`inbox`) is fast ⇒ the bottleneck is write
   commit/NOTIFY/IO contention, not a read algorithm. Don't reflexively optimize
   the read.
2. A read-path optimization can still be correct hygiene (the `readAckedMsgIds`
   pushdown was — it ships \~250 rows instead of \~6000) — just don't mistake it
   for resolving a write-contention breach. Pair any such fix with the
   integration test for its new SQL path
   (see [coord-module-integration-test-fixture](/internal/docs/agent-insights/coord-module-integration-test-fixture)).
3. Real fixes for the write side are load-bearing federation/wake infra (coalesce
   the `coord_inbox` NOTIFY, review the `substrate_outbox` capture on the hot
   path, or widen the SLO for a shared dev box) — owner decisions, not
   drive-by edits.
