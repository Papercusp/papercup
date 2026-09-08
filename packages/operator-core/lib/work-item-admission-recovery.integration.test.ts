import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import {
  AdmissionRecoveryRefused, requestAdmissionRecovery, runAdmissionRecoveries,
  type AdmissionRecoveryDeps,
} from './work-item-admission-recovery';

let db: FreshPgDb;
const scope = { workspaceId: 'ws-recovery', harnessSlug: 'papercusp', workItemId: 'WI-original' };
const input = { ...scope, caller: 'requester', target: 'reviewer' };
const authorize = vi.fn(async () => {});
beforeAll(async () => {
  db = await createFreshPgDb('admission-recovery');
  await db.sql.unsafe(`
    CREATE SCHEMA IF NOT EXISTS harness_shared;
    CREATE TABLE harness_shared.operator_secrets(name text PRIMARY KEY, value_b64 text);
    INSERT INTO harness_shared.operator_secrets VALUES ('spawn-signing-key', '${Buffer.alloc(32, 42).toString('base64')}');
    CREATE TABLE harness_shared.work_items (
      workspace_id text, harness_slug text, feature_id text, status text DEFAULT 'open',
      origin text DEFAULT 'local', taken_by text, admission text DEFAULT 'pending', payload jsonb,
      PRIMARY KEY(workspace_id, harness_slug, feature_id)
    );
    CREATE TABLE harness_shared.routines (
      id text PRIMARY KEY, workspace_id text, install_slug text, name text, target_role text,
      active boolean DEFAULT true, trigger_config jsonb, next_fire_at timestamptz
    );
  `);
}, 60_000);
afterAll(async () => db?.cleanup());
beforeEach(async () => {
  authorize.mockReset().mockResolvedValue(undefined);
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.routines`;
  await db.sql`
    INSERT INTO harness_shared.work_items(workspace_id,harness_slug,feature_id,payload)
    VALUES (${scope.workspaceId}, ${scope.harnessSlug}, ${scope.workItemId}, '{"keep":"original"}')`;
  await db.sql`
    INSERT INTO harness_shared.routines(id,workspace_id,install_slug,name,target_role,trigger_config,next_fire_at)
    VALUES ('real-promoter',${scope.workspaceId},${scope.harnessSlug},'work-item-admission-promoter',
      'system:work-item-admission-promoter','{"cron":"*/30 * * * *"}', now() + interval '30 minutes')`;
});
async function current() {
  const [row] = await db.sql`SELECT * FROM harness_shared.work_items WHERE feature_id = ${scope.workItemId}`;
  return row!;
}
function deps(overrides: Partial<AdmissionRecoveryDeps> = {}): AdmissionRecoveryDeps {
  return {
    authorize,
    screen: vi.fn(async (_scope, beforePersist) => {
      await beforePersist();
      await db.sql`UPDATE harness_shared.work_items SET admission = 'admitted' WHERE feature_id = ${scope.workItemId}`;
    }),
    dispatch: vi.fn(async () => {
      const row = await current();
      expect(row.admission).toBe('admitted');
      await db.sql`UPDATE harness_shared.work_items SET taken_by = 'reviewer' WHERE feature_id = ${scope.workItemId}`;
      return { ok: true, wake: { queued: 1, woken: 1 } } as Awaited<ReturnType<AdmissionRecoveryDeps['dispatch']>>;
    }),
    ...overrides,
  };
}

describe('original-item durable admission recovery', () => {
  it('concurrent/repeated requests persist one identity and atomically accelerate the real routine', async () => {
    // First commit establishes the visible identity; racing retries must preserve it.
    const first = await requestAdmissionRecovery(input, { authorize }, db.sql);
    const retries = await Promise.all(Array.from({ length: 5 }, () => requestAdmissionRecovery(input, { authorize }, db.sql)));
    expect(new Set([first, ...retries].map((r) => r.request.requestId)).size).toBe(1);
    const [count] = await db.sql`SELECT count(*)::int AS n FROM harness_shared.work_items`;
    expect(count!.n).toBe(1);
    expect((await current()).payload).toMatchObject({ keep: 'original', _admissionRecovery: { state: 'queued' } });
    const [routine] = await db.sql`SELECT next_fire_at <= now() AS due FROM harness_shared.routines`;
    expect(routine!.due).toBe(true);
  });

  it.each(['missing', 'paused', 'wrong-role', 'one-shot'])('refuses a %s routine without persisting a request', async (mode) => {
    if (mode === 'missing') await db.sql`DELETE FROM harness_shared.routines`;
    if (mode === 'paused') await db.sql`UPDATE harness_shared.routines SET active = false`;
    if (mode === 'wrong-role') await db.sql`UPDATE harness_shared.routines SET target_role = 'system:other'`;
    if (mode === 'one-shot') await db.sql`UPDATE harness_shared.routines SET trigger_config = '{}'`;
    await expect(requestAdmissionRecovery(input, { authorize }, db.sql)).rejects.toThrow('existing recurring');
    expect((await current()).payload).toEqual({ keep: 'original' });
  });

  it('caller revocation after enqueue holds the same item without screening or dispatch', async () => {
    await requestAdmissionRecovery(input, { authorize }, db.sql);
    const d = deps();
    authorize.mockRejectedValue(new AdmissionRecoveryRefused('requester no longer authorized'));
    await runAdmissionRecoveries(scope, d, db.sql);
    expect(d.screen).not.toHaveBeenCalled();
    expect(d.dispatch).not.toHaveBeenCalled();
    expect((await current()).payload._admissionRecovery).toMatchObject({ state: 'held', pickupConfirmed: false });
    await expect(requestAdmissionRecovery(input, { authorize }, db.sql)).rejects.toThrow('no longer authorized');
  });

  it('rejects a forged caller or a request transplanted onto another item', async () => {
    await requestAdmissionRecovery(input, { authorize }, db.sql);
    await db.sql`
      INSERT INTO harness_shared.work_items(workspace_id,harness_slug,feature_id,payload)
      SELECT workspace_id,harness_slug,'WI-transplant',payload FROM harness_shared.work_items`;
    await db.sql`UPDATE harness_shared.work_items
      SET payload = jsonb_set(payload, '{_admissionRecovery,caller}', '"forged"')
      WHERE feature_id = ${scope.workItemId}`;
    const d = deps();
    await runAdmissionRecoveries(scope, d, db.sql);
    expect(d.screen).not.toHaveBeenCalled();
    expect(d.dispatch).not.toHaveBeenCalled();
    const rows = await db.sql`SELECT payload->'_admissionRecovery'->>'reason' AS reason FROM harness_shared.work_items`;
    expect(rows.every((r) => r.reason.includes('provenance is invalid'))).toBe(true);
  });

  it('rechecks authority after screening latency and stops before admission persistence', async () => {
    await requestAdmissionRecovery(input, { authorize }, db.sql);
    const d = deps({ screen: async (_scope, beforePersist) => {
      authorize.mockRejectedValue(new AdmissionRecoveryRefused('target policy revoked during model call'));
      await beforePersist();
      throw new Error('unreachable persistence');
    } });
    await runAdmissionRecoveries(scope, d, db.sql);
    expect((await current()).admission).toBe('pending');
    expect(d.dispatch).not.toHaveBeenCalled();
  });

  it('a paused routine after queueing cannot screen or wake', async () => {
    await requestAdmissionRecovery(input, { authorize }, db.sql);
    await db.sql`UPDATE harness_shared.routines SET active = false`;
    const d = deps();
    await runAdmissionRecoveries(scope, d, db.sql);
    expect(d.screen).not.toHaveBeenCalled();
    expect(d.dispatch).not.toHaveBeenCalled();
  });

  it('replays after a crash following committed assignment without creating or rescreening', async () => {
    const first = await requestAdmissionRecovery(input, { authorize }, db.sql);
    const d = deps();
    const originalDispatch = d.dispatch;
    d.dispatch = vi.fn(async (args) => {
      const result = await originalDispatch(args);
      if (vi.mocked(d.dispatch).mock.calls.length === 1) throw new Error('crash after assignment');
      return result;
    });
    await expect(runAdmissionRecoveries(scope, d, db.sql)).rejects.toThrow('crash after assignment');
    expect((await current()).taken_by).toBe('reviewer');
    expect((await current()).payload._admissionRecovery.state).toBe('queued');
    await runAdmissionRecoveries(scope, d, db.sql);
    expect(d.screen).toHaveBeenCalledTimes(1);
    expect(d.dispatch).toHaveBeenCalledTimes(2);
    expect((await current()).payload._admissionRecovery).toMatchObject({
      requestId: first.request.requestId, state: 'delivered', pickupConfirmed: false,
    });
    const retry = await requestAdmissionRecovery(input, { authorize }, db.sql);
    expect(retry.request.requestId).toBe(first.request.requestId);
    await runAdmissionRecoveries(scope, d, db.sql);
    expect(d.dispatch).toHaveBeenCalledTimes(3);
    expect(d.screen).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent consumers, including the delivery window', async () => {
    await requestAdmissionRecovery(input, { authorize }, db.sql);
    const d = deps();
    await Promise.all([runAdmissionRecoveries(scope, d, db.sql), runAdmissionRecoveries(scope, d, db.sql)]);
    expect(d.screen).toHaveBeenCalledTimes(1);
    expect(d.dispatch).toHaveBeenCalledTimes(1);
  });

  it('refuses changed target, cross-scope identity, remote origin, and peer holds', async () => {
    await requestAdmissionRecovery(input, { authorize }, db.sql);
    await expect(requestAdmissionRecovery({ ...input, target: 'other' }, { authorize }, db.sql)).rejects.toThrow('belongs to');
    await expect(requestAdmissionRecovery({ ...input, harnessSlug: 'elsewhere' }, { authorize }, db.sql)).rejects.toThrow('not found');
    await db.sql`UPDATE harness_shared.work_items SET origin = 'remote'`;
    await expect(requestAdmissionRecovery(input, { authorize }, db.sql)).rejects.toThrow('originating actor');
    await db.sql`UPDATE harness_shared.work_items SET origin = 'local', taken_by = 'peer'`;
    await expect(requestAdmissionRecovery(input, { authorize }, db.sql)).rejects.toThrow('held by peer');
  });

  it('an interrupted authorization read leaves the request queued for durable replay', async () => {
    await requestAdmissionRecovery(input, { authorize }, db.sql);
    authorize.mockRejectedValueOnce(new Error('policy store unavailable'));
    await expect(runAdmissionRecoveries(scope, deps(), db.sql)).rejects.toThrow('policy store unavailable');
    expect((await current()).payload._admissionRecovery.state).toBe('queued');
  });
});
