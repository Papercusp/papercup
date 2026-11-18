/** Replace a live child tape without exposing a truncated published snapshot. */
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { GroundedCensus, GroundedMeasurementScope, GroundedNonPersistingSql, observeGroundedStoreOperations } from '../lib/grounded-evidence-measurement';

const crashFixtureSourceHash = '66ade3b1450e5573957875cb21131f24038de472faa8623a57aeb172cb30004e';
const fixtureSerializerSourceRef = 'source:postgres/src/connection.js@37fd9fb939eb686e75745dfaffaeea7ac6f697902cc8985e9894270ac7de0eeb'
  + '+types.js@1883bd4536eab1c94b9e708d325b13708b0f18ec80020e3a825f34a72f603b81#Bind';

/** Fixture-only AFTER-row receipts for the installed DBOS writer. The caller
 * supplies the complete ordered column census from its exclusive private DB.
 * Installation is setup, outside the measured child. These registrations never
 * reinterpret old tapes or infer bytes from final rows or bound parameters. */
export function reviewedDurableServerValues(input: {
  systemDatabase: string; serverMessageSourceRef: string; marker: string; catalogSourceRef: string;
  columns: Record<'workflow_status' | 'operation_outputs' | 'application_versions', string[]>;
  /** Exclusive private fixture only. Receipt rows commit atomically with NEW;
   * a different connection must read them after the observed process settles.
   * Missing rows never prove a no-op, rollback, or an operation terminal. */
  retainCommittedRows?: boolean;
}) {
  const writer = 'de943d85e4414114a6bb01b079051b0e59940a4911cf9e54f05e41f24011b02b';
  const driver = 'source:pg/lib/client.js@4d8f863700d5a94c443edf9186f546c555486a66d0575806a2fe792c43911a46#NoticeResponse+ReadyForQuery';
  if (input.systemDatabase !== writer || input.serverMessageSourceRef !== driver) return null;
  if (!/^[a-f0-9]{64}$/.test(input.marker) || !input.catalogSourceRef.trim())
    throw new Error('GEC invalid DBOS server-value fixture identity');
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const statements: Array<{ table: keyof typeof input.columns; command: 'INSERT' | 'UPDATE'; hash: string; anchor: string }> = [
    { table: 'workflow_status', command: 'INSERT', hash: 'a9e10fc207f9f998ce3e49a1e320c8866b3205f480132ba76c8b6a82ab4da0f5', anchor: 'insertWorkflowStatus' },
    { table: 'workflow_status', command: 'UPDATE', hash: '8c66bbd7690cd0558564c7d7048db0203f799b093acd68cdb2894e628ab72135', anchor: 'reenqueueWorkflowsForRecovery' },
    { table: 'workflow_status', command: 'UPDATE', hash: 'c6fa0add461e01e4dcd38bfa70a23460e718726924ec6de54b837750727cb368', anchor: 'transitionDelayedWorkflows' },
    { table: 'workflow_status', command: 'UPDATE', hash: '9bebb0656cf5753c1b7844d41fc9f16006eed055664860f3571b29a94ec7c163', anchor: 'findAndMarkStartableWorkflows:claim' },
    { table: 'workflow_status', command: 'UPDATE', hash: '25d1b83fcceb22b1b26a8a5205a0cd65c5490d8ef1ffa7ccc3913c70656d29c8', anchor: 'recordWorkflowOutput' },
    { table: 'workflow_status', command: 'UPDATE', hash: '4f01eb87844c709f81c32a23f49c07f9bfe0bdadb9799f15064d758807bc4435', anchor: 'executor-assignment' },
    { table: 'application_versions', command: 'INSERT', hash: 'ea031961f36e32d61e46ec51718fa74b240f03f06dda78921d7966de06278d13', anchor: 'createApplicationVersion:insert' },
    { table: 'application_versions', command: 'UPDATE', hash: '4f424e83ebb04df589947f784d7d5d9f2d92b469cef1987c7e9928d5c2b65e2a', anchor: 'createApplicationVersion:claim' },
  ];
  const serverSqlWrites: NonNullable<Parameters<typeof observeGroundedStoreOperations>[0]['serverSqlWrites']>[number][] = [];
  const ddl: string[] = [];
  const committedRows = input.retainCommittedRows ? {
    accountingScope: 'committed-server-values-only' as const,
    acceptance: 'unmeasured' as const,
    missingReceipt: 'unknown' as const,
    marker: input.marker,
    // Sequence gaps include rolled-back inserts and are never a row census.
    query: "SELECT sequence::text, receipt FROM dbos.gec_committed_server_values WHERE receipt->>'marker' = $1 ORDER BY sequence",
  } : null;
  if (committedRows) ddl.push(`CREATE TABLE IF NOT EXISTS dbos.gec_committed_server_values (
    sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, receipt json NOT NULL)`);
  for (const table of ['workflow_status', 'operation_outputs', 'application_versions'] as const) {
    const columns = input.columns[table];
    if (!Array.isArray(columns) || !columns.length || new Set(columns).size !== columns.length
      || columns.some(column => !/^[a-z_][a-z0-9_]*$/.test(column)))
      throw new Error('GEC invalid complete DBOS column census');
    const values = columns.map(column => `json_build_object('column', '${column}',
          'hex', encode(convert_to(NEW."${column}"::text, 'UTF8'), 'hex'),
          'changed', TG_OP = 'INSERT' OR OLD."${column}" IS DISTINCT FROM NEW."${column}")`).join(',\n        ');
    const functionName = `gec_server_values_${table}`;
    let trigger = `CREATE OR REPLACE FUNCTION dbos.${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE NOTICE USING MESSAGE = 'GEC-SERVER-VALUES-v1', DETAIL = json_build_object(
          'marker', '${input.marker}', 'backend', pg_backend_pid(),
          'transactionId', pg_current_xact_id()::text,
          'queryHash', encode(sha256(convert_to(current_query(), 'UTF8')), 'hex'),
          'schema', TG_TABLE_SCHEMA, 'table', TG_TABLE_NAME, 'operation', TG_OP, 'rowId', NEW.ctid::text,
          'values', json_build_array(${values}))::text;
        RETURN NEW;
      END $$`;
    if (committedRows) {
      // Reuse the exact original server serialization for both channels. The
      // receipt INSERT is in the writer's transaction; NOTICE alone is not.
      trigger = trigger.replace('      BEGIN', '      DECLARE receipt json;\n      BEGIN')
        .replace("RAISE NOTICE USING MESSAGE = 'GEC-SERVER-VALUES-v1', DETAIL = json_build_object(",
          'receipt := json_build_object(')
        .replace('))::text;', ")) ;\n        INSERT INTO dbos.gec_committed_server_values (receipt) VALUES (receipt);\n        RAISE NOTICE USING MESSAGE = 'GEC-SERVER-VALUES-v1', DETAIL = receipt::text;");
    }
    ddl.push(trigger, `DROP TRIGGER IF EXISTS ${functionName} ON dbos.${table}`,
      `CREATE TRIGGER ${functionName} AFTER INSERT OR UPDATE ON dbos.${table} FOR EACH ROW EXECUTE FUNCTION dbos.${functionName}()`);
    for (const statement of statements.filter(row => row.table === table)) serverSqlWrites.push({
      pool: 'child-dbos-all-clients', queryHash: statement.hash, command: statement.command,
      sourceRef: `source:@dbos-inc/dbos-sdk/dist/src/system_database.js@${writer}#${statement.anchor}`,
      triggerSourceRef: `fixture:after-row@${digest(trigger)};${input.catalogSourceRef}`,
      serverMessageSourceRef: driver, marker: input.marker, schema: 'dbos', table, columns: [...columns], exclusive: true,
    });
  }
  return { ddl, serverSqlWrites, committedRows };
}

