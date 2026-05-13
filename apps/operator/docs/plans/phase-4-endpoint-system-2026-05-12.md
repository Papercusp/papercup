# Endpoint system — Phase 4+ implementation

**Status:** **draft v2 — reviewer feedback incorporated 2026-05-12** — Tier 1 ready for kickoff; Tier 2 ready pending the one empirical measurement (buffer sizes); Tier 3 gated on T3.1 spike outcome.

Sequences the eight Phase 4+ items previously deferred from the SSE typed-events plan, plus the IPC Specta-codegen follow-up. Items are revised against current code, not the version of the codebase the original plan assumed — three items are now substantially smaller than originally scoped because incremental infrastructure landed during Phase 3 implementation.

**Prereqs met:** Phase 3 (`dispatchProjectedToolStream`, schema-inferred wire kinds, MCP `notifications/papercusp/event`) shipped on main `6ab7c8f6`. Endpoint-IPC shipped (UDS framing, Node server, Rust client, transport adapters). Migration 058 applied (`transport` column on `tool_invocations`).

---

## Goals

1. Land the cheap Phase 4+ items that the Phase 3 work made trivial (1-line capability declaration, 2 Hono shim retirements, Specta wiring) before they bit-rot.
2. Build the schema-driven card registry that unblocks adding new in-chat tool UIs without touching every consumer.
3. Implement replay / `Last-Event-ID` for chat resume — the SSE library already supports it; the dispatcher just needs per-call buffering.
4. Implement tool-output-as-resource for tools that emit large outputs (200MB+) without inlining bytes in the SSE stream.
5. Project voice as a first-class modality at the framework level so tools declare `modality: ['text', 'voice']` instead of each rolling its own `<say>`-tag handling.

## Non-goals (deferred indefinitely)

- Plugin events from JSON manifests (P4.1) — Tier 3 if accepted, otherwise deferred.
- Bidirectional client→server during a stream (`ctx.awaitResponse`, P4.7) — explicit non-goal preserved from Phase 3.
- Shared-memory IPC (Ladder Level 3) — only justified by a real-time tool feature; none on roadmap.
- Cross-process replay buffers (PG-backed) — Tier 2's in-memory buffer is the contract.
- Signed-URL cross-workspace scratch sharing — revisit when org-sharing becomes a real feature.
- Mid-stream tool continuation through disconnect (the "(a)" model in T2.2 below) — deferred until a real driver demands long-lived disconnected tools.

---

## Audit findings (2026-05-12)

Three items had **substantial infrastructure built incrementally** during Phase 3 and need much smaller implementations than the original plan assumed:

| Item | Original assumption | Audit reality | Effort shift |
|---|---|---|---|
| **P4.4 Replay / `Last-Event-ID`** | New feature in `sseResponse` + per-call buffer | `@restart/sse` already implements it (`response.ts:75-91`: `lastEventId`, `replay()`, `setFloor()`). ID allocator live-verified emitting `id: 1, 2, 3`. | Just dispatcher buffering needed. ~3 days. |
| **P4.5 Tool-output-as-resource** | New `chunk` event type + URI scheme + storage | `outputRef` already in `ProjectedToolResult` (`dispatch-projected.ts:80`). `expose.mcp.largeOutput` exists. `tools/intel/artifacts.ts` exists. | Wire up existing fields. ~3 days. |
| **P4.3 `/api/built/[...path]` namespace** | Rip 6 Hono shims | Only 2 shims survived (architect+brainstorm). Others migrated to `/api/agent-mcp/*` independent routes. | ½ day. |

The other items are unchanged or larger:

| Item | Audit reality | Effort |
|---|---|---|
| **P4.8 MCP capability** | `initialize` response doesn't declare the Papercusp extension | 30 min |
| **Specta codegen (IPC FU)** | `tauri-specta` installed but `Builder` not wired in `main.rs` | ½ day |
| **P4.2 Cards as registry** | Hardcoded `if (t.name !== 'chat:ask_choice') return null` in 2 consumers (OperatorChat.tsx:77, OracleDock.tsx:1344) | 2 days |
| **P4.6 Voice modality** | `modality: 'voice' \| 'text'` exists in `operator:converse` prompt-side only; no framework abstraction | 2 weeks |
| **P4.1 Plugin events from manifests** | Manifest schema has no `events` field; plugin loader warns + drops; no JSON-Schema-to-Zod adapter | 1 week |
| **P4.7 Bidirectional `awaitResponse`** | Nothing exists | 3 weeks (deferred) |

---

## Tier 1 — Cleanup + capability advertisements (~1 week)

Low risk, low effort. Three independent items; can ship in any order.

### T1.1 — MCP `initialize` capability declaration (P4.8)

**File:** `apps/operator/app/api/[transport]/route.ts` (~line 629).

Add the Papercusp typed-events extension to the server's declared capabilities:

```ts
{ capabilities: {
    tools: {},
    resources: {},
    prompts: {},
    experimental: {
      'papercusp/typedEvents': { version: '1' },
    },
} }
```

**Test:** new test in `mcp-notifications.test.ts` asserts `initialize` response includes `experimental['papercusp/typedEvents']`.

**Risk:** zero. Pure declaration, no behavior change. Third-party MCP clients ignore unknown capabilities.

### T1.2 — Retire 2 Hono shims (P4.3 simplified)

**Pre-flight (verified for this revision):** `architect:chat` and `brainstorm:chat` tools both declare `harnessSlug: z.string()` (required, not optional) per `apps/operator/lib/agent-tools/architect/chat.ts:48-57`. Safe to switch consumers from URL-encoded slug to body field with no schema change.

**Atomicity:** the consumer (`useHarnessChatRuntime`) and the shim retirement must land in the same commit. A stale client posting to the legacy URL after the shim is removed would 404; a stale client posting the new URL without `harnessSlug` in the body before the round-12 migration would fail Zod validation. Both already shipped — the migration is consumer + server in one commit.

**Files:**
- `apps/operator/app/api/_hono/harness.ts` — remove the `harness.post('/:slug/architect/chat', ...)` and `harness.post('/:slug/brainstorm/chat', ...)` blocks (~150 LoC total)
- `libs/agent-chat/src/useHarnessChatRuntime.ts` — POST to `/api/agent-tools/architect/chat` (or `brainstorm/chat`); body gains `harnessSlug` field

**Audit:** before shipping, `git grep` confirms no other caller hardcodes `/:slug/architect/chat` or `/:slug/brainstorm/chat` outside `useHarnessChatRuntime`. Adding a `chat-surface-tools.mjs` drift test that asserts no source contains the legacy pattern.

**Test:** the existing `chat-surface-tools.mjs` drift test continues to pass (tools are still IPC-eligible self-contained). Add a smoke test that POSTs `/api/agent-tools/architect/chat` with a slug-bearing body and asserts the stream opens.

**Risk:** medium. Mitigations: pre-flight grep, atomic consumer+server commit, drift test on the legacy URL pattern.

### T1.3 — Wire Specta codegen for IPC

**Files:**
- `papercusp-desktop/src-tauri/src/main.rs` — instantiate `tauri_specta::Builder` for `endpoint_invoke` and `endpoint_cancel` commands; emit TypeScript at build to `apps/operator/lib/transport-adapters/ipc-types.generated.ts`
- `apps/operator/lib/transport-adapters/ipc-stream.ts` — replace hand-typed `RustEndpointEvent` interface (lines 21-26) with the generated type

**Test:** existing `transport-adapters.test.ts` continues to pass. Add a `npm run check-generated-ipc` script that errors if the committed `.generated.ts` drifts from a fresh codegen — runs in CI.

**Risk:** low. Wire format is fixed; the generated type is a refactor of the consumer side.

---

## Tier 2 — User-visible features (~2-3 weeks)

