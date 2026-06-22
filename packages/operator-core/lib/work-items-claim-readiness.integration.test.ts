/**
 * work-items-claim-readiness.integration.test.ts — claimNextWorkItem RESPECTS blocking
 * (work-item-deps-and-readiness-2026-06-22 P-005, the F1 split-brain fix).
 *
 * Before P-005 the decentralized claim path (claimNextWorkItem) ignored blocking
 * entirely and could hand out a row with an unsatisfied blocker, while the orchestrator
 * frontier (frontier-readiness.ts) correctly held it back — a split-brain. P-005 adds the
 * SAME readiness AND-clause to the claim SELECT: never self-select a row that has a
 * PRESENT, NON-TERMINAL blocker in work_item_deps (dep_type='blocks').
 *
 * Proves against real Postgres (testcontainer; Docker required):
 *   • a feature with a non-terminal feature blocker is NOT claimed;
 *   • after the blocker → 'passed' (terminal) it IS claimed;
 *   • an ABSENT blocker ref (no matching row) does not block;
 *   • an issue blocker 'open' blocks, but 'resolved' does not (the F2 cross-family terminal).
 *
 * Run:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/work-items-claim-readiness.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, USER_TRUST_LIST_DDL, WORK_ITEM_DEPS_DDL } from '../test/_work-items-schema';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../libs/papercusp/libs/db/sql');
const readMigration = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line) && !/\bGRANT\b/.test(line) && !/^\s*(BEGIN|COMMIT);\s*$/.test(line))
    .join('\n');

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});

const wi = await import('./work-items');
const H = 'papercup';
const WS = 'default'; // == DEFAULT_COORD_WORKSPACE; work_item_deps + engineer_issues live here
let db: FreshPgDb;

async function seedFeature(
  id: string,
  opts: { createdTs?: number; status?: string; takenBy?: string | null } = {},
) {
  await db.sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, item_kind, status, taken_by, workspace_id, created_ts, updated_ts)
    VALUES (${H}, ${id}, 'feature', ${opts.status ?? 'todo'}, ${opts.takenBy ?? null}, ${WS}, ${opts.createdTs ?? 0}, 0)`;
}

/** A feature→feature blocks edge (harness-qualified refs, the featureRef convention). */
async function blockByFeature(blockedId: string, blockerId: string) {
  await db.sql`
    INSERT INTO harness_shared.work_item_deps
      (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)
    VALUES (${WS}, 'feature', ${`${H}#${blockedId}`}, 'feature', ${`${H}#${blockerId}`}, 'blocks')`;
}

/** An issue→feature blocks edge: blocker is a bare 'EI-<n>' issue id (issues:link convention). */
async function blockByIssue(blockedId: string, issueId: string) {
  await db.sql`
    INSERT INTO harness_shared.work_item_deps
      (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)
    VALUES (${WS}, 'feature', ${`${H}#${blockedId}`}, 'issue', ${issueId}, 'blocks')`;
}

async function seedIssue(id: string, state: string) {
  await db.sql`
    INSERT INTO harness_shared.engineer_issues (workspace_id, issue_id, title, state)
    VALUES (${WS}, ${id}, ${`issue ${id}`}, ${state})`;
}

