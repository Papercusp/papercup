/**
 * survey.integration.test.ts — the cross-member frontier query against REAL
 * Postgres (mug-autonomous-execution B-08 / P-012). The 2026-06-11 bug was a
 * survey scoped to the Mug's home seat only; `fetchFrontierRows` must union
 * EVERY surveyed member harness, and (surveySlugs=[]) fall back to a
 * workspace-wide read — never the home slug alone.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, USER_TRUST_LIST_DDL, CARRY_NOTES_DDL } from '../../test/_work-items-schema';
import {
  countPlaceableFrontier,
  countQuarantinedFrontier,
  fetchFrontierRows,
  fetchEscalatedIssueFrontierRows,
  isAdmissionStarved,
} from './survey';

const readMigration = (f: string) =>
  readFileSync(join(__dirname, '../../../../libs/papercusp/libs/db/sql', f), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line) && !/\bGRANT\b/.test(line) && !/^\s*(BEGIN|COMMIT);\s*$/.test(line))
    .join('\n');

let db: FreshPgDb;

async function seed(
  harness: string,
  id: string,
  opts: {
    kind?: string;
    status?: string;
    takenBy?: string | null;
    createdTs?: number;
    planSlug?: string | null;
    origin?: string | null;
    auditVerdict?: string | null;
    /** EI-13501: cup-forbidden payload markers on a feature-family row. */
    payload?: Record<string, unknown> | null;
  } = {},
) {
  await db.sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, item_kind, status, taken_by, workspace_id, created_ts, updated_ts, source_plan_slug, origin, audit_verdict, payload)
    VALUES (${harness}, ${id}, ${opts.kind ?? 'feature'}, ${opts.status ?? 'open'},
            ${opts.takenBy ?? null}, 'default', ${opts.createdTs ?? 0}, 0, ${opts.planSlug ?? null},
            ${opts.origin ?? 'local'}, ${opts.auditVerdict ?? null},
            ${opts.payload ? JSON.stringify(opts.payload) : null}::text::jsonb)`;
}

/** EI-13501: seed an issue-family row (bug/change/task) directly on the work_items
 *  base table — fetchEscalatedIssueFrontierRows queries it directly, not through
 *  the harness_features_consolidated view (which excludes these kinds). */
async function seedIssue(
  harness: string,
  id: string,
  opts: {
    kind?: 'bug' | 'change' | 'task';
    severity?: 'critical' | 'major' | 'minor';
    takenBy?: string | null;
    createdTs?: number;
    payload?: Record<string, unknown>;
  } = {},
) {
  const payload = { ...(opts.payload ?? {}), _ei: { severity: opts.severity ?? 'major' } };
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, status, taken_by, workspace_id, created_ts, updated_ts, origin, payload)
    VALUES (${harness}, ${id}, ${opts.kind ?? 'bug'}, 'open',
            ${opts.takenBy ?? null}, 'default', ${opts.createdTs ?? 0}, 0, 'local', ${JSON.stringify(payload)}::text::jsonb)`;
}

beforeAll(async () => {
  db = await createFreshPgDb('pot-survey');
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  // EI-865 — the frontier anti-joins pot_placements to exclude cursed items, so the
  // table must exist. The migration's trailing GRANT / DO-block is stripped by
  // readMigration's line filter (breaking the DO body); the CREATE TABLE + INDEX is
  // all the anti-join needs, so apply just that (mirrors HARNESS_FEATURES_CONSOLIDATED_DDL).
  await db.sql.unsafe(POT_PLACEMENTS_DDL).simple();
  // EI-8498 — fetchFrontierRows now applies the G2 admission gate (autoPickableWhereSql),
  // whose trust fast-path subquery reads harness_shared.user_trust_list unconditionally
  // whenever a workspaceId is passed (every real call). Must exist or every query in this
  // suite errors "relation does not exist" (D-014 read-path-completeness, mirrors the
  // datatype_registry/plan_item_claims precedent in _work-items-schema.ts).
  await db.sql.unsafe(USER_TRUST_LIST_DDL);
  // EI-13695 — fetchFrontierRows/countPlaceableFrontier's checkpoint-reconcile exclusion
  // (hasWorkItemCheckpointSql) unconditionally queries harness_shared.carry_notes; must
  // exist or every query in this suite errors "relation does not exist" (this fixture was
  // never updated when that exclusion landed — found live 2026-07-17 verifying EI-13501).
  await db.sql.unsafe(CARRY_NOTES_DDL);
}, 90_000);