/** The fixture stores its already-serialized effect payload in args TEXT.
 * Read the driver's original Bind output; never invoke JSON.stringify again.
 * Like the operation-output registration, this measures the serialized payload,
 * not row/index/protocol overhead. Other writers still need their own proof. */
export function reviewedDurableFixturePayloadSql(crashFixture: string | undefined, serializerSourceRef: string):
  NonNullable<Parameters<typeof observeGroundedStoreOperations>[0]['serializedSqlParameters']> {
  if (crashFixture !== crashFixtureSourceHash || serializerSourceRef !== fixtureSerializerSourceRef) return [];
  return [{ pool: 'child-effect-log', serializerSourceRef, command: 'INSERT', parameterCount: 5,
    sourceRef: `source:packages/operator-core/test/_durable-orchestration-crash-child.ts@${crashFixtureSourceHash}#probeTool:effect-payload`,
    queryHash: '1671c0c4b9c208aafa1b9306e6155c5acfe775f85b8af8e65eb2a587dc62613c',
    persistedParameters: [3], allOrNoneRows: 1 }];
}

/** The application-version claim writes only its original application_name
 * parameter, guarded by a one-row outcome. Other SDK writers also persist
 * defaults, timestamps or existing column values and qualify only zero-row
 * no-ops. This applies to new observations, never retained tapes. */
