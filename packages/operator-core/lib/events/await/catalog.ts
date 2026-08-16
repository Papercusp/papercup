/**
 * events/await/catalog — the SINGLE SOURCE OF TRUTH for awaitable event-key
 * families (event-await-discoverability-and-coverage-2026-07-03 P-002, D-005).
 *
 * The plan's headline: the await primitive works, but agents don't FIND it — they
 * poll (`dev:pipeline_position`, `dev:build_status`) for things that already fire
 * an awaitable event. This registry is the fix's spine: ONE list of key families that
 *   (a) the `events:catalog` tool renders — answers "what can I wait on?" in one call;
 *   (b) the poll-site tools read to advertise an `awaitable:` hint (P-001);
 *   (c) the sugar verbs (P-003) source their key TEMPLATES from via `buildKey` — so a
 *       key shape lives in exactly one place.
 *
 * D-005 (why the registry is load-bearing, not decoration): because BOTH the
 * poll-sites AND the sugar read this registry, a future Phase 4 (fold the await
 * primitive into the ECA reaction engine) is a FORM change — swap how a family
 * resolves — not a rebuild. Do not scatter key strings; add them HERE.
 *
 * GROUNDED against the real emit sites (verified 2026-07-03), NOT the plan's prose:
 * the gate keys are the asymmetric `release:green` / `green-checkpoint:red`, and the
 * deploy key is a plain `release:deployed` (no `:<sha>` in the GLOBAL emit; the
 * per-sha `release:deployed:<sha>` is added by this plan's Phase 2). Every
 * `exists:true` key was read off its emitter; every `exists:false` key is added by
 * Phase 2 in the SAME session, so catalog and emitters agree by construction.
 *
 * MODEL: one entry = one key family (one `keyTemplate`). No implicit key-unions —
 * a sugar verb that wants an either-way wait (deploy success|fail) awaits the two
 * MUTUALLY-EXCLUSIVE keys explicitly; keys that CO-fire (e.g. the general
 * `work-item:status` and the specific `work-item:done`) are never awaited together,
 * so an agent is never double-woken for one transition.
 */

/** A `<placeholder>` slot in a key template. */
export interface EventKeyParam {
  /** Placeholder name as it appears in the template, e.g. 'id' for `work-item:done:<id>`. */
  name: string;
  /** Must the caller supply it to build a concrete key? An omitted OPTIONAL param collapses its `:<name>` segment. */
  required: boolean;
  /** One line for the catalog + sugar arg docs. */
  describe: string;
}

/** One awaitable event-key family. */
export interface EventCatalogEntry {
  /** Stable family id — the catalog lookup key and `buildKey` handle. */
  family: string;
  /** Exact key TEMPLATE with `<param>` placeholders. A no-param family is a literal key. */
  keyTemplate: string;
  /** Placeholders the template interpolates, in order. */
  params: EventKeyParam[];
  /** What firing this key MEANS (one line). */
  describe: string;
  /** Who fires it — a source label / file, for the catalog's "who emits". */
  emitter: string;
  /** Does an emitter ALREADY fire this key today? `false` = a Phase-2 addition. */
  exists: boolean;
  /** The poll this replaces — surfaced so agents stop polling (D-001). */
  replacesPoll?: string;
  /** The sugar verb that primarily surfaces this family, if any (P-003). */
  sugar?: string;
  /**
   * KEY IS GLOBAL (no per-subject param) — a wake fires for EVERY occurrence, so the
   * waiter must check the payload to confirm it's theirs. Set on families whose real
   * emit carries the subject in the PAYLOAD, not the key (e.g. `release:green` fires
   * once per checkpoint; `payload.sha` says which). The sugar echoes this caveat.
   */
  payloadFiltered?: boolean;
}

/**
 * THE registry. Order = catalog display order (highest-value / existing first).
 */
