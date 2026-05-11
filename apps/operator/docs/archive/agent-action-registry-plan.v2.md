# Agent Action Registry — Implementation Plan

**Status:** draft v2 — reviewer feedback applied
**Scope:** unify the three agent tool surfaces (Oracle, Operator, Pi) plus
the user-facing surfaces (keyboard shortcuts, ⌘K command palette) under a
single typed registry of commands (side-effects) and queries (reads).
**Non-goals (this plan):** generic DOM clicker, free-text input tools, drag/
resize gestures, multi-step workflows. These are deliberately out of scope.

**v2 deltas (vs v1):**
- §2.1 — `browser` is now a tristate (`'required' | 'optional' | 'none'`) not a boolean; replaces `requiresBrowser`.
- §2.1 — `concurrent` field added to `CommandDef`.
- §2.1 — `runCommand` returns a `CommandResult<T>` discriminated union; never throws to LLM consumers.
- §2.4 (new) — schema → JSON-Schema conversion is named (`zod-to-json-schema`); forbidden Zod constructs listed.
- §3 (new sub-section) — workspace scoping is part of `ctx`; not threaded through args.
- §3 (new sub-section) — multi-tab arbitration via voice-leader-election; "the session" defined as `(workspace, leader-tab-id)`.
- §4 PR 1 — adds the `run-command` HTTP endpoint and the leader-bridge skeleton up front, even though Pi doesn't call it yet (pressure-tests the cross-process design).
- §5 — alias strategy is dropped; renames are hard cutovers in the same PR that updates each agent's prompt.
- §6 — adds an `agent_queries` table for sampled query audit, alongside the original `agent_actions` for commands.
- §7 — concurrency, prompt drift, and import-cycle risks added.
- §10 — reframed as "PR 1 alone is shippable" (not a parallel quick path).

---

## 1. Why

Today the same "thing the user can do" is implemented 2–3 times:

- **Open the operator panel** → `operator.toggle` shortcut + Operator's
  `open_operator` tool + (no palette entry).
- **Navigate to a route** → Oracle's `navigate` tool + every component's own
  `RouteLink` + the `goto.*` shortcuts.
- **Read harness status** → Oracle's `getHarnessStatus` tool + Pi's
  `status` tool (different schemas, same data).

Three downstream symptoms:

1. *Asymmetric capabilities.* Operator can `open_operator` but can't close
   itself. Pi can read but can't act. Oracle can navigate but can't toggle
   panels.
2. *Drift between callers.* `operator.toggle` calls
   `broadcastState({open: !sharedState.open})` directly; `open_operator`
   dispatches a window event. They both work today; they will not stay in
   sync forever.
3. *No audit surface.* LLM tool invocations are scattered across three
   transports (HTTP / WebRTC / stdio MCP). There's no single log of "what
   actions did agents take this session."

A registry doesn't add new functionality. It removes duplication and gives
us one place to add new functionality, audit, and gate per-agent.

---

## 2. Shape

### 2.1 Two flavors

```ts
// lib/commands/types.ts
export type AgentId = 'oracle' | 'operator' | 'pi' | 'palette' | 'shortcut';

/** How a command relates to a live browser session. */
export type BrowserRequirement =
  | 'required'   // panel.toggle — useless without a browser
  | 'optional'   // chat.dispatch — server writes the row, browser updates if present
  | 'none';      // harness.start — server-side process, no browser involvement

/** Concurrency policy when multiple callers fire the same command id. */
export type Concurrency =
  | 'allow'      // panel.toggle — safe to fire in parallel (idempotent)
  | 'queue'      // harness.start — serialize; second call waits for first
  | 'deny';      // harness.delete — second concurrent call returns conflict

export interface CommandDef<Args = unknown, Result = unknown> {
  id: string;                          // e.g. 'panel.toggle'
  kind: 'command';                     // mutating
  description: string;                 // ≤200 chars, shown to LLMs + ⌘K
  promptDescription?: string;          // longer agent-facing description, used by buildSystemPrompt
  schema: ZodSchema<Args>;             // arg validation (see §2.4 for constraints)
  agents: AgentId[];                   // who's allowed to invoke
  browser: BrowserRequirement;
  concurrent?: Concurrency;            // default 'allow'
  paletteEntry?: { section: string; title: string; icon?: string; keywords?: string };
  handler: (args: Args, ctx: CommandContext) => Promise<Result> | Result;
}

export interface QueryDef<Args = unknown, Result = unknown> {
  id: string;                          // e.g. 'harness.status'
  kind: 'query';                       // pure read
  description: string;
  promptDescription?: string;
  schema: ZodSchema<Args>;
  agents: AgentId[];
  audit?: 'none' | 'sample' | 'full';  // default 'sample' (see §6)
  handler: (args: Args, ctx: CommandContext) => Promise<Result> | Result;
}

export interface CommandContext {
  agent: AgentId;
  workspace: string;                   // see §3.2 — every handler gets this
  sessionId?: string;                  // browser session for browser=required commands
  requestId: string;                   // for audit correlation
}

export type Definition = CommandDef | QueryDef;

/** Result shape returned to all callers. Errors are values, never thrown. */
export type CommandResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: CommandErrorPayload };

export interface CommandErrorPayload {
  code: string;                        // 'no-active-session', 'denied', 'conflict', 'invalid-args', 'internal'
  message: string;                     // human-readable, safe to show
  hint?: string;                       // actionable, agent-facing
  retryable: boolean;
}

/** Handlers throw this; registry wraps anything else as code:'internal'. */
export class CommandError extends Error {
  constructor(public payload: CommandErrorPayload) { super(payload.message); }
}
```

