import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { createFrozenCandidateRepairQueue } from './frozen-candidate-repair-queue';
import { delegateRepairCausalGroup, reconcileRepairLeadHandoff, repairLeadIntake, routeFrozenRepairToLead, updateStoredRepairLeadHandoff,
  type RepairLeadHandoff } from './frozen-repair-lead-handoff';
import { insertDeliveries, listDeliveriesForSources, markDeliveryDelivered, upsertInboxWakeAwait } from '../events/await/store';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';

const db = vi.hoisted(() => ({ sql: undefined as unknown as Sql, send: vi.fn(), wake: vi.fn() }));
vi.mock('@papercusp/db-org', async original => ({
  ...(await original<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: db.sql }),
}));
vi.mock('../coord/condition-bridge', () => ({
  acquireConditionOwner: async () => ({ workItem: 'WI-HANDOFF' }),
  readLiveGateOwnerForAssignment: async () => ({ ok: true, heldByLiveHolder: true,
    ownership: { takenBy: 'lead', workItem: 'WI-GATE' } }),
}));
vi.mock('../agent-tools/coordination/liveness-oracle', () => ({
  resolveSessionStates: async (owners: { ownerId: string }[]) => new Map(owners.map(owner => [owner.ownerId, { sessionState: 'live' }])),
}));
vi.mock('../agent-tools/coordination/messages', () => ({ sendMessage: db.send }));
vi.mock('../agent-tools/coordination/inbox-wake', () => ({ wakeRecipients: db.wake }));

const WS = 'repair-lead-handoff-test';
const KEY = 'frozen-repair-convergence:papercusp';
const T = 1_800_000_000_000;
let org: OrgTestDb;
let sql: Sql;
beforeAll(async () => { org = await createOrgTestDb(); sql = org.adminSql; db.sql = sql; });
afterAll(async () => { await org?.cleanup(); });
beforeEach(async () => {
  vi.clearAllMocks();
  await sql`DELETE FROM harness_shared.event_wake_deliveries`;
  await sql`DELETE FROM harness_shared.event_awaits`;
  await sql`DELETE FROM harness_shared.work_items WHERE workspace_id = ${WS}`;
  await sql`INSERT INTO harness_shared.work_items
    (workspace_id, harness_slug, feature_id, item_kind, title, status, condition_key, payload)
    VALUES (${WS}, 'papercusp', 'WI-HANDOFF', 'task', 'Repair handoff', 'open', ${KEY},
      ${JSON.stringify({ _bridge: { conditionKey: KEY }, independentSource: { ref: 'WI-SOURCE', proof: 'retain-me' } })}::text::jsonb)`;
  await sql`INSERT INTO harness_shared.work_items
    (workspace_id, harness_slug, feature_id, item_kind, title, status, taken_by)
    VALUES (${WS}, 'papercusp', 'WI-GATE', 'task', 'Gate ownership fixture', 'wip', 'lead')`;
  db.wake.mockImplementation(async (owners: string[], opts: { source: string; payload: unknown }) => {
    const awaits = await Promise.all(owners.map(subscriberId => upsertInboxWakeAwait({ subscriberId,
      eventKey: 'coord:inbox-wake:' + subscriberId })));
    await insertDeliveries({ awaits, source: opts.source, payload: opts.payload, urgent: true });
  });
});
const scope = { workspaceId: WS, workItem: 'WI-HANDOFF', conditionKey: KEY };
const queue = (n: number, round = 0) => ({ ...createFrozenCandidateRepairQueue({ candidate: 'a'.repeat(40),
  base: 'b'.repeat(40), failingTests: Array.from({ length: n }, (_, i) => `lib/native-${i}.test.ts`), nowMs: T }),
  repairHead: round.toString(16).padStart(40, '0') });
const reconcile = (prior: RepairLeadHandoff | null, n: number, round = 0) => reconcileRepairLeadHandoff({
  prior, pipeline: 'papercusp', intake: repairLeadIntake(queue(n, round), 'native-ledger-round'),
  lead: { owner: 'lead', workItem: 'WI-LEAD' }, workerStates: new Map(), nowMs: T + round,
});
const load = async () => (await sql<{ payload: { frozenRepairHandoff: RepairLeadHandoff; independentSource: unknown } }[]>`
  SELECT payload FROM harness_shared.work_items WHERE workspace_id = ${WS} AND feature_id = 'WI-HANDOFF'`)[0].payload;

