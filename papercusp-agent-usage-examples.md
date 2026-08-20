# Papercusp agent usage: expressive, durable examples

These examples show how an agent can combine Papercusp's first-class runtime primitives into behavior that is observable, resumable, and coordinated. The scenarios are illustrative—the named project keys do not need to exist—but the tool shapes and composition rules are grounded in the live schemas as of August 20, 2026.

The important idea is that an agent does not have to hold an entire workflow in prose. It can put durable intent in plans and work-items, live intent in coordination state, waits in the event system, changing facts in state cells, and long-running recurrence in the engine loop.

## Example 1: wait for a genuinely complicated release condition

Suppose a release may proceed by either of two routes:

1. The normal route requires review approval and any two of three platform checks.
2. The recovery route requires both rollback completion and incident closure.

`events:await` accepts a nested `all` / `any` / `some` threshold tree. It wakes the agent once when the root becomes true.

```json
{
  "spec": {
    "any": [
      {
        "all": [
          {
            "event": "demo:review-approved",
            "when": { "risk": { "lte": "moderate" } }
          },
          {
            "some": {
              "require": 2,
              "of": [
                { "event": "demo:linux-verified" },
                { "event": "demo:windows-verified" },
                { "event": "demo:macos-verified" }
              ]
            }
          }
        ]
      },
      {
        "all": [
          { "event": "demo:rollback-complete" },
          { "event": "demo:incident-closed" }
        ]
      }
    ]
  },
  "timeout_sec": 1800,
  "on_timeout": "wake",
  "note": "Release when the normal evidence threshold or the complete recovery path is satisfied. On timeout, inspect producer health instead of silently waiting again."
}
```

The composed-await contract is intentionally bounded: at most 20 leaves and three levels of nesting. `all` means every child, `any` means at least one child, and `some` means _k_ of _n_. A leaf may include a payload condition. Event-level negation is deliberately unsupported; absence is observed at the deadline.

Good agent behavior after registering the await is to end the turn. The event engine owns the wait and re-invokes the session with the matched evidence. If the tree is already satisfied, registration returns `already_satisfied` and the agent proceeds immediately.

Source: [events/await.ts](packages/operator-core/lib/agent-tools/events/await.ts)

## Example 2: declare a gate once, then let late joiners rendezvous safely

Hand-typing a custom event key into several messages is fragile. The completion owner should declare the gate first:

```json
{
  "event": "walkthrough:runtime-demo-ready",
  "announce": true,
  "announceScope": "plan",
  "announceScopeRef": "runtime-demo",
  "summary": "The runtime demo bundle is validated and ready to present."
}
```

`events:emit` returns the authoritative scoped key. A waiter copies that returned value—not a key retyped from chat—into:

```json
{
  "event": "<returned-scoped-key>",
  "timeout_sec": 1200,
  "on_timeout": "wake",
  "note": "Continue the presentation setup when the demo bundle is validated."
}
```

When the owner finishes, it emits the returned key without `announce:true`. The declaration is latched: a late waiter receives `already_fired` instead of sleeping forever on an event that already happened.

For gates delivered in a coordination message, the waiter can avoid copying the key entirely:

```json
{
  "fromMsg": "<coord-message-id-containing-one-gateRef>",
  "timeout_sec": 1200,
  "on_timeout": "wake"
}
```

Sources: [emit.ts](packages/operator-core/lib/agent-tools/events/emit.ts), [await.ts](packages/operator-core/lib/agent-tools/events/await.ts)

## Example 3: read changing state at the moment of action

An agent should not act on a deploy status copied into an earlier message. It reads the registered cell when the decision is made:

```json
{
  "cell": "gate.greenCheckpoint.candidate",
  "as": "packages/operator-core/lib/agent-tools/events/await.ts"
}
```

The result is tri-state:

- `value` means the resolver measured the cell.
- `unknown` includes a reason such as `resolver-failed`, `not-measured`, or `insufficient-data`.
- `absent` means the cell is outside this caller's readable audience.

Unknown is never equivalent to false, zero, or healthy.

If the agent needs to wait for a value to cross a threshold, it subscribes instead of polling:

```json
{
  "cell": "git.pipelinePosition",
  "as": "papercusp-agent-usage-examples.md",
  "on": { "op": "eq", "value": true },
  "of": "value",
  "once": true,
  "interval_sec": 30,
  "note": "Wake when this document is reported deployed by the registered pipeline-position cell."
}
```

`state:subscribe` is a preset over `watch:create`, so identical subscribers share the underlying poller rather than creating private loops.

Source: [cell-registrations.ts](packages/operator-core/lib/cell-registrations.ts)

## Example 4: keep ambient interest cheap and reserve wakes for action

Not every signal deserves an LLM turn. A standing topic interest can inject a digest into the inbox without waking the agent:

```json
{
  "pattern": "release-engineering",
  "targetKind": "topic",
  "wake": false,
  "once": false,
  "mode": "digest",
  "note": "Keep release-engineering context visible without spending a turn for every update."
}
```

An exact event that requires action may opt into a wake:

```json
{
  "pattern": "green-checkpoint:red:papercusp",
  "targetKind": "event",
  "wake": true,
  "once": false,
  "min_sleep_sec": 300,
  "urgency": true,
  "note": "Wake for a red shared gate; coalesce repeated emissions within five minutes."
}
```

`watch:create` controls delivery (`wake`), cardinality (`once`), cadence (`min_sleep_sec`), urgency, timeout behavior, and target kind in one subscription model.

Source: [watch.ts](packages/operator-core/lib/agent-tools/events/watch.ts)

## Example 5: let the rules engine turn a complex condition into durable action

`events:await` composes conditions for one sleeping agent. A reaction rule is different: it is durable, inspectable Event–Condition–Action wiring that applies whenever its trigger occurs. Rules are curated code rather than runtime `add-rule` calls, so the common case uses a serializable declarative condition and reserves functions for deriving action arguments.

Suppose every newly filed bug should escalate automatically when it is not quarantined and at least two risk signals agree:

```ts
import { registerReactionRule } from "./registry";

registerReactionRule({
  id: "demo:high-risk-bug-alert",
  on: "work_items:create",
  when: {
    all: [
      { "result.data.ok": true },
      { "args.kind": "bug" },
      { not: { "args.topics": { contains: "quarantined" } } },
      {
        some: {
          require: 2,
          of: [
            { "args.severity": { in: ["major", "critical"] } },
            {
              "args.title": {
                matches: { source: "security|data loss|red gate", flags: "i" },
              },
            },
            { "args.topics": { contains: "release" } },
          ],
        },
      },
    ],
  },
  fire: "coord:escalate",
  args: (event) => {
    const input = event.args as { title?: string };
    const item = (
      event.result.data as {
        workItem: { id: string; sourcePlanSlug?: string | null };
      }
    ).workItem;
    return {
      severity: "advisory",
      summary: `High-risk bug filed: ${item.id} — ${input.title ?? "untitled"}`,
      conditionKey: `high-risk-bug:${item.id}`,
      ...(item.sourcePlanSlug ? { plan_slug: item.sourcePlanSlug } : {}),
    };
  },
  mode: "durable",
  onlyOnSuccess: true,
  source: "events-file",
  dedupKey: (event) =>
    (event.result.data as { workItem?: { id?: string } }).workItem?.id ??
    "unknown",
});
```

The condition is fully inspectable: path matches are implicit ANDs; `all`, `any`, `some`, and `not` nest; leaves support equality, existence, membership, containment, numeric comparison, prefix/suffix, and regex tests. A predicate function remains an escape hatch, but using the declarative form preserves a richer graph description.

The host supplies the rest of the reaction contract. `mode:'durable'` survives a restart and retries through the durable seam; `onlyOnSuccess` prevents a failed trigger from acting; `dedupKey` makes at-least-once delivery idempotent; and the inherited cause chain caps depth and detects cycles. Bulk tool results are fanned out before matching, so this rule evaluates once per created work-item rather than against a bulk `results[]` envelope.

Sources: [rules types](libs/generic/rules/src/types.ts), [operator vocabulary](libs/generic/rules/src/operators.ts), [reaction types](libs/generic/event-reaction/src/types.ts), [registry.ts](packages/operator-core/lib/events/registry.ts)

## Example 6: inspect what can fire and explain what actually fired

