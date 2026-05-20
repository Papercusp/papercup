---
title: Plugin MCP Host — design doc v2
slug: plugin-mcp-host-design-2026-05-10
status: superseded
created: 2026-05-10
updated: 2026-05-20
owner: pandawamble@gmail.com
---

## Now

**State:** **Status:** **shipped** as foundation PRs 0c.A–E (commits 0de6d10 → f62d4b4). **Scope:** how Papercusp plugins contribute tools that any transport (HTTP, MCP) can call. **Driver:** Foundation for shipping Repomix, GitNexus-bridge, Code2Prompt, fetch-plus, firecrawl-bridge, and any future tool plugins.

**Next:** Archived — no further work expected. Restore from archive/ only if context warrants.


# Plugin MCP Host — design doc v2

**Status:** **shipped** as foundation PRs 0c.A–E (commits 0de6d10 → f62d4b4).
**Scope:** how Papercusp plugins contribute tools that any transport (HTTP, MCP) can call.
**Driver:** Foundation for shipping Repomix, GitNexus-bridge, Code2Prompt, fetch-plus, firecrawl-bridge, and any future tool plugins.

---

## TL;DR — function-as-truth

**The function is the source of truth.** HTTP and MCP are both projections of it. A plugin author writes:

```ts
// plugin/index.ts
export const tools = {
  async pack(input, ctx) {
    ctx.progress(0, 'starting');
    const result = await packRepo(ctx.projectDir, input);
    return { content: [{ type: 'text', text: result }] };
  }
};
```

```json
// plugin/papercusp.json
"tools": [{
  "name": "pack",
  "description": "Pack project for AI",
  "inputSchema": { "type": "object" },
  "capabilities": ["tools:repomix:pack"],
  "roles": ["scoper", "architect", "worker"],
  "rolesQuota": { "worker": { "perChunk": 1 } },
  "expose": {
    "http": { "path": "/api/plugins/repomix/pack" },
    "mcp":  { "name": "repomix.pack" }
  }
}]
```

The framework auto-mounts the function on **both** transports. Plugin author writes one function + one manifest entry. Test surface: unit-test the function with a mock `UnifiedToolContext`. No HTTP integration tests required, no MCP transport mocks. The 27 existing built-in agent-mcp tools auto-projected onto HTTP via `defineTool()` → no per-tool migration code.

OMP points at one MCP endpoint (`http://localhost:3070/api/sse?harness=...&role=...&run=...&spawn=...`); the seven per-spawn URL params let the operator filter tools by role and enforce per-chunk/per-run quotas at dispatch time.

---

## Six decisions

### D1. Where the host runs

**In-process inside the operator app, served via the existing `packages/agent-mcp` HTTP/SSE endpoint.**

Rationale: `agent-mcp` already exists, already serves 27 tools at `/api/[transport]/route.ts`, already has HTTP/SSE working. Adding plugin tools is a merge step at request time, not a new process. Plugins are first-party so we trust them; if a plugin handler throws, the request fails visibly. Process isolation is overengineering for v1.

Rejected alternatives:
- Per-harness child process: more lifecycle plumbing than the value justifies.
- Per-plugin MCP server: 5+ MCP servers in OMP config; cache & startup overhead per call.

### D2. Tool registration API shape

**Manifest-declarative + typed handler export. Mirror the existing `actions[]` pattern.**

`papercusp.json`:
```json
{
  "name": "@papercupai/repomix",
  "tools": [
    {
      "name": "repomix.pack",
      "description": "Pack a project (or subset) into a single LLM-friendly document.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "include": { "type": "array", "items": { "type": "string" } },
          "ignore":  { "type": "array", "items": { "type": "string" } },
          "format":  { "enum": ["xml", "md", "plain"], "default": "xml" }
        }
      },
      "capabilities": ["tools:repomix:pack"],
      "roles":        ["scoper", "architect", "operator", "reviewer", "debugger", "worker"],
      "rolesQuota":   { "worker": { "perChunk": 1 } }
    }
  ]
}
```

`index.ts`:
```ts
import type { ToolHandler } from '@papercusp/plugin-sdk';

export const tools: Record<string, ToolHandler> = {
  'repomix.pack': async (input, ctx) => {
    // ctx.harness, ctx.role, ctx.projectDir, ctx.log, ctx.spawn, ctx.db (capability-gated)
    const out = await ctx.spawn('repomix', [...]);
    return { content: [{ type: 'text', text: out.stdout }] };
  }
};
```

