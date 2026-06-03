---
title: Coordination substrate — universal subscribe→inject (foundation + architecture spine)
slug: coordination-substrate-2026-06-03
status: draft
created: 2026-06-03
updated: 2026-06-03
owner: aviynw@gmail.com
companion-to: [coordination-conversations-2026-06-03, engineer-issues-2026-06-03, coordination-integration-adoption-2026-06-03, plans-pg-canonical-migration-2026-06-03]
---

# Coordination substrate — universal subscribe→inject

## Now

**State:** Draft authored 2026-06-03 from a multi-session design with the owner. This is the SPINE of a four-plan coordination project (companions: [[coordination-conversations-2026-06-03]], [[engineer-issues-2026-06-03]], [[coordination-integration-adoption-2026-06-03]]) and carries the shared decision record + the whole-project surface map. The owner is authoritative on these decisions; other agents will be told to accept them. No code written yet.

**Next:** owner reviews the four plans; on sign-off, build the substrate FIRST — every companion depends on it. Phase 0 (schema + capability code) is additive and safe to start.

## What this is

A universal **"subscribe → updates injected"** substrate on Postgres. Today coord can message agents and (via `coord:watch`) drop path-glob `notify`s, but there is no way to follow an *entity* (a topic, an issue, a plan) and have its updates pushed into your context. This generalizes that into one substrate that conversations, issues, and (connected) features/plans all ride.

The unifying abstraction: **Subscribable is a capability, not a table.** A conversation, an issue, a feature, a plan, and a topic are distinct domain objects that each implement a small set of shared capabilities; the substrate provides those capabilities once, polymorphically.

## Architecture (shared by all four plans)

**Capabilities (built once, polymorphic over object kind):**
- `Subscribable` — follow an object/topic → its updates are injected into your inbox.
- `Taggable` — carries topic tags (the routing/discovery unit).
- `Threadable` — a comment timeline attachable to any object (an issue's notes, a conversation's posts — same substrate).
- `Linkable` — polymorphic edges between objects (e.g. issue → plan-item / feature).
- `Claimable` — claim/assignee for pickup.
- `Lifecycle` — open / resolved / closed.

**Domain objects** (each its own table + workflow, on top of the capabilities): `topic`, `conversation`/`question` ([[coordination-conversations-2026-06-03]]), `issue` ([[engineer-issues-2026-06-03]]), and the connected `feature`/`plan` ([[coordination-integration-adoption-2026-06-03]]). Separate tables, shared substrate services — never one mega-table (issues are a work-tracking artifact with auto-promote + a validator-fed sibling population; co-mingling with chat threads entangles their lifecycles).

**The pipeline (all Postgres — no Zero, no IVM engine, no external broker):**
1. **Change capture (source):** the existing trigger CDC + `harness_shared.substrate_outbox` — every entity change is already captured durably here for federation.
2. **Fan-out:** a consumer of the outbox that resolves matching subscribers (by topic tag or direct entity subscription) and writes one durable row per subscriber, honoring delivery mode. This rides su-08782's registry-driven projection engine — "fan out to subscriber inboxes by topic" is one more projection target on the same outbox, NOT a parallel drain.
3. **Durable delivery (queue):** per-subscriber rows in a PG table + a watermark cursor (the existing coord inbox pattern) — at-least-once, replayable, survives disconnect. `pg_notify` is only the wake-up.
4. **Injection:** the existing mature inbox-injection hook (`coord-hook.ts`: turn-start + mid-turn `pollInboxDelta`, watermark dedup, fail-open, CC/Codex/OMP parity) — reused unchanged except for delivery-mode handling.

## Decisions (shared across the whole project)

### D-001 — Subscribable is a capability, not a table
2026-06-03

Conversations, issues, features, plans, and topics are different domain objects that each implement the shared capabilities (Subscribable/Taggable/Threadable/Linkable/Claimable/Lifecycle). The substrate builds those capabilities once, polymorphically. This is what buys the unification without the over-merge: separate object tables/workflows, shared substrate services in code.

### D-002 — Postgres only; no Zero / IVM engine / external broker
2026-06-03

