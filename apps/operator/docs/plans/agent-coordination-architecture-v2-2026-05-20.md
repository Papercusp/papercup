---
title: Agent coordination architecture v2 — identity, locks, channels, and the harness on-ramp
slug: agent-coordination-architecture-v2-2026-05-20
status: shipped
created: 2026-05-20
updated: 2026-05-20
owner: pandawamble@gmail.com
supersedes: apps/operator/docs/plans/agent-coordination-architecture-2026-05-20.md
related:
  - apps/operator/docs/plans/file-locking-improvements-2026-05-20.md
  - apps/operator/docs/plans/omp-power-user-bundle-2026-05-20.md
  - apps/operator/docs/plans/agent-plan-tracking-2026-05-20.md
---

# Agent coordination architecture v2

How OMP-based engineer-collaborator agents and the engineer share state, coordinate edits, communicate, and feed work into the harness — built on existing substrate, not new invention.

## Now

**State:** **Shipped.** Phases A–F all complete — L1 identity/presence, L2 file locking, L3 channels (`coord:send/inbox/ack/thread`), `coord/plan-events` on the `plans:*` write verbs, the `plans:promote` on-ramp, the OMP turn-start hook, and the `/coord` UI. Three skeptical audits run; every finding fixed.

**Next:** none — plan complete (the plan body ends at §18, "ready for review").

## §0 What this plan is, and what changed since v1

v1 named a three-layer coordination model (L1 identity, L2 locks, L3 channels). It was then **audited line-by-line against the codebase**. The audit found the architecture sound but surfaced two unbuildable tool-namespace collisions, several factual inaccuracies, and gaps. Separately, the user defined a new requirement — SU-agent plans must be able to **enter the harness as features** — and we worked through how that maps onto the *existing* proposals/SPEC/scoper machinery.

v2 is the corrected, complete plan. Concrete deltas from v1:

- **Tool namespaces fixed.** v1 proposed `messages:*` and `escalations:*` — both already-registered namespaces in the codebase (`messages:send`, `messages:inbox`, `escalations:get`, …). v2 puts the entire new coordination surface under a single **verified-free `coord:*` namespace**.
- **Rust-port `kind` taxonomy corrected.** v1 mis-stated it. `ack` and `handoff` are *existing* rust-port kinds, not new; `checkpoint`/`claim` are not `kind` values at all (they are `action` values in a *different* coord directory). v2 §3 states it accurately.
- **The two-coord-schema reality.** Two `coord/` dirs exist with *different* line schemas (`kind` vs `action`). v2 §6 scopes the new typed envelope to the new files only; it does not claim to validate legacy lines.
- **Citation + ownership fixes.** v1 cited a non-existent "file-locking-improvements D-008(c)"; the `coordination_domain` rename was an orphaned work item owned by nobody. v2 §13 owns it explicitly with its real footprint.
- **`cc:` → `omp:`.** v1's OMP-only pass missed 9 `cc:` (Claude Code) identifier examples. v2 is uniformly OMP.
- **New: §11 Plan → harness on-ramp.** The largest addition — how an SU agent's plan becomes harness features.
- Full audit changelog is §17.

The conversation arc that produced this: file-locking improvements → a comparison of the two pre-existing lock systems → the three-layer coordination model → the OMP-only decision (drop Claude Code / Codex / Gemini as integration targets) → the plan→harness on-ramp.

## §1 Goals / non-goals

### Goals

- **One coordination vocabulary.** Name three layers — L1 identity & presence, L2 synchronous locks, L3 asynchronous channels — so future work slots in without re-litigating substrate. One identity primitive feeds all three.
- **Build on existing substrate.** The rust-port `coord/*.jsonl` pattern, the shipped `plans:*` tool surface, the `FileLockQueue`/SU-locks systems, and the proposals/SPEC/scoper pipeline already exist. v2 connects them; it does not replace them.
- **Spec the L3 channel family** — messages+acks, subscriptions/watching, escalation-to-human, handoff state, cross-plan decision propagation — as one coherent surface, not five point tools.
- **Ship a plan history viewer** as working-memory UI, before durable archival is built.
- **The plan→harness on-ramp.** An SU agent that has authored a plan with a human can promote it into the harness: create the features and update SPEC.md directly, as a first-class path parallel to (not gated by) the autonomous scoper.
- **Preserve portability.** An OMP agent running outside Papercusp (no operator) still participates in L3 by direct filesystem reads/writes. The operator adds tool-mediated UX and is not a prerequisite.

### Non-goals

- **Not migrating L2 to the filesystem.** Locks need Postgres semantics (advisory-lock-per-domain, atomic upsert, FIFO waiter wake). L2 work lives in `file-locking-improvements-2026-05-20.md`; v2 only consumes its identity input.
- **Not relationalizing SPEC.md.** The spec stays a prose markdown document (already DB-canonical — see §11.3). v2 adds stable inline criterion IDs, not a criteria table.
- **Not durably archiving completed plans.** Working-memory view only; DB-backed archival is deferred.
- **Not a search index over JSONL.** Grep suffices at target volumes.
- **Not supporting Claude Code / Codex / Gemini.** Per the 2026-05-20 OMP-only decision, OMP is the sole engineer-collaborator harness.
- **Not requiring operator-attached mode.** Detached degraded mode is first-class for L1+L3.

### What "done" looks like

- One `coord:*` MCP tool surface (L1 + L3) plus `plans:promote` (the on-ramp), all on verified-free names.
- A `coord/` filesystem layout: per-agent JSONL outboxes + typed shared streams.
- A turn-start context-injection OMP hook (the same module that carries the L2 `tool_call` handler — see §12).
- The plan history viewer + a `/coord` UI route (active sessions, human inbox, history).
- `plans:promote` working end-to-end: a plan → features (via `/features/import`) + SPEC.md update (via `PUT /spec`), with `[SC-NNN]` coverage links.

## §2 The layered model

