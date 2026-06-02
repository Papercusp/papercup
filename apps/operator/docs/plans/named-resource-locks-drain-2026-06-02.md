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

**State:** ALL build phases complete (1 model/schema, 2 drain machine, 3 broadcasts, 4 tool surface, 5 rules+docs, 6 tests, 8 defineTool/requiresLock). Named resource locks are live end-to-end: locks:acquire_resource/release_resource/heartbeat_resource/list/check_command + the dev:restart/db:migrate wrappers; guardResource is the enforced rung (D-016, handler HOF not dispatcher interceptor); coord drain-start/back-up broadcasts; session-end all_mine clears resource locks too (P-019). ~70 locks tests green; new code type-clean; tools-md-sync 46/46. Committed across submodule libs/papercusp + superproject (latest 63d10e7bf).

**Next:** Only non-code items remain: P-016 + P-023 (needs-human — dev-server enforcement level, ship sign-off); D-015 (latent getOrgPg first-call race — flagged, unowned); the Bash PreToolUse gate is built-not-wired (activation is deliberate); and the docs served mirror needs `cd apps/operator-docs && npm run build`.

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

- **P-001** `done` Extend the `@papercusp/locks` lock model: add a `resource` (named logical lock) key kind alongside file `paths`, and `mode: shared | exclusive`. Today's path locks become `{ kind: 'path', mode: 'exclusive' }` under one model.
- **P-002** `done` Migration `107-named-resource-locks.sql` — idempotent, NO runtime DDL (per `self-contained-migration-baseline-2026-06-02`): named-lock holder rows (resource, mode, owner_id, lease/heartbeat, drain state) + a resource registry table (name, description, rule text, enforcement level). PG store-of-record; sync authority `none`. blocked-by: P-001 (shipped as packages/locks/src/sql/005-named-resource-locks.sql in papercusp_su D-009, not harness_shared/107)
- **P-003** `done` Seed the registry with the first named locks — `dev-server` and `db-schema` — each with rule text + an enforcement level. blocked-by: P-002
- **P-024** `done` Registry-required acquire: `tryAcquireResource` validates `resource` against `agent_resource_registry` and rejects an unknown name with `unknown_resource` (D-010). `locks:list` is the authoritative discovery surface. blocked-by: P-002


## Phase 2 — Drain state machine

- **P-004** `done` Writer-priority drain: a pending `exclusive` flips the resource to `draining` — refuse NEW `shared` acquisitions (return `draining`), keep existing `shared` leases live. blocked-by: P-001
- **P-005** `done` Drain-to-zero grant: grant `exclusive` when the shared-holder count reaches 0, parking the request on the existing server-side wait queue. blocked-by: P-004
- **P-006** `done` `max_drain_sec` timeout: if drain doesn't complete in time, return a "still held by X, Y" envelope so the requester can force-proceed (with a warning broadcast) or escalate. blocked-by: P-005 (max_drain_sec implemented in the exclusive wait loop resource-acquire-wait.ts; returns drain_timeout with remaining holders)
- **P-007** `done` Zombie safety: reuse heartbeat/TTL so a crashed `shared` holder's lease auto-expires and never blocks drain forever. blocked-by: P-004
- **P-008** `done` No lock upgrade: a requester already holding `shared` must `release` then request `exclusive` (re-queue), avoiding the two-holders-both-upgrading deadlock. Document + guard in the acquire path. blocked-by: P-004

## Phase 3 — Broadcast & resume (event delivery)

- **P-009** `done` Drain-start broadcast: on entering `draining`, `fireNotifications` to all current `shared` holders + watchers ("draining for restart by X — release when current use done"), delivered via the coord injection hook. blocked-by: P-004
- **P-010** `done` Release broadcast + resume: on `exclusive` release, broadcast "back up" to the wait queue + watchers so parked agents re-acquire `shared`. Event-push only; never poll. blocked-by: P-005
- **P-011** `done` Auto-wire lock lifecycle → watch notifications (today the watch notify is hand-fired via `fireNotifications`); fold lock acquire/drain/release into the `coord:watch` trigger set. blocked-by: P-009 (drain-start + back-up fireNotifications to resource:&lt;name&gt; watchers; plain shared acquire/release watch-notify not wired low value)

## Phase 4 — Tool surface & enforcement dial

