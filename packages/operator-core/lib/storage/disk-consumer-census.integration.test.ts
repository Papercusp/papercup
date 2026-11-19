/**
 * Real-PostgreSQL + real-du coverage for the disk consumer census
 * (disk-headroom-standing-reclaim-2026-10-12 P-001, R-1; WI-6554700010008933).
 *
 * R-1: a per-consumer size census is written to Postgres and one read shows each
 * consumer's size and its 24h growth. Falsifiers covered here: a device with no
 * census rows in 24h is reported (stale / missing), and a consumer at or above the
 * floor that the census does not list fails the du comparison below.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import {
  apiStoreConsumers,
  censusOneDevice,
  diskCensusPassInFlight,
  pruneDiskCensus,
  readCompleteDiskConsumerCensus,
  readDiskConsumerCensus,
  runDiskConsumerCensusOnce,
  unattributedKey,
  writeCensusRun,
  type CensusDevice,
  type CensusFilesystemIdentity,
  type CensusDeviceView,
  type CensusSql,
} from './disk-consumer-census';
import { devToMajorMinor, type CensusConsumer } from './usage';
import { censusEndpointEnvelopeNote, readCensusEndpointEnvelope, runDetachedDuUsage, writeCensusEndpointEnvelope,
  type CensusEndpointCandidate, type CensusEndpointReceipt } from './disk-census-detached-walk';
import { detectDiskGrowthWarnings, runDiskHeadroomAlarmOnce, emitStorageGrowthToast,
  DISK_HEADROOM_OBSERVATION_ACTION, DISK_HEADROOM_EXERCISE_ACTION, diskHeadroomAlarmRuntimeIdentity,
  DISK_CENSUS_INCOMPLETE_ACTION,
  measureNativeDiskHeadroomAlarm, type DiskHeadroomObservation } from './storage-growth-alarm';

// Toast/audit persistence uses the real throwaway PG below. The host SSE sink
// resolves its own live org pool, so keep that separate outbound boundary local.
const invalidation = vi.hoisted(() => ({ notify: vi.fn(async () => {}) }));
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: invalidation.notify }));

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = resolve(HERE, '../../../../libs/papercusp/libs/db/sql/1472-disk-consumer-census.sql');
const MIGRATION = readFileSync(existsSync(MIGRATION_PATH) ? MIGRATION_PATH : `${MIGRATION_PATH}.DRAFT`, 'utf8');

const MIB = 1024 ** 2;
const G = 1024 ** 3;
const HOUR = 3600_000;

let rootSql: postgres.Sql;
let notificationSql: postgres.Sql;
let sql: CensusSql;
let fixture: string;
let endpointEvidence: string;
let censusDatabaseUri: string;

beforeEach(() => { invalidation.notify.mockClear(); });

describe('independent consecutive-incomplete episodes (real PG)', () => {
  afterEach(async () => {
    const removed = await rootSql`DELETE FROM harness_shared.audit_log WHERE workspace_id LIKE 'episode-%' RETURNING subject`;
    const subjects = removed.map(row => row.subject);
    if (subjects.length) await rootSql`DELETE FROM harness_shared.toast_log WHERE id::text = ANY(${subjects}::text[])`;
  });
  const start = new Date('2026-11-19T00:00:00Z');
  const identityFor = (host: string, mount = '/episode-device'): CensusFilesystemIdentity => ({
    version: 1, host, device: mount, bootId: '00000000-0000-4000-8000-000000000001',
    majorMinor: '0:0', rootDev: '1', rootIno: '2', rootBirthNs: '1000',
  });
  const write = async (host: string, index: number, complete: boolean, opts: {
    id?: string; mount?: string; identity?: CensusFilesystemIdentity | null; note?: string; consumers?: CensusConsumer[];
  } = {}) => {
    const runId = opts.id ?? randomUUID(), mount = opts.mount ?? '/episode-device';
    const finishedAt = new Date(start.getTime() + index * 1000);
    await writeCensusRun(sql, { runId, host, device: device({ device: mount }), startedAt: finishedAt,
      finishedAt, attributedBytes: 50 * G, complete,
      note: opts.note ?? `du walked as root${complete ? '' : '; du timed out; sizes are lower bounds'}`,
      consumers: opts.consumers ?? [dir(`${mount}/consumer`, G)],
      filesystemIdentity: opts.identity === undefined ? identityFor(host, mount) : opts.identity });
    return runId;
  };
  const read = async (host: string, client = sql) =>
    (await readDiskConsumerCensus(client, { host, now: start })).devices[0]!;

  it('certifies producer history only when filesystem identity survives the entire failed walk', async () => {
    for (const replaced of [false, true]) {
      const host = `episode-producer-${replaced}-${randomUUID()}`;
      const identity = identityFor(host);
      let inspected = 0;
      const inspectFilesystem = vi.fn(async () => ({ ...identity, rootBirthNs: replaced && inspected++ ? '2000' : '1000' }));
      const dev = device({ device: identity.device });
      const outcome = await censusOneDevice({ host, devices: [dev], stores: [], sudo: null }, dev, {
        sql, statDevice: null, inspectFilesystem, now: () => start,
        runDu: async () => ({ summary: { rootBytes: 100, consumers: [], ownFiles: [], records: 1 },
          deniedCount: 0, deniedSample: [], exitCode: 1, timedOut: false, privileged: true,
          diagnostics: { lines: 0, missingPaths: [], other: 0, overflow: false } }),
        reconcileFailures: async () => ({ status: 'unbounded', uncertainBytesUpperBound: null,
          vanishedPaths: 0, shards: [], reason: 'unclassified failed walk remains unknown' }),
      });
      expect(outcome.run).toMatchObject({ complete: false });
      expect(inspectFilesystem).toHaveBeenCalledTimes(2);
      const note = (await rootSql`SELECT note FROM harness_shared.disk_census_runs WHERE host=${host}`)[0]!.note as string;
      expect(note.includes('census-history:')).toBe(!replaced);
      expect(note).toContain('sizes are lower bounds');
      expect((await read(host)).incompleteEpisode).toMatchObject({ status: 'unknown' });
    }
  });

  it('pins episode history across consumer pages and alarm recovery, and resyncs an inserted source', async () => {
    const host = `episode-cursor-${randomUUID()}`;
    const consumers = Array.from({ length: 31 }, (_, n) => dir(`/episode-device/c${String(n).padStart(3, '0')}`, G));
    await write(host, 0, true); await write(host, 1, false); await write(host, 3, false, { consumers });
    const page = (await readDiskConsumerCensus(sql, { host, now: start, limit: 7 })).devices[0]!;
    expect(page).toMatchObject({ consumersOmitted: 24, incompleteEpisode: { status: 'open', consecutive: 2 } });
    const savedCursor = page.nextConsumerCursor!;
    const recovered = await readCompleteDiskConsumerCensus(sql, { host, now: start, limit: 7 });
    expect(recovered.devices[0]!.consumers).toHaveLength(31);
    expect(recovered.devices[0]!.incompleteEpisode).toEqual(page.incompleteEpisode);
    const emitToast = vi.fn(async () => {});
    const alarm = await runDiskHeadroomAlarmOnce({
      readDiskCensus: async () => (await readCompleteDiskConsumerCensus(sql, { host, now: start, limit: 2 })).devices,
      emitToast,
    });
    expect(alarm.censusIncomplete).toHaveLength(1);
    expect(emitToast).toHaveBeenCalledOnce();
    await write(host, 2, false);
    await expect(readDiskConsumerCensus(sql, { cursor: savedCursor })).rejects.toMatchObject({ code: 'census_restart_required' });
    expect((await read(host)).incompleteEpisode).toMatchObject({ status: 'unknown' });
  });

  it('opens once at 2, shares the episode at 3, survives restart/toast pruning and resets only on complete', async () => {
    const host = `episode-${randomUUID()}`, workspaceId = host;
    await write(host, 0, true);
    const first = await write(host, 1, false);
    expect((await read(host)).incompleteEpisode).toMatchObject({ status: 'pending', consecutive: 1, first: { runId: first }, trigger: null });
    const trigger = await write(host, 2, false);
    const opened = await read(host);
    expect(opened.incompleteEpisode).toMatchObject({ status: 'open', consecutive: 2,
      first: { runId: first, coverageIssues: ['walk-timeout'] }, trigger: { runId: trigger } });
    expect(opened.complete).toBe(false);
    expect(opened.consumers![0]!.growth24hBytes).toBeNull();
    // Separate connections contend on the actual audit PK, not a process cache.
    const concurrentSql = postgres(censusDatabaseUri, { max: 6, onnotice: () => {} });
    const options = { db: drizzle(concurrentSql) as never, workspaceId };
    const alarm = async (view: CensusDeviceView) => runDiskHeadroomAlarmOnce({ readDiskCensus: async () => [view],
      emitToast: (toast, observation) => emitStorageGrowthToast(toast, observation, options) });
    try {
      await Promise.all(Array.from({ length: 6 }, () => alarm(opened)));
      expect((await rootSql`SELECT count(*)::int n FROM harness_shared.audit_log
        WHERE workspace_id=${workspaceId} AND action=${DISK_CENSUS_INCOMPLETE_ACTION}`)[0]!.n).toBe(1);
      const saved = (await rootSql`SELECT * FROM harness_shared.audit_log WHERE workspace_id=${workspaceId}`)[0]!;
      expect(saved.details.incompleteEpisode).toMatchObject({ first: { runId: first }, trigger: { runId: trigger } });
      expect(saved.details.notification.id).toBe(saved.subject);
      expect(invalidation.notify).toHaveBeenCalledTimes(1);
      await rootSql`DELETE FROM harness_shared.toast_log WHERE id::text=${saved.subject}`;
      await write(host, 3, false);
      const restartedSql = postgres(censusDatabaseUri, { max: 1, onnotice: () => {} });
      try {
        const third = await read(host, restartedSql as unknown as CensusSql);
        expect(third.incompleteEpisode).toMatchObject({ status: 'open', consecutive: 3, first: { runId: first }, trigger: { runId: trigger } });
        await alarm(third);
        expect((await rootSql`SELECT count(*)::int n FROM harness_shared.toast_log WHERE id::text=${saved.subject}`)[0]!.n).toBe(0);
        expect(invalidation.notify).toHaveBeenCalledTimes(1);
      } finally { await restartedSql.end({ timeout: 5 }); }
      await write(host, 4, true);
      expect((await read(host)).incompleteEpisode).toMatchObject({ status: 'closed' });
      await write(host, 5, false);
      expect((await read(host)).incompleteEpisode).toMatchObject({ status: 'pending', consecutive: 1 });
      const secondTrigger = await write(host, 6, false);
      await alarm(await read(host));
      const receipts = await rootSql`SELECT details FROM harness_shared.audit_log WHERE workspace_id=${workspaceId}`;
      expect(receipts).toHaveLength(2);
      expect(receipts.some(r => r.details.incompleteEpisode.trigger.runId === secondTrigger)).toBe(true);
    } finally { await concurrentSql.end({ timeout: 5 }); }
  });

  it.each([99, 100, 101, 199, 200, 201])('drains %i consecutive rows to their decisive complete anchor across pages and fresh clients', async count => {
    const host = `episode-pages-${count}-${randomUUID()}`;
    const reset = await write(host, 0, true);
    const runs: string[] = [];
    for (let i = 1; i <= count; i++) runs.push(await write(host, i, false));
    const client = postgres(censusDatabaseUri, { max: 1, onnotice: () => {} });
    try {
      expect((await read(host, client as unknown as CensusSql)).incompleteEpisode).toMatchObject({
        status: 'open', resetRunId: reset, consecutive: count, first: { runId: runs[0] }, trigger: { runId: runs[1] },
      });
    } finally { await client.end({ timeout: 5 }); }
  }, 120_000);

  it('keeps history gaps, legacy/unknown metadata, replacement and out-of-order insertions UNKNOWN with resync', async () => {
    for (const fault of ['pruned', 'legacy', 'version', 'identity', 'inserted'] as const) {
      const host = `episode-${fault}-${randomUUID()}`;
      await write(host, 0, true);
      const first = await write(host, 1, false);
      await write(host, 3, false);
      if (fault === 'pruned') await rootSql`DELETE FROM harness_shared.disk_census_runs WHERE run_id=${first}`;
      if (fault === 'legacy') await rootSql`UPDATE harness_shared.disk_census_runs SET note='du walked as root; du timed out' WHERE run_id=${first}`;
      if (fault === 'version') {
        const row = (await rootSql`SELECT note FROM harness_shared.disk_census_runs WHERE run_id=${first}`)[0]!;
        await rootSql`UPDATE harness_shared.disk_census_runs SET note=${row.note.replace('%22version%22%3A1', '%22version%22%3A2')} WHERE run_id=${first}`;
      }
      if (fault === 'identity') await write(host, 4, false, { identity: { ...identityFor(host), rootBirthNs: '2000' } });
      if (fault === 'inserted') await write(host, 2, false);
      expect((await read(host)).incompleteEpisode, fault).toMatchObject({ status: 'unknown', recovery: expect.stringContaining('storage:census') });
    }
  });

  it('isolates host/device identity, preserves note parsing and uses stable equal-time event order', async () => {
    const host = `episode-isolation-${randomUUID()}`;
    const [zero, one, two] = Array.from({ length: 3 }, () => randomUUID()).sort() as [string, string, string];
    await write(host, 0, true, { id: zero });
    await write(host, 1, false, { id: one });
    await write(host, 1, false, { id: two });
    await write(host, 0, true, { mount: '/other-device' });
    await write(host, 1, false, { mount: '/other-device' });
    const devices = (await readDiskConsumerCensus(sql, { host, now: start })).devices;
    expect(devices.find(d => d.device === '/episode-device')!.incompleteEpisode).toMatchObject({ status: 'open', first: { runId: one }, trigger: { runId: two } });
    expect(devices.find(d => d.device === '/other-device')!.incompleteEpisode).toMatchObject({ status: 'pending' });
    // An unfinished row participates in neither reset nor streak count.
    const unfinished = await write(host, 4, true);
    await rootSql`UPDATE harness_shared.disk_census_runs SET started_at=finished_at + interval '1 hour' WHERE run_id=${unfinished}`;
    expect((await read(host)).runId).toBe(two);
    const legacy = `note-compat-${randomUUID()}`;
    const baseAt = new Date(start.getTime() - 24 * HOUR);
    await writeCensusRun(sql, { runId: randomUUID(), host: legacy, device: device({ device: '/episode-device' }),
      startedAt: baseAt, finishedAt: baseAt, attributedBytes: 50 * G, complete: true, note: 'du walked as root',
      consumers: [dir('/episode-device/consumer', 1)] });
    await write(legacy, 0, true, { consumers: [dir('/episode-device/consumer', 2)] });
    expect(await read(legacy)).toMatchObject({ complete: true, coverageIssues: [], baselineStatus: 'comparable',
      consumers: [{ growth24hBytes: 1 }], incompleteEpisode: { status: 'closed' } });
  });

  it('rolls back both replay identity and notification on either failure and permits a safe retry', async () => {
    const host = `episode-rollback-${randomUUID()}`;
    await write(host, 0, true); await write(host, 1, false); await write(host, 2, false);
    let observation: DiskHeadroomObservation | undefined;
    await runDiskHeadroomAlarmOnce({ readDiskCensus: async () => [await read(host)],
      emitToast: async (_toast, saved) => { observation = saved; } });
    const options = { db: drizzle(notificationSql) as never, workspaceId: host };
    const toast = { level: 'warning', message: 'refuse-notification', description: 'must roll back replay identity' };
    await expect(emitStorageGrowthToast(toast, observation, options)).rejects.toThrow();
    expect((await rootSql`SELECT count(*)::int n FROM harness_shared.audit_log WHERE workspace_id=${host}`)[0]!.n).toBe(0);
    await rootSql.unsafe('ALTER TABLE harness_shared.audit_log ADD CONSTRAINT refuse_episode_audit CHECK (false) NOT VALID');
    try { await expect(emitStorageGrowthToast({ ...toast, message: 'evidence-refused' }, observation, options)).rejects.toThrow(); }
    finally { await rootSql.unsafe('ALTER TABLE harness_shared.audit_log DROP CONSTRAINT refuse_episode_audit'); }
    await emitStorageGrowthToast({ ...toast, message: 'episode-retry' }, observation, options);
    const receipts = await rootSql`SELECT a.subject, t.id FROM harness_shared.audit_log a JOIN harness_shared.toast_log t ON t.id::text=a.subject
      WHERE a.workspace_id=${host} AND a.action=${DISK_CENSUS_INCOMPLETE_ACTION}`;
    expect(receipts).toHaveLength(1);
  });
});

/** du's own number for one path — the comparison R-1's method names. */
function duBytes(path: string): number {
  const r = spawnSync('du', ['-s', '-B1', path], { encoding: 'utf8' });
  expect(r.status).toBe(0);
  return Number(r.stdout.split('\t')[0]);
}

