# p2p-rest — Leader Handoff Brief

**From:** su-4d7a4628-898d-43c7-8f60-3a956480e774 (outgoing p2p-rest leader)
**Date:** 2026-07-10 ~18:45Z
**Context:** Owner (avi) is ending this session and the whole fleet's sessions and asked
for (a) a root-cause on *why the fleet looked paused* and (b) a brief so the next leader
can continue. **Owner directive: do NOT restart the members.** This brief captures the
diagnosis + the durable fixes; it does not mutate live fleet state.

---

## TL;DR — the fleet is NOT paused by any throttle or kill-switch

There is **no** rate-limit pause, **no** governor circuit-breaker, **no** operator pause
sentinel, and **no** down service. The "paused" appearance is two *separate* things
stacked on top of each other:

1. **It LOOKS paused (UI symptom)** — the coordination presence/status layer is
   **degraded/timing out** behind a slow unbounded scan, so the fleet panels render empty
   or stale. Nothing is actually stopped; the read just can't complete.
2. **Work ISN'T actually flowing (substantive)** — the *worker* sessions largely
   **auto-ended** after their plans drained, leaving mostly idle **monitor-loops that
   quiesce by design**. A real backlog (28+ admissible todo items) sits unclaimed because
   few live worker sessions remain to drain it — not because anything blocked them.

A stale claim spec (below) is a **latent trap** that already bit one member, but it is
*not* the current hard cause — `scheduler:get_next` still returns claimable items.

---

## Evidence (verified this session, 18:30–18:45Z)

### Root cause A — coordination reads are degraded (the "looks paused" cause)
- `coord:presence {scope:workspace}` → **timed out at 55s** (still running server-side).
- `fleet:status {p2p-rest}` → **`degraded:true`**, `degradedLegs:[roster.presence,
  roster.assignments,runningBees,beeCount]`, reported `memberCount:0, members:[]` even
  though the fleet has live members. The presence leg failing is what empties the panel.
