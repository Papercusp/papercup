# memory-backend benchmark — the scorecard for the revive-vs-retire call

> **Status: COMPLETE — for the owner's needs-human decision (D-006).**
> All four tiers ran. This document **informs**; the revive-vs-retire
> call is the **owner's** — the implementing agents deliberately make no
> recommendation.
>
> Artifacts (all under `.papercusp/bench-reports/`):
> - **T1/T2 deterministic** — `memory-bench-2026-06-05T14-40-41-392Z.{json,md}`
>   (canonical; an earlier 14-25-04Z run was discarded — predated the
>   limit/topK fix below).
> - **Scale tier (P-010)** — `memory-bench-2026-06-05T14-45-53-264Z.*` +
>   index-cap probe `index-cap-2026-06-05T14-40-52-437Z.*`.
> - **T3 judged usefulness (P-008)** — `memory-judged-2026-06-05T16-13-06-141Z.*`.
> - **T4 boot-recall (P-009)** — `memory-t4-boot-recall-2026-06-05.md`.
>
> Lanes: su-097d9 (engine + T1/T2 + live-runs), su-2b227 (T3/T4 code),
> su-62aed (scale + index-cap).

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

## T3 — judged usefulness (P-008): the judge agrees with the rank metrics

A frozen judge (`claude-sonnet-4-6`, rubric `memory-usefulness.v1`) scored
"was the TOP result actually useful for this intent?" over a 24-query
stratified sample (hard negatives excluded — ill-posed). Judge agreement
on a 6-query double-score: mean |Δ| 0.17 / max 1.00 (tight).

| backend | mean usefulness 0–5 | useful-rate ≥3 | lexical-gap | exact-identifier | session-start |
| --- | --- | --- | --- | --- | --- |
| mem0 | **3.79** | **71%** | **3.50** | 3.38 | 4.50 |
| claude-file | 2.92 | 54% | 0.13 | **4.63** | 4.00 |
| noop (control) | 0.00 | 0% | 0.00 | 0.00 | 0.00 |

The judged tier **independently reproduces the T1/T2 split**: mem0's top
result is more useful overall and dominates lexical-gap (3.50 vs 0.13 —
the file backend's top hit on a paraphrased query is near-useless); the
file backend's top hit is *more* useful on exact-identifiers (4.63 vs
3.38 — grep returns the exact memory, embeddings return a near-neighbor).
The noop 0.00 confirms the judge isn't inventing usefulness from empty
results. Net: at 114-entry scale, mem0's top result is useful 71% of the
time vs the file backend's 54%.

## T4 — boot-recall (P-009): injection demonstrably surfaces a seeded gotcha

The end-to-end question memory exists to answer: in a live operator
session whose task needs a gotcha, does pre-turn injection surface it?
A 2-scenario proof sample on the live `:3170` operator brain (mem0
backend), each seeding an **unguessable token** reachable only via
boot-recall:

| scenario | seeded | result |
| --- | --- | --- |
| MEM00 (control, unseeded) | — | token correctly ABSENT — unguessable, no hallucination |
| MEM01 (staging probe port) | `:31785` | **surfaced** — the operator answered "probe the staging governor proxy on :31785, not :3170" |

The seeded fact reached the operator's answer purely through memory
injection. **Boot-recall works** on the live operator with the mem0
backend. (Caveat: T4 with `realWorkspace:true` writes to the live store
and the cleanup is incomplete — swept manually; filed EI-48. The full
11-scenario matrix is the periodic tier, gated on the cascade fix
reaching green `:3070`.)

## The one-line read per the four tiers

- **Quality at today's scale (114):** mem0 ahead (R@10 91% vs 82%; judged
  useful-rate 71% vs 54%), decisively on lexical-gap, behind on
  exact-identifier.
- **Scale:** mem0's quality collapses past ~1k *same-domain entries in one
  pool* (MRR 0.05 @10k single-pool) unless scoping/thresholding/re-ranking
  is wired; the file backend's lexical quality is flat but its
  boot-injection index is **already over the hard cap and stale**.
- **Cost/latency/reach:** file wins latency (×35–150) and cost ($0); mem0
  wins reach (any-process PG vs same-box FS + a capped boot index).
- **Both** lack false-positive discipline (FP@5 100%) — an
  injection-threshold decision is owed regardless of the backend chosen.

## Decision frame for the owner (the agents do NOT decide — D-006)

The measured tradeoff, stated neutrally:

- **Choosing mem0** buys lexical-gap recall (find a memory by its symptom,
  not its words) and any-process reach — its distinctive value, real and
  reproduced across T1/T2 and the judge. The price: it needs an embedder
  key + a working extraction LLM (the stale-credential failure mode bit
  once already), it's ×35–150 slower per query and non-zero cost, and its
  single-pool quality needs scoping/thresholding/re-ranking before a pool
  passes ~1k same-domain entries — none of which is wired today.
- **Choosing claude-file** buys zero-dependency simplicity, ~0ms/$0
  retrieval, and scale-flat lexical quality — but it cannot bridge the
  lexical gap (the thing embeddings are *for*), and its boot-injection
  index is already over the hard cap and serving stale (a real, present
  problem independent of this decision).
- **The hinge** (D-006): does lexical-gap recall matter enough at the
  *real per-scope pool size* — which is ~100 today and grows slowly — to
  justify mem0's operational weight and the scoping work its scale story
  needs? Both backends already work behind the shipped neutral seam, so
  the choice is reversible and re-benchable with this same instrument.

Two follow-ups are owed **regardless** of the revive/retire call:

1. **Rotate the Anthropic API key** in operator credentials (stale, 401) —
   /settings/api-keys. Extraction currently rides the OpenAI fallback;
   the cascade fix (P-002) self-heals but the dead key should be replaced.
2. **Decide the false-positive policy** for injection consumers (a score
   threshold / abstain heuristic) — FP@5 is 100% under BOTH backends, so
   any top-K injection without a threshold adds noise on out-of-corpus
   intents.

## What the benchmark itself left behind (durable instrument)

- `@papercusp/memory/bench` — the backend-parameterized engine (seed /
  gold-set replay / rank metrics / round-trips / synthetic scale /
  scorecard), re-runnable any time against any registered backend.
- Frozen fixtures `corpus.v1` (114 real memories) + `gold-set.v1` (150
  queries, 4 adversarial classes) — versioned, so future runs compare.
- Two production bugs the bench surfaced and fixed: the `limit`→`topK`
  over-fetch on every mem0 search (incl. pre-turn injection) and the
  canonical-store single-`pg.Client` serialization.
- The cascade fix (P-002) that resurrected mem0 from "stillborn".