The manifest is the source of truth for what tools exist, what capabilities they need, what roles can call them, and quotas. The code provides only handlers. Static analysis can validate manifest ↔ exports at load time.

### D3. Capability gating + role allowlist

Three checks per invocation, in order:

1. **Plugin enabled for this harness?** From `harness_shared.installed_plugins` + per-harness install state.
2. **Calling role in `tools[].roles` allowlist?** Header-supplied role, manifest-declared list.
3. **Quota satisfied?** `tools[].rolesQuota[role]` checked against per-chunk PG counter.

Capability declarations on the tool (`capabilities: ["tools:repomix:pack"]`) are validated at plugin install time (manifest declares matching `capabilities` at top level). At invocation time the cap is already implicit — if the plugin is loaded, its capabilities are already granted.

Failures return MCP errors with codes: `plugin-disabled`, `role-not-allowed`, `quota-exceeded`.

#### Authentication boundary

The dispatcher enforces capability/role/quota but does **not** authenticate the URL spawn-context query params (`?role=worker&run=R&spawn=S&...`). The `spawn` and `parent_spawn` IDs are not signed; nothing on the HTTP layer verifies they were issued by the orchestrator.

This is intentional and currently safe because:

- The operator binds to `127.0.0.1` by default (`PAPERCUSP_BIND_HOST`) — see `project_operator_auth_loopback.md`. Only local processes can hit `/api/plugins/*` or `/api/[transport]`.
- Built-in tools (defined via `defineTool`) still require a bearer token — they throw `UnauthorizedToolError` (→ HTTP 401) when `ctx.principal` is missing.
- Plugin tools rely on the orchestrator's spawn-time URL-baking guarantee: the orchestrator writes the per-spawn `.mcp.json` with the URL it controls, and the agent only ever sees that URL.

If we ever bind off-loopback, the spawn URL params will need to be signed (HMAC over `workspace|harness|role|run|spawn` with a per-process key) and verified at the HTTP boundary before the dispatcher runs.

### D4. Tool discovery for OMP

OMP gets ONE MCP server entry in its `mcp.json`. Context goes in **URL query params** (not headers) for maximum MCP client compatibility:

```json
{
  "mcpServers": {
    "papercusp": {
      "url": "http://localhost:3070/api/agent-mcp/sse?harness=${HARNESS_SLUG}&workspace=${WORKSPACE_ID}&role=${ROLE}&feature=${FEATURE_ID}&chunk=${CHUNK_ID}&run=${RUN_ID}&spawn=${SPAWN_ID}"
    }
  }
}
```

**Seven params per spawn.** Multiple concurrent OMP spawns (e.g. parallel workers on different features) each get their own URL with their own param values, baked into their own `mcp.json` at spawn time. No shared state between spawns.

| Param | Purpose |
|---|---|
| `harness` | Per-harness PG schema, project dir, plugin set |
| `workspace` | Multi-workspace isolation; filters credentials and search providers |
| `role` | Capability + role-allowlist + quota window selection |
| `feature` | Feature this spawn is working on; telemetry grouping; future per-feature tool overrides |
| `chunk` | Quota window key for worker `perChunk` quotas |
| `run` | Quota window key for non-worker `perRun` quotas; audit grouping |
| `spawn` | Unique per-spawn ID for audit, dedup, log correlation |

The orchestrator's spawn-env code (currently writes `OMP_MEMORIES_ENABLED=false` etc.) gets extended to write a per-spawn `mcp.json` with all seven values substituted. OMP picks it up via `OMP_MCP_CONFIG_PATH` or its standard config-discovery path.

Server-side, agent-mcp parses the URL params on each connection and binds them into the request context. Validation: missing or unknown harness/role/workspace returns a clear MCP error before any tool call. `feature`/`chunk` may be empty for some non-worker roles (architect at run start has no feature yet); empty is allowed.

**Quota window resolution:**
```ts
const windowKey = isWorkerRole(role) ? `chunk:${chunk}` : `run:${run}`;
// quota check looks up (toolName, role, windowKey, workspace) in tool_invocations
```

Worker A on chunk `ck_C1` calling `repomix.pack` does not share a quota counter with Worker B on chunk `ck_C5`. Each spawn has independent quotas scoped to its own chunk.

**Role-fixedness within a spawn:** the seven params are immutable for the lifetime of an OMP spawn. If the orchestrator transitions worker → validator on the same feature, that's a new OMP process with a new `mcp.json` and new `spawn` ID. No mid-session role transitions.

