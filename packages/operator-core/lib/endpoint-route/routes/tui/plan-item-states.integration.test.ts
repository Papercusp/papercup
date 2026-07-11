/**
 * plan-item-states.integration.test.ts — real-Postgres coverage of the P-005a route's
 * DATA PATH (mergedPlanItemStates → shapePlanItemStates) end-to-end against migrations
 * 140 (assignments) + 141 (leased claims).
 *
 * The pure shaper has unit coverage (plan-item-states.test.ts) and the live HTTP
 * round-trip covered the pooled + assigned-idle cases; this closes the gap the live
 * verify could NOT reach — the `active` and `claimed-mismatch` dispositions, which need
 * a real seeded CLAIM. Seeding a claim live is blocked by EI-8 (the production swarm
 * claim-authority throws `require is not defined` under ESM). In tests the claim store
 * uses the pure LocalClaimAuthority default (the swarm authority is only installed from
 * the plan-items tool barrel, which we don't import), so acquireClaim works here and we
 * can assert the full disposition matrix against a real DB.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../../../libs/papercusp/libs/db/sql');
const readMigration = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter(
      (line) =>
        !/^\s*\\/.test(line) && !/\bGRANT\b/.test(line) && !/^\s*(BEGIN|COMMIT);\s*$/.test(line),
    )
    .join('\n');

const h = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql,
  plans: new Map<string, { items: { id: string; status: string }[] }>(),
}));

vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

vi.mock('../../../agent-tools/plans/source', () => ({
  resolvePlanScope: async (opts?: { workspaceId?: string; harnessSlug?: string }) => ({
    workspaceId: opts?.workspaceId ?? 'default',
    harnessSlug: opts?.harnessSlug ?? 'papercup',
  }),
  readPlanBySlug: async (slug: string) => {
    const p = h.plans.get(slug);
    if (!p) return null;
    return {
      archived: false,
      parsed: { items: p.items.map((i) => ({ id: i.id, storedStatus: i.status })) },
      row: { items: p.items },
    };
  },
}));

const asg = await import('../../../plan-items/assignments');
const claims = await import('../../../plan-items/claims');
const liveness = await import('../../../plan-items/liveness');
const { shapePlanItemStates } = await import('./plan-item-states');

const WS = 'default';
const HARNESS = 'papercup';
const PLAN = 'demo-plan';

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('plan-item-states');
  h.sql = db.sql;
  await db.sql.unsafe(readMigration('140-plan-item-assignments.sql')).simple();
  await db.sql.unsafe(readMigration('141-plan-item-claims.sql')).simple();
  // 143 (agent_activity) rides along because claims.ts's steal-guard/sweep SQL
  // (EI-8997 holder-activity grace check) joins it — without this table the
  // `active`/`claimed-mismatch` disposition cases below hit
  // `relation "harness_shared.agent_activity" does not exist` (EI-9473). Mirrors
  // the same pairing already applied in the sibling claims.integration.test.ts.
  await db.sql.unsafe(readMigration('143-agent-activity.sql')).simple();
  // Minimal contributors table for the shared-ness (liveness-mode) heuristic.
  await db.sql
    .unsafe(
      `CREATE TABLE IF NOT EXISTS harness_shared.contributors (
         workspace_id text NOT NULL,
         harness_slug text NOT NULL,
         github_user_id bigint NOT NULL,
         github_username text NOT NULL DEFAULT ''
       )`,
    )
    .simple();
}, 90_000);

afterAll(async () => {
  await db.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.plan_item_assignments,
                       harness_shared.plan_item_claims,
                       harness_shared.contributors`;
  liveness.resetHarnessSharedResolver();
  h.plans.clear();
  h.plans.set(PLAN, {
    items: [
      { id: 'P-001', status: 'todo' },
      { id: 'P-002', status: 'wip' },
      { id: 'P-003', status: 'wip' },
      { id: 'P-004', status: 'todo' },
      { id: 'P-005', status: 'todo' },
    ],
  });
});

async function assign(itemId: string, name: string) {
  await asg.assignItem({
    workspaceId: WS,
    harnessSlug: HARNESS,
    planSlug: PLAN,
    itemId,
    assigneeName: name,
    assignedByUser: 'user-x',
  });
}

async function claim(itemId: string, ownerName: string) {
  const res = await claims.acquireClaim({
    workspaceId: WS,
    harnessSlug: HARNESS,
    planSlug: PLAN,
    itemId,
    owner: `sess-${ownerName}`,
    ownerLabel: `su · ${ownerName}`,
    ownerName,
    intent: `working ${itemId}`,
    livenessMode: 'availability',
  });
  expect(res.ok).toBe(true);
}

describe('plan-item-states route data path (P-005a)', () => {
  it('produces the full disposition matrix through mergedPlanItemStates → shapePlanItemStates', async () => {
    // P-001 untouched → pooled.
    // P-002 assigned + claimed by the assignee → active.
    await assign('P-002', 'builder-1');
    await claim('P-002', 'builder-1');
    // P-003 assigned to owner-a but claimed by other-b → claimed-mismatch (drift).
    await assign('P-003', 'owner-a');
    await claim('P-003', 'other-b');
    // P-004 unassigned but claimed → claimed-pooled.
    await claim('P-004', 'puller');
    // P-005 assigned, no live claim → assigned-idle.
    await assign('P-005', 'idle-1');

    const merged = await liveness.mergedPlanItemStates(WS, HARNESS, PLAN);
    const mode = await liveness.harnessLivenessMode(WS, HARNESS);
    const dto = shapePlanItemStates(HARNESS, PLAN, mode, merged);
    const byId = Object.fromEntries(dto.items.map((i) => [i.itemId, i]));

    expect(byId['P-001'].disposition).toBe('pooled');
    expect(byId['P-001'].assigneeName).toBeNull();
    expect(byId['P-001'].claimOwnerName).toBeNull();
    expect(byId['P-001'].itemStatus).toBe('todo');

    expect(byId['P-002'].disposition).toBe('active');
    expect(byId['P-002'].assigneeName).toBe('builder-1');
    expect(byId['P-002'].claimOwnerName).toBe('builder-1');
    expect(byId['P-002'].claimLivenessMode).toBe('availability');
    expect(byId['P-002'].claimIntent).toBe('working P-002');
    expect(byId['P-002'].claimExpiresTs).toBeTruthy();

    expect(byId['P-003'].disposition).toBe('claimed-mismatch');
    expect(byId['P-003'].assigneeName).toBe('owner-a');
    expect(byId['P-003'].claimOwnerName).toBe('other-b');

    expect(byId['P-004'].disposition).toBe('claimed-pooled');
    expect(byId['P-004'].assigneeName).toBeNull();
    expect(byId['P-004'].claimOwnerName).toBe('puller');

    expect(byId['P-005'].disposition).toBe('assigned-idle');
    expect(byId['P-005'].assigneeName).toBe('idle-1');
    expect(byId['P-005'].claimOwnerName).toBeNull();

    expect(dto.harnessLivenessMode).toBe('availability'); // single box → LOCAL
    expect(dto.items).toHaveLength(5);
  });

  it('surfaces the harness liveness split (availability LOCAL vs activity SHARED)', async () => {
    // 0–1 contributors → availability (LOCAL).
    expect(await liveness.harnessLivenessMode(WS, HARNESS)).toBe('availability');
    // >1 distinct contributor → activity (SHARED).
    await db.sql`INSERT INTO harness_shared.contributors (workspace_id, harness_slug, github_user_id)
                 VALUES (${WS}, ${HARNESS}, 1), (${WS}, ${HARNESS}, 2)`;
    const mode = await liveness.harnessLivenessMode(WS, HARNESS);
    expect(mode).toBe('activity');
    const dto = shapePlanItemStates(HARNESS, PLAN, mode, await liveness.mergedPlanItemStates(WS, HARNESS, PLAN));
    expect(dto.harnessLivenessMode).toBe('activity');
  });

  it('an orphan claim/assignment (item not in the plan) still surfaces (inPlan=false)', async () => {
    // skipItemCheck: a record whose item id isn't in the plan (drift / a federated
    // insert). The merged view still surfaces it with inPlan=false.
    await asg.assignItem({
      workspaceId: WS,
      harnessSlug: HARNESS,
      planSlug: PLAN,
      itemId: 'P-099',
      assigneeName: 'ghost',
      assignedByUser: 'user-x',
      skipItemCheck: true,
    });
    const merged = await liveness.mergedPlanItemStates(WS, HARNESS, PLAN);
    const dto = shapePlanItemStates(HARNESS, PLAN, 'availability', merged);
    const orphan = dto.items.find((i) => i.itemId === 'P-099');
    expect(orphan).toBeTruthy();
    expect(orphan!.inPlan).toBe(false);
    expect(orphan!.assigneeName).toBe('ghost');
  });
});