/** The pot_placements table (migration 263), table + index only — see beforeAll. */
const POT_PLACEMENTS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.pot_placements (
    workspace_id      text NOT NULL,
    install_slug      text NOT NULL,
    work_item_id      text NOT NULL,
    harness_slug      text,
    mug_owner_id    text,
    cup_spawn_id      text,
    cup_owner_id      text,
    status            text NOT NULL DEFAULT 'working',
    fail_count        integer NOT NULL DEFAULT 0,
    last_disposition  text,
    escalation_msg_id text,
    placed_at         timestamptz NOT NULL DEFAULT now(),
    last_recovery_at  timestamptz,
    last_seen_at      timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT hive_placements_pkey PRIMARY KEY (workspace_id, install_slug, work_item_id),
    CONSTRAINT hive_placements_status_check CHECK (status IN
      ('working', 'recovering', 'cursed', 'stranded', 'completed', 'abandoned'))
  );
  CREATE INDEX IF NOT EXISTS hive_placements_open_idx
    ON harness_shared.pot_placements (workspace_id, install_slug, status);`;

/** Seed a pot_placements row (the breaker ledger) for the cursed-exclusion test. */
async function seedPlacement(id: string, status: string, opts: { harness?: string; failCount?: number } = {}) {
  await db.sql`
    INSERT INTO harness_shared.pot_placements
      (workspace_id, install_slug, work_item_id, harness_slug, status, fail_count)
    VALUES ('default', ${opts.harness ?? MEMBER_A}, ${id}, ${opts.harness ?? MEMBER_A}, ${status}, ${opts.failCount ?? 0})`;
}

afterAll(async () => {
  await db.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.pot_placements, harness_shared.user_trust_list, harness_shared.carry_notes`;
});

const HOME = 'papercup-pot';
const MEMBER_A = 'papercup';
const MEMBER_B = 'restart';

