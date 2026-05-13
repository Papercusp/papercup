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

### B1. Worker-thread isolation for local embedder — ✅ closed 2026-05-14

**Status:** `closed` (was `engineering deferred`)

**Context.** When `memoryEmbedderMode='local'`, the `@huggingface/transformers` BGE-small pipeline runs ONNX inference (100-500ms per call). Previously this ran on the Node.js main event loop, blocking every concurrent request during inference.

**Resolution (2026-05-14).** Shipped a worker-thread isolated embedder:
- `apps/operator/lib/memory/local-embedder-worker.ts` — main-thread wrapper with lazy spawn + pending-promise registry + graceful failure handling
- `apps/operator/lib/memory/local-embedder-worker.script.mjs` — worker script (plain ESM so `worker_threads` spawn works without TypeScript transform)
- `apps/operator/lib/memory/mem0-client.ts:buildLocalEmbedder` tries the worker first, falls back to inline on spawn/load failure (preserves backward compat in environments where `worker_threads` is unavailable, e.g. some vitest setups)
- 5 protocol-contract tests in `local-embedder-worker.test.ts` (soft-skipped when `@huggingface/transformers` isn't installed)

Main thread is now non-blocking during local-mode embedding. The worker holds the warm pipeline so subsequent calls are amortized.

---

### B2. Battery-aware embed worker pause — ✅ closed 2026-05-14

**Status:** `closed` (was `engineering deferred`)

**Context.** Periodic sweeps (embed-backfill every 5 min, backup orphan sweep every 5 min) ran unconditionally regardless of power state. On battery-powered Tauri desktop installs, that's wasted energy when the device is unplugged.

**Resolution (2026-05-14).** Shipped a battery-policy gate:
- `apps/operator/lib/search/battery-policy.ts` — `shouldRun()` returns `'pause'` only when the device is **Discharging AND below threshold** (default 30%, configurable via `BATTERY_POLICY_MIN_PCT`). Otherwise `'run'`. Unknown / no-battery / AC-power all return `'run'` (safer default — servers and AC-powered desktops never pause).
- Env override `BATTERY_POLICY_OVERRIDE=force_pause|always_run` for tests and admins.
- Source: `/sys/class/power_supply/BAT[N]/{status,capacity}` (Linux/Tauri-on-Linux). macOS + Windows native probes deferred — battery-conscious users on those platforms can use the env override.
- Wired into two periodic workers:
  - `embed-backfill._runSweepLogged` (skip when paused, next 5-min tick re-checks)
  - `backup/orphan-cleanup.runOnce` (same pattern)

10 unit tests covering all decision paths + env override + threshold customization. Real-host reading test soft-skips on machines without a battery.

---

### B3. pgvector wizard live re-verify (round-13 bug #29) — ✅ closed 2026-05-14

**Status:** `closed` (was `code-verified deferred`)

**Context.** Fix verified in code at `27082a3e`. The install-pgvector wizard script accepts the runtime arg correctly; the bug was that one call site wasn't passing it.

**Resolution (2026-05-14).** Live-verified end-to-end against this checkout:
- Default arg (no arg → repo-relative default): copies vector.so + control + sql to `node_modules/@embedded-postgres/linux-x64/native/`. ✓
- Explicit alternate dir: copies into the named `native/` dir. ✓
- Nonexistent target: exits 1 with clear error. ✓

Smoke test pinned at `apps/operator/__tests__/scripts/install-pgvector.test.ts` (3 tests, soft-skipped on non-Linux or when system pgvector isn't installed). Note: desktop sidecar build (`papercusp-desktop/bin/build-desktop-sidecar.sh:208`) has its own inlined pgvector-bundling path — they're parallel surfaces. Both work; B3 was specifically about the dev-machine script.

---

### B4. Full plugin lifecycle E2E (install / enable / disable / upgrade) — ✅ closed 2026-05-14

**Status:** `closed` (was `engineering deferred`)

**Context.** Step G of the Tier-2 follow-up arc shipped a focused test on `plugin-grants.ts` — the unique-to-plugins capability-grant mechanics (`apps/operator/lib/plugin-grants.test.ts`, 7 tests, PG-soft-skipped). B4 was the remaining install/enable/disable/upgrade lifecycle coverage.

**Resolution (2026-05-14).** Shipped at `apps/operator/__tests__/e2e/plugin-lifecycle.e2e.test.ts` using the existing `_injectPluginHostForTests` seam:
- **Install**: injected plugin appears in `pluginHostStatus.plugins` with correct name/version
- **Dispatch-time gate**: `invokePluginAction` returns the right error code when the plugin isn't loaded
- **Disable**: post-reset state correctly shows 0 loaded plugins
- **Permissions**: grant-store persistence smoke (capabilities round-trip via `grantCapabilities` / `getGrantsForPluginInHarness`)
- **Upgrade**: injecting v2 over v1 (with expanded capabilities + new action) replaces the loaded entry

5 tests, all using the existing test seam (`_injectPluginHostForTests`) — no WASM fixture pipeline needed because the host's dispatch contract is testable at the in-memory `LoadedPlugin[]` boundary. WASM-specific paths remain covered by `packages/plugin-loader`'s existing tests (`api-factory`, `capabilities`, `tools`, `actions`, `hookbus`).

What's still NOT covered (genuinely out of scope):
- Real WASM/daemon plugin install (init runs through `@papercusp/plugin-loader`)
- Per-harness install-scope multi-harness deployment
- File-system snapshot include/exclude on `plugin.snapshot.include[]`

If those become important, the trigger remains "real plugins start shipping AND a user-reported regression in those specific paths."

---

## Cross-cutting notes

**On the "shim pattern" recognition (A1).** A1's conclusion — that thin-tool + per-route shim is correctly the right shape when shims do legit business logic — should propagate into the projection cookbook (if one exists) or the endpoint-system docs. Future authors of new chat-style surfaces shouldn't treat the shim as transitional debt. The Hono shim is the natural home for transport-specific pre/post work (auth lookups, cost caps, transcript persistence, feature locks).

**On `scope: 'global'` (A2) appearing again.** If A2 ships, future projected tools that fit the singleton-shape pattern should default to using it rather than implementing one-off SSE producers. Update the projection cookbook with examples once a second consumer materializes.

**On the principal RFC (A3) appearing again.** Once the RFC lands, every existing transport's auth path becomes a `principal` populator. The signed-URL HMAC verify path migrates first (existing semantics preserved), then IPC explicit-trust path (already implemented this way), then JWT-mobile (new). After that, adding a new auth model (API tokens, OAuth, etc.) is a matter of writing one populator, not threading auth through the dispatcher.
