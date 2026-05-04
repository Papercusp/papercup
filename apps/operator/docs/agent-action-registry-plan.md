# Agent Action Registry — Implementation Plan

**Status:** draft for review
**Scope:** unify the three agent tool surfaces (Oracle, Operator, Pi) plus
the user-facing surfaces (keyboard shortcuts, ⌘K command palette) under a
single typed registry of commands (side-effects) and queries (reads).
**Non-goals (this plan):** generic DOM clicker, free-text input tools, drag/
resize gestures, multi-step workflows. These are deliberately out of scope.

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

export interface CommandDef<Args = unknown, Result = unknown> {
  id: string;                // e.g. 'panel.toggle'
  kind: 'command';           // mutating
  description: string;       // shown to LLMs + ⌘K
  schema: ZodSchema<Args>;   // arg validation
  agents: AgentId[];         // who's allowed to invoke
  requiresBrowser?: boolean; // true → Pi cannot call without browser back-channel
  paletteEntry?: { section: string; title: string; icon?: string; keywords?: string };
  handler: (args: Args) => Promise<Result> | Result;
}

export interface QueryDef<Args = unknown, Result = unknown> {
  id: string;                // e.g. 'harness.status'
  kind: 'query';             // pure read
  description: string;
  schema: ZodSchema<Args>;
  agents: AgentId[];
  handler: (args: Args) => Promise<Result> | Result;
}

export type Definition = CommandDef | QueryDef;
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

export function register(def: Definition): void { defs.set(def.id, def); }

export function get(id: string): Definition | undefined { return defs.get(id); }

export function list(filter?: { kind?: 'command' | 'query'; agent?: AgentId }): Definition[] {
  return [...defs.values()].filter(d => {
    if (filter?.kind && d.kind !== filter.kind) return false;
    if (filter?.agent && !d.agents.includes(filter.agent)) return false;
    return true;
  });
}

export async function runCommand(id: string, args: unknown, ctx: { agent: AgentId }): Promise<unknown> {
  const def = defs.get(id);
  if (!def || def.kind !== 'command') throw new RegistryError(`unknown command: ${id}`);
  if (!def.agents.includes(ctx.agent)) throw new RegistryError(`agent ${ctx.agent} not authorized for ${id}`);
  const parsed = def.schema.parse(args ?? {});
  audit({ kind: 'command', id, agent: ctx.agent, args: parsed, t: Date.now() });
  try {
    const out = await def.handler(parsed);
    audit({ kind: 'command-ok', id, agent: ctx.agent, t: Date.now() });
    return out;
  } catch (err) {
    audit({ kind: 'command-err', id, agent: ctx.agent, error: String(err), t: Date.now() });
    throw err;
  }
}

