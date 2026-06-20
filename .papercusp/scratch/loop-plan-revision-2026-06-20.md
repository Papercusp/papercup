# Loops — interval-recurring routines that replace Claude /loop (su/interactive)

## Now

**State:** Design complete + code-grounded, **REVISED 2026-06-20 after an owner design review** (the original "loop = scheduled plan-run" model was reversed — see D-005/D-006). **Core model:** a **loop** is a routine that fires a recurring **warm `coord` wake** at a pinned su-agent session, re-armed N seconds *after the previous turn completes*. It rides the EXISTING wake-executor liveness ladder (alive+injectable → inject the wake-turn; exited → `claude --resume <sid>`; the loop owns NO resume code — D-005). The agent stays warm (same session/context) and works a plan by **creating + self-assigning `work_items` each wake** via an atomic `work_items:create {assign_to}` (D-006, P-007), so progress tracking piggybacks on three existing layers — routine fire-history (`recordFire`), the work-queue (`fleet:assignments`), and plan progress — plus a cost-cap on the loop routine; **no per-fire plan_run** (D-006). This is the user-directed counterpart to the autonomous queen/bee/scout loop, which is OUT OF SCOPE and untouched (D-007). Phases: **A** = the loop primitive; **B** = adoption (retire Claude `/loop` for `/loop`-using su/interactive agents, big-bang); **C** = scale to hundreds (demand-gated).

**Next:** Implement Phase A — P-001 (schema: `reschedule_interval_sec` column + session binding) → P-002 (completion-rebase) + P-003 (claimDueRoutine third kind, `infinity` in-flight sentinel) + P-004 (fire action = warm `coord` wake) + P-005 (expose + tests).

## Background — intent, terminology, scope

**Intent: replace Claude Code's built-in `/loop` for user-directed su loops.** A user works directly with an su agent, they produce a plan together, and the user wants to "put it on a loop" — the agent keeps working that plan on a recurring cadence, **warm** (same conversation), but **engine-managed + tracked** in papercusp (survives restarts, observable, inherits guardrails) instead of Claude's in-context `/loop` (which drifts, dies with the session, is invisible to the operator). This is NOT the autonomous queen/bee/scout loop — that already runs on its own system and is untouched (D-007).

**Terminology.** plans (the work) · routines (anything the engine fires on a trigger) · schedules (cron/rrule wall-clock recurrence). This adds a fourth: a **loop** = a routine that re-fires N sec *after the previous run completed*. "schedule" = fixed clock; "loop" = N sec after the last turn finished.

**How a loop runs, mechanically (revised — D-005/D-006).** A loop fire delivers a **`coord` wake** to the agent's pinned session. The shipped **wake-executor liveness ladder** (`await-event-primitive-2026-06-05` P-004) handles delivery transparently: process **alive + injectable pty** → inject the wake-turn ("press enter"); process **exited** → re-invoke via `claude --resume <sid>` (warm from transcript); **alive-but-uninjectable** (detached terminal — the common psu case) → park + inbox-nudge, sweeper converts to resume when the pid dies. So the loop owns NO resume logic — inject-vs-resume is the executor's call by liveness. Transcript growth across iterations is handled by the agent's harness (Claude Code's native context compaction), not the loop.

## Phase A — the loop primitive (interval-after-completion recurrence)

