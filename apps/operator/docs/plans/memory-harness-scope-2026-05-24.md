---
title: Memory scope — user + harness model
slug: memory-harness-scope-2026-05-24
created: 2026-05-24
updated: 2026-05-24
status: draft
owner: aviynw3@gmail.com
---

## Now

**State**: Memory today has two tiers — user (`user_id = <user.id>`) and workspace-shared (`user_id = "workspace:<wsId>"`). Pre-turn injection at `apps/operator/lib/memory/injection.ts` does two parallel `client.search()` calls and merges. The editor lives at `/settings/user/memory`, currently nav-grouped under "Identity & devices", with a single mixed list of user + workspace entries (workspace entries badged "shared").

**Next**: Replace the workspace tier with a per-harness tier (`user_id = "harness:<slug>"`). Agents inside a harness recall `[user, this-harness]`; operator chat fans out across `[user, every-harness-the-user-has-access-to]`. The editor moves to "Advanced", renames "Papercup" → "Papercusp", and splits into labeled sections with user-friendly explanations.

## Context

A separate user request started this: add a Memory tab to the settings nav; later — should that page distinguish user vs workspace memories? While discussing, we noticed the workspace tier is mostly a placeholder for a real "team/project" scope and "shared harnesses" (now planned in `papercusp-dogfood-v5-2026-05-23.md`) make harness-scoped memory the natural fit. Workspace memory becomes a derived view ("memories across all your harnesses"), not a storage tier.

## Audit findings (verified against current code, 2026-05-24)

Every claim that drove the design was checked against the actual files in `apps/operator/` and `node_modules/mem0ai/dist/oss/`.

### Verified ✓

1. **mem0 is search-queryable, not auto-loaded** — `client.search(query, { filters, limit })` returns top-K (`node_modules/mem0ai/dist/oss/index.d.ts:401`).
2. **Pre-turn injection is already dual-scope, parallel-search-and-merge** — `apps/operator/lib/memory/injection.ts:99-118` runs two `client.search()` calls (user, workspace) concurrently and merges results. Used by `operator/converse-prompt.ts`, `architect/prompts.ts`, `oracle/prompts.ts`, `operator/delegate.ts`. Bounded by a 5s timeout with a process-level degraded-mode flag.
3. **Workspace storage uses `user_id = "workspace:<wsId>"`** — `apps/operator/lib/agent-tools/memory/remember.ts:78`: `userId: args.shared ? \`workspace:${ctx.workspaceId}\` : user.id`.
4. **Operator chat has workspaceId in scope, NOT a harness id** — `apps/operator/lib/agent-tools/operator/converse.ts:343` writes with `metadata.workspace_id` only; operator-launched spawns set `harness='system'` (line 367). The fan-out across harnesses must happen client-side in the recall path.
5. **Harness identifier is the slug** — every existing memory and write path treats slug as the canonical id (`harness:list`, schema names `harness_<slug>`, etc.).
6. **Shared harnesses is a real planned feature** — `apps/operator/docs/plans/papercusp-dogfood-v5-2026-05-23.md` covers per-contributor branches and harness-link join flow. This plan does NOT depend on that shipping — harness memory is useful even in single-user workspaces.

### Corrected ✗ (one substantive change to the design discussion)

7. **mem0's PGVector adapter does NOT support `$or` or `IN` filters** at the SQL level. `node_modules/mem0ai/dist/oss/index.js` `PGVector.search/list/keywordSearch` iterates `Object.entries(filters)` and builds `payload->>'key' = $N` only — flat equality. The mem0 core layer's `_processMetadataFilters` recognizes AND/OR/NOT/in syntax (index.js:7193-7280), but the PGVector adapter ignores the processed shape. **Implication: the fan-out is N parallel `client.search()` calls, not one OR-filtered query.** This is exactly the pattern `injection.ts` already uses (N=2 today); per-harness just grows N.

### Cost flagged ⚠

8. **mem0's `search()` re-embeds the query per call** (index.js, `addToVectorStore`-adjacent code path embeds query once per `search`). With local BGE that's CPU-expensive; with OpenAI it's one API call per harness. For typical workspaces (~5-15 harnesses) the cost is acceptable; for large workspaces (~50+) we'd want to optimize. **Mitigation later, not blocker for this plan**: embed once + custom pgvector SQL with `WHERE payload->>'user_id' IN (...)`, bypassing mem0's adapter for the fan-out path.

## Decisions

