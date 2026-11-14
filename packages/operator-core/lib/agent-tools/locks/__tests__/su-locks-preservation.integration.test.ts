import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  configureLocks, ensureBootstrap, getTxPool, inWorkspaceTxn,
  readQueue, sweepWorkspaceExpired, tryAcquire, tryFinishHookOperation,
  tryRelease, WorkspaceContendedError, _resetForTests,
  type AcquireParams, type LocksHost, type ReleaseLockRow,
} from '@papercusp/locks';
import { getHarnessAdminUrl } from '../../../embedded-pg-discovery';

// testing:run { privatePg:true } supplies the maintained disposable database.
// Unique domains and domain-scoped teardown also isolate ordinary suite runs.
const domains = new Set<string>();
const host = (extra: Partial<LocksHost> = {}) => configureLocks({
  getAdminBaseUrl: () => getHarnessAdminUrl(),
  getTxnTimeouts: () => ({ lockTimeoutMs: 250, statementTimeoutMs: 3000 }),
  ...extra,
});

async function fixture(automatic = false) {
  const domain = 'preservation-' + randomUUID();
  domains.add(domain);
  const params: AcquireParams = {
    coordinationDomain: domain, owner: 'original', ownerLabel: 'preservation-test',
    paths: ['src/a.ts'], intent: automatic ? 'PreToolUse: preservation test' : 'preservation test',
    ttlSec: 60, automatic,
    ...(automatic ? { operation: { id: randomUUID(), deadline: new Date(Date.now() + 60_000).toISOString() } } : {}),
  };
  const acquired = await inWorkspaceTxn(domain, params.owner, tx => tryAcquire(tx, params), { paths: params.paths });
  if (!acquired.ok) throw new Error('fixture lease was not granted');
  return { domain, params, lockId: acquired.lock_id };
}

async function holdings(domain: string) {
  return (await readQueue(getTxPool(), { coordinationDomain: domain })).active_locks;
}

