import { afterEach, describe, expect, it } from 'vitest';
import {
  pgResultDiagnosticSnapshot,
  createPgDiagnosticHooks,
  resetPgDiagnosticContextResolver,
  resetAcquireRegistryForTest,
} from '@papercusp/db-org';
import {
  createStageAttempt,
  traceStageAwait,
  withStageAttempt,
} from '../sync/hyperbee/stage-stall-log';
import {
  installDbDiagnosticCorrelationWiring,
  withNamedQueryDiagnosticContext,
  withNamedQueryDiagnosticLeg,
  recordNamedQueryResponse,
} from './db-diagnostic-correlation-wiring';

afterEach(() => {
  resetPgDiagnosticContextResolver();
  resetAcquireRegistryForTest();
});

describe('db diagnostic correlation wiring', () => {
  it('isolates overlapping named requests and captures context before out-of-order completion', async () => {
    installDbDiagnosticCorrelationWiring();
    const hooks = createPgDiagnosticHooks('org-app');
    let releaseFirst!: () => void;
    const paused = new Promise<void>(resolve => { releaseFirst = resolve; });
    const first = withNamedQueryDiagnosticContext('workItems.byHarness', async () => {
      const context = hooks.onquerycontext();
      await paused;
      hooks.onresult({ connectionId: 1, queryId: 1, backendPid: null, query: 'select 1',
        rowCount: 1, wireBytes: 1, status: 'ok', context, result: [] });
      recordNamedQueryResponse('resolvedRows', []);
    });
    await withNamedQueryDiagnosticContext('plans.list', async () => {
      await Promise.resolve();
      hooks.onresult({ connectionId: 1, queryId: 2, backendPid: null, query: 'select 1',
        rowCount: 1, wireBytes: 1, status: 'ok', context: hooks.onquerycontext(), result: [] });
      releaseFirst();
    });
    await first;
    const results = pgResultDiagnosticSnapshot('org-app', 32, { includeObjectRefs: true }).results;
    expect(results.map(r => r.correlation?.operation)).toEqual(['plans.list', 'workItems.byHarness']);
    expect(results[0].correlation?.requestId).not.toBe(results[1].correlation?.requestId);
    expect(results[0].objectRefs?.resolvedRows).toBeUndefined();
    expect(results[1].objectRefs?.resolvedRows).toBeInstanceOf(WeakRef);
    expect(hooks.onquerycontext()).toEqual({ state: 'unobserved' });
  });

  it('preserves an inner stage attempt and the outer request, including rejection cleanup', async () => {
    installDbDiagnosticCorrelationWiring();
    const attempt = createStageAttempt({ rowId: 42, onEvent: () => {} });
    const hooks = createPgDiagnosticHooks('org-app');
    await expect(withNamedQueryDiagnosticContext('workItems.byHarness', async () => {
      await withStageAttempt(attempt, () => traceStageAwait('epoch-query', async () => {
        hooks.onresult({ connectionId: 1, queryId: 1, backendPid: null, query: 'select 1',
          rowCount: 1, wireBytes: 1, status: 'ok', context: hooks.onquerycontext() });
      }));
      throw new Error('resolver failed');
    })).rejects.toThrow('resolver failed');
    attempt.finish();
    expect(pgResultDiagnosticSnapshot('org-app').results[0].correlation).toMatchObject({
      rowId: '42', attemptId: attempt.context.attemptId, stage: 'epoch-query',
      operation: 'workItems.byHarness', requestId: expect.any(String),
    });
    expect(hooks.onquerycontext()).toEqual({ state: 'unobserved' });
  });

  it('carries the active named hop into the existing local result snapshot', () => {
    installDbDiagnosticCorrelationWiring();
    const attempt = createStageAttempt({ rowId: 42, onEvent: () => {} });
    const hooks = createPgDiagnosticHooks('org-app');
    withStageAttempt(attempt, () =>
      traceStageAwait('epoch-query', async () => {
        hooks.onresult({
          connectionId: 7,
          queryId: 23,
          backendPid: 8123,
          query: 'SELECT secret FROM private_table',
          rowCount: 1,
          wireBytes: 12,
          status: 'ok',
          context: hooks.onquerycontext(),
        });
      }),
    );
    attempt.finish();

    const result = pgResultDiagnosticSnapshot('org-app').results[0];
    expect(result).toMatchObject({
      correlationState: 'linked',
      source: {
        processInstanceId: attempt.context.processInstanceId,
      },
      correlation: {
        processInstanceId: attempt.context.processInstanceId,
        buildSha: attempt.context.buildSha,
        rowId: '42',
        attemptId: attempt.context.attemptId,
        hopId: 1,
        stage: 'epoch-query',
        boundary: 'await',
      },
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('distinguishes same-table work-item query legs and preserves the failed leg without SQL text', async () => {
    installDbDiagnosticCorrelationWiring();
    const hooks = createPgDiagnosticHooks('org-app');
    let requestId = '';
    await expect(withNamedQueryDiagnosticContext('workItems.byHarness', async (id) => {
      requestId = id;
      await withNamedQueryDiagnosticLeg('work-items-page', async () => {
        hooks.onresult({
          connectionId: 1, queryId: 1, backendPid: null,
          query: "select * from harness_shared.work_items where note = 'never-retain-page-sql'",
          rowCount: 1, wireBytes: 10, elapsedMs: 21, status: 'ok',
          context: hooks.onquerycontext(),
        });
      });
      await withNamedQueryDiagnosticLeg('work-items-presentation', async () => {
        hooks.onresult({
          connectionId: 1, queryId: 2, backendPid: null,
          query: "select * from harness_shared.work_items where note = 'never-retain-presentation-sql'",
          rowCount: 0, wireBytes: 0, elapsedMs: 6000, status: 'error', errorCode: '57014',
          context: hooks.onquerycontext(),
        });
        throw new Error('presentation query failed');
      });
    })).rejects.toThrow('presentation query failed');

    const rows = pgResultDiagnosticSnapshot('org-app').results;
    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.queryFamily)).toEqual([
      'select:harness_shared.work_items',
      'select:harness_shared.work_items',
    ]);
    expect(rows.map(row => ({
      queryLeg: row.correlation?.queryLeg,
      requestId: row.correlation?.requestId,
      operation: row.correlation?.operation,
      status: row.status,
      errorCode: row.errorCode,
      elapsedMs: row.elapsedMs,
    }))).toEqual([
      { queryLeg: 'work-items-page', requestId, operation: 'workItems.byHarness', status: 'ok', errorCode: null, elapsedMs: 21 },
      { queryLeg: 'work-items-presentation', requestId, operation: 'workItems.byHarness', status: 'error', errorCode: '57014', elapsedMs: 6000 },
    ]);
    expect(JSON.stringify(rows)).not.toContain('never-retain-');
    expect(hooks.onquerycontext()).toEqual({ state: 'unobserved' });
  });

  it('keeps attempt identity while no hop is active, rather than inventing a stage', () => {
    installDbDiagnosticCorrelationWiring();
    const attempt = createStageAttempt({ rowId: 43, onEvent: () => {} });
    const hooks = createPgDiagnosticHooks('org-app');
    withStageAttempt(attempt, () => {
      hooks.onresult({
        connectionId: 8,
        queryId: 24,
        backendPid: null,
        query: 'select 1',
        rowCount: 1,
        wireBytes: 1,
        status: 'ok',
        context: hooks.onquerycontext(),
      });
    });
    attempt.finish();

    expect(pgResultDiagnosticSnapshot('org-app').results[0]).toMatchObject({
      correlationState: 'linked',
      correlation: {
        rowId: '43',
        attemptId: attempt.context.attemptId,
        hopId: null,
        stage: null,
        boundary: null,
      },
    });
  });
});
