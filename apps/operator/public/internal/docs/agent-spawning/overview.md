# Overview
URL: /internal/docs/agent-spawning/overview

What agent spawning is, why we built it, and when to use it.

## The one-line version

One agent launches another via four MCP tools — `orchestrator.spawn`, `orchestrator.poll`, `orchestrator.list_active`, `orchestrator.cancel` — and the parent gets a `spawnId` back immediately. The child runs to completion in the background; parent polls or moves on. Lineage threads through `parent_spawn_id` so the Intel panel shows the full tree.

## Why this exists

Before Phase 9, the orchestrator was the only thing that could launch agents. Every architect→worker, scoper→validator, debugger→validator step ran through the main loop's decision turn. That's right for the canonical lifecycle, but two patterns kept hitting the wall:

* **Architect fan-out.** "These three features are independent — let's run F-001, F-002, F-003 in parallel" — required either three orchestrator iterations in series or a custom branch in main-loop.ts. Now: three `orchestrator.spawn` calls, return immediately, poll later.
* **Reviewer kicking a re-architect.** Reviewer notices an architectural mismatch mid-review. Pre-Phase 9: write an issue, hope architect picks it up next iteration. Post-Phase 9: `orchestrator.spawn(role: 'architect', extras: ['REVIEW_NOTE=...'])` — synchronous-looking, no main-loop trip.

## How it differs from the orchestrator's main loop

|              | Main loop                                   | spawn primitive                                                          |
| ------------ | ------------------------------------------- | ------------------------------------------------------------------------ |
| Driver       | `runMainLoop` decision-turn → invoke        | A tool call from any allowlisted role                                    |
| Sync?        | Sequential (one role at a time)             | Parallel (multiple spawns concurrent)                                    |
| Duration cap | Per-role timeout in `invoke()`              | Same per-spawn — but parent doesn't wait                                 |
| Context      | Walks `decisions` table, computes next verb | Caller passes `role` + `featureId` + `chunkId` directly                  |
| Telemetry    | `decisions` + `tool_invocations`            | `spawned_agents` (durable) + `tool_invocations` (with `parent_spawn_id`) |

The main loop still owns the canonical "what should this harness do next" decision. spawn() is the lower-level primitive an agent reaches for when it knows what it wants to launch and just needs to launch it.

## Where you read about how it works

* [Lifecycle](/internal/docs/agent-spawning/lifecycle) — spawn → poll → cancel; status transitions; cross-restart durability via PG
* [Allowlist & caps](/internal/docs/agent-spawning/allowlist-and-caps) — who can spawn whom; the five typed error codes
* [Schema](/internal/docs/agent-spawning/schema) — `spawned_agents` (Migration 049) + `tool_invocations_spawn_tree` (Migration 048)
* [Observability](/internal/docs/agent-spawning/observability) — Intel panel's Spawns sub-tab; useful PG queries for the tree
* [Limits](/internal/docs/agent-spawning/limits) — what v1.5 doesn't do, what's deferred to v2

## Where it lives in code

| Component                              | File                                                              |
| -------------------------------------- | ----------------------------------------------------------------- |
| Plugin (4 tool handlers + PG mirror)   | `libs/papercusp/plugins/orchestrator-spawn/index.cjs`             |
| Manifest                               | `libs/papercusp/plugins/orchestrator-spawn/papercusp.json`        |
| InvokeOptions.signal extension         | `libs/papercusp/packages/orchestrator/src/invoke.ts`              |
| Spawned-agents table                   | `libs/papercusp/libs/db/sql/049-spawned-agents.sql`               |
| Spawn-tree recursive view              | `libs/papercusp/libs/db/sql/048-intel-views.sql`                  |
| Per-spawn URL params                   | `packages/agent-mcp/src/http-projection.ts:buildHttpSpawnContext` |
| `.mcp.json` writer (orchestrator-side) | `libs/papercusp/packages/orchestrator/src/spawn-mcp.ts`           |
