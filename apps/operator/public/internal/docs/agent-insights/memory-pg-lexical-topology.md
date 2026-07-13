# Memory topology — one PG store, two legs, papercusp-owned injection
URL: /internal/docs/agent-insights/memory-pg-lexical-topology

The post-2026-07-13 memory architecture — hybrid-pg (RRF of a PG lexical leg + the mem0 cosine leg over ONE memory_canonical table), why ~/.claude topic files stopped being load-bearing, and the cutover/rollback levers.

Plan: `memory-pg-lexical-own-injection-2026-07-13`. Owner mandate: the lexical
leg must be papercusp code over papercusp storage, and ambient injection must
be papercusp-controlled — no dependency on Claude's file-memory implementation.

## The shape

**One canonical store**: `harness_shared.memory_canonical` (payload jsonb) +
one `memory_vec_<mode>` table per embedding space (`vec-write.ts` `VEC_TABLE` /
`MODE_DIMS` are the single source of truth for that set — derive from them,
never hand-copy the list).

**Two recall legs, same rows** (`hybrid-pg`, registered in `configure.ts`):

* **Cosine leg** — `Mem0Backend.search`: pgvector distance over the active
  embedder mode's vec table, per-scope fan-out, decay + diversity rerank.
* **Lexical leg** — `Mem0Backend.searchLexical` →
  `CanonicalVectorStore.lexicalSearch`: embed-free, field-weighted token match
  (`payload->>'name'` ×3 > `'description'` ×2 > `'data'` ×1, normalized by
  tokens×3 — parity with the claude-file scoring that benched best on
  exact-identifier recall), min-2-char identifier-preserving tokenizer
  (`lexicalTokens`, which emits a compound like `PAPERCUSP_MEMORY_TIMEOUT` whole
  *and* its `_`/`-` subtokens). **The score is computed IN SQL and the `ORDER BY`
  is the score** — see the ranking trap below.
* Fusion: `HybridBackend` RRF (floored-union). Both legs return the SAME
  canonical ids, so fusion dedupes by construction.

`LexicalLegBackend` (`lexical-leg.ts`) presents the lexical capability as a
standalone `MemoryBackend` for the hybrid's constructor. **Its `remember()` is
a deliberate no-op** — `HybridBackend.remember` write-through-projects into
its lexical leg, which is correct for two SEPARATE stores (the old `hybrid`:
claude topic files + PG) but would double-write when both legs share
`memory_canonical`.

## Why (the evidence)

* Frozen-corpus bench: lexical wins exact-identifier recall (MRR 0.99 vs 0.87
  cosine); cosine wins paraphrase. Complementary failure modes → hybrid.
* Live A/B (2026-07-13, 40 known-item pairs from post-June memories,
  `bench/ab-live-recall-cli.ts`): **hybrid-pg recall\@10 83% vs old hybrid 55%
  vs mem0 53%**, p50 816ms (fastest). The old hybrid's file leg only saw
  write-through projections; the PG lexical leg sees every canonical row.

## \~/.claude topic files are NOT load-bearing anymore

* All pre-existing topic-file memories were imported into the canonical store
  (`claude-import-cli.ts`, P-004): 71 net-new of 1,806 active files — 1,630
  were already write-through projections (`extra.link_id` = the canonical id),
  26 were ghosts of canonical deletes (deliberately NOT resurrected), 79 exact
  dups. `archive/` was excluded (plan D-005 — evictions stay evicted; backup
  tar at `~/.papercusp/backups/p004-memory-import/`).
* Idempotency: imported rows carry `payload.imported_from =
  'claude-file:<basename>'`; re-runs no-op.
* `MEMORY.md` regeneration (the `memory-compact.mjs` SessionStart hook) was
  unwired in the 2026-07-12 managed-hooks migration; the file is a pointer
  stub (P-008). Ambient recall is papercusp-owned: the MCP initialize prelude
  (`mcp-prelude.ts`), `coord:orient` memory folds, work-item claim injection,
  and the post-compaction re-prime.

## Cutover / rollback

* The switch is the persisted `memory_backend` operator setting
  (`backend-selection.ts`, 15s SWR so all processes converge without
  restarts). `hybrid-pg` ↔ `hybrid` is runtime-reversible; the old `hybrid`
  stays registered as the rollback.
* ⚠ A process running code WITHOUT the `hybrid-pg` registration throws
  `unknown memory backend` on every memory call if the setting is flipped
  early — deploy the code first, flip second.
* Watchdogs: the live recall canary (`recall-canary.ts`, EI-10047) auto-reseeds
  its pair set on a backend flip, and its P-010 probe measures the LEXICAL leg
  separately every run — a blind leg (zero lexical retrieval while the fused
  product serves rows) alarms as `degraded` even when cosine carries recall.

## Traps this replaced (don't re-learn them)

* **Never rank a lexical candidate pool by RECENCY and then score it.** The first
  cut of `lexicalSearch` pulled `ORDER BY created_at DESC LIMIT max(topK*5, 50)`
  and did the field-weighted scoring in JS over the survivors. That truncates the
  pool *before* anything is scored, so the best lexical match is dropped without
  ever being scored whenever it loses a recency race to rows that merely share a
  common word. It cost lexical-gap MRR on the frozen bench (0.68 vs the file leg's
  0.75 — the paraphrase queries reach their answer only through a couple of generic
  words), and on a live store it silently breaks **exact-identifier recall**, which
  is the whole reason this leg exists: a rare identifier sitting in an old row never
  enters the candidate pool at all. A small bench corpus HIDES this — with 114 rows a
  cap of 50 still admits most of the corpus. The fix is structural: the per-token
  `CASE` weights are computed in SQL, `WHERE lex_raw > 0 ORDER BY lex_raw DESC LIMIT
  topK` — ranking over the whole matching set, each ILIKE evaluated once (the score
  expression *is* the filter). Guard:
  `canonical-lexical-search.integration.test.ts` → "ranks an OLD strong match above
  many NEWER weak ones" (60 newer common-word rows vs one old identifier row), which
  fails if a recency-ordered candidate cap is ever reintroduced.
* The bench's isolated `bench_memory` schema used to hand-mirror production
  DDL and drifted TWICE in one day (missing `memory_vec_harrier`, then missing
  the temporal-lite columns) — every PG backend benched at literal zero
  (EI-10793). `ensureBenchSchema` now clones live tables
  (`LIKE harness_shared.* INCLUDING ALL`).
* Unscoped topic files used to surface under ANY scope via the claude-file
  backend's visibility-first trick. The import maps them to the OWNER'S USER
  POOL because the live `memory:search` fan-out queries
  `[user.id, harness:*…]` — never `'local'`.
