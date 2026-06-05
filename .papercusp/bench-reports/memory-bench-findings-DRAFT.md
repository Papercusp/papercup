# memory-backend benchmark — findings for the revive-vs-retire call (DRAFT)

> **Status: DRAFT** — T1/T2 baseline complete (canonical run artifact
> `memory-bench-2026-06-05T14-40-41-392Z.{json,md}`; an earlier 14-25-04Z
> run was discarded — it predated the limit/topK fix below and slightly
> inflated mem0's MRR/R@10). **P-010 scale tier DONE** (su-62aed; run
> `memory-bench-2026-06-05T14-45-53-264Z.{json,md}` + index-cap probe
> `index-cap-2026-06-05T14-40-52-437Z.{json,md}` — folded in below).
> Pending before this goes to the owner: P-008 T3 judged tier + P-009 T4
> boot-recall tier (su-2b227). Per D-006 this document INFORMS; the
> decision is the owner's.

Corpus: the real Claude store frozen at 114 entries (corpus.v1). Gold set:
150 frozen queries (gold-set.v1) — 40 lexical-gap / 35 exact-identifier /
30 hard-negative / 45 session-start-intent. Both backends seeded
byte-identical (verbatim writes); NoopBackend control read clean zeros.

## D-006's falsifiable predictions, checked

| prediction | verdict | evidence |
| --- | --- | --- |
| mem0 wins lexical-gap | **CONFIRMED** | MRR 0.81 vs 0.44; the file backend misses over half the paraphrased-symptom queries outright |
| mem0 wins scale | **REFUTED on quality, CONFIRMED on latency** (P-010) | quality INVERTS: mem0 MRR 0.86→0.76→**0.05** at 111→1k→10k while file holds 0.745→0.737→0.726 (lexical scoring is scale-invariant); but mem0's *latency* stays flat (986ms, hnsw sublinear) while file's grows 14→86→**803ms** (linear re-read). See the Scale tier section — single-pool worst case; scoping is the untested mitigation. |
| file wins exact-identifier | **CONFIRMED** (narrowly) | MRR 1.00 vs 0.86 — grep is perfect on identifiers, embeddings stay usable |
| file wins latency | **CONFIRMED** (×35-150) | search p50 26ms vs 977ms, p95 33ms vs 5184ms. Caveat: mem0's latency is dominated by an OpenAI embed per query; the local-BGE embedder path would change this and was NOT measured |
| file wins cost | **CONFIRMED** | $0 vs ~$0.43/1k remembers (extraction path; verbatim writes are ~$0.002/1k) + $0.0004/1k searches. At the real workload (~hundreds of ops/day) both round to ~$0/month |
| near-dup caught by mem0's dedup | **REFUTED** (this run) | 0/6 near-dups merged — the gpt-4o-mini additive extractor chose ADD every time. May differ under Haiku once the credential is rotated; not re-tested |

## Findings beyond the predictions

1. **mem0 is no longer stillborn.** The "broken embed path" was a stale
   Anthropic credential 401-ing fact-extraction, swallowed by mem0 into
   silent no-ops (D-007). With the cascade fix (falls back to the OpenAI
   extractor), mem0 seeded 114/114 and round-tripped writes 6/6. The
   credential itself still needs rotation (owner action).
2. **The bench caught two real production bugs on the mem0 path.**
   (a) `Mem0Backend.search` passed `limit`, which mem0's `Memory.search`
   ignores in favor of `topK` (default 20) — every consumer, including
   the operator's pre-turn injection, silently over-fetched double the
   requested window. Fixed (topK now passed; pinned by a lib test).
   (b) The canonical store funneled all queries through one `pg.Client`
   (deprecated interleaving, removed in pg@9; a serialization bottleneck
   under concurrent writes) — now a small `pg.Pool`, live-verified with
   12 concurrent writes.
3. **Neither backend has false-positive discipline.** FP@5 = 100% on BOTH:
   every hard-negative query returned hits. Score separability exists but
   overlaps — mem0 positives median 0.549 vs negatives 0.385 (neg p90
   0.460); file 0.458 vs 0.250 (neg p90 0.367). Any consumer that injects
   top-K results without a score threshold will inject noise on
   out-of-corpus intents *with either backend*. (mem0 applies a default
   score threshold of 0.1 internally — far below the separation point.)
4. **P@5 is ceiling-limited, not informative.** 85/120 positive queries
   expect exactly one memory → the P@5 ceiling is ~27%; mem0 24% / file
   20% sit near it. MRR and R@10 are the discriminative columns: R@10
   mem0 91% vs file 82% — within a 10-result window, grep misses the
   right memory ~1 time in 5, embeddings ~1 in 11.
5. **Write-side paraphrase recall mirrors lexical-gap:** a fact written
   then searched by paraphrase: mem0 5/6 in top-3, file 0/6. The file
   backend only finds writes by their own vocabulary.