**Sequencing note:** T2.1, T2.2, and T2.3 are independent and ship in parallel. T2.1 is client-side; T2.2 and T2.3 are server-side. The original plan's claim that T2.1 derisks T2.3 was wrong — they share nothing.

### T2.1 — Schema-driven card registry (P4.2)

**Goal:** stop touching every chat consumer when a new card tool ships.

**File layout:**
```
apps/operator/lib/chat-cards/
  registry.ts         ~50 LoC — registerCard / renderCard / unregisterCard
  registry.test.ts    ~80 LoC — unit
  AskChoiceCard.tsx   move from existing inline definition
```

**API:**
```ts
export type CardRenderProps = {
  toolName: string;
  args: unknown;
  result?: unknown;
  onAnswer?: (id: string, label: string) => void;
};

export type CardRenderer = (props: CardRenderProps) => ReactNode | null;

export function registerCard(toolName: string, renderer: CardRenderer): void;
export function renderCard(props: CardRenderProps): ReactNode | null;
```

**Migration:**
- `chat:ask_choice` registers `AskChoiceCard` at module load via the same side-effect that registers the tool itself.
- `OperatorChat.tsx:75-77` and `OracleDock.tsx:1341-1344` import `renderCard` and pass it through as the `renderToolCard` prop.
- The hardcoded `if (t.name !== 'chat:ask_choice') return null` chains delete.

**Schema-driven extension (out of scope for T2.1):** the registry can later opt into auto-rendering from `tools/list`'s `inputSchema` for tools that declare `expose.chatCard: true`. The imperative `registerCard` API ships first; schema-driven is a follow-up.

**Test:** unit-test the registry; smoke-test that mounting `OperatorChat` with a synthetic `chat:test_card` tool renders the registered component (and falls through to default chip if unregistered).

**Risk:** low. Additive — `renderCard` returns null for unregistered tools, preserving the default-chip fallback.

### T2.2 — Replay / `Last-Event-ID` for chat resume (P4.4)

**Goal:** a refresh / network blip resumes a chat turn mid-stream instead of losing it.

#### Disconnect semantics — **picked (b): pre-disconnect buffer only**

When the client disconnects, the dispatcher aborts the in-flight tool (today's behavior). Replay serves only the events that were buffered **before** the disconnect. Reconnecting after a network blip does NOT continue a long-running tool that was killed.

This is sufficient for chat tools: the consumer's persisted conversation state on the server side regenerates the partial turn cleanly. The harder case (long-running delegate session that should survive a 5-second network blip) is the "(a)" model — keep the tool running, redirect emits to buffer, abort only on buffer expiry. (a) requires atomic buffer-vs-sink switchover, careful long-running-tool semantics, and a behavioral surprise (a tool that *was* cancelable now isn't). We defer (a) until a real driver demands it.

**Behavioral implication for users:** a tab idle past the 5-minute retention window will see a fresh turn on reconnect, not the in-progress one. Document this in the user-facing chat-resume docs.

#### `runId` provenance — **lock in: response header**

The server sets `X-Papercusp-Run-Id: <uuid>` on the SSE stream's HTTP response. The client retains it; on reconnect, the client sends both `Last-Event-ID: <last-seen-id>` AND `X-Papercusp-Run-Id: <same-uuid>` to reach the right buffer.

- Less wire-format overhead than emitting a synthetic event.
- Accessible to fetch consumers via the response's headers — no parsing of the first event needed.
- EventSource consumers access via the `readyState` event's response object (or via a paired fetch HEAD if needed).

#### Buffer size — **instrument first**

The original plan's "1000 events = 1 LLM turn worth" was a guess. operator:converse turns with many tool_call deltas could exceed it.

**Step 1 (before locking opt-in values):** add `event_count` column to `tool_invocations`. Dispatcher counts emits per call, records at completion. Run for one week.

**Step 2 (after data):** set per-tool `replayBufferSize` to `1.5 × p99 event_count` from the sample period.

