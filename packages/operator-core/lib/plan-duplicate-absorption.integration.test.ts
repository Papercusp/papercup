import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, applyMigrationForTest, type FreshPgDb } from '../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, WORK_ITEM_DEPS_DDL } from '../test/_work-items-schema';
import { prepareBlockerDecision, readBlockerResolution, type BlockerDecisionInput } from './blocker-resolution-decision';
import { applyBlockerDecisionMutation } from './blocker-resolution-persistence';
import { absorptionDecisionHash, bindPlanAbsorptionInTransaction } from './plan-duplicate-absorption';
import { mutateWorkItemDependencies, mutateWorkItemDependenciesInTransaction,
  withWorkItemDependencyAdmissionTransaction, type WorkItemDependencyMutation } from './dbos/work-item-deps-store';

const WS = 'absorption-test', H = 'absorption', OWNER = 'su-absorber', producer = 'su-producer';
const scope = { workspaceId: WS, harnessSlug: H, planSlug: 'portfolio', itemId: 'P-003' };
const title = 'Preserve duplicate obligations';
const body = 'Absorb P-003 into the existing producer; preserve pending sequencing and consumers.';
const ep = (id: string) => ({ kind: 'feature', ref: `${H}#${id}` });
let db: FreshPgDb;
const decision = (): BlockerDecisionInput => ({
  schemaVersion: 1, idempotencyKey: 'absorption-1', disposition: 'absorb',
  symptom: 'Duplicate implementation lane', attempts: [],
  investigation: [{ action: 'Read canonical source and producer', outcome: 'Same obligation, pending producer',
    evidenceRefs: [{ kind: 'work-item', ref: `${H}#WI-producer` }] }],
  evidenceRefs: [{ kind: 'work-item', ref: `${H}#WI-producer` }],
  absorption: { rationale: 'Retain producer execution and consumer sequencing', decisionId: 'D-006',
    decisionHash: absorptionDecisionHash(title, body),
    survivors: [{ harness: H, id: 'WI-producer', responsibleParty: producer }] },
});
const mutate = (mutations: WorkItemDependencyMutation[]) => mutateWorkItemDependencies({
  workspaceId: 'default', itemWorkspaceId: WS, mutations,
}, { sql: db.sql as Sql });
const add = (blocked: string, blocker: string, satisfaction: 'success' | 'settled' = 'settled') =>
  mutate([{ op: 'add', blocked: ep(blocked), blocker: ep(blocker), satisfaction }]);
