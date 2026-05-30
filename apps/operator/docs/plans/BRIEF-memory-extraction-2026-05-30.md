---
title: Brief — @papercusp/memory (P-021)
slug: BRIEF-memory-extraction-2026-05-30
status: active
created: 2026-05-30
owner: avi@storewolf.com
companion-to: [papercusp-systems-abstraction-2026-05-29, BRIEF-RECIPE-shared-2026-05-30]
---

# Brief: `@papercusp/memory` (P-021)

Read **`BRIEF-RECIPE-shared-2026-05-30.md`** first. This is the
memory-specific audit. **This is the largest and least-clean extraction
in the set — the scoping is the hard part, not the moving.**

**Plan item:** P-021 (`todo`). Source: `apps/operator/lib/memory/`
(~4970 LOC, ~30 files). 26 consumers. Coupling at the import level is
small (`@restart/db-org`, `@/lib/workspace-registry`,
`@/lib/embedded-pg-discovery`) but the directory **mixes a reusable mem0
store with a large operator-specific curation pipeline.** Do not move the
whole dir.

## ✅ Boundary already audited (2026-05-30) — use this, it's sharper than the original first-pass

A read-only audit fixed the cut. It's **cleaner than feared** — the core is
~1191 LOC / 5 files with a single external coupling, not a 5K-LOC tangle:

**Core → `@papercusp/memory` (extract these 5):**
| file | LOC | role |
|---|---|---|
| `mem0-connection.ts` | 58 | resolves PG for mem0ai's PGVector provider via `getHarnessAdminUrl` from `@/lib/embedded-pg-discovery` — **the one seam.** Exports `connectionString`, `pgFields`, `pgClientFields`. |
| `mem0-client.ts` | 485 | the mem0ai wrapper (`getMemoryClient`, `getResolvedMode`, `invalidateMemoryClient`); imports `./canonical-store`. |
| `canonical-store.ts` | 279 | the pgvector canonical store. |
| `local-embedder-worker.ts` (+ `.script.mjs`) | 141 | local embedder. |
| `reembed.ts` | 228 | re-embedding pass. |

**Internal dep graph (within core):** `mem0-client → canonical-store`. Clean.

**Seam (singular, narrow):** `mem0-connection` reaches `@/lib/embedded-pg-discovery`
(`getHarnessAdminUrl`). mem0ai owns its own `pg.Client` (takes discrete fields),
so inject a **PgDiscovery** seam (`() => Promise<string>` URL, or the discrete
`pgFields`), wired by the operator to `getHarnessAdminUrl`/`pgFields`. Check
whether the embedder cascade in `mem0-client` reads operator state
(`credentials`/`voice-prefs`, like search's `buildQueryEmbedder` does) — if so,
inject an **EmbedderProvider** seam too; otherwise it's self-contained.

**Deep-import consumers needing operator shims** (keep these paths resolving):
`@/lib/memory/mem0-client` (6), `@/lib/memory/mem0-connection` (3),
`@/lib/memory/reembed` (2). NOTE: `pgClientFields` from `mem0-connection` is
imported by **another lib's test** (`lib/backup/orphan-cleanup.test.ts`) — keep
that export path working.

**Everything else STAYS in the operator** (the curation pipeline — the big
surface): `injection` (**20 consumers**), `learning`/`learning-shared`,
`mcp-prelude`, `insights-index`, `feedback`, `anchors`/`persist-anchors`/
`audit-anchors`, `conflict-check`, `detect-harness-slug`, `bump-last-surfaced`,
`anthropic-judge`, `cleanup-worker`, `suite/`. These call INTO the core.

The boundary is clean enough to proceed without a further scope check. Land the
store-core package first (committable, inert), then the operator barrel/shims as
a second commit. Verify via the live `memory:*` tools (note `memory_search` may
report `mem0_unavailable` in some envs — confirm reachability so you can tell a
regression from a pre-existing outage).

## (original first-pass scoping notes — superseded by the audit above)

The extractable `@papercusp/memory` is the **generic mem0 store/connection/
embedder/vector-store wrapper**. The Papercusp *curation* logic stays in
the operator. A first-pass split from the audit:

**Generic store core → `@papercusp/memory` (candidate):**
- `mem0-client.ts`, `mem0-connection.ts` — the `mem0ai` wrapper + its own
  `pg.Client` (mem0 owns the connection; **this is NOT a PgHandle seam** —
  see below).
- `canonical-store.ts` — the canonical/vector store ops.
- `local-embedder-worker.ts` (+ `.script.mjs`) — the local embedder.
- `reembed.ts` — re-embedding pass.

**Operator curation pipeline → STAYS in operator:**
- `learning.ts`, `learning-shared.ts`, `injection.ts`, `mcp-prelude.ts`,
  `insights-index.ts`, `feedback.ts`, `anchors.ts` / `persist-anchors.ts`
  / `audit-anchors.ts`, `conflict-check.ts`, `detect-harness-slug.ts`,
  `bump-last-surfaced.ts`, `anthropic-judge.ts`, `cleanup-worker.ts`.
  These are the Papercusp-specific "what to remember / when to surface /
  how to dedup / harness anchoring" policy built ON TOP of the store.

This boundary is a judgment call with real money on it (4970 LOC). **Audit
each file's imports + role, draw the line, and run it past the user
(`AskUserQuestion`) before the heavy moves** — same as the backup PG-seam
checkpoint. Don't extract 30 files on a guess.

## Seams (per the plan)

mem0 **owns its own `pg.Client`**, so unlike backup/search you do NOT
inject a postgres-js `sql` handle. Inject instead:

1. **`PgDiscovery`** — how mem0 finds its DB (currently
   `@/lib/embedded-pg-discovery` + `@/lib/workspace-registry`). Inject a
   connection-config/URL resolver seam, not a live client.
2. **`EmbedderProvider`** — the embedder (OpenAI-or-local cascade; note
   the search lib has the same cascade — consider sharing, but don't block
   on it). Inject `(text) => Promise<number[]>` (+ batch).
3. **`VectorStoreProvider`** — the pgvector store abstraction
   (`canonical-store.ts`), if it's cleanly separable from the mem0 client.
4. **Optional Claude dedup judge** — `anthropic-judge.ts`, **feature-
   flagged OFF**. Inject as an optional seam; default no-op.

## Operator side

`lib/memory/` keeps the curation pipeline + a `configure`/adapter wiring
the seams (PgDiscovery from embedded-pg-discovery + workspace-registry,
EmbedderProvider, VectorStoreProvider, optional judge). The
`agent-tools/memory/` verbs (`remember`, `search`, `list`, `forget`,
`update` — `defineTool` wrappers) **stay** and call through the operator
adapter. Keep the 26 consumers resolving via the same `@/lib/memory`
import paths (barrel re-export, like backup).

## Verify

- The mem0 store core has live tests (`mem0-connection` is used by other
  libs' tests too — e.g. backup's `orphan-cleanup.test.ts` imports
  `pgClientFields` from `lib/memory/mem0-connection`; **don't break that
  export path** without updating the consumer).
- Live dispatch: `mcp__papercusp-su__memory_remember` /
  `memory_search` / `memory_list` / `memory_forget` / `memory_update`.
  NOTE: `memory_search` currently returns `{ ok:false, reason:
  'mem0_unavailable' }` in some envs — confirm whether mem0 is reachable
  before/after so you can tell a regression from a pre-existing outage.
- Operator tsc: zero NEW errors in your area; package tsc clean.

Flip **P-021 → done**, `plans:lint`, `coord:send`. Given the size,
consider landing the store-core package first (committable), then the
operator rewire as a second commit.