**Until step 2 completes:** set all opt-in tools to `replayBufferSize: 5000` (generous soft cap) with `[replay-buffer] evicted N events from <toolName>/<runId>` warn log on eviction. The log lets us detect tools that overrun the cap in production.

#### `runId` generation — **lock in: `crypto.randomUUID()`**

Replace the current `${prefix}-${Date.now()}` pattern across all Hono shims. Date.now() collisions are rare but real. UUIDs are collision-proof and the `/dev/sessions` UI already handles arbitrary string `runId`s.

Add a regression test: two concurrent `architect:chat` calls with different `runId`s, both with buffers active. Assert that each consumer's replay returns only its own buffer's events, no cross-contamination.

#### Implementation files

- `packages/agent-mcp/src/types.ts` — add `replayBufferSize?: number` to `RoleToolDefinitionInput` (default `0` = disabled)
- `packages/agent-mcp/src/dispatch-projected.ts` — wrap `ctx.emit` to push into a per-call ring buffer when `replayBufferSize > 0`; expose `getReplayBuffer(callKey)` for transport adapters; eviction warn log
- `packages/agent-mcp/src/http-projection.ts` — read `Last-Event-ID` + `X-Papercusp-Run-Id` headers on stream open; on match, plumb `replay()` callback to `sseResponse`
- `apps/operator/app/api/agent-tools/[...path]/route.ts` — propagate both headers to the dispatcher; set `X-Papercusp-Run-Id` on response
- `libs/papercusp/libs/db/sql/065-tool-invocations-event-count.sql` — add `event_count` integer nullable column

#### Buffer key

`(workspaceId, toolName, runId)`. All three components verified to be globally unique enough that collision is implausible.

#### Buffer lifetime

In-memory keyed on `(workspaceId, toolName, runId)`. Lives 5 minutes after stream-end. Cleared on workspace switch (all buffers in the previous workspace go).

#### Opt-in per tool (initial, pre-instrumentation)

- `architect:chat`, `brainstorm:chat`, `operator:converse`, `operator:delegate`: `replayBufferSize: 5000`
- `operator:scan`: `replayBufferSize: 5000`
- `dev:ipc_echo`: `0` (not worth buffering)

Tuned down per-tool after one week of `event_count` data.

#### Tests

- Framework: synthetic streaming tool, abort stream mid-way, reconnect with LEI + runId, assert remainder + done.
- Concurrent-call collision: two simultaneous architect:chat invocations with different UUIDs, both reconnect-and-replay, assert no cross-contamination.
- Buffer eviction: emit 5001 events, assert the first one is evicted and warn log fires.
- Cross-workspace isolation: buffer in workspace A is unreachable from a reconnect attempt as workspace B's principal.

#### Risk

Medium. In-memory buffer dies with the operator process. Cross-process buffer (PG-backed) is a P5 follow-up if needed.

### T2.3 — Tool-output-as-resource (P4.5)

**Goal:** tools emitting 200MB+ outputs (CSV exports, repomix-style bundles, large screenshots) don't inline bytes in the SSE stream.

#### Scratch URI scheme

```
papercusp://scratch/<workspace>/<toolName>/<runId>/<basename>
```

Maps to: `~/.papercusp/scratch/<workspace>/<toolName>/<runId>/<basename>`

#### Path traversal validation — **mandatory at both write and read**

| Segment | Validation | Reject on |
|---|---|---|
| `<workspace>` | Must match a workspace in the registry (UUID or known-shape) | unknown workspace → 403 |
| `<toolName>` | Must contain a separator (`.` or `:`) per existing tool-name shape; charset `[A-Za-z0-9.:_-]` | mismatch → 400 |
| `<runId>` | Must be a UUIDv4 (8-4-4-4-12 hex pattern) | mismatch → 400 |
| `<basename>` | `/^[A-Za-z0-9._-]+$/` AND length 1-255 AND not `.` / `..` / starts-with-`.` / ends-with-`.` | mismatch → 400 |