export async function runQuery(id: string, args: unknown, ctx: { agent: AgentId }): Promise<unknown> {
  const def = defs.get(id);
  if (!def || def.kind !== 'query') throw new RegistryError(`unknown query: ${id}`);
  if (!def.agents.includes(ctx.agent)) throw new RegistryError(`agent ${ctx.agent} not authorized for ${id}`);
  const parsed = def.schema.parse(args ?? {});
  return def.handler(parsed);
}
```

`audit()` writes to `harness_shared.agent_actions` (new table — see
section 6) so we have a per-session log of every command an agent ran,
visible from the harness UI.

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

---

## 3. Side-effect routing — same-process vs. cross-process

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
supports it via `requiresBrowser` — we just don't wire the back-channel yet.

---

## 4. Migration plan — six steps, six PRs

Each step is independently shippable, reverts cleanly, doesn't break the
preceding step's behavior.

### PR 1 — Registry + audit + first command end-to-end

**Files:**
- `lib/commands/types.ts` — type definitions only
- `lib/commands/registry.ts` — engine
- `lib/commands/audit.ts` — batched INSERT into a new
  `harness_shared.agent_actions` table (`id, agent, command_id, args,
  result_status, error, t_ms`). Migration in `harness-state/migrations/`.
- `lib/commands/defs/panel.ts` — registers `panel.toggle`, `panel.open`,
  `panel.close` for `agents: ['oracle','operator','palette','shortcut']`,
  `requiresBrowser: true`. Handlers call existing
  `operator-shared-state.broadcastState`.
- `lib/commands/shims/operator-shim.ts` — generates Realtime tool defs.
  Replaces the inline tools in
  `lib/voice-engines/openai-realtime.ts:48-103` with a generated catalog.
- New API route `app/api/agent-mcp/operator-actions/route.ts` —
  `POST { id, args }` → `runCommand` → response. (Used by Oracle's MCP
  server to invoke browser-only commands cross-process; Operator uses
  in-page handler so doesn't need this.)

**Behavior change:** none from the user's perspective. Operator's
`open_operator` keeps working (now through the shim). Operator gains
`panel.close`. Audit table starts populating.

**Tests:**
- Unit: registry rejects unknown agents, schema-fails on bad args.
- Integration: Realtime SDK shim emits expected tool list; calling
  `panel.toggle` toggles `sharedState.open`.

**Risk:** medium — first time the registry runs in production. Mitigated
by step (1) being a thin wrapper over existing functions; if registry
breaks, fall back to the old inline `tool({...})` code (kept in a comment
for one release).

### PR 2 — Oracle shim + read-side unification with Pi

**Files:**
- `lib/commands/defs/harness.ts` — registers all 7 of Pi's queries
  (`harness.status`, `harness.list-features`, `harness.lineage`,
  `harness.audit`, `harness.proposals`, `harness.decisions`,
  `harness.issues`). `agents: ['oracle','operator','pi']`. Handlers
  call existing harness-state read functions.
- `lib/commands/defs/chat.ts` — registers Oracle's `chat.list`,
  `chat.resume`, `chat.dispatch`. `agents: ['oracle','operator']` for
  now (chat is browser-only ergonomically until Pi can spawn a chat
  pane). `chat.dispatch` is server-side (creates row in PG); the
  side-effect of opening the chat pane is browser-only and routed via
  step (1)'s API route.
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

## 5. Tool naming + schema discipline

Current tool names across the three agents are inconsistent:

- Oracle: camelCase verbs (`listHarnesses`, `getHarnessStatus`).
- Operator: snake_case verbs (`open_operator`, `across_workspaces`).
- Pi: snake_case nouns (`status`, `list_features`).

Pick one and stick with it. Recommended: **`namespace.action`** (dotted,
kebab inside parts). `harness.status`, `panel.close`, `voice.set-mode`,
`chat.list`. Reads well, easy to filter (`harness.*`), no model
confusion.

For backward compatibility during migration:

```ts
register({
  id: 'harness.status',
  aliases: ['status', 'getHarnessStatus'], // legacy names still work
  // …
});
```

Each shim emits both the canonical id and the aliases as separate tool
defs (with the alias's old description) for one release, then drops the
aliases after we confirm nobody's prompts reference them.

---

## 6. Audit table

```sql
CREATE TABLE IF NOT EXISTS harness_shared.agent_actions (
  id          BIGSERIAL PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  agent       TEXT NOT NULL,           -- 'oracle' | 'operator' | 'pi' | 'palette' | 'shortcut'
  command_id  TEXT NOT NULL,           -- 'panel.toggle' etc.
  kind        TEXT NOT NULL,           -- 'command' | 'query'
  args        JSONB NOT NULL DEFAULT '{}'::jsonb,
  status      TEXT NOT NULL,           -- 'ok' | 'err' | 'denied'
  error       TEXT,
  duration_ms INT,
  workspace   TEXT,
  session_id  TEXT
);
CREATE INDEX ON harness_shared.agent_actions (ts DESC);
CREATE INDEX ON harness_shared.agent_actions (agent, ts DESC);
CREATE INDEX ON harness_shared.agent_actions (command_id, ts DESC);
```

Surface in the harness UI under a new "Agent activity" sub-tab in the
dashboard, showing a virtualized list of recent actions. Useful for
debugging ("what did Operator just do?") and review.

Queries are excluded from audit by default (high volume, low value);
opt-in per query def via `audit: true` if a specific read needs tracking.

---

## 7. Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Tool prompts break when names change | Medium | Aliases (section 5) for one release |
| Cross-process command latency | Low | Same-process routing for ~70% of cases; back-channel (PR 6) is opt-in |
| Registry becomes a god object | Medium | Hard rule: `defs/` files per domain, ≤200 LoC each. Split when they grow |
| Auditing PG insert volume | Low | Batched (1s flush), indexed by ts, only commands by default |
| Pi gains too much authority too fast | Medium | PR 5 is a deliberate review milestone; tag-per-command keeps the surface explicit |
| Concurrent paperclip stomps during migration | High | Per memory feedback: stage+commit in single shell command; touch one defs/ file per PR |

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

1. **Aliases (section 5)** — keep them for one release, or do a clean
   rename and update the agent prompts in the same PR? Clean is simpler;
   aliases are safer.
2. **Audit retention** — keep all rows forever, or tail to N days? Default
   suggestion: 30 days.
3. **Pi's expanded surface (PR 5)** — should we whitelist a smaller set
   first (e.g., just `chat.dispatch` and `harness.scan`) before opening
   the full server-side surface?
4. **Browser back-channel (PR 6)** — concrete use case? If not, drop from
   the plan.
5. **Where does the registry live process-wise?** The Node-side defs
   need to run in three places: operator app server (Oracle queries +
   server-side commands), browser (Operator + palette), Pi subprocess
   (Pi queries). Plan assumes the registry source is shared and each
   environment imports the slice it needs. Confirm this is acceptable
   vs. e.g. a separate microservice.

---

## 10. Quick path (if you want one PR fixing the immediate complaint)

If you don't want to commit to the whole migration up front, the smallest
change that solves "Operator can't close itself" with the right shape:

- Land `lib/commands/{types,registry}.ts` (50 LoC).
- Land `lib/commands/defs/panel.ts` with `panel.toggle / open / close`.
- Land `lib/commands/shims/operator-shim.ts`, replace just the
  `open_operator` tool inline.
- Add `panel.close` to Operator's prompt.
- Skip everything else.

That's ~150 LoC, one PR, ~2 hours. Operator can close itself, the
registry is in place for future migration, no other agent affected.
