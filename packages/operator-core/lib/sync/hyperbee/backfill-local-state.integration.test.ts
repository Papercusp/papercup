/**
 * backfill-local-state.integration.test.ts — Stage 4 of the feature-content
 * federation plan (papercusp-feature-content-federation-2026-06-01). Real
 * testcontainer PG.
 *
 * Proves the one-time BACKFILL of existing local `*_consolidated` rows into
 * `substrate_outbox` (the Stage-3 drain then appends them to the own log, so
 * rows that existed BEFORE federation shipped reach later-joining peers):
 *
 *  - For each consolidated table, enqueues every row where
 *    `COALESCE(origin,'local')='local'` AND it belongs to THIS (workspace,
 *    harness) — and NOT the `origin='remote'` rows (the echo-loop guard) nor
 *    other harnesses'.
 *  - Each enqueued outbox row mirrors the capture trigger: `table_name`,
 *    `op='put'`, `key`=feature_id/issue_id, `row`=to_jsonb(row), workspace_id,
 *    harness_slug, `ts`, `drained_at` NULL.
 *  - IDEMPOTENT, PER-TARGET (WI-971 gap 2): each target gets its own
 *    `backfill_done:<table>` marker in `substrate_meta`; a second call with
 *    every target already marked returns `{ skipped: true }` and enqueues 0
 *    additional rows. A pre-existing LEGACY flat `backfill_done` marker is
 *    migrated (one time, no re-enqueue) into per-table markers for the
 *    targets that existed under the old scheme.
 *  - ENQUEUE BAIL CAP (WI-971 gap 2 condition (b)): if the candidate row total
 *    across unswept targets exceeds `maxEnqueueBeforeBail`, nothing is
 *    enqueued and no target is marked done (retryable on a later boot).
 *  - Per-author cap (cap-and-warn): `maxOpsPerAuthor` caps the enqueue and
 *    `console.warn`s a `peer_capped`-style message naming how many were dropped.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../../../test/_work-items-schema';
import { backfillLocalState } from './backfill-local-state';
import type { BootedHarnessHandle } from './boot';

const WS = 'ws_backfill';
const SLUG = 'backfill';

/** A minimal fake handle — the backfill only reads `workspaceId`/`harnessSlug`
 *  (it INSERTs into the outbox; it never appends to the log directly). */
function fakeHandle(workspaceId = WS, harnessSlug = SLUG): BootedHarnessHandle {
  return { workspaceId, harnessSlug } as unknown as BootedHarnessHandle;
}

async function seedFeature(
  sql: postgres.Sql,
  id: string,
  opts: {
    origin?: string;
    workspace_id?: string;
    harness_slug?: string;
    fed_ts?: number;
    fed_hlc?: string;
  } = {},
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, workspace_id, title, status, origin, updated_ts, fed_ts, fed_hlc)
    VALUES
      (${opts.harness_slug ?? SLUG}, ${id}, ${opts.workspace_id ?? WS},
       ${`T ${id}`}, 'todo', ${opts.origin ?? 'local'}, 1700,
       ${opts.fed_ts ?? null}, ${opts.fed_hlc ?? null})`;
}

async function seedIssue(
  sql: postgres.Sql,
  id: string,
  opts: { origin?: string; workspace_id?: string; harness_slug?: string } = {},
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.harness_issues_consolidated
      (harness_slug, issue_id, workspace_id, title, severity, source, status,
       found_at, attempts, created_ts, updated_ts, origin)
    VALUES
      (${opts.harness_slug ?? SLUG}, ${id}, ${opts.workspace_id ?? WS},
       ${`I ${id}`}, 'high', 'manual', 'open',
       '2024-05-29T12:00:00.000Z', 0, 1700, 1700, ${opts.origin ?? 'local'})`;
}

async function seedPlan(
  sql: postgres.Sql,
  slug: string,
  opts: { origin?: string; workspace_id?: string; harness_slug?: string } = {},
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.harness_plans
      (harness_slug, plan_slug, workspace_id, title, status, content, origin)
    VALUES
      (${opts.harness_slug ?? SLUG}, ${slug}, ${opts.workspace_id ?? WS},
       ${`P ${slug}`}, 'active', ${`body ${slug}`}, ${opts.origin ?? 'local'})`;
}

async function seedHiveMember(
  sql: postgres.Sql,
  githubUserId: number,
  opts: { origin?: string; workspace_id?: string; pot_home_slug?: string } = {},
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.pot_members
      (workspace_id, pot_home_slug, github_user_id, github_username, origin)
    VALUES
      (${opts.workspace_id ?? WS}, ${opts.pot_home_slug ?? SLUG}, ${githubUserId},
       ${`u${githubUserId}`}, ${opts.origin ?? 'local'})`;
}

