# Bespoke card-system improvements — 2026-05-13 (v2)

Stay on our bespoke card+event surface. Adopt four insights from researching A2UI, AG-UI, MCP elicitation, and JSON Forms. T4.1 and T4.3 collapse into these improvements; T4.2 stays deferred.

**v2 changes (from review):** H1–H4 high-priority issues addressed (card reserved name; cards live on state channel not replay buffer; auth model specified; single `onWorkspaceSwitch` hook). M1 scopes state to snapshot-only in v1. L1 PR sequencing corrected. L4 renames `accept` → `submit`. Full list in §A.

**Plan-doc convention reminder:** execution happens in sibling git worktrees, one per PR. Per-turn commit + push discipline.

---

## 1. Motivation

The chat-cards system and `ctx.emit` typed-events framework shipped in Phase 4 work, but a research sweep across competing designs surfaced four structural improvements worth taking. The full A2UI/AG-UI migration was considered and rejected (~9 weeks, theoretical interop, costs OracleDock flexibility); these four targeted changes get ~80% of the design benefit in ~4 weeks (3 dev + 1 audit) while keeping every other decision under our control.

| # | Insight | From | Cost | Impact |
|---|---|---|---|---|
| #4 | `ctx.askUser` runtime primitive | Every framework | ~1 wk + state-channel | **Absorbs T4.1.** Cards live on the state channel from day one. |
| #1 | `ctx.publishState` (state vs events) | AG-UI `STATE_*` | ~1 wk | **Absorbs T4.3.** State-shaped tools survive disconnect by construction. |
| #3 | Schema/UI separation in card payloads | JSON Forms | ~3 d | Fixes T3.1 modality at per-emit granularity. |
| #2 | `submit` / `decline` / `cancel` response actions | MCP elicitation | ~2 d | First-class "user said no". Voice gets free skip semantics. |

Order: **#4 → (#1 || #3) → #2**. PR 4 depends on `CardPresentation` from PR 3.

---

## 2. Scope and non-goals

### In scope
- New runtime primitives `ctx.askUser` and `ctx.publishState` on `UnifiedToolContext`.
- A **state channel** alongside the existing event channel. Pending cards live here, not in the ring buffer.
- Server-side correlator + response-resolution route with session-cookie auth + rate limit.
- Card-payload shape: `{prompt, dataSchema, presentation?, fallbackText?}`.
- Card response shape: `{action: 'submit'|'decline'|'cancel', payload?}`.
- Migration of `chat:ask_choice` to thin wrapper over `ctx.askUser`.
- Migration of `OperatorChat` to new response shape via `/card-response`.
- `askUserLocal` companion API for OracleDock's render-time-only prompts (distinct from `ctx.askUser`).
- Voice surface consumes `fallbackText`.
- Single `onWorkspaceSwitch(workspaceId)` lifecycle hook subscribed by ring buffer + pending-card + state-snapshot cleanup.
- Backwards-compat: `/turn-answer` becomes a legacy adapter for one release cycle.

### Out of scope
- Visual redesign of cards. Existing AskChoiceCard rendering preserved verbatim.
- Removing `chat-cards/` directory (becomes a thin layer over the new primitives).
- A2UI / AG-UI / MCP-elicitation wire adoption.
- T4.2 shared-memory IPC.
- Rust port changes. `libs/papercusp/` untouched per memory directive.
- **JSON Patch deltas for `publishState`** — deferred to v1.1 after we measure snapshot-only perf.
- Cross-process correlator persistence (in-process; dev HMR drops pending cards, documented).

---

## 3. Architectural picture

