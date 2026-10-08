/**
 * runtime-vintage — the CURRENT build-identity ledger every runtime self-reports
 * at boot (fleet-reliability-verification-2026-07-10 P-008; mig 542).
 *
 * Exercised on InMemoryRuntimeVintageStore (the same store tests inject via
 * configureRuntimeVintageStore — mirrors read-cursors.test.ts's injection
 * contract). The Pg store's upsert is exercised live by an actual boot report,
 * not here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { hostname, tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { readProcessIdentity } from './process-identity';
import {
  InMemoryRuntimeVintageStore,
  configureRuntimeVintageStore,
  resetRuntimeVintageStore,
  reportRuntimeVintage,
  listRuntimeVintage,
  measureRuntimeVintageEnvironment,
  type RuntimeVintageRow,
} from './runtime-vintage';

describe('runtime-vintage — self-report ledger (P-008)', () => {
  beforeEach(() => configureRuntimeVintageStore(new InMemoryRuntimeVintageStore()));
  afterEach(() => resetRuntimeVintageStore());

  it('reports a new (workspace, unit, host) row and lists it back', async () => {
    await reportRuntimeVintage({
      unit: 'dev-api',
      host: 'tower',
      treeSha: 'abc1234',
      bundleVersion: '1.2.3',
      pid: 4242,
      workspaceId: 'default',
    });
    const rows = await listRuntimeVintage('default');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspaceId: 'default',
      unit: 'dev-api',
      host: 'tower',
      treeSha: 'abc1234',
      bundleVersion: '1.2.3',
      pid: 4242,
    });
    expect(rows[0].reportedAt).toBeTruthy();
  });

  it('upserts on a repeat report for the SAME (workspace, unit, host) — one row, latest wins', async () => {
    await reportRuntimeVintage({ unit: 'gateway', host: 'tower', treeSha: 'sha-old', workspaceId: 'default' });
    await reportRuntimeVintage({ unit: 'gateway', host: 'tower', treeSha: 'sha-new', workspaceId: 'default' });
    const rows = await listRuntimeVintage('default');
    expect(rows).toHaveLength(1);
    expect(rows[0].treeSha).toBe('sha-new');
  });

  it('keeps distinct rows per host for the same unit (fleet of Mac/Windows/tower bundles)', async () => {
    await reportRuntimeVintage({ unit: 'desktop-sidecar', host: 'mac-01', treeSha: 'sha-mac', workspaceId: 'default' });
    await reportRuntimeVintage({ unit: 'desktop-sidecar', host: 'win-01', treeSha: 'sha-win', workspaceId: 'default' });
    const rows = await listRuntimeVintage('default');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.host).sort()).toEqual(['mac-01', 'win-01']);
  });

  it('isolates rows per workspace', async () => {
    await reportRuntimeVintage({ unit: 'dev-api', host: 'tower', treeSha: 'sha-a', workspaceId: 'ws-a' });
    await reportRuntimeVintage({ unit: 'dev-api', host: 'tower', treeSha: 'sha-b', workspaceId: 'ws-b' });
    expect(await listRuntimeVintage('ws-a')).toHaveLength(1);
    expect(await listRuntimeVintage('ws-b')).toHaveLength(1);
    expect((await listRuntimeVintage('ws-a'))[0].treeSha).toBe('sha-a');
  });
  it('selects only named units and preserves workspace isolation', async () => {
    await reportRuntimeVintage({ unit: 'own-test', host: 'tower', treeSha: 'aaaaaaa', workspaceId: 'ws-a' });
    await reportRuntimeVintage({ unit: 'other-test', host: 'tower', treeSha: 'bbbbbbb', workspaceId: 'ws-a' });
    await reportRuntimeVintage({ unit: 'own-test', host: 'tower', treeSha: 'ccccccc', workspaceId: 'ws-b' });
    expect(await listRuntimeVintage('ws-a', undefined, ['own-test']))
      .toEqual([expect.objectContaining({ unit: 'own-test', treeSha: 'aaaaaaa', workspaceId: 'ws-a' })]);
    expect(await listRuntimeVintage('ws-a', undefined, [])).toEqual([]);
    expect(await listRuntimeVintage('ws-a', undefined, ['missing'])).toEqual([]);
  });

  it('defaults host to os.hostname() when omitted', async () => {
    await reportRuntimeVintage({ unit: 'bg-host', treeSha: 'sha-x', workspaceId: 'default' });
    const rows = await listRuntimeVintage('default');
    expect(rows).toHaveLength(1);
    expect(rows[0].host).toBeTruthy();
  });

  it('sorts listed rows by unit then host', async () => {
    await reportRuntimeVintage({ unit: 'gateway', host: 'b-host', treeSha: 's1', workspaceId: 'default' });
    await reportRuntimeVintage({ unit: 'bg-host', host: 'a-host', treeSha: 's2', workspaceId: 'default' });
    await reportRuntimeVintage({ unit: 'bg-host', host: 'z-host', treeSha: 's3', workspaceId: 'default' });
    const rows = await listRuntimeVintage('default');
    expect(rows.map((r) => `${r.unit}:${r.host}`)).toEqual(['bg-host:a-host', 'bg-host:z-host', 'gateway:b-host']);
  });

  it('pins its own process from the kernel and strips caller-authored pins', async () => {
    await reportRuntimeVintage({ unit: 'self', pid: process.pid, treeSha: 'a'.repeat(40), workspaceId: 'default',
      extra: { kernelProcessIdentity: 'invented' } });
    const rows = await listRuntimeVintage('default');
    const identity = readProcessIdentity(process.pid);
    if (identity) {
      expect(rows[0].extra.kernelProcessIdentity).toBe(identity);
      expect(measureRuntimeVintageEnvironment(rows, ['self'])).toMatch(/^[a-f0-9]{64}$/);
    } else {
      expect(rows[0].extra).not.toHaveProperty('kernelProcessIdentity');
      expect(measureRuntimeVintageEnvironment(rows, ['self'])).toBeNull();
    }
    await reportRuntimeVintage({ unit: 'remote', host: `${hostname()}-remote`, pid: process.pid,
      workspaceId: 'default', extra: { kernelProcessIdentity: 'invented' } });
    expect((await listRuntimeVintage('default')).find(row => row.unit === 'remote')!.extra)
      .not.toHaveProperty('kernelProcessIdentity');
  });

  const pinnedRow = (unit = 'bg-host'): RuntimeVintageRow => ({
    workspaceId: 'default', unit, host: 'local', treeSha: 'a'.repeat(40), buildTime: '2026-10-07T00:00:00Z',
    bundleVersion: null, pid: 42, extra: { kernelProcessIdentity: 'boot:start' }, reportedAt: 'now',
  });

  it('refuses missing, dead, reused, remote and legacy runtime identities', () => {
    const deps = { host: 'local', identity: () => 'boot:start' };
    const row = pinnedRow();
    expect(measureRuntimeVintageEnvironment([row], ['bg-host'], deps)).toMatch(/^[a-f0-9]{64}$/);
    for (const rows of [[], [{ ...row, host: 'remote' }], [{ ...row, extra: {} }],
      [{ ...row, treeSha: null }], [{ ...row, treeSha: 'unknown' }], [row, row]]) {
      expect(measureRuntimeVintageEnvironment(rows, ['bg-host'], deps)).toBeNull();
    }
    expect(measureRuntimeVintageEnvironment([row], ['bg-host'], { ...deps, identity: () => null })).toBeNull();
    expect(measureRuntimeVintageEnvironment([row], ['bg-host'], { ...deps, identity: () => 'boot:reused' })).toBeNull();
    expect(measureRuntimeVintageEnvironment([row], [], deps)).toBeNull();
    expect(measureRuntimeVintageEnvironment([row], ['bg-host', 'bg-host'], deps)).toBeNull();
  });

  it('fingerprints all selected runtime identities independently of row order or heartbeat', () => {
    const rows = [pinnedRow(), pinnedRow('desktop')];
    const deps = { host: 'local', identity: () => 'boot:start' };
    const original = measureRuntimeVintageEnvironment(rows, ['desktop', 'bg-host'], deps);
    expect(measureRuntimeVintageEnvironment([...rows].reverse().map(row => ({ ...row, reportedAt: 'later' })),
      ['bg-host', 'desktop'], deps)).toBe(original);
    expect(measureRuntimeVintageEnvironment([{ ...rows[0], treeSha: 'b'.repeat(40) }, rows[1]],
      ['desktop', 'bg-host'], deps)).not.toBe(original);
  });

  it('hashes equivalent PG boot timestamps identically while retaining actual boot changes', () => {
    const deps = { host: 'local', identity: () => 'boot:start' };
    const fingerprint = (buildTime: string | null) => measureRuntimeVintageEnvironment(
      [{ ...pinnedRow(), buildTime }], ['bg-host'], deps);
    const iso = fingerprint('2026-10-07T15:41:11.125Z');
    expect(iso).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint('2026-10-07 11:41:11.125-04')).toBe(iso);
    expect(fingerprint('2026-10-07T11:41:11.125-04:00')).toBe(iso);
    // postgres-js may return Date despite the persisted row's string type.
    expect(fingerprint(new Date('2026-10-07T15:41:11.125Z') as unknown as string)).toBe(iso);
    expect(fingerprint('2026-10-07T15:41:11.126Z')).not.toBe(iso);
    expect(fingerprint('invalid')).toBeNull();
    expect(fingerprint(null)).not.toBe(iso);
  });

  it('independently pins the loaded executable without inventing a Git revision', async () => {
    if (process.platform !== 'linux') return;
    const digest = createHash('sha256').update(readFileSync(`/proc/${process.pid}/exe`)).digest('hex');
    await reportRuntimeVintage({ unit: 'native', pid: process.pid, treeSha: null,
      bundleVersion: `executable-sha256:${digest}`, workspaceId: 'default',
      extra: { kernelExecutableDigest: 'caller-authored', kernelExecutableStat: 'caller-authored' } });
    const rows = await listRuntimeVintage('default');
    expect(rows[0].treeSha).toBeNull();
    expect(rows[0].extra.kernelExecutableDigest).toBe(digest);
    expect(rows[0].extra.kernelExecutableStat).not.toBe('caller-authored');
    expect(measureRuntimeVintageEnvironment(rows, ['native'])).toMatch(/^[a-f0-9]{64}$/);
    await reportRuntimeVintage({ unit: 'wrong', pid: process.pid, treeSha: null,
      bundleVersion: `executable-sha256:${'0'.repeat(64)}`, workspaceId: 'default',
      extra: { kernelExecutableDigest: '0'.repeat(64) } });
    const wrong = (await listRuntimeVintage('default')).filter(row => row.unit === 'wrong');
    expect(wrong[0].extra).not.toHaveProperty('kernelExecutableDigest');
    expect(measureRuntimeVintageEnvironment(wrong, ['wrong'])).toBeNull();
    await reportRuntimeVintage({ unit: 'remote-native', host: `${hostname()}-remote`, pid: process.pid,
      treeSha: null, bundleVersion: `executable-sha256:${digest}`, workspaceId: 'default',
      extra: { kernelExecutableDigest: digest } });
    expect((await listRuntimeVintage('default')).find(row => row.unit === 'remote-native')!.extra)
      .not.toHaveProperty('kernelExecutableDigest');
  });

  it('pins a real direct Node bundle and refuses a post-start rewrite of its entry', async () => {
    if (process.platform !== 'linux') return;
    const dir = await mkdtemp(join(tmpdir(), 'runtime-vintage-entry-'));
    const entry = join(dir, 'serve.cjs');
    const source = "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);";
    await writeFile(entry, source);
    await new Promise(resolve => setTimeout(resolve, 50));
    const child = spawn(process.execPath, [entry], { stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      await once(child.stdout!, 'data');
      const digest = createHash('sha256').update(source).digest('hex');
      await reportRuntimeVintage({ unit: 'node-bundle', pid: child.pid!, treeSha: null,
        bundleVersion: `node-entry-sha256:${digest}`, workspaceId: 'default',
        extra: { kernelNodeEntryDigest: 'caller-authored' } });
      const rows = await listRuntimeVintage('default');
      expect(rows[0].treeSha).toBeNull();
      expect(rows[0].extra.kernelNodeEntryDigest).toBe(digest);
      expect(measureRuntimeVintageEnvironment(rows, ['node-bundle'])).toMatch(/^[a-f0-9]{64}$/);
      await writeFile(entry, `${source}\n// changed after startup`);
      expect(measureRuntimeVintageEnvironment(rows, ['node-bundle'])).toBeNull();
      await reportRuntimeVintage({ unit: 'changed-bundle', pid: child.pid!, treeSha: null,
        bundleVersion: `node-entry-sha256:${createHash('sha256').update(readFileSync(entry)).digest('hex')}`,
        workspaceId: 'default', extra: { kernelNodeEntryDigest: digest } });
      expect((await listRuntimeVintage('default')).find(row => row.unit === 'changed-bundle')!.extra)
        .not.toHaveProperty('kernelNodeEntryDigest');
    } finally {
      child.kill('SIGTERM');
      await once(child, 'close');
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects changed executable bytes, missing digest pins and process replacement during measurement', () => {
    const digest = 'b'.repeat(64);
    const row = { ...pinnedRow('native'), treeSha: null,
      bundleVersion: `executable-sha256:${digest}`,
      extra: { kernelProcessIdentity: 'boot:start', kernelExecutableDigest: digest,
        kernelExecutableStat: 'loaded:inode:metadata' } };
    const deps = { host: 'local', identity: () => 'boot:start', executableStat: () => 'loaded:inode:metadata' };
    expect(measureRuntimeVintageEnvironment([row], ['native'], deps)).toMatch(/^[a-f0-9]{64}$/);
    expect(measureRuntimeVintageEnvironment([row], ['native'], { ...deps,
      executableStat: () => 'changed:inode:metadata' })).toBeNull();
    expect(measureRuntimeVintageEnvironment([{ ...row, extra: { kernelProcessIdentity: 'boot:start' } }],
      ['native'], deps)).toBeNull();
    let reads = 0;
    expect(measureRuntimeVintageEnvironment([row], ['native'], { ...deps,
      identity: () => ++reads === 1 ? 'boot:start' : 'boot:replacement' })).toBeNull();
    expect(measureRuntimeVintageEnvironment([row], ['native'], {
      host: 'local', identity: deps.identity })).toBeNull();
  });
});