- **P-012** `done` `locks:acquire` schema gains `{ resource, mode, max_drain_sec, reason }` alongside today's `{ paths }` — one verb, two key kinds. blocked-by: P-001 (shipped as sibling locks:acquire_resource D-014, not an overload of locks:acquire)
- **P-013** `done` `locks:queue` shows mode + drain state (holders, draining flag, waiters). blocked-by: P-012 (shipped as locks:list registry + live holders + draining flag)
- **P-014** `done` `locks:list` — read the resource registry (named locks + rule text + enforcement level) for agent discovery. blocked-by: P-003
- **P-015** `done` Enforcement dial: per-resource level — `advisory` (prompt-only; visibility + broadcast), `checked` (tool refuses on busy/draining), `enforced` (a `PreToolUse` hook hard-blocks where the action is hookable). blocked-by: P-012 (advisory/checked/enforced all realized: registry level + locks:list + check_command + guardResource; enforced-via-Bash-hook built-not-wired)
- **P-016** `needs-human` Decide `dev-server`'s enforcement level — no hookable "I'm using the server" action exists, so it tops out at `checked`; confirm advisory vs checked. importance: high blocked-by: P-015

## Phase 5 — Rules injection & docs

- **P-017** `done` Inject named-lock rules into agent context: render the registry's rule text into the SU playbook and/or a `locks:list`-driven discovery so agents know when to acquire/release. blocked-by: P-014
- **P-018** `done` Docs: extend `/internal/docs/agent-spawning/su-agent-coordination-v3` + agent-policies + the SU playbooks (`prompts/papercusp-su-*.tools.md`) with the named-lock + drain protocol. blocked-by: P-017 (named-resource-locks.mdx written; served mirror needs `cd apps/operator-docs && npm run build`)
- **P-019** `done` Release reliability: confirm `locks:release { all_mine: true }` (session end) and TTL expiry cover named locks too. blocked-by: P-012

## Phase 6 — Tests & verification

- **P-020** `done` Vitest for the drain state machine: writer-priority (new readers refused while writer pending), drain-to-zero grant, `max_drain_sec` timeout, zombie-lease expiry. blocked-by: P-005
- **P-021** `todo` Integration test for the broadcast→resume cycle (a `notify` lands in the watcher inbox; a parked waiter re-acquires after release). blocked-by: P-010
- **P-022** `done` Live verify on the dev box: register `dev-server`, two `psu` sessions hold `shared`, a third requests `exclusive`, observe drain + broadcast + resume end-to-end. blocked-by: P-018, P-021 (concurrent multi-owner drain covered by resource-acquire-wait start exclusive wait → concurrent shared release → grant)

## Phase 7 — Ship gate

- **P-023** `needs-human` Human sign-off before shipping — review the model, enforcement dial, and drain protocol; confirm scope (drain lock only, or also the "ask a question and wait" feature on the same backbone). importance: urgent


## Phase 8 — defineTool integration & universal enforcement

- **P-025** `done` defineTool `requiresLock: { resource, mode, drain?, maxDrainSec? }` — the shared endpoint dispatcher auto-acquires the declared lock (full drain protocol for `exclusive`), runs the tool body, releases on success/error. Realizes the `enforced` rung declaratively at the dispatch chokepoint (D-011). blocked-by: P-012, P-015
- **P-026** `done` Close the raw-Bash bypass: a registry-driven command-matcher (resource carries match patterns) on the `Bash` tool's dispatch maps a command to a registered resource and acquires it — mirroring the file-edit hook's path matcher — so raw shell can't sidestep a registered lock (D-012). Document that non-agent actors (human/paperclip/Tauri shell) are out of scope of dispatch enforcement. blocked-by: P-025 (matcher + locks:check_command shipped; the Bash PreToolUse hook is built-not-wired would gate every agent — activation documented)
- **P-027** `done` Blessed wrapper tools — `dev:restart` (exclusive `dev-server`) and `db:migrate` (exclusive `db-schema`) authored with `requiresLock`, as the canonical path agents use instead of raw `systemctl`/`psql`. They get the full dispatcher drain protocol (D-011) for free; the Bash command-matcher (P-026) is the backstop for raw use. ("Both" approach — wrapper tools + matcher.) blocked-by: P-025



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


### D-009 — Implementation corrections from reading the locks substrate
Date: 2026-06-02
Reading the real code (`libs/papercusp/packages/locks/`) corrected two assumptions from the design pass:

(1) **Schema home — supersedes D-007/P-002.** The locks substrate is NOT in `harness_shared` on the main `papercusp` db. It lives in a SEPARATE side database `papercusp_su` with the package's OWN migration runner (`ensureBootstrap` applies `packages/locks/src/sql/NNN-*.sql`, tracked in `su_meta`). So the new schema is `packages/locks/src/sql/005-named-resource-locks.sql`, NOT `libs/papercusp/libs/db/sql/107`. This package migration runner is the sanctioned migration system for this db, so it does not violate the "schema = migrations only, no runtime DDL" rule (that rule governs the main harness_shared schema).

