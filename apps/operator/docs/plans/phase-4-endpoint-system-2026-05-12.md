# Endpoint system — Phase 4+ implementation

**Status:** **draft 2026-05-12** — awaiting approval. Follows the codebase audit on the same date and assumes `sse-typed-events-2026-05-12.md` + `desktop-native-transport-2026-05-12.md` have shipped to main (commit `6ab7c8f6` and later).

Sequences the eight Phase 4+ items previously deferred from the SSE typed-events plan, plus the IPC Specta-codegen follow-up. Items are revised against current code, not the version of the codebase the original plan assumed — three items are now substantially smaller than originally scoped because incremental infrastructure landed during Phase 3 implementation.

---

## Goals

1. Land the cheap Phase 4+ items that the Phase 3 work made trivial (1-line capability declaration, 2 Hono shim retirements, Specta wiring) before they bit-rot.
2. Build the schema-driven card registry that unblocks adding new in-chat tool UIs without touching every consumer.
3. Implement replay / `Last-Event-ID` for chat resume — the SSE library already supports it; the dispatcher just needs per-call buffering.
4. Implement tool-output-as-resource for tools that emit large outputs (200MB+) without inlining bytes in the SSE stream.
5. Project voice as a first-class modality at the framework level so tools declare `modality: ['text', 'voice']` instead of each rolling its own `<say>`-tag handling.

## Non-goals (deferred indefinitely — see "Deferred" below)

- Plugin events from JSON manifests (P4.1) — has no concrete driver beyond hypothetical authoring ergonomics; the workaround (built-ins via `defineTool`) is still preferred.
- Bidirectional client→server during a stream (`ctx.awaitResponse`, P4.7) — explicitly the carve-out preserved in Phase 3.
- Shared-memory IPC (Ladder Level 3) — only justified by a real-time tool feature; none on roadmap.

## Hard prerequisites

- Phase 3 shipped (`dispatchProjectedToolStream`, schema-inferred wire kinds, MCP `notifications/papercusp/event`). ✅ on main `6ab7c8f6`.
- Endpoint-IPC shipped (UDS framing, Node server, Rust client, transport adapters). ✅ on main `6ab7c8f6`.
- Migration 058 applied (`transport` column on `tool_invocations`). ✅ live PG.

---

## Audit findings (2026-05-12)

Three Phase 4+ items had **substantial infrastructure built incrementally** during Phase 3 and need much smaller implementations than the original plan assumed:

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

Low risk, low effort. These exist as infrastructure already; we're just wiring or removing.

### T1.1 — MCP `initialize` capability declaration (P4.8)

**File:** `apps/operator/app/api/[transport]/route.ts` (~line 629).

Add the Papercusp typed-events extension to the server's declared capabilities:

```ts
{ capabilities: {
    tools: {},
    resources: {},
    prompts: {},
    // Papercusp extension: this server emits notifications/papercusp/event
    // frames for tools with declared events: schemas. Third-party MCP
    // clients can read tools/list response to discover per-tool event
    // shape via the `events` field.
    experimental: {
      'papercusp/typedEvents': { version: '1' },
    },
} }
```

**Test:** new test in `mcp-notifications.test.ts` asserts `initialize` response includes `experimental['papercusp/typedEvents']`.

**Risk:** zero. Pure declaration, no behavior change. Third-party MCP clients ignore unknown capabilities.

### T1.2 — Retire 2 Hono shims (P4.3 simplified)

**Files:**
- `apps/operator/app/api/_hono/harness.ts` — remove the `harness.post('/:slug/architect/chat', ...)` and `harness.post('/:slug/brainstorm/chat', ...)` blocks (~150 LoC each)
- `libs/agent-chat/src/useHarnessChatRuntime.ts` — update URL builder to `/api/agent-tools/architect/chat` (or `brainstorm/chat`); body gains `harnessSlug` field (already supported by the tool args)

**Why simpler than the original plan:** the original assumed 6 shims; operator-chat was deleted as dead code in Phase 3, operator-converse/scan/delegate were never Hono shims (they're at `/api/agent-mcp/*`), so only architect+brainstorm survived.

**Test:** existing `chat-surface-tools.mjs` drift test continues to pass (the tools are still IPC-eligible self-contained). Add a smoke test that hits `/api/agent-tools/architect/chat` directly with a slug-bearing body.

**Risk:** medium. Changes the consumer URL. Mitigated by the tool already accepting `harnessSlug` as an arg post-round-12 migration, and by `@restart/sse` resilient EventSource handling reconnects.

### T1.3 — Wire Specta codegen for IPC

**Files:**
- `papercusp-desktop/src-tauri/src/main.rs` — instantiate `tauri_specta::Builder` for `endpoint_invoke` and `endpoint_cancel` commands, emit TypeScript at build to `apps/operator/lib/transport-adapters/ipc-types.generated.ts`
- `apps/operator/lib/transport-adapters/ipc-stream.ts` — replace hand-typed `RustEndpointEvent` interface (lines 21-26) with the generated type

**Test:** existing `transport-adapters.test.ts` continues to pass with the generated type substituted. Verify generated file commits clean via a `npm run check-generated-ipc` script that errors if the committed file drifts from a fresh codegen.

**Risk:** low. The wire format is fixed; the generated type is a refactor of the consumer side.

---

## Tier 2 — User-visible features (~2-3 weeks)

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
  args: unknown;           // tool input as recorded by the consumer
  result?: unknown;        // tool result if available
  onAnswer?: (id: string, label: string) => void;
};

