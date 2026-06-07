/**
 * change-feed-deps.integration.test.ts — the Change Feed's PRODUCTION readers
 * against real migrated Postgres (self-learning-central-2026-06-06 Phase 7 /
 * P-060, D-005).
 *
 * The pure layer (change-feed.test.ts) proves the projection over injected
 * readers; THIS suite pins that `buildChangeFeedReaders` actually derives the
 * feed from the real completion sources — the unified `work_items` view
 * (features ∪ engineer issues), `gym_proposals`, `harness_plans` — and that
 * regenerating after the SOURCES change reflects the change with no residue
 * (derived view, no parallel log).
 *
 * (Phase-7 finding: the first cut of change-feed-deps.ts queried an imagined
 * schema — every reader threw and the core's defensive wrapper turned the
 * production feed into a permanently-empty list. This suite exists so that
 * cannot regress silently again.)
 *
 * Follows the established org-fixture pattern (test/_org-test-db.ts): mock
 * `getOrgPg` onto the fixture's admin client.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown }));

vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: h.sql }) }));

// Imported AFTER the mocks are declared (vi.mock is hoisted above imports).
const { buildChangeFeedReaders } = await import('./change-feed-deps');
const { gatherCompletions } = await import('./change-feed');
const { createOrgTestDb } = await import('../../test/_org-test-db');

const WS = 'ws-change-feed-test';

// Deterministic completion clocks (epoch ms), newest → oldest:
const T_ISSUE = Date.parse('2026-06-06T09:00:00Z'); // resolved engineer issue
const T_FEATURE = Date.parse('2026-06-05T10:00:00Z'); // done feature
const T_GYM = Date.parse('2026-06-04T08:00:00Z'); // accepted gym proposal
const T_PLAN = Date.parse('2026-06-03T07:00:00Z'); // finished plan run

describe('change-feed production readers (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
    const sql = db.adminSql;

    // — work_items, feature family: one completed, one in-flight (excluded) —
    await sql`
      INSERT INTO harness_shared.harness_features_consolidated
        (workspace_id, harness_slug, feature_id, title, status, updated_ts)
      VALUES
        (${WS}, 'papercup', 'F-DONE', 'Shipped the dock workbench', 'done', ${T_FEATURE}),
        (${WS}, 'papercup', 'F-WIP', 'Half-built thing', 'in_progress', ${T_FEATURE})`;

    // — work_items, issue family: one resolved, one still open (excluded) —
    await sql`
      INSERT INTO harness_shared.engineer_issues
        (workspace_id, issue_id, scope, title, state, updated_at)
      VALUES
        (${WS}, 'EI-5', 'harness:papercup', 'Fixed the flaky watchdog tick', 'resolved', ${new Date(T_ISSUE)}),
        (${WS}, 'EI-6', 'operator', 'Still-open friction', 'open', ${new Date(T_ISSUE)})`;

    // — gym proposals: one decided, one pending (excluded) —
    await sql`
      INSERT INTO harness_shared.gym_proposals
        (id, workspace_id, harness_slug, role, proposed_md, status, created_at, decided_at)
      VALUES
        ('gp-1', ${WS}, 'papercup', 'judge', '# better rubric', 'accepted', ${T_GYM - 1000}, ${T_GYM}),
        ('gp-2', ${WS}, 'papercup', 'worker', '# pending change', 'pending', ${T_GYM - 1000}, NULL)`;

    // — plan runs: one op-done, one op-started (excluded). Completion lives on
    //   op_status/op_updated_at, NOT the frontmatter status column. —
    await sql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, title, op_status, op_updated_at)
      VALUES
        (${WS}, 'papercup', 'plan-done', 'A finished plan', 'done', ${new Date(T_PLAN)}),
        (${WS}, 'papercup', 'plan-started', 'A running plan', 'started', ${new Date(T_PLAN)})`;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('derives the feed from all three completion sources — terminal records only', async () => {
    const feed = await gatherCompletions(buildChangeFeedReaders());
    const ids = feed.map((e) => e.id);

    // The completions are in…
    expect(ids).toContain('wi:F-DONE'); // feature family, status done
    expect(ids).toContain('wi:EI-5'); // issue family, state resolved
    expect(ids).toContain('gym:gp-1'); // decided proposal
    expect(ids).toContain('plan:plan-done'); // op_status done

    // …and the in-flight records are NOT.
    expect(ids).not.toContain('wi:F-WIP');
    expect(ids).not.toContain('wi:EI-6');
    expect(ids).not.toContain('gym:gp-2');
    expect(ids).not.toContain('plan:plan-started');
  });

  it('orders newest-first across sources and round-trips the completion clocks', async () => {
    const feed = await gatherCompletions(buildChangeFeedReaders());
    const ids = feed.map((e) => e.id);
    expect(ids).toEqual(['wi:EI-5', 'wi:F-DONE', 'gym:gp-1', 'plan:plan-done']);

    const byId = new Map(feed.map((e) => [e.id, e]));
    // Feature completion clock = the view's epoch-ms updated_ts.
    expect(byId.get('wi:F-DONE')!.ts).toBe(new Date(T_FEATURE).toISOString());
    // Issue completion clock = updated_at, projected to epoch ms by the view.
    expect(byId.get('wi:EI-5')!.ts).toBe(new Date(T_ISSUE).toISOString());
    // Gym decision clock = decided_at (epoch-ms bigint).
    expect(byId.get('gym:gp-1')!.ts).toBe(new Date(T_GYM).toISOString());
    // Plan completion clock = op_updated_at (timestamptz).
    expect(byId.get('plan:plan-done')!.ts).toBe(new Date(T_PLAN).toISOString());
  });

  it('every entry references its original record (ref) with the right shape', async () => {
    const feed = await gatherCompletions(buildChangeFeedReaders());
    const byId = new Map(feed.map((e) => [e.id, e]));

    expect(byId.get('wi:F-DONE')).toMatchObject({
      kind: 'completion',
      title: 'Shipped the dock workbench',
      harness: 'papercup',
      workItemId: 'F-DONE',
      ref: 'wi:F-DONE',
    });
    // The issue family's harness derives from its scope ('harness:papercup').
    expect(byId.get('wi:EI-5')).toMatchObject({
      kind: 'completion',
      harness: 'papercup',
      workItemId: 'EI-5',
    });
    expect(byId.get('gym:gp-1')).toMatchObject({
      kind: 'proposal',
      title: 'Accepted prompt for judge',
      harness: 'papercup',
      ref: 'gym:gp-1',
    });
    expect(byId.get('plan:plan-done')).toMatchObject({
      kind: 'plan-run',
      title: 'Plan completed: A finished plan',
      harness: 'papercup',
      ref: 'plan:plan-done',
    });
  });

  it('REGENERATES from the sources — new completions appear, deleted ones vanish (no parallel log)', async () => {
    const sql = db.adminSql;

    // The open issue resolves → the next regeneration includes it.
    await sql`UPDATE harness_shared.engineer_issues SET state = 'resolved'
               WHERE workspace_id = ${WS} AND issue_id = 'EI-6'`;
    let ids = (await gatherCompletions(buildChangeFeedReaders())).map((e) => e.id);
    expect(ids).toContain('wi:EI-6');

    // A source record disappears → the feed forgets it. A parallel log would
    // still carry the dead entry; a derived view cannot.
    await sql`DELETE FROM harness_shared.gym_proposals WHERE id = 'gp-1'`;
    ids = (await gatherCompletions(buildChangeFeedReaders())).map((e) => e.id);
    expect(ids).not.toContain('gym:gp-1');
    expect(ids).toContain('wi:F-DONE'); // the rest of the feed is unaffected
  });
});