- **P-001** `todo` Schema: add a dedicated `reschedule_interval_sec INTEGER` (nullable) column to `harness_shared.routines` (D-003 resolved: column, not jsonb — the rebase/dispatch SQL filters + indexes on it). NULL = schedule-only; N = re-fire N sec after the turn completes. Also bind the loop to the **target session** it wakes (the su agent's owner/session id). Thread through RoutineRow, upsertRoutine, materialize-plan-schedule. importance: high
- **P-002** `todo` Completion-rebase ("N sec after the turn ENDS"): in reconcileAndGovern (reconcile-plan-runs.ts:132, the 30s tick) when the loop's last turn settles, set `next_fire_at = completed_at + interval`. Idempotent off the fixed completion time; rebase ONLY off the most-recent settled turn (never an older late-settling one, or next_fire_at moves backwards). Caveat: settle is observed on the 30s tick, so the true period is interval + up-to-30s — fine for the /loop floor (60s), not sub-minute. blocked-by: P-001 importance: high
- **P-003** `todo` (MUST-FIX) claimDueRoutine: treat a loop as a THIRD recurrence kind. A loop has neither cron nor rrule, so today `hasRecurrence` (claim.ts:26) is false → the one-shot branch sets `active=FALSE` (claim.ts:32) and the loop fires once then dies (and would wrongly trip the plan-schedule un-arm, claim.ts:47). The naive fix (`active=TRUE` + `next_fire_at=NULL`) hits the opposite trap the file warns of (claim.ts:11-15): NULL = due next tick → infinite refire. **Pinned mechanism (owner review):** on claim keep `active=TRUE` and PARK `next_fire_at = 'infinity'::timestamptz` — the claim guard `next_fire_at <= now()` never matches it, so it is not re-claimed while the turn runs (this IS the in-flight / skip-if-in-flight guard, for free); the completion-rebase (P-002) re-arms it to a real time. A routine with BOTH a cron and a loop takes the SOONER of cron-next and the loop re-arm. Load-bearing — without it Phase A does not work. blocked-by: P-001 importance: high
- **P-004** `todo` Fire action = a WARM `coord` wake (NOT a fresh plan-run — D-005): the loop fire delivers a `coord:send {wake}` to the pinned session and records the fire (`recordFire`). It rides the existing wake-executor ladder (inject-if-live / `--resume`-if-exited); the loop adds no resume code. Attach a **cost-cap** to the loop routine (auto-pause on cost breach) alongside the existing failure-streak fire-gate (`checkFireGate`, routines-workflow.ts). blocked-by: P-001 importance: high
- **P-005** `todo` Expose + test: a loop verb / `plans:set-schedule` accepts the interval + session binding. Tests: (a) warm wake continues the SAME session (transcript carries forward); (b) fires N sec after the turn settles; (c) composes with cron — takes the sooner; (d) skip-if-in-flight via the `infinity` sentinel — never refires mid-turn; (e) P-003 regression — a pure-loop stays active across many fires; (f) BOTH the failure-streak fire-gate and the new cost-cap trip. blocked-by: P-002, P-003, P-004

## Phase B — adoption: the ONE loop mechanism (retire Claude /loop), big-bang

Scope (D-007): ONLY agents that self-pace with Claude `/loop` / ScheduleWakeup — the su/interactive agents. The autonomous queen/bee/scout loop is its own system and is NOT touched.

- **P-006** `todo` Update the su/interactive agent prompts/personas that currently use Claude `/loop` to use the engine loop instead — **big-bang** (owner's call; not staged). Lowest layer that fits (defineTool guidance > role .tools.md > .persona.md). New rule: "to recur, declare an engine loop; do NOT self-pace with Claude /loop." Explicitly EXCLUDE the autonomous fleet loop. blocked-by: P-005 importance: high
- **P-007** `todo` (owner request) `work_items:create` — add an atomic **`assign_to`** parameter: create the item AND assign/claim it to a supplied agent id in the SAME call (one DB write, no create→claim race). General capability — `assign_to` accepts ANY agent id (e.g. the Queen creating + placing onto a bee); **self-assignment is the case where the agent passes its OWN owner id**. Thread the assignee into create.ts (it already stamps `createdBy`) so the claim/lease is written atomically with the insert. importance: high
- **P-008** `todo` Ergonomic entry point: a verb an agent calls to arm a loop on ITSELF (the /loop replacement) + end it, binding the current session. The loop's **wakeup prompt** instructs the agent: *"each wake, create your work_items for this iteration and SELF-ASSIGN them by passing your own agent id to `work_items:create {assign_to: <me>}` (P-007), then work them and `set_state` as you go"* — so the loop's work rides the work-queue / `fleet:assignments` observability while staying warm + owned (no cold dispatch). blocked-by: P-005, P-007
- **P-009** `todo` Docs: an agent-insights page — loops vs schedules vs Claude /loop, the after-completion semantics, the warm-wake/resume ladder, the guardrails (fire-gate + cost-cap), the create+self-assign work-queue convention, and observing a loop (fire-history + work-queue + plan progress). blocked-by: P-005

## Phase C — scale to hundreds (DEMAND-GATED)

Phase A+B deliver the goal (replace /loop) on their own. Hundreds of concurrent loops is speculative and is the part most likely to re-create the workflow_status freeze — do NOT build until there is a concrete requirement (D-004).

- **P-010** `todo` Bound RUNNING, not ARMED: hundreds of loops may be armed, but only ≤ the fleet / spawn-governor cap wake at once (the interval staggers the rest); a sleeping loop is a cheap `next_fire_at` row. Verify sleeping cost is O(1) per loop and the fleet rate-governor is the real bound. blocked-by: P-005
- **P-011** `todo` Unblock dispatch: routinesQueue concurrency is 4 (routines-workflow.ts:44) → hundreds-due serialize. Raise to ~16-32 OR add a lightweight loop dispatch lane. Dispatch != running — it hands to the spawn governor. blocked-by: P-005
- **P-012** `todo` Lightweight fire record (the freeze-killer): a loop wake must NOT persist a full durable DBOS workflow per fire — a lost fire is re-fired by the next interval, so durability isn't needed. This IS EI-1622's source fix (dbos-workflow-gc.ts: run ephemeral high-freq checks as in-process intervals) and dodges the workflow_status 300k-row freeze that stalled the Queen (2026-06-19). Keep the guards the durable path gave free: single-fire / skip-if-in-flight (the `infinity` sentinel already gives this) + a dead-fire release valve. Pair with count-based workflow_status GC tuned to the firing rate. blocked-by: P-005 importance: high

## Decisions

### D-001 — Terminology: interval-after-completion routines are "loops"
Date: 2026-06-20
We already have three first-class words: plans (the work), routines (anything the engine fires on a trigger), and schedules (cron/rrule wall-clock recurrence). The thing this plan adds — a routine that re-fires N seconds AFTER its previous run completes — needs its own word so it doesn't blur with "schedule". We call it a **loop**. Rule of thumb: "schedule" = fixed wall-clock; "loop" = N sec after the last run finished. Use "loop" consistently in the field name, API/verb surface, docs, and agent prompts.
Related: P-001

### D-002 — SUPERSEDED by D-005: "a loop is a scheduled plan-run"
Date: 2026-06-20 (superseded same day, owner review)
Original framing: a loop mints scheduled plan_runs (run_type='scheduled') so it inherits cost-cap + failure-streak auto-pause for free. REVERSED: that model spawns COLD — `plan-run-action.ts` mints a fresh instance plan (`templateSlug@run-<token>`) + fresh work_items dispatched to interchangeable bees (verified, lines 100-179) — which defeats the warm-continuity requirement (the agent of iteration N+1 is not the warm context of iteration N). The loop fire is a warm `coord` wake instead (D-005); the guardrails are re-attached at the routine layer (D-006), not inherited from plan-run minting.
Related: P-004

### D-003 — RESOLVED: dedicated reschedule_interval_sec column
Date: 2026-06-20
Resolved (owner): a dedicated `reschedule_interval_sec INTEGER` column, not a `trigger_config` jsonb key. The completion-rebase + Phase-C dispatch queries filter/index on it, and the app is pre-production so there is no migration cost to deferring. Cron/rrule stay in trigger_config; the loop interval is its own column.
Related: P-001

### D-004 — Phase C (scale to hundreds) is demand-gated
Date: 2026-06-20
Phase A+B deliver the stated goal — replace Claude /loop with a tracked engine-managed warm loop — entirely on their own. "Hundreds of concurrent loops" has no cited concrete requirement, and Phase C is the part most likely to re-create the workflow_status bloat/freeze that stalled the Queen on 2026-06-19 (the lightweight-fire-record work in P-012 is exactly that risk surface). So Phase C is not built on spec: ship A, adopt it in B (retire Claude /loop), and let real observed load decide whether C is needed. If/when it is, P-012's source-fix (no durable workflow per fire) is mandatory.
Related: P-010, P-011, P-012

### D-005 — A loop fire is a warm `coord` wake, not a fresh plan-run
Date: 2026-06-20 (owner design review)
Requirement: a loop must run WARM — the same su session/context continues across iterations (behave like Claude /loop, but tracked). The fire therefore delivers a `coord:send {wake}` to the pinned session and rides the shipped wake-executor liveness ladder (`await-event-primitive-2026-06-05` P-004): alive+injectable → inject the wake-turn; exited → `claude --resume <sid>`; alive-but-uninjectable (the common psu detached-terminal case) → park → resume when the pid dies. The loop owns NO resume logic — inject-vs-resume is the executor's call by liveness, so "riding the coord wake" needs no new resume code. Transcript growth across iterations is the agent harness's job (Claude Code native compaction), not the loop's. Supersedes D-002.
Related: P-004

### D-006 — Tracking piggybacks on existing layers; no per-fire plan_run
Date: 2026-06-20 (owner design review)
The loop does NOT mint a plan_run per fire. Progress + history ride three existing layers: (1) **routine fire-history** — routines already call `recordFire` on every fire and gate on `checkFireGate` (failure-streak backoff); (2) the **work-queue** — the loop's kickoff instructs the agent to create + SELF-ASSIGN its work_items each wake via the atomic `work_items:create {assign_to: <me>}` (P-007), so its work shows in `fleet:assignments` (warm + self-claimed in ONE call → no create→claim race, no cold dispatch); (3) **plan progress** — the items/Now the agent updates as it works. The only net-new guardrail is a **cost-cap on the loop routine**. The heavier "plan_run per fire" (per-iteration cost accounting + each fire as a distinct Runs-tab entry) was considered and rejected as unneeded — fire-history + work-queue + plan progress already cover history + progress + don't-run-away; revisit only on a concrete demand. Progress-checkpointing is general (every agent should update progress each turn, loop or not), so it lives in the existing plan/work_item tools, not in the loop.
Related: P-004, P-007, P-008

### D-007 — Scope: su/interactive loops only; the autonomous fleet loop is untouched
Date: 2026-06-20 (owner)
This replaces Claude /loop ONLY for agents that self-pace with it — the su/interactive agents a user works with directly. The queen/bee/scout autonomous loop is a separate, already-running system and is explicitly OUT OF SCOPE. Phase B's prompt sweep (P-006) targets `/loop`-using agents, not "every agent."
Related: P-006

### D-008 — Atomic create+assign on `work_items:create` (owner request)
Date: 2026-06-20 (owner)
Rather than mitigate the create→claim race with a tiny-window claim + `declare-intent`, `work_items:create` gains an atomic `assign_to` parameter: create AND assign the claim to a supplied agent id in one call. It is GENERAL (assign to any agent id — e.g. Queen create+place onto a bee), and self-assignment is just the case where the caller passes its own id. The loop wakeup prompt (P-008) tells the agent to self-assign by passing its own id. Removes the race the warm-loop work-queue convention (D-006) depended on.
Related: P-007, P-008