export type CardRenderer = (props: CardRenderProps) => ReactNode | null;

export function registerCard(toolName: string, renderer: CardRenderer): void;
export function renderCard(props: CardRenderProps): ReactNode | null;
```

**Migration:**
- `chat:ask_choice` registers `AskChoiceCard` at module load via the same `defineTool`-adjacent side effect that registers the tool itself.
- `OperatorChat.tsx:75-77` and `OracleDock.tsx:1341-1344` import `renderCard` and pass it through as the `renderToolCard` prop.
- The hardcoded `if (t.name !== 'chat:ask_choice') return null` chains delete.

**Schema-driven extension (follow-up after the registry lands):** the registry can opt into auto-rendering from `tools/list`'s `inputSchema` for tools that declare `expose.chatCard: true`. Out of scope for the initial registry; this is the long-tail P4.2 vision.

**Test:** unit test the registry, plus a smoke test that mounting `OperatorChat` with a synthetic `chat:test_card` tool renders the registered component (and falls through to default chip if unregistered).

**Risk:** low. The registry is additive — `renderCard` returns null for unregistered tools, preserving the default-chip fallback.

### T2.2 — Replay / `Last-Event-ID` for chat resume (P4.4)

**Goal:** a refresh / network blip resumes a chat turn mid-stream instead of losing it.

**Files:**
- `packages/agent-mcp/src/types.ts` — add `replayBufferSize?: number` to `RoleToolDefinitionInput` (default `0` = disabled)
- `packages/agent-mcp/src/dispatch-projected.ts` — wrap `ctx.emit` to push into a per-call ring buffer when `replayBufferSize > 0`; expose `getReplayBuffer(callKey)` for transport adapters
- `packages/agent-mcp/src/http-projection.ts` — read `Last-Event-ID` header on stream open; if a buffer exists for the `(workspaceId, toolName, runId)` key, plumb `replay()` callback to `sseResponse`
- `apps/operator/app/api/agent-tools/[...path]/route.ts` — propagate the LEI header to the dispatcher

**Buffer semantics:**
- Buffer is in-memory keyed on `(workspaceId, toolName, runId)`.
- Lives 5 minutes after stream-end (default).
- Bounded to `replayBufferSize` events; oldest evicted FIFO.
- Cleared on workspace switch (telemetry-aligned).

**Resume protocol (per-call):**
1. Client receives `id: N` events during normal stream.
2. Stream drops mid-turn.
3. Client reconnects with `Last-Event-ID: N` and the same `runId` query param.
4. Server finds buffer, `sink.replay()` emits events `N+1..M`.
5. Tool continues streaming (it's still running in the dispatcher); new events emit at `id: M+1+`.

**Edge cases:**
- Tool already finished by reconnect time: replay emits buffered events, then `done`, then close.
- Tool errored: replay emits buffered events, then `error`, then close.
- `runId` not provided: skip replay; stream fresh. (Backwards-compat.)

**Opt-in per tool:**
- `architect:chat`, `brainstorm:chat`, `operator:converse`, `operator:delegate`: `replayBufferSize: 1000` (~1000 events = 1 LLM turn worth)
- `operator:scan`: `replayBufferSize: 200`
- `dev:ipc_echo`: 0 (not worth buffering test events)

**Tests:**
- Framework-level: spawn synthetic streaming tool, abort stream mid-way, reconnect with LEI, assert remainder + done.
- Integration: hit `/api/agent-tools/architect/chat` with `Last-Event-ID: 3`, assert events 4+ stream.

**Risk:** medium. The in-memory buffer is per-process; if the operator restarts, the buffer dies. Acceptable trade-off — chat resume is best-effort. Cross-process buffer (PG-backed) is a P5 follow-up.

### T2.3 — Tool-output-as-resource (P4.5)

**Goal:** tools emitting 200MB+ outputs (CSV exports, repomix-style bundles, large screenshots) don't inline bytes in the SSE stream.

**Files:**
- `apps/operator/lib/scratch-uri.ts` (new) — `papercusp://scratch/<workspace>/<toolName>/<runId>/<basename>` ↔ filesystem path resolver
- `apps/operator/app/api/scratch/[...path]/route.ts` (new) — serves scratch files with workspace-scoped auth (operator principal required)
- `packages/agent-mcp/src/types.ts` — declare the `chunk` event as a framework-reserved name (not user-emittable directly; tools declare it via `largeOutput: true` flag)
- `packages/agent-mcp/src/dispatch-projected.ts` — when handler returns with `outputRef` set, framework auto-emits a final `chunk` event referencing the URI and includes it in the MCP `tools/call` response as a resource link

