---
title: Brief: migrating components to the projected-tool MCP framework
slug: plugin-mcp-migration-brief-2026-05-10
status: shipped
created: 2026-05-10
updated: 2026-06-01
owner: pandawamble@gmail.com
---

## Now

**State:** For agents picking up component migrations after the spawn-system port. Read this front-to-back before touching code.

**Next:** Owner: review current state and replace this auto-generated Now block (backfilled 2026-05-20).


# Brief: migrating components to the projected-tool MCP framework

For agents picking up component migrations after the spawn-system port. Read this front-to-back before touching code.

---

## TL;DR — what the framework gives you

You write **one typed function**. The framework projects it onto:
- An HTTP route at `/api/plugins/<plugin>/<tool>` (or `/api/agent-tools/<tool>` for built-ins)
- An MCP `tools/call` entry under `<plugin>.<tool>` (or `<scope>:<verb>` for built-ins)

You declare exposure + role + quota + capabilities in a manifest entry. The framework handles auth gating, role allowlisting, quota windows, telemetry persistence, streaming progress, and per-spawn URL context — none of which you write per tool.

Spec: `apps/operator/docs/plugin-mcp-host-design.md`. Read D1–D6 before D3 ("Authentication boundary" + the Phase 9 sketch are the bits agents miss most).

---

## The shapes you'll work with

### Built-in tools (`packages/agent-mcp/src/tools/**`)
- Use `defineTool({ name, capability, schema, handler })`
- Handler signature: `(input, { principal, tx, ... })`. Auth-required (bearer → principal); throws `UnauthorizedToolError` (→ 401) if `principal` is missing.
- Auto-projected to both transports via `defineTool`'s extension. **You do not write a route file.**
- Quota / role gating: not used (built-ins gate by capability via principal).

### Plugin tools (`libs/papercusp/plugins/<name>/`)
- `papercusp.json` declares `tools[]` with `{ name, description, inputSchema, capabilities, roles[], rolesQuota, timeoutSec, expose: { http?, mcp? } }`
- `index.ts` exports `tools: { <name>: handler }` matching each manifest entry
- Handler signature: `(input, ctx: ToolContext)` where ctx has `{ workspaceId, harnessSlug, role, runId, spawnId, featureId?, chunkId?, log, signal, progress, spawn?, secret?, projectDir?, stateDir? }`
- **No principal** — gating is role + quota + URL-baked spawn context (see "auth boundary" below).
- The framework picks up your handler via `registerPluginTools` at host init.

### Default exposure (omit `expose.*` and you get):
- `expose.mcp.name` → `<short-pluginName>.<tool.name>` (drops `@scope/` prefix)
- `expose.http.path` → `/api/plugins/<short-pluginName>/<tool.name>`

You only declare `expose.*` if you want to override the default name/path.

---

## Migration recipe (in order)

### 1. Pick the right shape
Decision tree:
- **Component currently uses bearer auth + workspace-scoped PG** → it's a built-in. Use `defineTool`.
- **Component shells out to a CLI** → plugin, single-tool or multi-tool. (Repomix = single, code2prompt = multi.)
- **Component is an HTTP fetch with optional/required secret** → plugin. (fetch-plus, firecrawl-bridge.)
- **Component is currently exposed as a one-off Next.js API route used by agents** → plugin if it has stable args; built-in if it needs principal.
- **Component is a long-running subprocess that needs to stay resident** → don't try to project it. The framework expects request/response, not daemons. Wrap a *client* of the daemon as a tool.

### 2. Write the function first (function-as-truth)
- TS function. Input + output typed. No transport awareness inside.
- Inputs reach you via the second arg's `ctx.signal` for cancel; that's the only transport-bleed in the contract.
- Returns `{ content: [{ type: 'text', text: ... }] }` (the MCP `ToolResult` shape — same on both transports).
- Throw to fail; the dispatcher records `status='error'` with the message.
- For long outputs: write to `<stateDir>/scratch/<id>.<ext>` and return `{ content: [{ type: 'text', text: 'Wrote to <path>' }] }`. Repomix `pack` does this for >50k.

### 3. Declare the manifest entry
Minimum:
```json
{
  "name": "do_thing",
  "description": "One sentence. Lead with the verb. Mention what to use it instead of.",
  "inputSchema": { "type": "object", "properties": { "x": { "type": "string" } }, "required": ["x"] },
  "capabilities": ["tools:<plugin>:do_thing"],
  "roles": ["worker", "architect"],
  "rolesQuota": { "worker": { "perChunk": 1 }, "architect": { "perRun": 5 } },
  "timeoutSec": 60
}
```
- `capabilities` for plugin tools are descriptive, not enforced (no principal). Used by tooling/Intel UI.
- `roles` is enforced. Roles you're picking from: `worker, validator, scoper, architect, reviewer, debugger, operator, documenter, curator`. Worker quotas are **`perChunk`** (resets per chunk); everyone else is **`perRun`** (resets per orchestrator run).
- `timeoutSec` defaults to 60 if omitted. Aborts the call via `ctx.signal`.
- `inputSchema` — **JSON Schema directly**. Don't reach for `zodToJsonSchema` (broken on Zod 4); just write the schema.

