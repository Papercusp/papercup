# Plan — Backend 100% reliable under fleet load (kill "transient tool errors are normal")

> **Status:** DRAFT for owner review (su-5587d, 2026-07-03). Not yet promoted to
> `plans:new` (MCP was flaky mid-investigation — promote to a PG plan + spawn
> work-items once the route is chosen).
> **Mandate (owner, Avi):** the backend must be 100% reliable; thousands of agents
> must run simultaneously on this box. Transient tool/MCP failures under load are a
> **bug to fix**, never a normal cost of concurrency.

---

## 0. TL;DR — what's actually breaking (and why it looks "random")

Over the **last 3 days**: **1,323,371** tool calls, **99.87% ok**. The 0.13% that
fail cluster on a handful of *structural* faults — none of them "the box is busy":

| # | Failure class | Evidence (last 2–3 days) | Root cause | Status |
|---|---|---|---|---|
| A | **Deploy-restart MCP outage** | `:3070` down **~46s per deploy** (23 consecutive failed health probes; health step = 46,189ms) × **5–9 deploys/hr**. Live-reproduced 3× this session (`tools:find` → "Streamable HTTP error: Error POSTing to endpoint"). | In-place restart of the single `:3070` host has a ~46s cold-start gap; the resilient proxy is **opt-in** and su/interactive + some clients bypass it. | **Under-counted** (conn-level fails never reach the ledger) |
| B | **Gateway whole-process crash** | Inference-gateway crashed **≥2×** Jul 2 (21:49, 22:10): `Unhandled 'error' event … TimeoutError` → `status=1/FAILURE` → systemd restart. | No process-level `uncaughtException`/`unhandledRejection` guard; unguarded stream pipe at `gateway.ts:1926`. One request's stream timeout kills the shared gateway → **every in-flight bee/queen request dropped**. | Root cause open |
| C | **Gateway wedge / freeze** | gw-watchdog: `WEDGE -> restarting … totalRequests frozen @4864, 16 queued, 8/4 in-flight for 120s` (+ freeze candidates). | Admission-slot / stuck-stream leak (see the 2026-06-21 slot-leak note in `gateway.ts:3648`). Watchdog restart is a **mitigation, not a fix**. | Root cause open |
| D | **bg-host DBOS ticker freeze** | bghost-watchdog: **~8 FROZEN→restart** events Jul 1–2 (`routinesTick 246s+ stale while active`) → git-sync + all routines stall (→ repeated "git-sync RECOVERED"). Healthy since ~21:45 Jul 2. | DBOS ticker blocked (event-loop block / PG-pool starvation). Watchdog restart = mitigation. | Recently quiet — confirm root cause |
| E | **Event-loop saturation under load** | MCP errors track **load, not deploys** — peak **42–66 err/hr midday** Jul 2 vs ~15/hr off-peak. Known signature (`agent-insights/agent-mcp-slow-but-health-fast-event-loop-saturation`). | The single `:3070` Node **main event loop** is the scaling ceiling — hop-heavy agent-mcp routes degrade N× under CPU saturation while `/health` stays fast → MCP clients time out. | **The "thousands of agents" blocker** |
| F | **Hot-path write contention** | `plans:set-status` = **280** handler-timeouts ("handler returned but signal…"); `canceling statement due to lock timeout` ×15; `work_items:claim_next`, `git-sync:run`, `activity:report` also. | PG lock contention on plan/work-item status writes under concurrency + a spurious timeout-after-return bug. | Root cause open |
| G | **Account rate-window / egress** | `429 … util5h=1.01 util7d=0.85 retry-after=8328000ms`; `upstream fetch failed` bursts on egress proxy. | Some accounts hit true rate windows (multi-hour retry-after) but stay in rotation; egress transient failures. Failover mostly works. | Mostly mitigated |
| H | **Role capability gaps** | `missing_capability` ×354 (`queen` lacks `memory:read`, `bee` lacks `capability:git`/`fs-read`, `overwatch` lacks `memory:read`). | Role↔capability config drift → recurring hard errors agents may misread as "flaky". | Config fix |

