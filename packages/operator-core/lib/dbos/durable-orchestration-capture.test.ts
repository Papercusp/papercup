// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureDurableProcessBoundary, composeDurableCaptureCensus, createDurableCaptureRecorder, materializeDurableCapture, reconstructDurableCapture,
  retainDurableCapture, reviewedDurableDbosSqlWrites, reviewedDurableDbosSql, reviewedDurableFixturePayloadSql } from '../../test/_durable-orchestration-capture';
import type { GroundedCensus, GroundedInvocation, GroundedMeasurementScope, GroundedSqlObservation } from '../grounded-evidence-measurement';

const directories: string[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'durable-capture-'));
  directories.push(directory);
  const path = join(directory, 'capture.json');
  const original = '{"pending":["original-admission"],"boundary":null}';
  writeFileSync(path, original);
  return { directory, path, original };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('source-reviewed DBOS nonpersisting SQL', () => {
  const crashFixtureHash = '23fa4c6dcd82d6f6ac946c58ff88eea5af278454afc69a8c16ddf879a4cff6a8';
  const sources = {
    systemDatabase: 'de943d85e4414114a6bb01b079051b0e59940a4911cf9e54f05e41f24011b02b',
    databaseUtils: 'deff0db24fad793b10ad21314a8333c2b4398e4c26c25a6cedd8e24fbff54ca4',
    migrationRunner: 'e843709372e77cd6151bf35345ceca0d7307a87182a57c867bfead4fa7d830f5',
  };
  it('requires each actual installed writer pin and returns independent registration copies', () => {
    for (const [name, file] of [['systemDatabase', 'system_database.js'], ['databaseUtils', 'database_utils.js'],
      ['migrationRunner', 'sysdb_migrations/migration_runner.js']] as const) {
      expect(createHash('sha256').update(readFileSync(new URL(
        '../../../../node_modules/@dbos-inc/dbos-sdk/dist/src/' + file, import.meta.url))).digest('hex')).toBe(sources[name]);
    }
    const original = reviewedDurableDbosSql(sources);
    expect(original).toHaveLength(23);
    expect(new Set(original.map(row => row.queryHash)).size).toBe(original.length);
    expect(original.every(row => row.status === 'ok' && ['read', 'control'].includes(row.kind))).toBe(true);
    original[0]!.queryHash = 'changed';
    expect(reviewedDurableDbosSql(sources)[0]!.queryHash).not.toBe('changed');
    expect(reviewedDurableDbosSql({})).toEqual([]);
    for (const key of Object.keys(sources) as Array<keyof typeof sources>) {
      const changed = reviewedDurableDbosSql({ ...sources, [key]: 'unreviewed-source' });
      expect(changed).toEqual(reviewedDurableDbosSql(sources).filter(row => !row.sourceRef.includes(sources[key])));
    }
  });

  it('requires the exact fixture writer for effect-log count reads', () => {
    expect(createHash('sha256').update(readFileSync(new URL(
      '../../test/_durable-orchestration-crash-child.ts', import.meta.url))).digest('hex')).toBe(crashFixtureHash);
    const statement = 'SELECT count(*)::int AS n FROM test_durable.calls WHERE run_key = $1';
    expect(reviewedDurableDbosSql({ crashFixture: crashFixtureHash })).toEqual([{
      queryHash: createHash('sha256').update(statement).digest('hex'), kind: 'read', command: 'SELECT', status: 'ok',
      sourceRef: `source:packages/operator-core/test/_durable-orchestration-crash-child.ts@${crashFixtureHash}#probeTool:effect-count`,
    }]);
    expect(reviewedDurableDbosSql({ crashFixture: 'changed-source' })).toEqual([]);
  });

  it('measures the original fixture payload once and refuses unqualified write outcomes', async () => {
    const { observeGroundedStoreOperations } = await import('../grounded-evidence-measurement');
    const connectionHash = createHash('sha256').update(readFileSync(new URL(
      '../../../../node_modules/postgres/src/connection.js', import.meta.url))).digest('hex');
    const typesHash = createHash('sha256').update(readFileSync(new URL(
      '../../../../node_modules/postgres/src/types.js', import.meta.url))).digest('hex');
    const serializerSourceRef = `source:postgres/src/connection.js@${connectionHash}+types.js@${typesHash}#Bind`;
    const statement = 'INSERT INTO test_durable.calls (run_key, tool, mode, args, idempotency_key) VALUES ($1, $2, $3, $4, $5)';
    const registrations = reviewedDurableFixturePayloadSql(crashFixtureHash, serializerSourceRef);
    expect(registrations).toHaveLength(1);
    expect(registrations[0]!.queryHash).toBe(createHash('sha256').update(statement).digest('hex'));
    expect(reviewedDurableFixturePayloadSql('changed-writer', serializerSourceRef)).toEqual([]);
    expect(reviewedDurableFixturePayloadSql(crashFixtureHash, serializerSourceRef + '-changed-driver')).toEqual([]);
    const scope: GroundedMeasurementScope = { workspaceId: 'w', harness: 'h', potId: 'p', runId: 'r',
      ownerId: 'effect-payload', caseId: 'C5', arm: 'pre', iteration: 1, manifestHash: 'm', fixtureHash: 'f',
      sourceFingerprint: 's', testFingerprint: 't', runtimeFingerprint: 'r', configFingerprint: 'c' };
    let serializations = 0;
    const args = { toJSON() { serializations++; return { original: 'λ.😺' }; } };
    const payload = JSON.stringify(args);
    const opaque = { toJSON() { throw new Error('second serialization'); } };
    for (const control of ['original', 'zero', 'partial', 'missing-count', 'wrong-command', 'error',
      'changed-sql', 'wrong-arity', 'not-serialized', 'simple', 'not-executed', 'pending'] as const) {
      const client = { options: {} } as unknown as import('postgres').Sql;
      const tap = observeGroundedStoreOperations({ scope, deps: {}, operations: [], sourceRef: 'fixture-payload',
        attemptId: control, postgres: [{ pool: 'child-effect-log', client }], serializedSqlParameters: registrations });
      try {
        const query = { executed: control !== 'not-executed', options: { simple: control === 'simple' },
          statement: { string: statement }, parameters: control === 'wrong-arity' ? [payload]
            : ['run', 'probe:put', 'recover', control === 'not-serialized' ? opaque : payload, null] };
        const context = tap.run(() => client.options.onquerycontext!(query));
        const command = control === 'wrong-command' ? 'UPDATE' : 'INSERT';
        if (control !== 'pending') client.options.onresult!({ context, queryId: 1,
          query: statement + (control === 'changed-sql' ? ' ' : ''), command,
          status: control === 'error' ? 'error' : 'ok', wireBytes: 999999,
          result: { command, count: control === 'missing-count' ? null : control === 'zero' ? 0 : control === 'partial' ? 2 : 1 },
        } as import('postgres').QueryResultDiagnostic);
        const capture = tap.seal();
        expect(serializations).toBe(1);
        if (control === 'pending') { expect(capture.complete).toBe(false); expect(capture.rows).toEqual([]); }
        else expect(capture.rows[0]!.persistedBytes, control)
          .toBe(control === 'original' ? Buffer.byteLength(payload) : control === 'zero' ? 0 : null);
        if (control === 'original') expect(capture.rows[0]!.sql?.serializedParameters?.values)
          .toEqual([{ parameter: 3, sha256: createHash('sha256').update(payload).digest('hex'), bytes: Buffer.byteLength(payload) }]);
      } finally { tap.restore(); }
    }
  });

  it('qualifies exact successful reads and leaves changed SQL, errors and writes unknown', async () => {
    const { observeGroundedStoreOperations } = await import('../grounded-evidence-measurement');
    class Query {
      _results = { command: 'SELECT', rowCount: 1 };
      values: unknown[] = [];
      constructor(readonly text: string) {}
      submit(connection: { bind(config: { values: unknown[]; valueMapper(value: unknown, index: number): unknown }): void }) {
        connection.bind({ values: this.values, valueMapper: value => value });
      }
      handleReadyForQuery() {}
      handleError(error: Error) { return error; }
    }
    class Client { query(text: string) {
      const query = new Query(text);
      query.submit({ bind: config => { config.values.forEach((value, index) => config.valueMapper(value, index)); } });
      return query;
    } }
    const scope = { workspaceId: 'w', harness: 'h', potId: 'p', runId: 'r', ownerId: 'sql-control', caseId: 'C5',
      arm: 'pre' as const, iteration: 1, manifestHash: 'm', fixtureHash: 'f', sourceFingerprint: 's',
      testFingerprint: 't', runtimeFingerprint: 'r', configFingerprint: 'c' };
    const tap = observeGroundedStoreOperations({ scope, deps: {}, operations: [], sourceRef: 'test:reviewed-sql',
      attemptId: 'reviewed', nodePostgres: [{ pool: 'dbos', clientPrototype: Client.prototype,
        queryPrototype: Query.prototype, serializerSourceRef: 'unused-no-bind' }],
      nonPersistingSql: reviewedDurableDbosSql({ ...sources, crashFixture: crashFixtureHash }) });
    try {
      const client = new Client(), statement = 'SELECT 1 FROM pg_database WHERE datname = $1';
      const fixtureCount = 'SELECT count(*)::int AS n FROM test_durable.calls WHERE run_key = $1';
      for (const [sql, fault] of [[statement, ''], [statement + ' ', ''], ['SELECT side_effect()', ''],
        [statement, 'error'], ['UPDATE dbos.workflow_status SET status=$1', 'write'],
        [fixtureCount, ''], [fixtureCount + ' ', ''], [fixtureCount, 'error'],
        ['INSERT INTO test_durable.calls (args) VALUES ($1)', 'write']] as const) {
        const query = tap.run(() => client.query(sql));
        if (fault === 'error') query.handleError(new Error('original-query-error'));
        else { if (fault === 'write') query._results.command = 'UPDATE'; query.handleReadyForQuery(); }
      }
      const capture = tap.seal();
      expect(capture.complete).toBe(true);
      expect(capture.rows.map(row => [row.kind, row.persistedBytes]))
        .toEqual([['read', null], ['unknown', null], ['unknown', null], ['unknown', null], ['unknown', null],
          ['read', null], ['unknown', null], ['unknown', null], ['unknown', null]]);
    } finally { tap.restore(); }
  });

  it('qualifies original application-name claim bytes while keeping other positive SDK writes unknown', async () => {
    const { observeGroundedStoreOperations } = await import('../grounded-evidence-measurement');
    const serializerSourceRef = 'source:actual-driver-Bind';
    const registrations = reviewedDurableDbosSqlWrites(sources.systemDatabase, serializerSourceRef);
    expect(registrations).toHaveLength(6);
    expect(new Set(registrations.map(row => row.queryHash)).size).toBe(6);
    expect(registrations.filter(row => row.allOrNoneRows === 'zero-only')).toHaveLength(5);
    expect(registrations.filter(row => row.allOrNoneRows === 1).map(row => row.sourceRef))
      .toEqual([expect.stringContaining('#createApplicationVersion:claim')]);
    expect(reviewedDurableDbosSqlWrites('changed-source', serializerSourceRef)).toEqual([]);
    expect(reviewedDurableDbosSqlWrites(sources.systemDatabase, '')).toEqual([]);
    class Query {
      _results: { command: string; rowCount: number | null } = { command: 'UPDATE', rowCount: 0 };
      constructor(readonly text: string, readonly values: unknown[]) {}
      submit(connection: { bind(config: { values: unknown[]; valueMapper(value: unknown, index: number): unknown }): void }) {
        connection.bind({ values: this.values, valueMapper: value => value });
      }
      handleReadyForQuery() {}
      handleError(error: Error) { return error; }
    }
    class Client { query(text: string, values: unknown[]) {
      const query = new Query(text, values);
      query.submit({ bind: config => { config.values.forEach((value, index) => config.valueMapper(value, index)); } });
      return query;
    } }
    const scope: GroundedMeasurementScope = { workspaceId: 'w', harness: 'h', potId: 'p', runId: 'r',
      ownerId: 'sql-noop', caseId: 'C5', arm: 'pre', iteration: 1, manifestHash: 'm', fixtureHash: 'f',
      sourceFingerprint: 's', testFingerprint: 't', runtimeFingerprint: 'r', configFingerprint: 'c' };
    const statement = `UPDATE "dbos".application_versions
         SET application_name = $1
         WHERE version_name = $2 AND application_name IS NULL`;
    const run = (registeredSerializer: string) => {
      const tap = observeGroundedStoreOperations({ scope, deps: {}, operations: [], sourceRef: 'test:zero-only',
        attemptId: registeredSerializer, nodePostgres: [{ pool: 'child-dbos-all-clients',
          clientPrototype: Client.prototype, queryPrototype: Query.prototype, serializerSourceRef }],
        serializedSqlParameters: reviewedDurableDbosSqlWrites(sources.systemDatabase, registeredSerializer) });
      try {
        const client = new Client();
        for (const fault of ['zero', 'positive', 'partial', 'missing-count', 'error', 'changed-sql', 'wrong-arity', 'wrong-command']) {
          const query = tap.run(() => client.query(statement + (fault === 'changed-sql' ? ' ' : ''),
            fault === 'wrong-arity' ? ['é🧪'] : ['é🧪', 'version']));
          if (fault === 'positive') query._results.rowCount = 1;
          if (fault === 'partial') query._results.rowCount = 2;
          if (fault === 'missing-count') query._results.rowCount = null;
          if (fault === 'wrong-command') query._results.command = 'INSERT';
          if (fault === 'error') query.handleError(new Error('actual-terminal-error'));
          else query.handleReadyForQuery();
        }
        // This writer additionally persists server defaults. Even a successful
        // one-row insert cannot inherit the claim's positive-byte contract.
        const insert = tap.run(() => client.query(`INSERT INTO "dbos".application_versions (version_id, version_name, application_name)
           VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`, ['id', 'version', 'é🧪']));
        insert._results = { command: 'INSERT', rowCount: 1 };
        insert.handleReadyForQuery();
        return tap.seal();
      } finally { tap.restore(); }
    };
    const capture = run(serializerSourceRef);
    expect(capture.complete).toBe(true);
    expect(capture.rows.map(row => row.persistedBytes)).toEqual([0, Buffer.byteLength('é🧪'), null, null, null, null, null, null, null]);
    expect(capture.rows[0]).toMatchObject({ kind: 'write', sql: {
      rowOutcome: { allOrNoneRows: 1, affectedRows: 0 },
      serializedParameters: { parameterCount: 2, serializerSourceRef,
        values: [{ parameter: 0, bytes: Buffer.byteLength('é🧪') }] } } });
    expect(capture.rows[1]).toMatchObject({ kind: 'write', sql: {
      rowOutcome: { allOrNoneRows: 1, affectedRows: 1 },
      serializedParameters: { values: [{ parameter: 0, sha256: createHash('sha256').update('é🧪').digest('hex'),
        bytes: Buffer.byteLength('é🧪') }] } } });
    expect(capture.rows.at(-1)).toMatchObject({ kind: 'write', sql: { rowOutcome: { allOrNoneRows: 'zero-only', affectedRows: 1 } } });
    const changedDriver = run('source:changed-driver');
    expect(changedDriver.complete).toBe(true);
    expect(changedDriver.rows.every(row => row.persistedBytes === null)).toBe(true);
  });
});

