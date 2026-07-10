# Embedder cost: insufficient_quota ≠ rate-limit, and the spend backstop
URL: /internal/docs/agent-insights/embedder-cost-and-insufficient-quota-classification

OpenAI returns HTTP 429 for BOTH a transient rate-limit AND a permanent insufficient_quota (out of billing credit) — don't conflate them. Production embedding costs cents/month; a large "embeddings" bill is the benchmark, not steady-state. The embed-admission governor now carries a hard daily token cap, embed-backfill is governed + keyed by PK (not ctid), and a 429 insufficient_quota fails fast as embed_quota_exhausted.

import { Aside } from '@astrojs/starlight/components';

## The gotcha: OpenAI 429 means two unrelated things

`POST /v1/embeddings` returns **HTTP 429** for two conditions that need
opposite handling:

* **`rate_limit_exceeded`** — transient. Capacity exists; back off and
  retry and it clears.
* **`insufficient_quota`** — permanent until you act. The account is out
  of credit or hit its monthly billing cap. It fails **identically on
  every request, one or a thousand, regardless of load**, until billing
  is fixed.

Lumping all 429s into one "rate-limited, retrying" bucket once sent a
multi-hour investigation down the throughput/sharing path when the real
fix was **"the account ran out of credit — add billing."** The key was
valid (`/v1/models` → 200) and the box was idle, yet every embed 429'd.
Always read the response **body** — `insufficient_quota` is in the
error `type`/`code` — before assuming a rate problem.

