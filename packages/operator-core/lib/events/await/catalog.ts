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
  // ── git-sync / session / services (Phase 2 additions) ─────────────────────
  {
    family: 'git-sync',
    keyTemplate: 'git-sync:committed:<sha>',
    params: [{ name: 'sha', required: false, describe: 'the commit sha to wait for; omit to wake on the next git-sync commit' }],
    describe: 'git-sync committed the tree (your left-in-tree edit is now a commit on origin/staging).',
    emitter: 'git-sync action (packages/operator-core/lib/harness/git-sync/git-sync-events.ts)',
    exists: true, // P-102: git-sync-action fires `git-sync:committed[:<sha>]` on a synced tick
    replacesPoll: 'dev:pipeline_position (polling "is my edit committed yet")',
    sugar: 'git-sync:await',
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

/** A render-ready row for the events:catalog tool (stable, JSON-friendly shape). */
export interface CatalogRow {
  family: string;
  key: string;
  awaitable_now: boolean;
  await_example: string;
  describe: string;
  emitter: string;
  replaces_poll?: string;
  sugar?: string;
  payload_filtered?: boolean;
  /** EI-9000: live (unfired, uncancelled) events:await registrations matching this
   *  family RIGHT NOW — "is anyone actually listening" at read time. Filled in by
   *  the events:catalog tool handler (a DB read renderCatalog itself stays free of);
   *  absent here means the caller didn't ask for it. */
  live_awaiters?: number;
}

/** Project the whole catalog into render rows for the events:catalog tool. */
export function renderCatalog(): CatalogRow[] {
  return EVENT_CATALOG.map((e) => ({
    family: e.family,
    key: e.keyTemplate,
    awaitable_now: e.exists,
    await_example: `events:await { event: "${e.keyTemplate}" }`,
    describe: e.describe,
    emitter: e.emitter,
    ...(e.replacesPoll ? { replaces_poll: e.replacesPoll } : {}),
    ...(e.sugar ? { sugar: e.sugar } : {}),
    ...(e.payloadFiltered ? { payload_filtered: true } : {}),
  }));
}
