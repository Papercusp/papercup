# Papercusp 30-minute runtime demo: presenter script and FAQ

This is a presenter-ready runbook for a hard 30-minute Papercusp demo. It is organized around one story rather than a catalog of subsystems:

> A capability is authored with an explicit contract, its actions emit signals, rules turn those signals into further behavior, live state stays inspectable, and durable work/coordination objects let agents continue safely across time and concurrency.

The core presentation is designed for **28 minutes of material plus a 2-minute close/Q&A buffer**. The FAQ is preparation material, not content to read during the main walkthrough.

## What the audience should understand by the end

The audience should leave with five ideas:

1. Papercusp is a runtime and coordination substrate, not a long prompt pretending to be infrastructure.
2. Tools, events, reaction rules, state cells, routines, blueprints, personas, plugins, plans, work-items, fleets, waits, and recipes have distinct jobs.
3. Those objects compose into observable workflows without hiding control flow inside one agent's transcript.
4. Concurrency and continuity are explicit: claims, locks, checkpoints, event wakes, fleet roles, and completion evidence are first-class.
5. The runtime preserves uncertainty and provenance instead of converting an unread value into a confident answer.

## Supporting documents

Keep these three guides open as reference and fallback material:

- [Papercusp agent usage: expressive, durable examples](papercusp-agent-usage-examples.md)
- [Papercusp state-object inventory](papercusp-state-object-inventory.md)
- [Papercusp runtime demo: representative example files](papercusp-runtime-demo-example-files.md)

## Strict run-of-show

| Time        | Segment                        | Main point                                                                                                  |
| ----------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| 0:00–1:30   | Hook and mental model          | Papercusp externalizes the state an agent would otherwise carry privately in prose.                         |
| 1:30–4:30   | An authored tool               | One definition combines human guidance, machine schema, authority, lifecycle emission, and implementation.  |
| 4:30–6:30   | A declared, awaitable event    | Event families are declared as data — named, discoverable, awaitable — not improvised strings or polls.     |
| 6:30–11:00  | Reaction rule and causal graph | Declarative event–condition–action behavior remains durable, bounded, deduplicated, and explainable.        |
| 11:00–14:00 | Registered live state          | Cells preserve provenance, relativity, falsifiers, and `unknown` rather than publishing convenient guesses. |
| 14:00–16:30 | Routine and system action      | Time policy is separated from executable behavior.                                                          |
| 16:30–19:00 | Blueprint and persona          | Topology and role behavior are declarative, inspectable, and reusable.                                      |
| 19:00–21:30 | Plugin                         | Extension code runs through an explicit manifest, capability, schema, and secret contract.                  |
| 21:30–26:00 | Live operational story         | Show a plan/work-item, an active agent or fleet, an event wake, and recipe reuse as one flow.               |
| 26:00–28:00 | Synthesis                      | Reassemble the primitives into one compact model and state the architecture boundary.                       |
| 28:00–30:00 | Close and questions            | Repeat the thesis, answer one or two questions, and park the rest for the FAQ.                              |

Do not add material because an earlier section went quickly. Preserve the buffer.

## Before the room: five-minute setup checklist

### VS Code tabs

Open the tabs in this order. Put the three guides in one tab group and the representative source files in a second group.

