---
title: Brief — finish @papercusp/search (P-013 / P-020) — ✅ DONE
slug: BRIEF-search-extraction-2026-05-30
status: done
created: 2026-05-30
owner: avi@storewolf.com
companion-to: [papercusp-systems-abstraction-2026-05-29, HANDOFF-systems-abstraction-phase2-2026-05-30]
---

# Brief: finish `@papercusp/search` (P-013 / P-020)

> ✅ **COMPLETED 2026-05-30** — done inline (`0332afba` engine + `163d60b3`
> wiring). P-013 + P-020 are `done`. This brief is kept as the record of how
> it was done; no action remaining. The other three lib briefs (memory,
> locks, coordination) are still open.

You are one of several agents each finishing **one** shared-lib extraction
from `papercusp-systems-abstraction-2026-05-29`. Yours is search. The
**engine package is already built and committed** (`0332afba`); you only
need the operator-side wiring. ~1–2 hours.

Read this whole brief, then the §Recipe at the bottom (shared across all
briefs). Re-verify against the repo before acting — HEAD moves under you.

## State (verified at write time)

- `packages/search/` exists on `main`, **tsc-clean**, symlinked at
  `node_modules/@papercusp/search`. It exports:
  - types: `PgHandle` (=postgres `Sql`), `Embedder`, `SearchHit`,
    `Listing` (=`RankedItem<SearchHit>[]`), `SearchSource`,
    `SearchSourceParams`.
  - `runFullTextSearch(sources, ctx)` — BM25 only.
  - `runHybridSearch(sources, ctx)` — BM25 + pgvector fused via RRF.
  - re-exports `rrfCombine`, `RRF_K_DEFAULT`, `RankedItem`, `FusedItem`.
  - Each source call is independently try/caught + logged (the explicit
    P-013 degradation). Read `packages/search/src/hybrid.ts` first.
- The operator still runs its **own** copies in
  `apps/operator/lib/agent-tools/search/{semantic,fulltext}.ts`. Nothing
  imports `@papercusp/search` yet. Plan items P-013 + P-020 are `todo`.

## What's left (operator side only)

### 1. `lib/agent-tools/search/sources.ts` (NEW) — the 4 `SearchSource`s

Move the per-source SQL out of the current `semantic.ts` + `fulltext.ts`
into one shared registry. The two tools today duplicate the **identical**
BM25 SQL; this collapses it. Export
`export const SEARCH_SOURCES: SearchSource[]` with these four, each
implementing `bm25(p)` and (where an embedding column exists) `embedding(p)`:

| source name | table | tsv col | embedding col | id/key | harness filter? |
|---|---|---|---|---|---|
| `escalations` | `harness_shared.harness_escalations` | `body_tsv` | `body_embedding` | `${harness_slug}:${phase}` | yes |
| `brainstorm` | `harness_shared.harness_brainstorm` | `content_tsv` | `content_embedding` | `${harness_slug}:${phase}` | yes |
| `turns` | `harness_shared.operator_turns t JOIN operator_conversations c ON c.id=t.conversation_id` | `t.text_tsv` | `t.text_embedding` | `${id}` | **no** (filter via `c.workspace_id`) |
| `decisions` | `harness_shared.harness_decisions` | `body_tsv` | `body_embedding` | `${harness_slug}:${line_hash}` | yes |

Copy the exact SQL + row→hit mapping from the CURRENT
`semantic.ts` (it has both bm25 + embedding blocks for all 4) — see git
`HEAD:apps/operator/lib/agent-tools/search/semantic.ts`. Each source
function returns a `Listing` (`{key, score, row: SearchHit}[]`). Use:
- `HEADLINE_OPTS` const (copy verbatim).
- bm25: `score = ts_rank_cd(...)`, `rankers: ['bm25']`, `LIMIT ${p.limit}`.
- embedding: `score = 1 - (<col> <=> ${p.qVec}::vector)` AS sim,
  `rankers: ['embeddings']`, `ORDER BY <col> <=> ${p.qVec}::vector
  LIMIT ${p.limit}`, guarded by `<col> IS NOT NULL`.
- The cast pattern the originals use: `(await p.sql`…`) as unknown as
  Array<{…}>`. `p.sql` IS the `PgHandle`.
- `turns` has no `harness_slug`; its `SearchHit` omits the field and its
  excerpt/highlight are prefixed `[${role}] `.

### 2. `lib/agent-tools/search/embedder.ts` (NEW) — the embedder seam provider

