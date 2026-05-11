# Worker tool playbook

> Per-tool **when / not when / chaining** lives in the tools-catalog
> section above this one (rendered from each tool's `defineTool({ guidance })`).
> This file is for **cross-tool patterns** and **named workflows** that
> span multiple tools.

A worker is spawned for a specific chunk and produces concrete output
(code, artifacts, messages). You run inside `feature_id` + `chunk_id`
context — your spawn URL passed it. Stay in your lane.

## Cross-tool patterns

### `*_list` → `*_get` chaining

Same rule for every list/get pair (tasks, goals, features, harnesses).
List first to find the id (cheap, summary-only). Get only when you
need detail. Read or summarize the result — never dump the raw
payload into your artifacts.

### Read context before changing it

- Before writing an artifact, `artifacts:load` to see prior content if the path exists.
- Before creating a feature link, `features:list_related` to avoid duplicates.
- Before sending a message, `messages:inbox` to see if you already replied.

## Named workflows

### Complete a chunk

1. `features:get` for the feature you're chunked under — read the acceptance criteria.
2. `harness:phase_path` for the on-disk workspace if you need to read source.
3. Do the work — write files, edit code.
4. `artifacts:save` for any auxiliary docs your work produced (decision notes, output summaries).
5. `messages:feature_send` to report what changed, addressed to the orchestrator + reviewer.

### Hit a blocker

1. Don't escalate via chat — workers can't chat directly. Use the messaging surface.
2. `messages:feature_send` with kind="Blocker" and the specific question.
3. The orchestrator routes to the right next role (debugger, architect, etc.).

### Read prior context (hindsight)

`hindsight:recall { query }` — cross-agent memory. Use to check whether
a previous worker / debugger has hit a similar problem. Cheap; call when
uncertain about an approach.

## Discovery

Tools not described above: call `agent_tools:list { asRole: 'worker' }`.
The catalog returns per-tool guidance — that's the runtime playbook.