export function reviewedDurableDbosSqlWrites(systemDatabase: string | undefined, serializerSourceRef: string,
  serverSqlWrites: readonly { pool: string; queryHash: string }[] = []):
  NonNullable<Parameters<typeof observeGroundedStoreOperations>[0]['serializedSqlParameters']> {
  const sourceHash = 'de943d85e4414114a6bb01b079051b0e59940a4911cf9e54f05e41f24011b02b';
  if (systemDatabase !== sourceHash || !serializerSourceRef.trim()) return [];
  const writes: NonNullable<Parameters<typeof observeGroundedStoreOperations>[0]['serializedSqlParameters']> = [...([
    ['8c66bbd7690cd0558564c7d7048db0203f799b093acd68cdb2894e628ab72135', 'UPDATE', 6, 'reenqueueWorkflowsForRecovery'],
    ['ea031961f36e32d61e46ec51718fa74b240f03f06dda78921d7966de06278d13', 'INSERT', 3, 'createApplicationVersion:insert'],
    ['c6fa0add461e01e4dcd38bfa70a23460e718726924ec6de54b837750727cb368', 'UPDATE', 4, 'transitionDelayedWorkflows'],
    ['9bebb0656cf5753c1b7844d41fc9f16006eed055664860f3571b29a94ec7c163', 'UPDATE', 8, 'findAndMarkStartableWorkflows:claim'],
    ['25d1b83fcceb22b1b26a8a5205a0cd65c5490d8ef1ffa7ccc3913c70656d29c8', 'UPDATE', 4, 'recordWorkflowOutput'],
  ] as const).map(([queryHash, command, parameterCount, anchor]) => ({
    pool: 'child-dbos-all-clients', queryHash, command, parameterCount,
    sourceRef: `source:@dbos-inc/dbos-sdk/dist/src/system_database.js@${sourceHash}#${anchor}`,
    serializerSourceRef, persistedParameters: [0], allOrNoneRows: 'zero-only' as const,
  })), {
    pool: 'child-dbos-all-clients', command: 'UPDATE', parameterCount: 2,
    queryHash: '4f424e83ebb04df589947f784d7d5d9f2d92b469cef1987c7e9928d5c2b65e2a',
    sourceRef: `source:@dbos-inc/dbos-sdk/dist/src/system_database.js@${sourceHash}#createApplicationVersion:claim`,
    serializerSourceRef, persistedParameters: [0], allOrNoneRows: 1,
  }, {
    pool: 'child-dbos-all-clients', command: 'UPDATE', parameterCount: 2,
    queryHash: '4f01eb87844c709f81c32a23f49c07f9bfe0bdadb9799f15064d758807bc4435',
    sourceRef: `source:@dbos-inc/dbos-sdk/dist/src/system_database.js@${sourceHash}#recordOperationResultInternal`,
    serializerSourceRef, persistedParameters: [0], allOrNoneRows: 1,
  }];
  // A query has exactly one byte oracle. Prefer the reviewed server receipt
  // where installed; retain the parameter registrations in other pools.
  return writes.filter(row => !serverSqlWrites.some(server => server.pool === row.pool && server.queryHash === row.queryHash));
}