```
                   IMPROVED BESPOKE SYSTEM (v2)
                   ════════════════════════════

  Tool handler                          UnifiedToolContext
  ┌──────────────────────────┐         ┌──────────────────────────┐
  │                          │         │  ctx.emit(name, payload) │ ← events channel
  │  await ctx.askUser({…}) ─┼────────►│  ctx.askUser(spec)       │ ← state channel (#4)
  │                          │         │  ctx.publishState(snap)  │ ← state channel (#1)
  │  ctx.publishState({…})  ─┼────────►│                          │
  └──────────────────────────┘         └──────────────────────────┘
              │                                  │
              ▼                                  ▼
  ┌──────────────────────────────────────────────────────────────┐
  │            Tool-projection runtime — two channels            │
  │                                                              │
  │   ┌───────────────────┐         ┌─────────────────────────┐  │
  │   │  EVENTS channel   │         │   STATE channel         │  │
  │   │  ──────────────   │         │   ──────────────        │  │
  │   │  ctx.emit         │         │   ctx.askUser           │  │
  │   │  ring buffer      │         │   ctx.publishState      │  │
  │   │  replay = history │         │   per-run state map     │  │
  │   │  (T2.2)           │         │   replay = snapshot     │  │
  │   │                   │         │   { openCards:[],       │  │
  │   │                   │         │     toolState: {...} }  │  │
  │   └───────────────────┘         └─────────────────────────┘  │
  │                                                              │
  │   "card" is a RESERVED event name — plugins cannot declare   │
  │   events: { card: ... } (H1)                                 │
  └──────────────────────────────────────────────────────────────┘
              │
              ▼
        libs/sse / IPC  (transports — unchanged at framing layer)
              │
              ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  Client decoder                                              │
  │  - events: append to message stream                          │
  │  - state-snapshot: replace local snapshot for this run       │
  │  - render openCards[head] only (one visible, queue indicator)│
  │  - on submit: POST /card-response with action enum (#2)      │
  └──────────────────────────────────────────────────────────────┘

  onWorkspaceSwitch(workspaceId) ← single registration point (H4)
    ├─ clearRingBuffersForWorkspaceSwitch
    ├─ cancelPendingCardsForWorkspaceSwitch
    └─ dropStateSnapshotsForWorkspaceSwitch
```

---

## 4. Improvement #4 — `ctx.askUser` (deepest detail)

### 4.1 API surface

```ts
interface CardSpec<T extends ZodTypeAny = ZodTypeAny> {
  /** Human-readable prompt. Voice reads this verbatim. */
  prompt: string;
  /** Zod schema for the response payload. Validated server-side before resolving. */
  dataSchema: T;
  /** Presentation hint for visual renderers. Voice ignores. */
  presentation?: CardPresentation;
  /** Voice / MCP elicitation fallback. */
  fallbackText?: string;
  /** Absolute timeout. Rejects with TimeoutError if user doesn't respond. */
  timeoutMs?: number;
  /** Per-run idempotency: same key returns cached response within the run. */
  idempotencyKey?: string;
  /** Allow user to decline (default true). When false, decline action is hidden. */
  allowDecline?: boolean;
}

type CardResponse<T extends ZodTypeAny> =
  | { action: 'submit'; payload: z.infer<T> }
  | { action: 'decline'; reason?: string }
  | { action: 'cancel' };

interface UnifiedToolContext {
  // ... existing
  askUser<T extends ZodTypeAny>(spec: CardSpec<T>): Promise<CardResponse<T>>;
}
```

### 4.2 Wire shape

**On the state channel** (NOT the event channel): cards are part of the run's snapshot. Server emits a `state-snapshot` typed event whenever openCards changes:

```jsonc
{
  "type": "state-snapshot",
  "payload": {
    "runId": "abc-…",
    "version": 7,
    "snapshot": {
      "openCards": [
        {
          "correlationId": "550e8400-e29b-41d4-a716-446655440000",
          "prompt": "Did you mean X or Y?",
          "dataSchemaJson": { /* JSON Schema derived from Zod */ },
          "presentation": { "kind": "radio", "options": [...] },
          "fallbackText": "Choose X or Y",
          "allowDecline": true
        }
      ],
      "toolState": { /* populated by ctx.publishState (#1) */ }
    }
  }
}
```

On reconnect mid-run, client receives the latest snapshot. If the original card was already answered server-side, its correlationId is absent from `openCards[]` and the user is not re-prompted (this is the H2 fix).

Client POSTs response to:

```
POST /api/operator/conversations/:convId/card-response
Cookie: <session>
Content-Type: application/json

{ "correlationId": "550e8400-…", "action": "submit", "payload": { "picks": ["x"] } }
```

Or `{ "action": "decline", "reason"?: string }`, `{ "action": "cancel" }`.

### 4.3 Server-side state machine

**File:** `packages/agent-mcp/src/card-correlator.ts`

```ts
interface PendingCard<T extends ZodTypeAny = ZodTypeAny> {
  runId: string;
  workspaceId: string;
  dataSchema: T;
  spec: CardSpec<T>;
  deferred: Deferred<CardResponse<T>>;
  createdAt: number;
  timeoutHandle?: NodeJS.Timeout;
}

const PENDING = new Map<string /* correlationId */, PendingCard>();
const BY_RUN  = new Map<string /* runId */, Set<string /* correlationId */>>();
const BY_RUN_IDEMPOTENCY = new Map<string /* runId */, Map<string /* key */, CardResponse<any>>>();
```

