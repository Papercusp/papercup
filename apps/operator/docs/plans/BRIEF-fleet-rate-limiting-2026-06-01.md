# BRIEF — Fleet API rate-limit / admission control

**For:** the agent who will write the rate-limiting plan.
**Date:** 2026-06-01. **Author:** prior session (claude-su). **Status:** brief only — no plan, no code yet.
**Scope:** avoid tripping the Anthropic/Codex (claude / omp / codex CLI) API rate limits when the harness fleet spawns many agent subprocesses concurrently. Treated as its own project (the parent DBOS-completion plan deliberately does NOT cover this).

All claims below were verified against code on 2026-06-01 (read-only). Cite-and-verify before building — the spawn path has no hot-reload and the codebase moves fast.

---

## 1. The problem, precisely

The harness fleet spawns agent CLIs (`claude -p` / `omp` / `codex`) as **independent subprocesses**, many concurrently. Anthropic/Codex rate limits are **fuzzy from the harness's vantage point**: the CLI swallows the HTTP exchange, so a 429 does NOT surface as a parseable error — it surfaces as the *same* symptom as local contention: **exit 0, empty stdout, suspiciously short duration (~4.5s)**. You cannot tell a rate-limit apart from a crash today. Any design must therefore (a) PREVENT the stampede and (b) SURVIVE the fuzzy failure — you can't rely on reading a `retry-after`.

This is not hypothetical: `dbos-retire-legacy-orchestrator-2026-05-31` D-005/D-006 document the "empty agent output under concurrent load" wall (≈37–48 concurrent `claude` procs returning empty exit-0 output). NB the D-006 correction: the *primary* cause of that specific incident was a `HARNESS_SLUG`/schema bug (since fixed), but a **genuine secondary concurrency-contention effect remained** ("under ~48 concurrent claude processes … individual spawns occasionally still return empty"). Root cause of the secondary effect was never fully isolated between (a) API rate-limiting, (b) shared `~/.claude` state contention, (c) OS resource exhaustion — see §6.

---

## 2. What EXISTS today (build on these)

