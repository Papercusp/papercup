# Schema
URL: /internal/docs/agent-spawning/schema

The two PG tables that back the spawn primitive — `spawned_agents` (the durable mirror) and `tool_invocations_spawn_tree` (the recursive lineage view).

## `harness_shared.spawned_agents` — Migration 049

One row per spawn launch. Written by the plugin; read by `poll`, `list_active`, and the Intel panel.

```sql
CREATE TABLE harness_shared.spawned_agents (
  spawn_id          TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL,
  harness_slug      TEXT NOT NULL,
  parent_spawn_id   TEXT NULL,
  parent_role       TEXT NOT NULL,
  child_role        TEXT NOT NULL,
  feature_id        TEXT NULL,
  chunk_id          TEXT NULL,
  run_id            TEXT NOT NULL,
  status            TEXT NOT NULL,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ NULL,
  duration_ms       BIGINT NULL,
  exit_code         INT NULL,
  output_tail       TEXT NULL,
  error_message     TEXT NULL,
  cancel_requested  BOOLEAN NOT NULL DEFAULT false
);
```

### Status values

`running | done | failed | cancelled | reaped`

### Indexes

```sql
spawned_agents_parent_idx    -- (workspace_id, parent_spawn_id) — child enumeration + recursive joins
spawned_agents_recent_idx    -- (workspace_id, harness_slug, started_at DESC) — Intel panel feed
spawned_agents_running_idx   -- (workspace_id, status) WHERE status='running' — reaper sweep
```

### RLS

Same workspace-scoped policy as every other `harness_shared` table: reads/writes require `app.workspace_id` GUC set to match the row's `workspace_id`. The plugin sets the GUC inside its `sql.begin(...)` block on every operation.

### Lifecycle hooks on the row

| When                                                 | What                                                                             |
| ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| `spawn()` allocates a record                         | `INSERT` with `status='running'`                                                 |
| Background `invoke()` resolves                       | `UPDATE` with status, duration, exit\_code, output\_tail                         |
| Background `invoke()` rejects                        | `UPDATE` with status='failed' (or 'cancelled' if signal aborted), error\_message |
| `cancel()` matches in-memory                         | `UPDATE` with status='cancelled' immediately                                     |
| `cancel()` matches PG-only                           | `UPDATE` with status='cancelled' AND cancel\_requested=true                      |
| `list_active()` first call per workspace per process | One-shot reaper: rows still 'running' get flipped to 'reaped'                    |

### `cancel_requested` — the v2 hook

Today the column is informational. v2 will add a watcher process that:

1. Polls `WHERE cancel_requested=true AND status='running'`
2. Finds the stored OS-level pid (would need a `pid` column added)
3. SIGTERMs by pid

Designed for cross-restart cancel of an actively-running child whose owning operator is dead. We haven't built it because no use case has demanded it yet — most spawns finish or fail naturally; cancelling a survived-restart spawn is rare.

## `harness_shared.tool_invocations_spawn_tree` — Migration 048

A view, not a table. Recursive CTE over `tool_invocations` joining each row to its ancestors via `parent_spawn_id`.

```sql
CREATE VIEW harness_shared.tool_invocations_spawn_tree AS
WITH RECURSIVE chain AS (
  -- Roots: spawns with no parent
  SELECT
    id, workspace_id, harness_slug, plugin_name, tool_name, role,
    feature_id, chunk_id, run_id, spawn_id, parent_spawn_id,
    window_key, invoked_at, duration_ms, status,
    output_ref, output_size, error_message,
    0 AS depth,
    spawn_id::text AS root_spawn_id
  FROM harness_shared.tool_invocations
  WHERE parent_spawn_id IS NULL OR parent_spawn_id = ''
  UNION ALL
  -- Children, joined via parent → ancestor's spawn_id
  SELECT
    t.*, c.depth + 1, c.root_spawn_id
  FROM harness_shared.tool_invocations t
  JOIN chain c
    ON t.parent_spawn_id = c.spawn_id
   AND t.workspace_id = c.workspace_id
   AND c.depth < 16
)
SELECT * FROM chain;
```

### What's in vs what's not

This view is **per-tool-call**, not per-spawn. Each row is one MCP tool invocation; the view tells you "tool X was called by spawn Y, whose root is spawn Z, at depth N."

It's not the same as `spawned_agents`:

|                                       | `spawned_agents`                    | `tool_invocations_spawn_tree`          |
| ------------------------------------- | ----------------------------------- | -------------------------------------- |
| Granularity                           | One row per spawn launch            | One row per tool call by a child agent |
| When written                          | At `spawn()` call time + on resolve | When child makes any MCP tool call     |
| Includes spawns that called no tools? | ✅                                   | ❌                                      |
| Has `depth` (cross-spawn)             | ❌ (one row per spawn)               | ✅ (recursive lineage)                  |
| Used by                               | `poll`, `list_active`, durability   | Intel panel's Spawns sub-tab           |

You query `spawned_agents` to answer "what spawns happened?". You query `tool_invocations_spawn_tree` to answer "what did each spawn DO?".

### Joining the two

To get every spawn launch with its child tool calls flattened:

```sql
SET app.workspace_id = 'default';

SELECT
  s.spawn_id,
  s.child_role,
  s.status                                    AS spawn_status,
  s.duration_ms                               AS spawn_dur_ms,
  count(t.id)                                 AS tool_calls,
  count(t.id) FILTER (WHERE t.status='ok')    AS tool_calls_ok,
  count(t.id) FILTER (WHERE t.status='error') AS tool_calls_err
FROM harness_shared.spawned_agents s
LEFT JOIN harness_shared.tool_invocations t
  ON t.parent_spawn_id = s.spawn_id
 AND t.workspace_id   = s.workspace_id
WHERE s.harness_slug = 'sheets'
  AND s.started_at > now() - interval '24 hours'
GROUP BY s.spawn_id, s.child_role, s.status, s.duration_ms
ORDER BY s.started_at DESC;
```

That's the canonical "what happened to each spawn" feed.

## URL plumbing — the 7 spawn params

When a spawn fires, the orchestrator's `spawn-mcp.ts` writes a per-child `.mcp.json` with these query params on the operator URL:

| Param          | Source                          | Purpose                                                   |
| -------------- | ------------------------------- | --------------------------------------------------------- |
| `workspace`    | `ctx.workspaceId`               | RLS scoping for everything                                |
| `harness`      | `ctx.harnessSlug`               | Path resolution + telemetry attribution                   |
| `role`         | child role                      | Tool quota windows + role gating                          |
| `feature`      | spawn input `featureId`         | Feature attribution in tool\_invocations                  |
| `chunk`        | spawn input `chunkId` (workers) | Worker chunk-window quotas                                |
| `run`          | parent's `runId`                | Inherited; per-run quota windows                          |
| `spawn`        | new `spawnId`                   | Unique per-spawn telemetry attribution                    |
| `parent_spawn` | parent's `spawnId`              | The lineage edge — this is what makes the spawn-tree work |

The agent process loads this `.mcp.json` and every MCP request it makes thereafter carries those params. The framework reads them in `buildHttpSpawnContext` (HTTP) / equivalent (MCP), populates `ctx.parentSpawnId`, and the dispatcher records it as `parent_spawn_id` on every `tool_invocations` row.

That's the entire mechanism. No agent code needs to know about spawning; the URL params do all the work.