The `kind` split matters because:
- Commands need audit logging, can be denied by gates, may show
  confirmation UI, and are the things "real users" trigger via clicks.
- Queries are cacheable, retriable on the LLM side, free of side-effects,
  and the natural layer for cross-process boundaries (Pi can read remote
  state without needing a browser session).

### 2.2 Registry

```ts
// lib/commands/registry.ts
const defs = new Map<string, Definition>();
const inflight = new Map<string, Promise<unknown>>();   // for 'queue' / 'deny'

export function register(def: Definition): void {
  if (defs.has(def.id)) throw new Error(`duplicate command id: ${def.id}`);
  defs.set(def.id, def);
}

export function get(id: string): Definition | undefined { return defs.get(id); }

export function list(filter?: { kind?: 'command' | 'query'; agent?: AgentId }): Definition[] {
  return [...defs.values()].filter(d => {
    if (filter?.kind && d.kind !== filter.kind) return false;
    if (filter?.agent && !d.agents.includes(filter.agent)) return false;
    return true;
  });
}

export async function runCommand<T = unknown>(
  id: string,
  args: unknown,
  ctx: CommandContext,
): Promise<CommandResult<T>> {
  const def = defs.get(id);
  if (!def || def.kind !== 'command')
    return err('unknown', `no such command: ${id}`, false);
  if (!def.agents.includes(ctx.agent))
    return err('denied', `agent ${ctx.agent} not authorized for ${id}`, false);

  // Schema validation
  const parsed = def.schema.safeParse(args ?? {});
  if (!parsed.success)
    return err('invalid-args', parsed.error.message, false);

  // Browser-requirement gate. Commands that need a browser but are called
  // from a context without one (Pi, server-side cron) get a structured
  // 'no-active-session' before the handler ever runs. The shim that has
  // a back-channel can pre-resolve the session and pass it via ctx; if
  // sessionId is set, the gate is satisfied.
  if (def.browser === 'required' && !ctx.sessionId)
    return err('no-active-session', 'this command needs an open browser tab', true,
               'ask the user to open the workspace in a browser');

  // Concurrency
  const policy = def.concurrent ?? 'allow';
  if (policy !== 'allow') {
    if (inflight.has(id)) {
      if (policy === 'deny')
        return err('conflict', `${id} is already running`, true);
      // 'queue' — wait for the in-flight call, then run
      try { await inflight.get(id); } catch { /* prior failure shouldn't block us */ }
    }
  }

  const t0 = Date.now();
  const auditRow = { kind: 'command', id, agent: ctx.agent, workspace: ctx.workspace,
                     args: parsed.data, requestId: ctx.requestId };
  const promise = (async () => {
    try {
      const value = await def.handler(parsed.data, ctx) as T;
      audit({ ...auditRow, status: 'ok', durationMs: Date.now() - t0 });
      return ok(value);
    } catch (e: any) {
      const payload = e instanceof CommandError
        ? e.payload
        : { code: 'internal', message: 'handler threw', retryable: false };
      audit({ ...auditRow, status: 'err', error: payload.code, durationMs: Date.now() - t0 });
      return { ok: false as const, error: payload };
    }
  })();
  if (policy !== 'allow') inflight.set(id, promise.finally(() => inflight.delete(id)));
  return promise;
}

export async function runQuery<T = unknown>(
  id: string,
  args: unknown,
  ctx: CommandContext,
): Promise<CommandResult<T>> {
  // …same shape, no concurrency gate, audit policy per-def (see §6).
}

function ok<T>(value: T): CommandResult<T> { return { ok: true, value }; }
function err(code: string, message: string, retryable: boolean, hint?: string): CommandResult<never> {
  return { ok: false, error: { code, message, hint, retryable } };
}
```

