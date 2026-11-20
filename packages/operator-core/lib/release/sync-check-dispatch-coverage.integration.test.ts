import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { COVERAGE_EXPECTED_INTERVAL_MS as I } from './sync-batch-delta-check';
import { recordSyncCheckDispatchCoverage, writeSyncCheckState } from './sync-check-dispatch-coverage';
import { buildSyncBatchDeltaDeps, readSyncDeltaKnownGood } from './sync-batch-delta-check-deps';
import { buildSyncLintGuardDeps } from './sync-batch-lint-guards-deps';
import { runSyncLintGuardTick, type SyncLintGuardDeps, type SyncLintGuardState } from './sync-batch-lint-guards';

vi.mock('@papercusp/db-org', async importOriginal => ({
  ...(await importOriginal<object>()),
  getOrgPg: () => ({ sql: bindingSql ?? sql }),
}));

let sql: postgres.Sql;
let bindingSql: postgres.Sql | undefined;
let databaseUrl: string;
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
  databaseUrl = url.toString();
  sql = postgres(databaseUrl, { max: 3, onnotice: () => {} });
  await sql`CREATE SCHEMA harness_shared`;
  await sql`CREATE TABLE harness_shared.routines (
    id text PRIMARY KEY, workspace_id text, install_slug text, name text,
    active boolean DEFAULT true, metadata jsonb DEFAULT '{}'::jsonb)`;
});
afterAll(async () => { await sql?.end({ timeout: 5 }); });
beforeEach(async () => {
  bindingSql = undefined;
  await sql`TRUNCATE harness_shared.routines`;
  for (const workspace of ['coverage-owner', 'other-workspace']) {
    await sql`INSERT INTO harness_shared.routines (id, workspace_id, install_slug, name, metadata)
      VALUES (${workspace === scope.workspaceId ? 'delta' : 'other'}, ${workspace}, ${scope.installSlug},
        ${scope.name}, ${sql.json({ sibling: 'keep', sync_delta: original })})`;
  }
});
const read = async (id = 'delta') => (await sql`SELECT metadata FROM harness_shared.routines WHERE id = ${id}`)[0]!.metadata;