```
   ┌───────────────────────────────────────────────────────────────┐
   │  PLAN → HARNESS ON-RAMP  (§11)                                 │
   │  plans:promote — an authored plan becomes harness features +   │
   │  a SPEC.md update. Parallel to the autonomous scoper.          │
   └───────────────────────────────────────────────────────────────┘
   ┌───────────────────────────────────────────────────────────────┐
 L3│  Asynchronous communication (eventual, fan-out)                │
   │  messages+acks · subscriptions · escalations · handoffs ·      │
   │  cross-plan decision propagation · plan-event log              │
   │  Substrate: coord/*.jsonl + apps/operator/docs/plans/*.md      │
   └───────────────────────────────────────────────────────────────┘
   ┌───────────────────────────────────────────────────────────────┐
 L2│  Synchronous coordination (blocking, request/response)         │
   │  SU-locks (cross-process, Postgres) · FileLockQueue (in-proc)  │
   │  Owned by file-locking-improvements-2026-05-20.md              │
   └───────────────────────────────────────────────────────────────┘
   ┌───────────────────────────────────────────────────────────────┐
 L1│  Identity & presence                                           │
   │  who am I (session) · who else is active · what they're doing  │
   │  Substrate: power_user_sessions row (PG) + coord liveness rows │
   └───────────────────────────────────────────────────────────────┘
```

The load-bearing rule: **L2, L3, and the on-ramp all consume L1's one identity definition.** A lock owner, a message sender, a plan-decision author, a feature's creator — one `resolveAgentIdentity(ctx)`, four consumers. v1's failure mode was three independent identity stories; v2 collapses them.

## §3 What we're borrowing — and from where (audit-corrected)

This plan rearranges existing patterns. Every substrate claim below was verified against source during the v1 audit.

### From the rust-port `coord/*.jsonl` protocol

- **Per-agent outbox files** — each agent writes only its own file → no write contention, no file locking needed.
- **All agents read all files at turn start.** Works at observed volumes (the workspace-root `coord/` is ~454 KB total across five agents after weeks — *not* the "~150 KB" v1 claimed; corrected).
- **`to: [...]` routing field** on every entry; broadcast = `["*"]`.
- **`commit` field** — head SHA at write time, so a reader can `git show` to verify a claim.
- **A shared stream** for cross-cutting contracts everyone must read.

**Two corrections the audit forced** (v1 got these wrong):

1. **The `kind` taxonomy is sprawling and ad-hoc, not a clean fixed set.** The workspace-root `coord/` has 19 distinct `kind` values; the top ones are `done` (409×), `contract` (157×), `progress` (136×), `ack` (47×), `decision` (29×), `handoff` (22×). **`ack` and `handoff` are already field-proven rust-port kinds** — v1 wrongly labelled them "new for L3." That the pattern is already in production *strengthens* the L3 design; v2 says so honestly.
2. **There are two coord directories with different line schemas.** `papercupai-workspace/coord/*.jsonl` keys on `"kind"`; `papercup/coord/*.jsonl` keys on `"action"` (`checkpoint`, `claim` are `action` values there — v1 wrongly listed them as `kind`s). v2's typed envelope (§6.3) governs **only the new files the new tools write**; it does not retrofit or re-validate either legacy directory.

### From the shipped `plans:*` tool surface (`agent-plan-tracking-2026-05-20.md`)