/** Reviewed installed SDK statements, never a SELECT/command-prefix heuristic.
 * Hashes below name exact emitted SQL (including the selected dbos schema and
 * application filters). Source changes disable the affected group until review.
 * Writes, errors, other schemas/filters and server-derived values stay unknown.
 * This extends the existing physical-driver recorder for NEW captures only. */
export function reviewedDurableDbosSql(sources: Partial<Record<'systemDatabase' | 'databaseUtils' | 'migrationRunner' | 'crashFixture', string>>): GroundedNonPersistingSql[] {
  const rows: GroundedNonPersistingSql[] = [];
  const add = (queryHash: string, sourceRef: string, kind: 'read' | 'control', command: GroundedNonPersistingSql['command']) =>
    rows.push({ queryHash, sourceRef, kind, command, status: 'ok' });
  const systemHash = 'de943d85e4414114a6bb01b079051b0e59940a4911cf9e54f05e41f24011b02b';
  if (sources.systemDatabase === systemHash) {
    const ref = `source:@dbos-inc/dbos-sdk/dist/src/system_database.js@${systemHash}`;
    for (const [queryHash, anchor] of [
      ['b8a33fb067a796c279a44fed8a33d0b535d0277dd5ea3a943cb11beb3e0a6826', 'isCockroachDB'],
      ['dc5158f09c849f9585fdb8e347c852c0b843395e40690583731f1e97a9dee8fa', 'resolveRowOwner:application_versions'],
      ['fe09ca5f845bb0630d7d00ca7da34fd4d7245a471fa0a4534428cdee7180227e', 'getLatestApplicationVersion'],
      ['a327d50ba6b0cb0ee0d1adcf56b3bcb32235574701f8c9b99338c1fea413a7a3', 'listQueues'],
      ['9f8d413d45c5e64b62aedc094b46679f7b535422578a46d3f30598734ece812a', 'listSchedules'],
      ['4acd7265d7470ec477b689c3331ce819727651270f2a02567f5a0a92a435f6cd', 'latestApplicationVersionName'],
      ['1bc8e597fa61841d672f4e673d39da6bb35e66252d454cecfe64a0d85b2c25f0', 'findAndMarkStartableWorkflows:select'],
      ['0312bd3c912ba08b722c58997f23358e4584a5aa4ec7008b9415007567b4b12f', 'awaitWorkflowResult'],
      ['d842f2503afae9ad2fd9dbaf6d6fa81726226ccd781ba977cfefae65ad27d906', 'listWorkflows:input'],
      ['505422dcb72f8ea323b94adedf6970ded16be7aa4df0018eb772c2f4f3673301', 'listWorkflows:input-output'],
      ['afda15dab24932686dbb8e8b7e80e9566a40e77e2f2cf30b75f39136f8a7066c', 'getWorkflowStatusValue'],
      ['20ac0ef228483efa83ea286efb05f7b6fbd60addd2bd91d80fdeac8f6dd280ef', 'getOperationResultAndThrowIfCancelled'],
      ['21bc008bf821baa94e7f788983b114017eeabc3f186aaf5e1e1788f2554776b0', 'getAllOperationResults'],
    ]) add(queryHash!, `${ref}#${anchor}`, 'read', 'SELECT');
    for (const [queryHash, command] of [
      ['a8402858d4f1e1d27afee976520485ebb4b96a5387355b823f0d0b8079729032', 'BEGIN'],
      ['79663c1d3b43ceaf9ee728e501c64b57ae2e4d6cb36ff5c65eddcda1de27342f', 'COMMIT'],
      [createHash('sha256').update('ROLLBACK').digest('hex'), 'ROLLBACK'],
    ] as const) add(queryHash, `${ref}#transaction-boundaries`, 'control', command);
    for (const [queryHash, command] of [
      ['2dfb06715dd1ca9db551ee03eed8cf4d1560b086c0adf99d3b543437df32f7d7', 'LISTEN'],
      ['832fb87fb98cee7914c921ec44ede3fb437008fd3e8bf4985f5af80e2dfcf6ab', 'LISTEN'],
      ['6cb0b99e8615da9b0be254f3b925ad08d748b0dd54ce15532ecc16262111a272', 'LISTEN'],
      ['51d3f928cd16813b7a8f257cd05b53f2fe093baa8066900c62203e876c24e538', 'NOTIFY'],
    ] as const) add(queryHash, `${ref}#notification-setup`, 'control', command);
  }
  const databaseHash = 'deff0db24fad793b10ad21314a8333c2b4398e4c26c25a6cedd8e24fbff54ca4';
  if (sources.databaseUtils === databaseHash) add(
    '46c5712c7858d59ef557084e295a65cabed886d65beead3a69eba9e3ae26a09f',
    `source:@dbos-inc/dbos-sdk/dist/src/database_utils.js@${databaseHash}#ensurePGDatabase`, 'read', 'SELECT');
  const migrationHash = 'e843709372e77cd6151bf35345ceca0d7307a87182a57c867bfead4fa7d830f5';
  if (sources.migrationRunner === migrationHash) for (const queryHash of [
    'f76fcac8cd6134140759d16e5852f1c68a8ae36eebf10cc71bd4081e79673a4e',
    'c856a36005d6916e6c1474633c26563e90ec8a3ef0f95dc738c884593f3d1510',
  ]) add(queryHash, `source:@dbos-inc/dbos-sdk/dist/src/sysdb_migrations/migration_runner.js@${migrationHash}#getCurrentSysDBVersion`, 'read', 'SELECT');
  // The private fixture's count query is outside the SDK. Pin its actual writer
  // separately; this does not qualify its INSERT or any retained earlier tape.
  const fixtureHash = crashFixtureSourceHash;
  if (sources.crashFixture === fixtureHash) add(
    '1d6c78cf760bfe8165b02e3095b163663635c95035346f41ff78be7ca942dbe9',
    `source:packages/operator-core/test/_durable-orchestration-crash-child.ts@${fixtureHash}#probeTool:effect-count`, 'read', 'SELECT');
  return rows;
}

