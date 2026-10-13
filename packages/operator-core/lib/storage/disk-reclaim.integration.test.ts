import { mkdtemp, mkdir, writeFile, utimes, symlink, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { readReclaimReceipt, runDiskReclaimOnce, writeReclaimAudit, type ReclaimSql } from './disk-reclaim';
import { type RetentionClass } from './retention-policy';

let fixture: string | undefined;
afterEach(async () => { if (fixture) await rm(fixture, { recursive: true, force: true }); fixture = undefined; });

async function setup() {
  fixture = await mkdtemp(join(tmpdir(), 'disk-retention-'));
  const root = join(fixture, 'scratch'); await mkdir(root);
  const policy: RetentionClass[] = [{ id: 'fixture', title: 'fixture', origin: 'agent', roots: [root], keep: { kind: 'max-age', maxAgeHours: 24 }, enforcers: [{ kind: 'standing-reclaim' }] }];
  // Synthetic now also ages ctime; real stale trees must have both mtime AND ctime old.
  const nowMs = Date.now() + 48 * 3_600_000;
  const options = { policy, roots: [{ path: root, classId: 'fixture' }], nowMs, registeredWorkspaces: () => [], expectedDevices: [], sample: async () => [], scanHolders: async () => ({ complete: true, byPath: new Map<string, string[]>() }) };
  return { root, options };
}

describe('retention on a real fixture tree', () => {
  it('removes expired files even without low-space samples and returns the exact path receipt', async () => {
    const { root, options } = await setup(); const path = join(root, 'old'); await writeFile(path, 'expired');
    const receipt = await runDiskReclaimOnce(options);
    expect(receipt.complete).toBe(true);
    expect(receipt.entries).toEqual([expect.objectContaining({ path, status: 'removed', classId: 'fixture' })]);
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('protects a stale parent with a recently written descendant', async () => {
    const { root, options } = await setup(); const parent = join(root, 'parent'); await mkdir(parent);
    const child = join(parent, 'recent'); await writeFile(child, 'new');
    const future = new Date(options.nowMs); await utimes(child, future, future);
    await utimes(parent, new Date(0), new Date(0));
    const receipt = await runDiskReclaimOnce(options);
    expect(receipt.entries).toEqual([]); expect(await stat(child)).toBeTruthy();
  });
  it('never follows a symlink into owner data', async () => {
    const { root, options } = await setup(); const owner = join(fixture!, 'owner'); await mkdir(owner); await writeFile(join(owner, 'data'), 'keep');
    await symlink(owner, join(root, 'link'));
    const receipt = await runDiskReclaimOnce(options);
    expect(receipt.complete).toBe(false); expect(await stat(join(owner, 'data'))).toBeTruthy();
  });
  it('refuses deletion when process evidence is incomplete or a process holds the file', async () => {
    const { root, options } = await setup(); const path = join(root, 'old'); await writeFile(path, 'keep');
    const unavailable = await runDiskReclaimOnce({ ...options, scanHolders: async () => ({ complete: false, byPath: new Map() }) });
    expect(unavailable.complete).toBe(false); expect(await stat(path)).toBeTruthy();
    const held = await runDiskReclaimOnce({ ...options, scanHolders: async () => ({ complete: true, byPath: new Map([[path, ['123']]]) }) });
    expect(held.entries[0]?.status).toBe('protected'); expect(await stat(path)).toBeTruthy();
  });
  it('reports bounded scans as incomplete instead of claiming there are no eligible artifacts', async () => {
    const { root, options } = await setup(); const path = join(root, 'old'); await writeFile(path, 'keep');
    const receipt = await runDiskReclaimOnce({ ...options, maxEntries: 0 });
    expect(receipt.complete).toBe(false); expect(receipt.errors.join(' ')).toContain('incomplete tree scan'); expect(await stat(path)).toBeTruthy();
  });
  it('dry-run gives a deletion plan while preserving the selected file', async () => {
    const { root, options } = await setup(); const path = join(root, 'old'); await writeFile(path, 'keep');
    const receipt = await runDiskReclaimOnce({ ...options, dryRun: true });
    expect(receipt.entries[0]?.status).toBe('would-remove'); expect(await stat(path)).toBeTruthy();
  });
  it('reports missing required device evidence, never a completed empty receipt', async () => {
    const { options } = await setup();
    const receipt = await runDiskReclaimOnce({ ...options, expectedDevices: ['/', '/mnt/data'] });
    expect(receipt.complete).toBe(false); expect(receipt.policyExhausted).toBeNull();
    expect(receipt.devices.map((d) => d.atTarget)).toEqual([null, null]);
  });
  it('attributes bind-mount aliases to the same free-space measurement', async () => {
    const { options } = await setup();
    const receipt = await runDiskReclaimOnce({ ...options, expectedDevices: ['/', '/mnt/data'], sample: async () => [{ path: '/', aliases: ['/mnt/data'], totalBytes: 300 * 1024 ** 3, freeBytes: 120 * 1024 ** 3, freePct: 0.4, totalInodes: 0, freeInodes: 0, freeInodesPct: 0 }] });
    expect(receipt.complete).toBe(true); expect(receipt.devices.map((d) => d.atTarget)).toEqual([true, true]);
    expect(receipt.policyExhausted).toBe(true);
  });
  it('refuses effects when the durable audit cannot record the intent', async () => {
    const { root, options } = await setup(); const path = join(root, 'old'); await writeFile(path, 'keep');
    const receipt = await runDiskReclaimOnce({ ...options, record: async (phase) => { if (phase === 'remove-intent') throw new Error('audit offline'); } });
    expect(receipt.complete).toBe(false); expect(await stat(path)).toBeTruthy();
    expect(receipt.entries[0]?.reason).toContain('audit offline');
  });
  it('persists start, exact removal intent, removed path and final receipt in real Postgres', async () => {
    const adminUri = await getTestPg();
    const name = 'reclaim_' + randomBytes(5).toString('hex');
    const admin = postgres(adminUri, { max: 1 });
    await admin.unsafe(`CREATE DATABASE "${name}"`); await markManagedTestDatabase(admin, name);
    const url = new URL(adminUri); url.pathname = '/' + name;
    const sql = postgres(url.toString(), { max: 1 });
    try {
      await sql.unsafe('CREATE SCHEMA harness_shared; CREATE TABLE harness_shared.audit_log (id text PRIMARY KEY, ts bigint, actor text, action text, subject text, details jsonb, workspace_id text)');
      const { root, options } = await setup(); const path = join(root, 'old'); await writeFile(path, 'expired');
      let runId = '';
      const receipt = await runDiskReclaimOnce({ ...options, record: async (phase, detail) => {
        if (phase === 'started') runId = (detail as { id: string }).id;
        await writeReclaimAudit(sql as unknown as ReclaimSql, 'fixture-workspace', runId, phase, detail);
      } });
      const rows = await sql`SELECT action, details, jsonb_typeof(details) AS detail_type FROM harness_shared.audit_log WHERE subject = ${receipt.id} ORDER BY ts`;
      expect(rows.map((r) => r.action)).toEqual(['disk-retention:started', 'disk-retention:remove-intent', 'disk-retention:removed', 'disk-retention:receipt']);
      expect(rows.map((r) => r.detail_type)).toEqual(['object', 'object', 'object', 'object']);
      expect(rows[1]!.details.path).toBe(path); expect(rows[3]!.details).toEqual(receipt);
      expect(await readReclaimReceipt(sql, 'fixture-workspace')).toEqual(receipt);
      expect(await readReclaimReceipt(sql, 'fixture-workspace', receipt.id)).toEqual(receipt);
      expect(await readReclaimReceipt(sql, 'other-workspace', receipt.id)).toBeNull();
      expect(await readReclaimReceipt(sql, 'fixture-workspace', 'missing')).toBeNull();
      const dry = { ...receipt, id: 'dry-receipt', dryRun: true };
      await writeReclaimAudit(sql, 'fixture-workspace', dry.id, 'receipt', dry);
      expect(await readReclaimReceipt(sql, 'fixture-workspace')).toEqual(receipt);
      expect(await readReclaimReceipt(sql, 'fixture-workspace', dry.id)).toEqual(dry);
      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await sql.end({ timeout: 5 });
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); await admin.end({ timeout: 5 });
    }
  }, 120_000);
});