- `operator:paused` → **transport dropped mid-call** (couldn't complete).
- **Smoking gun** in `dev:pg_active_queries`: a single **ACTIVE** query running **130s**:
  ```
  SELECT body FROM harness_shared.coord_event_log
   WHERE workspace_id = $1 AND surface = $2
   ORDER BY id ASC        -- no LIMIT, no id-cursor → full-scan of the surface's log
  ```
  Plus a pile of connections idle **640–767s** on `LISTEN "sync_invalidate"` /
  `"coord_inbox"`. PG saturation ~44% (203/512 conns) — not maxed, but the unbounded
  `coord_event_log` scan is the latency source. As that log grows, every presence/orient
  read that touches it degrades. **This is a real perf regression, filed as a bug (see
  Fixes).**

### Root cause B — workers auto-ended; survivors are quiescing monitor-loops
- `autoloop_status(papercusp)`: many rows `no-session-now:auto-ended` (worker sessions
  gone) and many live ones `loop-presence-quiescence` (monitor-loops woke, found nothing
  directed, settled — *expected* idle behavior). Live loops fired minutes ago (14:29Z EDT
  timestamps) — they are **alive and firing**, just settling idle.
- `dev:rate_governor_status`: `inFlight:0, effective:8, floor:1, buckets:[]`, opus zone
  `headroom` (util 0). **Nothing is rate-limited.** Zero turns in flight = genuinely idle,
  not throttled.

### Latent trap — stale p2p-rest claim spec (bit su-53a8a earlier)
- `scheduler:get_claim_spec {fleet:p2p-rest}` (and my inherited cup spec) =
  `specId: fleet-launch-p2p-rest-plan`, `view.filter: { plan = "fleet-deltas-leader-primitives-2026-07-10" }`,
  revision 3, updatedBy me, updatedAt 2026-07-10 05:03Z.
- That plan is **fully drained + closed** (11/11 done). A spec filtering to a closed plan
  matches zero of that plan's items. At ~16:18Z su-53a8a reported *"3 consecutive empty
  `scheduler:get_next` wakes (spec matched zero) despite 18+ admissible todo items … likely
  stale claim spec from the closed fleet-deltas plan"* and ended their loop.
- **BUT** my own `scheduler:get_next {harness:papercusp}` this session returned a real
  claimable item (WI-3514) under this same spec — i.e. the engine fell back rather than
  hard-starving. So the stale spec is a **latent/intermittent** trap, not the current hard
  block. It should still be reset so a relaunched fleet can't starve on it.

---

## Recommended durable fixes (for the next leader / owner)

1. **Reset the p2p-rest claim spec off the closed plan** before relaunching any member:
   ```
   scheduler:set_claim_spec { fleet:"p2p-rest", spec: <default oldest-first, no plan filter> }
   ```
   or re-point `view.filter.plan` to whatever plan the relaunched fleet should drain.
   Leaving it on `fleet-deltas-leader-primitives-2026-07-10` re-arms the empty-wake trap.
   **Class fix worth landing:** when a plan closes/drains, auto-reconcile (clear or warn)
   any fleet/bee claim spec whose `view.filter` pins that plan — today it silently rots.

2. **Fix the `coord_event_log` unbounded scan** — filed as **WI-3869** (bug, major). Bound
   the read with a `LIMIT` + an `id > $cursor` window so presence/orient/fleet-status reads
   stop timing out as the log grows. This is what makes the whole fleet UI look dead.
   *(Live corroboration: while writing this brief, `work_items:create`, `work_items:release`,
   and `memory:remember` all TIMED OUT at 55s — the coord/PG write path is degraded right
   now, same root as the presence-read timeouts.)*

3. **The backlog is real and drainable** — 28+ admissible `todo` items in papercusp
   (`work_items:list {harness:papercusp, state:todo, admissibleOnly:true}`). Point live
   workers at it; `scheduler:get_next` works once the spec isn't pinned to a closed plan.

---

## State of my lane (what I was doing)

- **Mission complete on my lane.** Both fleet-system improvement plans SHIPPED/drained:
  - `fleet-deltas-leader-primitives-2026-07-10` — 11/11 done, plan closed.
  - `fleet-leader-frictions-six-improvements-2026-07-10` — 6/6, status shipped.
  - No engineering work remained; I was in passive AUTO leader-watch (60s warm monitor).
- **p2p readiness = NO-GO.** Root blocker **WI-3646** (cross-machine content-federation
  regression, apply/projection stage). Ledger: `shared-pot-release-testing/RELEASE-READINESS.md`.

### Owner-gated walls (carry forward — none resolvable by an agent)
- **WI-3627** — foreign-session capability GRANTS beyond DEFAULT-DENY-ALL; owner
  ratification pending. Re-check: `work_items:get { id: WI-3627 }`.
- **WI-3574** — OpenAI embedding quota exhausted; mem0 on BGE fallback; needs owner billing
  action. (system-watchdog re-alarmed "Durable memory degraded" 16:17Z.)
- **Ledger walls 24/25/26/29** — code-signing certs, open-signup, multi-owner ban-lift,
  arm64 hardware. Re-check: `sed -n 96,104p shared-pot-release-testing/RELEASE-READINESS.md`.

## Open coordination threads
- **su-7a3c4 (cup-lexicon-rename leader)** — ANSWERED. Their E5-hot cascade gate on my
  "cascade ping" is **CLEAR/GREEN** (my msg `mrf9g0jg`); I hold zero locks, p2p-rest closed,
  so the gate's reason is gone. Two caveats I flagged as theirs: (1) fresh locks/presence
  check on a live editor of `lib/sync/hive-git/` (su-6073d on WI-3646) before moving that
  dir; (2) land the rename atomically + update `RELEASE-READINESS.md` path refs (p2p still
  re-tests on that substrate).
- **su-4dc3b (p2p-parity-lanes leader)** — a staged r3 cascade fires only on their explicit
  `wm>127` GREEN wake. Do NOT poll for it.
- **su-53a8a (p2p-rest member)** — ended their loop on the empty-wake symptom above; resumes
  on wakeOnReply. Their diagnosis (stale spec) is corroborated in this brief.

## Loose ends
- **WI-3514** ("GRADE program … su-agent-behavior v0.2.1 exam iteration 1") — I claimed this
  via a diagnostic `scheduler:get_next` call while proving the spec wasn't hard-starving. I
  did **not** work it. I attempted an explicit release but the call **timed out at 55s**
  (same coord/PG degradation) — so it may still show me as holder; when my session ends,
  orphan-reclaim reclaims it. It's an owner-directed GRADE task (assigned by su-a0a309f9) —
  keep it claimable for whoever runs the grade program; re-release by id if it's still pinned.

---
*Verified live 2026-07-10 ~18:45Z. Numbers are snapshots — re-verify via `coord:orient`,
`dev:pg_active_queries`, `dev:rate_governor_status`, `scheduler:get_claim_spec` before acting.*