`..`, absolute paths, `~`, embedded `/` or `\` all rejected by the basename regex. Resolver also calls `path.resolve` and asserts the result starts with the workspace scratch root.

#### Quota — **lock in: 5GB per workspace, FIFO eviction**

When a write would push the workspace's scratch usage past 5GB, evict oldest-first (`<runId>` dir, ordered by mtime) until below quota. Metric `scratch_eviction_bytes` records total bytes evicted per sweep.

Quota check happens at write time, before bytes hit disk. If a single write exceeds 5GB, reject with 507 Insufficient Storage.

#### GC — **lock in: 24h retention + dead-workspace cleanup**

Sweep runs at startup + every 1h:
1. Walk `~/.papercusp/scratch/`. For each `<workspace>/<toolName>/<runId>/` dir older than 24h, delete.
2. List `~/.papercusp/scratch/<workspace>/` dirs. Cross-reference workspace registry. Delete orphans.
3. After deletion, check per-workspace usage against 5GB quota; FIFO-evict if still over (handles the case where a long-running workspace went near-quota and the 24h sweep didn't clear enough).

Log `[scratch-gc] swept N=<n> dirs (<m> bytes), workspaces=<orphans-removed>`.

#### `chunk` event reservation — **runtime enforced**

Add `chunk` to `ReservedEventNames`:
```ts
export type ReservedEventNames = 'done' | 'progress' | 'heartbeat' | 'result' | 'chunk' | 'error';
```
(`error` is also reserved per audit; the framework auto-emits both `error` and `chunk`.)

`registerProjectedTool` throws `ToolRegistrationError: 'chunk' is a reserved event name (auto-emitted by the framework for large-output tools); declare largeOutput: true instead'` if a tool declares `events: { chunk: ... }`.

The compile-time `UserEvents<T>` guard already rejects reserved names; runtime check is the belt-and-suspenders.

#### Implementation files

- `apps/operator/lib/scratch-uri.ts` (new) — URI parser + path resolver + traversal validation
- `apps/operator/lib/scratch-gc.ts` (new) — GC sweep, quota enforcement, FIFO eviction
- `apps/operator/app/api/scratch/[...path]/route.ts` (new) — serves scratch files with workspace-scoped auth
- `apps/operator/instrumentation-node.ts` — schedule the 1h GC interval
- `packages/agent-mcp/src/types.ts` — add `chunk` to `ReservedEventNames`, runtime reject
- `packages/agent-mcp/src/dispatch-projected.ts` — when handler returns with `outputRef`, framework auto-emits `chunk` event + includes resource link in MCP `tools/call` response

#### Auth on resolver

Workspace-scoped operator principal required. Cross-workspace reads fail 403. Signed-URL cross-workspace sharing is explicitly out of scope.

#### Tests

- Resolver round-trip: write a file under the scratch dir, fetch via `/api/scratch/...`, assert auth + bytes.
- Path traversal: reject `..`, absolute paths, `~`, embedded separators, empty basename, basename of `.` / `..` / `.hidden`.
- Quota: write 4.5GB, then 1GB; assert eviction; assert eviction metric.
- Dead-workspace cleanup: create a scratch dir for a workspace not in the registry; assert GC removes it.
- Synthetic tool emits `outputRef`, assert framework auto-includes resource link in the MCP response.
- `chunk` event rejection: register a tool declaring `events: { chunk: z.object({}) }`, assert ToolRegistrationError.

#### Risk

Medium. Path traversal is the security-sensitive area; comprehensive test coverage required. Quota enforcement adds write-path latency (~1 PG-like stat call); acceptable.

---

## Tier 3 — Substantial scope (~3-4 weeks)

### T3.1 — Voice modality projection (P4.6)

**Goal:** tools declare `modality: ['text', 'voice']`; framework auto-narrates progress/done for voice surfaces.

**Mandatory pre-work — spike (~1 week):**