function device(over: Partial<CensusDevice> = {}): CensusDevice {
  return { device: '/test-dev', majorMinor: '0:0', sizeBytes: 100 * G, usedBytes: 50 * G, availBytes: 50 * G, ...over };
}

function dir(consumer: string, bytes: number, depth = 1): CensusConsumer {
  return { consumer, kind: 'dir', depth, bytes };
}

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `dcc_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  censusDatabaseUri = u.toString();
  rootSql = postgres(censusDatabaseUri, { max: 2, onnotice: () => {} });
  // Drizzle replaces its client's timestamp/JSON codecs. Never give it the
  // native census client, whose Date parameters need postgres.js serialization.
  notificationSql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await rootSql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  await rootSql.unsafe(MIGRATION);
  await rootSql.unsafe(`CREATE TABLE harness_shared.toast_log (
    id bigserial PRIMARY KEY, level text NOT NULL, message text NOT NULL CHECK (message <> 'refuse-notification'),
    description text, harness_slug text, created_at bigint NOT NULL, action_label text, action_href text);
    CREATE TABLE harness_shared.audit_log (id text PRIMARY KEY, ts bigint NOT NULL, actor text NOT NULL,
    action text NOT NULL, subject text NOT NULL, details jsonb, workspace_id text NOT NULL)`);
  sql = rootSql as unknown as CensusSql;

  // A small tree with known shape: two listed directories, one nested, one big root file,
  // and one directory under the 1 MiB test floor.
  fixture = mkdtempSync(join(tmpdir(), 'disk-census-'));
  endpointEvidence = mkdtempSync(join(tmpdir(), 'disk-census-endpoints-'));
  vi.stubEnv('PAPERCUSP_HOME', endpointEvidence);
  vi.stubEnv('PAPERCUSP_RELEASE_RETENTION_ROOT', join(endpointEvidence, 'pins'));
  vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(endpointEvidence, 'mutexes'));
  mkdirSync(join(fixture, 'a'));
  mkdirSync(join(fixture, 'b', 'c'), { recursive: true });
  mkdirSync(join(fixture, 'tiny'));
  writeFileSync(join(fixture, 'a', 'one.bin'), randomBytes(3 * MIB));
  writeFileSync(join(fixture, 'a', 'two.bin'), randomBytes(2 * MIB));
  writeFileSync(join(fixture, 'b', 'c', 'deep.bin'), randomBytes(5 * MIB));
  writeFileSync(join(fixture, 'big.bin'), randomBytes(4 * MIB));
  writeFileSync(join(fixture, 'tiny', 'small.txt'), 'x'.repeat(1000));
}, 120_000);

afterAll(async () => {
  if (fixture) rmSync(fixture, { recursive: true, force: true });
  if (endpointEvidence) rmSync(endpointEvidence, { recursive: true, force: true });
  vi.unstubAllEnvs();
  await rootSql?.end({ timeout: 5 });
  await notificationSql?.end({ timeout: 5 });
});

describe('integrated producer singleton endpoints (real PG and du)', () => {
  it('persists certified independent endpoints and resumes the durable cursor without promoting the failed root', async () => {
    // The worker independently measures its actual host. Synthetic host names
    // must remain UNKNOWN; this positive control uses that measured identity.
    const host = hostname();
    const dev = device({ device: fixture, majorMinor: devToMajorMinor(statSync(fixture).dev) });
    const runDu = async () => ({ summary: { rootBytes: 100, consumers: [dir(join(fixture, 'a'), 50)], ownFiles: [], records: 2 },
      deniedCount: 0, deniedSample: [], exitCode: 1, timedOut: false,
      diagnostics: { lines: 1, missingPaths: [join(fixture, 'a', 'gone')], other: 0, overflow: false } });
    const launches: string[] = [];
    const measureEndpoint: typeof runDetachedDuUsage = (roots, options) => {
      launches.push(roots[0]!);
      return runDetachedDuUsage(roots, { ...options, launch: async (cmd, args) => {
        const child = spawn(cmd, args, { stdio: 'ignore' }); child.unref();
        if (!child.pid) throw new Error('test worker has no pid');
        return { pid: child.pid, taskId: null, confined: true };
      } });
    };
    for (let pass = 0; pass < 2; pass++) {
      const result = await censusOneDevice({ host, devices: [dev], stores: [], sudo: null }, dev, {
        sql, runDu, statDevice: null, producerBuildSha: 'a'.repeat(40), measureEndpoint,
        reconcileFailures: async (_root, _du, options) => {
          expect(options?.budget?.walksLeft).toBe(pass === 0 ? 7 : 8);
          return { status: 'unbounded', uncertainBytesUpperBound: null, vanishedPaths: 1, shards: [], reason: 'original root remains incomplete' };
        },
      });
      expect(result.failure).toBeUndefined();
      expect(result.run?.complete).toBe(false);
      const rows = await rootSql`SELECT note, complete FROM harness_shared.disk_census_runs WHERE run_id=${result.run!.runId}`;
      expect(rows[0]!.complete).toBe(false);
      const population = await readCensusEndpointEnvelope(rows[0]!.note);
      expect(population.status).toBe('verified');
      if (population.status !== 'verified') throw new Error(population.reason);
      const endpoint = population.rows[0]!.candidate.endpoint;
      expect(endpoint.status, JSON.stringify(endpoint)).toBe('certified');
      expect(population.envelope.selection).toMatchObject({ attempted: 1, remaining: 0,
        nextPriority: pass === 0 ? 'failure-shards' : 'endpoints', afterConsumer: join(fixture, 'a') });
      expect(population.failurePaths).toEqual([join(fixture, 'a', 'gone')]);
      const consumers = (await readDiskConsumerCensus(sql, { host })).devices[0]?.consumers;
      expect(consumers).toBeDefined();
      expect(consumers!.every(row => row.growth24hBytes === null)).toBe(true);
    }
    expect(launches).toEqual([join(fixture, 'a'), join(fixture, 'a')]);
  }, 120_000);

  it('reuses the durable prepare run id after a committed device step is replayed', async () => {
    const host = `producer-replay-${randomUUID()}`, dev = device(), runId = randomUUID();
    await writeCensusRun(sql, { runId, host, device: dev, startedAt: new Date(1000), finishedAt: new Date(2000),
      attributedBytes: 40 * G, complete: false, note: 'saved original UNKNOWN', consumers: [dir('/test-dev/a', G)] });
    const runDu = vi.fn();
    const result = await censusOneDevice({ host, devices: [dev], stores: [], sudo: null, runIds: { [dev.device]: runId } }, dev, { sql, runDu });
    expect(result.run).toMatchObject({ runId, complete: false, durationMs: 1000, consumers: 1 });
    expect(runDu).not.toHaveBeenCalled();
    expect((await rootSql`SELECT count(*)::int AS n FROM harness_shared.disk_census_runs WHERE run_id=${runId}`)[0]!.n).toBe(1);
  });
});

describe('scoped endpoint comparisons through the public reader (real PG and du)', () => {
  // The raw singleton traversals are real. Only their historical clocks are
  // retimed in this maintained fixture; this is not operational baseline proof.
  async function history(count = 1, reverse = false) {
    const root = mkdtempSync(join(endpointEvidence, 'scoped-')), consumer = join(root, 'zz-decisive');
    mkdirSync(consumer); writeFileSync(join(consumer, 'file'), randomBytes(64 * 1024));
    const host = hostname(), dev = device({ device: root, majorMinor: devToMajorMinor(statSync(root).dev) });
    const baselineId = randomUUID(), latestId = randomUUID();
    async function endpoint(runId: string, older: boolean): Promise<CensusEndpointCandidate> {
      const measured = await runDetachedDuUsage([consumer], { dir: join(root, `walk-${runId}`), pollMs: 25,
        endpoint: { parentRunId: runId, host, device: root, majorMinor: dev.majorMinor, producerBuildSha: 'a'.repeat(40) },
        launch: async (cmd, args) => {
          const child = spawn(cmd, args, { stdio: 'ignore' }); child.unref();
          if (!child.pid) throw new Error('test worker has no pid');
          return { pid: child.pid, taskId: null, confined: true };
        } });
      if (measured.endpoint?.status !== 'certified') throw new Error(JSON.stringify(measured));
      const observed = measured.endpoint;
      const receipt: CensusEndpointReceipt = structuredClone(observed.receipt);
      if (older) {
        receipt.startedAt -= 24 * HOUR; receipt.finishedAt -= 24 * HOUR;
        const terminal = JSON.parse(readFileSync(observed.source.path, 'utf8'));
        terminal.endpoint = receipt; terminal.finishedAt = receipt.finishedAt;
        writeFileSync(observed.source.path, JSON.stringify(terminal));
      }
      const sourceBytes = readFileSync(observed.source.path);
      return { consumer, endpoint: { status: 'certified', receipt,
        source: { path: observed.source.path, byteCount: sourceBytes.length, sha256: createHash('sha256').update(sourceBytes).digest('hex') } } };
    }
    const before = await endpoint(baselineId, true);
    writeFileSync(join(consumer, 'growth'), randomBytes(128 * 1024));
    const after = await endpoint(latestId, false);
    const consumers = [ ...Array.from({ length: count - 1 }, (_, i) => dir(join(root, `c${String(i).padStart(4, '0')}`), G)), dir(consumer, G) ];
    const unmeasured: CensusEndpointCandidate[] = consumers.filter(row => row.consumer !== consumer).map(row => ({ consumer: row.consumer,
      endpoint: { status: 'unknown', reason: 'deliberately unmeasured fixture consumer ' + 'x'.repeat(2000) } }));
    const selection = { version: 1 as const, filesystemKey: 'f'.repeat(64), afterConsumer: consumer,
      nextPriority: 'failure-shards' as const, attempted: 1, remaining: count - 1,
      failureScope: { status: 'known' as const, total: 1, reason: 'complete fixture classification' } };
    const notes = new Map<string, string>();
    for (const [runId, candidate] of [[baselineId, before], [latestId, after]] as const) {
      const rows = [...unmeasured, candidate];
      const envelope = await writeCensusEndpointEnvelope(reverse ? rows.reverse() : rows, { dir: join(root, `population-${runId}`), parentRunId: runId,
        selection, failurePaths: [join(root, 'failed-sibling', 'gone')] });
      notes.set(runId, 'du failed: churn; ' + censusEndpointEnvelopeNote(envelope));
      const receipt = candidate.endpoint.status === 'certified' ? candidate.endpoint.receipt : null;
      if (!receipt) throw new Error('fixture endpoint missing');
      await writeCensusRun(sql, { runId, host, device: dev, startedAt: new Date(receipt.startedAt - 1), finishedAt: new Date(receipt.finishedAt + 1),
        attributedBytes: 0, complete: false, note: notes.get(runId)!, consumers: reverse ? [...consumers].reverse() : consumers });
    }
    return { host, root, consumer, baselineId, latestId, before, after, notes };
  }

  it.each([99, 100, 101, 199, 200, 201])('drains %i mixed rows, recovers the late sealed source and preserves independent alarm truth', async count => {
    for (const reverse of [false, true]) {
      const h = await history(count, reverse);
      const first = (await readDiskConsumerCensus(sql, { host: h.host, device: h.root, limit: 100 })).devices[0]!;
      expect(first).toMatchObject({ complete: false, baselineStatus: 'latest-incomplete', baselineRunId: null,
        scopedComparisons: { total: count, qualified: 1, unknown: count - 1, rejected: 0 }, consumersOmitted: Math.max(0, count - 100) });
      const view = (await readCompleteDiskConsumerCensus(sql, { host: h.host, device: h.root, limit: 100 })).devices[0]!;
      const row = view.consumers!.find(item => item.consumer === h.consumer)!;
      expect(row.growth24hBytes).toBeNull();
      expect(row.scopedComparison).toMatchObject({ status: 'qualified', baselineRunId: h.baselineId,
        additive: false, snapshot: false, physicalProjection: false });
      expect(row.scopedComparison!.deltaBytes).toBeGreaterThan(0);
      expect(row.scopedComparison!.elapsedMs).toBeGreaterThanOrEqual(24 * HOUR);
      expect(view.consumers).toHaveLength(count);
      expect(view).toMatchObject({ nextConsumerCursor: null, consumersOmitted: 0 });
      expect(detectDiskGrowthWarnings([view])).toEqual([]);
      const emitToast = vi.fn(async (_toast: { message: string }) => {});
      const alarm = await runDiskHeadroomAlarmOnce({ readDiskCensus: async () => [view], emitToast });
      expect(alarm.censusScopedGrowth.map(item => item.consumer)).toEqual([h.consumer]);
      expect(alarm.diskGrowth).toEqual([]);
      expect(alarm.diskProjectionUnknown).toEqual([h.root]);
      expect(emitToast.mock.calls[0]?.[0]).toMatchObject({ message: `Measured consumer growth — ${h.root}` });
      const latest = await readCensusEndpointEnvelope(h.notes.get(h.latestId)!);
      expect(latest.status).toBe('verified');
      if (latest.status === 'verified' && count >= 99) expect(latest.envelope.omitted).toBeGreaterThan(0);
    }
  }, 120_000);

  it('pins recovered terminal qualification across pages and requests resync after source corruption', async () => {
    const h = await history(101);
    const first = (await readDiskConsumerCensus(sql, { host: h.host, device: h.root, limit: 100 })).devices[0]!;
    if (h.before.endpoint.status !== 'certified') throw new Error('fixture endpoint missing');
    writeFileSync(h.before.endpoint.source.path, '{}');
    await expect(readDiskConsumerCensus(sql, { cursor: first.nextConsumerCursor! })).rejects.toMatchObject({ code: 'census_restart_required' });
    const recovered = (await readCompleteDiskConsumerCensus(sql, { host: h.host, device: h.root })).devices[0]!;
    expect(recovered.scopedComparisons).toMatchObject({ total: 101, qualified: 0, unknown: 101 });
    expect(recovered.consumers!.every(row => row.growth24hBytes === null)).toBe(true);
  }, 120_000);

  it('resumes a scoped public cursor in a fresh Node process with the same qualification and population', async () => {
    const h = await history(101);
    const initial = (await readDiskConsumerCensus(sql, { host: h.host, device: h.root, limit: 100 })).devices[0]!;
    const script = join(h.root, 'public-cursor-restart.mts');
    writeFileSync(script, `import postgres from ${JSON.stringify(new URL('../../../../node_modules/postgres/src/index.js', import.meta.url).href)};