`audit()` writes to `harness_shared.agent_actions` for commands and the
sampled `harness_shared.agent_queries` for queries (§6).

Critical property: **runCommand never throws to its caller.** Every error
becomes a `CommandResult.ok=false` payload. Shims that emit this to
LLMs serialize it as their transport's preferred error shape (MCP
`isError: true`, OpenAI Realtime tool error, etc.) — all from the same
`CommandErrorPayload`.

### 2.3 Catalog file structure

```
apps/operator/lib/commands/
  registry.ts            # the engine above
  types.ts               # CommandDef, QueryDef, AgentId
  audit.ts               # audit() impl, batched insert into PG
  defs/
    panel.ts             # panel.toggle, panel.open, panel.close
    nav.ts               # navigate, navigate.panel
    voice.ts             # voice.set-mode, voice.set-engine
    harness.ts           # harness.start, harness.stop, harness.scan,
                         # harness.status (query), harness.list-features (q),
                         # harness.lineage (q), harness.audit (q),
                         # harness.proposals (q), harness.decisions (q)
    workspace.ts         # workspace.list (q), workspace.switch
    chat.ts              # chat.list (q), chat.dispatch, chat.resume
    palette.ts           # palette.toggle, palette.run
  shims/
    palette-shim.ts      # render registry → ⌘K palette items
    shortcut-shim.ts     # bind shortcuts to commands
    oracle-shim.ts       # generate Oracle MCP tool defs
    operator-shim.ts     # generate Realtime SDK tool defs
    pi-shim.ts           # generate Pi MCP tool defs
```

Each `defs/*.ts` file calls `register()` at module load. The shims read
the registry and emit transport-specific tool catalogs. Adding a new
command is one diff in `defs/`; the shims pick it up automatically.

**Import discipline.** `defs/*.ts` files run for side-effect
(`import 'lib/commands/defs/panel'`) and call `register()` at top level.
They MUST NOT import each other or import from anywhere that imports the
registry transitively — that's how import cycles bite. Convention: defs
import only from `lib/commands/types`, the side-effect targets they wrap
(`operator-shared-state`, `voice-mode`, harness-state), and `zod`. A
`defs/index.ts` does the side-effect imports in a stable order and
optionally re-exports a typed catalog (`Commands.panel.toggle:
CommandDef<…>`) for autocomplete.

### 2.4 Schema → tool-spec translation

Each shim converts `def.schema` to the transport's expected schema format:

- **MCP tools** (Oracle, Pi): JSON Schema. Use **`zod-to-json-schema`**.
- **OpenAI Realtime tools** (Operator): the SDK's `tool({...})` accepts
  Zod directly via `parameters`, no conversion needed.

Forbidden Zod constructs (don't translate cleanly to JSON Schema /
become invisible to the LLM):

- `.transform()` — runtime-only, not in the schema. Use a separate
  validation/normalization step inside the handler.
- `.refine()` with logic the LLM can't see — same reason. OK to use for
  internal sanity checks; describe the constraint in `description` so
  the LLM can satisfy it.
- Branded types — opaque to the LLM, no benefit at the boundary.
- `z.union` of incompatible literal shapes that the LLM has to pick by
  presence — flatten or split into separate commands.

A unit test enumerates every registered def and asserts
`zod-to-json-schema(def.schema)` doesn't throw and produces a
non-empty object. Catches misuse at import time.

---

## 3. Side-effect routing — same-process vs. cross-process

### 3.1 Process boundaries

The hard part is that Pi runs in a *separate process* from the browser
(`node-pty` subprocess containing claude/omp, which spawns the
papercusp-mcp-server). Side-effect commands have to land in the right
process.

| Command | Where the side-effect lives | Same-process from Oracle? | Same-process from Operator? | Same-process from Pi? |
|---|---|---|---|---|
| `panel.toggle` | Browser DOM (operator-shared-state) | Yes (oracle-mcp-server runs in operator app) | Yes (browser) | **No** |
| `navigate` | Browser router | Yes | Yes | **No** |
| `voice.set-mode` | Browser voice-mode singleton | Yes | Yes | **No** |
| `harness.start` | Server-side process (`overmind start`) | Yes | Yes (HTTP) | Yes (HTTP) |
| `harness.scan` | Server-side scan job | Yes | Yes (HTTP) | Yes (HTTP) |
| `chat.dispatch` | Server-side chat write | Yes | Yes (HTTP) | Yes (HTTP) |
| `harness.status` (query) | DB read | Yes | Yes (HTTP) | Yes (HTTP) |

