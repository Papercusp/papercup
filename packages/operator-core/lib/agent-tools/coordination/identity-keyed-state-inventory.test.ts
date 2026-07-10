/**
 * identity-keyed-state-inventory.test.ts — the WI-3642 lesson generalized
 * (EI-8999: "Claim-integrity invariant sweep + compaction-survival test class
 * for ALL identity-keyed state").
 *
 * WI-3642's root cause was narrow in mechanism (rebindIdentity's held-items
 * step only re-keyed via the engineer_issues compat view, missing the
 * FEATURE-family majority of live claims) but general in CLASS: any column
 * that stores a CURRENT ownerId/sid — and that some liveness-tied reader or
 * reaper treats as "this row's current holder" — silently strands its state
 * under the dead sid the instant a compaction mints a new one, unless
 * rebindIdentity (or an equivalent) explicitly re-keys it. EI-8999 asks for a
 * sweep across every such column, not just the one WI-3642 happened to hit.
 *
 * A live-DB integration test can't do this sweep (it can only exercise
 * columns it already knows to look at — the exact blind spot that let
 * WI-3642 happen). Instead this is a STATIC inventory test over the
 * generated Drizzle schema (libs/papercusp/libs/db/src/schema/schema.ts,
 * `npm run pull-schema`'s output — the single source of truth for every
 * column that actually exists in harness_shared): it greps every table for
 * columns matching known "current holder" naming patterns, then checks each
 * hit against a maintained classification below:
 *
 *   - COVERED  — re-keyed by rebindIdentity's numbered surfaces (cross-checked
 *                against rebind-identity.ts's own surface list, so this file
 *                and that one can't silently drift apart).
 *   - EXEMPT   — deliberately NOT re-keyed, with a one-line reason (an
 *                append-only log/audit column, a TTL-leased row not tied to
 *                presence liveness, or a per-agent preference whose staleness
 *                is a UX nit, not a correctness bug).
 *
 * A column the scan finds that is in NEITHER list fails the test — the same
 * shape as `production-defaults.test.ts`'s KNOWN_DARK_FLAGS watermark: a new
 * identity-keyed column must be a DELIBERATE decision (rebind it + add it
 * here, or exempt it with a stated reason), never a silent gap discovered
 * three weeks later as a WI-3642-shaped incident report.
 *
 * This also guards the ALLOWLIST itself: an entry that no longer matches any
 * live column (renamed/dropped) fails too, so the list can't rot into
 * fiction. Run: cd packages/operator-core && npx vitest run
 * lib/agent-tools/coordination/identity-keyed-state-inventory.test.ts
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The generated Drizzle schema — the single source of truth for what columns
// actually exist (kept in sync with prod via `pull-schema.mjs`, per CLAUDE.md's
// storage-policy section). Static-parsed, not imported: this file is huge and
// its module graph pulls in the full drizzle-orm table definitions, which is
// unnecessary weight for a pure text scan.
// Read `generated.ts`, NOT `schema.ts`: pull-schema.mjs writes schema.ts (the
// drizzle-kit output) then copyFileSync's it to generated.ts — byte-identical —
// but schema.ts is gitignored, so it is ABSENT in a clean checkout (e.g. the
// release green-checkpoint worktree), where reading it ENOENTs and reds the gate.
// generated.ts is the TRACKED mirror, so the scan is deterministic everywhere.
const SCHEMA_PATH = resolve(
  __dirname,
  '../../../../../libs/papercusp/libs/db/src/schema/generated.ts',
);

/** table.column keys the scan is allowed to find without failing — see the
 *  module doc above for COVERED vs EXEMPT semantics. */
interface Classification {
  status: 'covered' | 'exempt';
  /** For `covered`, the rebindIdentity surface name (cross-checked below). */
  surface?: string;
  /** For `exempt`, why a compaction rebind stranding this column is safe. */
  reason?: string;
}