async function seedEngineerIssue(
  sql: postgres.Sql,
  id: string,
  opts: {
    scope?: string;
    origin?: string;
    workspace_id?: string;
    fed_ts?: number;
    fed_hlc?: string;
  } = {},
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.engineer_issues
      (workspace_id, issue_id, scope, title, origin, fed_ts, fed_hlc)
    VALUES
      (${opts.workspace_id ?? WS}, ${id}, ${opts.scope ?? `harness:${SLUG}`},
       ${`EI ${id}`}, ${opts.origin ?? 'local'}, ${opts.fed_ts ?? null}, ${opts.fed_hlc ?? null})`;
}

/** WI-971 gap 1: plan_item_assignments backfill target (mig 140 DDL shape). */
async function seedAssignment(
  sql: postgres.Sql,
  planSlug: string,
  itemId: string,
  opts: { origin?: string; workspace_id?: string; harness_slug?: string; assignee?: string } = {},
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.plan_item_assignments
      (workspace_id, harness_slug, plan_slug, item_id, assignee_name, assigned_by_user, origin)
    VALUES
      (${opts.workspace_id ?? WS}, ${opts.harness_slug ?? SLUG}, ${planSlug}, ${itemId},
       ${opts.assignee ?? 'bee-1'}, 'su-test', ${opts.origin ?? 'local'})`;
}

async function outboxRows(sql: postgres.Sql) {
  return sql<{
    table_name: string;
    op: string;
    key: string;
    workspace_id: string;
    harness_slug: string;
    // int8 comes back as a string from postgres.js (precision-safe); compare via Number().
    ts: string;
    op_hlc: string | null;
    drained_at: number | null;
    row: Record<string, unknown> | null;
  }[]>`
    SELECT table_name, op, key, workspace_id, harness_slug, ts, op_hlc, drained_at, row
      FROM harness_shared.substrate_outbox ORDER BY id`;
}

/** Per-table markers currently set for (WS, SLUG) — WI-971 gap 2. */
async function markerTables(sql: postgres.Sql): Promise<string[]> {
  const rows = await sql<{ key: string }[]>`
    SELECT key FROM harness_shared.substrate_meta
     WHERE workspace_id = ${WS} AND harness_slug = ${SLUG} AND key LIKE 'backfill_done:%'
     ORDER BY key`;
  return rows.map((r) => r.key.slice('backfill_done:'.length));
}