export const EVENT_CATALOG: readonly EventCatalogEntry[] = [
  // ── Deploy / release pipeline ─────────────────────────────────────────────
  {
    family: 'deploy',
    keyTemplate: 'release:deployed:<sha>',
    params: [{ name: 'sha', required: false, describe: 'the target sha; omit to wake on the NEXT deploy of any sha (global key)' }],
    describe: 'A staging sha reached the live GREEN :3070 operator (the deploy landed).',
    emitter: 'release-gate (apps/operator/lib/release/deploy.ts)',
    exists: true, // P-102: deploy.ts now fires `release:deployed:<sha>` alongside the global `release:deployed`
    replacesPoll: 'dev:pipeline_position (polling "is my sha live on :3070")',
    sugar: 'deploy:await',
  },
  {
    family: 'deploy-failed',
    keyTemplate: 'release:deploy-failed',
    params: [],
    describe: 'A deploy FAILED and rolled back (the mutually-exclusive counterpart of release:deployed).',
    emitter: 'release-gate (apps/operator/lib/release/deploy.ts)',
    exists: true,
    payloadFiltered: true,
  },
  {
    family: 'checkpoint',
    keyTemplate: 'release:green:<pipeline>',
    // EI-7646: several pipelines (papercusp operator + papercup dogfood) share the
    // global key, so a waiter woke on EVERY pipeline's verdict and had to lineage-
    // check payload.sha by hand each time. The emitter now fires BOTH the global
    // key and the pipeline-scoped one (basename of its integration root), mirroring
    // the release:deployed:<sha> precedent (P-102). Omit pipeline → the global key.
    params: [{ name: 'pipeline', required: false, describe: "the pipeline's repo basename (e.g. 'papercusp'); omit to wake on ANY pipeline's green (global key)" }],
    describe: 'The green-checkpoint PASSED — the candidate advanced onto main (the gate is green).',
    emitter: 'green-checkpoint (apps/operator/lib/release/green-checkpoint.ts)',
    exists: true,
    replacesPoll: 'dev:pipeline_position / dev:build_status (polling "did my change clear the gate?")',
    sugar: 'checkpoint:await',
    payloadFiltered: true,
  },
  {
    family: 'checkpoint-red',
    keyTemplate: 'green-checkpoint:red:<pipeline>',
    params: [{ name: 'pipeline', required: false, describe: "the pipeline's repo basename (e.g. 'papercusp'); omit to wake on ANY pipeline's red (global key)" }],
    describe: 'The green-checkpoint is HELD — candidate not green (payload.summary = failing-test tail).',
    emitter: 'green-checkpoint (apps/operator/lib/release/green-checkpoint.ts)',
    exists: true,
    payloadFiltered: true,
  },
  {
    // EI-19320479870270699: the THIRD terminal outcome — a run that ended WITHOUT a
    // verdict at all (payload.reason: up-to-date / not-fast-forward / migrations-pending /
    // skipped-locked / …, i.e. `CheckpointResult.green === null`). Before this existed, a
    // waiter armed on ONLY `checkpoint`/`checkpoint-red` (both mutually-exclusive REAL
    // verdicts) slept through an inconclusive run to its full timeout — the run that most
    // needs a human/agent to look, because it means the gate is WEDGED, not merely red.
    family: 'checkpoint-inconclusive',
    keyTemplate: 'green-checkpoint:inconclusive:<pipeline>',
    params: [{ name: 'pipeline', required: false, describe: "the pipeline's repo basename (e.g. 'papercusp'); omit to wake on ANY pipeline's inconclusive tick (global key)" }],
    describe: 'The green-checkpoint run ended with NO verdict (payload.reason names why, e.g. migrations-pending/skipped-locked) — not green, not red; just try again once the cause clears.',
    emitter: 'green-checkpoint (apps/operator/lib/release/green-checkpoint.ts)',
    exists: true,
    // Deliberately NO sugar. This entry carried `sugar: 'checkpoint:await'`, which the
    // `checkpoint` (green) family already owns — a sugar verb maps to exactly ONE family,
    // so the duplicate red-pinned the gate on catalog.test.ts's "every sugar-bearing
    // family names a distinct verb" (8 families, 7 distinct verbs). Its sibling
    // `checkpoint-red` has no sugar either: the convention is that the green family owns
    // the verb and the other terminal outcomes are awaited by key. If this outcome should
    // be sugar-awaitable, it needs its OWN verb (e.g. 'checkpoint:await-inconclusive'),
    // not a second claim on this one.
    payloadFiltered: true,
  },
  // ── Locks / plan runs ─────────────────────────────────────────────────────
  {
    family: 'lock',
    keyTemplate: 'lock:grant:<ticket>',
    params: [{ name: 'ticket', required: true, describe: 'the lock ticket you are queued on' }],
    describe: 'A queued lock was GRANTED to you.',
    emitter: 'lock-grant-bridge (locks:*)',
    exists: true,
    // already sugared via the locks:* tools — listed for completeness, no new verb
  },
  {
    family: 'plan-run',
    keyTemplate: 'plan-run:finished:<runId>',
    params: [{ name: 'runId', required: true, describe: 'the plan-run id you are waiting on' }],
    describe: 'A plan run finished.',
    emitter: 'plans:turn (packages/operator-core/lib/agent-tools/plans/turn.ts)',
    exists: true,
    replacesPoll: 'plans:runs polling',
  },
  // ── Work items ────────────────────────────────────────────────────────────
  {
    family: 'work-item',
    keyTemplate: 'work-item:status:<id>',
    params: [{ name: 'id', required: true, describe: 'the work-item id, e.g. WI-1234' }],
    describe: 'ANY status transition of a work item (todo/wip/blocked/done/…) — wake on every change of WI-X.',
    emitter: 'work-items-events (packages/operator-core/lib/work-items-events.ts)',
    exists: true, // P-101: emitWorkItemStatusEvent fires from setWorkItemState on every transition
    replacesPoll: 'polling work_items:get for a peer/dependency item',
    sugar: 'work-item:await',
  },
  {
    family: 'work-item-done',
    keyTemplate: 'work-item:done:<id>',
    params: [{ name: 'id', required: true, describe: 'the work-item id' }],
    describe: 'A work item SETTLED (feature→passed/deprecated, issue→resolved/closed).',
    emitter: 'work-items-events',
    exists: true,
  },
  {
    family: 'work-item-unblocked',
    keyTemplate: 'work-item:unblocked:<id>',
    params: [{ name: 'id', required: true, describe: 'the work-item id' }],
    describe: 'A work item\'s LAST live blocker just cleared.',
    emitter: 'work-items-events',
    exists: true,
  },
  {
    family: 'work-item-blocked',
    keyTemplate: 'work-item:blocked:<id>',
    params: [{ name: 'id', required: true, describe: 'the work-item id' }],
    describe: 'A work item transitioned INTO blocked.',
    emitter: 'work-items-events',
    exists: true,
  },
  {
    family: 'work-item-claimed',
    keyTemplate: 'work-item:claimed:<id>',
    params: [{ name: 'id', required: true, describe: 'the work-item id' }],
    describe: 'An agent claimed a work item.',
    emitter: 'work-items-events',
    exists: true,
  },
  {
    family: 'work-item-created',
    keyTemplate: 'work-item:created:<severity>',
    // EI-8296: "alert me when a new critical-severity item is filed" was inexpressible
    // (no creation event existed) — a 15-min poll+diff plan was built as a stopgap
    // (critical-severity-alert-2026-07-06). This family replaces it: omit `severity` to
    // wake on ANY new item (global key, payload_filtered — check payload.kind/harness/
    // severity yourself), or scope to e.g. 'critical' for the precise per-severity key.
    params: [
      {
        name: 'severity',
        required: false,
        describe: "issue-family severity (minor/major/critical) to scope to; omit to wake on ANY new work item (global key)",
      },
    ],
    describe:
      'A work item was CREATED (issue or feature). payload carries {id, kind, severity, harness, title} for filtering kind/harness after waking.',
    emitter: 'work-items-events (packages/operator-core/lib/work-items-events.ts) — fired from createWorkItem',
    exists: true,
    replacesPoll: 'a scheduled poll+diff plan for "alert on new WI matching <severity>" (e.g. critical-severity-alert-2026-07-06)',
    payloadFiltered: true,
  },
  {
    family: 'work-item-claimable',
    keyTemplate: 'work-item:claimable',
    // composable-event-awaits-2026-07-11 P-007: the CANONICAL "work may exist for
    // you" key — dual-emitted alongside work-item:created (unclaimed create),
    // claim:released:<id>, work-item:unblocked:<id>, and the bare set_state
    // requeue edge (WI-4180, the audit's gap-(A) close), so an idle self-puller
    // awaits ONE leaf instead of composing them. Only fires for an item that
    // is actually pool-claimable (no assignee, claimable state). The wake is a
    // HINT: scheduler:get_next / work_items:claim_next stays the authoritative claim.
    params: [],
    describe:
      'A work item became CLAIMABLE (created unclaimed, claim released, last blocker cleared, or requeued by a bare set_state into a claimable state). payload carries {id, kind, severity, harness, title, state, reason} for payload_filter narrowing.',
    emitter: 'work-items-events (packages/operator-core/lib/work-items-events.ts) — emitWorkItemClaimableEvent',
    exists: true,
    replacesPoll: 'the idle ~60s scheduler:get_next re-poll (and the 3-leaf composed any-spec it replaced)',
    payloadFiltered: true,
  },
  // ── git-sync / session / services (Phase 2 additions) ─────────────────────
  {
    family: 'git-sync',
    keyTemplate: 'git-sync:committed:<sha>',
    params: [{ name: 'sha', required: false, describe: 'the local commit sha to wait for; omit to wake on the next git-sync commit' }],
    describe: 'git-sync committed the tree locally (no claim about bridged origin/staging egress).',
    emitter: 'git-sync action (packages/operator-core/lib/harness/git-sync/git-sync-events.ts)',
    exists: true, // P-102: git-sync-action fires `git-sync:committed[:<sha>]` on a synced tick
    replacesPoll: 'dev:pipeline_position (polling "is my edit committed yet")',
    sugar: 'git-sync:await',
    payloadFiltered: true,
  },
  {
    family: 'git-sync-egress',
    keyTemplate: 'git-sync:egressed:<sha>',
    params: [{ name: 'sha', required: false, describe: 'the remote staging head to wait for; omit to wake on the next proven GitHub-bridge egress' }],
    describe: 'The GitHub bridge proved canonical staging was pushed to origin/staging or was already at that sha.',
    emitter: 'git-sync GitHub bridge leg (packages/operator-core/lib/harness/git-sync/git-sync-action.ts)',
    exists: true,
    replacesPoll: 'git ls-remote origin refs/heads/staging / github_bridge.egress_head polling',
    payloadFiltered: true,
  },
  {
    family: 'session-compacted',
    keyTemplate: 'session:compacted:<owner>',
    params: [{ name: 'owner', required: true, describe: 'the ownerId whose compaction to wait on' }],
    describe: 'A session finished a /compact (WI-1804 alt post-compaction wake; a leader can await a member\'s compaction).',
    emitter: 'psu-pty-host.mjs (mode:compact step-4) → apps/operator/scripts/emit-session-compacted.ts → session-compacted-events.emitSessionCompactedEventAsync',
    exists: true, // P-103 LANDED: host wire (su-94b69) + the bridge CLI fire session:compacted:<owner> on compaction-complete
  },
  {
    family: 'service-up',
    keyTemplate: 'service:up:<name>',
    params: [{ name: 'name', required: true, describe: 'the service name, e.g. inference-gateway / substrate-sidecar / git-sync' }],
    describe: 'A monitored service transitioned to HEALTHY (block-until-recovered instead of re-polling).',
    emitter: 'service-health tick (packages/operator-core/lib/service-health-events.ts)',
    exists: true, // P-104: runServiceHealthTick fires `service:up:<name>` on a diffHealth up-transition
    replacesPoll: 'dev:service_health re-polling for recovery',
    sugar: 'service:await-up',
  },
  {
    family: 'service-down',
    keyTemplate: 'service:down:<name>',
    params: [{ name: 'name', required: true, describe: 'the service name' }],
    describe: 'A monitored service transitioned to UNHEALTHY.',
    emitter: 'service-health tick (packages/operator-core/lib/service-health-events.ts)',
    exists: true, // P-104: runServiceHealthTick fires `service:down:<name>` on a diffHealth down-transition
  },
  // ── Coordination / fleet (Phase 2 additions) ──────────────────────────────
  {
    family: 'plan-item',
    keyTemplate: 'plan-item:done:<slug>:<id>',
    params: [
      { name: 'slug', required: true, describe: 'the plan slug' },
      { name: 'id', required: true, describe: 'the plan item id, e.g. P-014' },
    ],
    describe: 'A plan item flipped to done.',
    emitter: 'plans:set-status (packages/operator-core/lib/agent-tools/plans/plan-item-events.ts)',
    exists: true, // P-105: setStatusOne fires `plan-item:done:<slug>:<id>` on a →done transition
    replacesPoll: 'polling plans:get for an item\'s status',
    sugar: 'plan-item:await',
  },
  {
    family: 'claim-released',
    keyTemplate: 'claim:released:<id>',
    params: [{ name: 'id', required: true, describe: 'the work-item / plan-item id whose claim to watch' }],
    describe: 'A claim was released (pick up orphaned/handed-back work the moment it frees).',
    emitter: 'releaseWorkItem → work-items-events (both work_items:release AND the stale-claim reaper)',
    exists: true, // P-105: releaseWorkItem fires `claim:released:<id>` (voluntary release + reaper)
  },
  {
    family: 'fleet-drained',
    keyTemplate: 'fleet:drained:<slug>',
    params: [{ name: 'slug', required: true, describe: 'the fleet slug' }],
    describe:
      'Every claimable item in a fleet\'s lanes is done, OR the fleet\'s claim-spec view is empty AND every member is idle (a leader can sleep until drain, then loop:end + scorecard).',
    emitter:
      'fleet-drained-events (packages/operator-core/lib/fleet-drained-events.ts) — fired from plans:set-status when a →done flip drains the plan; ALSO fired by fleet-idle-drain.ts (packages/operator-core/lib/scheduler/fleet-idle-drain.ts) on a scheduler:get_next miss when every fleet member is idle (P-006, WI-3763)',
    exists: true, // WI-1830: set-status fires `fleet:drained:<slug>` on the plan-drain edge
    sugar: 'fleet:await-drained',
  },
  // ── Fleet transitions a LEADER reacts to (P-009 / D-008 of
  //    fleet-leadership-continuity-and-actuation-2026-08-01).
  //
  //    These exist so leading is PUSH-based. `fleet:leader-brief` already derives
  //    every one of them, but nothing published them, so a leader had no key to
  //    park on and fell back to `loop:arm` on a short interval — the measured run
  //    behind that plan burned ~14 wakes, mostly near-noops, and still took up to
  //    3 minutes to notice a released claim.
  //
  //    Slug LAST (`fleet:<transition>:<slug>`), uniform with `fleet:drained:<slug>`
  //    above and NOT the `fleet:<slug>:<transition>` the plan text sketched:
  //    familyKeyPrefix truncates a template at its first placeholder, so a
  //    slug-first template would register the prefix `fleet:` and match EVERY
  //    `fleet:*` key — including typos — silently disarming the EI-10870 orphan
  //    guard for the whole namespace.
  //
  //    P-009's fifth transition, `idle-with-claimable`, is deliberately ABSENT: the
  //    existing global `work-item:claimable` family already serves it and is
  //    genuinely payload-filtered, so a leader parks on it with
  //    `payload_filter: { plan: { eq: '<slug>' } }`. A fleet-scoped twin would
  //    duplicate an emission that already fires.
  {
    family: 'fleet-member-dead',
    keyTemplate: 'fleet:member-dead:<slug>',
    params: [{ name: 'slug', required: true, describe: 'the fleet slug' }],
    describe:
      "A member of this fleet reached a CONFIRMED-dead liveness verdict (sessionState 'ended') — the leader can reclaim its claims and relaunch it. Fires on the CROSSING only: never on a first sighting, never again while the member stays dead, and never for the unconfirmed 'draining'/'suspect' verdicts (WI-4400 requires a wake confirmation before assuming death).",
    emitter:
      'fleet-transition-events (packages/operator-core/lib/fleet-transition-events.ts) — detected by the periodic fleet-transition sweep against the previous roster snapshot',
    exists: true,
    replacesPoll: 'polling fleet:leader-brief / fleet:assignments for member liveness',
  },
  {
    family: 'fleet-context-critical',
    keyTemplate: 'fleet:context-critical:<slug>',
    params: [{ name: 'slug', required: true, describe: 'the fleet slug' }],
    describe:
      "A member of this fleet crossed INTO critical context pressure — compaction is imminent, so the leader can force a checkpoint (fleet:require-checkpoint) before state is at risk. Crossing-only, like fleet:member-dead.",
    emitter:
      'fleet-transition-events (packages/operator-core/lib/fleet-transition-events.ts) — detected by the periodic fleet-transition sweep against the previous roster snapshot',
    exists: true,
    replacesPoll: 'polling fleet:leader-brief for each member contextPressure bucket',
  },
  {
    family: 'fleet-claim-released',
    keyTemplate: 'fleet:claim-released:<slug>',
    params: [{ name: 'slug', required: true, describe: 'the fleet slug' }],
    describe:
      "A member of this fleet released a work-item claim — work is back in the pool for the leader to re-place. The fleet-scoped counterpart of the id-scoped `claim:released:<id>`: use THIS one when you do not know which item will free next (a leader), and that one when you are waiting on a SPECIFIC item (a delegator).",
    emitter:
      'fleet-transition-events, co-fired from releaseWorkItem alongside claim:released:<id> (packages/operator-core/lib/work-items.ts)',
    exists: true,
    replacesPoll: 'polling fleet:assignments for a claim that dropped',
  },
  {
    family: 'fleet-item-completed',
    keyTemplate: 'fleet:item-completed:<slug>',
    params: [{ name: 'slug', required: true, describe: 'the fleet slug' }],
    describe:
      "A member of this fleet settled a work-item — the leader can feed it more work or re-judge burn-down. The fleet-scoped counterpart of the id-scoped `work-item:done:<id>`: use THIS one when you do not know which item will finish next (a leader), and that one when awaiting a SPECIFIC child (a delegator).",
    emitter:
      'fleet-transition-events, co-fired from emitWorkItemSettledEvents alongside work-item:done:<id> (packages/operator-core/lib/work-items-events.ts)',
    exists: true,
    replacesPoll: 'polling fleet:leader-brief for burn-down delta',
  },
  {
    family: 'goal-drain-dead',
    keyTemplate: 'goal:drain-dead:<goalId>',
    params: [{ name: 'goalId', required: true, describe: 'the goal whose drain fleet you hold' }],
    describe:
      "The drain fleet DECLARED for this goal is gone — it was declared but has no live holders, so nothing is draining the goal any more. ⚠ Fires ONLY for a fleet that was actually declared and then died: a goal that never declared one (reason `no-drain-fleet-declared`) is reported but deliberately does NOT emit, because a waiter parked here is asking to hear its fleet died, not to be nagged about paperwork. The watchdog never auto-relaunches — standing a fleet back up is the goal holder's authority.",
    emitter:
      'goal-drain-fleet-watchdog (packages/operator-core/lib/system-health/goal-drain-fleet-watchdog.ts, defaultEmitDrainDead)',
    exists: true,
    replacesPoll: 'polling goals:get / fleet:status to notice the drain fleet vanished',
  },
  // ── Spawn admission (D-004: over-ceiling queue + await, never silent-drop) ──
  {
    family: 'spawn-slot',
    keyTemplate: 'spawn-slot:freed:<workspace>',
    // EI-13072: the emitter has fired this key for a long time (announceSpawnSlotFreed
    // on every spawn completion + the reclaim sweep + boot reconcile), and the
    // over-ceiling cup:spawn rejection ADVISES awaiting it — but the family was never
    // registered here, so the EI-10870 orphan-guard flagged every such await
    // `unknown_event_key` ("nothing will ever fire it — can only TIME OUT"), which was
    // FALSE, and events:catalog couldn't surface the key at all. Registering the
    // family (the emitter already exists) both silences the false warning and makes
    // the sanctioned recovery discoverable. The workspace is IN the key, so a wake is
    // unambiguously for that workspace's waiters — not payload_filtered; but the wake
    // is a BROADCAST (re-check-on-wake fairness, not a granted ticket): retry the
    // spawn on wake and re-check the ceiling.
    params: [
      {
        name: 'workspace',
        required: true,
        describe: 'the workspace whose spawn ceiling you are queued behind (the awaitEvent an over-ceiling cup:spawn rejection returns)',
      },
    ],
    describe:
      'A spawn slot FREED in a workspace — a spawn completed (done/failed/cancelled) or the reclaim sweep freed orphaned rows. Broadcast to all over-ceiling waiters, which re-check the ceiling on retry (re-check-on-wake fairness, not a granted ticket).',
    emitter:
      'operator-spawn announceSpawnSlotFreed (packages/operator-core/lib/fleet/operator-spawn.ts) + the reclaim sweep (packages/operator-core/lib/dbos/in-process-periodic.ts) + boot reconcile (packages/operator-core/lib/fleet/spawn-reclaim.ts)',
    exists: true,
    replacesPoll: 'busy-waiting / retrying cup:spawn on a loop after an over-ceiling (D-004) rejection',
  },
  // ── Coordination / session lifecycle ──────────────────────────────────────
  // EI-18676056143796303: these families have emitted for a long time but were
  // never REGISTERED here, so the EI-10870 orphan guard reported an await on them
  // as `unknown_event_key` — "nothing in this system will ever fire it and this
  // await can only TIME OUT" — which is false and maximally actionable in the
  // WRONG direction. The live case was `coord:inbox-wake:<ownerId>`: the single
  // most-fired key in the whole system (8,989 fires across 118 owners at filing
  // time), and the mechanism that rescues a stranded agent — an agent that
  // believed the warning and re-parked on something else would strand itself,
  // precisely the failure the inbox-wake exists to prevent. Every entry below was
  // grounded against BOTH its emit site (cited in `emitter`) and a non-zero
  // harness_shared.event_key_fires row, per this file's grounding rule.
  {
    family: 'inbox-wake',
    keyTemplate: 'coord:inbox-wake:<ownerId>',
    params: [{ name: 'ownerId', required: true, describe: "the agent ownerId to wake — only THAT owner ever watches this key (never a broadcast)" }],
    describe:
      'A directed message / dispatch landed for ONE agent — the always-armed park key every live session holds, and the key `coord:send { wake:true }` / `coord:dispatch` / `coord:wake-queue` fire to re-invoke a sleeping agent.',
    emitter:
      'inbox-wake fan (packages/operator-core/lib/agent-tools/coordination/inbox-wake.ts — inboxWakeKey/COORD_INBOX_WAKE_PREFIX) via coord:send{wake}, coord:dispatch, coord:wake-queue',
    exists: true,
    replacesPoll: 'coord:inbox re-polling for a directed message',
  },
  {
    family: 'coord-receipt',
    keyTemplate: 'coord:receipt:<msgId>',
    params: [{ name: 'msgId', required: true, describe: 'the coord msg_id whose federated delivery receipt to wait on' }],
    describe: "A federated peer returned a DELIVERY RECEIPT for one of your coord messages (delivered, or quarantined with a reason in the payload).",
    emitter:
      'hyperbee coord-message projection (packages/operator-core/lib/sync/hyperbee/projections/coord-message.ts) — the fed_event pass-through on the receiving peer',
    exists: true,
  },
  {
    family: 'work-item-duplicate-settled',
    keyTemplate: 'work-item:duplicate-settled:<id>',
    params: [{ name: 'id', required: true, describe: 'the CANONICAL work-item id (the one your item duplicates)' }],
    describe: 'The canonical item that YOUR item duplicates has settled — targeted at each duplicate-holder\'s assignee, not a subscriber fan-out.',
    emitter: 'work-items-events (packages/operator-core/lib/work-items-events.ts) — the `duplicates` edge fan',
    exists: true,
  },
  {
    family: 'autoloop-release-pass',
    keyTemplate: 'release-pass:autoloop',
    params: [],
    describe:
      'The autoloop release-readiness monitor returned GO. One-shot by design: it NEVER fires on go:false, so a wake means the verdict really is GO (payload = the verdict).',
    emitter:
      'autoloop-release-readiness monitor (packages/operator-core/lib/harness/routines/autoloop-release-readiness-action.ts — AUTOLOOP_RELEASE_PASS_EVENT_KEY)',
    exists: true,
    replacesPoll: 'polling the autoloop-release-readiness-verdict fact for a GO',
  },
  {
    family: 'escalation-resolved',
    keyTemplate: 'escalation:resolved:<msgId>',
    params: [{ name: 'msgId', required: true, describe: 'the escalation / spawn-request msg_id you raised' }],
    describe: 'An escalation you raised was RESOLVED (or a spawn request was approved) — wake instead of re-polling for the verdict.',
    emitter:
      'coord:resolve (packages/operator-core/lib/agent-tools/coordination/tools/resolve.ts) + spawn approve (packages/operator-core/lib/agent-tools/spawn/approve.ts)',
    exists: true,
    replacesPoll: 'coord:escalations re-polling for a verdict',
  },
  {
    family: 'conversation-answered',
    keyTemplate: 'conversation:answered:<conversationId>',
    params: [{ name: 'conversationId', required: true, describe: 'the conversation id you are waiting on an answer for' }],
    describe: 'A conversation you opened received an ANSWER.',
    emitter: 'conversations:answer (packages/operator-core/lib/agent-tools/coordination/conversations.ts)',
    exists: true,
    replacesPoll: 'conversations:get re-polling for an answer',
  },
  {
    family: 'handoff-accepted',
    keyTemplate: 'handoff:accepted:<acceptMsgId>',
    params: [{ name: 'acceptMsgId', required: true, describe: 'the accept msg_id the handoff returned' }],
    describe: 'A work handoff you offered was ACCEPTED by the receiver.',
    emitter: 'coord:handoff (packages/operator-core/lib/agent-tools/coordination/tools/handoff.ts)',
    exists: true,
    replacesPoll: 'coord:handoffs re-polling for pickup',
  },
  {
    family: 'plan-draft-ready',
    keyTemplate: 'plan:draft-ready:<slug>',
    params: [{ name: 'slug', required: true, describe: 'the plan slug being drafted' }],
    describe: 'An architect plan DRAFT finished and is ready to read/ratify.',
    emitter: 'architect plan-block handler (packages/operator-core/lib/agent-tools/architect/plan-block-handler.ts)',
    exists: true,
    replacesPoll: 'plans:get re-polling for a draft to appear',
  },
  {
    family: 'rate-limit-exhausted',
    keyTemplate: 'rate-limit:exhausted:<accountId>',
    params: [{ name: 'accountId', required: true, describe: 'the account id that tipped into sustained rate-limiting' }],
    describe: 'An account tipped into SUSTAINED rate-limiting (distinct from the transient rate-limit:paused pause).',
    emitter: 'account-pool-store (packages/operator-core/lib/deployment/account-pool-store.ts)',
    exists: true,
  },
  // ── pot-git federation gossip ─────────────────────────────────────────────
  {
    family: 'pot-git-ref-announce',
    keyTemplate: 'pot-git:ref-announce',
    params: [],
    describe: 'A federated peer ANNOUNCED a git ref (pot-git gossip). Global key — check the payload for the repo/ref/peer.',
    emitter: 'pot-git ref-announce (packages/operator-core/lib/sync/pot-git/ref-announce.ts — REF_ANNOUNCE_EVENT_KEY)',
    exists: true,
    payloadFiltered: true,
  },
  {
    family: 'pot-git-staging-advance',
    keyTemplate: 'pot-git:staging-advance',
    params: [],
    describe: "A federated peer's signed staging-advance landed (pot-git gossip). Global key — check the payload for the device/epoch/sha.",
    emitter: 'pot-git staging-advance (packages/operator-core/lib/sync/pot-git/staging-advance.ts — STAGING_ADVANCE_EVENT_KEY)',
    exists: true,
    payloadFiltered: true,
  },
  // ── Rate limits (already emit) ────────────────────────────────────────────
  {
    family: 'rate-limit-reset',
    keyTemplate: 'rate-limit:reset:<scope>',
    params: [{ name: 'scope', required: true, describe: 'the rate-limit scope, e.g. gym-judge' }],
    describe: 'A rate-limit pause ENDED for a scope.',
    emitter: 'gym rate-pause-events (packages/operator-core/lib/gym/rate-pause-events.ts)',
    exists: true,
  },
  {
    family: 'rate-limit-paused',
    keyTemplate: 'rate-limit:paused:<scope>',
    params: [{ name: 'scope', required: true, describe: 'the rate-limit scope' }],
    describe: 'A scope ENTERED a rate-limit pause.',
    emitter: 'gym rate-pause-events',
    exists: true,
  },
] as const;

