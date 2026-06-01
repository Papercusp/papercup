---
title: Brief — @papercusp/coordination (P-011 / P-012)
slug: BRIEF-coordination-extraction-2026-05-30
status: shipped
created: 2026-05-30
owner: avi@storewolf.com
companion-to: [papercusp-systems-abstraction-2026-05-29, BRIEF-RECIPE-shared-2026-05-30]
updated: 2026-06-01
---

# Brief: `@papercusp/coordination` (P-011 / P-012)

Read **`BRIEF-RECIPE-shared-2026-05-30.md`** first. This is the
coordination-specific audit.

**Plan items:** P-012 (`todo`, **do FIRST**) → P-011 (`todo`).
Source: `apps/operator/lib/agent-tools/coordination/` (~1735 LOC):
`envelope, escalations, handoffs, identity, messages, paths, plan-events,
presence, promote, roles, subscriptions, watermarks` + `tools/` +
`__tests__`. External coupling (small): `@restart/db-org`,
`@/lib/ensure-schema`.

## P-012 FIRST — make the event log append-only

The design (D-009) wants the coordination event log to be **append-only**
so it can have a pure fs-or-PG backend. Today `escalations.resolveEscalation`
does an **in-place row mutation** (the one non-append write). Before
splitting, migrate it: instead of mutating the escalation row, **append an
`escalation_resolved` event**; readers fold the events to derive current
state. Land this as P-012, verify, commit — THEN do the split. (This keeps
the split mechanical instead of entangling a behavior change.)

## P-011 — split into THREE pieces (NOT one package)

Per D-010, these are three separable concerns with different storage
shapes — extract them as distinct modules/packages, not one blob:

1. **`coord-core` (pure)** — the envelope/message types, identity-free
   merge/fold logic, path helpers (`envelope.ts`, `paths.ts`, the pure
   parts of `messages/handoffs/plan-events/roles/promote/watermarks`).
   No DB, no fs. Unit-testable in isolation.
2. **`CoordEventLog`** — the durable event stream. **fs-backed by default,
   optional PG backend** — this is the *only* swappable storage seam.
   Define an interface (`append(event)`, `read(since)`, …) with an fs impl
   and a PG impl; the host picks. This is where the append-only events
   from messages/handoffs/plan-events/escalations/subscriptions/watermarks
   land.
3. **`PresenceStore` (PG, separate)** — `presence.ts`. Live agent presence
   is PG-only (ephemeral, queried fresh); keep it a distinct store, not
   part of the event log.

The exact package boundary (one package with three sub-modules, vs three
packages) is **D-000-adjacent / your call with the user** — the plan's
D-002 bundling question is unresolved. Default: **one `@papercusp/coordination`
package exporting the three as separate entry modules**, unless the user
says otherwise. Don't block on it.

## Seams

- DB access is `@restart/db-org` (`getOrgPg().sql`) + `@/lib/ensure-schema`.
  Inject the PG handle the same way backup did: a `getSql()` seam (see
  `packages/backup/src/config.ts` for the exact pattern), and an
  `ensureSchema()` seam. Pure `coord-core` takes neither.
- `identity.ts` (the `{ ownerId, ownerLabel, coordinationDomain }`
  extraction from `UnifiedToolContext`) is **operator/ctx glue — keep it
  operator-side.** The pure core receives resolved strings, never `ctx`.

## ⚠️ Cross-dependency with locks (P-010) — COORDINATE

The **locks** lib (another agent) imports `coordination/identity` and
`coordination/subscriptions` (`fireNotificationsForCaller`). Agreement
reached in the locks brief: **both `identity` and `subscriptions` stay
operator-side**; neither pure lib imports the other. So:
- Don't move `identity.ts` into the pure package — leave it in
  `lib/agent-tools/coordination/` (or `lib/agent-tools/` shared) as
  operator glue.
- `subscriptions.ts` / `fireNotificationsForCaller`: locks fires it as a
  callback. Keep it operator-side and let the operator wire it into both
  the coordination verbs and the locks `onAcquired` seam.
Confirm with the locks agent via `coord:send` before moving either file.

## defineTool wrappers

The `coord:*` verbs in `coordination/tools/` (and any `defineTool` files)
**stay in the operator** — extract the engine (core + event log +
presence store), leave the verb wrappers thin, keep them registered via
`lib/agent-tools/index.ts`.

## Verify

- Pure `coord-core`: unit tests (move the relevant `__tests__`).
- Live dispatch: `mcp__papercusp-su__coord_send` / `coord_inbox` /
  `coord_presence` / `coord_handoff` / `coord_escalate` /
  `coord_plan-events` against the running operator — send a message to
  yourself, read it back; declare presence, read it; for P-012, resolve a
  throwaway escalation and confirm the append-only fold yields the right
  state. **You depend on coord yourself** — don't break your own comms.
- Operator tsc: zero NEW errors in your area.

Flip **P-012 then P-011 → done**, `plans:lint`, `coord:send`.
