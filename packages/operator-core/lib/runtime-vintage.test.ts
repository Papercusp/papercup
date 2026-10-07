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
import { hostname } from 'node:os';
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
});
