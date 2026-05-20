---
title: Agent coordination architecture — identity, locks, and channels
slug: agent-coordination-architecture-2026-05-20
status: superseded
created: 2026-05-20
updated: 2026-05-20
owner: pandawamble@gmail.com
superseded_by: apps/operator/docs/plans/agent-coordination-architecture-v2-2026-05-20.md
related:
  - apps/operator/docs/plans/file-locking-improvements-2026-05-20.md
  - apps/operator/docs/plans/omp-power-user-bundle-2026-05-20.md
  - apps/operator/docs/plans/agent-plan-tracking-2026-05-20.md
---

# Agent coordination architecture

A three-layer model for how SU agents (OMP sessions) and the engineer share state, coordinate work, and surface issues — without inventing the substrate every time we hit a new use case.

## Now

Spec review with user. No code lands until the layering is accepted. Once accepted, three downstream plans (file-locking improvements, OMP power-user bundle, this plan) all converge to the same coordination contract.

## §0 Why this plan now

Three coordination plans are in flight at once. They're each correct in isolation but they each invented their own identity story, their own storage choice, and their own delivery path:

- `file-locking-improvements-2026-05-20.md` — synchronous locks; per-session identity via `Mcp-Session-Id`; storage in Postgres.
- `omp-power-user-bundle-2026-05-20.md` — power-user agents; identity from HMAC token claims; bundle delivery via HTTP.
- `agent-plan-tracking-2026-05-20.md` *(shipped)* — durable plan documents; identity anonymous; storage in filesystem markdown.

Plus a *fourth* substrate already running for weeks: the rust-port `coord/*.jsonl` protocol — per-agent JSONL append-only logs that all five rust-port agents read at turn start. **It's the most successful coordination primitive we have, and no shipped plan references it.**

Plus the orchestrator's `FileLockQueue` + chunk-locking model — atomic multi-path acquire, FIFO-fair, deadlock-free, in-process — which solved exactly the locking problem `SU-locks` later re-solved at a different scope, with neither plan acknowledging the other.

Each of these is a real success. They don't conflict in implementation, but they conflict in *vocabulary* and *identity story*. This plan stops the drift by naming the layers explicitly and showing where each piece lives.

## §1 Goals / non-goals

### Goals

- **Name the three layers** (identity & presence, synchronous coordination, asynchronous communication) so future plans slot in without re-debating storage and substrate.
- **Establish L1 (identity & presence)** as the shared foundation L2 (locks) and L3 (channels) both consume. Today three identity stories exist; converge to one.
- **Spec L3 (asynchronous channels)** covering the five communication needs the user named: subscriptions/watching, ack/read-receipts, cross-plan decision propagation, handoff state, escalation to human. Build them as a coherent family, not five point solutions.
- **Borrow proven patterns**: the rust-port `coord/*.jsonl` model for the channel substrate, the `plans:*` shipped tool surface for durable structured state, the chunk-system invariants for L2's deadlock-freedom rationale.
- **Ship a history viewer** for plan progress as part of L3's UI side, even before durability is settled. Working-memory view first; archival later.
- **Preserve portability**: an OMP plugin running outside Papercusp (no operator on `localhost:3055`) can still participate in L3 via direct filesystem reads and writes. The operator adds nicer tool-mediated UX; it is not a prerequisite for L3 to function.

### Non-goals

- **Do not migrate L2 (locks) to filesystem.** Locks need Postgres semantics (advisory lock per workspace, atomic upsert, FIFO waiter wake). The locks plan stays as designed; this plan only confirms its L1 identity input.
- **Do not durably archive completed plans yet.** User explicitly deferred. When a plan reaches `status: completed`, *future* work will persist a snapshot to a database for long-term search. This plan only specifies the working-memory view.
- **Do not build a search index over the JSONL.** Grep is fine at the volumes this system targets (≤ a few thousand lines per file). When grep stops being enough we'll know.
- **Do not invent yet another store.** Plans stay in markdown at `apps/operator/docs/plans/`. JSONL files live at `coord/`. Locks stay in Postgres `papercusp_su`. No fourth substrate.
- **Do not require all agents to run with operator attached.** Portability is a goal; degraded mode is acceptable. Locks unavailable → L3 still works; agents can read each other's JSONL without an HTTP round trip.

### What "done" looks like

- An L1 identity primitive (`AgentIdentity`) consumed by the locks code, the OMP hook, and the (new) channel tools.
- A `coord/` filesystem layout with per-agent JSONL outboxes plus a handful of typed shared streams.
- MCP tool surface `messages:*` / `subscriptions:*` / `escalations:*` / `handoffs:*` over the JSONL.
- Plan-event log (`coord/plan-events.jsonl`) written by `plans:*` write verbs; history viewer reads it.
- Turn-start context-injection hook for OMP that surfaces unread messages, active subscriptions firing, and changed plans since the agent's last-read watermark.
- A simple UI panel showing active sessions, inbox, and history (extends whatever plans UI emerges; if none exists, this plan ships the first version).


## §2 The layered model

```
        ┌──────────────────────────────────────────────────────────┐
   L3   │  Asynchronous communication (eventual, fan-out)          │
        │  • messages (with acks)                                  │
        │  • subscriptions / watches                               │
        │  • escalations to human                                  │
        │  • handoff state                                         │
        │  • cross-plan decision propagation                       │
        │  • plan-event log (history)                              │
        │  Substrate: coord/*.jsonl  +  apps/operator/docs/plans/  │
        └──────────────────────────────────────────────────────────┘
        ┌──────────────────────────────────────────────────────────┐
   L2   │  Synchronous coordination (blocking, request/response)   │
        │  • SU-locks (cross-process, Postgres)                    │
        │  • FileLockQueue (in-process, in-memory)                 │
        │  Substrate: Postgres + heap                              │
        └──────────────────────────────────────────────────────────┘
        ┌──────────────────────────────────────────────────────────┐
   L1   │  Identity & presence                                     │
        │  • who am I right now? (session id, agent kind)          │
        │  • who else is active? what are they doing?              │
        │  Substrate: coord/agents/<session>.json + Postgres ident │
        └──────────────────────────────────────────────────────────┘
```

