# Papercusp state-object inventory

This document inventories Papercusp's agent-visible state model as of August 20, 2026. It is exhaustive across two explicit boundaries:

1. Every state surface rendered by **HUD → Sessions → Conversation** in the current code.
2. Every first-class agent-facing state family used to represent work, coordination, liveness, reactive waits, authority/context, reusable runtime definitions, and operational proof.

It intentionally does **not** enumerate local React component state, raw cache entries, every database implementation table, generated projections, or unstructured logs. Those are storage/implementation details rather than objects an agent is expected to reason about directly.

## 1. The conversation popup: complete surface map

The popup is not one state object. It composes four independent live reads plus the transcript stream:

| Read                       | What it supplies                                                                                                                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `advRoster.list`           | Session identity, presence/liveness, launch/runtime handles, intent, modes, current files, fleet membership, context usage, account/model/context launch settings, and session lifecycle tiers. |
| `agentOrders.byOwner`      | What the agent was told and what it carries forward: mission, modes, directives, facts, walls, and carry state.                                                                                 |
| `agentDetail.byOwner`      | What the agent is doing and receiving: health, plan lane, events, locks, coordination, pushed context, files, and diagnostics.                                                                  |
| `agentLeaderBrief.byOwner` | Fleet-leader-only intervention signals, member alerts, fleet alerts, capacity, invariants, and leadership drift.                                                                                |
| Native transcript/SSE      | The actual user/assistant conversation, stream freshness, pending decisions, reply delivery, and archive/live resolution.                                                                       |

Primary sources:

- [SessionChatModal.tsx](apps/operator/app/_components/chat/SessionChatModal.tsx)
- [AgentOrders.tsx](apps/operator/app/adv/sessions/AgentOrders.tsx)
- [AgentDossier.tsx](apps/operator/app/adv/sessions/AgentDossier.tsx)
- [FleetPeersRail.tsx](apps/operator/app/_components/chat/FleetPeersRail.tsx)
- [adv-agent-orders.ts](packages/operator-core/lib/adv-agent-orders.ts)
- [adv-agent-detail.ts](packages/operator-core/lib/adv-agent-detail.ts)
- [adv-agent-leader-brief.ts](packages/operator-core/lib/adv-agent-leader-brief.ts)
- [hud-board-model.ts](apps/operator/app/adv/hud/hud-board-model.ts)

### 1.1 Popup frame and session state

The center/header/footer surfaces include:

- Agent identity: owner id, display label/short handle, client/backend, role, feature, and revocation state.
- Session lifecycle: starting, live, parked, draining/suspect, ended, launch-failed, provider-blocked before first turn, startup-timeout, unknown session, and “no resolvable native transcript.”
- Live intent and the age of the intent declaration. Intent age is not session age and is not proof of progress.
- Liveness verdict and badges derived by the shared HUD board model.
- Context pressure: current token count, compaction limit, and percentage.
- Mode pills and who set them.
- Account pin, model launch spec, and context-limit launch setting.
- Compact lock and unread-message counts, linked to the corresponding Activity sections.
- Transcript origin/resolution: native session id, source backend, live stream vs archive replay, missing transcript reason, and stream freshness.
- Composer posture: reply to live, wake parked, or explain that ended requires resume/relaunch.
- Delivery outcome: woken, staged by manual-wake mode, inbox-only, or recipient absent.
- Pending escalation/decision cards, their options, and whether an answer or discussion action was taken.
- Session action bar, local confirmation cards, maximize/window state, and fleet-launch row.

### 1.2 Orders rail — “what they were told”

The left rail has two clusters.

#### What they were told

- **Mission**
  - Effective mission/goal text.
  - Mission source and authority.
  - Current plan and plan items when present.
  - Scope/subject carried by the active mode or launch context.
- **Modes**
  - Every active official mode.
  - Mode axis, reason/instructions, setter, whether owner-directed, and activation time.
  - Wake/carry mode where applicable.
