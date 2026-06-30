# Agent-activity truth: a claim is not progress — who's-doing-what is a LIVE derived signal
URL: /internal/docs/agent-insights/agent-activity-truth

The durable fix for 'agents are wrong about what other agents are doing'. A claim is a RESERVATION and a heartbeat proves the PROCESS is alive — NEITHER proves the WORK is advancing, and a coord broadcast outlives the work. The incident: a gate-fix bee DIED but its 'spawned for X' broadcast was read as 'actively worked' by the Queen + idle agents + the coordinator for ~1h, so the reds sat owned-but-unworked and blocked every deploy. The fix: a third signal (last_progress_at) + a reconciled fleet_assignment view (orphaned = dead holder, stalled = live-but-not-progressing) + the whoIsDoingWhat resolver + a flag-gated reconciler that auto-frees dead/stalled claims + immediate spawn-death release + the stalled-claim watchdog. Read the live signal, never the announcement.

## The incident (2026-06-21)

The Queen spawned a bee to fix two green-gate reds. The bee **died** seconds after
spawn (`fleet:assignments` for it → 0 agents / 0 claims). But every reader — the
Queen's placement, idle su agents, and the coordinator itself — kept reading the
Queen's "**bee spawned for these reds**" coord broadcast as "being actively
worked." So the gate sat **RED and unowned for \~1 hour**, blocking ALL deploys. No
one picked up the reds because everyone believed they were covered.

