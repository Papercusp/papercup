import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { insertHiveIfAbsent } from '../hive-store';
import { getOwnerSteering, setOwnerSteering } from '../owner-steering';
import { registerLearningLoop, recordLearningSpend } from '../learning-governor/store';
import { dreamRegistrationInput } from './dream-governor';
import { beginDreamRun, finalizeDreamRun } from './dream-run-store';
import { readDreamControlSnapshot, readDreamRoutineControls, setDreamControl } from './dream-control';

const workspaceId = 'ws-dream-controls';
const scope = { workspaceId, potSlug: 'dream-control-pot-a' };
const read = (sql: Sql, selected: typeof scope) => readDreamControlSnapshot(sql, selected, {
  flags: async () => ({ feature: true, governor: true }), sourceAvailable: async () => true,
});
describe('Dream controls persist atomically in real PostgreSQL', () => {
  let db: OrgTestDb;
  beforeAll(async () => {
    db = await createOrgTestDb();
    for (const [index, potSlug] of [scope.potSlug, 'dream-control-pot-b'].entries()) {
      await insertHiveIfAbsent({ workspaceId, homeSlug: potSlug, pubkeyBase64: Buffer.alloc(32, index + 73).toString('base64'), keychainId: 'test' }, db.adminSql);
    }
  }, 180_000);
  afterAll(async () => { await db?.cleanup(); });
  beforeEach(async () => {
    await db.adminSql`DELETE FROM harness_shared.routines WHERE workspace_id = ${workspaceId}`;
    await db.adminSql`DELETE FROM harness_shared.pot_settings WHERE workspace_id = ${workspaceId}`;
    await db.adminSql`DELETE FROM harness_shared.dream_runs WHERE workspace_id = ${workspaceId}`;
    await db.adminSql`DELETE FROM harness_shared.learning_spend_events WHERE workspace_id = ${workspaceId}`;
    for (const potSlug of [scope.potSlug, 'dream-control-pot-b']) {
      await registerLearningLoop(db.adminSql, dreamRegistrationInput({ workspaceId, potSlug }));
      for (const mode of ['manual', 'auto']) {
        await db.adminSql`
          INSERT INTO harness_shared.routines (id, workspace_id, install_slug, name, trigger_kind, trigger_config, target_role, payload_template, concurrency, catchup, active, next_fire_at)
          VALUES (${`${potSlug}-${mode}`}, ${workspaceId}, ${potSlug}, ${`dream-cycle-${mode}`}, 'cron', '{"cron":"0 */5 * * * *"}', 'system:dream-cycle', ${JSON.stringify({ mode })}::jsonb, 'skip', 'skip-old', false, now() + interval '1 day')`;
      }
    }
  });

  it('opening controls writes no setting and never opts into automatic spending', async () => {
    const first = await read(db.adminSql, scope);
    const second = await read(db.adminSql, scope);
    expect(first).toEqual(second);
    expect(first.automatic.enabled).toBe(false);
    expect(first.manual.active).toBe(false);
    expect(await db.adminSql`SELECT * FROM harness_shared.pot_settings WHERE workspace_id = ${workspaceId}`).toHaveLength(0);
  });

  it('starts immediately, pauses and resumes only the selected manual routine while preserving charges', async () => {
    await beginDreamRun(db.adminSql, { ...scope, runId: 'prior', cycleId: 'prior-cycle', mode: 'manual' });
    await finalizeDreamRun(db.adminSql, { workspaceId, runId: 'prior', status: 'error', error: 'reviewer unavailable', dreamUsage: { model: 'test', inputTokens: 1, outputTokens: 1, costUsd: 0.1 } });
    for (const enabled of [true, false, true]) {
      await setDreamControl(db.adminSql, { ...scope, mode: 'manual', enabled, actor: 'test-owner' }, read);
      const state = await read(db.adminSql, scope);
      expect(state.manual.active).toBe(enabled);
      expect(state.automatic.enabled).toBe(false);
      expect(state.lastCycle).toMatchObject({ cycleId: 'prior-cycle', attempts: 1, costUsd: 0.1 });
      if (enabled) expect(Date.parse(state.manual.nextFireAt!)).toBeLessThanOrEqual(Date.now());
    }
    expect((await readDreamRoutineControls(db.adminSql, { workspaceId, potSlug: 'dream-control-pot-b' })).every((row) => !row.active)).toBe(true);
    expect((await getOwnerSteering(workspaceId, scope.potSlug, db.adminSql)).idleActivities).toBeNull();
  });

  it('starts with persisted raised manual limits and refuses auto at its own lower cap', async () => {
    await db.adminSql`UPDATE harness_shared.routines
      SET payload_template = '{"mode":"manual","cycle":{"maxCostUsd":10,"rolling24hCostUsd":200}}'::jsonb
      WHERE workspace_id = ${workspaceId} AND install_slug = ${scope.potSlug} AND name = 'dream-cycle-manual'`;
    await recordLearningSpend(db.adminSql, { workspaceId, loopId: `dream:${scope.potSlug}`, potSlug: scope.potSlug, costUsd: 6 });
    const snapshot = await read(db.adminSql, scope);
    expect(snapshot).toMatchObject({ limits: { cycleUsd: 10, rollingUsd: 200 }, blocker: null });
    await setDreamControl(db.adminSql, { ...scope, mode: 'manual', enabled: true, actor: 'test' }, read);
    await expect(setDreamControl(db.adminSql, { ...scope, mode: 'auto', enabled: true, actor: 'test' }, read)).rejects.toThrow('24 hours');
    expect((await read(db.adminSql, scope)).manual.active).toBe(true);
    expect((await read(db.adminSql, scope)).automatic.enabled).toBe(false);
  });

  it('changes the explicit auto setting and its routine together, preserving other owner controls', async () => {
    await setOwnerSteering(workspaceId, scope.potSlug, { idleActivities: { gym: false, scout: false } }, db.adminSql);
    for (const enabled of [true, false]) {
      await setDreamControl(db.adminSql, { ...scope, mode: 'auto', enabled, actor: 'test-owner' }, read);
      expect((await read(db.adminSql, scope)).automatic.enabled).toBe(enabled);
      expect((await getOwnerSteering(workspaceId, scope.potSlug, db.adminSql)).idleActivities).toEqual({ gym: false, scout: false, dream: enabled });
      expect((await read(db.adminSql, scope)).manual.active).toBe(false);
    }
  });

  it('refuses an incompatible routine without leaving a partial auto opt-in', async () => {
    await db.adminSql`UPDATE harness_shared.routines SET payload_template = '{"mode":"manual"}' WHERE workspace_id = ${workspaceId} AND install_slug = ${scope.potSlug} AND name = 'dream-cycle-auto'`;
    await expect(setDreamControl(db.adminSql, { ...scope, mode: 'auto', enabled: true, actor: 'test' }, read)).rejects.toThrow('incompatible');
    expect((await getOwnerSteering(workspaceId, scope.potSlug, db.adminSql)).idleActivities).toBeNull();
    expect((await readDreamRoutineControls(db.adminSql, scope)).every((row) => !row.active)).toBe(true);
  });

  it('refuses a spent-out workspace but still permits Pause without a readable preflight', async () => {
    await recordLearningSpend(db.adminSql, { workspaceId, loopId: `dream:${scope.potSlug}`, potSlug: scope.potSlug, costUsd: 5 });
    await expect(setDreamControl(db.adminSql, { ...scope, mode: 'manual', enabled: true, actor: 'test' }, read)).rejects.toThrow('24 hours');
    await db.adminSql`UPDATE harness_shared.routines SET active = true WHERE workspace_id = ${workspaceId} AND install_slug = ${scope.potSlug} AND name = 'dream-cycle-manual'`;
    await setDreamControl(db.adminSql, { ...scope, mode: 'manual', enabled: false, actor: 'test' }, async () => { throw new Error('must not preflight a pause'); });
    expect((await readDreamRoutineControls(db.adminSql, scope)).every((row) => !row.active)).toBe(true);
  });

  it('rolls back the owner opt-in if the routine write fails afterward', async () => {
    await db.adminSql.unsafe("ALTER TABLE harness_shared.routines ADD CONSTRAINT dream_control_test_fault CHECK (name <> 'dream-cycle-auto' OR NOT active)");
    try {
      await expect(setDreamControl(db.adminSql, { ...scope, mode: 'auto', enabled: true, actor: 'test' }, read)).rejects.toThrow('dream_control_test_fault');
      expect((await getOwnerSteering(workspaceId, scope.potSlug, db.adminSql)).idleActivities).toBeNull();
      expect((await readDreamRoutineControls(db.adminSql, scope)).every((row) => !row.active)).toBe(true);
    } finally {
      await db.adminSql.unsafe('ALTER TABLE harness_shared.routines DROP CONSTRAINT dream_control_test_fault');
    }
  });

  it('never resolves a pot from a different workspace', async () => {
    await expect(setDreamControl(db.adminSql, { ...scope, workspaceId: 'foreign-workspace', mode: 'manual', enabled: false, actor: 'test' }, read)).rejects.toThrow('routine is missing');
    expect((await readDreamRoutineControls(db.adminSql, scope)).every((row) => !row.active)).toBe(true);
  });
});
