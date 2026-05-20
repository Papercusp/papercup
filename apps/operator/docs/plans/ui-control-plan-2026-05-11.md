---
title: UI control surface for agents
slug: ui-control-plan-2026-05-11
status: active
created: 2026-05-11
updated: 2026-05-20
owner: pandawamble@gmail.com
---

## Now

**State:** Two-part feature: agents inspect what the user is looking at, and agents trigger UI actions, without per-feature wiring.

**Next:** Owner: review current state and replace this auto-generated Now block (backfilled 2026-05-20).


# UI control surface for agents

Two-part feature: agents inspect what the user is looking at, and agents
trigger UI actions, without per-feature wiring.

## Architectural shape

Mirrors the backend tool pattern: pure-function-as-truth, projected to
MCP, gated by capability/spawn ctx. The UI is "another tool surface."

Two PG tables, two browser hooks, three MCP tools, one SSE stream.

## Schema (migration 012)

```sql
CREATE TABLE harness_shared.ui_clients (
  client_id text PRIMARY KEY,
  workspace_id text,
  url text NOT NULL,
  title text,
  viewport jsonb,
  opened_at timestamptz DEFAULT now(),
  last_seen_at timestamptz DEFAULT now()
);
CREATE INDEX ui_clients_last_seen ON harness_shared.ui_clients (last_seen_at DESC);

CREATE TABLE harness_shared.ui_intents (
  id bigserial PRIMARY KEY,
  client_id text NOT NULL,
  intent text NOT NULL,
  args jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',  -- pending|done|error|timeout
  result jsonb,
  error_message text,
  requested_by text,                        -- principal slug or 'system:operator'
  created_at timestamptz DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX ui_intents_client_pending
  ON harness_shared.ui_intents (client_id, id)
  WHERE status = 'pending';
```

Rows older than 60s with no heartbeat are stale; query layer filters
them out. Old `ui_intents` rows reaped daily.

## Spawn ctx wiring (client_id auto-known to agents)

When the user is chatting with an agent on a page, the page's
`client_id` is baked into the agent's MCP URL. The agent's spawn ctx
exposes it as `ctx.uiClientId`, so `ui:dispatch` and friends default to
it without the agent having to call `ui:list_clients` first.

- Add `'client'` to `SIGNED_PARAM_ALLOWLIST` in `apps/operator/lib/spawn-signing.ts` AND `libs/papercusp/packages/orchestrator/src/spawn-mcp.ts` (both must match — keep allowlists in lockstep).
- Add `uiClientId?: string` to `SpawnContext` in `apps/operator/lib/spawn-context.ts`.
- `parseRequestContext` reads `url.searchParams.get('client')`.
- Each chat-entry route (operator-converse, operator-chat, delegate-chat, _hono/oracle/harness/agent-chats) reads `clientId` from request body and appends `&client=<id>` to the operator MCP URL.

## Browser-side

- `lib/ui/client-id.ts` — `getOrCreateClientId()` reads/writes `sessionStorage.papercusp_ui_client_id`. UUIDv4.
- `lib/ui/use-ui-presence.ts` — on URL change + every 15s, POST `/api/ui/presence` `{client_id, url, title, viewport}`.
- `lib/ui/intent-dispatcher.tsx` — singleton; opens `EventSource('/api/ui/intents/stream?client_id=X')`. On event:
  1. Look up `intent` in built-ins (always present), else in feature registry.
  2. Execute, capture result or error.
  3. POST `/api/ui/intents/:id/result` `{result|error}`.
- `lib/ui/use-ui-intent.ts` — `useUiIntent(name, handler)` registers on mount, unregisters on unmount.
- `app/_components/UiPresenceProvider.tsx` — mounted at app root; runs `useUiPresence()` + renders the dispatcher.

### Built-in intents (no per-feature wiring)