`buildOpenAiEmbedder` (`memory/configure.ts`) now distinguishes them: a
429 whose body matches `insufficient_quota` is treated like a 401 —
**fail fast** (one attempt, no retry-budget burn), **don't** `penalize()`
the shared admission bucket (there's no reset window to wait for), and
throw a distinct `openai_embed_quota_exhausted`. `embedFailureReason`
(`op-deadline.ts`) maps it to reason **`embed_quota_exhausted`** so the
agent narrates *"OpenAI quota exhausted — check billing"* instead of
*"rate-limited, retrying."*

## Cost reality: embedding is cents; the benchmark is the spender

`text-embedding-3-small` is \~$0.02 per 1M tokens. The embeddable corpus
is tiny — \~15k rows total (`memory_vec_openai` + `operator_turns` + the
backfill tables) → embedding all of it **once ≈ $0.15**. Measured call
rate is \~90 memory/search tool calls/day. Steady-state embedding is
**cents/month.**

So if you see a surprising "$N on embeddings" bill, it is **not**
production recall. The dominant embed spender is the **memory/search
benchmark** (`lib/memory/bench` — `run-bench` / `precision-monitor`
re-embeds the whole corpus × every backend variant × repeats per run).
Those runs use **ephemeral scopes** they create and drop, so they leave
**no rows** in `memory_precision_bench` — untraceable from the DB, but
it's the documented org-TPM burner. It is budget-gated:
`iq-battery/cadence-tick` **refuses** an unattended run without an
owner-set `budgetUsd`.

For scale: the agent fleet spends on the order of **$1k/day on opus**
(the mug). Tens of dollars/month on OpenAI embeddings is a rounding
error against that — diagnose a "high embedding bill" as a bench/dev
artifact first, not a production-recall regression.

## The spend backstop: a hard daily token cap

The `embed-admission` governor historically capped only the **rate**
(itpm + maxConcurrent) — a run that stays under the rate cap can still
accumulate a large bill over hours. It now also carries a hard
**daily cumulative token budget**:

* `EMBED_DAILY_TOKEN_CAP` (env `PAPERCUSP_EMBED_DAILY_TOKEN_CAP`,
  default **5,000,000 tokens/day ≈ $0.10/day**; `0` disables).
* Once a UTC-day's estimated embed tokens exceed it, `acquire()` throws
  `EmbedBudgetExhaustedError` for **both** lanes → reason
  **`embed_budget_exhausted`**.
* It is enforced **even when the `EMBED_ADMISSION` flag is off** — a
  spend ceiling must not be defeatable by the rate-governing toggle.
* It logs loudly **once per day** when it binds, and `adm.usage()`
  exposes the running day-token count for monitoring.

The default is \~300× real usage, so it never trips in normal operation
but hard-stops a runaway (a bench/backfill loop) before it can drain a
low-balance key. Raise the env var if a legitimate bulk re-embed needs
more headroom.

## All three embed paths now go through the one governor

There are three OpenAI embed call sites. Two already used the governor;
`embed-backfill.ts` was the **one ungoverned raw-fetch path** — so
neither the rate cap nor the spend cap applied to it. It is now routed
through the shared `embedAdmission()` (bench lane), so the single
choke point covers everything:

| Path                                 | File                                        | Lane     |
| ------------------------------------ | ------------------------------------------- | -------- |
| memory:\* (mem0)                     | `memory/configure.ts` `buildOpenAiEmbedder` | `memory` |
| search:semantic / work\_items:search | `agent-tools/search/embedder.ts`            | `bench`  |
| embed-backfill (5-min DBOS sweep)    | `search/embed-backfill.ts`                  | `bench`  |

## The embed-backfill ctid bug (fixed)

`embed-backfill.ts` walks rows `WHERE embedding IS NULL` and fills them
in 5-minute sweeps. It used to target the `UPDATE` by **`ctid`** for 3 of
4 tables. `ctid` is a **physical row pointer that changes on any UPDATE
or (auto)VACUUM**, which caused:

1. **Re-embed loop / token burn** — if a row's ctid drifted between the
   `SELECT` and the `UPDATE … WHERE ctid=$`, the update matched nothing,
   the embedding stayed `NULL`, and the row was re-embedded **every 5
   minutes forever.**
2. **Wrong-row clobber** — a reused ctid could write one row's embedding
   onto a different row.
3. **A latent hot-loop** — the inner `while(true)` re-`SELECT`s
   `IS NULL` rows; a row whose embed *persistently* fails (e.g. every
   request 429s during a quota outage) is re-selected forever, spinning
   the loop and re-spending each pass.

Fixed by keying the `UPDATE` on the real **PRIMARY KEY** (composite where
needed: `operator_turns(id)`, `harness_escalations`/`harness_brainstorm`
`(harness_slug,phase)`, `harness_decisions(harness_slug,line_hash)`) +
guarding `AND embedCol IS NULL`, plus a **zero-progress break** (stop the
sweep when a full batch embeds nothing — the remaining NULLs are
persistent failures; the next tick retries).

## Runbook

* **`memory:search`/`remember` returns `embed_quota_exhausted`** → the
  OpenAI account is out of credit. Add credit / raise the spend cap at
  platform.openai.com → Billing, **or** switch memory to the local
  embedder (`PAPERCUSP_MEMORY_EMBEDDER=local`). The key itself is fine.
* **`embed_budget_exhausted`** → *our* daily cap tripped (a runaway, or
  a legitimate bulk re-embed). Check the once-per-day
  `[embed-admission] DAILY embed spend cap hit` log; raise
  `PAPERCUSP_EMBED_DAILY_TOKEN_CAP` if it's real load.
* **`embed_rate_limited`** (frequent) → a *true* transient 429. A fresh
  OpenAI key often starts at a **low TPM tier**; if it's chronic, lower
  `PAPERCUSP_EMBED_ITPM` (default 600k) to match the key's tier at
  platform.openai.com → Limits. 429s aren't billed; search/memory
  degrade gracefully (BM25 / passthrough+retry).
* **"Why did embeddings cost $N?"** → it's almost certainly a benchmark
  run, not steady-state recall. Confirm steady-state with the
  memory/search tool-call rate in `tool_invocations`.
* **Rotating the OpenAI key** → `POST /api/credentials` now invalidates
  the cached mem0 client on a key change, so it takes effect immediately
  (no ≤1h client-TTL wait).
