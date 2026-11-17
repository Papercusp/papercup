import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { COVERAGE_EXPECTED_INTERVAL_MS as I } from './sync-batch-delta-check';
import { recordSyncCheckDispatchCoverage, writeSyncCheckState } from './sync-check-dispatch-coverage';

let sql: postgres.Sql;
const scope = { workspaceId: 'coverage-owner', installSlug: 'papercusp', name: 'sync-batch-delta-check' };
const due = { ...scope, id: 'delta', targetRole: `system:${scope.name}` };
const original = { sha: 'original', coverage: { ticks: [{ atMs: 10 * I, status: 'green' as const, evaluated: true }] } };

beforeAll(async () => {
  const uri = await getTestPg();
  const database = `dispatchcov_${randomBytes(5).toString('hex')}`;
  const admin = postgres(uri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${database}"`);
    await markManagedTestDatabase(admin, database);
  } finally { await admin.end({ timeout: 5 }); }
  const url = new URL(uri);
  url.pathname = `/${database}`;
  sql = postgres(url.toString(), { max: 3, onnotice: () => {} });
  await sql`CREATE SCHEMA harness_shared`;
  await sql`CREATE TABLE harness_shared.routines (
    id text PRIMARY KEY, workspace_id text, install_slug text, name text,
    active boolean DEFAULT true, metadata jsonb DEFAULT '{}'::jsonb)`;
});
afterAll(async () => { await sql?.end({ timeout: 5 }); });
beforeEach(async () => {
  await sql`TRUNCATE harness_shared.routines`;
  for (const workspace of ['coverage-owner', 'other-workspace']) {
    await sql`INSERT INTO harness_shared.routines (id, workspace_id, install_slug, name, metadata)
      VALUES (${workspace === scope.workspaceId ? 'delta' : 'other'}, ${workspace}, ${scope.installSlug},
        ${scope.name}, ${sql.json({ sibling: 'keep', sync_delta: original })})`;
  }
});
const read = async (id = 'delta') => (await sql`SELECT metadata FROM harness_shared.routines WHERE id = ${id}`)[0]!.metadata;

describe('source-check dispatch/completion private PostgreSQL runtime', () => {
  it('persists held slots without running the action and fences workspace plus sibling metadata', async () => {
    await recordSyncCheckDispatchCoverage(sql, [due], 13 * I + 2 * 60_000);
    const row = await read();
    expect(row.sibling).toBe('keep');
    expect(row.sync_delta.sha).toBe('original');
    expect(row.sync_delta.coverage.ticks.map((tick: any) => [tick.atMs / I, tick.evaluated, tick.status]))
      .toEqual([[10, true, 'green'], [11, false, 'missed-opportunity'],
        [12, false, 'missed-opportunity'], [13, false, 'pending']]);
    expect((await read('other')).sync_delta).toEqual(original);
    await recordSyncCheckDispatchCoverage(sql, [due], 13 * I + 3 * 60_000);
    expect(await read()).toEqual(row);
  });

  it('a stale cursor write and concurrent dispatch preserve each other and an action judgment', async () => {
    await recordSyncCheckDispatchCoverage(sql, [due], 11 * I);
    await Promise.all([
      writeSyncCheckState(sql, scope, 'sync_delta', { ...original, sha: 'completed', coverage: {
        ticks: [...original.coverage.ticks, { atMs: 11 * I, evaluated: true, status: 'green' }],
      } }),
      recordSyncCheckDispatchCoverage(sql, [due], 12 * I),
    ]);
    await writeSyncCheckState(sql, scope, 'sync_delta', { sha: 'next-cursor' });
    const state = (await read()).sync_delta;
    expect(state.sha).toBe('next-cursor');
    expect(state.coverage.ticks.find((tick: any) => tick.atMs === 11 * I))
      .toMatchObject({ evaluated: true, status: 'green' });
    expect(state.coverage.ticks.find((tick: any) => tick.atMs === 12 * I))
      .toMatchObject({ evaluated: false, status: 'pending' });
    expect((await read('other')).sync_delta).toEqual(original);
  });

  it('also protects lint-guard state and does not bootstrap coverage for a routine without a cursor', async () => {
    const lint = { ...scope, name: 'sync-batch-lint-guards' };
    await sql`INSERT INTO harness_shared.routines (id, workspace_id, install_slug, name, metadata)
      VALUES ('lint', ${scope.workspaceId}, ${scope.installSlug}, ${lint.name},
        ${sql.json({ sync_lint_guards: { ...original, guards: { guard: 'passed' } } })})`;
    await recordSyncCheckDispatchCoverage(sql, [{ ...lint, id: 'lint', targetRole: `system:${lint.name}` }], 11 * I);
    await writeSyncCheckState(sql, lint, 'sync_lint_guards', { ...original, guards: { guard: 'new' } });
    expect((await read('lint')).sync_lint_guards).toMatchObject({ guards: { guard: 'new' },
      coverage: { ticks: [original.coverage.ticks[0], { atMs: 11 * I, evaluated: false, status: 'pending' }] } });
    await sql`UPDATE harness_shared.routines SET metadata = '{}'::jsonb WHERE id = 'delta'`;
    await recordSyncCheckDispatchCoverage(sql, [due], 15 * I);
    expect(await read()).toEqual({});
  });
});