### 4. Test surfaces (do not skip)
- Live HTTP: `curl -X POST 'http://localhost:3055/api/plugins/<plugin>/<tool>?harness=h&workspace=default&role=architect&run=R&spawn=S' -d '{...}'`
- Live MCP: `curl -X POST 'http://localhost:3055/api/mcp?harness=h&workspace=default&role=architect&run=R&spawn=S' -H "Accept: text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"<plugin>.<tool>","arguments":{...}}}'`
- Verify telemetry row landed: `psql -c "SELECT tool_name, role, status FROM harness_shared.tool_invocations ORDER BY id DESC LIMIT 1"` (use `set_config('app.workspace_id', 'default', false)` first — the table has RLS).
- Verify quota: fire perChunk+1 calls with same `chunk=` → second is `429 quota_exceeded`.
- Verify role gate: call with a role NOT in `roles[]` → 403 `role_not_allowed`.
- Verify `/api/plugins/tools` shows your tool with the right metadata.
- Refresh the host: `curl -X POST /api/plugins/host/refresh` should return `errors=2` (the 2 pre-existing) — if it goes up, you broke something.

### 5. After every plugin edit
- `curl -X POST /api/plugins/host/refresh` to re-discover. Otherwise you're testing stale code.
- HMR is unreliable for tool registrations because the projection registry is module-level state.

---

## Things that bit me (plus the fixes already shipped — don't re-bite)

These are landed; you shouldn't rediscover them. But understand them so you don't accidentally regress.

| Trap | What it looks like | Fix already in place |
|---|---|---|
| `zodToJsonSchema(zod4Schema)` returns `{}` | Agents see empty `inputSchema` for your tool | Use `z.toJSONSchema()` (Zod 4 built-in) or write the schema directly |
| In-repo plugins not discovered | `/api/plugins/tools` shows 0 plugin tools | `loadPlugins({ projectDir })` is wired via `findBundledPluginsParent()`; if you add a plugin in `libs/papercusp/plugins/<name>/`, refresh and it shows up |
| Refresh re-registers and collides with itself | "claimed by plugins X and X" errors | `registerPluginTools` calls `unregisterProjectedToolsForPlugin(name)` first |
| `SET LOCAL app.workspace_id = $1` | "syntax error at or near $1" — silent quota/telemetry failure | Use `SELECT set_config('app.workspace_id', $1, true)` — PG `SET` doesn't accept binds |
| `ctx.spawn` undefined on HTTP | Subprocess plugins return "ctx.spawn not available" | HTTP-projection takes `extras.spawn`; the operator route passes `pluginSpawnImpl` from `apps/operator/lib/plugin-spawn-impl.ts` |
| Built-in tool wrapped without auth | Returns 500 instead of 401 | `UnauthorizedToolError` thrown by built-in wrapper, mapped to `'unauthorized'` code → 401 |
| Migrations live in submodule but never applied | Tables don't exist; calls 500/silent-fail | Embedded-pg has an idempotent runner (added 2026-05-05) — auto-applies on boot. **Native PG `:5432` is dev-only and has no runner**: write the SQL in `libs/papercusp/libs/db/sql/<NNN>-*.sql` (so embedded-pg picks it up) and apply manually for dev with `psql -f`. Native PG is going away at public release; embedded-pg is the only ship target. See CLAUDE.md "Database topology" for details. |

---

## Known open issues (don't accidentally fix something else and call it done)

These three are explicitly known and tracked. Keep them straight from genuine new bugs.

1. **`ctx.projectDir` is never resolved on HTTP transport.** MCP route calls `resolveHarnessPathsImpl(harnessSlug, workspaceId)`; HTTP path skips it. Tools needing `projectDir` (repomix, code2prompt) work over MCP, fail over HTTP with a clear message. Fix is to lift the resolver into a shared helper and call it from `http-projection.ts` after `buildHttpSpawnContext`.

2. **Orchestrator default operator URL is `:3070` (prod).** `libs/papercusp/packages/orchestrator/src/spawn-mcp.ts:51`. In dev, agents' `.mcp.json` will point at the wrong port unless `PAPERCUSP_OPERATOR_URL=http://localhost:3055/api/sse` is set. Open question: NODE_ENV-aware default vs strict-no-default-fail-loud.

3. **`buildSpawnEnv()` for search-provider keys runs only on the expert-dispatcher path.** The main `invoke.ts` spawn doesn't inject decrypted search keys. Workers/validators/scoper/architect won't see TAVILY_API_KEY etc. ~5 lines to fix; intentionally not landed yet.

If your component touches projectDir, port-routing, or search-provider env, **fix or surface the related issue rather than working around it.**

---

## How to think about gating

Two enforcement layers, do not conflate:

- **Capability** (built-in tools only). Bearer → principal → `principal.capabilities` set. The dispatcher checks `tool.capabilities[]` ⊆ `principal.capabilities`. Failure → 403 `missing_capability`.
- **Role + quota** (plugin tools). URL spawn-context (`?role=&run=&chunk=&...`) is trusted under loopback bind. Dispatcher checks `tool.roles.includes(ctx.role)` then `count(<workspace, tool, role, windowKey>)` against `tool.rolesQuota[role]`.

There is **no auth check on the HTTP layer** for plugin tools — the orchestrator is trusted to bake the URL. If you ever add a feature that exposes plugin endpoints off-loopback, **add HMAC signing of the URL params first**. Read the new "Authentication boundary" section in the design doc.

---

## Don't migrate these (yet)

- **`runClaudeChat` LLM streams** — needs out-of-band SSE handling separate from `notifications/progress`. Out-of-scope for the current framework.
- **Voice WSS** — same reason; it's a true bidirectional stream, not request/response.
- **Operator/cards UI APIs** — they need principal + RLS-bound transactions and don't benefit from MCP exposure (no agent calls them).
- **Zero-cache / rest-query** — replication tier; lives below the tool framework.
- **Anything that accepts file uploads >5MB** — multipart isn't wired through the projected-tool dispatcher; SSE response only. Either keep as-is or build the upload bridge first.

These are tracked in the rust-port "skip-to-end" bucket. If you think one belongs in the framework, raise it before sinking time into it.

---

## Order I'd migrate the rest in

If you have a backlog of components, this order minimizes blockers:

1. **Anything that already takes a JSON request and returns a JSON response.** Cheap. The translation is mostly schema-writing.
2. **Subprocess wrappers** (CLIs that exist as Next routes). Repomix-shape: `ctx.spawn(bin, argv, opts)` + capability `compute:exec:<bin>`. ~1h each once you've done the first.
3. **HTTP-fetch wrappers with secrets** (third-party API bridges). fetch-plus / firecrawl shape: `ctx.secret(NAME)` + `http:fetch:<host>` capability. ~30min each.
4. **MCP-proxy plugins** (already-MCP CLIs). New shape — only GitNexus is planned. Needs the manifest contract extension `dynamicTools()`. **Do not invent this on the fly** — coordinate with the GitNexus track.
5. **Built-in tool migrations** (existing `defineTool` callers). Trivial; `defineTool` already auto-projects. The work is mostly cleanup of legacy ad-hoc routes that duplicated the tool surface. Verify each migration kills the old route — leftover dual-paths cause the audit-1 deduplication issue.

For each: open the design doc → write the manifest entry → write the function → run the 5 test surfaces in step 4 above → commit + push (per-turn discipline applies).

---

## Where state lives

You should not need to invent any of this — but knowing where to look saves an hour:

| Concern | Module |
|---|---|
| Projection registry (the source of truth) | `packages/agent-mcp/src/tool-projection.ts` |
| Built-in `defineTool` + auto-projection | `packages/agent-mcp/src/define-tool.ts` |
| Plugin `registerPluginTools` (manifest → registry) | `packages/plugin-loader/src/index.ts` |
| HTTP catch-all (plugins) | `apps/operator/app/api/plugins/[...path]/route.ts` |
| HTTP catch-all (built-ins) | `apps/operator/app/api/agent-tools/[...path]/route.ts` |
| MCP transport (both pipelines) | `apps/operator/app/api/[transport]/route.ts` |
| Dispatcher (role + quota + record) | `packages/agent-mcp/src/dispatch-projected.ts` |
| HTTP request → context builder | `packages/agent-mcp/src/http-projection.ts` |
| Spawn-mcp `.mcp.json` writer | `libs/papercusp/packages/orchestrator/src/spawn-mcp.ts` |
| Per-spawn URL → ctx parser | `packages/agent-mcp/src/spawn-context.ts` |
| Plugin host runtime + lifecycle | `apps/operator/lib/plugin-host-runtime.ts` |
| Shared subprocess + secret impls | `apps/operator/lib/plugin-spawn-impl.ts` |
| Telemetry + quota schema | `libs/papercusp/libs/db/sql/046-tool-invocations.sql` |

---

## When to stop and ask

- The component you're migrating fits none of the four shipped shapes (subprocess single-tool, HTTP+optional-secret, subprocess multi-tool, HTTP+required-secret-with-schema). Don't invent a fifth shape — talk first.
- The handler signature you'd want isn't `(input, ctx) => ToolResult`. The framework can't accommodate exotic shapes (long-poll, callbacks, multi-response).
- You're tempted to extend the manifest contract. Five fields drive five behaviors; adding a sixth is an architecture decision, not a cleanup.
- You hit one of the three known open issues and need to work around it. **Surface it; the workaround usually masks a real bug.**

---

## Last thing — per-turn commit discipline

Per `feedback_per_turn_commit.md`: every turn ends with a commit + push, including WIP. The framework code spans the operator app and the `libs/papercusp/` submodule. If you touch both, **commit the submodule first, then bump the parent's submodule pointer in a second commit**. Otherwise the parent commit references a SHA that isn't pushed and the next agent sees a broken checkout.
