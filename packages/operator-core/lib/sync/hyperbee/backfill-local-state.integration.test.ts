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
 *  - IDEMPOTENT: writes a `backfill_done` marker into `substrate_meta`; a second
 *    call returns `{ skipped: true }` and enqueues 0 additional rows.
 *  - Per-author cap (cap-and-warn): `maxOpsPerAuthor` caps the enqueue and
 *    `console.warn`s a `peer_capped`-style message naming how many were dropped.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
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
  opts: { origin?: string; workspace_id?: string; harness_slug?: string } = {},
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, workspace_id, title, status, origin, updated_ts)
    VALUES
      (${opts.harness_slug ?? SLUG}, ${id}, ${opts.workspace_id ?? WS},
       ${`T ${id}`}, 'todo', ${opts.origin ?? 'local'}, 1700)`;
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
  opts: { origin?: string; workspace_id?: string; hive_home_slug?: string } = {},
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.hive_members
      (workspace_id, hive_home_slug, github_user_id, github_username, origin)
    VALUES
      (${opts.workspace_id ?? WS}, ${opts.hive_home_slug ?? SLUG}, ${githubUserId},
       ${`u${githubUserId}`}, ${opts.origin ?? 'local'})`;
}

async function outboxRows(sql: postgres.Sql) {
  return sql<{
    table_name: string;
    op: string;
    key: string;
    workspace_id: string;
    harness_slug: string;
    drained_at: number | null;
    row: Record<string, unknown> | null;
  }[]>`
    SELECT table_name, op, key, workspace_id, harness_slug, drained_at, row
      FROM harness_shared.substrate_outbox ORDER BY id`;
}