- **Per-harness pipeline cap** — `apps/operator/lib/dbos/orchestrator-dispatcher.ts` `resolvePerHarnessCap` (~L74-86): `min(parallelWorkers.max, maxFeaturesInFlight?, PAPERCUSP_DBOS_MAX_PIPELINES ?? SAFETY_CEILING=16)`, always ≥1. **Per-harness ONLY.**
- **DBOS queue concurrency = 4** — `orchestrator-workflow.ts:219` `new WorkflowQueue('feature-pipeline', { concurrency: 4 })`. This is the *de facto* global limiter today — a single blunt workspace-wide ceiling of 4 running pipelines. It is NOT a rate guard; it's a workflow-concurrency knob that happens to bound spawns.
- **DBOS decide-step retry** — `orchestrator-workflow.ts:~134-150`: `maxAttempts:3, intervalSeconds:5, backoffRate:2` (5s→10s). **Only the decide step.** The worker/validator dispatch step (~L169-180) has **NO retry config** — runs once.
- **P-010 empty-run resilience** — `invoke.ts:~1020-1054` `findPriorRunForIdempotency`: an empty/whitespace `out_body` is NOT cached as a reusable "done" run, so a retry re-spawns instead of replaying the empty. (Important: this means adding worker-step retries WILL actually re-spawn.)
- **Cost-cap** — `cost-cap.ts`: gates cumulative **$ spend** per harness (`maxCostUsd` → `selectFeaturesToDispatch` returns `[]`). **This is spend, not rate** — different axis, but it lives at the right place (the dispatcher's pre-spawn gate).
- **`@papercusp/rate-limit`** — `libs/generic/rate-limit/src/index.ts`: a generic two-bucket (soft refundable / hard lockout) algorithm with an injected `BucketStore`. **Wired ONLY into inbound HTTP auth** (`auth-rate-limit.ts` login; `operator-rate-limit.ts` background-scan 2/min + "5 consecutive 503s → 10-min circuit breaker"). **Zero wiring into the agent-spawn path.** It's a reusable algorithm you could borrow, not an existing spawn throttle.
- **The PG-backed lock layer** — `apps/operator/lib/agent-tools/locks/{acquire,release,heartbeat}.ts` + the `@papercusp/file-claim` `FileClaimCoordinator` seam (`libs/papercusp/packages/file-claim/src/index.ts`): a cross-process, TTL'd, Postgres-backed claim primitive. **This is the key reusable primitive** (see §4) — a global spawn-slot semaphore is the same primitive with a fixed key + N permits.
- **Telemetry that exists** — `harness_shared.harness_run_output` (jsonl_body has the `{"type":"result","total_cost_usd"}` event; **no token columns**), `prompt_compositions` (char counts + `ts_ms` timestamp, no tokens), `harness_lanes` (live pid + started_at heartbeat).

---

## 3. What is ABSENT (the gap to fill)

- **No global / cross-harness concurrent-spawn cap.** Each harness throttles itself in ignorance of the others. 10 harnesses × their caps is unbounded except by the DBOS queue's `concurrency:4`. Raise that knob and there is no fleet-wide ceiling. **This is the core gap — rate-limit trips are overwhelmingly a *concurrency* (N-simultaneous) problem, not a steady-throughput one.**
- **No 429 detection / `retry-after` parsing / rate-aware backoff** anywhere in the spawn path. A 429 is indistinguishable from any other failure.
- **No requests/min or tokens/min limiter.** Only the cumulative $ cost-cap exists.
- **No per-model / per-API-key tracking.** (Relevant if different harnesses use different keys/providers.)
- **No structured token-usage columns** a TPM limiter could read without parsing raw JSONL.
- **Worker/validator dispatch step has no retry** at all (only decide does).

---

## 4. Suggested design — three layers, in priority order

The unifying insight: **rate-limit, conflict-safety, and cost-cap are all the same architectural shape — a gate the orchestrator(-ex-dispatcher) checks around a spawn.** Cost-cap already lives there. Build rate-limiting as another gate at that same admission-control point, reusing the PG primitive. (Note: a sibling effort is renaming the dispatcher → "orchestrator" and wiring the PG file-lock into the worker chunk-loop for conflict-safety; coordinate — both want the same PG semaphore primitive. See `dbos-system-completion-2026-06-01`.)

**Layer 1 — Global concurrent-spawn semaphore (the real fix, highest leverage).**
A single **workspace-wide cap on concurrent agent spawns** that every pipeline must acquire a slot from before spawning, regardless of harness. Implement as the existing PG lock/`FileClaimCoordinator` primitive with a fixed key (`fleet-spawn-slots`) holding N permits + TTL (so a crashed spawn frees its slot). This replaces the accidental `concurrency:4` ceiling with an intentional, tunable, cross-harness one. Rate trips are mostly concurrency stampedes → this is the load-bearing piece.

**Layer 2 — Survive the fuzz: retriable backoff on empty output.**
Give the worker/validator dispatch step the same retriable + exponential-backoff treatment the decide step has. Critically, because the symptom is fuzzy: treat **"exit 0 + empty output + suspiciously short duration"** as a soft-failure that triggers backoff-and-retry (not a success). The duration heuristic (≪ a real LLM call, ~4.5s) is the signal D-005 identified. P-010 already ensures the retry re-spawns rather than replaying the empty. This converts "silently produces nothing" → "backs off and retries when the fleet is quieter."

**Layer 3 — Adaptive circuit breaker on the empty-rate (optional, do last).**
Borrow `operator-rate-limit.ts`'s existing pattern ("5 consecutive 503s → 10-min breaker"). If empties spike across the fleet (the rate-limit-or-contention signal you CAN observe, since you can't read the limit), the Layer-1 semaphore **sheds permits** (shrinks N) for a cooldown, then ramps back. This is the pragmatic answer to "fuzzy": infer the limit from the empty-rate and back off adaptively. Start with a fixed N (Layer 1) and only add this if fixed N proves too rigid.

---

## 5. Explicitly do NOT do

