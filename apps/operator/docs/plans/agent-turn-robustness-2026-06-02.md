---
title: Agent turn-error robustness + rate-limit awareness (claude/omp/codex)
slug: agent-turn-robustness-2026-06-02
status: proposed
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
- **P-005** `todo` Wrap the CLI spawn path (claude/omp/codex) in `runAgentChat` at the
  **subprocess-turn** granularity: enforce the concurrency + spawn-rate cap (the burst
  fix), classify the turn outcome from exit+stderr (P-011 extractors), apply policy
  (wait-until-reset/backoff/pause/escalate) — and **do NOT re-retry the CLI's own
  internal LLM retries**. omp = concurrency-cap only (self-pacing); codex = OpenAI bucket;
  claude-CLI = Anthropic bucket. blocked-by: P-003, P-011 importance: high
- **P-006** `todo` Orchestrator/DBOS + gym integration — `rate_limited` → wait-until-reset
  + a rate-limit-pause/resume state (not a crash); gym `evaluate` resilient to per-run
  `TurnError`. blocked-by: P-004, P-005 importance: high
- **P-007** `todo` PG-backed cross-process governor (`agent_rate_budget`, leased) so the
  fleet + gym + this dev session share ONE Anthropic-account budget. blocked-by: P-002
  importance: normal
- **P-008** `todo` Prompt-caching pass on stable prefixes (system prompts, tool defs) to
  cut ITPM. importance: normal
- **P-009** `todo` Observability: headroom + 429 telemetry; coord/UI "rate-limited —
  paused until <reset>" status. blocked-by: P-003 importance: normal
- **P-010** `todo` Fault-injection tests (mock 429 with retry-after, 529, timeout, crash,
  empty/malformed) per backend → assert no parent crash + correct wait/resume. The gym
  A/B is the live proof: it paces under the limit + never fails on a transient 429.
  blocked-by: P-006 importance: high

## Decisions (open)

- **D-001** Governor scope first: in-process (P-002) is enough for a single runner; the
  shared-account fleet+gym genuinely needs PG-backed (P-007). Ship in-process first,
  PG-backed second — agree?
- **D-002** On a handled-but-exhausted `rate_limited` turn with a far-off reset, default
  policy = **pause the loop + resume at reset** (vs escalate-to-human vs skip). For the
  gym (unattended, bounded) pause+resume; for interactive chat, surface + let the user
  decide. Confirm.
- **D-003** Read limits dynamically from headers (auto-tune) + a conservative static
  floor for the cold start (before we've seen headers). Confirm the floor source
  (config vs hard-coded conservative default).
- **D-004** **omp granularity:** treat omp as self-pacing (rely on its fallback chaining
  for per-provider 429s) and govern it with a **concurrency cap only** — vs trying to
  parse/pace omp's internal multi-provider calls (opaque, and we'd fight its fallback).
  Recommend concurrency-only. Confirm.
- **D-005** **Subprocess granularity:** for claude-CLI/codex/omp, govern at the
  spawn/turn level (concurrency + spawn-rate + turn-outcome classification), NOT
  per-internal-LLM-call (opaque + would double-retry). Confirm this is acceptable (it
  means our pacing for subprocess agents is coarser than for meridian — the lever is
  "how many agents we run at once," which is the actual burst cause).
- **D-006** **Subscription vs API key:** the meridian/claude path is on the Max
  *subscription* (coarse, no per-minute headroom) — so the precise header-driven
  token-bucket only fully applies if/when we point a backend at a raw **API key**.
  Question: do we want a config option to run the gym judge (and/or pipeline) on a
  dedicated **Anthropic API key** (precise limits + separate bucket from the shared Max
  account) — which also unblocks the P-014 run independent of the Max rate window? This
  is the cleanest path to both robustness AND immediate capacity.
- **D-007** **Provider buckets:** confirm separate governor buckets per provider —
  Anthropic (claude meridian+CLI, + omp-if-routed-to-Anthropic) and OpenAI (codex, +
  omp-if-routed-to-OpenAI) — with omp's shared-account overlap declared in config so it
  shares the relevant concurrency cap.