Move `buildQueryEmbedder()` verbatim from the current `semantic.ts`
(lines ~45–109): the OpenAI-or-local cascade that reads
`../../credentials` (`readCredentials`) + `../../voice-prefs`
(`loadVoicePrefs`), returns `Embedder | null`. Keep `EMBEDDER_DIM`,
`OPENAI_EMBEDDER_MODEL`, `LOCAL_EMBEDDER_MODEL`. Export
`buildQueryEmbedder`. (This is the operator's embedding-provider seam; the
package never imports it.)

### 3. Rewrite the two `defineTool` wrappers (thin)

Both keep their EXACT current `defineTool` metadata (name, capability,
description, guidance, roles, rolesQuota, args, SCOPE/MODE choices,
ALL_ROLES) — only the `handler` body shrinks. **Preserve the exact output
JSON** (an e2e spec hits `/api/agent-tools/search/fulltext`).

`fulltext.ts` handler:
```ts
const limit = args.limit ?? 5;
const scope = args.scope?.includes('all') || !args.scope?.length
  ? ['escalations','brainstorm','turns','decisions'] : args.scope;
const sources = SEARCH_SOURCES.filter(s => scope.includes(s.name));
const { results, totalHits } = await runFullTextSearch(sources, {
  sql: ctx.tx, query: args.query, workspaceId: ctx.workspaceId,
  harnessFilter: args.harness_slug ?? null, limit, log: ctx.log,
});
// fulltext output uses `rank`, NOT score+rankers — map it:
const top = results.map(r => ({
  source: r.source, source_id: r.source_id,
  ...(r.harness_slug ? { harness_slug: r.harness_slug } : {}),
  excerpt: r.excerpt, highlight: r.highlight, rank: r.score,
}));
return { content:[{ type:'text', text: JSON.stringify({
  query: args.query, scope, total_hits: totalHits, results: top }) }] };
```

`semantic.ts` handler:
```ts
const limit = args.limit ?? 5;
const mode = args.mode ?? 'hybrid';
const scope = (same resolve as above);
const sources = SEARCH_SOURCES.filter(s => scope.includes(s.name));
const embedder = await buildQueryEmbedder();
const { results, totalHits, embedderAvailable } = await runHybridSearch(sources, {
  sql: ctx.tx, query: args.query, workspaceId: ctx.workspaceId,
  harnessFilter: args.harness_slug ?? null, limit, mode, embedder, log: ctx.log,
});
return { content:[{ type:'text', text: JSON.stringify({
  query: args.query, mode, embedder_available: embedderAvailable,
  scope, total_hits: totalHits, results }) }] };
```
(`runHybridSearch` already returns `SearchHit[]` with `score`+`rankers`,
which is exactly the old semantic output row shape.)

### 4. Wire + verify + commit

- `apps/operator/lib/agent-tools/index.ts` still imports `./search/fulltext`
  + `./search/semantic` — leave those lines; the files still default-export
  the `defineTool`.
- Add `"@papercusp/search": "file:../../packages/search"` to
  `apps/operator/package.json` (alphabetical).
- **Verify**: package `tsc` 0 errors; operator `npx tsc --noEmit` shows
  **zero NEW errors in lib/agent-tools/search** (operator baseline ≈ 781
  pre-existing — compare, don't expect 0); then dispatch the **live tools**
  to confirm behavior is preserved:
  `mcp__papercusp-su__search_fulltext { workspace, query: "<something in your data>" }`
  and `mcp__papercusp-su__search_semantic { …, mode: "hybrid" }`. Compare
  shape/results to a pre-change run if you can.
- Commit (package dep + operator files), flip **P-013 + P-020 → done**,
  `plans:lint`, `coord:send` done.

## Gotchas

- `ctx.tx` is typed `any` and optional. Passing it as `sql: PgHandle` is
  fine; the package's per-source try/catch handles an absent/throwing
  handle → empty results (P-013 behavior). Don't "fix" this into a hard
  requirement.
- The semantic bm25 path runs **only** in `mode='hybrid'`; embeddings run
  whenever a query vector exists. `runHybridSearch` already encodes this —
  don't re-add the branching in the wrapper.
- Don't change the embedder cascade or the SQL — this is a
  behavior-preserving move. Verify byte-identical-ish output.

---

§Recipe (skeleton, seams, verify, commit discipline, gotchas) is shared:
read **`BRIEF-RECIPE-shared-2026-05-30.md`** first.