So commands split into two buckets:

**A) Server-side commands** — the handler is an API call. Works from any
agent, regardless of browser presence. ~70% of useful actions live here.
`harness.start/stop/scan`, `chat.dispatch`, `proposal.accept`,
`workspace.switch`, all queries.

**B) Browser-only commands** — the handler is in-page state mutation.
Needs a live browser session. `panel.toggle`, `navigate`, `voice.set-mode`,
maximize/minimize panels, dismiss toasts. ~30%.

The registry tags each command with `requiresBrowser: boolean`. Each shim
reads it:

- **Palette / shortcut shims** — always in browser, ignore the flag.
- **Oracle shim** — Oracle's MCP server runs in the operator app's Node
  process *and* has a WS bridge to a specific browser session.
  `requiresBrowser: true` commands get a "find this Oracle's browser
  session and post the request" wrapper.
- **Operator shim** — always in browser (Realtime SDK runs in-page).
  Ignores the flag.
- **Pi shim** — exposes only `requiresBrowser: false` definitions in the
  initial cut. Browser-only commands return `{ error: 'not-available-from-pi' }`
  with a hint to ask the user via Oracle/Operator.

This is **Option A → B from my prior message**. Option C (Pi back-channel
to drive a browser session) is a future extension; the registry already
supports it via `browser: 'required'` — we just don't wire the back-channel
fully yet. PR 1 lands the skeleton (HTTP endpoint + leader-resolver
returning `503 no-active-session`), so the contract is real and gets
pressure-tested even before any caller uses it.

### 3.2 Workspace scoping

Per repo memory (`workspace_scoping_boundary`), workspaces are
**filesystem-only** (PG state is global, scoped per-row by `workspace`
column). Every command/query handler that touches `harness_shared.*`
must filter on workspace, or it leaks across workspaces.

The registry threads workspace through `ctx`:

```ts
runCommand('harness.start', { slug }, { agent: 'oracle', workspace: 'default', requestId, sessionId });
```

Workspace is **never an argument to the LLM** — the LLM doesn't pick
which workspace, the calling agent's session does. Each shim derives it:

- **Palette / shortcut** — current `useWorkspace()` value at the moment
  the action is invoked.
- **Oracle / Operator** — derived from the active workspace of the
  browser session that holds the LLM connection.
- **Pi** — passed via env var when the pty was spawned (`PAPERCUSP_WORKSPACE`),
  per the existing pty-bridge convention. The papercusp-mcp-server reads
  it and stamps it on every outbound `runCommand` / `runQuery`.

A CI test loads every registered def, mounts it against a mock
workspace, and asserts the result doesn't reference rows from a
different workspace. Catches handlers that forget the filter.

### 3.3 Multi-tab session arbitration

For `browser: 'required'` commands, the registry needs to pick a tab
to dispatch to. There can be 0 (no tabs open), 1, or N tabs open on the
same workspace.

**Election:** the codebase already has `voice-leader.ts` doing
BroadcastChannel-based leader election among tabs of the same workspace.
Reuse it. The leader tab registers its presence with the operator app's
server-side session registry on election win and on every heartbeat
(~5s). Followers don't register.

**Session registry** (new, in-memory in the operator Node process):

```
Map<workspace, { sessionId, lastSeen, deliver: (cmd) => Promise<CommandResult> }>
```

`deliver` is a per-session SSE channel: when an in-process caller
(Oracle MCP, or the cross-process HTTP endpoint) needs to run a
`browser: 'required'` command, it looks up the workspace's leader,
posts the command over SSE, awaits the result, returns it.

**Failure modes the registry handles:**

- 0 tabs open for the workspace → `{ok: false, error: {code:'no-active-session', retryable: true, hint: 'open the workspace in a browser'}}`. Caller decides whether to retry or surface to the user.
- Leader tab closes mid-command → 5s timeout on `deliver`, returns the same error.
- Leader changes mid-flight → command may be dispatched twice (once to the closing leader, once to the new one) for non-`'allow'` concurrency. Mitigated by `requestId`: handlers idempotent by request id where it matters; serializable commands marked `concurrent: 'queue'` get serialized at the new leader.
- 3 tabs same workspace → exactly one leader gets the command. Followers see the resulting state via the existing pub/sub (`operator-shared-state.broadcastState`), so the user's other tabs visually update.