**Lifecycle:**
1. `ctx.askUser(spec)` called.
2. If `spec.idempotencyKey` present + cached for this runId → return cached response, no emit.
3. Generate `correlationId = crypto.randomUUID()`.
4. Register in `PENDING` + `BY_RUN`.
5. **Re-emit state snapshot for the run** (current openCards includes new entry).
6. If `spec.timeoutMs` → schedule `setTimeout` that resolves with `{action:'cancel'}` and removes entry.
7. Return the Deferred's promise.
8. On `/card-response` POST → look up by `correlationId` → validate `payload` against stored `dataSchema` → resolve Deferred → remove from maps → **re-emit state snapshot** (openCards no longer includes this entry).
9. On run-end → for every pending card under this runId, resolve `{action:'cancel'}` → clean maps.
10. On workspace-switch → same as run-end but scoped to workspace.

**State-channel integration:**
The PENDING map IS the source-of-truth for `snapshot.openCards`. The card-correlator publishes to the state channel via `publishCardSnapshot(runId)` whenever PENDING changes. No double-bookkeeping.

### 4.4 `ctx.askUser` (server) vs `askUserLocal` (client) — boundary

| API | Where | Triggered by | Wire? | Use cases |
|---|---|---|---|---|
| `ctx.askUser` | Server, inside tool handlers | Tool execution | Yes — state channel + `/card-response` | In-flight tool prompts: `chat:ask_choice` body, `search` follow-up clarification, anything calling a tool |
| `askUserLocal` | Client, inside React components | Render-time user interactions | No — pure client state | OracleDock tab pickers, settings dialogs, render-time confirmations not tied to a tool run |

They share `CardSpec`/`CardResponse` types and the renderer (`AskChoiceCard`). They do NOT share the correlator. OracleDock uses both: `ctx.askUser` flows when it invokes a tool that prompts the user; `askUserLocal` when OracleDock itself needs a tab-picker.

`askUserLocal` API:
```ts
function askUserLocal<T extends ZodTypeAny>(
  spec: CardSpec<T>,
): Promise<CardResponse<T>>;
```

Implementation: client-side React-state-driven; renders the card in a host-provided slot, returns the resolved promise when the user submits.

### 4.5 `/card-response` auth

- **Auth:** session cookie, identical to `/turn-answer`. Server resolves session → workspaceId. Card's stored workspaceId must match.
- **No cookie or wrong workspace** → 401.
- **CSRF:** same origin check as `/turn-answer`.
- **Rate limit:** 30 RPS per workspace, sliding window (in-memory; same pattern as existing rate limits in operator).
- **Test:** `POST /card-response without cookie → 401` is in the test plan (§4.9).

### 4.6 `chat:ask_choice` migration

```ts
defineTool({
  name: 'chat:ask_choice',
  input: AskChoiceArgs,
  output: AskChoiceOutput,
  handler: async (args, ctx) => {
    const choiceSchema = args.multi
      ? z.object({ picks: z.array(z.string()).min(1) })
      : z.object({ picks: z.tuple([z.string()]) });

    const r = await ctx.askUser({
      prompt: args.question,
      dataSchema: choiceSchema,
      presentation: {
        kind: args.multi ? 'checkbox' : 'radio',
        options: args.options.map(o => ({ id: o.id, label: o.label, hint: o.hint, style: o.style })),
      },
      fallbackText: `Pick ${args.multi ? 'one or more' : 'one'}: ${args.options.map(o => o.label).join(', ')}`,
    });

    if (r.action === 'decline') return { declined: true };
    if (r.action === 'cancel')  throw new Error('cancelled');
    return {
      picks: r.payload.picks.map(id => {
        const opt = args.options.find(o => o.id === id)!;
        return { option_id: id, label: opt.label };
      }),
    };
  },
});
```

Old call sites of `chat:ask_choice` keep working.

### 4.7 Legacy `/turn-answer` adapter

Today's `POST /api/operator/conversations/:id/turn-answer`:
- Locates the open `chat:ask_choice` turn by seq
- Stores the answer on the turn record
- Wakes the model's `chat:ask_choice` tool-call to return

After PR 1:
- The endpoint locates the open `chat:ask_choice` invocation's `correlationId`.
- Translates the legacy POST body into a `/card-response` call with `action: 'submit'`.
- Resolves through the new correlator.
- Marked deprecated in code comments + docs; retire after one release.

### 4.8 File-by-file scope (PR 1)

**New files**

```
packages/agent-mcp/src/
  workspace-lifecycle.ts         ← onWorkspaceSwitch registration (H4)
  workspace-lifecycle.test.ts
  state-channel.ts               ← minimal state-channel for openCards (PR 1 portion)
  state-channel.test.ts
  card-correlator.ts             ← PENDING + Deferred lifecycle (uses state-channel)
  card-correlator.test.ts
  ask-user.ts                    ← ctx.askUser implementation
  ask-user.test.ts

apps/operator/app/api/operator/conversations/[id]/card-response/route.ts
                                  ← endpoint w/ session-cookie auth + 30 RPS limit
apps/operator/app/api/operator/conversations/[id]/card-response/route.test.ts

apps/operator/lib/chat-cards/
  ask-user-local.ts              ← OracleDock-side companion
  ask-user-local.test.ts
```

