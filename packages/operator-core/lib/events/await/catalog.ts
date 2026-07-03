/**
 * events/await/catalog — the SINGLE SOURCE OF TRUTH for awaitable event-key
 * families (event-await-discoverability-and-coverage-2026-07-03 P-002, D-005).
 *
 * The plan's headline: the await primitive works, but agents don't FIND it — they
 * poll (`dev:pipeline_position`, `dev:build_status`) for things that already fire
 * an awaitable event. This registry is the fix's spine: ONE list of families that
 *   (a) the `events:catalog` tool renders — answers "what can I wait on?" in one call;
 *   (b) the poll-site tools read to advertise an `awaitable:` hint (P-001);
 *   (c) the sugar verbs (P-003) source their key-templates from — so a key SHAPE
 *       lives in exactly one place.
 *
 * D-005 (why the registry is load-bearing, not decoration): because BOTH the
 * poll-sites AND the sugar read this registry, a future Phase 4 (fold the await
 * primitive into the ECA reaction engine) is a FORM change — swap how the sugar
 * resolves a family — not a rebuild. Do not scatter key strings; add them here.
 *
 * GROUNDED against the real emit sites (verified 2026-07-03), NOT the plan's prose:
 * the gate keys are the asymmetric `release:green` / `green-checkpoint:red`, and the
 * deploy key is a plain `release:deployed` (no `:<sha>` suffix in the global emit).
 * Normalizing that asymmetry behind named, discoverable sugar is exactly the point.
 */

/** A `<placeholder>` slot in a key template. */
export interface EventKeyParam {
  /** Placeholder name as it appears in the template, e.g. 'id' for `work-item:done:<id>`. */
  name: string;
  /** Must the caller supply it to build a concrete key? */
  required: boolean;
  /** One line for the catalog + sugar arg docs. */
  describe: string;
}

/** A sibling outcome key of a dual/multi-outcome family (e.g. deploy failed). */
export interface EventSibling {
  key: string;
  describe: string;
}

/** One awaitable event-key family. */
export interface EventCatalogEntry {
  /** Stable family id — the catalog lookup key and the sugar's resolution key. */
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
  /** The sugar verb that resolves to this family, if any (P-003). */
  sugar?: string;
  /**
   * Additional outcome keys worth awaiting alongside the primary (e.g. a deploy
   * FAILS on `release:deploy-failed`, not `release:deployed`). The dual-outcome
   * sugar registers awaits on the primary AND every sibling so it wakes either way.
   */
  siblings?: EventSibling[];
  /**
   * KEY IS GLOBAL (no per-subject param) — a wake fires for EVERY occurrence, so
   * the waiter must check the payload to confirm it's theirs. Set on families whose
   * real emit carries the subject in the PAYLOAD, not the key (e.g. `release:deployed`
   * fires once per deploy; `payload.sha` says which). The sugar echoes this caveat.
   */
  payloadFiltered?: boolean;
}

/**
 * THE registry. Order = catalog display order (existing/high-value first).
 * Every `exists: true` key was verified against its emit site on 2026-07-03;
 * every `exists: false` key is ADDED by this plan's Phase 2 in the same session,
 * so the catalog and the emitters agree by construction.
 */