**Cross-tab UX implication:** if the user has the operator open in tab A and Oracle answers a command in tab B's session, tab A sees the side-effect through the pub/sub. This is the same behavior as today's voice-leader-gated STT — tested pattern, no new mechanism.

**Pi specifically:** Pi's MCP shim only emits commands with `browser: 'none'` or `browser: 'optional'` until PR 6. So the multi-tab path is exercised by Oracle (in the same Node process, easy case) and the cross-process HTTP endpoint (Pi's eventual path), but not by Pi until we deliberately open that door.

---

## 4. Migration plan — six steps, six PRs

Each step is independently shippable, reverts cleanly, doesn't break the
preceding step's behavior.

### PR 1 — Registry + audit + leader-bridge skeleton + first command end-to-end

This PR lands the **complete spine** even though only a few commands flow
through it. The reviewer's point #1: pressure-test the cross-process
design now, when it's cheap; not in PR 6, when it's already been baked
around for months.

**Files:**

*Engine:*
- `lib/commands/types.ts` — types from §2.1
- `lib/commands/registry.ts` — engine from §2.2 (full version: result
  shape, concurrency gate, browser-requirement gate, schema validation)
- `lib/commands/audit.ts` — batched INSERT into
  `harness_shared.agent_actions` for commands and
  `harness_shared.agent_queries` for sampled queries. Migrations in
  `harness-state/migrations/`.

*Cross-process spine:*
- `lib/commands/session-registry.ts` — in-memory `Map<workspace, Session>`
  with `register/heartbeat/deliver`. Sessions register over an SSE
  channel mounted at the next file.
- `app/api/agent-mcp/run-command/route.ts` — `POST { id, args }` →
  resolves workspace from caller, calls `runCommand`. Returns
  `CommandResult` JSON. Used by the operator-shim cross-process bridge
  (PR 5+) — in PR 1 it just exists and returns `503 no-active-session`
  for `browser: 'required'` commands.
- `app/api/agent-mcp/run-command/sse/route.ts` — SSE channel a browser
  tab opens on workspace-load. Tab posts `register` (with workspace +
  sessionId), then waits for `runCommand` events streamed from the
  server, runs them in-page, posts results back via a sibling
  `result/route.ts`.
- `lib/commands/leader-bridge.ts` (browser) — connects to the SSE,
  registers the tab if it's voice-leader (reuses `voice-leader.ts`), runs
  received commands via `runCommand` (in-page registry), POSTs results.
  Handles disconnect/reconnect and leader-change events.

*First commands:*
- `lib/commands/defs/panel.ts` — `panel.toggle`, `panel.open`,
  `panel.close` (`browser: 'required'`,
  `agents: ['oracle','operator','palette','shortcut']`). Handlers call
  existing `operator-shared-state.broadcastState`.
- `lib/commands/shims/operator-shim.ts` — generates Realtime tool defs
  from the registry. Replaces inline tools in
  `lib/voice-engines/openai-realtime.ts:48-103`.
- The Operator's system prompt is updated to add `panel.close` to its
  tool list (no aliases — see §5).

**Deliberately NOT in PR 1:** Oracle shim, Pi shim, palette/shortcut
shims, any new commands beyond `panel.*`. Those come in subsequent PRs.

**Behavior change:** Operator gains `panel.close`. Otherwise transparent.

**Tests:**
- Unit: registry rejects unknown agents, schema-fails on bad args,
  enforces browser/concurrent gates, returns `CommandResult` (never
  throws).
- Unit: Zod-to-JSON-Schema validity for every registered def.
- Integration: Realtime SDK shim emits expected tool list (snapshot
  test); calling `panel.toggle` toggles `sharedState.open`.
- Integration: leader-bridge flow — open a headless tab, register it as
  workspace leader, POST `/api/agent-mcp/run-command panel.toggle`
  from a separate Node context, assert the headless tab's
  `sharedState.open` flips. This is the cross-process pressure test.
- Integration: with no tabs open, the same POST returns
  `{ok: false, error: {code: 'no-active-session', retryable: true}}`.

**Risk:** higher than the v1 plan said. Adds a new SSE channel and a
session-registry singleton. Mitigations:
- All v1 inline code paths preserved as a fallback flag
  (`AGENT_REGISTRY_ENABLED=false` returns to inline `tool({...})`). One
  env var to revert.