it('keeps unknown backend identities explicit and pins queued query identity before a failed terminal', async () => {
  const { observeGroundedStoreOperations } = await import('../grounded-evidence-measurement');
  class Query {
    _results = { command: 'UPDATE', rowCount: 1 };
    values: unknown[] = [];
    constructor(readonly text: string) {}
    submit(connection: { bind(config: { values: unknown[]; valueMapper(value: unknown, index: number): unknown }): void }) {
      connection.bind({ values: this.values, valueMapper: value => value });
    }
    handleReadyForQuery() {}
    handleError(error: Error) { return error; }
  }
  class Client {
    processID: unknown = null;
    _queryQueue: Query[] = [];
    query(text: string) { const query = new Query(text); this._queryQueue.push(query); return query; }
    submit() { const query = this._queryQueue.shift()!;
      query.submit({ bind: config => { config.values.forEach((value, index) => config.valueMapper(value, index)); } });
      return query;
    }
  }
  const scope: GroundedMeasurementScope = { workspaceId: 'w', harness: 'h', potId: 'p', runId: 'r',
    ownerId: 'backend-control', caseId: 'C5', arm: 'pre', iteration: 1, manifestHash: 'm', fixtureHash: 'f',
    sourceFingerprint: 's', testFingerprint: 't', runtimeFingerprint: 'r', configFingerprint: 'c' };
  const observations: GroundedSqlObservation[] = [];
  const tap = observeGroundedStoreOperations({ scope, deps: {}, operations: [], sourceRef: 'test:backend-identity',
    attemptId: 'backend-control', nodePostgres: [{ pool: 'dbos', clientPrototype: Client.prototype,
      queryPrototype: Query.prototype, serializerSourceRef: 'original-driver' }],
    onSqlObservation: observation => observations.push(observation) });
  try {
    const first = new Client(), second = new Client();
    const failed = tap.run(() => first.query('UPDATE original_writer SET value = clock_timestamp()'));
    const other = tap.run(() => second.query('UPDATE original_writer SET value = clock_timestamp()'));
    first.processID = 321; second.processID = 654;
    first.submit(); second.submit();
    // A later mutation of the Client cannot rewrite the already submitted
    // query's identity, including when a different Client terminates first.
    first.processID = 999;
    other.handleReadyForQuery();
    const error = new Error('actual failed terminal');
    expect(failed.handleError(error)).toBe(error);
    for (const invalid of [undefined, null, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '321']) {
      const client = new Client(); client.processID = invalid;
      const query = tap.run(() => client.query('UPDATE original_writer SET value = clock_timestamp()'));
      client.submit(); query.handleReadyForQuery();
    }
    const census = tap.seal();
    expect(census.complete).toBe(true);
    expect(census.rows.slice(0, 2).map(row => row.sql?.backendProcessId)).toEqual([654, 321]);
    expect(census.rows.slice(2).every(row => row.sql?.backendProcessId === null)).toBe(true);
    expect(census.rows.every(row => row.kind === 'unknown' && row.persistedBytes === null)).toBe(true);
    const failedId = census.rows[1]!.id;
    expect(observations.filter(row => row.id === failedId).map(row => [row.phase, row.backendProcessId]))
      .toEqual([['admission', null], ['submit', 321], ['terminal', 321]]);
    expect(observations.find(row => row.id === failedId && row.phase === 'terminal')?.status).toBe('error');
    for (const row of census.rows.slice(2)) expect(observations.filter(observation => observation.id === row.id))
      .toEqual(expect.arrayContaining([expect.objectContaining({ phase: 'submit', backendProcessId: null }),
        expect.objectContaining({ phase: 'terminal', backendProcessId: null })]));
  } finally { tap.restore(); }
});