**Modified files**

```
packages/agent-mcp/src/
  tool-projection.ts             ← add askUser to UnifiedToolContext;
                                    reserve 'card' in RESERVED_EVENT_NAMES (H1)
  types.ts                       ← CardSpec / CardResponse / CardPresentation
  dispatch-projected.ts          ← state channel plumbing
  replay-buffer.ts               ← onWorkspaceSwitch subscriber; rename
                                    clearAllBuffersForTests → clearForWorkspaceSwitch

apps/operator/lib/agent-tools/chat/ask_choice.ts
                                  ← handler rewritten as ctx.askUser wrapper
apps/operator/lib/chat-cards/registry.ts
                                  ← renderer onResponse signature
apps/operator/lib/chat-cards/AskChoiceCardEntry.tsx
                                  ← reads presentation; emits CardResponse
apps/operator/app/_components/chat/AskChoiceCard.tsx
                                  ← onAnswer → onResponse w/ action enum
                                    Skip button (action:'decline') when allowDecline≠false
                                    One-card-visible-at-a-time + queue indicator (L3)
apps/operator/app/_components/OperatorChat.tsx
                                  ← answerChoice() → /card-response
apps/operator/app/_components/OracleDock.tsx
                                  ← uses askUserLocal where applicable
apps/operator/app/api/operator/conversations/[id]/turn-answer/route.ts
                                  ← legacy adapter

apps/operator/lib/voice-engines/elevenlabs-conv.ts
                                  ← consumes fallbackText (additive)
papercup-rust-mobile/apps/voice/…
                                  ← consumes fallbackText (additive; TS Hono surface
                                    per feedback_mobile_targets_hono; NO TS DELETION)
```

### 4.9 Tests (PR 1)

**Unit (`packages/agent-mcp/`)**

| Test | Asserts |
|---|---|
| `workspace-lifecycle: subscribe + dispatch` | Multiple subscribers all called with workspaceId |
| `workspace-lifecycle: dispatch isolation` | One subscriber throwing does not block others |
| `state-channel: openCards snapshot shape` | Snapshot reflects PENDING contents |
| `state-channel: snapshot version monotonic` | Increments on every change |
| `card-correlator: register → resolve` | Deferred resolves with validated payload |
| `card-correlator: payload validation failure` | 400 returned from endpoint; deferred stays pending |
| `card-correlator: timeout resolves cancel` | After timeoutMs, action:'cancel' |
| `card-correlator: run-end cascade` | All pending cards under runId → cancel |
| `card-correlator: workspace-switch cancel` | onWorkspaceSwitch invoked → cancel pending |
| `card-correlator: idempotency key cache hit` | Second call with same key returns cached response, no emit |
| `card-correlator: card snapshot republished` | PENDING change → state-snapshot re-emitted |
| `ask-user: emit shape` | state-snapshot payload matches wire schema |
| `ask-user: decline path` | `{action:'decline'}` resolves with that shape |
| `ask-user: cancel rejects via abort` | run abort → AbortSignal fires + cancel |
| `ask-user: card not on event ring buffer` | event-channel listener sees NO card events |
| `ask-user: 'card' reserved at register time` | Plugin declaring events:{card} throws (H1) |
| `dispatch-projected: askUser interleaved with emit` | Tool can emit progress + askUser concurrently |

**Integration (`apps/operator/`)**

| Test | Asserts |
|---|---|
| `chat:ask_choice round-trip via askUser` | Old args → new path → same output shape |
| `/card-response: submit` | 200, deferred resolved, run continues |
| `/card-response: decline` | 200, handler sees `{declined: true}` |
| `/card-response: validation fail` | 400, body includes Zod error |
| `/card-response: no cookie` | 401 (H3) |
| `/card-response: rate-limit 30 RPS` | 429 on 31st request within window (H3) |
| `/turn-answer legacy adapter` | Old POST body resolves new correlator |
| `OracleDock: askUserLocal` | No network; tab state mutated; response delivered |
| `Voice: chat:ask_choice via fallbackText` | EL converse reads prompt, captures spoken answer |
| `Reconnect mid-card: open card visible` | snapshot delivered; user sees card (H2) |
| `Reconnect after card answered: NO re-prompt` | snapshot omits resolved correlationId (H2) |

