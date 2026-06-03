---
title: Agent turn-error robustness + rate-limit awareness (claude/omp/codex)
slug: agent-turn-robustness-2026-06-02
status: complete
owner: avi
created: 2026-06-02
harness: all
importance: high
---

# Agent turn-error robustness + rate-limit awareness

## Problem

Our agents trip the provider rate limit and then handle the failure poorly — both
in the harness pipeline and in the judge/gym framework, **even when run solo**.

Two root causes, confirmed against the live code + Anthropic's published limits:

1. **No rate-limit *awareness* (we burst past the ceiling).** The provider uses a
   **token-bucket** over **RPM / input-TPM / output-TPM**, *per model class*, and even
   a short burst over the per-second-equivalent trips a `429` (plus a separate
   *acceleration* limit on sharp usage spikes). We fire requests with **no shared
   budget**: the DBOS pipeline spawns several role agents at once, the gym runs
   multiple pipelines concurrently, and the frozen judge emits ~32k thinking tokens
   (output-TPM heavy) — all uncoordinated. So we trip the limit ourselves.

2. **No rate-limit *robustness* (we mishandle the 429s we do get).**
   - `meridianAgentChat` retries 429 with **blind exponential backoff (2→60s, 8 tries)**
     — it **ignores the `retry-after` header and the `anthropic-ratelimit-*-reset`
     headers** the server sends, then **gives up after ~3 min** and yields an `error`.
   - The **CLI backends (claude/omp/codex)** have no unified 429 detection — a
     rate-limited spawn surfaces only as an exit code / stderr text, classified by no
     one.
   - DBOS steps use generic `maxAttempts:3, backoffRate:2` retries — not
     rate-limit-aware, give up at 3.
   - A rate-limited turn **throws and crashes the parent** (e.g. the gym judge 429 →
     `judgeGymRun` throws → the whole A/B run fails), instead of pausing + resuming.

**Goal (this plan):** every agent turn — in-process LLM calls *and* spawned CLI agents
(claude/omp/codex) — must (a) **proactively pace** to stay under the provider's limits,
and (b) **robustly handle ANY turn error** (429, 529/5xx, timeout, agent crash,
empty/malformed output, auth) with correct backoff + **graceful degradation that never
crashes the parent** pipeline/run/loop.

## Facts that shape the design (Anthropic rate limits, 2026)

- Token-bucket, continuously replenished; limits are **RPM + ITPM + OTPM, separate per
  model class** (Opus 4.x and Sonnet 4.x are *separate* buckets — so splitting the gym
  pipeline onto Sonnet and the judge onto Opus already helps).
- `429` responses carry **`retry-after`** (seconds) and
  **`anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-{limit,remaining,reset}`**
  (reset = RFC-3339). The right behavior is: **honor `retry-after`; pre-emptively slow
  when `*-remaining` is low; resume at `*-reset`.**
- `max_tokens` does NOT count toward OTPM (only tokens actually produced) — but the
  judge's ~32k *thinking* tokens DO. So thinking-heavy calls are OTPM-expensive; pace them.
- **Prompt caching**: cache-read input tokens don't count toward ITPM → cache stable
  prefixes (system prompts, tool defs) to raise effective throughput.
- **Acceleration limits**: ramp up gradually + keep steady pacing; don't cold-burst.
- The Claude **Max subscription** (what the meridian OAuth path uses) has its OWN
  short-window rate limit *and* a separate rolling usage limit — distinct axes. This
  plan targets the **rate** axis (the 429s); the usage axis is a spend/scheduling concern.

### The other two backends are different providers with different limit models

- **codex → OpenAI.** Codex bills on **API token usage** (as of Apr 2026). Two limit
  models by auth: **ChatGPT subscription** (Plus/Pro/Business/Enterprise) = rolling-window
  message/usage caps (per-few-hours + weekly), 429 on exhaustion, coarse reset;
  **OpenAI API key** = RPM/TPM token-bucket with `Retry-After` + `x-ratelimit-{limit,remaining,reset}-{requests,tokens}`
  headers. Either way it's a **separate budget bucket from Anthropic** (different account,
  different reset clock). Codex runs its own internal retries.