describe('parent-owned durable process boundary', () => {
  const scope: GroundedMeasurementScope = { workspaceId: 'w', harness: 'h', potId: 'p', runId: 'r',
    ownerId: 'capture-unit', caseId: 'J3', arm: 'pre', iteration: 1, manifestHash: 'manifest', fixtureHash: 'fixture',
    sourceFingerprint: 'source', testFingerprint: 'test', runtimeFingerprint: 'runtime', configFingerprint: 'config' };
  function child(path: string, fault: string) {
    const source = `
      import fs from 'node:fs';
      const { createDurableCaptureRecorder } = await import(process.env.CAPTURE_MODULE);
      const scope = JSON.parse(process.env.CAPTURE_SCOPE), fault = process.env.CAPTURE_FAULT;
      const census = () => ({ scope, sourceRef: process.env.CAPTURE_PATH, complete: false,
        ids: ['returned', 'pending'], rows: [{ id: 'returned', source: 'live' }] });
      const capture = { processId: process.pid, boundary: null, census: census(), invocations: census(), storage: census(),
        processTermination: { pid: process.pid, signal: 'SIGKILL' } };
      if (fault === 'foreign') capture.storage.scope = { ...scope, ownerId: 'foreign' };
      if (fault === 'unannounced') capture.processTermination = null;
      if (fault === 'wrong-pid') capture.processTermination.pid++;
      if (fault.includes('foreign-process')) capture.processId++;
      if (fault === 'loss') capture.invocations.diagnostics = { captureFailed: true };
      if (fault === 'orphan') capture.storage.rows.push({ id: 'orphan' });
      if (fault.startsWith('exit')) {
        capture.boundary = { scope, sourceRef: process.env.CAPTURE_PATH, drained: true };
        for (const key of ['census', 'invocations', 'storage']) {
          capture[key].complete = true;
          if (fault !== 'exit-gap') capture[key].rows.push({ id: 'pending' });
        }
      }
      createDurableCaptureRecorder(process.env.CAPTURE_PATH).retain(capture);
      if (fault === 'partial') fs.appendFileSync(process.env.CAPTURE_PATH + '.journal', '{"partial":');
      if (!fault.startsWith('exit')) process.kill(process.pid, 'SIGKILL');
    `;
    return spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
      cwd: new URL('../..', import.meta.url), timeout: 20_000, encoding: 'utf8',
      env: { ...process.env, CAPTURE_PATH: path, CAPTURE_FAULT: fault, CAPTURE_SCOPE: JSON.stringify(scope),
        CAPTURE_MODULE: new URL('../../test/_durable-orchestration-capture.ts', import.meta.url).href },
    });
  }

  it.each(['kill', 'exit'])('records independent %s costs without changing or sealing the child snapshot', fault => {
    const { path, original } = fixture();
    const { child: result, processCapture } = captureDurableProcessBoundary(path, scope, () => child(path, fault));
    expect(result.error, result.stderr).toBeUndefined();
    expect(processCapture).toMatchObject({ complete: true, gaps: [], acceptance: 'unmeasured',
      terminal: fault === 'kill' ? 'intentional-sigkill' : 'drained-exit',
      values: { durableAdmissions: 2, dispatchAdmissions: 2, storageAdmissions: 2 } });
    expect(processCapture.values.processWallMs).toBeGreaterThan(0);
    expect(processCapture.values.recorderJournalBytes).toBe(statSync(path + '.journal').size);
    expect(processCapture.populations.storage!.unreturnedIds).toEqual(fault === 'kill' ? ['pending'] : []);
    expect(readFileSync(path, 'utf8')).toBe(original);
    const tape = readFileSync(path + '.journal');
    expect(reconstructDurableCapture(path).census).toMatchObject({ complete: fault === 'exit' });
    expect(readFileSync(path + '.journal')).toEqual(tape);
    expect(JSON.parse(readFileSync(path + '.process.json', 'utf8'))).toEqual(processCapture);
    expect(statSync(path + '.process.json').mode & 0o777).toBe(0o600);
    const launch = vi.fn();
    expect(() => captureDurableProcessBoundary(path, scope, launch)).toThrow();
    expect(launch).not.toHaveBeenCalled();
  });

  it.each(['foreign', 'unannounced', 'wrong-pid', 'loss', 'orphan', 'partial',
    'foreign-process', 'exit-foreign-process', 'exit-gap'])
  ('retains the actual death and fails qualification after %s', fault => {
    const { path } = fixture();
    const { child: result, processCapture } = captureDurableProcessBoundary(path, scope, () => child(path, fault));
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.signal).toBe(fault.startsWith('exit') ? null : 'SIGKILL');
    expect(processCapture.complete).toBe(false);
    expect(processCapture.gaps.length).toBeGreaterThan(0);
    expect(processCapture.values.durableAdmissions).toBeNull();
    expect(processCapture.values.dispatchAdmissions).toBeNull();
    expect(processCapture.values.storageAdmissions).toBeNull();
    expect(processCapture.values.processWallMs).toBeGreaterThan(0);
    if (!fault.startsWith('exit')) expect(reconstructDurableCapture(path).boundary).toBeNull();
  });

  it('retains a launch exception and preserves its identity', () => {
    const { path } = fixture(), failure = new Error('original-launch-error');
    expect(() => captureDurableProcessBoundary(path, scope, () => { throw failure; })).toThrow(failure);
    expect(JSON.parse(readFileSync(path + '.process.json', 'utf8'))).toMatchObject({
      state: 'launch-threw', complete: false, error: failure.message });
  });
});