- **Owner directives**
  - Open directives addressed to this agent.
  - Required side effects, source message/authority, and actuation state when measurable.
- **Standing facts**
  - Deterministically injected facts in scope.
  - Key, body, scope/source, confidence/kind, expiry, and dependencies when present.

#### What they are carrying

- **Walls**
  - Explicit owner/human walls and the exact ask required to remove each wall.
  - Associated goal/work-item and checkpoint context.
- **Carry**
  - Held work-items and checkpoints.
  - Carry brief / successor note.
  - Loop checkpoint and cold/warm continuation state when available.

Source: [adv-agent-orders.ts](packages/operator-core/lib/adv-agent-orders.ts)

### 1.3 Activity rail — “what they’re doing”

The right rail is ordered by operational urgency.

#### Identity and fleet-control banner

- Backend/client, role, feature, revoked state, owner id/label, intent, and intent age.
- Fleet control state when not plain active: fleet, paused/winding-down state, reason, authority, and age.

#### Health

- Engine loop: armed/not armed, interval, next fire, and stalled verdict.
- Current work-item claim: id, title, active/stalled/unknown progress, and idle age.
- Context pressure: tokens, limit, percentage, and risk coloring.
- Latest work-item/loop checkpoint text and age.
- Count of unanswered directed messages.
- Last productive/tool-call time.
- Read failures are rendered as unavailable, never collapsed into “none.”

#### Plan

- Current plan slug and whether it came from live intent or the launch record.
- Plan `Now` state and author-written `Now → Next` text.
- Mechanically computed next actionable item.
- Claimable count, including an explicit zero.
- Declared-plan-but-unclaimed warning.
- Release pipeline position relevant to the agent's current work.

#### Waiting on

- Active event subscriptions and standing watches.
- Event key/pattern, policy, one-shot vs standing, wakes vs inbox-only, urgency, note, creation age, and expiry.
- Announced gates in scope that this agent has not awaited.
- Failed reads are distinct from an empty subscription set.

#### Locks

- Held file locks: path, intent, acquisition, and expiry.
- Waiting lock tickets: paths, intent, queue position, deadline, and blockers (holder, holder label, intent, expiry).

#### Coord

- Last inbound/outbound coordination message.
- Bounded unread messages plus the true unread count.
- Open/accepted handoffs.
- Escalations with severity.
- Direction, counterpart, summary, timestamp, plan link, and acceptance state.

#### Dynamically pushed context

- Retrieval/injection events over the recent window.
- Surface/port, returned vs admitted counts, truncation, semantic and lexical legs, fusion mode, budget spent, dropped stages, and per-leg candidate/qualification counts.
- Concrete surfaced references from memory and corpus ledgers.
- Reference kind, port, title/detail resolution, epoch, and unresolved/unavailable state.
- An unreadable retrieval ledger is rendered as unavailable, not as zero results.

#### Files

- The agent's currently declared/open files from live presence.
- Lock cross-marks where applicable.

#### Reference

- Host, pid, cwd, tty/window, start and heartbeat times, user/session identifiers, backend-specific thread/session ids, and launch/runtime metadata.
- Native session handle and resumability/transcript status.
- Codex runtime diagnostics such as CODEX_HOME/session resolution and missing-reason state.

Source: [use-agent-detail.ts](apps/operator/app/adv/sessions/use-agent-detail.ts)

### 1.4 Fleet rail — “who they’re with”

The fleet rail appears only for an agent with live fleet membership.

#### Every peer row

- Owner id, label/handle, agent kind, pane kind, role, current intent, and whether this is the viewed agent.
- Leader vs member.
- Shared HUD state: `needs-you`, `blocked`, `stalled`, `working`, or `parked`.
- Reason, age in that state, and context percentage.

#### Leader-brief member alerts