- Session registry is in-memory, no PG dependency to break.
- Leader-bridge ties into an existing tested mechanism (voice-leader);
  doesn't introduce new election logic.

### PR 2 — Oracle shim + read-side unification with Pi

**Files:**
- `lib/commands/defs/harness.ts` — registers all 7 of Pi's queries
  (`harness.status`, `harness.list-features`, `harness.lineage`,
  `harness.audit`, `harness.proposals`, `harness.decisions`,
  `harness.issues`). `agents: ['oracle','operator','pi']`. Handlers
  call existing harness-state read functions.
- `lib/commands/defs/chat.ts` — splits Oracle's old `dispatchToAgent` into:
  - `chat.dispatch` — server-side row insert + agent kick. `browser: 'optional'`. Works from Pi (PR 5+).
  - `chat.open-pane` — opens the chat panel in the browser to a given chatId. `browser: 'required'`.
  - `chat.list` — query, `browser: 'none'`.
  - `chat.resume` — convenience wrapper: `chat.open-pane(chatId)` from a list result. `browser: 'required'`.

  Oracle's prior `dispatchToAgent` becomes `chat.dispatch` + a follow-up
  `chat.open-pane` in the same prompt turn. The split is what enables
  Pi to dispatch to chats in PR 5 without needing the back-channel.
- `lib/commands/defs/nav.ts` — registers `navigate`,
  `navigate.panel`. Browser-only.
- `lib/commands/shims/oracle-shim.ts` — generates Oracle's MCP tool
  defs. Replaces inline tools in `lib/oracle-mcp-server.mjs`.
- `lib/commands/shims/pi-shim.ts` — generates Pi's MCP tool defs.
  Replaces inline tools in
  `libs/papercusp/packages/papercusp-mcp-server/src/index.js`. Filters
  to only `requiresBrowser: false` defs.

**Behavior change:** none. Existing Oracle and Pi tool names + schemas
preserved. Internally they now share a single set of handlers.

**Tests:**
- Snapshot test: Oracle's tool list matches the prior set verbatim (so
  no model-prompt breakage).
- Snapshot test: Pi's tool list matches the prior set verbatim.

**Bonus:** Oracle gains `harness.audit/proposals/decisions/issues` (Pi's
read tools) for free if we tag them with `agents: ['oracle','pi']`. The
prompt for Oracle has to mention them; do it in this PR or skip until
needed.

### PR 3 — Palette + shortcut shims

**Files:**
- `lib/commands/shims/palette-shim.ts` — exports a hook that returns
  `cs.push(...)`-compatible items for every command tagged
  `paletteEntry`. HarnessDashboard's CommandPalette switches to consume
  this.
- `lib/commands/shims/shortcut-shim.ts` — for any shortcut whose
  registry entry has a `command:` field, register a
  `useShortcutAction(id, () => runCommand(...))` automatically at app
  bootstrap.
- `lib/shortcut-registry.ts` — add optional `command?: string` and
  `commandArgs?: any` fields on entries. Migrate the obvious ones
  (`operator.toggle`, `goto.config`, etc.). Components can keep using
  `useShortcutAction(id, fn)` directly for shortcuts whose handler is
  more complex than a registry call.

**Behavior change:** palette items and shortcuts now route through the
audit log. No user-visible change.

**Migration scope:** ~10 of the existing ~30 palette items and ~7 of
the ~30 shortcuts. The rest can stay inline indefinitely; this is
opt-in per entry.

### PR 4 — `voice.set-mode` and `closePanel` are simple specific commands

`voice.set-mode({ mode })` and `panel.close({ panel: 'operator' })` get
registered. Both browser-only. Operator's prompt is updated to include
them. Fixes the original "Operator can't close itself" complaint properly
end-to-end.

(Could ride on PR 1 if we want the close fix sooner — see "Quick path"
below.)

### PR 5 — Server-side action expansion to Pi

Tag the server-side commands (`harness.start`, `harness.stop`,
`harness.scan`, `chat.dispatch`, `proposal.accept`,
`workspace.switch`) with `agents: ['oracle','operator','pi']`. Pi
shim begins emitting them. Test from a real claude subprocess that
the new tools show up and work.

This is where Pi gains action capability for the first time. Worth a
deliberate review pass — it's a meaningful expansion of Pi's authority.

### PR 6 — Optional: browser back-channel for Pi

Skip unless concrete workflows demand it. Implementation sketch:

- `operator-actions` endpoint already exists from PR 1. Add a server-side
  registry of "active browser sessions" keyed by workspace, populated by
  the workspace-switcher's existing heartbeat.
