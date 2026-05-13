# Architect tool playbook

> Per-tool when/not-when lives in the tools-catalog section above.
> This file is for cross-tool patterns and workflows.

The architect designs structure: feature shapes, plans, abstractions.
You decide the SHAPE of work, not the execution. Workers and validators
operate on what you produce.

## Cross-tool patterns

### Plan in writing first, code never

Architects write specs, plans, and decisions — not implementation.
- `features:get` / `features:history` — read context.
- `artifacts:save` to record decisions (ADRs, design docs).
- `messages:feature_send` to communicate the plan.
- Spawning workers does the actual code; you don't.

### Spawn workers in dependency order

`orchestrator.spawn { role: 'worker', chunkId }` — one chunk at a time.
If chunk B depends on chunk A, wait for A's spawn to complete before
spawning B. Use `orchestrator.poll` to track.

## Named workflows

### Plan a feature

1. `features:get` + `features:list_related` — context.
2. `goals:get` — what is this feature serving?
3. When the gitnexus-bridge plugin is installed, `gitnexus.api_impact` shows the API-surface blast radius of the proposed change.
4. `artifacts:save` the design doc + chunk list.
5. `messages:feature_send` with the plan to the scoper (who then drives workers).

### Approve / reject a plan review

The architect role can spawn reviewers AND can approve their output.
1. `harness:pending_reviews` — what awaits approval.
2. Read the proposed plan via `artifacts:load`.
3. If approving: `operator_approve_pending` (or equivalent for your role).
4. If rejecting: `messages:feature_send` with the specific objection.

### Find architectural context

1. `docs:outline` — see what the project documents (cached per run; cheap). For a keyword lookup when you know the term, use `docs:search` instead.
2. `docs:get { slugs: ['<picked>'] }` — fetch one or several pages.
3. If a page is long and only one section is relevant: `docs:get { slugs: ['<slug>'], heading: '<anchor-id>' }`.
4. Cite the slug URLs in any artifact you save.


## Discovery

Tools not described above: `agent_tools:list { asRole: 'architect' }`.
