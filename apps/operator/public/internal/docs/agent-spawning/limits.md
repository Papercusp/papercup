# Limits
URL: /internal/docs/agent-spawning/limits

What the spawn primitive does not do (yet) — the honest list of v1.5's edges, with workarounds where they exist.

These are the rough edges. Each one is real, each one has a reason, and each one has a path forward when a use case demands it. Until then they're documented so you can plan around them.

## Cancel can't kill across restarts

`orchestrator.cancel` against an in-process spawn fires `AbortSignal` immediately and the orchestrator tears down the child. Against a spawn that's only in PG (the operator that launched it has since restarted), there is no live `AbortController` and no pid to signal — we mark `cancel_requested=true` and flip status to `cancelled` so the UI reflects intent, but the orphaned OS process keeps running until it exits on its own.

**Workaround:** none today. A future watcher process could read `cancel_requested=true` rows and SIGTERM by stored pid, but we'd need to record `pid` in `spawned_agents` first and decide whether the watcher lives in the operator or as a sidecar. Defer until a real workflow needs it.

## No FIFO queue when concurrent cap hits

`MAX_CONCURRENT=10` per workspace. Spawn 11 returns `spawn_concurrent_exceeded` and the caller has to retry. There is no "wait for a slot" semantic.

**Workaround:** caller-side retry with backoff. The error code is typed so a client can branch on it cleanly. A v2 queue would change the contract — currently every `spawn` either launches synchronously or rejects, never blocks.

## Cancel of a deeply nested subtree is best-effort

`orchestrator.cancel(parentSpawnId)` aborts the immediate child. If that child has spawned grandchildren, the grandchildren see their parent die but are not themselves SIGTERMed by us — they may continue or may exit cleanly depending on what they were doing.

**Workaround:** call cancel on the full spawn tree. The recursive view `harness_shared.tool_invocations_spawn_tree` shows lineage; iterate descendants and cancel each. A `cancel_subtree` tool could be a v2 addition.

## Caps are per-process, not per-workspace cluster-wide

`MAX_CONCURRENT`, `MAX_DEPTH`, `MAX_CHILDREN_PER_PARENT` are enforced inside one operator process. If two operator processes both serve the same workspace (rare today but possible in the multi-workspace setup), they each enforce 10 concurrent, totalling 20.

**Workaround:** none needed in single-operator deployments. Multi-operator coordination would need the caps to read from PG, which would slow every spawn by a roundtrip. Worth the cost only if cluster mode becomes real.

## `output_tail` is truncated to 4 KB

When a spawn finishes, we capture the last 4 KB of stdout/stderr into `spawned_agents.output_tail` for postmortem inspection. Anything beyond that is dropped at write time — full output lives wherever the agent itself logged it (typically the operator's per-spawn log file).

**Workaround:** for full output, read the operator's per-spawn log from the path encoded in the agent's role + run + spawn URL. The Intel panel's Spawns tab links to it directly.

## No spawn from in-process built-in tools

Built-in tools (those declared via `defineTool`) run with a principal but no spawn URL params. They cannot themselves call `orchestrator.spawn` — the spawn machinery requires the URL-baked context (workspace, harness, parent spawn, run) that only plugin-route invocations carry.

**Workaround:** if a built-in needs to fan out work, expose its logic as a *plugin tool* instead. The decision tree in [Writing a tool](/internal/docs/endpoint-system/writing-a-tool) covers when to pick which.

## Reaper marks orphans dead, but only on first invocation per process

The startup reaper fires lazily on the first call to any `orchestrator.*` tool after process boot. It flips `status='running'` rows older than the boot time to `reaped`. Until that first call lands, ghost rows can briefly appear in the Intel panel as "running."

**Workaround:** the panel auto-polls every 30s, so the window is at most one poll cycle. Acceptable in practice.

## Cross-restart `poll` is read-only

After restart, `poll(spawnId)` returns the durable record with `fromPg: true`. You can see status, exit code, duration, output\_tail. You cannot:

* Resume the spawn (it's gone)
* Re-attach to its stream (no controller)
* Get any output beyond what was tail-captured

**Workaround:** treat post-restart spawns as immutable history. Launch a fresh spawn if you need new work done.

## What lights up free when these limits get fixed

Each of these has a clean path forward without contract churn:

| Limit                | Future fix                                                                      | Cost to plumb                           |
| -------------------- | ------------------------------------------------------------------------------- | --------------------------------------- |
| Cross-restart cancel | Watcher process + `pid` column                                                  | \~1 day, plus deciding watcher topology |
| FIFO queue           | New `spawn` option `wait_for_slot: boolean`, default false (preserves contract) | \~0.5 day                               |
| Subtree cancel       | New tool `orchestrator.cancel_subtree(rootId)` walking the recursive view       | \~0.5 day                               |
| Cluster-wide caps    | `concurrent_count` materialized in PG, refreshed every spawn                    | \~1 day, with throughput cost           |
| Larger output        | Stream to scratch file, store path in `output_ref` instead of `output_tail`     | \~0.5 day                               |

Until a real workflow demands one of these, v1.5 is the resting state.
