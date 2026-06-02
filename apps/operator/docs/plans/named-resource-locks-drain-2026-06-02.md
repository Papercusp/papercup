---
title: Named resource locks with drain semantics
slug: named-resource-locks-drain-2026-06-02
status: draft
created: 2026-06-02
updated: 2026-06-02
owner: aviynw@gmail.com
---

# Named resource locks with drain semantics

## Now

**State:** Design captured from an interactive session (2026-06-02). No code written. The model (shared/exclusive named-resource locks), the per-resource enforcement dial, and the writer-priority drain protocol are settled; the three gotchas (drain timeout, no lock-upgrade, zombie safety) are recorded as decisions.

**Next:** human reviews the design + scope (P-023) — in particular whether to build the drain lock alone or also fold the "agent asks a question and waits" feature onto the same request/await/notify backbone (D-008) — before any implementation starts.

## Background

The repo runs **one shared checkout on `main`** with many concurrent agents (claude/codex/omp + paperclip + the harness fleet). File edits are already coordinated by `locks:*` (a `PreToolUse` hook claims a per-file exclusive lock and blocks a conflicting edit; it fails open). But **destructive *shared-resource* actions have no coordination at all**: restarting the `:3070` Hono host (no hot-reload, so restarts are frequent), running a schema migration, freeing a port. Today the convention is "just do it" — fine most of the time, disruptive when a peer is mid-use of the thing you just restarted.

The user's framing: a lock that is **as loose as a prompt or as strict as a file lock**, dialable per resource. You register a named lock (e.g. `dev-server`); agents are instructed to acquire it (mode `shared`) before relying on the resource; an agent that needs to restart it acquires `exclusive`, which **drains** the shared holders before proceeding, then **broadcasts** when the resource is back.

This is a classic **writer-priority readers-writer lock with a drain phase** (the same shape as graceful shutdown / connection draining). It is an **extension of the existing `locks:*` model**, not a new subsystem (D-001). The drain protocol's request → await → notify backbone is also the substrate the separate "agent is unsure → ask a question → wait for an answer" feature would reuse (D-008).

Related: `agent-coordination-architecture-2026-05-20` (the coord/locks architecture this extends), `self-contained-migration-baseline-2026-06-02` (the migrations-only / no-runtime-DDL rule this must follow), and the storage policy (`/internal/docs/system/storage-policy`).

## Goals

