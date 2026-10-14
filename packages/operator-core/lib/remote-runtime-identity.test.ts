/**
 * remote-runtime-identity: environment fingerprints for live evidence whose runtime is a
 * remote managed resource (WI-6554700010011907). The describe call is injected; the default
 * gcloud reader is exercised live by the cloud-portal SPEC-P-004 binding, not here.
 */
import { describe, it, expect } from 'vitest';
import { hostname } from 'node:os';
import { readProcessIdentity } from './process-identity';
import { measureRuntimeVintageEnvironment, type RuntimeVintageRow } from './runtime-vintage';
import {
  isRemoteRuntimeUnit,
  measureRemoteRuntimeIdentity,
  measureRuntimeEnvironment,
  type RemoteDescribe,
} from './remote-runtime-identity';

const UNIT = 'gcp-cloudsql:papercusp-cloud-prod/pc-cloud-prod-pg';

const instance = (over: Record<string, unknown> = {}, settings: Record<string, unknown> = {}) => ({
  name: 'pc-cloud-prod-pg',
  project: 'papercusp-cloud-prod',
  selfLink: 'https://sqladmin.googleapis.com/sql/v1beta4/projects/papercusp-cloud-prod/instances/pc-cloud-prod-pg',
  createTime: '2026-10-14T03:25:36.604Z',
  databaseVersion: 'POSTGRES_18',
  maintenanceVersion: 'POSTGRES_18_6.R20260712.01_33',
  state: 'RUNNABLE',
  settings: { settingsVersion: '8', ipConfiguration: { sslMode: 'ENCRYPTED_ONLY' }, ...settings },
  ...over,
});

const describing = (doc: unknown): RemoteDescribe & { calls: string[][] } => {
  const calls: string[][] = [];
  const fn = (async (argv: readonly string[]) => {
    calls.push([...argv]);
    return typeof doc === 'string' || doc === null ? doc : JSON.stringify(doc);
  }) as RemoteDescribe & { calls: string[][] };
  fn.calls = calls;
  return fn;
};

describe('remote runtime units', () => {
  it('recognises provider-prefixed units only', () => {
    expect(isRemoteRuntimeUnit(UNIT)).toBe(true);
    expect(isRemoteRuntimeUnit('bg-host')).toBe(false);
    expect(isRemoteRuntimeUnit('postgres:5432')).toBe(false);
    expect(isRemoteRuntimeUnit('cloudsql:papercusp-cloud-prod/pc-cloud-prod-pg')).toBe(false);
  });

  it('reads the instance through a bounded describe and returns a stable digest', async () => {
    const d = describing(instance());
    const a = await measureRemoteRuntimeIdentity(UNIT, d);
    const b = await measureRemoteRuntimeIdentity(UNIT, describing(instance()));
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(b).toBe(a);
    expect(d.calls).toEqual([[
      'sql', 'instances', 'describe', 'pc-cloud-prod-pg', '--project=papercusp-cloud-prod', '--format=json', '--quiet',
    ]]);
  });

  it.each([
    ['a settings change (settingsVersion bump)', instance({}, { settingsVersion: '9' })],
    ['a recreated instance (new createTime)', instance({ createTime: '2026-10-15T00:00:00.000Z' })],
    ['a maintenance update (new maintenanceVersion)', instance({ maintenanceVersion: 'POSTGRES_18_7.R20260901.00_01' })],
    ['an engine upgrade (new databaseVersion)', instance({ databaseVersion: 'POSTGRES_19' })],
  ])('changes identity on %s, so bound proof goes stale', async (_name, changed) => {
    const before = await measureRemoteRuntimeIdentity(UNIT, describing(instance()));
    const after = await measureRemoteRuntimeIdentity(UNIT, describing(changed));
    expect(after).toMatch(/^[a-f0-9]{64}$/);
    expect(after).not.toBe(before);
  });

  it.each([
    ['the describe fails', null],
    ['the describe prints non-JSON', 'ERROR: (gcloud.sql.instances.describe) permission denied'],
    ['the describe prints a JSON array', '[]'],
    ['the instance is not RUNNABLE', instance({ state: 'SUSPENDED' })],
    ['the document names another instance', instance({ name: 'other-instance' })],
    ['the document names another project', instance({ project: 'other-project-1' })],
    ['settingsVersion is missing', instance({}, { settingsVersion: undefined })],
    ['createTime is missing', instance({ createTime: undefined })],
  ])('is unknown (null), never a pass, when %s', async (_name, doc) => {
    expect(await measureRemoteRuntimeIdentity(UNIT, describing(doc))).toBeNull();
  });

  it('is unknown when the describe throws', async () => {
    const throwing: RemoteDescribe = async () => { throw new Error('spawn gcloud ENOENT'); };
    expect(await measureRemoteRuntimeIdentity(UNIT, throwing)).toBeNull();
  });

  it.each([
    'gcp-cloudsql:--impersonate-service-account=x/pc',
    'gcp-cloudsql:papercusp-cloud-prod/--format=yaml',
    'gcp-cloudsql:papercusp-cloud-prod',
    'gcp-cloudsql:Papercusp-Cloud-Prod/pc-cloud-prod-pg',
    'gcp-cloudsql:papercusp-cloud-prod/pc-cloud-prod-pg/extra',
  ])('refuses malformed unit %s without calling describe', async (unit) => {
    const d = describing(instance());
    expect(await measureRemoteRuntimeIdentity(unit, d)).toBeNull();
    expect(d.calls).toEqual([]);
  });
});

