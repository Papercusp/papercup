/**
 * substrate-outbox-trigger.integration.test.ts — Stage 1 of the feature-content
 * federation plan (papercusp-feature-content-federation-2026-06-01).
 *
 * Proves the CDC capture seam: an AFTER INSERT/UPDATE/DELETE trigger on the two
 * consolidated tables (`harness_features_consolidated`, `harness_issues_consolidated`)
 * enqueues a row into `harness_shared.substrate_outbox` for every LOCAL-origin
 * write, and — crucially — enqueues NOTHING for a `origin='remote'` write (the
 * echo-loop guard, D-2). Without the guard a peer's projected op would be
 * re-captured and federated back forever.
 *
 * This test owns its schema: it creates minimal but column-faithful versions of
 * the two consolidated tables (matching the real 001-shared / 029 / 030 / 097
 * shapes for the columns the trigger + assertions touch) and applies the Stage-1
 * migration DDL (libs/papercusp/libs/db/sql/102-substrate-outbox.sql) verbatim. It
 * does NOT depend on the dev DB.
 *
 * NOTIFY: the trigger fires `pg_notify('substrate_outbox', ...)`. Asserting an
 * actual NOTIFY delivery in-process is awkward (needs a dedicated LISTEN
 * connection + race-free wait), so we leave NOTIFY-delivery coverage to the
 * Stage-3 drain test and here assert (a) the outbox-row behavior and (b) that the
 * migration's trigger function source references pg_notify('substrate_outbox',…).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from "./../../../../test/_work-items-schema";

const HERE = dirname(fileURLToPath(import.meta.url));
// __tests__/ → hyperbee/ → sync/ → lib/ → operator/ → apps/ → papercup/
const MIGRATION_PATH = resolve(
  HERE,
  '../../../../../../libs/papercusp/libs/db/sql/archive/102-substrate-outbox.sql',
);
// Migration 103: BEFORE INSERT fill of workspace_id from projects on both
// consolidated tables (the Stage-1 fix — issues had no workspace_id source, so
// their outbox rows landed workspace_id='' and the Stage-3 drain never matched).
const FILL_MIGRATION_PATH = resolve(
  HERE,
  '../../../../../../libs/papercusp/libs/db/sql/archive/103-issues-workspace-id-fill-trigger.sql',
);

const WS = 'ws_fed';
const SLUG = 'fed';
// A second harness whose workspace_id is resolved purely by the 103 fill trigger
// (via the projects lookup) rather than supplied by the INSERT.
const SLUG_FILL = 'fed_fill';
const WS_FILL = 'ws_fed_resolved';

interface OutboxRow {
  id: string | number;
  workspace_id: string;
  harness_slug: string;
  table_name: string;
  op: string;
  key: string;
  row: Record<string, unknown> | null;
  ts: number;
  drained_at: number | null;
}

describe('substrate-outbox capture triggers (Stage 1, real PG)', () => {
  let db: FreshPgDb;

  beforeAll(async () => {
    db = await createFreshPgDb('substrate_outbox');
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);

    // The migration GRANTs to harness_app / harness_admin (the runtime roles);
    // the throwaway testcontainer DB has neither, so create no-login stubs so
    // the migration's GRANT statements resolve. (NOLOGIN = pure grant targets.)
    await db.sql.unsafe(`
      DO $r$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_app') THEN
          CREATE ROLE harness_app NOLOGIN;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_admin') THEN
          CREATE ROLE harness_admin NOLOGIN;
        END IF;
      END $r$;
    `);

    // Minimal but column-faithful consolidated tables. We include workspace_id on
    // BOTH (the Stage-1 migration adds it to issues_consolidated to match
    // features_consolidated, since the per-(workspace,harness) drain needs it),
    // the content columns the projection writes, the G1 provenance columns
    // (origin / author_pubkey, migration 097), and ts columns.
    await db.sql.unsafe(`
      CREATE TABLE harness_shared.harness_features_consolidated (
        workspace_id         TEXT NOT NULL DEFAULT '',
        harness_slug         TEXT NOT NULL,
        feature_id           TEXT NOT NULL,
        title                TEXT,
        summary              TEXT,
        status               TEXT,
        attempts             BIGINT,
        claims               TEXT,
        notes                TEXT,
        metadata             JSONB,
        kind                 TEXT,
        project_id           TEXT,
        expected_cost_cents  BIGINT,
        tags                 JSONB,
        needs_human_review   BOOLEAN,
        ts                   BIGINT,
        created_ts           BIGINT,
        updated_ts           BIGINT,
        parent_id            TEXT,
        goal_id              TEXT,
        taken_by             TEXT,
        taken_at             TIMESTAMPTZ,
        expires_at           TIMESTAMPTZ,
        author_pubkey        TEXT,
        origin               TEXT NOT NULL DEFAULT 'local',
        PRIMARY KEY (harness_slug, feature_id)
      );
      CREATE TABLE harness_shared.harness_issues_consolidated (
        harness_slug      TEXT NOT NULL,
        issue_id          TEXT NOT NULL,
        title             TEXT NOT NULL,
        severity          TEXT NOT NULL,
        source            TEXT NOT NULL,
        status            TEXT NOT NULL,
        found_at          TIMESTAMPTZ NOT NULL,
        found_during      TEXT,
        repro             TEXT,
        evidence          TEXT,
        suggested_fix     TEXT,
        code_pointer      TEXT,
        linked_feature_id TEXT,
        attempts          BIGINT NOT NULL DEFAULT 0,
        notes             JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_ts        BIGINT NOT NULL,
        updated_ts        BIGINT NOT NULL,
        author_pubkey     TEXT,
        origin            TEXT NOT NULL DEFAULT 'local',
        PRIMARY KEY (harness_slug, issue_id)
      );
    `);

    // projects: the slug→workspace_id map the 103 fill trigger resolves against.
    // Map SLUG_FILL → WS_FILL; leave SLUG out so the SLUG-based tests keep
    // supplying workspace_id explicitly (the trigger's fast path).
    await db.sql.unsafe(`
      CREATE TABLE harness_shared.projects (
        slug         TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL
      );
    `);
    await db.sql`INSERT INTO harness_shared.projects (slug, workspace_id)
      VALUES (${SLUG_FILL}, ${WS_FILL})`;

    // Apply the Stage-1 migration verbatim. The migration ALTERs
    // harness_issues_consolidated to add workspace_id (idempotent), creates the
    // substrate_outbox table, the capture function, and both triggers.
    const migration = readFileSync(MIGRATION_PATH, 'utf8');
    await db.sql.unsafe(migration);

    // Apply the Stage-1 fix migration (103): defines
    // fill_workspace_id_from_projects() + attaches the BEFORE INSERT fill
    // triggers on both consolidated tables, and backfills empty workspace_id.
    const fillMigration = readFileSync(FILL_MIGRATION_PATH, 'utf8');
    await db.sql.unsafe(fillMigration);
  }, 60_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  // ── helpers ──────────────────────────────────────────────────────────────
  const insertFeature = (featureId: string, origin: string) =>
    db.sql`INSERT INTO harness_shared.harness_features_consolidated
      (workspace_id, harness_slug, feature_id, title, summary, status, origin)
      VALUES (${WS}, ${SLUG}, ${featureId}, ${'T ' + featureId}, 'summary', 'todo', ${origin})`;

  const insertIssue = (issueId: string, origin: string) =>
    db.sql`INSERT INTO harness_shared.harness_issues_consolidated
      (workspace_id, harness_slug, issue_id, title, severity, source, status, found_at, attempts, created_ts, updated_ts, origin)
      VALUES (${WS}, ${SLUG}, ${issueId}, ${'I ' + issueId}, 'high', 'manual', 'open', now(), 0, 1, 1, ${origin})`;

  const outboxFor = (tableName: string, key: string) =>
    db.sql<OutboxRow[]>`
      SELECT * FROM harness_shared.substrate_outbox
       WHERE table_name = ${tableName} AND key = ${key}
       ORDER BY id ASC`;

  // ── features ────────────────────────────────────────────────────────────
  it('INSERT of a local feature enqueues exactly one put outbox row carrying the full row', async () => {
    await insertFeature('F-LOCAL', 'local');
    const rows = await outboxFor('harness_features_consolidated', 'F-LOCAL');
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.table_name).toBe('harness_features_consolidated');
    expect(r.op).toBe('put');
    expect(r.key).toBe('F-LOCAL');
    expect(r.workspace_id).toBe(WS);
    expect(r.harness_slug).toBe(SLUG);
    expect(r.drained_at).toBeNull();
    expect(typeof r.ts).toBe('number');
    expect(r.ts).toBeGreaterThan(0);
    // The full row is captured as jsonb.
    expect(r.row).toMatchObject({
      harness_slug: SLUG,
      feature_id: 'F-LOCAL',
      title: 'T F-LOCAL',
      status: 'todo',
      origin: 'local',
    });
  });

  it('INSERT of a remote feature enqueues NOTHING (echo-loop guard)', async () => {
    await insertFeature('F-REMOTE', 'remote');
    const rows = await outboxFor('harness_features_consolidated', 'F-REMOTE');
    expect(rows).toHaveLength(0);
  });

  it('UPDATE of a local feature enqueues another put row carrying the new state', async () => {
    await db.sql`UPDATE harness_shared.harness_features_consolidated
       SET status = 'in_progress', summary = 'updated'
       WHERE harness_slug = ${SLUG} AND feature_id = 'F-LOCAL'`;
    const rows = await outboxFor('harness_features_consolidated', 'F-LOCAL');
    // Original INSERT put + this UPDATE put.
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const last = rows[rows.length - 1];
    expect(last.op).toBe('put');
    expect(last.row).toMatchObject({ status: 'in_progress', summary: 'updated' });
  });

  it('DELETE of a local feature enqueues a del row carrying the key', async () => {
    await db.sql`DELETE FROM harness_shared.harness_features_consolidated
       WHERE harness_slug = ${SLUG} AND feature_id = 'F-LOCAL'`;
    const rows = await outboxFor('harness_features_consolidated', 'F-LOCAL');
    const del = rows.find((x) => x.op === 'del');
    expect(del).toBeTruthy();
    expect(del!.key).toBe('F-LOCAL');
    expect(del!.workspace_id).toBe(WS);
    expect(del!.harness_slug).toBe(SLUG);
  });

  // ── issues (same four assertions) ─────────────────────────────────────────
  it('INSERT of a local issue enqueues exactly one put outbox row carrying the full row', async () => {
    await insertIssue('I-LOCAL', 'local');
    const rows = await outboxFor('harness_issues_consolidated', 'I-LOCAL');
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.table_name).toBe('harness_issues_consolidated');
    expect(r.op).toBe('put');
    expect(r.key).toBe('I-LOCAL');
    expect(r.workspace_id).toBe(WS);
    expect(r.harness_slug).toBe(SLUG);
    expect(r.drained_at).toBeNull();
    expect(r.row).toMatchObject({
      harness_slug: SLUG,
      issue_id: 'I-LOCAL',
      title: 'I I-LOCAL',
      status: 'open',
      origin: 'local',
    });
  });

  it('INSERT of a remote issue enqueues NOTHING (echo-loop guard)', async () => {
    await insertIssue('I-REMOTE', 'remote');
    const rows = await outboxFor('harness_issues_consolidated', 'I-REMOTE');
    expect(rows).toHaveLength(0);
  });

  it('UPDATE of a local issue enqueues another put row carrying the new state', async () => {
    await db.sql`UPDATE harness_shared.harness_issues_consolidated
       SET status = 'resolved', updated_ts = 2
       WHERE harness_slug = ${SLUG} AND issue_id = 'I-LOCAL'`;
    const rows = await outboxFor('harness_issues_consolidated', 'I-LOCAL');
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const last = rows[rows.length - 1];
    expect(last.op).toBe('put');
    expect(last.row).toMatchObject({ status: 'resolved' });
  });

  it('DELETE of a local issue enqueues a del row carrying the key', async () => {
    await db.sql`DELETE FROM harness_shared.harness_issues_consolidated
       WHERE harness_slug = ${SLUG} AND issue_id = 'I-LOCAL'`;
    const rows = await outboxFor('harness_issues_consolidated', 'I-LOCAL');
    const del = rows.find((x) => x.op === 'del');
    expect(del).toBeTruthy();
    expect(del!.key).toBe('I-LOCAL');
    expect(del!.workspace_id).toBe(WS);
    expect(del!.harness_slug).toBe(SLUG);
  });

  // ── workspace_id fill (migration 103 — the Stage-1 bug fix) ────────────────
  // The bug: issues_consolidated had no workspace_id source, so a local issue
  // write landed workspace_id='' → its outbox row got '' → the Stage-3 drain
  // (keyed on the booted harness's REAL workspaceId) never matched it. The 103
  // fill trigger resolves workspace_id from projects on BEFORE INSERT, so the
  // AFTER capture trigger enqueues the real value.
  it('a local issue inserted WITHOUT workspace_id gets the real ws on its outbox row (not "")', async () => {
    // Note: no workspace_id column in this INSERT — the 103 fill trigger must
    // resolve it from projects (SLUG_FILL → WS_FILL).
    await db.sql`INSERT INTO harness_shared.harness_issues_consolidated
      (harness_slug, issue_id, title, severity, source, status, found_at, attempts, created_ts, updated_ts, origin)
      VALUES (${SLUG_FILL}, 'I-FILL', 'I I-FILL', 'high', 'manual', 'open', now(), 0, 1, 1, 'local')`;

    // The consolidated row itself carries the resolved workspace_id.
    const [issueRow] = await db.sql<{ workspace_id: string }[]>`
      SELECT workspace_id FROM harness_shared.harness_issues_consolidated
       WHERE harness_slug = ${SLUG_FILL} AND issue_id = 'I-FILL'`;
    expect(issueRow.workspace_id).toBe(WS_FILL);

    // And — the point of the fix — the outbox row carries the SAME real
    // workspace_id, not '' (which the Stage-3 drain would never match).
    const rows = await outboxFor('harness_issues_consolidated', 'I-FILL');
    expect(rows).toHaveLength(1);
    expect(rows[0].workspace_id).toBe(WS_FILL);
    expect(rows[0].workspace_id).not.toBe('');
  });

  it('a local feature inserted WITHOUT workspace_id also gets the real ws on its outbox row', async () => {
    await db.sql`INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, title, summary, status, origin)
      VALUES (${SLUG_FILL}, 'F-FILL', 'T F-FILL', 'summary', 'todo', 'local')`;
    const rows = await outboxFor('harness_features_consolidated', 'F-FILL');
    expect(rows).toHaveLength(1);
    expect(rows[0].workspace_id).toBe(WS_FILL);
  });

  it('an issue whose harness is not in projects falls back to "default" (never "")', async () => {
    // SLUG_NOPROJ has no projects row → the fill trigger uses its 'default'
    // fallback so the drain still has a non-empty key to match on.
    await db.sql`INSERT INTO harness_shared.harness_issues_consolidated
      (harness_slug, issue_id, title, severity, source, status, found_at, attempts, created_ts, updated_ts, origin)
      VALUES ('fed_noproj', 'I-NOPROJ', 'I I-NOPROJ', 'high', 'manual', 'open', now(), 0, 1, 1, 'local')`;
    const rows = await outboxFor('harness_issues_consolidated', 'I-NOPROJ');
    expect(rows).toHaveLength(1);
    expect(rows[0].workspace_id).toBe('default');
    expect(rows[0].workspace_id).not.toBe('');
  });

  // ── NOTIFY (source-level assertion; delivery is Stage 3's drain test) ──────
  it('the migration trigger function fires pg_notify on the substrate_outbox channel', () => {
    const migration = readFileSync(MIGRATION_PATH, 'utf8');
    expect(migration).toMatch(/pg_notify\(\s*'substrate_outbox'/);
  });
});
