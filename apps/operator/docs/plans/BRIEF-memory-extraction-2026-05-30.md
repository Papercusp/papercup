---
title: Brief — @papercusp/memory (P-021)
slug: BRIEF-memory-extraction-2026-05-30
status: shipped
created: 2026-05-30
owner: avi@storewolf.com
companion-to: [papercusp-systems-abstraction-2026-05-29, BRIEF-RECIPE-shared-2026-05-30]
updated: 2026-06-01
---

# Brief: `@papercusp/memory` (P-021)

Read **`BRIEF-RECIPE-shared-2026-05-30.md`** first.

**Plan item:** P-021. Source: `apps/operator/lib/memory/` (~4970 LOC,
~30 files, 26 consumers). The directory mixes a small reusable mem0 store
with a large operator-specific curation pipeline — **do not move the whole
dir.** A read-only audit (2026-05-30) fixed the boundary, below; it's
clean and narrow, so just execute it.

> **⚠️ Check before you start:** a memory agent may already be underway —
> `packages/memory/src/` and `lib/memory/configure.ts`/barrel may already
> exist. `git log --oneline | grep -i mem0` and `ls packages/memory/src`
> first. If so, continue that work, don't restart it.

## The boundary (audited)

The core is ~1191 LOC / 5 files with a single external coupling:

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

## Seams

mem0ai **owns its own `pg.Client`** (it takes discrete connection fields),
so unlike backup/search you do NOT inject a postgres-js `sql` handle.
Inject instead:

1. **`PgDiscovery`** (the one that matters) — how mem0 finds its DB.
   `mem0-connection.ts` currently calls `getHarnessAdminUrl` from
   `@/lib/embedded-pg-discovery`. Inject a URL/`pgFields` resolver seam;
   the operator wires it to `getHarnessAdminUrl`/`pgFields`.
2. **`EmbedderProvider`** (only if needed) — `mem0-client`'s OpenAI-or-local
   embedder cascade. If it reads operator state (`credentials`/`voice-prefs`,
   the way search's `buildQueryEmbedder` does), inject it; if it's
   env-only/self-contained, leave it in the package. Resolve this by reading
   `mem0-client.ts` — don't guess.

`canonical-store.ts` is part of the moved core (internal to the package),
NOT a seam. The Claude dedup judge (`anthropic-judge.ts`) is curation glue
that **stays in the operator**, so it's not a core seam either.

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
