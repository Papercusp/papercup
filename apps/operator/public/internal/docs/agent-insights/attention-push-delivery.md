# Attention push-notification delivery (and why retiring the poll is coupled)
URL: /internal/docs/agent-insights/attention-push-delivery

How needs-human / escalation / smoke / plan-review notifications actually get delivered, the mobile-vs-desktop channel gap, and why P-020's event-driven push can't drop the 60s poll for its legacy triggers without P-021.

## What it is

The flip side of [the attention/importance system](/internal/docs/agent-insights/attention-importance-system):
how an attention item that needs a human actually becomes a **push
notification** on the user's devices. This is the part the
`planning-attention-importance-2026-05-31` plan's P-020/P-021/D-007 touch,
and the topology is non-obvious — reverse-engineering it took a session, so
this is the map.

## The two delivery facts that surprise everyone

1. **The only delivery channel today is MOBILE push.**
   `apps/operator/lib/device-push-dispatcher.ts` → `notifyWorkspace(wsId, payload)`
   → APNs/FCM to devices paired in `harness_shared.mobile_push_tokens`. It is
   a **no-op when no device is paired** (safe to call unconditionally).
   There is **no desktop-native (Tauri OS notification) bridge** — D-007's
   "emit an event the desktop turns into a native OS notification via the
   existing Tauri IPC bridge" describes a bridge that does **not exist yet**.
   Building it is Rust/Tauri work and is unverifiable headless.

2. **The legacy triggers are delivered by a 60s POLL, not at the source.**
   `apps/operator/lib/device-intervention-watcher.ts` `setInterval(60s)` does
   three `SELECT`s — `harness_escalations`, `harness_smoke_test (status=fail)`,
   `harness_plan_review` — dedupes via an in-memory `seen` set keyed on
   `(workspace, slug, phase/status, mtime)`, and pushes each new row. It is a
   **robust catch-all**: it fires regardless of which code path wrote the row.

## Where those rows are written (the producer chokepoints)

The fs-watcher mirror for these three tables is **retired** (see the long
comment block in `harness-fs-watcher.ts`). They're now written **at producer
time** by three internal endpoints, called by `bash run.sh` / `bin/supervisor.sh`
/ `bin/service-smoke-test.sh`:

* `POST /api/internal/escalation-event`  → `harness_escalations`
* `POST /api/internal/smoke-test-event`  → `harness_smoke_test`
* `POST /api/internal/plan-review-event` → `harness_plan_review`

So an event-driven emit for these has a clean home (those 3 endpoints) — but
see the coupling gotcha below.

## The importance map (what the ≥high gate includes)

P-020 pushes only at importance **≥ high**. The per-kind importance lives in
`apps/operator/lib/attention/adapters.ts`:

| Kind                   | importance                                                                      |
| ---------------------- | ------------------------------------------------------------------------------- |
| smoke-fail             | `high` (fixed)                                                                  |
| plan-review            | `high` (fixed)                                                                  |
| coord escalation       | `severityToImportance(sev)` — blocker→`urgent`, question→`high`, advisory→`low` |
| coord message-to-human | `normal`                                                                        |
| plan item              | the item's own `importance:` keyword                                            |

Note `harness_escalations` (the table the watcher polls) has **no severity
column** — it's a harness-level escalation, distinct from a *coord* escalation.
Treat it as inherently high. Net: the watcher's three triggers are all already
high, so the watcher never pushed low-importance noise to begin with.

## P-020 was safe to ship; P-021 is the coupled, risky part

**Shipped (P-020, safe, additive):** `plans:set-status` pushes when an item
transitions INTO `needs-human` at importance ≥ high
(`shouldPushNeedsHuman` + `itemImportance` in `set-status.ts`). A plan item is
a source the watcher *never polls*, so there is **no overlap → no double-fire**.
It's transition-gated (a re-set won't re-push), importance-gated, and fully
fail-safe (a push error never fails the flip). With the watcher's already-high
triggers, the full push set is now exactly the ≥high attention items.

**Not shipped (P-021, coupled + risky):** moving the watcher's *own* triggers
(escalation/smoke/plan-review) to producer-time emits at the 3 endpoints
**cannot be done additively** — the poll already pushes them, so adding emits
**double-fires** (duplicate push to the user's phone). Avoiding that requires
**retiring the poll** in the same change, which trades away the catch-all: any
write path not explicitly hooked silently **loses** its notification. The only
upside is latency (≤60s → instant) — no new user-facing notifications. That's
why P-021 is held for a human decision (accept the missed-path tradeoff, or
keep a low-frequency reconcile floor), not done blind.

## If you're the agent picking up P-021 / D-007

* **P-021:** either (a) emit at the 3 endpoints + delete the poll (accept
  missed-path risk — audit every writer of those tables first), or (b) emit at
  the 3 endpoints for low latency + keep a *reduced-frequency* poll as a
  reconcile floor, sharing the dedup so it only catches what emits missed.
* **D-007:** there is no desktop notification bridge. You'd add a Tauri IPC
  command + a JS emit path; `notifyWorkspace` is mobile-only. Decide whether
  desktop-native is worth it or mobile push is sufficient.
* Both need a running desktop to verify delivery — neither is headless-testable.