**Transport proof:** MCP-transport tool calls fail **~40× more** than HTTP
(0.34% of 381,037 vs 0.008% of 936,301). And the failures agents *complain* about
most — connection refused/reset during a deploy — **never reach `tool_invocations`**
(the request never lands), so the true MCP failure rate is **higher than the ledger
shows**. That invisibility is itself why "it's just transient" became the culture.

**Prior art to extend (do NOT fork):** `mcp-host-availability-resilience-2026-06-22`,
`mcp-outage-triage-2026-07-02`, and insights `gateway-mass-outage-storm-guard`,
`gateway-admission-control-loop`, `auto-implement-orphans-are-gateway-deaths-not-restarts`,
`bg-host-watchdog-false-restart-on-wedged-journald`, `deploy-pipeline-is-async-self-healing`,
`operator-scalability-event-loop-2026-06-16`.

---

## 1. Principle: root cause + recurrence guard, never a watchdog band-aid

Every workstream below must land **all four**: (1) name where the fault
*originates*; (2) a durable fix; (3) a **recurrence guard** (test/assert/SLO that
fails if the class returns); (4) verified under real fleet load. Watchdogs
(gw-watchdog, bghost-watchdog) stay as **backstops** — they are not the fix.

---

## 2. Workstreams (root-cause-first, ordered by leverage ÷ effort)

### W1 — Zero-downtime deploys + universal MCP resilience  ⟶ kills class A (the headline)
- **W1.1** Blue-green `:3070` cutover: boot the new release on an alt port → run the
  **full** health+MCP-initialize probe against it → **atomically flip** the front
  (mcp-proxy upstream + reverse proxy) → drain & stop the old process. Result: the
  MCP/HTTP endpoint is **never down** during a deploy (today: ~46s × 5–9/hr).
- **W1.2** Make the resilient proxy (`:9071`) the **default for ALL clients** — not
  opt-in. Repoint su/interactive (`~/.claude.json`), psu-launched, and codex MCP
  configs at the proxy (`resolveAgentMcpBaseUrl` already exists; universalize it).
- **W1.3** Harden the proxy retry: keep the write-safety invariant (retry only on
  pre-connect refusal) but shrink the client-visible tail — cap absorb latency below
  the MCP client's own tool timeout, and emit structured failure telemetry per client.
- **Guard:** deploy gate runs a **real tools/call** (not just `/health`) through the
  proxy and **fails the deploy** if it errors; SLO alarm on MCP success-rate dip.
- **Acceptance:** a deploy during active fleet load produces **0** client-visible MCP
  errors (measured proxy-side).

### W2 — Gateway crash-proofing  ⟶ kills class B  (SMALL, HIGH-IMPACT — do first)
- **W2.1** Add process-level `process.on('uncaughtException')` + `unhandledRejection`
  in `inference-gateway/bin.ts` (log to the durable gateway.log + survive). A single
  request must **never** take down the shared multi-tenant gateway.
- **W2.2** Guard the unguarded stream pipe at `gateway.ts:1926` (local-backend path)
  with `.on('error')` + teardown, matching the already-hardened Anthropic/Claude
  paths (`gateway.ts:3258`, `3636`).
- **W2.3** After a hardening deploy, **deliberately restart** long-running hosts
  (gateway) — they don't hot-reload, so today a fix sits undeployed until the next
  crash (exactly why the 21:49 crash ran stale pre-hardening code).
- **Guard:** a crash-injection test (force a stream timeout mid-pipe → gateway must
  log + stay up) + an alarm on gateway restart-count > N/hr.

### W3 — Gateway wedge root cause  ⟶ kills class C
- Root-cause the admission-slot / stuck-stream leak that freezes `totalRequests`
  (audit every stream path frees its slot on abort/idle/error/finish). Keep
  gw-watchdog as backstop; add a slot-leak assertion + a live in-flight-slot metric.

### W4 — bg-host ticker freeze root cause  ⟶ kills class D
- Root-cause the DBOS `routinesTick` block (event-loop block vs PG-pool starvation
  under load); ensure the ticker can't be starved by concurrent load. Keep
  bghost-watchdog (already fixed for wedged-journald false restarts) as backstop.