1. This presenter script.
2. [Runtime demo file index](papercusp-runtime-demo-example-files.md).
3. [Agent usage examples](papercusp-agent-usage-examples.md).
4. [State-object inventory](papercusp-state-object-inventory.md).
5. [`coord:escalate` tool definition](packages/operator-core/lib/agent-tools/coordination/tools/escalate.ts#L25).
6. [Event-catalog declaration](packages/operator-core/lib/events/await/catalog.ts#L314).
7. [Fleet-drained event emission](packages/operator-core/lib/fleet-drained-events.ts#L98).
8. [Lifecycle reaction rules](packages/operator-core/lib/coord-lifecycle/lifecycle-rules.ts#L80).
9. [`agent.goal` state cell](packages/operator-core/lib/cell-registrations.ts#L645).
10. [Routine declaration](packages/operator-core/lib/harness/routines/seed-unclaimed-work-digest-routine.ts#L27).
11. [System action](packages/operator-core/lib/harness/routines/unclaimed-work-digest-action.ts#L75).
12. [Pair blueprint](libs/papercusp/packages/harness/blueprints/pair/blueprint.yaml#L6).
13. [Researcher persona](libs/papercusp/packages/harness/blueprints/base/prompts/researcher.md#L1).
14. [Plugin handler](libs/papercusp/plugins/fetch-plus/index.ts#L1).
15. [Plugin declaration](libs/papercusp/plugins/fetch-plus/papercusp.json#L1).

Keep the two optional MCP examples closed unless someone asks about MCP prompts or resources:

- [`definePrompt`](packages/agent-mcp/src/prompts/operator/scanner.ts#L44)
- [`defineResource`](packages/agent-mcp/src/resources/goals/list.ts#L11)

### Live-demo prerequisites

Prepare these before the audience arrives; do not create them while narrating:

- One small plan with two or three visible items and at least one dependency edge.
- One work-item with a checkpoint and one completed work-item with verification evidence.
- One live agent or small fleet whose current intent and claim are safe to show.
- One harmless, uniquely named demo gate that has a registered waiter.
- One known recipe search query that returns a useful match, plus its dry-run arguments.
- A fallback capture or the corresponding section of [the agent-usage guide](papercusp-agent-usage-examples.md) for every live step.

Use the actual plan, work-item, fleet, event key, and recipe returned during rehearsal. Never retype an event key from memory during the presentation.

### Presentation hygiene

- Increase editor font size and hide unrelated sidebars.
- Start each file at the cited line rather than searching live.
- Collapse comments that would distract from the contract being shown.
- Keep one terminal or operator window ready for the live segment.
- Disable notifications that could expose unrelated coordination traffic.
- Rehearse once with a stopwatch. The target is 26–27 minutes before questions.
- If a live read is `unknown`, explain it; do not retry until it happens to look green.

## The 30-minute presenter script

## 0:00–1:30 — Open with the problem, not the feature list

### Show

Open this document at **What the audience should understand by the end**, then briefly show the [compact mental model](papercusp-agent-usage-examples.md#compact-mental-model).

### Say

> Most agent systems can call tools, but the hard part starts when work lasts longer than one turn, involves more than one agent, or must be explained afterward. If intent, waiting, authority, progress, and proof live only in a transcript, the system becomes fragile and invisible.
>
> Papercusp gives those concerns first-class runtime objects. Today I will follow one path from an authored capability, through events and reaction rules, into live state and durable coordination. The point is not the number of APIs. The point is that each kind of state has a named home and can be inspected independently of the model's prose.

### Land this point

Papercusp is not trying to make the model remember the workflow. It makes the workflow explicit enough that a human, another agent, or a resumed session can recover it.

### Do not detour into

- Product history.
- A complete namespace inventory.
- Database tables.
- Every UI panel.

## 1:30–4:30 — Show one authored capability

### Show

Open [`packages/operator-core/lib/agent-tools/coordination/tools/escalate.ts`](packages/operator-core/lib/agent-tools/coordination/tools/escalate.ts#L25) at `defineTool`.

Point to these elements in order:

1. `name` and human-readable `description`.
2. `guidance.when` and `guidance.notWhen`.
3. `capability` and the allowed roles.
4. `emits`, which connects successful execution to a lifecycle signal.
5. The Zod argument schema, including the stable `conditionKey` used for coalescing.

Do not scroll through the entire handler.

### Say

> This is a tool definition, but it is more than a function exported to an LLM. The same definition tells a person when the tool is appropriate, gives the model a machine-readable schema, declares the authority required to call it, limits the roles that receive it, and describes what lifecycle signal follows a successful call.
>
> The `conditionKey` is a small but important example. Repeated reports of the same recurring condition coalesce instead of creating endless duplicate escalations. The contract is designed for a long-running system, not just one successful invocation.

### Land this point

The authored capability is the first inspectable unit: guidance, shape, authority, side effects, and implementation meet at one seam.

### If asked immediately, “Is this just MCP?”

> MCP can expose tools, prompts, and resources. Papercusp uses those interfaces, but this definition also participates in runtime authority, events, coordination, audit, and role-scoped delivery. MCP is an interface boundary; it is not the whole control plane.

## 4:30–6:30 — Turn a state change into a declared, awaitable event

### Show, part 1: the declaration

Open [`packages/operator-core/lib/events/await/catalog.ts`](packages/operator-core/lib/events/await/catalog.ts#L314) at the `fleet-drained` entry. Highlight, in order:

1. The key template with a typed parameter: `fleet:drained:<slug>`.
2. The human meaning of the transition.
3. The named emitter provenance.
4. `replacesPoll` on neighboring entries — the poll each event exists to retire.
5. The sugar verb: `fleet:await-drained`.

### Say

> Events are declared, not improvised. This registry is the single source of truth for awaitable event families: one entry declares the key template, what the transition means, which code emits it, which polling pattern it replaces, and the sugar verb that wraps the wait. The discovery tool, the await primitives, and the polling tools' own “stop polling — await this instead” hints all read this same declaration, so the catalog and the emitters cannot drift apart.

### Show, part 2: the emission

Switch to [`packages/operator-core/lib/fleet-drained-events.ts`](packages/operator-core/lib/fleet-drained-events.ts#L98). Highlight:

- The emission of the exact declared key family.
- The human summary and structured payload.
- The fail-soft boundary: an event-delivery problem cannot roll back the state transition that caused it.

### Say

> Once a fleet has no remaining claimable lane, the runtime emits the declared key with a payload identifying the fleet. A waiting agent does not need to re-query the database every few seconds or agree on a prose phrase like “looks done.” It waits for the runtime's transition.
>
> The event is deliberately downstream of the authoritative state change. If event delivery fails, it is diagnosed as a delivery problem; it does not undo or corrupt the fleet's actual status.

### Land this point

Events are first-class declared objects — named, typed, discoverable, awaitable — and the emission stays downstream of truth, never the truth itself.

### One sentence on discovery

> Live, `events:catalog` renders this registry — plus event families contributed by installed plugins and any leader-declared gates — each with a `live_awaiters` count, so an emitter can see who is actually listening and an agent about to poll finds the push-based key instead.

### One sentence on late joiners

> For coordination gates, Papercusp can declare the authoritative scoped key first and latch the fire, so a late waiter receives `already_fired` instead of sleeping forever.

## 6:30–11:00 — Show the rules engine and explain the cause chain

### Show, part 1: a real lifecycle rule

Open [`packages/operator-core/lib/coord-lifecycle/lifecycle-rules.ts`](packages/operator-core/lib/coord-lifecycle/lifecycle-rules.ts#L80).

Point to the five-part shape:

1. Stable rule id.
2. `on: 'work_items:claim'`.
3. A condition that checks successful output.
4. `fire: 'coord:emit'`.
5. Derived arguments and `onlyOnSuccess`.

### Say

> This rule says that a successful work-item claim produces a coordination emission announcing who took the work. The claimant does not have to remember a second hand-written status call. That convention is runtime behavior, and the rule is visible as an Event–Condition–Action edge.

### Show, part 2: expressive declarative conditions

Switch to [Example 5 in the agent-usage guide](papercusp-agent-usage-examples.md#example-5-let-the-rules-engine-turn-a-complex-condition-into-durable-action). Show the high-risk bug example without reading every line.

Point to:

- Nested `all`, `some`, and `not`.
- Path-based field tests.
- Membership, containment, numeric, and regex operators.
- `mode: 'durable'`, `onlyOnSuccess`, and `dedupKey`.

### Say

> Conditions can remain serializable and inspectable even when they are expressive. Nested `all`, `any`, `some`, and `not` compose with field operators. A function is still available when arguments must be derived from the triggering result, but the decision logic does not need to disappear into an opaque callback.
>
> Durable delivery is at least once, so correctness depends on idempotency. The stable deduplication key makes the action safe to retry. The inherited cause chain also caps depth and detects cycles, so a reaction cascade cannot recurse forever.

### Show, part 3: explainability

Move to [Example 6](papercusp-agent-usage-examples.md#example-6-inspect-what-can-fire-and-explain-what-actually-fired) and show this chain:

```text
work_items:create
  → demo:high-risk-bug-alert
  → coord:escalate
  → emits:coord:escalate#0
  → coord:emit
```

### Say

> `events:graph` answers two different questions from the same registry: what could fire, and what actually fired recently. It includes rule provenance, condition kind, execution mode, and audited cause chains. Tool-local `emits`, contextual reaction rules, and restricted plugin or blueprint rules converge into this graph rather than creating separate hidden automation systems.

### Land this point

The rule engine is expressive, but expressiveness is not allowed to erase provenance, retry safety, or causal inspection.

### Time check

You should reach **11:00** here. If you are late, skip the live `events:graph` call and leave the prepared cause-chain example on screen.

## 11:00–14:00 — Show a state cell that refuses to lie

### Show

Open [`packages/operator-core/lib/cell-registrations.ts`](packages/operator-core/lib/cell-registrations.ts#L645) at `AGENT_GOAL_CELL`.

Point to:

1. Stable cell id and owner.
2. The headline value.
3. The independent falsifier.
4. Null/unknown handling.
5. Caller relativity through `ownerId`.

Then show the [registered live-state table](papercusp-state-object-inventory.md#2-registered-live-state-cells).

### Say

> A state cell is a registered answer to an operational question. `agent.goal` is not “the newest thing that looks like a goal in a log.” It resolves current state and declares how that answer can be falsified.
>
> This cell is parameterized by the agent being inspected. It can say that nothing is held, that several claims compete, or that the resolver could not establish an answer. Papercusp preserves `value`, `unknown`, and `absent` because an unread value must not become a false green, a zero, or an empty list.

### Optional UI gesture

If the conversation popup is already open, point out that its Orders, Activity, Fleet, and transcript areas come from independent reads. Do not tour every field.

### Land this point

Live state is a contract with provenance and uncertainty, not a dashboard label reverse-engineered from whichever table was convenient.

## 14:00–16:30 — Separate the clock from the work

### Show

Open these files side by side:

- [Routine declaration](packages/operator-core/lib/harness/routines/seed-unclaimed-work-digest-routine.ts#L27)
- [System action](packages/operator-core/lib/harness/routines/unclaimed-work-digest-action.ts#L75)

In the routine, point to cadence, trigger configuration, target role, concurrency, catch-up policy, and active state. In the action, point to the registered name, the work-item read, digest composition, and coordination broadcast.

### Say

> The routine owns the question “when should this happen?” The system action owns “what should happen?” Here, a daily routine invokes a read-only digest action. The schedule can be paused, inspected, or retuned without duplicating the behavior, and the action can be tested independently of the clock.
>
> This is also why Papercusp distinguishes four concepts that often get blurred together: an event wait wakes one agent on a pushed condition; a loop gives one session more work turns; a plan schedule creates recurring auditable project runs; and a system routine runs platform-owned maintenance.

### Land this point

Time policy and executable behavior are separate runtime objects.

## 16:30–19:00 — Show topology and role behavior as data

### Show

Open the [pair blueprint](libs/papercusp/packages/harness/blueprints/pair/blueprint.yaml#L6), then the [researcher persona](libs/papercusp/packages/harness/blueprints/base/prompts/researcher.md#L1).

In the blueprint, point to:

- Inheritance from `base`.
- Dispatch concurrency and the claim model.
- Coordination policy.
- Driver and navigator roles.

In the persona, point to:

- One bounded responsibility.
- Expected evidence and uncertainty handling.
- The instruction not to expand scope.

### Say

> A blueprint describes how agents are arranged: roles, topology, concurrency, coordination policy, and runtime spine. A persona describes how one role should behave inside that arrangement.
>
> Keeping them separate lets the same behavioral role participate in different topologies, and lets a topology evolve without copying a giant system prompt. The pair blueprint is intentionally concise: the driver writes, the navigator continuously reviews, and the coordination policy makes that relationship explicit.

### Land this point

The model prompt is one component of the runtime, not the runtime itself.

## 19:00–21:30 — Show a capability-scoped plugin

### Show

Open the [fetch-plus handler](libs/papercusp/plugins/fetch-plus/index.ts#L1) and [its manifest](libs/papercusp/plugins/fetch-plus/papercusp.json#L1) side by side.

In the handler, point to:

- Typed input.
- Protocol validation.
- Progress reporting.
- Abort signal.
- Bounded output.
- Optional secret access.

In the manifest, point to:

- Version and Papercusp compatibility.
- Explicit capabilities.
- Input schema and guidance.
- Roles and quotas.
- HTTP/MCP exposure.
- Configuration schema.

### Say

> A plugin is a removable runtime extension, not arbitrary code silently added to every agent. The handler implements the behavior, while the manifest declares compatibility, schema, roles, quotas, network authority, and the specific secret it may request.
>
> Notice that secret access and outbound HTTP access are named capabilities. The plugin does not inherit every credential or every network destination simply because it runs in the same application.
>
> Two more things worth saying while this file is open. First, this is one of twenty plugins in the tree — Jira and Linear sync, a Slack notifier, GitHub tooling, a Postgres manager, TUI panes — so this seam is exercised, not aspirational. Second, a plugin's reactive behavior goes through the same event-reaction registry we saw earlier: there is no separate hook-and-filter bus — that layer was deliberately retired — so plugin rules and plugin-fired events appear in the same causal graph as everything else, and `plugins:runtime_status` shows what is loaded right now.

### Land this point

Extension points remain inspectable and capability-scoped.

## 21:30–26:00 — Run one live operational story

This segment should feel like one workflow, not four unrelated tool demonstrations. Use prepared objects and keep each step under one minute.

### Step 1 — Plan and work-items: externalize intent and proof

#### Show

Open the prepared plan and its work-item list in the operator or a bounded tool result. Show:

- The objective.
- Two or three plan items and one `blocked-by` edge.
- A work-item claim/checkpoint.
- A completed item's verification evidence.

#### Say

> The plan captures decomposition, dependencies, decisions, and what comes next. Work-items are the executable units agents claim. A checkpoint carries in-flight state across a wake or replacement session; completion records what landed and how it was verified. “I said done in chat” is not the terminal record.

### Step 2 — Active agent or fleet: make concurrency visible

#### Show

Open the prepared active session or fleet view. Point to:

- Current intent.
- Claimed work-item.
- Working, parked, blocked, or stalled state.
- One lock or declared file if present.
- Leader/member roles and a fleet invariant if prepared.

#### Say

> Assignment, a live claim, declared intent, and recent productive activity are different signals. The runtime keeps them separate so a leader can distinguish working from merely present, parked from ended, and an active wait from a stranded lane. Members pull work through a claim specification; leaders supervise transitions and evidence rather than hand-feeding every task.

### Step 3 — Event wake: demonstrate push and latching

#### Show

Show the prepared waiter and emit the already-declared harmless gate using the exact returned key. Then show the waiter wake or the `already_fired` result.

#### Optional gesture (only if ahead of schedule)

Before firing, run `events:catalog` and point to the declared gate in its announced section: its latch state and `live_awaiters: 1` — the prepared waiter, visible before the emit. Skip this without comment if time is tight.

#### Say

> The waiting session ends its turn. It does not burn tokens asking whether the condition changed. The runtime wakes it when the declared gate fires. If the fire happened before registration, the latch returns immediately instead of creating a dead wait.

Do not invent a new key live. If the waiter does not wake promptly, show [Example 2](papercusp-agent-usage-examples.md#example-2-declare-a-gate-once-then-let-late-joiners-rendezvous-safely) and say:

> The live delivery is delayed, so I am switching to the recorded contract rather than pretending a timeout is a success. The relevant distinction is declared, fired, delivered, and woken—those are four observable states.

### Step 4 — Recipe reuse: show orchestration becoming reusable

#### Show

Run the rehearsed recipe search, inspect the top match, and show its exact dry-run arguments. If time permits, execute only the dry run and point to the planned mutations.

#### Say

> Before composing repeated multi-step tool calls, an agent searches the recipe library. The selected recipe carries provenance, revision, and context-bound authority. It still runs inside the caller's capabilities; no privilege is inherited from the recipe's author.
>
> If no recipe fits, `code:run` provides real control flow over the same permitted tools, keeps intermediate payloads out of the transcript, and captures a successful orchestration for reuse.

### Land this point

Plans, work-items, fleets, waits, and recipes are the operational form of the same architecture: explicit intent, explicit state transitions, explicit authority, and explicit proof.

### Time check

Stop this segment at **26:00**, even if a live response is still streaming. Use the prepared guide as the source of truth and move to the synthesis.

## 26:00–28:00 — Reassemble the system

### Show

Return to the [compact mental model](papercusp-agent-usage-examples.md#compact-mental-model).

### Say

> We followed one path from an authored tool to an event, from the event to a durable reaction, from the reaction to inspectable state and coordination, and from there to plans, fleets, waits, and reusable orchestration.
>
> The important boundary is what I did not show: raw storage tables, dispatch internals, migrations, or delivery pumps. Those implement the runtime, but they are not the objects an agent should reason about directly. The agent-facing model is intentionally smaller: intent, authority, action, change, wait, recurrence, concurrency, continuity, and proof.

Read the final mapping slowly:

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

### Land this point

Papercusp makes multi-agent work recoverable and explainable by externalizing the runtime state that would otherwise be hidden in conversations.

## 28:00–30:00 — Close cleanly

### Say

> The shortest description of Papercusp is: it gives agents a shared, typed, inspectable operating environment. Models can change, sessions can end, and work can move between agents without requiring the workflow to be reconstructed from prose.
>
> Every example shown today is grounded in a current runtime definition. The larger guides contain the detailed schemas and examples, so we can go deep on any one area without stretching this half-hour overview.

Take one or two short questions. If a question needs more than 45 seconds, say:

> That deserves a precise answer rather than a rushed one. I have it covered in the FAQ and can take it immediately after the timed walkthrough.

## Timing guardrails and cut order

### Hard checkpoints

| Clock | You should be at            | If you are late                                          |
| ----- | --------------------------- | -------------------------------------------------------- |
| 4:30  | Leaving the tool definition | Stop discussing handler implementation.                  |
| 11:00 | Leaving rules and graph     | Show the prepared cause chain; skip the live graph call. |
| 16:30 | Leaving routine/action      | Use the one-sentence wait/loop/schedule distinction.     |
| 21:30 | Starting the live story     | Show blueprint and persona without reading their prose.  |
| 26:00 | Ending all live actions     | Abandon any streaming call and use the prepared example. |
| 28:00 | Beginning the close         | Take at most two questions.                              |

### First things to cut

1. Optional UI gesture during the state-cell section.
2. Optional `events:catalog` gesture in the live story; retain the prepared waiter demonstration.
3. Live `events:graph`; retain the prepared cause-chain diagram.
4. Detailed persona prose; retain the blueprint/persona distinction.
5. Recipe dry-run execution; retain search and the returned run arguments.
6. All optional MCP material.

### Never cut

- The opening problem statement.
- One concrete tool definition.
- The event-catalog declaration (events are declared, not improvised).
- The rule-engine cause chain.
- The `unknown`/`absent` state distinction.
- The live operational story's plan/work-item view.
- The final synthesis.

## Presenter FAQ

Use these as spoken answers. Lead with the first paragraph; add the “If they press” detail only when needed.

## A. Positioning and architecture

### 1. What is Papercusp in one sentence?

Papercusp is a shared, typed, inspectable operating environment for agents: it externalizes intent, authority, work, coordination, waiting, continuity, and proof so those concerns do not live only inside one model's conversation.

### 2. Is Papercusp an agent framework?

It can support agent applications, but “framework” is too narrow. Papercusp is the runtime and coordination substrate around agents: tools, state, events, work ledgers, fleets, scheduling, continuity, permissions, and operational evidence. A model or framework can sit on top of it without becoming the source of truth for those concerns.

### 3. Is this just a large system prompt?

No. Personas and instructions exist, but they are one runtime-definition type among many. Claims, locks, plans, work-items, event subscriptions, state cells, schedules, checkpoints, and completion records survive independently of prompt text and can be inspected by other actors.

### 4. Is this just MCP with extra tools?

MCP is one interface through which tools, prompts, and resources can be exposed. Papercusp adds shared runtime semantics around that interface: role-scoped authority, event causality, durable work, coordination, scheduling, fleet supervision, state provenance, and recovery. The optional `definePrompt` and `defineResource` examples show MCP-native surfaces, but they are not the entire architecture.

### 5. What is the core design principle?

Give each kind of operational state one explicit home. Intent belongs in plans, work-items, and live declarations; waits belong in events and watches; recurrence belongs in loops, plan schedules, or routines; continuity belongs in checkpoints and carry; proof belongs in completion evidence and measured cells.

### 6. Why so many object types?

Because the distinctions affect correctness. A declared event is not a fired event; a message delivered is not a session woken; an assignment is not a live claim; a loop is not a shared schedule; and an unknown read is not false. Combining those concepts into one generic “agent state” object would make the system smaller on paper and less reliable in practice.

### 7. What is the source of truth: the UI, the transcript, or the database?

The runtime object that owns the fact is the source of truth; the UI and transcript are projections. For example, current fleet membership comes from live fleet/presence state, historical audience traffic comes from the append-only coordination stream, and completion comes from the work-item record. The demo deliberately shows agent-facing objects rather than raw storage tables.

### 8. Why not show registries, stores, dispatchers, migrations, and pumps?

Those are implementation mechanics. They matter to maintainers, but they are not the stable vocabulary an agent or operator should use to reason about work. The demo stays at the authored-runtime and agent-visible state boundary so the architecture remains understandable in half an hour. The event catalog shown in the event segment is the deliberate exception that proves the boundary: it is an authored, agent-facing declaration rendered live by a discovery tool, not an implementation registry.

### 9. Is Papercusp model- or provider-specific?

The runtime concepts are model-independent. A session records its backend, model, account route, and context settings, but plans, work-items, events, cells, recipes, and evidence do not depend on one provider's private transcript format. Provider-specific adapters still exist at the execution boundary.

### 10. Can one agent use Papercusp, or is it only useful for fleets?

One agent benefits from plans, work-items, state cells, event waits, loops, recipes, checkpoints, and proof. Fleets add concurrency, pull-based scheduling, member liveness, leader supervision, and invariants. The single-agent path and fleet path share the same substrate rather than becoming separate products.

## B. Tools, rules, and reactive behavior

### 11. What makes a Papercusp tool different from an ordinary function call?

A tool definition co-locates human guidance, machine schema, capability requirements, eligible roles, lifecycle emissions, and implementation. The runtime can therefore decide who receives it, validate inputs, explain intended use, and connect successful calls to the event graph.

### 12. Can rules be added dynamically by any agent?

The demonstrated reaction rules are curated code, not an unrestricted runtime `add-rule` endpoint. That keeps rule installation reviewable and capability-scoped. Tool-local `emits` and restricted plugin or blueprint contributions still converge into the same registry, so there is one graph even though there are several authoring forms.

### 13. What conditions can the rules engine express?

Declarative conditions support nested `all`, `any`, `some`, and `not`, plus path-based equality, existence, membership, containment, numeric comparison, prefix/suffix, and regular-expression tests. Function predicates remain an escape hatch, especially for derived arguments, but the declarative form produces richer inspection data.

### 14. How do durable rules handle retries?

Durable execution is at least once, so the action must be idempotent. A stable `dedupKey` ties retries to the same logical occurrence, and `onlyOnSuccess` prevents downstream action when the trigger itself failed. The correct claim is retry-safe when the rule supplies an appropriate deduplication contract—not magical exactly-once execution.

### 15. What prevents reaction loops?

The event carries an inherited cause chain. The runtime detects cycles and caps causal depth, so a cascade cannot recurse without bound. `events:graph { recent:true }` exposes the chain used to explain a firing.

### 16. How do you debug “why did this happen?”

Start with `events:graph` scoped to the triggering or fired event and include recent firings. It shows registered edges, condition kind, execution mode, provenance, argument form, and audited cause chains. Then inspect the owning runtime object rather than reconstructing causality from timestamps in several logs.

### 17. How do you answer “what could happen if I call this tool?”

Inspect the tool definition's `emits` entries and the event graph's outgoing edges. Because tool-local emissions and standalone reaction rules share the registry, the graph can show both intrinsic and cross-tool follow-on behavior.

### 18. What is the difference between an event and a state cell?

An event records that a transition occurred and can wake subscribers. A state cell answers a current operational question at read time and declares provenance, relativity, unknown behavior, and a falsifier. Events are change signals; cells are measured state.

### 19. What is the difference between `events:await`, `watch:create`, and `state:subscribe`?

`events:await` is a one-shot wake for an event condition. `watch:create` is the general standing subscription primitive and can deliver a cheap inbox digest or wake a session. `state:subscribe` watches a registered cell for a threshold crossing and shares the underlying poller with identical subscribers.

### 20. Can an await express complex conditions?

Yes. A composed await can nest `all`, `any`, and `some { require, of }`, with optional payload conditions on leaves. It is intentionally bounded—currently at most 20 leaves and three levels—so a wait remains inspectable and operationally safe.

### 21. Can you wait for something not to happen?

Absence is evaluated at a deadline, not treated as a normal event-level negation. Register the relevant wait with a timeout that wakes the session, then inspect producer health and the absence condition. This avoids pretending that silence is a positively observed signal.

### 22. What happens if the event fired before the agent started waiting?

Use a declared, latched gate for rendezvous conditions. The completion owner declares the authoritative scoped key and later fires that exact key; a late waiter receives `already_fired`. A hand-typed ad hoc key has no such safety guarantee.

### 23. Why not just poll?

Polling consumes turns, introduces detection delay, duplicates load, and can still miss the distinction between “not changed” and “read failed.” Push events are preferred for transitions, while cell subscriptions share a poller when the underlying source genuinely requires measurement. A paced loop is the fallback when no push source exists and must include producer-health checks.

Discovery is part of the answer: `events:catalog` lists every awaitable key family — key template, meaning, emitter, the poll it replaces, its sugar verb, and how many agents are listening right now — and the polling tools themselves advertise the awaitable key that replaces them, so an agent about to poll is pointed at the push-based alternative.

## C. State, truth, and observability

### 24. Why are `unknown`, `absent`, `false`, zero, and empty separate?

They describe different realities. `false` is a measured negative; `unknown` means the resolver could not establish a value; `absent` means the caller is not allowed to read the cell; zero and empty are measured values. Flattening them creates false green dashboards and unsafe agent decisions.

### 25. What is a cell falsifier?

A falsifier is an independent measurement that can kill a tempting interpretation of the headline value. For `agent.goal`, a second relationship can reveal competing claims that make one selected goal misleading. It forces the cell author to encode not only an answer but also how that answer could be wrong.

### 26. Are state cells just cached SQL queries?

No. A cell is a registered semantic contract: stable identity, resolver, headline, relativity, visibility, provenance, unknown behavior, falsifier, and change signal. Its implementation may query storage, but callers depend on the contract rather than the table layout.

### 27. Why not infer current state from the newest log entry?

A log says what was true when an event or call was recorded. Current state may change between entries, and an agent can declare intent before producing another tool call. Papercusp separates current-state cells and presence from historical stamps so postmortem evidence does not masquerade as a live answer.

### 28. How does the conversation popup get its data?

It combines independent reads for roster/session state, orders and carried authority, detailed activity, fleet-leader alerts, and the native transcript stream. A failure in one read is rendered as unavailable rather than causing the UI to invent an empty list. That independence is why the popup can distinguish “nothing exists” from “this surface could not be read.”

### 29. Can state be audience-specific?

Yes. Cells declare whether they are global, parameter-relative, or ambient-scope-relative, and they enforce visibility/federation boundaries. A caller may receive `absent` even though the cell exists for another audience.

### 30. How do you prevent a stale metric from misleading an agent?

Read the registered cell at the moment of action, inspect its measurement time and unknown reason, and follow its pointer to the next operational cell when provided. For changing thresholds, subscribe to the cell rather than copy a value into a message and act on it later.

## D. Plans, work-items, coordination, and fleets

### 31. What is the difference between a goal, plan, plan item, and work-item?

A goal captures the objective and budget. A plan decomposes an approach, dependencies, decisions, and current direction. Plan items are units in that decomposition; work-items are executable ledger records that agents claim, checkpoint, block, and complete with evidence.

### 32. Why keep assignment and claim separate?

Assignment is durable ownership; a claim is a live heartbeat-backed lease indicating that a session is actually working it. Separating them lets the system detect an assigned item whose worker died, reclaim an orphan, and distinguish “owned someday” from “active now.”

### 33. What prevents two agents from doing the same work?

The scheduler and claim ledger serialize ownership of work-items, while claim specifications bound what each fleet lane may pull. Live intent makes adjacent work visible, and file locks serialize actual edits. These mechanisms address different collision layers and are meant to be used together.

### 34. How do file locks work?

The runtime selects one effective mode. In automatic mode, the edit hook acquires and releases a lock around each write; in manual mode, the agent acquires and releases explicitly. Agents never combine the modes, and a blocked edit waits behind the current holder rather than routing around the lock.

### 35. What is the difference between an active, parked, stalled, and ended agent?

An active agent is currently producing work or a turn. A parked agent is alive but waiting for a wake; an ended agent needs a resume or relaunch. “Stalled” is a runtime diagnosis based on missing productive progress, not merely the absence of chat text.

### 36. How does a fleet receive work?

Members pull the next eligible item through a claim specification instead of relying on the leader to hand-assign every id. The specification controls eligible kinds, views, filters, revisions, and freshness lanes. If agents are idle while matching work remains, that is a feed/specification problem, not an invitation to invent private dispatch.

### 37. What does the fleet leader do?

The leader monitors burn-down, member liveness and productivity, orphaned or stalled claims, dependency gates, capacity, directives, and invariants. Transition events provide push-based wakes, with a long heartbeat as a safety net. The leader intervenes when a lane is stranded and winds down only when terminal evidence or explicit residue accounts for the plan.

### 38. What is a fleet invariant?

It is a stored read-only query evaluated on each leader brief. Its contract is “rows returned means violation; zero rows means satisfied.” Registration is not enough: the leader must verify that the invariant runs successfully and also prove that a deliberately wrong pin returns a row, so a broken guard cannot look clean.

### 39. What happens if an agent crashes or loses context?

The durable work-item and its checkpoint survive the session. Warm carry resumes the same live context; cold carry rebuilds from the checkpoint. Claims and presence let a leader detect dead ownership, and the task can be resumed or reclaimed without treating the transcript as the only record of progress.

### 40. How does Papercusp handle context-window pressure?

Context use and limit are visible session state. Work-item and loop checkpoints preserve in-flight progress before compaction or replacement, while facts and memory carry different classes of durable knowledge. The system is designed so a context reset is a continuity event, not an excuse to restart the task from scratch.

### 41. How are decisions shared across lanes?

Cross-lane rulings live as plan decisions, where other agents can address and re-read them. Coordination messages notify affected peers, but the message is not the durable authority. That prevents a convention from disappearing when an inbox scrolls away or a session ends.

### 42. How do you know a handoff was actually received?

Message delivery and session wake are separate outcomes. Dispatch, handoff, and required-wake calls report whether a live session was re-invoked; `woken:0`, `recipient_absent`, or `recipient_dead` is a failed pickup. Durable assignment alone does not make a parked or ended session act.

### 43. Why have structured coordination messages?

They make the expected response, evidence, premises, uncertainty, and recipient relationship explicit. A message can say whether it expects acknowledgment, an answer, an action, or nothing, and can separate verified findings from what the sender could not determine. That structure reduces both silent blocking and accidental overconfidence.

## E. Time, continuity, and reusable orchestration

### 44. What is the difference between a loop, a plan schedule, a routine, and an event wait?

An event wait wakes one session when a pushed condition occurs. A loop gives one session recurring future turns. A plan schedule creates recurring, auditable project runs that can outlive a session. A system routine runs platform-owned maintenance by invoking a registered system action.

### 45. Why separate schedule authoring from arming?

Authoring answers what the recurrence means—timezone, exclusions, overlap, catch-up, expiry, and cost cap. Arming grants the autonomy to make it fire. Keeping them separate lets the recurrence be reviewed and inspected without accidentally activating it.

### 46. How do time zones and missed runs work?

Plan schedules can use RRULEs with an explicit `DTSTART`, timezone, exclusions, overlap policy, and catch-up policy. The exact behavior is part of the schedule object rather than an implicit assumption in a cron string. System routines have their own registered cadence and policy.

### 47. What is a recipe?

A recipe is a captured, reusable multi-step tool orchestration with provenance and revision. Search returns context-bound run arguments; the caller can inspect and dry-run them before execution. The recipe never grants authority the caller does not already have.

### 48. How is `code:run` different from a recipe?

`code:run` is the composition and authoring path: it provides real control flow over the caller's permitted tools, keeps intermediate payloads inside the sandbox, and returns a compact result. A successful orchestration can be captured for later discovery and execution as a recipe.

### 49. Why not put all orchestration inside one script?

Because plans, claims, waits, schedules, and completion evidence need shared lifecycle and inspection semantics. `code:run` is valuable for bounded composition, but it should invoke the first-class primitives rather than replace them with a private parallel state machine.

### 50. What is the difference between a fact, memory, and checkpoint?

A standing fact is a deterministic conclusion injected into every relevant turn until expiry or retraction. Memory is fuzzy, durable knowledge retrieved semantically. A checkpoint is in-flight progress for the next wake or successor. Putting the same sentence in all three creates stale duplication rather than resilience.

## F. Blueprints, personas, plugins, and security

### 51. What is the difference between a blueprint and a persona?

A blueprint defines the multi-agent topology and runtime policy: roles, dispatch, coordination, inheritance, and spine. A persona defines the behavioral contract of one role. Their separation allows role behavior and team topology to evolve independently.

### 52. Can a blueprint or plugin add reaction rules?

Yes, through a restricted contribution path. Those rules enter the same reaction registry and appear in the same graph as core rules and tool-local emissions. The contribution does not create a second invisible rules engine.

This is a deliberate design decision, not an accident of history: an earlier WordPress-style hook/filter bus was retired in favor of it. Event-reaction rules are the plugin extension surface, plugin-fired events enter the registry as first-class events, and the legacy lifecycle hooks survive only as a frozen back-compat surface.

### 53. What can a plugin contribute?

Depending on its manifest and host support, a plugin can contribute tools and related runtime surfaces. The demonstrated plugin declares its tool, schema, roles, quotas, HTTP/MCP exposure, configuration, network destination, and optional secret. The manifest is the inspectable contract; the handler is the implementation. A plugin can also declare event families; those fold into the same `events:catalog` under an `installed:<unit>` provenance tag rather than creating a second, private event system.

If they press: beyond tools and events, plugins contribute server actions, API routes, and TUI panes, and `plugins:runtime_status` reports what is loaded, registered, and mounted right now. The plugin protocol itself is defined once in WIT, so a plugin can also ship as a WebAssembly component that loads on either host runtime — the JS host transpiles it at install time, the Rust host runs it under wasmtime — and an alternate-runtime manifest needs no JS entry at all.

### 54. Can a plugin read every secret?

No. Secret access is capability-scoped and names the requested secret. The fetch-plus example asks for `JINA_API_KEY`; it does not inherit unrelated credentials. The handler must also tolerate the secret not being granted.

### 55. How is outbound network access controlled?

The plugin manifest declares a destination-specific HTTP capability, and the handler validates the URL scheme before fetching. The demonstrated contract is explicit about the network service it needs. Exact enforcement details belong to the host capability layer, not to an informal promise in the prompt.

### 56. Can a recipe or rule bypass permissions?

No. A recipe executes within the caller's role-scoped tool envelope, and a reaction or plugin action is evaluated through its registered capability context. Reuse carries logic and provenance, not borrowed privilege.

### 57. How do humans retain control?

Authority is explicit runtime state: owner directives, modes, capabilities, schedule arming, escalation records, and fleet leadership are inspectable. Human-facing escalations can include choices and evidence, and their resolution is durable. The important property is that control is represented as state rather than inferred from whether an agent “sounded authorized.”

### 58. How auditable is the system?

Plans, work-items, claims, messages, waits, reaction firings, cause chains, schedules, checkpoints, completions, and pipeline cells all leave addressable records. Auditability is strongest when agents use those first-class objects rather than summarizing side effects only in prose. The demo should claim inspectability and provenance, not omniscience: a failed or absent read remains explicit.

## G. Reliability, testing, scale, and limitations

### 59. How do you test this kind of runtime?

At the component level, tool schemas, rule matching, state-cell resolvers, routines, and system actions can be tested independently. At the workflow level, work-item completion records the tests and evidence used, while pipeline cells show where a change sits from commit through deployment. The live demo should never substitute a successful UI gesture for verification evidence.

### 60. What happens when a rule action fails?

Synchronous and durable modes have different delivery paths, but failure remains an observable outcome. Durable actions can retry, which is why stable deduplication and idempotency matter. A failure should be diagnosed at the rule/action boundary rather than hidden by reporting only the original trigger.

### 61. What happens when an event wake fails?

The authoritative state transition remains true. The delivery path records whether the message was delivered and whether a session was actually woken. A timeout should wake the waiting agent to inspect producer and delivery health rather than silently registering the same wait forever.

### 62. Does push-based coordination eliminate all polling?

No. Some underlying conditions are only measurable by reading them, and a long heartbeat protects against a missed transition. The design goal is to share necessary pollers, use push where a real transition event exists, and attach producer-health checks to waits so polling is a bounded fallback rather than the primary message bus.

### 63. How does this scale to many agents?

The architecture avoids several obvious scaling traps: members pull by specification, watches can be inbox-only, identical cell subscriptions share a poller, messages use audience selectors, and leaders wake on transitions rather than constantly rereading the fleet. Actual capacity still depends on the datastore, host, provider accounts, and workload and should be answered with measured data rather than a universal number.

### 64. What happens when the model provider is rate-limited?

Session and fleet state can distinguish provider throttling from an application stall and record a resume time or wall reason. Account routing can use a default credential, a pinned pool account, or gateway auto-routing when configured. Work remains durable while execution is paused; routing choices affect failover, billing, and prompt-cache continuity.

### 65. Does Papercusp guarantee exactly-once behavior?

Do not claim that. Durable reactions are designed around at-least-once delivery, explicit deduplication keys, and idempotent actions. Some state changes are serialized by claims or locks, but exactly-once is not a blanket property of the whole system.

### 66. Is every state transition immediately consistent everywhere?

Do not claim that either. The system separates authoritative state, event delivery, projections, and UI reads precisely because they can advance at different moments. It exposes timestamps, freshness, unknowns, and delivery outcomes so callers can reason about that gap.

### 67. What are the current limitations you would state plainly?

The system has deliberate bounds and operational dependencies. Composed awaits cap depth and leaves; some rule contributions are curated code rather than live authoring; live cells depend on working resolvers; event delivery and authoritative state can advance separately; and fleet throughput depends on host and provider capacity. The benefit is that these conditions are represented explicitly instead of being hidden as generic “agent failure.”

### 68. Is this production-ready?

Answer in terms of the demonstrated evidence, not a blanket label. The files shown are current implementation surfaces with tests and operational use, but readiness depends on the deployment, workload, security requirements, and failure budget in question. Offer to review the relevant scorecards, test surfaces, and pipeline evidence for the intended use case.

### 69. What should we build next?

Separate demonstrated capability from roadmap. A good answer is: improve the breadth and freshness of registered cells, expand live causal inspection and replay ergonomics, keep tightening fleet invariants and completion evidence, and add extensions through the existing blueprint/plugin/recipe seams rather than new parallel orchestration systems. Do not promise a date or unapproved feature.

### 70. What if the live demo fails?

Treat the failure as evidence, not theater. State exactly which layer failed—authoritative state, event delivery, wake, resolver, or UI projection—then switch to the prepared source-backed example. The architecture's credibility comes from preserving failure distinctions, so pretending a timeout was success would undermine the point of the demo.

## H. Comparison questions

### 71. How is this different from Temporal, Airflow, or another workflow engine?

Those systems are useful comparisons for durable orchestration and scheduling, but Papercusp's unit of operation includes agent-specific state: prompts/personas, context carry, live intent, human directives, semantic memory, model/account routing, coordination audiences, and fleet supervision. Papercusp should reuse established infrastructure where it fits; the distinction is the agent operating model layered around durable work.

### 72. How is this different from Kubernetes?

Kubernetes manages workloads and desired infrastructure state. Papercusp manages agent work, authority, coordination, waiting, knowledge, and evidence. It may run on infrastructure managed by Kubernetes, but a pod's liveness is not the same as an agent's claimed task, context pressure, unanswered directive, or verified wait.

### 73. How is this different from a message queue?

A queue transports work or messages. Papercusp includes transport, but also the typed objects around it: plans, claims, audiences, event conditions, state cells, latching, checkpoints, capabilities, causal graphs, and completion evidence. A queue can be an implementation component without becoming the whole runtime model.

### 74. How is this different from a multi-agent chat room?

A chat room provides communication. Papercusp distinguishes communication from assignment, claim, wake, decision, event, state, and proof. Agents can communicate through it, but correctness does not depend on every participant reading every message and remembering what it implied.

### 75. Why not let the LLM decide all of this dynamically?

The model should make judgments where judgment is valuable. It should not have to reinvent mutual exclusion, durable waiting, retry semantics, permissions, recurrence, or evidence every turn. Externalizing those mechanics gives the model better context and makes its decisions reviewable without reducing it to a fixed workflow.

## Questions to answer cautiously

For these topics, prefer a measured answer over a confident generalization:

- Maximum fleet size or throughput.
- Provider cost and latency.
- Exactly-once guarantees.
- Deployment-specific security boundaries.
- Availability and recovery objectives.
- Compatibility with a named external framework not tested in this workspace.
- Roadmap dates.

Use this phrasing when the evidence is not in the room:

> The runtime exposes the measurements needed to answer that for a specific deployment, but I do not want to invent a universal number. I would check the current capacity, scorecard, or pipeline cell and answer from that evidence.

## Final one-minute rehearsal card

If you lose your place, use this sequence:

1. **Tool:** contract plus authority.
2. **Event:** declared family, named transition.
3. **Rule:** condition turns the event into action.
4. **Graph:** explain what could and did fire.
5. **Cell:** current truth with `unknown` and a falsifier.
6. **Routine/action:** clock separated from behavior.
7. **Blueprint/persona:** topology separated from role behavior.
8. **Plugin:** extension separated from capability grant.
9. **Live story:** plan → work-item → fleet → event wake → recipe.
10. **Close:** intent, authority, action, change, wait, recurrence, concurrency, continuity, proof.

The single sentence to remember is:

> Papercusp makes agent work recoverable and explainable by turning the operational state around the model into shared, typed, inspectable runtime objects.