/** Compose independently admitted populations without completing an interrupted
 * producer or borrowing its recovery's scope/drain. Keep original censuses (and
 * their diagnostics/purpose registrations) beside the unmodified ids and rows. */
export function composeDurableCaptureCensus<T extends { id: string }>(
  scope: GroundedMeasurementScope, sourceRef: string, inputs: readonly (GroundedCensus<T> | undefined)[],
) {
  const sources = inputs.map(source => source ? structuredClone(source) : null);
  const gaps: string[] = [];
  const ids: string[] = [], rows: T[] = [];
  const validPopulation = (admitted: readonly string[], completed: readonly T[]) => {
    const admittedIds = new Set(admitted), completedIds = new Set(completed.map(row => row.id));
    return admittedIds.size === admitted.length && completedIds.size === completed.length
      && [...admittedIds, ...completedIds].every(id => typeof id === 'string' && id.trim().length > 0)
      && admittedIds.size === completedIds.size && [...admittedIds].every(id => completedIds.has(id));
  };
  if (!sourceRef.trim() || !sources.length) gaps.push('missing-composition-source');
  for (const [index, source] of sources.entries()) {
    if (!source) { gaps.push(`${index}:missing-source`); continue; }
    if (!isDeepStrictEqual(scope, source.scope)) gaps.push(`${index}:foreign-scope`);
    if (!source.sourceRef.trim()) gaps.push(`${index}:missing-source-ref`);
    if (!source.complete) gaps.push(`${index}:incomplete-source`);
    if (!validPopulation(source.ids, source.rows)) gaps.push(`${index}:population-mismatch`);
    ids.push(...source.ids); rows.push(...source.rows);
  }
  if (!validPopulation(ids, rows)) gaps.push('composed-population-mismatch');
  return { scope: { ...scope }, sourceRef, complete: gaps.length === 0, ids, rows, sources, gaps };
}

