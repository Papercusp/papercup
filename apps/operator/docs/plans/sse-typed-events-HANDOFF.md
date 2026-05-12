# SSE typed-events / endpoint-system / IPC work — handoff & ownership

**Status:** in-flight on branches; not merged to main. Branches:
- `papercupai/papercup#sse-typed-events` (43 commits ahead of main)
- `papercupai/papercusp-desktop#sse-typed-events-ipc` (4 commits ahead of main)

This doc is for another agent picking up adjacent code. Read it first
to avoid stepping on the work below.

---

## Plan (what the branches are building)

Three layers, in dependency order:

### Layer 1 — Wire-format normalization (✅ shipped)
Move every hand-rolled SSE producer/consumer in the operator
(`:3055`/`:3070`) onto `@restart/sse`. Concrete consequences:
- `handleHttpToolRequestStreaming` writes to an `SseSink` instead of
  building byte strings.
- Catch-all routes use `sseResponse({signal, setup})`.
- `branch-actions.ts` + `delegation.ts` use `parseSseStream` for
  multi-line-`data:` correctness.

### Layer 2 — Endpoint-system typed event channel (✅ shipped)
Extend `defineTool` so streaming tools declare an `events: {...}`
schema and emit typed events via `ctx.emit(name, data)`.
`ctx.progress(pct, msg)` becomes an alias for
`ctx.emit('progress', ...)`. Three transports project the same
ctx.emit call:
- **HTTP/SSE** → `event: name\ndata: ...` via `@restart/sse`.
- **MCP** → `notifications/papercusp/event` JSON-RPC notification.
- **In-process** → `dispatchProjectedToolStream(...)` async iterator.

Schema-inferred wire format per event:
- `z.string()` → raw text (no JSON wrapping; multi-line `data:` per spec)
- `z.instanceof(Uint8Array)` → self-describing base64 envelope shape
  shared across HTTP + MCP (`{$papercuspBinary, encoding, data}`);
  raw `EVENT_BIN` frame on IPC
- everything else → JSON-stringified

Migrations done:
- **6 streaming routes** migrated to `dispatchProjectedToolStream` +
  shared `emitToSseSink` helper: architect.chat, brainstorm.chat,
  operator-scan, operator-converse, delegate-chat.
- **operator-chat** was discovered to have zero callers and was
  deleted (not migrated). Carry-on cleanup: deleted dead modules
  `lib/claude-sessions.ts` + `lib/claude-session-summary.ts`.

### Layer 3 — Desktop-native transport (IPC) (✅ shipped)
Webview→Tauri→Node fast path that bypasses localhost HTTP for tool
dispatch on desktop. Same `defineTool` projects to:
- Unix-domain socket (Linux/macOS) or named pipe (Windows).
- Binary frame protocol per `apps/operator/lib/endpoint-ipc/PROTOCOL.md`.
- Per-call multiplexing via monotonic `u64` ids.
- Cold-start handshake via `PAPERCUSP_IPC_READY socket=<path>` line
  on Node sidecar stdout.

Opt-in via:
- `PAPERCUSP_DESKTOP_IPC=1` (set by desktop, propagates to operator's
  `PAPERCUSP_IPC_ENABLE=1`).
- Per-tool allowlist (currently `['dev:ipc_echo']` only — see why
  under "What's NOT yet wired").

Verification: `/dev` page has an "IPC" tab that runs `dev:ipc_echo`
through `dispatchEndpointStream` (auto-picks transport).

---

## File ownership — DO NOT TOUCH if you're working in this area

These files are core to the in-flight work. Editing them risks merge
conflicts and re-introducing audit-caught bugs.

### papercup repo

**Framework — agent-mcp package**:
- `packages/agent-mcp/src/tool-projection.ts` (registry, emitToSseSink,
  PapercuspBinaryEnvelope, EventWireKind classifier)
- `packages/agent-mcp/src/dispatch-projected.ts` (dispatcher, idle/wall
  timer wraps, ctx.emit/progress override chain, ok-on-abort race fix)
- `packages/agent-mcp/src/http-projection.ts` (auto-done, auto-error,
  wire-kind dispatch via emitToSseSink)