Profile the EL Conv AI integration. Today, voice POSTs to `/api/agent-mcp/operator-converse` and parses `<say>` tags client-side at `voice-engines/elevenlabs-conv.ts:516-565`. The framework-level modality would replace ad-hoc tag parsing with structured narration events.

Spike output (~1 page memo at `apps/operator/docs/plans/voice-modality-spike-2026-05-26.md`):
- Confirmed: does EL Conv AI's hosted infra support consuming a structured narration event, or does it need `<say>` tags in the streamed text?
- Decided: is narration a new event (`narrate: z.object({ text: z.string() })`) or does it overload `delta`?
- Designed: how does a tool declaring `modality: ['voice']` get narrated when called via MCP tools/call (no SSE)?

Spike decides whether the migration is feasible OR voice modality stays at the prompt level.

**If spike approves the migration (~2 weeks):**

- `packages/agent-mcp/src/types.ts` — add `modality?: ('text' | 'voice')[]` to `RoleToolDefinitionInput`
- `packages/agent-mcp/src/tool-projection.ts` — `UnifiedToolContext.narrate?: (text: string) => void`
- `apps/operator/lib/voice-engines/elevenlabs-conv.ts` — replace `<say>` tag parsing with native `narrate` event consumption
- `apps/operator/lib/agent-tools/operator/converse.ts` — migrate `modality` field from ad-hoc input arg to declarative

**Risk:** high. Tightly coupled to EL Conv AI's contract. Spike-first gating is the mitigation; the spike's spike-killing outcome is acceptable.

### T3.2 — Plugin events from JSON manifests (P4.1)

**Goal:** plugin authors can declare `events: { delta: { type: 'string' } }` in `papercusp.json` instead of being limited to built-ins via `defineTool`.

#### Supported JSON-Schema subset — **explicit**

| Keyword | Status | Notes |
|---|---|---|
| `type: 'string'` | ✅ supported | wire kind: `'string'` |
| `type: 'number'` / `'integer'` / `'boolean'` | ✅ supported | wire kind: `'json'` |
| `type: 'object'` | ✅ supported | wire kind: `'json'` |
| `type: 'array'` | ✅ supported | wire kind: `'json'` |
| `properties` | ✅ supported | object subschema |
| `items` | ✅ supported | array element schema |
| `enum` | ✅ supported | array of allowed values |
| `const` | ✅ supported | literal value |
| `contentEncoding: 'base64'` (on `type: 'string'`) | ✅ supported | wire kind: `'binary'` (base64 envelope) |
| `required` | ✅ supported | per object subschema |
| `description` | ✅ supported | passes through |
| `format` | ❌ unsupported | reject at validate time |
| `pattern` | ❌ unsupported | reject |
| `$ref` / `$defs` | ❌ unsupported | reject |
| `oneOf` / `anyOf` / `allOf` | ❌ unsupported | reject |
| `additionalProperties: <schema>` | ❌ unsupported | reject (only `false` or omit) |
| `not` | ❌ unsupported | reject |
| `if` / `then` / `else` | ❌ unsupported | reject |

Rejection error: `unsupported JSON-Schema keyword "<name>" in plugin "<plugin>" tool "<tool>" event "<event>". Supported: type, properties, items, enum, const, contentEncoding, required, description.`

Rationale: the subset covers everything `defineTool`-side tools need (delta as string, tool_call as object, cost as object, binary as base64). Adding `oneOf`/`format` requires either a more sophisticated converter OR runtime validators we don't have a use for yet. Plugin authors who hit the wall file a feature request with their use case.

#### Wire classification

Stays structurally-derived (no Zod schema needed for runtime classification):
- `{type: 'string', contentEncoding: 'base64'}` → `'binary'`
- `{type: 'string'}` → `'string'`
- else → `'json'`

`classifyEventWire` from `packages/agent-mcp/src/tool-projection.ts` gains a JSON-Schema overload alongside the existing Zod overload. Both produce the same `EventWireKind`.