export function retainDurableCapture(path: string, capture: unknown): {
  serializationMs: number; publicationMs: number; bytes: number;
} {
  // Serialize before touching either file. Keep the sibling on the same
  // filesystem so readers see the previous snapshot or the complete replacement.
  const started = performance.now();
  const bytes = JSON.stringify(capture);
  const serialized = performance.now();
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return { serializationMs: serialized - started, publicationMs: performance.now() - serialized,
    bytes: Buffer.byteLength(bytes) };
}

type Value = null | boolean | number | string | Value[] | { [key: string]: Value };
type Patch = { path: string[]; value: Value; appendAt?: number };
const object = (value: Value | undefined): value is { [key: string]: Value } =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

function changes(prior: Value | undefined, next: Value, path: string[] = [], out: Patch[] = []): Patch[] {
  if (isDeepStrictEqual(prior, next)) return out;
  if (Array.isArray(prior) && Array.isArray(next) && next.length >= prior.length
    && prior.every((value, index) => isDeepStrictEqual(value, next[index]))) {
    out.push({ path, value: next.slice(prior.length), appendAt: prior.length });
  } else if (object(prior) && object(next) && Object.keys(prior).every(key => Object.hasOwn(next, key))) {
    for (const key of Object.keys(next)) changes(Object.hasOwn(prior, key) ? prior[key] : undefined, next[key]!, [...path, key], out);
  } else out.push({ path, value: next });
  return out;
}

/** The existing child recorder's original snapshots, retained as synchronous
 * deltas. No sampling: array replacements (including final fragment exclusion)
 * and every scalar change survive. A failed append poisons this writer so a later
 * successful seal cannot conceal a missing admission or a partial tail. */
export function createDurableCaptureRecorder(path: string) {
  const journalPath = path + '.journal';
  let prior: Value | undefined, sequence = 0, previous: string | null = null, failed = false;
  return { retain(capture: unknown) {
    if (failed) throw new Error('Durable capture recorder failed; original journal must be inspected');
    const started = performance.now();
    try {
      // Normalize exactly once through the original JSON serialization contract;
      // retain a private postimage because source arrays keep growing in place.
      const next: Value = JSON.parse(JSON.stringify(capture));
      const payload = JSON.stringify({ version: 1, sequence, previous, patches: changes(prior, next) });
      const sha256 = digest(payload);
      const bytes = JSON.stringify({ payload, sha256 }) + '\n';
      const serialized = performance.now();
      if (sequence === 0) writeFileSync(journalPath, bytes, { flag: 'wx', mode: 0o600 });
      else appendFileSync(journalPath, bytes);
      const published = performance.now();
      prior = next; previous = sha256; sequence++;
      return { serializationMs: serialized - started, publicationMs: published - serialized,
        bytes: Buffer.byteLength(bytes) };
    } catch (error) { failed = true; throw error; }
  } };
}

function apply(prior: Value | undefined, patches: Patch[]): Value {
  let next = structuredClone(prior);
  for (const patch of patches) {
    if (!Array.isArray(patch.path) || patch.path.some(key => typeof key !== 'string') || !Object.hasOwn(patch, 'value'))
      throw new Error('invalid-patch');
    let parent: { [key: string]: Value } | undefined;
    let target = next;
    for (const key of patch.path) {
      if (!object(target)) throw new Error('invalid-patch-path');
      parent = target;
      target = Object.hasOwn(target, key) ? target[key] : undefined;
    }
    let value = patch.value;
    if (Object.hasOwn(patch, 'appendAt')) {
      if (!Array.isArray(target) || !Array.isArray(value) || patch.appendAt !== target.length)
        throw new Error('invalid-append-offset');
      value = target.concat(value);
    }
    if (parent) Object.defineProperty(parent, patch.path.at(-1)!, { value, enumerable: true, writable: true, configurable: true });
    else next = value;
  }
  if (next === undefined) throw new Error('missing-root');
  return next;
}

