# p2p-parity-lanes — Leader Handoff Brief

**For:** the incoming leader of fleet `p2p-parity-lanes` (owner will hand you this).
**From:** su-0e1a65bd (transitional leader — I took leadership only to hold the fleet; the
owner is reassigning it to you).
**Written:** 2026-07-10 ~20:10Z. Harness: `papercusp`. Repo: `~/papercupai-workspace/papercusp`
(branch `staging`; NEVER `git add/commit/push` — the auto-commit routine owns the tree).

> ⚠️ This is a **stale snapshot of a live system**. Before acting on any fleet/claim/liveness
> line below, re-verify: `fleet:leader-brief { fleet:"p2p-parity-lanes", harness:"papercusp" }`,
> `plans:get { slug:"p2p-parity-closeout-lanes-2026-07-10", harness:"papercusp" }`, and the
> facts named at the bottom. Numbers here are snapshots.

---

## STEP 1 — claim the fleet (do this first)
```
fleet:take-leadership { fleet:"p2p-parity-lanes" }
```
This installs you as leader and demotes + notifies me (su-0e1a65bd). Do it before you plan —
it's identity-establishing, not a confirm-gated write.

> Note on `coord:orient`: its memory-recall leg can **hang** right now — OpenAI embedding quota
> is exhausted so `memory:*` runs on the slow local BGE fallback (`[owner-gated] WI-3574`). If
> orient times out, bootstrap with targeted reads (`fleet:leader-brief`, `plans:get`,
> `facts:list`) instead.

---

## The mission
Plan **`p2p-parity-closeout-lanes-2026-07-10`** (harness `papercusp`): P-059 close-out + parity
workstreams. **6 of 10 plan items are DONE.** The remaining 4 all gate on **P-059 going GREEN**,
which is still **RED**.

### Plan item state (snapshot)
| Item | State | Note |
|---|---|---|
| P-001..P-004, P-009, P-010 | **done** | fed-plane close-out + sandbox + LIVE-2 prep |
| **P-005** (WI-3765) | **blocked** | Mac-VM 0.0.7 bundle install → slug-stamp verify. su-63834's active lane. |
| **P-006** (LIVE-1, WI-1729) | **blocked** | green all 5 parity surfaces on the live rig — gates on P-059 green |
| **P-007** | todo→blocked | presence-gossip cutover — only after P-006/LIVE-1 is green |
| **P-008** | **blocked** | distribution-chain puller activation + metering |

---

## THE LINCHPIN: P-059 GREEN (still RED)

**Green signal** (the discriminant — read fact `p2p-git-watermark-gate-discriminant`):
a probe round-trip must land a **remote** row —
`SELECT origin,count(*) FROM harness_shared.coord_event_log WHERE body::text ILIKE '%v2t-probe%' GROUP BY origin`
→ `origin='remote' >= 1`. **Do NOT** use the bare `origin='remote'` count as the signal — it's
contaminated by service-health broadcast federation from other hive members. As of handoff the
signal was **frozen** (remote max-ts stuck at `2026-07-10 10:32:45 EDT`, 0 fresh probe rows).

### Two-ended model (from WI-1729's checkpoint)
- **TOWER send-side = RESOLVED.** The SESSION_CLOSED retry-storm (WI-3684) was fixed by
  **WI-3761** (state `passed`, landed 14:54Z); zero recurrences since. Needs **one more bg-host
  boot-cycle** to confirm the soak. **`[self-imposed]` DO-NOT: do NOT force a bg-host restart** —
  it re-trips the late-boot-ADOPT trap.
- **MAC→TOWER receive-side = DOMINANT BLOCKER.** Root cause: the **iMac** runs a **stale bundle**
  + likely **disk-full/ENOSPC** (EI-9046 / EI-8982 pattern). This is the thing to fix to green P-059.

### The owner-authorized unblock (IMPORTANT — not owner-gated)
Read fact **`p2p-imac-fix-authorized-2026-07-10`** — `[owner:Avi 2026-07-10]` explicitly
**authorized** the iMac sidecar-refresh fix and said *"this isn't owner gated. you can do this."*
Procedure (delegated to the **p2p-git leader su-63834**, who owns the active Mac lane):
rsync the tower's fresh `papercusp-desktop/src-tauri/sidecar/` (serve.mjs, Jul-10 13:39) →
iMac `/Applications/Papercusp Server.app/Contents/Resources/sidecar/` (stale Jul-9 23:39),
**back up first**, quit + relaunch the Mac app. **Do NOT cut a duplicate 0.0.7 bundle**
(fact `desktop-0-0-7-must-rebuild-sidecar-serve-mjs`). Also relevant: **WI-3891** (join-link never
stamped `harness_kind:'hive'` → registry misclassifies a real member as nonexistent; resolved on
staging) — the VM needs that fix via **SQL registry backfill** (fastest) or a 0.0.8 release.