const ALLOWLIST: Record<string, Classification> = {
  // --- COVERED: re-keyed by rebindIdentity (rebind-identity.ts) ---
  'routines.target_owner_id': { status: 'covered', surface: 'loop-routine' },
  'pending_wakes.owner_id': { status: 'covered', surface: 'pending-wakes' }, // EI-8999
  'coord_presence.owner_id': { status: 'covered', surface: 'presence' },
  'fleet_membership_events.owner_id': { status: 'covered', surface: 'fleet-membership' },
  'agent_fleets.leader_owner_id': { status: 'covered', surface: 'fleet-leadership' },
  'bee_claim_specs.bee_id': { status: 'covered', surface: 'claim-spec' },
  'event_awaits.subscriber_id': { status: 'covered', surface: 'awaits' },
  'plan_item_claims.owner': { status: 'covered', surface: 'plan-claims' },
  'work_item_claims.owner': { status: 'covered', surface: 'work-claims' },
  'coord_watermarks.owner_id': { status: 'covered', surface: 'watermarks' },
  'coord_read_cursors.owner_id': { status: 'covered', surface: 'read-cursors' }, // EI-8999, caught live as migration 537 landed

  'work_items.taken_by': { status: 'covered', surface: 'held-work-items' },
  'agent_facts.scope_ref': { status: 'covered', surface: 'owner-facts' },

  // --- EXEMPT: deliberately not re-keyed ---
  'agent_activity.owner_id': {
    status: 'exempt',
    reason: 'append-only activity LOG (who did what, when) — not a current-holder claim any reader treats as live.',
  },
  'adv_sessions.coord_owner_id': {
    status: 'exempt',
    reason: "the session's OWN record, created under its own id at boot — never read/reaped keyed on a DIFFERENT session's liveness.",
  },
  'tool_invocations.coord_owner_id': {
    status: 'exempt',
    reason: 'immutable per-call audit log row — attribution, not a claim any reaper acts on.',
  },
  'agent_mode_changes.owner_id': {
    status: 'exempt',
    reason: 'append-only mode-change event log — the CURRENT mode lives in agent_modes.owner_id (see below), this is history.',
  },
  'agent_modes.owner_id': {
    status: 'exempt',
    reason: 'a stale rebind here means the new sid falls back to the DEFAULT wake-mode, not a stolen/lost claim — a UX nit, not a correctness bug (no reaper frees a resource because of it). Candidate for a future rebind surface, not urgent.',
  },
  'agent_seat_consumptions.owner_id': {
    status: 'exempt',
    reason: 'seat accounting is boot-time-consume / explicit-release (consumeSeatAtBoot / releaseSeatConsumption), not presence-reap-tied as far as this sweep found — flagged for a follow-up audit of its release path (no reaper caller found; TTL/explicit-release only), not a confirmed WI-3642-class bug.',
  },
  'session_briefs.owner_id': {
    status: 'exempt',
    reason: "the session's own carry-brief snapshot, written by and read back by the SAME id at each of its own turns — a rebind moves the loop carry-note (a separate surface) which is what a cold successor actually reads.",
  },
  'tui_view_state.owner_id': {
    status: 'exempt',
    reason: 'per-agent UI preference (panel layout etc.) — a rebind losing it means the new sid sees default UI state, not a lost claim or a wrongly-freed resource.',
  },
  'tui_layouts.owner_id': { status: 'exempt', reason: 'same class as tui_view_state.owner_id — UI preference, not a claim.' },
  'tui_crews.owner_id': { status: 'exempt', reason: 'same class as tui_view_state.owner_id — UI preference, not a claim.' },
  'agent_name_sessions.session_owner_id': {
    status: 'exempt',
    reason: 'naming-registry attribution for a session that already exists under its own id — not reaped by a different id going stale.',
  },
  'fleet_ekg_sessions.owner_id': {
    status: 'exempt',
    reason: 'EKG telemetry session record, keyed by its own id at creation — not a claim another reaper acts on.',
  },
  'shared_session_presence.owner_id': {
    status: 'exempt',
    reason: "the federation mirror of coord_presence — same ghost-row-on-death handling as the 'presence' surface (the live id's own beat repopulates it; nothing to move).",
  },
  'bench_run_tasks.bee_id': {
    status: 'exempt',
    reason: 'benchmark-harness run attribution, an isolated evaluation context — not live coordination state a reaper touches.',
  },
  'coord_entity_subscriptions.subscriber_id': {
    status: 'exempt',
    reason: 'topic subscriptions are cheaply re-established (declare-intent / topics:subscribe re-fires each orient) — a rebind losing one means a missed notification window, not a stranded claim/resource. Worth a future rebind surface if this proves to bite in practice; filed as a follow-up, not a confirmed incident.',
  },
  'event_wake_deliveries.subscriber_id': {
    status: 'exempt',
    reason: 'a delivery-history LOG row (what was sent to whom) — not a live subscription or claim.',
  },
  'voice_lease.owner_id': {
    status: 'exempt',
    reason: 'a TTL-expiring lease (its own expires_ts governs reclaim) — not reaped by presence liveness of the owner id.',
  },
  'llm_test_claims.owner_id': {
    status: 'exempt',
    reason: 'an isolated eval-harness claim (LLM test scenario runs), TTL-leased like voice_lease — not part of live agent coordination presence sweeps.',
  },
  'work_item_replicas.owner': {
    status: 'exempt',
    reason: 'a heartbeat-LEASED redundancy slot (migration 195) reclaimed on its own expires_ts, same TTL-lease class as voice_lease/llm_test_claims — not presence-reaped.',
  },
  'agent_fleets.owner': {
    status: 'exempt',
    reason: "the fleet's CREATOR attribution, distinct from leader_owner_id (current leadership, covered by the 'fleet-leadership' surface) — display/provenance only, no reaper keys on it.",
  },
  'session_turns.owner': {
    status: 'exempt',
    reason: 'a per-turn append-only session-history log row (which session logged this turn) — attribution, not a live claim.',
  },
  'harness_plans.owner': {
    status: 'exempt',
    reason: "the plan's creator/owner attribution field, distinct from the per-lane plan_item_claims.owner (covered by the 'plan-claims' surface) — display/provenance only, no reaper keys on it.",
  },
  'engineer_issues.assignee': {
    status: 'covered',
    surface: 'held-items',
    // (Also covered transitively by 'held-work-items', which re-keys the
    // underlying work_items.taken_by this compat view reads through — see
    // rebind-identity.ts step 11 vs 11b.)
  },
  'harness_features.taken_by': {
    status: 'covered',
    surface: 'held-work-items',
    // A per-harness-schema view/legacy projection over the same
    // harness_shared.work_items.taken_by column 'held-work-items' re-keys
    // directly — not an independently-stored copy.
  },
  'harness_features_consolidated.taken_by': {
    status: 'covered',
    surface: 'held-work-items',
  },

  'predicate_watches.owner_id': {
    status: 'exempt',
    reason:
      'registrant attribution for the poll dispatch principal + display (predicate-watch.ts) — the row\'s ' +
      'actual liveness is governed entirely by its PAIRED event_awaits row (gcOrphanedPredicateWatches ' +
      'deactivates on that pairing going inactive, never on owner_id/presence), and event_awaits.subscriber_id ' +
      'IS re-keyed (the \'awaits\' surface) — so a stale owner_id here means the dead predecessor\'s id lingers ' +
      'in error/source strings, not a stranded claim or a wrongly-GC\'d watch. Same class as tui_view_state.owner_id.',
  },
  'session_archives.owner': {
    status: 'exempt',
    reason:
      "the archived session's OWN post-mortem attribution, stamped by archiveSession() AFTER that session " +
      'already ended (migration 539) — never read by a reaper keyed on a DIFFERENT session\'s presence, same ' +
      'class as session_turns.owner.',
  },
};