/** Reconstruct only verified contiguous frames. Preserve the original bytes and
 * explicitly invalidate all qualifying censuses after any malformed/partial tail.
 * A complete journal says nothing about a drain: crash snapshots stay unsealed. */
export function reconstructDurableCapture(path: string) {
  const sourceRef = path + '.journal', original = readFileSync(sourceRef);
  // Buffer boundaries matter: decoding a truncated UTF-8 character must not turn
  // into a replacement character that can accidentally qualify a valid record.
  const lines = original.toString('utf8').split('\n');
  let capture: Value | undefined, frames = 0, previous: string | null = null, error: string | null = null;
  for (let index = 0; index < lines.length; index++) {
    if (index === lines.length - 1 && lines[index] === '') break;
    try {
      if (index === lines.length - 1) throw new Error('partial-tail');
      const envelope = JSON.parse(lines[index]!);
      if (typeof envelope.payload !== 'string' || digest(envelope.payload) !== envelope.sha256)
        throw new Error('frame-hash-mismatch');
      const frame = JSON.parse(envelope.payload);
      if (frame.version !== 1 || frame.sequence !== frames || frame.previous !== previous || !Array.isArray(frame.patches))
        throw new Error('frame-chain-mismatch');
      const next = apply(capture, frame.patches);
      if (!object(next)) throw new Error('invalid-capture-root');
      capture = next; previous = envelope.sha256; frames++;
    } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); break; }
  }
  if (!object(capture)) throw new Error('No verified durable capture frame: ' + (error ?? 'empty-journal'));
  if (error) {
    capture.boundary = null;
    for (const key of ['census', 'invocations', 'storage']) if (object(capture[key])) capture[key].complete = false;
  }
  const retentionJournal = { sourceRef, sha256: digest(original), bytes: original.byteLength,
    frames, complete: error === null, error };
  return Object.assign(capture, { retentionJournal });
}

/** The parent publishes one familiar JSON postimage after child death/exit. The
 * append-only journal remains beside it as the original, independently hashable tape. */
export function materializeDurableCapture(path: string, child?: {
  status: number | null; signal: NodeJS.Signals | null; error?: Error; stdout?: string; stderr?: string;
}) {
  let capture: ReturnType<typeof reconstructDurableCapture>;
  try { capture = reconstructDurableCapture(path); }
  catch (error) {
    if (!child) throw error;
    throw new Error(`Durable child capture failed: status=${child.status}, signal=${child.signal}, spawnError=${child.error?.message ?? 'none'}\nstdout: ${child.stdout ?? ''}\nstderr: ${child.stderr ?? ''}`,
      { cause: error });
  }
  retainDurableCapture(path, capture);
  return capture;
}

/** The parent owns this boundary; the child never certifies its own SIGKILL.
 * Admission counts include unreturned attempts and SQL fragments. They are NOT
 * completed operations, persisted bytes, or a substitute for the child census.
 * Keep this edition separate so a new run cannot complete a historical tape. */
