# Papercusp runtime demo: representative example files

Recovered from the streamed assistant answer on August 19, 2026, then extended on August 21 with the declarative event catalog. The set covers ten core runtime concepts that tell one coherent story without exposing implementation internals: stores, dispatchers, migrations, or delivery pumps.

## Core demo set

1. **`defineTool` — an authored capability**

   [packages/operator-core/lib/agent-tools/coordination/tools/escalate.ts](packages/operator-core/lib/agent-tools/coordination/tools/escalate.ts#L25)

   Demonstrates one authored capability: guidance, schema, permissions, lifecycle emission, and handler.

2. **Declared event family — the event catalog**

   [packages/operator-core/lib/events/await/catalog.ts](packages/operator-core/lib/events/await/catalog.ts#L314)

   Demonstrates the declarative side of the event system: the `fleet-drained` family declared as data — key template (`fleet:drained:<slug>`), typed params, human meaning, named emitter provenance, the poll it replaces, and its sugar verb (`fleet:await-drained`). `events:catalog` renders this registry live with per-family `live_awaiters` counts, installed-plugin families, and announced gates.

3. **Event emission**

   [packages/operator-core/lib/fleet-drained-events.ts](packages/operator-core/lib/fleet-drained-events.ts#L98)

   Demonstrates the emission of the declared `fleet:drained:<slug>` event: its payload, emission condition, and the fail-soft delivery boundary.

4. **Reaction rule**

   [packages/operator-core/lib/coord-lifecycle/lifecycle-rules.ts](packages/operator-core/lib/coord-lifecycle/lifecycle-rules.ts#L80)

   Demonstrates declarative “when X happens, invoke Y” behavior; the first rule maps `work_items:claim` to `coord:emit`.

5. **Live state cell**

   [packages/operator-core/lib/cell-registrations.ts](packages/operator-core/lib/cell-registrations.ts#L645)

   Demonstrates the `agent.goal` cell: live state, resolver, falsifier, visibility, and change signal.

6. **Routine declaration**

   [packages/operator-core/lib/harness/routines/seed-unclaimed-work-digest-routine.ts](packages/operator-core/lib/harness/routines/seed-unclaimed-work-digest-routine.ts#L27)

   Demonstrates a scheduled runtime object: cadence, target action, concurrency, and activation.

7. **System action**

   [packages/operator-core/lib/harness/routines/unclaimed-work-digest-action.ts](packages/operator-core/lib/harness/routines/unclaimed-work-digest-action.ts#L75)

   Demonstrates what the preceding routine actually does when it fires. These two files form a useful schedule → behavior pair.

8. **Blueprint**

   [libs/papercusp/packages/harness/blueprints/pair/blueprint.yaml](libs/papercusp/packages/harness/blueprints/pair/blueprint.yaml#L6)

   Demonstrates a concise driver/navigator topology: roles, coordination policy, dispatch, and spine.

9. **Agent persona**

   [libs/papercusp/packages/harness/blueprints/base/prompts/researcher.md](libs/papercusp/packages/harness/blueprints/base/prompts/researcher.md#L1)

   Demonstrates the behavioral contract supplied to one runtime role.

10. **Plugin**
    - Runtime handler: [libs/papercusp/plugins/fetch-plus/index.ts](libs/papercusp/plugins/fetch-plus/index.ts#L1)
    - Companion declaration: [libs/papercusp/plugins/fetch-plus/papercusp.json](libs/papercusp/plugins/fetch-plus/papercusp.json#L1)

    Demonstrates a removable runtime extension with a real tool handler, progress reporting, secret access, and capabilities. A plugin can also declare event families (`provides.events`); those fold into the same `events:catalog` under an `installed:<unit>` provenance tag. This is one of twenty plugins in `libs/papercusp/plugins` (Jira/Linear sync, a Slack notifier, GitHub tooling, a Postgres manager, TUI panes, and more); the plugin protocol is defined once in WIT ([packages/plugin-wit](packages/plugin-wit/README.md)), so a plugin can ship as a WASM component loadable by either the JS host (jco-transpiled at install) or the Rust host (wasmtime).

## Optional MCP bonus tabs

- **`definePrompt`:** [packages/agent-mcp/src/prompts/operator/scanner.ts](packages/agent-mcp/src/prompts/operator/scanner.ts#L44)
- **`defineResource`:** [packages/agent-mcp/src/resources/goals/list.ts](packages/agent-mcp/src/resources/goals/list.ts#L11)

## Recommended presentation order

`defineTool` → event declaration → event emission → reaction rule → state cell → routine → system action → blueprint → persona → plugin

This order tells a single runtime story:

> authored capability → declared signal → emitted signal → reaction → scheduled/system behavior → agent/blueprint behavior