/** Lookup one family by id. */
export function catalogEntry(family: string): EventCatalogEntry | undefined {
  return EVENT_CATALOG.find((e) => e.family === family);
}

/** All families that carry a sugar verb (for the catalog + guidance cross-links). */
export function sugaredFamilies(): EventCatalogEntry[] {
  return EVENT_CATALOG.filter((e) => e.sugar);
}

/**
 * Build a concrete event key from a family + params. Interpolates every `<name>`
 * placeholder; a MISSING required param throws (a sugar verb that can't build its
 * key must fail loudly, never register an await on a malformed key). An OMITTED
 * optional param collapses its whole `:<name>` segment — so `buildKey('deploy', {})`
 * yields the global `release:deployed`, matching the real global emit (D-005).
 */
export function buildKey(family: string, params: Record<string, string | number | undefined> = {}): string {
  const entry = catalogEntry(family);
  if (!entry) throw new Error(`events:catalog — unknown family '${family}'`);
  let key = entry.keyTemplate;
  for (const p of entry.params) {
    const raw = params[p.name];
    const has = raw !== undefined && raw !== null && String(raw).length > 0;
    if (!has) {
      if (p.required) throw new Error(`events:catalog — family '${family}' requires param '${p.name}'`);
      key = key.replace(`:<${p.name}>`, ''); // optional + omitted → collapse to the global key
      continue;
    }
    key = key.replace(`<${p.name}>`, String(raw));
  }
  return key;
}