export function captureDurableProcessBoundary<T extends {
  pid: number; status: number | null; signal: NodeJS.Signals | null; error?: Error;
  stdout?: string; stderr?: string;
}>(path: string, scope: GroundedMeasurementScope, run: () => T) {
  const sourceRef = path + '.process.json';
  const admittedAt = new Date().toISOString();
  // Refuse an existing cohort before launching anything or touching its journal.
  writeFileSync(sourceRef, JSON.stringify({ kind: 'durable-process-boundary', scope,
    state: 'admitted', admittedAt }), { flag: 'wx', mode: 0o600 });
  const monotonicStartMs = performance.now();
  let child: T;
  try { child = run(); }
  catch (error) {
    retainDurableCapture(sourceRef, { kind: 'durable-process-boundary', scope, state: 'launch-threw',
      admittedAt, settledAt: new Date().toISOString(), complete: false,
      error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  const monotonicEndMs = performance.now(), settledAt = new Date().toISOString();
  const gaps: string[] = [];
  let original: ReturnType<typeof reconstructDurableCapture> | null = null;
  try { original = reconstructDurableCapture(path); }
  catch (error) { gaps.push('journal:' + (error instanceof Error ? error.message : String(error))); }
  if (child.error) gaps.push('process:spawn-error');
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) gaps.push('process:missing-pid');
  if (original?.processId !== child.pid) gaps.push('process:foreign-capture');
  if (!original?.retentionJournal.complete) gaps.push('journal:incomplete');
  const termination = original && object(original.processTermination) ? original.processTermination : null;
  const boundary = original && object(original.boundary) ? original.boundary : null;
  const expectedKill = child.signal === 'SIGKILL' && child.status === null
    && termination?.pid === child.pid && termination.signal === child.signal;
  const normalExit = child.status === 0 && child.signal === null && boundary?.drained === true
    && isDeepStrictEqual(boundary.scope, scope) && boundary.sourceRef === path;
  if (!expectedKill && !normalExit) gaps.push('process:unqualified-terminal');
  const populations: Record<string, { admittedIds: string[]; terminalIds: string[]; unreturnedIds: string[] }> = {};
  for (const key of ['census', 'invocations', 'storage']) {
    const census = original && object(original[key]) ? original[key] : null;
    if (!census || !isDeepStrictEqual(census.scope, scope) || census.sourceRef !== path
      || !Array.isArray(census.ids) || !Array.isArray(census.rows)) {
      gaps.push(key + ':missing-or-foreign-source'); continue;
    }
    const ids = census.ids, rows = census.rows;
    if (ids.some(id => typeof id !== 'string' || !id.trim()) || new Set(ids).size !== ids.length
      || rows.some(row => !object(row) || typeof row.id !== 'string' || !ids.includes(row.id))
      || new Set(rows.map(row => object(row) ? row.id : null)).size !== rows.length) {
      gaps.push(key + ':invalid-population'); continue;
    }
    if (normalExit && (census.complete !== true || ids.length !== rows.length))
      gaps.push(key + ':unsealed-normal-exit');
    const diagnostics = object(census.diagnostics) ? census.diagnostics : null;
    if (diagnostics?.captureFailed === true || diagnostics?.late === true || diagnostics?.hooksIntact === false)
      gaps.push(key + ':recorder-loss');
    const admittedIds = ids as string[], terminalIds = rows.map(row => (row as { id: string }).id);
    populations[key] = { admittedIds: [...admittedIds], terminalIds,
      unreturnedIds: admittedIds.filter(id => !terminalIds.includes(id)) };
  }
  const complete = gaps.length === 0;
  const processCapture = { kind: 'durable-process-boundary', acceptance: 'unmeasured',
    accountingScope: 'process-lifetime-and-admissions', scope: { ...scope }, sourceRef,
    originalCaptureRef: path, journal: original?.retentionJournal ?? null,
    admittedAt, settledAt, monotonicStartMs, monotonicEndMs,
    process: { pid: child.pid, status: child.status, signal: child.signal, error: child.error?.message ?? null,
      stdout: child.stdout ?? null, stderr: child.stderr ?? null },
    terminal: expectedKill ? 'intentional-sigkill' : normalExit ? 'drained-exit' : 'unqualified',
    complete, gaps, populations,
    values: { processWallMs: monotonicEndMs - monotonicStartMs,
      recorderJournalBytes: original?.retentionJournal.bytes ?? null,
      durableAdmissions: complete ? populations.census!.admittedIds.length : null,
      dispatchAdmissions: complete ? populations.invocations!.admittedIds.length : null,
      storageAdmissions: complete ? populations.storage!.admittedIds.length : null },
  };
  retainDurableCapture(sourceRef, processCapture);
  return { child, processCapture };
}