Target: agent-mcp **≥210/≥210** (currently 167); operator **≥420/≥421** (one pre-existing).

### 4.10 PR 1 commit breakdown

Worktree: `../papercup-bespoke-4-askuser`. Branch: `phase-4-bespoke-4-askuser`.

| Commit | Scope |
|---|---|
| 1 | Types: `CardSpec`, `CardResponse`, `CardPresentation` in `types.ts`. No behavior. |
| 2 | `workspace-lifecycle.ts` + tests (H4 hook in isolation). |
| 3 | `replay-buffer.ts` migrates to `onWorkspaceSwitch`; rename `clearAllBuffersForTests` → `clearForWorkspaceSwitch`. |
| 4 | `state-channel.ts` minimal (openCards snapshot only) + tests. |
| 5 | `card-correlator.ts` + tests (PENDING, lifecycle, idempotency). |
| 6 | `ctx.askUser` on `UnifiedToolContext`; reserve `'card'` event name (H1); dispatch wiring; unit tests. |
| 7 | `/card-response` route + session-cookie auth + rate limit (H3) + route tests. |
| 8 | `chat:ask_choice` rewritten as `ctx.askUser` wrapper; integration test. |
| 9 | Client: AskChoiceCard onResponse signature + Skip button + one-at-a-time queue (L3). OperatorChat → `/card-response`. |
| 10 | `askUserLocal` companion (M6) + OracleDock migration. |
| 11 | `/turn-answer` legacy adapter (deprecated). |
| 12 | Docs: `content/docs/endpoint-system/ask-user.mdx`. |

### 4.11 Design notes anchored to T4 absorption + review

- Correlation IDs **must be UUIDs** (`crypto.randomUUID()`), not `${prefix}-${Date.now()}`.
- `/card-response` **accepts any runId in the workspace**, not just the "current" run.
- **Timeout path shipped in v1.**
- **Idempotency key shipped in v1.**
- **`'card'` is a reserved event name** (H1) — validator at `tool-projection.ts:539` rejects at register time.
- **Cards live on the state channel** — they are not in the event ring buffer (H2). No replay-as-history for cards.
- **Single `onWorkspaceSwitch` hook** (H4) wires all three subscribers.

---

## 5. Improvement #1 — `ctx.publishState` (v1: snapshot-only)

### 5.1 API surface (v1)

```ts
interface UnifiedToolContext<S = unknown> {
  // ... events: ctx.emit
  // ... cards: ctx.askUser
  publishState(snapshot: S): void;  // v1: full snapshot only
  // publishState(delta: JsonPatch): void;  // v1.1, deferred
}

interface ProjectedTool<I, O, S = never> {
  // ...
  state?: ZodType<S>;
}
```

**Behavior (v1):**
- Tool declares `state: z.object({...})` at `defineTool` time.
- Mode is fixed at register time (M5): tools with `state` schema get the state channel, never a ring buffer.
- Every `publishState(snapshot)` validates against schema, replaces current.
- Snapshot stored in `Map<runId, currentSnapshot>`; retained 5 min after run-end.
- Calling `publishState` on a tool without a `state` schema throws (M2).
- Calling `publishState` with anything other than a full snapshot in v1 throws (M2 — patches not yet supported).

### 5.2 Wire shape

```jsonc
{
  "type": "state-snapshot",
  "payload": {
    "runId": "…",
    "version": 1,
    "snapshot": {
      "openCards": [...],   // managed by card-correlator
      "toolState": { ... }  // managed by publishState
    }
  }
}
```

**Versioning:** monotonic per-run. Client tracks version; gap → request resync. Replay-on-reconnect = "send latest snapshot at current version," never event history.

### 5.3 Two-channel contract (post-H2)

| Channel | API | Wire event | Replay strategy |
|---|---|---|---|
| **Events** | `ctx.emit(name, payload)` | typed-events (`progress`, `text-delta`, …) | Ring buffer history (T2.2) |
| **State** | `ctx.askUser`, `ctx.publishState` | `state-snapshot` | Current snapshot only |

A tool may use either or both. State-shaped tools (declared `state` schema OR any tool that calls `ctx.askUser`) get a state channel. The runtime maintains exactly one snapshot per run.

### 5.4 File scope (PR 2)