/**
 * EI-9000 (fleet-reliability-verification-2026-07-10 P-005): the static LIKE-prefix
 * that matches every concrete key a family can produce, whether or not its optional
 * trailing param is supplied — mirrors buildKey's collapse rule (`familyKeyPrefix`
 * for 'deploy' matches BOTH the global `release:deployed` and the scoped
 * `release:deployed:<sha>`). A no-param family's prefix IS its literal key. This is
 * the join key events:catalog uses to attach a live-awaiter COUNT per family
 * (countActiveAwaitsByPrefixes in ./store) — kept here, next to the template it
 * derives from, so the two can never drift apart (D-005: one place per key shape).
 */
export function familyKeyPrefix(entry: EventCatalogEntry): string {
  const idx = entry.keyTemplate.indexOf('<');
  if (idx === -1) return entry.keyTemplate;
  let prefix = entry.keyTemplate.slice(0, idx);
  if (prefix.endsWith(':')) prefix = prefix.slice(0, -1);
  return prefix;
}

/**
 * EI-10870 — the ORPHAN-AWAIT guard: does ANY known family emit this concrete key?
 *
 * `events:await` accepts an arbitrary key string, so an invented or mistyped key
 * registers happily and can then only ever TIME OUT. That failure is invisible by
 * construction — a lost wake fails in the SAFE-LOOKING direction (the agent simply
 * waits), so nothing raises an error. Live proof: `overwatch:surface-landed` had 14
 * settled awaits, 0 real fires ever, and appears NOWHERE in the tree. The catalog
 * always knew every family's emitter; it was just never consulted at await time.
 *
 * Matches by family PREFIX, not exact string — a templated key must match every
 * concrete instantiation (`release:deployed:<sha>` → any sha). Mirrors buildKey's
 * collapse rule via familyKeyPrefix, so the global (`release:deployed`) and the
 * scoped (`release:deployed:abc123`) both resolve to the `deploy` family.
 *
 * Pass the MERGED catalog (builtin + installed `provides.events`) so a key emitted
 * by an installed pack is never misreported as an orphan.
 */
