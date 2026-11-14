import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import { enrichPlanListRows } from './plan-attribution';

let db: MigratedTestDb;
let sql: Sql;
const PLAN_COUNT = 40;
const REVISION_COUNT = 100;

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'planattribution' });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
  await sql.unsafe(`
    CREATE SCHEMA harness_shared;
    CREATE TABLE harness_shared.plan_revisions (
      workspace_id text, harness_slug text, plan_slug text, seq integer,
      author_id text, author_kind text,
      UNIQUE (workspace_id, harness_slug, plan_slug, seq)
    );
    CREATE TABLE harness_shared.pot_members (
      workspace_id text, github_user_id bigint, github_username text,
      display_name text, avatar_url text, device_attestations jsonb
    );
    INSERT INTO harness_shared.plan_revisions
    SELECT workspace, harness, 'plan-' || plan, revision,
           workspace || '/' || harness || '/' || plan || '/' || revision, 'agent'
      FROM unnest(ARRAY['target', 'other']) workspace
      CROSS JOIN unnest(ARRAY['first', 'second']) harness
      CROSS JOIN generate_series(1, ${PLAN_COUNT}) plan
      CROSS JOIN generate_series(1, ${REVISION_COUNT}) revision;
    ANALYZE harness_shared.plan_revisions;
  `);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  await db?.drop();
});

describe('latest plan attribution with revision history', () => {
  it('keeps workspace and harness identities distinct and observes a new revision', async () => {
    const plans = [
      { harness: 'first', slug: 'plan-1' },
      { harness: 'second', slug: 'plan-1' },
      { harness: 'first', slug: 'missing' },
      { slug: 'plan-1' },
    ];
    const before = await enrichPlanListRows(plans, { sql, workspaceId: 'target' }) as Array<{
      lastEditor?: { id: string };
    }>;
    expect(before.map(row => row.lastEditor?.id)).toEqual([
      'target/first/1/100', 'target/second/1/100', undefined, undefined,
    ]);
    await sql.unsafe(`INSERT INTO harness_shared.plan_revisions
      VALUES ('target', 'first', 'plan-1', 101, 'fresh-editor', 'agent')`);
    const after = await enrichPlanListRows(plans, { sql, workspaceId: 'target' }) as Array<{
      lastEditor?: { id: string };
    }>;
    expect(after[0].lastEditor?.id).toBe('fresh-editor');
    expect(after[1].lastEditor?.id).toBe('target/second/1/100');
  });

  it('visits at most one history row per requested plan using the production query', async () => {
    let query = '';
    let parameters: unknown[] = [];
    const observedSql = { unsafe: async (text: string, values: unknown[]) => {
      if (text.includes('plan_revisions')) { query = text; parameters = values; }
      return sql.unsafe(text, values as never[]);
    } } as unknown as Sql;
    const plans = Array.from({ length: PLAN_COUNT }, (_, i) => ({
      harness: 'first', slug: `plan-${i + 1}`,
    }));
    const rows = await enrichPlanListRows(plans, { sql: observedSql, workspaceId: 'target' });
    expect(rows).toHaveLength(PLAN_COUNT);
    expect(query).not.toBe('');
    const explanation = await sql.unsafe(`EXPLAIN (ANALYZE, FORMAT JSON) ${query}`, parameters as never[]);
    type PlanNode = { 'Relation Name'?: string; 'Actual Rows': number; 'Actual Loops': number; Plans?: PlanNode[] };
    const visited = (node: PlanNode): number =>
      (node['Relation Name'] === 'plan_revisions' ? node['Actual Rows'] * node['Actual Loops'] : 0)
      + (node.Plans ?? []).reduce((sum, child) => sum + visited(child), 0);
    expect(visited(explanation[0]['QUERY PLAN'][0].Plan)).toBeGreaterThan(0);
    expect(visited(explanation[0]['QUERY PLAN'][0].Plan)).toBeLessThanOrEqual(PLAN_COUNT);
  });
});
