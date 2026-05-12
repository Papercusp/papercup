# Rebase note for `sse-typed-events` branch — schema flattener forward-port

**For the agent on `papercupai/papercup#sse-typed-events`.** When you
rebase onto current `main` you will conflict on
`packages/agent-mcp/src/define-tool.ts`. Resolution is mechanical;
this note exists so you don't have to reconstruct intent from the
conflict markers.

## What's on main (not yet on your branch)

Commit `02dde625` — "agent-mcp: flatten JSON schemas for OpenAI
strict-mode tool calling".

OpenAI Codex strict mode rejects any function `parameters` schema
that has `oneOf`/`anyOf`/`allOf`/`not` at the root, or is missing
`type: "object"` at the root. Zod's `discriminatedUnion` (and
`z.union`) produces exactly that shape — `{anyOf: [...]}` or
`{oneOf: [...]}` with no `type` key. Result: every tool whose args
schema uses a discriminated union has its definition rejected at
tool-list time, and the whole turn produces zero output.

Fix on main: `flattenForOpenAi(schema)` helper in `define-tool.ts`
that merges variant `properties` into a single object schema with
discriminator-only `required` set, then wraps every legacy and
projected tool's `inputSchema` through it.

## Conflict shape

Your branch's `registerLegacyAsProjected` has:

```ts
const inputSchema = (z as any).toJSONSchema(def.args) as Record<string, unknown>;
delete (inputSchema as Record<string, unknown>).$schema;
```

Main has:

```ts
const rawSchema = (z as any).toJSONSchema(def.args) as Record<string, unknown>;
delete (rawSchema as Record<string, unknown>).$schema;
const inputSchema = flattenForOpenAi(rawSchema);
```

Same two-line conflict appears at the second projected-tool
registration site (around line 256 on your branch / 326 on main).

## Resolution

Pick "incoming" (main) for both `inputSchema` assignments AND keep
the `flattenForOpenAi` helper that lands above them. Your branch's
`events`/`idleTimeoutSec`/reserved-name guard code is untouched by
the conflict — it lives further down the file in the
`ToolDefinitionRegistry`/`UserEvents`/`registerProjectedTool` paths.

After resolving, run:

```
cd packages/agent-mcp && npx vitest run src/__tests__/define-tool.test.ts
```

12 tests cover the flattener; they should all pass.

## Why this matters for IPC

The IPC path bypasses HTTP/MCP transports but still surfaces the
same `inputSchema` to clients via `dispatchProjectedToolStream`'s
schema lookup. If a downstream consumer (e.g. a future agentic
client that talks OpenAI-strict) goes through IPC, the same flatten
must apply. Keeping the wrap inside `define-tool.ts` (rather than
the HTTP route) means IPC is covered automatically.