- **Dormant:** no loop, event park, or claim; nothing will wake the member.
- **Verified-wait takeover:** producer is stalled/absent and the leader should take over or wake its owner.
- **Spinning:** turns continue but productive tool activity is stale.
- **Coord-deaf:** coord inbox reads are missing/stale.
- **Throttled:** provider wall/backoff reason and resume time.
- **Bench suggestion:** stalled-no-MCP or laneless-idle; `idle-with-claimable` is explicitly a starvation warning, not a bench recommendation.
- **Unanswered:** directed-message count, oldest age, and newest summaries.
- **Unactuated directives:** required side effects not yet visible in the ledger.

#### Fleet-level alerts and proof

- Stranded fleet.
- Spec-starved, spec-authorship, idle-with-claimable, and floor-starved conditions.
- Paused/winding-down control state and reason.
- Unowned criticals, laneless idle, dormant, spinning, throttled, and coord-deaf counts.
- Current claimable count; null means unread, not zero.
- Shared inference-pool capacity: exhausted/degraded, factor, queue depth, usable/available accounts.
- Custom invariants: satisfied, violated, or error; an error means the guard did not run.
- Registry-vs-presence leadership drift: `presence-behind` vs `registry-disowned`.

Sources: [fleet-peers.ts](apps/operator/app/_components/chat/fleet-peers.ts), [leader-brief-alerts.ts](apps/operator/app/_components/chat/leader-brief-alerts.ts)

## 2. Registered live state cells

`state:read {}` is the live, audience-filtered catalog. At the time of this inventory it returned these 10 readable cells; the registrations live in [cell-registrations.ts](packages/operator-core/lib/cell-registrations.ts).

| Cell                             | Relativity           | Headline / purpose                                                                                             |
| -------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------- |
| `agent.goal`                     | Parameter: `ownerId` | The goal reference held by an agent, corroboration, competing references, and explicit `nothing-held` unknown. |
| `deploy.3070.sha`                | Global               | Deployed SHA plus serving-process restart evidence and unknown reasons.                                        |
| `gate.greenCheckpoint.candidate` | Parameter: `path`    | Which SHA the gate is judging and whether that candidate contains the caller's path.                           |
| `gate.greenCheckpoint.ownership` | Global               | Real ownership of the red gate: work-item, claim/holder session, duplicates, recent thread, and unknowns.      |
| `gate.greenCheckpoint.verdict`   | Global               | Consecutive reds/stall state, freshness, last green, and ownership pointer.                                    |
| `git.mainBehindStaging`          | Global               | Whether main is behind staging/green pin, fast-forward state, age, deployed lag, and origin.                   |
| `git.pipelinePosition`           | Parameter: `path`    | Commit → staging → main → deployed → serving position for one path, with unknown hoists.                       |
| `host.memoryPressure`            | Global               | PSI/memory pressure verdict, thresholds, age/staleness, host readings, reasons, and unknowns.                  |
| `testing.census.population`      | Ambient scope        | Test-surface population, retired surfaces, provider/fidelity census, age, and basis.                           |
| `testing.coverage.floor`         | Ambient scope        | Coverage floor, measured/not-measured verdict, below/waived surfaces, fidelity, and coverage by rung/kind.     |

Every cell declares:

- A headline value.
- An independent falsifier that kills a likely misreading.
- Whether unknown/null is possible and where unknowns are hoisted.
- Caller relativity: global, parameterized, or ambient.
- Provenance and live-exercise evidence.
- Exactly one resolver and the surfaces that project it.
- Visibility/federation boundaries.
- A change signal used by `state:subscribe`.

`state:read` returns `value`, `unknown`, or `absent`. `state:subscribe` is the threshold-crossing reader. A cell may also point to another cell that answers the next operational question—for example, a red verdict points to gate ownership.

## 3. Durable work and intent objects

### Goals

- Goal identity, objective, status, token/time/cost budgets, owner, timestamps, and tripwires.
- Goal-to-pot/fleet relationships, subgoals, launch settings, waiting state, and activity/spend rollups.
- `agent.goal` is the live per-agent projection, not a replacement for the durable goal object.

