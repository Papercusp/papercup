import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { maintenancePgStore } from './maintenance-pg';
import { recoverRoutineMaintenance, runRoutineMaintenance, type MaintenancePlan, type MaintenanceRecoveryAuthority } from './maintenance';
import { readRoutineSnap } from './routine-snapshot';

const workspaceId = 'ws-routine-maintenance-test';
const actor = 'su-maintenance-test';
const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const exec = promisify(execFile);
let org: OrgTestDb;
let plan: MaintenancePlan;
let runtime: Pick<MaintenanceRecoveryAuthority, 'cgroupSha256' | 'sourceSha256'>;

beforeAll(async () => {
  org = await createOrgTestDb();
  const { stdout } = await exec(process.execPath, ['--import', 'tsx',
    resolve(root, 'scripts/routine-maintenance-recover.mts'), '--check-runtime'], { cwd: root, timeout: 30_000 });
  runtime = JSON.parse(stdout.trim());
});
afterAll(async () => { await org?.cleanup(); });
beforeEach(async () => {
  await org.adminSql`DELETE FROM harness_shared.audit_log WHERE workspace_id = ${workspaceId}`;
  await org.adminSql`DELETE FROM harness_shared.routines WHERE workspace_id = ${workspaceId}`;
  for (const [slug, active] of [['papercusp', true], ['calendar', true], ['crm', true], ['papercusp/libs/generic/cache', true], ['deliberately-paused', false]] as const) {
    await org.adminSql`INSERT INTO harness_shared.routines
      (id, workspace_id, install_slug, name, trigger_kind, trigger_config, target_role, active, payload_template, metadata)
      VALUES (${randomUUID()}, ${workspaceId}, ${slug}, 'git-sync', 'cron', '{}'::jsonb, 'system:git-sync', ${active}, '{}'::jsonb, '{}'::jsonb)`;
  }
  const target = async (installSlug: string) => ({ installSlug, name: 'git-sync' as const,
    before: await readRoutineSnap(org.adminSql, workspaceId, installSlug, 'git-sync') });
  plan = { operationId: randomUUID(), ownerId: actor, workItemId: 'WI-maintenance-test', reason: 'isolated verification',
    canonical: await target('papercusp'), others: [await target('calendar'), await target('crm'), await target('papercusp/libs/generic/cache')],
    deadlineMs: Date.now() + 60_000, phaseTimeoutMs: 10_000, cleanupTimeoutMs: 10_000 };
});
const store = () => maintenancePgStore(org.adminSql, workspaceId, actor);
const snap = (slug: string) => readRoutineSnap(org.adminSql, workspaceId, slug, 'git-sync');
const recovery = (): MaintenanceRecoveryAuthority => ({ ...runtime,
  schemaVersion: 'routine-maintenance-recovery-v1', workspaceId, ownerId: actor,
  operationId: plan.operationId, timeoutMs: plan.cleanupTimeoutMs, deadlineMs: plan.deadlineMs });

