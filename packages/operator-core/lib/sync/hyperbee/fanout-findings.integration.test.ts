import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { configureScheduledRegistry, resetScheduledRegistry, type TimerHandle } from '@papercusp/scheduled-registry';
import { applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import {
  FANOUT_CLAIM_LEASE_MS, FANOUT_MAX_ATTEMPTS, FANOUT_RETRY_BASE_MS,
  recordFanoutFailure, retryOwedFanoutFindings, type FanoutFindingFiler,
} from './fanout-deliveries';

const capture = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../../harness/improvements/capture-core', () => ({ captureImprovement: capture.run }));

const FINDING_WORKER = String.raw`
import postgres from 'postgres';
const input = JSON.parse(process.env.FANOUT_TEST_WORKER_INPUT);
const sql = postgres(process.env.FANOUT_TEST_DB_URL, { max: 1 });
const imported = await import(input.moduleUrl);
const api = imported.default ?? imported;
const fileFinding = async (finding) => {
  if (input.phase === 'before-capture') process.exit(74);
  await sql.unsafe(
    'INSERT INTO harness_shared.test_fanout_findings (id,watchdog_key) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING',
    [finding.artifactId, finding.watchdogKey],
  );
  if (input.phase === 'after-capture') process.exit(75);
  return finding.artifactId;
};
const result = await api.retryOwedFanoutFindings({
  sql, workspaceId: input.workspaceId, now: input.now, fileFinding,
});
await sql.end();
console.log(JSON.stringify(result));
`;

async function findingProcess(phase: 'before-capture' | 'after-capture' | 'recover', now: number) {
  const { execFile } = await import('node:child_process');
  return new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
    // These ordinary children inherit the suite's task cgroup. A fresh process
    // loads production reservation/recovery code against the same durable PG.
    execFile(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', FINDING_WORKER], {
      cwd: fileURLToPath(new URL('../../../../../', import.meta.url)),
      env: {
        ...process.env,
        FANOUT_TEST_DB_URL: db.url,
        FANOUT_TEST_WORKER_INPUT: JSON.stringify({
          phase, now, workspaceId: WS,
          moduleUrl: new URL('./fanout-deliveries.ts', import.meta.url).href,
        }),
      },
      timeout: 45_000,
    }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') { reject(error); return; }
      resolve({ exitCode: error && typeof error.code === 'number' ? error.code : 0, stdout, stderr });
    });
  });
}

const WS = 'fanout_finding_test';
const NOW = 1_000_000;
let db: FreshPgDb;

async function seed(id: number, attempts = FANOUT_MAX_ATTEMPTS, state = 'pending') {
  await db.sql`INSERT INTO harness_shared.substrate_fanout_deliveries
    (workspace_id,outbox_id,subscriber_id,msg_id,object_kind,object_ref,target_kind,target_ref,delivery,attempts,state)
    VALUES (${WS},${id},'reader',${'fan-'+id},'work-item','WI-1','object','work-item:WI-1','{}',${attempts},${state})`;
}

const sink: FanoutFindingFiler = async (input) => {
  // A durable collaborator implementing capture's permanent-artifact contract.
  // Terminal artifacts are still returned. The production capture contract is
  // separately exercised by capture-core.test.ts's reserved-artifact tests.
  const rows = await db.sql`INSERT INTO harness_shared.test_fanout_findings (id,watchdog_key)
    VALUES (${input.artifactId},${input.watchdogKey})
    ON CONFLICT (id) DO UPDATE SET id=EXCLUDED.id RETURNING id`;
  return String(rows[0].id);
};

async function row(id: number) {
  const rows = await db.sql`SELECT * FROM harness_shared.substrate_fanout_deliveries
    WHERE workspace_id=${WS} AND outbox_id=${id} AND subscriber_id='reader'`;
  return rows[0];
}

function run(now = NOW, fileFinding: FanoutFindingFiler = sink, batch = 25) {
  return retryOwedFanoutFindings({ sql: db.sql, workspaceId: WS, now, fileFinding, batch });
}