- **omp (Oh My Pi) → model-agnostic, 40+ providers, per-role routing, built-in fallback
  chaining.** Critically: omp encodes **no explicit rate-limit policy beyond generic
  provider failure handling + fallback chaining**, and which provider/model a given omp
  call hits is decided *inside* the omp subprocess (and can fall over to another provider
  mid-turn). So (a) omp's per-call provider/limit is **not statically known to us**, (b)
  omp **already self-heals** across providers, and (c) its hashline edits cut output
  tokens (~61% on one bench) → lighter OTPM. Implication: we do NOT pace omp's internal
  calls; we govern omp at the **subprocess-turn** level and let its fallback chain do the
  per-provider recovery.
- **Consequence — granularity is backend-dependent.** In-process meridian calls: we own
  each HTTP call → govern per-call with full header honoring. Subprocess agents
  (claude-CLI / omp / codex): the LLM calls are **opaque inside the subprocess**, which
  runs its OWN retries/fallbacks → our levers are **(i) a concurrency + spawn-rate cap**
  (the actual burst control), **(ii) turn-level error classification** from exit code +
  stderr, and **(iii) NOT double-retrying** on top of the CLI's own retries (our-retry ×
  CLI-retry = amplification that makes 429s worse).

## Design

A single choke point + a single wrapper that every backend goes through.

### Principles

1. **One governor per (account, provider, model-class).** All agent requests pass
   through a `RateLimitGovernor` that enforces a token-bucket (RPM/ITPM/OTPM) + a
   concurrency cap, and globally **pauses** the bucket when the provider signals
   backpressure. The fleet + gym share one Claude account, so the governor must be able
   to coordinate **cross-process** (PG-backed, like `locks:*`), not just in-process.
2. **Honor server backpressure, don't guess.** Parse `retry-after` + `*-reset` +
   `*-remaining`; wait exactly as told; slow pre-emptively as remaining drops.
3. **Unified turn-error taxonomy.** Classify every failure into one policy:
   `rate_limited` (429/accel) · `overloaded` (529/5xx) · `timeout` · `transient_io` ·
   `auth` · `agent_crash` (nonzero exit/signal) · `empty_output` · `malformed_output` ·
   `permanent`. Each maps to: wait-until-reset · backoff-retry · escalate · fail-fast ·
   degrade.
4. **Backend-agnostic wrapper, backend-specific extraction.** One `runAgentTurn()` that
   wraps meridian + the claude/omp/codex spawns; each backend supplies a thin shim that
   extracts `{status, headers, retryAfter}` (meridian: SDK APIError + response headers;
   CLI: exit code + stderr pattern match for rate-limit/overloaded). Governor + retry +
   classification live ABOVE the backend, so all three share one robustness path.
5. **Never crash the parent.** An exhausted turn returns a structured `TurnError`, not a
   thrown exception. The caller decides: re-queue · skip+mark · escalate-to-human ·
   **pause-the-loop-until-reset**. The gym A/B specifically: a rate-limited
   judge/pipeline → pause + resume, not fail the run.
6. **Ramp + cache.** Start concurrency low and ramp (acceleration safety); cache stable
   prompt prefixes to cut ITPM.
7. **Observable.** Emit headroom + 429 events to telemetry; surface a
   "rate-limited — paused until <reset>" status to coord/UI.
8. **Govern at the right granularity; don't fight the backend's own resilience.**
   In-process meridian = per-HTTP-call token-bucket + header honoring. Subprocess
   agents (claude-CLI/omp/codex) = **per-spawn concurrency + spawn-rate cap** (we can't
   see their internal calls), plus turn-level classification of the *outcome*. We do
   **not** re-retry an LLM call the CLI already retried (avoid our-retry × CLI-retry
   amplification); omp's fallback chaining and codex/claude's internal retries handle the
   per-call layer — our job is to not over-spawn and to handle the *turn* result.
