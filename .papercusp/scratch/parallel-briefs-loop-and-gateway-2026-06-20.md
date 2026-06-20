# Parallel implementation briefs — loop plan + gateway robustness (2026-06-20)

10 hand-off-able briefs decomposed from two plans. Each is self-contained (goal · files · do · acceptance · deps). Most are independent and start immediately (Wave 1); a few depend on the loop-engine schema (Wave 2/3).

**Design refs (read for full context):**
- Loop plan: `loop-routines-interval-recurrence-2026-06-20` (papercusp harness) — staged revision: `.papercusp/scratch/loop-plan-revision-2026-06-20.md`
- Gateway audit: `.papercusp/scratch/inference-gateway-robustness-audit-2026-06-20.md`

**Already shipped this session (DO NOT redo):** gateway's 3 slot-guards (token-deadline, downstream-idle, hard-ceiling) + the `papercup-inference-gateway-watchdog` systemd service + the `role-principal-caps.ts` `plans:write` fix (riding su-7fa79's migration restart). Loop-plan **Phase C** (P-010/011/012, scale-to-hundreds) is DEMAND-GATED (D-004) — NOT in scope; do not build on spec.

**Waves:** Wave 1 (start now, independent) = B-LOOP-1, B-LOOP-4, B-GW-1, B-GW-2, B-GW-3, B-GW-4, B-GW-5. Wave 2 (after B-LOOP-1 schema) = B-LOOP-2, B-LOOP-3. Wave 3 (after the loop engine works) = B-LOOP-5.

---

## B-LOOP-1 — Loop engine core: schema + claim (P-001 + P-003) · Wave 1 · FOUNDATIONAL
**Goal:** make a "loop" a real third recurrence kind in the routines engine.
**Files:** a `harness_shared.routines` migration (`reschedule_interval_sec INTEGER` nullable + a target-session binding col); `RoutineRow`, `upsertRoutine`, `materialize-plan-schedule.ts`; `harness/routines/claim.ts`.
**Do:** Add the column (D-003: dedicated column, not jsonb) + the session/owner binding (the session the loop wakes). In `claimDueRoutine`, treat a loop (no cron/rrule but `reschedule_interval_sec` set) as a THIRD kind: on claim keep `active=TRUE` and PARK `next_fire_at='infinity'::timestamptz` (the in-flight sentinel) — NOT deactivate (today `hasRecurrence`=false → one-shot deactivates, claim.ts:26/32) and NOT `NULL` (→ due-next-tick infinite refire, claim.ts:11-15). cron+loop → take the SOONER. P-003 is load-bearing.
**Acceptance:** unit + integration tests — a pure loop stays active across many claims, never refires while parked, re-fires after the rebase re-arms; cron+loop composes.
**Deps:** none. ⚠ COORDINATE the migration with **su-7fa79** (papercup→papercusp rename touches routines tables).

## B-LOOP-2 — Completion-rebase + turn-completion signal (P-002 + the open spike) · Wave 2
**Goal:** re-arm a loop N sec AFTER its turn completes.
**Files:** `harness/routines/reconcile-plan-runs.ts` (reconcileAndGovern) / wherever the loop's turn-completion is observed.
**Do:** On the 30s tick, when a loop's last turn SETTLES, set `next_fire_at = completed_at + interval` (idempotent off the fixed completion time; rebase only off the MOST-RECENT settled turn — never backwards). **RESOLVE FIRST (the open spike):** warm-wake (D-005/D-006) does NOT mint a plan_run per fire, so the signal is NOT `plan_runs.finished_at` — re-source it from the SESSION/turn-completion (await/wake-idle lifecycle). Confirm a clean signal exists; if messy, flag (the one thing that could nudge the design). Caveat: 30s tick → true period = interval + up-to-30s (fine for the 60s floor, not sub-minute).
**Acceptance:** tests — fires N sec after a turn settles; idempotent; never moves next_fire_at backwards.
**Deps:** B-LOOP-1 (schema).

## B-LOOP-3 — Fire action = warm coord wake + cost-cap (P-004) · Wave 2
**Goal:** a loop fire WAKES the pinned session warm (not a fresh plan-run).
**Files:** `dbos/routines-workflow.ts` (the fire dispatch).
**Do:** The fire delivers a `coord:send {wake}` to the pinned session (rides the existing wake-executor ladder: inject-if-live / `claude --resume`-if-exited — NO new resume code, D-005) + `recordFire`. Attach a COST-CAP to the loop routine (auto-pause on cost breach) alongside the existing failure-streak fire-gate (`checkFireGate`).
**Acceptance:** tests — a fire wakes the SAME session warm; cost-cap + failure-streak both trip.
**Deps:** B-LOOP-1 (schema/binding).

## B-LOOP-4 — Atomic `work_items:create {assign_to}` (P-007 / D-008) · Wave 1 · INDEPENDENT
**Goal:** create + claim a work_item in ONE call (kills the create→claim race).
**Files:** `agent-tools/work_items/create.ts` (already stamps `createdBy`).
**Do:** Add an `assign_to` param — create AND write the claim/lease to the supplied agent id atomically (one DB write). GENERAL (any agent id; self-assign = own id). Used by B-LOOP-5's wakeup prompt but it's a standalone capability (e.g. Queen create+place onto a bee).
**Acceptance:** tests — create-with-`assign_to` yields an item claimed by the target in one call; self-assign works; no race window.
**Deps:** none.

