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

- **claude** — meridian: SDK `APIError.status` + response headers (read `retry-after` +
  `anthropic-ratelimit-*`); CLI (`claude -p`): exit code + stderr ("rate limit"/"429"/
  "overloaded"). Anthropic bucket.
- **omp** — CLI subprocess; detect 429/overload from its output/exit; Anthropic bucket
  (it proxies Anthropic) — shares the claude governor for the same account/model-class.
- **codex** — CLI subprocess; OpenAI-style limits → a **separate** governor bucket
  (provider=openai); detect 429 from exit/stderr.

## Items

- **P-001** `todo` `TurnError` taxonomy + `classifyTurnError(backend, raw)` — pure +
  table-driven; unit tests incl. claude/omp/codex stderr + meridian-APIError fixtures.
  importance: high
- **P-002** `todo` `RateLimitGovernor` (in-process token-bucket RPM/ITPM/OTPM +
  concurrency cap + `retry-after`/reset honoring + pre-emptive slow on low remaining);
  property/unit tests with a fake clock. blocked-by: P-001 importance: high
- **P-003** `todo` `runAgentTurn()` wrapper (governor.acquire → backend → record →
  classify → policy; returns `TurnResult|TurnError`, never throws on handled classes).
  blocked-by: P-001, P-002 importance: high
- **P-004** `todo` Rewrite `meridianAgentChat` to honor `retry-after` + `*-reset` headers
  and go through `runAgentTurn` (the immediate fix for judge/gym/brains). blocked-by:
  P-003 importance: high
- **P-005** `todo` Wrap the CLI spawn path (claude/omp/codex) in `runAgentChat` —
  classify 429/overload from exit+stderr, route through the governor. blocked-by: P-003
  importance: high
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
