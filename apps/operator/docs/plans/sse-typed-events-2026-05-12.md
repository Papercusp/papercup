# SSE library adoption + endpoint-system typed event channel

**Status:** approved 2026-05-12. Implementation in branch `sse-typed-events`.

Consolidates every decision and correction from the brainstorming conversation. Phases 1-3 are the implementation scope; Phase 4+ is the roadmap for follow-on work that benefits from the new framework.

---

## Goals

1. Normalize all SSE wire-format production in the `@papercusp/web` operator (`:3055`/`:3070`) onto `@restart/sse`.
2. Normalize all SSE consumption (`parseSseStream`) so multi-line `data:` round-trips spec-compliantly.
3. Extend the endpoint system with `ctx.emit<TEvents>(name, data)` so streaming tools can emit typed named events. `ctx.progress` becomes an alias for `ctx.emit('progress', …)`.
4. Migrate all six LLM-streaming routes onto the new framework: `architect.chat`, `brainstorm.chat`, `operator-chat`, `operator-converse`, `operator-scan`, `delegate-chat`.
5. Document the new typed-events surface; narrow the existing "LLM streams are excluded" carve-out in `function-as-truth.mdx` so the framework's stated scope matches reality.

## Non-goals (deferred — see Phase 4+)

- Plugin tool events from JSON manifests (built-ins only for Phase 3).
- Replay / `Last-Event-ID` on tool streams.
- Multipart / file uploads.
- Bidirectional streams (voice WSS, agent ↔ user mid-stream — explicitly still excluded).
- Schema-driven card rendering (the cards system stays in its current ad-hoc form; Phase 4 item).
- New top-level URL namespace for built-ins (`/api/built/[...]` — Phase 5 item once we have ≥3 built-in non-MCP tools justifying it).

---

## Locked-in architectural decisions

### D1. Terminal event name is `done`, not `result`

Framework auto-emits `event: done\ndata: <ToolResult content as JSON>` when the handler returns. `event: result` is dropped entirely from the wire format. MCP `tools/call` response shape is unchanged (returns the `ToolResult` as the JSON-RPC result, as the spec requires).

Rationale: every existing consumer in the codebase (`VoiceAppBridge.tsx`, `SupportAgentPanel.tsx`, `ProvisionStream.tsx`, `BranchActionRunner.tsx`) listens for `done`. `useHarnessChatRuntime.ts` ignores both — closes on stream-end — so it's compatible either way. `done` is the only name that doesn't break anyone.

### D2. Reserved event names

```ts
type ReservedEventNames = 'done' | 'progress' | 'heartbeat' | 'result';
```

`result` is kept reserved even though the framework doesn't emit it, to prevent name collision with pre-2026-05-12 code paths if anything's left behind. Compile-time guard:

```ts
type UserEvents<T> = T & { [K in ReservedEventNames]?: never };
```

### D3. `error` is dual-mode

