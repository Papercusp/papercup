# Inference Gateway / Account Pool — Robustness Audit + Improvement Plan (2026-06-20)

## Context
Two production wedges this session, both now **fixed + tested + deployed**:
1. **Token-hang** — `active.token()` (deadline-less OAuth refresh) ran before the upstream stall-guard → pinned every slot. Fixed with a `withDeadline` token guard.
2. **Hung-client streaming** — the stall-guard aborts UPSTREAM only; a *completed upstream + half-open/non-reading client* left the streaming `await` with no path to resolve (no `finish`/`close`/`error`) → slot pinned forever. Fixed with a downstream-idle guard (`res.setTimeout → res.destroy`).

This audit covers the whole gateway/account-pool system for robustness under **failures, edge cases, extreme concurrency, and load**, and proposes prioritized improvements. Everything below is grounded in the code (`packages/operator-core/lib/inference-gateway/*`) + the observed incidents.

---

## P0 — Self-healing: the system cannot DETECT or RECOVER from a wedge
**Finding.** A wedged gateway stays UP (process alive, port listening), so systemd `Restart=always` NEVER fires — it only catches a process *crash*. Nothing consumes `/healthz` or `/stats` to detect the wedge signature (frozen `totalRequests` while `queueDepth>0`; `inFlight==maxConcurrent` with `shed429` climbing; sustained `/healthz` 503). Both wedges ran SILENTLY for 6–38 min until a human noticed. This is the single biggest robustness gap: the two specific hangs are fixed, but a *third* unknown hang would wedge again, just as silently.

**Recommend.**
- **External watchdog** (systemd timer / sidecar / operator backend) polling `/healthz`+`/stats` ~every 10s. Detect: (a) `totalRequests` not advancing while `queueDepth>0` for >60s → WEDGE → `systemctl --user restart` + alert; (b) sustained 503/shed → capacity alert (not a restart). Turns a 38-min silent outage into ~30s auto-recovery.
- **Hard per-request lifetime ceiling** — a single backstop timer per proxy request (generous, e.g. 10 min) that aborts upstream + destroys `res` + guarantees the slot releases. Defends against ANY future unbounded-await, not just the two we patched. (The activity timers optimize the common case; the ceiling guarantees termination.)
- **In-gateway self-watchdog** — if `inFlight==maxConcurrent` and no slot released for >N s, log LOUDLY (make the silence a signal) and optionally self-exit so systemd restarts.

## P1 — Concurrency doesn't adapt under sustained throttle (retry-storm amplification)
**Finding.** Gateway admission concurrency is FIXED at 24 (`PriorityAdmissionQueue({maxConcurrent: concurrency})`, no AIMD). Under a sustained pool-wide 429 storm, all 24 slots squat on the internal retry/wait budget (≤30s each); throughput collapses, the queue fills to 256, sheds. Worse, those internal retries ADD to the per-IP RPM → worsen the upstream throttle (a positive-feedback loop).

**Recommend.**
- **AIMD on the gateway's own admission**: multiplicative-decrease effective concurrency on sustained 429, additive-recover when clear. Fewer concurrent upstream calls = lower per-IP RPM = the throttle eases. (The fleet has an AIMD governor; the gateway's admission does not.)
- **Fail fast when ALL accounts are throttled** — shed quickly with `retry-after` instead of 24 slots each holding 30s of retries; reduces the self-inflicted RPM amplification.

## P1 — All accounts share ONE egress IP (the throttle root cause)
**Finding.** Per-account egress (D-003 undici dispatcher) EXISTS but is UNCONFIGURED — every account egresses from one IP (`gateway.ts:448` "all share one egress IP"). Anthropic's per-IP opus RPM limit then 429s the WHOLE pool simultaneously, and account-rotation — the gateway's primary defense — cannot escape a per-IP limit. This is why 8 distinct accounts 429 in lockstep while the 5h budget still has headroom.

**Recommend.** Provision N egress IPs (HTTP/SOCKS proxies or bound source IPs) and wire each account's `egress` so the per-IP limit becomes per-account → rotation works again + ~8× effective RPM headroom. Highest-leverage CAPACITY fix (vs. merely surviving the throttle).

## P2 — Budget exhaustion isn't paced (blow-then-starve)
**Finding.** When the 5h opus unified budget hits ~100% (observed 0.97 this session), the gateway throttles hard (429/503) until the rolling window frees. The fleet over-drives opus into the ceiling rather than pacing under it; recovery waits for the window.

**Recommend.** A fleet-level opus-budget governor that paces opus consumption to stay under the 5h ceiling (reserve headroom) and shifts non-critical work to sonnet. Cross-cuts the fleet rate-governor.

## P2 — No chaos / failure load testing
**Finding.** `load-test.ts` tests only the happy path (N concurrent → assert zero upstream 429s). It does NOT simulate hung/half-open clients, token-endpoint stalls, upstream header/body stalls, pool-wide 429 storms, or extreme concurrency. Neither wedge would have been caught pre-production.

**Recommend.** A **chaos harness** that injects each failure mode — a fault upstream that stalls headers/body; a token endpoint that hangs; clients that half-open mid-stream; a 429-storm upstream; hundreds of concurrent requests — and asserts NO slot is pinned + bounded recovery. Run in CI. This is how wedge #3 gets caught before production. (The two regression tests added this session — token-hang + hung-client — are the seed.)

## P3 — Observability / alerting gaps
**Finding.** `/stats` exists but nothing alerts on the wedge or sustained-throttle signatures; failover/routed-account data isn't surfaced as metrics; the silent wedge produced no signal.
**Recommend.** Emit structured metrics (inFlight, queueDepth, shed429, per-account pause state, utilization, failovers) to the operator dashboard; alert on the wedge + sustained-throttle signatures.

## P3 — Control-plane self-healing (related, surfaced this session)
**Finding.** The superuser MCP channel (`papercusp-su`) dropped and did NOT auto-recover — surfaced as an agent silently losing its write capabilities (fell back to a role-scoped principal lacking `plans:write`/`memory:read`).
**Recommend.** MCP channel auto-reconnect with backoff so a transient backend blip doesn't silently degrade an agent's capabilities.

---

## Suggested sequencing
1. **P0** watchdog + hard per-request ceiling — stop the bleeding (auto-recovery + a universal backstop so no hang is ever silent/terminal again).
2. **P1** AIMD admission + per-account egress IPs — the two that actually FIX the throttle, not just survive it.
3. **P2** chaos harness (catch regressions) + opus-budget pacing.
4. **P3** metrics/alerting + MCP self-heal.

## Already shipped this session (the acute fixes)
- Token-refresh deadline guard + regression test.
- Downstream-idle guard (hung-client) + regression test reproducing the wedge.
- Both deployed; gateway suite 29/29 green.
