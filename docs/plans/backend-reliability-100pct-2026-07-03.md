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

## 4. Definition of done
- A deploy under load → 0 client-visible MCP errors.
- No gateway/bg-host **whole-process** death from a single request; watchdogs go idle.
- MCP p95 latency flat as concurrent-agent count rises (load-rig proof).
- A backend-reliability SLO exists and alarms on regression.
- The phrase "transient errors are normal under load" is false — and measured false.