- **Markdown is canonical, filesystem is source of truth** (that plan's D-002). No PG mirror for plan docs.
- **Parser-keyed sections.** The parser yields `{ frontmatter, now, items, decisions }` with tolerant heading matching (`## 7. Decisions` matches `## Decisions`).
- **Verified verb set** (10 registered): reads `plans:list / get / items / search / lint`; writes `plans:new / set-status / set-now / add-decision / add-item`. v2 adds an 11th — `plans:promote` (§11.2), name verified free.
- **Attribution exists but is self-reported.** `plans:add-decision` already writes an `owner_label` — but it is *caller-supplied*, not derived from a trusted identity. v1 called the write verbs "anonymous"; that was wrong. v2's L1 work replaces the self-reported field with `resolveAgentIdentity(ctx)`.

v2 adds one thing to this surface: a `coord/plan-events.jsonl` event log emitted by the existing write verbs (§8).

### From `FileLockQueue` + the chunk system

- **Atomic multi-path acquire**, no partial holds; deadlock-free via no-hold-while-waiting.
- **`Chunk { id: string; files: readonly string[]; description }`** — each work unit declares its file scope up front. (v1 wrote `files: string[]`; actual is `readonly`.)

### From SU-locks (`9ebb499a`)

- **Per-session identity** via the `Mcp-Session-Id` header with a `?client=` fallback — this is already L1's core mechanism.
- **The `workspace_id` column** is real and pervasive in the SU-locks schema. v2 §13 owns its rename to `coordination_domain`.

### From the proposals / SPEC / scoper pipeline

- **`SPEC.md` is the canonical project plan**, DB-backed in `harness_project_files.spec` (PG canonical, disk mirrored). The scoper reads it to generate the work queue.
- **`POST /:slug/features/import`** — the bulk feature-creation endpoint the scoper already POSTs to on `MODE=initial`/`replan`; `INSERT … ON CONFLICT DO UPDATE` by `feature_id`.
- **`PUT /:slug/spec`** — the SPEC.md write endpoint.

§11 builds the on-ramp entirely on these three; it adds no new endpoints.

## §4 L1 — identity & presence

### §4.1 Identity

```typescript
// libs/papercusp/packages/coordination/identity.ts (new)
export interface AgentIdentity {
  /** The stable per-agent id. For a power-user agent this IS the
   *  auth_session_id ("pus-<uuid>") minted at session launch. */
  ownerId: string;
  ownerLabel: string;                 // display, e.g. "omp · pus-1a2b3c4d"
  source: 'power-user-token' | 'omp-hook-session' | 'static-client';
  workspaceId: string | null;         // Papercusp workspace, when known
  userId: string | null;              // human user (power-user acted-as identity)
}
export function resolveAgentIdentity(ctx: ToolContext): AgentIdentity;
```

Identity resolution is **tier-aware** — not the flat fallback chain v1 wrote:

- **Power-user agent** (`?power_user=1`) — `ownerId = ctx.uiClientId`, which the `?power_user=1` route branch sets to the token's `auth_session_id` (verified at `route.ts:225`). That is the canonical agent id; it also reaches the OMP hook as the `PAPERCUSP_AUTH_SESSION_ID` env var. `Mcp-Session-Id` is **not** consulted for power-user identity — it is the MCP transport handshake, not the agent.
- **Engineer / superuser agent** (`?superuser=1`) — no `auth_session_id` exists; identity is the OMP hook's `session_id`, else the `Mcp-Session-Id` header, else the static `?client=<uuid>` install-script machine id.

**Never key coordination on `ctx.runId` or `ctx.spawnId`** — both regenerate on every MCP call (OMP-bundle brief §3).

One resolver, consumed by: the L2 lock code (replacing its ad-hoc header reads), the OMP hook, every `coord:*` tool, and the `plans:*` write verbs (replacing the self-reported `owner_label`).

### §4.2 Presence

Presence has two parts — and the durable part **already exists**; v2 must not rebuild it.

**Durable record — `harness_shared.power_user_sessions` (shipped).** One row per power-user agent for its whole life: `auth_session_id` PK, `workspace_id`, `user_id`, `created_at`, `last_seen_at`, `revoked_at`. The shipped helper `listActivePowerUserSessions(workspaceId)` is the ready-made "who is registered in this workspace" query. This is the agent roster — the coordination layer *reads* it, it does not duplicate it.

**Liveness layer — the genuinely new part.** `power_user_sessions` is not a heartbeat: `last_seen_at` bumps only on token refresh (~hourly) and there is no session-end write (OMP-bundle brief §6). The coordination system needs *live* state — heartbeat, declared `intent`, `current_plan_slug`, `current_files`, held lock ids. Because power-user agents are **always operator-attached** (they hold a token and an MCP URL), this is a thin companion store keyed on `auth_session_id` — added columns on `power_user_sessions`, or a 1:1 table (`coord_presence`) — written by the OMP hook's `session_start` / `turn_start` handlers and cleared on process exit. It is **not** a `coord/agents/` file store: v1's file design duplicated the durable half of `power_user_sessions`.

`coord:presence` joins the two — the `power_user_sessions` row (identity, workspace, not-revoked) plus the liveness row (work state, freshness).

- **Heartbeat**: the OMP `session_start` + `turn_start` hooks write the liveness `heartbeat_at`.
- **Staleness**: `heartbeat_at` older than 10 min → the reader treats the session as dead.
- **`intent`** is the user-facing "what is this agent doing right now" answer — refreshed on session start, on `plans:set-now`, and on lock acquire (the lock's `intent` rolls up).

### §4.3 L1 tool surface (`coord:*`)

```
coord:whoami          → resolved AgentIdentity for the caller (debug aid)
coord:presence        → { active: PresenceRecord[], stale: PresenceRecord[] }
coord:declare-intent  { intent, current_plan_slug?, current_files? } → ok
```

### §4.4 What L1 does not do

No long-term agent identity (sessions are ephemeral; the *user* is identified separately via the power-user token). No live-presence durability — a crash leaves a stale `heartbeat_at`, and readers treat a stale heartbeat as dead (correct — stale liveness is useless); the durable `power_user_sessions` row persists and is reaped by its own `revoked_at`, not by L1. No auth — identity is for *attribution*; authorization stays in the tier system (superuser / power-user / role-gated).

## §5 L2 — synchronous locks (cross-reference)

L2 is **not designed in this plan** — it is the file-locking subsystem, owned by `file-locking-improvements-2026-05-20.md` (SU-locks, committed `9ebb499a`; plus the in-process `FileLockQueue`). v2 states only the seams:

- **L2 consumes L1.** The locks code calls `resolveAgentIdentity(ctx)` for the lock `owner`, instead of its current ad-hoc header reads. This subsumes that plan's item #5 ("acquire echoes resolved owner").
- **L2 feeds L3.** A successful `locks:acquire` emits a `coord` `notify` entry to matching watchers' inboxes (§6.4 #5). The lock is L2; the broadcast it triggers is L3.
- **Shared package.** L1, the L2 shared interface (that plan's #11 `FileClaimCoordinator`), and L3 all live in `libs/papercusp/packages/coordination/` — sub-modules `identity/`, `lock/`, `channel/`.
- **`workspace_id` → `coordination_domain`.** Owned here in v2 §13 (it was orphaned — see §17). Not cosmetic: the column is in a PRIMARY KEY, two GIN indexes, the `grant_cascade` PL/pgSQL function signature, and the `LISTEN/NOTIFY` channel name. No behavior change, but real surface.

## §6 L3 — asynchronous channels

### §6.1 Filesystem layout

All under `coord/` at the **repo root** (`papercup/coord/`). The new tools read/write only these *new* subdirs; the pre-existing flat `coord/*.jsonl` rust-port files are left untouched (resolves the two-schema problem — §3):

```
coord/
  messages/<ownerId>.jsonl       ← L3 messages + acks (per-sender outbox)
  subscriptions/<ownerId>.jsonl  ← L3 watches (per-watcher)
  escalations/<ts>-<id>.json     ← L3 escalation-to-human (per-event file)
  handoffs/<ts>-<id>.json        ← L3 handoff state (per-event file)
  plan-events.jsonl              ← history-viewer feed (single-writer: operator)
  contracts.jsonl                ← cross-cutting contracts (rust-port shared.jsonl analog)
  watermarks/<ownerId>.json      ← per-agent last-read pointers (hook-managed)
```

Per-agent files where the agent is the writer → no contention. Per-event files for low-rate shared streams (escalations, handoffs) → maildir-style atomic-write-by-name. Single-writer files (`plan-events.jsonl`, `contracts.jsonl`) → the one writer is the operator route / append-only.

### §6.2 The typed envelope

Every line the new tools write shares one base shape:

```typescript
interface CoordEnvelope {
  ts: string;              // ISO-8601 UTC
  msg_id: string;          // ULID, unique across coord/
  from: string;            // AgentIdentity.ownerId
  to: string[];            // ["*"] broadcast | ownerIds | ["human"]
  kind: CoordKind;
  summary?: string; body?: string; files?: string[];
  commit?: string;         // head SHA at write time
  plan_slug?: string; related_msg_id?: string;
}
type CoordKind =
  | 'message' | 'ack'
  | 'subscribe' | 'unsubscribe' | 'notify'
  | 'handoff' | 'handoff_accepted'
  | 'escalation' | 'escalation_resolved'
  | 'contract' | 'plan_event';
```

Note: this is the envelope for the **new** coordination files only. It deliberately does *not* claim compatibility with the legacy rust-port `kind`/`action` lines (§3 correction).

### §6.3 Tool surface — all under the verified-free `coord:*` namespace

v1 proposed `messages:*` and `escalations:*`; both are **already-registered namespaces** (`messages:send`, `messages:inbox`, `messages:outbox`, `messages:feature_*`, `escalations:get`). v2 puts the whole new surface under `coord:*`, verified unregistered:

```
coord:send       { to[], summary, body?, plan_slug?, files? }      → { msg_id }
coord:inbox      { since_ts?, kinds?[] }                            → CoordEnvelope[]
coord:ack        { msg_id }                                         → ok
coord:thread     { root_msg_id }                                    → CoordEnvelope[]
coord:watch      { pattern, trigger, ttl_sec? }                     → { msg_id }
coord:unwatch    { msg_id }                                         → ok
coord:watches    { owner? }                                         → SubRecord[]
coord:escalate   { severity, summary, body, options? }              → { msg_id }
coord:escalations{ status?: 'open'|'resolved' }                     → EscalationRecord[]
coord:resolve    { msg_id, choice, note? }                          → ok
coord:handoff    { to[], plan_slug, summary, body, next_action }    → { msg_id }
coord:handoffs   { status? }                                        → HandoffRecord[]
```

Plus L1's `coord:whoami / presence / declare-intent` (§4.3). One namespace, one mental model.

### §6.4 The five primitives

**#5 Subscriptions / watching.** A watcher appends a `subscribe` line (`pattern`, `trigger`, `expires_ts`) to its own `coord/subscriptions/<ownerId>.jsonl`. Notifications fire when `locks:acquire` (L2) or `plans:add-decision`/`add-item` touches a matching path — the firing code appends a `notify` line into the watcher's `coord/messages/` inbox. Cancel = an `unsubscribe` line; readers filter expired/cancelled.

**#6 Messages + acks.** `coord:send` appends a `message` line to the sender's outbox. `coord:inbox` = scan all `coord/messages/*.jsonl`, filter `to.includes(me)`. `coord:ack` appends an `ack` (with `related_msg_id`) to the *acker's own* outbox — so every file has exactly one writer. The ack chain is reconstructed by scanning. Vocabulary intentionally parallels the harness's `messages:feature_send`/`feature_inbox` (features) — different scope (agents), different namespace (`coord:`).

**#7 Cross-plan decision propagation.** `plans:add-decision` gains an optional `affects: string[]` of plan slugs. When non-empty, the route emits a `notify` to watchers of those plans and a `plan_event` so each affected plan's UI sidebar shows the incoming decision. The decision has **one canonical home** (the plan it was made in); other plans *reference* it — never duplicated.

**#8 Handoff state.** `coord:handoff` writes a per-event `coord/handoffs/<ts>-<id>.json` (`from`, `to`, `plan_slug`, `summary`, `body`, `next_action`, `commit`). The receiver's acceptance is a sibling `handoff_accepted` record, or is auto-emitted when the receiver calls `plans:set-now` on that plan. Both the plan's `## Now` block (current state, re-read every turn) and the handoff record (the one-shot transition event) exist — they answer different questions.

**#9 Escalation to human.** `coord:escalate` writes `coord/escalations/<ts>-<id>.json` with `severity` (`blocker|question|advisory`), `summary`, `body`, optional `options[]`, `resolved: null`. The human resolves in the UI (or via `coord:resolve`); the file is updated in place with `resolved: { choice, ts, note }`. The UI surfaces open escalations prominently — this is the channel that earns the right to interrupt.

> **Naming note (audit C2):** Papercusp already has a *harness* escalation concept (`escalations:get`, `harness:escalation` — supervisor escalations). The `coord:escalate` family is **distinct**: agent-to-human within an SU session. The `coord:` prefix keeps them from colliding in the tool catalog; the docs must state the conceptual difference so the two aren't confused.

## §7 Turn-start context injection

The user's question was "can an agent be made to read coord state every turn?" The honest decomposition:

1. **Delivery is enforceable.** A hook prepends a system-reminder before the model's turn; the content is in context. That *is* enforcement of delivery.
2. **Compliance is not.** What the model does with in-context information is downstream prompt discipline — the same as every other model-behavior property.
3. **"All plans every turn" is too coarse.** The right unit is *changed since this agent last read*, via a per-agent watermark.

### §7.1 The injected payload

At turn start the hook assembles a compact reminder — held locks, unread inbox, plans changed since the watermark, subscriptions that fired. It does **not** dump plan bodies; those are one tool call away.

The hook runs inside the OMP process. It has no direct PG access — lock state (held locks) comes from an HTTP call to the operator (`coord:presence` / a locks read), **not** a direct query (v1 said "1 PG query" — corrected). In **detached mode** (§10) the lock section is simply omitted; the reminder degrades to the filesystem-derived parts.

### §7.2 The watermark

`coord/watermarks/<ownerId>.json` holds last-read timestamps per surface (`messages_since_ts`, `escalations_since_ts`, `plan_events_since_ts`, `subscriptions_fired[]`). Written by the hook at turn-end (conservative — an aborted turn re-sees its notifications).

### §7.3 The hook

OMP is the only harness (OMP-only decision), so there is exactly one hook surface — the OMP `turn_start` event from `HookAPI`. It is the **same hook module** that carries the L2 `tool_call` enforcement handler and the L1 `session_start` presence handler: **one module, three handlers** (see §12). Installed into `~/.omp/agent/hooks/` by `install-standalone-mcp.sh` for the engineer path; delivered via the bundle into the session-scratch dir for the power-user path.

### §7.4 Silent-failure surfacing

If injection fails (operator unreachable, etc.) the hook writes a marker the UI can surface — same pattern as the L2 hook fail-open (`file-locking-improvements` #3). Lower stakes than a missed lock (a missed notification is recoverable) but still worth a visible signal.

## §8 The history viewer

A working-memory view of plan progress — shipped now, before durable archival.

### §8.1 The plan-event log

`coord/plan-events.jsonl`, single-writer (the operator's `plans:*` write routes). Each write verb emits one line:

```jsonc
{"ts":"…","msg_id":"…","kind":"plan_event","from":"<ownerId>","to":["*"],
 "plan_slug":"…","event":"created|status_changed|now_updated|decision_added|
  item_added|item_status_changed|promoted|completed",
 "before"?:…, "after"?:…, "detail"?:"…"}
```

`promoted` is the event emitted by `plans:promote` (§11) — the moment a plan enters the harness. ~1 line of code added per existing write verb; strictly additive.

### §8.2 The viewer

A chronological feed (default last 7 days), filterable by plan / event-kind / author / time. Each row is one event; click-through opens the plan at the relevant section. Not an archive, not a search index, not a compliance log — a working-memory view. Rotation when the log grows: monthly files, viewer concatenates the last N.

## §9 UI surface — `/coord`

The v1 audit confirmed there is **no graphical plans UI** in `apps/operator/app/` today (only an API route). **Open question Q-1 stands:** the user has said an interface for viewing plans is being built — if a plan for it exists, this section aligns to it; otherwise v2 ships the first cut.

Proposed: one operator route `/coord`, panels:

- **Active sessions** (L1) — `coord/agents/*.json`, sorted by heartbeat; intent, current plan, held-lock count; stale sessions dimmed.
- **Inbox** (L3, human-facing) — everything with `to.includes("human")`: open escalations most prominent (expand → options → `coord:resolve`), then human-directed messages and handoffs. This is the "things surfaced to the human" surface.
- **Plans** — list + full markdown render; sidebar shows cross-plan incoming decisions.
- **History** — the §8.2 viewer.

Not in v1 of the UI: a subscriptions panel (works via tools), analytics/charts.

## §10 Portability — operator-attached vs detached

- **Attached** (operator on `localhost:3055`): full `coord:*` + `plans:*` + `locks:*` tool surface; turn-start injection reads through tools; `/coord` UI live.
- **Detached** (no operator): the OMP plugin still reads/writes `coord/` directly on the filesystem. Works: reading peers' outboxes, writing own outbox, reading plans, registering subscriptions. Does **not** work: locks (need PG — the L2 hook fails open with a marker), **presence** (now PG-backed — §4.2 — needs the operator), cross-process notify fan-out (needs the operator to scan subscriptions on lock-acquire), the `/coord` UI.
- **Mode detection:** the plugin probes the operator at startup and auto-selects. (v1 named `/api/health`; that route does not exist — the plugin must probe a real endpoint, e.g. an existing harness/status route, or one is added. Tracked as a small open item, Q-5.)
- **Honest caveat:** detached mode means agents can *leave each other notes*; it does not mean they can *prevent stomps*. That needs the operator + PG.

## §11 Plan → harness on-ramp

The piece that connects the SU-agent workflow to the harness: once a human and an SU agent (with expert agents) have formulated a plan, that plan must be able to **enter the harness as features** — and update the canonical spec — without going through the novice proposals flow.

### §11.1 Two independent paths into the harness

Neither gates the other. They are parallel producers.

**Path A — SU-agent path** (human + expert-agent driven, the new path):
1. Human + SU agent (+ expert agents) formulate a plan (`plans:*` doc).
2. The SU agent **creates the features directly** — it authored the plan, it has the breakdown context.
3. The SU agent **updates `SPEC.md` directly** so the canonical north-star spec reflects the new scope.

**Path B — autonomous scoper** (the existing, reframed path):
- The scoper runs autonomously and continuously. Its job: read `SPEC.md`, find **gaps** (criteria with no covering feature), find **bugs**, and generate new features that push toward the north-star vision. It is *not* a gate on Path A — after Path A updates the spec, the scoper simply sees an accurate, current spec on its next cycle and continues.

The novice proposals pipeline (proposal → accept → SPEC.md append → scoper replan) is unchanged and remains the novice path. Path A is the advanced-user equivalent — same destination (features + an updated SPEC.md), different driver.

Why Path A lets the agent do the breakdown rather than routing through the scoper: the authoring agent has the deepest context for *this* plan; the scoper would reconstruct it. The scoper's value is continuous *gap/bug/vision* work, not being a mandatory decomposition checkpoint.

### §11.2 `plans:promote` — the on-ramp verb

One new `plans:*` verb (name verified free). It is the only genuinely new tool §11 needs — everything downstream already exists.

```
plans:promote {
  slug: 'auth-refactor-2026-05-20',
  features: [
    { title, body, acceptance, covers: ['SC-041','SC-042'], from_items?: ['P-001','P-002'], blockedBy?: [<idx>] },
    ...
  ],
  spec_update: {
    base_version: <int>,                 // optimistic-concurrency token (§11.4)
    new_criteria: [ { id?: 'SC-041', text: '...' }, ... ],
    prose_patch?: '...'                   // optional narrative additions
  }
}
→ { features: [{ id: 'F-040', covers: [...] }, ...], spec_version: <int> }
```

`plans:promote` is a `plans:*` **write verb**, so it routes through `withPlanLock` (the shipped acquire-mutate-release helper every write verb uses — plans brief §4.3) and holds the plan-file lock while it marks the promoted items.

Its effects span **four stores and cannot be a single transaction** — the plan must be honest about that. Ordering is chosen so a partial failure degrades safely:

1. **Update `SPEC.md` first** — PUT to `PUT /:slug/spec`, inserting `new_criteria` as `[SC-NNN]`-tagged bullets (§11.3) with provenance markers, under optimistic concurrency (§11.4). A `409` here (a concurrent spec write landed) aborts the whole call having created **nothing** — the caller re-reads `base_version` and retries. Spec-first makes a contention failure clean.
2. **Create features** — POST to `POST /:slug/features/import` (§11.5). Each feature carries `metadata.source_plan`, `metadata.source_items` (the `P-NNN` ids), `metadata.covers = ['SC-NNN', …]`. The endpoint is idempotent (`ON CONFLICT DO UPDATE`), so a retry after a partial failure re-converges instead of duplicating.
3. **Mark the plan** — inside the held `withPlanLock`, flip the promoted `P-NNN` items' status and record their `F-NNN` ids.
4. **Emit a `plan_event`** (`event: promoted`) to `coord/plan-events.jsonl`.

**Partial-failure semantics:** if step 2 fails after step 1 succeeded, `SPEC.md` carries new `[SC-NNN]` criteria with no covering feature — which the autonomous scoper correctly sees as a *gap* and fills. A partial failure degrades to "the scoper finishes the job," not to corruption. That is the reason for spec-first ordering.

Granularity is the agent's call — it supplies the feature list and the criteria; `plans:promote` executes the mapping, it does not auto-split. A plan's items are not 1:1 with features.

### §11.3 feature → SPEC-coverage via `[SC-NNN]` IDs

The scoper's gap analysis must not duplicate a feature Path A already created. The robust link: **every acceptance criterion in `SPEC.md` carries a stable inline ID.**

```
- [SC-041] locks:acquire normalizes every path to repo-relative POSIX before hashing.
```

This is the existing Papercusp house pattern — `F-NNN`, `D-NNN`, `P-NNN` — extended with `SC-NNN` for spec criteria. The spec stays a prose markdown document; only criteria get tagged.

- **The link:** a feature's `metadata.covers` is a list of `SC-NNN` IDs.
- **Gap analysis becomes exact:** `{ SC-IDs present in SPEC.md } − { SC-IDs in any feature's covers }` = the uncovered criteria. A set diff over stable IDs — not fuzzy NLP. This is the cleanest possible form of the autonomous gap-finder.
- **Robust:** rewording a criterion does not break the link; only *deleting* it does — and that *should* surface ("F-040 covers SC-041, which no longer exists").
- **`SC-NNN` allocation** is server-side, in the `PUT /spec` path, same idea as feature-ID allocation (§11.5) — `plans:promote` may omit `id` on `new_criteria` and receive assigned IDs back.

**Implementation caveat to resolve when building:** the scoper's existing `MODE=replan` "delta-merge" already avoids recreating features when `SPEC.md` grows — its dedup must be read to see whether it keys on `feature_id` or on coverage. If id-only, teaching it the `covers` set-diff is part of this work.

### §11.4 SPEC.md concurrency — optimistic, at the DB layer

`SPEC.md` is **already DB-canonical**: `PUT /:slug/spec` → `saveProjectFiles` → the `harness_project_files.spec` TEXT column (PG canonical, disk mirrored temp+rename). So "back SPEC.md with a DB" is already done — no work needed there.

But `saveProjectFiles` is a **blind last-writer-wins overwrite** of the whole `spec` blob (`ON CONFLICT DO UPDATE … COALESCE`, no version column). Two read-modify-write callers → silent lost update. (And note: locking the disk `SPEC.md` file would *not* fix this — the file is a mirror, not canonical. v1's "L2-lock the SPEC.md file" suggestion was wrong and is dropped.)

**Fix: optimistic concurrency on the spec row.** Add a `version` integer to `harness_project_files`. `PUT /spec` accepts the `base_version` the caller read; the UPDATE is conditional `WHERE version = base_version`, increments on success; a mismatch returns `409` and the caller re-reads + retries. DB-native, small, at the canonical layer, no retrofit of other writers required. The `[SC-NNN]` IDs make retries cheap — two agents adding *different* criteria produce non-conflicting diffs.

(Precedent in-tree: migration `007-project-specs.sql` already has a `project_spec_revisions` append-only audit table for the *other* spec concept — the same revision-row pattern is available here if full spec history is wanted later. Out of scope for v1.)

### §11.5 Feature-ID allocation — in the endpoint, not a separate tool

`POST /:slug/features/import` currently *requires* a caller-supplied `id`. v2: when `id` is **omitted**, the endpoint allocates inside its existing transaction and returns the assigned ids. When `id` is **provided**, today's `ON CONFLICT DO UPDATE` is kept (the scoper relies on deterministic re-import).

This beats a separate `features:next-id` allocator, which would have a TOCTOU race (allocate, then someone imports before you). Allocation inside the import transaction has no race. The allocation logic already exists — `doCreateFeature` does "generate or validate the feature id" — so the import endpoint adopts it. No new allocator tool.

### §11.6 Experts — co-authors of Path A, not a third on-ramp

The audit established: an **expert** is a managed, budgeted, multi-round, multi-persona spec-authoring agent (`harness_experts`, `featureSize`, `maxAgents`/`maxRounds` caps, terminal states); a **papercusp-su power agent** is a sovereign external OMP process the user drives. Same idea, two control levels — *employee vs contractor*. Conclusion: **separate runtimes, do not fold** — folding either neuters the expert's accountability or pretends Papercusp controls a process in the user's terminal.

The user's framing — Path A is "driven by direct human and expert agent interaction" — places experts precisely: **experts are co-authors inside Path A.** Human + SU agent + expert agents collaborate to formulate the plan; the SU agent commits it via `plans:promote`. Experts are advisors/co-authors before the on-ramp, not a parallel on-ramp.

One consequence: the dormant **autonomous-expert "writes features directly"** path (`expert-dispatcher.ts`, zero `.role.json` roles registered — built but unused) is the *anomaly* — the one producer that bypasses a shared verb. If it is ever revived, it should emit features through the same `POST /features/import` + coverage-link discipline, not its own path.

### §11.7 What this reuses vs. what is new

**Reused, unchanged:** `POST /:slug/features/import`, `PUT /:slug/spec`, the scoper, the proposals pipeline, the `plans:*` parser.

**New / modified — the entire footprint of §11:**
- `plans:promote` MCP tool (new).
- `POST /features/import` — accept omitted `id` and allocate (small).
- `PUT /spec` + `harness_project_files` — add a `version` column + optimistic-concurrency check (small migration + handler change).
- `SC-NNN` criterion-ID convention + server-side allocation in the `PUT /spec` path.
- The scoper's gap analysis — teach it the `covers` set-diff (size depends on the §11.3 caveat).
- Feature `metadata`: `source_plan`, `source_items`, `covers` (no schema change — `metadata` is already a JSON field on import).

## §12 Cross-plan coordination

### §12.1 With `file-locking-improvements-2026-05-20.md`

- L2 is owned entirely by that plan; v2 consumes its identity input (§5). That plan's #5 ("acquire echoes resolved owner") is subsumed by L1's `resolveAgentIdentity`.
- The **OMP hook is one module, three handlers**: `tool_call` (L2 enforcement — that plan's #2), `session_start` (L1 presence), `turn_start` (L3 injection — §7). That plan builds the `tool_call` handler; v2 adds the other two to the same file.
- The shared package `libs/papercusp/packages/coordination/` (that plan's #11) gains the `identity/` and `channel/` sub-modules alongside `lock/`.
- **`workspace_id` → `coordination_domain`** — v2 §13 owns this (it was orphaned; see §17 S4).

### §12.2 With `omp-power-user-bundle-2026-05-20.md`

- The bundle **delivers the OMP hook** into the power-user session-scratch dir (that plan's §4.3.1). v2 only notes the bundled hook does L1/L2/L3 work — the same one-module-three-handlers file.
- The power-user token's `userId` / `workspaceId` claims populate L1 `AgentIdentity` (§4.1 resolution order, priority 3).
- That plan's own open issues (macOS runtime-dir portability, refresh-token storage, sleep/wake 401 recovery — from the earlier review) are **tracked there, not here** — they do not block v2.
- The OMP-only decision is shared bedrock for both plans.

### §12.3 With `agent-plan-tracking-2026-05-20.md` (shipped)

- No change to the plan format or its filesystem-canonical rule. Additive only: `plan-events.jsonl` emission (§8), `plans:add-decision` gains optional `affects[]` (§6.4 #7), and the new `plans:promote` verb (§11.2).

## §13 Order of work

Six phases; each testable on its own. The on-ramp (Phase E) is independent of L3 and may run in parallel once L1 lands.

- **Phase A — L1 identity & presence** (~1 day; prerequisite for all else). The `coordination/identity.ts` resolver; refactor the L2 lock code to consume it; the `coord_presence` liveness store (companion to the shipped `power_user_sessions`); `coord:whoami/presence/declare-intent`.
- **Phase B — L3 messages + history** (~2 days). `coord/messages/` + `coord:send/inbox/ack/thread`; `coord/plan-events.jsonl` emission bolted onto the `plans:*` write verbs; the `/coord` route with Active-Sessions + Inbox + History panels.
- **Phase C — L3 escalations + handoffs** (~1.5 days). The two per-event stores + `coord:escalate/escalations/resolve` and `coord:handoff/handoffs`; UI Inbox surfacing.
- **Phase D — L3 subscriptions + cross-plan propagation** (~1.5 days). `coord/subscriptions/` + `coord:watch/unwatch/watches`; `locks:acquire` notify fan-out; `plans:add-decision` `affects[]`.
- **Phase E — Plan → harness on-ramp** (~2.5 days). `plans:promote`; `/features/import` id-allocation; `harness_project_files.version` migration + optimistic-concurrency on `PUT /spec`; `SC-NNN` convention + allocation; the scoper `covers` set-diff (size pending the §11.3 caveat).
- **Phase F — turn-start hook + portability** (~1.5 days). The OMP `turn_start` handler (into the shared hook module); watermarks; detached-mode filesystem-direct paths + operator probe.

Total ≈ 10 days. Phases A+B are the high-value core (identity + messages + history). Phase E delivers the on-ramp.

## §14 Decisions

- **D-001** Three layers (L1 identity / L2 locks / L3 channels) + the harness on-ramp as the capstone. One identity primitive, all consumers.
- **D-002** L3 substrate is JSONL + markdown on the filesystem. Portability, grep-ability, human-editability; the rust-port pattern has proven it. PG stays for L2 and future durability.
- **D-003** One typed `CoordEnvelope` for **the new coord files only**. It explicitly does not retrofit the legacy rust-port `kind`/`action` lines (audit S2).
- **D-004** The entire new tool surface is under **`coord:*`** (verified free). `messages:*` / `escalations:*` are already-occupied namespaces (audit C1/C2).
- **D-005** Per-agent files where the agent is the writer; per-event files for low-rate shared streams. No file locking inside L3.
- **D-006** L1 identity is one function (`resolveAgentIdentity`). Replaces the L2 ad-hoc reads and the `plans:*` self-reported `owner_label`.
- **D-007** Turn-start injection enforces *delivery*, not *compliance*. One OMP hook module, three handlers.
- **D-008** History viewer ships in Phase B over `plan-events.jsonl`. Durable archival deferred.
- **D-009** Detached mode (no operator) is a first-class supported configuration for L1+L3; locks degrade with a visible marker.
- **D-010** Two independent paths into the harness (§11.1): the SU-agent path (`plans:promote`) and the autonomous scoper. Neither gates the other.
- **D-011** SPEC.md stays a prose markdown document, already DB-canonical. Structure is added via `[SC-NNN]` inline criterion IDs — not a criteria table (audit-era discussion; full relational spec rejected, §16).
- **D-012** SPEC.md concurrency is solved by optimistic concurrency (a `version` column on `harness_project_files`), not by locking the disk mirror.
- **D-013** Feature-ID (and `SC-NNN`) allocation happens inside the writing endpoint's transaction; no separate allocator tool.
- **D-014** Experts and power agents stay separate runtimes; experts are co-authors within the SU-agent path (§11.6).

## §15 Open questions

- **Q-1** Is a plans-viewing UI already in flight? If so, §9 aligns to it rather than shipping `/coord` fresh. Needs a pointer.
- **Q-2** Sound on `coord:escalate`? Proposal: off by default, user-configurable; badge count always.
- **Q-3** Watermark write timing — turn-end (conservative, proposed) vs turn-start (simpler). Confirm.
- **Q-4** `plan-events.jsonl` retention window before monthly rotation — proposal 30 days.
- **Q-5** The operator-probe endpoint for detached-mode detection — `/api/health` does not exist (audit G2); pick an existing route or add one.
- **Q-6** Standard-interface question: does the operator/novice path also adopt `plans:*` plan docs, or keep filing proposals only? v2 does not require a change either way — both converge at the harness — but it decides whether `plans:*` becomes a shared surface.
- **Q-7** The scoper `MODE=replan` dedup mechanism (§11.3 caveat) — must be read before Phase E is sized; if it keys on `feature_id` only, the `covers` set-diff is net-new scoper work.
- **Q-8** Phase ordering — A→B→C→D→E→F is dependency order, but E (the on-ramp) could be pulled earlier if it is the priority. Confirm.

## §16 Rejected alternatives

- **L3 in Postgres.** Rejected — portability needs filesystem reads; broadcast needs no atomic acquire; the rust-port pattern already works.
- **Funnel the SU path through the proposals pipeline** (so the scoper does the breakdown). Considered and rejected: it would make the scoper a *gate* on the SU path, when the user wants it as a *parallel autonomous co-worker*. The SU agent authored the plan; it does the breakdown.
- **Relational SPEC.md** (one row per criterion, spec rendered from rows). Rejected — high cost (rewrites scoper parsing, the proposal-accept handler, the UI editor; lossy migration of every freeform spec), and a spec is fundamentally a prose document (north-star narrative + rationale). `[SC-NNN]` IDs give the structural benefit where it is needed without destructuring the prose.
- **A separate `features:next-id` tool.** Rejected — TOCTOU race; endpoint-side allocation has none.
- **Folding experts and power agents into one runtime.** Rejected — different control models (managed/budgeted vs sovereign/external).
- **Reusing `messages:*` / `escalations:*` namespaces.** Rejected — already registered; `coord:*` is clean.
- **`harness_shared.spawns` reuse for SU agents.** v1 cited this; the audit could not confirm that table exists in the SQL (G1). Regardless, `harness_shared` is harness-pipeline scope, not SU scope — kept separate.

## §17 Audit corrections carried in from v1

The v1 codebase audit (`agent-coordination-architecture-2026-05-20.md`) found these; v2 resolves each:

- **C1** `messages:send`/`inbox` already registered → entire surface moved to `coord:*` (D-004, §6.3).
- **C2** `escalations:get` already registered + "escalation" is an existing harness concept → `coord:escalate` family, with an explicit distinctness note (§6.4 #9).
- **S1** Rust-port `kind` taxonomy mis-stated → §3 corrected: `ack`/`handoff` are existing kinds; `checkpoint`/`claim` are `action` values in a different dir.
- **S2** Two coord dirs, different schemas → D-003: the typed envelope governs new files only; new subdirs coexist with legacy flat files (§6.1).
- **S3** Citation to a non-existent "file-locking D-008(c)" → removed; the rename is owned here (§5, §13).
- **S4** `coordination_domain` rename was orphaned + called "cosmetic" → owned in §13 with its real footprint (PK, GIN indexes, `grant_cascade`, NOTIFY channel).
- **S5** "`plans:*` write verbs are anonymous" → corrected: they carry a *self-reported* `owner_label`; L1 replaces it with a resolved identity (§3, §4.1).
- **S6** Nine residual `cc:` (Claude Code) identifiers → v2 is uniformly `omp:`.
- **G1** `harness_shared.spawns` unverified → §16 softened; no longer asserted.
- **G2** `/api/health` does not exist → Q-5.
- **G3** "1 PG query" from the turn-start hook → corrected: the hook is in-process to OMP, has no PG access; lock state comes via an operator HTTP call, omitted in detached mode (§7.1).
- **G4** No graphical plans UI exists → Q-1 stands.
- **M1–M4** `Chunk.files` is `readonly`; `plans:lint` exists; `agents:list` exists; coord total is ~454 KB not ~150 KB — all corrected inline (§3).

## §18 Corrections from the agent briefs (2026-05-20)

After v2 was first written, two operational briefs landed — `omp-power-user-bundle-brief-2026-05-20.md` and `plans-system-brief-2026-05-20.md`. Each claim in them was verified against code; the corrections folded in:

- **B-1 — tier-aware identity (§4.1).** A power-user agent's id is `auth_session_id`, surfaced as `ctx.uiClientId` (verified `route.ts:225`); `Mcp-Session-Id` is *not* its identity. v1's flat 4-step resolution chain is replaced by a per-tier rule. Added the "never key on `runId`/`spawnId`" rule.
- **B-2 — presence reuses an existing table (§4.2, §2 diagram, §10, §13).** The shipped `harness_shared.power_user_sessions` is the durable agent record; v2 no longer invents a `coord/agents/` file store (it duplicated that table). Only a thin liveness layer is new. Detached mode loses presence (it is PG-backed) — §10 updated.
- **B-3 — `plans:promote` honesty (§11.2).** It now routes through `withPlanLock` and the plan states plainly that its effects span four stores and cannot be atomic — spec-first ordering with a defined partial-failure degradation.
- **B-4 — plan status (`draft`).** `proposed` is not in the parser's `PLAN_STATUSES` enum (`draft | active | shipped | superseded`, `parser.ts:22`); v2's frontmatter is now `draft`.

---

End of plan v2. Ready for review.
