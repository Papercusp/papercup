import { mkdtemp, mkdir, writeFile, utimes, symlink, stat, rm } from 'node:fs/promises';
import { homedir, hostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readDiskAlarmContext, runDiskSpaceAlarmOnce } from './disk-space-alarm';
import { writeCensusRun } from './disk-consumer-census';
import type { AttentionNotifyInput } from '../attention-notify';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { nativeRetentionCommand, readReclaimReceipt, runDiskReclaimOnce, writeReclaimAudit, type ReclaimSql } from './disk-reclaim';
import { type RetentionClass } from './retention-policy';
import { createFreshPgDb, applyEventSubstrateMigrationsForTest, COORD_SUBSCRIPTION_SUBSTRATE } from '../../test/_pg-helpers';

const inspectionProbe = vi.hoisted(() => ({ before: undefined as ((path: string) => (() => void) | undefined) | undefined }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, lstat: async (...args: Parameters<typeof actual.lstat>) => {
    const done = inspectionProbe.before?.(String(args[0]));
    try { return await actual.lstat(...args); }
    finally { done?.(); }
  } };
});

const nativeDb = vi.hoisted(() => ({ sql: undefined as postgres.Sql | undefined }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...await original<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => {
    if (!nativeDb.sql) throw new Error('native retention fixture database is not prepared');
    return { sql: nativeDb.sql };
  },
}));
vi.mock('../workspace-registry', async (original) => ({
  ...await original<typeof import('../workspace-registry')>(), activeWorkspaceId: () => 'default',
}));
vi.mock('../task-manager/enabled', async (original) => ({
  ...await original<typeof import('../task-manager/enabled')>(), isTaskManagerEnabled: async () => true,
}));

const fixtureMutex = vi.hoisted(() => ({
  name: `disk-retention-fixture-${crypto.randomUUID()}`,
  requested: [] as string[],
}));
// Exercise the real mutex on fixture resources. Other infrastructure mutexes
// retain their original identity; the scheduled actor owns the production name.
vi.mock('../../../../scripts/lib/fs-mutex.mjs', async (original) => {
  const actual = await original<typeof import('../../../../scripts/lib/fs-mutex.mjs')>();
  return {
    ...actual,
    withFsMutex: (...args: Parameters<typeof actual.withFsMutex>) => {
      fixtureMutex.requested.push(args[0]);
      return actual.withFsMutex(args[0] === 'papercusp-disk-retention' ? fixtureMutex.name : args[0], args[1], args[2]);
    },
  };
});