Same class as the orphaned **WI-291** (live lease, dead holder), **EI-2311**
(re-dispatch-of-dead-holder doesn't check already-resolved), and the loop that
re-assigned items to dead holders.

## Root cause: a claim is not progress, and an announcement outlives the work

"What others are doing" was answered from **stale announcements + claims that are
never reconciled against (a) the holder's liveness and (b) actual PROGRESS**.

* A **claim** (`taken_by`) is a RESERVATION.
* A **presence/nursery heartbeat** proves the PROCESS is alive.
* A **coord broadcast** ("spawned for X") has **no expiry** — it outlives the
  claim, the work, even the agent.

None of these proves the WORK is advancing. The missing third signal was
**last\_progress\_at** — a timestamp bumped only on REAL item-scoped work.

## The fix — one reconciled truth every reader derives from

1. **The progress signal** (`last_progress_at` on `harness_features_consolidated`,
   migration 357). Bumped ONLY on genuine item-scoped work — a `setWorkItemState`
   transition (the bump is folded into its UPDATE) or a `checkpoint` write
   (`markFeatureProgress`). NEVER on a bare presence heartbeat or a lease keepalive
   (`work_item_claims.last_activity_ts` already conflates those — this column stays
   clean).

2. **The classifier** (`item-activity.ts` `classifyItemActivity`) — a pure leaf
   deriving `free | reserved | alive | progressing | stalled | dead` from
   `(taken_by, taken_at, last_progress_at, holderAlive)`. **"Actively worked" ≡
   `progressing` only** (a live holder making real progress in the window).

3. **The reconciled read** (migration 358) — the `work_items` view projects
   `last_progress_at`, and `fleet_assignment` gains a **`stalled`** column
   (live lease, ALIVE holder, no progress in the 10-min window) ALONGSIDE the
   existing **`orphaned`** (live lease, DEAD holder). Both mean **NOT covered** and
   **reclaimable**; they're mutually exclusive. The SQL window mirrors `STALE_MS`
   so the view and the classifier can't drift.

4. **The single resolver** (`fleet/assignments.ts` `whoIsDoingWhat(workItemId)`)
   — the one per-item truth: is it actively worked, by whom, and is it reclaimable?
   `fleet:assignments` surfaces both `orphaned` and `stalled` lists + per-claim
   `activity`; `deriveActivity` projects the label from the view's booleans.

5. **The reconciler** (`reclaimStaleWorkItemClaims`) — frees + requeues a claim
   whose holder is **DEAD** (past grace), **a CONFIRMED-terminal spawn** (immediate,
   NO grace — spawn-death → release, the direct cure for the incident's lag), or
   **STALLED** (alive but not progressing — **flag-gated** behind `RECLAIM_STALLED`,
   default OFF, because it frees a live agent's claim).

6. **The recurrence guard** — the `stalled-claim` watchdog collector fires a loud
   aggregate signal when a live holder sits on a non-progressing claim, so stalled
   work is visible even while the reconciler's stalled leg is dark. Plus the
   `item-activity` + reconciler integration tests.

## What this means for you (the behavioural half)

* To answer "**is X being worked / who's on plan P / what is agent Y doing**", READ
  THE LIVE RECONCILED STATE via **`fleet:assignments`** (or `whoIsDoingWhat`). Do
  NOT re-derive coverage from a `coord:inbox` message or something you remember.
* `orphaned` (dead holder) and `stalled` (live holder, no progress) both mean
  **pickable**. A claim by a dead-or-stalled holder is yours to take — the
  reconciler frees it, and you should treat it as free even before it does.
* Keep YOUR work legible the same way: set work-item state / checkpoint as you go
  so your `last_progress_at` advances and peers reading the live signal see the
  truth. Don't rely on a one-time broadcast to keep a lane "owned."

The durable fix makes the QUERY truthful so you needn't hand-verify; the prompt
clause (`AGENT_ACTIVITY_TRUTH_NOTE`, shared across every role) reinforces "trust
the live signal, not the announcement."

## The corollary: a HANDOFF is not a pickup, and `woken:0` is a miss (2026-06-26)

The same class re-surfaced from the OTHER direction — not "I read a stale broadcast"
but "I made a stale read and then handed work to a ghost." An interactive `su`
session needed a `:3070` deploy driven. It read the fleet ONCE at session start,
saw `su-559a4885` `alive:true` with intent "hardening the gate," and then **carried
that snapshot \~13h** while asserting "they're actively on it." By the time it
`coord:send`'d the deploy to that agent, the agent had **ended hours earlier**. The
send used `wake:'optimistic'` and came back `woken:0` — which was read as "fine, a
backstop will get it." There was no backstop. The deploy was queued for a ghost.

Two failures, both avoidable with signals that ALREADY existed:

1. **Declared intent ≠ progress, and a snapshot decays.** `coord:presence` already
   exposes `lastActiveSecAgo`, `sessionState` (live | parked | **ended**), and
   `intentStale` right next to `intent`; `fleet:assignments` carries `holderAlive`
   next to `holderIntent`. Re-READ the live signal at the moment you rely on it — a
   13h-old "alive" is not "alive now." `fleet:assignments { agent }` returning **0
   rows** is the loudest possible "not on it."

2. **`woken:0` is a MISS, not a note — and `optimistic` hides it on purpose.**
   `coord:send` is honest by mode: `wake:'required'` escalates a miss to
   `recipient_absent` / `recipient_dead` with a loud note; a plain inject reports
   `notWoken`. But **`wake:'optimistic'` is SILENT on a miss by design** (it assumes
   a durable backstop re-dispatches) — it still returns `woken:0`, but no escalation.
   So `optimistic` is ONLY safe when something (the Queen survey, a sweep) will
   re-dispatch. For a one-off transfer to a specific agent it is the WRONG mode.

### Use the right tool for a transfer

A work/ownership **transfer** (you're done; a named agent picks up) is `coord:handoff`,
not `coord:send`. Handoff has the **lifecycle** a message lacks: an `open → accepted |
expired | repinged` state, an accept→wake-back loop, a reconcile sweep that auto-re-pings
at \~30m and expires at \~12h, and (like `wake:'required'`) a loud `recipient_absent` when
it wakes nobody. `coord:send` is for messages; it has no pickup lifecycle. If you DO use
`coord:send` to hand off, use `wake:'required'` and confirm `woken ≥ 1` — never
`optimistic` to a ghost.

### The forcing functions (so it can't just be ignored next time)

Guidance alone failed once (the signals existed and were rationalized away), so the
miss is now structurally hard to swallow:

* **FF#1 — `optimistic` silence must be CLAIMED.** `coord:send wake:'optimistic'` is
  silent-on-miss ONLY when you pass `backstop:'<what re-dispatches>'`. WITHOUT a
  declared backstop, an optimistic miss is reported as loudly as a required miss
  (`recipient_absent`). You can no longer silently hand work to a dead agent by
  reaching for the quiet mode.
* **FF#2 — a handoff is PENDING, not done.** `coord:handoff` open returns
  `accepted:false` / `pending_acceptance:true`, classifies dead recipients
  (`recipient_dead`), and is closed only by an acceptance (or the \~30m re-ping / 12h
  expiry sweep). A successful OPEN is never a successful TRANSFER.
* **FF#3 — the fresh liveness is forced into the result.** On any miss, both tools
  attach `recipient_liveness: [{ ownerId, sessionState, wakeable }]` — the missed
  addressee's CURRENT state, freshly read at the transfer moment
  (`recipient-liveness.ts` → `fetchWakeability`/`deriveSessionState`). A transfer to a
  long-ended agent reads `sessionState:'ended'` right in the answer, not a silent
  `woken:0`.

Rule of thumb: **after any handoff/wake, look at the count.** `woken ≥ 1` = a live
session was re-invoked. `woken:0` / `recipient_absent` / `recipient_dead` /
`recipient_liveness:[…ended]` = MISSED → re-dispatch to a LIVE agent
(`coord:presence → wakeable:true`) or respawn the owner. "I handed it off" only counts
if a live owner received it.