Inside `agent-mcp`'s `tools/list` handler:

```ts
const builtinTools = getBuiltinTools(ctx);
const pluginTools  = await loadEnabledPluginTools(ctx); // filtered by harness + role
return [...builtinTools, ...pluginTools];
```

OMP sees a flat list of tools — `read`, `grep`, `lsp`, `repomix.pack`, `gitnexus.impact`, etc. — and can't tell which are built-in vs plugin-contributed. That's intentional.

### D5. Per-harness context injection

Every tool handler receives a `ToolContext`:

```ts
interface ToolContext {
  harness: { slug: string; projectDir: string; stateDir: string; phase: string };
  workspace: { id: string };
  role: AgentRole; // 'scoper' | 'worker' | 'validator' | ...
  log: (msg: string) => void;
  spawn: (bin: string, args: string[], opts?) => Promise<{ stdout: string; stderr: string; code: number }>;
  // capability-gated PG access:
  db: { query: (sql: string, params?: unknown[]) => Promise<QueryResult> };
  // capability-gated secret access:
  secret: (name: string) => Promise<string | null>;
}
```

Mirrors the existing `PapercuspContext` from the plugin SDK; the new bit is `role` (which the agent-mcp request injects from headers) and the typed shape suited for tool handlers vs lifecycle hooks.

### D6. Streaming / long-running tools

**v1: streaming is built-in via `ctx.progress(pct, msg)` callback.** Every tool handler receives a `progress` function in its context; calling it emits MCP `notifications/progress` to the client. Tools that don't care just never call it.

```ts
'gitnexus.impact': async (input, ctx) => {
  ctx.progress(0, 'starting impact analysis');
  const callers = await findCallers(input.symbol);
  ctx.progress(50, `found ${callers.length} direct callers`);
  const transitive = await traverseGraph(callers);
  ctx.progress(100, 'done');
  return { content: [{ type: 'text', text: formatResult(transitive) }] };
}
```

No timeout cap by default; tools declare `"timeoutSec"` in manifest if needed. The agent client (OMP) handles the streamed events natively. The operator UI's Intel tab subscribes to the same SSE stream for live progress visualization.

Tools producing large final outputs (Repomix on a big repo) still use the disk-handoff pattern (`{ path }` return) — streaming is for progress visibility, not for chunking 500k-token outputs through MCP. The two patterns are orthogonal.

---

## Concrete implementation work

Six PRs. ~3 days total.

### PR 1: Plugin SDK type extensions (~2h)
- `packages/plugin-sdk/src/index.ts`: add `Tool`, `ToolHandler`, `ToolContext`, `RolesQuota` types.
- Extend `Capability` union with `tools:<name>` patterns.
- 4 unit tests for type guards.

### PR 2: Plugin loader changes (~3h)
- `packages/plugin-loader`: when loading a plugin, discover `tools[]` from manifest, validate against exported `tools` object, register into a workspace-level registry keyed by `(plugin, toolName)`.
- Tests: load slack-notifier (no tools — should still load), and a fixture plugin with tools.

### PR 3: agent-mcp tool merging (~6h)
- `apps/operator/app/api/agent-mcp/[transport]/route.ts`: add a per-request middleware that reads context headers, queries enabled plugins, filters by role, and merges into the tool list.
- New endpoint or middleware: `/api/agent-mcp/tools-debug` returning the resolved tool list for a given (harness, role) so we can inspect.
- Tests: integration test with a fixture plugin showing role-filtered visibility.

