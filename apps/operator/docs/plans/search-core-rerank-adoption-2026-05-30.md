---
title: Adopt @papercusp/rerank + search-core (Stage-B rerank over RRF)
slug: search-core-rerank-adoption-2026-05-30
status: ready
created: 2026-05-30
updated: 2026-05-30
owner: avi@storewolf.com
related: [BRIEF-search-extraction-2026-05-30, papercusp-systems-abstraction-2026-05-29]
---

# Adopt @papercusp/rerank + search-core (Stage-B rerank over RRF)

## Now

**State:** Code-complete and verified on `main`. The papercup side of the
Restart handoff (`HANDOFF-papercup-search-core-adoption`, full spec in Restart's
`docs/plans/search-core-papercup-adoption-2026-05-30.md`) is wired: a fail-safe
cross-encoder rerank stage now sits on top of `@papercusp/search`'s RRF-fused
output at all three prose-search call sites. It is **gated off until a
`ZEROENTROPY_API_KEY` is provisioned** — with no key the helper returns the RRF
order unchanged, so the wiring is a pure no-op today and turns on the day a key
is added. Verified: `@papercusp/search-core` 47/47 + typecheck clean; the new
`rerank.test.ts` 6/6 (fail-safe passthrough, slice-to-limit, ≤1-hit, outage →
passthrough, active reorder + doc mapping, env-var key); operator `tsc` zero NEW
errors (601 pre-existing baseline); live `search:fulltext`/`search:semantic`
dispatch preserves output shape.

**Next:** Human: provision a `ZEROENTROPY_API_KEY` (settings → API keys → "ZeroEntropy
API key", stored in `operator_credentials`) to turn the rerank on, then run the
P-3 golden-set eval before enabling it as the default ordering.

## Background

papercup and Restart independently built the two complementary halves of one
search pipeline, both under `@papercusp`, same design DNA (host-agnostic,
injected deps, zero schema coupling, fail-safe):

| Stage | Package | Owner | Does |
|---|---|---|---|
| **A — retrieve + fuse** | `@papercusp/search` + `@papercusp/rrf` | papercup | BM25 (`ts_rank_cd`) + pgvector cosine, fused via RRF. |
| **B — rerank** | `@papercusp/search-core` + `@papercusp/rerank` | Restart | cross-encoder rerank (zerank-2) + eval metrics. |

papercup's search stopped after Stage A. This adopts Stage B as a consumer-side
post-step on the fused list.

## What shipped

- **Submodules** (private, Papercusp org, https to match `.gitmodules`):
  `libs/rerank` (`@papercusp/rerank`, dep `zeroentropy`) and `libs/search-core`
  (`@papercusp/search-core`, dep `@papercusp/rerank`). Wired like the other
  `@papercusp/*` packages: root `workspaces` entries, `apps/operator`
  `file:` deps, `node_modules/@papercusp/*` symlinks, `zeroentropy@0.1.0-alpha.10`
  in the lockfile. Src-as-entry, no build step.
- **Credential** `zeroentropy_api_key` — added to the `Credentials` interface +
  `maskCredentials`, the `/api/credentials` POST allow-list, and the
  settings → API keys "Core" form (same surface as the embedder's OpenAI key).
- **Helper** `apps/operator/lib/agent-tools/search/rerank.ts` —
  `rerankProseHits(query, hits, limit)`. Reads the key from `operator_credentials`
  (env fallback); **only then** dynamically imports `@papercusp/search-core` and
  calls `rankWithReranker` — so with no key the rerank lib (and its `zeroentropy`
  dep) is never even imported. Wrapped in try/catch → any failure returns the RRF
  order. Generic rerank only: no `instruction`, no `llm` (search-core's defaults
  are e-commerce and do not transfer); `qualityScore = hit.score` as the
  within-bucket tiebreak.
- **Wiring** at the three prose consumers, via the shared helper, before output
  mapping: `agent-tools/search/semantic.ts`, `agent-tools/search/fulltext.ts`,
  `endpoint-route/routes/user/search.ts`.

## Decisions

- **D-001 — Consumer-side, not an engine hook.** The rerank is a post-step on
  `@papercusp/search`'s output; the retriever stays pure. (Brief §6a; revisit an
  engine `rerank?` hook only if a third consumer wants identical reranking.)
- **D-002 — Rerank the returned page, not an over-fetched pool (first cut).**
  `runHybridSearch`/`runFullTextSearch` already slice to `limit` internally, so
  the helper reorders the top-`limit`. Reranking a larger candidate pool (to pull
  a buried-but-relevant hit *into* the page — rerank's bigger win) is deferred:
  it adds DB cost on every search and is premature to tune before a key exists and
  the eval (P-3) justifies it. The upgrade is a one-line change per consumer
  (request `limit * pool` from the engine; the helper already slices down).
- **D-003 — Generic cross-encoder only.** No instruction/LLM/rewrite stages —
  those default to e-commerce. If we later want instruction-following, pass our
  OWN agent-memory prompts, never search-core's `DEFAULT_RERANK_INSTRUCTION` /
  `defaultLlmRerankPrompt` / `defaultRewritePrompt`.

## Follow-ups (gated)

- **P-1 (human)** — provision `ZEROENTROPY_API_KEY` in `operator_credentials` to
  enable the rerank.
- **P-2 (human/agent)** — build a small judged golden set of agent-memory queries
  (escalations / turns / decisions) and score with search-core's `ndcg` /
  `precisionAtK`. Confirm the cross-encoder beats raw RRF before relying on it.
- **P-3** — if the eval justifies it: over-fetch a candidate pool (D-002) so the
  rerank can pull buried hits into the page.