#### Implementation files

- `apps/operator/lib/json-schema-to-zod.ts` (new, ~300 LoC) — convert the subset above into Zod schemas for runtime validation (validates emitted-event payloads if the framework grows that feature later); produces `null` for unsupported keywords with an explicit error
- `packages/plugin-sdk/papercusp-plugin.schema.json` — extend `tools[].events` to allow `{ <name>: <JSON-Schema> }`
- `packages/plugin-loader/src/manifest-validate.ts` — validate the events block via strict Ajv schema; reject unsupported keywords
- `packages/plugin-loader/src/index.ts:634` — replace the warn-and-drop with: convert manifest events to wire-kind map, pass through `registerProjectedTool`

#### Hard constraint: no raw binary

Plugin events support binary only via base64 envelope (same as built-in `z.instanceof(Uint8Array)`). Raw bytes on the wire require WASM/IPC, which is P5 concern.

#### Tests

- Round-trip a manifest with `events: { delta: { type: 'string' }, payload: { type: 'string', contentEncoding: 'base64' } }`, assert correct wire kinds + wire shape.
- Unsupported keyword (`format`, `oneOf`) at validate time → strict rejection with helpful error.
- A plugin's typed event ships through the same emitToSseSink path as built-ins.

#### Risk

Medium. JSON-Schema-to-Zod converter is the unknown. Mitigation: hand-rolled for the documented subset; reject anything outside it at validate time.

---

## Tier 4 — Deferred indefinitely

### T4.1 — Bidirectional `ctx.awaitResponse` (P4.7)

The plan's explicit non-goal. Use cases (mid-stream interactive forms, server asks user a question) are speculative. Framework changes are substantial (server-held pending responses, client correlation tokens, timeout handling). **Do not start without a concrete driver feature.**

### T4.2 — Ladder Level 3 shared-memory IPC

Only justified by a real-time video/audio/GPU tool. None on roadmap. **Defer until a Level-3-specific feature appears.**

### T4.3 — Long-lived disconnected tools (T2.2 model "(a)")

Tools that keep streaming through a network disconnect into a buffer, with the dispatcher's abort gated on buffer expiry rather than client disconnect. Real engineering work; speculative driver. **Deferred from T2.2's "(b)" scope; revisit if a long-running tool's UX needs it.**

---

## Sequencing

```
Week 1:  Tier 1 — 3 small items in parallel (all independent)
         ├─ T1.1 MCP initialize capability (½ day)
         ├─ T1.2 Hono shim retirement (½ day)
         └─ T1.3 Specta codegen (½ day)

Week 2-3: Tier 2 — three independent features in parallel
         ├─ T2.1 Card registry (2 days, client-side)
         ├─ T2.2 Replay / LEI (3 days, server-side; needs migration 065
         │       for event_count column)
         └─ T2.3 Tool-output-as-resource (3 days, server-side)

         T2.2 has a 1-week instrumentation phase BEFORE locking
         per-tool buffer sizes. The migration can land with the
         5000-event default; the per-tool tuning is a follow-up
         commit once data exists.

Week 4-6: Tier 3 — substantial work
         ├─ T3.1 Voice modality (1-week spike + 2-week migration if
         │       spike approves; abort with a memo if it doesn't)
         └─ T3.2 Plugin events from JSON manifests (1 week)

Deferred:
         T4.1 bidirectional, T4.2 shared-memory, T4.3 long-lived disconnected
```

Each item gets its own PR. Audit pattern (1-2 rounds per migration commit) applied per the round-12/13 lessons.

---

## Locked-in decisions

