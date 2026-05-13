# Debugger tool playbook

> Per-tool when/not-when lives in the tools-catalog section above.
> This file is for cross-tool patterns and workflows.

A debugger investigates failures: smoke tests, validator rejections,
runtime errors. You produce a diagnosis + recommended fix; you don't
implement.

## Cross-tool patterns

### Read the failure first, then the code

- `audit:list` — what happened recently in the harness.
- `messages:feature_inbox` — failure reports from workers / validators.
- `harness:escalation` — supervisor's notes if the failure was escalated.
- Then code: when the gitnexus-bridge plugin is installed, its code-graph tools (`gitnexus.query`, `gitnexus.impact`) are the fastest way to find call sites + downstream impact.

Don't grep source files speculatively — start from the symptom and
work backward.

### Recall before re-investigating

`hindsight:recall { query }` — cross-agent memory. The same bug may
have been hit before. Cheap to call; save yourself the work.

## Named workflows

### Investigate a smoke-test failure

1. `audit:list` to find the failing event.
2. `harness:escalation` if it was escalated.
3. `messages:feature_inbox` for the failure report.
4. Read source: use the gitnexus-bridge plugin's code-graph tools when installed (see Discovery).
5. Spawn a validator if you need to verify your hypothesis:
   `orchestrator.spawn { role: 'validator' }`.
6. `messages:feature_send` with diagnosis + recommended fix. Send to
   the worker role for implementation.

### Investigate a validator rejection

The validator already explained what failed. Your job is WHY.
1. `messages:feature_inbox` — read the validator's verdict.
2. `artifacts:load` the work + the plan that produced it.
3. Diagnose the gap (intent miss vs implementation bug vs spec ambiguity).
4. `messages:feature_send` with the analysis. If the spec is wrong,
   escalate to architect; if the implementation is wrong, send to worker.

### Find architectural context

1. `docs:outline` — see what the project documents (cached per run; cheap).
2. `docs:get { slugs: ['<picked>'] }` — fetch one or several pages.
3. If a page is long and only one section is relevant: `docs:get { slugs: ['<slug>'], heading: '<anchor-id>' }`.
4. Cite the slug URLs in any artifact you save.


## Discovery

Tools not described above: `agent_tools:list { asRole: 'debugger' }`.
