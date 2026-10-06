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

const { emitScorecard, scorecardEmitMutexKey, _closeScorecardEmitMutexForTests } = await import('./emit');
const { proposeRubric, getRubric } = await import('../../rubrics');
const { listScorecards, isCurrentSourceAuditResponder } = await import('../../scorecards');
const { createIssue } = await import('../../issues-engineer');
const { OBSERVATION_TOPIC } = await import('../../harness/improvements/read-items');
const { createOrgTestDb } = await import('../../../test/_org-test-db');
const { activeWorkspaceId } = await import('../../workspace-registry');
const { _resetHarnessAdminUrlCacheForTests } = await import('../../embedded-pg-discovery');

const RUBRIC = 'scorecard-emit-concurrency-regression';
const TIMEOUT_RUBRIC = 'scorecard-emit-lock-timeout-regression';
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
  db = await createOrgTestDb({ adminPoolMax: 8 });
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
  await proposeRubric({
    rubricId: TIMEOUT_RUBRIC,
    characteristic: 'scorecard-emission',
    title: 'Scorecard emit lock-timeout regression',
    criteria: [
      {
        key: 'dedup-safety',
        title: 'Dedup safety',
        model: 'A valid emit waits for an in-flight emitter beyond the role lock timeout.',
        method: 'Hold the dedup advisory lock, then release it after the inherited timeout expires.',
        driftMarkers: 'A valid emit returns lock_timeout instead of waiting for the lock holder.',
      },
    ],
    status: 'active',
    by: OWNER,
  });
  await proposeRubric({
    rubricId: 'grading-integrity',
    characteristic: 'grading-integrity',
    title: 'Grading-integrity concurrency fixture',
    criteria: [
      {
        key: 'audit-correctness',
        title: 'Audit correctness',
        model: 'One pending subject reservation produces one grading-audit card.',
        method: 'Run two direct-fallback audit emitters against the same reserved subject.',
        driftMarkers: 'Multiple persisted grading-audit cards cite one subject reservation.',
      },
    ],
    ratingScale: ['pass', 'fail', 'unknown'],
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
  it('clears inherited lock timeout before waiting for an in-flight emitter', async () => {
    // Configure only this throwaway database so the newly-created dedicated
    // mutex session inherits finite lock and statement timeouts. The current
    // code used to surface 55P03 here after 100ms; the fixed mutex session
    // clears both settings before pg_advisory_lock and waits for release.
    const dbIdent = db.dbName.replaceAll('"', '""');
    await db.adminSql.unsafe(`ALTER DATABASE "${dbIdent}" SET lock_timeout = '100ms'`);
    await db.adminSql.unsafe(`ALTER DATABASE "${dbIdent}" SET statement_timeout = '100ms'`);
    const holder = (await import('postgres')).default(db.adminDsn, { max: 1, onnotice: () => {} });
    const key = scorecardEmitMutexKey({
      workspaceId: activeWorkspaceId(),
      rubricRef: TIMEOUT_RUBRIC,
      sourceHive: SOURCE_HIVE,
    });
    try {
      await holder`SELECT pg_advisory_lock(hashtextextended(${key}, 0))`;
      const emit = emitScorecard(
        { rubricRef: TIMEOUT_RUBRIC, ratings: RATINGS },
        {
          createdBy: OWNER,
          ctxHarness: SOURCE_HIVE,
          workspaceId: activeWorkspaceId(),
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await holder`SELECT pg_advisory_unlock(hashtextextended(${key}, 0))`;
      await expect(emit).resolves.toMatchObject({ ok: true, created: true });
    } finally {
      await holder.end({ timeout: 5 });
      await db.adminSql.unsafe(`ALTER DATABASE "${dbIdent}" RESET lock_timeout`);
      await db.adminSql.unsafe(`ALTER DATABASE "${dbIdent}" RESET statement_timeout`);
    }
  }, 120_000);

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

  it('does not file a second audit when two direct-fallback emitters share one pending lease', async () => {
    console.info('[grading-audit concurrency fixture] starting grading-integrity rubric lookup');
    const auditRubricRead = getRubric('grading-integrity').then(
      (rubric) => ({ status: 'resolved' as const, rubric }),
      (error) => ({ status: 'rejected' as const, error }),
    );
    let rubricReadTimer: ReturnType<typeof setTimeout> | undefined;
    const auditRubricResult = await Promise.race([
      auditRubricRead,
      new Promise<{ status: 'timeout' }>((resolve) => {
        rubricReadTimer = setTimeout(() => resolve({ status: 'timeout' }), 5_000);
      }),
    ]);
    if (rubricReadTimer) clearTimeout(rubricReadTimer);
    console.info(`[grading-audit concurrency fixture] rubric lookup result=${auditRubricResult.status}`);
    if (auditRubricResult.status !== 'resolved') {
      console.info('[grading-audit concurrency fixture] rubric lookup timed out; importing postgres');
      const postgresModule = await import('postgres');
      console.info('[grading-audit concurrency fixture] postgres import resolved');
      const observer = postgresModule.default(db.adminDsn, {
        max: 1,
        connect_timeout: 3,
        onnotice: () => {},
        prepare: false,
        connection: { search_path: 'harness_shared, public' },
      });
      console.info('[grading-audit concurrency fixture] observer client created');
      let activity: unknown[] = [];
      let diagnosticError: string | undefined;
      try {
        activity = await observer`
          SELECT pid, application_name, state, wait_event_type, wait_event,
                 ROUND(EXTRACT(EPOCH FROM (clock_timestamp() - query_start)) * 1000)::integer AS query_age_ms,
                 LEFT(query, 180) AS query_prefix, pg_blocking_pids(pid) AS blocking_pids
            FROM pg_stat_activity
           WHERE datname = current_database()
             AND pid <> pg_backend_pid()
           ORDER BY query_start NULLS LAST
           LIMIT 12
        `;
        console.info(`[grading-audit concurrency fixture] observer query resolved with ${activity.length} rows`);
      } catch (error) {
        diagnosticError = String(error);
        console.info(`[grading-audit concurrency fixture] observer query failed: ${diagnosticError}`);
      } finally {
        console.info('[grading-audit concurrency fixture] closing observer client');
        await observer.end({ timeout: 5 });
        console.info('[grading-audit concurrency fixture] observer client closed');
      }
      const readError = auditRubricResult.status === 'rejected'
        ? `; read error=${String(auditRubricResult.error)}`
        : '';
      throw new Error(`grading-integrity rubric lookup did not resolve in 5s${readError}; pg_stat_activity=${JSON.stringify(activity)}; diagnosticError=${diagnosticError ?? 'none'}`);
    }
    const auditRubric = auditRubricResult.rubric;
    expect(auditRubric?.kind).toBe('standard');
    expect(auditRubric?.criteria.length).toBeGreaterThan(0);
    if (!auditRubric) throw new Error('grading-integrity rubric was not available in the test database');
    expect(auditRubric.ratingScale).toEqual(['pass', 'fail', 'unknown']);

    const reservedAt = new Date().toISOString();
    console.info('[grading-audit concurrency fixture] creating pending source subject');
    const subject = await createIssue({
      title: 'pending grading-audit concurrency subject',
      kind: 'change',
      topics: [OBSERVATION_TOPIC],
      createdBy: 'su-scorecard-concurrency-source',
      payload: {
        observation: {
          rubricRef: RUBRIC,
          rubricRevision: 1,
          criteriaHash: 'source-rubric-hash-v1',
          sourceHive: SOURCE_HIVE,
          ratings: RATINGS,
          gradingAudit: {
            state: 'pending',
            metaRubricRef: 'grading-integrity',
            stampedAt: new Date(Date.now() - 1_000).toISOString(),
            rubricRevision: auditRubric.revision,
            criteriaHash: auditRubric.criteriaHash,
            dispatchReservation: {
              key: 'grading-audit:pending-grading-audit-concurrency-subject',
              reservedAt,
            },
          },
        },
      },
    });
    console.info(`[grading-audit concurrency fixture] source subject created id=${subject.id}`);
    const reservation = {
      key: `grading-audit:${subject.id}`,
      reservedAt,
    };
    console.info('[grading-audit concurrency fixture] persisting dispatch reservation');
    await db.adminSql`
      UPDATE harness_shared.work_items
         SET payload = jsonb_set(
           payload,
           '{observation,gradingAudit,dispatchReservation}',
           ${db.adminSql.json(reservation as never)}::jsonb,
           true
         )
       WHERE feature_id = ${subject.id}
    `;
    console.info('[grading-audit concurrency fixture] verifying persisted dispatch reservation');
    const persistedReservations = await db.adminSql`
      SELECT payload->'observation'->'gradingAudit'->'dispatchReservation' AS reservation
        FROM harness_shared.work_items
       WHERE workspace_id = ${activeWorkspaceId()}
         AND feature_id = ${subject.id}
    `;
    expect(persistedReservations[0]?.reservation).toEqual(reservation);
    console.info('[grading-audit concurrency fixture] dispatch reservation verified');

    const passRatings = Object.fromEntries(
      auditRubric.criteria.map((criterion) => [criterion.key, {
        rating: 'pass',
        evidence: 'replayed the same pending subject before the competing emitter settled',
      }]),
    );
    const failRatings = {
      ...passRatings,
      [auditRubric.criteria[0]!.key]: {
        rating: 'fail',
        evidence: 'the competing verdict intentionally disagrees for the race reproduction',
      },
    };
    let releaseFirstPreflight!: () => void;
    const firstPreflightRelease = new Promise<void>((resolve) => {
      releaseFirstPreflight = resolve;
    });
    let signalFirstPreflight!: () => void;
    const firstPreflightReached = new Promise<void>((resolve) => {
      signalFirstPreflight = resolve;
    });
    let signalSecondPreflight!: () => void;
    const secondPreflightReached = new Promise<void>((resolve) => {
      signalSecondPreflight = resolve;
    });
    let responderCalls = 0;
    const responderBarrier: typeof isCurrentSourceAuditResponder = async (...args) => {
      const eligible = await isCurrentSourceAuditResponder(...args);
      if (!eligible) return false;
      responderCalls += 1;
      if (responderCalls === 1) {
        signalFirstPreflight();
        await firstPreflightRelease;
      } else if (responderCalls === 2) {
        signalSecondPreflight();
      }
      return true;
    };
    const inputFor = (createdBy: string) => ({
      createdBy,
      ctxHarness: SOURCE_HIVE,
      workspaceId: activeWorkspaceId(),
    });
    const argsFor = (ratings: typeof passRatings) => ({
      rubricRef: 'grading-integrity',
      ratings,
      terminal: true,
      subject: { kind: 'scorecard' as const, ref: subject.id },
      gradingAuditReservation: reservation,
    });
    const deps = {
      isCurrentSourceAuditResponder: responderBarrier,
      lineageRelated: async () => false,
    };

    console.info('[grading-audit concurrency fixture] starting first audit emitter');
    const first = emitScorecard(argsFor(passRatings) as never, inputFor('su-audit-concurrency-a'), deps);
    const firstOutcome = first.then(
      (result) => ({ state: 'settled' as const, result }),
      (error) => ({ state: 'rejected' as const, error: String(error) }),
    );
    let firstBarrierTimer: ReturnType<typeof setTimeout> | undefined;
    const firstBarrierState = await Promise.race([
      firstPreflightReached.then(() => ({ state: 'preflight' as const })),
      firstOutcome,
      new Promise<{ state: 'timeout' }>((resolve) => {
        firstBarrierTimer = setTimeout(() => resolve({ state: 'timeout' }), 5_000);
      }),
    ]);
    if (firstBarrierTimer) clearTimeout(firstBarrierTimer);
    console.info(`[grading-audit concurrency fixture] first emitter phase=${firstBarrierState.state}`);
    if (firstBarrierState.state !== 'preflight') {
      releaseFirstPreflight();
      throw new Error(
        `first audit emitter did not reach responder preflight: ${JSON.stringify(firstBarrierState)}`,
      );
    }
    console.info('[grading-audit concurrency fixture] starting second audit emitter');
    const second = emitScorecard(argsFor(failRatings) as never, inputFor('su-audit-concurrency-b'), deps);

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const secondPassedBeforeFirstSettled = await Promise.race([
      secondPreflightReached.then(() => true),
      new Promise<boolean>((resolve) => {
        timeoutHandle = setTimeout(() => resolve(false), 5_000);
      }),
    ]);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    console.info(
      `[grading-audit concurrency fixture] second preflight before first settled=${secondPassedBeforeFirstSettled}`,
    );
    releaseFirstPreflight();
    const results = await Promise.all([first, second]);

    expect(secondPassedBeforeFirstSettled).toBe(false);
    expect(results.filter((result) => result.ok && result.created)).toHaveLength(1);
    const persistedAudits = await listScorecards({
      rubricRef: 'grading-integrity',
      subjectRef: subject.id,
      limit: 10,
    });
    console.info(`[grading-audit concurrency fixture] persisted audit count=${persistedAudits.length}`);
    expect(persistedAudits).toHaveLength(1);
  }, 30_000);
});