### PR 4: Spawn-env injection (~4h)
- `libs/papercusp/packages/orchestrator/src/spawn-env.ts` (or wherever OMP's env is built today — needs verification): write a per-spawn `mcp.json` to `<state_dir>/spawn-mcp.json`, set `OMP_MCP_CONFIG_PATH` to point at it.
- Spawn-env adds `X-Papercusp-Harness/Role/Workspace` headers via the MCP config.
- Tests: spawn fixture, assert generated mcp.json shape.

### PR 5: Quota enforcement (~3h)
- Migration 046: `harness_shared.tool_invocations` (also covers Phase 6 telemetry; one table, two purposes).

```sql
CREATE TABLE harness_shared.tool_invocations (
  id              BIGSERIAL PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  harness_slug    TEXT NOT NULL,
  plugin_name     TEXT NOT NULL,
  tool_name       TEXT NOT NULL,
  role            TEXT NOT NULL,
  feature_id      TEXT NULL,
  chunk_id        TEXT NULL,
  run_id          TEXT NULL,
  spawn_id        TEXT NOT NULL,
  window_key      TEXT NOT NULL,        -- 'chunk:<id>' or 'run:<id>'
  invoked_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  duration_ms     INT NULL,
  status          TEXT NOT NULL,         -- 'ok' | 'error' | 'quota-exceeded' | 'role-not-allowed'
  output_ref      TEXT NULL,             -- path to .harness/scratch/<...> if disk-handoff
  output_size     BIGINT NULL,
  error_message   TEXT NULL
);

CREATE INDEX tool_invocations_quota_idx
  ON harness_shared.tool_invocations(workspace_id, tool_name, role, window_key)
  WHERE status = 'ok';

CREATE INDEX tool_invocations_telemetry_idx
  ON harness_shared.tool_invocations(workspace_id, harness_slug, invoked_at DESC);
```

- agent-mcp request middleware checks quota: `SELECT count(*) FROM tool_invocations WHERE (workspace_id, tool_name, role, window_key) = ($1,$2,$3,$4) AND status = 'ok'`.
- Quota-exceeded returns a structured MCP error so OMP surfaces it cleanly.
- Tests: 3 quota cases (under, at, over) per role-window combination.

### PR 6: Operator settings UI (~3h)
- `/settings/plugins/<id>` page: show which tools the plugin contributes, current capability/role/quota config.
- Read-only for v1; per-harness overrides come later if needed.
- Snapshot test.

After this foundation lands, each tool plugin (Repomix, GitNexus-bridge, Code2Prompt, fetch-plus, firecrawl-bridge) is purely "add a plugin directory with manifest + handlers + a couple of tests." No more architectural decisions.

---

## Shipped — implementation map (PR 0c.A–E)

| PR | Commit | Module |
|---|---|---|
| 0c.A | `0de6d10` | `packages/agent-mcp/src/tool-projection.ts` — registry + lookup + `UnifiedToolContext` |
| 0c.A | `0de6d10` | `packages/agent-mcp/src/dispatch-projected.ts` — single dispatcher (role + quota + capability gates) |
| 0c.B | `0b86aad` | `packages/agent-mcp/src/http-projection.ts` — pure HTTP routing logic |
| 0c.B | `0b86aad` | `apps/operator/app/api/plugins/[...path]/route.ts` — Next.js dynamic catch-all |
| 0c.C | `8f2868b` | `apps/operator/app/api/[transport]/route.ts` — MCP route migrated to projection registry |
| 0c.D | `5f26695` | `packages/agent-mcp/src/define-tool.ts` — auto-mirrors all 27 built-ins onto projection registry |
| 0c.D | `5f26695` | `apps/operator/app/api/agent-tools/[...path]/route.ts` — HTTP catch-all for built-ins |
| 0c.E | `f62d4b4` | `packages/plugin-loader/src/index.ts` — `registerPluginTools()` wires manifest → projection |
| 0c.E | `f62d4b4` | `packages/agent-mcp/src/spawn-context.ts` — split out from dropped plugin-tools.ts |

**Test totals at end of 0c.E:** 152 actual tests pass across agent-mcp + plugin-loader + plugin-sdk. 39 of those are new from PR 0c (12 registry + 14 dispatcher + 13 http).

**Net code:** ~1,100 lines added (projection registry + transports), ~600 lines deleted (legacy plugin-tools.ts + tests + handler-map types).

---

## Phase 9 forward-looking adds (now, not later)

Spawn (Phase 9) is built on this foundation but informs two PRs that ship now:

**PR 5 schema additions:**
- `tool_invocations.parent_spawn_id TEXT NULL` — audit chain for spawned children.
- `harness_chunk_plans.spawned_by_spawn_id TEXT NULL` — keeps chunk planner from double-launching agent-spawned workers (added via Migration 046 ALTER).

**PR 7 prompt-builder addition:**
- New `spawnContext` section helper (fast-volatile category, trails the prompt). Reader queries `tool_invocations` for the current spawn's parent; if `parent_spawn_id` is non-null, renders "Spawned by <parent_role> for: <stated reason>". Empty until Phase 9 ships.

These are zero-cost forward-looking adds during this foundation. Without them, Phase 9 requires a schema migration + prompt-builder rewrite later.

## Phase 9 sketch — `@papercupai/orchestrator-spawn` (~2 days)

Built-in plugin contributing four tools:

```
orchestrator.spawn        { role, feature?, extras?, awaitResult? } → { spawnId, status, result?, error? }
orchestrator.poll         { spawnId } → { status, progress?, result?, error? }
orchestrator.list_active  → [{ spawnId, role, feature, progress }, ...]
orchestrator.cancel       { spawnId } → { ok: true }
```

**Per-role spawn allowlist** (manifest):

| Caller | Can spawn |
|---|---|
| Architect | worker, validator, scoper, reviewer, debugger |
| Operator | any |
| Debugger | validator |
| Scoper | validator, reviewer |
| Reviewer | architect |
| Worker, Validator | nothing |

**Safety knobs** (per-harness configurable): `maxDepth=3`, `maxChildrenPerParent=5`, `maxConcurrent=10`, `costBudgetTokens=parent.remaining`, `timeoutPerChildSec=600`.

**Implementation:** the spawn tool handler calls into the existing orchestrator `invoke()` with a fresh tmpfs dir, a fresh per-spawn `mcp.json` (carrying parent's harness/workspace + new role/feature/chunk/spawn/parent_spawn IDs), and registers the spawn in `harness_chunk_plans` via the existing chunk-planner gate. Worktree allocation reuses `branch-iso.ts`. Cost cap reuses `cost-cap.ts` with a new `attribute(parentSpawn, costTokens)` API. Streaming progress events bubble up to the parent's MCP session via the same `ctx.progress(pct, msg)` primitive.

**Cross-cutting integration touches** (all phases):
- Phase 1 (Repomix): no change. URL params already include `chunk` so parallel spawns get isolated quotas.
- Phase 2 (Code2Prompt): no change.
- Phase 3 (GitNexus): no change.
- Phase 4 (search keys): no change. `workspace` URL param means children inherit credentials.
- Phase 5 (fetch-plus / firecrawl): no change.
- Phase 6 (Intel tab): **+ 4th sub-tab "Spawns"** for live tree visualization. Will scaffold it now with empty state.
- Phase 7 (prompt-builder): `spawnContext` section helper added now, populated when Phase 9 ships.
- Phase 8 (docs): + page on spawn primitive when Phase 9 ships.

---

## Risks

| # | Risk | Mitigation |
|---|---|---|
| H1 | Plugin handler crashes take out an MCP request | Wrap every handler call in try/catch at the host; structured error response; circuit-breaker per plugin (3 fails in 60s → temp-disable) |
| H2 | Header forgery — agent claims wrong role to bypass quotas | Headers come from spawn-env which the orchestrator owns; OMP can't override per-call. Verify by signing the role header with a per-spawn HMAC if paranoid |
| H3 | Plugin handlers do unbounded I/O (memory, network) | `ctx.spawn` already capability-gated; add per-call wall-clock timeout (default 60s) and memory ceiling (200MB) |
| H4 | Tool name collisions between plugins | Manifest schema enforces `tools[].name` is `<plugin-prefix>.<verb>`; loader rejects on duplicate registration |
| H5 | OMP version drift breaks MCP transport | Pin minimum OMP version that supports HTTP MCP transport; test against locked version |
| H6 | Slow build of `tools/list` if many plugins enabled | Cache resolved list per (harness, role) for 5s; invalidate on plugin install/uninstall |

---

## Decisions locked (post-review)

1. **Function-as-truth (revised 2026-05-09 mid-implementation):** the function is the source of truth; HTTP and MCP are projections. Plugin authors declare manifest entries with `expose.{http?, mcp?}` and export a function map. Framework auto-projects on both transports.
2. **Transport:** URL query params, not headers. Maximum MCP-client compatibility.
3. **`role` source of truth:** orchestrator spawn-env (URL baked at spawn time, not derived at request time).
4. **Built-in vs plugin tool names:** projected-tool registry rejects duplicate names/paths across plugins. Built-ins use colon convention (`tasks:list`); plugin tools use dot convention (`repomix.pack`). Both accepted.
5. **Quota windows:** `perRun` for non-worker roles, `perChunk` for workers.
6. **Hidden plugins:** `hidden: true` is a marketplace-listing flag only; tools still register at runtime.
7. **Streaming:** built-in to v1 via `ctx.progress(pct, msg)` callback. Currently no-op on both transports — wiring to MCP `notifications/progress` and HTTP SSE deferred to a follow-up.

All decisions ratified 2026-05-09.