Reactive behavior must not become hidden control flow. `events:graph` returns every registered `on → fire` edge, its condition kind, execution mode, provenance, and argument form. With `recent:true`, it also reads the audited firings and their cause chains.

```json
{
  "on": "work_items:create",
  "recent": true,
  "limit": 20
}
```

For the preceding example, the relevant cascade is:

```text
work_items:create
  → demo:high-risk-bug-alert
  → coord:escalate
  → emits:coord:escalate#0
  → coord:emit
```

The second rule is not a parallel notification system. `defineTool({ emits:[…] })` is co-located authoring sugar that desugars into the same reaction registry. Plugin- and blueprint-contributed rules also enter that registry under a restricted capability. Consequently one graph answers both “what could fire?” and “why did this fire?” across all three authoring forms:

1. `registerReactionRule` for contextual cross-tool behavior.
2. A tool's `emits` field for behavior intrinsic to that tool.
3. Plugin or blueprint rules for sandboxed extensions.

Sources: [graph.ts](packages/operator-core/lib/agent-tools/events/graph.ts), [emits-desugar.ts](packages/operator-core/lib/coord-lifecycle/emits-desugar.ts), [escalate.ts](packages/operator-core/lib/agent-tools/coordination/tools/escalate.ts)

## Example 7: send a message whose evidence and requested action are unambiguous

Coordination messages say what response they expect and why this recipient is involved. Different epistemic dispositions belong in different body sections.

```json
{
  "to": ["su-example-reviewer"],
  "summary": "Validate the runtime-demo event examples against the live await schema",
  "expects": "action",
  "blocking": true,
  "plan_slug": "runtime-demo",
  "why": {
    "goalRef": "WI-DEMO",
    "note": "The walkthrough cannot be called source-backed until the event shapes are checked."
  },
  "body": [
    {
      "text": "The composed tree uses only all/any/some and stays within the documented depth and leaf caps.",
      "premises": ["packages/operator-core/lib/agent-tools/events/await.ts"],
      "forYouBecause": {
        "relation": "owns",
        "ref": "event-schema-review"
      },
      "youMayNotKnow": [
        {
          "ref": "runtime-demo#D-001",
          "provenance": "authored"
        }
      ]
    },
    {
      "text": "I could not establish whether every illustrative event family has a live emitter; please treat the names as examples unless the catalog confirms them.",
      "couldNotDetermine": [
        {
          "what": "whether each demo:* key is installed in this harness"
        }
      ]
    }
  ],
  "wake": "required"
}
```

The transport reports whether a live session was actually woken. `woken:0`, `recipient_absent`, or `recipient_dead` is a failed pickup, not a successful handoff.

For new work, use `coord:dispatch`: it assigns plan items, delivers the brief, wakes the recipient, and reports pickup in one operation. For an ongoing discussion that must persist with a work-item, use `coord:message-agent` rather than a loose series of inbox pings.

Sources: [send.ts](packages/operator-core/lib/agent-tools/coordination/tools/send.ts), [dispatch.ts](packages/operator-core/lib/agent-tools/coordination/tools/dispatch.ts), [message-agent.ts](packages/operator-core/lib/agent-tools/coordination/tools/message-agent.ts)

## Example 8: turn a goal into durable, collision-safe implementation

A good implementation sequence externalizes each kind of state:

```text
plans:new
  → plans:add-item (with blockedBy edges)
  → plans:start
  → plan_items:convert / scheduler:get_next
  → coord:declare-intent (live lane + files)
  → locks:acquire (exclusive edit lease, in manual lock mode)
  → edit + verify
  → locks:release
  → work_items:complete (structured evidence)
```

The lock step follows the runtime's one effective mode. In `manual` mode the agent explicitly acquires and releases the lease. In `automatic` mode the edit hook does that around each write. Never combine the modes.

Illustrative claim conversion:

```json
{
  "plan": "runtime-demo",
  "itemIds": ["P-001", "P-002"],
  "kind": "task",
  "intent": "Author and verify the two walkthrough documents.",
  "mode": "activity",
  "ttl_sec": 1800
}
```

Illustrative file lock:

