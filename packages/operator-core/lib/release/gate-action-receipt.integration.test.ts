import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';

const harness = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: harness.sql }),
}));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'receipt-test-ws' }));

const { executeWithGateActionReceipt } = await import('./gate-action-receipt');
let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('gate-action-receipt');
  harness.sql = db.sql;
  await db.sql.unsafe(`CREATE TABLE harness_shared.audit_log (
    id text PRIMARY KEY, ts bigint NOT NULL, actor text NOT NULL, action text NOT NULL,
    subject text NOT NULL, details jsonb NOT NULL, workspace_id text NOT NULL)`);
  await db.sql.unsafe(`CREATE TABLE harness_shared.coord_links (
    workspace_id text NOT NULL, src_kind text NOT NULL, src_ref text NOT NULL,
    dst_kind text NOT NULL, dst_ref text NOT NULL, rel text NOT NULL)`);
  await db.sql.unsafe(`CREATE TABLE harness_shared.work_items (
    workspace_id text NOT NULL, feature_id text PRIMARY KEY, status text,
    taken_by text, taken_at timestamptz, expires_at timestamptz)`);
  await db.sql.unsafe(`INSERT INTO harness_shared.work_items
    (workspace_id, feature_id, status, taken_by, taken_at)
    VALUES ('receipt-test-ws', 'WI-gate', 'wip', 'owner-a', now())`);
  await db.sql.unsafe(`INSERT INTO harness_shared.coord_links
    (workspace_id, src_kind, src_ref, dst_kind, dst_ref, rel)
    VALUES ('receipt-test-ws', 'issue', 'WI-gate', 'event', 'gate-red-streak:papercusp', 'about')`);
});

afterAll(async () => { await db?.cleanup(); });

describe('gate action claim/effect transaction', () => {
  it('holds the real claim row through the external effect and settles the same intent id', async () => {
    let releaseEffect!: () => void;
    let enteredEffect!: () => void;
    const effectHold = new Promise<void>((resolve) => { releaseEffect = resolve; });
    const entered = new Promise<void>((resolve) => { enteredEffect = resolve; });
    const action = executeWithGateActionReceipt({
      action: 'release:deploy', actor: 'test-actor', ownerId: 'owner-a',
      conditionKey: 'gate-red-streak:papercusp', target: { commit: 'abc' },
      run: async () => { enteredEffect(); await effectHold; return { launched: true }; },
      summarize: (effect) => ({ status: effect.launched ? 'accepted' : 'not-launched' }),
    });
    await entered;
    // A competing claim update cannot pass the row lock while the effect runs.
    const competingClaim = db.sql.unsafe(`UPDATE harness_shared.work_items SET taken_by = 'owner-b'
      WHERE workspace_id = 'receipt-test-ws' AND feature_id = 'WI-gate'`);
    const early = await Promise.race([
      competingClaim.then(() => 'updated'),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 75)),
    ]);
    expect(early).toBe('blocked');
    releaseEffect();
    const result = await action;
    await competingClaim;
    expect(result).toMatchObject({ ok: true, ownership: { holder: 'owner-a',
      certainty: 'claim-row-locked-through-effect' } });
    if (!result.ok) throw new Error(result.reason);
    const rows = await db.sql.unsafe<{ details: Record<string, unknown> | string }[]>(
      `SELECT details FROM harness_shared.audit_log WHERE id = $1`, [result.receiptId]);
    const details = typeof rows[0]?.details === 'string' ? JSON.parse(rows[0].details) : rows[0]?.details;
    expect(details).toMatchObject({ phase: 'settled',
      ownership: { workItem: 'WI-gate', holder: 'owner-a' },
      ownershipCertainty: 'claim-row-locked-through-effect', effect: { status: 'accepted' } });
  });
});
