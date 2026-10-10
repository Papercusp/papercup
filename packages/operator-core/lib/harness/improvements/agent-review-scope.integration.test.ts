/** P-026: real pickup queries against migrated PG, with a full excluded page. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
const { adoptNextAgentReviewRevision, claimNextAgentReview, claimNextVerificationTask } = await import('./agent-review');
const { LEGACY_AGENT_REVIEW_SUBMITTER } = await import('./agent-review-policy');
const { buildP2pLaneFence } = await import('../../scheduler/p2p-lane-fence');
const WS = 'ws-verifier-scope';
const HARNESS = 'papercusp';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

async function ensureClaimNextIndex(db: OrgTestDb) {
  const existing = await db.adminSql`SELECT 1 FROM pg_indexes
    WHERE schemaname = 'harness_shared' AND indexname = 'work_items_agent_review_claim_next_idx'`;
  if (existing.length) return;

  // During migration authoring the allocated .DRAFT is intentionally invisible to
  // the migration runner. Apply that one additive DDL in this isolated test DB so
  // the integration assertion exercises the exact draft before it is armed.
  const candidates = [
    resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql/1435-agent-review-claim-next-index.sql.DRAFT'),
    resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql/1435-agent-review-claim-next-index.sql'),
  ];
  const path = candidates.find(existsSync);
  if (!path) throw new Error('1435 agent-review claim-next migration is missing');
  await db.adminSql.unsafe(readFileSync(path, 'utf8'));
}

describe('P-026 canonical verifier scope before LIMIT, real PG', () => {
  let db: OrgTestDb;
  beforeAll(async () => {
    db = await createOrgTestDb();
    await ensureClaimNextIndex(db);
    h.sql = db.adminSql;
  }, 180_000);
  afterAll(async () => { await db?.cleanup(); });
  beforeEach(async () => { await db.adminSql`DELETE FROM harness_shared.work_items WHERE workspace_id = ${WS}`; });

  async function seed(id: string, review: boolean, index: number, plan: string | null, conflict?: string, kind = review ? 'change' : 'task') {
    const payload = review
      ? { agentReview: { status: 'pending', submittedBy: conflict ?? 'su-filer', ledgerIdeaId: id, round: 2 } }
      : { verification: { schemaVersion: 'verification-task-v1', subject: 'WI-S', check: 'completion', reporters: conflict ? [conflict] : [] } };
    await db.adminSql`INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, summary, item_kind, status, payload, source_plan_slug, created_ts, feature_order)
      VALUES (${WS}, ${HARNESS}, ${id}, 'Neutral queue item', 'Current fixture', ${kind},
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

  it.each([
    [true, 'change'],
    [true, 'bug'],
    [false, 'task'],
  ] as const)('filters a full excluded page before independent pickup; review=%s kind=%s', async (review, kind) => {
    for (let i = 0; i < 30; i++) await seed(`WI-EXCLUDED-${i}`, review, i, 'p2p-release', undefined, kind);
    await seed('WI-CONFLICT', review, 30, 'queue-flow', 'su-verifier', kind);
    // The bug has no plan approval, acceptance contract or reproduction receipt.
    // Pickup assigns validation; it must not silently turn that into bug acceptance.
    await seed('WI-IN', review, 31, null, undefined, kind);
    const { deps, claimWorkItem } = writer();
    const scope = { harnessSlug: HARNESS, workspaceId: WS, filter: buildP2pLaneFence() };
    const result = review
      ? await claimNextAgentReview({ ...scope, reviewer: 'su-verifier' }, deps as never)
      : await claimNextVerificationTask({ ...scope, verifier: 'su-verifier' }, deps as never);
    expect(result?.id).toBe('WI-IN');
    expect(result?.kind).toBe(kind);
    if (kind === 'bug') {
      expect(result?.payload).not.toHaveProperty('intakeReproduction');
      expect(result?.payload).not.toHaveProperty('implementationReadiness');
    }
    expect(claimWorkItem.mock.calls.map((c) => c[0])).toEqual(['WI-IN']);
    const held = await db.adminSql`SELECT feature_id FROM harness_shared.work_items WHERE workspace_id=${WS} AND taken_by IS NOT NULL`;
    expect(held.map((row) => row.feature_id)).toEqual(['WI-IN']);
  });

  it('keeps the pending-review projection and claim-next partial index aligned (EI-25555666233005302)', async () => {
    await seed('WI-PROJECTION', true, 1, null);
    await db.adminSql`INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, summary, item_kind, status, payload, created_ts, feature_order)
      SELECT ${WS}, ${HARNESS}, 'WI-PLAN-FILLER-' || i::text, 'Neutral queue item', 'Plan fixture', 'change',
        'open', '{}'::jsonb, i + 1, i + 1
      FROM generate_series(1, 5000) AS i`;
    await db.adminSql`ANALYZE harness_shared.work_items`;

    const [row] = await db.adminSql`SELECT agent_review_projection
      FROM harness_shared.work_items
      WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND feature_id = 'WI-PROJECTION'`;
    const [index] = await db.adminSql`SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'harness_shared' AND indexname = 'work_items_agent_review_claim_next_idx'`;
    const [plan] = await db.adminSql`EXPLAIN (FORMAT JSON, COSTS FALSE)
      SELECT feature_id
      FROM harness_shared.work_items wi
      WHERE workspace_id = ${WS}
        AND harness_slug = ${HARNESS}
        AND status = 'open'
        AND item_kind IN ('bug', 'change', 'task', 'feature')
        AND (taken_by IS NULL OR btrim(taken_by) = '')
        AND agent_review_projection ->> 'status' = 'pending'
      ORDER BY feature_order ASC NULLS LAST, created_ts ASC
      LIMIT 25`;
    const indexDef = index?.indexdef ?? '';

    expect(row?.agent_review_projection).toMatchObject({ status: 'pending', submittedBy: 'su-filer' });
    expect(indexDef).toMatch(/agent_review_projection\s*->>\s*'status'(?:::text)?\)?\s*=\s*'pending'(?:::text)?/);
    expect(indexDef).toMatch(/status\s*=\s*'open'(?:::text)?/);
    expect(indexDef).toMatch(/btrim\(\s*taken_by\s*\)\s*=\s*''(?:::text)?/);
    expect(JSON.stringify(plan)).toContain('work_items_agent_review_claim_next_idx');
  });

  it('adopt-next discovers the oldest proven-orphan content revision and leaves every other route alone (D-008)', async () => {
    const revision = async (id: string, index: number, review: Record<string, unknown>) => {
      const payload = { agentReview: { status: 'revision-requested', ledgerIdeaId: id, round: 2, revisionKind: 'content', ...review } };
      await db.adminSql`INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, summary, item_kind, status, payload, created_ts, feature_order)
        VALUES (${WS}, ${HARNESS}, ${id}, 'Neutral queue item', 'Current fixture', 'bug',
          'open', ${JSON.stringify(payload)}::text::jsonb, ${index}, ${index})`;
    };
    await revision('WI-REPRO', 0, { submittedBy: 'su-gone', revisionKind: 'reproduction' });
    await revision('WI-LEGACY', 1, { submittedBy: LEGACY_AGENT_REVIEW_SUBMITTER });
    await revision('WI-OWN', 2, { submittedBy: 'su-adopter' });
    await revision('WI-PENDING', 3, { submittedBy: 'su-gone', status: 'pending', revisionKind: undefined });
    await revision('WI-LIVE', 4, { submittedBy: 'su-live' });
    await revision('WI-ORPHAN', 5, { submittedBy: 'su-gone' });
    await revision('WI-ORPHAN-LATER', 6, { submittedBy: 'su-gone' });

    const { deps } = writer();
    const liveness = vi.fn(async (ownerId: string) => ({ sessionState: ownerId === 'su-live' ? 'live' : 'ended' }) as const);
    const adoptDeps = {
      ...deps,
      claimWorkItem: vi.fn(async (id: string, assignee: string, opts: { expectedAssignee?: string } = {}) => {
        const rows = await db.adminSql`UPDATE harness_shared.work_items SET taken_by=${assignee}
          WHERE workspace_id=${WS} AND feature_id=${id}
            AND (taken_by IS NULL OR taken_by = ${opts.expectedAssignee ?? ''}) RETURNING feature_id`;
        return rows.length ? deps.getWorkItem(id) : null;
      }),
      mergeWorkItemPayload: vi.fn(async (id: string, patch: Record<string, unknown>) => {
        await db.adminSql`UPDATE harness_shared.work_items
          SET payload = COALESCE(payload, '{}'::jsonb) || ${JSON.stringify(patch)}::text::jsonb
          WHERE workspace_id=${WS} AND feature_id=${id}`;
        return deps.getWorkItem(id);
      }),
      getWorkItemDetail: vi.fn(async () => ({ posts: [] })),
      commentWorkItem: vi.fn(async () => ({})),
      resolveSubmitterLiveness: liveness,
      resolveVerifiedSubmitterAlias: vi.fn(async () => null),
    };

    const result = await adoptNextAgentReviewRevision(
      { adopter: 'su-adopter', harnessSlug: HARNESS, workspaceId: WS },
      adoptDeps as never,
    );

    expect(result).toMatchObject({ adopted: true, workItem: { id: 'WI-ORPHAN' }, scanned: 2, refusals: { 'not-submitter': 1 } });
    // Liveness is measured only for content revisions the query admitted, oldest first.
    expect(liveness.mock.calls.map((call) => call[0])).toEqual(['su-live', 'su-gone']);
    const rows = await db.adminSql`SELECT feature_id, taken_by, payload FROM harness_shared.work_items
      WHERE workspace_id=${WS} ORDER BY created_ts`;
    const held = Object.fromEntries(rows.map((row) => [row.feature_id, row.taken_by]));
    expect(held).toEqual({
      'WI-REPRO': null, 'WI-LEGACY': null, 'WI-OWN': null, 'WI-PENDING': null,
      'WI-LIVE': null, 'WI-ORPHAN': 'su-adopter', 'WI-ORPHAN-LATER': null,
    });
    const adopted = rows.find((row) => row.feature_id === 'WI-ORPHAN')?.payload as Record<string, Record<string, unknown>>;
    expect(adopted.agentReview).toMatchObject({ status: 'revision-requested', submittedBy: 'su-adopter', round: 2 });
    expect(adopted.agentReviewAdoption).toMatchObject({ from: 'su-gone', sessionState: 'ended', adoptedBy: 'su-adopter' });
  });
});