```json
{
  "paths": [
    "papercusp-agent-usage-examples.md",
    "papercusp-state-object-inventory.md"
  ],
  "intent": "Author the runtime walkthrough documents.",
  "ttl_sec": 1800,
  "wait": { "max_sec": 30 }
}
```

Completion records what landed and how it was checked, rather than merely asserting “done”:

```json
{
  "id": "WI-DEMO",
  "state": "done",
  "assumptions": "none",
  "completion": {
    "status": "done",
    "summary": "Authored and opened the source-backed walkthrough documents.",
    "whatLanded": ["Agent usage examples", "State-object inventory"],
    "verification": {
      "filesChanged": [
        "papercusp-agent-usage-examples.md",
        "papercusp-state-object-inventory.md"
      ],
      "testsRun": "Link/path validation and source cross-check",
      "testResult": "All referenced repository paths exist",
      "verifiedHow": "manual",
      "addedTests": false
    }
  }
}
```

Sources: [new.ts](packages/operator-core/lib/agent-tools/plans/new.ts), [start.ts](packages/operator-core/lib/agent-tools/plans/start.ts), [convert.ts](packages/operator-core/lib/agent-tools/plan-items/convert.ts), [acquire.ts](packages/operator-core/lib/agent-tools/locks/acquire.ts), [complete.ts](packages/operator-core/lib/agent-tools/work_items/complete.ts)

## Example 9: reuse a proven orchestration instead of rebuilding it

Before composing a repeated multi-step `code:run`, search the shared recipe library by intent and live entity context:

```json
{
  "query": "validate a Markdown runtime guide and verify every repository link",
  "limit": 5,
  "context": {
    "plan": "runtime-demo",
    "harness": "papercusp",
    "items": ["P-001"]
  }
}
```

Inspect the best match before executing it:

```json
{
  "id": "<recipe-id-from-search>"
}
```

Then pass the search result's exact `runArgs` to `recipes:run`. Entity-bound recipes include an authority proof tied to the recipe revision and current context; reconstructing that object by hand defeats the protection.

```json
{
  "id": "<recipe-id-from-search>",
  "dryRun": true,
  "authority": {
    "version": 1,
    "revision": "<revision-returned-by-search>",
    "context": {
      "plan": "runtime-demo",
      "harness": "papercusp",
      "items": ["P-001"]
    }
  }
}
```

After the dry run, execute the same returned arguments with `dryRun:false`. The recipe still runs under the caller's role-scoped tool envelope; no privilege travels from its author.

If no existing recipe fits, `code:run` is the authoring path. It runs real JavaScript control flow over only the tools the caller could already invoke, keeps intermediate payloads inside the sandbox, and returns a compact summary. A successful non-dry run captures the orchestration as a recipe automatically.

```json
{
  "title": "verify a runtime-demo plan before presentation",
  "description": "Check the demo work-items first; only read the plan and live cells when every item is terminal.",
  "dryRun": true,
  "timeoutSec": 30,
  "script": "const items = await tools.call('work_items:get', { ids: ['WI-DEMO-A', 'WI-DEMO-B'], harness: 'papercusp' });\nconst rows = items.results ?? [];\nconst unfinished = rows.filter((r) => !r.ok || !['done', 'resolved'].includes(r.workItem?.state));\nif (unfinished.length) return { ready: false, unfinished: unfinished.map((r) => r.id) };\nconst plan = await tools.call('plans:get', { slug: 'runtime-demo', harness: 'papercusp', mode: 'meta' });\nconst cells = await tools.call('state:read', {});\nreturn { ready: true, planStatus: plan.results?.[0]?.frontmatter?.status, readableCells: cells.count };"
}
```

Previewing with `dryRun:true` suppresses write-effect calls while still performing reads. After inspecting `plannedMutations`, rerun without `dryRun` to execute and capture. A rejected call aborts later calls in the script, so put indispensable durable writes before any step likely to fail.

Sources: [code/run.ts](packages/operator-core/lib/agent-tools/code/run.ts), [search.ts](packages/operator-core/lib/agent-tools/recipes/search.ts), [run.ts](packages/operator-core/lib/agent-tools/recipes/run.ts)

## Example 10: run autonomously without becoming invisible

When an owner explicitly says “run autonomously,” the session records the mode and arms a tracked loop for an open-ended objective:

```json
{
  "mode": "auto",
  "reason": "Owner asked the session to keep improving the walkthrough autonomously.",
  "ownerDirected": true
}
```

```json
{
  "intervalSec": 60,
  "goal": "Keep the runtime walkthrough accurate as the source registry changes.",
  "workItem": "WI-DEMO-MAINTENANCE",
  "carry": "warm",
  "continuation": "settle",
  "mode": "work"
}
```

The loop is visible through `loop:status` and fleet/session surfaces and can be stopped with `loop:end`. A one-shot wait still belongs in `events:await`; the loop is for ongoing work or a paced fallback when no push event exists.

Sources: [set.ts](packages/operator-core/lib/agent-tools/mode/set.ts), [arm.ts](packages/operator-core/lib/agent-tools/loop/arm.ts)

## Example 11: schedule recurring project work without confusing it with a loop

An engine loop gives one session another turn. A plan schedule creates recurring project runs that can outlive any one session. Authoring and activation are deliberately separate.

First author a DST-safe recurrence, including an exclusion, overlap policy, catch-up policy, expiry, and per-run cost cap:

```json
{
  "harness": "papercusp",
  "slug": "runtime-demo-audit",
  "schedule": {
    "kind": "rrule",
    "rrule": "FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=9;BYMINUTE=0",
    "dtstart": "2026-08-24T09:00:00-04:00",
    "tzid": "America/New_York",
    "exdate": ["2026-09-07T09:00:00-04:00"],
    "concurrency": "skip",
    "catchup": "skip-old",
    "costCapCents": 500
  },
  "expiresAt": "2026-12-31T23:59:59-05:00"
}
```

That call validates and stores the recurrence but does not start it. Activation is explicit:

```json
{
  "harness": "papercusp",
  "slug": "runtime-demo-audit"
}
```

`plans:arm-schedule` materializes a routine whose target is `system:plan-run`; each firing creates an auditable run from the plan template. Inspect the history with `plans:runs`, fire one immediately with `plans:run-now`, pause with `plans:disarm-schedule`, or remove the recurrence with `plans:set-schedule { schedule:null }`.

| Need                                          | Correct primitive              |
| --------------------------------------------- | ------------------------------ |
| Wake one agent when a pushed condition occurs | `events:await`                 |
| Maintain standing signal interest             | `watch:create`                 |
| Give one session future work turns            | `loop:arm`                     |
| Repeat project work as auditable runs         | Plan schedule                  |
| Run platform-owned maintenance                | System routine + system action |

Sources: [set-schedule.ts](packages/operator-core/lib/agent-tools/plans/set-schedule.ts), [arm-schedule.ts](packages/operator-core/lib/agent-tools/plans/arm-schedule.ts), [plan-run-action.ts](packages/operator-core/lib/harness/routines/plan-run-action.ts), [runs-list.ts](packages/operator-core/lib/agent-tools/plans/runs-list.ts)

## Example 12: put knowledge in the correct durability layer

The same sentence should not be copied into every store.

| Need                                                  | Mechanism                                       | Example                                                             |
| ----------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------- |
| Deterministic conclusion every relevant turn must see | `facts:assert`                                  | “This service has no staging endpoint; do not wait for one.”        |
| Fuzzy, durable project knowledge                      | `memory:remember`                               | “The owner prefers runtime demos organized as an end-to-end story.” |
| In-flight progress for the next wake/successor        | `work_items:checkpoint` or `loop:checkpoint`    | “Validated 8/10 cells; next inspect coverage cells.”                |
| Live presence, intent, handoff, or question           | `coord:*`                                       | “I hold P-002 and these two files.”                                 |
| Long-form how-to                                      | `docs:author` / an approved repository document | This walkthrough.                                                   |

Facts may depend on registered cells. That creates an auditable relationship between a durable conclusion and the live measurements that can invalidate it.

```json
{
  "scope": "harness",
  "scopeRef": "papercusp",
  "key": "runtime-demo-requires-green-gate",
  "body": "The runtime demo is considered shipped only when the green-checkpoint verdict and deployed SHA are both measured and consistent.",
  "confidence": "verified",
  "kind": "conclusion",
  "dependsOn": [
    { "cell": "gate.greenCheckpoint.verdict" },
    { "cell": "deploy.3070.sha" }
  ],
  "ttlSec": 604800
}
```

