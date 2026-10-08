/** P-026: real pickup queries against migrated PG, with a full excluded page. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../../test/_org-test-db';
import type { WorkItem } from '../../work-items';

const h = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('../../workspace-registry', async (orig) => ({
  ...(await orig<typeof import('../../workspace-registry')>()), activeWorkspaceId: () => 'wrong-ambient-workspace',
}));

const { createOrgTestDb } = await import('../../../test/_org-test-db');
const { FEATURE_COLS, featureRowToWorkItem } = await import('../../work-items');
const { claimNextAgentReview, claimNextVerificationTask } = await import('./agent-review');
const { buildP2pLaneFence } = await import('../../scheduler/p2p-lane-fence');
const WS = 'ws-verifier-scope';
const HARNESS = 'papercusp';

describe('P-026 canonical verifier scope before LIMIT, real PG', () => {
  let db: OrgTestDb;
  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
  }, 180_000);
  afterAll(async () => { await db?.cleanup(); });
  beforeEach(async () => { await db.adminSql`DELETE FROM harness_shared.work_items WHERE workspace_id = ${WS}`; });

  async function seed(id: string, review: boolean, index: number, plan: string | null, conflict?: string) {
    const payload = review
      ? { agentReview: { status: 'pending', submittedBy: conflict ?? 'su-filer', ledgerIdeaId: id, round: 2 } }
      : { verification: { schemaVersion: 'verification-task-v1', subject: 'WI-S', check: 'completion', reporters: conflict ? [conflict] : [] } };
    await db.adminSql`INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, summary, item_kind, status, payload, source_plan_slug, created_ts, feature_order)
      VALUES (${WS}, ${HARNESS}, ${id}, 'Neutral queue item', 'Current fixture', ${review ? 'change' : 'task'},
        'open', ${JSON.stringify(payload)}::text::jsonb, ${plan}, ${index}, ${index})`;
  }

  function writer() {
    const getWorkItem = vi.fn(async (id: string): Promise<WorkItem | null> => {
      const rows = await db.adminSql.unsafe(`SELECT ${FEATURE_COLS} FROM harness_shared.work_items WHERE workspace_id=$1 AND feature_id=$2`, [WS, id]);
      return rows[0] ? featureRowToWorkItem(rows[0] as never) : null;
    });
    const claimWorkItem = vi.fn(async (id: string, assignee: string) => {
      const rows = await db.adminSql`UPDATE harness_shared.work_items SET taken_by=${assignee}
        WHERE workspace_id=${WS} AND feature_id=${id} AND taken_by IS NULL RETURNING feature_id`;
      return rows.length ? getWorkItem(id) : null;
    });
    const deps = {
      getWorkItem, claimWorkItem, readLedgerGrade: vi.fn(async () => null),
      releaseWorkItem: vi.fn(async (id: string, opts: { expectedAssignee?: string }) => {
        await db.adminSql`UPDATE harness_shared.work_items SET taken_by=NULL
          WHERE workspace_id=${WS} AND feature_id=${id} AND taken_by=${opts.expectedAssignee ?? ''}`;
        return getWorkItem(id);
      }),
    };
    return { deps, claimWorkItem };
  }

  it.each([true, false])('filters a full excluded page before pickup; review=%s', async (review) => {
    for (let i = 0; i < 30; i++) await seed(`WI-EXCLUDED-${i}`, review, i, 'p2p-release');
    await seed('WI-CONFLICT', review, 30, 'queue-flow', 'su-verifier');
    await seed('WI-IN', review, 31, null);
    const { deps, claimWorkItem } = writer();
    const scope = { harnessSlug: HARNESS, workspaceId: WS, filter: buildP2pLaneFence() };
    const result = review
      ? await claimNextAgentReview({ ...scope, reviewer: 'su-verifier' }, deps as never)
      : await claimNextVerificationTask({ ...scope, verifier: 'su-verifier' }, deps as never);
    expect(result?.id).toBe('WI-IN');
    expect(claimWorkItem.mock.calls.map((c) => c[0])).toEqual(['WI-IN']);
    const held = await db.adminSql`SELECT feature_id FROM harness_shared.work_items WHERE workspace_id=${WS} AND taken_by IS NOT NULL`;
    expect(held.map((row) => row.feature_id)).toEqual(['WI-IN']);
  });
});
