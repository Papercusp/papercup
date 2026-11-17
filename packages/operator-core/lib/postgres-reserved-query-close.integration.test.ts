import postgres from 'postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { createPgDiagnosticHooks, pgResultDiagnosticSnapshot } from '@papercusp/db-org';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';

describe('postgres.js reserved query queue after backend close', () => {
  let db: FreshPgDb;
  let sql: postgres.Sql;

  beforeAll(async () => {
    db = await createFreshPgDb('reserved-query-close');
    // One in-flight query fills the only pipeline slot; the next query stays in
    // postgres.js reserve()'s private queue until the backend is killed.
    // `max_pipeline` is a real runtime option (postgres/src/index.js parseOptions
    // defaults it to 100) that the package's typings omit, so a literal object
    // trips TS2353. A non-literal argument skips the excess-property check while
    // `max` and `prepare` stay type-checked against Options.
    const options = { max: 1, max_pipeline: 1, prepare: false,
      ...createPgDiagnosticHooks('reserved-query-timing') };
    sql = postgres(db.url, options);
  }, 180_000);

  afterAll(async () => {
    await sql?.end({ timeout: 1 }).catch(() => {});
    await db?.cleanup();
  });

  it('records original JSON and dynamic-builder serializer outputs without serializing again', async () => {
    const { observeGroundedStoreOperations, GROUNDED_MANIFEST_SHA256 } = await import('./grounded-evidence-measurement');
    const source = await readFile(new URL('../../../node_modules/postgres/src/connection.js', import.meta.url));
    const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
    const serializerSourceRef = `source:node_modules/postgres/src/connection.js@${digest(source)}#Bind`;
    const scope = { workspaceId: 'gec-native-serialization', potId: 'gec', harness: 'gec',
      runId: 'gec-native-serialization', ownerId: 'gec-native-serialization', caseId: 'N7', arm: 'pre' as const,
      iteration: 1, manifestHash: GROUNDED_MANIFEST_SHA256, fixtureHash: 'native-private-pg',
      sourceFingerprint: digest(source), testFingerprint: digest(await readFile(new URL(import.meta.url))),
      runtimeFingerprint: process.version, configFingerprint: 'prepare:false' };
    await sql`CREATE TABLE original_serialized_values (value json, enabled boolean, note text)`;
    let serializations = 0;
    const captures: unknown[] = [];
    for (const count of [1, 2]) {
      const query = 'INSERT INTO original_serialized_values ("value","enabled","note")values'
        + Array.from({ length: count }, (_, row) => '(' + Array.from({ length: 3 }, (_, column) => `$${row * 3 + column + 1}`).join(',') + ')').join(',')
        + ' RETURNING value';
      const tap = observeGroundedStoreOperations({ scope, deps: {}, operations: [], sourceRef: 'test:original-driver-serialization',
        attemptId: `builder-${count}`, postgres: [{ pool: 'native', client: sql }],
        serializedSqlParameters: [{ pool: 'native', queryHash: digest(query), command: 'INSERT', parameterCount: count * 3,
          persistedParameters: Array.from({ length: count * 3 }, (_, index) => index),
          sourceRef: `test:postgres-reserved-query-close.integration.test.ts@${scope.testFingerprint}`, serializerSourceRef }] });
      try {
        const values = Array.from({ length: count }, () => ({
          value: sql.json({ toJSON: () => ({ original: `λ.😺-${++serializations}` }) }), enabled: true, note: null,
        }));
        const returned = await tap.run(() => sql`INSERT INTO original_serialized_values ${sql(values, 'value', 'enabled', 'note')} RETURNING value`);
        const census = tap.seal();
        const expectedValues = returned.map(row => `{"original":"${row.value.original}"}`);
        expect(serializations).toBe(count === 1 ? 1 : 3);
        expect(census.complete).toBe(true);
        expect(census.rows).toHaveLength(1);
        expect(census.rows[0].kind).toBe('write');
        expect(census.rows[0].persistedBytes).toBe(expectedValues.reduce((sum, value) => sum + Buffer.byteLength(value) + 1, 0));
        expect(census.rows[0].sql?.serializedParameters?.values).toEqual(expectedValues.flatMap((value, row) => [
          { parameter: row * 3, sha256: digest(value), bytes: Buffer.byteLength(value) },
          { parameter: row * 3 + 1, sha256: digest('t'), bytes: 1 },
          { parameter: row * 3 + 2, sha256: null, bytes: 0 },
        ]));
        captures.push({ count, serializations, census });
      } finally { tap.restore(); }
    }
    if (process.env.PAPERCUSP_TEST_ARTIFACT_DIR) await writeFile(join(process.env.PAPERCUSP_TEST_ARTIFACT_DIR,
      'gec-native-original-serialization.json'), JSON.stringify({ serializerSourceRef, captures }));
  });

  it('qualifies conditional write bytes from actual affected rows across both PostgreSQL drivers', async () => {
    const { observeGroundedStoreOperations, GROUNDED_MANIFEST_SHA256 } = await import('./grounded-evidence-measurement');
    const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
    const driverSource = await readFile(new URL('../../../node_modules/postgres/src/connection.js', import.meta.url));
    const nodeSource = await readFile(new URL('../../../node_modules/pg/lib/query.js', import.meta.url));
    const nodeMapper = await readFile(new URL('../../../node_modules/pg/lib/utils.js', import.meta.url));
    const scope = { workspaceId: 'gec-conditional-write', potId: 'gec', harness: 'gec', runId: 'gec-conditional-write',
      ownerId: 'gec-conditional-write', caseId: 'N7', arm: 'pre' as const, iteration: 1,
      manifestHash: GROUNDED_MANIFEST_SHA256, fixtureHash: 'native-private-pg', sourceFingerprint: digest(driverSource),
      testFingerprint: digest(await readFile(new URL(import.meta.url))), runtimeFingerprint: process.version,
      configFingerprint: 'actual-command-complete-counts' };
    await sql`CREATE TABLE conditional_values (key text PRIMARY KEY, value text CHECK (value <> 'fail'))`;
    const bootstrap = new pg.Client({ connectionString: db.url }), captures: unknown[] = [];
    try {
      await bootstrap.connect();
      for (const driver of ['postgres', 'node-postgres', 'tagged'] as const) {
        const serializerSourceRef = driver === 'node-postgres'
          ? `source:pg/lib/query.js@${digest(nodeSource)}+utils.js@${digest(nodeMapper)}#Bind.prepareValue`
          : `source:postgres/src/connection.js@${digest(driverSource)}#Bind+CommandComplete`;
        const key = `${driver}-winner`, body = 'λ.😺';
        const insert = 'INSERT INTO conditional_values VALUES ($1,$2) ON CONFLICT DO NOTHING';
        const update = 'UPDATE conditional_values SET value=$2 WHERE key=$1 AND value IS DISTINCT FROM $2';
        // Like DBOS checkpoint retries, a successful no-op UPDATE can report
        // one affected row without persisting any supplied payload value.
        const ambiguous = 'INSERT INTO conditional_values VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=conditional_values.value';
        const batch = 'INSERT INTO conditional_values VALUES ($1,$2),($3,$4) ON CONFLICT DO NOTHING';
        const cases = [
          { name: 'winner', statement: insert, values: [key, body], count: 1, expectedRows: 1, selected: [0, 1] },
          { name: 'identical-retry', statement: insert, values: [key, body], count: 0, expectedRows: 1, selected: [0, 1] },
          { name: 'different-loser', statement: insert, values: [key, 'loser'], count: 0, expectedRows: 1, selected: [0, 1] },
          { name: 'unchanged-update', statement: update, values: [key, body], count: 0, expectedRows: 1, selected: [1] },
          { name: 'changed-update', statement: update, values: [key, 'changed'], count: 1, expectedRows: 1, selected: [1] },
          { name: 'partial-batch', statement: batch, values: [key, 'ignored', `${key}-new`, body], count: 1,
            expectedRows: 2, selected: [0, 1, 2, 3] },
          { name: 'zero-batch', statement: batch, values: [key, 'ignored', `${key}-new`, body], count: 0,
            expectedRows: 2, selected: [0, 1, 2, 3] },
          { name: 'full-batch', statement: batch, values: [`${key}-a`, body, `${key}-b`, body], count: 2,
            expectedRows: 2, selected: [0, 1, 2, 3] },
          { name: 'failed-write', statement: insert, values: [`${key}-fail`, 'fail'], count: null,
            expectedRows: 1, selected: [0, 1] },
          { name: 'ambiguous-fresh-insert', statement: ambiguous, values: [`${key}-ambiguous`, body], count: 1,
            expectedRows: 'zero-only' as const, selected: [0, 1] },
          { name: 'ambiguous-unchanged-retry', statement: ambiguous, values: [`${key}-ambiguous`, 'loser'], count: 1,
            expectedRows: 'zero-only' as const, selected: [0, 1] },
          { name: 'proven-zero-only-noop', statement: insert, values: [key, 'loser'], count: 0,
            expectedRows: 'zero-only' as const, selected: [0, 1] },
        ];
        for (const control of driver === 'tagged' ? cases.slice(0, 3) : cases) {
          const sourceRef = `test:conditional-values@${scope.testFingerprint}`;
          const tap = observeGroundedStoreOperations({ scope, deps: {}, operations: [], sourceRef,
            attemptId: `${driver}-${control.name}`,
            postgres: driver === 'node-postgres' ? [] : [{ pool: driver, client: sql }],
            nodePostgres: driver === 'node-postgres' ? [{ pool: driver, clientPrototype: pg.Client.prototype,
              queryPrototype: pg.Query.prototype, serializerSourceRef }] : [],
            serializedSqlWrites: driver === 'tagged' ? [{ pool: driver, sourceRef, command: 'INSERT',
              template: ['INSERT INTO conditional_values VALUES (', ',', ') ON CONFLICT DO NOTHING'],
              serializedArguments: [0, 1], allOrNoneRows: 1 }] : [],
            serializedSqlParameters: driver === 'tagged' ? [] : [{ pool: driver, sourceRef, serializerSourceRef,
              queryHash: digest(control.statement), command: control.statement === update ? 'UPDATE' : 'INSERT',
              parameterCount: control.values.length, persistedParameters: control.selected, allOrNoneRows: control.expectedRows }] });
          try {
            let failed = false, actualCount: number | null = null, returnedRows: number | null = null;
            try {
              const result = await tap.run(() => driver === 'node-postgres'
                ? bootstrap.query(control.statement, control.values)
                : driver === 'tagged'
                  ? sql`INSERT INTO conditional_values VALUES (${control.values[0]},${control.values[1]}) ON CONFLICT DO NOTHING`
                  : sql.unsafe(control.statement, control.values));
              if ('rowCount' in result) { actualCount = result.rowCount; returnedRows = result.rows.length; }
              else { actualCount = result.count; returnedRows = result.length; }
            } catch (error) { if ((error as { code?: string }).code !== '23514') throw error; failed = true; }
            const census = tap.seal();
            captures.push({ driver, control: control.name, actualCount, returnedRows, failed, census });
            expect(failed).toBe(control.count === null); expect(actualCount).toBe(control.count);
            expect(returnedRows).toBe(failed ? null : 0);
            expect(census.complete).toBe(true); expect(census.rows).toHaveLength(1);
            const bytes = control.values.reduce((sum, value, index) => sum
              + (control.selected.includes(index) ? Buffer.byteLength(value) : 0), 0);
            expect(census.rows[0].persistedBytes, `${driver}/${control.name}`).toBe(control.count === 0 ? 0
              : control.count === control.expectedRows ? bytes : null);
            expect(census.rows[0].sql?.rowOutcome).toEqual({ allOrNoneRows: control.expectedRows, affectedRows: actualCount });
          } finally { tap.restore(); }
        }
        const winner = await sql`SELECT value FROM conditional_values WHERE key=${key}`;
        expect(winner[0].value).toBe(driver === 'tagged' ? body : 'changed');
        if (driver !== 'tagged') expect((await sql`SELECT value FROM conditional_values WHERE key=${`${key}-ambiguous`}`)[0].value).toBe(body);
      }
    } finally {
      await bootstrap.end();
      if (process.env.PAPERCUSP_TEST_ARTIFACT_DIR) await writeFile(join(process.env.PAPERCUSP_TEST_ARTIFACT_DIR,
        'gec-conditional-write-outcomes.json'), JSON.stringify({ scope, captures }));
    }
  });

  it('retains executing backend identities for queued queries across two actual pg Clients', async () => {
    const { observeGroundedStoreOperations, GROUNDED_MANIFEST_SHA256 } = await import('./grounded-evidence-measurement');
    const observations: import('./grounded-evidence-measurement').GroundedSqlObservation[] = [];
    const scope = { workspaceId: 'gec-backend', potId: 'gec', harness: 'gec', runId: 'gec-backend',
      ownerId: 'gec-backend', caseId: 'N7', arm: 'pre' as const, iteration: 1,
      manifestHash: GROUNDED_MANIFEST_SHA256, fixtureHash: 'native-private-pg', sourceFingerprint: 'current-source',
      testFingerprint: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),
      runtimeFingerprint: process.version, configFingerprint: 'two-actual-pg-Clients' };
    const clients = [new pg.Client({ connectionString: db.url }), new pg.Client({ connectionString: db.url })];
    const tap = observeGroundedStoreOperations({ scope, deps: {}, operations: [],
      sourceRef: 'test:queued-backend-identity', attemptId: 'queued-backend',
      nodePostgres: [{ pool: 'actual-pg', clientPrototype: pg.Client.prototype, queryPrototype: pg.Query.prototype,
        serializerSourceRef: 'source:installed-pg-original-mapper' }],
      onSqlObservation: observation => observations.push(observation) });
    try {
      // Admission precedes BackendKeyData; submission happens after each
      // actual handshake, and a second query is queued on each connection.
      const pending = clients.flatMap((client, index) => [1, 2].map(sequence => tap.run(() => client.query(
        `SELECT pg_backend_pid() AS backend, $1::text AS label`, [`${index}:${sequence}`]))));
      await Promise.all(clients.map(client => client.connect()));
      const returned = await Promise.all(pending);
      const failed = await tap.run(() => clients[0]!.query('SELECT 1 / 0')).catch(error => error);
      expect(failed.code).toBe('22012');
      const census = tap.seal();
      expect(census.complete).toBe(true); expect(census.rows).toHaveLength(5);
      const pids = returned.map(result => result.rows[0].backend as number);
      expect(pids[0]).toBe(pids[1]); expect(pids[2]).toBe(pids[3]); expect(pids[0]).not.toBe(pids[2]);
      for (const [index, result] of returned.entries()) {
        const label = result.rows[0].label;
        // Admission order is independent of completion order and backend PID.
        const id = census.ids[index]!;
        expect(label).toBe(`${Math.floor(index / 2)}:${index % 2 + 1}`);
        expect(observations.filter(row => row.id === id).map(row => [row.phase, row.backendProcessId]))
          .toEqual([['admission', null], ['submit', pids[index]], ['terminal', pids[index]]]);
        expect(census.rows.find(row => row.id === id)?.sql?.backendProcessId).toBe(pids[index]);
      }
      expect(census.rows.at(-1)?.sql).toMatchObject({ status: 'error', backendProcessId: pids[0] });
      // Backend identity alone never upgrades an unreviewed SQL operation.
      expect(census.rows.every(row => row.kind === 'unknown' && row.persistedBytes === null)).toBe(true);
    } finally {
      tap.restore();
      await Promise.all(clients.map(client => client.end()));
    }
  });

  it('node-postgres server messages retain original generated values and transaction outcomes across actual Clients', async () => {
    const { observeGroundedStoreOperations, GROUNDED_MANIFEST_SHA256 } = await import('./grounded-evidence-measurement');
    const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
    const clientSource = await readFile(new URL('../../../node_modules/pg/lib/client.js', import.meta.url));
    const scope = { workspaceId: 'gec-server-messages', potId: 'gec', harness: 'gec', runId: 'gec-server-messages',
      ownerId: 'gec-server-messages', caseId: 'N7', arm: 'pre' as const, iteration: 1,
      manifestHash: GROUNDED_MANIFEST_SHA256, fixtureHash: 'native-private-pg', sourceFingerprint: digest(clientSource),
      testFingerprint: digest(await readFile(new URL(import.meta.url))), runtimeFingerprint: process.version,
      configFingerprint: 'actual-notice-and-ready-for-query' };
    await sql`CREATE TABLE server_message_values (key text PRIMARY KEY, value text DEFAULT clock_timestamp()::text)`;
    await sql.unsafe(`CREATE FUNCTION retain_server_value() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE NOTICE '%', json_build_object('key', NEW.key, 'value', NEW.value,
          'backend', pg_backend_pid(), 'transactionId', pg_current_xact_id()::text)::text;
        RETURN NEW;
      END $$`);
    await sql.unsafe('CREATE TRIGGER retain_server_value AFTER INSERT ON server_message_values FOR EACH ROW EXECUTE FUNCTION retain_server_value()');
    const observations: import('./grounded-evidence-measurement').GroundedSqlObservation[] = [];
    const delivered: unknown[] = [];
    const tap = observeGroundedStoreOperations({ scope, deps: {}, operations: [], sourceRef: 'test:actual-server-messages',
      attemptId: 'actual-server-messages', nodePostgres: [{ pool: 'actual-pg', clientPrototype: pg.Client.prototype,
        queryPrototype: pg.Query.prototype, serializerSourceRef: 'source:installed-pg-original-mapper',
        serverMessageSourceRef: `source:pg/lib/client.js@${digest(clientSource)}#NoticeResponse+ReadyForQuery` }],
      onSqlObservation: observation => observations.push(observation) });
    const clients = [new pg.Client({ connectionString: db.url }), new pg.Client({ connectionString: db.url })];
    try {
      clients.forEach(client => client.on('notice', notice => delivered.push(notice)));
      await Promise.all(clients.map(client => client.connect()));
      const insert = 'INSERT INTO server_message_values (key) VALUES ($1)';
      const run = (index: number, statement: string, args?: unknown[]) => tap.run(() => clients[index]!.query(statement, args));
      await Promise.all([run(0, insert, ['first']), run(0, insert, ['queued']), run(1, insert, ['other'])]);
      await run(0, 'BEGIN'); await run(0, insert, ['rolled-back']); await run(0, 'ROLLBACK');
      await run(1, 'BEGIN');
      await expect(run(1, 'SELECT 1 / 0')).rejects.toMatchObject({ code: '22012' });
      await run(1, 'ROLLBACK');
      const census = tap.seal();
      expect(census.complete).toBe(true); expect(census.rows).toHaveLength(9);
      expect(census.rows.every(row => row.kind === 'unknown' && row.persistedBytes === null)).toBe(true);
      const byId = new Map(census.rows.map(row => [row.id, row]));
      const notices = observations.filter(row => row.phase === 'notice');
      expect(notices).toHaveLength(4); expect(delivered).toHaveLength(4);
      const saved = await sql`SELECT key, value FROM server_message_values ORDER BY key`;
      expect(saved.map(row => row.key)).toEqual(['first', 'other', 'queued']);
      for (const observation of notices) {
        const original = JSON.parse(observation.notice!.message!);
        expect(observation.association).toBe('executing-query');
        expect(observation.query).toBe(insert);
        expect(observation.backendProcessId).toBe(original.backend);
        expect(original.transactionId).toMatch(/^\d+$/);
        const record = byId.get(observation.id)!;
        expect(record.sql?.serverMessages?.notices).toContainEqual(observation.notice);
        expect(record.sql?.serverMessages?.transactionStatus).toBe(original.key === 'rolled-back' ? 'T' : 'I');
        if (original.key !== 'rolled-back') expect(saved.find(row => row.key === original.key)?.value).toBe(original.value);
      }
      const failed = census.rows.find(row => row.sql?.status === 'error')!;
      expect(failed.sql?.serverMessages?.transactionStatus).toBe('E');
      expect(observations.find(row => row.id === failed.id && row.phase === 'ready')?.transactionStatus).toBe('E');
      expect(census.rows.filter(row => row.sql?.command === 'ROLLBACK').every(row => row.sql?.serverMessages?.transactionStatus === 'I')).toBe(true);
      if (process.env.PAPERCUSP_TEST_ARTIFACT_DIR) await writeFile(join(process.env.PAPERCUSP_TEST_ARTIFACT_DIR,
        'gec-original-server-messages.json'), JSON.stringify({ scope, census, observations }));
    } finally {
      tap.restore(); await Promise.all(clients.map(client => client.end()));
    }
  });

  it('records node-postgres Pool and bootstrap Clients with original serialization and terminal-loss controls', async () => {
    const { observeGroundedStoreOperations, GROUNDED_MANIFEST_SHA256 } = await import('./grounded-evidence-measurement');
    const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
    const source = await readFile(new URL('../../../node_modules/pg/lib/query.js', import.meta.url));
    const mapper = await readFile(new URL('../../../node_modules/pg/lib/utils.js', import.meta.url));
    const serializerSourceRef = `source:pg/lib/query.js@${digest(source)}+utils.js@${digest(mapper)}#Bind.prepareValue`;
    const scope = { workspaceId: 'gec-native-node-pg', potId: 'gec', harness: 'gec', runId: 'gec-native-node-pg',
      ownerId: 'gec-native-node-pg', caseId: 'N7', arm: 'pre' as const, iteration: 1,
      manifestHash: GROUNDED_MANIFEST_SHA256, fixtureHash: 'native-private-pg', sourceFingerprint: digest(source),
      testFingerprint: digest(await readFile(new URL(import.meta.url))), runtimeFingerprint: process.version,
      configFingerprint: 'actual-pg-Pool-and-standalone-Client' };
    await sql`CREATE TABLE node_original_values (value json, note text CHECK (note <> 'fail'), empty text)`;
    const statement = 'INSERT INTO node_original_values VALUES ($1, $2, $3) RETURNING value';
    const descriptor = { pool: 'node-pg', clientPrototype: pg.Client.prototype, queryPrototype: pg.Query.prototype,
      serializerSourceRef };
    const observe = (attemptId: string, registered = true) => observeGroundedStoreOperations({ scope, deps: {}, operations: [],
      sourceRef: 'test:node-postgres-original-serializer', attemptId, nodePostgres: [descriptor],
      serializedSqlParameters: registered ? [{ pool: 'node-pg', queryHash: digest(statement), command: 'INSERT', parameterCount: 3,
        persistedParameters: [0, 1, 2], sourceRef: `test:postgres-reserved-query-close@${scope.testFingerprint}`, serializerSourceRef }] : [] });
    const pool = new pg.Pool({ connectionString: db.url, max: 1 });
    const bootstrap = new pg.Client({ connectionString: db.url });
    const captures: unknown[] = [];
    let serializations = 0;
    const value = { toPostgres: () => JSON.stringify({ original: `λ.😺-${++serializations}` }) };
    try {
      await bootstrap.connect();
      const tap = observe('pool-and-bootstrap');
      try {
        const returned = await tap.run(async () => Promise.all([
          pool.query(statement, [value, 'pool', null]),
          bootstrap.query(statement, [value, 'bootstrap-1', null]),
          // The second standalone query is queued before its first completes.
          bootstrap.query(statement, [value, 'bootstrap-2', null]),
        ]));
        const census = tap.seal();
        expect(serializations).toBe(3);
        expect(census.complete).toBe(true); expect(census.rows).toHaveLength(3);
        expect(census.ids).toHaveLength(3); expect(census.diagnostics.pending).toBe(0);
        expect(census.rows.every(row => row.kind === 'write' && row.persistedBytes !== null)).toBe(true);
        const originalValues = returned.map(result => JSON.stringify(result.rows[0].value));
        expect(census.rows.reduce((sum, row) => sum + row.persistedBytes!, 0)).toBe(
          originalValues.reduce((sum, text) => sum + Buffer.byteLength(text), 0)
          + Buffer.byteLength('poolbootstrap-1bootstrap-2'));
        expect(census.rows.flatMap(row => row.sql!.serializedParameters!.values)
          .filter(row => row.parameter === 0).map(row => row.sha256).sort()).toEqual(originalValues.map(digest).sort());
        captures.push({ control: 'pool-and-bootstrap-original', serializations, census });
      } finally { tap.restore(); }
      const unregistered = observe('unregistered-original', false);
      try {
        const returned = await unregistered.run(() => bootstrap.query(statement, [value, 'unregistered', null]));
        const census = unregistered.seal(), original = JSON.stringify(returned.rows[0].value);
        expect(serializations).toBe(4);
        expect(census.complete).toBe(true);
        expect(census.rows[0]).toMatchObject({ kind: 'unknown', persistedBytes: null });
        expect(census.rows[0].sql?.serializedParameters).toBeUndefined();
        expect(census.diagnostics.admissions[0]!.boundParameters).toEqual({ serializerSourceRef, parameterCount: 3,
          complete: true, values: [
            { parameter: 0, sha256: digest(original), bytes: Buffer.byteLength(original) },
            { parameter: 1, sha256: digest('unregistered'), bytes: Buffer.byteLength('unregistered') },
            { parameter: 2, sha256: null, bytes: 0 },
          ] });
        captures.push({ control: 'unregistered-bind-remains-unqualified', serializations, census });
      } finally { unregistered.restore(); }
      const failed = observe('failed-write');
      try {
        await expect(failed.run(() => bootstrap.query(statement, [value, 'fail', null]))).rejects.toThrow();
        const census = failed.seal(); expect(census.complete).toBe(true);
        expect(census.rows).toHaveLength(1); expect(census.rows[0].persistedBytes).toBeNull();
        expect(census.rows[0].sql?.status).toBe('error');
        expect(census.diagnostics.admissions[0]!.boundParameters).toMatchObject({ complete: true, parameterCount: 3 });
        captures.push({ control: 'failed-write-unknown-bytes', census });
      } finally { failed.restore(); }
      const prototype = pg.Query.prototype as unknown as Record<string, unknown>;
      const originalReady = prototype.handleReadyForQuery;
      const lost = observe('lost-terminal'), wrappedReady = prototype.handleReadyForQuery;
      try {
        // Let the REAL query and callback succeed while dropping only the
        // recorder terminal. Restore the hook before sealing: census identity,
        // not an intact hook alone, must detect this loss.
        prototype.handleReadyForQuery = originalReady;
        await lost.run(() => bootstrap.query(statement, [value, 'lost-terminal', null]));
        prototype.handleReadyForQuery = wrappedReady;
        const census = lost.seal(); expect(census.complete).toBe(false);
        expect(census.diagnostics).toMatchObject({ pending: 1, hooksIntact: true });
        expect(census.ids).toHaveLength(1); expect(census.rows).toHaveLength(0);
        expect(census.diagnostics.admissions[0]!.boundParameters).toMatchObject({ complete: true, parameterCount: 3 });
        captures.push({ control: 'lost-terminal-incomplete', census });
      } finally { prototype.handleReadyForQuery = wrappedReady; lost.restore(); }
      const partial = observe('partial-original', false), failure = new Error('original mapper failure');
      try {
        const prefix = JSON.stringify({ original: 'λ.😺' });
        await expect(partial.run(() => bootstrap.query(statement, [prefix, { toPostgres() { throw failure; } }, null])))
          .rejects.toBe(failure);
        const census = partial.seal();
        expect(census.complete).toBe(true);
        expect(census.rows[0]).toMatchObject({ kind: 'unknown', persistedBytes: null, sql: { status: 'error' } });
        expect(census.diagnostics.admissions[0]!.boundParameters).toEqual({ serializerSourceRef, parameterCount: 3,
          complete: false, values: [{ parameter: 0, sha256: digest(prefix), bytes: Buffer.byteLength(prefix) }] });
        captures.push({ control: 'partial-mapper-original-prefix', census });
      } finally { partial.restore(); }
    } finally { await bootstrap.end(); await pool.end(); }
    if (process.env.PAPERCUSP_TEST_ARTIFACT_DIR) await writeFile(join(process.env.PAPERCUSP_TEST_ARTIFACT_DIR,
      'gec-native-node-postgres-original-serialization.json'), JSON.stringify({ serializerSourceRef, captures }));
  });

  it('measures installed DBOS operation-output conflicts independently of completion timestamp equality', async () => {
    const { observeGroundedStoreOperations, GROUNDED_MANIFEST_SHA256 } = await import('./grounded-evidence-measurement');
    const require = createRequire(import.meta.url);
    const sdkDirectory = dirname(require.resolve('@dbos-inc/dbos-sdk'));
    const writerPath = join(sdkDirectory, 'system_database.js');
    const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
    type Writer = (this: { schemaName: string; appName: string },
      client: { query: (text: string, values: unknown[]) => Promise<pg.QueryResult> },
      workflowID: string, functionID: number, functionName: string, checkConflict: boolean,
      startTime: number, endTime: number, options: { output: string; serialization: string }) => Promise<void>;
    // Resolve through the public entry, then call the INSTALLED implementation.
    // No copied upsert or workflow runtime is substituted for this branch proof.
    const { SystemDatabase } = require(writerPath) as { SystemDatabase: { prototype: { recordOperationResultInternal: Writer } } };
    const { DBOSWorkflowConflictError } = require(join(sdkDirectory, 'error.js')) as {
      DBOSWorkflowConflictError: new (...args: never[]) => Error };
    const writerSourceRef = `source:${writerPath}@${digest(await readFile(writerPath))}#recordOperationResultInternal`;
    // Keep this installed-version diagnostic valid before and after the saved
    // dependency patch lands. The isolated patch regression below requires the fix.
    const insertWinner = (await readFile(writerPath, 'utf8')).includes('const inserted = out?.rowCount === 1;');
    const reviewedWriter = digest(await readFile(writerPath)) === 'b8594818c046779927f646b94aa6a159ac1d97655a88bfdd451dbe494858bf55';
    const outputStatement = `INSERT INTO dbos_output_branches.operation_outputs
         (workflow_uuid, function_id, output, error, function_name, child_workflow_id, started_at_epoch_ms, completed_at_epoch_ms, serialization, application_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (workflow_uuid, function_id) DO UPDATE
         SET completed_at_epoch_ms = operation_outputs.completed_at_epoch_ms
         RETURNING completed_at_epoch_ms;`;
    const executorStatement = `UPDATE "dbos_output_branches".workflow_status
             SET executor_id = $1
           WHERE workflow_uuid = $2 AND executor_id IS DISTINCT FROM $1`;
    const querySource = await readFile(new URL('../../../node_modules/pg/lib/query.js', import.meta.url));
    const mapperSource = await readFile(new URL('../../../node_modules/pg/lib/utils.js', import.meta.url));
    const serializerSourceRef = `source:pg/lib/query.js@${digest(querySource)}+utils.js@${digest(mapperSource)}#Bind.prepareValue`;
    const scope = { workspaceId: 'gec-dbos-output-branches', potId: 'gec', harness: 'gec',
      runId: 'gec-dbos-output-branches', ownerId: 'gec-dbos-output-branches', caseId: 'N7', arm: 'pre' as const,
      iteration: 1, manifestHash: GROUNDED_MANIFEST_SHA256, fixtureHash: 'native-private-pg',
      sourceFingerprint: digest(await readFile(writerPath)), testFingerprint: digest(await readFile(new URL(import.meta.url))),
      runtimeFingerprint: process.version, configFingerprint: 'installed-writer-independent-postgres-readback' };
    await sql`CREATE SCHEMA dbos_output_branches`;
    await sql`CREATE TABLE dbos_output_branches.operation_outputs (
      workflow_uuid text NOT NULL, function_id integer NOT NULL, output text, error text, function_name text,
      child_workflow_id text, started_at_epoch_ms bigint, completed_at_epoch_ms bigint, serialization text,
      application_name text, PRIMARY KEY (workflow_uuid, function_id))`;
    await sql`CREATE TABLE dbos_output_branches.workflow_status (workflow_uuid text PRIMARY KEY, executor_id text)`;
    await sql`INSERT INTO dbos_output_branches.workflow_status VALUES ('branch-workflow', 'before')`;
    const client = new pg.Client({ connectionString: db.url });
    const captures: unknown[] = [];
    const original = JSON.stringify({ original: 'A-λ.😺' });
    try {
      await client.connect();
      for (const control of [
        { name: 'fresh-insert', output: original, end: 101, checkConflict: true, conflict: false, calls: 2 },
        { name: 'different-timestamp-conflict', output: 'B', end: 202, checkConflict: true, conflict: true, calls: 1 },
        { name: 'same-timestamp-conflict', output: 'C', end: 101, checkConflict: true,
          conflict: insertWinner, calls: insertWinner ? 1 : 2 },
        { name: 'unchecked-conflict', output: 'D', end: 202, checkConflict: false, conflict: false, calls: 1 },
      ]) {
        // The independent postgres.js connection is outside the observed call.
        await sql`UPDATE dbos_output_branches.workflow_status SET executor_id = 'before'`;
        const returned: Array<{ queryHash: string; rowCount: number | null; rows: pg.QueryResultRow[] }> = [];
        const forwardingClient = { query: async (text: string, values: unknown[]) => {
          const result = await client.query(text, values);
          returned.push({ queryHash: digest(text), rowCount: result.rowCount, rows: result.rows });
          return result;
        } };
        // Exact source pin + actual Bind + CommandComplete. A positive upsert
        // count cannot distinguish a fresh insert from an unchanged loser;
        // keep its payload unknown. The executor UPDATE has an exact zero/all
        // contract. Changed SDKs remain unregistered pending source review.
        const tap = observeGroundedStoreOperations({ scope, deps: {}, operations: [], sourceRef: writerSourceRef,
          attemptId: control.name, nodePostgres: [{ pool: 'dbos-branches', clientPrototype: pg.Client.prototype,
            queryPrototype: pg.Query.prototype, serializerSourceRef }],
          serializedSqlParameters: reviewedWriter ? [
            { pool: 'dbos-branches', sourceRef: writerSourceRef, serializerSourceRef, queryHash: digest(outputStatement),
              command: 'INSERT', parameterCount: 10, persistedParameters: [2, 3], allOrNoneRows: 'zero-only' },
            { pool: 'dbos-branches', sourceRef: writerSourceRef, serializerSourceRef, queryHash: digest(executorStatement),
              command: 'UPDATE', parameterCount: 2, persistedParameters: [0], allOrNoneRows: 1 },
          ] : [] });
        try {
          const recording = tap.run(() => SystemDatabase.prototype.recordOperationResultInternal.call(
            { schemaName: 'dbos_output_branches', appName: 'branch-proof' }, forwardingClient,
            'branch-workflow', 1, 'branch-step', control.checkConflict, 1, control.end,
            { output: control.output, serialization: 'native-branch-test' }));
          if (control.conflict) await expect(recording).rejects.toBeInstanceOf(DBOSWorkflowConflictError);
          else await expect(recording).resolves.toBeUndefined();
          const census = tap.seal();
          const [stored] = await sql`SELECT output, completed_at_epoch_ms::text AS completed_at,
            function_name, application_name, serialization FROM dbos_output_branches.operation_outputs`;
          const [status] = await sql`SELECT executor_id FROM dbos_output_branches.workflow_status`;
          expect(stored).toEqual({ output: original, completed_at: '101', function_name: 'branch-step',
            application_name: 'branch-proof', serialization: 'native-branch-test' });
          expect(returned).toHaveLength(control.calls);
          expect(returned[0]).toMatchObject(insertWinner && control.name !== 'fresh-insert'
            ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ completed_at_epoch_ms: '101' }] });
          if (control.calls === 2) expect(status.executor_id).not.toBe('before');
          else expect(status.executor_id).toBe('before');
          expect(census.complete).toBe(true);
          expect(census.rows).toHaveLength(control.calls);
          expect(census.ids).toHaveLength(control.calls);
          expect(census.diagnostics.pending).toBe(0);
          if (reviewedWriter) {
            expect(census.rows[0]).toMatchObject({ kind: 'write', persistedBytes: null,
              sql: { rowOutcome: { allOrNoneRows: 'zero-only', affectedRows: 1 } } });
            if (control.calls === 2) expect(census.rows[1]).toMatchObject({ kind: 'write',
              persistedBytes: Buffer.byteLength(status.executor_id ?? ''),
              sql: { rowOutcome: { allOrNoneRows: 1, affectedRows: 1 } } });
          } else expect(census.rows.every(row => row.kind === 'unknown' && row.persistedBytes === null)).toBe(true);
          expect(census.diagnostics.admissions[0]!.boundParameters).toMatchObject({ serializerSourceRef,
            complete: true, parameterCount: 10, values: expect.arrayContaining([
              { parameter: 2, sha256: digest(control.output), bytes: Buffer.byteLength(control.output) },
              { parameter: 7, sha256: digest(String(control.end)), bytes: Buffer.byteLength(String(control.end)) },
            ]) });
          captures.push({ control, returned, stored, status, census });
        } finally { tap.restore(); }
      }
    } finally { await client.end(); }
    if (process.env.PAPERCUSP_TEST_ARTIFACT_DIR) await writeFile(join(process.env.PAPERCUSP_TEST_ARTIFACT_DIR,
      'gec-installed-dbos-output-branches.json'), JSON.stringify({ writerSourceRef, serializerSourceRef, captures }));
  });

  it('rejects same-timestamp DBOS checkpoint losers through the saved dependency patch', async () => {
    const require = createRequire(import.meta.url);
    const sdkDirectory = dirname(require.resolve('@dbos-inc/dbos-sdk'));
    const fixture = await mkdtemp(join(tmpdir(), 'dbos-checkpoint-winner-'));
    const patch = await readFile(new URL('../../../patches/@dbos-inc+dbos-sdk+4.27.6.patch', import.meta.url), 'utf8');
    const target = 'node_modules/@dbos-inc/dbos-sdk/dist/src/system_database.js';
    const block = patch.split('diff --git ').find(value => value.startsWith(`a/${target} b/${target}\n`));
    expect(block, 'saved patch must contain the actual SDK writer').toBeDefined();
    const hashes = block!.match(/\nindex ([a-f0-9]+)\.\.([a-f0-9]+) /)!;
    const gitBlob = (bytes: Buffer) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    const writerPath = join(fixture, 'sdk/dist/src/system_database.js');
    const clients = [new pg.Client({ connectionString: db.url }), new pg.Client({ connectionString: db.url })];
    const captures: unknown[] = [];
    try {
      // Apply the real patch-package effect to a disposable SDK, with ordinary
      // dependency resolution. Never rewrite the shared installed package here.
      await cp(join(sdkDirectory, '../..'), join(fixture, 'sdk'), { recursive: true });
      await symlink(new URL('../../../node_modules', import.meta.url), join(fixture, 'node_modules'), 'dir');
      const before = gitBlob(await readFile(writerPath));
      expect([hashes[1], hashes[2]]).toContain(before);
      if (before === hashes[1]) {
        const { parsePatchFile } = require('patch-package/dist/patch/parse.js') as {
          parsePatchFile: (text: string) => Array<{ type: string; path: string }> };
        const { executeEffects } = require('patch-package/dist/patch/apply.js') as {
          executeEffects: (effects: unknown[], options: { cwd: string; dryRun: boolean }) => void };
        const effects = parsePatchFile(patch).filter(effect => effect.path === target)
          .map(effect => ({ ...effect, path: 'sdk/dist/src/system_database.js' }));
        expect(effects).toHaveLength(1);
        executeEffects(effects, { cwd: fixture, dryRun: true });
        executeEffects(effects, { cwd: fixture, dryRun: false });
      }
      expect(gitBlob(await readFile(writerPath))).toBe(hashes[2]);
      type Writer = (this: { schemaName: string; appName: string }, client: { query: pg.Client['query'] },
        workflow: string, id: number, name: string, checked: boolean, start: number, end: number,
        options: { output?: string; error?: string; serialization: string }) => Promise<void>;
      const { SystemDatabase } = require(writerPath) as { SystemDatabase: { prototype: { recordOperationResultInternal: Writer } } };
      const { DBOSWorkflowConflictError } = require(join(fixture, 'sdk/dist/src/error.js')) as {
        DBOSWorkflowConflictError: new (...args: never[]) => Error };
      await sql`CREATE SCHEMA dbos_checkpoint_winner`;
      await sql`CREATE TABLE dbos_checkpoint_winner.operation_outputs (
        workflow_uuid text NOT NULL, function_id integer NOT NULL, output text, error text, function_name text,
        child_workflow_id text, started_at_epoch_ms bigint, completed_at_epoch_ms bigint, serialization text,
        application_name text, checkpoint_invocation_id text, PRIMARY KEY (workflow_uuid, function_id))`;
      await sql`CREATE TABLE dbos_checkpoint_winner.workflow_status (workflow_uuid text PRIMARY KEY, executor_id text)`;
      await sql`INSERT INTO dbos_checkpoint_winner.workflow_status VALUES ('sequential', 'before'), ('race', 'before')`;
      await Promise.all(clients.map(client => client.connect()));
      const invoke = async (client: pg.Client, workflow: string, options: { output?: string; error?: string },
        checked = true, end = 101) => {
        const returned: Array<{ rowCount: number | null; rows: pg.QueryResultRow[] }> = [];
        const forwarding = { query: async (text: string, values: unknown[]) => {
          const result = await client.query(text, values);
          returned.push({ rowCount: result.rowCount, rows: result.rows });
          return result;
        } };
        try {
          await SystemDatabase.prototype.recordOperationResultInternal.call(
            { schemaName: 'dbos_checkpoint_winner', appName: 'patched-winner' }, forwarding as { query: pg.Client['query'] },
            workflow, 1, 'winner-step', checked, 1, end, { ...options, serialization: 'winner-control' });
          return { outcome: 'success', options, checked, end, returned };
        } catch (error) {
          expect(error).toBeInstanceOf(DBOSWorkflowConflictError);
          return { outcome: 'conflict', options, checked, end, returned };
        }
      };
      const original = '{"winner":"A-λ.😺"}';
      const fresh = await invoke(clients[0], 'sequential', { output: original });
      expect(fresh).toMatchObject({ outcome: 'success', returned: [{ rowCount: 1 }, { rowCount: 1 }] });
      captures.push(fresh);
      for (const control of [
        { output: original, checked: true, end: 101 },
        { output: 'different', checked: true, end: 101 },
        { error: 'losing-error', checked: true, end: 101 },
        { output: 'later', checked: true, end: 202 },
        { output: 'unchecked', checked: false, end: 101 },
        { error: 'unchecked-error', checked: false, end: 202 },
      ]) {
        await sql`UPDATE dbos_checkpoint_winner.workflow_status SET executor_id = 'before' WHERE workflow_uuid = 'sequential'`;
        const result = await invoke(clients[1], 'sequential', control, control.checked, control.end);
        expect(result).toMatchObject({ outcome: control.checked ? 'conflict' : 'success', returned: [{ rowCount: 0, rows: [] }] });
        expect(result.returned).toHaveLength(1);
        expect(await sql`SELECT output, error, completed_at_epoch_ms::text AS completed_at
          FROM dbos_checkpoint_winner.operation_outputs WHERE workflow_uuid = 'sequential'`)
          .toEqual([{ output: original, error: null, completed_at: '101' }]);
        expect(await sql`SELECT executor_id FROM dbos_checkpoint_winner.workflow_status WHERE workflow_uuid = 'sequential'`)
          .toEqual([{ executor_id: 'before' }]);
        captures.push(result);
      }
      const race = await Promise.all(clients.map((client, index) => invoke(client, 'race', { output: `racer-${index}` })));
      expect(race.map(result => result.outcome).sort()).toEqual(['conflict', 'success']);
      const winner = race.find(result => result.outcome === 'success')!;
      expect(winner.returned.map(result => result.rowCount)).toEqual([1, 1]);
      expect(race.find(result => result.outcome === 'conflict')!.returned).toEqual([{ rowCount: 0, rows: [] }]);
      expect(await sql`SELECT output FROM dbos_checkpoint_winner.operation_outputs WHERE workflow_uuid = 'race'`)
        .toEqual([{ output: winner.options.output }]);
      captures.push({ race });
      if (process.env.PAPERCUSP_TEST_ARTIFACT_DIR) await writeFile(join(process.env.PAPERCUSP_TEST_ARTIFACT_DIR,
        'gec-patched-dbos-checkpoint-winner.json'), JSON.stringify({ patchHash: createHash('sha256').update(patch).digest('hex'),
        before, after: hashes[2], sharedPackageMutated: false, captures }));
    } finally {
      await Promise.all(clients.map(client => client.end()));
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('installs the complete DBOS patch with its CLI and replays public SDK steps after restart', async () => {
    const require = createRequire(import.meta.url);
    const sharedModules = new URL('../../../node_modules', import.meta.url);
    const sdkDirectory = dirname(require.resolve('@dbos-inc/dbos-sdk'));
    const fixture = await mkdtemp(join(tmpdir(), 'dbos-cli-replay-'));
    const packagePath = join(fixture, 'node_modules/@dbos-inc/dbos-sdk');
    const patchName = '@dbos-inc+dbos-sdk+4.27.6.patch';
    const patch = await readFile(new URL(`../../../patches/${patchName}`, import.meta.url), 'utf8');
    const gitBlob = (bytes: Buffer) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
    const helpersUrl = new URL('../../../scripts/check-installed-patch-postimages.mjs', import.meta.url).href;
    const { parsePatchPostimages, verifyPostimages } = await import(helpersUrl) as {
      parsePatchPostimages: (source: string, path: string) => Array<{ path: string; hash: string }>;
      verifyPostimages: (options: { patches: Array<{ path: string; contents: string }>;
        hashInstalled: (path: string) => string }) => { ok: boolean; checked: number; errors: string[] };
    };
    type Effect = { type: string; path: string; beforeHash: string; afterHash: string };
    const { parsePatchFile } = require('patch-package/dist/patch/parse.js') as {
      parsePatchFile: (source: string) => Effect[] };
    const { reversePatch } = require('patch-package/dist/patch/reverse.js') as {
      reversePatch: (effects: Effect[]) => Effect[] };
    const { executeEffects } = require('patch-package/dist/patch/apply.js') as {
      executeEffects: (effects: Effect[], options: { cwd: string; dryRun: boolean }) => void };
    const effects = parsePatchFile(patch);
    const targets = parsePatchPostimages(patch, patchName);
    expect(targets.map(target => target.path).sort()).toEqual([
      'node_modules/@dbos-inc/dbos-sdk/dist/src/debugpoint.js',
      'node_modules/@dbos-inc/dbos-sdk/dist/src/sysdb_migrations/internal/migrations.js',
      'node_modules/@dbos-inc/dbos-sdk/dist/src/system_database.js',
    ]);
    const sharedBefore = targets.map(target => digest(readFileSync(new URL(`../../../${target.path}`, import.meta.url))));
    let DBOS: typeof import('@dbos-inc/dbos-sdk').DBOS | undefined;
    let releaseStep: (() => void) | undefined;
    let adoptionResult: Promise<unknown> | undefined;
    let adoptionSettled = false;
    const adoptionId = 'cli-replay-checkpoint-loser';
    const restores: Array<() => void> = [];
    const rivalPool = new pg.Pool({ connectionString: db.url, max: 1 });
    let rivalDatabase: { destroy(): Promise<void> } | undefined;
    const bounded = async <T,>(promise: Promise<T>, label: string): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([promise, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 10_000);
        })]);
      } finally { clearTimeout(timer); }
    };
    const capture: Record<string, unknown> = { stage: 'prepare', patchHash: digest(patch),
      environment: { home: process.env.HOME, workspace: process.env.PAPERCUSP_WORKSPACE,
        pgPort: process.env.PAPERCUSP_PG_PORT, skipDiscovery: process.env.PAPERCUSP_SKIP_PG_DISCOVERY,
        productCredentialKeys: Object.keys(process.env).filter(key => /^(OPENAI_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|GITHUB_TOKEN|PAPERCUSP_SID)$/.test(key)) } };
    try {
      await mkdir(dirname(packagePath), { recursive: true });
      await cp(join(sdkDirectory, '../..'), packagePath, { recursive: true });
      // Preserve the SDK's own nested dependencies. Missing packages resolve
      // through an ancestor fallback; both patch targets stay private files.
      await symlink(sharedModules, join(dirname(packagePath), 'node_modules'), 'dir');
      expect(existsSync(join(packagePath, 'node_modules'))).toBe(existsSync(join(sdkDirectory, '../../node_modules')));
      expect(require.resolve('pg', { paths: [packagePath] })).toBe(require.resolve('pg'));
      await mkdir(join(fixture, 'patches'));
      await writeFile(join(fixture, 'package.json'), JSON.stringify({ name: 'dbos-cli-replay-fixture',
        version: '1.0.0', private: true, dependencies: { '@dbos-inc/dbos-sdk': '4.27.6' } }));
      await writeFile(join(fixture, 'patches', patchName), patch);
      // A developer installation may already contain either patch. Normalize
      // only the private candidate to verified preimages before invoking CLI.
      for (const effect of effects) {
        expect(effect.type).toBe('patch');
        const current = gitBlob(await readFile(join(fixture, effect.path)));
        expect(current.startsWith(effect.beforeHash) || current.startsWith(effect.afterHash)).toBe(true);
        if (current.startsWith(effect.afterHash)) {
          executeEffects(reversePatch([effect]), { cwd: fixture, dryRun: true });
          executeEffects(reversePatch([effect]), { cwd: fixture, dryRun: false });
        }
        expect(gitBlob(await readFile(join(fixture, effect.path))).startsWith(effect.beforeHash)).toBe(true);
      }
      const cli = await promisify(execFile)(process.execPath,
        [require.resolve('patch-package/index.js'), '--error-on-fail'],
        { cwd: fixture, timeout: 30_000, maxBuffer: 1024 * 1024, env: { ...process.env, INIT_CWD: fixture } });
      const postimages = verifyPostimages({ patches: [{ path: `patches/${patchName}`, contents: patch }],
        hashInstalled: path => gitBlob(readFileSync(join(fixture, path))) });
      Object.assign(capture, { stage: 'installed', cli, postimages });
      expect(postimages).toMatchObject({ ok: true, checked: 3, errors: [] });

      // Load the candidate's PUBLIC entry and use its real migrations,
      // executor and persistence. No copied writer or synthetic SDK is used.
      ({ DBOS } = require(join(packagePath, 'dist/src/index.js')) as typeof import('@dbos-inc/dbos-sdk'));
      const sdk = DBOS;
      const calls = { workflow: 0, first: 0, second: 0 };
      sdk.setConfig({ name: 'dbos-cli-replay', systemDatabaseUrl: db.url,
        systemDatabaseSchemaName: 'dbos_cli_replay', applicationVersion: 'cli-replay-v1',
        runAdminServer: false, logLevel: 'error' });
      const workflow = sdk.registerWorkflow(async () => {
        calls.workflow++;
        const first = await sdk.runStep(async () => ({ original: `λ.😺-${++calls.first}` }), { name: 'first' });
        const second = await sdk.runStep(async () => ++calls.second, { name: 'second' });
        return { first, second };
      }, { name: 'installedPatchReplay' });
      let enterStep!: () => void;
      const stepEntered = new Promise<void>(resolve => { enterStep = resolve; });
      const stepReleased = new Promise<void>(resolve => { releaseStep = resolve; });
      const adoptionCalls = { step: 0, afterStep: 0 };
      const adoptionWorkflow = sdk.registerWorkflow(async () => {
        await sdk.runStep(async () => {
          adoptionCalls.step++;
          enterStep();
          await stepReleased;
          return { winner: 'local-loser' };
        }, { name: 'contested-step' });
        adoptionCalls.afterStep++;
        return { winner: 'local-workflow-must-not-finish' };
      }, { name: 'installedPatchCheckpointLoser' });
      await sdk.launch();
      const original = await sdk.withNextWorkflowID('cli-replay-original', () => workflow());
      Object.assign(capture, { stage: 'original', original, calls: { ...calls } });
      expect(original).toEqual({ first: { original: 'λ.😺-1' }, second: 1 });
      const beforeRestart = await sql`SELECT function_id, function_name, output, error, serialization
        FROM dbos_cli_replay.operation_outputs WHERE workflow_uuid = 'cli-replay-original' ORDER BY function_id`;
      capture.beforeRestart = beforeRestart;
      expect(beforeRestart.map(row => row.function_name)).toEqual(['first', 'second']);
      expect(beforeRestart.map(row => row.function_id)).toEqual([0, 1]);
      expect(beforeRestart.every(row => row.output !== null && row.error === null)).toBe(true);
      await sdk.shutdown();
      await sdk.launch();
      const retrieved = await sdk.retrieveWorkflow('cli-replay-original').getResult();
      Object.assign(capture, { stage: 'restarted', retrieved, calls: { ...calls } });
      expect(retrieved).toEqual(original);
      expect(calls).toEqual({ workflow: 1, first: 1, second: 1 });
      // DBOS step IDs start at zero; fork copies only IDs below startStep.
      // Select the second step's persisted ID so only its callback runs again.
      const replayFromStep = Number(beforeRestart[1].function_id);
      capture.replayFromStep = replayFromStep;
      const fork = await sdk.forkWorkflow('cli-replay-original', replayFromStep, { newWorkflowID: 'cli-replay-fork' });
      const replay = await fork.getResult();
      const afterRestart = await sql`SELECT workflow_uuid, function_id, function_name, output, error, serialization
        FROM dbos_cli_replay.operation_outputs ORDER BY workflow_uuid, function_id`;
      Object.assign(capture, { stage: 'replayed', replay, calls: { ...calls }, afterRestart,
        candidateEntryHash: digest(await readFile(join(packagePath, 'dist/src/index.js'))) });
      expect(replay).toEqual({ first: original.first, second: 2 });
      expect(calls).toEqual({ workflow: 2, first: 1, second: 2 });
      const forkFirst = afterRestart.find(row => row.workflow_uuid === 'cli-replay-fork'
        && row.function_id === beforeRestart[0].function_id);
      expect(forkFirst).toMatchObject(beforeRestart[0]);
      expect(afterRestart).toHaveLength(4);

      // Exercise the real public executor, not just its persistence method.
      // Observe and forward SDK calls unchanged; only the step callback pauses.
      type NativeDatabase = {
        destroy(): Promise<void>;
        checkForRunningWorkflow(id: string): boolean;
        recordOperationResult(id: string, functionId: number, name: string, checked: boolean,
          start: number, end: number, options: { output: string; serialization: string }): Promise<void>;
        awaitWorkflowResult(id: string, timeout?: number, caller?: string, timer?: number,
          polling?: number, failIfMissing?: boolean): Promise<unknown>;
        recordWorkflowOutput(id: string, status: { output: string }): Promise<boolean>;
      };
      const { SystemDatabase } = require(join(packagePath, 'dist/src/system_database.js')) as {
        SystemDatabase: { new (...args: unknown[]): NativeDatabase; prototype: NativeDatabase } };
      const { DBOSWorkflowConflictError } = require(join(packagePath, 'dist/src/error.js')) as {
        DBOSWorkflowConflictError: new (...args: never[]) => Error };
      const { DBOSJSON } = require(join(packagePath, 'dist/src/serialization.js')) as {
        DBOSJSON: { stringify(value: unknown): string; name(): string } };
      const adoption: Record<string, unknown> = { calls: adoptionCalls, conflicts: [], awaits: [],
        executorHash: digest(await readFile(join(packagePath, 'dist/src/dbos-executor.js'))) };
      capture.adoption = adoption;
      const originalRecord = SystemDatabase.prototype.recordOperationResult;
      const recordSpy = vi.spyOn(SystemDatabase.prototype, 'recordOperationResult').mockImplementation(async function (
        this: NativeDatabase, ...args: Parameters<NativeDatabase['recordOperationResult']>
      ) {
        try { return await originalRecord.apply(this, args); }
        catch (error) {
          if (args[0] === adoptionId) (adoption.conflicts as unknown[]).push({
            realSdkConflict: error instanceof DBOSWorkflowConflictError,
            name: error instanceof Error ? error.constructor.name : String(error), functionId: args[1] });
          throw error;
        }
      });
      restores.push(() => recordSpy.mockRestore());
      let enteredAdoption!: () => void;
      const awaitingWinner = new Promise<void>(resolve => { enteredAdoption = resolve; });
      const originalAwait = SystemDatabase.prototype.awaitWorkflowResult;
      const awaitSpy = vi.spyOn(SystemDatabase.prototype, 'awaitWorkflowResult').mockImplementation(function (
        this: NativeDatabase, ...args: Parameters<NativeDatabase['awaitWorkflowResult']>
      ) {
        if (args[0] === adoptionId && args[5] === true) {
          (adoption.awaits as unknown[]).push({ failIfMissing: args[5],
            runningMapReleased: !this.checkForRunningWorkflow(adoptionId),
            afterStep: adoptionCalls.afterStep, settled: adoptionSettled });
          enteredAdoption();
        }
        return originalAwait.apply(this, args);
      });
      restores.push(() => awaitSpy.mockRestore());
      const log = () => {};
      const rival = new SystemDatabase(db.url, { debug: log, info: log, warn: log, error: log },
        DBOSJSON, 1, rivalPool, 'dbos_cli_replay', false);
      rivalDatabase = rival;
      adoptionResult = sdk.withNextWorkflowID(adoptionId, () => adoptionWorkflow());
      void adoptionResult.then(() => { adoptionSettled = true; }, () => { adoptionSettled = true; });
      await bounded(stepEntered, 'public step callback');
      const winnerStep = DBOSJSON.stringify({ winner: 'independent-step-λ.😺' });
      await rival.recordOperationResult(adoptionId, 0, 'contested-step', true, 1, 101,
        { output: winnerStep, serialization: DBOSJSON.name() });
      adoption.checkpointBeforeRelease = await sql`SELECT function_id, output, error, serialization,
        checkpoint_invocation_id FROM dbos_cli_replay.operation_outputs WHERE workflow_uuid = ${adoptionId}`;
      releaseStep!();
      await bounded(awaitingWinner, 'executor adopting genuine checkpoint conflict');
      adoption.beforeTerminal = await sql`SELECT status, output, error FROM dbos_cli_replay.workflow_status
        WHERE workflow_uuid = ${adoptionId}`;
      const winner = { winner: 'independent-workflow-λ.😺', at: new Date('2026-01-02T03:04:05.000Z') };
      adoption.winnerSerialized = DBOSJSON.stringify(winner);
      adoption.terminalRecorded = await rival.recordWorkflowOutput(adoptionId, { output: String(adoption.winnerSerialized) });
      adoption.returned = await bounded(adoptionResult, 'public workflow winner result');
      adoption.retrieved = await bounded(sdk.retrieveWorkflow(adoptionId).getResult(), 'stored winner result');
      adoption.checkpointAfter = await sql`SELECT function_id, output, error, serialization,
        checkpoint_invocation_id FROM dbos_cli_replay.operation_outputs WHERE workflow_uuid = ${adoptionId}`;
      adoption.terminalAfter = await sql`SELECT status, output, error FROM dbos_cli_replay.workflow_status
        WHERE workflow_uuid = ${adoptionId}`;
      // Preserve every observation before checking the adoption oracles.
      expect(adoption.conflicts).toEqual([{ realSdkConflict: true, name: 'DBOSWorkflowConflictError', functionId: 0 }]);
      expect(adoption.awaits).toEqual([{ failIfMissing: true, runningMapReleased: true, afterStep: 0, settled: false }]);
      expect(adoption.beforeTerminal).toEqual([{ status: 'PENDING', output: null, error: null }]);
      expect(adoption.terminalRecorded).toBe(true);
      expect(adoption.returned).toEqual(winner);
      expect(adoption.retrieved).toEqual(winner);
      expect(adoptionCalls).toEqual({ step: 1, afterStep: 0 });
      expect(adoption.checkpointBeforeRelease).toEqual([{ function_id: 0, output: winnerStep,
        error: null, serialization: DBOSJSON.name(), checkpoint_invocation_id: expect.any(String) }]);
      expect(adoption.checkpointAfter).toEqual(adoption.checkpointBeforeRelease);
      expect(adoption.terminalAfter).toEqual([{ status: 'SUCCESS', output: adoption.winnerSerialized, error: null }]);
      capture.stage = 'verified';
    } catch (error) {
      capture.failure = error instanceof Error ? { message: error.message, stack: error.stack } : String(error);
      throw error;
    } finally {
      try {
        try {
          releaseStep?.();
          if (DBOS?.isInitialized() && adoptionResult && !adoptionSettled) await DBOS.cancelWorkflow(adoptionId);
          if (adoptionResult) await bounded(adoptionResult.catch(() => {}), 'cleanup public workflow drain');
          capture.adoptionDrained = !adoptionResult || adoptionSettled;
        } finally {
          for (const restore of restores.reverse()) restore();
          try { if (DBOS) await DBOS.shutdown({ deregister: true }); }
          finally {
            try { await rivalDatabase?.destroy(); }
            finally { await rivalPool.end(); }
          }
        }
      } finally {
        await rm(fixture, { recursive: true, force: true });
        const sharedAfter = targets.map(target => digest(readFileSync(new URL(`../../../${target.path}`, import.meta.url))));
        if (process.env.PAPERCUSP_TEST_ARTIFACT_DIR) await writeFile(join(process.env.PAPERCUSP_TEST_ARTIFACT_DIR,
          'gec-dbos-cli-public-replay.json'), JSON.stringify({ ...capture, sharedBefore, sharedAfter,
            candidateRemoved: true, sdkStopped: !DBOS?.isInitialized() }));
        expect(sharedAfter).toEqual(sharedBefore);
      }
    }
  }, 90_000);

  it('preserves decorated DBOS checkpoint identity across retries and uncommitted competitors', async () => {
    const require = createRequire(import.meta.url);
    const sdkDirectory = dirname(require.resolve('@dbos-inc/dbos-sdk'));
    const fixture = await mkdtemp(join(tmpdir(), 'dbos-public-retry-'));
    const writerPath = join(fixture, 'sdk/dist/src/system_database.js');
    const target = 'node_modules/@dbos-inc/dbos-sdk/dist/src/system_database.js';
    const patch = await readFile(new URL('../../../patches/@dbos-inc+dbos-sdk+4.27.6.patch', import.meta.url), 'utf8');
    const block = patch.split('diff --git ').find(value => value.startsWith(`a/${target} b/${target}\n`))!;
    const hashes = block.match(/\nindex ([a-f0-9]+)\.\.([a-f0-9]+) /)!;
    const gitBlob = (bytes: Buffer) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    const sharedBefore = gitBlob(await readFile(join(sdkDirectory, 'system_database.js')));
    const pool = new pg.Pool({ connectionString: db.url, max: 2 });
    const rivalPool = new pg.Pool({ connectionString: db.url, max: 1 });
    const rival = new pg.Client({ connectionString: db.url });
    const capture: Record<string, unknown> = { stage: 'prepare', patchHash: createHash('sha256').update(patch).digest('hex') };
    const observations: Array<Record<string, unknown>> = [];
    let database: { init(): Promise<void>; destroy(): Promise<void>;
      recordOperationResult(workflow: string, id: number, name: string, checked: boolean,
        start: number, end: number, options: { output: string; serialization: string }): Promise<void>;
      recordOperationResultInternal(client: pg.PoolClient, workflow: string, id: number, name: string,
        checked: boolean, start: number, end: number,
        options: { output: string; serialization: string }): Promise<void> } | undefined;
    let rivalDatabase: typeof database;
    let restoreRetry: (() => void) | undefined;
    let restoreConnect: (() => void) | undefined;
    let heldRival: pg.PoolClient | undefined;
    let pendingRecord: Promise<void> | undefined;
    const originalQueries = new Map<pg.PoolClient, pg.PoolClient['query']>();
    try {
      await cp(join(sdkDirectory, '../..'), join(fixture, 'sdk'), { recursive: true });
      await symlink(new URL('../../../node_modules', import.meta.url), join(fixture, 'node_modules'), 'dir');
      const before = gitBlob(await readFile(writerPath));
      expect([hashes[1], hashes[2]]).toContain(before);
      const { parsePatchFile } = require('patch-package/dist/patch/parse.js') as {
        parsePatchFile(source: string): Array<{ path: string; beforeHash: string; afterHash: string }> };
      const { executeEffects } = require('patch-package/dist/patch/apply.js') as {
        executeEffects(effects: unknown[], options: { cwd: string; dryRun: boolean }): void };
      for (const effect of parsePatchFile(patch)) {
        const candidateEffect = { ...effect, path: effect.path.replace('node_modules/@dbos-inc/dbos-sdk/', 'sdk/') };
        const hash = gitBlob(await readFile(join(fixture, candidateEffect.path)));
        expect(hash.startsWith(effect.beforeHash) || hash.startsWith(effect.afterHash)).toBe(true);
        if (hash.startsWith(effect.beforeHash)) {
          executeEffects([candidateEffect], { cwd: fixture, dryRun: true });
          executeEffects([candidateEffect], { cwd: fixture, dryRun: false });
        }
        expect(gitBlob(await readFile(join(fixture, candidateEffect.path))).startsWith(effect.afterHash)).toBe(true);
      }
      expect(gitBlob(await readFile(writerPath))).toBe(hashes[2]);
      const { SystemDatabase } = require(writerPath) as { SystemDatabase: new (...args: unknown[]) => NonNullable<typeof database> };
      const { DBOSWorkflowConflictError } = require(join(fixture, 'sdk/dist/src/error.js')) as {
        DBOSWorkflowConflictError: new (...args: never[]) => Error };
      const { dbRetryConfig, globalParams } = require(join(fixture, 'sdk/dist/src/utils.js')) as {
        dbRetryConfig: { initialBackoffSec: number; maxBackoffSec: number }; globalParams: { executorID: string } };
      const retryBefore = { ...dbRetryConfig };
      restoreRetry = () => Object.assign(dbRetryConfig, retryBefore);
      Object.assign(dbRetryConfig, { initialBackoffSec: 0, maxBackoffSec: 0 });
      const logs: unknown[][] = [];
      const log = (...args: unknown[]) => { logs.push(args); };
      database = new SystemDatabase(db.url, { debug: log, info: log, warn: log, error: log }, {},
        2, pool, 'dbos_public_retry', false);
      rivalDatabase = new SystemDatabase(db.url, { debug: log, info: log, warn: log, error: log }, {},
        1, rivalPool, 'dbos_public_retry', false);
      // Run the candidate SDK's maintained migrations, before fault injection.
      await database.init();
      await rival.connect();
      capture.stage = 'migrated';
      let active: { mode: string; injected: number; queries: unknown[]; writerPid?: number } | undefined;
      const connect = pool.connect.bind(pool);
      const connectSpy = vi.spyOn(pool, 'connect').mockImplementation(async () => {
        const client = await connect();
        if (!originalQueries.has(client)) originalQueries.set(client, client.query);
        const original = originalQueries.get(client)!.bind(client);
        active!.writerPid = (await original('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        client.query = (async (text: string, values?: unknown[]) => {
          const current = active!;
          const insert = text.startsWith('INSERT INTO dbos_public_retry.operation_outputs');
          const marker = text.startsWith('UPDATE "dbos_public_retry".workflow_status');
          const entry: Record<string, unknown> = { text, values };
          current.queries.push(entry);
          if (current.injected === 0 && ((current.mode === 'marker' && marker)
            || (['insert-ack-loss', 'identical-rival'].includes(current.mode) && insert))) {
            current.injected++;
            if (current.mode === 'insert-ack-loss') {
              const committed = await original(text, values);
              entry.committedBeforeLostAck = { rowCount: committed.rowCount, rows: committed.rows };
            } else if (current.mode === 'identical-rival') {
              // Our first INSERT never executes. A separate writer wins with
              // identical payload/times; it must NOT be mistaken for our retry.
              await rivalDatabase!.recordOperationResult(String(values![0]), 0, 'retry-step', true, 1, 101,
                { output: '{"winner":"same-λ.😺"}', serialization: 'retry-control' });
              entry.independentWinner = await rival.query('SELECT checkpoint_invocation_id FROM dbos_public_retry.operation_outputs WHERE workflow_uuid = $1', [values![0]]);
              await rival.query('UPDATE dbos_public_retry.workflow_status SET executor_id = $1 WHERE workflow_uuid = $2',
                ['rival', values![0]]);
            }
            entry.injectedError = 'ECONNRESET';
            throw Object.assign(new Error('controlled committed-checkpoint retry fault'), { code: 'ECONNRESET' });
          }
          const result = await original(text, values);
          Object.assign(entry, { rowCount: result.rowCount, rows: result.rows });
          return result;
        }) as pg.PoolClient['query'];
        return client;
      });
      restoreConnect = () => connectSpy.mockRestore();
      for (const mode of ['marker', 'insert-ack-loss', 'identical-rival', 'competitor-commit', 'competitor-abort']) {
        await sql`INSERT INTO dbos_public_retry.workflow_status (workflow_uuid, status, name, executor_id)
          VALUES (${mode}, 'PENDING', 'publicRetry', 'before')`;
        const contention: Record<string, unknown> = {};
        if (mode.startsWith('competitor-')) {
          heldRival = await rivalPool.connect();
          await heldRival.query('BEGIN');
          contention.rivalPid = (await heldRival.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          // Actual SDK writer on a reserved, still-open transaction. Its null
          // invocation identity also exercises compatibility with legacy rows.
          await rivalDatabase.recordOperationResultInternal(heldRival, mode, 0, 'retry-step', true, 1, 101,
            { output: '{"winner":"same-λ.😺"}', serialization: 'retry-control' });
          await heldRival.query('UPDATE dbos_public_retry.workflow_status SET executor_id = $1 WHERE workflow_uuid = $2',
            ['rival', mode]);
          contention.uncommittedRow = (await heldRival.query(
            'SELECT output, checkpoint_invocation_id FROM dbos_public_retry.operation_outputs WHERE workflow_uuid = $1', [mode])).rows;
        }
        active = { mode, injected: 0, queries: [] };
        let outcome = 'success', failure: unknown;
        try {
          let settled = false;
          pendingRecord = database.recordOperationResult(mode, 0, 'retry-step', true, 1, 101,
            { output: '{"winner":"same-λ.😺"}', serialization: 'retry-control' });
          // Attach rejection handling immediately while the independent observer
          // waits for a measured lock, so no rejection can go unobserved.
          void pendingRecord.then(() => { settled = true; }, () => { settled = true; });
          if (heldRival) {
            const deadline = Date.now() + 10_000;
            let lockObserved = false;
            while (Date.now() < deadline && !settled) {
              if (active.writerPid) {
                const activity = await sql`SELECT pid, state, wait_event_type, wait_event,
                  pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid = ${active.writerPid}`;
                contention.activity = activity;
                if (activity[0]?.wait_event_type === 'Lock'
                  && activity[0].blockers.includes(contention.rivalPid)) {
                  lockObserved = true;
                  break;
                }
              }
              await new Promise(resolve => setTimeout(resolve, 10));
            }
            Object.assign(contention, { lockObserved, settledBeforeRelease: settled,
              visibleRowsBeforeRelease: await sql`SELECT output FROM dbos_public_retry.operation_outputs WHERE workflow_uuid = ${mode}`,
              visibleMarkerBeforeRelease: await sql`SELECT executor_id FROM dbos_public_retry.workflow_status WHERE workflow_uuid = ${mode}` });
            const release = mode === 'competitor-commit' ? 'COMMIT' : 'ROLLBACK';
            contention.release = release;
            await heldRival.query(release);
            heldRival.release(); heldRival = undefined;
          }
          await pendingRecord;
        } catch (error) {
          outcome = error instanceof DBOSWorkflowConflictError ? 'conflict' : 'error';
          failure = error instanceof Error ? { name: error.name, message: error.message } : String(error);
        } finally {
          if (heldRival) {
            await heldRival.query('ROLLBACK');
            heldRival.release(); heldRival = undefined;
          }
          await pendingRecord?.catch(() => {});
          pendingRecord = undefined;
        }
        const stored = await sql`SELECT output, error, completed_at_epoch_ms::text AS completed_at
          FROM dbos_public_retry.operation_outputs WHERE workflow_uuid = ${mode}`;
        const marker = await sql`SELECT executor_id FROM dbos_public_retry.workflow_status WHERE workflow_uuid = ${mode}`;
        const identity = await sql`SELECT checkpoint_invocation_id FROM dbos_public_retry.operation_outputs WHERE workflow_uuid = ${mode}`;
        observations.push({ ...active, outcome, failure, stored, marker, identity, contention });
      }
      Object.assign(capture, { stage: 'observed', observations, logs, executorID: globalParams.executorID });
      // Collect every control and independent row BEFORE asserting any oracle.
      for (const row of observations) {
        const competing = String(row.mode).startsWith('competitor-');
        const loser = ['identical-rival', 'competitor-commit'].includes(String(row.mode));
        expect(row.injected).toBe(competing ? 0 : 1);
        expect(row.stored).toEqual([{ output: '{"winner":"same-λ.😺"}', error: null, completed_at: '101' }]);
        expect(row.outcome).toBe(loser ? 'conflict' : 'success');
        expect(row.marker).toEqual([{ executor_id: loser ? 'rival' : globalParams.executorID }]);
        if (competing) {
          expect(row.contention).toMatchObject({ lockObserved: true, settledBeforeRelease: false,
            visibleRowsBeforeRelease: [], visibleMarkerBeforeRelease: [{ executor_id: 'before' }],
            uncommittedRow: [{ output: '{"winner":"same-λ.😺"}', checkpoint_invocation_id: null }] });
          expect(row.identity).toEqual([{ checkpoint_invocation_id: row.mode === 'competitor-commit' ? null : expect.any(String) }]);
        }
      }
      capture.stage = 'verified';
    } catch (error) {
      Object.assign(capture, { observations, failure: error instanceof Error ? { message: error.message, stack: error.stack } : String(error) });
      throw error;
    } finally {
      if (heldRival) {
        await heldRival.query('ROLLBACK');
        heldRival.release();
      }
      await pendingRecord?.catch(() => {});
      restoreConnect?.(); restoreRetry?.();
      for (const [client, query] of originalQueries) client.query = query;
      try { await database?.destroy(); await rivalDatabase?.destroy(); }
      finally {
        await rival.end(); await pool.end(); await rivalPool.end();
        await rm(fixture, { recursive: true, force: true });
        const sharedAfter = gitBlob(await readFile(join(sdkDirectory, 'system_database.js')));
        if (process.env.PAPERCUSP_TEST_ARTIFACT_DIR) await writeFile(join(process.env.PAPERCUSP_TEST_ARTIFACT_DIR,
          'gec-dbos-public-retry.json'), JSON.stringify({ ...capture, sharedBefore, sharedAfter, candidateRemoved: true }));
        expect(sharedAfter).toBe(sharedBefore);
      }
    }
  }, 90_000);

  it('measures queries held behind a reserved connection separately from their execution', async () => {
    const reserved = await sql.reserve();
    const queued = sql`SELECT 42 AS answer`;
    let result: Promise<postgres.Row[]> | undefined;
    let released = false;
    try {
      // Leave the lazy query unexecuted before starting the controlled wait.
      await new Promise(resolve => setTimeout(resolve, 40));
      expect((queued as unknown as { diagnosticHandleStartedAt?: number }).diagnosticHandleStartedAt).toBeUndefined();
      result = queued.execute().then(rows => rows);
      await vi.waitFor(() => expect(
        (queued as unknown as { diagnosticHandleStartedAt?: number }).diagnosticHandleStartedAt,
      ).toEqual(expect.any(Number)), { timeout: 1_000, interval: 5 });
      await new Promise(resolve => setTimeout(resolve, 120));
      reserved.release();
      released = true;
      expect((await result)[0].answer).toBe(42);
      const records = pgResultDiagnosticSnapshot('reserved-query-timing').results;
      const terminal = records.find(row => row.queryFamily === 'select' && row.command === 'select');
      expect(terminal).toBeDefined();
      expect((terminal as typeof terminal & { preBuildMs: number }).preBuildMs).toBeGreaterThanOrEqual(100);
      expect(terminal!.elapsedMs).toEqual(expect.any(Number));
      expect(terminal!.elapsedMs).toBeGreaterThanOrEqual(0);
    } finally {
      if (!released) reserved.release();
      await result?.catch(() => {});
    }
  });

  it('rejects every queued reserved query when Postgres closes the connection', async () => {
    const reserved = await sql.reserve();
    try {
      const [backend] = await reserved<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`;
      const active = reserved`SELECT pg_sleep(60)`.execute().then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      );
      const pipelined = reserved`SELECT 41 AS answer`.execute().then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      );
      const queued = reserved`SELECT 42 AS answer`.execute().then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      );

      await vi.waitFor(async () => {
        const [activity] = await db.sql<{ state: string }[]>`
          SELECT state FROM pg_stat_activity WHERE pid = ${backend.pid}`;
        expect(activity?.state).toBe('active');
      }, { timeout: 5_000, interval: 20 });

      const [terminated] = await db.sql<{ terminated: boolean }[]>`
        SELECT pg_terminate_backend(${backend.pid}) AS terminated`;
      expect(terminated.terminated).toBe(true);
      await expect(active).resolves.toBe('rejected');
      await expect(pipelined).resolves.toBe('rejected');

      let timer: ReturnType<typeof setTimeout> | undefined;
      const queuedResult = await Promise.race([
        queued,
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), 2_000);
        }),
      ]);
      if (timer) clearTimeout(timer);
      expect(queuedResult).toBe('rejected');
    } finally {
      reserved.release();
    }
  });
});
