# Deferred follow-ups — 2026-05-14

Things we've parked, why, and what would unpause them. One doc for everything that's not in flight.

**Status legend:**
- `permanent` — not deferred work; this IS the right shape. Listed so future readers don't re-litigate.
- `engineering deferred` — pure engineering call, parked until a trigger justifies the effort.
- `RFC deferred` — needs a framework-level design decision before any concrete migration.
- `code-verified deferred` — fix is in code; live verification or follow-up environment needed.

---

## Section A: Projection follow-ups

### A1. Hono route shims for `/api/oracle/chat` and `/api/harness/:slug/agent-chats/:chatId/messages`

**Status:** `permanent` (oracle is contingent — see below)

**Context.** PR #2 of session 2026-05-13 made `oracle:chat` and `agent_chats:chat` into projected tools. The legacy URLs survive as Hono shims that internally `dispatchProjectedToolStream(...)`. Six consumer sites still point at the legacy URLs: `OracleDock.tsx` (×2), `ChatPanel.tsx`, `ExpertsPanel.tsx`, `VoiceAppBridge.tsx`, `OperatorChat.tsx` (referenced in comments).

**Why permanent, not deferred:**

- `_hono/agent-chats.ts` is 419 lines. It does legitimate business logic that doesn't belong in a transport-agnostic tool: `assembleRolePrompt`, feature-lock reads, transcript-row reads, cost-cap checks, AND post-stream PG persistence of tokens, cost, and the final assistant message into the `agent_chats` transcript table. We ran through three options for relocating that work:
  - **(A) Push PG work into the tool** — breaks the tool's transport-agnostic property. Tool would need to know about `agent_chats` schema, transcripts, cost caps. **Rejected.**
  - **(B) Thin pre/post wrapper at a different layer** — functionally equivalent to the shim, just renamed. **No win.**
  - **(C) Fire a `done` event, separate worker persists** — eventually-consistent transcript persistence is a UX regression for a surface where users WILL refresh. **Rejected.**

  None of A/B/C is better than keeping the shim. The thin-tool + per-route shim pattern is correctly the right shape when shims do legitimate business logic.

- `_hono/oracle.ts` (120 lines) is mostly forwarding. It **could** retire alone, but doing so while agent-chats stays would split the 6 consumer sites between two URL conventions — more churn for less benefit. **Oracle shim stays *contingent* on agent-chats staying.** If A2 ever provides a clean way to retire agent-chats, revisit oracle then.

**Trigger to revisit:** any of —
- User-perceptible lag introduced by the extra HTTP hop (none today; measure if reported).
- A third chat surface materializes that would have to write another 400-line shim — at which point the *shim pattern itself* is worth re-examining, not the individual files.
- A clean architectural way to retire agent-chats appears (currently none).

---

### A2. Flag stream as a state-shaped projected tool

**Status:** `engineering deferred`

**Context.** PR #4 migrated the flag-stream consumers to `createResilientEventSource` (5b path — resilient wrapper, no architectural change). The producer (`/api/flags/stream`) is still a hand-rolled SSE route, not a state-shaped tool publishing into the unified `/api/operator/state-snapshot` channel.

The unified state-snapshot channel is per-workspace (`subscribeWorkspace(activeWorkspaceId(), ...)`). Flags today are global. Four options:

- **(a)** Workspace-scope the flags. Product change — orgs with multi-workspace setups have to set the same flag in N places. Changes user-facing semantics.
- **(b)** Add a global state-snapshot variant. Significant framework scope creep; nothing else needs it today.
- **(c)** Status quo. Migration buys nothing.
- **(d)** Per-tool `scope: 'global' | 'workspace'` declaration on `defineTool`'s state contract.

  ```ts
  defineTool({
    name: 'flags:current',
    state: FlagsSchema,
    scope: 'global',
    timeoutSec: 86_400,
    idleTimeoutSec: 0,
    handler: ...
  });
  ```

  Dispatcher routes through a global state-snapshot subscription when `scope: 'global'`. Generalizes to any singleton-shaped tool (server config, install metadata, telemetry rates, license info, system health, etc.) — no product call required.

**Selected: (d).** No product change, additive framework change, broad future value.

**Effort, honest estimate.** The state-snapshot route, channel naming, replay buffer keying, and subscribe path all assume workspace scoping today. Each needs a fork or a `scope`-aware branch. Plus the `flags:current` tool itself. Plus the 4 sibling routes (`/api/flags/set`, `/api/flags/preset`, `/api/flags/dashboard-url`, `/api/flags/testing-features`) — which are mutations, not subsumed by state-snapshot. Each becomes a projected mutation tool (`flags:set`, `flags:preset_apply`, `flags:dashboard_url`, etc.). Realistic effort: **1-2 days**, not an afternoon.

**Trigger to revisit:** a second singleton-shaped tool needs the same pattern (server config, install metadata, etc.). Ship `scope: 'global'` once for both — single 1-2-day investment amortized across two beneficiaries.

**When unblocked, must include:**
- `idleTimeoutSec: 0` is mandatory (`ctx.publishState` does NOT bump the dispatcher idle clock; only `ctx.emit` does — see `dispatch-projected.ts:318`). A flags handler that publishes once per hour would otherwise be killed at 120s.
- Update `content/docs/posthog/feature-flags.mdx` — current doc describes `GET /api/flags/stream` as the public contract.

---

### A3. Mobile log stream as a projected tool — and the dispatcher principal RFC

**Status:** `RFC deferred`

**Context.** PR #3 migrated `_hono/mobile.ts:917` (`/harnesses/:slug/log/stream`) from `streamSSE` to `sseResponse + sink.eventRaw`. It's a Hono route, not a projected tool, and stays that way for now.