describe('source-check dispatch/completion private PostgreSQL runtime', () => {
  it.each([false, true])('production readers and writers fence workspace identity (foreign first: %s)', async foreignFirst => {
    await sql`TRUNCATE harness_shared.routines`;
    const owners = foreignFirst ? ['other-workspace', scope.workspaceId] : [scope.workspaceId, 'other-workspace'];
    for (const name of [scope.name, 'sync-batch-lint-guards']) {
      for (const workspace of owners) {
        const sha = workspace === scope.workspaceId ? 'owner' : 'foreign';
        await sql`INSERT INTO harness_shared.routines (id, workspace_id, install_slug, name, metadata)
          VALUES (${`${name}:${workspace}`}, ${workspace}, ${scope.installSlug}, ${name},
            ${sql.json({ sync_delta: { sha, updatedAtMs: 1 }, sync_lint_guards: { sha, atMs: 1, guards: {} } })})`;
      }
    }
    const cfg = { workspaceId: scope.workspaceId, installSlug: scope.installSlug, root: '/repo/root', branch: 'staging' };
    const delta = buildSyncBatchDeltaDeps(cfg);
    const lint = buildSyncLintGuardDeps(cfg);
    const [cursor, guard] = await Promise.all([delta.readCursor(), lint.readGuardState()]);
    expect({ delta: cursor?.sha, lint: guard?.sha }).toEqual({ delta: 'owner', lint: 'owner' });
    await delta.writeCursor({ ...cursor!, sha: 'owner-next' });
    await lint.writeGuardState({ ...guard!, sha: 'owner-next' });
    const rows = await sql`SELECT workspace_id, name, metadata FROM harness_shared.routines`;
    for (const row of rows) {
      const field = row.name === scope.name ? 'sync_delta' : 'sync_lint_guards';
      const sibling = field === 'sync_delta' ? 'sync_lint_guards' : 'sync_delta';
      expect(row.metadata[field].sha).toBe(row.workspace_id === scope.workspaceId ? 'owner-next' : 'foreign');
      expect(row.metadata[sibling].sha).toBe(row.workspace_id === scope.workspaceId ? 'owner' : 'foreign');
    }
  });

  it.each([399, 400, 401])('retains and consumes the full %i-offender JSONB inventory across connection restarts', async count => {
    const script = 'lint:no-raw-setinterval';
    const lintScope = { ...scope, name: 'sync-batch-lint-guards' };
    const known = 'apps/old/known.ts';
    const paths = Array.from({ length: count }, (_, index) => `apps/new/file-${index}.ts`);
    paths[count - 1] = `apps/new/${'last'.repeat(450)}.ts`;
    const initial = { sha: 'before', atMs: 1, guards: {
      [script]: { status: 'fail', sha: 'before', atMs: 1, offenders: [known], offendersTruncated: true },
    } } satisfies SyncLintGuardState;
    await sql`INSERT INTO harness_shared.routines (id, workspace_id, install_slug, name, metadata)
      VALUES ('lint', ${scope.workspaceId}, ${scope.installSlug}, ${lintScope.name},
        ${sql.json({ sibling: 'keep', sync_lint_guards: initial })})`;
    const filed: string[] = [];
    const budget = 127;
    let guardCalls = 0;
    const rounds = Math.ceil(count / budget);
    for (let pass = 0; pass <= rounds; pass += 1) {
      const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });
      bindingSql = client;
      try {
        const io = buildSyncLintGuardDeps({ workspaceId: scope.workspaceId,
          installSlug: scope.installSlug, root: '/repo/root', branch: 'staging' });
        const deps: SyncLintGuardDeps = { ...io,
          hostLoad: () => ({ load1: 0, cores: 100 }), greenCheckpointRunning: async () => false,
          headSha: async () => 'after', listBatches: async () => [], lookupEditors: async () => [],
          now: () => 1_000_000, log: () => {},
          runGuard: async () => {
            guardCalls += 1;
            const current = pass % 2 ? [...paths].reverse() : paths;
            return { exitCode: 1, output: ['guard failed', known, ...current].join('\n') };
          },
          fileRed: async finding => {
            expect(finding.body).toContain('Newness: unknown');
            filed.push(finding.conditionKey);
            return { ok: true, id: `WI-${filed.length}` };
          },
        };
        const result = await runSyncLintGuardTick(deps, { scripts: [script], maxFilings: budget });
        const restored = await io.readGuardState();
        expect(new Set(restored?.guards[script]?.offenders)).toEqual(new Set([known, ...paths]));
        expect(restored?.guards[script]?.pendingViolations ?? []).toHaveLength(count - filed.length);
        if (pass === rounds) expect(result.status).toBe('up-to-date');
        expect((await read('lint')).sibling).toBe('keep');
      } finally {
        bindingSql = undefined;
        await client.end({ timeout: 5 });
      }
    }
    expect(guardCalls).toBe(rounds);
    expect(filed).toHaveLength(count);
    expect(new Set(filed)).toEqual(new Set(paths.map(path => `sync-delta-guard:${script}:${path}`)));
  });

  it.each([true, false])('reads known-good commits only from the requested workspace (foreign first: %s)', async foreignFirst => {
    await sql`TRUNCATE harness_shared.routines`;
    const ownSha = '1'.repeat(40);
    const foreignSha = '2'.repeat(40);
    const workspaces = foreignFirst ? ['other-workspace', scope.workspaceId] : [scope.workspaceId, 'other-workspace'];
    for (const workspace of workspaces) {
      const sha = workspace === scope.workspaceId ? ownSha : foreignSha;
      await sql`INSERT INTO harness_shared.routines (id, workspace_id, install_slug, name, metadata)
        VALUES (${workspace}, ${workspace}, ${scope.installSlug}, ${scope.name},
          ${sql.json({ sync_delta: { lastPassed: { sha } } })})`;
    }
    expect(await readSyncDeltaKnownGood(scope.workspaceId, scope.installSlug)).toBe(ownSha);
    expect(await readSyncDeltaKnownGood('other-workspace', scope.installSlug)).toBe(foreignSha);
    expect(await readSyncDeltaKnownGood('missing-workspace', scope.installSlug)).toBeNull();
    await sql`DELETE FROM harness_shared.routines WHERE workspace_id = ${scope.workspaceId}`;
    expect(await readSyncDeltaKnownGood(scope.workspaceId, scope.installSlug)).toBeNull();
  });

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
