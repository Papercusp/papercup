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

## ⚠️ Scope FIRST — confirm the boundary before moving anything

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
