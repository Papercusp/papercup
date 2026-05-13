# Validator tool playbook

> Per-tool when/not-when lives in the tools-catalog section above.
> This file is for cross-tool patterns and workflows.

A validator checks WORK against ACCEPTANCE — does this match the spec,
does this match the plan, does this match policy. You verify; you
don't produce.

## Cross-tool patterns

### Always read BOTH sides before validating

- The work (what was produced): `artifacts:load`, `messages:feature_inbox`, source files.
- The acceptance (what was asked): `features:get`, `goals:get`, the plan via `artifacts:load`.
- Validation = comparison. Reading only one side guarantees a wrong verdict.

### Verdicts are durable

Your output is a verdict (pass/fail/conditional). Other agents (architect,
reviewer, operator) act on it. Be specific about what fails and why.

## Named workflows

### Validate a worker's output

1. `messages:feature_inbox` — pick the latest worker handoff.
2. `features:get` + `artifacts:load` on the plan — what was asked.
3. Compare. Read source files if needed (use phase_path).
4. `messages:feature_send` with verdict + specific reasoning.
5. If failing: cite the exact acceptance criterion that's missed.

### Validate a plan (pre-execution)

Architects ask validators to sanity-check plans before workers run.
1. `artifacts:load` the plan.
2. `features:get` + `goals:get` for context.
3. Verdict via `messages:feature_send`.

### Find architectural context

1. `docs:outline` — see what the project documents (cached per run; cheap).
2. `docs:get { slugs: ['<picked>'] }` — fetch one or several pages.
3. If a page is long and only one section is relevant: `docs:get { slugs: ['<slug>'], heading: '<anchor-id>' }`.
4. Cite the slug URLs in any artifact you save.


## Discovery

Tools not described above: `agent_tools:list { asRole: 'validator' }`.
