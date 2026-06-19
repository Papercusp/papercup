# BRIEF — Infra fail-fast, fault-isolation & build-integrity (independent round-4)

- **Slug (proposed):** `infra-fail-fast-build-integrity-2026-06-19`
- **Author:** su (independent audit, owner-directed 2026-06-19) — operator console session
- **Lane:** prevent the *class* of failure behind today's `:3070` outage; stop a wedged
  subsystem from silently hanging a worker behind a green health check.
- **Stance:** COMPLEMENT, not fork. Themes A+B are my lane. Theme C is data-layer (offer to
  round-4). B3/B4 explicitly reconcile with round-3 (su-226ad, F9) + self-healing (su-67d39, D-001).
- **Method:** live telemetry + 5 parallel read-only audit agents, deduped against the shipped
  lineage (`operator-scalability-event-loop`, `backend-connection-scaling`,
  `infra-perf-robustness-audit-2026-06-18`, `infra-perf-reliability-audit-round3`,
  `infra-self-healing-supervision`, `perf-sweep-outbox-bloat`, `operator-memory-and-psu-resilience`).

---

## 0. Resolved live incident (owner-approved fix, DONE + verified)

`:3070` operator was DOWN (hang → connection-refused). **Root cause:** `papercup-release`'s
`better-sqlite3` native addon was built for Node 22 (ABI 127) while the service runs linuxbrew
**Node 25 (ABI 141)** — `mem0` failed to load (`Module did not self-register`) and every MCP/HTTP
handler that touched memory **hung forever** (never resolved), while systemd still reported
`active`. **Fix:** `prebuild-install` the ABI-141 `better-sqlite3` binary in `papercup-release`,
restart `papercup-dev-api.service`. **Verified:** health `200` (~1.3 ms), 0 mem0 errors since
restart, coord wakes flowing to all 6 named peers, fix survived an external 11:37 restart,
`NRestarts=0`. This brief turns that one-off fix into durable prevention.

**Two independent gaps combined to cause it:** (1) nothing rebuilt/verified native addons against
the runtime Node = the load-time failure; (2) the memory call path has no effective deadline +
the health probe exercises no subsystem = the failure became a silent infinite hang behind a
green check.

---

## Theme A — Build / release integrity (load-time cause) — all NEW (uncovered by any plan)

- **A1 [P0] Deploy-gate native-addon preflight.** After the green-release install, test-load every
  *runtime-relevant* native addon under the service's pinned Node; **fail the promotion** on any
  load failure. Must select only the loader-relevant binary (skip musl/other-platform alternates)
  to avoid false alarms (the scan below shows ~60 benign alternate-platform FAILs). Evidence:
  ABI-127 `better-sqlite3` shipped to green undetected.
- **A2 [P0] Boot self-check + fail-fast.** At `hono-host` boot, test-load critical addons
  (`better-sqlite3`/mem0, `zero-sqlite3`, `@lmdb`, `sodium`/`udx`/`rocksdb`) and **exit non-zero**
  on failure, so `Restart=always` surfaces a visible crashloop instead of an invisible hang.
- **A3 [P1] Pin runtime Node + kill PATH drift.** The unit PATH carries BOTH nvm Node 22 (ABI 127)
  AND linuxbrew Node 25 (ABI 141) — the drift that caused this. Drop nvm22 from the unit PATH,
  pin linuxbrew 25, add `.nvmrc`/`engines`, and run `npm rebuild`/`prebuild-install` against the
  pinned Node on every release refresh.
- **A4 [P2] Verify `lmdbx@0.5.0`** (no ABI-141 prebuilt found). If on a runtime path it's a latent
  `better-sqlite3`-class hang; rebuild or remove.

Addon scan (102 paths under Node 25, post-fix): all runtime glibc/x64 addons **OK**; FAILs are
benign musl/darwin/win/freebsd/arm alternates the loader never selects. Lone real gap: `lmdbx`.

## Theme B — Request-level fault isolation (silent-hang amplifier)

- **B1 [P0, NEW] Thread `AbortSignal` into the memory backend.** `agent-tools/memory/search.ts:120`
  calls `backend.search()` with no signal; `MemoryBackend` (`backend.ts:160-163`) has no timeout
  param; `canonical-store.ts` PG `client.query` is unguarded; the 60 s dispatch
  `AbortSignal.timeout` (`dispatch-stack.ts:401-415`) never reaches the backend. The 5 s
  `withTimeout` only guards the auto-injection seam, **not** `memory:search`/`memory:remember`.
  Fix: thread `ctx.signal` into `SearchOptions`/`RememberOptions` + honor it in canonical-store, or
  wrap each memory tool in the shared `withTimeout`+degraded-latch. *This is what made the outage a
  silent infinite hang.*
