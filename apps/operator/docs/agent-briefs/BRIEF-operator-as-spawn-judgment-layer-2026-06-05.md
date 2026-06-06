# BRIEF — Operator as the spawn-judgment layer, fed by coalesced wake-events (design discussion)

**Type:** design discussion to continue *with the owner (avi)* — **NOT an implementation brief.** The owner explicitly said "don't even think about how to fix this yet; first let's think about the system." Your job is to continue the design dialogue and, only when the owner is ready, converge it into a plan (`plans:new`). Do not start building.

**Author handoff:** su-5580e (the audit/brief session). Date 2026-06-05. Everything below is file-grounded (three read-only investigations); cite the files when you pick a direction.

---

## How we got here (the origin)

The owner asked to drive a release-gate deploy of today's batch-4 work to green `:3070`. Verifying first surfaced the real story: **`ready` (what `:3070` runs) is stuck at a 05:35 commit — 85 commits / ~15.5h behind `main`** — because the hourly **green-checkpoint gate has found `main` not-green all day** (last fired 20:15; `ready` never advanced). The owner's reaction was the important part: *"Why are we just finding out about this now?"* — and pivoted from "fix the deploy" to **"let's design the system that surfaces and resolves these automatically."**

That opened three intertwined threads, which are really **one system**:
1. **Surfacing gap** — a 15h-red main produced zero actionable alert.
2. **Spawn machinery** — how agents (e.g. the merge-resolver) get spawned, and the owner's vision to route more spawn *decisions* through the operator (which has full context) to reduce token burn.
3. **Wake-token-burn** — the wakeup system could wake an agent repeatedly and burn tokens; the owner proposed a "min sleep" floor and asked for a better design.

**The unifying thesis (the spine of this discussion):** signals fire into the void, and spawns happen with no judgment layer. The answer is **the operator as the judgment layer over spawns, fed by floored + coalesced wake-events.** Critically — the operator-as-decider vision *only* reduces tokens if the operator's own wakes are floored/coalesced; the two ideas are one design.

---

## Thread 1 — Why a 15h-red main produced no alert (the surfacing gap)

**Broadcast-and-forget.** The green-checkpoint red path (`apps/operator/lib/release/green-checkpoint.ts:87-96`) does only: a `console.warn` (host log, invisible) + one `broadcast(... category:'service-health')` (`:143-149`). That category is **hard-excluded from `coord:inbox`** (`AMBIENT_CATEGORIES` in `packages/operator-core/lib/agent-tools/coordination/tools/inbox.ts:33,75-78`), so no agent sees it. It *does* reach `plans:attention`, but as `to:['*']`/no-lifecycle → **`tier:'activity'`** (lowest FYI; `packages/operator-core/lib/attention/adapters.ts:171-205`), buried in source #3's `.slice(-50)` (`plans/attention.ts:138-173`) among hourly 🟩 noise.

**No accumulator, no escalation, no await.** There is no "red for N hours" state — each tick re-broadcasts and forgets. The red path never calls `openEscalation()` (the unused rail at `coordination/escalations.ts:39`), writes no toast (`notifications:recent` empty), and emits **no await key** — `emitAwaitedEvent({key:'release:green'})` fires only on the *green* branch (`green-checkpoint.ts:109-121`); there is no `release:red`.