### W5 — Event-loop scale-out for thousands of agents  ⟶ kills class E (the real ceiling)
- **W5.1** Under real load, read the standing `event-loop-lag-monitor` gauge +
  60s CPU profile to **name** the on-loop consumers on agent-mcp routes.
- **W5.2** Move heavy per-hop work off the main thread (`worker_threads`) and/or cut
  per-`await`-hop cost on the hottest agent-mcp routes.
- **W5.3** Evaluate a **multi-process / sharded MCP host** (cluster or a pool of hosts
  behind the proxy) so N agents don't all contend on ONE event loop — the structural
  path to thousands of concurrent agents.
- **Guard:** a **load-test rig** (N synthetic concurrent agents) as a periodic/CI gate
  with an MCP p95-latency + success-rate SLO; adding agents must not raise latency.

### W6 — Hot-path write contention  ⟶ kills class F
- Fix the `plans:set-status` "handler returned but signal" spurious-timeout bug (280×).
- Reduce PG lock contention on plan/work-item status writes (narrower locks / upsert /
  bounded retry-on-lock) so `set-status` / `claim_next` don't time out under fan-out.
- **Guard:** latency + timeout SLO on the write hot-paths.

### W7 — Account routing / capacity hardening  ⟶ hardens class G
- Eject an account with a multi-hour `retry-after` from rotation until its window
  resets (stop routing to a known-dead account); verify egress transient-failure
  handling; confirm the **full** account pool is loaded (per the multi-account rule:
  most "limits" are routing bugs — verify with `accounts:status` / rate-governor,
  don't assume capacity).

### W8 — Observability + end the "transient is normal" culture  ⟶ cross-cutting
- Record **connection-level** MCP failures proxy-side into a durable ledger keyed by
  client/owner, so deploy-window + saturation failures stop being invisible.
- A backend-reliability **SLO dashboard + alarm** (MCP success rate, gateway
  restarts, host event-loop p95, deploy-window error count). A regression should
  **page**, not get normalized by the next agent as "just flaky."

---

## 3. Recommended sequencing

1. **W2** (gateway crash-proof) + **W1.2** (universalize proxy) — small, same-day,
   remove two whole failure classes immediately.
2. **W1.1** (blue-green deploy) + **W8** (telemetry) — eliminate the headline class
   and make the remainder measurable.
3. **W5** (event-loop scale-out) — the structural "thousands of agents" work.
4. **W3 / W4 / W6 / W7** — root-cause the wedge/freeze/contention classes in parallel
   (disjoint files → safe to fan out).

## 5. Session log + REVISED root-cause synthesis (2026-07-03, su-5587d, AUTO mode, route A)

### LANDED + VERIFIED this session
- **W1.3 — mcp-proxy stale-keep-alive-socket bug (NEW find, likely THE biggest single cause): DONE, TESTED, LIVE-VERIFIED.**
  The proxy forwarded via Node's global agent (`keepAlive:true`) and **reused pooled sockets** to the
  `:3070` `SO_REUSEPORT` cluster. A socket the server/worker was concurrently closing (61s keepalive +
  worker recycle) made a forward land on a half-closed socket → `:3070` returned a spurious
  `400 Bad Request` (empty body, `connection:close`) that the proxy passed to the agent as a tool error.
  **Measured ~13% failure** on reuse-prone (sequential) traffic while direct `:3070` was clean — and
  **completely invisible** (unlogged, absent from `tool_invocations`). Since every agent routes through
  this proxy, this was a dominant source of "transient tool errors under load."
  - Fix: dedicated `UPSTREAM_AGENT` (`keepAlive:false`, fresh socket per forward) in
    `apps/operator/lib/mcp-proxy/proxy.ts` + a no-reuse regression test (7 proxy tests green).
  - Activated (restarted `papercup-mcp-proxy.service`) and **live-verified: 160/160 probes → 200**
    (pre-fix ~13% 400). Follow-up for thousands-of-agents throughput: bounded keep-alive +
    `keepAliveMsecs` < 61s + retry-once-on-reset (tracked).
- **W2 — gateway crash-proofing: DONE, TESTED, LIVE.**
  - `inference-gateway/bin.ts`: added process-level `uncaughtException` + `unhandledRejection`
    backstop (log durably, KEEP SERVING) — registered post-boot so startup failures still exit→restart.
  - `gateway.ts:1926`: guarded the last unguarded local-backend pipe (`.on('error')` + teardown,
    parity with the hardened Anthropic paths at ~3258/3636).
  - `local-backend-gateway.test.ts`: crash-injection regression test (backend RSTs mid-stream →
    gateway must survive + serve a later request). **All 18 tests green.**
  - Activated: restarted `papercup-inference-gateway.service` → back up healthy (`/stats` 200), no crash.
- **W1.2 — universal proxy (partial): DONE for the residual gap.** Spawned bees already ride `:9071`
  (dev-api/bg-host carry `PAPERCUSP_MCP_PROXY_BASE`). Fixed the stale **`:3070` default** in
  `~/.claude.json`'s `papercusp-su` server → `:9071`, so bare interactive Claude sessions no longer
  bypass the proxy. (`install-standalone-mcp.sh` already mints against the proxy; the live file was
  pre-WI-1457 stale config.)

### Findings REVISED by reading the running system (supersede §0 where noted)
- **`:3070` is ALREADY a `node:cluster` + `SO_REUSEPORT` fleet** (~10+ per-worker sockets + 1 background
  primary; `cluster-fork.ts`, plan `operator-scalability-event-loop-2026-06-16`), *with* a per-worker
  lag self-restart that recycles one worker while siblings serve. So **class E is NOT "add clustering"**
  — clustering exists. The two real gaps: (i) the deploy does a **blunt `systemctl restart`** (kills
  primary + every worker at once → the ~46s full outage) instead of a rolling/overlap recycle; (ii)
  per-worker event-loop saturation under load still needs live profiling.
- **W1.1 refined:** zero-downtime = **overlap two `SO_REUSEPORT` cluster generations** (boot the new
  gen on the same port, health+MCP probe it, then drain the old) OR a rolling worker recycle through
  the primary. This is a **high-stakes deploy-path change** (a bug breaks EVERY fleet deploy) → build
  behind a flag, verify on `:3170`/staging, then flip. **Deliberately NOT rushed this session** — the
  anti-footgun rule outranks speed here.
- **The proxy is not the main lever.** I was already on `:9071` and still saw transient failures. The
  residual class is a **post-connect mid-stream reset** during the 46s full-restart window: the proxy
  correctly refuses to retry a non-idempotent write, so the client sees a hard error. The durable cure
  is W1.1 (never drop a request mid-stream), not more proxy routing.
- **W6 is DOWNSTREAM of W5.** `dispatch-stack.ts:598-620` already surfaces completed-but-aborted
  **low-tier reads**, but records every **mutation** (incl. `plans:set-status`) as a hard `timeout`
  even though the write committed. Its own comment names the cause: *"under load, wall-clock exceeds the
  timeout even for a CHEAP handler."* So the **280 `set-status` false-timeouts are event-loop
  saturation (W5) surfacing as write-timeouts** — the deadline fires because the handler is queued
  behind a saturated loop, not because the write is slow. Fix = (a) an **idempotent-write** completion
  path in dispatch-stack (surface a committed idempotent mutation like `set-status` instead of a
  spurious timeout — needs per-tool idempotency review, so done carefully not rushed) + (b) cut the
  PG lock contention on plan/work-item status writes.

### THE synthesis (drives sequencing)
**W5 — per-worker event-loop saturation under fleet load — is the common upstream cause** of both the
MCP slowness/timeouts (class E) AND the `set-status` false-timeouts (class F). It is the highest-leverage
structural item for "thousands of agents." W1.1 (rolling/overlap deploy) removes the discrete-deploy
outage (class A). W2 (done) removed the mass-drop crash (class B). Remaining: W1.1, W5, W3, W4, W6, W7,
W8 — tracked as work-items with the refined designs above.

## 4. Definition of done
- A deploy under load → 0 client-visible MCP errors.
- No gateway/bg-host **whole-process** death from a single request; watchdogs go idle.
- MCP p95 latency flat as concurrent-agent count rises (load-rig proof).
- A backend-reliability SLO exists and alarms on regression.
- The phrase "transient errors are normal under load" is false — and measured false.
