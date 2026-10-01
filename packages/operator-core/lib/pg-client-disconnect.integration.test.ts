/**
 * P-008: a shell deadline owns the SQL frontend, not the PostgreSQL backend.
 * Keep this counterexample beside the bounded diagnostic-query integration
 * tests so a terminal shell receipt cannot become a query-cancellation claim.
 * All processes and SQL below belong to a dedicated throwaway cluster.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveNativePgBinDir, startDedicatedNativePg } from '@papercusp/test-config/pg';
import { runForeground } from './agent-tools/capability/bash-jobs';

const psql = join(resolveNativePgBinDir(), 'psql');
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('native SQL frontend deadline versus PostgreSQL execution', () => {
  let pg: Awaited<ReturnType<typeof startDedicatedNativePg>>;
  let sql: postgres.Sql;
  const stateDir = mkdtempSync(join(tmpdir(), 'p008-client-disconnect-'));

  beforeAll(async () => {
    expect(existsSync(psql), 'the native fixture requires its real psql frontend').toBe(true);
    pg = await startDedicatedNativePg({ settings: { client_connection_check_interval: '0' } });
    sql = postgres(pg.getConnectionUri(), { max: 1, onnotice: () => {} });
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await pg?.stop();
    rmSync(stateDir, { recursive: true, force: true });
    if (!pg) return;
    expect(existsSync(pg.dataDir)).toBe(false);
    const refused = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: '127.0.0.1', port: pg.port });
      socket.once('connect', () => { socket.destroy(); resolve(false); });
      socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code === 'ECONNREFUSED'));
      socket.setTimeout(2_000, () => { socket.destroy(); resolve(false); });
    });
    expect(refused, 'private PostgreSQL port must be closed after teardown').toBe(true);
  });

  async function exercise(statementTimeoutMs: number): Promise<void> {
    const controller = new AbortController();
    const marker = `p008-disconnect-${crypto.randomUUID()}`;
    let output = '';
    let backendPid: number | undefined;
    const settingsQuery = "SELECT json_build_object('pid', pg_backend_pid(), 'statementTimeout', " +
      "current_setting('statement_timeout'), 'connectionCheck', current_setting('client_connection_check_interval'))";
    // Explicit startup options make the treatment the only difference between
    // the two cases. No host database, inherited PGOPTIONS or sudo is involved.
    const command = [
      quote(psql), quote(pg.getConnectionUri()), '-X -w -qAt -v ON_ERROR_STOP=1',
      '-c', quote(settingsQuery), '-c', quote(`SELECT pg_sleep(30) /* ${marker} */`),
    ].join(' ');
    const run = runForeground({
      command, cwd: process.cwd(), stateDir,
      env: { PGOPTIONS: `-c statement_timeout=${statementTimeoutMs} -c client_connection_check_interval=0` },
      onChunk: (chunk) => {
        output += chunk;
        const line = output.split('\n').find((row) => row.startsWith('{') && row.includes('"pid"'));
        if (line) backendPid = Number(JSON.parse(line).pid);
      },
    }, controller.signal, 5_000);

    try {
      // Observe THIS identified backend executing THIS query before trusting a
      // timeout. A startup failure or a different backend cannot pass the test.
      let observed = false;
      const readyDeadline = Date.now() + 4_000;
      while (Date.now() < readyDeadline && !observed) {
        if (backendPid !== undefined) {
          const rows = await sql<{ state: string; query: string }[]>`
            SELECT state, query FROM pg_stat_activity WHERE pid = ${backendPid}`;
          observed = rows[0]?.state === 'active' && rows[0].query.includes(marker);
        }
        if (!observed) await delay(20);
      }
      expect(observed, `the exact private query must start before the shell deadline; output=${output}`).toBe(true);
      expect(output).toContain('"connectionCheck" : "0"');
      const result = await run;

      if (statementTimeoutMs === 0) {
        expect(output).toContain('"statementTimeout" : "0"');
        expect(result.status).toBe('timed_out');
        // The client is gone, yet its server backend still executes the exact
        // query. This is the counterexample to process-tree kill == SQL cancel.
        const rows = await sql<{ state: string; query: string }[]>`
          SELECT state, query FROM pg_stat_activity WHERE pid = ${backendPid!}`;
        expect(rows[0]?.state).toBe('active');
        expect(rows[0]?.query).toContain(marker);
      } else {
        expect(output).toContain('"statementTimeout" : "1s"');
        expect(result.status).toBe('failed');
        expect(result.output).toContain('canceling statement due to statement timeout');
        let stillExecuting = true;
        const stopDeadline = Date.now() + 2_000;
        while (Date.now() < stopDeadline && stillExecuting) {
          const rows = await sql<{ state: string; query: string }[]>`
            SELECT state, query FROM pg_stat_activity WHERE pid = ${backendPid!}`;
          stillExecuting = rows[0]?.state === 'active' && rows[0].query.includes(marker);
          if (stillExecuting) await delay(20);
        }
        expect(stillExecuting, 'the server deadline must stop the identified query').toBe(false);
      }
    } finally {
      controller.abort();
      await run;
      // Cancellation is restricted to the PID captured from our private
      // frontend. The whole cluster is also stopped unconditionally above.
      if (backendPid !== undefined) await sql`SELECT pg_cancel_backend(${backendPid})`;
    }
  }

  it('a killed frontend can leave its query running after the shell deadline', async () => {
    await exercise(0);
  }, 20_000);

  it('an explicit server statement deadline stops that same workload', async () => {
    await exercise(1_000);
  }, 20_000);
});