it('retains unregistered original Bind inputs before a terminal without qualifying pending or failed writes', async () => {
  const { observeGroundedStoreOperations, GROUNDED_MANIFEST_SHA256 } = await import('../grounded-evidence-measurement');
  const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
  class Query {
    _results = { command: 'INSERT' };
    constructor(readonly text: string, readonly values: unknown[]) {}
    submit(connection: { bind(config: { values: unknown[]; valueMapper(value: unknown, index: number): unknown }): void }) {
      connection.bind({ values: this.values, valueMapper: value => value === null ? null : Buffer.isBuffer(value)
        ? value : typeof value === 'object' ? JSON.stringify(value) : String(value) });
    }
    handleReadyForQuery() { return this._results; }
    handleError(error: Error) { return error; }
  }
  class Client {
    _queryQueue: Query[] = [];
    query(text: string, values: unknown[]) { const query = new Query(text, values); this._queryQueue.push(query); return query; }
    submit() { const query = this._queryQueue.shift()!;
      query.submit({ bind: config => { config.values.forEach((value, index) => config.valueMapper(value, index)); } }); return query; }
  }
  const scope: GroundedMeasurementScope = { workspaceId: 'bind-control', harness: 'bind-control', potId: 'bind-control',
    runId: 'bind-control', ownerId: 'bind-control', caseId: 'C5', arm: 'pre', iteration: 1,
    manifestHash: GROUNDED_MANIFEST_SHA256, fixtureHash: 'bind-control', sourceFingerprint: 'bind-control',
    testFingerprint: 'bind-control', runtimeFingerprint: 'bind-control', configFingerprint: 'bind-control' };
  const retained: Array<ReturnType<ReturnType<typeof observeGroundedStoreOperations>['snapshot']>> = [];
  const tap = observeGroundedStoreOperations({ scope, deps: {}, operations: [], sourceRef: 'test:unregistered-bind',
    attemptId: 'unregistered', nodePostgres: [{ pool: 'dbos', clientPrototype: Client.prototype,
      queryPrototype: Query.prototype, serializerSourceRef: 'source:original-mapper' }],
    onObservation: (): void => { retained.push(tap.snapshot()); } });
  const client = new Client(), statement = 'INSERT INTO unreviewed VALUES ($1, $2)';
  let serializations = 0;
  try {
    const first = tap.run(() => client.query(statement, [{ toJSON: () => ({ original: `λ.${++serializations}` }) }, null]));
    const failed = tap.run(() => client.query(statement, ['failed', null]));
    const pending = tap.run(() => client.query(statement, [Buffer.from('λ.😺'), null]));
    tap.run(() => client.query(statement, ['queued', null]));
    client.submit();
    const beforeTerminal = retained.at(-1)!;
    expect(beforeTerminal.rows).toEqual([]);
    expect(beforeTerminal.diagnostics.pending).toBe(4);
    expect(beforeTerminal.diagnostics.admissions[0]!.boundParameters).toEqual({
      serializerSourceRef: 'source:original-mapper', parameterCount: 2, complete: true, values: [
        { parameter: 0, sha256: digest('{"original":"λ.1"}'), bytes: Buffer.byteLength('{"original":"λ.1"}') },
        { parameter: 1, sha256: null, bytes: 0 },
      ] });
    first.handleReadyForQuery(); client.submit();
    const failure = new Error('original failed write'); expect(failed.handleError(failure)).toBe(failure);
    expect(client.submit()).toBe(pending);
    const snapshot = tap.snapshot();
    expect(serializations).toBe(1);
    expect(snapshot.complete).toBe(false);
    expect(snapshot.diagnostics.admissions[2]!.boundParameters).toMatchObject({ complete: true,
      values: [{ parameter: 0, sha256: digest('λ.😺'), bytes: Buffer.byteLength('λ.😺') }, { parameter: 1, sha256: null, bytes: 0 }] });
    expect(snapshot.diagnostics.admissions[3]!.boundParameters).toBeUndefined();
    expect(snapshot.rows.map(row => [row.kind, row.persistedBytes, row.sql?.status]))
      .toEqual([['unknown', null, 'ok'], ['unknown', null, 'error']]);
    expect(snapshot.rows.every(row => !row.sql?.serializedParameters)).toBe(true);
    expect(beforeTerminal.diagnostics.admissions[2]!.boundParameters).toBeUndefined();
    // A partial mapper must preserve both the original error and the prefix.
    client.submit();
    const partial = tap.run(() => client.query(statement, ['prefix', { toJSON() { throw failure; } }]));
    expect(() => client.submit()).toThrow(failure);
    expect(partial.handleError(failure)).toBe(failure);
    expect(tap.snapshot().diagnostics.admissions[4]!.boundParameters).toEqual({
      serializerSourceRef: 'source:original-mapper', parameterCount: 2, complete: false,
      values: [{ parameter: 0, sha256: digest('prefix'), bytes: Buffer.byteLength('prefix') }] });
  } finally { tap.restore(); }
});

