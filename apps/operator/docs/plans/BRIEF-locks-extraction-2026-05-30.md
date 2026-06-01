---
title: Brief — @papercusp/locks (P-010)
slug: BRIEF-locks-extraction-2026-05-30
status: shipped
created: 2026-05-30
owner: avi@storewolf.com
companion-to: [papercusp-systems-abstraction-2026-05-29, BRIEF-RECIPE-shared-2026-05-30]
updated: 2026-06-01
---

# Brief: `@papercusp/locks` (P-010)

Read **`BRIEF-RECIPE-shared-2026-05-30.md`** first (skeleton, seams,
verify, commit discipline). This brief is the locks-specific audit.

**Plan item:** P-010 (`todo`). Source: `apps/operator/lib/agent-tools/locks/`
(~2364 LOC). Prior design notes already exist in-tree:
`locks/PHASE-STATUS.md` + `locks/README.md` — **read both first.**

## The shape (verified)

The SU agent file-lock coordinator. It runs its **own side database**
`papercusp_su` (lazily bootstrapped, own migration runner, own pools:
txPool=10 + listenerPool=20), and serializes via
`pg_advisory_xact_lock(101, …)` inside an `inWorkspaceTxn` wrapper. It
**already implements `@papercusp/file-claim`** (a shipped interface
package) via the `SuLocksCoordinator` class. So this extraction is "move
the implementation behind the interface it already satisfies", not a
redesign.

### Files: core (extract) vs wrappers (stay)

- **Core → `@papercusp/locks`:** `coordinator.ts` (`SuLocksCoordinator`),
  `su-lock-store.ts`, `in-workspace-txn.ts`, `path-normalize.ts`,
  `workspace-listener.ts`, `queue.ts`'s engine logic, and `sql/`
  (the `papercusp_su` migrations).
- **Wrappers → STAY in operator:** `acquire.ts`, `release.ts`,
  `heartbeat.ts`, `cancel_wait.ts`, `queue.ts` (the `defineTool` parts).
  These import `defineTool` from `@papercusp/agent-mcp` (does not move),
  read identity from `ctx`, and call the core. Leave them thin.

### Seams (per the plan, D-010 — locks CANNOT take a shared tx)

The handoff is explicit: **do NOT inject a shared transaction handle.**
Locks keeps its own DB + pool + advisory lock — that isolation is the
point. The seams are narrow:

1. **`coordinationDomain: string`** — already the parameter shape
   (`inWorkspaceTxn(coordinationDomain, ownerId, fn)`,
   `ch_coord_${coordinationDomain}` LISTEN channel). The caller passes an
   opaque string; the package never derives it from a workspace/harness
   noun. This is already true in the code — preserve it.
2. **SU-DB URL resolution.** Core resolves the `papercusp_su` connection
   via `@/lib/embedded-pg-discovery`. Inject this as a seam
   (`getSuDbUrl: () => string` or depend on the package
   `@papercusp/embedded-pg-discovery` and pass the operator's discovery
   config). Pick the lower-coupling option (a `() => url` seam).

### ⚠️ Cross-dependency with coordination (P-011/P-012) — COORDINATE

Locks imports from the **coordination** lib (a sibling extraction another
agent owns):
- `locks/identity.ts` → `import … from '../coordination/identity'`
  (the `{ ownerId, ownerLabel, coordinationDomain }` extraction from ctx).
- `locks/acquire.ts` → `import { fireNotificationsForCaller } from
  '../coordination/subscriptions'`.

Decisions to make WITH the coordination agent (use `coord:send`):
- **identity**: `readIdentity(ctx)` is operator/ctx glue — it reads the
  agent principal off `UnifiedToolContext`. Keep it **operator-side**
  (it's not part of either pure lib); both lib wrappers call it. The
  PACKAGE core should receive already-resolved `ownerId` +
  `coordinationDomain` strings, never `ctx`.
- **subscriptions / `fireNotificationsForCaller`**: a coordination
  notification side-effect that locks fires on acquire. Inject it into the
  core as an **optional callback seam** (`onAcquired?: (…) => void`), wired
  by the operator wrapper to coordination's `fireNotificationsForCaller`.
  Don't make `@papercusp/locks` depend on `@papercusp/coordination`.

So both `identity` and `subscriptions` stay operator-side; neither pure
lib imports the other. Confirm this split with the coordination agent
before either of you deletes/moves those files.

## Operator side after extraction

`lib/agent-tools/locks/` keeps the `defineTool` wrappers +
`identity.ts` glue + a `configure`/adapter that injects the SU-DB-URL seam
and the `onAcquired` callback. The wrappers call `SuLocksCoordinator` from
`@papercusp/locks`. The 5 `@papercusp/agent-mcp` importers (the verbs)
stay registered via `lib/agent-tools/index.ts`.

## Verify

- Package tsc + its own `__tests__` (move the unit-testable ones; the
  live-PG ones may stay operator-side).
- Live dispatch: `mcp__papercusp-su__locks_acquire` / `locks_release` /
  `locks_queue` / `locks_heartbeat` against the running operator — acquire
  a throwaway path, see it in `locks:queue`, release it. The lock system
  is load-bearing for all SU agents (including you) — verify carefully and
  don't leave a wedged lock.
- Watch the `pg_advisory_xact_lock` namespacing + the `lock_timeout`/
  `statement_timeout` settings survive the move (they're audit-hardened).

Flip **P-010 → done**, `plans:lint`, `coord:send`.