/** Column-name patterns that mean "this stores a CURRENT holder/owner
 *  identity" — the shape a presence-tied reader/reaper is likely to key on.
 *  Deliberately narrow (false negatives are safer than false positives here:
 *  a name like `created_by` or `assigned_by` is PROVENANCE — who did this —
 *  not a live claim, and is excluded on purpose). */
const IDENTITY_COLUMN_NAMES = new Set([
  'owner_id',
  'owner',
  'assignee',
  'taken_by',
  'held_by',
  'holder_id',
  'claimed_by',
  'locked_by',
  'leader_owner_id',
  'target_owner_id',
  'subscriber_id',
  'bee_id',
  'session_owner_id',
  'coord_owner_id',
  'scope_ref', // only identity-shaped when paired with scope='owner' (agent_facts) — swept in, classified by table.
]);

/** camelCase field name -> its default drizzle-kit snake_case column name
 *  (used only when the column call omits an explicit `"snake_name"` arg,
 *  e.g. `owner: text().notNull()`). */
function toSnakeCase(camel: string): string {
  return camel.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
}

interface ScanHit {
  table: string;
  column: string;
}

/** Static-parse schema.ts: track the current `harnessShared.table("name", {`
 *  block and record every column line whose db name matches
 *  IDENTITY_COLUMN_NAMES. A column line looks like `fieldName: type(...)` or
 *  `fieldName: type("explicit_db_name")...` — take the explicit name when
 *  present, else derive it from the camelCase field name. Exported for the
 *  self-test below. */