export function keyMatchesCatalog(
  key: string,
  entries: readonly EventCatalogEntry[] = EVENT_CATALOG,
): boolean {
  const k = String(key ?? '').trim();
  if (!k) return false;
  return entries.some((e) => {
    const prefix = familyKeyPrefix(e);
    return prefix.length > 0 && (k === prefix || k.startsWith(`${prefix}:`));
  });
}

/**
 * EI-13089 — the FAMILY-PREFIX-MISSING-REQUIRED-PARAM guard.
 *
 * `familyKeyPrefix` (and therefore `keyMatchesCatalog`) strips a template down to
 * the text before its FIRST placeholder regardless of whether that placeholder is
 * required or optional — correct for an optional param (the bare prefix IS the
 * real global key `buildKey` collapses to, e.g. `release:deployed`), but WRONG for
 * a required one: no emitter ever fires the bare literal (only the concretely-
 * interpolated form does, e.g. `work-item:done:<id>`), so `keyMatchesCatalog`
 * reports the bare prefix as a known/matching key and the EI-10870 orphan guard
 * stays silent — an await on it can then only ever TIME OUT, silently, in the
 * safe-looking direction. Live case: `events:await { event: 'release:deployed' }`
 * was armed intending the per-sha deploy wake but the caller had actually meant a
 * family whose FIRST param is required in other families (`work-item:done`,
 * `lock:grant`, `plan-run:finished`, …) — this guard is the general fix.
 *
 * Returns the matched family + its first (required) param when `key` is EXACTLY a
 * family's prefix and that family's first placeholder is required; `undefined`
 * when `key` doesn't look like a bare required-param prefix (including when the
 * first placeholder is optional — that bare key is legitimate and already handled
 * by `keyMatchesCatalog`).
 */