- `packages/agent-mcp/src/define-tool.ts` (events generic, reserved-name
  guard, idleTimeoutSec plumbing, replaceAll(':', '/') in URL derivation)
- `packages/agent-mcp/src/types.ts` (RoleToolDefinitionInput events
  generic + UserEvents guard)
- `packages/agent-mcp/src/index.ts` (exports — keep adding new exports
  here; don't break existing)
- `packages/plugin-sdk/src/index.ts` (ToolContext.emit field)

**Operator — transport infrastructure**:
- `apps/operator/lib/projected-tool-deps.ts` (shared
  recordInvocation + readQuotaState used by both HTTP and IPC)
- `apps/operator/lib/transport-adapters/` (entire dir — HTTP/IPC
  consumer adapters + transport picker)
- `apps/operator/lib/endpoint-ipc/` (entire dir — Node IPC server,
  framing, PROTOCOL.md)
- `apps/operator/app/api/[transport]/route.ts` (MCP transport; emit
  closure with binary base64 envelope, dual-fire progress notification)
- `apps/operator/app/api/agent-tools/[...path]/route.ts` (catch-all
  with strict-streamable 406 path)
- `apps/operator/app/api/plugins/[...path]/route.ts` (same pattern)
- `apps/operator/instrumentation-node.ts` (`maybeStartEndpointIpcServer`
  hook; passes PROJECTED_DEPS)

**Operator — migrated routes (preserve dispatch loop shape)**:
- `apps/operator/app/api/_hono/harness.ts` — architect/brainstorm Hono
  shims at the `:slug/architect/chat` and `:slug/brainstorm/chat`
  routes. Each uses `dispatchProjectedToolStream` + `emitToSseSink` +
  the documented error/done forwarding.
- `apps/operator/app/api/agent-mcp/operator-scan/route.ts`
- `apps/operator/app/api/agent-mcp/operator-converse/route.ts`
- `apps/operator/app/api/agent-mcp/delegate-chat/route.ts`

**Operator — projected tool modules**:
- `apps/operator/lib/agent-tools/architect/chat.ts` (architect + brainstorm)
- `apps/operator/lib/agent-tools/operator/scan.ts`
- `apps/operator/lib/agent-tools/operator/converse.ts`
- `apps/operator/lib/agent-tools/operator/delegate.ts`
- `apps/operator/lib/agent-tools/dev/ipc_echo.ts` (IPC liveness probe)

**Documentation**:
- `apps/operator/content/docs/endpoint-system/transports.mdx`
- `apps/operator/content/docs/endpoint-system/function-as-truth.mdx`
- `apps/operator/content/docs/endpoint-system/writing-a-tool.mdx`
- `apps/operator/docs/plans/sse-typed-events-2026-05-12.md` (plan doc)
- `apps/operator/docs/plans/desktop-native-transport-2026-05-12.md` (plan doc)

**Tests for the above** (do not modify; add new tests in new files):
- `packages/agent-mcp/src/*.test.ts` (8 files, 115 tests)
- `apps/operator/lib/endpoint-ipc/*.test.ts`
- `apps/operator/lib/transport-adapters/transport-adapters.test.ts`
- `apps/operator/lib/agent-tools/__tests__/streaming-tools-migration.test.ts`
- `apps/operator/lib/agent-tools/__tests__/hono-shim-dispatch.test.ts`
- `apps/operator/lib/agent-tools/dev/__tests__/ipc_echo.test.ts`
- `apps/operator/app/api/[transport]/mcp-notifications.test.ts`
- `apps/operator/app/api/agent-tools/[...path]/route.test.ts`

### papercup-desktop repo

- `src-tauri/src/endpoint_ipc.rs` (IpcClient, Tauri commands,
  backpressure cap, decide_backpressure)
- `src-tauri/src/endpoint_ipc_framing.rs` (frame codec — byte-for-byte
  mirror of TS framing.ts)
- `src-tauri/src/main.rs` lines around `spawn_sidecar` (piped-stdout
  forwarder thread, `PAPERCUSP_IPC_READY` parsing, `IpcClient::connect`
  init in setup). `SidecarState.endpoint_ipc_socket` field.
- `src-tauri/Cargo.toml` (`tokio`, `dashmap`, `bytes`, `thiserror`,
  `specta` features pinned for the IPC types)

---

## File areas where collaboration is SAFE

Other tooling around the operator that the IPC work doesn't touch:

- `apps/operator/lib/agent-tools/operator/` — non-streaming operator
  tools (stats, scans_list, paused, etc.). Safe to add new tools.
- `apps/operator/lib/agent-tools/dev/` — dev-panel tools (build_status,
  pg_health, etc.). Safe to add new tools. Only `dev/ipc_echo.ts` is
  IPC-specific.
- `apps/operator/lib/agent-tools/harness/`, `projects/`, `experts/`,
  `cross_harness/`, `delegates/`, `plugins/`, `roles/`, `agent_chats/`,
  `notes/`, `intel/`, `processes/` — all unrelated to streaming. Free
  to modify.
- Any non-streaming projected tool (the 80+ tools that use
  `defineTool` without an `events` field). They go through the
  framework unchanged.

---

## What's NOT yet implemented (intentional gaps)

If your work overlaps any of these, coordinate with me first.

### 1. `transport` column on `harness_shared.tool_invocations` ✅ DONE

Shipped via the submodule branch
`papercupai/papercusp#sse-typed-events-transport-column` (file
`libs/db/sql/058-tool-invocations-transport.sql`) plus the
plumbing on this branch in `UnifiedToolContext.transport` and
`PROJECTED_DEPS.recordInvocation`.

Values: `'http' | 'mcp' | 'ipc' | 'in_process' | null`. Older rows
have null. The submodule pointer is bumped on this branch.

`/dev → Sessions` and `/dev → Telemetry` can now filter by transport.
If you're adding a filter UI: the column is `transport text` on
`harness_shared.tool_invocations`. Write SQL like
`WHERE transport = $1 OR ($1 = 'unknown' AND transport IS NULL)`
to keep older rows reachable.

### 2. End-to-end live IPC verification
The whole stack is unit-tested but **no one has actually rebuilt the
desktop with `PAPERCUSP_DESKTOP_IPC=1` and run the `/dev → IPC` tab
yet**. If you touch desktop sidecar lifecycle, the build, or the
PAPERCUSP_IPC_ENABLE env plumbing, this verification becomes more
urgent.

### 3. Migrating real routes to the IPC fast-path
`operator:scan`, `operator:converse`, `operator:delegate`,
`architect:chat`, `brainstorm:chat` are **not on the IPC allowlist**.
Each has route-level side effects (rate limit, scan lock, budget,
idle-cache short-circuit, scan tracker, plugin merge, session resume,
PG audit append) that the IPC fast-path bypasses today because IPC
dispatches the tool directly without the Hono route's pre/post code.

Migrating any of these to IPC requires moving the side effects INTO
the tool handler. That's a per-tool refactor and a different
project. If you're working on those routes, do NOT add them to the
allowlist in `apps/operator/instrumentation-node.ts`.

### 4. Schema-driven render-into-chat cards (P4 in plan)
The plan acknowledges `chat:ask_choice` and similar UI-tool patterns
but doesn't ship schema-driven rendering. If you're building new
chat cards, follow the existing ad-hoc pattern in `OperatorChat.tsx`
+ the `chat:ask_choice` tool. Don't try to "unify" until P4 lands.

### 5. Plugin-declared events (P4 in plan)
Plugin `papercusp.json` manifests can't declare an `events: {...}`
field today — only built-in tools (TS-defined via `defineTool`) can
declare typed events. Plugins emit events but they're untyped at the
manifest level. The plan calls this P4. If you're working on the
plugin loader, leave the events-from-manifest path alone.

### 6. WebSocket transport
**Considered, rejected for now.** The plan doc has a long IPC-options
landscape; we picked Unix-domain-sockets / named-pipes via Tokio for
desktop. WebSocket was evaluated and shelved — see
`apps/operator/docs/plans/desktop-native-transport-2026-05-12.md` §
"IPC options landscape" for the comparison. If you have a new use
case for WS (browser-side binary streaming?), update the plan doc
before adding code.

### 7. Replay / Last-Event-ID for chat resume
Not implemented. Tool streams are non-resumable today. If you're
adding chat-resume UX, design it around the existing per-call
dispatch model — don't bolt replay onto the SSE wire.

---

## Architectural decisions you should not silently revert

These are the "locked in" decisions from the original brainstorm +
7 audit rounds. Each was contested and resolved; if your work would
unwind one of them, raise it explicitly.

| Decision | Where it lives | Why |
|---|---|---|
| Terminal event name is `done`, not `result` | Framework auto-done + Hono shims | Every existing consumer listens for `done`; `result` was a holdover |
| Reserved event names: `done`, `progress`, `heartbeat`, `result` | `UserEvents<T>` type-level guard | Prevents collisions; compile-time enforced |
| `error` is dual-mode (handler-emit AND auto-emit) | http-projection auto-error path | runAgentChat yields non-fatal errors mid-stream; handler also throws fatal |
| Wire kind inferred from Zod schema, not declared | `classifyEventWire` in tool-projection | Single source of truth; `z.string()`/`z.object()`/`z.instanceof(Uint8Array)` map to wire shapes |
| Binary uses self-describing envelope (HTTP + MCP); raw EVENT_BIN frame on IPC | `PapercuspBinaryEnvelope` + IPC framing | Consumers normalize uniformly; envelope is the canonical decode shape |
| IPC webview-as-in-boundary; signature verification skipped | `apps/operator/lib/endpoint-ipc/server.ts` + transports.mdx § Trust model | Same UID, same process tree; signed-URL threat doesn't apply |
| `ctx.progress` is an alias of `ctx.emit('progress', ...)` rebound by dispatcher | `dispatch-projected.ts:wrappedProgress` | Progress emits also refresh idleTimeoutSec deadline |
| IPC allowlist starts empty (only dev:ipc_echo) | `instrumentation-node.ts` | Migrating a tool to IPC requires moving its side effects into the handler — explicit per-tool decision |

---

## How to know if you're stepping on this work

Quick check before editing any file:

1. Look at this doc's file-ownership lists above. If the file is there, coordinate with me.
2. Look at the file's git blame — if recent commits have messages starting with `endpoint-ipc:`, `deferred-PR`, `audit pass`, or `architect/brainstorm`/`operator:scan`/`operator:converse`/`operator:delegate` migration, you're in the IPC/typed-events surface.
3. Search the file for: `emitToSseSink`, `dispatchProjectedToolStream`, `eventWireKinds`, `PROJECTED_DEPS`, `PapercuspBinaryEnvelope`, `endpoint_invoke`, `endpoint_cancel`, `PAPERCUSP_IPC_*`. Any hit means coordinate.

If you need to change framework behavior, **read the plan doc first**:
`apps/operator/docs/plans/sse-typed-events-2026-05-12.md`. It captures
the locked-in decisions and why.

---

## Test pass rates (so you can verify your changes don't regress mine)

- `@papercusp/agent-mcp`: **115/115**
- `@restart/sse`: **148/148**
- Operator IPC + transport adapters + streaming tools + dev tools +
  MCP notifications + agent-tools route: **88+ across 9 test files**
- Rust `papercusp-desktop` IPC: **22/22**

Pre-existing failure that's NOT mine:
`apps/operator/lib/agent-tools/projects/__tests__/projects.test.ts >
projects:list > throws when no slug available` — fails on main too.

---

## Open follow-ups (clearly scoped, not blocking)

If you want to pick something up:

1. **End-to-end live IPC verification** (gap #2) — rebuild
   `papercusp-desktop` with `PAPERCUSP_DESKTOP_IPC=1`, run the
   `/dev → IPC` tab. No code change, just verification. Update this
   doc with results.
2. **Migrate operator-scan side effects into the tool handler** so
   it's IPC-allowlist-eligible (gap #3). Substantial refactor; per-tool.
3. **/dev UI filter by `transport`** — the column exists now; the
   sessions/telemetry tabs don't yet surface a filter.

---

## Contact / coordination

This doc is the source of truth for what's claimed by the SSE/IPC
work. If you find something here that's wrong (e.g. a file marked
"don't touch" that no longer needs protection, or a decision that
should be revisited), update this doc in the same PR that changes
the underlying code. Keep this doc and the implementation in sync.