describe('fetchFrontierRows (P-012 cross-member survey)', () => {
  it('unions EVERY surveyed member harness, not just the home seat (the 2026-06-11 bug)', async () => {
    // The home seat is empty (the Mug's seat); the work lives in the members.
    await seed(MEMBER_A, 'WI-A1', { createdTs: 1 });
    await seed(MEMBER_B, 'WI-B1', { createdTs: 2 });
    const rows = await fetchFrontierRows(db.sql as unknown as postgres.Sql, 'default', [HOME, MEMBER_A, MEMBER_B]);
    expect(rows.map((r) => r.feature_id).sort()).toEqual(['WI-A1', 'WI-B1']);
  });

  it('the buggy home-only scope would have seen NOTHING — proving the regression', async () => {
    await seed(MEMBER_A, 'WI-A1', { createdTs: 1 }); // a freshly-filed member item
    const homeOnly = await fetchFrontierRows(db.sql as unknown as postgres.Sql, 'default', [HOME]);
    expect(homeOnly).toEqual([]); // <- the 2026-06-11 sleep-through
    const withMembers = await fetchFrontierRows(db.sql as unknown as postgres.Sql, 'default', [HOME, MEMBER_A]);
    expect(withMembers.map((r) => r.feature_id)).toEqual(['WI-A1']);
  });

  it('surveySlugs=[] falls back to a WORKSPACE-WIDE read (every harness)', async () => {
    await seed(MEMBER_A, 'WI-A1', { createdTs: 1 });
    await seed(MEMBER_B, 'WI-B1', { createdTs: 2 });
    await seed('some-other-harness', 'WI-X', { createdTs: 3 });
    const rows = await fetchFrontierRows(db.sql as unknown as postgres.Sql, 'default', []);
    expect(rows.map((r) => r.feature_id).sort()).toEqual(['WI-A1', 'WI-B1', 'WI-X']);
  });

  it('EI-1525: excludes ephemeral benchmark/instance debris even in the workspace-wide fallback', async () => {
    await seed(MEMBER_A, 'WI-A1', { createdTs: 1 });
    // The exact 2026-06-18 pathology: a torn-down benchmark fleet's per-task
    // instance harnesses leaking into the unscoped survey as "real" frontier.
    await seed('xbench-su-1234', 'WI-BENCH1', { createdTs: 2 });
    await seed('xbq1a2b3c-instance_7', 'WI-BENCH2', { createdTs: 3 });
    await seed('some-harness-DELETEME', 'WI-BENCH3', { createdTs: 4 });
    const rows = await fetchFrontierRows(db.sql as unknown as postgres.Sql, 'default', []);
    expect(rows.map((r) => r.feature_id).sort()).toEqual(['WI-A1']);
  });

  it('EI-1525: the SAME exclusion still applies when the survey IS explicitly scoped (defense in depth)', async () => {
    await seed('xbench-su-9999', 'WI-BENCH', { createdTs: 1 });
    await seed(MEMBER_A, 'WI-A1', { createdTs: 2 });
    const rows = await fetchFrontierRows(db.sql as unknown as postgres.Sql, 'default', [MEMBER_A, 'xbench-su-9999']);
    expect(rows.map((r) => r.feature_id)).toEqual(['WI-A1']);
  });

  it('excludes assigned + non-open items and orders oldest-first', async () => {
    await seed(MEMBER_A, 'WI-taken', { takenBy: 'cup-1', createdTs: 0 });
    await seed(MEMBER_A, 'WI-passed', { status: 'passed', createdTs: 1 });
    await seed(MEMBER_A, 'WI-new', { createdTs: 3 });
    await seed(MEMBER_A, 'WI-old', { createdTs: 2 });
    const rows = await fetchFrontierRows(db.sql as unknown as postgres.Sql, 'default', [MEMBER_A]);
    expect(rows.map((r) => r.feature_id)).toEqual(['WI-old', 'WI-new']); // oldest-first, only open+unassigned
  });

  it('EI-18690462961089460/EI-13699 (work-item-status-full-unify regression): a row genuinely sitting at the LEGACY \'todo\' token is NOT surfaced — only \'open\' is the current claimable status', async () => {
    // Migration 638 (2026-07-19) rewrote feature-family status todo -> open; no writer
    // produces 'todo' anymore. A row somehow still AT 'todo' (a pre-migration leftover,
    // or a future regression reverting fetchFrontierRows back to the retired literal)
    // must NOT be treated as placeable — pinning the CURRENT token, not the legacy one,
    // is exactly what silently broke the frontier for a week between 07-19 and 07-26.
    await seed(MEMBER_A, 'WI-LEGACY-TODO', { status: 'todo', createdTs: 1 });
    await seed(MEMBER_A, 'WI-CURRENT-OPEN', { status: 'open', createdTs: 2 });
    const rows = await fetchFrontierRows(db.sql as unknown as postgres.Sql, 'default', [MEMBER_A]);
    expect(rows.map((r) => r.feature_id)).toEqual(['WI-CURRENT-OPEN']);

    const placeable = await countPlaceableFrontier(db.sql as unknown as postgres.Sql, 'default', [MEMBER_A]);
    expect(placeable).toBe(1);
  });

  it('respects the limit cap', async () => {
    for (let i = 0; i < 5; i++) await seed(MEMBER_A, `WI-${i}`, { createdTs: i });
    const rows = await fetchFrontierRows(db.sql as unknown as postgres.Sql, 'default', [MEMBER_A], 3);
    expect(rows.map((r) => r.feature_id)).toEqual(['WI-0', 'WI-1', 'WI-2']);
  });

  it('surfaces source_plan_slug as plan_slug, for the eligible-plans HARD filter (mug-steering-panel P-008)', async () => {
    await seed(MEMBER_A, 'WI-PLANNED', { createdTs: 1, planSlug: 'queen-steering-panel-2026-06-15' });
    await seed(MEMBER_A, 'WI-UNPLANNED', { createdTs: 2 }); // no source plan
    const rows = await fetchFrontierRows(db.sql as unknown as postgres.Sql, 'default', [MEMBER_A]);
    const byId = new Map(rows.map((r) => [r.feature_id, r.plan_slug]));
    expect(byId.get('WI-PLANNED')).toBe('queen-steering-panel-2026-06-15');
    expect(byId.get('WI-UNPLANNED')).toBeNull();
  });

  it('EI-865: excludes a CURSED item — the breaker holds a doomed item out of the frontier', async () => {
    await seed(MEMBER_A, 'WI-OK', { createdTs: 1 });
    await seed(MEMBER_A, 'WI-CURSED', { createdTs: 2 });
    await seedPlacement('WI-CURSED', 'cursed', { failCount: 3 });
    const rows = await fetchFrontierRows(db.sql as unknown as postgres.Sql, 'default', [MEMBER_A]);
    expect(rows.map((r) => r.feature_id)).toEqual(['WI-OK']); // the cursed item never re-surfaces
  });

  it('WI-677/EI-3850: a fail_count=0 infra-cursed item stays in the survey frontier', async () => {
    await seed(MEMBER_A, 'WI-OK', { createdTs: 1 });
    await seed(MEMBER_A, 'WI-INFRA-CURSED', { createdTs: 2 });
    await seed(MEMBER_A, 'WI-PATHOLOGY-CURSED', { createdTs: 3 });
    await seedPlacement('WI-INFRA-CURSED', 'cursed', { failCount: 0 });
    await seedPlacement('WI-PATHOLOGY-CURSED', 'cursed', { failCount: 3 });
    const rows = await fetchFrontierRows(db.sql as unknown as postgres.Sql, 'default', [MEMBER_A]);
    expect(rows.map((r) => r.feature_id)).toEqual(['WI-OK', 'WI-INFRA-CURSED']);
  });

  it('EI-865: a NON-cursed placement row (recovering/working) does NOT exclude its item — only the curse latches it out', async () => {
    await seed(MEMBER_A, 'WI-RECOVERING', { createdTs: 1 });
    await seed(MEMBER_A, 'WI-WORKING', { createdTs: 2 });
    await seedPlacement('WI-RECOVERING', 'recovering', { failCount: 1 });
    await seedPlacement('WI-WORKING', 'working');
    const rows = await fetchFrontierRows(db.sql as unknown as postgres.Sql, 'default', [MEMBER_A]);
    expect(rows.map((r) => r.feature_id).sort()).toEqual(['WI-RECOVERING', 'WI-WORKING']);
  });

  it('EI-8498: excludes a REMOTE, un-admitted (quarantined) item — the same G2 gate fleet:place_batch enforces', async () => {
    await seed(MEMBER_A, 'WI-LOCAL', { createdTs: 1 }); // origin defaults 'local'
    await seed(MEMBER_A, 'WI-REMOTE-ADMITTED', { createdTs: 2, origin: 'remote', auditVerdict: 'admit' });
    await seed(MEMBER_A, 'WI-REMOTE-QUARANTINED', { createdTs: 3, origin: 'remote', auditVerdict: null });
    const rows = await fetchFrontierRows(db.sql as unknown as postgres.Sql, 'default', [MEMBER_A]);
    // Before this fix all three showed up as "ready" — a quarantined remote item
    // was indistinguishable from real placeable work, feeding false work-feed-stuck
    // escalations (WI-2601). Now the survey's frontier matches what placement can
    // actually pick up.
    expect(rows.map((r) => r.feature_id).sort()).toEqual(['WI-LOCAL', 'WI-REMOTE-ADMITTED']);
  });

  it('EI-8498: the trust-list fast-path admits a remote item whose verified author is locally trusted', async () => {
    await seed(MEMBER_A, 'WI-TRUSTED-REMOTE', { createdTs: 1, origin: 'remote', auditVerdict: null });
    await db.sql`UPDATE harness_shared.harness_features_consolidated SET verified_author_github_user_id = 42 WHERE feature_id = 'WI-TRUSTED-REMOTE'`;
    await db.sql`INSERT INTO harness_shared.user_trust_list (workspace_id, trusted_github_user_id) VALUES ('default', 42)`;
    await seed(MEMBER_A, 'WI-UNTRUSTED-REMOTE', { createdTs: 2, origin: 'remote', auditVerdict: null });
    const rows = await fetchFrontierRows(db.sql as unknown as postgres.Sql, 'default', [MEMBER_A]);
    expect(rows.map((r) => r.feature_id)).toEqual(['WI-TRUSTED-REMOTE']);
  });

  it('COUNTS the quarantined frontier — a remote UNAUDITED item (audit_verdict NULL) must not vanish into SQL NULL', async () => {
    // The silent-starvation detector, pinned against real Postgres — and this test can
    // ONLY be written here, because the bug it guards is three-valued logic that no
    // fixture-driven unit test can reach.
    //
    // For exactly the rows this counter exists to find (remote, NEVER audited),
    // `audit_verdict = 'admit'` is NULL — not FALSE. So the admission expression is
    // NULL, and `NOT NULL` is NULL, which a WHERE treats as no-match. A bare
    // `NOT (autoPickableWhereSql)` therefore counts ZERO quarantined items while the
    // pot sits deadlocked behind them, which is precisely the blindness the counter
    // was added to remove. countQuarantinedFrontier pins NULL to FALSE with COALESCE;
    // if someone "simplifies" that away, this test fails and the next one does not
    // have to rediscover it against a live database at 02:40.
    await seed(MEMBER_A, 'WI-Q-LOCAL', { createdTs: 1, origin: 'local' });
    await seed(MEMBER_A, 'WI-Q-ADMITTED', { createdTs: 2, origin: 'remote', auditVerdict: 'admit' });
    await seed(MEMBER_A, 'WI-Q-REMOTE-1', { createdTs: 3, origin: 'remote', auditVerdict: null });
    await seed(MEMBER_A, 'WI-Q-REMOTE-2', { createdTs: 4, origin: 'remote', auditVerdict: null });

    const placeable = await countPlaceableFrontier(db.sql as unknown as postgres.Sql, 'default', [MEMBER_A]);
    const quarantined = await countQuarantinedFrontier(db.sql as unknown as postgres.Sql, 'default', [MEMBER_A]);

    // The two must PARTITION the same row set — every candidate lands in exactly one.
    expect(placeable).toBe(2); // local + admitted
    expect(quarantined).toBe(2); // the two remote-unaudited rows (0 under the NULL bug)
    expect(isAdmissionStarved({ placeable, quarantined })).toBe(false); // work IS placeable ⇒ not starved
  });

  it('flags the DEADLOCK: everything placeable is quarantined ⇒ the pot has work it may never touch', async () => {
    // The 2026-07-13 production state exactly: the pot's whole placeable pool is
    // federated remote items, none audited, no trusted author — so the Mug surveys a
    // frontier of zero, correctly places nothing, and reports success, forever.
    await seed(MEMBER_A, 'WI-D-1', { createdTs: 1, origin: 'remote', auditVerdict: null });
    await seed(MEMBER_A, 'WI-D-2', { createdTs: 2, origin: 'remote', auditVerdict: null });

    const placeable = await countPlaceableFrontier(db.sql as unknown as postgres.Sql, 'default', [MEMBER_A]);
    const quarantined = await countQuarantinedFrontier(db.sql as unknown as postgres.Sql, 'default', [MEMBER_A]);

    expect(placeable).toBe(0);
    expect(quarantined).toBe(2);
    // An empty frontier ALONE is just an idle pot; it is a deadlock only because work
    // is being withheld. That distinction is the whole point of the signal.
    expect(isAdmissionStarved({ placeable, quarantined })).toBe(true);
    expect(isAdmissionStarved({ placeable: 0, quarantined: 0 })).toBe(false);
  });
});

