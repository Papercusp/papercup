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

**State:** Draft authored 2026-06-03. SPINE of a four-plan coordination project (companions: [[coordination-conversations-2026-06-03]], [[engineer-issues-2026-06-03]], [[coordination-integration-adoption-2026-06-03]]) carrying the shared decision record + surface map. **I own all five plans (incl. [[plans-pg-canonical-migration-2026-06-03]]); su-08782 is idle and the owner authorized me to decide without coordination** — so the projection-engine, table-registry, and federation calls are mine. No code yet.

**Next:** owner reviews; on sign-off build the substrate FIRST (every companion depends on it). Phase 0 (schema + capability code) is additive.

## What this is

A universal **"subscribe → updates injected"** substrate on Postgres. Today coord can message agents and (via `coord:watch`) drop path-glob `notify`s, but there is no way to follow an *entity* (a topic, an issue, a plan) and have its updates pushed into your context. This generalizes that into one substrate that conversations, issues, and (connected) features/plans all ride.

The unifying abstraction: **Subscribable is a capability, not a table.** A conversation, an issue, a feature, a plan, and a topic are distinct domain objects that each implement a small set of shared capabilities; the substrate provides those capabilities once, polymorphically.

## Architecture (shared by all four plans)

**Capabilities (built once, polymorphic over object kind):** `Subscribable` (follow → injected updates), `Taggable` (topic tags), `Threadable` (a comment timeline attachable to any object), `Linkable` (polymorphic edges), `Claimable` (claim/assignee), `Lifecycle` (open/resolved/closed).

**Domain objects** (each its own table + workflow, on top of the capabilities): `topic`, `conversation`/`question`, `issue`, and the connected `feature`/`plan`. Separate tables, shared substrate services — never one mega-table.

**The pipeline (all Postgres — no Zero, no IVM engine, no external broker):** `substrate_outbox` captures every entity change once (existing trigger CDC). The **projection engine** then projects each change to **two sibling targets** (D-009):
1. **Federation** — the peer-log / Hyperbee projection (cross-machine; the existing features/issues machinery). PRESERVED + adapted.
2. **Local fan-out** — resolve matching subscribers (topic tag or direct subscription) → write one durable row per subscriber into the inbox surface, honoring delivery mode (NEW).
Durable delivery is the PG table + watermark cursor (at-least-once, replayable); `pg_notify` is the wake-up; the mature inbox-injection hook (`coord-hook.ts`) injects, reused unchanged except for delivery-mode handling.

## Decisions (shared across the whole project)

### D-001 — Subscribable is a capability, not a table
2026-06-03

Conversations, issues, features, plans, topics each implement the shared capabilities; the substrate builds them once, polymorphically. Separate object tables/workflows, shared services in code — the unification without the over-merge.

### D-002 — Postgres only; no Zero / IVM engine / external broker
2026-06-03

Verified the live reactive path is trigger → `pg_notify` → SSE (invalidate+refetch); Zero/ZQL is retired in papercusp. ZQL's value is IVM for thick sync clients — we have none (we route change EVENTS to server-side agent inboxes). PG supplies capture (`substrate_outbox`), wake-up (LISTEN/NOTIFY), and durable delivery (table + watermark). IVM engines + brokers are rejected (heavy; can't run under embedded-pg; re-introduce what we retired). The substrate must NOT depend on any Zero remnant.

### D-003 — Reuse the delivery rail; replace the coord:watch subscription model
2026-06-03