Verified the live reactive path is trigger → `pg_notify` → SSE (invalidate + refetch); Zero/ZQL is retired in papercusp (zero-cache runs only in the retired webapp's compose; `libs/zero-harness` = 0 live importers). ZQL's value is incremental view maintenance for thick sync clients — we have none (we route change EVENTS to server-side agent inboxes, not reactive query RESULTS to clients). PG supplies all three needs: `substrate_outbox` (capture), LISTEN/NOTIFY (wake-up), table + watermark (durable delivery). IVM engines (Materialize/Electric/pg_ivm) + brokers (Redis/NATS/Kafka) are rejected: heavy, can't run under embedded-pg (the ship target), and re-introduce what we just retired. The substrate must NOT depend on any Zero remnant; Zero cleanup is a separate pass.

### D-003 — Reuse the delivery rail; replace the coord:watch subscription model
2026-06-03

The inbox-injection hook + table+watermark delivery is mature — reuse as-is. The `coord:watch` model is the wrong shape (path-globs + file/lock triggers, not entities) and half-built (manual `fireNotifications`, opt-in/GC'd `notify`, no delivery tiering) — replace it with entity/topic subscriptions + CDC-driven auto-emission. Migrate the few real path-watch use cases (refactor-area awareness) onto the new model or drop them; retire the path-glob notify.

### D-004 — Topics: agent-curated, tag + one sentence, prefer-existing, NO creation-time gate
2026-06-03

A topic is a one-word(ish) tag + a one-sentence description. Agents read the full topic list once at prompt start and subscribe to a built-in `new_topic` topic that injects every new topic as it is created — so the taxonomy is a live shared artifact, not a static per-agent snapshot. Agents are instructed to prefer existing topics over creating new. With Opus-4.8 agents that is sufficient; we do NOT add a semantic suggest-on-create gate (over-engineering at that duplicate rate). The only residual (rare concurrent creation of near-duplicate tags) is handled by a cheap `topics:merge`/alias cleanup, not a gate.

### D-005 — Two subscription motivations, two mechanisms
2026-06-03

(a) "I can contribute to THIS thread" → a per-object subscription/join. (b) "this area is relevant to my work" → a topic subscription (standing interest). Both deliver via the same rail; topics serve (b) and are the scalable unit of routing.

### D-006 — Delivery-mode tiering is mandatory (the noise control)
2026-06-03

Every subscription carries a delivery mode — `full` (every update) | `digest` (count + one-line summary) | `mention` (only when @-addressed or on resolution) — plus a TTL / auto-drop. High-churn object kinds (features, plans) default to `digest`. Without this, a universal subscribe→inject is an instant firehose (the lesson that demoted the old `notify` to opt-in). Tiering lives in the fan-out + the inbox hook. It must land WITH the fan-out, not after.

### D-007 — Subscribable = coordination CONTENT, not control
2026-06-03

Topics, conversations, issues, features, plans are subscribable. Locks are NOT — you wait on a lock (queue/grant), you do not follow it. This boundary keeps the abstraction from swallowing the wrong primitives.

### D-008 — Fan-out rides the projection engine; federation deferred
2026-06-03

The CDC→inbox fan-out is a projection target on su-08782's outbox engine, not a parallel consumer (a second drain would race/duplicate). Topics + subscriptions are workspace-local for v1. Conversations + issues may ride the existing outbox federation (issues are already federated), but cross-workspace TOPIC federation is deferred — no concrete multi-workspace requirement yet.

## Surface map (whole project → owning plan)

| Surface | Owning plan |
|---|---|
| PG: topics, subscriptions, thread/comments, link edges, capability code; fan-out worker; delivery-mode tiering; `topics:*` tools; retire `coord:watch` | **this plan** |
| conversation/question object; knowledge-first ask; answer-capture | [[coordination-conversations-2026-06-03]] |
| `engineer_issues` surface; issues PG-canonical finish; blocking edges | [[engineer-issues-2026-06-03]] |
| features/plans → Taggable + Subscribable; admin UI; agent prompting/playbook | [[coordination-integration-adoption-2026-06-03]] |
| plan-item structured storage (cleanest blocking-edge FK) | [[plans-pg-canonical-migration-2026-06-03]] (dependency) |

## This plan's build (the substrate)

### Phase 0 — Schema + capabilities (additive, safe)
1. Migration (next free # via `db:check_drift`; 115–117 taken): `coord_topics` (slug PK, title, one-sentence desc, created_by), `coord_subscriptions` (subscriber, target_kind `topic`|`object`, target_ref, delivery_mode, expires_ts), `coord_threads` / `coord_thread_posts` (polymorphic parent), `coord_links` (polymorphic edge). RLS + grants; register in `table-registry.ts` via su-08782's final registry shape (sync: none for topics/subs).
2. Shared capability TS module (`@papercusp/coordination` extension): the six capability interfaces + helpers, imported by every domain object so a field/behavior is added in one place.

### Phase 1 — Topics surface
`topics:list` / `topics:create` (prefer-existing in guidance) / `topics:subscribe` / `topics:unsubscribe` / `topics:merge` (alias cleanup) + the built-in `new_topic` topic. Implements read-once-at-prompt + new_topic injection (D-004).

### Phase 2 — Fan-out + delivery tiering
The outbox → subscriber-inbox projection (on su-08782's engine): on an entity change in `substrate_outbox`, resolve subscribers (topic tags + direct subscriptions) and write per-subscriber inbox rows honoring delivery mode (full/digest/mention). Extend the inbox hook to render digests + respect mode. Reuse the existing notify-GC retention pattern.

### Phase 3 — Retire coord:watch path-glob
Migrate any real consumer to entity/topic subscriptions; remove the path-glob watch + manual `fireNotifications` + the opt-in notify firehose.

## Risks
- **Firehose if tiering slips** — D-006 must land WITH the fan-out (Phase 2), not after.
- **Double-consumer of the outbox** — the fan-out must be a projection on the one engine, not a second drain. Build on su-08782's engine.
- **coord:watch retirement** — confirm no live consumer silently depends on path-glob notify before removal (grep + a CI-style check).
- **Embedded-pg constraint** — everything must run under embedded-pg (no arbitrary extensions); the PG-only design honors this.

## Dependencies / non-goals
- **Depends on:** su-08782's projection engine (fan-out home), the existing inbox hook + `substrate_outbox`.
- **Non-goals:** Zero/IVM/broker; cross-workspace topic federation; reactive query-result subscriptions (agents re-query on a nudge).