9. **Provider/account/limit-model is DECLARED per backend, not guessed.** A
   `backendProviderProfile` says: claude→Anthropic(subscription|apiKey),
   codex→OpenAI(subscription|apiKey), omp→{multi-provider, self-pacing}. The governor
   keys budgets by the declared provider+account and picks the right limit model
   (header-driven for API keys; coarse rolling-window + conservative concurrency for
   subscriptions, where per-minute headroom isn't visible). omp is marked self-pacing →
   concurrency-capped only.

### Components

- **`@papercusp/agent-governor`** (new; or extend `packages/rate-limit`):
  `RateLimitGovernor` keyed by `(provider, account, modelClass)`.
  `acquire(estInTokens, estOutTokens)` blocks until budget; `record(headers)` syncs
  limit/remaining/reset; `penalize(retryAfterMs)` pauses the bucket. In-process first;
  a **PG-backed** variant (table `agent_rate_budget`, leased like locks) for the
  shared-account fleet+gym case.
- **`classifyTurnError(backend, raw) → TurnErrorClass`** — pure, table-driven, unit-
  tested per backend (incl. CLI stderr fixtures for claude/omp/codex 429s).
- **`runAgentTurn(spec, deps) → TurnResult | TurnError`** — the one wrapper:
  `governor.acquire → run backend → record(headers) → on error classify → policy
  (waitUntil(reset)|backoff|escalate|degrade)`. Replaces the ad-hoc meridian retry loop
  and wraps the CLI spawn. Returns structured, never throws on a handled class.
- **Caller integration**: `meridianAgentChat`, the CLI spawn path in `runAgentChat`,
  `invoke-once`/`invoke`, the gym judge (`judgeGymRun`'s `llmCall`), the gym pipeline
  (operator spawn), and the chat surfaces (operator/oracle) all route through it.
- **Orchestrator/DBOS + gym**: `rate_limited` → the DBOS step **waits until reset**
  (honor retry-after) instead of burning 3 attempts; the workflow exposes a
  **rate-limit-pause** state + resumes. The gym loop's `evaluate` catches per-run
  `TurnError`s and pauses/resumes rather than aborting.

### Backend specifics

- **claude — two surfaces, Anthropic bucket.**
  - *meridian (in-process: judge / sim-user / operator+oracle brains)* — we own the HTTP
    call → full governance: token-bucket + read `retry-after` + `anthropic-ratelimit-*`
    headers, wait to `*-reset`, slow as `*-remaining` drops. **This is P-004, the highest-
    impact fix** (it's what the judge/gym hit).
  - *CLI (`claude -p`, pipeline agents)* — opaque internal calls; we **cap concurrency +
    spawn-rate**, classify the *turn* from exit code + stderr ("rate limit"/"429"/
    "overloaded"/"5-hour limit"), and back off / pause at the turn level. Don't re-retry
    its internal calls.
  - Auth here is the Max **subscription** (OAuth) → coarse limit model: react to 429 +
    `retry-after`, pace conservatively, no per-minute header headroom to read.
- **codex — OpenAI, SEPARATE bucket.** CLI subprocess; opaque internal calls + its own
  retries → concurrency/spawn-rate cap + turn-level classification. Limit model depends
  on auth: **API key** → OpenAI RPM/TPM + `Retry-After`/`x-ratelimit-*` (precise, if we
  can surface headers; from a subprocess we usually only see the 429 in stderr → treat
  coarse); **ChatGPT subscription** → rolling-window caps (coarse). Governed independently
  from Anthropic — codex turns don't draw from the claude budget.
- **omp — model-agnostic, SELF-PACING.** CLI subprocess that routes to any of 40+
  providers per-role *with internal fallback chaining*, and has no explicit rate-limit
  policy of its own. We therefore: **only cap concurrency/spawn-rate** for omp (no
  per-provider budget — we don't know which provider a call hit), let omp's fallback
  chain absorb per-provider 429s, and classify only the *terminal* turn outcome (the
  whole omp turn failed after its fallbacks → our policy applies). If omp is configured
  to route to the SAME Anthropic account as claude, its spawns should count against the
  shared concurrency cap to avoid co-bursting that account (config-declared overlap).

## Items

- **P-001** `done` `TurnError` taxonomy + `classifyTurnError(backend, raw)` — pure +
  table-driven; unit tests incl. claude/omp/codex stderr + meridian-APIError fixtures.
  importance: high (DONE 2026-06-02: `libs/papercup-shared/src/agent/turn-error.ts`, 16 tests)
- **P-002** `done` (`libs/papercup-shared/src/agent/governor.ts`, 8 tests) `RateLimitGovernor` — supports BOTH limit models: (a) **header-driven**
  token-bucket RPM/ITPM/OTPM + `retry-after`/reset honoring + pre-emptive slow on low
  remaining (API-key providers / in-process meridian), and (b) **coarse** mode for
  subscriptions (no per-minute headroom: conservative concurrency + react to 429 +
  `retry-after`). Plus a **concurrency + spawn-rate cap** primitive used for subprocess
  backends. Keyed by `(provider, account, modelClass)`; OpenAI (codex) and Anthropic
  (claude) are separate buckets. Property/unit tests with a fake clock. blocked-by: P-001
  importance: high
- **P-011** `done` (`libs/papercup-shared/src/agent/governor-registry.ts`, 5 tests; per-backend extractors landed in P-001's turn-error.ts) `backendProviderProfile` config + per-backend turn-error extractors:
  declare provider/account/limit-model/self-pacing for claude(meridian+CLI)/codex/omp;
  CLI **stderr+exit classifiers** with real fixtures for each (claude "5-hour limit"/429,
  codex 429/quota, omp terminal-fallback-exhausted). Marks omp self-pacing
  (concurrency-only) and declares any shared-account overlap (e.g. omp→Anthropic). 
  blocked-by: P-001 importance: high
- **P-003** `done` (`libs/papercup-shared/src/agent/turn-runner.ts`, 5 tests)
  `runAgentTurn()` wrapper (governor.acquire → backend → record → classify → policy;
  returns `TurnResult|TurnError`, never throws on handled classes). blocked-by: P-001, P-002
  importance: high
- **P-004** `done` (flag-gated `PAPERCUSP_AGENT_GOVERNOR=1`; chat-stream.ts governedMeridian
  + headersToRecord, +2 tests) Rewrite `meridianAgentChat` to honor `retry-after` + `*-reset`
  headers and go through `runAgentTurn` (the immediate fix for judge/gym/brains). Default
  OFF = byte-identical live path. blocked-by: P-003 importance: high
- **P-005 / RB-005** `done` (ABSORBED into RB-012, not separately deferred). The CLI spawn
  path IS now governed: `runAgentChat` acquires a shared-governor permit before the spawn
  (concurrency + spawn-rate cap, `governorMaxWaitMs`), classifies the subprocess TURN outcome
  from exit+stderr (RB-011 extractors) + a wall-clock turn-timeout, and penalizes the shared
  governor on a 429/overload — without re-retrying the CLI's own internal retries. omp =
  concurrency-cap only (self-pacing); codex = OpenAI bucket; claude-CLI = Anthropic bucket.
  (Committed under RB-012 `ff68689`; the original "invasive extraction" framing was wrong —
  the acquire-before-spawn + penalize-on-429 wrapping is small.) blocked-by: P-003, P-011 importance: high
- **P-006 / RB-006** `done` (`apps/operator/lib/gym/{rate-pause,loop,ab-runner}.ts` +
  `llm-testing/llm-error.ts` `LlmCallError`; orchestrator-runner penalizes on rate_limited/overloaded;
  commits super `0f362e6c0`, sub `bd67d92`) Orchestrator/DBOS + gym integration — `rate_limited`
  → wait-until-reset + a rate-limit-pause/resume disposition (not a crash); gym `evaluate`
  resilient to per-run `TurnError` (a rate-limited judge → run excluded from the variance sample,
  loop pauses+resumes, never aborts). blocked-by: P-004, P-005 importance: high
- **P-007 / RB-007** `done` (`libs/papercup-shared/src/resilience/governor.ts` GovernorStore seam;
  `apps/operator/lib/agent-governor-pg-store.ts`; migration 111 `harness_shared.agent_rate_budget`;
  3 integration tests) PG-backed cross-process governor so the fleet + gym + this dev session share
  ONE account budget. DECISION: the SHARED part is the RATE window + PAUSE (the account-wide 429
  cause); CONCURRENCY stays per-process (a per-runner burst lever — the shared rate window already
  bounds aggregate request rate, and cross-process concurrency-leasing would be disproportionate).
  Flag-gated `PAPERCUSP_AGENT_GOVERNOR_PG=1`; default unset = in-memory. blocked-by: P-002 importance: normal
- **P-008 / RB-008** `done` (`chat-stream.ts` `buildMeridianSystem` — `cache_control: ephemeral`
  on the system prefix; off-switch `PAPERCUSP_PROMPT_CACHE=0`; commit sub `ff68689`) Prompt-caching
  pass on the stable system prefix → cache-read tokens don't count toward ITPM. importance: normal
- **P-009 / RB-009** `done` (`libs/papercup-shared` `onGovernorPause`/`snapshotGovernors`;
  `apps/operator/lib/agent-governor-observer.ts` coord+toast surfacing; `dev:rate_governor_status`
  tool; commits sub `ae083d8`, super `0d78b823c`) Observability: per-bucket headroom + pause snapshot;
  coord/toast "rate-limited — paused until <reset>" on each pause transition. blocked-by: P-003 importance: normal
- **P-010 / RB-010** `done` (`turn-robustness.fault-injection.test.ts` 18 tests + the
  concurrency-SLO test in `governor.test.ts`) Fault-injection matrix (429+retry-after, 529, timeout,
  agent_crash, empty/malformed) per backend shape (meridian HTTP + CLI subprocess) → asserts no
  parent crash + correct wait/resume + fail-fast on auth/permanent; PLUS the review's pacing SLO
  (governed 429-rate <10% AND throughput within 50% of the ceiling vs a naive burst >50%, + header
  auto-tune). blocked-by: P-006 importance: high

## Completion (2026-06-02, overnight session — every plan item complete + tested)

ALL items done. Final state by item: RB-001..004/011/012/013 (core + migration of every agent
surface + generic resilience extraction) — done earlier. **This session closed the rest:**
- **RB-005** — reconciled to `done` (its intent was absorbed into RB-012's CLI-spawn governance; it
  was never genuinely deferrable work, just mislabeled).
- **RB-006 / RB-008 / RB-009 / RB-012 / RB-013** — verified genuinely complete against the committed
  code (gym pause/resume + LlmCallError; prompt-cache; pause observer + `dev:rate_governor_status`;
  all surfaces governed; resilience split).
- **Review "before the live flag" items (all 4)** — slow-as-remaining-drops (`paceDelayMs`),
  runtime `limitModel` (D-006), subprocess turn-timeout (#6), honest window-semantics doc.
- **RB-010** — fault-injection matrix (18 tests) + pacing SLO + header auto-tune.
- **RB-007** — PG cross-process governor: GovernorStore seam, migration 111, `PgGovernorStore`,
  boot wiring, 3 PG integration tests.

**Test totals added/kept green this session:** papercup-shared agent+resilience suite 84 unit
(governor 19 incl. 2 shared-budget seam tests; fault-injection 18; registry 9; turn-error 16;
turn-runner 8; retry 5; chat-stream 9) + operator RB-007 PG integration 3 + RB-009 operator suite
(observer 4, orchestrator-runner 13, tools-md-sync 46).

**Discovered (out-of-scope, flagged not fixed):** `apps/operator/lib/operator-rate-limit.ts` writes
jsonb via `${JSON.stringify(payload)}::jsonb`, which **double-encodes** under postgres-js (the jsonb
column ends up holding the stringified JSON, not the object) — so its transactional read-modify-write
likely never persists state correctly (the per-workspace scan rate-limit + 503 breaker would silently
reset every call). RB-007's `PgGovernorStore` avoids this by using `sql.json()`. **Recommend a
follow-up to fix operator-rate-limit.ts the same way + add a round-trip test.**

**Live-flag posture:** `PAPERCUSP_AGENT_GOVERNOR` (per-call governance) and
`PAPERCUSP_AGENT_GOVERNOR_PG` (cross-process budget) both still default OFF. All pre-flip review
items are resolved, so flipping is now a *rollout decision* (best done with one human-watched live
A/B), not a *correctness* blocker — left OFF pending that watched run rather than flipped blind
overnight. See the final note at the very bottom.

## Findings during implementation (2026-06-02)

- **Core mechanism built + flag-gated (P-001/002/003/011/004), 41 tests, all committed.**
  The judge / in-app brains / sim-user (in-process meridian) are now governed when
  `PAPERCUSP_AGENT_GOVERNOR=1`; default OFF = byte-identical live path.
- **Two distinct CLI spawn sites — only one matters for the burst.** `runAgentChat`'s CLI
  branch (chat-stream.ts) serves the LOW-concurrency in-app **brains** (oracle/agent-chats)
  and is a large inline streaming generator; gating it is an invasive extraction for modest
  value. The harness/gym **pipeline** agents are spawned elsewhere — the DBOS
  `orchestrator-runner.realRunner` → `invoke-once` path (apps/operator/lib/dbos) — which is
  the real burst/rate source. → **Re-scope: P-005 deferred (low value); P-006 is the key
  remaining lever.**
- **The gym's trip is RATE, not concurrency.** `runAbEvaluation` already runs runs
  sequentially, so the gym doesn't fan out pipelines — the 429s come from the *rate* of
  sequential agent calls (RPM) interleaved with the Opus judge. So the fix is RPM pacing +
  retry-after honoring (P-004 done for the judge; P-006 for the pipeline spawn rate), not a
  big concurrency cap.
- **P-006 is validatable ZERO-LLM** via the fake-agent gym smoke with the flag on (it
  exercises the spawn-pacing logic without real rate limits) — so it can be built + proven
  safely; flip the live flag only after that + the real A/B.

## Review incorporated (2026-06-02 — peer review, accepted nearly wholesale)

A strong peer review confirmed the diagnosis and found real defects. Accepted + status:

**Fixed already (committed):**
- **Hot-loop on missing retry-after** (reviewer #1) — `rate_limited`/`overloaded` with no
  server hint (our exact subscription 429s + most 529s) now falls back to exponential
  backoff (shared-governor penalty), bounded by maxWaitMs; was burning all attempts
  instantly — a regression vs the legacy loop. DONE + 2 tests.
- **Miscalibrated estTokens=max_tokens** (reviewer #4) — dropped (max_tokens ≠ OTPM). DONE.

**To fix before flipping the live flag / building more on top — ALL RESOLVED (2026-06-02):**
- **Abortable governor waits + per-turn maxWait** (strategic #3) — ✅ DONE (`acquire(est, {signal,
  maxWaitMs})` bails to null; commit sub `70c881d`). An interactive caller surfaces/escalates
  (D-002) instead of inheriting a far-off shared pause; unattended callers pass a large/Infinity
  maxWait and just wait.
- **Token-bucket inert on the subscription** (reviewer #2/#3/#5) — ✅ DONE (D-006). `limitModel`
  is now a **runtime credential fact** (`resolveLimitModel`/`resolveProviderLimitModel` from env,
  surfaced per bucket in `dev:rate_governor_status`), not a compile-time const. Subscription-mode is
  honestly "concurrency + rpm + honor-retry-after + never-crash"; the ITPM/OTPM token-bucket
  activates only when an API key is present (its `*-ratelimit-*` headers auto-tune the limits).
- **Subprocess classification** (reviewer #6) — ✅ DONE. Classifier prefers exit codes/signal +
  `--output-format json|stream-json` (regex is the fallback), and `runAgentChat` now has a
  wall-clock **subprocess turn-timeout** (`PAPERCUSP_AGENT_TURN_TIMEOUT_MS`, default 15m) →
  SIGTERM/SIGKILL + `timedOut` → classified `timeout`.
- **Window semantics** (reviewer #7/#8) — ✅ DONE. The tumbling-60s window is now honestly
  documented (it's not a continuously-replenished bucket), and **"slow as remaining drops"** is
  implemented: `recordHeaders` derives a capped `paceDelayMs` from low `*-remaining` headers so we
  glide toward a reset instead of slamming into remaining=0 (no longer all-or-nothing).

**Strategic reframes (accepted):**
- **D-006 decided FIRST** (was "normal" → now the crux; see below). Determines whether the
  token-bucket is real (API key) or descoped.
- **Cross-process store seam NOW, not P-007-as-rewrite.** The governor holds plain in-memory
  state with no store seam → cross-process would be a rewrite. Add an injected store seam now
  (mirror `@papercusp/rate-limit`'s `BucketStore`) so P-007 is a swap and callers don't churn.
  NUANCE: the gym A/B is single-process + sequential → in-process suffices for the GYM/P-014;
  cross-process is the FLEET fix.
- **Elevate prompt-caching (RB-008) ahead of RB-007** — caching the 32k-thinking judge's
  stable prefix dodges ITPM; likely the cheapest pressure relief.
- **SLO for "pacing works"** — RB-010 must assert 429-rate < X% AND throughput within Y% of
  uncapped (so we can tell well-paced from needlessly throttled), not just "survived a 429".

**Plan hygiene:**
- **Renumber this plan's items `P-NNN` → `RB-NNN`** — `P-NNN` collides with the gym plan's
  P-001..P-030 AND existing `P-006` comments elsewhere (autoloop/periodic-workflows). (Built
  items map: RB-001 taxonomy, RB-002 governor, RB-003 wrapper, RB-004 meridian, RB-011
  registry.) Future commits use RB-.
- Components section is stale (everything landed in `libs/papercup-shared/src/agent/*`, not a
  new `@papercusp/agent-governor`); note the relationship to `@papercusp/rate-limit` (different
  algorithm, same store-seam pattern to reuse).

## Scope additions (2026-06-02 — user directives #1–#3)

- **(#1) The framework is generic; the REGULAR fleet must benefit, not just the gym.** The
  core (`turn-error`/`governor`/`runAgentTurn`) is already backend-agnostic + harness-agnostic
  — nothing gym-specific. The gap is wiring: only the meridian path (RB-004) is wired. The
  regular fleet benefits via RB-012 below.
- **(#2) Migrate ALL existing agent surfaces — now in scope (RB-012).**
- **(#3) Split the GENERIC retry/governor out of the agent layer (RB-013).** Retry +
  backoff + rate-limit-governance is a universal concern, so it belongs in an
  agent-independent shared lib; the agent-specific taxonomy/classification depends on it.

- **RB-012** `done` Migrate every agent-calling surface onto the shared governor (so the
  WHOLE fleet gets pacing + never-crash, not just the gym). All flag-gated on
  `PAPERCUSP_AGENT_GOVERNOR` (default OFF = byte-identical legacy path). Surfaces wired:
  - **meridian in-process `llmCall`** (gym judge, sim-user, haiku, operator/oracle brains)
    → `governedMeridian` in `chat-stream.ts` (RB-004).
  - **`runAgentChat` CLI spawn** (claude/omp/codex brains) → acquire-before-spawn +
    penalize-on-429 + release-in-`finally` in `chat-stream.ts` (RB-005/RB-012).
  - **orchestrator pipeline spawn** (`spawnInvokeOnce`, the burst path) → governed in
    `orchestrator-runner.ts` (pacing only; the director owns retry — no double-retry).
  - **scoper background spawn** (`invokeScoperBackground`) + **expert dispatcher spawn**
    (`dispatchExpert`) → the new shared `governed-background-spawn.ts` helper
    (`spawnInvokeOnceBackground`) for the scoper; expert-dispatcher acquires before its
    spawn and releases in `finalise()` (rides the file-lock lifecycle, leak-safe).
  Each was validated flag-OFF (existing tests unchanged) + flag-ON (governor unit/route/
  helper tests + the live meridian/CLI paths). The one non-spawn note: omp self-paces
  (fallback chaining) so it gets concurrency-cap only, by design. importance: high
- **RB-013** `done` (governor → `src/resilience/governor.ts`; `runWithRetry` →
  `src/resilience/retry.ts`; agent `turn-runner` now a thin wrapper; 49 tests) Extract the
  generic core — token-bucket + concurrency + exponential
  backoff + abortable/bounded waits + the retry-with-classification *policy loop* + a store
  seam (PG/in-memory, mirroring `@papercusp/rate-limit`'s `BucketStore`) — into an
  **agent-independent** module. PRAGMATIC TARGET: start as
  `libs/papercup-shared/src/resilience/*` (clean generic/agent split inside the existing
  shared submodule — no new submodule/repo to provision), promotable to a standalone
  `libs/generic/@papercusp/resilience` per BORROWABLE.md later. (rate-limit is a different
  algorithm — auth lockout — so a separate resilience module is justified, per reviewer.)
  The agent layer
  (`papercup-shared/src/agent/*`: TurnError taxonomy, `classifyTurnError`, backend profiles,
  the agent `runAgentTurn` wrapper) then **depends on** the generic lib. Reusable by any
  rate-limited/flaky I/O (substrate sync, external APIs, PG pools). The store seam also makes
  cross-process (RB-007) a swap, not a rewrite. importance: high blocked-by: (refactor of
  RB-002/003)

## Decisions (RESOLVED 2026-06-02 — judgment calls made under overnight autonomy, per the
## plan's own recommendations + the implementation. The user delegated these: "make any
## judgement calls you deem appropriate.")

- **D-001** ✅ DECIDED: ship BOTH. In-process (RB-002) is the default fast path; the PG-backed
  cross-process governor (RB-007) is built + flag-gated (`PAPERCUSP_AGENT_GOVERNOR_PG=1`) for the
  shared-account fleet+gym. In-process first, PG-backed available second — as proposed.
- **D-002** ✅ DECIDED: pause-the-loop-and-resume-at-reset for unattended (gym pauses+resumes,
  run excluded from variance, never aborts — RB-006); interactive callers pass `{signal, maxWaitMs}`
  so `acquire()` bails to a structured TurnError → surface/escalate instead of inheriting a far-off
  shared pause. Implemented.
- **D-003** ✅ DECIDED: conservative **hard-coded** cold-start floors (`DEFAULT_FLOORS`:
  anthropic/openai `maxConcurrent 3, rpm 45`; omp/unknown concurrency-only), auto-tuned UP from
  `*-ratelimit-*-limit` response headers when present (API-key paths). Floor source = hard-coded
  conservative default (not config) — simplest, and the headers correct it upward in apiKey mode.
- **D-004** ✅ DECIDED: omp = self-pacing, **concurrency-cap only** (no token/req budget — we don't
  know which provider its internal call hit; its fallback chaining self-heals per-provider 429s).
  `BACKEND_PROFILES.omp.selfPacing = true` → 'self' bucket, concurrency only.
- **D-005** ✅ DECIDED: subprocess agents governed at the **spawn/turn level** (concurrency +
  spawn-rate cap + turn-outcome classification from exit/stderr/timeout), NOT per-internal-LLM-call
  (opaque + would double-retry the CLI's own retries). Coarser than meridian by design — the lever
  is "how many agents run at once," the actual burst cause.
- **D-006** ✅ DECIDED: `limitModel` is a **runtime credential fact** (`resolveLimitModel` reads
  `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` from env). Subscription (Max/ChatGPT OAuth, the dev-box
  default) = coarse concurrency+rpm+honor-retry-after; pointing a backend at a raw **API key**
  automatically flips it to precise header-driven token-bucket mode (no code change) — which is the
  config path to run the gym judge/pipeline on a dedicated key (precise limits + separate bucket from
  the Max account). Surfaced per bucket in `dev:rate_governor_status`.
- **D-007** ✅ DECIDED: separate governor buckets per `(provider, modelClass)` — Anthropic (claude
  meridian+CLI) and OpenAI (codex) are distinct buckets; opus/sonnet/haiku are distinct within
  Anthropic. omp collapses to one concurrency-only 'self' bucket (self-pacing). Implemented in
  `governorForBackend`/`modelClassOf`.

## Final note — turning it on (the one remaining human decision)

The mechanism is complete, correct, and tested; what's left is purely a rollout choice that wants a
human watching, so it was deliberately NOT flipped blind overnight:

1. **`PAPERCUSP_AGENT_GOVERNOR=1`** — turns on per-call governance for meridian + the CLI spawns.
   Recommended first live proof: run the gym A/B with it on (the plan's intended "live proof") and
   confirm it paces under the limit + never fails on a transient 429. Then leave it on for the fleet.
2. **`PAPERCUSP_AGENT_GOVERNOR_PG=1`** — additionally shares the budget cross-process (fleet + gym +
   dev sessions on one account). Turn on once #1 is proven, when multiple operator processes /
   parallel pipelines actually run concurrently (single-process/sequential gym doesn't need it).
3. **Optional capacity unlock (D-006):** set `ANTHROPIC_API_KEY` for a backend → it flips to precise
   header-driven token-bucket mode + a separate bucket from the shared Max account.

Suggested follow-up (separate from this plan): fix the `operator-rate-limit.ts` jsonb double-encode
noted in Completion.