- Framework auto-emits `event: error\ndata: { message }` + closes the stream on uncaught handler throw.
- Handler may also `ctx.emit('error', …)` for non-fatal mid-stream errors (`runAgentChat` yields a non-fatal `error` event that doesn't end the stream — this is the canonical case).

The wire shape is identical for both paths; this is documented explicitly in the framework reference.

### D4. MCP projection — `notifications/papercusp/event`

```jsonc
// JSON-RPC over the agent's MCP SSE session
{
  "method": "notifications/papercusp/event",
  "params": {
    "progressToken": "<token from _meta>",
    "event": "delta",
    "data": { "text": "…" }
  }
}
```

When `name === 'progress'`, the framework **also** fires `notifications/progress` (spec-compliance — MCP-aware UIs use this for built-in progress bars).

Non-Papercusp MCP clients ignore unknown notification methods, so this is forward-compatible.

### D5. HTTP projection — one wire event per `ctx.emit` call

All frames produced by `@restart/sse`'s `encodeFrame`. No hand-rolled byte assembly anywhere in the operator.

### D6. In-process projection — `fnStream` through dispatcher

`tool.fnStream(input, ctx): AsyncIterable<StreamEvent>` exists alongside `tool.fn`. **It runs through `dispatchProjectedTool`** — role check, quota, telemetry all apply. `tool.fn` direct call is the escape hatch for callers who explicitly want to bypass gating (documented as a footgun).

This makes `fnStream` load-bearing for Pilot 2 (operator-scan): the route uses it to keep its pre/post side-effects while pushing the streaming-chat core into a tool.

### D7. Event schemas — Zod, type-only

`events?: Record<string, ZodTypeAny>` on the tool definition input. Stored on the registry. Surfaced in `tools/list` via `z.toJSONSchema()` (Zod 4 built-in — NOT `zod-to-json-schema@3`, which returns empty schemas on Zod 4).

No runtime validation of outgoing events — they're produced by trusted code; runtime checking is overkill.

### D8. Three context types — Phase 3 touches two

| Type | Location | Phase 3 changes |
|---|---|---|
| `UnifiedToolContext` | `packages/agent-mcp/src/tool-projection.ts:50` | **adds `emit`** |
| `@papercusp/plugin-sdk` `ToolContext` | `packages/plugin-sdk/src/index.ts:1020` | **adds `emit`** for parity |
| `@papercusp/agent-mcp/types.ts` `ToolContext` | `packages/agent-mcp/src/types.ts:27` | **untouched** — legacy principal-gated, no streaming use case in scope |

### D9. URL stability for the pilot

Pilot tools live at the framework default URL: `/api/agent-tools/<name-with-slashes>`. A Hono shim per migrated route preserves the legacy URL via in-process dispatch (`fnStream` through the projection registry).

Six total shims (one per migrated route, ~10 LoC each). Once we have ≥3 stable built-in chat tools, Phase 5 introduces an explicit `/api/built/[...path]` namespace and we can rip the shims.

### D10. `idleTimeoutSec` augments `timeoutSec`

```ts
defineTool({
  // …
  timeoutSec: 600,        // wall-clock hard cap
  idleTimeoutSec: 120,    // abort if no event emitted for this many seconds (0 disables)
});
```

The dispatcher wraps `ctx.emit` to update a last-emit timestamp; a watchdog timer fires `abort` if the gap exceeds `idleTimeoutSec`. Catches deadlocked-child-process cases that wall-clock can't.

### D11. Cards are an emergent pattern, not a framework primitive

The card system (`chat:ask_choice` + `renderToolCard` on the client) is documented as a worked example of `ctx.emit` in Phase 3's doc update. It uses two tools at different layers: the inner card-tool is a vanilla `defineTool`, the outer chat-tool emits `ctx.emit('tool_call', {name, input})` which the browser hooks. No framework changes are needed for cards to keep working post-Phase 3. Phase 4 may revisit this for schema-driven rendering.

---

## Phase 1 — Wire-format normalization

Standalone branch. ~1 day. Lands before Phase 3.

### P1.1 — `agent-mcp` depends on `@restart/sse`

`packages/agent-mcp/package.json`: add `"@restart/sse": "*"` to dependencies.

### P1.2 — `handleHttpToolRequestStreaming` writes into `SseSink`

`packages/agent-mcp/src/http-projection.ts:341-385`. Change signature from `(req, extras) => ReadableStream<string>` to `(req, extras, sink) => Promise<void>`. All wire bytes go through `@restart/sse`.

### P1.3 — Rewrite the projection's test suite to use a recording sink

`packages/agent-mcp/src/http-projection.test.ts:230-282`. Replace `parseSseEvents(await readAllSse(stream))` helpers with a `recordingSink()` factory.

### P1.4 — Migrate the two catch-all routes onto `sseResponse`

`apps/operator/app/api/agent-tools/[...path]/route.ts:158-180` and `apps/operator/app/api/plugins/[...path]/route.ts:156-178`. Both collapse to:

```ts
if (wantsStream) {
  return sseResponse({
    signal: req.signal,
    setup: (sink) => handleHttpToolRequestStreaming(transportReq, HOST_EXTRAS, sink),
  });
}
```

### P1.5 — Migrate `test-buttons/echo`

`apps/operator/app/api/test-buttons/echo/route.ts:15-34`. Replace hand-rolled stream with `sseResponse({ … sink.eventRaw('line', …) … sink.close() })`. Keeps wire shape identical (the consumer ignores event name; receives `data:` lines).

---

## Phase 2 — SSE consumer migration

Same branch as Phase 1. ~half day.

### P2.1 — `branch-actions.ts` uses `parseSseStream`

`apps/operator/lib/branch-actions.ts:528-548`. Replace hand-rolled `\n\n` / `data:` splitter:

```ts
for await (const ev of parseSseStream(res.body)) {
  if (ev.event === 'heartbeat') continue;
  await logFh.write(ev.data + '\n');
}
```

Multi-line `data:` payloads now round-trip correctly. No behavior change in practice (existing producers emit single-line data).

### P2.2 — `delegation.ts` uses `parseSseStream`

`apps/operator/lib/commands/defs/delegation.ts:178+320`. Swap the bespoke `parseEventBlock` + manual reader loop for `parseSseStream`. Delete the local `parseEventBlock`. Preserve the 10s race-with-deadline state machine — only the parser swaps.

### P2.3 — Skip the `libs/papercusp` mirror

It's not a workspace member and not running; the mirror's hand-rolled streams stay until they're touched for another reason. Per the "NO TS deletion in rust port" rule.

---

## Phase 3 — Typed event channel

Separate branch off Phase 1+2. ~1-2 weeks. 17 commits.

### Framework extension (commits 1-10)

**Commit 1 — SDK types (`packages/plugin-sdk/src/index.ts`)**

```ts
export type EmitCallback = (name: string, data: unknown) => void;

export interface ToolContext {
  // …existing fields…
  /** Emit a typed event. No-op when transport has no event channel attached. */
  emit: EmitCallback;
}
```

**Commit 2 — `UnifiedToolContext.emit`**

`packages/agent-mcp/src/tool-projection.ts:50-101`. Add `emit: EmitCallback`. Add doc comment noting `progress` is an alias.

**Commit 3 — `defineTool` events generic + reserved-name guard**

`packages/agent-mcp/src/types.ts` + `define-tool.ts`. Extend `RoleToolDefinitionInput` (and `ToolDefinitionInput` for symmetry, even though principal-gated tools don't yet stream):

```ts
export interface RoleToolDefinitionInput<TArgs extends ZodTypeAny = ZodTypeAny, TEvents extends EventsSchema = {}> {
  // …existing fields…
  events?: TEvents;
  idleTimeoutSec?: number;
}

type EventsSchema = Record<string, ZodTypeAny>;
type ReservedEventNames = 'done' | 'progress' | 'heartbeat' | 'result';
type UserEvents<T extends EventsSchema> = T & { [K in ReservedEventNames]?: never };
```

Plugin manifest declaring `events` fails loudly: runtime warning at registration, "plugin events declarations are not yet honored — Phase 4+ feature."

**Commit 4 — Dispatcher idle-timeout enforcement**

`packages/agent-mcp/src/dispatch-projected.ts`. Wrap `ctx.emit` with a last-emit-timestamp recorder. Add a watchdog timer that calls `abort.abort()` when `Date.now() - lastEmit > idleTimeoutSec * 1000`. Reset on every emit. Disabled when `idleTimeoutSec === 0` or undefined.

**Commit 5 — HTTP transport adapter: emit→sink, auto-done, auto-error**

`packages/agent-mcp/src/http-projection.ts`. Extend `handleHttpToolRequestStreaming` so:

- `ctx.emit = (n, d) => sink.event(n, d)`
- `ctx.progress` is auto-built on top of `emit`
- Handler return → `sink.event('done', result.content)` + `sink.close()`
- Handler throw → `sink.event('error', { message })` + `sink.close()` (also: `@restart/sse`'s `setup` rejection already auto-handles this; the explicit emit is for the dispatcher's error envelope shape)

**Commit 6 — MCP transport adapter: `notifications/papercusp/event`**

`apps/operator/app/api/[transport]/route.ts:394-420`. Build `emit` from `progressToken + sendNotification`. Send `notifications/papercusp/event` always; also send `notifications/progress` when `name === 'progress'`. Build `progress` as an alias.

**Commit 7 — `tools/list` discoverability via `z.toJSONSchema`**

`packages/agent-mcp/src/tool-projection.ts:320-339`. `McpToolListing` gains an `events?: Record<string, Record<string, unknown>>` field. `listMcpProjections` serializes each event schema via `z.toJSONSchema(zodSchema)` at list time (cached after first call). Tools without events return no events field — back-compat.

**Commit 8 — Strict-streamable opt-in for HTTP**

`apps/operator/app/api/{agent-tools,plugins}/[...path]/route.ts`. When `Accept: text/event-stream` is set but the resolved tool has no `events` declared AND `expose.mcp.streaming !== true`, return `406 Not Acceptable`. Prevents clients from opening SSE against non-streamable tools and waiting forever.

**Commit 9 — In-process `fnStream` through dispatcher**

`packages/agent-mcp/src/tool-projection.ts`. Add `fnStream(input, ctx): AsyncIterable<StreamEvent>` to `ProjectedTool`. Implementation builds a queue, constructs a synthetic `emit` that pushes to the queue, runs `dispatchProjectedTool(tool, …, ctx)` (FULL dispatcher — role check + quota + telemetry), yields events as they arrive. Terminates with `{kind: 'done', result}` or `{kind: 'error', error}`. ~80 LoC.

```ts
type StreamEvent =
  | { kind: 'event'; name: string; data: unknown }
  | { kind: 'done'; result: ToolResult }
  | { kind: 'error'; error: { code: string; message: string } };
```

**Commit 10 — Docs**

`apps/operator/content/docs/endpoint-system/`:

- `function-as-truth.mdx`: narrow the "LLM streams excluded" carve-out:
  > Still excluded: bidirectional streams (voice WSS, agent ↔ user back-and-forth in one connection). The `(input, ctx) → ToolResult` shape — input once, stream events, then a single result — does fit LLM streaming, because the model produces a terminal turn. Anything that needs the server to ask the client questions mid-stream stays out.
- `transports.mdx`: add the typed-events section with three-transport projection table.
- `writing-a-tool.mdx`: update the "Don't write tools for these" list (drop LLM streams).
- New: `transports.mdx` § "Cards (render-into-chat tools)" — the worked example paragraph from earlier in this conversation.
- New: `transports.mdx` § "The three context types" — explicit table mapping each ToolContext type to its handler family and which Phase 3 touches.
- Reference: `notifications/papercusp/event` as the Papercusp MCP extension; spec-compliance via dual-fire on `progress`.

### Pilots (commits 11-12)

**Commit 11 — Pilot 1: `architect.chat`**

New file `apps/operator/lib/agent-tools/architect/chat.ts`. Default URL: `/api/agent-tools/architect/chat`. Hono shim at `apps/operator/app/api/_hono/harness.ts` replaces the deleted 5670-5790 block and forwards `/:slug/architect/chat` to the tool via `fnStream`.

**Commit 12 — Pilot 2: `operator.scan`**

New file `apps/operator/lib/agent-tools/operator/scan.ts`. The **tool fn is the streaming-chat-and-parser core only** (~80 LoC). Route `apps/operator/app/api/agent-mcp/operator-scan/route.ts` shrinks (~380 → ~150 LoC). Keeps: rate limit, scan lock, budget, idle-cache short-circuit, scan tracker (PG), session resume, dismissed cache, plugin suggestion gather. Dispatches into the tool via `tool.fnStream` inside an `sseResponse` setup.

### Fold-ins (commits 13-16)

Each in its own commit. Same pattern: extract the streaming-chat-and-parser core into a tool, keep the route thin (or delete it for the architect/brainstorm cases that have no side-effect surface).

- **Commit 13** — `brainstorm.chat` (Hono route in `harness.ts:6003-6030`). Near-clone of architect.chat. Route deletes; Hono shim replaces it.
- **Commit 14** — `operator.chat` (`app/api/agent-mcp/operator-chat/route.ts`). Has session tracking + audit append. Route shrinks ~210 → ~80 LoC.
- **Commit 15** — `operator.converse` (`app/api/agent-mcp/operator-converse/route.ts`). Similar shape to operator-chat. Route shrinks ~490 → ~150 LoC.
- **Commit 16** — `delegate.chat` (`app/api/agent-mcp/delegate-chat/route.ts`). Has delegate-session row creation + auto-archive idle. Route shrinks ~240 → ~80 LoC.

### Tests (commit 17)

- **Unit** — recording-sink tests for each of the 6 tools (assert event order, payload shapes, terminal `done`).
- **Integration** — `curl -N` against each of the 6 URLs; assert wire output (heartbeats stripped) matches pre-migration capture at the event-name + payload-shape level (not byte-exact, since LLM streams aren't deterministic).
- **MCP** — register a **synthetic test tool** (`test.echo_stream`) that emits `delta` + `done`; spawn an MCP client; assert `notifications/papercusp/event` arrives with the right shape AND `notifications/progress` arrives when the test tool emits `progress`. **Not** end-to-end against the chat tools, per G1.
- **In-process** — `for await (const ev of tool.fnStream(input, ctx))` against `architect.chat` (mocked `runAgentChat`); assert dispatcher gating still applies (try a role-disallowed call, expect `kind: 'error'`).
- **Strict-streamable** — `Accept: text/event-stream` against a non-streamable tool returns 406.
- **Idle timeout** — register a synthetic tool that emits once then sleeps 150s; with `idleTimeoutSec: 1`, assert abort fires after ~1s.

---

## Phase 4+ — Roadmap (out of scope for this implementation)

### P4.1 — Plugin events from JSON manifests
JSON-Schema `events` field on plugin `papercusp.json`, mirroring how `inputSchema` works today.

### P4.2 — Cards as schema-driven generative UI
Framework exposes inner card-tool's args schema (via `tools/list`'s `inputSchema`) to the client. `renderToolCard` becomes a `(t, schema) => ReactNode` registry keyed by tool name OR by a `category: 'card'` discriminant on the manifest. Migration targets: `chat:ask_choice`, plus future `chat:ask_textbox`, `chat:show_diff`, `chat:show_progress`.

### P4.3 — `/api/built/[...path]` namespace
Once we have ≥3 stable chat tools, introduce the explicit built-in-chat namespace and rip the six Hono shims from Phase 3.

### P4.4 — Replay / `Last-Event-ID` for chat resume
`sseResponse` already supports it. For chat tools, this would let a refresh resume mid-turn instead of losing the stream. Requires the dispatcher to persist emitted events to a per-call ring buffer.

### P4.5 — Tool-output-as-resource for large outputs
Phase 4 lets a streaming tool emit `event: chunk\ndata: {ref: 'papercusp://scratch/…', byteOffset: N}` for incremental large-output flow without inline.

### P4.6 — Voice modality projection
Letting tools declare `modality: ['text', 'voice']` and having the framework auto-narrate `progress` / `done` events for voice surfaces.

### P4.7 — Bidirectional client→server during a stream
Framework support for `ctx.awaitResponse('clientKey')` so a tool can pause mid-stream for a client response. The carve-out we're explicitly NOT collapsing in Phase 3.

### P4.8 — Third-party MCP-client discoverability
Surface `notifications/papercusp/event` as an MCP capability declared in the server's `initialize` response.

---

## Decisions locked in vs. originally open

| Originally open | Decision | Source |
|---|---|---|
| `done` vs `result` terminal | `done` | reviewer Issue 2; verified against consumers |
| Reserved event names | `done`, `progress`, `heartbeat`, `result`; `error` is dual-mode | reviewer Issue 3 + conversation |
| Plugin events scope | Built-ins only for Phase 3 | reviewer Issue 4 |
| tools/list discoverability | Add `events` field via `z.toJSONSchema` | reviewer Issue 5 |
| Pilot count | Two: architect/chat + operator-scan | reviewer Q3 |
| Migrate 6 routes? | Yes, all in Phase 3 | reviewer Q4 |
| Idle timeout | `idleTimeoutSec: 120` default | reviewer Q6 |
| `fnStream` dispatcher routing | Through dispatcher | reviewer nit |
| `defineTool` URL override | No — default URL + Hono shim | audit M1 |
| Zod serialization | `z.toJSONSchema` not `zod-to-json-schema` | audit M2 |
| Which ToolContext gets `emit` | `UnifiedToolContext` + plugin-sdk ToolContext; legacy untouched | audit M3 |
| Cards in Phase 3? | Documented as worked example only; framework unchanged | conversation |
| MCP test against chat tool? | No — synthetic test tool only | audit G1 |
| MCP namespace | `notifications/papercusp/event` (slashed) | reviewer Q1 |
| Phase 1+2 first vs combined | Separate branch, Phase 3 branches off it | original recommendation |