**Coordinate the rig through su-63834 (p2p-git leader) and su-07320 (live-rig / EI-8895 crack
leader).** They hold the P-059 GREEN watch + peer-flip contracts; a restart mid-watch corrupts the
verdict. Don't stomp their lane — support it.

---

## Fed-plane bug status (mostly resolved — context, verify before re-touching)
- **WI-3619** (outbox-drain PASS TIMEOUT) — **resolved**; real root cause was WI-3825.
- **WI-3825** (readInbox unbounded seq scan, ~79h DB CPU, starved bg-host drain) — **resolved**
  (bounded read + partial index, migration 545).
- **WI-3684** (SESSION_CLOSED storm) — fix landed (WI-3761). Leave **open one more boot-cycle** to
  confirm soak, then close as fixed-by-WI-3761 with evidence.
- **WI-3734** (live-federation-gate RED: content-matrix) — fix landed (a second retry
  classification for empty-body boot-readiness flake). **Awaiting the next hourly gate run**
  (`papercup-live-federation-gate.timer`) to confirm; if that run shows a retry attempt-2 and ends
  GREEN, close it citing that run. Held by su-abce4 (claim may be stale — re-verify).

---

## Fleet + claim-spec state (the thing that made members idle)
As of handoff: ~10 alive members (mix of live + parked/winding-down), several ended. Members had
**drifted into general papercusp backlog drain** because the plan lane is saturated/blocked.

**The trap:** the fleet claim spec was pinned to `plan = p2p-parity-closeout-lanes-2026-07-10`
(revision 11, `maxConcurrentClaims:1`). Since the plan is 6/10 done and the rest are blocked, that
spec matches **zero** claimable items → `scheduler:get_next` returns empty → members quiesce.

**Recommended fix** (mirror what I did for the sibling fleet p2p-rest-sonnet-5):
`scheduler:set_claim_spec { fleet:"p2p-parity-lanes", spec:{ …, view:{ filter:{ all:[{ field:"kind", op:"in", value:["bug","change","task"] }] } }, rank:{ mode:"lexicographic", terms:[{expr:"priority",dir:"asc"},{expr:"age",dir:"desc"}] } } }`
so idle members drain the real papercusp backlog. Then **wake the parked members**
(`coord:send { to:[…ids], wake:"required" }`). Re-point the spec **back to the plan** when P-059
greens and P-006/P-007/P-008 open up. (`needs_2_machine_rig` items are auto-excluded from
`scheduler:get_next` for a single-box caller, so you don't have to filter them.)

---

## DO-NOTs (carry forward)
- **`[self-imposed]`** Do NOT flip AUTHORITY dark-flags (**WI-3855**) unilaterally — treat as owner-gated.
- **`[self-imposed]`** Do NOT force a bg-host restart (re-trips the late-boot-ADOPT trap).
- **`[inferred from leader lock]`** Do NOT touch the tower bg-host / iMac / Mac-VM app lifecycle
  without su-63834 / su-07320 ACK (P-059 GREEN watch runs there; there is also an owner VM-pause in
  effect per WI-3546's thread, ~19:32Z — not independently verified against an owner quote, so
  confirm before any VM change).
- Do NOT cut a duplicate 0.0.7 bundle.
- Do NOT hand-edit `MEMORY.md` (auto-generated).

## Owner-gated walls (not agent-resolvable)
- **WI-3574** — OpenAI embedding quota exhausted; mem0 on BGE fallback (needs owner billing).
- **WI-3855** — AUTHORITY dark-flags (owner ratification).

## Owner staffing directive (this session, 2026-07-10)
`[owner:Avi 2026-07-10]` wants **up to 10 Claude Sonnet-high** workers on this stream. Capacity was
healthy at handoff (accounts un-walled/un-paused). **Rate-limit sensitivity exists** — the owner
capped a sibling fleet at 5 earlier after rate pressure — so watch account status and let members
quiesce if pressure returns. When you spawn, announce account/model/carry (default: `auto` gateway
routing, `sonnet:high`, `warm` carry) per the spawn-disclosure rule.

## Your first monitor loop
`loop:arm { intervalSec:120, mode:"monitor", harness:"papercusp", goal:"…" }` — **pass `harness`**
(the su session is unscoped; loop:arm errors `no_harness` without it).

---

## Pointers (re-read these, don't trust this doc alone)
- **Facts** (`facts:list { scope:"harness", scopeRef:"papercusp" }`):
  `p2p-parity-lanes-leader-handoff-2026-07-10`, `p2p-imac-fix-authorized-2026-07-10`,
  `p2p-git-watermark-gate-discriminant`, `p059-two-ended-blocker-2026-07-10`,
  `desktop-0-0-7-must-rebuild-sidecar-serve-mjs`.
- **Checkpoints**: `work_items:get { ids:["WI-1729","WI-3684","WI-3619"] }` (WI-1729 carries the
  full fed-plane handoff).
- **Live-rig leaders to coordinate with**: su-63834 (p2p-git), su-07320 (EI-8895 crack / live-rig).