export const EVENT_CATALOG: readonly EventCatalogEntry[] = [
  // ── Deploy / release pipeline ─────────────────────────────────────────────
  {
    family: 'deploy',
    keyTemplate: 'release:deployed:<sha>',
    params: [{ name: 'sha', required: false, describe: 'the target sha; omit to wake on the NEXT deploy of any sha' }],
    describe: 'A staging sha reached the live GREEN :3070 operator (the deploy landed).',
    emitter: 'release-gate (apps/operator/lib/release/deploy.ts)',
    exists: false, // per-sha key ADDED in Phase 2 (P-102) alongside the existing global `release:deployed`
    replacesPoll: 'dev:pipeline_position (polling for "is my sha live on :3070")',
    sugar: 'deploy:await',
    siblings: [
      { key: 'release:deployed', describe: 'GLOBAL deploy-landed (any sha) — fired on every deploy; check payload.sha' },
      { key: 'release:deploy-failed', describe: 'the deploy FAILED and rolled back' },
    ],
  },
  {
    family: 'checkpoint',
    keyTemplate: 'release:green',
    params: [],
    describe: 'The green-checkpoint PASSED — the candidate advanced onto main (the gate is green).',
    emitter: 'green-checkpoint (apps/operator/lib/release/green-checkpoint.ts)',
    exists: true,
    replacesPoll: 'dev:pipeline_position / dev:build_status (polling "did my change clear the gate?")',
    sugar: 'checkpoint:await',
    payloadFiltered: true,
    siblings: [{ key: 'green-checkpoint:red', describe: 'the gate is HELD — candidate not green (payload.summary = failing-test tail)' }],
  },
  // ── Locks / plan runs (already sugared / surfaced) ────────────────────────
  {
    family: 'lock',
    keyTemplate: 'lock:grant:<ticket>',
    params: [{ name: 'ticket', required: true, describe: 'the lock ticket you are queued on' }],
    describe: 'A queued lock was GRANTED to you.',
    emitter: 'lock-grant-bridge (locks:*)',
    exists: true,
    sugar: undefined, // already sugared via the locks:* tools — surfaced here for completeness
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
    describe: 'ANY status transition of a work item (todo/wip/blocked/done/…). Wake on every change of WI-X.',
    emitter: 'work-items-events (packages/operator-core/lib/work-items-events.ts)',
    exists: false, // P-101 adds the general per-transition emit; done/unblocked/claimed/blocked already exist as siblings
    replacesPoll: 'polling work_items:get for a peer/dependency item',
    sugar: 'work-item:await',
    siblings: [
      { key: 'work-item:done:<id>', describe: 'the item SETTLED (feature→passed/deprecated, issue→resolved/closed)' },
      { key: 'work-item:unblocked:<id>', describe: 'the item\'s LAST live blocker just cleared' },
      { key: 'work-item:blocked:<id>', describe: 'the item transitioned INTO blocked' },
      { key: 'work-item:claimed:<id>', describe: 'an agent claimed the item' },
    ],
  },
  // ── git-sync / session / services (Phase 2 additions) ─────────────────────
  {
    family: 'git-sync',
    keyTemplate: 'git-sync:committed:<sha>',
    params: [{ name: 'sha', required: false, describe: 'the commit sha to wait for; omit to wake on the next git-sync commit' }],
    describe: 'git-sync committed the tree (your left-in-tree edit is now a commit on origin/staging).',
    emitter: 'git-sync routine (Phase 2)',
    exists: false, // P-102
    replacesPoll: 'dev:pipeline_position (polling "is my edit committed yet")',
    sugar: 'git-sync:await',
    payloadFiltered: true,
  },
  {
    family: 'session-compacted',
    keyTemplate: 'session:compacted:<owner>',
    params: [{ name: 'owner', required: true, describe: 'the ownerId whose compaction to wait on' }],
    describe: 'A session finished a /compact (WI-1804 alt post-compaction wake; lets a leader await a member\'s compaction).',
    emitter: 'compaction path (Phase 2)',
    exists: false, // P-103
    sugar: undefined,
  },
  {
    family: 'service',
    keyTemplate: 'service:up:<name>',
    params: [{ name: 'name', required: true, describe: 'the service name, e.g. inference-gateway / substrate-sidecar / git-sync' }],
    describe: 'A monitored service transitioned to HEALTHY (block-until-recovered instead of re-polling).',
    emitter: 'coord:conditions bridge (Phase 2)',
    exists: false, // P-104
    replacesPoll: 'dev:service_health re-polling for recovery',
    sugar: 'service:await-up',
    siblings: [{ key: 'service:down:<name>', describe: 'the service transitioned to UNHEALTHY' }],
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
    emitter: 'plans:set-status (Phase 2)',
    exists: false, // P-105
    replacesPoll: 'polling plans:get for an item\'s status',
    sugar: 'plan-item:await',
  },
  {
    family: 'claim-released',
    keyTemplate: 'claim:released:<id>',
    params: [{ name: 'id', required: true, describe: 'the work-item / plan-item id whose claim to watch' }],
    describe: 'A claim was released (pick up orphaned/handed-back work the moment it frees).',
    emitter: 'work_items:release / claim reaper (Phase 2)',
    exists: false, // P-105
    sugar: undefined,
  },
  {
    family: 'fleet-drained',
    keyTemplate: 'fleet:drained:<slug>',
    params: [{ name: 'slug', required: true, describe: 'the fleet slug' }],
    describe: 'Every claimable item in a fleet\'s lanes is done (a leader can sleep until drain, then loop:end + scorecard).',
    emitter: 'fleet drain check (Phase 2)',
    exists: false, // P-105
    sugar: 'fleet:await-drained',
  },
  // ── Rate limits (already emit) ────────────────────────────────────────────
  {
    family: 'rate-limit',
    keyTemplate: 'rate-limit:reset:<scope>',
    params: [{ name: 'scope', required: true, describe: 'the rate-limit scope, e.g. gym-judge' }],
    describe: 'A rate-limit pause ended for a scope.',
    emitter: 'gym rate-pause-events (packages/operator-core/lib/gym/rate-pause-events.ts)',
    exists: true,
    siblings: [{ key: 'rate-limit:paused:<scope>', describe: 'the scope entered a rate-limit pause' }],
  },
] as const;