- A **named logical lock** (a resource, not a file path) with two modes: `shared` (I'm using it) and `exclusive` (I need to restart/break it).
- **Writer-priority drain**: a pending `exclusive` stops *new* `shared` acquisitions but lets *in-flight* `shared` holders finish, then grants once they drain to zero.
- A **per-resource enforcement dial** spanning prompt-loose → file-lock-strict.
- **Event-push** notification of drain-start and resource-back, delivered through the existing coord injection hook — never PG polling.
- Reuse the existing wait-queue, heartbeat/TTL, and `fireNotifications` machinery; add the minimum new surface.

## Non-goals

- Hard OS-level prevention of the protected action (you can't stop a process from calling `systemctl restart`). Enforcement is advisory/social for non-hookable actions; hard only where a `PreToolUse` hook can intercept (D-002).
- Cross-machine lock synchronization. Named locks are **workspace-local** coordination state (sync authority `none`, D-007).
- Lock upgrade (shared→exclusive in place) — deliberately excluded (D-004).

## Design

### The model

A lock record gains two axes on top of today's path-keyed exclusive lock:

- **key kind** — `path` (today's file locks) or `resource` (new: a registered name like `dev-server`).
- **mode** — `exclusive` (today's only mode; one holder) or `shared` (new: many concurrent holders).

Today's file edit-lock is exactly `{ kind: 'path', mode: 'exclusive' }` — so this is one unified model with two key kinds, not a parallel system.

### The drain protocol (worked example)

```text
t0   B,C hold SHARED(dev-server) ───────────────┐ (working against :3070)
t1   R: acquire EXCLUSIVE(dev-server) → DRAINING │
       ├─ new SHARED requests → REFUSED 'draining' (D wants in → parks in wait queue)
       └─ broadcast "dev-server draining for restart by R — release when current use done" → B,C
t2   B releases ──┐
t3   C releases ──┴─ shared-count == 0  → drain complete
t4   R granted EXCLUSIVE → runs the restart
t5   R releases → broadcast "dev-server back up" → wait queue (D) resumes → re-acquires SHARED
```

The load-bearing rule is at **t1**: the instant a writer is pending, *new* `shared` acquisitions are refused (`draining`) while *existing* leases keep running. That is both "don't start new things that need this" and "continue the work you're doing that needs this" — and it's what prevents a steady trickle of new readers from starving the writer forever (writer-priority, D-003).

### The enforcement dial (per resource)

A resource's `enforcement` level is stored in its registry row:

```text
advisory  — rule lives only in the prompt + the broadcast; locks:queue shows state.
            Acquire/release are honor-system. Realistic ceiling for dev-server
            (no hookable "I'm using the server" action exists).
checked   — locks:acquire actually returns busy/draining and refuses, so any agent
            that calls it is gated. Nothing forces the call.
enforced  — a PreToolUse hook hard-blocks the protected action, exactly like the
            file edit-lock. Only possible where the action is hookable
            (e.g. "no git commit while a rebase lock is held").
```

This is the user's "in between": same machinery, dial per resource. `dev-server` lands at advisory→checked; a hookable action can reach `enforced`.

### Discovery & rules

Each registry row carries injectable **rule text** ("acquire `shared` before using the dev server; the restarter acquires `exclusive`; release promptly on a drain broadcast"). That text is rendered into agent context (playbook addendum and/or a `locks:list` the agent reads) — this is how the *loose* end of the dial works: the rule is a prompt, compliance is behavioral.

### Reuse map

- **Wait queue** — `locks:acquire { wait: { max_sec } }` already parks a request server-side; the exclusive request waits on drain-to-zero through it.
- **Heartbeat / TTL** — `locks:heartbeat` already keeps a lease alive; a missing heartbeat auto-expires a crashed `shared` holder so it can't block drain (D-005).
- **Broadcast** — `fireNotifications` appends a `notify` envelope to each watcher's inbox via `coordLog` (the same surface as coord messages), which the `PostToolUse` coord-injection hook surfaces mid-turn. This is the drain-start and back-up delivery (D-006).
- **Storage** — the lock store is the `@papercusp/locks` package; the host-tie-in seam stays. New schema is a migration, not runtime DDL (D-007).

## Phase 1 — Lock model & schema

- **P-001** `todo` Extend the `@papercusp/locks` lock model: add a `resource` (named logical lock) key kind alongside file `paths`, and `mode: shared | exclusive`. Today's path locks become `{ kind: 'path', mode: 'exclusive' }` under one model.
- **P-002** `todo` Migration `107-named-resource-locks.sql` — idempotent, NO runtime DDL (per `self-contained-migration-baseline-2026-06-02`): named-lock holder rows (resource, mode, owner_id, lease/heartbeat, drain state) + a resource registry table (name, description, rule text, enforcement level). PG store-of-record; sync authority `none`. blocked-by: P-001
- **P-003** `todo` Seed the registry with the first named locks — `dev-server` and `db-schema` — each with rule text + an enforcement level. blocked-by: P-002

## Phase 2 — Drain state machine

- **P-004** `todo` Writer-priority drain: a pending `exclusive` flips the resource to `draining` — refuse NEW `shared` acquisitions (return `draining`), keep existing `shared` leases live. blocked-by: P-001
- **P-005** `todo` Drain-to-zero grant: grant `exclusive` when the shared-holder count reaches 0, parking the request on the existing server-side wait queue. blocked-by: P-004
- **P-006** `todo` `max_drain_sec` timeout: if drain doesn't complete in time, return a "still held by X, Y" envelope so the requester can force-proceed (with a warning broadcast) or escalate. blocked-by: P-005
- **P-007** `todo` Zombie safety: reuse heartbeat/TTL so a crashed `shared` holder's lease auto-expires and never blocks drain forever. blocked-by: P-004
- **P-008** `todo` No lock upgrade: a requester already holding `shared` must `release` then request `exclusive` (re-queue), avoiding the two-holders-both-upgrading deadlock. Document + guard in the acquire path. blocked-by: P-004

## Phase 3 — Broadcast & resume (event delivery)

- **P-009** `todo` Drain-start broadcast: on entering `draining`, `fireNotifications` to all current `shared` holders + watchers ("draining for restart by X — release when current use done"), delivered via the coord injection hook. blocked-by: P-004
- **P-010** `todo` Release broadcast + resume: on `exclusive` release, broadcast "back up" to the wait queue + watchers so parked agents re-acquire `shared`. Event-push only; never poll. blocked-by: P-005
- **P-011** `todo` Auto-wire lock lifecycle → watch notifications (today the watch notify is hand-fired via `fireNotifications`); fold lock acquire/drain/release into the `coord:watch` trigger set. blocked-by: P-009

## Phase 4 — Tool surface & enforcement dial

- **P-012** `todo` `locks:acquire` schema gains `{ resource, mode, max_drain_sec, reason }` alongside today's `{ paths }` — one verb, two key kinds. blocked-by: P-001
- **P-013** `todo` `locks:queue` shows mode + drain state (holders, draining flag, waiters). blocked-by: P-012
- **P-014** `todo` `locks:list` — read the resource registry (named locks + rule text + enforcement level) for agent discovery. blocked-by: P-003
- **P-015** `todo` Enforcement dial: per-resource level — `advisory` (prompt-only; visibility + broadcast), `checked` (tool refuses on busy/draining), `enforced` (a `PreToolUse` hook hard-blocks where the action is hookable). blocked-by: P-012
- **P-016** `needs-human` Decide `dev-server`'s enforcement level — no hookable "I'm using the server" action exists, so it tops out at `checked`; confirm advisory vs checked. importance: high blocked-by: P-015

## Phase 5 — Rules injection & docs

- **P-017** `todo` Inject named-lock rules into agent context: render the registry's rule text into the SU playbook and/or a `locks:list`-driven discovery so agents know when to acquire/release. blocked-by: P-014
- **P-018** `todo` Docs: extend `/internal/docs/agent-spawning/su-agent-coordination-v3` + agent-policies + the SU playbooks (`prompts/papercusp-su-*.tools.md`) with the named-lock + drain protocol. blocked-by: P-017
- **P-019** `todo` Release reliability: confirm `locks:release { all_mine: true }` (session end) and TTL expiry cover named locks too. blocked-by: P-012

## Phase 6 — Tests & verification

- **P-020** `todo` Vitest for the drain state machine: writer-priority (new readers refused while writer pending), drain-to-zero grant, `max_drain_sec` timeout, zombie-lease expiry. blocked-by: P-005
- **P-021** `todo` Integration test for the broadcast→resume cycle (a `notify` lands in the watcher inbox; a parked waiter re-acquires after release). blocked-by: P-010
- **P-022** `todo` Live verify on the dev box: register `dev-server`, two `psu` sessions hold `shared`, a third requests `exclusive`, observe drain + broadcast + resume end-to-end. blocked-by: P-018, P-021

## Phase 7 — Ship gate

- **P-023** `needs-human` Human sign-off before shipping — review the model, enforcement dial, and drain protocol; confirm scope (drain lock only, or also the "ask a question and wait" feature on the same backbone). importance: urgent

## Decisions

### D-001 — Extend coord:*/locks:*, not a new subsystem
Date: 2026-06-02
Named resource locks are the existing path-lock model with two added axes (key kind `path|resource`, mode `exclusive|shared`). The wait queue, heartbeat/TTL, and `fireNotifications` delivery are reused. A separate subsystem would duplicate all three and split coordination state across two stores.

### D-002 — Enforcement is a per-resource dial
Date: 2026-06-02
Each resource declares `advisory` (prompt + broadcast + visibility, honor-system), `checked` (the tool refuses on busy/draining), or `enforced` (a `PreToolUse` hook hard-blocks the action). The user wanted "as loose as a prompt or as strict as a file lock" — this is that, dialed per resource. `dev-server` has no hookable "I'm using it" action, so its ceiling is `checked`; a hookable action (e.g. commit-during-rebase) can be `enforced`.

### D-003 — Writer-priority drain
Date: 2026-06-02
The moment an `exclusive` request is pending, *new* `shared` acquisitions are refused (`draining`) while *existing* leases run to completion. Without refusing new readers, a steady stream of `shared` acquisitions would starve the writer indefinitely. This rule is simultaneously "don't start new work needing this" and "finish the work you're doing." refs: P-004

### D-004 — No lock upgrade; release-then-request
Date: 2026-06-02
A requester already holding `shared` must `release` and then request `exclusive`, accepting a re-queue. In-place upgrade is a classic deadlock (two holders each waiting for the other to drop its shared lease so it can upgrade). Release-then-request is deadlock-free and simpler. refs: P-008

### D-005 — Zombie + timeout safety
Date: 2026-06-02
A crashed or idle `shared` holder must not block restarts forever. Two backstops: heartbeat-TTL auto-expires a dead lease, and `max_drain_sec` caps the writer's wait — on expiry the requester gets a "still held by X" envelope and chooses force-proceed (with a warning broadcast) or escalate. Without this the resource can deadlock. refs: P-006, P-007

### D-006 — Event-push delivery, never poll
Date: 2026-06-02
Drain-start and resource-back are pushed via `fireNotifications` → `coordLog` → the `PostToolUse` coord-injection hook (the same path coord messages already take). Polling PG as a message channel is forbidden by the storage policy ("DB is not a transport"). refs: P-009, P-010

### D-007 — Schema via migration; PG store-of-record, sync authority none
Date: 2026-06-02
New tables go in migration `107-named-resource-locks.sql` (idempotent, ≥ 107 after the squashed `000-baseline.sql`), never runtime DDL / `ensureXxx()` — per `self-contained-migration-baseline-2026-06-02`. PG is the runtime store-of-record; locks are workspace-local coordination state, so the sync authority is `none` (not synced across machines). refs: P-002

### D-008 — The drain backbone is shared with the "ask a question and wait" feature
Date: 2026-06-02
Both features are request → await → notify over coord: the drain lock is claim-exclusive → drain → broadcast → resume; the question feature is post-question → answer → resume. Building the drain protocol first yields the await/notify substrate the question feature reuses. Whether to build both now is the open scope question. refs: P-023

## Open questions

- **Scope** — build the drain lock alone, or also the "agent is unsure → ask a question → wait for an answer" feature on the same request/await/notify backbone? (→ D-008, P-023)
- **`dev-server` enforcement** — advisory (prompt + broadcast only) or checked (tool refuses)? No hookable action means `enforced` is out. (→ P-016)
- **First resources** — is `dev-server` + `db-schema` the right initial registry, or are there other destructive shared actions to register day one (ports, the Tauri shell, Typesense)?