- When Pi's shim is asked to run a `requiresBrowser: true` command, it
  picks the most recent session for the workspace, posts the command to
  it via SSE, awaits ack. Timeout → "no live browser, please open one."

Adds latency + a real failure mode. Defer until needed.

---

## 5. Tool naming and prompt cutover

Current tool names across the three agents are inconsistent:

- Oracle: camelCase verbs (`listHarnesses`, `getHarnessStatus`).
- Operator: snake_case verbs (`open_operator`, `across_workspaces`).
- Pi: snake_case nouns (`status`, `list_features`).

Pick one and stick with it. Recommended: **`namespace.action`** (dotted,
kebab inside parts). `harness.status`, `panel.close`, `voice.set-mode`,
`chat.list`. Reads well, easy to filter (`harness.*`), no model
confusion.

**No aliases.** v1 of this plan proposed runtime aliases for one release;
the reviewer correctly pointed out this is wrong: the LLM's *system
prompt* is the source of truth for what tool names it tries. If the
prompt says `getHarnessStatus`, the model will keep calling it whether
or not we add `harness.status` runtime aliases. Aliasing only stops the
runtime from crashing, not the LLM from picking inconsistent names.

So renames are **hard cutovers in the same PR that updates the agent's
system prompt.** Each migration PR (PR 2 for Oracle, PR 3 for palette,
PR 4 for Pi, PR 5 for Operator) includes both:

1. The shim change (registry-generated tool list with new names).
2. The agent's system prompt diff (replace old names with new names).

This means in-flight LLM sessions running on an old prompt may briefly
see "unknown tool" errors during deploy. Acceptable — the registry's
structured `CommandResult` makes the error self-describing, and the
LLM rolls forward.

Snapshot tests on the prompt files keep them honest: a CI test asserts
that every tool name mentioned in `apps/operator/prompts/oracle.md`
exists in the registry with `agents.includes('oracle')`.

---

## 6. Audit tables

Two tables, different audit policies — the reviewer's point #3: queries
ARE the reasoning trail, dropping them entirely loses too much signal.

**Commands** (every invocation, full args, full status):

```sql
CREATE TABLE IF NOT EXISTS harness_shared.agent_actions (
  id          BIGSERIAL PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  agent       TEXT NOT NULL,           -- 'oracle' | 'operator' | 'pi' | 'palette' | 'shortcut'
  command_id  TEXT NOT NULL,           -- 'panel.toggle' etc.
  args        JSONB NOT NULL DEFAULT '{}'::jsonb,
  status      TEXT NOT NULL,           -- 'ok' | 'err' | 'denied' | 'no-session' | 'conflict'
  error_code  TEXT,                    -- error.code from CommandErrorPayload, NULL if ok
  duration_ms INT,
  workspace   TEXT,
  session_id  TEXT,
  request_id  TEXT
);
CREATE INDEX ON harness_shared.agent_actions (ts DESC);
CREATE INDEX ON harness_shared.agent_actions (agent, ts DESC);
CREATE INDEX ON harness_shared.agent_actions (command_id, ts DESC);
CREATE INDEX ON harness_shared.agent_actions (workspace, ts DESC);
```

**Queries** (sampled by default, compact rows):

```sql
CREATE TABLE IF NOT EXISTS harness_shared.agent_queries (
  id          BIGSERIAL PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  agent       TEXT NOT NULL,
  query_id    TEXT NOT NULL,
  args_compact JSONB,                  -- only kept for audit:'full' defs
  workspace   TEXT,
  request_id  TEXT
);
CREATE INDEX ON harness_shared.agent_queries (ts DESC);
CREATE INDEX ON harness_shared.agent_queries (agent, query_id, ts DESC);
```

Per-query audit policy controlled by `QueryDef.audit`:
- `'none'` — never logged. For high-volume polls (`harness.status` every 5s).
- `'sample'` — log 1-in-20 (or burst-rate-limited to ≤2/sec). Default.
- `'full'` — log every invocation with args. For diagnostics.

Retention: 30 days for actions, 7 days for queries. Configurable via
`PAPERCUSP_AUDIT_RETENTION_DAYS_*` env vars. A nightly cron in the
operator app prunes.

**UI:** new "Agent activity" sub-tab in the dashboard. Default view
shows actions only (commands). A toggle reveals queries inline,
intermixed by timestamp — that's the reasoning-trail view ("Oracle
read status, then read list-features, then ran chat.dispatch"). Each
action row links to its `request_id` correlated entries.