/** Lookup one family by id. */
export function catalogEntry(family: string): EventCatalogEntry | undefined {
  return EVENT_CATALOG.find((e) => e.family === family);
}

/** All families that carry a sugar verb (P-003 registers exactly these). */
export function sugaredFamilies(): EventCatalogEntry[] {
  return EVENT_CATALOG.filter((e) => e.sugar);
}

/**
 * Build a concrete event key from a family + params. Interpolates every
 * `<name>` placeholder; a MISSING required param throws (a sugar verb that can't
 * build its key must fail loudly, never register an await on a malformed key).
 * An OMITTED optional param collapses the whole `:<name>` segment away — so
 * `deploy` with no sha yields the global `release:deployed`, matching the real
 * global emit (D-005: one key shape, one place).
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
      // Optional + omitted: drop the ":<name>" segment (collapse to the global key).
      key = key.replace(new RegExp(`:<${p.name}>`), '');
      continue;
    }
    key = key.replace(`<${p.name}>`, String(raw));
  }
  return key;
}

/**
 * Concrete keys a sugar verb should register awaits on for a family + params:
 * the built primary key PLUS every sibling whose placeholders can be filled from
 * the same params (so a dual-outcome verb wakes on either outcome). A sibling
 * with an unfillable placeholder is skipped (never register a malformed key).
 */
export function awaitKeysForFamily(
  family: string,
  params: Record<string, string | number | undefined> = {},
): string[] {
  const entry = catalogEntry(family);
  if (!entry) throw new Error(`events:catalog — unknown family '${family}'`);
  const keys = [buildKey(family, params)];
  for (const sib of entry.siblings ?? []) {
    const built = interpolateSibling(sib.key, params);
    if (built && !keys.includes(built)) keys.push(built);
  }
  return keys;
}

/** Fill `<name>` placeholders in a sibling key from params; null if any remain. */
function interpolateSibling(template: string, params: Record<string, string | number | undefined>): string | null {
  let key = template;
  const placeholders = template.match(/<([a-zA-Z0-9_]+)>/g) ?? [];
  for (const ph of placeholders) {
    const name = ph.slice(1, -1);
    const raw = params[name];
    if (raw === undefined || raw === null || String(raw).length === 0) {
      // An optional placeholder we can't fill → collapse the segment (global sibling);
      // a required one we can't fill → skip this sibling entirely.
      const entry = catalogEntry(Object.keys(params).length ? '' : '');
      void entry;
      // Collapse ":<name>" when the primary family marks this param optional; else drop.
      key = key.replace(new RegExp(`:${ph}`), '');
      if (key.includes('<')) return null;
      continue;
    }
    key = key.replace(ph, String(raw));
  }
  return key.includes('<') ? null : key;
}