- **D1**: Drop the workspace storage tier. Use only `user:<id>` and `harness:<slug>`. Workspace becomes a derived view.
- **D2**: Storage key for harness memory is `user_id = "harness:<slug>"`, mirroring the existing `workspace:<wsId>` pattern.
- **D3**: Pre-turn recall:
  - Agent inside a harness → fan out to `[<userId>, harness:<currentSlug>]`
  - Operator chat → fan out to `[<userId>, harness:<slug-1>, ..., harness:<slug-N>]` for every harness the session user has access to (today: all harnesses in the workspace; under shared-harness, the user's accessible set).
- **D4**: Migration of existing `workspace:<wsId>` entries — **deprecate, do not migrate**. Pre-alpha; no real users. Editor shows legacy entries in a "Deprecated — workspace memory" section with delete buttons; injection.ts reads them through one extra search for back-compat until the section is empty. Tracked for removal (P-012).
- **D5**: Editor sections (Memory page):
  - "My memory" — entries with `scope === 'user'`
  - "Per-harness memory" — entries with `scope === 'harness'`, grouped by harness slug
  - "Deprecated — workspace memory" — entries with `scope === 'workspace'`, shown only if non-empty
- **D6**: Editor location — move from "Identity & devices" to "Advanced" in the settings nav.
- **D7**: Title rename — "Papercup memory" → "Papercusp memory".
- **D8** (deferred): Harness-memory write permissions under shared-harness. Today single-user; defer until contributors model lands in `papercusp-dogfood-v5`.

## Items

### Phase 1 — Backend: writes + storage key

- **P-001** [todo] `apps/operator/lib/agent-tools/memory/remember.ts`: add `harness_slug` arg (mutually exclusive with `shared`); when present, write `userId: "harness:<slug>"` and `metadata.scope = "harness"`. `shared: true` path keeps working but is marked deprecated in the tool description.
- **P-002** [todo] `apps/operator/prompts/operator.persona.md` + `oracle.persona.md`: persona-prompt guidance — prefer `harness_slug` over `shared: true` when the fact is project-specific.

### Phase 2 — Backend: recall fan-out

- **P-003** [todo] `apps/operator/lib/memory/injection.ts`: extend `MemoryInjectionInput` with `harnessSlugs?: string[]`. Replace the single `workspace:<wsId>` pull with N parallel `client.search()` calls (one per harness slug). Keep the `workspace:<wsId>` pull as a back-compat read-through (one extra call) for D4 deprecation period. Merge all hits, rank by score, return top-K.
- **P-004** [todo] `apps/operator/lib/agent-tools/operator/converse-prompt.ts`: resolve `harnessSlugs` via the harness registry (list all harnesses in the active workspace) and pass to `buildMemoryContextBlock`. Cache the slug list per-process — slugs change rarely.
- **P-005** [todo] Harness-context callers — pass `harnessSlugs: [<currentSlug>]`:
  - `apps/operator/lib/agent-tools/architect/prompts.ts:110, 170`
  - `apps/operator/lib/agent-tools/oracle/prompts.ts:221`
  - `apps/operator/lib/agent-tools/operator/delegate.ts:201`
- **P-006** [todo] `apps/operator/lib/agent-tools/memory/search.ts`: add `harness_slug` arg; when present, the parallel search becomes `[user, harness:<slug>]` instead of `[user, workspace:<wsId>]`.

### Phase 3 — Editor restructure

- **P-007** [todo] `apps/operator/app/settings/layout.tsx`: move the `/settings/user/memory` link from "Identity & devices" to "Advanced" (D6). Keep `keywords` so search still finds it.
- **P-008** [todo] `apps/operator/app/settings/user/memory/page.tsx`:
  - Rename `<h1>Papercup memory</h1>` → `<h1>Papercusp memory</h1>` (line 145) and "Facts Papercup has stored…" → user-friendly description (D7).
  - Replace single list with three labeled sections (D5):
    - "My memory" (`scope === 'user'`) — short blurb: *"Personal facts about you. Carried across every project. Only you can see these."*
    - "Per-harness memory" (`scope === 'harness'`, grouped by `harness_slug`) — *"Per-project facts shared with anyone who has access to that harness."*
    - "Deprecated — workspace memory" (`scope === 'workspace'`, hidden when empty) — *"Older shared memories from before per-harness scope existed. Move important ones into the right harness, or delete."*
- **P-009** [todo] `apps/operator/lib/endpoint-route/routes/user/memory.ts` GET handler: fan out three pulls (user + all-harnesses + legacy workspace), tag each entry with `scope` and include `harness_slug` from metadata. Forget-all stays user-scoped only (already correct per existing handler).

### Phase 4 — Verify

- **P-010** [todo] `apps/operator/lib/memory/suite/checks.ts`: add a per-harness round-trip — write `harness:foo` memory, run operator pre-turn injection with `harnessSlugs: ['foo']`, assert it surfaces. Add a deprecation-readthrough check: write a legacy `workspace:*` memory and confirm it still surfaces during the deprecation window.
- **P-011** [todo] verdict e2e: log in as `default`, write a harness memory via `memory:remember harness_slug=sheets`, open `/settings/memory` (new path), confirm it appears in the per-harness section under "sheets", confirm title reads "Papercusp memory" not "Papercup memory", confirm tab lives under "Advanced".

### Phase 5 — Deprecation cleanup (follow-up plan, not this one)

- **P-012** [todo] Once legacy `workspace:*` entries are drained (UI shows empty Deprecated section across all users), remove the read-through from `injection.ts`, the `shared: true` arg from `remember.ts`, and the section from the editor.

## Dependencies / blockers

- **None blocking.** Shared-harnesses (`papercusp-dogfood-v5-2026-05-23.md`) does not block this plan — harness memories are useful in single-user workspaces. When shared-harness ships, harness-memory access naturally follows harness access (D7 deferred).
- **Adjacent bug, not this plan**: the `operator_memory_openai` collection is missing in the embedded PG (today's session). That blocks the editor from showing anything at all, regardless of scope changes. Tracked separately.

## Out of scope

- Embedding-cache or custom pgvector fan-out SQL (cost mitigation #8 above). Defer until a workspace with >20 harnesses actually feels the latency.
- Permissions model for harness-memory writes (D8). Comes with the shared-harness contributors model.
- Removing `next-transition-router` watchdog patch / the navigation deadlock — separate session item.