The inbox-injection hook + table+watermark delivery is mature — reuse. The `coord:watch` model is the wrong shape (path-globs, not entities) and half-built (manual fire, opt-in/GC'd notify, no tiering) — replace with entity/topic subscriptions + CDC-driven auto-emission; retire the path-glob notify. (The new subscription table is a NEW table — see Phase 0 — not a reshape of the existing path-glob `coord_subscriptions`.)

### D-004 — Topics: agent-curated, tag + one sentence, prefer-existing, NO creation-time gate
2026-06-03

A topic = one-word(ish) tag + one-sentence description. Agents read the full list once at prompt start and subscribe to a built-in `new_topic` topic that injects each new topic as created — the taxonomy is a live shared artifact. Prefer existing over creating new; with Opus-4.8 agents that suffices (no semantic suggest-on-create gate). Rare concurrent near-duplicate creation is handled by a cheap `topics:merge`/alias, not a gate.

### D-005 — Two subscription motivations, two mechanisms
2026-06-03

(a) "I can contribute to THIS thread" → per-object join. (b) "this area is relevant to my work" → topic subscription (standing interest). Both deliver via the same rail; topics serve (b) and are the scalable routing unit.

### D-006 — Delivery-mode tiering is mandatory (the noise control)
2026-06-03

Every subscription carries a delivery mode — `full` | `digest` (count + one-line summary) | `mention` (only @-addressed or on resolution) — plus a TTL/auto-drop. High-churn kinds (features, plans) default to `digest`. Without this a universal subscribe→inject is an instant firehose. Tiering lives in the fan-out + the inbox hook and must land WITH the fan-out.

### D-007 — Subscribable = coordination CONTENT, not control
2026-06-03

Topics, conversations, issues, features, plans are subscribable. Locks are NOT — you wait on a lock (queue/grant), you don't follow it.

### D-008 — I own the projection engine, table-registry, and federation calls (su-08782 idle)
2026-06-03

**Reverses the earlier "ride / coordinate with su-08782's engine + final registry shape" framing.** su-08782 (storage-unification) is idle; the owner put me in charge with no coordination. So: the fan-out + federation are projections I build on the **existing** `substrate_outbox` + Hyperbee features/issues machinery (`wire-outbox`/`feature-issue-op-keys` + per-table projection modules), generalizing into one registry-driven engine opportunistically — not waiting on anyone. I classify the new tables in `table-registry.ts` myself. There must still be exactly ONE outbox consumer (a second drain would race/duplicate) — that single consumer runs both sibling projections (D-009).

### D-009 — Federation is PRESERVED & adapted: a sibling projection on the same engine
2026-06-03

**Per owner: the federation feature cannot be removed.** It is not deferred or dropped — it is adapted into this framework. The insight: **federation and subscribe→inject are two projections of the same `substrate_outbox` change stream** — one to remote peers (peer-log/Hyperbee, the existing feature/issue machinery), one to local subscriber inboxes (the new fan-out). Same source, same engine, two targets.
- **Federated object set (content):** features + issues (already), engineer-issues, conversations, PG-canonical plans, and **topics** (the taxonomy must be shared across the federated set or `new_topic` diverges per machine). Each registers in the wire-outbox table-tag map + a projection module, carrying the `origin='remote'` echo-guard, the AFTER-UPDATE `WHEN OLD.* IS DISTINCT FROM NEW.*` guard, and the jsonb-binding fixes (`agent-insights/postgres-js-jsonb-binding`). LWW per Model-B.
- **Local-only (NOT federated):** subscriptions, per-subscriber inbox rows, watermarks, presence — these are machine/agent-local delivery state. Content arrives via peer-log; each machine's local fan-out delivers it to that machine's local subscribers.
- This restores plan cross-machine sync (git→peer-log, [[plans-pg-canonical-migration-2026-06-03]] D-004) and keeps features/issues federation intact, all on one mechanism.

## Surface map (whole project → owning plan)

| Surface | Owning plan |
|---|---|
| PG: topics, subscriptions, thread/comments, link edges, capability code; the single outbox consumer running both projections (fan-out + federation framework); delivery-mode tiering; `topics:*` tools; retire `coord:watch` | **this plan** |
| conversation/question object; knowledge-first ask; answer-capture | [[coordination-conversations-2026-06-03]] |
| `engineer_issues` surface; issues PG-canonical finish; blocking edges | [[engineer-issues-2026-06-03]] |
| features/plans → Taggable+Subscribable; per-object federation registration; admin UI; agent prompting/playbook | [[coordination-integration-adoption-2026-06-03]] |
| plan-item structured storage; plans federation projection | [[plans-pg-canonical-migration-2026-06-03]] |

## This plan's build (the substrate)

### Phase 0 — Schema + capabilities (additive, safe)
1. Migration (next free # via `db:check_drift`): `coord_topics` (slug PK, title, one-sentence desc, created_by), **`coord_entity_subscriptions`** (subscriber, target_kind `topic`|`object`, target_ref, delivery_mode, expires_ts — **local-only, not federated**; a NEW table — do NOT reuse/reshape the existing path-glob `coord_subscriptions`, which the Phase-3 `coord:watch` retirement drops), `coord_threads`/`coord_thread_posts` (polymorphic parent), `coord_links` (polymorphic edge). RLS + grants; I classify them in `table-registry.ts`.
2. Shared capability TS module (`@papercusp/coordination`): the six capability interfaces + helpers imported by every domain object.

### Phase 1 — Topics surface
`topics:list`/`create`/`subscribe`/`unsubscribe`/`merge` + the built-in `new_topic` topic. Read-once-at-prompt + new_topic injection (D-004). Topics are in the federated set (D-009).

### Phase 2 — The single outbox consumer: fan-out + federation framework + tiering
Build the ONE `substrate_outbox` consumer that runs both sibling projections (D-008/D-009): the local-inbox fan-out (resolve subscribers by topic/entity → per-subscriber rows honoring delivery mode) and the peer-log federation projection framework (the per-table registration pattern that conversations/issues/plans/features plug into). Extend the inbox hook to render digests + respect mode.

### Phase 3 — Retire coord:watch path-glob
Migrate any real consumer to entity/topic subscriptions; remove the path-glob watch + manual `fireNotifications` + the opt-in notify firehose, and drop the old `coord_subscriptions` table once no consumer remains.

## Risks
- **Firehose if tiering slips** — D-006 must land WITH Phase 2.
- **Double outbox consumer** — there must be exactly one drain running both projections (D-008); a second would race/duplicate.
- **Federation echo/amplification** — every federated object's projection needs the echo-guard + AFTER-UPDATE-DISTINCT + jsonb-binding fixes (D-009), or the outbox self-amplifies.
- **coord:watch retirement** — confirm no live consumer depends on path-glob notify before removal.
- **Embedded-pg constraint** — PG-only honors it.

## Dependencies / non-goals
- **Depends on:** the existing `substrate_outbox` + Hyperbee features/issues federation machinery + the inbox hook. (No dependency on another agent — I own the engine decisions, D-008.)
- **Non-goals:** Zero/IVM/broker; reactive query-result subscriptions (agents re-query on a nudge). Federation is explicitly IN scope (D-009), including topic federation.