describe('source preservation outside SQL (EI-28280477757151195)', () => {
  beforeAll(async () => { host(); await ensureBootstrap(); });
  beforeEach(() => host());
  afterEach(async () => {
    const sql = getTxPool();
    for (const domain of domains) {
      await sql`DELETE FROM agent_file_locks WHERE coordination_domain = ${domain}`;
      await sql`DELETE FROM agent_lock_waiters WHERE coordination_domain = ${domain}`;
    }
    domains.clear();
  });
  afterAll(() => _resetForTests());

  it('positive control: PostgreSQL terminates an actually idle transaction', async () => {
    const sql = getTxPool();
    const connection = await sql.reserve();
    try {
      await connection.unsafe('BEGIN');
      await connection.unsafe("SET LOCAL idle_in_transaction_session_timeout = '200ms'");
      const [row] = await connection`SELECT pg_backend_pid() AS pid`;
      expect((await sql`SELECT pid FROM pg_stat_activity WHERE pid = ${row.pid}`).length).toBe(1);
      await vi.waitFor(async () => {
        expect(await sql`SELECT pid FROM pg_stat_activity WHERE pid = ${row.pid}`).toHaveLength(0);
      }, { timeout: 5000, interval: 50 });
    } finally {
      connection.release();
    }
  });

  it('keeps the same-path fence while capture outlives the idle timeout and unrelated paths proceed', async () => {
    const { domain, params, lockId } = await fixture();
    const sql = getTxPool();
    let pid = 0;
    let captured!: () => void;
    const capturing = new Promise<void>(resolve => { captured = resolve; });
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const preserve = vi.fn(async (rows: ReleaseLockRow[]) => {
      expect(rows.map(row => row.lock_id)).toEqual([lockId]);
      captured();
      await gate;
      await delay(350);
      const [state] = await sql`SELECT state, xact_start FROM pg_stat_activity WHERE pid = ${pid}`;
      expect(state).toEqual({ state: 'idle', xact_start: null });
    });
    const release = inWorkspaceTxn(domain, params.owner, async tx => {
      await tx`SET LOCAL idle_in_transaction_session_timeout = '200ms'`;
      const [backend] = await tx`SELECT pg_backend_pid() AS pid`;
      pid = backend.pid;
      return tryRelease(tx, { coordinationDomain: domain, owner: params.owner, lockId, beforeRelease: preserve });
    }, { paths: params.paths });
    const outcome = release.then(value => ({ value }), error => ({ error }));
    try {
      await Promise.race([capturing, outcome.then(() => { throw new Error('release settled before capture'); })]);
      expect(await holdings(domain)).toHaveLength(1);
      await expect(inWorkspaceTxn(domain, 'same-path', async () => 'unexpected', { paths: params.paths }))
        .rejects.toBeInstanceOf(WorkspaceContendedError);
      await expect(inWorkspaceTxn(domain, 'other-path', async () => 'independent', { paths: ['src/b.ts'] }))
        .resolves.toBe('independent');
    } finally {
      finish();
    }
    const settled = await outcome;
    if ('error' in settled) throw settled.error;
    expect(settled.value.released).toEqual(params.paths);
    expect(preserve).toHaveBeenCalledOnce();
    expect(await holdings(domain)).toHaveLength(0);
    await expect(inWorkspaceTxn(domain, 'successor', async () => 'available', { paths: params.paths }))
      .resolves.toBe('available');
  }, 15_000);

  it('retains the lease on failed capture, then permits a successful retry and no-op release replay', async () => {
    const { domain, params, lockId } = await fixture();
    const preserve = vi.fn().mockRejectedValueOnce(new Error('capture refused')).mockResolvedValue(undefined);
    const release = () => inWorkspaceTxn(domain, params.owner, tx => tryRelease(tx, {
      coordinationDomain: domain, owner: params.owner, lockId, beforeRelease: preserve,
    }), { paths: params.paths });
    await expect(release()).rejects.toThrow('capture refused');
    expect(await holdings(domain)).toHaveLength(1);
    expect((await release()).released).toEqual(params.paths);
    expect((await release()).released).toEqual([]);
    expect(preserve).toHaveBeenCalledTimes(2);
  });

  it('preserves an expired predecessor outside SQL before deleting its exact lease', async () => {
    const { domain, params, lockId } = await fixture();
    const sql = getTxPool();
    await sql`UPDATE agent_file_locks SET expires_ts = clock_timestamp() - interval '1 second'
      WHERE coordination_domain = ${domain}`;
    let pid = 0;
    const preserve = vi.fn(async ({ rows }: { rows: ReleaseLockRow[] }) => {
      expect(rows.map(row => row.lock_id)).toEqual([lockId]);
      await delay(350);
      const [state] = await sql`SELECT state, xact_start FROM pg_stat_activity WHERE pid = ${pid}`;
      expect(state).toEqual({ state: 'idle', xact_start: null });
    });
    host({ beforeFileLocksRelease: preserve });
    await expect(inWorkspaceTxn(domain, params.owner, async tx => {
      await tx`SET LOCAL idle_in_transaction_session_timeout = '200ms'`;
      const [backend] = await tx`SELECT pg_backend_pid() AS pid`;
      pid = backend.pid;
      return sweepWorkspaceExpired(tx, domain);
    })).resolves.toBe(true);
    expect(preserve).toHaveBeenCalledOnce();
    expect(await holdings(domain)).toHaveLength(0);
  });

  it('records the original hook receipt after capture and reuses it on completion replay', async () => {
    const { domain, params } = await fixture(true);
    const receipt = { source: 'original-generation', operation: params.operation!.id };
    const preserve = vi.fn(async (operation: { captureReceipt?: Record<string, unknown> }) => {
      await delay(350);
      return operation.captureReceipt ?? receipt;
    });
    const finish = () => inWorkspaceTxn(domain, params.owner, async tx => {
      await tx`SET LOCAL idle_in_transaction_session_timeout = '200ms'`;
      return tryFinishHookOperation(tx, { ...params, operation: params.operation!, outcome: 'completed', beforeRelease: preserve });
    }, { paths: params.paths });
    expect(await finish()).toMatchObject({ ok: true, state: 'completed', captureReceipt: receipt, released: params.paths });
    expect(await holdings(domain)).toHaveLength(0);
    expect(await finish()).toMatchObject({ ok: true, state: 'completed', captureReceipt: receipt, released: [] });
    expect(preserve).toHaveBeenCalledTimes(2);
    expect(preserve.mock.calls[1][0].captureReceipt).toEqual(receipt);
  });

  it('cancels a hook without invoking its successful-edit capture callback', async () => {
    const { domain, params } = await fixture(true);
    const preserve = vi.fn();
    const result = await inWorkspaceTxn(domain, params.owner, tx => tryFinishHookOperation(tx, {
      ...params, operation: params.operation!, outcome: 'cancelled', beforeRelease: preserve,
    }), { paths: params.paths });
    expect(result).toMatchObject({ ok: true, state: 'cancelled', released: params.paths });
    expect(preserve).not.toHaveBeenCalled();
    expect(await holdings(domain)).toHaveLength(0);
  });
});