```
NEW:
packages/agent-mcp/src/
  state-publisher.ts          ← Map<runId, snapshot>; v1 snapshot-only
  state-publisher.test.ts

MODIFIED:
packages/agent-mcp/src/
  types.ts                    ← ProjectedTool.state; UnifiedToolContext.publishState
  define-tool.ts              ← state schema plumbed
  tool-projection.ts          ← publishState wiring; throw if no state schema
  state-channel.ts            ← (PR 1) extended to merge openCards + toolState
  dispatch-projected.ts       ← state-snapshot emit for publishState
  replay-buffer.ts            ← skip ring-buffer init when state schema present (M5)
  workspace-lifecycle.ts      ← subscribe state-snapshot cleanup

apps/operator/lib/agent-tools/search/semantic.ts
                              ← first state-shaped tool (proof point)
apps/operator/app/_components/…  ← client decoder for toolState merge
libs/sse/src/                  ← +4 tests for new event types (L6)
```

### 5.5 Tests (PR 2)

| Test | Asserts |
|---|---|
| `publishState: snapshot validated against schema` | Bad shape throws synchronously |
| `publishState: throws if no state schema declared` (M2) | Tool author error caught at runtime |
| `publishState: throws on non-snapshot input in v1` (M2) | Patch shape rejected until v1.1 |
| `publishState: latest snapshot delivered on reconnect` | One snapshot, no history |
| `publishState: state outlives disconnect` | Tool mutates while disconnected; reconnect resumes |
| `publishState: workspace-switch drops snapshots` | onWorkspaceSwitch cleanup wired (H4) |
| `publishState: 5-min retention after run-end` | Snapshot queryable for 5 min |
| `state-channel: openCards + toolState merge` | Snapshot has both keys |
| `replay-buffer: state-shaped tools opt out at register` (M5) | No buffer created |
| `search:semantic integration: state delivered` | Snapshot reflects tool progress |
| `libs/sse decoder: state-snapshot event` (L6) | Decodes correctly |

---

## 6. Improvement #3 — Schema/UI separation

### 6.1 Shape

```ts
interface CardSpec<T extends ZodTypeAny> { /* §4.1 */ }

type CardPresentation =
  | { kind: 'radio';    options: PresOption[] }
  | { kind: 'checkbox'; options: PresOption[] }
  | { kind: 'text';     placeholder?: string; multiline?: boolean }
  | { kind: 'date';     min?: string; max?: string }
  | { kind: 'slider';   min: number; max: number; step?: number };

interface PresOption {
  id: string;
  label: string;
  hint?: string;
  style?: 'default' | 'primary' | 'danger';
}
```

### 6.2 Migration

`CardSpec` lands in PR 1 with at minimum the `radio` and `checkbox` shapes (used by `chat:ask_choice`). PR 3 adds the rest (`text`, `date`, `slider`) + their renderers in `AskChoiceCard` (which is renamed conceptually to a generic CardRenderer, but the file stays).

### 6.3 Voice modality (T3.1 integration)

- Web/desktop reads `presentation` + `prompt` + `dataSchema`.
- Voice reads `fallbackText` (or `prompt` if absent) + `dataSchema` for response validation.
- Per-emit modality, not just per-tool (extends T3.1).

### 6.4 File scope (PR 3)

```
MODIFIED:
packages/agent-mcp/src/types.ts        ← presentation discriminated union complete
apps/operator/app/_components/chat/AskChoiceCard.tsx
                                        ← reads presentation kinds (radio/checkbox land in PR 1;
                                          text/date/slider in PR 3)
apps/operator/lib/chat-cards/AskChoiceCardEntry.tsx
                                        ← presentation-aware
apps/operator/lib/voice-engines/elevenlabs-conv.ts
                                        ← fallbackText path
```

### 6.5 Tests (PR 3)

| Test | Asserts |
|---|---|
| Radio rendering matches today's UI | No regression |
| Checkbox + Submit matches today's UI | No regression |
| Text presentation renders TextField | New |
| Date presentation renders DatePicker | New |
| Slider presentation renders Slider | New |
| Voice: fallbackText used when present | TTS reads expected text |
| dataSchema server-validation | Bad payload → 400 |

---

## 7. Improvement #2 — `submit` / `decline` / `cancel`

### 7.1 Shape

(Already shown in §4.1.) `CardResponse.action: 'submit' | 'decline' | 'cancel'`.

**Why `submit` not `accept`** (L4): `accept` is MCP elicitation's word; we're not on the MCP elicitation wire. `submit` reads more naturally for forms and confirms equally well. If we add the MCP bridge later, it's a single keyword translation in one adapter.

### 7.2 UI changes (PR 4)

- `AskChoiceCard` gains "Skip" affordance:
  - Single-select: small "Skip" link below options.
  - Multi-select: "Skip" button next to "Submit".
- `presentation.allowDecline: false` (in CardSpec) hides Skip.
- Chat-level "cancel run" UI sends `{action: 'cancel'}` to every open correlationId under the run.

### 7.3 Tool handler patterns

