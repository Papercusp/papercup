/**
 * WI-10003688 recurrence guard (integration tier): a REAL embedded postmaster that is
 * SIGKILLed comes back on its own, and stop() never hangs on a postmaster that is
 * already dead.
 *
 * Measured 2026-09-28 on the Mac rig VM: the postmaster died on ENOSPC and nothing
 * restarted it, so the operator ran against a dead database for over an hour. The
 * unit tier (embedded-pg-supervisor.test.ts) covers disk-full classification and the
 * never-give-up backoff; this tier proves the wiring inside startEmbeddedPostgresServer.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import postgres from 'postgres';
import EmbeddedPostgres from 'embedded-postgres';
import { startEmbeddedPostgresServer } from '@papercusp/embedded-postgres-server';

const cleanups: Array<() => Promise<unknown>> = [];

afterAll(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => {});
});

async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('free-port probe returned no TCP address'));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function postmasterPid(dataDir: string): Promise<number> {
  const first = (await readFile(join(dataDir, 'postmaster.pid'), 'utf8')).split('\n')[0];
  const pid = Number(first);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`bad postmaster.pid first line: ${first}`);
  return pid;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(what: string, cond: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

async function selectOne(port: number, password: string): Promise<boolean> {
  const sql = postgres({ host: '127.0.0.1', port, user: 'postgres', password, database: 'papercusp', max: 1, connect_timeout: 2 });
  try {
    const rows = await sql`SELECT 1 AS one`;
    return rows[0]?.one === 1;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

async function boot(prefix: string, extra: Record<string, unknown> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const port = await freePort();
  const logs: string[] = [];
  const handle = await startEmbeddedPostgresServer({
    dataDir,
    port,
    onLog: (m: string) => logs.push(m),
    ...extra,
  });
  cleanups.push(() => handle.stop());
  return { dataDir, port, logs, handle };
}

describe('embedded-PG postmaster supervision (WI-10003688)', () => {
  it('propagates a low-level stop rejection and remains available for explicit cleanup', async () => {
    const { dataDir, port, handle } = await boot('papercusp-pg-stop-rejection-');
    const pid = await postmasterPid(dataDir);
    const cause = new Error('fixture_low_level_postgres_stop_failure');
    const stop = vi.spyOn(EmbeddedPostgres.prototype, 'stop').mockRejectedValueOnce(cause);
    try {
      await expect(handle.stop()).rejects.toBe(cause);
      expect(handle.health()).toMatchObject({ state: 'stopped' });
      expect(isAlive(pid)).toBe(true);
      expect(await selectOne(port, handle.password)).toBe(true);
    } finally {
      stop.mockRestore();
    }
    await handle.stop();
    await waitFor('the explicitly cleaned postmaster to stop', () => !isAlive(pid), 10_000);
  }, 120_000);

  it('restarts a SIGKILLed postmaster and serves queries again without an operator restart', async () => {
    const exits: Array<{ signal: string | null }> = [];
    let restarted = 0;
    const { dataDir, port, logs, handle } = await boot('papercusp-pg-supervise-', {
      restartBackoffMs: [250, 500, 1000],
      onPostgresExit: (e: { signal: string | null }) => exits.push(e),
      onPostgresRestarted: () => {
        restarted += 1;
      },
    });
    expect(await selectOne(port, handle.password)).toBe(true);
    expect(handle.health()).toMatchObject({ state: 'running', restarts: 0 });

    const before = await postmasterPid(dataDir);
    process.kill(before, 'SIGKILL');
    await waitFor('the killed postmaster to be gone', () => !isAlive(before), 10_000);

    await waitFor('a supervised restart', () => restarted >= 1, 60_000);
    expect(exits[0]).toMatchObject({ signal: 'SIGKILL' });
    await waitFor('the restarted postmaster to answer SELECT 1', () => selectOne(port, handle.password), 30_000);

    const after = await postmasterPid(dataDir);
    expect(after).not.toBe(before);
    expect(handle.health()).toMatchObject({ state: 'running' });
    expect(handle.health()!.restarts).toBeGreaterThanOrEqual(1);
    expect(logs.some((l) => l.includes('postgres exited unexpectedly'))).toBe(true);

    // A deliberate stop is not a death: nothing restarts it afterwards.
    await handle.stop();
    await waitFor('the postmaster to stop', () => !isAlive(after), 10_000);
    await new Promise((r) => setTimeout(r, 1500));
    expect(await selectOne(port, handle.password)).toBe(false);
    expect(handle.health()).toMatchObject({ state: 'stopped' });
  }, 180_000);

  it('stop() returns promptly when the postmaster is already dead (unsupervised)', async () => {
    const { dataDir, handle } = await boot('papercusp-pg-deadstop-', { supervise: false });
    expect(handle.health()).toBeNull();
    const pid = await postmasterPid(dataDir);
    process.kill(pid, 'SIGKILL');
    await waitFor('the killed postmaster to be gone', () => !isAlive(pid), 10_000);
    // embedded-postgres' own stop() waits for an 'exit' event that has already fired,
    // so without the dead-child guard this await never settles.
    const outcome = await Promise.race([
      handle.stop().then(() => 'stopped'),
      new Promise((r) => setTimeout(() => r('hung'), 10_000)),
    ]);
    expect(outcome).toBe('stopped');
  }, 120_000);
});
