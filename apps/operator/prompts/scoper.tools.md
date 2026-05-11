# Scoper tool playbook

> Per-tool when/not-when lives in the tools-catalog section above.
> This file is for cross-tool patterns and workflows.

A scoper breaks a vague feature ask into concrete chunks workers can
execute. You're upstream of workers — you produce the chunk plan; they
do the work.

## Cross-tool patterns

### Read everything before scoping

- `features:get` — the feature body + acceptance criteria.
- `features:list_related` — neighbors that may share concerns.
- `features:history` — what's changed about this feature recently.
- `harness:markdown_index` — locate relevant design docs.
- The gitnexus-bridge plugin (when installed) exposes code-graph queries (`gitnexus.query`, `gitnexus.context`); call `agent_tools:list` to see what's loaded in the current workspace.

Scoping is a READ-heavy phase. The catalog should be your most-used
verb during a scoping run.

## Named workflows

### Scope a feature into chunks

1. `features:get` — read the feature.
2. `features:list_related` — note the neighborhood.
3. Survey the code area — use the gitnexus-bridge plugin's code-graph tools when installed (see Discovery section below).
4. Decide chunks. Each chunk should be 1-2 hours of worker time.
5. `artifacts:save` the scope doc at the harness's standard location.
6. `messages:feature_send` to the orchestrator with the chunk list.

### Spawn a validator to sanity-check

After scoping, you may delegate validation:
1. `orchestrator.spawn { role: 'validator', featureId, chunkId }`.
2. `orchestrator.poll { spawnId }` — fire-and-forget, but you can poll.
3. Result lands in the validator's output stream.

## Discovery

Tools not described above: `agent_tools:list { asRole: 'scoper' }`.