export function findRequiredParamPrefixMatch(
  key: string,
  entries: readonly EventCatalogEntry[] = EVENT_CATALOG,
): { entry: EventCatalogEntry; param: EventKeyParam } | undefined {
  const k = String(key ?? '').trim();
  if (!k) return undefined;
  for (const e of entries) {
    const prefix = familyKeyPrefix(e);
    if (prefix.length === 0 || k !== prefix) continue;
    const firstParam = e.params[0];
    if (firstParam?.required) return { entry: e, param: firstParam };
  }
  return undefined;
}

/**
 * P-004 / D-002 — the ZERO-PARAM-FAMILY-WITH-A-SUFFIX guard. The exact INVERSE of
 * {@link findRequiredParamPrefixMatch} above, and the other half of the same hole.
 *
 * {@link keyMatchesCatalog} answers true for `k === prefix || k.startsWith(prefix + ':')`.
 * That prefix test is deliberately PERMISSIVE (a templated family must match every
 * concrete instantiation), but the EI-10870 orphan guard consumes its `true` as PROOF
 * THAT AN EMITTER EXISTS. For a family declaring NO params, no emitter ever fires a
 * suffixed form — so every suffix is structurally dead, and the orphan guard stays
 * silent about it. Absence of a warning then reads as a positive verdict, which is
 * precisely the shape this plan exists to remove.
 *
 * Live cost before this guard: 42 awaits from 6 distinct agents, 100% timeout, ZERO
 * real fires ever — `work-item:claimable:*` (32), `work-item:claimable:p2p-release-verify-lane`
 * (9), `work-item:claimable:papercusp:backlog-drain` (1) — while the canonical bare
 * `work-item:claimable` ran 1913 awaits / 1221 real fires. The mistake is a REASONABLE
 * generalisation: every neighbouring family DOES take a suffix (`work-item:done:<id>`,
 * `work-item:unblocked:<id>`, `release:green:<pipeline>`), and scoping guidance points at
 * `payload_filter` — which those agents applied to the KEY instead.
 *
 * Handles the pattern form too, which is why this is ONE guard rather than two: for a
 * glob only the literal head before the first `*` is decidable, and
 * `work-item:claimable:*` → `work-item:claimable:` still strictly extends the family
 * prefix. A glob whose literal head stops short of the separator (`work-item:claimable*`)
 * legitimately matches the bare key and is NOT flagged; a glob starting with `*` is
 * undecidable and is likewise left alone.
 *
 * Returns the offended family when `key` strictly extends a zero-param family's prefix;
 * `undefined` otherwise. Never throws. The caller WARNS — never rejects (EI-10870's
 * discipline: a false "nothing emits this" is worse than no warning, because it trains
 * the warning out).
 */