### Plans

- Plan slug/title/status, `Now` state/next, phases, items, decisions, revisions, and source hash.
- Plan-item id, text, phase, importance, status, `blocked-by` edges, assignee, and live claim.
- Decisions are cross-lane rulings with references/affected items.
- Plan schedules are authored separately from their autonomy-gated armed state.

### Work-items

- Kinds: feature, chunk, bug, change, and task.
- Lifecycle: open/todo, wip, blocked, needs-human, done/resolved, or dropped/deprecated.
- Assignment vs live heartbeat-leased claim are distinct.
- Parent/child, plan-item implementation edge, causal/related/duplicate links, topics, severity/priority, and routing intent.
- Checkpoint, completion evidence, assumptions, authority judgement, files/tests/deploy evidence, and terminal reason.
- Claim specs and scheduler freshness decide what a fleet member may pull.

### Current lane

- `coord:declare-intent` publishes the present-tense intent, current plan, claimed P-items, and current files.
- It is live coordination state, not a durable completion record.
- A declared lane without a claim and without a loop is surfaced as a warning in the HUD.

## 4. Session, mode, loop, and fleet objects

### Session/presence

- Owner identity, label, role, pot/workspace, capability tags, pid/tty/host/window, backend, native session/thread handles, start/heartbeat/activity times, session lifecycle, intent, plan/files, context use, revocation, and user/account linkage.
- Launch records cover starting, failed, and provider-blocked sessions before presence exists.
- Ended-session history and live presence answer different questions; current roster state cannot reconstruct historical fleet membership.

### Modes

- Official mode id, axis, active state, reason/instructions, subject, setter, owner-directed authority, activation/expiry, and same-axis exclusion.
- Current official modes include autonomy/work-source/overlay roles such as auto, cold-auto, ideate, drain, grade, goal, and test.
- Mode is authorization/work posture; it is separate from the engine loop that creates future turns.

### Engine loop and carry

- Active/ended, interval, goal, work-item, blocked-on reason/event, next/last fire, continuation mode, warm/cold carry, cost/fire/duration caps, and stall state.
- Loop checkpoint/walls preserve in-flight state for the next wake or cold successor.

### Fleets

- Fleet registry: slug/title, leader, control state, visibility/headless placement, creation/update, and liveness.
- Membership: owner, role, session state, join/leave history, and live presence projection.
- Claim specs: kinds/view/filter, revision, inheritance, workspace binding, and freshness lane.
- Leader state: assignments, burn-down, member liveness/productivity, capacity, orphaned/stalled claims, bench state, gates, alerts, and invariants.
- Historical fleet audience traffic lives in the append-only coordination stream, not in current presence.

## 5. Coordination and concurrency objects

### Coordination messages

- Message id, sender, audience selectors/recipients, summary, structured body sections, expectations (`ack`, `answer`, `action`, `none`), blocking flag, goal/work reference, files/plan, reply relationship, gate references, delivery/wake outcome, and read/answer state.
- Audience history is durable even after live membership disappears.

### Handoffs, dispatches, and conversations

- Handoff: source, recipients, plan/items, summary/body, next action, files/commit, open/accepted/expired state.
- Dispatch: durable assignment mutation + brief delivery + wake/pickup result.
- Work-item conversation: durable participant thread, subscriptions, and messages.

### Escalations and decisions

- Severity, options, owner/agent, plan/work relation, open/resolved state, selected answer, and discussion thread.
- HUD decision cards are a user-facing projection of these records.

### Topics and audience subscriptions

- Topic identity/description, subscriber membership, target object references, feed entries, and notification delivery.
- Selectors (`@fleet`, `@plan`, `@topic`, `@object`, `@file`) resolve their live audience at send time while preserving the original selector for history.

### Locks

