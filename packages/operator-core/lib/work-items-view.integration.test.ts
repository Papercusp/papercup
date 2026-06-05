/**
 * work-items-view.integration.test.ts — migration 159: the work_items UNION
 * view over BOTH per-kind tables + INSTEAD OF DML routing
 * (unify-work-items-2026-06-04 D-010=(b), the kind-views tail).
 *
 * Loads a column-faithful harness_features_consolidated (full 47-col shape,
 * dumped from live 2026-06-05) + the real engineer_issues migrations
 * (131/142/152) + migration 159 into a throwaway PG, then proves:
 *  • the view UNIONs both families in the feature column space;
 *  • feature rows are bit-identical to the pre-159 view (consumer contract);
 *  • the DBOS-frontier-shaped read (item_kind='feature') excludes issue rows;
 *  • the export-state-shaped read (item_kind<>'feature') now CAPTURES a
 *    harness's issue-family rows;
 *  • INSTEAD OF INSERT/UPDATE/DELETE route by kind to the right base table;
 *  • cross-family reclassification via the view is refused (engine's job).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../libs/papercusp/libs/db/sql');

const readMigration = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter(
      (line) => !/^\s*\\/.test(line) && !/\bGRANT\b/.test(line) && !/^\s*(BEGIN|COMMIT);\s*$/.test(line),
    )
    .join('\n');

// Column-faithful hfc (full live shape, pg_dump 2026-06-05) — the view's explicit
// 47-column SELECT requires every column to exist.
const HFC_FULL_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.harness_features_consolidated (
    harness_slug text NOT NULL,
    feature_id text NOT NULL,
    title text, summary text, status text, attempts bigint, claims text, notes text,
    metadata jsonb, kind text, project_id text, expected_cost_cents bigint, tags jsonb,
    needs_human_review boolean, ts bigint, created_ts bigint, updated_ts bigint,
    parent_id text, goal_id text, taken_by text, taken_at timestamptz, expires_at timestamptz,
    workspace_id text NOT NULL DEFAULT 'default',
    _search tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(summary,''))) STORED,
    deprecation_reason text,
    see_also text[] DEFAULT '{}'::text[] NOT NULL,
    needs_design boolean DEFAULT false NOT NULL,
    design_status text, design_spec_id text,
    discarded_design_work boolean DEFAULT false NOT NULL,
    completion_ref jsonb, created_by_github_user_id bigint,
    working_users bigint[] DEFAULT '{}'::bigint[] NOT NULL,
    worked_by_history jsonb DEFAULT '[]'::jsonb NOT NULL,
    wave text, verified_done_at_remote_ts timestamptz, verifier_last_error text,
    verifier_last_checked_at timestamptz, source_plan_slug text, source_plan_item_ids text[],
    feature_order integer, author_pubkey text,
    origin text DEFAULT 'local'::text NOT NULL,
    audit_verdict text, audit_reasons text, audited_at timestamptz,
    item_kind text DEFAULT 'feature'::text NOT NULL,
    payload jsonb,
    PRIMARY KEY (harness_slug, feature_id))`;

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('work-items-view');
  await db.sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  await db.sql.unsafe(HFC_FULL_DDL);
  await db.sql.unsafe(readMigration('131-engineer-issues.sql')).simple();
  await db.sql.unsafe(readMigration('142-work-items-unify.sql')).simple();
  await db.sql.unsafe(readMigration('152-delegate-task-workitems.sql')).simple();
  await db.sql.unsafe(readMigration('159-work-items-union-view.sql')).simple();
}, 90_000);

afterAll(async () => {
  await db.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.engineer_issues, harness_shared.harness_features_consolidated`;
});

async function seedBoth() {
  await db.sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, title, summary, status, item_kind, taken_by, workspace_id,
       feature_order, metadata, origin, ts, created_ts, updated_ts)
    VALUES ('papercup', 'F-100', 'a feature', 'feature body', 'todo', 'feature', NULL, 'default',
            7, '{"source_plan": "demo-plan"}'::jsonb, 'local', 1000, 1000, 1000)`;
  await db.sql`
    INSERT INTO harness_shared.engineer_issues
      (workspace_id, issue_id, scope, title, body, state, assignee, kind, payload)
    VALUES ('default', 'WI-200', 'harness:papercup', 'a bug', 'bug body', 'open', 'sess-A', 'bug',
            '{"plan_item": {"plan_slug": "demo-plan", "item_id": "P-001", "harness_slug": "papercup"}}'::jsonb)`;
  await db.sql`
    INSERT INTO harness_shared.engineer_issues
      (workspace_id, issue_id, scope, title, body, state, kind)
    VALUES ('default', 'WI-201', 'operator', 'an operator-scoped task', '', 'open', 'task')`;
}

describe('migration 159 — the work_items UNION view', () => {
  it('merges both families into the feature column space', async () => {
    await seedBoth();
    const rows = await db.sql<{ feature_id: string; item_kind: string; harness_slug: string | null; status: string; taken_by: string | null; summary: string }[]>`
      SELECT feature_id, item_kind, harness_slug, status, taken_by, summary
        FROM harness_shared.work_items ORDER BY feature_id`;
    expect(rows.map((r) => r.feature_id)).toEqual(['F-100', 'WI-200', 'WI-201']);
    const bug = rows.find((r) => r.feature_id === 'WI-200')!;
    expect(bug).toMatchObject({
      item_kind: 'bug',
      harness_slug: 'papercup', // scope 'harness:papercup' → slug
      status: 'open', // state → status
      taken_by: 'sess-A', // assignee → taken_by
      summary: 'bug body', // body → summary
    });
    // operator scope → NULL harness_slug (excluded by per-harness filters).
    expect(rows.find((r) => r.feature_id === 'WI-201')!.harness_slug).toBeNull();
  });

  it('the DBOS-frontier-shaped read sees ONLY feature rows — unchanged contract', async () => {
    await seedBoth();
    const rows = await db.sql<{ feature_id: string; feature_order: number | null; source_plan: string | null }[]>`
      SELECT feature_id, feature_order, metadata->>'source_plan' AS source_plan
        FROM harness_shared.work_items
       WHERE workspace_id = 'default' AND harness_slug = 'papercup'
         AND item_kind = 'feature'
         AND (origin = 'local' OR origin IS NULL OR audit_verdict = 'admit')`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ feature_id: 'F-100', feature_order: 7, source_plan: 'demo-plan' });
  });

  it('the export-state-shaped read now captures a harness’s issue-family rows', async () => {
    await seedBoth();
    const rows = await db.sql<{ feature_id: string }[]>`
      SELECT feature_id FROM harness_shared.work_items
       WHERE harness_slug = 'papercup' AND item_kind <> 'feature' ORDER BY feature_id`;
    expect(rows.map((r) => r.feature_id)).toEqual(['WI-200']); // the bug; NOT the operator-scoped task
  });

  it('INSTEAD OF INSERT routes by kind: issue-family → engineer_issues, feature-family → hfc', async () => {
    await db.sql`
      INSERT INTO harness_shared.work_items (harness_slug, feature_id, title, summary, status, item_kind, taken_by, workspace_id)
      VALUES ('papercup', 'WI-300', 'routed bug', 'via the view', 'open', 'bug', 'sess-B', 'default')`;
    const issues = await db.sql<{ issue_id: string; scope: string; kind: string; body: string; assignee: string }[]>`
      SELECT issue_id, scope, kind, body, assignee FROM harness_shared.engineer_issues`;
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      issue_id: 'WI-300',
      scope: 'harness:papercup',
      kind: 'bug',
      body: 'via the view',
      assignee: 'sess-B',
    });

    await db.sql`
      INSERT INTO harness_shared.work_items (harness_slug, feature_id, title, status, item_kind, workspace_id)
      VALUES ('papercup', 'WI-301', 'routed research', 'todo', 'research-task', 'default')`;
    const feats = await db.sql<{ feature_id: string; item_kind: string }[]>`
      SELECT feature_id, item_kind FROM harness_shared.harness_features_consolidated`;
    expect(feats).toHaveLength(1);
    expect(feats[0]).toMatchObject({ feature_id: 'WI-301', item_kind: 'research-task' });
  });

  it('INSTEAD OF UPDATE routes to the right base table; DELETE routes too', async () => {
    await seedBoth();
    await db.sql`UPDATE harness_shared.work_items SET status = 'resolved', taken_by = NULL WHERE feature_id = 'WI-200'`;
    const ei = await db.sql<{ state: string; assignee: string | null }[]>`
      SELECT state, assignee FROM harness_shared.engineer_issues WHERE issue_id = 'WI-200'`;
    expect(ei[0]).toMatchObject({ state: 'resolved', assignee: null });

    await db.sql`UPDATE harness_shared.work_items SET status = 'validating' WHERE feature_id = 'F-100'`;
    const f = await db.sql<{ status: string }[]>`
      SELECT status FROM harness_shared.harness_features_consolidated WHERE feature_id = 'F-100'`;
    expect(f[0].status).toBe('validating');

    await db.sql`DELETE FROM harness_shared.work_items WHERE feature_id = 'WI-200'`;
    expect(await db.sql`SELECT 1 FROM harness_shared.engineer_issues WHERE issue_id = 'WI-200'`).toHaveLength(0);
    await db.sql`DELETE FROM harness_shared.work_items WHERE feature_id = 'F-100'`;
    expect(await db.sql`SELECT 1 FROM harness_shared.harness_features_consolidated WHERE feature_id = 'F-100'`).toHaveLength(0);
  });

  it('cross-family reclassification via the view is REFUSED (a cross-table move — engine’s job)', async () => {
    await seedBoth();
    await expect(
      db.sql`UPDATE harness_shared.work_items SET item_kind = 'feature' WHERE feature_id = 'WI-200'`,
    ).rejects.toThrow(/cross-family reclassification/);
    await expect(
      db.sql`UPDATE harness_shared.work_items SET item_kind = 'bug' WHERE feature_id = 'F-100'`,
    ).rejects.toThrow(/cross-family reclassification/);
  });

  it('the migration is idempotent (re-apply is a no-op)', async () => {
    await db.sql.unsafe(readMigration('159-work-items-union-view.sql')).simple();
    await seedBoth();
    const rows = await db.sql`SELECT feature_id FROM harness_shared.work_items`;
    expect(rows).toHaveLength(3);
  });
});