describe('backfillLocalState (Stage 4, real PG)', () => {
  let db: FreshPgDb;

  beforeAll(async () => {
    db = await createFreshPgDb('backfill');
    // P-010 unification: work_items base + hfc/ei compat views (the backfill reads
    // hfc + engineer_issues, now views over work_items). NO capture trigger here — the
    // backfill INSERTs into the outbox itself, mirroring the capture in code.
    await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
    await db.sql.unsafe(`
      CREATE TABLE harness_shared.harness_issues_consolidated (
        harness_slug TEXT NOT NULL,
        issue_id     TEXT NOT NULL,
        workspace_id TEXT NOT NULL DEFAULT '',
        title        TEXT,
        severity     TEXT,
        source       TEXT,
        status       TEXT,
        found_at     TIMESTAMPTZ,
        attempts     BIGINT,
        created_ts   BIGINT,
        updated_ts   BIGINT,
        origin       TEXT NOT NULL DEFAULT 'local',
        fed_ts       BIGINT,
        fed_hlc      TEXT,
        PRIMARY KEY (harness_slug, issue_id)
      );
      -- plans-pg-canonical-migration-2026-06-03 (Stage 2) added harness_plans to
      -- BACKFILL_TARGETS (key == plan_slug). HARNESS_FEATURES_CONSOLIDATED_DDL now
      -- creates the key-column stub (workspace_id, harness_slug, plan_slug, status),
      -- so COMPOSE onto it — a re-CREATE collides ("relation already exists", WI-3192).
      -- Add only the extra columns the backfill's SELECT / to_jsonb + seedPlan touch.
      ALTER TABLE harness_shared.harness_plans
        ADD COLUMN IF NOT EXISTS title   TEXT,
        ADD COLUMN IF NOT EXISTS content TEXT,
        ADD COLUMN IF NOT EXISTS origin  TEXT NOT NULL DEFAULT 'local',
        ADD COLUMN IF NOT EXISTS fed_ts  BIGINT,
        ADD COLUMN IF NOT EXISTS fed_hlc TEXT;
      -- shared-hive-federation (P-005) added hive_settings to BACKFILL_TARGETS
      -- (scope == harness_slug) and (P-006) added hive_members (scope ==
      -- hive_home_slug). The fixture must create BOTH or the backfill's count query
      -- hits a missing relation. Subset of the real columns the SELECT / to_jsonb touch.
      CREATE TABLE harness_shared.pot_settings (
        harness_slug TEXT NOT NULL,
        setting_key  TEXT NOT NULL,
        workspace_id TEXT NOT NULL DEFAULT '',
        value        TEXT,
        origin       TEXT NOT NULL DEFAULT 'local',
        fed_ts       BIGINT,
        fed_hlc      TEXT,
        PRIMARY KEY (harness_slug, setting_key)
      );
      CREATE TABLE harness_shared.pot_members (
        workspace_id   TEXT   NOT NULL,
        pot_home_slug  TEXT   NOT NULL,
        github_user_id BIGINT NOT NULL,
        github_username TEXT  NOT NULL DEFAULT '',
        revoked_pubkeys TEXT[] NOT NULL DEFAULT '{}',
        origin         TEXT   NOT NULL DEFAULT 'local',
        fed_ts         BIGINT,
        fed_hlc        TEXT,
        PRIMARY KEY (workspace_id, pot_home_slug, github_user_id)
      );
      -- WI-971 gap 1 fixture (mig 140 real DDL shape, trimmed to the columns the
      -- backfill's SELECT / to_jsonb touch — fed_key is the GENERATED key column the
      -- live capture trigger (mig 145) also keys on).
      --
      -- COMPOSE, do not re-CREATE — same WI-3192 collision the harness_plans block
      -- above records, recurring on a new table. HARNESS_FEATURES_CONSOLIDATED_DDL
      -- (applied just above) gained its own plan_item_assignments in
      -- EI-22040912157347872, so a bare CREATE TABLE here 42P07s
      -- ("relation already exists") inside this one multi-statement unsafe() block.
      -- That throws in beforeAll, which Vitest reports as 14 SKIPPED tests and a
      -- failed FILE — a silently dead suite, not a visible failure. It supplies
      -- every column except fed_ts/fed_hlc, so add exactly those two.
      ALTER TABLE harness_shared.plan_item_assignments
        ADD COLUMN IF NOT EXISTS fed_ts  BIGINT,
        ADD COLUMN IF NOT EXISTS fed_hlc TEXT;
      -- engineer_issues is the unified ei compat VIEW (created by the helper above); the
      -- backfill's issue block reads it + derives the federation slug from scope (operator
      -- resolves via hives).
      CREATE TABLE harness_shared.pots (
        workspace_id  TEXT NOT NULL,
        pot_home_slug TEXT NOT NULL,
        PRIMARY KEY (workspace_id, pot_home_slug)
      );
      CREATE TABLE harness_shared.substrate_outbox (
        id           BIGSERIAL PRIMARY KEY,
        workspace_id TEXT   NOT NULL,
        harness_slug TEXT   NOT NULL,
        table_name   TEXT   NOT NULL,
        op           TEXT   NOT NULL CHECK (op IN ('put', 'del')),
        key          TEXT   NOT NULL,
        row          JSONB,
        ts           BIGINT NOT NULL,
        enqueued_at_ms BIGINT NOT NULL DEFAULT ((EXTRACT(epoch FROM now()) * 1000)::bigint),
        op_hlc       TEXT,
        drained_at   BIGINT,
        drained_log_key TEXT
      );
      CREATE TABLE harness_shared.substrate_meta (
        workspace_id TEXT NOT NULL,
        harness_slug TEXT NOT NULL,
        key          TEXT NOT NULL,
        value        TEXT NOT NULL,
        PRIMARY KEY (workspace_id, harness_slug, key)
      );
    `);
  }, 60_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  beforeEach(async () => {
    await db.sql`TRUNCATE harness_shared.work_items `;
    await db.sql`TRUNCATE harness_shared.harness_issues_consolidated `;
    await db.sql`TRUNCATE harness_shared.harness_plans CASCADE`;
    await db.sql`TRUNCATE harness_shared.pot_settings `;
    await db.sql`TRUNCATE harness_shared.pot_members `;
    await db.sql`TRUNCATE harness_shared.plan_item_assignments `;
    await db.sql`TRUNCATE harness_shared.work_items `;
    await db.sql`TRUNCATE harness_shared.pots `;
    await db.sql`TRUNCATE harness_shared.substrate_outbox  RESTART IDENTITY`;
    await db.sql`TRUNCATE harness_shared.substrate_meta `;
  });

  it('enqueues exactly the local feature + issue + plan rows (not remote, not other harnesses), writes per-target markers', async () => {
    // 4 local features + 2 local issues + 2 local plans for THIS harness.
    await seedFeature(db.sql, 'F-1');
    await seedFeature(db.sql, 'F-2');
    await seedFeature(db.sql, 'F-3');
    await seedFeature(db.sql, 'F-4');
    await seedIssue(db.sql, 'I-1');
    await seedIssue(db.sql, 'I-2');
    // plans-pg-canonical (Stage 2): local plans federate too (key == plan_slug).
    await seedPlan(db.sql, 'P-1');
    await seedPlan(db.sql, 'P-2');
    // 1 remote feature/plan — MUST NOT be enqueued (echo-loop guard).
    await seedFeature(db.sql, 'F-REMOTE', { origin: 'remote' });
    await seedPlan(db.sql, 'P-REMOTE', { origin: 'remote' });
    // A different harness / workspace — MUST NOT be enqueued.
    await seedFeature(db.sql, 'F-OTHER', { harness_slug: 'other' });
    await seedFeature(db.sql, 'F-OTHERWS', { workspace_id: 'other_ws' });
    await seedPlan(db.sql, 'P-OTHER', { harness_slug: 'other' });

    const res = await backfillLocalState(fakeHandle(), db.sql);
    expect(res.skipped).toBe(false);
    expect(res.enqueued).toBe(8);

    const rows = await outboxRows(db.sql);
    expect(rows).toHaveLength(8);
    // All for THIS (workspace, harness), all put, all undrained.
    for (const r of rows) {
      expect(r.workspace_id).toBe(WS);
      expect(r.harness_slug).toBe(SLUG);
      expect(r.op).toBe('put');
      expect(r.drained_at).toBeNull();
    }
    // Features map to the features table-name, issues to the issues one.
    const featureKeys = rows
      .filter((r) => r.table_name === 'harness_features_consolidated')
      .map((r) => r.key)
      .sort();
    const issueKeys = rows
      .filter((r) => r.table_name === 'harness_issues_consolidated')
      .map((r) => r.key)
      .sort();
    const planKeys = rows
      .filter((r) => r.table_name === 'harness_plans')
      .map((r) => r.key)
      .sort();
    expect(featureKeys).toEqual(['F-1', 'F-2', 'F-3', 'F-4']);
    expect(issueKeys).toEqual(['I-1', 'I-2']);
    expect(planKeys).toEqual(['P-1', 'P-2']);

    // The row jsonb mirrors to_jsonb of the consolidated row.
    const f1 = rows.find((r) => r.key === 'F-1');
    expect(f1?.row?.feature_id).toBe('F-1');
    expect(f1?.row?.title).toBe('T F-1');
    expect(f1?.row?.origin).toBe('local');

    // WI-971 gap 2: every target (including the empty ones — pot_settings,
    // pot_members, plan_item_assignments) gets its OWN per-table marker, not one
    // flat 'backfill_done' key.
    const markers = await markerTables(db.sql);
    expect(markers).toEqual(
      [
        'engineer_issues',
        'harness_features_consolidated',
        'harness_issues_consolidated',
        'harness_plans',
        'plan_item_assignments',
        'pot_members',
        'pot_settings',
      ].sort(),
    );
  });

  it('a second call is a no-op (every target marked → skipped, 0 added rows)', async () => {
    await seedFeature(db.sql, 'F-1');
    await seedFeature(db.sql, 'F-2');
    const first = await backfillLocalState(fakeHandle(), db.sql);
    expect(first.skipped).toBe(false);
    expect(first.enqueued).toBe(2);

    const countAfterFirst = (await outboxRows(db.sql)).length;
    expect(countAfterFirst).toBe(2);

    const second = await backfillLocalState(fakeHandle(), db.sql);
    expect(second.skipped).toBe(true);
    expect(second.enqueued).toBe(0);
    // No additional rows enqueued.
    expect((await outboxRows(db.sql)).length).toBe(2);
  });

  it('force ignores every marker and re-enqueues the current local rows for release seed refreshes', async () => {
    await seedFeature(db.sql, 'F-1');
    const first = await backfillLocalState(fakeHandle(), db.sql);
    expect(first).toMatchObject({ skipped: false, enqueued: 1 });

    await seedFeature(db.sql, 'F-2');
    const forced = await backfillLocalState(fakeHandle(), db.sql, { force: true, maxOpsPerAuthor: 0 });
    expect(forced).toMatchObject({ skipped: false, enqueued: 2, dropped: 0 });

    const rows = await outboxRows(db.sql);
    expect(rows.filter((r) => r.table_name === 'harness_features_consolidated').map((r) => r.key).sort()).toEqual([
      'F-1',
      'F-1',
      'F-2',
    ]);
  });

  // ── WI-2141185 / EI-12727 — force must not re-send ALREADY-FEDERATED rows ──
  // This backfill exists to rescue rows that predate the capture trigger and so
  // never fired it (see the plan_item_assignments note in BACKFILL_TARGETS). That
  // condition is `fed_ts IS NULL`, and the enqueue SELECTs never expressed it — so
  // the per-target `backfill_done` marker was the ONLY idempotence guard, and
  // `force` bypasses exactly that marker. The nightly release seed cut runs
  // force:true + maxOpsPerAuthor:0, so it re-enqueued the WHOLE projection every
  // night (2026-09-02: 153,797 in-scope engineer_issues rows, of which 0 were
  // unfederated) and then blocked waiting to drain the flood it had just created.
  // Each drained row is an append to an append-only log — EI-12727's monotonic
  // corestore ratchet — so the cost never came back.
  //
  // NB the force test above stays green either way: its fixtures never set fed_ts,
  // so every row it seeds genuinely needs enqueueing. That is the coverage gap that
  // let this ship — it proved force re-enqueues rows, using rows that should be.
  it('force does NOT re-enqueue already-federated rows, only ones that never federated (WI-2141185 / EI-12727)', async () => {
    // F-1 / EI-1: already federated. F-2 / EI-2: predate federation — the real target.
    await seedFeature(db.sql, 'F-1', { fed_ts: 1_700_000_000_000, fed_hlc: 'hlc-f1' });
    await seedFeature(db.sql, 'F-2');
    await seedEngineerIssue(db.sql, 'EI-1', { fed_ts: 1_700_000_000_000, fed_hlc: 'hlc-ei1' });
    await seedEngineerIssue(db.sql, 'EI-2');

    const forced = await backfillLocalState(fakeHandle(), db.sql, {
      force: true,
      maxOpsPerAuthor: 0,
    });
    expect(forced).toMatchObject({ skipped: false, enqueued: 2, dropped: 0 });

    const rows = await outboxRows(db.sql);
    expect(
      rows.filter((r) => r.table_name === 'harness_features_consolidated').map((r) => r.key),
    ).toEqual(['F-2']);
    expect(rows.filter((r) => r.table_name === 'engineer_issues').map((r) => r.key)).toEqual([
      'EI-2',
    ]);
  });

  it('resyncFederated re-sends federated rows — the deliberate re-anchor escape hatch (WI-2141185)', async () => {
    await seedFeature(db.sql, 'F-1', { fed_ts: 1_700_000_000_000, fed_hlc: 'hlc-f1' });
    await seedEngineerIssue(db.sql, 'EI-1', { fed_ts: 1_700_000_000_000, fed_hlc: 'hlc-ei1' });

    const resync = await backfillLocalState(fakeHandle(), db.sql, {
      force: true,
      resyncFederated: true,
      maxOpsPerAuthor: 0,
    });
    expect(resync).toMatchObject({ skipped: false, enqueued: 2, dropped: 0 });

    const rows = await outboxRows(db.sql);
    expect(
      rows.filter((r) => r.table_name === 'harness_features_consolidated').map((r) => r.key),
    ).toEqual(['F-1']);
    expect(rows.filter((r) => r.table_name === 'engineer_issues').map((r) => r.key)).toEqual([
      'EI-1',
    ]);
  });

  it('per-author cap (maxOpsPerAuthor): enqueues up to the cap and warns about the rest', async () => {
    // 5 local features; cap of 3.
    await seedFeature(db.sql, 'F-1');
    await seedFeature(db.sql, 'F-2');
    await seedFeature(db.sql, 'F-3');
    await seedFeature(db.sql, 'F-4');
    await seedFeature(db.sql, 'F-5');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await backfillLocalState(fakeHandle(), db.sql, { maxOpsPerAuthor: 3 });
      expect(res.skipped).toBe(false);
      expect(res.enqueued).toBe(3);
      expect(res.dropped).toBe(2);

      // Exactly 3 rows enqueued.
      expect((await outboxRows(db.sql)).length).toBe(3);

      // Warned about the 2 dropped (peer_capped-style message).
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('peer_capped'),
      );
      const warnMsg = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warnMsg).toContain('2');
    } finally {
      warnSpy.mockRestore();
    }

    // Markers still written (incl. the capped target) so a re-boot doesn't re-enqueue.
    const markers = await markerTables(db.sql);
    expect(markers).toContain('harness_features_consolidated');
  });

  it('no local rows → enqueues 0, still writes every target marker (idempotent on empty)', async () => {
    await seedFeature(db.sql, 'F-REMOTE', { origin: 'remote' });
    const res = await backfillLocalState(fakeHandle(), db.sql);
    expect(res.skipped).toBe(false);
    expect(res.enqueued).toBe(0);
    expect((await outboxRows(db.sql)).length).toBe(0);

    // Second call skipped.
    const second = await backfillLocalState(fakeHandle(), db.sql);
    expect(second.skipped).toBe(true);
  });

  it('backfills local engineer_issues — harness-scoped always, operator-scope iff this harness is the single Hive home (B5)', async () => {
    // Harness-scoped local rows for THIS harness → enqueued (scope derived to SLUG).
    await seedEngineerIssue(db.sql, 'EI-1', { scope: `harness:${SLUG}` });
    await seedEngineerIssue(db.sql, 'EI-2', { scope: `harness:${SLUG}` });
    // remote → echo-loop guard; other harness → not ours; operator (no hive yet) → local.
    await seedEngineerIssue(db.sql, 'EI-R', { scope: `harness:${SLUG}`, origin: 'remote' });
    await seedEngineerIssue(db.sql, 'EI-O', { scope: 'harness:other' });
    await seedEngineerIssue(db.sql, 'EI-OP', { scope: 'operator' });

    // With NO Hive home, operator-scope stays local: only the 2 harness-scoped rows.
    const res1 = await backfillLocalState(fakeHandle(), db.sql);
    expect(res1.skipped).toBe(false);
    const eiRows1 = (await outboxRows(db.sql)).filter((r) => r.table_name === 'engineer_issues');
    expect(eiRows1.map((r) => r.key).sort()).toEqual(['EI-1', 'EI-2']);
    for (const r of eiRows1) {
      expect(r.harness_slug).toBe(SLUG);
      expect(r.row?.harness_slug).toBe(SLUG); // stamped for the projection demux
    }

    // Now make THIS harness the workspace's single Hive home + clear ONLY the
    // engineer_issues per-table marker (WI-971 gap 2: markers are per-target now)
    // so a re-backfill picks up the operator-scope row too, without re-sweeping
    // every other already-done target.
    await db.sql`INSERT INTO harness_shared.pots (workspace_id, pot_home_slug) VALUES (${WS}, ${SLUG})`;
    await db.sql`TRUNCATE harness_shared.substrate_outbox  RESTART IDENTITY`;
    await db.sql`DELETE FROM harness_shared.substrate_meta WHERE key = 'backfill_done:engineer_issues'`;

    const res2 = await backfillLocalState(fakeHandle(), db.sql);
    expect(res2.skipped).toBe(false);
    const eiRows2 = (await outboxRows(db.sql)).filter((r) => r.table_name === 'engineer_issues');
    // The operator-scope row now rides the Hive home too.
    expect(eiRows2.map((r) => r.key).sort()).toEqual(['EI-1', 'EI-2', 'EI-OP']);
    const op = eiRows2.find((r) => r.key === 'EI-OP');
    expect(op?.harness_slug).toBe(SLUG);
    expect(op?.row?.harness_slug).toBe(SLUG);
    expect(op?.row?.scope).toBe('operator'); // the row keeps operator scope
  });

  it('backfills local hive_members scoped by hive_home_slug (P-006 multi-Swarm admission)', async () => {
    // 2 local members of THIS Hive home (SLUG) + a remote one + a member of a DIFFERENT Hive.
    await seedHiveMember(db.sql, 11);
    await seedHiveMember(db.sql, 22);
    await seedHiveMember(db.sql, 33, { origin: 'remote' }); // echo-loop guard → NOT enqueued
    await seedHiveMember(db.sql, 44, { pot_home_slug: 'other-hive' }); // other Pot → NOT enqueued
    // A local feature too, so the marker/loop isn't a single-table run.
    await seedFeature(db.sql, 'F-1');

    const res = await backfillLocalState(fakeHandle(), db.sql);
    expect(res.skipped).toBe(false);

    const rows = await outboxRows(db.sql);
    const memberRows = rows.filter((r) => r.table_name === 'pot_members');
    // Only the 2 local SLUG-scoped members, keyed by github_user_id (the trigger's
    // TG_ARGV[0]), scoped to the Pot home (outbox harness_slug == pot_home_slug).
    expect(memberRows.map((r) => r.key).sort()).toEqual(['11', '22']);
    for (const r of memberRows) {
      expect(r.harness_slug).toBe(SLUG);
      expect(r.op).toBe('put');
      expect(r.row?.pot_home_slug).toBe(SLUG);
    }
  });

  it('threads each row\'s OWN fed_ts/fed_hlc onto the outbox op — never the boot clock (mig 446 symmetry, WI-1433 regression)', async () => {
    // ROOT CAUSE this test guards: pre-fix the backfill re-enqueued a joiner's
    // pre-existing LOCAL rows with `ts=${now}` (boot time) and NO op_hlc. On the
    // receiver the projection persists the WIRE ts as fed_ts and mints a fresh HLC —
    // so a genuinely-OLD row got re-stamped with a LATER boot time and clobbered a
    // newer remote row under LWW (`fed_order_key`). The fix mirrors mig 446's
    // `capture_*_outbox`: a STAMPED local row (fed_hlc present ⇒ the mig-314 BEFORE
    // trigger stamped fed_ts atomically) carries its OWN immutable fed_ts/fed_hlc
    // through; only an UNSTAMPED row (fed_hlc NULL, pre-federation) takes now().
    const FED_TS = 1782944750814; // genuine ~2026-07-01 write (WI-1433's real `ts`)
    const FED_HLC = '001782944750814:00000:abc0000000000001';
    const EI_FED_TS = 1782944888888;
    const EI_FED_HLC = '001782944888888:00000:abc0000000000002';
    const BOOT = 1783053983790; // a LATER backfill boot clock (~30h after the write)

    // Stamped rows on BOTH INSERT paths (features INSERT + engineer_issues INSERT).
    await seedFeature(db.sql, 'F-STAMPED', { fed_ts: FED_TS, fed_hlc: FED_HLC });
    await seedEngineerIssue(db.sql, 'EI-STAMPED', {
      scope: `harness:${SLUG}`,
      fed_ts: EI_FED_TS,
      fed_hlc: EI_FED_HLC,
    });
    // An UNSTAMPED local row (fed_hlc NULL) — pre-federation baseline, no stamp.
    await seedFeature(db.sql, 'F-UNSTAMPED');

    // WI-2141185: `resyncFederated` is REQUIRED to reach this behaviour now, and no
    // assertion below is relaxed — the guard is routed, not weakened. A STAMPED row
    // has fed_ts set, and the default predicate deliberately skips already-federated
    // rows, so re-sending one is exactly what resyncFederated means. That makes this
    // invariant MORE load-bearing than before, not less: a deliberate re-anchor is
    // now the only way a stamped row goes back on the wire, so it is the only
    // remaining path that could re-stamp an old row with a later clock and clobber a
    // newer peer under LWW — the WI-1433 bug this test exists to catch.
    const res = await backfillLocalState(fakeHandle(), db.sql, {
      now: BOOT,
      resyncFederated: true,
    });
    expect(res.skipped).toBe(false);

    const rows = await outboxRows(db.sql);
    const stampedF = rows.find((r) => r.key === 'F-STAMPED');
    const stampedEI = rows.find((r) => r.key === 'EI-STAMPED');
    const unstamped = rows.find((r) => r.key === 'F-UNSTAMPED');

    // Features INSERT: the stamped row threads its OWN stamp, NOT the boot clock.
    expect(Number(stampedF?.ts)).toBe(FED_TS);
    expect(stampedF?.op_hlc).toBe(FED_HLC);
    expect(Number(stampedF?.ts)).not.toBe(BOOT);

    // engineer_issues INSERT: same symmetry on the second code path.
    expect(stampedEI?.table_name).toBe('engineer_issues');
    expect(Number(stampedEI?.ts)).toBe(EI_FED_TS);
    expect(stampedEI?.op_hlc).toBe(EI_FED_HLC);

    // An unstamped (pre-federation) row keeps the boot clock; op_hlc NULL so the
    // Stage-3 drain mints a fresh HLC (matches mig 446's `fed_hlc IS NULL → now()`).
    expect(Number(unstamped?.ts)).toBe(BOOT);
    expect(unstamped?.op_hlc).toBeNull();
  });

  // ── WI-971 gap 1: plan_item_assignments was simply missing from BACKFILL_TARGETS ──
  describe('WI-971 gap 1 — plan_item_assignments backfill', () => {
    it('enqueues local pre-existing plan_item_assignments rows (not remote, not other harnesses)', async () => {
      await seedAssignment(db.sql, 'plan-a', 'P-1');
      await seedAssignment(db.sql, 'plan-a', 'P-2');
      await seedAssignment(db.sql, 'plan-b', 'P-1', { origin: 'remote' }); // echo-loop guard
      await seedAssignment(db.sql, 'plan-c', 'P-1', { harness_slug: 'other' }); // other harness

      const res = await backfillLocalState(fakeHandle(), db.sql);
      expect(res.skipped).toBe(false);

      const rows = (await outboxRows(db.sql)).filter((r) => r.table_name === 'plan_item_assignments');
      // fed_key is the generated `plan_slug:item_id` column — the SAME key the live
      // capture trigger (mig 145) uses, so receive-side projection demux is identical.
      expect(rows.map((r) => r.key).sort()).toEqual(['plan-a:P-1', 'plan-a:P-2']);
      for (const r of rows) {
        expect(r.workspace_id).toBe(WS);
        expect(r.harness_slug).toBe(SLUG);
        expect(r.row?.assignee_name).toBe('bee-1');
      }

      const markers = await markerTables(db.sql);
      expect(markers).toContain('plan_item_assignments');
    });

    it('LEGACY MARKER MIGRATION: a harness with a pre-existing FLAT backfill_done marker does NOT re-sweep already-covered tables, but DOES backfill the newly-added plan_item_assignments target', async () => {
      // Simulate a harness that ran the OLD (pre-per-target) backfill: a feature row
      // that "already federated" under the flat scheme (so re-sweeping it would be a
      // visible regression — a real peer could already have consumed the equivalent
      // live op, and a duplicate/stale re-enqueue risks a spurious LWW clobber), plus
      // the flat marker itself, with NO per-table markers yet.
      await seedFeature(db.sql, 'F-OLD');
      await db.sql`
        INSERT INTO harness_shared.substrate_meta (workspace_id, harness_slug, key, value)
        VALUES (${WS}, ${SLUG}, 'backfill_done', '1700000000000')`;

      // A genuinely NEW target relative to the legacy set: a plan_item_assignments row
      // that predates this fix landing (or predates mig 145) — this is exactly the
      // row that was permanently stuck before gap 1.
      await seedAssignment(db.sql, 'plan-new', 'P-1');

      const res = await backfillLocalState(fakeHandle(), db.sql);
      expect(res.skipped).toBe(false);

      const rows = await outboxRows(db.sql);
      // F-OLD is NOT re-enqueued (legacy marker covers harness_features_consolidated).
      expect(rows.find((r) => r.key === 'F-OLD')).toBeUndefined();
      // The new target IS enqueued.
      const assignmentRows = rows.filter((r) => r.table_name === 'plan_item_assignments');
      expect(assignmentRows.map((r) => r.key)).toEqual(['plan-new:P-1']);

      // Every legacy-covered target now has its OWN per-table marker (migrated from
      // the flat one), stamped with the flat marker's original value/timestamp.
      const legacyMarkerRow = await db.sql<{ value: string }[]>`
        SELECT value FROM harness_shared.substrate_meta
         WHERE workspace_id = ${WS} AND harness_slug = ${SLUG}
           AND key = 'backfill_done:harness_features_consolidated'`;
      expect(legacyMarkerRow[0]?.value).toBe('1700000000000');

      const markers = await markerTables(db.sql);
      expect(markers).toEqual(
        [
          'engineer_issues',
          'harness_features_consolidated',
          'harness_issues_consolidated',
          'harness_plans',
          'plan_item_assignments',
          'pot_members',
          'pot_settings',
        ].sort(),
      );

      // A subsequent call is now fully a no-op — everything (legacy-migrated AND
      // the newly-backfilled target) is marked done.
      const second = await backfillLocalState(fakeHandle(), db.sql);
      expect(second.skipped).toBe(true);
      expect(second.enqueued).toBe(0);
    });
  });

  // ── WI-971 gap 2 condition (b): don't flood an already-backlogged outbox ──────
  describe('WI-971 gap 2(b) — enqueue bail cap', () => {
    it('bails (nothing enqueued, no target marked done) when the candidate total exceeds the cap, and a later call (once the cap allows it) succeeds', async () => {
      await seedFeature(db.sql, 'F-1');
      await seedFeature(db.sql, 'F-2');
      await seedFeature(db.sql, 'F-3');

      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const res = await backfillLocalState(fakeHandle(), db.sql, { maxEnqueueBeforeBail: 2 });
      // Assert on the spy's recorded calls BEFORE restoring it — mockRestore()
      // resets the call history (it's mockReset() + restore-original), so
      // asserting after restore always sees 0 calls regardless of what actually
      // happened (caught this via a real test run, not just review).
      expect(res).toMatchObject({ skipped: false, enqueued: 0, dropped: 0, bailed: true, candidateTotal: 3 });
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('BAIL'));
      errSpy.mockRestore();

      // Nothing enqueued, no marker written — fully retryable.
      expect((await outboxRows(db.sql)).length).toBe(0);
      expect(await markerTables(db.sql)).toEqual([]);

      // A later call under a cap that now covers the candidate total succeeds normally.
      const retried = await backfillLocalState(fakeHandle(), db.sql, { maxEnqueueBeforeBail: 100 });
      expect(retried.bailed).toBeFalsy();
      expect(retried.enqueued).toBe(3);
    });

    it('maxEnqueueBeforeBail: 0 disables the bail cap entirely', async () => {
      await seedFeature(db.sql, 'F-1');
      await seedFeature(db.sql, 'F-2');
      const res = await backfillLocalState(fakeHandle(), db.sql, { maxEnqueueBeforeBail: 0 });
      expect(res).toMatchObject({ skipped: false, enqueued: 2 });
      expect(res.bailed).toBeUndefined();
    });
  });
});