export function scanIdentityColumns(schemaSrc: string): ScanHit[] {
  // Matches both `harnessShared.table("name", {` (base tables) AND
  // `harnessShared.view("name", {` (views, e.g. engineer_issues — the
  // compat view holding `taken_by AS assignee`) — a view can carry an
  // identity-keyed column just as live-read as a base table's.
  const tableStart = /\.(?:table|view)\("([a-z0-9_]+)"/;
  const colLine = /^\s*(\w+):\s*\w+\(\s*(?:"([a-z0-9_]+)")?/;
  let currentTable: string | null = null;
  const hits: ScanHit[] = [];
  for (const line of schemaSrc.split('\n')) {
    const ts = line.match(tableStart);
    if (ts) currentTable = ts[1];
    const cm = line.match(colLine);
    if (!cm || !currentTable) continue;
    const dbName = cm[2] ?? toSnakeCase(cm[1]);
    if (IDENTITY_COLUMN_NAMES.has(dbName)) hits.push({ table: currentTable, column: dbName });
  }
  return hits;
}

describe('scanIdentityColumns (pure parser self-test)', () => {
  it('picks up an explicit quoted db-name and derives an implicit one from camelCase', () => {
    const src = `
export const fooInHarnessShared = harnessShared.table("foo", {
	ownerId: text("owner_id").notNull(),
	owner: text().notNull(),
	unrelated: text("something_else"),
});
`;
    const hits = scanIdentityColumns(src);
    expect(hits).toEqual([
      { table: 'foo', column: 'owner_id' },
      { table: 'foo', column: 'owner' },
    ]);
  });

  it('resets the current table at each new table("...") block', () => {
    const src = `
export const aInHarnessShared = harnessShared.table("a", {
	ownerId: text("owner_id").notNull(),
});
export const bInHarnessShared = harnessShared.table("b", {
	assignee: text("assignee"),
});
`;
    expect(scanIdentityColumns(src)).toEqual([
      { table: 'a', column: 'owner_id' },
      { table: 'b', column: 'assignee' },
    ]);
  });
});

describe('identity-keyed state inventory (EI-8999 — the WI-3642 lesson generalized)', () => {
  const schemaSrc = readFileSync(SCHEMA_PATH, 'utf8');
  const hits = scanIdentityColumns(schemaSrc);
  const foundKeys = new Set(hits.map((h) => `${h.table}.${h.column}`));

  it('found at least the columns this sweep was seeded from (schema.ts is readable + non-empty)', () => {
    // A canary: if this drops to 0 the scan silently broke (wrong path, schema
    // regenerated in an incompatible shape, …) and every other assertion below
    // would vacuously pass. Guard against a green-by-accident test.
    expect(hits.length).toBeGreaterThan(10);
  });

  it('every identity-keyed column found in the live schema is a DELIBERATE decision (covered or exempt)', () => {
    const unclassified = [...foundKeys].filter((k) => !(k in ALLOWLIST));
    expect(
      unclassified,
      unclassified.length > 0
        ? `New identity-keyed column(s) found with no classification: ${unclassified.join(', ')}.\n` +
            'Either (a) it is a live current-holder claim a presence-tied reaper/reader keys on — add a ' +
            "rebindIdentity surface for it (rebind-identity.ts) and list it here as 'covered', or (b) it is " +
            "provenance/log/TTL-leased/preference state safe to strand — add it here as 'exempt' with a one-line " +
            'reason. Do not silently ignore: this is exactly the shape of gap WI-3642 shipped as an incident.'
        : undefined,
    ).toEqual([]);
  });

  it('the allowlist itself has not rotted — every entry still matches a live column', () => {
    const stale = Object.keys(ALLOWLIST).filter((k) => !foundKeys.has(k));
    expect(
      stale,
      stale.length > 0
        ? `Allowlist entries no longer found in schema.ts (renamed/dropped column or table — remove or update): ${stale.join(', ')}`
        : undefined,
    ).toEqual([]);
  });

  it('every "covered" entry names a surface that actually exists in rebindIdentity', async () => {
    // Import lazily (and only the source text, not the runtime module) so this
    // stays a pure-text assertion with no PG/module-graph dependency: read
    // rebind-identity.ts's own source and confirm each claimed surface name is
    // one of its `run('<surface>', ...)` calls. This is what keeps this file
    // and rebind-identity.ts from silently drifting apart (a surface renamed
    // there without updating here, or vice versa).
    const { readFileSync: rf } = await import('node:fs');
    const rebindSrc = rf(resolve(__dirname, 'rebind-identity.ts'), 'utf8');
    const declaredSurfaces = new Set(
      [...rebindSrc.matchAll(/run\('([a-z-]+)'/g)].map((m) => m[1]),
    );
    const covered = Object.entries(ALLOWLIST).filter(([, c]) => c.status === 'covered');
    const missing = covered.filter(([, c]) => !c.surface || !declaredSurfaces.has(c.surface));
    expect(
      missing.map(([k]) => k),
      missing.length > 0 ? `Covered entries naming a surface rebind-identity.ts no longer declares: ${missing.map(([k]) => k).join(', ')}` : undefined,
    ).toEqual([]);
  });
});