**It's systemic.** Deploy results (`deploy-deps.ts:211-217`), `db-boot-migrate`, the service-health monitor all use the same `service-health` broadcast-and-forget. The one rescued signal — `service-down` — is rescued only because the **improvement-watchdog** (`packages/operator-core/lib/harness/improvements/watchdog.ts:36,176-215`) has a collector for it. Its four collectors are `red-test | smoke-fail | repeated-tool-error | service-down` — **no `red-main`/`stuck-ready` collector.** `release-trigger` is INACTIVE and wouldn't help anyway (it's a green-ahead deploy trigger, no-op on red).

**Verdict: wiring gap, not a missing capability.** Three escalation rails already exist (escalation channel → `tier:'decision'`; the watchdog auto-filer; the await bus). The only genuinely new logic is the **"ready has been red/stale for N hours" accumulator.** The minimal honest fix: on red, stop treating it as ambient `service-health` — `openEscalation` (advisory on first red → blocker after N hours) and/or add a watchdog `red-main` collector + a `release:red` await key.

---

## Thread 2 — How agents get spawned (and the operator-as-decider vision)

**One spawn primitive:** `POST /api/harness/:slug/invoke?role=<role>` (`packages/operator-core/lib/endpoint-route/routes/harness/spawn.ts:164-290`) → spawns a **cold one-shot LLM agent** (`harness-invoke-once.ts`; `claude`/`omp`/`codex`). Everything else decides *who hits that route*.

- **Cron/routine tick** — DBOS `routinesTick` every 30s (`packages/operator-core/lib/dbos/routines-workflow.ts:120`). Dispatches by `target_role`: **`system:*` → deterministic handler inline, no LLM** (registry in `harness/routines/{system-actions,register-system-actions,release-actions}.ts`); **bare role → cold agent fire** (`:87-109`, gated by an error-backoff circuit breaker).
- **The merge-resolver (the owner's "merge on main" agent): event-driven, NOT cron, NOT operator.** git-sync is a deterministic `system:git-sync` routine (every 3 min). When its merge returns `conflict`, the **git-sync handler itself** spawns the resolver (`harness/git-sync/git-sync-action.ts:226-284`) via the `merge-resolution` launch blueprint (`blueprint/launch-blueprint.ts` event-map :104-118). git-sync owns detection + the spawn; the operator is not in the loop.
- **The pipeline** (scoper→worker→…): a DBOS workflow loop (`dbos/orchestrator-workflow.ts:183-320`) where the **director LLM decides the next role each turn**, then a workflow step spawns it.
- **The operator/pot**: declares its own next wake (a one-shot `pot-wake` routine row) + event subscriptions (`pot/wake.ts`), and creates harnesses via `harness:create` (`agent-tools/harness/create.ts` — *"No orchestrator.spawn (P-007)"*), which **materializes blueprint triggers into routine rows** (`blueprint/materialize-triggers.ts`). It expresses decisions as declarative routine/subscription state; the deterministic engine pulls the trigger.

**The blind vs judgment-gated split (the crux for the vision):**
- **Blind/scheduled (fire on a clock regardless of context):** `system:blueprint-run mode:'run'` cadence + bare-role cron routines — spawn a cold agent **every interval whether or not there's work**; the only guard is *failure*-backoff, not *work*-awareness. **These are the candidates to re-route through the operator.**
- **Already judgment/work-gated:** the pipeline dispatcher (reads the eligible frontier + concurrency first), the merge-resolver (only on a real conflict), `release-trigger` (deterministic precheck, hands go/no-go to the release-manager agent). Routing *these* through the operator buys observability/centralization, not blindness-reduction.

**The seams to do it already exist:** the fire is injectable (`setBlueprintRunFire`, `setLaunchBlueprintFire`, `setPipelineInvokeRunner`), event→reaction dispatch is durable (`event-reaction-workflow.ts`), role resolution is declarative (`launch-blueprint.ts`). So a blind cadence fire can flip from *"cron → spawn cold agent"* to *"cron → wake the operator → operator surveys + decides."*

**The honest tradeoff to hold in the design (do not lose this):** every operator wake is itself a full-context turn (Thread 3). Routing *everything* through the operator **increases** burn. The win materializes only when the operator's cheap wake **replaces a more-expensive cold specialist spawn that would have been wasted** (an idle cadence run the operator decides to skip). **Principle: deterministic where the decision is mechanical (git-sync, the 30s tick, pipeline role-advance — leave them); operator-gated where the decision needs context.**

**Flag caveat:** routines/reactions/curation engines are **opt-in** (`PAPERCUSP_DBOS_ROUTINES` etc., `dbos/bootstrap.ts`); the orchestrator is default-on. Verify which spawn paths are actually live on the running host before designing around them.

---

## Thread 3 — Wake-token-burn + the owner's "min sleep" idea

**Hard fact:** every wake is a **fresh-context turn at full token cost** — the re-invocation is `claude --resume <uuid>` (replays the whole conversation) / `omp -r` / headless `claude -p`, or `system:blueprint-run` relaunching the pot (`events/await/wake-executor.ts:62,208`; the code states *"a wake = a turn = tokens"*, `engine.ts:15`). No warm in-memory resume.

**The await primitive** (`events:await`/`emit`, `locks:acquire{wake_on_grant}` — plan `await-event-primitive-2026-06-05`): registration stamps the wake-handle and ends the turn (`agent-tools/events/await.ts:84`); one-shot by construction (`store.ts`, migration `163`); re-invoked by an on-emit pump + a 30s sweeper (`events/await/engine.ts:103,275`). The pump **paces** (per-tick resume cap default 3, per-subscriber single-flight, 30s defer at `engine.ts:162-196`) but has **NO min-sleep floor** — a hot key can wake a non-pot agent ~every 30s indefinitely. The governor (`fleet/governor.ts`, migration 161) *could* throttle but is **default-open + fail-open**.

**The owner's "min sleep" idea already exists — for the pot only.** `potWakeFloorSec` (default 60s; `pot/wake.ts:64`) with a time-wake clamp (`clampWakeAt:70`) and **fire-side debounce + coalesce** — *"a burst of subscribed events collapses to one wake"* (`agent-tools/pot/wake.ts:5,60`; `withinWakeFloor` `pot/wake.ts:209`) and a `force:true` urgency bypass. So the owner re-derived a real, shipped primitive — good sign the instinct is sound. The gap: it's **pot-only, a fixed global floor, not per-subscriber/per-key**, and the general await pump has none of it.

**The refined design (my recommendation to the owner — continue from here).** A bare min-sleep under-specifies it; the right primitive has four properties:
1. **Min-interval floor** (the owner's idea) — `next_wake_at = max(now, last_wake + min_sleep)`.
2. **Coalesce, don't queue** (the key correction to "queue them") — N events in the window collapse into **one** wake carrying the **union** ("you have 3 things"); one turn handles all pending. A queue of N wakeups is the opposite of the goal.
3. **Urgency bypass** — human message / escalation / rate-limit-reset deadline skips the floor (generalize the pot's `force:true` to a priority flag on `events:emit`; deadline-wakes always bypass).
4. **Max-staleness ceiling** — a deadline so a low-priority event isn't deferred forever (`wake at min(floor_expiry, max_wait)`). Leading-edge (wake on first, coalesce the rest of the window) = responsive + economical.

**Where it lives:** the await pump's delivery loop `pumpWakeDeliveries` (`events/await/engine.ts:162-198`) is the single choke point every wake passes through — add a per-subscriber `last_woken_at` + fold same-subscriber deliveries into one wake (store column on `event_wake_deliveries`, migration 163). And **lift the pot's floor logic into a generic `libs/generic` debounce/coalesce core** both the pot and the await pump consume (repo generic-first discipline; it's a textbook debounce).

---

## What the next agent should do

1. **Continue the design dialogue with the owner** — they want to think the system through before any code. Lead with reasoning + options (owner pref: `give-reasoning-with-options`), don't bare-card them, and don't implement.
2. Help converge on **scope**: which blind cadence spawns route through the operator vs stay deterministic; whether the red-main fix goes via watchdog-collector vs escalation vs await (or all three); the wake-coalescer's exact shape (per-key vs per-subscriber, leading vs trailing, defaults for floor/max-staleness/urgency classes).
3. Keep the **token-math honest**: centralizing spawns only saves tokens if operator wakes are floored/coalesced — design them together, not separately.
4. When the owner is ready, write it up as a **plan** (likely 2-3: the surfacing/escalation wiring; the operator wake-event seam for blind cadence fires; the generalized wake-coalescer lib). Until then, it's a conversation.

## Open questions to put to the owner
- Should the operator own *every* spawn decision (incl. merge-resolver, release-trigger), or only the blind cadence fires? (My read: only the blind ones; the rest is observability.)
- Floor granularity: one global floor, per-role, or per-subscription-key?
- Urgency classes: what bypasses the floor (human, escalation, deadline, rate-reset) — and who declares urgency, the emitter or the subscriber?
- Red-main: escalate to the human directly, or wake the operator to triage first (and *it* decides escalate vs fix-agent)? The latter is the operator-as-judgment-layer model end-to-end.

## Separate, still-open (not part of this discussion, tracked elsewhere)
- **Batch-4 deploy is ON HOLD.** `main` is red so a clean deploy is a no-op; the owner has not chosen get-main-green vs force-deploy vs hold. (The urgent driver — Brief 53/62 validation — was already done on `:3170`, so it's not pressing.) Don't force-deploy without an explicit owner go.
- Three plan decisions were already recorded this session (reversible, owner-ratified): `promote-spawn-child-harness` D-005, `coord-channels-pg-port` D-009, `starlight-projection-generators` D-007. Unrelated to this brief.

## Key files (grounding)
- **Surfacing:** `apps/operator/lib/release/green-checkpoint.ts` · `harness/routines/release-actions.ts` · `apps/operator/lib/release/seed-release-routines.ts` · `agent-tools/coordination/tools/inbox.ts` · `attention/adapters.ts` · `agent-tools/plans/attention.ts` · `harness/improvements/watchdog.ts` · `agent-tools/coordination/escalations.ts`
- **Spawn:** `endpoint-route/routes/harness/spawn.ts` · `harness-invoke-once.ts` · `dbos/routines-workflow.ts` · `harness/routines/{system-actions,register-system-actions,release-actions}.ts` · `harness/git-sync/{git-sync-routine,git-sync-action}.ts` · `blueprint/{launch-blueprint,blueprint-run-action,materialize-triggers}.ts` · `dbos/orchestrator-*.ts` · `pot/wake.ts` · `autoloop.ts` · `agent-tools/harness/create.ts` · `dbos/bootstrap.ts` (flags)
- **Wake/coalesce:** `events/await/{await,engine,store,wake-executor}.ts` · migration `163-await-event-subscriptions.sql` · `pot/wake.ts` + `agent-tools/pot/wake.ts` · `fleet/governor.ts` + `@papercusp/structured-concurrency` · `rate-limit-config.ts` (migration 161) · insight `agent-insights/await-event-primitive.md`