import { readDiskConsumerCensus } from ${JSON.stringify(new URL('./disk-consumer-census.ts', import.meta.url).href)};
const [uri, cursor] = JSON.parse(process.argv[2]);
const client = postgres(uri, { max: 1, onnotice: () => {} });
try { console.log(JSON.stringify(await readDiskConsumerCensus(client, { cursor, limit: 100 }))); }
finally { await client.end({ timeout: 5 }); }`);
    const child = spawnSync(process.execPath, ['--import', 'tsx/esm', script, JSON.stringify([censusDatabaseUri, initial.nextConsumerCursor])], { encoding: 'utf8' });
    expect(child.status, child.stderr).toBe(0);
    const page = (JSON.parse(child.stdout) as { devices: CensusDeviceView[] }).devices[0]!;
    expect(page).toMatchObject({ runId: h.latestId, consumersPageStart: 100, consumersOmitted: 0,
      nextConsumerCursor: null, scopedComparisons: initial.scopedComparisons });
    expect(page.consumers).toHaveLength(1);
    expect(page.consumers![0]).toMatchObject({ consumer: h.consumer, growth24hBytes: null,
      scopedComparison: { status: 'qualified', baselineRunId: h.baselineId, physicalProjection: false } });
  }, 120_000);

  it('keeps a mixed unknown/rejected baseline population UNKNOWN in either candidate order', async () => {
    const h = await history();
    if (h.before.endpoint.status !== 'certified' || h.after.endpoint.status !== 'certified') throw new Error('fixture endpoint missing');
    const baseline = h.before.endpoint;
    baseline.receipt.request.producerBuildSha = 'b'.repeat(40);
    const terminal = JSON.parse(readFileSync(baseline.source.path, 'utf8'));
    terminal.endpoint = baseline.receipt;
    writeFileSync(baseline.source.path, JSON.stringify(terminal));
    const bytes = readFileSync(baseline.source.path);
    baseline.source = { ...baseline.source, byteCount: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    const prior = await readCensusEndpointEnvelope(h.notes.get(h.baselineId)!);
    if (prior.status !== 'verified') throw new Error(prior.reason);
    const envelope = await writeCensusEndpointEnvelope([h.before], { dir: join(h.root, 'rejected-baseline'), parentRunId: h.baselineId,
      selection: prior.envelope.selection, failurePaths: prior.failurePaths });
    await rootSql`UPDATE harness_shared.disk_census_runs SET note=${censusEndpointEnvelopeNote(envelope)} WHERE run_id=${h.baselineId}`;
    const read = async () => (await readCompleteDiskConsumerCensus(sql, { host: h.host, device: h.root })).devices[0]!;
    expect((await read()).scopedComparisons).toMatchObject({ qualified: 0, rejected: 1, unknown: 0 });
    const unknownId = randomUUID();
    const at = new Date(h.after.endpoint.receipt.finishedAt + 1 - 24 * HOUR);
    await writeCensusRun(sql, { runId: unknownId, host: h.host, device: device({ device: h.root }), startedAt: at, finishedAt: at,
      attributedBytes: 0, complete: false, note: 'legacy source missing', consumers: [] });
    for (const first of [true, false]) {
      if (!first) {
        const far = new Date(h.before.endpoint.receipt.finishedAt - 1000);
        await rootSql`UPDATE harness_shared.disk_census_runs SET started_at=${far}, finished_at=${far} WHERE run_id=${unknownId}`;
      }
      const view = await read(), comparison = view.consumers![0]!.scopedComparison!;
      expect(view.scopedComparisons).toMatchObject({ total: 1, qualified: 0, rejected: 0, unknown: 1 });
      expect(comparison.candidates.map(row => row.status)).toEqual(first ? ['unknown', 'rejected'] : ['rejected', 'unknown']);
      expect(comparison.status).toBe('unknown');
    }
  }, 120_000);

  it.each([99, 100, 101, 199, 200, 201])('finds the decisive last scoped baseline across %i incomplete candidates and permutations', async count => {
    for (const reverse of [false, true]) {
      const h = await history();
      if (h.after.endpoint.status !== 'certified') throw new Error('fixture endpoint missing');
      const finishedAt = new Date(h.after.endpoint.receipt.finishedAt + 1 - 24 * HOUR);
      const ids = Array.from({ length: count - 1 }, () => randomUUID());
      for (const runId of reverse ? ids.reverse() : ids) await writeCensusRun(sql, {
        runId, host: h.host, device: device({ device: h.root }), startedAt: finishedAt, finishedAt,
        attributedBytes: 0, complete: false, note: 'legacy incomplete; endpoint qualification unavailable', consumers: [],
      });
      const view = (await readCompleteDiskConsumerCensus(sql, { host: h.host, device: h.root })).devices[0]!;
      const comparison = view.consumers!.find(row => row.consumer === h.consumer)!.scopedComparison!;
      expect(comparison).toMatchObject({ status: 'qualified', baselineRunId: h.baselineId });
      expect(comparison.candidates).toHaveLength(count);
      expect(comparison.candidates.slice(0, -1).every(candidate => candidate.status === 'unknown')).toBe(true);
      expect(comparison.candidates.at(-1)).toMatchObject({ runId: h.baselineId, status: 'qualified' });
      expect(view).toMatchObject({ complete: false, baselineRunId: null, baselineAt: null, scopedComparisons: { qualified: 1 } });
    }
  }, 120_000);
});

describe('lossless persisted census reader (real PG)', () => {
  const at = new Date('2026-11-18T12:00:00Z');
  const write = (host: string, runId: string, finishedAt: Date, consumers: CensusConsumer[], note = 'du walked as root') =>
    writeCensusRun(sql, { runId, host, device: device(), startedAt: finishedAt, finishedAt,
      attributedBytes: 50 * G, complete: true, note, consumers });

  it.each([99, 100, 101, 401])('finds the decisive last baseline among %i candidates across insertion permutations', async count => {
    for (const reverse of [false, true]) {
      const host = `baseline-${count}-${reverse}-${randomUUID()}`;
      const runIds = Array.from({ length: count }, () => randomUUID()).sort();
      const ids = Array.from({ length: count }, (_, i) => i + 1);
      if (reverse) ids.reverse();
      // Equal-distance ties cross every page boundary. The only comparable
      // candidate is last; all earlier rows must be classified, not capped.
      for (const i of ids) {
        await write(host, runIds[i - 1]!, new Date(at.getTime() - 24 * HOUR), [dir('/decisive', 3 * G)],
          i === count ? 'du walked as root' : i % 2 ? 'du walked unprivileged' : 'du walked as root; du failed: unreadable');
      }
      const runId = randomUUID();
      await write(host, runId, at, [dir('/decisive', 8 * G)]);
      const view = (await readDiskConsumerCensus(sql, { host, now: at })).devices[0]!;
      expect(view).toMatchObject({ runId, baselineRunId: runIds[count - 1], baselineStatus: 'comparable',
        consumers: [{ consumer: '/decisive', growth24hBytes: 5 * G }] });
      await rootSql`DELETE FROM harness_shared.disk_census_runs WHERE host = ${host}`;
    }
  });

  it('pins one repeatable snapshot across baseline pages during a concurrent insert', async () => {
    const host = `snapshot-${randomUUID()}`;
    const runIds = Array.from({ length: 101 }, () => randomUUID()).sort();
    for (let i = 1; i <= 101; i++) {
      await write(host, runIds[i - 1]!, new Date(at.getTime() - 23 * HOUR), [dir('/decisive', 2 * G)],
        i === 101 ? 'du walked as root' : 'du walked unprivileged');
    }
    await write(host, randomUUID(), at, [dir('/decisive', 8 * G)]);
    const concurrentId = randomUUID();
    let inserted = false;
    const snapshotSql = new Proxy(sql, {
      get(target, property, receiver) {
        if (property !== 'begin') return Reflect.get(target, property, receiver);
        return <T>(fn: (tx: CensusSql) => Promise<T>) => sql.begin(async tx => fn(new Proxy(tx, {
          apply(target, receiver, args: [TemplateStringsArray, ...unknown[]]) {
            const query = Reflect.apply(target, receiver, args);
            // Return fragment queries unchanged: postgres.js recognizes their
            // identity when interpolated into an outer tagged query.
            if (inserted || !args[0].join(' ').includes('AS distance')) return query;
            return query.then(async (rows: unknown[]) => {
              inserted = true;
              await write(host, concurrentId, new Date(at.getTime() - 24 * HOUR), [dir('/decisive', 6 * G)]);
              return rows;
            });
          },
        })));
      },
    });
    expect((await readDiskConsumerCensus(snapshotSql, { host })).devices[0]!.baselineRunId).toBe(runIds[100]);
    expect((await readDiskConsumerCensus(sql, { host })).devices[0]!.baselineRunId).toBe(concurrentId);
    await rootSql`DELETE FROM harness_shared.disk_census_runs WHERE host = ${host}`;
  });

  it.each([
    { count: 29, pageSize: 30 }, { count: 30, pageSize: 30 }, { count: 31, pageSize: 30 },
    { count: 101, pageSize: 30 }, { count: 499, pageSize: 500 }, { count: 500, pageSize: 500 },
    { count: 501, pageSize: 500 },
  ])('recovers $count tied consumers at a $pageSize-row boundary across fresh clients', async ({ count, pageSize }) => {
    const host = `consumer-pages-${randomUUID()}`;
    const consumers = Array.from({ length: count }, (_, i) => dir(`/consumer-${String(i).padStart(4, '0')}`, G));
    // A semantic key survives continuation intact, including multi-byte text.
    consumers[consumers.length - 1]!.consumer += `-${'字'.repeat(600)}`;
    const base = randomUUID();
    const latest = randomUUID();
    await write(host, base, new Date(at.getTime() - 24 * HOUR), consumers.map(c => ({ ...c, bytes: 0 })));
    await write(host, latest, at, [...consumers].reverse());
    const initial = (await readDiskConsumerCensus(sql, { host, limit: pageSize, now: at })).devices[0]!;
    expect(initial).toMatchObject({ consumersTotal: count, consumersReturned: Math.min(count, pageSize),
      consumersPageStart: 0, consumersOmitted: Math.max(0, count - pageSize), truncatedByLimit: count > pageSize });
    const recovered = [...initial.consumers!];
    let cursor = initial.nextConsumerCursor;
    let pages = 1;
    while (cursor) {
      // A fresh client on every page has no process-local continuation state.
      const client = postgres(censusDatabaseUri, { max: 1, onnotice: () => {} });
      try {
        const view = (await readDiskConsumerCensus(client as unknown as CensusSql,
          { cursor: JSON.parse(JSON.stringify(cursor)), limit: 7, now: at })).devices[0]!;
        expect(view.runId).toBe(latest);
        expect(view.baselineRunId).toBe(base);
        recovered.push(...view.consumers!);
        expect(view.consumersOmitted).toBe(count - recovered.length);
        expect(view.consumersReturned).toBe(view.consumers!.length);
        expect(view.consumersPageStart! + view.consumersReturned! + view.consumersOmitted!).toBe(count);
        cursor = view.nextConsumerCursor;
        expect(++pages).toBeLessThanOrEqual(Math.ceil(count / 7) + 1);
      } finally { await client.end({ timeout: 5 }); }
    }
    expect(recovered.map(c => c.consumer)).toEqual(consumers.map(c => c.consumer));
    expect(new Set(recovered.map(c => c.consumer)).size).toBe(count);
    expect(recovered.at(-1)).toMatchObject({ consumer: consumers.at(-1)!.consumer, growth24hBytes: G });
    const complete = (await readCompleteDiskConsumerCensus(sql, { host, orderBy: 'growth', limit: 7, now: at })).devices[0]!;
    expect(complete).toMatchObject({ consumersReturned: count, consumersOmitted: 0, truncatedByLimit: false, nextConsumerCursor: null });
    expect(complete.consumers).toEqual(recovered);
    const alarm = await runDiskHeadroomAlarmOnce({ readDiskCensus: async () => [complete], emitToast: async () => {} });
    expect(alarm.diskProjectionUnknown).toEqual([]);
  });

  it.each([0, 1, 2, 3])('bounds complete-reader resync with %i source invalidations, without mixing pages', async invalidations => {
    const host = `consumer-bounded-resync-${invalidations}-${randomUUID()}`;
    const latest = randomUUID();
    const consumers = [dir('/a', G), dir('/z', G)];
    await write(host, randomUUID(), new Date(at.getTime() - 24 * HOUR), consumers.map(c => ({ ...c, bytes: 0 })));
    await write(host, latest, at, consumers);
    let transactions = 0, mutations = 0;
    const changingSql = new Proxy(sql, {
      get(target, key, receiver) {
        if (key !== 'begin') return Reflect.get(target, key, receiver);
        return async (fn: Parameters<CensusSql['begin']>[0]) => {
          const transaction = ++transactions;
          const result = await target.begin(fn);
          // The cursor's snapshot has committed before another real PG client
          // changes its source. Each new attempt must discard its earlier page.
          if ((transaction === 1 || transaction === 3) && mutations < invalidations) {
            await rootSql`UPDATE harness_shared.disk_census_consumers SET bytes = bytes + 1 WHERE run_id = ${latest}`;
            mutations++;
          }
          return result;
        };
      },
    });
    const read = () => readCompleteDiskConsumerCensus(changingSql, { host, limit: 1, now: at });
    if (invalidations >= 2) {
      await expect(read()).rejects.toMatchObject({ code: 'census_restart_required',
        resync: { status: 'exhausted', attempts: 2 }, recovery: expect.stringContaining('without cursor') });
      expect(transactions).toBe(4);
      expect(mutations).toBe(2);
    } else {
      const result = await read();
      expect(transactions).toBe(invalidations === 0 ? 2 : 4);
      expect(result.devices[0]).toMatchObject({ consumersReturned: 2, consumersOmitted: 0,
        truncatedByLimit: false, nextConsumerCursor: null });
      expect(result.devices[0]!.consumers).toEqual(consumers.map(c => ({ ...c,
        bytes: G + invalidations, baselineBytes: 0, growth24hBytes: G + invalidations,
        scopedComparison: expect.objectContaining({ status: 'unknown', candidates: [], additive: false, physicalProjection: false }) })));
      const alarm = await runDiskHeadroomAlarmOnce({ readDiskCensus: async () => result.devices, emitToast: async () => {} });
      expect(alarm.diskProjectionUnknown).toEqual([]);
    }
  });

  it('does not resync a database failure as if its population changed', async () => {
    const failure = new Error('database read unavailable');
    const begin = vi.fn(async () => { throw failure; });
    const unavailableSql = new Proxy(sql, { get: (target, key, receiver) =>
      key === 'begin' ? begin : Reflect.get(target, key, receiver) });
    await expect(readCompleteDiskConsumerCensus(unavailableSql)).rejects.toBe(failure);
    expect(begin).toHaveBeenCalledTimes(1);
  });

  it('keeps the pinned run when a newer run arrives, and requires resync for late baselines, source mutation and pruning', async () => {
    const host = `consumer-resync-${randomUUID()}`;
    const latest = randomUUID();
    const baseline = randomUUID();
    await write(host, baseline, new Date(at.getTime() - 23 * HOUR), [dir('/a', 0), dir('/z', 0)]);
    await write(host, latest, at, [dir('/z', G), dir('/a', G)]);
    const options = { host, limit: 1, now: at };
    const first = (await readDiskConsumerCensus(sql, options)).devices[0]!;
    const cursor = first.nextConsumerCursor!;
    const resume = () => readDiskConsumerCensus(sql, { cursor, limit: 1, now: at });
    await write(host, randomUUID(), new Date(at.getTime() + HOUR), [dir('/new', G)]);
    expect((await resume()).devices[0]).toMatchObject({ runId: latest, consumers: [{ consumer: '/z' }] });
    await expect(readDiskConsumerCensus(sql, { cursor, orderBy: 'growth' })).rejects.toMatchObject({ code: 'census_restart_required' });
    await expect(readDiskConsumerCensus(sql, { cursor: 'not-a-cursor' })).rejects.toMatchObject({ code: 'census_restart_required' });
    const malformed = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(cursor, 'base64url').toString()),
      runId: '------------------------------------' })).toString('base64url');
    await expect(readDiskConsumerCensus(sql, { cursor: malformed })).rejects.toMatchObject({ code: 'census_restart_required' });
    const late = randomUUID();
    await write(host, late, new Date(at.getTime() - 24 * HOUR), [dir('/a', 1), dir('/z', 1)]);
    await expect(resume()).rejects.toMatchObject({ code: 'census_restart_required' });
    const restarted = (await readDiskConsumerCensus(sql, { ...options, asOf: at })).devices[0]!;
    expect(restarted.baselineRunId).toBe(late);
    await rootSql`UPDATE harness_shared.disk_census_consumers SET bytes = bytes + 1 WHERE run_id = ${latest}`;
    await expect(readDiskConsumerCensus(sql, { cursor: restarted.nextConsumerCursor! })).rejects.toMatchObject({ code: 'census_restart_required' });
    const beforePrune = (await readDiskConsumerCensus(sql, { ...options, asOf: at })).devices[0]!;
    await rootSql`DELETE FROM harness_shared.disk_census_runs WHERE run_id = ${late}`;
    await expect(readDiskConsumerCensus(sql, { cursor: beforePrune.nextConsumerCursor! })).rejects.toMatchObject({ code: 'census_restart_required' });
    const beforeRunPrune = (await readDiskConsumerCensus(sql, { ...options, asOf: at })).devices[0]!;
    await rootSql`DELETE FROM harness_shared.disk_census_runs WHERE run_id = ${latest}`;
    await expect(readDiskConsumerCensus(sql, { cursor: beforeRunPrune.nextConsumerCursor! })).rejects.toMatchObject({ code: 'census_restart_required' });
  });
});

describe('disk consumer census (real du, real PG)', () => {
  it('writes a census whose consumers match du on the same paths, and accounts for every byte', async () => {
    const total = duBytes(fixture);
    const dev = device({
      device: fixture,
      majorMinor: devToMajorMinor(statSync(fixture).dev),
      usedBytes: total + 5 * MIB, // 5 MiB the walk cannot see
    });
    const now = new Date('2026-10-12T12:00:00Z');
    const result = await runDiskConsumerCensusOnce({
      sql,
      host: 'census-test-host',
      devices: [dev],
      measurePostgres: async () => null,
      measureDocker: async () => null,
      statDevice: null, // keep the synthetic usedBytes; the real statfs would describe the host disk
      floorBytes: MIB,
      maxDepth: 3,
      now: () => now,
    });
    expect(result.failures).toEqual([]);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toMatchObject({ device: fixture, complete: true, attributedBytes: total, unattributedBytes: 5 * MIB });

    const read = await readDiskConsumerCensus(sql, { host: 'census-test-host', limit: 50, now });
    expect(read.devices).toHaveLength(1);
    const view = read.devices[0]!;
    expect(view).toMatchObject({ device: fixture, complete: true, usedBytes: total + 5 * MIB, unattributedBytes: 5 * MIB, coverageGap: false });
    const listed = new Map(view.consumers!.map((c) => [c.consumer, c]));

    // Every directory at or above the floor is listed, at du's size for that path.
    for (const p of [fixture, join(fixture, 'a'), join(fixture, 'b'), join(fixture, 'b', 'c')]) {
      expect(listed.get(p), p).toMatchObject({ kind: 'dir', bytes: duBytes(p) });
    }
    // A large file directly inside a listed directory gets its own row.
    expect(listed.get(join(fixture, 'big.bin'))).toMatchObject({ kind: 'file', depth: 1, bytes: duBytes(join(fixture, 'big.bin')) });
    // Under the floor: not listed.
    expect(listed.has(join(fixture, 'tiny'))).toBe(false);
    expect(listed.get(unattributedKey(fixture))).toMatchObject({ kind: 'unattributed', bytes: 5 * MIB });
    // No baseline 24h earlier yet: growth is unknown, never a made-up zero.
    expect(view.baselineAt).toBeNull();
    expect(view.baselineStatus).toBe('unavailable');
    expect(view.coverageIssues).toEqual([]);
    expect(view.baselineAvailBytes).toBeNull();
    expect(view.consumers!.every((c) => c.growth24hBytes === null)).toBe(true);
  }, 120_000);

  it('reports each consumer’s 24h growth against the run nearest 24h earlier, and ignores runs outside 18–30h', async () => {
    const host = 'growth-host';
    const dev = device({ device: '/g' });
    const latestAt = new Date('2026-10-12T12:00:00Z');
    const write = (runId: string, at: Date, consumers: CensusConsumer[], complete = true, availBytes = 50 * G) =>
      writeCensusRun(sql, { runId, host, device: { ...dev, availBytes, usedBytes: dev.sizeBytes - availBytes }, startedAt: at, finishedAt: at, attributedBytes: 40 * G, complete, note: null, consumers });
    await write('00000000-0000-4000-8000-000000000001', new Date(latestAt.getTime() - 40 * HOUR), [dir('/g/a', 1 * G)]);
    await write('00000000-0000-4000-8000-000000000002', new Date(latestAt.getTime() - 23 * HOUR), [dir('/g/a', 10 * G), dir('/g/b', 8 * G)], true, 80 * G);
    // Closer to 24h but incomplete: never a baseline.
    await write('00000000-0000-4000-8000-000000000003', new Date(latestAt.getTime() - 24 * HOUR), [dir('/g/a', 2 * G)], false, 90 * G);
    await write('00000000-0000-4000-8000-000000000004', latestAt, [dir('/g/a', 25 * G), dir('/g/b', 6 * G), dir('/g/new', 3 * G)]);

    const { devices } = await readDiskConsumerCensus(sql, { host, orderBy: 'growth', now: latestAt });
    const view = devices[0]!;
    expect(view).toMatchObject({ host, runId: '00000000-0000-4000-8000-000000000004',
      baselineRunId: '00000000-0000-4000-8000-000000000002' });
    expect(view.baselineAt).toBe(new Date(latestAt.getTime() - 23 * HOUR).toISOString());
    expect(view.availBytes).toBe(50 * G);
    expect(view.baselineAvailBytes).toBe(80 * G);
    expect(view.baselineSizeBytes).toBe(100 * G);
    expect(view.consumers!.map((c) => [c.consumer, c.bytes, c.growth24hBytes])).toEqual([
      ['/g/a', 25 * G, 15 * G],
      ['/g/b', 6 * G, -2 * G],
      ['/g/new', 3 * G, null],
    ]);
    expect(view.stale).toBe(false);
    expect(view.coverageGap).toBe(true); // used 50 GiB − attributed 40 GiB = 10 GiB unattributed
    // The forecast uses the selected clean baseline's filesystem delta and actual
    // 23h interval, not the latest free space or the overlapping consumer totals.
    const warnings = detectDiskGrowthWarnings(devices);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.growthBytesPerDay).toBeCloseTo(30 * G * 24 / 23);
    expect(warnings[0]!.daysToFull).toBeCloseTo(50 / (30 * 24 / 23));
    expect(warnings[0]!.topGrowers).toEqual([{ consumer: '/g/a', growthBytes: 15 * G }]);
    const notifications: string[] = [];
    const alarm = await runDiskHeadroomAlarmOnce({
      readDiskCensus: async () => (await readDiskConsumerCensus(sql, { host, orderBy: 'growth', now: latestAt })).devices,
      emitToast: async toast => { notifications.push(toast.description); },
    });
    expect(alarm.diskGrowth).toEqual(warnings);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain('full in 1.6d');
    expect(notifications[0]).toContain('/g/a');

    const options = { db: drizzle(notificationSql) as never, workspaceId: 'headroom-native-fixture' };
    await runDiskHeadroomAlarmOnce({ readDiskCensus: async () => devices,
      emitToast: (toast, observation) => emitStorageGrowthToast(toast, observation, options) });
    const saved = await rootSql`SELECT a.subject, a.details, t.id, t.message, t.description
      FROM harness_shared.audit_log a JOIN harness_shared.toast_log t ON t.id::text=a.subject
      WHERE a.action=${DISK_HEADROOM_OBSERVATION_ACTION} AND a.workspace_id=${options.workspaceId}`;
    expect(saved).toHaveLength(1);
    const receipt = saved[0]!.details as DiskHeadroomObservation & { notification: { id: string; message: string; description: string } };
    expect(receipt.devices[0]).toMatchObject({ host, runId: view.runId, baselineRunId: view.baselineRunId });
    expect(receipt.growth).toEqual(warnings);
    expect(receipt.notification).toMatchObject({ id: String(saved[0]!.id), message: saved[0]!.message,
      description: saved[0]!.description });
    expect(invalidation.notify).toHaveBeenCalledWith('toastLog.recent', undefined);
    expect(invalidation.notify).toHaveBeenCalledTimes(1);
    const toast = { level: 'warning', message: 'refuse-notification', description: 'must not leave evidence' };
    await expect(emitStorageGrowthToast(toast, receipt, options)).rejects.toThrow();
    expect(invalidation.notify).toHaveBeenCalledTimes(1);
    expect((await rootSql`SELECT count(*)::int n FROM harness_shared.audit_log`)[0]!.n).toBe(1);
    // Evidence failure must roll back the notification too, keeping their linkage atomic.
    await rootSql.unsafe('ALTER TABLE harness_shared.audit_log ADD CONSTRAINT refuse_evidence CHECK (false) NOT VALID');
    try {
      await expect(emitStorageGrowthToast({ ...toast, message: 'evidence-refused' }, receipt, options)).rejects.toThrow();
      expect((await rootSql`SELECT count(*)::int n FROM harness_shared.toast_log`)[0]!.n).toBe(1);
    } finally { await rootSql.unsafe('ALTER TABLE harness_shared.audit_log DROP CONSTRAINT refuse_evidence'); }

    // Only a 40h-old run besides the latest: outside the window, so no baseline.
    const only = await readDiskConsumerCensus(sql, { host, now: latestAt, device: '/g' });
    expect(only.devices).toHaveLength(1);
    expect(only.devices[0]!.baselineRunId).toBe(view.baselineRunId);
  });

  it('verifies native alarm decisions against all four hourly census histories and their actual notification', async () => {
    const host = 'native-headroom-verifier', workspaceId = 'native-headroom-verifier';
    const devices = ['/', '/mnt/data', '/mnt/cold-a', '/mnt/cold-b'];
    const epoch = Date.now();
    for (const path of devices) {
      for (let h = 0; h <= 24; h++) {
        const at = new Date(h === 24 ? epoch - 60_000 : epoch - 24 * HOUR + (h + 0.5) * HOUR);
        const availBytes = h === 24 ? 200e9 : 300e9;
        await writeCensusRun(sql, { runId: randomUUID(), host,
          device: device({ device: path, sizeBytes: 2e12, availBytes, usedBytes: 2e12 - availBytes }),
          startedAt: at, finishedAt: at, attributedBytes: 2e12 - availBytes, complete: true, note: null,
          producerBuildSha: 'native-verifier-fixture',
          consumers: [dir(`${path}/grower`, h === 24 ? 200e9 : 100e9)] });
      }
    }
    const native = await readDiskConsumerCensus(sql, { host, orderBy: 'growth', limit: 20, expectedDevices: devices });
    // The unenforced-class leg (durable-disk-and-checkpoint-recovery P-002) sends its own toast
    // with NO observation; forward it exactly as production's emitStorageGrowthToast receives it.
    const alarm = await runDiskHeadroomAlarmOnce({ readDiskCensus: async () => native.devices,
      emitToast: (toast, observation) => emitStorageGrowthToast(toast, observation && { ...observation,
        runtime: { ...observation.runtime, host, buildSha: 'native-verifier-fixture' } },
      { db: drizzle(notificationSql) as never, workspaceId }) });
    // Only cold-tier among these consumers is a class nothing enforces, so both cold volumes are
    // named. A notifier that throws on the missing observation would surface here as UNKNOWN.
    expect(alarm.unenforcedClassUnknown).toEqual([]);
    expect(alarm.unenforcedClassGrowth.map(w => [w.device, w.classId])).toEqual([
      ['/mnt/cold-a', 'cold-tier'], ['/mnt/cold-b', 'cold-tier']]);
    // Persisted as a plain notification: no audit receipt, so native acceptance below still passes.
    const classToasts = await rootSql`SELECT t.description FROM harness_shared.toast_log t
      WHERE t.message LIKE 'Protected storage growth%'
        AND NOT EXISTS (SELECT 1 FROM harness_shared.audit_log a WHERE a.subject = t.id::text)`;
    expect(classToasts).toHaveLength(1);
    expect(classToasts[0]!.description).toContain('cold-tier on /mnt/cold-a');
    expect(classToasts[0]!.description).toContain('cold-tier on /mnt/cold-b');
    const runtime = { ...diskHeadroomAlarmRuntimeIdentity(), host, buildSha: 'native-verifier-fixture' };
    await runDiskHeadroomAlarmOnce({ exercise: { devices: native.devices },
      emitToast: (toast, observation) => emitStorageGrowthToast(toast, { ...observation!, runtime },
        { db: drizzle(notificationSql) as never, workspaceId }) });
    const scope = { workspaceId, host, buildSha: 'native-verifier-fixture', runtime };
    expect((await measureNativeDiskHeadroomAlarm(rootSql, scope)).verdict).toBe('pass');
    expect((await measureNativeDiskHeadroomAlarm(rootSql, { ...scope, buildSha: 'other' })).verdict).toBe('unknown');
    const snapshotEnd = new Date(Date.now() + 1_000).toISOString();
    const snapshot = { ...scope, windowStart: new Date(epoch - 90 * 60_000).toISOString(), windowEnd: snapshotEnd };
    // New ordinary census runs and a fifth device cannot rewrite the alarm's inputs.
    for (const path of [...devices, '/mnt/unrelated']) {
      const at = new Date(epoch + 30 * 60_000);
      await writeCensusRun(sql, { runId: randomUUID(), host,
        device: device({ device: path }), startedAt: at, finishedAt: at,
        attributedBytes: 0, complete: false, note: null, consumers: [] });
    }
    expect((await measureNativeDiskHeadroomAlarm(rootSql, { ...scope, now: epoch + 31 * 60_000 })).verdict).toBe('pass');
    expect((await measureNativeDiskHeadroomAlarm(rootSql, { ...snapshot, now: epoch + 7 * 86400_000 })).verdict).toBe('pass');
    expect((await measureNativeDiskHeadroomAlarm(rootSql, { ...scope, now: epoch + 91 * 60_000 })).verdict).toBe('unknown');
    // The alarm's current build must not relabel historical census producers.
    await rootSql`UPDATE harness_shared.disk_census_runs SET note='census-producer:older; '
      WHERE host=${host} AND device='/' AND started_at BETWEEN ${new Date(epoch - 12 * HOUR)} AND ${new Date(epoch - 11 * HOUR)}`;
    expect((await measureNativeDiskHeadroomAlarm(rootSql, snapshot)).verdict).toBe('unknown');
    await rootSql`UPDATE harness_shared.disk_census_runs SET note='census-producer:native-verifier-fixture; ' WHERE host=${host}`;
    // A missing middle hour must fail even with valid latest+baseline endpoints.
    await rootSql`UPDATE harness_shared.disk_census_runs SET complete=false WHERE host=${host}
      AND device='/' AND started_at BETWEEN ${new Date(epoch - 12 * HOUR)} AND ${new Date(epoch - 11 * HOUR)}`;
    expect((await measureNativeDiskHeadroomAlarm(rootSql, scope)).verdict).toBe('unknown');
    await rootSql`UPDATE harness_shared.disk_census_runs SET complete=true WHERE host=${host} AND finished_at<=${new Date(epoch)}`;
    // A tampered decision is distinguished from a missing/detached notification.
    await rootSql`UPDATE harness_shared.audit_log SET details=jsonb_set(details,'{horizonDays}','8') WHERE workspace_id=${workspaceId}`;
    expect((await measureNativeDiskHeadroomAlarm(rootSql, scope)).verdict).toBe('fail');
    await rootSql`UPDATE harness_shared.audit_log SET details=jsonb_set(details,'{horizonDays}','7') WHERE workspace_id=${workspaceId}`;
    await rootSql`DELETE FROM harness_shared.toast_log WHERE id::text IN
      (SELECT subject FROM harness_shared.audit_log WHERE workspace_id=${workspaceId})`;
    expect((await measureNativeDiskHeadroomAlarm(rootSql, scope)).verdict).toBe('unknown');
  });

  it('proves labelled delivery on healthy native census without accepting synthetic capacity or missing real notifications', async () => {
    const host = 'healthy-exercise-host', workspaceId = 'healthy-exercise-workspace', buildSha = 'exercise-fixture-build';
    const runtime = { ...diskHeadroomAlarmRuntimeIdentity(), host, buildSha };
    const scope = { host, workspaceId, buildSha, runtime };
    const epoch = Date.now();
    const paths = ['/', '/mnt/data', '/mnt/cold-a', '/mnt/cold-b'];
    for (const path of paths) for (let h = 0; h <= 24; h++) {
      const at = new Date(h === 24 ? epoch - 60_000 : epoch - 24 * HOUR + (h + 0.5) * HOUR);
      await writeCensusRun(sql, { runId: randomUUID(), host,
        device: device({ device: path, sizeBytes: 2e12, availBytes: 1.5e12, usedBytes: 500e9 }),
        startedAt: at, finishedAt: at, attributedBytes: 500e9, complete: true, note: null,
        producerBuildSha: buildSha, consumers: [dir(`${path}/grower`, 500e9)] });
    }
    expect((await measureNativeDiskHeadroomAlarm(rootSql, scope)).verdict).toBe('unknown');
    const native = await readDiskConsumerCensus(sql, { host, orderBy: 'growth', limit: 20, expectedDevices: paths });
    const synthetic = native.devices.map(d => ({ ...d, availBytes: 200e9, baselineAvailBytes: 300e9,
      consumers: [{ consumer: `${d.device}/synthetic`, kind: 'dir' as const, depth: 1, bytes: 200e9,
        baselineBytes: 100e9, growth24hBytes: 100e9 }] }));
    const emit = (toast: Parameters<typeof emitStorageGrowthToast>[0], observation?: DiskHeadroomObservation) =>
      emitStorageGrowthToast(toast, observation && { ...observation, runtime }, { db: drizzle(notificationSql) as never, workspaceId });
    await runDiskHeadroomAlarmOnce({ exercise: { devices: synthetic }, emitToast: emit,
      readDiskCensus: async () => { throw new Error('exercise must not read native census'); } });
    const actions = await rootSql`SELECT action, details FROM harness_shared.audit_log WHERE workspace_id=${workspaceId}`;
    expect(actions).toHaveLength(1);
    expect(actions[0]!.action).toBe(DISK_HEADROOM_EXERCISE_ACTION);
    expect(actions[0]!.details.exercise.kind).toBe('synthetic-delivery');
    expect((await readDiskConsumerCensus(sql, { host, orderBy: 'growth', limit: 20, expectedDevices: paths })).devices).toEqual(native.devices);
    expect((await measureNativeDiskHeadroomAlarm(rootSql, scope)).verdict).toBe('pass');
    expect((await measureNativeDiskHeadroomAlarm(rootSql, { ...scope, runtime: { ...runtime, pid: runtime.pid + 1 } })).verdict).toBe('unknown');
    // Missing authentic hourly history cannot be repaired by a synthetic exercise.
    await rootSql`UPDATE harness_shared.disk_census_runs SET complete=false WHERE host=${host}
      AND device='/' AND started_at BETWEEN ${new Date(epoch - 12 * HOUR)} AND ${new Date(epoch - 11 * HOUR)}`;
    expect((await measureNativeDiskHeadroomAlarm(rootSql, scope)).verdict).toBe('unknown');
    await rootSql`UPDATE harness_shared.disk_census_runs SET complete=true WHERE host=${host}`;
    await rootSql`UPDATE harness_shared.audit_log SET details=jsonb_set(details,'{horizonDays}','8') WHERE workspace_id=${workspaceId}`;
    expect((await measureNativeDiskHeadroomAlarm(rootSql, scope)).verdict).toBe('fail');
    await rootSql`UPDATE harness_shared.audit_log SET details=jsonb_set(details,'{horizonDays}','7') WHERE workspace_id=${workspaceId}`;
    // A real floor breach still requires a physical notification of its own.
    const at = new Date();
    await writeCensusRun(sql, { runId: randomUUID(), host, device: device({ device: '/', sizeBytes: 2e12,
      availBytes: 200e9, usedBytes: 1.8e12 }), startedAt: at, finishedAt: at, attributedBytes: 1.8e12,
      complete: true, note: null, producerBuildSha: buildSha, consumers: [dir('//grower', 1.8e12)] });
    // A new exercise chooses the new native snapshot; it cannot satisfy the real breach.
    await runDiskHeadroomAlarmOnce({ exercise: { devices: synthetic }, emitToast: emit });
    expect((await measureNativeDiskHeadroomAlarm(rootSql, scope)).verdict).toBe('unknown');
    const breached = await readDiskConsumerCensus(sql, { host, orderBy: 'growth', limit: 20, expectedDevices: paths });
    await runDiskHeadroomAlarmOnce({ readDiskCensus: async () => breached.devices, emitToast: emit });
    expect((await measureNativeDiskHeadroomAlarm(rootSql, scope)).verdict).toBe('pass');
    await rootSql`DELETE FROM harness_shared.toast_log WHERE id::text IN
      (SELECT subject FROM harness_shared.audit_log WHERE workspace_id=${workspaceId} AND action=${DISK_HEADROOM_EXERCISE_ACTION})`;
    expect((await measureNativeDiskHeadroomAlarm(rootSql, scope)).verdict).toBe('unknown');
  });

  it('admits the oldest census pass and sheds overlapping hourly starts without wedging on stale or terminal rows', async () => {
    await rootSql.unsafe('CREATE SCHEMA IF NOT EXISTS dbos');
    // Only the SDK-owned columns read by the guard are needed in this private database.
    await rootSql.unsafe('CREATE TABLE dbos.workflow_status (workflow_uuid text PRIMARY KEY, name text, status text, created_at bigint, started_at_epoch_ms bigint)');
    const now = Date.now();
    const add = (id: string, name: string, status: string, createdAt: number) => rootSql`
      INSERT INTO dbos.workflow_status VALUES (${id}, ${name}, ${status}, ${createdAt}, ${status === 'ENQUEUED' ? null : createdAt})`;
    await add('old', 'diskConsumerCensus', 'PENDING', now - 75 * HOUR / 60);
    await add('self', 'diskConsumerCensus', 'PENDING', now);
    expect(await diskCensusPassInFlight(sql, 'self', 2, now)).toBe(true);
    expect(await diskCensusPassInFlight(sql, 'old', 2, now)).toBe(false);
    await rootSql`UPDATE dbos.workflow_status SET status = 'ENQUEUED', started_at_epoch_ms = NULL WHERE workflow_uuid = 'old'`;
    expect(await diskCensusPassInFlight(sql, 'self', 2, now)).toBe(true);
    await rootSql`UPDATE dbos.workflow_status SET status = 'SUCCESS' WHERE workflow_uuid = 'old'`;
    await add('unrelated', 'anotherWorkflow', 'PENDING', now - HOUR);
    await add('stale', 'diskConsumerCensus', 'PENDING', now - 4 * HOUR);
    expect(await diskCensusPassInFlight(sql, 'self', 2, now)).toBe(false);
    await rootSql.unsafe('DROP TABLE dbos.workflow_status');
  });

  it('never reports newly visible bytes as growth across a denied or differently privileged baseline', async () => {
    const host = 'visibility-growth-host'; const at = new Date('2026-10-13T17:00:00Z');
    const dev = device({ device: '/visibility' });
    const write = (id: string, hours: number, note: string, bytes: number) => writeCensusRun(sql, {
      runId: id, host, device: dev, startedAt: new Date(at.getTime() - hours * HOUR), finishedAt: new Date(at.getTime() - hours * HOUR),
      attributedBytes: bytes, complete: true, note, consumers: [dir('/visibility/data', bytes)],
    });
    await write('00000000-0000-4000-8000-000000000081', 24, '681 unreadable path(s), e.g. /var/lib/postgresql', 2 * G);
    await write('00000000-0000-4000-8000-000000000082', 23, 'du walked unprivileged (sudo -n unavailable)', 3 * G);
    await write('00000000-0000-4000-8000-000000000083', 0, 'du walked as root (sudo -n)', 40 * G);
    const unknown = (await readDiskConsumerCensus(sql, { host, now: at })).devices[0]!;
    expect(unknown.baselineRunId).toBeNull();
    expect(unknown.baselineStatus).toBe('visibility-mismatch');
    expect(unknown.baselineAt).toBeNull(); expect(unknown.consumers![0]!.growth24hBytes).toBeNull();
    expect(unknown.baselineAvailBytes).toBeNull();
    await write('00000000-0000-4000-8000-000000000084', 22, 'du walked as root (sudo -n)', 38 * G);
    const calibrated = (await readDiskConsumerCensus(sql, { host, now: at })).devices[0]!;
    expect(calibrated.baselineAt).toBe(new Date(at.getTime() - 22 * HOUR).toISOString());
    expect(calibrated.baselineRunId).toBe('00000000-0000-4000-8000-000000000084');
    expect(calibrated.baselineStatus).toBe('comparable');
    expect(calibrated.consumers![0]!.growth24hBytes).toBe(2 * G);
  });

  it('reports historical denied scans as incomplete even when the old writer stored complete=true', async () => {
    const at = new Date('2026-10-13T17:00:00Z');
    await writeCensusRun(sql, { runId: '00000000-0000-4000-8000-000000000085', host: 'legacy-denied-host', device: device({ device: '/denied' }), startedAt: at, finishedAt: at, attributedBytes: G, complete: true, note: '3 unreadable path(s), e.g. /db', consumers: [dir('/denied/data', G)] });
    const view = (await readDiskConsumerCensus(sql, { host: 'legacy-denied-host', now: at })).devices[0]!;
    expect(view.complete).toBe(false); expect(view.baselineAt).toBeNull();
    expect(view.coverageIssues).toContain('unreadable-paths');
    expect(view.baselineStatus).toBe('latest-incomplete');
  });

  it('reports recorded scan failures without guessing why an unexplained run is incomplete', async () => {
    const at = new Date('2026-10-13T17:00:00Z');
    for (const [host, complete, note, issues] of [
      ['recorded-coverage-host', true, 'du timed out; du failed: exit 1; du returned no root record; 3 unreadable path(s); own files of /db may be incomplete (find failed)',
        ['walk-timeout', 'walk-error', 'root-record-missing', 'unreadable-paths', 'own-files-incomplete']],
      ['unexplained-coverage-host', false, 'du walked unprivileged (sudo -n unavailable)', ['incomplete-run']],
    ] as const) {
      await writeCensusRun(sql, { runId: randomUUID(), host, device: device(), startedAt: at, finishedAt: at,
        attributedBytes: 50 * G, complete, note, consumers: [dir('/data', 50 * G)] });
      const view = (await readDiskConsumerCensus(sql, { host, now: at })).devices[0]!;
      expect(view).toMatchObject({ complete: false, coverageGap: false, coverageIssues: issues,
        baselineStatus: 'latest-incomplete', baselineRunId: null, baselineAt: null });
      expect(view.consumers![0]!.growth24hBytes).toBeNull();
    }
  });

  it('persists a missing root record as an explicit producer coverage failure', async () => {
    const at = new Date('2026-10-13T17:00:00Z'); const host = 'missing-root-record-host';
    const result = await runDiskConsumerCensusOnce({ sql, host, devices: [device()], now: () => at,
      statDevice: null, resolveSudo: async () => null,
      measurePostgres: async () => null, measureDocker: async () => null,
      runDu: async () => ({ summary: { rootBytes: null, consumers: [dir('/test-dev/data', 2 * G)], ownFiles: [], records: 1 },
        deniedCount: 0, deniedSample: [], timedOut: false, exitCode: 0 }),
    });
    expect(result.failures).toEqual([]);
    expect(result.runs[0]!.complete).toBe(false);
    const view = (await readDiskConsumerCensus(sql, { host, now: at })).devices[0]!;
    expect(view.note).toContain('du returned no root record; sizes are lower bounds');
    expect(view).toMatchObject({ complete: false, coverageIssues: ['root-record-missing', 'unattributed-bytes'],
      baselineStatus: 'latest-incomplete', baselineAt: null });
    expect(view.consumers!.find(c => c.consumer === '/test-dev/data')!.growth24hBytes).toBeNull();
  });

  it.each([
    { label: '0', exitCode: 0, expectedComplete: true, note: null, stderrSample: [] },
    { label: '1', exitCode: 1, expectedComplete: false, note: 'du exited with status 1; sizes are lower bounds',
      stderrSample: ['du: cannot access path-gone: No such file or directory'] },
    { label: 'null', exitCode: null, expectedComplete: false,
      note: 'du exited without an exit status; sizes are lower bounds', stderrSample: [] },
  ] as const)('persists completeness for du exitCode $label', async ({ label, exitCode, expectedComplete, note, stderrSample }) => {
    const at = new Date('2026-10-13T18:00:00Z'); const host = `du-exit-status-${label}-host`;
    const result = await runDiskConsumerCensusOnce({ sql, host, devices: [device()], now: () => at,
      statDevice: null, resolveSudo: async () => null,
      measurePostgres: async () => null, measureDocker: async () => null,
      runDu: async () => ({ summary: { rootBytes: 50 * G, consumers: [dir('/test-dev/data', 50 * G)], ownFiles: [], records: 2 },
        deniedCount: 0, deniedSample: [], timedOut: false, exitCode,
        ...(stderrSample.length ? { stderrSample: [...stderrSample] } : {}) }),
    });
    expect(result.failures).toEqual([]);
    expect(result.runs[0]!.complete).toBe(expectedComplete);
    const persisted = (await readDiskConsumerCensus(sql, { host, now: at })).devices[0]!;
    expect(persisted.complete).toBe(expectedComplete);
    if (note) expect(persisted.note).toContain(note);
    if (stderrSample.length) expect(persisted.note).toContain('du stderr: ' + stderrSample.join(' | '));
  });

  it('persists affected-shard bounds while retaining the failed whole-device verdict and unknown growth', async () => {
    const at = new Date('2026-10-13T18:00:00Z'); const host = 'bounded-vanished-shards-host';
    const coverage = { status: 'bounded' as const, uncertainBytesUpperBound: G, vanishedPaths: 1,
      shards: [{ path: '/test-dev/data', upperBytes: G }], reason: 'affected shard snapshots remeasured' };
    const result = await runDiskConsumerCensusOnce({ sql, host, devices: [device()], now: () => at,
      statDevice: null, resolveSudo: async () => null,
      measurePostgres: async () => null, measureDocker: async () => null,
      runDu: async () => ({ summary: { rootBytes: 50 * G, consumers: [dir('/test-dev/data', 50 * G)], ownFiles: [], records: 2 },
        deniedCount: 0, deniedSample: [], timedOut: false, exitCode: 1 }),
      reconcileFailures: async () => coverage,
    });
    expect(result.failures).toEqual([]);
    expect(result.runs[0]!.complete).toBe(false);
    const persisted = (await readDiskConsumerCensus(sql, { host, now: at })).devices[0]!;
    expect(persisted.failureCoverage).toEqual(coverage);
    expect(persisted).toMatchObject({ complete: false, baselineStatus: 'latest-incomplete', baselineAt: null });
    expect(persisted.consumers![0]!.growth24hBytes).toBeNull();
  });

  it('distinguishes unreadable baseline candidates from an absent qualified baseline', async () => {
    const at = new Date('2026-10-13T17:00:00Z'); const host = 'unreadable-baseline-host';
    await writeCensusRun(sql, { runId: randomUUID(), host, device: device(), startedAt: new Date(at.getTime() - 24 * HOUR),
      finishedAt: new Date(at.getTime() - 24 * HOUR), attributedBytes: 50 * G, complete: true,
      note: 'du walked as root (sudo -n); 3 unreadable path(s)', consumers: [dir('/data', 50 * G)] });
    await writeCensusRun(sql, { runId: randomUUID(), host, device: device(), startedAt: at, finishedAt: at,
      attributedBytes: 50 * G, complete: true, note: 'du walked as root (sudo -n)', consumers: [dir('/data', 50 * G)] });
    const view = (await readDiskConsumerCensus(sql, { host, now: at })).devices[0]!;
    expect(view).toMatchObject({ complete: true, coverageIssues: [], baselineStatus: 'incomplete-candidates', baselineAt: null });
    expect(view.consumers![0]!.growth24hBytes).toBeNull();
  });

  it('keeps a byte-attribution gap distinct from an incomplete scan', async () => {
    const at = new Date('2026-10-13T17:00:00Z'); const host = 'attribution-gap-host';
    await writeCensusRun(sql, { runId: randomUUID(), host, device: device(), startedAt: at, finishedAt: at,
      attributedBytes: 30 * G, complete: true, note: null, consumers: [dir('/data', 30 * G)] });
    const view = (await readDiskConsumerCensus(sql, { host, now: at })).devices[0]!;
    expect(view).toMatchObject({ complete: true, coverageGap: true, coverageIssues: ['unattributed-bytes'],
      baselineStatus: 'unavailable', baselineAt: null });
    expect(view.consumers![0]!.growth24hBytes).toBeNull();
  });

  it('flags a device whose latest run is older than 24h as stale, and a watched device with no rows as missing', async () => {
    const host = 'stale-host';
    const at = new Date('2026-10-10T00:00:00Z');
    await writeCensusRun(sql, {
      runId: '00000000-0000-4000-8000-000000000010',
      host,
      device: device({ device: '/s' }),
      startedAt: at,
      finishedAt: at,
      attributedBytes: 50 * G,
      complete: true,
      note: null,
      consumers: [dir('/s/x', 2 * G)],
    });
    const { devices } = await readDiskConsumerCensus(sql, {
      host,
      now: new Date(at.getTime() + 25 * HOUR),
      expectedDevices: ['/s', '/never-measured'],
    });
    expect(devices.find((d) => d.device === '/s')).toMatchObject({ stale: true, coverageGap: false });
    expect(devices.find((d) => d.device === '/never-measured')).toEqual({ device: '/never-measured', missing: true });
  });

  it('prunes runs older than 30 days together with their consumers', async () => {
    const host = 'prune-host';
    const now = new Date('2026-10-12T00:00:00Z');
    const mk = (runId: string, ageDays: number) =>
      writeCensusRun(sql, {
        runId,
        host,
        device: device({ device: '/p' }),
        startedAt: new Date(now.getTime() - ageDays * 24 * HOUR),
        finishedAt: new Date(now.getTime() - ageDays * 24 * HOUR),
        attributedBytes: 50 * G,
        complete: true,
        note: null,
        consumers: [dir('/p/x', G)],
      });
    await mk('00000000-0000-4000-8000-000000000020', 31);
    await mk('00000000-0000-4000-8000-000000000021', 29);
    expect(await pruneDiskCensus(sql, now)).toBeGreaterThanOrEqual(1);
    const runs = await rootSql`SELECT run_id FROM harness_shared.disk_census_runs WHERE host = ${host}`;
    expect(runs.map((r) => r.run_id)).toEqual(['00000000-0000-4000-8000-000000000021']);
    const orphans = await rootSql`
      SELECT count(*)::int AS n FROM harness_shared.disk_census_consumers WHERE run_id = '00000000-0000-4000-8000-000000000020'`;
    expect(orphans[0]!.n).toBe(0);
  });

  it('adds API-sized stores only on their own device and only when du cannot read their root', async () => {
    if (process.getuid?.() === 0) return; // root reads everything; the unreadable case cannot be built
    const locked = join(fixture, 'locked-store');
    const open = join(fixture, 'open-store');
    mkdirSync(locked);
    mkdirSync(open);
    chmodSync(locked, 0o000);
    try {
      const dev = device({ device: fixture, majorMinor: devToMajorMinor(statSync(fixture).dev) });
      const rows = await apiStoreConsumers(dev, [
        { kind: 'postgres', rootDir: locked, parts: [{ consumer: `postgres:${locked} databases`, bytes: 7 * G }] },
        { kind: 'docker', rootDir: open, parts: [{ consumer: 'docker:images', bytes: 3 * G }] },
        null,
      ]);
      expect(rows).toEqual([{ consumer: `postgres:${locked} databases`, kind: 'postgres', depth: 0, bytes: 7 * G }]);
      const elsewhere = await apiStoreConsumers(device({ majorMinor: '999:999' }), [
        { kind: 'postgres', rootDir: locked, parts: [{ consumer: 'postgres:x', bytes: G }] },
      ]);
      expect(elsewhere).toEqual([]);
      // A privileged (root) walk measured the locked store itself: adding the API size too
      // would count it twice.
      const afterRootWalk = await apiStoreConsumers(
        dev,
        [{ kind: 'postgres', rootDir: locked, parts: [{ consumer: `postgres:${locked} databases`, bytes: 7 * G }] }],
        true,
      );
      expect(afterRootWalk).toEqual([]);
    } finally {
      chmodSync(locked, 0o700);
    }
  });
});
