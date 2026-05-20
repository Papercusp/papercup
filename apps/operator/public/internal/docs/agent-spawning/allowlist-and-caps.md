# Allowlist & caps
URL: /internal/docs/agent-spawning/allowlist-and-caps

Who can spawn whom, and the five typed errors a spawn can fail with.

## Allowlist

Who can spawn whom. The mapping is enforced inside the plugin, not by the framework's role gate (the framework gate just says "is this caller-role allowed to call `orchestrator.spawn` at all?"; this is the finer per-target check).

| Caller role                                    | Can spawn                                                                     |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| `operator`                                     | worker, validator, scoper, reviewer, debugger, documenter, curator, architect |
| `architect`                                    | worker, validator, scoper, reviewer, debugger                                 |
| `scoper`                                       | validator, reviewer                                                           |
| `debugger`                                     | validator                                                                     |
| `reviewer`                                     | architect                                                                     |
| `worker`, `validator`, `documenter`, `curator` | (nothing)                                                                     |

Some of those choices are deliberately restrictive:

* **Worker and validator can't spawn anything.** They're the leaves of the tree. A worker that needs to fan out should escalate to architect or operator, not spawn directly.
* **Reviewer → architect** is the one bottom-up edge. It lets a reviewer kick a re-architect cycle without involving the orchestrator's main loop. Use case: reviewer notices the auth pattern is wrong; spawns architect with an `extras=['REVIEW_NOTE=auth pattern unclear, please re-plan']`.
* **Debugger → validator only.** The narrowest spawn — debugger spawns a validator to verify the patch it's about to suggest worked.
* **Operator → any.** The escape hatch. The operator role represents user-driven actions; an operator can launch anything in any direction.

## Five typed errors

Every spawn that can't run fails with one of these codes. Each gets its own `error_message` for human consumption.

### `spawn_role_not_allowed` — caller's role isn't permitted to spawn the target

```json
{
  "code": "spawn_role_not_allowed",
  "message": "Role \"worker\" cannot spawn \"validator\". Allowed: (none)."
}
```

Cancel uses the same allowlist: a scoper trying to cancel an architect spawn it didn't launch hits the same code.

### `spawn_invalid_input` — required input missing

The only case today: `role='worker'` without `chunkId`. Workers use `chunk:<id>` as their quota window; without one, the framework can't apply per-chunk limits.

```json
{
  "code": "spawn_invalid_input",
  "message": "role=\"worker\" requires chunkId so the child's tool quotas window correctly."
}
```

### `spawn_depth_exceeded` — lineage chain too deep

Default cap is `MAX_DEPTH = 3`. Counted from the in-process Map only; cross-restart depth (i.e., a spawn launched by a previous operator process) doesn't propagate, so this check is a same-session-only guard.

```json
{
  "code": "spawn_depth_exceeded",
  "message": "Spawn depth 3 >= cap 3. Cannot spawn another child from this lineage."
}
```

If you hit this often, the design pressure is "rethink the architect → worker → debugger → validator chain — could one of those steps be inlined?".

### `spawn_children_exceeded` — too many siblings

Default cap is `MAX_CHILDREN_PER_PARENT = 5`. Same caveat as depth: counted from the in-process Map.

```json
{
  "code": "spawn_children_exceeded",
  "message": "Parent already has 5 children (cap 5). Wait for some to finish or cancel before spawning more."
}
```

The cap exists to prevent an architect from accidentally launching 50 workers at once. If you legitimately need wider fan-out, raise it; there's no pressure-tested rationale for 5 specifically.

### `spawn_concurrent_exceeded` — host total too high

Default cap is `MAX_CONCURRENT = 10`. Counts every spawn currently `status='running'` across all parents in this operator process.

```json
{
  "code": "spawn_concurrent_exceeded",
  "message": "10 spawns already running (cap 10). Wait or cancel."
}
```

Per-host cap, not per-workspace. A workspace running 10 spawns can't kick off an 11th even from a different harness within the same operator process.

## How the gates compose

The full sequence when an architect calls `orchestrator.spawn(role: 'worker', featureId: 'F-001', chunkId: 'F-001-1')`:

```
1. Framework: tool exists?                          ✓ (registered)
2. Framework: HTTP method allowed?                  ✓ (POST)
3. Framework: caller role in tool's roles[]?        ✓ (architect ∈ {architect,operator,scoper,debugger,reviewer})
4. Framework: per-window quota OK?                  ✓ (architect: perRun: 30; we're under)
5. Plugin: childRole in ALLOWED[callerRole]?        ✓ (worker ∈ {worker,validator,scoper,reviewer,debugger})
6. Plugin: worker has chunkId?                      ✓
7. Plugin: depth(callerSpawnId) < 3?                ✓
8. Plugin: childrenOf(callerSpawnId) < 5?           ✓
9. Plugin: countConcurrent() < 10?                  ✓

   → SpawnRecord allocated, PG row written,
     invoke() fires in background.
```

If 1-2 fail you get HTTP 4xx with a framework error code. If 3-4 fail you get HTTP 4xx with `role_not_allowed` or `quota_exceeded`. If 5-9 fail you get HTTP 200 with an `isError: true` envelope and one of the typed `spawn_*` codes — same shape as a successful spawn, just signaling failure.

The split (HTTP-status for framework gates vs `isError` for plugin gates) matches MCP convention: the protocol carries the call envelope, the application's success/failure goes in the result body.

## Manifest reference

```jsonc
{
  "name": "spawn",
  "roles": ["architect", "operator", "scoper", "debugger", "reviewer"],
  "rolesQuota": {
    "architect": { "perRun": 30 },
    "operator":  { "perRun": 60 },
    "scoper":    { "perRun": 10 },
    "debugger":  { "perRun": 10 },
    "reviewer":  { "perRun": 10 }
  },
  "timeoutSec": 10
}
```

Quota numbers are intentionally generous — spawn itself is cheap (allocates state, fires a background promise). The expensive work is the *child agent*, which has its own quota windows. `perRun: 30` for architect means you can fan out 30 spawns in a run; the budget for what those children do is separate.
