# pg_textsearch (BM25) configuration: preload is mandatory, name the index, compact by hand
URL: /internal/docs/agent-insights/pg-textsearch-bm25-configuration

How Papercusp's BM25 lexical ranking (pg_textsearch) is configured and why it silently falls back to ts_rank_cd: the library must be preloaded (CREATE EXTENSION is not enough), every query names its index through to_bm25query, indexes use compaction = 'manual' under the bm25Maintenance workflow, and work_items and session_turns also merge a legacy exact list into the BM25 list (D-016, interleaved per D-032), so they keep their tsvector columns. Covers the kill-switch, the lock_timeout trap and host checks.

## The one-line version

Lexical search ranks with **pg\_textsearch BM25** only when all three hold, checked per call:

1. the flag `papercusp-bm25-lexical-ranking` is ON (default ON; OFF is the cutover kill-switch),
2. pg\_textsearch is loaded through **`shared_preload_libraries`**, and
3. the corpus's BM25 index (`harness_shared.<table>_bm25`) exists and is valid.

If any one fails, that call site ranks with the legacy `ts_rank_cd` path instead, **silently**. Nothing errors, so a host that is missing the preload looks healthy and just ranks worse. Check the three conditions before you debug relevance.

## Preload is mandatory

`CREATE EXTENSION pg_textsearch` is **not** enough. The library must be listed in `shared_preload_libraries`, which is postmaster-level: changing it needs a server **restart**, not a reload.

* **The availability signal** is `current_setting('pg_textsearch.library_version', true) IS NOT NULL`. Every role can read it. `shared_preload_libraries` itself is not readable by a role without `pg_read_all_settings`, so do not gate on it.
* **Without the preload**, `harness_shared.bm25_ensure_indexes()` (migration 1447) raises a NOTICE and returns one row with outcome `skipped:library-not-preloaded`. No index is built and every corpus stays on `ts_rank_cd`.
* **Never name a library the server does not have.** A missing library in `shared_preload_libraries` stops the postmaster from starting. So the preload is added only when the server's own binary tree holds the library: `OPTIONAL_PRELOAD_LIBRARIES` (`['pg_textsearch']`) and `presentPreloadLibraries()` in `libs/papercusp/packages/embedded-postgres-server/src/index.js` apply that rule.

How each host gets it:

| host                                           | mechanism                                                                                      |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| embedded PG (desktop sidecar, server installs) | `presentPreloadLibraries()` adds `pg_textsearch` when the library file is present              |
| dev box native PG                              | `scripts/pg-autotune.ts` applies the same rule (it reads the server's `BINDIR`), then restarts |
| Linux desktop sidecar build                    | `papercusp-desktop/bin/build-desktop-sidecar.sh` bundles the library                           |
| darwin / Windows desktop                       | not bundled yet (WI-6554700010008388): these hosts boot on the legacy path                     |

To check a host, run as a superuser:

```sql
SHOW shared_preload_libraries;                              -- must list pg_textsearch
SELECT current_setting('pg_textsearch.library_version', true); -- non-null when loaded
SELECT c.relname, i.indisvalid FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_am a ON a.oid = c.relam
 WHERE a.amname = 'bm25';                                   -- one valid <table>_bm25 per corpus
```

## Name the index explicitly in every query

A BM25 query names its index by schema-qualified name:

```sql
(<text expr>) <@> to_bm25query($query, 'harness_shared.work_items_bm25')
```

`<@>` returns a **negative** distance: smaller is better. The ranking seam turns it into three fragments: score `-(distance)`, match `distance < 0`, and order by `distance` ascending. The text expression must be exactly the index's expression, or the index is not used.

Do not hand-write this. The lexical seam, `packages/operator-core/lib/search/lexical/rank.ts`, is the only entry point for lexical ranking: every call site gets its ranking leg from one of the seam's two leg functions, `lexicalLeg()` or `bm25LegIfAvailable()`. The R-5 source guard (`lexical-source-guard.test.ts`, beside it) keeps ranking expressions out of call sites. `lexicalLeg()` takes the corpus table, the query, and the call site's legacy fragments, picks the engine per call, and renders the expression from the corpus registry in `packages/operator-core/lib/search/lexical/corpora.ts`. The registry lists each corpus's table, index name, text config (`english`, except `audit_log`, which uses `simple`) and its legacy tsvector column. `bm25LegIfAvailable()` returns the same BM25 leg, or `null` when BM25 is not live for that corpus, for call sites that keep their own handling when BM25 is off, such as the D-016 exact-list sources below. Helpers such as `bm25TopK()` and `mergeExactAndBm25()` shape or fuse a leg's rows; they never choose an engine.

## Exact-list corpora (D-016)

pg\_textsearch 1.5.1 has only `to_bm25query`: OR semantics, with no AND, phrase or proximity operator. On a long document whose terms are each common, BM25 alone can rank a verbatim fragment's target far down (measured: ranks 11 to over 500), where the legacy `plainto_tsquery` AND filter with `ts_rank_cd` cover density ranks it first or second. So, whenever BM25 is live, the `work_item` and `session_turn` sources of `search:semantic` (`packages/operator-core/lib/agent-tools/search/sources.ts`) also run the legacy AND query as an **exact list**, and merge it with the BM25 list by interleaving over row identity: `mergeExactAndBm25()` in `rank.ts`. The merged order is BM25 row 1, exact row 1, BM25 row 2, exact row 2, and so on; a row both lists hold appears once, at its earlier slot, so a row at rank r in either list lands at position 2r or better. Until plan decision D-032 the merge was reciprocal-rank fusion, which sorts a row only one list found below every row both lists found. On R-13 run 12 that put a fragment's exact rank-1 target at position 22 of the merged list, outside the hybrid top 10.

The exact list is gated. A capped GIN probe counts the AND set first, and the list runs only when that count is above 0 and at most `EXACT_LIST_MAX_AND_ROWS` (`5000`), defined in `rank.ts`. A larger AND set skips the exact list and returns the BM25 list alone.

The kept corpora are `harness_shared.work_items` (`_search`) and `harness_shared.session_turns` (`text_tsv`).

* The exact list reads the stored legacy tsvector column and its GIN index, so these corpora keep both. The registry marks them `keepLegacyColumn: 'exact-list'` (`corpora.ts`), and retirement skips them (step 6 below).
* `corpora.test.ts` pins the kept set to the exact-list sources in both directions. If an exact list is removed, that test fails until `keepLegacyColumn` is dropped too, which returns the column to retirement.
* The other BM25 sources rank with BM25 alone. Whether they lose fragment queries is unmeasured; WI-6554700010008535 owns that. Reclaiming the two kept columns once pg\_textsearch can express AND or phrase matching is WI-6554700010008546.

## Compaction is manual, and maintenance owns it

Indexes are created `WITH (text_config = ..., compaction = 'manual')` (`bm25_index_ddl`, migration 1447), so pg\_textsearch never compacts on its own. The `bm25Maintenance` DBOS scheduled workflow (`packages/operator-core/lib/dbos/periodic-workflows.ts`, crontab `30 */15 * * * *`, so every 15 minutes) runs `runBm25Maintenance()` from `packages/operator-core/lib/search/lexical/bm25-maintenance.ts`:

1. **ENSURE**: creates the extension and reports each missing index as `deferred:build-concurrently`. It never builds inline, because inline builds share one function call and hold every table's lock until the last build commits.
2. **ORPHANS** (step 2a): drops the INVALID `<index>_ccnew` / `<index>_ccold` copies that a REINDEX CONCURRENTLY left behind when it died. Such a copy still takes every write.
3. **BUILD**: at most one `CREATE INDEX CONCURRENTLY` per run. Never-attempted builds go before ones that already failed, so one failing index cannot starve the rest. An INVALID index is dropped first, because the DDL is `IF NOT EXISTS` and would otherwise skip it forever.
4. **COMPACT**: `bm25_compact_step(idx)` while `bm25_needs_compaction(idx)` is true, up to a per-run step budget.
5. **RECLAIM** (plan decision D-010): compaction merges segments but never shrinks the index file. An index whose file exceeds 1.4x its estimated live bytes (and is at least 8 MB) is rebuilt with `REINDEX INDEX CONCURRENTLY`, at most one per run.
6. **RETIRE**: once migration 1452 is armed, swaps each legacy stored tsvector column for a VIRTUAL generated column (D-012) when its corpus has a valid BM25 index. The exact-list corpora are skipped and reported `kept:exact-list` (D-016), because their exact list reads the stored column and its GIN index.

The workflow runs whether or not the flag is on. The indexes take every write either way, so turning the flag back on never lands on a degraded index.

### The lock\_timeout trap for CONCURRENTLY DDL

`CREATE`, `REINDEX` and `DROP INDEX CONCURRENTLY` wait for every older transaction on the table, and those waits obey `lock_timeout`. The pool role sets `lock_timeout = 15s`, and on a busy database (or while the pg\_dump backup holds its snapshot) some transaction is nearly always older than that. Every build was cancelled and left an INVALID index. Maintenance therefore sets a session `lock_timeout` of `4h` for its DDL and holds the advisory lock `bm25-maintenance:concurrent-ddl`, so two overlapping runs never run DDL on the same index. Waiting blocks no writer: the build's ShareUpdateExclusiveLock does not conflict with the RowExclusiveLock that writes take.

## The kill-switch

Turning `papercusp-bm25-lexical-ranking` OFF (via `/admin/features`) puts every call site back on the legacy `ts_rank_cd` fragments. Before migration 1452 runs, that path is still indexed by the legacy GIN indexes. After it, the retired legacy columns are virtual and unindexed, so flag-off still returns correct results but is slow on those corpora; the two exact-list corpora stay indexed. That is why 1452 is armed only after the recorded soak (plan decision D-013).

## Health

`bm25Health()` in `rank.ts` reports the flag, whether the library is loaded, and each corpus's index state. `packages/operator-core/lib/service-health.ts` surfaces it.

## Related

* [The lexical leg is ts\_rank\_cd, not BM25](/internal/docs/agent-insights/lexical-leg-is-ts-rank-cd-not-bm25) describes the legacy ranker, which is still what runs when any condition above fails, and what the exact list uses.
* Plan `bm25-lexical-search-evoke-adoption-2026-10-10` (decisions D-002 engine choice, D-010 reclaim, D-012 retirement, D-013 soak, D-016 exact list).