**Scratch URI scheme:**
```
papercusp://scratch/<workspace>/<toolName>/<runId>/<basename>
└──────────┴─────────┴──────────┴──────────┴──────────┴──────
prefix     scheme    workspace  tool       run        filename
```
Maps to: `~/.papercusp/scratch/<workspace>/<toolName>/<runId>/<basename>`

**Auth on resolver endpoint:** only the workspace's operator principal can read scratch files. Cross-workspace reads fail 403.

**Cleanup:** GC sweep at startup + every 1h removes scratch files older than 24h.

**Use case:** `bigquery:export` tool runs a 200MB query, writes the result CSV to scratch, emits `chunk` with `papercusp://scratch/default/bigquery/run-XYZ/result.csv`. The chat UI renders a download link. The MCP `tools/call` response includes the URI in the result content for non-Papercusp MCP clients.

**Tests:**
- Resolver round-trip: write a file under the scratch dir, fetch via `/api/scratch/...`, assert auth + bytes.
- Synthetic tool emits `outputRef`, assert framework auto-includes resource link in the MCP response.

**Risk:** low. Additive — tools opt in by declaring `largeOutput: true` and returning `outputRef`.

---

## Tier 3 — Substantial scope (~3-4 weeks)

### T3.1 — Voice modality projection (P4.6)

**Goal:** tools declare `modality: ['text', 'voice']`; framework auto-narrates progress/done for voice surfaces.

**Pre-work (must precede the migration):**
- **Profile the EL Conv AI integration.** Today, voice POSTs to `/api/agent-mcp/operator-converse` and parses `<say>` tags client-side. The framework-level modality would replace ad-hoc tag parsing with structured narration events.
- Document the contract: when `modality === 'voice'`, what events does the consumer expect? Likely `narrate: z.object({ text: z.string() })` instead of `delta: z.object({ text })`, but TBD.

**Files (after pre-work approval):**
- `packages/agent-mcp/src/types.ts` — add `modality?: ('text' | 'voice')[]` to `RoleToolDefinitionInput`
- `packages/agent-mcp/src/tool-projection.ts` — `UnifiedToolContext.narrate?: (text: string) => void`
- `apps/operator/lib/voice-engines/elevenlabs-conv.ts` — replace `<say>` tag parsing with native `narrate` event consumption
- `apps/operator/lib/agent-tools/operator/converse.ts` — migrate `modality` field from ad-hoc input arg to declarative

**Risk:** high. Tightly coupled to EL Conv AI's contract. The pre-work spike (~1 week) determines if this is even the right shape, or if voice modality should stay at the prompt-construction level. **Do not start the migration without the spike outcome.**

### T3.2 — Plugin events from JSON manifests (P4.1)

**Goal:** plugin authors can declare `events: { delta: { type: 'string' } }` in `papercusp.json` instead of being limited to built-ins via `defineTool`.

**Files:**
- `apps/operator/lib/json-schema-to-zod.ts` (new, ~300 LoC) — convert the subset of JSON-Schema plugins may use (string/object/number/boolean + `{type: 'string', contentEncoding: 'base64'}` as binary marker) into Zod schemas for runtime wire classification
- `packages/plugin-sdk/papercusp-plugin.schema.json` — extend `tools[].events` to allow `{ <name>: <JSON-Schema> }`
- `packages/plugin-loader/src/manifest-validate.ts` — validate the events block via the strict Ajv schema
- `packages/plugin-loader/src/index.ts:634` — replace the warn-and-drop with: convert manifest events to Zod, pass to `registerProjectedTool`

**Wire classification:** stays structurally-derived. No Zod schema needed for classification — inspect JSON-Schema directly:
- `{type: 'string'}` → wire 'string'
- `{type: 'string', contentEncoding: 'base64'}` → wire 'binary'
- else → wire 'json'

**Hard constraint:** binary support via base64 envelope only (same as the built-in `z.instanceof(Uint8Array)` path). Plugins can't get raw bytes on the wire — they'd need WASM/IPC for that, which is a P5 concern.