let fixture: string | undefined;
afterEach(async () => { inspectionProbe.before = undefined; if (fixture) await rm(fixture, { recursive: true, force: true }); fixture = undefined; });

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
  it('runs the native cargo delegate repeatedly with captured receipts and no missed completion', async () => {
    fixture = await mkdtemp(join(tmpdir(), 'disk-retention-cargo-'));
    const shared = join(fixture, 'target');
    const dead = join(fixture, 'target-pid99999999');
    await mkdir(join(dead, 'debug'), { recursive: true });
    await writeFile(join(dead, 'debug', 'marker'), 'expired fixture');
    const old = new Date(Date.now() - 7200_000);
    await utimes(join(dead, 'debug'), old, old); await utimes(dead, old, old);
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
    // Reuse the desktop slot suite's Cargo configuration fixture: the shared
    // root resolver intentionally ignores CARGO_TARGET_DIR (an already-claimed slot).
    await mkdir(join(fixture, '.cargo'));
    await mkdir(join(fixture, 'src-tauri', 'src'), { recursive: true });
    await writeFile(join(fixture, '.cargo', 'config.toml'), `[build]\ntarget-dir = ${JSON.stringify(shared)}\n`);
    await writeFile(join(fixture, 'src-tauri', 'Cargo.toml'), '[package]\nname = "retention-native-fixture"\nversion = "0.1.0"\nedition = "2021"\n');
    await writeFile(join(fixture, 'src-tauri', 'src', 'lib.rs'), '');
    // Resolve the selected installed binary before removing HOME/settings.toml.
    // Cargo metadata must work even with an empty rustup home; the runner also
    // supplies this binary directory before the shim directory under isolation.
    const cargo = process.env.PAPERCUSP_TEST_CARGO ?? execFileSync('rustup', ['which', 'cargo'], { encoding: 'utf8', timeout: 5000 }).trim();
    expect(cargo).toMatch(/\/bin\/cargo$/);
    const args = [
      '-u', 'CARGO_BUILD_TARGET_DIR', `HOME=${fixture}`, 'CARGO_TARGET_DIR=',
      `CARGO_HOME=${join(fixture, '.cargo')}`, `RUSTUP_HOME=${join(fixture, 'empty-rustup')}`,
      `PATH=${dirname(cargo)}:${process.env.PATH ?? ''}`,
      `PAPERCUSP_DESKTOP_TARGET_ROOT=${fixture}`,
      `PAPERCUSP_RELEASE_RETENTION_ROOT=${join(fixture, 'retention')}`,
      '/bin/bash', join(repoRoot, 'papercusp-desktop/bin/reap-private-target-slots.sh'),
    ];
    const db = await createFreshPgDb('disk-retention-native');
    nativeDb.sql = db.sql;
    try {
      await applyEventSubstrateMigrationsForTest(db.sql, {
        label: 'disk-reclaim.integration.test.ts native delegate', ...COORD_SUBSCRIPTION_SUBSTRATE,
        extra: [...COORD_SUBSCRIPTION_SUBSTRATE.extra,
          '696-task-ledger.sql', '700-task-ledger-bash-job-id-idx.sql', '774-task-ledger-ended-unobserved-state.sql'],
      });
      const listed = await nativeRetentionCommand(repoRoot, '/usr/bin/env', [...args, '--dry-run']);
      expect(listed, JSON.stringify(listed)).toMatchObject({ ok: true });
      expect(listed.detail).toMatchObject({ code: 0, output: expect.stringContaining(`would reap: ${dead}`) });
      await expect(stat(dead)).resolves.toBeDefined();
      const removed = await nativeRetentionCommand(repoRoot, '/usr/bin/env', args);
      expect(removed, JSON.stringify(removed)).toMatchObject({ ok: true });
      expect(removed.detail).toMatchObject({ code: 0, output: expect.stringContaining(`reaped dead private target slot ${dead}`) });
      await expect(stat(dead)).rejects.toMatchObject({ code: 'ENOENT' });
      const repeated = await nativeRetentionCommand(repoRoot, '/usr/bin/env', args);
      expect(repeated, JSON.stringify(repeated)).toMatchObject({ ok: true });
      const { getTask } = await import('../task-manager/store');
      for (const result of [listed, removed]) {
        const id = (result.detail as { taskId: string }).taskId;
        await expect.poll(async () => (await getTask(id))?.state).toBe('exited');
        expect(await getTask(id)).toMatchObject({ exitCode: 0 });
      }
    } finally {
      await db.cleanup(); nativeDb.sql = undefined;
    }
  }, 120_000);

  it('removes expired files even without low-space samples and returns the exact path receipt', async () => {
    const { root, options } = await setup(); const path = join(root, 'old'); await writeFile(path, 'expired');
    const receipt = await runDiskReclaimOnce(options);
    expect(receipt.errors).toEqual([]);
    expect(fixtureMutex.requested.at(-1)).toBe('papercusp-disk-retention');
    expect(receipt.complete).toBe(true);
    expect(receipt.entries).toEqual([expect.objectContaining({ path, status: 'removed', classId: 'fixture' })]);
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('drains complete classes and reaches the next root when safety checks outlast the inspection budget', async () => {
    const { root, options } = await setup();
    const secondRoot = join(fixture!, 'second-root'); await mkdir(secondRoot);
    const paths = [join(root, 'old-a'), join(root, 'old-b'), join(secondRoot, 'old-c')];
    await Promise.all(paths.map((path) => writeFile(path, 'expired')));
    let clock = Date.now();
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const scanHolders = vi.fn(async () => {
      clock += 500;
      return { complete: true, byPath: new Map<string, string[]>() };
    });
    try {
      const receipt = await runDiskReclaimOnce({ ...options, budgetMs: 100,
        policy: [...options.policy, { ...options.policy[0]!, id: 'second', roots: [secondRoot] }],
        roots: [...options.roots, { path: secondRoot, classId: 'second' }],
        scanHolders, record: async () => { clock += 500; },
      });
      expect(receipt.errors).toEqual([]); expect(receipt.complete).toBe(true);
      expect(receipt.policyExhausted).toBe(true);
      expect(receipt.scan?.stoppedAtRoot).toBeNull();
      expect(receipt.entries.map((entry) => entry.path).sort()).toEqual([...paths].sort());
      expect(receipt.entries.every((entry) => entry.status === 'removed')).toBe(true);
      // One class-level scan and a fresh immediate scan for every effect.
      expect(scanHolders).toHaveBeenCalledTimes(5);
      for (const path of paths) await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { now.mockRestore(); }
  });
  it('serializes overlapping fixture passes with the real mutex and preserves the losing pass', async () => {
    const { root, options } = await setup(); const path = join(root, 'old'); await writeFile(path, 'expired');
    let signalEntered = () => {}; let releaseFirst = () => {};
    const entered = new Promise<void>(resolve => { signalEntered = resolve; });
    const release = new Promise<void>(resolve => { releaseFirst = resolve; });
    const first = runDiskReclaimOnce({ ...options, scanHolders: async () => {
      signalEntered(); await release; return { complete: true, byPath: new Map<string, string[]>() };
    } });
    try {
      await entered;
      const second = await runDiskReclaimOnce(options);
      expect(second.complete).toBe(false);
      expect(second.errors.join(' ')).toContain('Timed out after 1000ms waiting for fs-mutex');
      expect(second.entries).toEqual([]);
      expect(await stat(path)).toBeTruthy();
    } finally { releaseFirst(); }
    const receipt = await first;
    expect(receipt.errors).toEqual([]); expect(receipt.complete).toBe(true);
    expect(receipt.entries).toEqual([expect.objectContaining({ path, status: 'removed' })]);
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('bounds concurrent entry inspection while retaining the exact oldest-first effects', async () => {
    const { root, options } = await setup();
    const paths = Array.from({ length: 32 }, (_, i) => join(root, `old-${i}`));
    await Promise.all(paths.map((path) => writeFile(path, 'expired')));
    let active = 0, peak = 0;
    inspectionProbe.before = (path) => {
      if (!path.startsWith(root + '/')) return;
      peak = Math.max(peak, ++active);
      return () => { active--; };
    };
    const receipt = await runDiskReclaimOnce({ ...options, dryRun: true });
    expect(receipt.complete).toBe(true); expect(receipt.errors).toEqual([]);
    expect(peak).toBeGreaterThan(1); expect(peak).toBeLessThanOrEqual(16); expect(active).toBe(0);
    expect(receipt.entries.map((entry) => entry.path).sort()).toEqual([...paths].sort());
    expect(receipt.entries.every((entry) => entry.status === 'would-remove')).toBe(true);
    for (const path of paths) expect(await stat(path)).toBeTruthy();
  });
  it('keeps an incomplete root intact and still reclaims an independent complete root', async () => {
    const { root, options } = await setup();
    const firstPaths = Array.from({ length: 32 }, (_, i) => join(root, `old-${i}`));
    await Promise.all(firstPaths.map((path) => writeFile(path, 'expired')));
    const secondRoot = join(fixture!, 'second-root'); await mkdir(secondRoot);
    const secondPath = join(secondRoot, 'old'); await writeFile(secondPath, 'expired');
    const receipt = await runDiskReclaimOnce({ ...options, maxEntries: 3,
      policy: [...options.policy, { ...options.policy[0]!, id: 'second', roots: [secondRoot] }],
      roots: [...options.roots, { path: secondRoot, classId: 'second' }],
    });
    expect(receipt.complete).toBe(false); expect(receipt.policyExhausted).toBeNull();
    expect(receipt.errors).toEqual(['incomplete tree scan: retention scan budget exhausted']);
    expect(receipt.scan?.incompleteRoots).toEqual([root]);
    expect(receipt.entries).toEqual([expect.objectContaining({ path: secondPath, status: 'removed' })]);
    await expect(stat(secondPath)).rejects.toMatchObject({ code: 'ENOENT' });
    for (const path of firstPaths) expect(await stat(path)).toBeTruthy();
  });
  it('enforces expiry when both disks already exceed the 100 GiB target (D-005)', async () => {
    const { root, options } = await setup(); const path = join(root, 'expired'); await writeFile(path, 'expired');
    const gib = 1024 ** 3;
    const receipt = await runDiskReclaimOnce({ ...options, expectedDevices: ['/', '/mnt/data'],
      sample: async () => ['/', '/mnt/data'].map((device) => ({ path: device, totalBytes: 500 * gib,
        freeBytes: 120 * gib, freePct: 0.24, totalInodes: 0, freeInodes: 0, freeInodesPct: 0 })),
    });
    expect(receipt.errors).toEqual([]); expect(receipt.complete).toBe(true);
    expect(receipt.devices.map((d) => d.atTarget)).toEqual([true, true]);
    expect(receipt.entries).toEqual([expect.objectContaining({ path, status: 'removed' })]);
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
  it('retains a fresh large tree without spending the candidate budget on its descendants', async () => {
    const { root, options } = await setup();
    const parent = join(root, 'fresh'); await mkdir(parent);
    await Promise.all(Array.from({ length: 64 }, (_, i) => writeFile(join(parent, `child-${i}`), 'keep')));
    await utimes(parent, new Date(options.nowMs), new Date(options.nowMs));
    const receipt = await runDiskReclaimOnce({ ...options, maxEntries: 2 });
    expect(receipt.complete).toBe(true); expect(receipt.errors).toEqual([]);
    expect(receipt.entries).toEqual([]); expect(await stat(join(parent, 'child-0'))).toBeTruthy();
  });
  it('completes the retain census when recent direct entries outnumber the deep-scan budget', async () => {
    const { root, options } = await setup();
    await Promise.all(Array.from({ length: 32 }, (_, i) => writeFile(join(root, `recent-${i}`), 'keep')));
    const receipt = await runDiskReclaimOnce({ ...options, nowMs: Date.now(), maxEntries: 2 });
    expect(receipt.complete).toBe(true); expect(receipt.errors).toEqual([]);
    expect(receipt.entries).toEqual([]);
    expect(receipt.scan).toEqual({ inspectedNodes: 0, retainedRecentTrees: 32, stoppedAtRoot: null, incompleteRoots: [] });
    expect(await stat(join(root, 'recent-31'))).toBeTruthy();
  });
  it('keeps the complete newest-write inspection bound for count retention', async () => {
    const { root, options } = await setup();
    await Promise.all(Array.from({ length: 32 }, (_, i) => writeFile(join(root, `recent-${i}`), 'keep')));
    const policy: RetentionClass[] = [{ ...options.policy[0]!, keep: { kind: 'newest', keep: 1 } }];
    const receipt = await runDiskReclaimOnce({ ...options, policy, nowMs: Date.now(), maxEntries: 2 });
    expect(receipt.complete).toBe(false); expect(receipt.policyExhausted).toBeNull();
    expect(receipt.entries).toEqual([]);
    expect(receipt.scan).toEqual({ inspectedNodes: 2, retainedRecentTrees: 0, stoppedAtRoot: root, incompleteRoots: [root] });
    expect(await stat(join(root, 'recent-31'))).toBeTruthy();
  });
  it('stops at a recent descendant while preserving an otherwise stale large tree', async () => {
    const { root, options } = await setup();
    const parent = join(root, 'parent'); await mkdir(parent);
    // Reverse traversal visits this recent file before the large older subtree.
    const older = join(parent, 'a-older'); await mkdir(older);
    await Promise.all(Array.from({ length: 64 }, (_, i) => writeFile(join(older, `child-${i}`), 'keep')));
    const recent = join(parent, 'z-recent'); await writeFile(recent, 'keep');
    await utimes(recent, new Date(options.nowMs), new Date(options.nowMs));
    const receipt = await runDiskReclaimOnce({ ...options, maxEntries: 3 });
    expect(receipt.complete).toBe(true); expect(receipt.errors).toEqual([]);
    expect(receipt.entries).toEqual([]); expect(await stat(join(older, 'child-0'))).toBeTruthy();
  });
  it('still refuses an expired large tree when its complete scan exceeds the same budget', async () => {
    const { root, options } = await setup();
    const parent = join(root, 'expired'); await mkdir(parent);
    await Promise.all(Array.from({ length: 64 }, (_, i) => writeFile(join(parent, `child-${i}`), 'keep')));
    const receipt = await runDiskReclaimOnce({ ...options, maxEntries: 3 });
    expect(receipt.complete).toBe(false); expect(receipt.policyExhausted).toBeNull();
    expect(receipt.errors).toEqual(['incomplete tree scan: retention scan budget exhausted']);
    expect(receipt.entries).toEqual([]); expect(await stat(join(parent, 'child-0'))).toBeTruthy();
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
  it.each([{ maxEntries: 1 }, { budgetMs: 0 }])('stops an exhausted scan with bounded evidence and keeps the partial class (%j)', async (bound) => {
    const { root, options } = await setup();
    const paths = Array.from({ length: 32 }, (_, i) => join(root, `expired-${i}`));
    await Promise.all(paths.map((path) => writeFile(path, 'expired')));
    const delegate = vi.fn(async () => ({ ok: true, detail: 'independent owner completed' }));
    const receipt = await runDiskReclaimOnce({ ...options, ...bound,
      delegates: [{ classId: 'independent-owner', run: delegate }],
    });
    expect(receipt.complete).toBe(false); expect(receipt.policyExhausted).toBeNull();
    expect(receipt.errors).toEqual(['incomplete tree scan: retention scan budget exhausted']);
    expect(receipt.entries).toEqual([]);
    expect(delegate).toHaveBeenCalledOnce();
    expect(receipt.delegates).toEqual([{ classId: 'independent-owner', ok: true, detail: 'independent owner completed' }]);
    for (const path of paths) expect(await stat(path)).toBeTruthy();
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
      // The production alarm context reads both device censuses and the same
      // receipt the owner follows; no fixture object replaces this PG join.
      await sql.unsafe(await readFile(new URL('../../../../libs/papercusp/libs/db/sql/1472-disk-consumer-census.sql', import.meta.url), 'utf8'));
      const at = new Date(); const gib = 1024 ** 3;
      for (const [device, consumer] of [['/', '/home/builduser'], ['/mnt/data', '/mnt/data/offload']]) {
        await writeCensusRun(sql as never, { runId: crypto.randomUUID(), host: hostname(),
          device: { device: device!, majorMinor: '0:0', sizeBytes: 500 * gib, usedBytes: 401 * gib, availBytes: 99 * gib },
          startedAt: at, finishedAt: at, attributedBytes: 401 * gib, complete: true, note: null,
          consumers: [{ consumer: consumer!, kind: 'dir', depth: 2, bytes: 401 * gib }],
        });
      }
      const context = await readDiskAlarmContext(sql, 'fixture-workspace');
      expect(context.receipt).toEqual(receipt);
      const notifications: AttentionNotifyInput[] = [];
      const alarm = await runDiskSpaceAlarmOnce({
        readContext: () => readDiskAlarmContext(sql, 'fixture-workspace'),
        sample: async () => [{ path: '/', totalBytes: 500 * gib, freeBytes: 99 * gib, freePct: 0.198, totalInodes: 0, freeInodes: 0, freeInodesPct: 0 }],
        emitToast: async () => {}, attributeUsage: async () => ({ entries: [], truncated: false }),
        escalate: async (input) => { notifications.push(input); }, recentlyEscalated: async () => false,
        broadcast: async () => true,
      });
      expect(alarm.escalated).toBe(true);
      expect(notifications).toHaveLength(1);
      for (const expected of ['/home/builduser', '/mnt/data/offload', `/settings/storage?reclaim=${receipt.id}`]) expect(notifications[0]!.body).toContain(expected);
      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await sql.end({ timeout: 5 });
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); await admin.end({ timeout: 5 });
    }
  }, 120_000);
});