async function blocked(id: string) {
  const [row] = await db.sql<{ blocked: boolean }[]>`SELECT harness_shared.work_item_is_blocked(${H}, ${id}, ${WS}) AS blocked`;
  return row.blocked;
}
async function absorb(input = decision(), abort = false, id = 'WI-source', itemId = scope.itemId) {
  return withWorkItemDependencyAdmissionTransaction(db.sql as Sql, async tx => {
    const [row] = await tx<{ payload: unknown }[]>`SELECT payload FROM harness_shared.work_items
      WHERE workspace_id=${WS} AND feature_id=${id}`;
    const prepared = prepareBlockerDecision(row.payload, input, { ownerId: OWNER, sessionId: OWNER,
      workItemId: id, custodianId: OWNER }, { effect: { status: 'dropped' } });
    if (!prepared.ok) throw new Error(JSON.stringify(prepared));
    const bound = await bindPlanAbsorptionInTransaction(tx, { ...scope, itemId }, prepared);
    await applyBlockerDecisionMutation(tx, { workspace: WS, harness: H, id }, {
      prepared: bound.prepared, expectedState: 'open', expectedCustodianId: OWNER,
      expectedExternalBlockers: (row.payload as { externalBlockers?: unknown } | null)?.externalBlockers,
      payloadPatch: {}, unset: [],
    });
    await tx`UPDATE harness_shared.work_items SET status='dropped', taken_by=NULL
      WHERE workspace_id=${WS} AND feature_id=${id}`;
    await mutateWorkItemDependenciesInTransaction(tx, {
      workspaceId: 'default', itemWorkspaceId: WS, mutations: bound.mutations,
    });
    if (abort) throw new Error('injected paired write failure');
    return bound.prepared.record;
  });
}
beforeAll(async () => {
  db = await createFreshPgDb('plan-duplicate-absorption');
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL).simple();
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  await applyMigrationForTest(db.sql, fileURLToPath(new URL(
    '../../../libs/papercusp/libs/db/sql/992-work-item-dependency-satisfaction.sql', import.meta.url)));
  await applyMigrationForTest(db.sql, fileURLToPath(new URL(
    '../../../libs/papercusp/libs/db/sql/1087-align-blocker-ref-indexability.sql', import.meta.url)));
}, 90_000);
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_item_deps, harness_shared.work_items, harness_shared.plan_decisions CASCADE`;
  for (const [id, plan, line, owner] of [
    ['WI-source', 'portfolio', 'P-003', null], ['WI-producer', 'producer', 'P-001', producer],
    ['WI-prerequisite', 'portfolio', 'P-001', null], ['WI-consumer', 'portfolio', 'P-005', null],
    ['WI-later', 'portfolio', 'P-006', null],
  ]) await db.sql`INSERT INTO harness_shared.work_items
    (workspace_id,harness_slug,feature_id,title,item_kind,status,taken_by,plan_slug,plan_line_id,payload,created_ts,updated_ts)
    VALUES (${WS},${H},${id},${id},'feature','open',${owner},${plan},${line},'{}'::jsonb,0,0)`;
  await db.sql`INSERT INTO harness_shared.plan_decisions
    (workspace_id,harness_slug,plan_slug,decision_id,seq,title,body,item_refs)
    VALUES (${WS},${H},'portfolio','D-006',0,${title},${body},ARRAY['P-003'])`;
  await add('WI-source', 'WI-prerequisite', 'success');
  await add('WI-consumer', 'WI-source', 'success');
  await db.sql`UPDATE harness_shared.work_items SET taken_by=${OWNER} WHERE feature_id='WI-source'`;
});
describe('atomic absorption over the canonical PostgreSQL graph', () => {
  it('keeps pending survivors and sequencing blocking existing and future consumers until required success', async () => {
    expect(await blocked('WI-consumer')).toBe(true);
    const receipt = await absorb();
    expect(receipt.absorptionGraph?.obligations).toContainEqual({ blocker: ep('WI-prerequisite'), satisfaction: 'success' });
    expect(await blocked('WI-consumer')).toBe(true);
    await add('WI-later', 'WI-source', 'success');
    expect(await blocked('WI-later')).toBe(true);
    const [row] = await db.sql`SELECT taken_by,status FROM harness_shared.work_items WHERE feature_id='WI-producer'`;
    expect(row).toMatchObject({ taken_by: producer, status: 'open' });
    await db.sql`UPDATE harness_shared.work_items SET status='done',authority='committed',taken_by=NULL WHERE feature_id='WI-prerequisite'`;
    expect(await blocked('WI-consumer')).toBe(true);
    await db.sql`UPDATE harness_shared.work_items SET status='dropped',taken_by=NULL WHERE feature_id='WI-producer'`;
    expect(await blocked('WI-consumer')).toBe(true);
    await db.sql`UPDATE harness_shared.work_items SET status='done',authority='proposed' WHERE feature_id='WI-producer'`;
    expect(await blocked('WI-consumer')).toBe(true);
    await db.sql`UPDATE harness_shared.work_items SET authority='committed' WHERE feature_id='WI-producer'`;
    expect(await blocked('WI-consumer')).toBe(false);
    expect(await blocked('WI-later')).toBe(false);
  });
  it('rolls back receipt, terminal lifecycle and effective edges together', async () => {
    await expect(absorb(decision(), true)).rejects.toThrow('injected paired write failure');
    const [row] = await db.sql`SELECT status,taken_by,payload FROM harness_shared.work_items WHERE feature_id='WI-source'`;
    expect(row).toMatchObject({ status: 'open', taken_by: OWNER });
    expect(readBlockerResolution(row.payload).status).toBe('unproven');
    const [edge] = await db.sql`SELECT blocker_ref FROM harness_shared.work_item_deps WHERE blocked_ref=${ep('WI-consumer').ref}`;
    expect(edge.blocker_ref).toBe(ep('WI-source').ref);
  });
  it('replaces only the exact source plan-lane gate while retaining its canonical history', async () => {
    const gate = { kind: 'runtime', status: 'active', ref: 'plan-lane:portfolio#P-003',
      createdBy: 'system:plan-item-lane-sync' };
    await db.sql`UPDATE harness_shared.work_items SET payload=${db.sql.json({ externalBlockers: [gate] })}
      WHERE feature_id='WI-source'`;
    await absorb();
    expect(await blocked('WI-consumer')).toBe(true);
    const [row] = await db.sql`SELECT payload FROM harness_shared.work_items WHERE feature_id='WI-source'`;
    expect(row.payload.externalBlockers).toEqual([gate]);
  });
  it('preserves transitive sequencing when an upstream duplicate is absorbed later', async () => {
    for (const [id, plan, line, owner] of [
      ['WI-source2', 'portfolio', 'P-004', null], ['WI-producer2', 'producer', 'P-002', producer],
      ['WI-consumer2', 'portfolio', 'P-007', null],
    ]) await db.sql`INSERT INTO harness_shared.work_items
      (workspace_id,harness_slug,feature_id,title,item_kind,status,taken_by,plan_slug,plan_line_id,payload,created_ts,updated_ts)
      VALUES (${WS},${H},${id},${id},'feature','open',${owner},${plan},${line},'{}'::jsonb,0,0)`;
    await db.sql`UPDATE harness_shared.plan_decisions SET item_refs=ARRAY['P-003','P-004']`;
    await add('WI-source2', 'WI-source', 'success');
    await add('WI-consumer2', 'WI-source2', 'success');
    await db.sql`UPDATE harness_shared.work_items SET taken_by=${OWNER} WHERE feature_id='WI-source2'`;
    const downstream = decision();
    if (downstream.disposition !== 'absorb') throw new Error('fixture');
    downstream.absorption.survivors[0].id = 'WI-producer2';
    await absorb(downstream, false, 'WI-source2', 'P-004');
    await absorb();
    expect(await blocked('WI-consumer2')).toBe(true);
    await db.sql`UPDATE harness_shared.work_items SET status='done',authority='committed',taken_by=NULL
      WHERE feature_id IN ('WI-producer2','WI-prerequisite')`;
    expect(await blocked('WI-consumer2')).toBe(true);
    await db.sql`UPDATE harness_shared.work_items SET status='done',authority='committed',taken_by=NULL WHERE feature_id='WI-producer'`;
    expect(await blocked('WI-consumer2')).toBe(false);
  });
  it.each(['missing', 'self', 'foreign', 'unowned', 'authority', 'hold', 'cycle'])('refuses %s mapping', async kind => {
    const input = decision();
    if (input.disposition !== 'absorb') throw new Error('fixture');
    if (kind === 'missing') input.absorption.survivors[0].id = 'WI-missing';
    if (kind === 'self') input.absorption.survivors[0].id = 'WI-source';
    if (kind === 'foreign') input.absorption.survivors[0].harness = 'elsewhere';
    if (kind === 'authority') input.absorption.decisionHash = '0'.repeat(64);
    if (kind === 'unowned') await db.sql`UPDATE harness_shared.work_items SET taken_by=NULL WHERE feature_id='WI-producer'`;
    if (kind === 'hold') await db.sql`UPDATE harness_shared.work_items SET payload='{"_claimHold":true}'::jsonb WHERE feature_id='WI-source'`;
    if (kind === 'cycle') {
      await db.sql`UPDATE harness_shared.work_items SET taken_by=NULL WHERE feature_id='WI-producer'`;
      await add('WI-producer', 'WI-consumer');
      await db.sql`UPDATE harness_shared.work_items SET taken_by=${producer} WHERE feature_id='WI-producer'`;
    }
    await expect(absorb(input)).rejects.toThrow();
    const [row] = await db.sql`SELECT status,payload FROM harness_shared.work_items WHERE feature_id='WI-source'`;
    expect(row.status).toBe('open');
    expect(readBlockerResolution(row.payload).status).toBe('unproven');
  });
});