**This is actually two separate things:**

1. **Framework RFC: dispatcher principal abstraction.** The dispatcher today has no authentication abstraction — it has a signed-URL-specific path. Making it transport-pluggable is the real change. Add a `principal` parameter to `dispatchProjectedTool` that each transport adapter populates from its own auth model:
   - Signed-URL transport (desktop/operator HTTP): from URL params + HMAC verify.
   - IPC transport (Tauri webview): from "this is the webview user, trust implicitly" — already implemented this way.
   - JWT-mobile transport: from `c.get('deviceClaims')`.
   - Future: API token, service-to-service, third-party OAuth, etc.

   Broad value — unblocks every future mobile endpoint, every future API-token use case, every future cross-service call. ~2-3 hours of framework work plus updating existing transports.

2. **Migration: `mobile:log_stream` becomes a projected tool.** Trivial once (1) ships — ~30 min, identical to the desktop log-stream projection pattern.

**Why deferred:** (1) is broad-value framework work that deserves its own RFC and review cycle, not bundled inside a single mobile-endpoint conversation. (2) is trivial once (1) lands but isn't worth doing on its own.

**Trigger to revisit:** a second mobile endpoint wants projected-tool features (telemetry rows in `tool_invocations`, capability quotas, discoverability via `tools/list`, automatic IPC fast-path if Tauri ever runs mobile). At that point the RFC has multiple beneficiaries and is worth writing.

---

## Section B: Backend follow-ups

### B1. Worker-thread isolation for local embedder

**Status:** `engineering deferred`

**Context.** `@huggingface/transformers` runs on the main event loop today. Only matters when `memoryEmbedderMode='local'`; default is `openai`. No user reports of event-loop blocking.

**Trigger to revisit:** any user report of operator slowdowns coinciding with local-embedder usage.

**Estimated effort when revisited:** 2-3 hours. Move the `@huggingface/transformers` invocation into a Node worker thread; ESM worker file + message protocol + return promise.

---

### B2. Battery-aware embed worker pause

**Status:** `engineering deferred`

**Context.** The 5-minute embed-backfill sweep runs unconditionally. On battery-powered Tauri desktop installs this is wasted energy when the device is unplugged.

**Trigger to revisit:** any Tauri/desktop user report of the embed worker affecting battery life.

**Estimated effort when revisited:** ~1.5 hours. `navigator.getBattery()` or Tauri's `power_monitor`; gate the 5-min sweep on `!isOnBattery || batteryLevel > 0.5`.

---

### B3. pgvector wizard live re-verify (round-13 bug #29)

**Status:** `code-verified deferred`

**Context.** Fix verified in code at `27082a3e`. The install-pgvector wizard script accepts the runtime arg correctly; the bug was that one call site wasn't passing it. Live re-run against a wizard worktree pending a desktop-build CI run.

**Trigger to revisit:** first desktop-release PR that builds the wizard. Verify the script accepts the arg in the built binary on the next desktop-release CI run; will surface naturally without needing scheduled action.

---

### B4. Full plugin lifecycle E2E (install / enable / disable / upgrade)

**Status:** `engineering deferred`

**Context.** Step G of the Tier-2 follow-up arc shipped a focused test on `plugin-grants.ts` — the unique-to-plugins capability-grant mechanics (`apps/operator/lib/plugin-grants.test.ts`, 7 tests, PG-soft-skipped). What's NOT covered yet:
- Install: pluginHostInstall() side-effects (PG row, manifest parse, file-system state)
- Enable/Disable: lookupByMcpName resolution after toggle
- Upgrade: install v2 over v1; schema migration; manifest version pin
- Permissions: capability-grant intersection with manifest at dispatch time

Existing coverage that overlaps:
- `apps/operator/lib/agent-tools/plugins/__tests__/plugins.test.ts` (the 3 plugin tools)
- `packages/plugin-loader/src/capabilities.test.ts` (capability matching)
- `packages/plugin-loader/src/api-factory.test.ts` (host API)
- `packages/plugin-sdk/src/tier-table.test.ts` (capability tier table)

**Trigger to revisit:** real plugins start shipping AND any user-reported lifecycle regression. The grant store is the unique-to-plugin surface; the rest is mostly shared with non-plugin tools and exercised by the existing test files. A full E2E test needs the WASM plugin fixture pipeline (esbuild + `packages/plugin-loader` integration) which is substantial unique infrastructure.

**Estimated effort when revisited:** ~4-5 hours. Needs: (a) esbuild + WASM fixture compilation in beforeAll, (b) live PG plus the plugin-host-runtime, (c) test fixture for a tiny plugin that emits a known event. Out of scope for the Tier-2 arc.

---

## Cross-cutting notes

**On the "shim pattern" recognition (A1).** A1's conclusion — that thin-tool + per-route shim is correctly the right shape when shims do legit business logic — should propagate into the projection cookbook (if one exists) or the endpoint-system docs. Future authors of new chat-style surfaces shouldn't treat the shim as transitional debt. The Hono shim is the natural home for transport-specific pre/post work (auth lookups, cost caps, transcript persistence, feature locks).

**On `scope: 'global'` (A2) appearing again.** If A2 ships, future projected tools that fit the singleton-shape pattern should default to using it rather than implementing one-off SSE producers. Update the projection cookbook with examples once a second consumer materializes.

**On the principal RFC (A3) appearing again.** Once the RFC lands, every existing transport's auth path becomes a `principal` populator. The signed-URL HMAC verify path migrates first (existing semantics preserved), then IPC explicit-trust path (already implemented this way), then JWT-mobile (new). After that, adding a new auth model (API tokens, OAuth, etc.) is a matter of writing one populator, not threading auth through the dispatcher.