describe('maintenance atomicity and recovery (real private PG)', () => {
  it('refreshes a later target changed during the pause window and restores that exact fresh state', async () => {
    const port = store(), pause = port.pause;
    port.pause = async (...args) => {
      await pause(...args);
      if (args[2] === 0) await org.adminSql`UPDATE harness_shared.routines
        SET metadata = '{"health":{"tick":88}}'::jsonb
        WHERE workspace_id = ${workspaceId} AND install_slug = 'crm'`;
    };
    const result = await runRoutineMaintenance(plan, port, { publication: async () => {}, adoption: async () => {} });
    expect(result).toMatchObject({ ok: true, cleanup: { ok: true, residue: [] } });
    expect(await snap('crm')).toMatchObject({ active: true, metadata: { health: { tick: 88 } } });
    const previews = await org.adminSql`SELECT id FROM harness_shared.audit_log
      WHERE workspace_id = ${workspaceId} AND action = 'gateway-control.routines:maintenance-preview'`;
    expect(previews).toHaveLength(4);
  });
  it('still refuses a change after the fresh per-target preview', async () => {
    const port = store();
    await port.prepare(plan);
    const target = await port.previewTarget!(plan, 0);
    await org.adminSql`UPDATE harness_shared.routines SET metadata = '{"health":"newer"}'::jsonb
      WHERE workspace_id = ${workspaceId} AND install_slug = 'calendar'`;
    await expect(port.pause(plan, target, 0)).rejects.toThrow('Stale routine preview');
    expect((await snap('calendar')).active).toBe(true);
    expect((await recoverRoutineMaintenance(port, plan.operationId, 10_000)).ok).toBe(true);
  });
  it('publishes immutable recovery on the existing intent without a file or routine effects', async () => {
    const port = store(), authority = recovery();
    await expect(port.publishRecovery(authority)).rejects.toThrow('Unknown or sealed');
    await port.prepare(plan);
    await port.publishRecovery(authority);
    await port.publishRecovery(authority);
    expect(await port.readRecovery(plan.operationId)).toEqual(authority);
    expect(await snap('calendar')).toEqual(plan.others[0]!.before);
    const rows = await org.adminSql`SELECT id FROM harness_shared.audit_log
      WHERE workspace_id = ${workspaceId} AND action = 'gateway-control.routines:maintenance-recovery'`;
    expect(rows).toHaveLength(1);
    await expect(port.publishRecovery({ ...authority, cgroupSha256: 'a'.repeat(64) })).rejects.toThrow('immutable');
  });
  it('binds recovery to the exact owner, workspace, operation and reserved cleanup bounds', async () => {
    const port = store();
    await port.prepare(plan);
    for (const patch of [
      { ownerId: 'su-another' }, { workspaceId: 'another-workspace' },
      { operationId: randomUUID() }, { deadlineMs: plan.deadlineMs + 1 },
      { timeoutMs: plan.cleanupTimeoutMs + 1 },
    ]) await expect(port.publishRecovery({ ...recovery(), ...patch })).rejects.toThrow();
    expect(await port.readRecovery(plan.operationId)).toBeUndefined();
    await port.publishRecovery(recovery());
    await expect(maintenancePgStore(org.adminSql, workspaceId, 'su-another')
      .readRecovery(plan.operationId)).rejects.toThrow('another actor');
    expect(await maintenancePgStore(org.adminSql, 'another-workspace', actor)
      .readRecovery(plan.operationId)).toBeUndefined();
    expect((await snap('calendar')).active).toBe(true);
  });
  it('refuses first publication after any pause and after the operation is sealed', async () => {
    const port = store();
    await port.prepare(plan);
    await port.pause(plan, plan.others[0]!, 0);
    await expect(port.publishRecovery(recovery())).rejects.toThrow('before pause');
    expect((await recoverRoutineMaintenance(port, plan.operationId, 10_000)).ok).toBe(true);
    await expect(port.publishRecovery(recovery())).rejects.toThrow('sealed');
  });
  it('refuses mismatched guardian source pins without sealing or changing routines', async () => {
    const port = store();
    await port.prepare(plan);
    const authority = recovery();
    await port.publishRecovery({ ...authority, sourceSha256: {
      ...authority.sourceSha256, 'scripts/routine-maintenance-recover.mts': '0'.repeat(64),
    } });
    await expect(exec(process.execPath, ['--import', 'tsx', resolve(root, 'scripts/routine-maintenance-recover.mts'),
      '--operation', plan.operationId, '--workspace', workspaceId, '--owner', actor, '--watch'], {
      cwd: root, timeout: 30_000, env: { ...process.env, PAPERCUSP_MAINTENANCE_DATABASE_URL: org.adminDsn },
    })).rejects.toMatchObject({ code: 1 });
    const seals = await org.adminSql`SELECT id FROM harness_shared.audit_log
      WHERE workspace_id = ${workspaceId} AND action = 'gateway-control.routines:maintenance-sealed'`;
    expect(seals).toHaveLength(0);
    expect(await snap('calendar')).toEqual(plan.others[0]!.before);
  });
  it('commits intent before effects, restores exact snapshots and preserves existing pauses', async () => {
    const port = store();
    await port.prepare(plan);
    expect((await snap('calendar')).active).toBe(true);
    const intent = await org.adminSql`SELECT id FROM harness_shared.audit_log
      WHERE workspace_id = ${workspaceId} AND action = 'gateway-control.routines:maintenance-intent'`;
    expect(intent).toHaveLength(1);
    await port.pause(plan, plan.others[0]!, 0);
    expect((await snap('calendar')).active).toBe(false);
    await expect(port.pause(plan, plan.others[0]!, 0)).rejects.toThrow('already committed');
    const recovered = await recoverRoutineMaintenance(store(), plan.operationId, 10_000);
    expect(recovered).toMatchObject({ ok: true, residue: [] });
    expect(await snap('calendar')).toEqual(plan.others[0]!.before);
    expect((await snap('deliberately-paused')).active).toBe(false);
    expect((await recoverRoutineMaintenance(store(), plan.operationId, 10_000)).ok).toBe(true);
  });
  it('recovers committed effects after losing the apply receipt and original in-memory store', async () => {
    const port = store();
    await port.prepare(plan);
    await port.pause(plan, plan.others[0]!, 0);
    await port.pause(plan, plan.others[1]!, 1);
    expect((await recoverRoutineMaintenance(store(), plan.operationId, 10_000)).ok).toBe(true);
    expect((await snap('calendar')).active).toBe(true);
    expect((await snap('crm')).active).toBe(true);
  });
  it('rolls the pause back if its mandatory audit cannot commit', async () => {
    const port = store();
    await port.prepare(plan);
    await org.adminSql`CREATE FUNCTION harness_shared.fail_maintenance_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action = 'gateway-control.routines:set' THEN RAISE EXCEPTION 'injected audit unavailable'; END IF; RETURN NEW; END $$`;
    await org.adminSql`CREATE TRIGGER maintenance_audit_failure BEFORE INSERT ON harness_shared.audit_log
      FOR EACH ROW EXECUTE FUNCTION harness_shared.fail_maintenance_audit()`;
    try {
      await expect(port.pause(plan, plan.others[0]!, 0)).rejects.toThrow('injected audit unavailable');
      expect(await snap('calendar')).toEqual(plan.others[0]!.before);
    } finally {
      await org.adminSql`DROP TRIGGER maintenance_audit_failure ON harness_shared.audit_log`;
      await org.adminSql`DROP FUNCTION harness_shared.fail_maintenance_audit()`;
    }
    expect((await recoverRoutineMaintenance(store(), plan.operationId, 10_000)).ok).toBe(true);
  });
  it('preserves newer peer pauses and continues cleaning other rows', async () => {
    const port = store();
    await port.prepare(plan);
    await port.pause(plan, plan.others[0]!, 0);
    await port.pause(plan, plan.others[1]!, 1);
    await org.adminSql`UPDATE harness_shared.routines SET metadata = jsonb_set(metadata, '{pause,reason}', '"peer hold"'::jsonb)
      WHERE workspace_id = ${workspaceId} AND install_slug = 'crm'`;
    const result = await recoverRoutineMaintenance(store(), plan.operationId, 10_000);
    expect(result).toMatchObject({ ok: false, residue: [{ ownerId: actor, workItemId: plan.workItemId }] });
    expect((await snap('crm')).metadata).toMatchObject({ pause: { reason: 'peer hold' } });
    expect((await snap('crm')).active).toBe(false);
    expect((await snap('calendar')).active).toBe(true);
  });
  it('preserves unrelated health metadata written after the pause', async () => {
    const port = store();
    await port.prepare(plan);
    await port.pause(plan, plan.others[0]!, 0);
    await org.adminSql`UPDATE harness_shared.routines SET metadata = metadata || '{"health":{"tick":99}}'::jsonb
      WHERE workspace_id = ${workspaceId} AND install_slug = 'calendar'`;
    expect((await recoverRoutineMaintenance(store(), plan.operationId, 10_000)).ok).toBe(true);
    expect(await snap('calendar')).toMatchObject({ active: true, metadata: { health: { tick: 99 } } });
  });
  it('seals late preparation and delayed applies instead of allowing a post-cleanup pause', async () => {
    expect((await recoverRoutineMaintenance(store(), plan.operationId, 10_000)).ok).toBe(true);
    await expect(store().prepare(plan)).rejects.toThrow('sealed');
    plan.operationId = randomUUID();
    const port = store();
    await port.prepare(plan);
    await port.seal(plan.operationId);
    await expect(port.pause(plan, plan.others[0]!, 0)).rejects.toThrow('sealed');
    expect((await snap('calendar')).active).toBe(true);
  });
  it('requires the complete current cohort and fresh per-row previews', async () => {
    const port = store();
    await expect(port.prepare({ ...plan, others: plan.others.slice(0, 1) })).rejects.toThrow('cohort changed');
    await org.adminSql`UPDATE harness_shared.routines SET metadata = '{"health":"changed"}'::jsonb
      WHERE workspace_id = ${workspaceId} AND install_slug = 'calendar'`;
    await expect(port.prepare(plan)).rejects.toThrow('Stale routine preview');
    expect((await snap('crm')).active).toBe(true);
  });
  it('uses a fresh canonical preview after publication and restores on adoption refusal', async () => {
    let adoptionCalls = 0;
    const result = await runRoutineMaintenance(plan, store(), {
      publication: async () => {
        await org.adminSql`UPDATE harness_shared.routines SET metadata = '{"gitPass":"qualified"}'::jsonb
          WHERE workspace_id = ${workspaceId} AND install_slug = 'papercusp'`;
      },
      adoption: async () => { adoptionCalls++; throw new Error('ordinary restart refused'); },
    });
    expect(result).toMatchObject({ ok: false, cleanup: { ok: true } });
    expect(adoptionCalls).toBe(1);
    expect(await snap('papercusp')).toMatchObject({ active: true, metadata: { gitPass: 'qualified' } });
  });
  it.each(['file-immediate', 'file-guardian-interruption', 'control-immediate', 'control-guardian-interruption'])('cleans up from a separate native process with no operator HTTP server: %s', async mode => {
    const control = mode.startsWith('control'), watch = mode.endsWith('interruption');
    const port = store();
    await port.prepare(plan);
    if (control) await port.publishRecovery(recovery());
    if (!(control && watch)) await port.pause(plan, plan.others[0]!, 0);
    const script = resolve(root, 'scripts/routine-maintenance-recover.mts');
    const { stdout } = await exec(process.execPath, ['--import', 'tsx', script, '--check-runtime'], { cwd: root, timeout: 30_000 });
    const runtime = JSON.parse(stdout.trim());
    const dir = await mkdtemp(join(tmpdir(), 'maintenance-recovery-test-'));
    try {
      const manifest = join(dir, 'manifest.json');
      if (!control) await writeFile(manifest, JSON.stringify({ ...runtime, schemaVersion: 'routine-maintenance-recovery-v1',
        workspaceId, ownerId: actor, operationId: plan.operationId, timeoutMs: 10_000,
        deadlineMs: Date.now() + (watch ? 60_000 : 0) }));
      const args = ['--import', 'tsx', script, ...(control
        ? ['--operation', plan.operationId, '--workspace', workspaceId, '--owner', actor]
        : ['--manifest', manifest]), ...(watch ? ['--watch'] : [])];
      const env = { ...process.env, PAPERCUSP_MAINTENANCE_DATABASE_URL: org.adminDsn };
      let output: string;
      if (!watch) {
        output = (await exec(process.execPath, args, { cwd: root, env, timeout: 45_000, maxBuffer: 128_000 })).stdout;
      } else {
        output = await new Promise<string>((done, fail) => {
          const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
          let stdout = '', stderr = '', interrupted = false;
          const timer = setTimeout(() => { child.kill('SIGKILL'); fail(new Error('Guardian did not finish within test bound')); }, 45_000);
          child.stdout.setEncoding('utf8'); // boundary-safe decode (WI-6728)
          child.stdout.on('data', bytes => {
            stdout += bytes;
            if (!interrupted && stdout.split('\n').some(line => { try { return JSON.parse(line).armed === true; } catch { return false; } })) {
              interrupted = true;
              // The control-path guardian must arm before the first pause.
              const pause = control ? port.pause(plan, plan.others[0]!, 0) : Promise.resolve();
              void pause.then(() => child.kill('SIGTERM')).catch(error => {
                clearTimeout(timer); child.kill('SIGKILL'); fail(error);
              });
            }
          });
          child.stderr.setEncoding('utf8'); child.stderr.on('data', bytes => { stderr += bytes; });
          child.on('error', error => { clearTimeout(timer); fail(error); });
          child.on('close', code => {
            clearTimeout(timer);
            if (code === 0 && interrupted) done(stdout);
            else fail(new Error(`Guardian failed (${code}): ${stderr.slice(-3000)}`));
          });
        });
        expect(output).toContain('"armed":true');
      }
      expect(JSON.parse(output.trim().split('\n').at(-1)!)).toMatchObject({ ok: true, residue: [] });
      expect((await snap('calendar')).active).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 90_000);
});
