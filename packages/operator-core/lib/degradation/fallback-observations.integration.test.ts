/**
 * fallback-observations against real Postgres, ACROSS PROCESSES
 * (degradation-signals-on-condition-rail-2026-10-11 P-002, BAR R-1, D-001).
 *
 * The whole point of the durable table is that a decision recorded in one
 * process (a gate child) is visible to the watchdog in another. So the write
 * here happens in a spawned child process through the public writer, and the
 * read happens in this process through the public reader.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { OrgTestDb } from '../../test/_org-test-db';

const { createOrgTestDb } = await import('../../test/_org-test-db');
const { readFallbackWindow, pruneFallbackObservations } = await import('./fallback-observations');

const MODULE_URL = new URL('./fallback-observations.ts', import.meta.url).href;
const WS = 'ws-fallback-observations-it';
const CORRELATION_ID = '64eab084-4e87-4e2b-99bd-3be2eb7c191f';

/** Run the writer in a separate node process (tsx loader), against `dsn`. */
function writeFromChildProcess(dsn: string): Promise<{ code: number | null; out: string }> {
  const script = `
    import postgres from 'postgres';
    const m = await import(${JSON.stringify(MODULE_URL)});
    const sql = postgres(process.env.FO_DSN, { max: 1, onnotice: () => {} });
    m.observeFallback('gate.pass-reuse', { eligible: 7689, applied: 0, reason: 'proofs-unavailable', scope: 'run-762a13a6' }, { sql, workspaceId: '${WS}', processTag: 'child-' + process.pid, correlationId: ${JSON.stringify(CORRELATION_ID)} });
    m.observeFallback('gate.pass-reuse', { eligible: 11, applied: 0, reason: 'dirty-checkout' }, { sql, workspaceId: '${WS}' });
    m.observeFallback('gate.pass-reuse', { eligible: 300, applied: 300, reason: 'applied' }, { sql, workspaceId: '${WS}' });
    m.observeFallback('other.mechanism', { eligible: 5, applied: 0, reason: 'x' }, { sql, workspaceId: '${WS}' });
    const res = await m.flushFallbackObservations();
    await sql.end({ timeout: 5 });
    process.stdout.write(JSON.stringify({ pid: process.pid, res }));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: fileURLToPath(new URL('.', import.meta.url)),
      env: { ...process.env, FO_DSN: dsn },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { err += String(d); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out: out || err }));
  });
}

describe('fallback observations — durable and readable across processes (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('a decision recorded in a child process is returned by the trailing-window reader here', async () => {
    const child = await writeFromChildProcess(db.adminDsn);
    expect(child.code, child.out).toBe(0);
    const reported = JSON.parse(child.out) as { pid: number; res: { written: number; failed: number } };
    expect(reported.pid).not.toBe(process.pid);
    expect(reported.res).toMatchObject({ written: 4, failed: 0 });

    const w = await readFallbackWindow('gate.pass-reuse', 60 * 60 * 1000, { sql: db.adminSql, workspaceId: WS });
    expect(w.samples).toBe(3);
    expect(w.eligible).toBe(8_000);
    expect(w.applied).toBe(300);
    expect(w.appliedRate).toBeCloseTo(300 / 8_000, 10);
    expect(w.dominantReason).toBe('proofs-unavailable');
    expect(w.reasons.find((r) => r.reason === 'dirty-checkout')).toMatchObject({ samples: 1, eligible: 11, fellBack: 11 });

    // Mechanisms and workspaces do not bleed into each other.
    const other = await readFallbackWindow('other.mechanism', 60 * 60 * 1000, { sql: db.adminSql, workspaceId: WS });
    expect(other.samples).toBe(1);
    const elsewhere = await readFallbackWindow('gate.pass-reuse', 60 * 60 * 1000, { sql: db.adminSql, workspaceId: 'ws-unrelated' });
    expect(elsewhere.samples).toBe(0);

    const rows = await db.adminSql<Array<{ process_tag: string | null; scope: string | null; correlation_id: string | null }>>`
      SELECT process_tag, scope, correlation_id FROM harness_shared.fallback_observations
       WHERE workspace_id = ${WS} AND reason = 'proofs-unavailable'
    `;
    expect(rows).toEqual([{ process_tag: `child-${reported.pid}`, scope: 'run-762a13a6', correlation_id: CORRELATION_ID }]);
  }, 60_000);

  it('the window excludes rows older than windowMs, and pruning removes rows past retention', async () => {
    await db.adminSql`
      INSERT INTO harness_shared.fallback_observations (workspace_id, mechanism, eligible, applied, reason, observed_at)
      VALUES (${WS}, 'aged.mechanism', 4, 0, 'stale', now() - interval '3 days')
    `;
    const recent = await readFallbackWindow('aged.mechanism', 24 * 60 * 60 * 1000, { sql: db.adminSql, workspaceId: WS });
    expect(recent.samples).toBe(0);
    const wide = await readFallbackWindow('aged.mechanism', 7 * 24 * 60 * 60 * 1000, { sql: db.adminSql, workspaceId: WS });
    expect(wide.samples).toBe(1);

    const deleted = await pruneFallbackObservations({ sql: db.adminSql, retentionMs: 2 * 24 * 60 * 60 * 1000, batchSize: 1 });
    expect(deleted).toBe(1);
    const after = await readFallbackWindow('aged.mechanism', 7 * 24 * 60 * 60 * 1000, { sql: db.adminSql, workspaceId: WS });
    expect(after.samples).toBe(0);
    // Recent rows survive the prune.
    const kept = await readFallbackWindow('gate.pass-reuse', 60 * 60 * 1000, { sql: db.adminSql, workspaceId: WS });
    expect(kept.samples).toBe(3);
  });

  it('BAR R-12: the default retention bound is 14 days — a 15-day-old row is pruned, a 13-day-old row survives', async () => {
    await db.adminSql`
      INSERT INTO harness_shared.fallback_observations (workspace_id, mechanism, eligible, applied, reason, observed_at)
      VALUES (${WS}, 'retention.default', 1, 0, 'past-bound', now() - interval '15 days'),
             (${WS}, 'retention.default', 1, 0, 'inside-bound', now() - interval '13 days')
    `;
    const deleted = await pruneFallbackObservations({ sql: db.adminSql });
    expect(deleted).toBe(1);
    const left = await db.adminSql<{ reason: string }[]>`
      SELECT reason FROM harness_shared.fallback_observations
       WHERE workspace_id = ${WS} AND mechanism = 'retention.default'
    `;
    expect(left.map((r) => r.reason)).toEqual(['inside-bound']);
  });

  it('the table refuses an applied count above eligible', async () => {
    await expect(db.adminSql`
      INSERT INTO harness_shared.fallback_observations (workspace_id, mechanism, eligible, applied, reason)
      VALUES (${WS}, 'm', 1, 2, 'r')
    `).rejects.toThrow(/fallback_observations_counts_valid/);
  });
});