- **Don't parse 429 / `retry-after`.** The CLIs hide the HTTP exchange; unreachable without forking the agent CLIs. Infer from empty-rate instead (Layer 3).
- **Don't build a tokens-per-minute limiter first.** No TPM telemetry exists; building it is heavy plumbing for what is fundamentally a concurrency problem. Spawn-slot count is the cheap, sufficient signal. A true TPM limiter (parse `input/output_tokens` from JSONL into new columns) is a possible v2 only if concurrency-capping proves insufficient.
- **Don't reinvent the throttle algorithm.** `@papercusp/rate-limit` (two-bucket) and the PG lock store already exist; adapt them.
- **Don't put the gate anywhere but the dispatcher/orchestrator admission point.** Keep it co-located with cost-cap so there's one deterministic pre-spawn admission-control surface.

---

## 6. Open questions for the plan author to resolve (code-investigation needed)

1. **Isolate the secondary contention root cause.** The ~4.5s-empty symptom fits ≥3 causes (API 429 / `~/.claude` state contention / OS exhaustion). Reproduce under controlled concurrency and instrument (Layer 2's stderr capture — see the sibling plan's P-005 — will help; today `spawnInvokeOnce` drops child stderr). The fix differs: API-throttle vs local-concurrency-throttle vs per-process `~/.claude` isolation. Layer 1 helps all three, but confirm.
2. **Per-key/per-provider dimension.** Do different harnesses use different API keys or providers (claude vs codex)? If so the global semaphore may need to be per-key, not one fleet-wide bucket.
3. **Where to set N.** The global permit count — fixed config, per-provider, or adaptive (Layer 3)? Needs a starting value that's safe on the shared dev box (which today just sets `DISPATCH_HARNESSES=none` to opt out entirely — a blanket avoidance the limiter should make unnecessary).
4. **Interaction with the per-harness cap + DBOS `concurrency:4`.** Decide whether the global semaphore replaces the `concurrency:4` knob or layers under it. Two overlapping ceilings invite confusion.
5. **Slot accounting granularity.** One permit per *spawn* (worker/validator/director each take one) vs per *pipeline*. Per-spawn is more accurate to API load; per-pipeline is simpler.

---

## 7. Key files

- `apps/operator/lib/dbos/orchestrator-dispatcher.ts` — `resolvePerHarnessCap`, `selectFeaturesToDispatch`, `dispatchOneHarness`, `runDispatchTick` (the admission-control point; `SAFETY_CEILING`, `PAPERCUSP_DBOS_MAX_PIPELINES`).
- `apps/operator/lib/dbos/orchestrator-workflow.ts` — `pipelineQueue` (`concurrency:4`), decide-step retry config, the per-feature loop.
- `apps/operator/lib/dbos/orchestrator-runner.ts` — `spawnInvokeOnce` (each role = independent subprocess; note: drops child stderr).
- `libs/papercusp/packages/orchestrator/bin/invoke-once.ts` — `new FileLockQueue()` per subprocess; the actual worker entry.
- `libs/papercusp/packages/orchestrator/src/invoke.ts` — the bare `spawn()`; `findPriorRunForIdempotency` (P-010); exit-124=timeout; no rate awareness.
- `libs/papercusp/packages/orchestrator/src/cost-cap.ts` — the $ spend gate (the existing pre-spawn gate pattern to mirror).
- `libs/generic/rate-limit/src/index.ts` — reusable two-bucket throttle algorithm (auth-only today).
- `apps/operator/lib/operator-rate-limit.ts` — the existing circuit-breaker pattern to borrow for Layer 3.
- `apps/operator/lib/agent-tools/locks/{acquire,release,heartbeat}.ts` + `libs/papercusp/packages/file-claim/src/index.ts` — the PG-backed cross-process claim primitive to reuse for the Layer-1 semaphore.
- `libs/papercusp/packages/orchestrator/src/run-output-pg.ts` — `harness_run_output` schema (no token columns; jsonl_body has cost).
- `apps/operator/docs/plans/dbos-retire-legacy-orchestrator-2026-05-31.md` D-005/D-006 — the authoritative contention-finding diagnosis.
- `apps/operator/docs/plans/dbos-system-completion-2026-06-01.md` — the sibling effort (dispatcher→orchestrator rename + PG file-lock conflict-safety); coordinate on the shared PG-semaphore primitive.