describe('EI-13501: cup-forbidden items are excluded from the placement frontier', () => {
  it('fetchFrontierRows excludes a claim-held feature (payload._claimHold) — the SAME floor claimFloorsWhereSql already enforces for the scheduler claim path', async () => {
    await seed(MEMBER_A, 'WI-CLAIM-HOLD', { createdTs: 1, payload: { _claimHold: true } });
    await seed(MEMBER_A, 'WI-NORMAL', { createdTs: 2 });
    const rows = await fetchFrontierRows(db.sql as unknown as postgres.Sql, 'default', [MEMBER_A]);
    // Before this fix BOTH counted as "ready to place" — live-verified 2026-07-17 that
    // the pot's real feature frontier was 100% claim-held items (WI-321/357/662/1281/1774),
    // a pure false-positive "N ready to place" signal driving Mug-dark blocker escalations.
    expect(rows.map((r) => r.feature_id)).toEqual(['WI-NORMAL']);
  });

  it('countPlaceableFrontier mirrors the SAME claim-hold exclusion (this count gates starvation/throughput signals)', async () => {
    await seed(MEMBER_A, 'WI-CH-1', { createdTs: 1, payload: { _claimHold: true } });
    await seed(MEMBER_A, 'WI-CH-2', { createdTs: 2 });
    const placeable = await countPlaceableFrontier(db.sql as unknown as postgres.Sql, 'default', [MEMBER_A]);
    expect(placeable).toBe(1);
  });

  it('fetchEscalatedIssueFrontierRows admits retired legacy needsHuman while excluding typed owner-action, claim-held, and rig-gated rows', async () => {
    await seedIssue(MEMBER_A, 'EI-NEEDS-HUMAN', { createdTs: 1, payload: { needsHuman: true } });
    await seedIssue(MEMBER_A, 'EI-NEEDS-OWNER-ACTION', { createdTs: 2, payload: { needsOwnerAction: true } });
    await seedIssue(MEMBER_A, 'EI-CLAIM-HELD', { createdTs: 3, payload: { _claimHold: true } });
    await seedIssue(MEMBER_A, 'EI-RIG-GATED', { createdTs: 4, payload: { needs_2_machine_rig: true } });
    await seedIssue(MEMBER_A, 'EI-GENUINE', { createdTs: 5 });
    const rows = await fetchEscalatedIssueFrontierRows(db.sql as unknown as postgres.Sql, 'default', [MEMBER_A]);
    // Migration 864 retired the ambiguous payload.needsHuman floor. The compatibility
    // row is therefore placeable, while the typed/current floors remain enforced.
    expect(rows.map((r) => r.feature_id)).toEqual(['EI-NEEDS-HUMAN', 'EI-GENUINE']);
  });

  it('fetchEscalatedIssueFrontierRows still surfaces a genuinely placeable severity-major issue (no false exclusion)', async () => {
    await seedIssue(MEMBER_A, 'EI-PLACEABLE', { createdTs: 1, severity: 'major' });
    await seedIssue(MEMBER_A, 'EI-MINOR', { createdTs: 2, severity: 'minor' }); // below the severity bar regardless
    const rows = await fetchEscalatedIssueFrontierRows(db.sql as unknown as postgres.Sql, 'default', [MEMBER_A]);
    expect(rows.map((r) => r.feature_id)).toEqual(['EI-PLACEABLE']);
  });
});