describe('measureRuntimeEnvironment', () => {
  const selfIdentity = readProcessIdentity(process.pid);
  const localRow: RuntimeVintageRow = {
    workspaceId: 'ws', unit: 'self', host: hostname(), treeSha: 'a'.repeat(40), buildTime: null,
    bundleVersion: null, pid: process.pid, extra: selfIdentity ? { kernelProcessIdentity: selfIdentity } : {},
    reportedAt: new Date(0).toISOString(),
  };

  it.skipIf(!selfIdentity)('keeps the exact local-only fingerprint, so existing bindings do not go stale', async () => {
    const local = measureRuntimeVintageEnvironment([localRow], ['self']);
    expect(local).toMatch(/^[a-f0-9]{64}$/);
    const d = describing(instance());
    expect(await measureRuntimeEnvironment([localRow], ['self'], { describe: d })).toBe(local);
    expect(d.calls).toEqual([]);
  });

  it('fingerprints a remote-only unit list without any runtime-vintage row', async () => {
    const fp = await measureRuntimeEnvironment([], [UNIT], { describe: describing(instance()) });
    expect(fp).toMatch(/^[a-f0-9]{64}$/);
    expect(await measureRuntimeEnvironment([], [UNIT], { describe: describing(instance({}, { settingsVersion: '9' })) }))
      .not.toBe(fp);
  });

  it.skipIf(!selfIdentity)('folds local and remote units together and needs both', async () => {
    const both = await measureRuntimeEnvironment([localRow], ['self', UNIT], { describe: describing(instance()) });
    expect(both).toMatch(/^[a-f0-9]{64}$/);
    expect(both).not.toBe(await measureRuntimeEnvironment([], [UNIT], { describe: describing(instance()) }));
    expect(await measureRuntimeEnvironment([], ['self', UNIT], { describe: describing(instance()) })).toBeNull();
    expect(await measureRuntimeEnvironment([localRow], ['self', UNIT], { describe: describing(null) })).toBeNull();
  });

  it('rejects empty, duplicate and oversized unit lists like the local measurer', async () => {
    const d = describing(instance());
    expect(await measureRuntimeEnvironment([], [], { describe: d })).toBeNull();
    expect(await measureRuntimeEnvironment([], [UNIT, UNIT], { describe: d })).toBeNull();
    expect(await measureRuntimeEnvironment([], Array.from({ length: 33 }, (_, i) => `u${i}`), { describe: d })).toBeNull();
    expect(d.calls).toEqual([]);
  });

  it('reads each remote resource once per memo', async () => {
    const d = describing(instance());
    const memo = new Map<string, Promise<string | null>>();
    const first = await measureRuntimeEnvironment([], [UNIT], { describe: d, memo });
    const second = await measureRuntimeEnvironment([], [UNIT], { describe: d, memo });
    expect(second).toBe(first);
    expect(d.calls).toHaveLength(1);
  });
});