describe('repair-lead native Postgres custody', () => {
  it('recovers the real flat-partition delivery and distinguishes accepted delivery from turn start', async () => {
    const input = { workspaceId: WS, pipeline: 'papercusp', queue: queue(13), reason: 'native-delivery' };
    expect(await routeFrozenRepairToLead(input)).toMatchObject({ pickup: 'pending' });
    const state = (await load()).frozenRepairHandoff;
    const source = 'frozen-repair-handoff:' + state.groups[0].delivery!.id;
    const rows = await listDeliveriesForSources([source]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workspaceId: DEFAULT_COORD_WORKSPACE, subscriberId: 'lead', source, turnProof: null });
    expect(rows[0].workspaceId).not.toBe(WS);
    await sql`UPDATE harness_shared.event_wake_deliveries SET status = 'delivering' WHERE id = ${rows[0].id}`;
    await markDeliveryDelivered(rows[0].id, 'psu-socket-inject');
    expect(await routeFrozenRepairToLead(input)).toMatchObject({ pickup: 'pending' });
    expect(db.wake).toHaveBeenCalledTimes(1);
    expect(db.send).toHaveBeenCalledTimes(1);
    expect((await listDeliveriesForSources([source]))[0]).toMatchObject({ turnProof: 'awaiting', turnStartedAt: null });
    await sql`UPDATE harness_shared.event_wake_deliveries SET status = 'delivering' WHERE id = ${rows[0].id}`;
    await markDeliveryDelivered(rows[0].id, 'psu-socket-inject', 1, 'host-attested');
    expect(await routeFrozenRepairToLead(input)).toMatchObject({ pickup: 'confirmed' });
    expect((await load()).frozenRepairHandoff.groups[0].delivery!.pickup).toBe('confirmed');
    expect(db.wake).toHaveBeenCalledTimes(1);
  });

  it('matches the assigned owner and recovers old exact sources after unrelated delivery traffic', async () => {
    const nowMs = Date.now() - 1_000;
    const current = queue(13);
    const state = reconcileRepairLeadHandoff({ prior: null, pipeline: 'papercusp', intake: repairLeadIntake(current, 'prepared'),
      lead: { owner: 'lead', workItem: 'WI-GATE' }, workerStates: new Map(), nowMs });
    // A crashed reservation is not a worker launch and must not silently consume
    // the strategy's three-launch budget or disable future transport recovery.
    state.groups[0].delivery!.sendAttempts = 5;
    await updateStoredRepairLeadHandoff(sql, scope, async () => ({ state, result: null }));
    const source = 'frozen-repair-handoff:' + state.groups[0].delivery!.id;
    const other = await upsertInboxWakeAwait({ subscriberId: 'other-agent', eventKey: 'coord:inbox-wake:other-agent' });
    await insertDeliveries({ awaits: [other], source, urgent: true });
    const [foreign] = await listDeliveriesForSources([source]);
    await sql`UPDATE harness_shared.event_wake_deliveries SET status = 'delivering' WHERE id = ${foreign.id}`;
    await markDeliveryDelivered(foreign.id, 'psu-socket-inject', 1, 'host-attested');
    await Promise.all(Array.from({ length: 31 }, (_, index) => insertDeliveries({ awaits: [other], source: 'unrelated:' + index, urgent: true })));
    expect(await routeFrozenRepairToLead({ workspaceId: WS, pipeline: 'papercusp', queue: current, reason: 'recover' }))
      .toMatchObject({ pickup: 'pending' });
    expect(db.wake).toHaveBeenCalledTimes(1);
    const recovered = await listDeliveriesForSources([source]);
    expect(recovered.map(row => row.subscriberId)).toEqual(['other-agent', 'lead']);
    expect((await load()).frozenRepairHandoff.groups[0].delivery!.pickup).toBe('pending');
  });

  it.each([11, 12, 13, 107])('stores and recovers the entire %i-member intake through the consumer', async n => {
    await updateStoredRepairLeadHandoff(sql, scope, async prior => {
      const state = reconcile(prior, n); return { state, result: state.latestIntake };
    });
    const payload = await load();
    expect(payload.frozenRepairHandoff.intakes[0].queue.failingTests).toEqual(queue(n).failingTests);
    expect(payload.frozenRepairHandoff.groups[0].members).toHaveLength(n);
    expect(payload.independentSource).toEqual({ ref: 'WI-SOURCE', proof: 'retain-me' });
  });

  it('serializes concurrent/restarted consumers without duplicate groups or lost later batches', async () => {
    for (let batch = 0; batch < 4; batch++) {
      await Promise.all(Array.from({ length: 6 }, (_, i) => updateStoredRepairLeadHandoff(sql, scope, async prior => {
        const state = reconcile(prior, 13, batch * 6 + i); return { state, result: state.latestIntake };
      })));
    }
    const state = (await load()).frozenRepairHandoff;
    expect(state.intakes).toHaveLength(24);
    expect(new Set(state.intakes.map(row => row.id)).size).toBe(24);
    expect(state.groups).toHaveLength(1);
    for (const intake of state.intakes) expect(intake.queue.failingTests).toContain('lib/native-12.test.ts');
    await Promise.all(Array.from({ length: 6 }, () => updateStoredRepairLeadHandoff(sql, scope, async prior => {
      const next = reconcile(prior, 13, 23); return { state: next, result: next.latestIntake };
    })));
    expect((await load()).frozenRepairHandoff.intakes).toHaveLength(24);
  });

  it('uses one durable attempt under duplicate delegation and rolls back an invalid overlapping group', async () => {
    await updateStoredRepairLeadHandoff(sql, scope, async prior => ({ state: reconcile(prior, 13), result: null }));
    const assignment = { id: 'shared-cause', caller: 'lead', worker: 'worker', members: ['lib/native-12.test.ts'],
      sourcePaths: ['lib/shared.ts'], causeEvidence: ['test-run:shared-root'], independentOf: [], sourceWorkItem: 'WI-SOURCE',
      strategy: 'repair-shared-root', attemptId: 'launch-1', atMs: T + 1 };
    await Promise.all(Array.from({ length: 6 }, () => updateStoredRepairLeadHandoff(sql, scope, async prior => {
      const state = delegateRepairCausalGroup(prior!, assignment); return { state, result: null };
    })));
    const before = (await load()).frozenRepairHandoff;
    expect(before.groups.find(group => group.id === 'shared-cause')!.attempts).toHaveLength(1);
    await expect(updateStoredRepairLeadHandoff(sql, scope, async prior => {
      const state = delegateRepairCausalGroup(prior!, { ...assignment, id: 'overlap', attemptId: 'launch-2' });
      return { state, result: null };
    })).rejects.toThrow('membership overlaps');
    expect((await load()).frozenRepairHandoff).toEqual(before);
  });

  it('protects independently registered source work and an unknown persisted schema', async () => {
    await sql`UPDATE harness_shared.work_items SET payload = payload - '_bridge' WHERE workspace_id = ${WS}`;
    await expect(updateStoredRepairLeadHandoff(sql, scope, async prior => ({ state: reconcile(prior, 13), result: null })))
      .rejects.toThrow('independent source work is protected');
    await sql`UPDATE harness_shared.work_items SET payload = payload ||
      '{"_bridge":{},"frozenRepairHandoff":{"schemaVersion":99,"evidence":"retain"}}'::jsonb WHERE workspace_id = ${WS}`;
    await expect(updateStoredRepairLeadHandoff(sql, scope, async prior => ({ state: reconcile(prior, 13), result: null })))
      .rejects.toThrow('Unsupported repair handoff schema');
    const payload = await load();
    expect(payload.frozenRepairHandoff).toEqual({ schemaVersion: 99, evidence: 'retain' });
    expect(payload.independentSource).toEqual({ ref: 'WI-SOURCE', proof: 'retain-me' });
  });
});