describe('durable child census composition', () => {
  const scope: GroundedMeasurementScope = { workspaceId: 'w', harness: 'h', potId: 'p', runId: 'r',
    ownerId: 'capture-unit', caseId: 'J3', arm: 'pre', iteration: 1, manifestHash: 'manifest', fixtureHash: 'fixture',
    sourceFingerprint: 'source', testFingerprint: 'test', runtimeFingerprint: 'runtime', configFingerprint: 'config' };
  const source = (id: string): GroundedCensus<GroundedInvocation> => ({ scope: { ...scope },
    sourceRef: `original:${id}`, complete: true, ids: [id], rows: [{ id, tool: 'items:get', args: { exact: 'é🌱' },
      boundary: 'internal', originRef: 'registered-dispatch', purpose: 'retrieval', purposeRef: 'registered-read' }] });

  it('preserves independent parent/crash/recovery populations, original purposes and diagnostics', () => {
    const parent = source('parent'), crash = { ...source('crash'), complete: false,
      ids: ['crash', 'pending'], diagnostics: { pending: 1, pendingIds: ['pending'],
        admissions: [{ id: 'pending', purpose: 'unknown', purposeRef: '' }] } }, recovery = source('recover');
    recovery.rows = [{ ...recovery.rows[0]!, purpose: 'other', purposeRef: 'registered-write' }];
    const originals = structuredClone([parent, crash, recovery]);
    const composed = composeDurableCaptureCensus(scope, 'parent-tape', [parent, crash, recovery]);
    expect(composed.complete).toBe(false);
    expect(composed.ids).toEqual(['parent', 'crash', 'pending', 'recover']);
    expect(composed.rows).toEqual(originals.flatMap(census => census.rows));
    expect(composed.sources).toEqual(originals);
    expect(composed.gaps).toContain('1:incomplete-source');
    expect(composed.gaps).toContain('1:population-mismatch');
    // A later mutation/seal cannot rewrite the earlier interrupted postimage.
    crash.ids.push('later'); crash.diagnostics.pendingIds.length = 0;
    expect(composed.sources).toEqual(originals);
    expect(composed.rows[2]!.purposeRef).toBe('registered-write');
  });

  it.each(['missing', 'foreign', 'unsealed', 'missing-row', 'orphan-row', 'duplicate', 'blank-ref', 'blank-id'])
  ('refuses to qualify a %s child instead of repairing its original evidence', fault => {
    const parent = source('parent'), child = source('child');
    if (fault === 'foreign') child.scope.ownerId = 'another-owner';
    if (fault === 'unsealed') child.complete = false;
    if (fault === 'missing-row') child.rows = [];
    if (fault === 'orphan-row') child.ids = [];
    if (fault === 'duplicate') { child.ids = parent.ids; child.rows = parent.rows; }
    if (fault === 'blank-ref') child.sourceRef = ' ';
    if (fault === 'blank-id') { child.ids = [' ']; child.rows = [{ ...child.rows[0]!, id: ' ' }]; }
    const sources = [parent, fault === 'missing' ? undefined : child];
    const originals = structuredClone(sources);
    const composed = composeDurableCaptureCensus(scope, 'parent-tape', sources);
    expect(composed.complete).toBe(false);
    expect(composed.gaps.length).toBeGreaterThan(0);
    expect(sources).toEqual(originals);
    expect(composed.sources).toEqual(originals.map(original => original ?? null));
  });

  it('keeps a child-local population loss even if another source has its missing row', () => {
    const first = source('first'), second = source('second');
    first.rows = second.rows; second.rows = source('first').rows;
    const composed = composeDurableCaptureCensus(scope, 'tape', [first, second]);
    expect(composed.ids).toHaveLength(composed.rows.length);
    expect(composed.complete).toBe(false);
    expect(composed.gaps).toEqual(['0:population-mismatch', '1:population-mismatch']);
  });

  it('qualifies a fully drained population without guessing unknown purpose or write bytes', async () => {
    const { GROUNDED_MANIFEST_SHA256, measureGroundedEvidence } = await import('../grounded-evidence-measurement');
    const validScope = { ...scope, manifestHash: GROUNDED_MANIFEST_SHA256 };
    const original = { ...source('unknown'), scope: validScope };
    original.rows = [{ ...original.rows[0]!, purpose: 'unknown', purposeRef: '' }];
    const invocations = composeDurableCaptureCensus(validScope, 'tape', [original]);
    const storage = composeDurableCaptureCensus(validScope, 'tape', [{ scope: validScope, sourceRef: 'sql',
      complete: true, ids: ['opaque-write'], rows: [{ id: 'opaque-write', kind: 'write' as const, persistedBytes: null }] }]);
    expect(invocations.complete).toBe(true);
    expect(storage.complete).toBe(true);
    const measured = measureGroundedEvidence({ scope: validScope, invocations, storage,
      boundary: { scope: validScope, sourceRef: 'tape', admittedAt: '2026-11-13T00:00:00Z',
        settledAt: '2026-11-13T00:00:01Z', monotonicStartMs: 1, monotonicEndMs: 2, drained: true } });
    expect(measured.values.storageOperations).toBe(1);
    expect(measured.values.storageBytes).toBeNull();
    expect(measured.values.retrievalCalls).toBeNull();
    expect(measured.gaps).toContain('storage:missing-persisted-bytes');
    expect(measured.gaps).toContain('invocations:unclassified-caller-purpose');
    expect(composeDurableCaptureCensus(validScope, 'tape', []).complete).toBe(false);
    expect(composeDurableCaptureCensus(validScope, ' ', [original]).complete).toBe(false);
  });
});