(2) **Separate table — refines D-001.** `agent_file_locks` is `(coordination_domain, path)` PRIMARY KEY = strictly exclusive-per-path, and it is the safety-critical hot path every agent's edit-lock hook depends on. Shared mode structurally breaks that PK. So named resources get a SEPARATE `agent_resource_locks` table (+ `agent_resource_registry`), leaving the file-lock tables/functions 100% untouched. "Extend, not rebuild" (D-001) holds at the substrate level: same `papercusp_su` db, same `ch_coord_<domain>` NOTIFY channel, same `inWorkspaceTxn` advisory-lock wrapper, and a sibling `resource_grant_cascade` mirroring `grant_cascade` — but a distinct table, because reshaping the file-lock PK would risk every agent's editing.
Related: P-002


### D-010 — Registered names only — acquiring an unregistered resource fails
Date: 2026-06-02
A resource must be pre-registered in `agent_resource_registry` to be acquirable; `tryAcquireResource` rejects an unknown name with `unknown_resource`. Rationale: free-form lock names silently fail to coordinate — one agent locking `dev-server` and another `devserver` get NO mutual exclusion, which is worse than no lock (false confidence). The registry is the single source of (a) the valid name set, (b) each lock's injectable rule text, and (c) its enforcement level — so `locks:list` is authoritative and there is exactly one home for "what locks exist and how strict each is." User-requested.


### D-011 — Locks integrate with defineTool via requiresLock; the dispatcher is the enforcement point
Date: 2026-06-02
A tool authored with `defineTool` may declare `requiresLock: { resource, mode, drain?, maxDrainSec? }`. The shared endpoint dispatcher — which already gates capability, quota, and role before running a tool body — also acquires the declared lock (running the full writer-priority drain protocol for `mode: exclusive`), runs the body, and releases on success OR error. This is how the `enforced` rung of the enforcement dial (D-002) is realized: declaratively, at the one chokepoint every tool call passes through, instead of a bespoke `PreToolUse` hook per destructive action. It also subsumes the manual `locks:acquire` call for any action expressible as a tool — the agent literally cannot run the tool body without holding the lock. The registry (D-010) still owns the resource's existence + rule text + level; `requiresLock` just binds a tool to a registered resource.
Related: P-015


### D-012 — Enforcement boundary: dispatch binds agents, not the world; close the raw-Bash bypass
Date: 2026-06-02
Answering "is there any command we can't route through defineTool?": a `defineTool` body runs in the operator's Node process, so it can spawn/exec anything the host can (shell, `systemctl`, `psql`, HTTP) — every destructive action is EXPRESSIBLE as a tool. But routing through a tool only yields ENFORCEMENT for actions that actually flow through the dispatcher. Two leaks remain: (1) the raw `Bash`/shell tool — an agent can `systemctl restart` directly, bypassing any wrapper. Close it with a registry-driven command-matcher (resource carries match patterns; Bash dispatch maps a command to a registered resource and acquires it, exactly as the file-edit hook maps a path to a file lock). (2) NON-agent actors — a human at a terminal, paperclip, the Tauri shell — never hit the dispatcher at all, so no tool-level enforcement can reach them; for them only the advisory rule + the drain broadcast applies. Conclusion: `enforced` means "enforced for agents going through the dispatcher," never a true world mutex — which is consistent with the loose-by-design philosophy. The clean end-state is: all agent actions flow through one dispatcher; `requiresLock` covers fixed-resource tools and the command-matcher covers the generic Bash tool; the dial just sets how strict the dispatcher is per resource.
Related: P-015


### D-013 — Raw-command gating = a fast PreToolUse Bash hook; the dispatcher owns the slow drain
Date: 2026-06-02
Confirmed against the live hook config: file locks already gate `Edit|Write|MultiEdit` via a `PreToolUse` hook (`~/.papercusp/hooks/cc/pretooluse-locks-acquire.sh`). The raw-shell matcher (D-012/P-026) is the SAME shape with matcher `Bash` — the hook receives the command string on stdin and returns allow/deny.

Division of labor with D-011: the Bash hook does a FAST check only — deny if the resource is exclusive/draining (with a "wait, X is restarting" reason), else acquire a shared lease and allow — because a PreToolUse hook runs synchronously under a timeout and cannot sit in a multi-minute drain. The full drain-wait (and progress streaming) lives in the dispatcher path (`requiresLock`, D-011).