**Tests:**
- Round-trip a manifest with `events: { delta: { type: 'string' }, binary: { type: 'string', contentEncoding: 'base64' } }`, assert correct wire kinds.
- A plugin's typed event ships through the same emitToSseSink path as built-ins.

**Risk:** medium. The converter is the unknown. Mitigation: hand-rolled for a tight subset of JSON-Schema; reject anything outside the subset at validate time.

---

## Tier 4 — Deferred indefinitely

### T4.1 — Bidirectional `ctx.awaitResponse` (P4.7)

The plan's explicit non-goal. Use cases (mid-stream interactive forms, server asks user a question) are speculative. Framework changes are substantial (server-held pending responses, client correlation tokens, timeout handling). **Do not start without a concrete driver feature.**

### T4.2 — Ladder Level 3 shared-memory IPC

Only justified by a real-time video/audio/GPU tool. None on roadmap. **Defer until a Level-3-specific feature appears.**

---

## Sequencing

```
Week 1:  Tier 1 — 3 small items in parallel where independent
         ├─ T1.1 MCP initialize capability (½ day)
         ├─ T1.2 Hono shim retirement (½ day) — slight risk; do after T1.1
         └─ T1.3 Specta codegen (½ day) — independent, can fold in any time

Week 2-3: Tier 2 — user-visible features in dependency order
         ├─ T2.1 Card registry (2 days) — derisks T2.3 (cards consume registry)
         ├─ T2.2 Replay / LEI (3 days)
         └─ T2.3 Tool-output-as-resource (3 days)

Week 4-6: Tier 3 — substantial work
         ├─ T3.1 Voice modality (2 weeks; spike first)
         └─ T3.2 Plugin events from JSON (1 week) — can land anytime post-T2

Deferred:
         T4.1 bidirectional, T4.2 shared-memory
```

Each item gets its own PR. Audit pattern (1-2 rounds per migration commit) should be applied per the round-12+13 lessons.

---

## Locked-in decisions

| Decision | Choice | Source |
|---|---|---|
| Resume protocol scope | Per-call (LEI + runId), not per-session | T2.2 reasoning |
| Scratch URI scheme | `papercusp://scratch/<ws>/<tool>/<runId>/<file>` | T2.3 reasoning |
| Scratch GC | 24h retention, sweep at startup + hourly | T2.3 reasoning |
| Plugin events binary | Base64 envelope only; no raw bytes (P5 concern) | T3.2 reasoning |
| Modality migration | Spike before code | T3.1 pre-work |
| Card registry scope | Imperative `registerCard` first; schema-driven follow-up | T2.1 reasoning |

## Open items (need decision before starting)

1. **Replay buffer eviction policy on workspace switch** — clear all buffers, or only clear the previous workspace's? Recommend "clear all" for memory hygiene; clarify with reviewer.
2. **Scratch quota per workspace** — none today. Should we cap (e.g., 5GB per workspace)? Easier to add early than retrofit.
3. **Voice modality pre-work owner** — needs someone with EL Conv AI context to drive the spike. Avi or whoever owns the voice arc.

---

## Out-of-scope explicitly

- Any new top-level URL namespace beyond what's already there (`/api/agent-tools`, `/api/plugins`, `/api/mcp`, `/api/agent-mcp`, `/api/scratch`).
- Cross-process replay buffers (PG-backed) — Tier 2's in-memory buffer is the contract.
- Plugin events with non-JSON-Schema-able shapes — plugins use JSON-Schema for everything.
- Real-time tool framework primitives (video/audio frames) — would land via Ladder Level 3 IPC + a per-tool shm ring.

---

## Reviewer pushback to apply before starting

This plan was drafted by the agent that shipped Phase 3 + the endpoint-IPC work. It hasn't been independently reviewed yet. Before approving, the following should be re-examined:

1. **Is T1.2 (shim retirement) really safe?** Verify no caller outside `useHarnessChatRuntime` POSTs to `/:slug/architect/chat` or `/:slug/brainstorm/chat`. The risk is a forgotten internal consumer that hardcodes the URL.
2. **Is T2.2's 5-minute buffer retention too aggressive?** Chat tabs that idle longer than 5 min and reconnect would still hit a cold buffer. Consider per-tool override (e.g., delegate sessions retain longer because their resume window is longer in practice).
3. **Is T3.1's voice spike correctly scoped?** The EL Conv AI integration touches `voice-engines/elevenlabs-conv.ts` (~600 LoC). A spike that doesn't actually exercise EL Conv AI's hosted infra would miss the real risk surface.
4. **T2.3's auth model** — should scratch files be cross-workspace-readable via signed URLs, or strictly workspace-locked? Today's `lib/sync-sse.ts` and friends use workspace isolation; T2.3 inherits that. Signed URLs would unblock sharing scratch outputs across an org but require a fresh threat model.
