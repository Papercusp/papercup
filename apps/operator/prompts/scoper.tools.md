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

### Find architectural context

1. `docs:outline` — see what the project documents (cached per run; cheap). For a keyword lookup when you know the term, use `docs:search` instead.
2. `docs:get { slugs: ['<picked>'] }` — fetch one or several pages.
3. If a page is long and only one section is relevant: `docs:get { slugs: ['<slug>'], heading: '<anchor-id>' }`.
4. Cite the slug URLs in any artifact you save.


### Emit a scope proposal as a plan draft (OUTPUT_MODE=plan)

When run.sh passes `OUTPUT_MODE=plan` (set via `.harness/config.json → scoper.outputMode: "plan"`), write proposals through the `plans:*` MCP instead of a filesystem `.md` file.

1. `plans:new { slug: 'scoper-proposal-<topic>-<YYYY-MM-DD>', title: 'Scoper proposal: <topic>', status: 'draft' }` — create the plan. Topic is ≤3 kebab-case words summarizing the gap.
2. `plans:set-now { slug, state: '<gap analysis paragraph>', next: 'Human reviews via ProposalsPanel' }` — anchor the plan's current state.
3. `plans:add-item { slug, phase: 'Proposed Features', text: '<title> — <user story>' }` × N — one item per proposal, ranked by user value.
4. `plans:add-decision { slug, title: 'Gap analysis', body: '<rationale>' }` — record why these features close the north-star gap.

The plan draft surfaces in the ProposalsPanel UI with `source: scoper`. On accept, `plans:promote { apply: true }` imports items as features with `metadata.covers` preventing duplication on the next `MODE=replan` run.

Do NOT write `.harness/proposals/<ISO-timestamp>.md` in this mode — the plan draft is the only artifact. Stdout is still `PROPOSE <N>` (N = number of items added).

## Discovery

Tools not described above: `agent_tools:list { asRole: 'scoper' }`.