## B-LOOP-5 — Loop surface: arm-verb + wakeup prompt + retire /loop + docs (P-008 + P-006 + P-009) · Wave 3
**Goal:** the ergonomic "/loop replacement" surface + adoption.
**Files:** a new agent-tool verb (arm/end a loop on self, binding the session); the wakeup-prompt template; su/interactive personas/prompts using Claude /loop; a new `agent-insights` doc.
**Do:** Verb to arm a loop on ITSELF + end it (P-008); wakeup prompt instructs "each wake, create + self-assign your work_items via `work_items:create {assign_to:<me>}`, then work them + set_state." Sweep su/interactive prompts that self-pace with Claude /loop → "declare an engine loop; do NOT self-pace with /loop" — EXCLUDE the autonomous queen/bee/scout loop (D-007). Docs: loops vs schedules vs /loop, after-completion semantics, the warm-wake/resume ladder, guardrails, observing a loop.
**Acceptance:** the verb arms/ends a tracked loop; a manual e2e shows a warm su session looping; prompts updated; docs published.
**Deps:** B-LOOP-1/2/3 (engine) + B-LOOP-4 (assign).

---

## B-GW-1 — AIMD adaptive admission concurrency (gateway P1) · Wave 1
**Goal:** the gateway dials its OWN concurrency down under sustained 429s (and recovers) to stop retry-storm amplification.
**Files:** `inference-gateway/gateway.ts` + `PriorityAdmissionQueue` (add a runtime `setMaxConcurrent`).
**Do:** AIMD — multiplicative-decrease effective maxConcurrent on sustained upstream 429s, additive-increase back to the cap when clear (floor ≥1). Fewer concurrent upstream calls = lower per-IP RPM = the throttle eases. Also fail-fast-shed when ALL accounts are throttled instead of holding slots retrying.
**Acceptance:** tests — under a sustained 429 storm, effective concurrency decreases then recovers; never below the floor; no slot leak.
**Deps:** none (gateway). ⚠ coordinate gateway.ts edits (active file this session).

## B-GW-2 — Chaos/failure load harness (gateway P2) · Wave 1
**Goal:** catch the next wedge before production.
**Files:** `inference-gateway/gateway.test.ts` (+ maybe `load-test.ts`).
**Do:** Failure-injection tests — a pool-wide 429 storm under high concurrency (graceful shed + no slot leak), extreme concurrency vs a healthy upstream (all settle, inFlight→0), upstream header/body stalls, a hung token endpoint. The 3 existing regression tests (token-hang / hung-client / hard-ceiling) are the seed. Wire into CI.
**Acceptance:** new chaos tests green; each asserts NO slot pinned + bounded recovery.
**Deps:** none.

## B-GW-3 — Per-account egress IPs (gateway P1) · Wave 1
**Goal:** each account egresses from its OWN IP so Anthropic's per-IP opus limit becomes per-account (rotation works + ~8× RPM headroom). HIGHEST-leverage capacity fix.
**Files:** `inference-gateway/account-resolver.ts` / `gateway.ts` (the D-003 dispatcher is wired: `egress?: AccountEgress`); a provisioning runbook.
**Do:** Wire each account's `egress` (HTTP/SOCKS proxy or bound source IP) end-to-end + a test that account X's request egresses via X's dispatcher. Write the runbook for provisioning N egress IPs. **The IPs/proxies are the OWNER's to provide** — deliver wiring + runbook + verification, ready to plug IPs in.
**Acceptance:** a configured account routes via its dispatcher (test); runbook complete.
**Deps:** none (code); IP provisioning is the owner's.

## B-GW-4 — Opus-budget pacing (gateway P2) · Wave 1
**Goal:** pace fleet opus to stay UNDER the 5h ceiling (no more blow-then-starve).
**Files:** the fleet rate-governor layer (NOT gateway.ts).
**Do:** a fleet-level opus-budget governor that paces opus to stay under the 5h unified-window ceiling (reserve headroom) and shifts non-critical work to sonnet as the budget approaches the cap.
**Acceptance:** under simulated budget pressure, opus throughput is paced below the ceiling; non-critical work shifts to sonnet.
**Deps:** none.

## B-GW-5 — Wedge metrics/alerting + MCP auto-reconnect (gateway P3) · Wave 1
**Goal:** observability on the wedge signature + control-plane self-heal.
**Files:** operator dashboard/metrics ingestion of gateway `/stats`; the MCP client/channel layer.
**Do:** Emit structured gateway metrics (inFlight, queueDepth, shed429, per-account pause, utilization, failovers) to the dashboard + alert on the wedge + sustained-throttle signatures (complements the watchdog — it auto-restarts; this makes it visible). MCP channel auto-reconnect with backoff so a transient backend blip doesn't silently drop an agent's caps (the `papercusp-su` disconnect this session — which blocked plan-writing).
**Acceptance:** /stats metrics on the dashboard + alert on a simulated wedge; a dropped MCP channel auto-reconnects.
**Deps:** none.