beforeAll(async () => {
  db = await createFreshPgDb('wi-claim-readiness');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(USER_TRUST_LIST_DDL); // claim path LEFT-JOINs the trust list (autoPickableWhereSql)
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple(); // the dep table the P-005 readiness clause reads
  await db.sql.unsafe(`
    ALTER TABLE harness_shared.work_items
      ADD COLUMN IF NOT EXISTS assignee_rank integer, ADD COLUMN IF NOT EXISTS rank_writer text,
      ADD COLUMN IF NOT EXISTS rank_updated_at timestamptz;
    ALTER TABLE harness_shared.work_items
      ADD COLUMN IF NOT EXISTS assignee_rank integer, ADD COLUMN IF NOT EXISTS rank_writer text,
      ADD COLUMN IF NOT EXISTS rank_updated_at timestamptz,
      ADD COLUMN IF NOT EXISTS signal_origin text NOT NULL DEFAULT 'organic';`).simple();
}, 90_000);
afterAll(async () => { await db.cleanup(); });
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps`;
});

describe('claimNextWorkItem readiness — feature blocker (P-005, F1)', () => {
  it('does NOT claim a feature with a non-terminal feature blocker', async () => {
    await seedFeature('F-blocker', { status: 'wip', createdTs: 100 });
    await seedFeature('F-blocked', { status: 'todo', createdTs: 200 });
    await blockByFeature('F-blocked', 'F-blocker');
    // F-blocker is 'wip' (not claimable here — not 'todo'); F-blocked is the only 'todo'
    // candidate, but its blocker is non-terminal ⇒ nothing should be claimed.
    expect(await wi.claimNextWorkItem({ harness: H, assignee: 'w1' })).toBeNull();
  });

  it('CLAIMS the blocked feature once the blocker reaches a terminal status', async () => {
    await seedFeature('F-blocker', { status: 'wip', createdTs: 100 });
    await seedFeature('F-blocked', { status: 'todo', createdTs: 200 });
    await blockByFeature('F-blocked', 'F-blocker');
    expect(await wi.claimNextWorkItem({ harness: H, assignee: 'w1' })).toBeNull();

    // Blocker satisfied: passed is terminal.
    await db.sql`UPDATE harness_shared.harness_features_consolidated SET status='passed' WHERE feature_id='F-blocker'`;
    const claimed = await wi.claimNextWorkItem({ harness: H, assignee: 'w1' });
    expect(claimed?.id).toBe('F-blocked');
  });

  it('treats deprecated (the other feature-terminal) as satisfying the blocker too', async () => {
    await seedFeature('F-blocker', { status: 'wip', createdTs: 100 });
    await seedFeature('F-blocked', { status: 'todo', createdTs: 200 });
    await blockByFeature('F-blocked', 'F-blocker');
    await db.sql`UPDATE harness_shared.harness_features_consolidated SET status='deprecated' WHERE feature_id='F-blocker'`;
    expect((await wi.claimNextWorkItem({ harness: H, assignee: 'w1' }))?.id).toBe('F-blocked');
  });

  it('an ABSENT blocker ref (no matching feature row) does NOT block', async () => {
    await seedFeature('F-blocked', { status: 'todo', createdTs: 100 });
    // Edge points at a blocker that has no row in the table — an absent blocker never deadlocks.
    await blockByFeature('F-blocked', 'F-ghost');
    expect((await wi.claimNextWorkItem({ harness: H, assignee: 'w1' }))?.id).toBe('F-blocked');
  });
});

describe('claimNextWorkItem readiness — issue blocker (P-005, F2 cross-family terminal)', () => {
  it('an OPEN issue blocker blocks; a RESOLVED one does not', async () => {
    await seedFeature('F-blocked', { status: 'todo', createdTs: 100 });
    await seedIssue('EI-1', 'open');
    await blockByIssue('F-blocked', 'EI-1');
    expect(await wi.claimNextWorkItem({ harness: H, assignee: 'w1' })).toBeNull();

    await db.sql`UPDATE harness_shared.engineer_issues SET state='resolved' WHERE issue_id='EI-1'`;
    expect((await wi.claimNextWorkItem({ harness: H, assignee: 'w1' }))?.id).toBe('F-blocked');
  });

  it('a CLOSED issue blocker (the other issue-terminal) does not block', async () => {
    await seedFeature('F-blocked', { status: 'todo', createdTs: 100 });
    await seedIssue('EI-2', 'closed');
    await blockByIssue('F-blocked', 'EI-2');
    expect((await wi.claimNextWorkItem({ harness: H, assignee: 'w1' }))?.id).toBe('F-blocked');
  });

  it('an ABSENT issue blocker ref (no matching issue row) does not block', async () => {
    await seedFeature('F-blocked', { status: 'todo', createdTs: 100 });
    await blockByIssue('F-blocked', 'EI-ghost');
    expect((await wi.claimNextWorkItem({ harness: H, assignee: 'w1' }))?.id).toBe('F-blocked');
  });
});

describe('claimNextWorkItem readiness — unblocked work is unaffected', () => {
  it('claims a normal unblocked todo feature exactly as before', async () => {
    await seedFeature('F-free', { status: 'todo', createdTs: 100 });
    expect((await wi.claimNextWorkItem({ harness: H, assignee: 'w1' }))?.id).toBe('F-free');
  });

  it('prefers the unblocked item over a blocked older one', async () => {
    await seedFeature('F-blocker', { status: 'wip', createdTs: 50 });
    await seedFeature('F-blocked', { status: 'todo', createdTs: 100 }); // older, but blocked
    await seedFeature('F-ready', { status: 'todo', createdTs: 200 }); // newer, but ready
    await blockByFeature('F-blocked', 'F-blocker');
    // Oldest-first would pick F-blocked, but it's blocked ⇒ the claim skips to F-ready.
    expect((await wi.claimNextWorkItem({ harness: H, assignee: 'w1' }))?.id).toBe('F-ready');
  });
});