| Decision | Choice | Section |
|---|---|---|
| Disconnect semantics | Tool aborts on disconnect; replay serves pre-disconnect buffer only | T2.2 |
| `runId` provenance | `X-Papercusp-Run-Id: <uuid>` HTTP response header | T2.2 |
| Buffer-size policy | Instrument first; default 5000 with eviction warn log; tune to 1.5× p99 after one week | T2.2 |
| `runId` generation | `crypto.randomUUID()` (replaces `${prefix}-${Date.now()}`) | T2.2 |
| Buffer lifetime | 5 min after stream-end; cleared on workspace switch | T2.2 |
| Scratch URI scheme | `papercusp://scratch/<ws>/<tool>/<runId>/<file>` | T2.3 |
| Path traversal | Strict regex + UUID check on runId + path.resolve assertion | T2.3 |
| Scratch quota | 5GB per workspace, FIFO eviction by mtime, metric `scratch_eviction_bytes` | T2.3 |
| Scratch GC | 24h retention + dead-workspace cleanup, sweep at startup + 1h | T2.3 |
| Scratch auth | Workspace-locked; no cross-workspace; no signed URLs | T2.3 |
| `chunk` reserved name | Runtime reject in `registerProjectedTool` + add to `ReservedEventNames` | T2.3 |
| Plugin events binary | Base64 envelope only; no raw bytes | T3.2 |
| Plugin JSON-Schema subset | Explicit allow-list table (T3.2); strict reject on unsupported keywords | T3.2 |
| T3.1 modality migration | Spike-gated; no code until spike memo approves | T3.1 |
| Card registry scope | Imperative `registerCard` first; schema-driven follow-up | T2.1 |
| Tier 2 parallelization | T2.1 / T2.2 / T2.3 independent — no false dependency | Sequencing |

## Open items (resolve before kickoff)

1. **`event_count` migration ordering.** T2.2 needs migration 065. Land it as a small standalone PR before T2.2 starts, or include in T2.2's PR. Recommend standalone — keeps the schema change separately reviewable.

That's the only one left. (Original v1 had three: cross-workspace buffer eviction policy — locked in T2.2 as "clear all on workspace switch"; quota — locked in T2.3 as 5GB FIFO; voice spike owner — defer until Tier 3 starts.)

---

## Out of scope explicitly

- Any new top-level URL namespace beyond `/api/agent-tools`, `/api/plugins`, `/api/mcp`, `/api/agent-mcp`, `/api/scratch` (T2.3 adds the last).
- Cross-process replay buffers (PG-backed) — Tier 2's in-memory buffer is the contract.
- Long-lived disconnected tools (T4.3).
- Plugin events with non-JSON-Schema-able shapes — plugins use JSON-Schema for everything.
- Real-time tool framework primitives (video/audio frames) — would land via Ladder Level 3 IPC + a per-tool shm ring.
- Cross-workspace scratch sharing via signed URLs.
- Mid-stream interactive forms (T4.1).

---

## Reviewer feedback applied (v1 → v2)

This v2 incorporates 13 concerns from the reviewer round on v1. Summary:

- **T2.2 disconnect semantics** → picked (b), defer (a) to T4.3
- **T2.2 runId provenance** → response header
- **T2.2 buffer sizes** → instrument first; soft cap 5000 with eviction log
- **T2.2 runId generation** → UUID + concurrent-call regression test
- **T2.3 path traversal** → strict regex + UUID validation table
- **T2.3 dead-workspace cleanup** → in GC sweep
- **T2.3 quota** → 5GB FIFO eviction
- **T3.2 JSON-Schema subset** → explicit allow-list table
- **`chunk` reservation** → add to `ReservedEventNames` + runtime reject
- **Tier 2 parallelization** → false dep dropped
- **T1.2 `harnessSlug` requiredness** → verified required in code; pre-flight grep before retirement
- **T2.2 user-docs note** → 5-min-window behavior noted for chat-resume docs
- **T2.3 signed-URL sharing** → kept out

The drafting agent (Claude) wrote v1 + v2. v2 has not been independently re-reviewed since incorporating the feedback; the reviewer should re-scan T2.2 disconnect semantics and T2.3 path-traversal in particular to confirm the resolutions match their intent.
