/** Waiting qualifications recover the durable condition without changing gate custody. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const db = vi.hoisted(() => ({ sql: null as Sql | null, workspace: 'test-lost-run-resolution' }));
vi.mock('@papercusp/db-org', async importOriginal => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: db.sql }),
}));
vi.mock('../pg-bounded-txn', () => ({
  boundedOrgTxn: async (run: (tx: Sql) => Promise<unknown>) => db.sql!.begin(tx => run(tx as unknown as Sql)),
}));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => db.workspace }));

import { sweepLostGateRuns } from './lost-gate-run-alarm';
import { beginStoredQualification, reserveStoredQualificationRunner, recordStoredQualificationVerdict,
  readStoredQualification } from './checkpoint-qualification-transaction';
import { computeConditionStates, readConditionEnvelopesForKey } from '../agent-tools/coordination/condition-state';

let org: OrgTestDb;
let sql: Sql;
beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  db.sql = sql;
});
afterAll(async () => {
  db.sql = null;
  await org?.cleanup();
});

describe('waiting qualification alarm recovery (real PG)', () => {
  it.each(['disk-headroom', 'dependency-generation', 'repair-in-progress'])(
    'resolves only the settled runner condition for %s', async reason => {
      const target = { workspaceId: db.workspace, installSlug: `waiting-${reason}` };
      const attemptId = `attempt-${reason}`;
      const conditionKey = `green-checkpoint-run-progress:${target.installSlug}`;
      const nowMs = Date.now();
      await sql`INSERT INTO harness_shared.routines
        (id, install_slug, name, trigger_kind, trigger_config, target_role, active, workspace_id, metadata, next_fire_at)
        VALUES (${`rt-${reason}`}, ${target.installSlug}, 'green-checkpoint', 'cron', '{}'::jsonb,
          'system:green-checkpoint', TRUE, ${target.workspaceId}, '{}'::jsonb, now() + interval '1 hour')`;
      expect((await beginStoredQualification(target, { attemptId, candidate: 'waiting-candidate', nowMs })).status)
        .toBe('updated');
      expect((await reserveStoredQualificationRunner(target, { attemptId, runnerId: `runner-${reason}`,
        runId: `run-${reason}`, unit: `waiting-${reason}.scope`, pid: process.pid,
        leaseDurationMs: 60_000, nowMs, started: true })).status).toBe('updated');
      const sweep = () => sweepLostGateRuns(sql, {
        nowMs: nowMs + 1000, observerGeneration: `observer-${reason}`, observerSequence: 1, monotonicAtMs: 1000,
        probeQualificationRunner: () => 'unknown', readHolder: async () => null, hostFleetSlug: null,
        notifyOwner: async () => {},
      });
      await sweep();
      const condition = async () => computeConditionStates(await readConditionEnvelopesForKey(conditionKey));
      expect(await condition()).toMatchObject([{ condition_key: conditionKey, open: true, one_shot: true }]);
      expect((await recordStoredQualificationVerdict(target, { attemptId, reason, nowMs: nowMs + 2000 })).status)
        .toBe('updated');
      const waiting = await readStoredQualification(target);
      expect(waiting).toMatchObject({ status: 'present', transaction: {
        phase: 'waiting', currentPhysicalRunner: null,
        outcome: { kind: 'pre-suite-no-verdict', reason },
      } });
      const [before] = await sql`SELECT metadata, next_fire_at::text AS next_fire_at FROM harness_shared.routines
        WHERE install_slug = ${target.installSlug} AND workspace_id = ${target.workspaceId}`;
      await sweep();
      expect(await condition()).toMatchObject([{ condition_key: conditionKey, open: false, alarm_count: 1 }]);
      expect(await readStoredQualification(target)).toEqual(waiting);
      const [after] = await sql`SELECT metadata, next_fire_at::text AS next_fire_at FROM harness_shared.routines
        WHERE install_slug = ${target.installSlug} AND workspace_id = ${target.workspaceId}`;
      expect(after).toEqual(before);
      // A later pass cannot append another resolution or resurrect the original alarm.
      const envelopes = await readConditionEnvelopesForKey(conditionKey);
      await sweep();
      expect(await readConditionEnvelopesForKey(conditionKey)).toEqual(envelopes);
    },
  );
});