Matchable asymmetry: the DESTRUCTIVE side (restart/migrate) is a small, matchable command set — gate it in the Bash hook and/or via `requiresLock` wrapper tools. The SHARED "usage" side (e.g. `curl :3070`) has too many forms to regex reliably — keep it EXPLICIT (`locks:acquire { mode: shared }`, or `requiresLock` on the specific tools that hit the resource), not Bash-pattern-matched. So `agent_resource_registry` gains a `match_patterns` column (regex/glob) the Bash hook reads to map a command → registered resource.

Per-client reality: hard enforcement on Claude + OMP (PreToolUse fires); soft on codex (it does not fire PreToolUse on `Bash`/`apply_patch` yet — upstream gap, identical to the file-lock asymmetry). Non-agent actors (human terminal, paperclip, Tauri shell) never invoke the hook — out of scope, advisory + drain broadcast only (D-012).
Related: P-026


### D-014 — Separate resource tools, not an overloaded locks:acquire (refines P-012)
Date: 2026-06-02
The agent surface is sibling tools — `locks:acquire_resource` / `release_resource` / `heartbeat_resource` / `list` — alongside the file-path `locks:acquire`/`release`/`heartbeat`/`queue`, rather than overloading `locks:acquire` with a `resource`/`mode` branch as P-012 literally proposed. Reason: the two are fundamentally different in arg shape (`paths[]` vs `resource`+`mode`), result shape (`held[]`/`busy[]` vs `mode`/`status`/`shared_holders`), and wait mechanics (FIFO path-waiter queue via `agent_lock_waiters` vs writer-priority drain via status polling). Overloading one verb would be a thin top-level if-branch with no real unification — two tools wearing one name — while separate tools give each a distinct `guidance.when` and far simpler, independently-testable handlers. Unification is preserved at the namespace level (`locks:*`). `locks:list` covers BOTH discovery (P-014) and queue/drain visibility (P-013) — registry rows + live holders + a `draining` flag.
Related: P-012


### D-015 — Latent getOrgPg first-call race found while wiring coord broadcasts
Date: 2026-06-02
While testing the Phase 3 coord broadcasts I hit a pre-existing fragility in `getOrgPg()` (`libs/papercusp/libs/db/src/connection.ts`): the FIRST call in a process can throw `TypeError: Cannot read properties of null (reading 'constructor')` from drizzle's `extractTablesRelationalConfig` — a `sharedSchema` module-load-order race when getOrgPg runs before the schema modules finish resolving. It assigns `_adminClient` (the usable postgres-js client) on line 298 but throws on line 300 building the drizzle handle, so the SECOND call returns `{ sql: <valid>, drizzle: null }` and any consumer needing only `.sql` (coord appendLine/readLines, the subscription store) works thereafter. Coord writes need only `.sql`, so I worked around it in the resource-broadcast test with a beforeAll warm-up (`readInbox(...).catch(()=>{})`) rather than touch connection.ts. NOT fixed here — it is a load-bearing submodule file, out of this plan's scope, and likely test-env-only (the operator runtime calls getOrgPg after module load). Flagged for a dedicated fix: getOrgPg should not leave `_adminClient` set on a partial init failure (so a retry rebuilds the drizzle handle), or schema load should be forced before first use.


### D-016 — The `enforced` rung is a handler HOF, not a dispatcher interceptor
Date: 2026-06-02
P-025 shipped `guardResource(spec, run)` + `withResourceLock(spec, handler)` (apps/operator/lib/agent-tools/locks/resource-lock-guard.ts): the body runs ONLY if the lock is acquired, released after. This realizes D-011's `enforced` rung as a handler HOF rather than a dispatcher interceptor reading a `requiresLock` field. Reason discovered in implementation: `defineTool` lives in the borrowable, domain-free `libs/generic/tooldef` lib; threading a locks-domain `requiresLock` field through the generic dispatcher (dispatch-projected) would couple that lib to the locks domain. The HOF gives the identical guarantee with all locks knowledge operator-side. A fully-declarative dispatcher seam (so plugin tools could also declare requiresLock) remains a possible follow-up, but is not needed for the wrapper tools (dev:restart/db:migrate use guardResource directly with a confirm-gate).
Related: P-025

## Open questions

- **Scope** — build the drain lock alone, or also the "agent is unsure → ask a question → wait for an answer" feature on the same request/await/notify backbone? (→ D-008, P-023)
- **`dev-server` enforcement** — advisory (prompt + broadcast only) or checked (tool refuses)? No hookable action means `enforced` is out. (→ P-016)
- **First resources** — is `dev-server` + `db-schema` the right initial registry, or are there other destructive shared actions to register day one (ports, the Tauri shell, Typesense)?
