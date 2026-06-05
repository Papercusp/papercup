# memory-backend benchmark — findings for the revive-vs-retire call (DRAFT)

> **Status: DRAFT** — T1/T2 baseline complete (run artifact
> `memory-bench-2026-06-05T14-25-04-692Z.{json,md}`). Pending before this
> goes to the owner: P-010 scale curve (su-62aed), P-008 T3 judged tier +
> P-009 T4 boot-recall tier (su-2b227). Per D-006 this document INFORMS;
> the decision is the owner's.

Corpus: the real Claude store frozen at 114 entries (corpus.v1). Gold set:
150 frozen queries (gold-set.v1) — 40 lexical-gap / 35 exact-identifier /
30 hard-negative / 45 session-start-intent. Both backends seeded
byte-identical (verbatim writes); NoopBackend control read clean zeros.

## D-006's falsifiable predictions, checked

| prediction | verdict | evidence |
| --- | --- | --- |
| mem0 wins lexical-gap | **CONFIRMED** | MRR 0.81 vs 0.42; the file backend misses over half the paraphrased-symptom queries outright |
| mem0 wins scale | _pending P-010_ | — |
| file wins exact-identifier | **CONFIRMED** (narrowly) | MRR 0.99 vs 0.87 — embeddings stay usable on identifiers, grep is near-perfect |
| file wins latency | **CONFIRMED** (×47) | search p50 20ms vs 939ms, p95 28ms vs 3145ms. Caveat: mem0's latency is dominated by an OpenAI embed per query; the local-BGE embedder path would change this and was NOT measured |
| file wins cost | **CONFIRMED** | $0 vs ~$0.43/1k remembers (extraction path; verbatim writes are ~$0.002/1k) + $0.0004/1k searches. At the real workload (~hundreds of ops/day) both round to ~$0/month |
| near-dup caught by mem0's dedup | **REFUTED** (this run) | 0/6 near-dups merged — the gpt-4o-mini additive extractor chose ADD every time. May differ under Haiku once the credential is rotated; not re-tested |

## Findings beyond the predictions

1. **mem0 is no longer stillborn.** The "broken embed path" was a stale
   Anthropic credential 401-ing fact-extraction, swallowed by mem0 into
   silent no-ops (D-007). With the cascade fix (falls back to the OpenAI
   extractor), mem0 seeded 114/114 and round-tripped writes 6/6. The
   credential itself still needs rotation (owner action).
2. **Neither backend has false-positive discipline.** FP@5 = 100% on BOTH:
   every hard-negative query returned hits. Score separability exists but
   overlaps — mem0 positives median 0.549 vs negatives 0.385 (neg p90
   0.460); file 0.458 vs 0.250 (neg p90 0.367). Any consumer that injects
   top-K results without a score threshold will inject noise on
   out-of-corpus intents *with either backend*.
3. **P@5 is ceiling-limited, not informative.** 85/120 positive queries
   expect exactly one memory → the P@5 ceiling is ~27%; mem0 24% / file
   20% sit near it. MRR and R@10 are the discriminative columns: R@10
   mem0 97% vs file 82% — at limit 10, embeddings nearly always surface
   the right memory somewhere; grep misses it entirely ~1 time in 5.
4. **Write-side paraphrase recall mirrors lexical-gap:** a fact written
   then searched by paraphrase: mem0 5/6 in top-3, file 0/6. The file
   backend only finds writes by their own vocabulary.
5. **Operational parity elsewhere:** update/forget honored 6/6 both;
   12/12 concurrent writes both; fresh-instance recall (restart analogue)
   both. The structural difference is reach: mem0 = any process with PG;
   file = same-box FS (+ the ~24.4KB MEMORY.md index cap, already hit
   once at 112 entries — scale tier will quantify).
6. **The session-start-intent class (the actual boot workload) is close:**
   MRR 0.88 (mem0) vs 0.85 (file) — at the current 114-entry scale, the
   realistic workload barely differentiates; the gap lives in the
   adversarial classes.

## Pending sections

- **Scale curve (P-010):** quality + latency at 111 → 1k → 10k, the
  file-index cap behavior. (D-006: "the verdict hinges on … whether
  lexical-gap recall matters at ~100-memory scale vs 1k+".)
- **T3 judged usefulness (P-008):** ~25 queries, frozen judge.
- **T4 boot-recall e2e (P-009):** does injection actually surface the
  gotcha in a live operator session.

## Owner actions queued regardless of the call

1. Rotate the Anthropic API key in operator credentials (stale, 401) —
   /settings/api-keys. Extraction currently rides the OpenAI fallback.
2. Decide the false-positive policy for injection consumers (score
   threshold / abstain heuristic) — needed under EITHER backend (finding 2).