Sources: [assert.ts](packages/operator-core/lib/agent-tools/facts/assert.ts), [remember.ts](packages/operator-core/lib/agent-tools/memory/remember.ts)

## Example 13: supervise a fleet by push, invariants, and evidence

A leader should not repeatedly reconstruct the same health questions by hand.

```text
launch-on-plan
  → members pull work by claim spec
  → fleet transition events wake the leader
  → a long heartbeat loop protects against missed emits
  → fleet invariants run on every leader brief
  → completion evidence closes each work-item
```

Launch a three-member headless fleet on an already-started plan. The account, model, carry, and visibility choices are explicit because they affect billing, capacity, continuity, and where the sessions appear:

```json
{
  "name": "runtime-demo-audit",
  "plan": "runtime-demo",
  "harness": "papercusp",
  "agent": "codex",
  "count": 3,
  "headless": true,
  "leader": "caller",
  "account": "default",
  "model": "gpt-5.5:high",
  "carry": "warm"
}
```

Members pull rather than waiting for hand-assignment:

```json
{
  "harness": "papercusp",
  "heldPaths": ["papercusp-agent-usage-examples.md"]
}
```

The leader parks on transition events instead of polling. A timeout still wakes the leader to verify producer health:

```json
{
  "event": "fleet:member-dead:runtime-demo-audit",
  "timeout_sec": 1200,
  "on_timeout": "wake",
  "note": "On a member death, reclaim or re-steer its lane; on timeout, verify the fleet is still producing turns."
}
```

Useful transition keys include member death, claim release, item completion, context pressure, and fleet drain. Per-member state distinguishes working, parked, blocked, stalled, and needs-you. The leader brief adds conditions that generic liveness cannot see: dormant, spinning, throttled, coordination-deaf, verified-wait takeover, bench suggestions, unanswered messages, and unactuated directives.

A custom fleet invariant is a stored read-only query whose contract is “rows returned = violation.” This example guards a project-specific assumption that every member of this fleet belongs to the `papercusp` pot:

```json
{
  "fleet": "runtime-demo-audit",
  "name": "members-stay-on-papercusp",
  "description": "A row means a live fleet member is attached to the wrong pot; rebind or respawn it before trusting its lane.",
  "severity": "critical",
  "sql": "SELECT owner_id, pot_slug FROM harness_shared.coord_presence WHERE workspace_id = {{workspace}} AND fleet_slug = {{fleet}} AND heartbeat_at > now() - interval '10 minutes' AND pot_slug IS DISTINCT FROM 'papercusp'"
}
```

Register it once, then read `fleet:leader-brief` and confirm `status:'satisfied'`. Prove the detector can fire by running the same read with a deliberately wrong expected pot through `dev:pg_query` and checking that it returns rows. Registration alone proves only that SQL was stored; an errored invariant protects nothing.

Each member records terminal evidence through `work_items:complete`. The completion event automatically reaches the current fleet leader, so members do not spend another message duplicating the report. The leader winds the fleet down only after the plan is terminal and the residue is accounted for.

Sources: [launch-on-plan.ts](packages/operator-core/lib/agent-tools/fleet_registry/launch-on-plan.ts), [get_next.ts](packages/operator-core/lib/agent-tools/scheduler/get_next.ts), [invariant.ts](packages/operator-core/lib/agent-tools/fleet/invariant.ts), [adv-agent-leader-brief.ts](packages/operator-core/lib/adv-agent-leader-brief.ts)

## Compact mental model

```text
Intent       → goal / plan / work-item / current coord intent
Authority    → owner directive / mode / standing fact
Action       → tool / reaction rule / system action / recipe
Change       → event / state-cell transition / coordination message
Wait         → events:await / watch:create / state:subscribe
Recurrence   → loop / plan schedule / system routine
Concurrency  → claims / locks / claim specs / fleet roles
Continuity   → checkpoint / carry brief / fact / memory
Proof        → completion evidence / tests / scorecard / pipeline cell
```

That separation is what makes the system expressive: the agent can compose behavior without inventing a private orchestration framework, and another agent or human can inspect every important state transition after the fact.
