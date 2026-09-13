/**
 * scorecards:emit concurrency regression (EI-22580603850046617).
 *
 * The unit emit suites mock `listScorecards` and `captureImprovement`, so they
 * cannot observe the check-then-create race across real database sessions. This
 * Docker-gated test runs two identical emits concurrently against a migrated
 * throwaway Postgres database and reads the persisted history back out. Exactly
 * one call may create a card; the other must see the first card after waiting on
 * the direct session advisory lock and return unchanged-evidence.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';

const h = vi.hoisted(() => ({ sql: null as unknown }));

vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return {
    ...(await orig<typeof import('@papercusp/db-org')>()),
    ...actual,
    getOrgPg: () => ({ sql: h.sql }),
    withWorkspace: async <T>(workspaceId: string, cb: (tx: postgres.Sql) => Promise<T> | T): Promise<T> =>
      (h.sql as postgres.Sql).begin(async (tx) => {
        await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
        return cb(tx as unknown as postgres.Sql);
      }) as Promise<T>,
  };
});

const { emitScorecard, _closeScorecardEmitMutexForTests } = await import('./emit');
const { proposeRubric } = await import('../../rubrics');
const { listScorecards } = await import('../../scorecards');
const { createOrgTestDb } = await import('../../../test/_org-test-db');
const { activeWorkspaceId } = await import('../../workspace-registry');
const { _resetHarnessAdminUrlCacheForTests } = await import('../../embedded-pg-discovery');

const RUBRIC = 'scorecard-emit-concurrency-regression';
const SOURCE_HIVE = 'papercusp';
const OWNER = 'su-scorecard-concurrency';
const RATINGS = {
  'dedup-safety': {
    rating: 'healthy',
    evidence: 'two concurrent emitters must retain one immutable scorecard',
  },
};

let db: Awaited<ReturnType<typeof createOrgTestDb>>;
const SAVED_ADMIN_URL = process.env.HARNESS_ADMIN_DATABASE_URL;
const SAVED_MUTEX_TEST_FLAG = process.env.PAPERCUSP_SCORECARD_EMIT_MUTEX_TEST;

beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.adminSql;
  process.env.HARNESS_ADMIN_DATABASE_URL = db.adminDsn;
  process.env.PAPERCUSP_SCORECARD_EMIT_MUTEX_TEST = '1';
  _resetHarnessAdminUrlCacheForTests();

  await proposeRubric({
    rubricId: RUBRIC,
    characteristic: 'scorecard-emission',
    title: 'Scorecard emit concurrency regression',
    criteria: [
      {
        key: 'dedup-safety',
        title: 'Dedup safety',
        model: 'Concurrent identical emits retain one scorecard.',
        method: 'Run two scorecards:emit calls at once and read the persisted ledger.',
        driftMarkers: 'Two unsuperseded cards with one evidence fingerprint.',
      },
    ],
    status: 'active',
    by: OWNER,
  });
}, 180_000);

afterAll(async () => {
  await _closeScorecardEmitMutexForTests();
  await db?.cleanup();
  _resetHarnessAdminUrlCacheForTests();
  if (SAVED_ADMIN_URL === undefined) delete process.env.HARNESS_ADMIN_DATABASE_URL;
  else process.env.HARNESS_ADMIN_DATABASE_URL = SAVED_ADMIN_URL;
  if (SAVED_MUTEX_TEST_FLAG === undefined) delete process.env.PAPERCUSP_SCORECARD_EMIT_MUTEX_TEST;
  else process.env.PAPERCUSP_SCORECARD_EMIT_MUTEX_TEST = SAVED_MUTEX_TEST_FLAG;
});

describe('scorecards:emit final dedup read-to-write mutex, real PG', () => {
  it('serializes concurrent identical emits and persists exactly one scorecard', async () => {
    const input = {
      createdBy: OWNER,
      ctxHarness: SOURCE_HIVE,
      workspaceId: activeWorkspaceId(),
    };
    const args = { rubricRef: RUBRIC, ratings: RATINGS };

    const results = await Promise.all([
      emitScorecard(args, input),
      emitScorecard(args, input),
    ]);

    expect(results.every((result) => result.ok), JSON.stringify(results, null, 2)).toBe(true);
    expect(results.filter((result) => result.ok && result.created)).toHaveLength(1);
    expect(results.filter((result) => result.ok && !result.created)).toHaveLength(1);
    expect(results.find((result) => result.ok && !result.created)).toMatchObject({
      reason: 'unchanged-evidence',
    });

    const persisted = await listScorecards({
      rubricRef: RUBRIC,
      sourceHive: SOURCE_HIVE,
      limit: 10,
    });
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      rubricRef: RUBRIC,
      sourceHive: SOURCE_HIVE,
      evidenceFingerprint: expect.any(String),
    });
  }, 120_000);
});