```ts
const r = await ctx.askUser(...);
switch (r.action) {
  case 'submit':  return doThing(r.payload);
  case 'decline': return doThingWithDefault();
  case 'cancel':  throw new Error('cancelled');
}
```

### 7.4 File scope (PR 4)

Depends on PR 3 for `CardPresentation`.

```
MODIFIED:
apps/operator/app/_components/chat/AskChoiceCard.tsx
                              ← Skip button; action propagation
apps/operator/app/api/operator/conversations/[id]/card-response/route.ts
                              ← validates action enum (already in PR 1; here just adds 'decline' UI test)
```

### 7.5 Tests (PR 4)

| Test | Asserts |
|---|---|
| Skip button → onResponse({action:'decline'}) | UI wires to action enum |
| allowDecline:false hides Skip | Renderer respects flag |
| Cancel-run cascades to open cards | All correlationIds receive cancel |
| Tool handler decline branch | `chat:ask_choice` returns `{declined: true}` |

---

## 8. Sequencing & PR map (post-L1)

```
   PR 1: #4 + state channel for cards + workspace-lifecycle hook
          (week 1)
         │
         ├─────────────────┐
         ▼                 ▼
   PR 2: #1 state    PR 3: #3 schema/UI
   (week 2)          (week 2, parallel)
         │                 │
         └────────┬────────┘
                  ▼
            PR 4: #2 actions UI
            (week 3)
                  │
                  ▼
            Audit rounds
            (~1 week, distributed across PRs)
```

| PR | Worktree | LOC est. | Calendar |
|---|---|---|---|
| 1 | `../papercup-bespoke-4-askuser` | ~1200 | Week 1 |
| 2 | `../papercup-bespoke-1-state` | ~700 | Week 2 (parallel w/ PR 3) |
| 3 | `../papercup-bespoke-3-schema-ui` | ~350 | Week 2 (parallel w/ PR 2) |
| 4 | `../papercup-bespoke-2-actions` | ~200 | Week 3 |

**Total honest:** ~3 weeks dev + ~1 week audit = ~4 weeks.

Per-turn commit discipline applies. All four PRs commit + push every turn.

---

## 9. Test pass criteria

| Surface | Current | After all 4 PRs |
|---|---|---|
| `@papercusp/agent-mcp` | 167/167 | ≥210/≥210 |
| `apps/operator` | 389/390 | ≥420/≥421 |
| `libs/sse` | 148/148 | **152/152** (+4 for new event types — L6) |
| Rust desktop | 45/45 | unchanged |
| `plugin-loader` | 122/122 | unchanged |

Audit-round protocol: every PR commit gets 1–2 audit rounds; expect 2–4 real bugs per PR. Budget ~6 days total.

---

## 10. Risks & open questions

### Risks

| Risk | Mitigation |
|---|---|
| `chat:ask_choice` migration breaks in-flight conversations | One release of `/turn-answer` legacy adapter; replay recorded conversations. |
| `askUser` ↔ `askUserLocal` divergence over time | Single `CardSpec`/`CardResponse` types; renderer is shared. |
| State-shaped tools leak memory | 5-min retention + workspace-switch cleanup + per-workspace 10MB cap (warn-log on eviction). |
| **Dev HMR drops pending cards (M4)** | Document; v1 accepts in-process loss. Same bound as current `/turn-answer`. |
| Multi-concurrent askUser UX cliff | **One card visible at a time, queue indicator** (L3). Snapshot-based renderer reads openCards[head]. |
| Card-state snapshot frequency under high-concurrency | Snapshot only re-emitted when openCards changes (mutation-driven), not periodic. |

### Open questions resolved (from v1)

1. Idempotency-key scope → **per-run.**
2. Persist non-`chat:ask_choice` cards → **yes, new `turns.kind = 'card'` for non-tool-triggered ones; for tool-triggered, the tool's own turn record carries the correlationId.**
3. State retention quota → **10MB per workspace soft cap, warn-log on eviction.**
4. Skip-button wording → **defer to PR 4 visual decision.** Initial: "Skip".
5. `/card-response` auth → **session cookie + 30 RPS rate limit (H3).**

### Remaining open

1. **JSON Patch delta format** — deferred to v1.1 (M1). When it lands: benchmark `fast-json-patch` vs hand-roll at realistic state sizes.
2. **Cross-process correlator persistence** — accepted as in-process loss in v1 (M4). Reconsider if dev HMR or prod restarts become painful.

---

## 11. What collapses out of the Phase 4 plan