**Ownership:** the migrations live in `harness-state/migrations/` per
repo convention (the `restart_harness` rename arc made that the
canonical migration spot per memory `db_rename_papercusp`). Drizzle
schema in `harness-state/src/schema/agent-audit.ts` if we want
type-safe queries; raw SQL is fine for the inserts.

---

## 7. Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Tool prompts break when names change | High | Hard cutover (rename + prompt diff in same PR). Brief "unknown tool" errors during deploy are acceptable; structured `CommandResult` lets the LLM roll forward |
| Multi-tab arbitration is wrong | Medium | Reuse existing voice-leader-election (tested). PR 1 includes integration test for headless leader-bridge flow |
| Cross-process command latency | Low | Same-process routing for ~70% of cases; SSE-bridged calls add ~50ms |
| Registry becomes a god object | Medium | Hard rule: `defs/` files per domain, ≤200 LoC each. Split when they grow |
| Audit insert volume | Medium | Commands always logged; queries sampled by default; nightly prune; configurable retention |
| Pi gains too much authority too fast | Medium | PR 5 is a deliberate review milestone; tag-per-command keeps the surface explicit |
| Concurrent paperclip stomps during migration | High | Per memory feedback: stage+commit in single shell command; touch one defs/ file per PR |
| Concurrent runs corrupt state (`harness.start` × 2) | Medium | `concurrent: 'queue'/'deny'` per-def; serialized at the registry |
| Import cycles between defs and registry | Medium | Strict import discipline (§2.3); CI test for cycles via `madge` |
| Prompt drift from registry | Medium | CI test asserts every tool name in the prompt files exists in the registry with the right `agents:` tag |
| Non-goals creep in (DOM clicker, free text) | High | `CONTRIBUTING.md` next to `defs/` lists rejection criteria; CI tripwire greps for `document.querySelector` etc. in handlers. Not airtight — code review backstop |

---

## 8. Success criteria

After PR 1–5:
- Operator can close itself (and any other panel).
- Operator and Oracle share the same `harness.status` definition.
- Pi gains `harness.start`, `harness.stop`, `harness.scan`,
  `chat.dispatch`.
- The CommandPalette is rendered from the registry; new palette items
  are added by adding a registry entry, not editing
  `HarnessDashboard.tsx`.
- `harness_shared.agent_actions` table populated; the dashboard has a
  recent-actions list.
- Tool counts: ~18 commands + ~10 queries in the registry. Each agent's
  tool list is generated from filtered registry slices.

---

## 9. Open questions for review

Most of v1's questions are now resolved (aliases dropped, audit defaults
set, browser back-channel skeleton in PR 1). Remaining:

1. **Pi's expanded surface (PR 5)** — open the full server-side surface
   in one PR, or whitelist a smaller set first (just `chat.dispatch` and
   `harness.scan`) and watch behavior before unlocking more?
2. **Sample rate for query audit** — 1-in-20 default + 2/sec burst cap.
   Tune based on PG insert pressure once we measure?
3. **Where does the registry source live?** The Node-side defs need to
   run in three places: operator app server, browser, Pi subprocess.
   Plan assumes the registry source is shared (single TS module imported
   from all three) and each environment imports the slice it needs.
   Confirm this is acceptable vs. e.g. a separate package.
4. **Per-handler timeouts.** Should commands have a default timeout
   (`30s`?) with per-def override? Long-running stuff (`harness.scan`)
   would override; everything else gets a forced cancel-and-error path.
   Not in v2; flag for v3 if it bites.

---

## 10. PR 1 alone is shippable

If you want to land the foundation but defer commitment to PR 2-6: ship
PR 1 as-described in §4 and stop. That's still ~600 LoC (registry +
audit + leader-bridge skeleton + first commands), but it gives you:

- Operator closes itself (`panel.close`)
- Audit table populating for command surface
- Cross-process design pressure-tested before any other shim depends on it

PRs 2-6 become independent decisions made later when concrete needs arise
(Oracle prompt rewrite, Pi expansion, palette rendering changes). PR 1
doesn't lock you in — it just removes the "every action implemented twice"
tax in the corner of the codebase that was already getting expensive
(panel control / Operator tools).

Earlier draft proposed a "quick path" of ~150 LoC stripping out the
cross-process spine. The reviewer correctly noted that creates a tiny
registry that nobody migrates into. Don't do that. The minimum viable
commit is PR 1 *with* the spine; the spine is what makes the registry
worth more than the inline code it replaces.