- `set_url(params)` — `router.replace` with merged search params. Drives nuqs-state changes.
- `snapshot({selector?, mode?})` — `outerHTML` | `innerText` | `textContent` of selector (default `body`).
- `read_visible_text({selector?})` — innerText only.
- `focus({selector})` — `el.focus()`.
- `scroll_into_view({selector, block?})` — `el.scrollIntoView()`.
- `click({selector})` — gated; only when the agent explicitly has `ui:click` capability (Tier 2).

### Feature-registered intents

Components that have imperative actions not representable in URL state register them with a single line:

```tsx
useUiIntent('refresh-build', () => refetch());
```

The intent only exists while the component is mounted. Agent calls
`ui:dispatch({intent: 'refresh-build'})` → dispatcher looks it up →
executes.

## API endpoints

- `POST /api/ui/presence` — body `{client_id, url, title?, viewport?}`. Upserts into `ui_clients`.
- `GET /api/ui/intents/stream?client_id=X` — SSE; on connect emits any backlog of pending intents for that client, then watches via `LISTEN ui_intent_pending` (NOTIFY fired by the dispatch tool). Closes when the client disconnects.
- `POST /api/ui/intents/:id/result` — body `{result?, error?}`. Sets status=done|error, completed_at=now.

All three are loopback by default (operator binds `127.0.0.1`). No bearer needed — the spawn URL is the credential for the agent path; the browser tab is on the same machine.

## MCP tools (`apps/operator/lib/agent-tools/ui/`)

- `ui:list_clients({workspace?, since_seconds?})` — recent clients (default 60s).
- `ui:get_state({client_id?})` — defaults `client_id` to `ctx.uiClientId`; parses URL and returns `{url, params, title, lastSeen}`.
- `ui:dispatch({client_id?, intent, args?, timeoutMs?})` — defaults client_id; inserts row, long-polls for result/error/timeout. Default timeout 5s. Result row is what the agent gets back.

All require `requirePrincipal: false`, `roles: [...ALL_ROLES]`. `ui:dispatch` with `intent: 'click'` requires capability `ui:click` (Tier 2). Other intents pass through with no extra capability needed — they're read-only or URL-state writes.

## Tests

`apps/operator/__tests__/integration/ui-control.mjs`:

1. POST presence → `ui:list_clients` shows it
2. Stale client (last_seen > 60s ago) doesn't appear in default `list_clients`
3. `ui:get_state(client_id)` returns parsed URL params
4. Dispatch `set_url` → presence URL updates within timeout
5. Dispatch `snapshot` → returns selector content
6. Dispatch feature-registered intent — register on a test page, dispatch, verify handler called with args
7. Dispatch unknown intent → returns `error: unknown_intent`
8. Dispatch with no `client_id` and no `ctx.uiClientId` → returns `error: client_id_required`
9. Dispatch with timeout — never-answered intent → status=timeout, error="dispatch_timeout"
10. Spawn URL with `&client=X` → `ctx.uiClientId === 'X'` → dispatch without `client_id` arg succeeds

## Docs

`apps/operator/content/docs/endpoint-system/ui-control.mdx` — page next
to `spawn-signing.mdx`. Covers the model, the three tools, the
built-ins, how to register a feature intent, security model.

## Out of scope (this PR)

- Cross-workspace presence visibility (current design lets any agent in any workspace list any client; tighten later if needed).
- Replay protection on intents (each row is one-shot — the browser-side dispatcher only acts on `pending` rows and marks them immediately; no replay loop).
- Persistent intents across page reloads — by design, only the currently-open tab's client_id matters.

## After implementation: nuqs audit

Walk `useState` / `useReducer` usage in `apps/operator/app/**/*.tsx`. Flag candidates that look like:
- "open/closed" panel state
- selected-row / active-tab state  
- filter/search-input state
- sort/pagination state

For each, output: file, line, current shape, suggested nuqs param name + parser, why it's worth moving (agent visibility, deep-link, refresh-survival).