describe('durable child incremental retention', () => {
  const pending = () => ({ boundary: null, census: { complete: false, ids: ['step'], rows: [] },
    invocations: { complete: false, ids: ['dispatch'], rows: [], diagnostics: { pendingIds: ['dispatch'] } },
    storage: { complete: false, ids: ['sql'], rows: [] }, original: 'é🌱' });

  it('reconstructs every growing postimage, including changed prefixes, removals and final exclusions', () => {
    const { path } = fixture(), recorder = createDurableCaptureRecorder(path);
    const capture = { ...pending(), phases: [{ phase: 'admitted' }], removed: true };
    recorder.retain(capture);
    // These arrays really grow in place in the child. A previous snapshot must
    // not alias them and silently lose their newly admitted entries.
    capture.census.ids.push('second');
    capture.phases.push({ phase: 'settled' });
    recorder.retain(capture);
    const { retentionJournal, ...roundtrip } = reconstructDurableCapture(path);
    expect(roundtrip).toEqual(capture);
    expect(retentionJournal).toMatchObject({ frames: 2, complete: true, error: null });
    const { removed: _removed, ...final } = capture;
    final.census.ids = ['second']; // exclusion at final seal is a replacement
    final.phases[0]!.phase = 'changed';
    recorder.retain(final);
    expect(reconstructDurableCapture(path)).toMatchObject(final);
    expect(reconstructDurableCapture(path)).not.toHaveProperty('removed');
    const original = readFileSync(path + '.journal');
    materializeDurableCapture(path);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(reconstructDurableCapture(path));
    expect(readFileSync(path + '.journal')).toEqual(original);
    expect(statSync(path + '.journal').mode & 0o777).toBe(0o600);
  });

  it('retains actual recorder admissions synchronously before the handler runs', async () => {
    const { observeGroundedToolDispatch } = await import('../grounded-evidence-measurement');
    const { path } = fixture(), recorder = createDurableCaptureRecorder(path);
    const scope = { workspaceId: 'w', harness: 'h', potId: 'p', runId: 'r', ownerId: 'capture-unit',
      caseId: 'N7', arm: 'pre' as const, iteration: 1, manifestHash: 'fixture-manifest', fixtureHash: 'fixture',
      sourceFingerprint: 'source', testFingerprint: 'test', runtimeFingerprint: 'runtime', configFingerprint: 'config' };
    const tap = observeGroundedToolDispatch({ scope, sourceRef: path, attemptId: 'actual', boundary: 'internal',
      originRef: 'fixture', registrations: { read: { purpose: 'retrieval', purposeRef: 'registered' } },
      onObservation: (): void => { recorder.retain({ ...pending(), invocations: tap.snapshot() }); },
      dispatch: async () => {
        const before = reconstructDurableCapture(path);
        expect(before.invocations).toMatchObject({ complete: false, ids: ['actual:dispatch:1'], rows: [],
          diagnostics: { pendingIds: ['actual:dispatch:1'], admissions: [{ tool: 'read', args: { exact: 'é🌱' } }] } });
        return 'original-result';
      } });
    expect(await tap.dispatch('read', { exact: 'é🌱' })).toBe('original-result');
    recorder.retain({ ...pending(), invocations: tap.seal() });
    expect(reconstructDurableCapture(path).invocations).toMatchObject({ complete: true,
      diagnostics: { pending: 0 }, rows: [{ tool: 'read', args: { exact: 'é🌱' } }] });
  });

  it('retains the entire original growing population with substantially fewer published bytes', () => {
    const { path } = fixture(), recorder = createDurableCaptureRecorder(path);
    const capture = { ...pending(), sqlObservations: [] as Array<{ id: number; original: string }> };
    let fullBytes = 0, publishedBytes = 0;
    for (let id = 0; id < 80; id++) {
      capture.sqlObservations.push({ id, original: 'original-'.repeat(128) });
      fullBytes += Buffer.byteLength(JSON.stringify(capture));
      publishedBytes += recorder.retain(capture).bytes;
    }
    expect(reconstructDurableCapture(path).sqlObservations).toEqual(capture.sqlObservations);
    expect(publishedBytes).toBe(readFileSync(path + '.journal').byteLength);
    expect(publishedBytes).toBeLessThan(fullBytes / 10);
  });

  it.each(['partial', 'hash', 'missing-frame', 'duplicate-frame'])('fails closed on %s without hiding the original journal', fault => {
    const { path } = fixture(), recorder = createDurableCaptureRecorder(path);
    const capture = { ...pending(), census: { complete: true, ids: ['step'], rows: ['step'] } };
    recorder.retain(capture);
    recorder.retain({ ...capture, original: 'second' });
    recorder.retain({ ...capture, original: 'third' });
    const lines = readFileSync(path + '.journal', 'utf8').trimEnd().split('\n');
    const corrupted = fault === 'partial' ? lines.join('\n') + '\n{"payload":"unfinished'
      : fault === 'hash' ? lines[0] + '\n' + lines[1]!.replace('second', 'forged') + '\n'
      : fault === 'missing-frame' ? [lines[0], lines[2]].join('\n') + '\n'
      : [lines[0], lines[1], lines[1], lines[2]].join('\n') + '\n';
    writeFileSync(path + '.journal', corrupted);
    const recovered = materializeDurableCapture(path);
    expect(recovered.retentionJournal).toMatchObject({ complete: false });
    expect(recovered.retentionJournal.error).toBeTruthy();
    expect(recovered.boundary).toBeNull();
    for (const key of ['census', 'storage', 'invocations']) expect(recovered[key]).toMatchObject({ complete: false });
    expect(readFileSync(path + '.journal', 'utf8')).toBe(corrupted);
  });

  it('refuses to overwrite an original journal and poisons a writer after serialization failure', () => {
    const { path } = fixture(), recorder = createDurableCaptureRecorder(path);
    recorder.retain(pending());
    const original = readFileSync(path + '.journal');
    expect(() => createDurableCaptureRecorder(path).retain(pending())).toThrow();
    expect(readFileSync(path + '.journal')).toEqual(original);
    expect(() => recorder.retain({ toJSON() { throw new Error('original_serialization_failure'); } }))
      .toThrow('original_serialization_failure');
    expect(() => recorder.retain({ boundary: 'fake-drain' })).toThrow('recorder failed');
    expect(readFileSync(path + '.journal')).toEqual(original);
  });

  it.each(['SIGKILL', 'SIGTERM', 'write-error'])('preserves pending admissions and rejects a partial append after %s', fault => {
    const { path } = fixture();
    const source = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const { createDurableCaptureRecorder } = await import(process.env.CAPTURE_MODULE);
      const recorder = createDurableCaptureRecorder(process.env.CAPTURE_PATH);
      recorder.retain({ boundary: null, invocations: { complete: false, ids: ['pending-admission'], rows: [] } });
      const originalAppend = fs.appendFileSync;
      fs.appendFileSync = (target, bytes) => {
        originalAppend(target, String(bytes).slice(0, 17));
        if (process.env.CAPTURE_FAULT === 'write-error') throw new Error('injected_partial_append');
        process.kill(process.pid, process.env.CAPTURE_FAULT);
      };
      syncBuiltinESMExports();
      try { recorder.retain({ boundary: { drained: true }, invocations: { complete: true, ids: [], rows: [] } }); }
      catch (error) {
        fs.appendFileSync = originalAppend; syncBuiltinESMExports();
        try { recorder.retain({ boundary: { drained: true } }); }
        catch { process.exitCode = 23; }
      }
    `;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
      cwd: new URL('../..', import.meta.url), timeout: 20_000, encoding: 'utf8',
      env: { ...process.env, CAPTURE_PATH: path, CAPTURE_FAULT: fault,
        CAPTURE_MODULE: new URL('../../test/_durable-orchestration-capture.ts', import.meta.url).href },
    });
    expect(result.error).toBeUndefined();
    if (fault === 'write-error') expect(result.status, result.stderr).toBe(23);
    else expect(result.signal, result.stderr).toBe(fault);
    expect(reconstructDurableCapture(path)).toMatchObject({ boundary: null,
      invocations: { complete: false, ids: ['pending-admission'], rows: [] },
      retentionJournal: { frames: 1, complete: false, error: 'partial-tail' } });
  });
});

// Interrupt the real synchronous filesystem boundary, after a partial write.
// The old in-place writer is the negative control; both writers get the same fault.
function interruptedWriter(path: string, fault: string, legacy = false) {
  const source = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const originalWrite = fs.writeFileSync;
    fs.writeFileSync = (target, bytes, options) => {
      originalWrite(target, String(bytes).slice(0, 7), options);
      if (process.env.CAPTURE_FAULT === 'write-error') throw new Error('injected_partial_write');
      process.kill(process.pid, process.env.CAPTURE_FAULT);
    };
    if (process.env.CAPTURE_FAULT === 'rename-error') {
      fs.writeFileSync = originalWrite;
      fs.renameSync = () => { throw new Error('injected_rename_failure'); };
    }
    syncBuiltinESMExports();
    const { retainDurableCapture } = await import(process.env.CAPTURE_MODULE);
    const next = { pending: ['replacement-admission'], boundary: null };
    try {
      if (process.env.CAPTURE_LEGACY === '1') fs.writeFileSync(process.env.CAPTURE_PATH, JSON.stringify(next));
      else retainDurableCapture(process.env.CAPTURE_PATH, next);
    } catch (error) {
      process.stderr.write(String(error));
      process.exitCode = 23;
    }
  `;
  return spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
    cwd: new URL('../..', import.meta.url), timeout: 20_000, encoding: 'utf8',
    env: { ...process.env, CAPTURE_PATH: path, CAPTURE_FAULT: fault, CAPTURE_LEGACY: legacy ? '1' : '0',
      CAPTURE_MODULE: new URL('../../test/_durable-orchestration-capture.ts', import.meta.url).href },
  });
}

describe('durable child capture publication', () => {
  it('publishes complete replacements with one serialization and no temporary residue', () => {
    const { directory, path } = fixture();
    let serializations = 0;
    retainDurableCapture(path, { toJSON() { serializations++; return { pending: ['new-admission'], boundary: null }; } });
    expect(serializations).toBe(1);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ pending: ['new-admission'], boundary: null });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(directory)).toEqual(['capture.json']);
    retainDurableCapture(path, { settled: true });
    expect(readFileSync(path, 'utf8')).toBe('{"settled":true}');
  });

  it('preserves the published tape when serialization fails', () => {
    const { directory, path, original } = fixture();
    expect(() => retainDurableCapture(path, { toJSON() { throw new Error('serialization_failed'); } }))
      .toThrow('serialization_failed');
    expect(readFileSync(path, 'utf8')).toBe(original);
    expect(readdirSync(directory)).toEqual(['capture.json']);
  });

  it('separates serialization from complete atomic publication and counts original UTF-8 bytes', () => {
    const { path } = fixture();
    vi.spyOn(performance, 'now').mockReturnValueOnce(10).mockReturnValueOnce(15).mockReturnValueOnce(27);
    const capture = { original: 'é🌱' };
    const timing = retainDurableCapture(path, capture);
    expect(timing).toEqual({ serializationMs: 5, publicationMs: 12,
      bytes: Buffer.byteLength(JSON.stringify(capture)) });
    expect(readFileSync(path, 'utf8')).toBe(JSON.stringify(capture));
  });

  it.each(['write-error', 'rename-error'])('retains the last valid tape and surfaces %s', fault => {
    const { directory, path, original } = fixture();
    const result = interruptedWriter(path, fault);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(23);
    expect(result.stderr).toContain(fault === 'write-error' ? 'injected_partial_write' : 'injected_rename_failure');
    expect(readFileSync(path, 'utf8')).toBe(original);
    expect(readdirSync(directory)).toEqual(['capture.json']);
  });

  it.each(['SIGKILL', 'SIGTERM'])('retains the published admission across %s during a replacement', signal => {
    const legacy = fixture();
    const old = interruptedWriter(legacy.path, signal, true);
    expect(old.error).toBeUndefined();
    expect(old.signal, old.stderr).toBe(signal);
    expect(() => JSON.parse(readFileSync(legacy.path, 'utf8'))).toThrow();

    const current = fixture();
    const result = interruptedWriter(current.path, signal);
    expect(result.error).toBeUndefined();
    expect(result.signal, result.stderr).toBe(signal);
    expect(readFileSync(current.path, 'utf8')).toBe(current.original);
    // A killed writer cannot clean its unpublished partial sibling. It remains
    // discoverable with the isolated run directory, never mistaken for the tape.
    expect(readdirSync(current.directory).filter(name => name.endsWith('.tmp'))).toHaveLength(1);
  });
});