describe('backfillLocalState (Stage 4, real PG)', () => {
  let db: FreshPgDb;

  beforeAll(async () => {
    db = await createFreshPgDb('backfill');
    // The consolidated tables (subset of the real columns the SELECT touches),
    // the outbox, and the marker table. NO capture trigger here — the backfill
    // INSERTs into the outbox itself, so the trigger is irrelevant; and we want
    // to seed remote rows without them being filtered by the trigger anyway.
    await db.sql.unsafe(`
      CREATE TABLE harness_shared.harness_features_consolidated (
        harness_slug TEXT NOT NULL,
        feature_id   TEXT NOT NULL,
        workspace_id TEXT NOT NULL DEFAULT '',
        title        TEXT,
        status       TEXT,
        updated_ts   BIGINT,
        origin       TEXT NOT NULL DEFAULT 'local',
        PRIMARY KEY (harness_slug, feature_id)
      );
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
        PRIMARY KEY (harness_slug, issue_id)
      );
      -- plans-pg-canonical-migration-2026-06-03 (Stage 2) added harness_plans to
      -- BACKFILL_TARGETS (key == plan_slug); the fixture must create it or the
      -- backfill's count query hits a missing relation. Subset of the real
      -- columns the SELECT / to_jsonb touch.
      CREATE TABLE harness_shared.harness_plans (
        harness_slug TEXT NOT NULL,
        plan_slug    TEXT NOT NULL,
        workspace_id TEXT NOT NULL DEFAULT '',
        title        TEXT,
        status       TEXT,
        content      TEXT,
        origin       TEXT NOT NULL DEFAULT 'local',
        PRIMARY KEY (harness_slug, plan_slug)
      );
      -- shared-hive-federation (P-005) added hive_settings to BACKFILL_TARGETS
      -- (scope == harness_slug) and (P-006) added hive_members (scope ==
      -- hive_home_slug). The fixture must create BOTH or the backfill's count query
      -- hits a missing relation. Subset of the real columns the SELECT / to_jsonb touch.
      CREATE TABLE harness_shared.hive_settings (
        harness_slug TEXT NOT NULL,
        setting_key  TEXT NOT NULL,
        workspace_id TEXT NOT NULL DEFAULT '',
        value        TEXT,
        origin       TEXT NOT NULL DEFAULT 'local',
        PRIMARY KEY (harness_slug, setting_key)
      );
      CREATE TABLE harness_shared.hive_members (
        workspace_id   TEXT   NOT NULL,
        hive_home_slug TEXT   NOT NULL,
        github_user_id BIGINT NOT NULL,
        github_username TEXT  NOT NULL DEFAULT '',
        revoked_pubkeys TEXT[] NOT NULL DEFAULT '{}',
        origin         TEXT   NOT NULL DEFAULT 'local',
        PRIMARY KEY (workspace_id, hive_home_slug, github_user_id)
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
        drained_at   BIGINT
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
    await db.sql`TRUNCATE harness_shared.harness_features_consolidated`;
    await db.sql`TRUNCATE harness_shared.harness_issues_consolidated`;
    await db.sql`TRUNCATE harness_shared.harness_plans`;
    await db.sql`TRUNCATE harness_shared.hive_settings`;
    await db.sql`TRUNCATE harness_shared.hive_members`;
    await db.sql`TRUNCATE harness_shared.substrate_outbox RESTART IDENTITY`;
    await db.sql`TRUNCATE harness_shared.substrate_meta`;
  });

  it('enqueues exactly the local feature + issue + plan rows (not remote, not other harnesses), writes the marker', async () => {
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

    // The marker is written.
    const [{ value }] = await db.sql<{ value: string }[]>`
      SELECT value FROM harness_shared.substrate_meta
       WHERE workspace_id = ${WS} AND harness_slug = ${SLUG} AND key = 'backfill_done'`;
    expect(value).toBeTruthy();
  });

  it('a second call is a no-op (marker present → skipped, 0 added rows)', async () => {
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

    // Marker still written so a re-boot doesn't re-enqueue the capped backfill.
    const [{ value }] = await db.sql<{ value: string }[]>`
      SELECT value FROM harness_shared.substrate_meta
       WHERE workspace_id = ${WS} AND harness_slug = ${SLUG} AND key = 'backfill_done'`;
    expect(value).toBeTruthy();
  });

  it('no local rows → enqueues 0, still writes the marker (idempotent on empty)', async () => {
    await seedFeature(db.sql, 'F-REMOTE', { origin: 'remote' });
    const res = await backfillLocalState(fakeHandle(), db.sql);
    expect(res.skipped).toBe(false);
    expect(res.enqueued).toBe(0);
    expect((await outboxRows(db.sql)).length).toBe(0);

    // Second call skipped.
    const second = await backfillLocalState(fakeHandle(), db.sql);
    expect(second.skipped).toBe(true);
  });

  it('backfills local hive_members scoped by hive_home_slug (P-006 multi-Swarm admission)', async () => {
    // 2 local members of THIS Hive home (SLUG) + a remote one + a member of a DIFFERENT Hive.
    await seedHiveMember(db.sql, 11);
    await seedHiveMember(db.sql, 22);
    await seedHiveMember(db.sql, 33, { origin: 'remote' }); // echo-loop guard → NOT enqueued
    await seedHiveMember(db.sql, 44, { hive_home_slug: 'other-hive' }); // other Hive → NOT enqueued
    // A local feature too, so the marker/loop isn't a single-table run.
    await seedFeature(db.sql, 'F-1');

    const res = await backfillLocalState(fakeHandle(), db.sql);
    expect(res.skipped).toBe(false);

    const rows = await outboxRows(db.sql);
    const memberRows = rows.filter((r) => r.table_name === 'hive_members');
    // Only the 2 local SLUG-scoped members, keyed by github_user_id (the trigger's
    // TG_ARGV[0]), scoped to the Hive home (outbox harness_slug == hive_home_slug).
    expect(memberRows.map((r) => r.key).sort()).toEqual(['11', '22']);
    for (const r of memberRows) {
      expect(r.harness_slug).toBe(SLUG);
      expect(r.op).toBe('put');
      expect(r.row?.hive_home_slug).toBe(SLUG);
    }
  });
});
