import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { createFrozenCandidateRepairQueue } from './frozen-candidate-repair-queue';
import { delegateRepairCausalGroup, reconcileRepairLeadHandoff, repairLeadIntake, updateStoredRepairLeadHandoff,
  type RepairLeadHandoff } from './frozen-repair-lead-handoff';

const WS = 'repair-lead-handoff-test';
const KEY = 'frozen-repair-convergence:papercusp';
const T = 1_800_000_000_000;
let org: OrgTestDb;
let sql: Sql;
beforeAll(async () => { org = await createOrgTestDb(); sql = org.adminSql; });
afterAll(async () => { await org?.cleanup(); });
beforeEach(async () => {
  await sql`DELETE FROM harness_shared.work_items WHERE workspace_id = ${WS}`;
  await sql`INSERT INTO harness_shared.work_items
    (workspace_id, harness_slug, feature_id, item_kind, title, status, condition_key, payload)
    VALUES (${WS}, 'papercusp', 'WI-HANDOFF', 'task', 'Repair handoff', 'open', ${KEY},
      ${JSON.stringify({ _bridge: { conditionKey: KEY }, independentSource: { ref: 'WI-SOURCE', proof: 'retain-me' } })}::text::jsonb)`;
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