- Lock set id, holder, repository/external paths, intent, acquired/expiry time, SHA token, and release state.
- Wait ticket, queue order, requested paths, deadline, blockers, and wake-on-grant state.
- Named resource locks and granular intention locks are separate concurrency variants.

## 6. Reactive state objects

### Event families and emissions

- Catalog family: key template, meaning, emitter, installed provenance, whether awaitable now, sugar verb, replaced poll, and live awaiter count.
- Event occurrence: exact key, payload, summary, scope, causal generation, recipients, and emitted time.

### One-shot awaits

- Exact key, glob/pattern, plan/fleet macro, or gate reference from a coord message.
- Subscriber/wake handle, note, timeout/on-timeout behavior, payload filter, producer-health certificate, creation/expiry/fired reason, and delivery state.
- Already-fired/done/unblocked conditions latch at registration rather than creating dead waits.

### Composed await trees

- Root, internal nodes, and leaves.
- Combinators: `all`, `any`, and `some { require, of }`.
- Leaf event and optional payload condition.
- Root satisfaction, matched evidence, depth/leaf count, timeout, cancellation, and one-shot wake.

### Announced gates

- Authoritative scoped key, announcer, scope/reference, note/summary, expected condition, generation, expiry, fired state, and latch.
- A declaration and a fire are separate actions.

### Watches and state subscriptions

- Pattern, target kind (`topic`, `event`, `interest`), wake vs inbox delivery, once vs standing, digest/full/mention mode, minimum sleep, urgency, timeout, payload filter, predicate, interval, and producer health.
- `events:await` is the one-shot wake preset; `state:subscribe` is the registered-cell threshold preset.

### Reactions, routines, and schedules

- Reaction rule: `on` event, condition, action/fire target, source/provenance, and enabled mode.
- System routine: schedule/cadence, target system action, payload, concurrency, activation/pause, last/next run, health/backoff, and run history.
- Plan schedule: recurrence authored on a plan plus separately armed autonomy.
- Engine loop: per-session recurrence; it is not a replacement for shared routines or plan schedules.

## 7. Authority, knowledge, and continuity objects

### Standing facts

- Key/body, scope/reference, source, confidence, kind, volatility/measurement time, TTL/retraction, audience, slot/wall semantics, cell dependencies, and enforcement metadata.
- Delivered deterministically into every relevant orient/brief until retracted or expired.

### Memory and corpus

- Memory: stable semantic fact, kind, scope/shareability, source, embedding/index state, and update/forget history.
- Corpus reference: durable handle to work-items, plans, documents, decisions, or other indexed prose.
- Recall/injection state: query/port, semantic and lexical legs, fusion, budgets, admitted references, truncation/drop reasons, and impact.

### Checkpoints and carry briefs

- Work-item checkpoint, loop checkpoint, held items, walls, successor note, files, tests/evidence, and updated time.
- Warm carry resumes the same live context; cold carry rebuilds from the durable checkpoint.

### Owner directives

- Authoritative instruction, source message/turn, recipient, required side effect, open/satisfied/unprovable state, and timestamps.
- Distinct from a coordination question and from a standing fact.

## 8. Reusable runtime-definition objects

These are “state objects” in the broader authored-runtime sense: durable definitions that the runtime loads and acts on.

- **Tool definition:** name, schema, guidance, capability/roles, emits, handler, and registration.
- **Event declaration/catalog entry:** key family, payload/meaning, emitter, and availability.
- **Reaction rule:** event-condition-action edge.
- **Registered state cell:** resolver, falsifier, unknown contract, relativity, provenance, visibility, federation, and change signal.
- **Routine declaration:** cadence, action, payload, concurrency, and activation.
- **System action:** executable behavior invoked by routines/reactions.
- **Blueprint:** roles, topology, coordination policy, dispatch, prompts, and runtime spine.
- **Persona/prompt:** behavioral contract supplied to an agent role.
- **Plugin:** manifest, capabilities, tools/events/UI contributions, handler, version, install/enabled state, and secrets contract.
- **MCP prompt/resource:** discoverable prompt/resource definitions and handlers.
- **Recipe:** captured multi-step tool orchestration, parameters, provenance, usage, and result.

