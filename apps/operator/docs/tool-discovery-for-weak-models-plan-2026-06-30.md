# Tool discovery for weak/local models — curated core, derived capability map, hybrid `tools:find`

**Status:** proposal · **Date:** 2026-06-30 · **Scope:** operator MCP catalog + omp launch wiring + tooldef projections

---

## 1. Problem

A psu→omp session on a small local model (`ollama/qwen3.5:latest`, `ornith` ≈ 32k ctx) fails almost every tool call — `coord:orient`, `read_file`, `db.sqlite:table`, `todo_write` all return **"not found"** — and the model hallucinates tool names. Claude/Codex never hit this.

Verified root cause (not "the model's fault" — a **mismatch**):

- The full superuser MCP catalog is **551 tools / ~141k tokens** (measured via `tools/list` + gpt-tokenizer). That's ~70% of a 200k Claude/Codex window (heavy but loadable) and **~4.4× a 32k local model's *entire* context** (impossible to load).
- **Claude Code / Codex register the whole `tools/list` directly** → every tool is callable upfront. No discovery step. That's why they work.
- **omp is the exception**: it puts a client-side **discovery layer** on top — `mcp.discoveryMode: true` / `tools.discoveryMode: auto` hides all MCP tools behind `search_tool_bm25` once there are >40 tools, to fit small contexts. So `coord:orient` isn't even visible until the model runs a search.
- omp's `search_tool_bm25` is **pure lexical BM25** (verified in `dist/cli.js`: `buildDiscoverableToolSearchIndex` + TF/IDF term-overlap; no embeddings). And omp's only catalogue "summary" (`summarizeDiscoverableTools`) is just `{ server, toolCount }` — it tells the model 530 tools are hidden but **nothing about what they do**.
- Net: the small models omp's discovery was built *for* are the ones too weak to *use* it — they don't search, they hallucinate names. They can't load the catalog and won't discover it.

Default `modelRoles.default = ollama/qwen3.5:latest` makes this the common case, and the easy "pick a Claude model" escape hatch is also broken (the `claude-*-local` options route through Meridian `:3456`, currently down).

## 2. Goals / non-goals

**Goals**
- A weak/local model gets: a small directly-loaded **core toolset** + **awareness of what else exists** + an **intent-based way to fetch the rest**.
- **Single source of truth**: everything derives from `defineTool` / `getCatalog()`. No hand-maintained, drift-prone artifacts.
- Improvements are **client-agnostic** — Claude/Codex benefit too.

**Non-goals**
- Rewriting omp's internal discovery. We work *with* it (give it a smart front-door).
- Making the smallest models (qwen3.5) flawless — there is a capability floor; the target is mid-tier local models (ornith-class) become usable.

## 3. Design principle (the through-line)

```
defineTool (TSDoc/guidance description + auto-derived <group>)
        │   getCatalog()  ── ONE source of truth
        ├─► tools/list                         (exists)
        ├─► catalogueProjection → capability map   (WS2 — always-loaded context)
        └─► tool-catalog hybrid search             (WS3 — lexical EXISTS + new embedding leg)
                 └─► `tools:find` MCP tool
```

`defineTool` already derives a tool's `description` from TSDoc/`guidance` (`libs/generic/tooldef/src/define-tool.ts`), and `<group>` from the `tools/<group>/<verb>.ts` path. The capability map and the search index are just two more **projections** over `registry.getCatalog()` — same pattern as `tool-projection.ts` / `slash-projection.ts`.

---

## 4. Workstreams

### WS1 — Curated core catalog (the ~17 always-loaded tools)

**What:** a small "always visible, no discovery needed" set that covers ~90% of turns. Measured cost: **~6.9k tokens** (fits a 32k model with ~25k to spare).

Proposed `CORE_MCP_TOOL_NAMES` (define next to `BEE_/QUEEN_MCP_TOOL_NAMES` in `libs/papercusp/packages/orchestrator/src/invoke.ts`):

| Group | Tools |
|---|---|
| Bootstrap | `coord:orient` |
| Coordinate | `coord:inbox`, `coord:ack`, `coord:send`, `coord:glance`, `coord:ask` |
| Plans & work | `plans:get`, `plans:set-status`, `plan_items:list`*, `work_items:list`, `work_items:claim`, `work_items:set_state`, `work_items:update` |
| Locks | `locks:acquire_granular`, `locks:release_granular` |
| Knowledge | `docs:search`, `memory:search` |

\* confirm exact name in the `plan_items` namespace.