6. **Operational parity elsewhere:** update/forget honored 6/6 both;
   12/12 concurrent writes both; fresh-instance recall (restart analogue)
   both. The structural difference is reach: mem0 = any process with PG;
   file = same-box FS (+ the ~24.4KB MEMORY.md index cap — now quantified
   in the Scale tier section: boot-injection reach bounded at ~115 entries
   and currently *stale* because the durables alone are over the hard cap).
7. **The session-start-intent class (the actual boot workload) is close:**
   MRR 0.88 (mem0) vs 0.83 (file) — at the current 114-entry scale, the
   realistic workload barely differentiates; the gap lives in the
   adversarial classes.

## Scale tier (P-010) — the curve inverts the prediction

Synthetic distractors (deterministic, seeded PRNG) layered around the real
114-corpus to 1k then 10k; the frozen gold set replayed at each size. The
distractors are **domain-faithful dev gotchas** ("the scheduler's
connection pool hangs on shutdown… Fix:… diagnosed via X on :PORT;
returns E1234") — i.e. what a real large engineer-memory store actually
fills up with, not adversarial noise.

| size | mem0 P@5 / MRR / search-p50 | claude-file P@5 / MRR / search-p50 |
| --- | --- | --- |
| 114 | 24% / 0.86 / 1016ms | 20% / 0.745 / 14ms |
| 1,000 | 21% / 0.76 / 986ms | 20% / 0.737 / 86ms |
| 10,000 | **1% / 0.05** / 986ms | 19% / 0.726 / **803ms** |

**What happens, and why.** mem0's retrieval *quality* collapses at 10k
(MRR 0.86→0.05) while its *latency* stays flat (hnsw is sublinear — the
986ms is the constant per-query OpenAI embed, not index growth). The
collapse is **ranking-out, not drop-out**: all 10k seeded (0 failures),
MRR 0.05 ≠ 0 so targets still exist — they're just buried. In a vector
store filled with thousands of *same-domain* memories, the one relevant
fact ranks below hundreds of near-neighbors at comparable cosine. The
file backend's **lexical** scoring is naturally robust to this: the
distractors share few *exact* tokens (specific identifiers/filenames/tool
names) with a gold query's expected memory, so they don't crowd the
lexical top-10 — quality is essentially flat across 100×, only the
full-re-read latency grows linearly.

**The decisive caveat — single-pool worst case (untested mitigation).**
The bench seeds all 10k into ONE scope (`'bench'`) and queries unscoped,
so every query races the entire 10k. A real deployment **scopes** memory
(`local` / per-harness / per-project — the `scope` param is live and
used), so a real query races only that scope's memories — far fewer than
10k. The 10k single-scope collapse is therefore the worst case w.r.t.
scoping; scope-narrowing, metadata filtering, a score threshold, or
re-ranking (all supported by mem0, **none exercised here**) would each cut
the effective haystack. The honest read: *embeddings need help (scoping /
thresholding / re-ranking) before a single pool grows past ~1k same-domain
entries* — not "mem0 is worse at 100-memory scale" (at 114 it wins MRR
0.86 vs 0.745).

**Bearing on D-006's hinge** ("whether lexical-gap recall matters at
~100-memory scale vs 1k+"): mem0's lexical-gap advantage is real at
100–1k (MRR 0.81 vs 0.42) but **evaporates by 10k single-pool** — the
crossover is governed by *pool size per scope*, not total store size. The
owner's call hinges on whether real per-scope pools stay under ~1k (they
do today: 114 total) and whether scoping/thresholding is wired before they
grow.

**File-index cap (D-004), measured by the index-cap probe** (simulation
pinned byte-for-byte to the real `~/.claude/scripts/memory-compact.mjs`):

| store size | indexed in MEMORY.md | index KB | indexed % |
| --- | --- | --- | --- |
| 114 | 113 | 26.3 | 99.1% |
| 1,000 | 113 | 26.3 | 11.3% |
| 10,000 | 113 | 26.3 | 1.1% |

The file backend's *session-start* reach (what a booting agent loads via
MEMORY.md) is bounded at ~115 entries regardless of store size — and
because the 113 durables alone render 26.3 KB **over the 24.4 KB hard
cap**, the real projector ABORTS: it archives nothing and leaves
MEMORY.md **stale** (the store already sits in this state at 114). So the
file backend's flat *search* quality above is the backend's API; its
*boot-injection* reach is far more constrained, and degrades to a stale
index as the durable set grows. mem0 has no such index cap (boot injection
is a live PG query). Probe: `index-cap-2026-06-05T14-40-52-437Z.*`;
runbook: agent-insight `claude-file-memory-index-cap`.

## Pending sections

- **T3 judged usefulness (P-008, su-2b227):** ~25 queries, frozen judge —
  draw pairs from the CANONICAL artifact (14-40-41-392Z), not the
  discarded first run.
- **T4 boot-recall e2e (P-009, su-2b227):** does injection actually
  surface the gotcha in a live operator session.

## Owner actions queued regardless of the call

1. Rotate the Anthropic API key in operator credentials (stale, 401) —
   /settings/api-keys. Extraction currently rides the OpenAI fallback.
2. Decide the false-positive policy for injection consumers (score
   threshold / abstain heuristic) — needed under EITHER backend (finding 3).