export function findZeroParamSuffixMismatch(
  key: string,
  entries: readonly EventCatalogEntry[] = EVENT_CATALOG,
): { entry: EventCatalogEntry; prefix: string } | undefined {
  const raw = String(key ?? '').trim();
  if (!raw) return undefined;
  // For a PATTERN, only the literal head before the first glob `*` is decidable —
  // anything at or after the wildcard could match a legitimate concrete key.
  const star = raw.indexOf('*');
  const literal = star === -1 ? raw : raw.slice(0, star);
  if (!literal) return undefined;
  for (const e of entries) {
    // A declared param means a suffix is exactly what the family expects.
    if (e.params.length > 0) continue;
    // Defensive: a template carrying a placeholder without a declared param is a
    // catalog authoring bug, not a dead key — say nothing rather than mislead.
    if (e.keyTemplate.includes('<')) continue;
    const prefix = familyKeyPrefix(e);
    if (prefix.length === 0) continue;
    if (literal.startsWith(`${prefix}:`)) return { entry: e, prefix };
  }
  return undefined;
}

/**
 * EI-18701276960172209 — a catalog-based "did you mean…?" suggestion for a key
 * that matches NO family ({@link keyMatchesCatalog} false). A self-declared
 * announced gate is deliberately exempted from the orphan-await guard above (an
 * announced-but-unfired gate is normally legitimate — a hand-minted pair-emit key
 * is expected to have no catalog entry yet), but that exemption also hid the live
 * incident this closes: an agent declared `green-gate-verdict` expecting the
 * green-checkpoint pipeline to fire it, when the REAL catalogued keys were
 * `release:green:<pipeline>` / `green-checkpoint:red:<pipeline>` — nothing was
 * ever going to emit the invented name, and nothing said so.
 *
 * Deliberately NOT a fuzzy edit-distance search (that machinery already exists
 * for near-identical typos via {@link findNearMissKeys} in ./store, which compares
 * against other ACTIVE rows, not the static catalog). This is a much cheaper,
 * good-enough heuristic for the common case: split both the awaited key and each
 * family's prefix into lowercase alnum tokens, and suggest any family that shares
 * at least one token of length >= 4 (short tokens like "id"/"ws" are too generic
 * to mean anything). `green-gate-verdict` → tokens {green, gate, verdict}; the
 * `release:green` family's prefix tokenizes to {release, green} → shared "green"
 * → suggested. Returns up to `limit` matched family PREFIXES (not full templates),
 * deduped, in registry order — never throws, worst case is an empty array.
 */