| Original Phase 4 item | Status |
|---|---|
| T4.1 bidirectional `ctx.awaitResponse` | **Shipped as PR 1.** No standalone T4.1. |
| T4.2 shared-memory IPC | **Still deferred.** Orthogonal; no driver. |
| T4.3 long-lived disconnected tools | **Shipped as PR 2** (state-shaped tools survive disconnect by construction). |
| T2.2 replay-buffer | **Retained for event-shaped tools.** State-shaped tools skip at register time. |
| T2.1 chat-cards registry | **Retained, thinned.** Becomes renderer layer over `CardSpec`. |
| T2.3 scratch URIs | **Unchanged.** `CardSpec.fallbackText` may reference `papercusp://`. |
| T3.1 modality | **Unchanged at tool level; extended per-emit via `fallbackText`.** |

The Phase 4 plan doc (`phase-4-endpoint-system-2026-05-12.md`) will be marked "T4.1/T4.3 superseded by bespoke-card-improvements-2026-05-13.md" after PR 2 lands.

---

## 12. Out-of-band cleanup post-merge

- `apps/operator/content/docs/endpoint-system/ask-user.mdx` (PR 1).
- `apps/operator/content/docs/endpoint-system/state-tools.mdx` (PR 2).
- `apps/operator/content/docs/endpoint-system/voice-modality.mdx` updated for `fallbackText` (PR 3).
- Memory updates:
  - New: `project_bespoke_card_system.md` summarizing shipped contract.
  - Update: `project_session_2026-05-12_plans_1234.md` with arc closeout.

---

## 13. `onWorkspaceSwitch` lifecycle hook (H4)

`packages/agent-mcp/src/workspace-lifecycle.ts`:

```ts
type WorkspaceSwitchCallback = (workspaceId: string) => void | Promise<void>;

const SUBSCRIBERS = new Set<WorkspaceSwitchCallback>();

export function onWorkspaceSwitch(cb: WorkspaceSwitchCallback): () => void {
  SUBSCRIBERS.add(cb);
  return () => SUBSCRIBERS.delete(cb);
}

export async function dispatchWorkspaceSwitch(workspaceId: string): Promise<void> {
  const errors: unknown[] = [];
  for (const cb of SUBSCRIBERS) {
    try {
      await cb(workspaceId);
    } catch (e) {
      errors.push(e);
    }
  }
  if (errors.length) {
    // log but do not throw; one subscriber failure must not block others
    console.warn('[workspace-lifecycle] subscriber errors', errors);
  }
}

/** Test-only flush. */
export function _resetWorkspaceLifecycleForTests(): void {
  SUBSCRIBERS.clear();
}
```

Subscribers wired in:
- `replay-buffer.ts`: `onWorkspaceSwitch(clearRingBuffersForWorkspaceSwitch)` (renamed from T2.2's `clearAllBuffersForTests`).
- `card-correlator.ts`: `onWorkspaceSwitch(cancelPendingCardsForWorkspaceSwitch)`.
- `state-publisher.ts` (PR 2): `onWorkspaceSwitch(dropStateSnapshotsForWorkspaceSwitch)`.

Caller (operator on session/workspace change) invokes `dispatchWorkspaceSwitch(newWorkspaceId)`.

---

## Appendix A — v2 change log (from review)

| Issue | Resolution |
|---|---|
| H1 | `'card'` added to RESERVED_EVENT_NAMES; register-time test (§4.11, §4.9). |
| H2 | Pending cards live on state channel, not ring buffer (§4.2, §4.3, §5.3, §3 diagram). |
| H3 | `/card-response` session-cookie auth + 30 RPS rate limit + 401 test (§4.5, §4.9). |
| H4 | Single `onWorkspaceSwitch(workspaceId)` hook + 3 subscribers (§13). |
| M1 | v1 is snapshot-only; deltas deferred to v1.1 (§5.1, §10). |
| M2 | publishState throws if no state schema OR if input is not a full snapshot in v1 (§5.1). |
| M3 | Resolved by M1 (snapshot-only). |
| M4 | Dev HMR loss documented; in-process only in v1 (§10 risks). |
| M5 | State mode declared at `defineTool` time; no per-call branch (§5.1, §5.5). |
| M6 | `ctx.askUser` (server, tool flows) vs `askUserLocal` (client, render-time) boundary explicit (§4.4). |
| L1 | PR sequencing: PR 1 → (PR 2 ‖ PR 3) → PR 4 (§8). |
| L2 | Audit budget added: ~6 days; total honest ~4 weeks (§8, §9). |
| L3 | Multi-concurrent UX: one visible, queue indicator (§4.7, §10). |
| L4 | `submit` not `accept` (§4.1, §7). |
| L5 | mobile-voice path: TS Hono, additive only (§4.7). |
| L6 | libs/sse: +4 tests for new event types (§5.4, §9). |