Representative files are listed in [papercusp-runtime-demo-example-files.md](papercusp-runtime-demo-example-files.md).

## 9. Quality, learning, and operational-proof objects

- Improvement/issue/observation: kind, severity, evidence, state, assignee/claim, source, duplicates, causal links, and completion.
- Rubric: ratified criteria, scales, evidence requirements, version, and scope.
- Scorecard: rubric application, ratings/evidence, freshness, subject, and outcome.
- Idea/proposal: lens, problem, sketch/bet, experiment, routes, grades/feedback, and realized outcome.
- Test surface/census: surface identity, provider, fidelity rung, retirement, evidence, freshness, and population.
- Coverage evidence/waiver: surface, test/evidence, strength, validity, waiver reason/expiry, and floor verdict.
- Test/build/checkpoint run: candidate, suite, status, failures, timing, logs/artifacts, and green/red/inconclusive verdict.
- Release pipeline: commit/staging/main/deploy/serving position, gate health, ownership, candidate containment, deployed SHA, and rollback/deploy state.
- Account/capacity state: account/provider, pin/routing mode, availability/walls, rate-limit/backoff, utilization, pool factor/queue, and failover state.
- Backup snapshot/event: snapshot id/scope/time/status, restore point, and restore history.
- Feature flag/configuration: key, value/source, default/override, dark-flag registration, review date, and audit history.

## 10. “Unknown” is itself state

Papercusp repeatedly preserves distinctions that conventional dashboards flatten:

| Values that must stay distinct     | Why                                                               |
| ---------------------------------- | ----------------------------------------------------------------- |
| `false` vs `unknown`               | A failed read must not become a negative verdict.                 |
| `0` vs unread/null                 | An unread claimable count must not look like a drained queue.     |
| absent vs empty                    | No field in an older payload is not proof that the list is empty. |
| live vs parked vs ended            | Only ended requires relaunch; parked can be woken.                |
| present vs historically present    | Current presence cannot answer who was ever in a fleet.           |
| declared intent vs active progress | Intent age does not prove current work.                           |
| assignment vs claim                | Durable ownership and the live lease are different.               |
| message delivered vs session woken | Inbox receipt is not pickup.                                      |
| event declared vs fired            | Declaration establishes a rendezvous; firing opens it.            |
| clean invariant vs invariant error | A guard that failed to run protects nothing.                      |
| mitigation vs durable fix          | Restart/retry/timeout widening does not close the root cause.     |

This tri-state discipline is part of the object model, not just UI wording.

## 11. Completeness checklist

Use this checklist when the platform grows:

- [ ] Does `advRoster.list` expose a new session/presence field?
- [ ] Did `agentOrders.byOwner` add a mission, authority, directive, fact, wall, or carry field?
- [ ] Did `agentDetail.byOwner` add a health, lane, wait, lock, coord, context, file, or diagnostics field?
- [ ] Did `agentLeaderBrief.byOwner` add a member/fleet intervention signal?
- [ ] Did `state:read {}` add/remove a registered cell?
- [ ] Did a new goal/plan/work-item/claim relationship become first-class?
- [ ] Did a new coordination, event, watch, routine, mode, loop, fact, memory, or checkpoint object appear?
- [ ] Did an installed blueprint/plugin/recipe introduce a durable runtime definition?
- [ ] Did a test/scorecard/pipeline/account/backup/flag surface become agent-actionable?
- [ ] Does every new value preserve unknown vs false/zero/empty?
- [ ] Is the writer identified, and does the HUD/tool read the writer rather than re-derive the value?

That checklist, the four HUD producers, and the live cell catalog are the repeatable audit path for keeping this inventory complete.