The rule that makes this layering pay off: **L2 and L3 share L1's identity definition.** Today a lock owner, a plan author, and a future message sender would each be derived independently. One identity primitive, three consumers.

## §3 What we're borrowing — and from where

This plan is mostly a rearrangement of existing patterns, not an invention. The substrate decisions are evidence-backed:

### From the rust-port `coord/*.jsonl` protocol (running since 2026-05-09)

- **Per-agent outbox files** (`coord/backend.jsonl`, `coord/mobile.jsonl`, …). Each agent only writes to its own file → no write contention, no file locking needed.
- **All agents read all files at turn start.** Crude but it works — the read cost is negligible at the file sizes we see (~150 KB across five agents after weeks of activity).
- **`to: ["agent-name"]` field on every entry** for routing/targeting. Broadcast = omit / `["*"]`.
- **`kind` taxonomy already field-tested**: `done`, `decision`, `contract`, `progress`, `audit`, `checkpoint`, `claim`, `refactor+tests`, `cleanup`. We adopt the same vocabulary.
- **Single `shared.jsonl`** for cross-cutting contracts everyone must read (e.g. *"never delete TypeScript code"*, *"all agents must push every turn"*). L3's "decisions cross-cutting all plans" maps directly onto this.
- **`commit` field** referencing the head SHA — so a reader can `git show <sha>` to verify the claim. We carry this forward; portability requires it (if the operator can't be queried, the SHA is the audit trail).

The rust-port pattern is the L3 substrate, almost unchanged. The new pieces are *typing* the entries, exposing them through MCP tools, and surfacing them in a UI.

### From the shipped `plans:*` tool surface (`agent-plan-tracking-2026-05-20.md`)

- **Markdown is canonical, filesystem is the source of truth.** No PG mirror. (D-002 from that plan.)
- **Parser-keyed sections** (`## Now`, `## Items`, `## Decisions`) — tools read structured state without an ORM.
- **`plans:list / get / items / search`** for reads; `plans:new / set-status / set-now / add-decision / add-item` for writes. **Already shipped, already correct.** L3's "durable structured state" *is* plans.
- **Legacy plans tagged `unknown`** rather than rejected — graceful coexistence with pre-format files.

We add one thing: a `plan-events.jsonl` event log written by the existing write verbs. That's the only schema change to the shipped system, and it's strictly additive.

### From `FileLockQueue` + chunk-locking (`worker-chunk-loop.ts`)

- **Atomic multi-path acquire — no partial holds.** Carried forward in L2; not re-invented at L3 because broadcast doesn't need atomicity.
- **Deadlock-freedom via no-hold-while-waiting** (not via the sort step — corrected in the file-locking comparison doc). This becomes one of L2's two implementations under the shared interface.
- **`Chunk { files: string[], description, id }`** — each unit of work declares its file scope up-front. The same shape powers L3 subscriptions: *"alert me when anyone acquires a lock matching this pattern"* is the cross-layer use case.

### From SU-locks (just shipped, `9ebb499a`)

- **Per-session identity** via `Mcp-Session-Id` header with `?client=` fallback. **This is already L1.** The plan extracts it; nothing changes about the mechanism.
- **`workspace_id` field** — renamed to `coordination_domain` (per `file-locking-improvements` D-008). The L1 identity primitive carries the coordination-domain assignment.

## §4 The L3 channel taxonomy

The user named five communication needs (#5–#9 from the prior discussion). Each maps onto a typed entry kind on top of the JSONL substrate:

| # | Need | Entry kind | Storage | Read pattern |
|---|------|-----------|---------|--------------|
| 5 | Subscription / watching | `subscribe` + `notify` | `coord/subscriptions/<watcher>.jsonl` + watcher's inbox | watcher reads inbox on turn start |
| 6 | Acknowledgment / read receipts | `ack` | sender's outbox | anyone scanning sees ack chain |
| 7 | Cross-plan decision propagation | `decision` (existing in plans) + `notify` | `plans:add-decision` writes plan + emits `notify` to subscribers | watcher gets a turn-start surface |
| 8 | Handoff state | `handoff` | plan's `## Now` block + `coord/<from>.jsonl` entry with `kind: handoff, to: [...]` | recipient reads inbox |
| 9 | Conflict escalation to human | `escalation` | `coord/escalations/<ts>-<from>.json` per-event file | UI surfaces prominently |

All five share one substrate (`coord/*.jsonl`) and one read pattern (turn-start scan). The variation lives in *which* kind of entry you write and *which* surface fires on it.


## §5 L1 — identity & presence

### §5.1 What L1 must answer

Two questions, every turn, for every agent and the human operator UI:

1. **"Who am I right now?"** — every action emits a stable, attributable identity. Same answer for lock owner, message sender, plan-decision author, hook owner.
2. **"Who else is active?"** — at any moment, which sessions are alive, what they declared they're working on, when they last checked in.

### §5.2 Identity (the resolved-owner primitive)

```typescript
// libs/papercusp/packages/coordination/identity.ts (new package)
export interface AgentIdentity {
  /** Stable across one OS process. Format: "<source>:<session>"
   *  e.g. "cc:abcd1234", "omp:efgh5678", "engineer-hook:ijkl9012"
   *  Truncate the session segment to 8 chars for display. */
  ownerId: string;

  /** Display alias — e.g. "omp (session abcd1234)". */
  ownerLabel: string;

  /** Where the identity came from, for debuggability. */
  source: 'mcp-session-id' | 'omp-hook-session' | 'static-client';

  /** Optional — Papercusp workspace this agent is acting within.
   *  Distinct from the locks' coordination_domain, which is per-machine. */
  workspaceId: string | null;

  /** Optional — the human user, when the agent has acted-as identity
   *  (power-user path from the OMP-bundle plan). */
  userId: string | null;
}

export function resolveAgentIdentity(ctx: ToolContext): AgentIdentity;
```

**Resolution order** (highest priority first):

1. OMP hook payload `session_id` (the per-turn hook receives this; it owns its identity outright).
2. MCP `Mcp-Session-Id` header (every Streamable HTTP MCP client maintains one).
3. Power-user token claims (`{ user_id, workspace_id, exp }` from the OMP-bundle plan's HMAC token).
4. Static `?client=<X>` URL parameter (the install script's machine UUID fallback).

The resolver is *one function* used by:

- `lib/agent-tools/locks/*.ts` (replaces the current ad-hoc reads from `headers.get('mcp-session-id')` and `?client=`).
- The OMP enforcement hook (from `file-locking-improvements-2026-05-20.md` #2 Part A).
- The new `messages:*` / `escalations:*` / `handoffs:*` tools.
- The (existing) `plans:*` write verbs — currently anonymous, gain attribution.
- The (new) `agents:presence` tool.

### §5.3 Presence

A per-session presence record at `coord/agents/<session>.json` (one file per active session; deleted on clean shutdown, garbage-collected after staleness):

```json
{
  "session": "abcd1234",
  "owner_id": "cc:abcd1234",
  "owner_label": "omp (engineer, session abcd1234)",
  "source": "omp-hook-session",
  "host": "host.example",
  "pid": 12345,
  "intent": "drafting agent-coordination-architecture plan",
  "started_ts": "2026-05-20T15:00:00Z",
  "last_heartbeat_ts": "2026-05-20T15:42:00Z",
  "active_lock_ids": ["7754d99d-..."],
  "current_plan_slug": null,
  "current_files": ["apps/operator/docs/plans/agent-coordination-architecture-2026-05-20.md"]
}
```

**Why per-file (not one shared file):** zero write contention, atomic creation+rename, simple cleanup (delete the file). Mirrors `coord/escalations/<ts>-<id>.json` shape for the same reasons.

**Heartbeat cadence:** the OMP `session_start` + `turn_start` hooks update `last_heartbeat_ts` automatically. No application code needs to remember.

**Staleness rule:** any session whose `last_heartbeat_ts` is older than 10 minutes is treated as dead by readers. Cleanup is opportunistic (next agent to read the directory rewrites the index).

**`intent` field is load-bearing.** This is where the user-facing "what is agent X doing right now?" surface gets its answer. Agents update it on:
- session_start (initial declaration)
- when they call `plans:set-now` (intent becomes the plan's now-text + plan slug)
- when they acquire a lock with a fresh `intent` parameter (lock-level intent rolls up)

### §5.4 The MCP tool surface for L1

```
agents:presence
  → { active_sessions: [PresenceRecord, ...], stale_sessions: [...] }

agents:identity   (returns ctx-resolved current identity — debug aid)
  → { ownerId, ownerLabel, source, workspaceId, userId }

agents:declare-intent  (write — updates the caller's presence record)
  { intent: string, current_plan_slug?: string, current_files?: string[] }
```

Three verbs, ~50 lines of implementation each. Identity resolution lives in the shared package; the tools are thin.

### §5.5 What L1 does *not* try to do

- **No long-term agent identity.** Sessions are ephemeral. Two OMP processes on the same machine are two sessions. The user is identified separately (power-user token `userId`); the *agent process* is not.
- **No presence durability.** A power outage clears `coord/agents/`. The next session bootstrap regenerates. That's correct — old presence records aren't useful.
- **No auth.** Identity is for *attribution*, not authorization. Authorization stays in the existing tier system (superuser / power-user / role-gated).


## §6 L3 — the channel substrate

### §6.1 Filesystem layout

All under `coord/` at the workspace root (preserving the rust-port location, which is already familiar to agents). The directory IS the API:

```
coord/
  agents/                          ← L1 presence
    <session>.json                   one file per live session

  messages/                        ← L3 #6 (messages + acks)
    <ownerId>.jsonl                  per-sender outbox; ack chain lives here too

  subscriptions/                   ← L3 #5 (watching)
    <ownerId>.jsonl                  per-watcher subscription list (current + expired)

  escalations/                     ← L3 #9 (escalation to human)
    <ts>-<id>.json                   per-event file; "resolved" written into same file in-place

  handoffs/                        ← L3 #8 (handoff state)
    <ts>-<id>.json                   per-handoff record; receiver can write "accepted" entry

  plan-events.jsonl                ← L3 (history viewer feed)
                                     single-writer (operator route) → no contention

  shared.jsonl                     ← L3 (rust-port-style global contracts)

  watermarks/                      ← per-agent last-read pointers (optional, hook-managed)
    <ownerId>.json
```

### §6.2 Why this shape

- **Per-agent files where the agent is the writer** → no write contention, no file locking. Inherits the rust-port property.
- **Per-event files for low-rate shared events** (escalations, handoffs) → mirrors maildir's atomic-write-by-name discipline; zero contention.
- **One shared file for the single-writer streams** (`plan-events.jsonl` — only the operator's `plans:*` route writes it; `shared.jsonl` — append-only contracts, low rate, JSONL line-append is atomic under PIPE_BUF).
- **Subscriptions are per-watcher**, not a shared registry. A watcher owns its list.

### §6.3 JSONL line shape (typed entries, one taxonomy)

Every line across every `*.jsonl` file under `coord/` shares a base envelope:

```typescript
interface CoordEnvelope {
  ts: string;          // ISO-8601 UTC
  msg_id: string;      // ULID; unique across all coord/*.jsonl
  from: string;        // AgentIdentity.ownerId
  to: string[];        // ["*"] for broadcast; ownerIds otherwise
  kind: CoordKind;
  // ...kind-specific fields below
}

type CoordKind =
  // borrowed from rust-port — same vocabulary, same semantics:
  | 'done' | 'decision' | 'contract' | 'progress' | 'audit'
  | 'checkpoint' | 'claim' | 'cleanup'
  // new for L3 #5–#9:
  | 'message' | 'ack'
  | 'subscribe' | 'unsubscribe' | 'notify'
  | 'handoff' | 'handoff_accepted'
  | 'escalation' | 'escalation_resolved';

// Common optional fields used by multiple kinds:
interface CoordCommon {
  summary?: string;           // human-readable one-liner
  body?: string;              // markdown blob, longer detail
  files?: string[];           // relevant files referenced
  commit?: string;            // head SHA at time of write
  plan_slug?: string;         // links to a plan doc
  related_msg_id?: string;    // for acks / replies / resolutions
}
```

Same envelope shape across all five primitives. Tools dispatch on `kind`. The rust-port kinds (`done`/`decision`/`contract`/etc.) keep working unchanged.

### §6.4 The five primitives, concretely

#### #5 — Subscriptions / watching

Agent A wants to be notified when anyone touches `apps/operator/auth/*`:

```jsonc
// agent A's session writes one line into coord/subscriptions/cc:abcd1234.jsonl
{"ts":"...", "msg_id":"01JZ...", "from":"cc:abcd1234",
 "kind":"subscribe", "pattern":"apps/operator/auth/**",
 "trigger":"lock_acquired|file_edited|plan_referenced",
 "expires_ts":"2026-05-21T00:00:00Z"}
```

**How notifications fire:**
- `locks:acquire` writes a `notify` line into each matching watcher's inbox (`coord/messages/cc:abcd1234.jsonl`) after a successful acquire.
- `plans:add-decision` / `plans:add-item` does the same when the decision/item references a matching path.
- Optional future: a filesystem watcher process emits notifies on raw file edits. Out of scope v1.

**Cancel:** agent A writes `{kind: "unsubscribe", related_msg_id: <orig subscribe id>}` into the same file. Reader filters out expired or cancelled.

**Tool surface:**
```
subscriptions:list   { owner?: <ownerId> } → SubRecord[]
subscriptions:add    { pattern, trigger, ttl_sec? } → { msg_id }
subscriptions:remove { msg_id } → ok
```

#### #6 — Messages with acks

Agent A sends a directed message to Agent B; both keep audit:

```jsonc
// A's outbox: coord/messages/<A>.jsonl
{"ts":"...", "msg_id":"01JZ_a", "from":"<A>", "to":["<B>"],
 "kind":"message", "summary":"hand off the auth refactor",
 "body":"PR ready at sha 1234abc; tests passing; one open question about ...",
 "plan_slug":"auth-refactor-2026-05-20"}

// B reads inbox = scan of ALL coord/messages/*.jsonl filtered by to.includes(<B>);
// on read, B appends an ack to ITS OWN outbox:
{"ts":"...", "msg_id":"01JZ_b", "from":"<B>", "to":["<A>"],
 "kind":"ack", "related_msg_id":"01JZ_a"}
```

**Why per-sender outbox:** A only writes its own file. No contention. B's ack lives in B's file. The chain is reconstructable by scanning all files (cheap at our volumes).

**Tool surface:**
```
messages:send       { to: ownerId[], summary, body?, plan_slug?, files? } → { msg_id }
messages:inbox      { since_ts?, kinds?: CoordKind[] } → CoordEnvelope[]
messages:ack        { msg_id } → ok  (appends ack to current agent's outbox)
messages:thread     { root_msg_id } → CoordEnvelope[]  (traverses related_msg_id)
```

Adopted vocabulary mirrors `messages:feature_send` / `messages:feature_inbox` (the harness-pipeline analog), differing only in scope (agents vs features).

#### #7 — Cross-plan decision propagation

A decision in plan A may affect plan B. The existing `plans:add-decision` API gains one optional field:

```typescript
plans:add-decision {
  slug: 'auth-refactor-2026-05-20',
  decision: 'switch to argon2id from bcrypt',
  affects?: ['session-token-rotation-2026-05-18', 'mobile-pair-2026-05-15'],
  body?: '...'
}
```

When `affects: [...]` is non-empty, the route also emits a `notify` line into each subscriber-of-those-plans' inbox AND a `decision` line into each affected plan's "incoming decisions" view (this lives in `plan-events.jsonl`, parsed into the plan's UI sidebar — see §7).

**Why not duplicate the decision into each affected plan's markdown:** drift. The decision has one canonical home (the plan where it was made); other plans *reference* it via `plan-events.jsonl`, which is the single source of cross-plan event truth.

#### #8 — Handoff state

Agent A is done with their piece; B picks up:

```jsonc
// coord/handoffs/<ts>-<id>.json (per-event file, atomic write)
{
  "ts": "...",
  "msg_id": "01JZ_h",
  "from": "<A>",
  "to": ["<B>"],
  "kind": "handoff",
  "plan_slug": "auth-refactor-2026-05-20",
  "summary": "Phase 2 complete; Phase 3 ready to start",
  "body": "Branch at sha 1234abc. Tests passing. Open: what to do about the legacy bcrypt rows — see decision Q-1.",
  "files_modified": ["apps/operator/lib/auth/*.ts"],
  "next_action": "implement Phase 3 §4.2 (legacy migration)",
  "commit": "1234abc"
}
```

When B accepts, B writes a sibling `<ts>-<id>.json` with `kind: "handoff_accepted"` and `related_msg_id`. Or B can simply call `plans:set-now` referencing the same plan, which auto-emits a handoff_accepted.

**Why both `## Now` *and* a handoff record:**
- `## Now` is the current state — single line, plan-local, human-readable.
- The handoff record is the *transition event* — durable, addressable, ack-able.

The plan's `## Now` block gets re-read on every turn (`plans:get`); the handoff is a one-shot event that fires the receiver's inbox once.

#### #9 — Escalation to human

Agent reaches a decision they shouldn't make alone:

```jsonc
// coord/escalations/<ts>-<id>.json
{
  "ts": "...",
  "msg_id": "01JZ_e",
  "from": "<A>",
  "to": ["human"],
  "kind": "escalation",
  "severity": "blocker" | "question" | "advisory",
  "summary": "About to drop migration 060 — confirm?",
  "body": "...",
  "plan_slug": "db-unlocks-plan-2026-05-11",
  "options": [
    { "id": "proceed", "label": "Drop the migration and re-run from 059" },
    { "id": "rollback", "label": "Keep 060, manual fix at psql" },
    { "id": "wait", "label": "Pause this work; pick up something else" }
  ],
  "resolved": null
}
```

Human resolves via UI (or via a `escalations:resolve` tool); the file is updated in-place with `resolved: { choice: "proceed", ts: "...", note: "go ahead" }`.

The UI surfaces unresolved escalations *prominently* (banner, badge count, sound — TBD with the user). This is the channel that earns the right to interrupt.

**Tool surface:**
```
escalations:open       { severity, summary, body, options? } → { msg_id }
escalations:list       { status?: 'open'|'resolved' } → EscalationRecord[]
escalations:resolve    { msg_id, choice, note? } → ok
```


## §7 Turn-start context injection

The user's specific question: *"any agent working on a plan reads it all on each turn (can that be enforced?)"*

Three things to separate (covered in the prior architecture chat, repeated here for the plan record):

1. **Information delivery is enforceable.** A hook injects a system reminder before the agent's turn starts. The content is in the context window. *That is enforcement of delivery.*
2. **Agent compliance is not enforceable.** Same shape as every other prompt-discipline problem. The hook puts the info in front of the model; what the model does with it is downstream.
3. **"All plans every turn" is too coarse.** The right unit is *changed since this agent last read*, with light relevance filtering.

### §7.1 The injected payload

At turn start, the hook fetches (in parallel; ~5 file reads + 1 PG query) and concatenates a short reminder:

```
<system-reminder type="agent-coord">
You (cc:abcd1234) currently hold 1 lock:
  • apps/operator/docs/plans/agent-coordination-architecture-2026-05-20.md (your own)

Inbox — 2 unread since 14:32:
  • [message from omp:efgh5678] "fold path canonicalization into your batch?" → file-locking-improvements
  • [escalation:open severity=question id=01JZ_e] "About to drop migration 060 — confirm?"

Plans changed since you last read (3):
  • file-locking-improvements-2026-05-20.md — 2 decisions added
  • omp-power-user-bundle-2026-05-20.md — status: proposed → reviewed
  • agent-plan-tracking-2026-05-20.md — Now block edited

Subscriptions firing (1):
  • Your watch on "apps/operator/lib/agent-tools/locks/**" matched a lock acquired by omp:efgh5678
</system-reminder>
```

Compact. Skimmable. Doesn't dump full plan bodies — those are one tool call away if the agent decides to read.

### §7.2 The watermark

Per-agent, last-read timestamp per surface:

```json
// coord/watermarks/cc:abcd1234.json
{
  "messages_since_ts":       "2026-05-20T14:32:00Z",
  "escalations_since_ts":    "2026-05-20T14:32:00Z",
  "plan_events_since_ts":    "2026-05-20T14:32:00Z",
  "subscriptions_fired":     ["01JZ_n1", "01JZ_n2"]
}
```

Updated by the hook at turn-end (when it has plausibly been consumed). The "Plans changed since you last read" filter uses `plan_events_since_ts`.

### §7.3 The hook

OMP is the only engineer-collaborator harness (2026-05-20 OMP-only decision), so there is exactly one hook surface:

- **OMP `turn_start`** — event from `HookAPI`. The handler injects the system-reminder before the model's turn. Installed into `~/.omp/agent/hooks/` by `install-standalone-mcp.sh` for the engineer path; **delivered via bundle** into the session-scratch dir for the power-user path (consistent with the OMP-bundle plan §4.3.1).

This is the same module that carries the L2 `tool_call` handler and the L1 `session_start` handler — one hook, three handlers (see §11.1).

### §7.4 Failure mode (silent injection failure)

Same critique that applies to L2's hook fail-open (`file-locking-improvements` #3) applies here. Solution is the same: on injection failure, write to a marker file; surface in UI.

The cost of a silent injection failure here is lower than L2's — a missed inbox notification is recoverable (the agent can scroll), while a missed lock is a stomp. Still worth surfacing.

## §8 The history viewer

User explicitly asked for this *now*, before durability is settled. It's a working-memory view, not an archive.

### §8.1 The plan-event log

Source: `coord/plan-events.jsonl`. Single writer (operator process running `plans:*` write verbs). Schema:

```jsonc
{"ts":"...","msg_id":"...","kind":"plan_event","from":"<ownerId>","to":["*"],
 "plan_slug":"file-locking-improvements-2026-05-20",
 "event":"created" | "status_changed" | "now_updated" | "decision_added"
        | "item_added" | "item_status_changed" | "completed",
 "before"?: <prior value>,
 "after"?: <new value>,
 "detail"?: <one-line summary>}
```

The existing `plans:*` write verbs gain one line of code each: emit an event to this log before returning success. ~5 lines net change across the verb implementations.

### §8.2 The viewer UI

A scrollable, chronological feed. Default view is "the last 7 days, all plans"; filterable by:

- **Plan** (single-select)
- **Event kind** (multi-select: created / status_changed / now_updated / decision_added / item_status_changed / completed)
- **Author** (`from` field)
- **Time range**

Each row is one event:

```
14:32  [file-locking-improvements] status: proposed → reviewed                 (pandawamble@gmail.com)
14:30  [file-locking-improvements] decision added: "rename workspace_id"       (cc:abcd1234)
14:25  [omp-power-user-bundle] now updated: "spec review with user"            (pandawamble@gmail.com)
14:18  [agent-coordination-architecture] created                               (cc:abcd1234)
```

Click a row → opens the plan at that section.

### §8.3 What this is *not*

- **Not an archive of completed plans.** When a plan reaches `status: completed`, its event stream stays in `plan-events.jsonl` for whatever rolling window we settle on (proposal: 30 days). The user has explicitly deferred archival to a future DB-backed system.
- **Not a search index.** Filtering is over the JSONL, parsed in-memory each request. Fine at a few thousand events; reconsider when grep is slow.
- **Not an audit log for compliance.** It's a working-memory view. Audit lives elsewhere (`harness_shared.tool_invocations` for tool-call audit).

### §8.4 Rotation / retention

The event log grows monotonically. At 1 event per plan-write × ~20 plan-writes per day × 30 days = 600 events ≈ a few hundred KB. Fine for years before we'd care.

When we do care, we'll rotate (`coord/plan-events-2026-05.jsonl`, `coord/plan-events-2026-06.jsonl`, etc.). The viewer concatenates the last N month-files. Trivial.

## §9 UI surface — extending the plans UI

The user noted *"we are already implementing an interface for viewing the plans"*. I searched the codebase and found the shipped `plans:*` MCP tool surface but no graphical UI in `apps/operator/app/` yet. **Open question Q-1**: is there a UI plan in flight I should align to, or is this plan the first cut?

If this plan is the first cut, the proposed shape is one new operator route — `/agents` — with four panels (tabs or stacked):

### §9.1 Panel: Active sessions (L1)

- Lists `coord/agents/<session>.json` records, sorted by `last_heartbeat_ts` desc.
- Each row: owner_label, intent, current_plan_slug (link), active locks (count + link), last_heartbeat (relative).
- Stale sessions in a separate, dimmed section.
- Source: `agents:presence` MCP tool, or direct filesystem read.

### §9.2 Panel: Inbox (L3 — what's surfaced to *the human*)

The human's inbox = all entries with `to.includes("human")`:

- **Escalations (open)** — most prominent. Click → expand body + options; select option → POSTs `escalations:resolve`.
- **Messages** — if any agent directly addressed the human.
- **Handoffs** — same — agent-to-human handoffs (rare; agent-to-agent handoffs live on per-plan views).

This is the "things surfaced to the human" interface the user named.

### §9.3 Panel: Plans (existing tool surface, new UI)

- List of active plans (filterable: status, owner, date).
- Click → full plan render (markdown).
- Sidebar: incoming decisions from *other* plans (cross-plan references via `plan-events.jsonl`).

### §9.4 Panel: History (new, this plan)

The history viewer from §8.2. Time-ordered event feed. Click-through to plan sections.

### §9.5 What's not in v1

- Subscriptions panel — power-user feature; can wait. Subscriptions still work via tool calls.
- Charts, dashboards, vanity stats. Working-memory view, not analytics.
- Per-agent dashboards. The session presence panel covers this.


## §10 Portability — operator-attached vs detached

The user's note: *"The OMP plugin could theoretically be run outside of the Papercusp application so portability is nice, even though a tighter integration between them is what will really make it shine."*

Two operating modes, with explicit feature matrices.

### §10.1 Operator-attached (the full experience)

- Operator running on `localhost:3055` (or wherever).
- All MCP tools (`agents:*`, `messages:*`, `subscriptions:*`, `escalations:*`, `handoffs:*`, `plans:*`, `locks:*`) available.
- Turn-start injection via hooks reads through the tool surface.
- UI at `/agents` shows everything.

### §10.2 Detached (degraded but functional)

- No operator running. OMP plugin in a terminal somewhere.
- `coord/` directory still accessible on the filesystem (the plugin knows the workspace root from its `--workspace` arg or `pwd`).
- **What still works:**
  - Reading other agents' outboxes (`coord/messages/*.jsonl`).
  - Writing own outbox.
  - Reading plans (markdown files).
  - Reading presence (`coord/agents/*.json`).
  - Writing own presence record.
  - Subscriptions registration.
- **What does NOT work:**
  - Locks (require PG). Plugin's L2 hook fails open with a UI marker (same fail-open as the locks plan).
  - Cross-process notify-fan-out (would need an operator process to scan subscriptions on lock acquire). Subscriptions in detached mode only fire on the watcher's own read pass.
  - The UI at `/agents` — there's no operator serving it.
- **Honest caveat:** "detached mode coordinates" means *agents can leave each other notes via the filesystem*. It does not mean *they can prevent each other from stomping*. That requires the operator + PG.

### §10.3 Switching modes

The plugin probes `localhost:3055/api/health` (or whatever) at startup. If reachable → attached mode (full tool surface). Else → detached mode (direct filesystem operations). No config flag; auto-detect.

### §10.4 Why this matters

The user named portability as a property they want preserved. The L3 substrate is already filesystem-based; this is mostly already true. The plan only formalizes what works detached vs not, so a future user running OMP outside Papercusp doesn't expect locks to work.

## §11 Cross-plan coordination

This plan touches three other plans. Stating the seams explicitly.

### §11.1 With `file-locking-improvements-2026-05-20.md`

- **L1 identity primitive replaces ad-hoc reads in lock code.** Locks plan #5 ("acquire echoes resolved owner") expands into "owner is resolved by `resolveAgentIdentity(ctx)`, returned in the response." Strictly additive; no change to lock semantics.
- **`workspace_id` → `coordination_domain` rename** — owned by the locks plan (per its D-008(c)). This plan depends on the rename being cosmetic.
- **OMP enforcement hook (locks #2)** — already designed to coordinate with the OMP-bundle plan. This plan adds *one more event handler* to the same hook module: `turn_start` for context injection. Same module, three handlers (`tool_call` for L2, `session_start` for L1 presence, `turn_start` for context injection).
- **Shared interface (locks #11)** — package becomes `libs/papercusp/packages/coordination/` with sub-modules `identity/`, `lock/`, `channel/`. Already noted in my response to the OMP-bundle revision.

### §11.2 With `omp-power-user-bundle-2026-05-20.md`

- **Bundle delivers the coordination hook.** The OMP-bundle plan's §4.3.1 already specifies hook delivery via bundle for power-user path. This plan adds: the bundled hook does L1/L2/L3 work, not just L2. No change to the bundle plan; the hook source at `apps/operator/scripts/hooks/omp/coord.ts` is one richer module.
- **Power-user token's `userId` populates L1's `AgentIdentity.userId`.** Already specified in §5.2 above.

### §11.3 With `agent-plan-tracking-2026-05-20.md` (shipped)

- **No schema change to plans.** Markdown stays canonical.
- **One line added to each `plans:*` write verb** — emit a `plan_event` to `coord/plan-events.jsonl`. Strictly additive.
- **`plans:add-decision` gains optional `affects: string[]`** field — backward compatible. Old callers omit it; new callers populate it for cross-plan propagation.
- **Plans UI**: this plan's §9 *extends* the plans surface. If a separate plans-UI plan exists (Q-1 above), align there; otherwise this plan ships the first version.

## §12 Order of work

Phased so each phase is testable and useful on its own.

### Phase A — L1 (presence + identity)
**~1 day. Prerequisite for everything else.**

1. Create `libs/papercusp/packages/coordination/identity.ts` — the resolver.
2. Refactor `apps/operator/lib/agent-tools/locks/identity.ts` to consume it (delete the ad-hoc resolution; locks plan's #5 acquire-echo follows naturally).
3. `coord/agents/<session>.json` write/read primitives in the same package.
4. OMP hook handlers write presence on `session_start` / heartbeat on `turn_start` / delete on `session_shutdown`.
5. MCP tools: `agents:presence`, `agents:identity`, `agents:declare-intent`.

Tested by: spawn two OMP sessions, observe two presence files, `agents:presence` lists both.

### Phase B — L3 messages + history (the high-value pair)
**~2 days.**

1. `coord/messages/<ownerId>.jsonl` substrate + envelope schema.
2. MCP tools: `messages:send`, `messages:inbox`, `messages:ack`, `messages:thread`.
3. `coord/plan-events.jsonl` write path — bolt onto existing `plans:*` write verbs.
4. UI: `/agents` route with Active Sessions + Inbox + History panels.
5. Turn-start injection hook surfaces unread inbox.

Tested by: agent A sends to B, B's next-turn injection surfaces it, B acks; history view shows the conversation chronologically.

### Phase C — L3 escalations + handoffs
**~1.5 days.**

1. `coord/escalations/<ts>-<id>.json` + tools (`escalations:open`/`list`/`resolve`).
2. `coord/handoffs/<ts>-<id>.json` + tools.
3. UI Inbox panel surfaces escalations prominently; handoffs in a dedicated section.
4. `plans:set-now` integration → auto-emits handoff_accepted when the `## Now` block names a different owner.

Tested by: agent calls `escalations:open`; UI shows banner; human picks an option; agent's next turn sees the resolution.

### Phase D — L3 subscriptions + cross-plan propagation
**~1.5 days.**

1. `coord/subscriptions/<ownerId>.jsonl` + tools.
2. `locks:acquire` writes `notify` lines into matching watchers' inboxes.
3. `plans:add-decision` gains `affects: string[]`; cross-plan notify fan-out.
4. Turn-start injection surfaces subscription fires.

Tested by: agent A subscribes to `lib/auth/**`; agent B acquires a lock there; A's next turn sees the notify.

### Phase E — Portability hardening (detached mode)
**~1 day.**

1. Filesystem-direct path in the coordination package (no HTTP dependency).
2. Plugin auto-detect: probe operator → attached / detached.
3. Documentation of the feature matrix from §10.

Tested by: kill the operator; OMP plugin still reads/writes `coord/`; locks fail-open with marker file.

**Total:** ~7 days of focused work. Phases A and B are the high-value pair (presence + messages + history). The rest is incremental.

## §13 Decisions

- **D-001** Three-layer model is the canonical mental model: L1 identity & presence, L2 synchronous coordination (locks), L3 asynchronous communication (channels + durable plans).
- **D-002** L3 substrate is JSONL + markdown on the filesystem, not Postgres. *Why:* portability (detached mode), grep-ability, human-editability, and the rust-port `coord/*.jsonl` pattern has been proving the model for weeks. PG remains for L2 and for the future durability layer.
- **D-003** **One typed envelope shape for all `coord/*.jsonl` lines** (`CoordEnvelope` in §6.3). Adopts the rust-port field names (`ts`, `from`, `to`, `kind`, `summary`, `commit`, `files`) so existing JSONL stays valid.
- **D-004** **Per-agent files where the agent is the writer.** Eliminates write contention without introducing locks. Mirrors the rust-port pattern.
- **D-005** **Single source of truth for cross-plan decisions** — the decision lives in one plan's markdown; other plans *reference* it via `plan-events.jsonl`. Never duplicate.
- **D-006** **L1 identity is one function**, used by L2 and L3 and the OMP hook and `plans:*`. Three identity stories converge to one. (`AgentIdentity` + `resolveAgentIdentity(ctx)`.)
- **D-007** **Turn-start context injection is the enforcement mechanism for "agents read coord state."** Information delivery is enforced; agent compliance is downstream prompt discipline (same as every other model-behavior property).
- **D-008** **History viewer ships in Phase B** (now), not deferred to durability. Working-memory view over `plan-events.jsonl`. Archival to DB is a separate future plan when we have a complete-plan corpus worth searching.
- **D-009** **Portability is preserved by design.** Detached mode (no operator) is a first-class supported configuration for L1 + L3, with an explicit feature matrix in §10. Locks degrade gracefully (fail-open with marker); other primitives fully functional.
- **D-010** **The package `libs/papercusp/packages/coordination/` houses all of L1, L2's shared interface, and L3.** Three sub-modules: `identity/`, `lock/` (today's `FileClaimCoordinator`), `channel/`. Supersedes the locks plan's #11 package boundary.

## §14 Open questions

- **Q-1** **Existing plans-UI plan?** User said *"we are already implementing an interface for viewing the plans."* I couldn't locate it in `apps/operator/app/` or in the active plan docs. If it exists, this plan's §9 should *extend* rather than *create*. If it doesn't, this plan ships the first version. Need a pointer or confirmation.
- **Q-2** **`coord/` location** — workspace root (current rust-port convention, `/home/marsh-office/papercupai-workspace/coord/`) or per-repo (`papercup/coord/`)? Both exist today; both have entries. Proposal: standardize on **per-repo** (`papercup/coord/`) for the SU-agent surface, since SU agents work on one repo at a time. The rust-port multi-repo coord stays at workspace root, separate concern.
- **Q-3** **Sound for escalations?** Escalations are the channel that earns the right to interrupt the human. A soft chime is reasonable on `escalations:open` if the UI is in the foreground; off by default; user-configurable. Or: no sound, badge count only. User's call.
- **Q-4** **Watermark write timing.** §7.2 says the hook writes watermarks at *turn-end* ("plausibly consumed"). Alternative: write at turn-start, treating injection as consumption. Turn-end is conservative (an aborted turn doesn't update the watermark; the next turn re-sees the notifications). Turn-start is simpler (no end-hook needed). Proposal: turn-end if reliable end-hooks exist on the CLI; turn-start otherwise.
- **Q-5** **Cross-machine coordination.** Today an engineer's machine and a user's desktop install never coordinate. Their `coord/` dirs are physically separate. If we ever want cross-machine coord (e.g., engineer's instance acknowledging a user's escalation), we need a sync layer (sync the `coord/` dir; would prefer Git for human-meaningful events, something lighter for messages). **Out of scope for v1; flag as a future tier.**
- **Q-6** **Retention.** Plans grow forever as markdown — fine, that's their nature. JSONL grows forever as event logs — needs rotation eventually (proposal: monthly file rotation, viewer reads last N months). Confirm 30-day window is enough working memory.
- **Q-7** **Naming.** I've used `messages:*`, `subscriptions:*`, etc. The harness already has `messages:feature_send` / `messages:feature_inbox`. Risk of collision in tool listings. Proposal: namespace the new tools as `agent-messages:*` etc. to disambiguate. Alternative: rename harness verbs to `feature-messages:*`. Open.
- **Q-8** **Phase ordering**. Phase A → B → C → D → E is the natural dependency order. But the user might prioritize differently — e.g., escalations first because they're high-leverage. Confirm or reorder.

## §15 Rejected alternatives

- **Build L3 in Postgres.** Considered briefly. Rejected: portability requires filesystem access; jsonl has zero-dependency reads; agents-read-all-files-at-turn-start works because the files are *small* and *atomic-line-append*. The PG advisory-lock-per-workspace machinery would be ten times the complexity for no functional gain — broadcast doesn't need atomic acquire.
- **Reuse `harness_shared.spawns` + `messages:feature_*` for SU agents.** Rejected: `harness_shared` is for the *harness pipeline* (scoper/architect/worker/etc. inside one feature). SU agents are a different scope — engineer-collaborator processes, not features. Conflating the two schemas would muddy both.
- **Webhooks / a notification server.** Rejected: requires per-agent persistent connections, hard to do across heterogeneous CLI runtimes, breaks portability. Read-at-turn-start over filesystem is good enough at our volumes.
- **Push all coord state into a search index (e.g., SQLite FTS).** Rejected for v1. Grep is fine. Reconsider when grep is slow.
- **A separate "agent chat" runtime.** Rejected: this is what `agent_chats` could become if extended, but agent chats today are a different surface (operator chat between human and one agent). Building a parallel chat for SU agents would fork that concept. Channels-via-JSONL stay distinct.
- **Mandatory turn-start tool calls instead of hooks.** Rejected: cooperative-only enforcement (the agent decides whether to call `agents:turn-context`), and we already know from §7 that information-in-context is the right gate. Hooks enforce delivery; tool calls don't.

---

End of plan. Ready for review.