- **B2 [P1, NEW] Global inbound HTTP request timeout.** Set Node `server.requestTimeout` /
  `headersTimeout` + a host-level deadline on `/api/*` so a wedged non-MCP handler returns 503,
  not an indefinite hang. Only per-MCP `raceDeadline` + DB statement timeout exist today.
- **B3 [P1] Worker-thread/subprocess isolation for native/CPU memory+DB calls.** `raceDeadline`
  races a timeout but **never cancels `run()`**, so a synchronous native hang wedges the event loop
  and the timer can't even fire. Offload is the only real fix. COMPLEMENTS round-3 F9 (now_next) —
  reconcile with su-226ad; do not fork.
- **B4 [P1] Subsystem-exercising readiness probe.** `/api/health` is a static 200 exercising no
  subsystem → "active" while hung. Add deep `/health/ready` that round-trips PG + memory under a
  short timeout. COORDINATE with self-healing D-001 (su-67d39 owns the loop-saturation-survival
  angle); I contribute the subsystem-roundtrip angle.

## Theme C — Data-layer growth control (offer to round-4 / su-369b9)

- **C1 [P1, NEW] Complete the `papercup`→`papercusp` `harness_slug` rename.** Dual-slug doubles
  every federated write: `harness_plans` 502/501, `plan_revisions` 10133/10099,
  `substrate_outbox` 23789/2018 (byte-identical, both `origin=local`). Pick canonical, migrate
  revisions/outbox, drop legacy, add CHECK. Biggest single write-amplification lever.
- **C2 [P0, REGRESSED] `substrate_outbox` regrowth.** 27,883 rows / 114 MB, **22,145 undrained** —
  the prior 100 GB-incident table (`perf-sweep-outbox-bloat`). GC deletes only drained rows; drain
  is stalled (newest row today), driven by the xbench 400+ ephemeral-hive fleet + dual-slug. Drain
  backlog + GC-undrained-after-TTL + prune dead xbench/contract-test hive slugs.
- **C3 [P1, NEW] `coord_event_log` retention + autovacuum.** 138 MB heap, `last_autovacuum=NULL`,
  no cap on `escalations` (19 k) / `messages` (17 k). Add VACUUM + autovacuum tuning + retention.
- **C4 [P2, NEW] `plan_revisions` cap.** 20,315 rows / 405 MB full snapshots; cap N recent + delta/gzip.
- **C5 [P2, NEW] Drop ~3 GB unused `route_invocations` indexes** (`ws_time_idx` 2.4 GB, `idx_scan=0`,
  orphaned by F4 covering index) — confirm over one full 7-day retention window first.

## Theme D — Smaller reliability — NEW

- **D1 [P1] DBOS `durable-spawn fire papercup-hive/queen → HTTP 400`** recurs (4 workflow fails/2 h,
  each exhausting 3 retries). Fix the spawn payload/endpoint AND classify 4xx as non-retryable
  (stop retrying a 400 three times).
- **D2 [P2] Cluster workers bind `0.0.0.0:3070`** (not loopback) under `PAPERCUSP_CLUSTER=2` —
  off-box reachable, bypasses the P-027 loopback guard. Force `127.0.0.1` / confirm `PAPERCUSP_BIND_HOST`.
- **D3 [P3] `autovacuum_max_workers` 3 → higher** for 281 tables + 2 multi-GB churn tables.
- **D4 [P2] Graceful-shutdown / SIGTERM connection-drain** (deploy restarts vs in-flight requests).
- **D5 [P3] Disk/inode low-space tripwire** as a first-class signal (only one-time prunes exist).

---

## Sequencing

- **Immediate, reversible, no deploy:** C2 (drain/prune outbox), C5 (drop unused indexes after a
  retention-window confirm), D3 (autovacuum), A3-partial (drop nvm22 from unit PATH).
- **Deploy-gated code:** A1, A2, B1, B2, B3, B4, C1, C3, C4, D1, D2, D4, D5.
- **Top two levers:** A1/A2 (build-integrity preflight kills the load-time failure class) +
  B1 (AbortSignal into memory backend kills the silent-hang class). Together they fully close
  today's outage path.

## Coordination

- B3 ↔ round-3 F9 (su-226ad); B4 ↔ self-healing D-001 (su-67d39) — land as their items or explicit
  complements, not duplicates.
- Theme C (data-layer) likely unclaimed — offer to su-369b9 (round-4) or take.
- Swarm lane signal (su-1aa2f asked): **Themes A+B (build-integrity + request-fault-isolation)** are
  mine; Theme C negotiable. Most pg/event-loop/memory items are already owned by the shipped lineage.