**Tasks**
- [ ] Add `CORE_MCP_TOOL_NAMES` constant + a parity test (mirrors the existing `BEE_/QUEEN_` lists).
- [ ] **Fix:** `coord:orient` is absent from both `BEE_` and `QUEEN_` allow-lists today — add it (it's the documented bootstrap entry point).
- [ ] Wire the **omp** MCP url (`~/.omp/agent/mcp.json`) to advertise the core catalog via a scoped `?role=`/profile param so `tools/list` returns ~core (under the 40-tool discovery threshold → core loads *directly*, no search). Superuser dispatch is unchanged (the role only narrows the *advertised* surface; superuser can still call anything — see the `roleParam` handling in `_mcp-handler.ts` and the `invoke.ts` "advertises that role's catalog instead of the full operator-tier surface" note).
- [ ] Leave Claude/Codex on the full catalog (they have the context).

### WS2 — Derived capability map (catalogue summaries)

**What:** a compact (~1–2k token) map of the ~125 namespaces grouped into ~12 functional areas, one line each, injected into the always-loaded context so the model knows *what exists* and the *vocabulary to search*. **Generated**, never hand-maintained.

**Tasks**
- [ ] `catalogueProjection()` in tooldef (next to `tool-projection.ts`): read `registry.getCatalog()`, group by derived `<group>`, emit `{ group, oneLiner, toolCount }[]`.
  - **Level 1 (default, zero authoring):** derive each group's one-liner from its tools' `guidance`/descriptions (same way `defineTool` composes a description from `guidance`).
  - **Level 2 (optional, cleaner):** add `defineGroup(slug, oneLiner)` (or a co-located `_group.ts` in `tools/<group>/`); projection prefers the declared line, falls back to Level 1.
- [ ] A renderer producing the markdown map block.
- [ ] Inject into the omp playbook + coord-hook session-start primer (WS4). Optionally surface to Claude/Codex too.

### WS3 — `tools:find` (hybrid semantic + lexical catalog search)

**What:** an operator MCP tool `tools:find { query, limit }` returning the best-matching tools by **intent**, not just keyword — works for **all** clients. This is the real fix for omp's keyword-only `search_tool_bm25` vocabulary gap.

**Reuse (most of this already exists):**

| Piece | Reuse from | Status |
|---|---|---|
| Corpus (551 tools: name/category/capability/description) | `collectToolMeta()` + `resolveToolEntries()` — `packages/operator-core/lib/cupboard/tools-discovery.ts` (reads `getCatalog()` + `listAllProjectedTools()`) | ✅ exists |
| Lexical leg ("BM25") | `scoreTool`/`searchTools` + `FIELD_WEIGHTS` — `packages/operator-core/lib/cupboard/tools-search.ts` (name 10 … description 2) | ✅ exists |
| Embedding leg (new) | `buildLocalEmbedder`/`embedViaWorker` (`libs/generic/memory/src/local-embedder-worker.ts`) + `buildQueryEmbedder` (`packages/operator-core/lib/agent-tools/search/embedder.ts`) — 384-d, OpenAI-or-local cascade | borrow |
| Fusion | `rrfCombine` (`libs/generic/rrf/src/index.ts`) **or** `fuse()` floored-union (`libs/generic/memory/src/hybrid-fusion.ts`) | borrow |
| End-to-end template | `packages/operator-core/lib/code-recipes-search.ts` — a *global* (workspace-ignoring) hybrid `SearchSource` + `runHybridSearch` | copy shape |

**Critical design nuance:** `tools-search.ts` *deliberately avoids* RRF because **exact-name must always win** (don't bury `coord:orient` under a semantically-similar sibling). So **do not naive-RRF** the two legs — use the **floored-union / admission** pattern (`hybrid-fusion.ts`): semantic broadens recall (intent→tool), but a strong exact/prefix name hit is always admitted on top.

**Tasks**
- [ ] Index: embed `name + "\n" + description (+ optional arg-schema text)` for all 551 tools **once at boot** into an in-memory cosine array (551 vectors is trivial — no pgvector table needed). Re-embed when the pack catalog rebuilds (`derivePackCatalog()`), not on a row-NULL sweep.
- [ ] `tools:find` handler: lexical (`searchTools`) ∪ embedding (cosine) → floored-union fuse → return `name + description + schema` for top-N.
- [ ] Extend `collectToolMeta()` to carry arg-schema text if we want schema searchable (today `ToolDiscoveryEntry` has no schema).
- [ ] Add `tools:find` to `CORE_MCP_TOOL_NAMES` (WS1).

**Client integration**
- **Claude/Codex:** call `tools:find('<intent>')` → call the returned tool directly (already loaded / can register).
- **omp:** `tools:find('<intent>')` → exact tool *name* → omp's `search_tool_bm25('<exact name>')` activates it (keyword search always nails an exact name) → call it. We don't fight omp's activation; we feed it exact names.

### WS4 — Playbook primer / system prompt

**What:** tell every model the map of the world. Add to the omp playbook **and** the coord-hook session-start injection (`~/.papercusp/papercusp-coord.ts` + release source):

> Plans, work-items, inbox, and assignments live in the **coordination system — not files** (never `ls`/`find` for them). Call **`coord:orient` first**. You have a small core toolset and a capability map (below). For anything else, call **`tools:find('<what you need>')`** (omp: then `search_tool_bm25('<exact name>')` to load it), then use it.

- [ ] Append the WS2 capability map to the primer.
- [ ] This directly fixes the two ornith failures: filesystem-hunting for plans, and never unlocking coord tools.

### WS5 — Config / environment (the loose ends we discussed)

- [ ] **omp default model:** change `modelRoles.default` off `ollama/qwen3.5:latest` to a capable gateway default (e.g. `papercusp-gateway/claude-sonnet-4-6`). WS1–4 make weaker models *viable*, but the default should be sane. Still user-overridable via `/model` (not "forcing").
- [ ] **Meridian `:3456` down:** the `claude-*-local` picker options and the `slow` role route through it and currently fail. Restore/fix so model selection in omp works (the original "make providers work so the user selects" goal).
- [x] **Already shipped (separate, deployed):** `wake-executor.ts` now sets `PAPERCUSP_WORKSPACE: d.workspaceId` on autonomous omp resume turns (fixed `coord:* not found` for capable-model bees whose user-level mcp.json sent an empty workspace header). **Caveat:** currently uncommitted on the running `papercup-release` checkout + dev/staging — must be committed so a release sync doesn't revert it.

---

## 5. Sequencing

1. **WS1 + WS4** — core catalog + primer. Immediate, low-risk, mostly config/prompt. Validate on ornith.
2. **WS2** — capability map (folds into the primer).
3. **WS3** — `tools:find` (the durable discovery upgrade).
4. **WS5** — config fixes, in parallel.

## 6. Validation

- **Repro→fix:** re-run the exact failing task — *"what are the plan items that are still unimplemented"* — on **ornith** after WS1+WS4. Today: hallucinates `db.sqlite:*`/`read_file`, 0 real tools. Target: uses real tools, real answer. (Already proven that `papercusp-gateway/claude-haiku-4-5` answers this correctly with 0 not-founds — that's the capable-model control.)
- **Token budget:** core ≤ ~7k + map ≤ ~2k → fits 32k with headroom.
- **`tools:find` quality:** intent queries resolve correctly — "feature flag" → `flags:*`, "spawn a worker" → `fleet:spawn`, "what plans are open" → `plans:*`. Exact-name queries never buried.
- **No regression:** Claude/Codex keep the full catalog; they additionally gain `tools:find` + the map.

## 7. Open decisions

1. **Universal core vs role-aware core?** Recommend **universal first** (the 17 cover most turns); roles `tools:find` their extras.
2. **Scope: omp-only, or also slim Claude/Codex?** Recommend **omp-first**; revisit the Claude/Codex ~141k tool-tax later (would need `tools:find` + a registration/`tools/list_changed` story).
3. **Embedding provider:** local `bge-small-en-v1.5` (no external dep) default; OpenAI `text-embedding-3-small` when a key is present. Both 384-d (same space as memories).
4. **`defineGroup` now or derive-only?** Ship Level-1 derivation first; add `defineGroup` opportunistically for groups whose auto-summary reads poorly.

## 8. Risks

- Narrowing omp's advertised catalog could hide a tool an agent needs → mitigated by `tools:find` + `search_tool_bm25` fallback + superuser can still call anything.
- Fusion must preserve exact-name primacy (floored-union, **not** naive RRF).
- `defineGroup` adds a small authoring surface → keep optional; Level-1 derivation is the floor.

## 9. Key file references

- Catalog measurement / discovery internals: omp `node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js` (`tV`, `mcp.discoveryMode`, `buildDiscoverableToolSearchIndex`, `summarizeDiscoverableTools`).
- tooldef: `libs/generic/tooldef/src/{define-tool,registry,tool-projection,slash-projection}.ts`.
- Existing tool-catalog search: `packages/operator-core/lib/cupboard/{tools-search,tools-discovery}.ts`.
- Search infra to borrow: `libs/generic/rrf/src/index.ts`, `libs/generic/memory/src/{local-embedder-worker,hybrid-fusion}.ts`, `packages/operator-core/lib/agent-tools/search/embedder.ts`, `packages/operator-core/lib/code-recipes-search.ts`, `libs/generic/search/src/hybrid.ts`.
- Curated lists + omp catalog wiring: `libs/papercusp/packages/orchestrator/src/invoke.ts` (`BEE_/QUEEN_MCP_TOOL_NAMES`), `_mcp-handler.ts` (`roleParam`).
- omp launch + primer: `apps/operator/scripts/psu-launcher.mjs`, `~/.papercusp/papercusp-coord.ts`.
