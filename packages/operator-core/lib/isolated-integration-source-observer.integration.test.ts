import { expect, it } from 'vitest';
import { getOrgPg } from '@papercusp/db-org';
import { withIsolatedIntegrationSourceObserver } from '../test/isolated-integration-proof';
import { FALLBACK_FLUSH_DELAY_MS, flushFallbackObservations } from './degradation/fallback-observations';
import { noteSidecarFallback } from './fleet/git-via-sidecar';

it('owns delayed parent source-reader fallback observations in a private migrated database', async () => {
  const env = { ...process.env };
  const workspace = `parent-source-observer-${process.pid}`;
  const result = await withIsolatedIntegrationSourceObserver(async sql => {
    const [{ database }] = await getOrgPg().sql<{ database: string }[]>`SELECT current_database() AS database`;
    expect(database).toMatch(/^org_/);
    expect(process.env.PAPERCUSP_FORBID_LIVE_PG).toBe(env.PAPERCUSP_FORBID_LIVE_PG);
    expect(process.env.PAPERCUSP_FORBID_LIVE_PG_TARGETS).toBe(env.PAPERCUSP_FORBID_LIVE_PG_TARGETS);
    // Exercise the exact rejected-reader reporter, including its ordinary
    // delayed flush; a flush-time override alone would not own this timer.
    process.env.PAPERCUSP_WORKSPACE_ID = workspace;
    noteSidecarFallback('committed-tree-reader', new Error('parent-source-observer-test'), undefined, 'rejected');
    const deadline = Date.now() + FALLBACK_FLUSH_DELAY_MS + 5_000;
    let rows: Array<{ reason: string; eligible: number; applied: number }> = [];
    while (Date.now() < deadline) {
      rows = await sql<typeof rows>`SELECT reason, eligible, applied
        FROM harness_shared.fallback_observations WHERE workspace_id = ${workspace}`;
      if (rows.length) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(rows).toEqual([{ reason: 'local-execution-rejected', eligible: 1, applied: 0 }]);
    return database;
  }).finally(() => {
    if (env.PAPERCUSP_WORKSPACE_ID === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
    else process.env.PAPERCUSP_WORKSPACE_ID = env.PAPERCUSP_WORKSPACE_ID;
  });
  expect(result.database).toBe(result.value);
  expect(result.flush.failed).toBe(0);
  expect(process.env.HARNESS_DATABASE_URL).toBe(env.HARNESS_DATABASE_URL);
  expect(process.env.HARNESS_ADMIN_DATABASE_URL).toBe(env.HARNESS_ADMIN_DATABASE_URL);
  expect(process.env.PAPERCUSP_PGBOUNCER).toBe(env.PAPERCUSP_PGBOUNCER);
  expect(process.env.PAPERCUSP_SKIP_PG_DISCOVERY).toBe(env.PAPERCUSP_SKIP_PG_DISCOVERY);
  expect(await flushFallbackObservations()).toMatchObject({ written: 0, failed: 0 });
}, 120_000);

it('drains the parent observer before restoring its environment when source capture throws', async () => {
  const adminUrl = process.env.HARNESS_ADMIN_DATABASE_URL;
  await expect(withIsolatedIntegrationSourceObserver(async () => {
    noteSidecarFallback('committed-tree-reader', new Error('parent-capture-failed-test'), undefined, 'rejected');
    throw new Error('source capture failed');
  })).rejects.toThrow('source capture failed');
  expect(process.env.HARNESS_ADMIN_DATABASE_URL).toBe(adminUrl);
  // No deferred row may survive to resolve the restored ambient pool.
  expect(await flushFallbackObservations()).toMatchObject({ written: 0, failed: 0 });
}, 120_000);