describe('R-27 permanent finding reservation and independent recovery (real PG)', () => {
  beforeAll(async () => {
    db = await createFreshPgDb('fanout_findings');
    await applyMigrationForTest(db.sql, fileURLToPath(new URL(
      '../../../../../libs/papercusp/libs/db/sql/1639-substrate-fanout-deliveries.sql', import.meta.url)));
    await db.sql`CREATE TABLE harness_shared.test_fanout_findings (
      id text PRIMARY KEY, watchdog_key text NOT NULL, state text NOT NULL DEFAULT 'open')`;
    await db.sql`CREATE TABLE harness_shared.coord_entity_subscriptions (
      workspace_id text, subscriber_id text, target_kind text, target_ref text,
      reasons text[], cancelled_at timestamptz, expires_ts timestamptz)`;
  }, 60_000);
  afterAll(async () => { await db?.cleanup(); });
  beforeEach(async () => {
    await db.sql`TRUNCATE harness_shared.substrate_fanout_deliveries, harness_shared.test_fanout_findings,
      harness_shared.coord_entity_subscriptions`;
    capture.run.mockReset();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it.each([FANOUT_MAX_ATTEMPTS - 1, FANOUT_MAX_ATTEMPTS, FANOUT_MAX_ATTEMPTS + 1])(
    'files exactly at and above the attempt threshold: %i', async (attempts) => {
      await seed(1, attempts);
      const result = await run();
      const count = attempts >= FANOUT_MAX_ATTEMPTS ? 1 : 0;
      expect(result).toEqual({ selected: count, filed: count, moreDue: false });
      expect(await db.sql`SELECT id FROM harness_shared.test_fanout_findings`).toHaveLength(count);
      expect((await run()).filed).toBe(0);
    });

  it('the unsuccessful threshold attempt files immediately, with the reserved id', async () => {
    await seed(1, FANOUT_MAX_ATTEMPTS - 1);
    const result = await recordFanoutFailure({ outboxId: '1', sub: { subscriber_id: 'reader', delivery_mode: 'full', via: 'object' },
      object: { kind: 'work-item', ref: 'WI-1' },
      ev: { from: 'writer', subject: 'work-item:WI-1', summary: 'changed', notify_kind: 'item_updated' },
      error: new Error('notification sink unavailable') }, { sql: db.sql, workspaceId: WS, now: NOW, fileFinding: sink });
    expect(result.attempts).toBe(FANOUT_MAX_ATTEMPTS);
    const stored = await row(1);
    expect(stored.finding_ref).toMatch(/^EI-\d+$/);
    expect(stored.finding_ref).toBe(stored.finding_artifact_id);
    expect(stored.finding_retry_at).toBeNull();
  });

  it('continues delivery retries after large attempt counts without overflowing SQL backoff', async () => {
    await seed(1, 100);
    await db.sql`UPDATE harness_shared.substrate_fanout_deliveries SET finding_ref='EI-111' WHERE outbox_id=1`;
    const result = await recordFanoutFailure({ outboxId: '1', sub: { subscriber_id: 'reader', delivery_mode: 'full', via: 'object' },
      object: { kind: 'work-item', ref: 'WI-1' },
      ev: { from: 'writer', subject: 'work-item:WI-1', summary: 'changed', notify_kind: 'item_updated' },
      error: new Error('still unavailable') }, { sql: db.sql, workspaceId: WS, now: NOW, fileFinding: sink });
    expect(result.attempts).toBe(101);
    expect(Number((await row(1)).next_retry_at)).toBe(NOW + 60 * 60_000);
  });

  it.each(['pending', 'written', 'superseded', 'failed'])('recovers an owed finding after notification state becomes %s', async (state) => {
    await seed(1, FANOUT_MAX_ATTEMPTS, state);
    expect((await run()).filed).toBe(1);
    expect((await row(1)).state).toBe(state);
  });

  it.each([null, 'EI-999'])('does not confirm a null or mismatched capture result: %s', async (ref) => {
    await seed(1);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failed: FanoutFindingFiler = async () => ref;
    expect((await run(NOW, failed)).filed).toBe(0);
    const reserved = await row(1);
    expect(reserved.finding_ref).toBeNull();
    expect(reserved.finding_artifact_id).toMatch(/^EI-\d+$/);
    expect(Number(reserved.finding_retry_at)).toBe(NOW + FANOUT_RETRY_BASE_MS);
    expect(error).toHaveBeenCalledTimes(1);
    await db.sql`UPDATE harness_shared.substrate_fanout_deliveries SET state='written' WHERE outbox_id=1`;
    expect((await run(NOW + FANOUT_RETRY_BASE_MS)).filed).toBe(1);
    expect((await row(1)).finding_ref).toBe(reserved.finding_artifact_id);
  });

  it('the actual drain cadence recovers an owed finding after notification retry has ended', async () => {
    await seed(1, FANOUT_MAX_ATTEMPTS, 'written');
    const { startOutboxDrain } = await import('./outbox-drain');
    const pg = Object.assign(async () => Object.assign([], { count: 0 }), {
      listen: () => ({ unlisten: async () => {} }),
    }) as unknown as typeof db.sql;
    let now = NOW;
    let passes = 0;
    let fileFindingCalls = 0;
    const fileFinding = vi.fn<FanoutFindingFiler>(async (input) =>
      ++fileFindingCalls === 1 ? null : sink(input));
    const handle = {
      workspaceId: WS, harnessSlug: 'finding_cadence',
      ownLog: { keyHex: 'ab'.repeat(32) }, append: async () => {},
      registerCloseHook: () => {},
    } as unknown as Parameters<typeof startOutboxDrain>[0];
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Real PG I/O needs real timers, so nothing is faked. The drain's poll is a
    // managed interval, which stays inert in a Vitest worker unless a
    // deterministic seam is injected: capture its tick and fire it by hand.
    const pollTicks: Array<() => void> = [];
    const pollHandle: TimerHandle = { unref: () => undefined };
    resetScheduledRegistry();
    configureScheduledRegistry({
      setIntervalImpl: (cb, ms) => {
        if (ms === 25) pollTicks.push(cb);
        return pollHandle;
      },
      clearIntervalImpl: () => undefined,
    });
    const drain = startOutboxDrain(handle, pg, {
      pollMs: 25, _passTimeoutMs: 0, _backlogStallMs: 0, _orphanCheckIntervalMs: -1,
      diagnosticsEnabled: false, fanout: async () => {},
      retryFanoutDeliveries: async (signal) => {
        const result = await retryOwedFanoutFindings({ sql: db.sql, workspaceId: WS, now, fileFinding, signal });
        passes++;
        return result;
      },
    });
    try {
      await vi.waitFor(() => expect(passes).toBeGreaterThan(0), { timeout: 10_000 });
      expect(pollTicks).toHaveLength(1);
      expect((await row(1)).finding_ref).toBeNull();
      now += FANOUT_RETRY_BASE_MS;
      pollTicks[0]?.();
      await vi.waitFor(async () => expect((await row(1)).finding_ref).not.toBeNull(), { timeout: 10_000 });
      expect(fileFinding).toHaveBeenCalledTimes(2);
      expect(await db.sql`SELECT id FROM harness_shared.test_fanout_findings`).toHaveLength(1);
      expect((await row(1)).state).toBe('written');
    } finally {
      await drain.stop();
      resetScheduledRegistry();
    }
  });

  it.each(['before-capture', 'after-capture'] as const)(
    'recovers an actual process exit %s from durable reservation state', async (phase) => {
      await seed(1);
      const interrupted = await findingProcess(phase, NOW);
      expect(interrupted.exitCode, interrupted.stderr).toBe(phase === 'before-capture' ? 74 : 75);
      const reserved = await row(1);
      expect(reserved.finding_artifact_id).toMatch(/^EI-\d+$/);
      expect(reserved.finding_ref).toBeNull();
      expect(reserved.finding_retry_at).toBe(NOW + FANOUT_CLAIM_LEASE_MS);
      const captured = await db.sql`SELECT id FROM harness_shared.test_fanout_findings`;
      expect(captured).toHaveLength(phase === 'before-capture' ? 0 : 1);
      if (phase === 'after-capture') {
        await db.sql`UPDATE harness_shared.test_fanout_findings SET state='done'`;
      }
      // A separate process, not a reset module or a synthetic reservation,
      // recovers after the dead process's lease and confirms the original id.
      const restarted = await findingProcess('recover', NOW + FANOUT_CLAIM_LEASE_MS);
      expect(restarted.exitCode, restarted.stderr).toBe(0);
      expect(JSON.parse(restarted.stdout)).toEqual({ selected: 1, filed: 1, moreDue: false });
      expect((await row(1)).finding_ref).toBe(reserved.finding_artifact_id);
      expect(await db.sql`SELECT id,state FROM harness_shared.test_fanout_findings`).toEqual([
        { id: reserved.finding_artifact_id, state: phase === 'after-capture' ? 'done' : 'open' },
      ]);
    }, 100_000,
  );

  it('recovers a crash after reservation but before capture once the durable lease expires', async () => {
    await seed(1);
    await db.sql`UPDATE harness_shared.substrate_fanout_deliveries
      SET finding_artifact_id='EI-1234',finding_retry_at=${NOW + FANOUT_CLAIM_LEASE_MS} WHERE outbox_id=1`;
    expect((await run(NOW + FANOUT_CLAIM_LEASE_MS - 1)).filed).toBe(0);
    expect((await run(NOW + FANOUT_CLAIM_LEASE_MS)).filed).toBe(1);
    expect((await row(1)).finding_ref).toBe('EI-1234');
  });

  it('replays the same terminal artifact when capture committed before ledger confirmation', async () => {
    await seed(1);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const lostReply: FanoutFindingFiler = async (input) => { await sink(input); throw new Error('capture response lost'); };
    await run(NOW, lostReply);
    const reserved = await row(1);
    expect(reserved.finding_ref).toBeNull();
    await db.sql`UPDATE harness_shared.test_fanout_findings SET state='done'`;
    expect((await run(NOW + FANOUT_RETRY_BASE_MS)).filed).toBe(1);
    expect(await db.sql`SELECT id,state FROM harness_shared.test_fanout_findings`).toEqual([
      { id: reserved.finding_artifact_id, state: 'done' }]);
  });

  it('concurrent recovery callers cannot capture twice during the lease', async () => {
    await seed(1);
    let entered!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const release = new Promise<void>((resolve) => { finish = resolve; });
    const filer = vi.fn<FanoutFindingFiler>(async (input) => { entered(); await release; return sink(input); });
    const first = run(NOW, filer);
    await started;
    try { expect((await run(NOW, filer)).filed).toBe(0); }
    finally { finish(); }
    expect((await first).filed).toBe(1);
    expect(filer).toHaveBeenCalledTimes(1);
  });

  it.each([2, 3, 4, 13])('preserves every due row across bounded batches and restarted clients: %i rows', async (population) => {
    for (let id = population; id >= 1; id -= 1) await seed(id);
    const batch = 3;
    const first = await run(NOW, sink, batch);
    expect(first.moreDue).toBe(population > batch);
    let result = first;
    let passes = 1;
    while (result.moreDue) {
      // Each call starts from durable SQL state, with no in-memory cursor.
      result = await run(NOW, sink, batch);
      passes += 1;
      expect(passes).toBeLessThanOrEqual(Math.ceil(population / batch));
    }
    const ids = await db.sql`SELECT outbox_id FROM harness_shared.substrate_fanout_deliveries
      WHERE finding_ref IS NOT NULL ORDER BY outbox_id`;
    expect(ids.map((r) => Number(r.outbox_id))).toEqual(Array.from({ length: population }, (_, i) => i + 1));
  });

  it('a failing first row cannot starve a decisive row beyond the batch boundary', async () => {
    for (let id = 1; id <= 7; id += 1) await seed(id);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const flaky: FanoutFindingFiler = async (input) => input.outboxId === '1' ? null : sink(input);
    expect((await run(NOW, flaky, 3)).moreDue).toBe(true);
    expect((await run(NOW, flaky, 3)).moreDue).toBe(true);
    expect((await run(NOW, flaky, 3)).moreDue).toBe(false);
    expect((await row(7)).finding_ref).toMatch(/^EI-\d+$/);
    expect((await row(1)).finding_ref).toBeNull();
    expect((await run(NOW + FANOUT_RETRY_BASE_MS, sink, 3)).filed).toBe(1);
  });

  it('the production filer passes the reserved artifact identity into capture', async () => {
    await seed(1);
    capture.run.mockImplementation(async (input: { artifactId: string }) => ({ issue: { id: input.artifactId } }));
    const result = await retryOwedFanoutFindings({ sql: db.sql, workspaceId: WS, now: NOW });
    const stored = await row(1);
    expect(result.filed).toBe(1);
    expect(capture.run).toHaveBeenCalledWith(expect.objectContaining({
      artifactId: stored.finding_artifact_id, watchdogKey: 'fanout-persistent:reader:outbox:1' }));
  });
});