export function findCatalogNearMiss(
  key: string,
  entries: readonly EventCatalogEntry[] = EVENT_CATALOG,
  limit = 3,
): string[] {
  const tokenize = (s: string): Set<string> =>
    new Set(
      String(s ?? '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 4),
    );
  const keyTokens = tokenize(key);
  if (keyTokens.size === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const prefix = familyKeyPrefix(e);
    if (!prefix || seen.has(prefix)) continue;
    const prefixTokens = tokenize(prefix);
    let overlaps = false;
    for (const t of prefixTokens) {
      if (keyTokens.has(t)) {
        overlaps = true;
        break;
      }
    }
    if (overlaps) {
      seen.add(prefix);
      out.push(prefix);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * INSTALLED TIER (cupboard-public-release-2026-07-12 P-006, D-003).
 *
 * D-003: "what good is an event without a tool" — events are a DEPENDENCY AXIS,
 * so a distribution unit can DECLARE the event families it provides
 * (`provides.events` in its manifest — P-005 / WI-4521). This tier folds those
 * declarations into the catalog, so `events:catalog` answers "what can I wait on?"
 * for the WHOLE host — builtin families AND whatever the installed packs/plugins
 * bring — rather than only the families this binary happens to hard-code.
 *
 * P-005 deliberately shaped `ManifestProvidedEvent` as a structural SUBSET of
 * `EventCatalogEntry` (family / keyTemplate / params / describe), so this is a
 * LIFT, not a translation.
 *
 * PROVENANCE, not a flat union: every row says where it came from (`builtin` vs
 * `installed:<unit>`). An agent that sees an awaitable key must be able to tell
 * whether it is a platform guarantee or a third-party pack's promise — those carry
 * very different trust and lifetime.
 *
 * BUILTIN ALWAYS WINS A FAMILY-ID COLLISION. This is a safety rule, not a
 * tie-break preference. The sugar verbs resolve their key TEMPLATES through this
 * registry by family id (`buildKey`), so a pack that re-declared `deploy` with its
 * own keyTemplate would silently re-point `deploy:await` at a key nothing emits —
 * and an agent awaiting it would hang FOREVER (a wait that never fires is the worst
 * failure this subsystem has). So a colliding installed family is REFUSED, never
 * merged. Collisions are reported, not swallowed: a silently-dropped declaration is
 * how a pack author ends up debugging a family that "just doesn't appear".
 *
 * The merge is PURE (no I/O) and does not mutate EVENT_CATALOG — mirroring
 * `assemblePackCatalog`'s pure-assembler/derive-wrapper split. Keeping the module
 * const immutable matters: it is process-global, and a mutable registry that grows
 * with whatever was installed last is unreproducible.
 * ───────────────────────────────────────────────────────────────────────────── */

/** Where a family came from. `installed:<unit>` names the declaring unit. */
export type EventProvenance = 'builtin' | `installed:${string}`;

/**
 * The minimal `provides.events[]` surface the merge reads — structurally the
 * plugin-sdk's `ManifestProvidedEvent` (P-005), re-declared rather than imported.
 * This follows pack-catalog's `InstalledUnitInput` convention: operator-core has no
 * plugin-sdk dependency, and the merge stays pure and dependency-free. Fields are
 * `unknown` because a manifest is THIRD-PARTY data: P-005 validates it at load time,
 * but this function must not assume that ran (it is also fed by tests and by the
 * Cupboard's not-yet-installed listings).
 */
export interface ManifestEventDeclaration {
  family?: unknown;
  keyTemplate?: unknown;
  params?: unknown;
  describe?: unknown;
}

/** One installed unit's declared event families. */
export interface InstalledUnitEvents {
  /** Unit name as the pack catalog knows it, e.g. `@papercupai/repomix`. */
  unit: string;
  events?: ManifestEventDeclaration[] | null;
}

/** A family the merge REFUSED, and why — surfaced so a drop is never silent. */
export interface EventFamilyCollision {
  family: string;
  /** The unit whose declaration was refused. */
  unit: string;
  /** What already held the family id. */
  heldBy: EventProvenance;
  reason: string;
}

/** A catalog entry plus where it came from. */
export interface MergedEventCatalogEntry extends EventCatalogEntry {
  provenance: EventProvenance;
}

export interface MergedEventCatalog {
  entries: MergedEventCatalogEntry[];
  collisions: EventFamilyCollision[];
}

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/** Lift a manifest's `params` into catalog `EventKeyParam`s, dropping malformed ones. */
function liftParams(raw: unknown): EventKeyParam[] {
  if (!Array.isArray(raw)) return [];
  const out: EventKeyParam[] = [];
  for (const p of raw) {
    if (p == null || typeof p !== 'object') continue;
    const { name, required, describe } = p as Record<string, unknown>;
    if (!isNonEmptyString(name)) continue;
    out.push({
      name: name.trim(),
      required: required === true,
      describe: isNonEmptyString(describe) ? describe : '',
    });
  }
  return out;
}

/**
 * Merge installed units' declared event families over the builtin registry.
 *
 * Order is stable and meaningful: builtin families first (they are the platform
 * guarantees and the ones a sugar verb can resolve), then installed families in
 * unit order. A family id already taken — by a builtin, or by an earlier unit — is
 * REFUSED and recorded in `collisions` (see the header note: shadowing `deploy`
 * would strand every `deploy:await` on a key nothing fires).
 *
 * `exists` is true for an installed family: unlike a builtin `exists:false` (a key
 * this repo has not yet wired an emitter for), a unit that declares `provides.events`
 * and is INSTALLED is asserting its runtime fires that key — that assertion IS the
 * unit's contract, and P-007's resolver is what checks a REQUIRED family is actually
 * provided by something.
 */
export function mergeInstalledEventCatalog(
  installed: readonly InstalledUnitEvents[] = [],
  builtin: readonly EventCatalogEntry[] = EVENT_CATALOG,
): MergedEventCatalog {
  const entries: MergedEventCatalogEntry[] = builtin.map((e) => ({ ...e, provenance: 'builtin' as const }));
  const held = new Map<string, EventProvenance>(entries.map((e) => [e.family, e.provenance]));
  const collisions: EventFamilyCollision[] = [];

  for (const unit of installed) {
    if (!isNonEmptyString(unit?.unit) || !Array.isArray(unit.events)) continue;
    const provenance: EventProvenance = `installed:${unit.unit}`;
    for (const decl of unit.events) {
      if (decl == null || typeof decl !== 'object') continue;
      const family = isNonEmptyString(decl.family) ? decl.family.trim() : '';
      const keyTemplate = isNonEmptyString(decl.keyTemplate) ? decl.keyTemplate.trim() : '';
      // A declaration missing either half cannot be awaited OR displayed. P-005's
      // load-time validator rejects these, so reaching here means an unvalidated
      // path (a test, or a Cupboard listing) — skip rather than emit a broken row.
      if (!family || !keyTemplate) continue;

      const heldBy = held.get(family);
      if (heldBy) {
        collisions.push({
          family,
          unit: unit.unit,
          heldBy,
          reason:
            heldBy === 'builtin'
              ? `family "${family}" is a BUILTIN — an installed unit may not shadow it (the sugar verbs resolve this family id to the builtin key template; re-pointing it would strand every await on a key nothing emits). Rename the family in your manifest.`
              : `family "${family}" is already declared by ${heldBy} — family ids must be unique across installed units. Rename the family in your manifest.`,
        });
        continue;
      }

      held.set(family, provenance);
      entries.push({
        family,
        keyTemplate,
        params: liftParams(decl.params),
        describe: isNonEmptyString(decl.describe) ? decl.describe : `Provided by ${unit.unit}.`,
        emitter: unit.unit,
        // An installed unit asserting provides.events IS asserting its runtime fires
        // the key — that is the unit's contract (P-007 validates the REQUIRES side).
        exists: true,
        provenance,
      });
    }
  }

  return { entries, collisions };
}

/** A render-ready row for the events:catalog tool (stable, JSON-friendly shape). */
export interface CatalogRow {
  family: string;
  key: string;
  awaitable_now: boolean;
  await_example: string;
  describe: string;
  emitter: string;
  /** `builtin` | `installed:<unit>` (P-006) — a platform guarantee vs a pack's promise. */
  provenance: EventProvenance;
  replaces_poll?: string;
  sugar?: string;
  payload_filtered?: boolean;
  /** EI-9000: live (unfired, uncancelled) events:await registrations matching this
   *  family RIGHT NOW — "is anyone actually listening" at read time. Filled in by
   *  the events:catalog tool handler (a DB read renderCatalog itself stays free of);
   *  absent here means the caller didn't ask for it. */
  live_awaiters?: number;
}

/**
 * Project the catalog into render rows for the events:catalog tool.
 *
 * Pass `installed` (units' `provides.events`) to fold in the installed tier (P-006);
 * omit it for the builtin-only catalog — the pre-P-006 behaviour, byte-identical
 * apart from the new `provenance` field, so every existing caller keeps working.
 */
export function renderCatalog(installed: readonly InstalledUnitEvents[] = []): CatalogRow[] {
  const { entries } = mergeInstalledEventCatalog(installed);
  return entries.map((e) => ({
    family: e.family,
    key: e.keyTemplate,
    awaitable_now: e.exists,
    await_example: `events:await { event: "${e.keyTemplate}" }`,
    describe: e.describe,
    emitter: e.emitter,
    provenance: e.provenance,
    ...(e.replacesPoll ? { replaces_poll: e.replacesPoll } : {}),
    ...(e.sugar ? { sugar: e.sugar } : {}),
    ...(e.payloadFiltered ? { payload_filtered: true } : {}),
  }));
}
