/** GEC P-001 adapters over existing recorder outputs. These are measurements,
 * not acceptance verdicts. Persist returned checks in test_runs.execution_details;
 * the original recorder census stays at its existing evidence reference. */
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type postgres from 'postgres';
import { canonicalJson } from '@papercusp/hash-chain';
import { parseSseStream } from '@papercusp/sse';
import { parseClaudeResultEvent } from '@papercusp/papercusp-shared/agent';
import { parseRecordedRubricCheck, parseTestRunExecutionDetails, type RecordedRubricCheck } from '@papercusp/test-config/execution-details';
import { parseCodexResponsesSse } from './llm-testing/targets/codex-responses-tool-loop';
import type { RubricCheckResult } from './check-results-ledger';
import fixture from './grounded-evidence-fixture.json';
import baselinePlan from './__fixtures__/grounded-evidence-plan53.json';
import { hasMatchingDeclaredCaseTitle, type RecordedTestCase } from './testing-case-filter';
import { retainMeasurementProvenance } from './measurement-provenance';

export const GROUNDED_MANIFEST_SHA256 = '565555fb5e75131c3c9fc59664eb42e21d2142d19f34713d2265795aada09e6a';
const hash = (value: unknown): string => createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
if (hash(fixture) !== GROUNDED_MANIFEST_SHA256) throw new Error('GEC immutable fixture hash mismatch');
export const GROUNDED_DIMENSIONS = [
  'endToEndMs', 'modelCalls', 'modelInputTokens', 'modelOutputTokens',
  'extractionCalls', 'extractionInputTokens', 'extractionOutputTokens',
  'refreshCalls', 'refreshInputTokens', 'refreshOutputTokens', 'retrievalCalls',
  'foregroundLookups', 'repeatedCalls', 'agentAuthoringCalls', 'agentAuthoringInputTokens',
  'agentAuthoringOutputTokens', 'newMandatoryFields', 'newMandatoryNarrativeSurfaces',
  'durableSteps', 'storageOperations', 'storageBytes',
] as const;
export type GroundedDimension = typeof GROUNDED_DIMENSIONS[number];

/** Only the allocated run token and generated store keys may vary. The oracle
 * bytes never depend on a product result. This map is retained before either arm. */
export function materializeGroundedFixture(runId: string, storeKeys: Readonly<Record<string, string>> = {}) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(runId)) throw new Error('invalid GEC run token');
  const logical = Object.values(fixture.namespace).filter((value): value is string => typeof value === 'string');
  const allowed = new Set<string>([...logical, fixture.seed.exactArchive.logicalPost,
    fixture.seed.exactArchive.foreignThreadPost, fixture.seed.exactArchive.foreignWorkspacePost,
    ...Object.values(fixture.seed.proof).filter((value): value is string => typeof value === 'string'),
    ...fixture.seed.events.map(event => event.id),
    ...Array.from({ length: 25 }, (_, index) => `child-${String(index + 1).padStart(2, '0')}`)]);
  const mapping = Object.fromEntries([...allowed].map(key => [key, key.replace('<registered-run-id>', runId)]));
  for (const [key, value] of Object.entries(storeKeys)) {
    if (!allowed.has(key) || !value.trim()) throw new Error('unknown or blank GEC store key');
    mapping[key] = value;
  }
  if (new Set(Object.values(mapping)).size !== Object.keys(mapping).length) throw new Error('GEC store map is not bijective');
  return { manifest: structuredClone(fixture), manifestHash: GROUNDED_MANIFEST_SHA256, mapping, mappingHash: hash(mapping) };
}

export interface GroundedMeasurementScope {
  workspaceId: string;
  potId: string;
  harness: string;
  runId: string;
  ownerId: string;
  caseId: string;
  arm: 'pre' | 'post';
  iteration: number;
  manifestHash: string;
  fixtureHash: string;
  sourceFingerprint: string;
  testFingerprint: string;
  runtimeFingerprint: string;
  configFingerprint: string;
}
const scopeKeys = ['workspaceId', 'potId', 'harness', 'runId', 'ownerId', 'caseId', 'arm', 'iteration',
  'manifestHash', 'fixtureHash', 'sourceFingerprint', 'testFingerprint', 'runtimeFingerprint', 'configFingerprint'] as const;

/** ids are the independent recorder's admitted population, not rows.map(id).
 * complete means its request admission, child tasks and recorder drain settled.
 * An empty complete, armed census can measure zero; an absent census cannot. */
export interface GroundedCensus<T extends { id: string }> {
  scope: GroundedMeasurementScope;
  sourceRef: string;
  complete: boolean;
  ids: readonly string[];
  rows: readonly T[];
}
export interface GroundedModelUsage {
  id: string;
  purpose: 'model' | 'extraction' | 'refresh' | 'authoring' | 'unknown';
  /** Registered caller boundary and final provider parser/tape identity. */
  purposeRef: string;
  usageRef: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}
export interface GroundedInvocation {
  id: string;
  tool: string;
  args: unknown;
  /** Derived at the transport/call_origin boundary, never from answer prose. */
  boundary: 'consumer' | 'internal' | 'control' | 'unknown';
  originRef: string;
  purpose: 'retrieval' | 'authoring' | 'other' | 'unknown';
  purposeRef: string;
}
// Some reviewed upserts report a positive affected count for an unchanged
// payload. Those writers can prove only zero-row no-ops from CommandComplete.
type GroundedPersistedRows = number | 'zero-only';
export interface GroundedStorageOperation {
  id: string;
  kind: 'read' | 'control' | 'write' | 'unknown';
  /** null for reads/session controls; exact UTF8 persisted value bytes for writes. */
  persistedBytes: number | null;
  sql?: { pool: string; queryId: number; queryHash: string; command: string | null; status: 'ok' | 'error';
    /** Actual node-postgres backend at submit, never the host process or pool. */
    backendProcessId?: number | null;
    affectedRows?: number | null;
    /** Original protocol diagnostics only; neither a notice nor an idle
     * transaction status certifies the values persisted by this statement. */
    serverMessages?: { sourceRef: string; notices: GroundedServerNotice[];
      transactionStatus: 'I' | 'T' | 'E' | null };
    serverWrite?: { sourceRef: string; triggerSourceRef: string; transactionId: string | null;
      outcome: 'unknown' | 'committed' | 'rolled-back'; commitQueryId: string | null;
      values: { column: string; sha256: string | null; bytes: number; changed: boolean }[][] };
    rowOutcome?: { allOrNoneRows: GroundedPersistedRows; affectedRows: number | null };
    nonPersisting?: { sourceRef: string; kind: 'read' | 'control' };
    serializedWrite?: { sourceRef: string; templateHash: string;
      values: readonly { argument: number; sha256: string; bytes: number }[] };
    serializedParameters?: { sourceRef: string; serializerSourceRef: string; parameterCount: number;
      values: readonly { parameter: number; sha256: string | null; bytes: number }[] };
    insertOrNoop?: { censusRef: string; censusHash: string; keyHash: string;
      prior: 'present' | 'absent'; contested: boolean } };
}
/** An independently retained initial key census, before the observed writer is
 * admitted. Only an exclusive fixture with EVERY writer using the exact reviewed
 * INSERT-or-unchanged-conflict statement can supply it. Keys contain hashes of
 * original driver-serialized key values, in keyParameters order. This is not a
 * claim that a general upsert, a shared database, or a crashed attempt is drained. */
export interface GroundedInsertOrNoopCensus {
  scope: GroundedMeasurementScope; sourceRef: string; complete: boolean; exclusive: boolean;
  keyParameters: readonly number[]; initialKeys: readonly (readonly string[])[];
}
/** A bounded source review, not a SQL safety parser. Register before execution;
 * any byte, command or terminal-status change requires a fresh review. */
export interface GroundedNonPersistingSql {
  queryHash: string; sourceRef: string; kind: 'read' | 'control';
  command: 'SELECT' | 'BEGIN' | 'COMMIT' | 'ROLLBACK' | 'SET' | 'LISTEN' | 'NOTIFY' | null;
  status: 'ok' | 'error';
}
/** Optional original-driver diagnostics. These observations never classify SQL
 * or certify persisted bytes; the caller must retain/review them separately. */
export interface GroundedServerNotice {
  message: string | null; severity: string | null; code: string | null;
  detail: string | null; where: string | null;
}
/** Exclusive fixture AFTER-row trigger, reviewed with the actual writer. The
 * trigger serializes NEW columns to UTF8 hex on the server, including defaults
 * and clocks, and compares OLD/NEW for UPDATE. This measures serialized value
 * bytes, never tuple/index/WAL overhead. A notice alone is not commit proof.
 * The per-fixture marker must be unique and retained with the trigger source. */
export interface GroundedServerSqlWrite {
  pool: string; queryHash: string; command: 'INSERT' | 'UPDATE'; sourceRef: string;
  triggerSourceRef: string; serverMessageSourceRef: string; marker: string;
  schema: string; table: string; columns: readonly string[]; exclusive: true;
}

/** Join only original protocol receipts. No final-row reads, Bind estimates,
 * wall-clock matching, SQL prefix inference, or caller-authored commit claims.
 * Unknown transaction statements (including savepoints) invalidate that entire
 * transaction; a new reviewed BEGIN is required before it can qualify again. */
function qualifyGroundedServerWrites(rows: GroundedStorageOperation[], complete: boolean,
  registrations: readonly GroundedServerSqlWrite[]) {
  if (!registrations.length) return;
  const transactions = new Map<string, { valid: boolean; transactionId: string | null;
    writes: { row: GroundedStorageOperation; bytes: number | null }[] }>();
  const finish = (transaction: NonNullable<ReturnType<typeof transactions.get>>, committed: boolean, id: string) => {
    for (const { row, bytes } of transaction.writes) {
      if (committed && transaction.valid && bytes !== null) {
        row.persistedBytes = bytes; row.sql!.serverWrite!.outcome = 'committed';
        row.sql!.serverWrite!.commitQueryId = id;
      } else if (!committed) row.sql!.serverWrite!.outcome = 'rolled-back';
    }
  };
  for (const row of rows) {
    const sql = row.sql;
    if (!sql) continue;
    const key = `${sql.pool}:${sql.backendProcessId}`;
    const registration = registrations.find(r => r.pool === sql.pool && r.queryHash === sql.queryHash);
    const status = sql.serverMessages?.transactionStatus;
    const transaction = transactions.get(key);
    if (registration) {
      row.kind = 'write'; row.persistedBytes = null;
      const proof: NonNullable<typeof sql.serverWrite> = { sourceRef: registration.sourceRef,
        triggerSourceRef: registration.triggerSourceRef, transactionId: null,
        outcome: 'unknown', commitQueryId: null, values: [] };
      sql.serverWrite = proof;
      let valid = complete && integer(sql.backendProcessId) && sql.backendProcessId! > 0
        && sql.status === 'ok' && sql.command === registration.command
        && sql.serverMessages?.sourceRef === registration.serverMessageSourceRef;
      const affected = sql.affectedRows;
      const rowIds = new Set<string>();
      // Terminal rowCount is recorded independently of any parameter writer.
      valid &&= integer(affected);
      for (const notice of sql.serverMessages?.notices ?? []) {
        if (notice.message !== 'GEC-SERVER-VALUES-v1') continue;
        try {
          const receipt = JSON.parse(notice.detail ?? '') as Record<string, unknown>;
          if (notice.severity !== 'NOTICE' || notice.code !== '00000'
            || receipt.marker !== registration.marker || receipt.backend !== sql.backendProcessId
            || receipt.queryHash !== sql.queryHash || receipt.schema !== registration.schema
            || receipt.table !== registration.table || receipt.operation !== registration.command
            || typeof receipt.rowId !== 'string' || !/^\([0-9]+,[1-9][0-9]*\)$/.test(receipt.rowId)
            || rowIds.has(receipt.rowId)
            || typeof receipt.transactionId !== 'string' || !/^[1-9][0-9]*$/.test(receipt.transactionId)
            || (proof.transactionId !== null && proof.transactionId !== receipt.transactionId)
            || !Array.isArray(receipt.values) || receipt.values.length !== registration.columns.length)
            throw new Error('foreign server values');
          rowIds.add(receipt.rowId);
          proof.transactionId = receipt.transactionId;
          const values = receipt.values.map((value, index) => {
            if (!value || typeof value !== 'object' || value.column !== registration.columns[index]
              || typeof value.changed !== 'boolean' || (registration.command === 'INSERT' && !value.changed)
              || (value.hex !== null && (typeof value.hex !== 'string' || !/^(?:[a-f0-9]{2})*$/.test(value.hex))))
              throw new Error('invalid server serialization');
            const original = value.hex === null ? null : Buffer.from(value.hex, 'hex');
            return { column: value.column as string, changed: value.changed as boolean,
              sha256: original === null ? null : createHash('sha256').update(original).digest('hex'),
              bytes: original?.byteLength ?? 0 };
          });
          proof.values.push(values);
        } catch { valid = false; }
      }
      valid &&= proof.values.length === affected;
      const sum = proof.values.flat().reduce((total, value) => total + (value.changed ? value.bytes : 0), 0);
      const bytes = valid && integer(sum) ? sum : null;
      if (status === 'I' && !transaction && bytes !== null) {
        row.persistedBytes = bytes; proof.outcome = 'committed'; proof.commitQueryId = row.id;
      } else if (status === 'T' && transaction) {
        if (proof.transactionId && transaction.transactionId && transaction.transactionId !== proof.transactionId)
          transaction.valid = false;
        transaction.transactionId ??= proof.transactionId;
        transaction.writes.push({ row, bytes });
      } else if (transaction) {
        transaction.valid = false; transaction.writes.push({ row, bytes: null });
      }
      continue;
    }
    const control = complete && sql.status === 'ok' && sql.nonPersisting?.kind === 'control';
    if (control && sql.command === 'BEGIN' && status === 'T') {
      // Nested BEGIN is not a new transaction; never erase the earlier writes.
      if (transaction) transaction.valid = false;
      else transactions.set(key, { valid: true, transactionId: null, writes: [] });
    } else if (control && (sql.command === 'COMMIT' || sql.command === 'ROLLBACK') && status === 'I') {
      if (transaction) finish(transaction, sql.command === 'COMMIT', row.id);
      transactions.delete(key);
    } else if (transaction && !(sql.status === 'ok' && status === 'T' && sql.nonPersisting?.kind === 'read')) {
      transaction.valid = false;
    }
  }
}
export interface GroundedSqlObservation {
  id: string; pool: string; phase: 'admission' | 'submit' | 'terminal' | 'notice' | 'ready';
  monotonicMs: number; query: string | null;
  /** node-postgres only. Admission may precede connection; submit/terminal use
   * the executing Client's backend identity pinned at submit. Diagnostic only:
   * this does not certify server values, transaction commit or persisted bytes. */
  backendProcessId?: number | null;
  command?: string | null; status?: 'ok' | 'error';
  serverMessageSourceRef?: string;
  notice?: GroundedServerNotice;
  association?: 'executing-query' | 'unattributed';
  transactionStatus?: 'I' | 'T' | 'E' | null;
}
export interface GroundedContractChange {
  id: string;
  beforeRequiredPaths: readonly string[];
  afterRequiredPaths: readonly string[];
  beforeNarrativePaths: readonly string[];
  afterNarrativePaths: readonly string[];
}
/** Independently retained catalogue population and original schema rows. */
export interface GroundedSchemaSnapshot {
  sourceRef: string;
  sourceFingerprint: string;
  complete: boolean;
  ids: readonly string[];
  /** The independently admitted contract channels, identical at both pins.
   * Full callers include result/authority/acceptance; input-only callers cannot
   * silently claim coverage of an absent channel. */
  requiredKinds?: readonly ('input' | 'result' | 'authority' | 'acceptance')[];
  rows: readonly { id: string; inputSchema: unknown; resultSchema?: unknown;
    authoritySchema?: unknown; acceptanceSchema?: unknown }[];
  /** Original code-only contracts that have no faithful schema projection.
   * ids are admitted independently of the completed reads. Exact unchanged
   * bytes prove zero additions; changed code requires an exact detector. */
  sourceFiles?: {
    ids: readonly string[];
    rows: readonly { id: string; sourceRef: string; body: string; sha256: string }[];
  };
}
export interface GroundedMeasurementInput {
  scope: GroundedMeasurementScope;
  boundary: {
    scope: GroundedMeasurementScope;
    sourceRef: string;
    admittedAt: string;
    settledAt: string;
    monotonicStartMs: number;
    monotonicEndMs: number;
    drained: boolean;
  } | null;
  models?: GroundedCensus<GroundedModelUsage>;
  invocations?: GroundedCensus<GroundedInvocation>;
  durable?: GroundedCensus<{ id: string; source: 'live' | 'recorded' }>;
  storage?: GroundedCensus<GroundedStorageOperation>;
  contracts?: GroundedCensus<GroundedContractChange>;
}

const integer = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const nonblank = (s: unknown): s is string => typeof s === 'string' && s.trim().length > 0;
const sameScope = (a: GroundedMeasurementScope, b: GroundedMeasurementScope): boolean =>
  scopeKeys.every(key => a[key] === b[key]);
const lookups = new Set(['graph:query', 'plans:get', 'work_items:get', 'goals:get', 'search:query', 'search:semantic',
  'search:fulltext', 'tools:find']);
const dimensionUnit = (dimension: GroundedDimension): string => dimension.endsWith('Tokens') ? 'tokens'
  : dimension === 'storageBytes' ? 'bytes' : dimension === 'endToEndMs' ? 'ms' : 'count';

/** Pure projection of original capture, including failures and replay attempts.
 * Missing/foreign/duplicated/dropped observations cannot become free operations. */
export function measureGroundedEvidence(input: GroundedMeasurementInput) {
  const values = Object.fromEntries(GROUNDED_DIMENSIONS.map(key => [key, null])) as Record<GroundedDimension, number | null>;
  const gaps = new Set<string>();
  // The original census may itself be unretainable. Preserve that failure
  // through provenance creation instead of hashing it again outside the guard.
  const sourceHashes = new WeakMap<object, string | null>();
  const sourceHash = (source: object): string | null => {
    if (!sourceHashes.has(source)) {
      try { sourceHashes.set(source, hash(source)); }
      catch { sourceHashes.set(source, null); }
    }
    return sourceHashes.get(source)!;
  };
  const validScope = scopeKeys.every(key => key === 'iteration' ? integer(input.scope[key]) && input.scope[key] >= 1
    : nonblank(input.scope[key])) && input.scope.iteration <= 3
    && ['pre', 'post'].includes(input.scope.arm)
    && input.scope.manifestHash === GROUNDED_MANIFEST_SHA256
    && fixture.cases.some(c => c.id === input.scope.caseId);
  if (!validScope) gaps.add('invalid-measurement-scope');
  const census = <T extends { id: string }>(name: string, capture?: GroundedCensus<T>): readonly T[] | null => {
    if (!capture || !capture.complete || !nonblank(capture.sourceRef) || !sameScope(input.scope, capture.scope)) {
      gaps.add(`${name}:missing-incomplete-or-foreign-census`); return null;
    }
    const ids = new Set(capture.ids);
    const rows = new Set(capture.rows.map(row => row.id));
    if (ids.size !== capture.ids.length || rows.size !== capture.rows.length
      || [...ids, ...rows].some(id => !nonblank(id)) || ids.size !== rows.size || [...ids].some(id => !rows.has(id))) {
      gaps.add(`${name}:recorder-population-mismatch`); return null;
    }
    if (sourceHash(capture) === null) { gaps.add(`${name}:unretainable-source`); return null; }
    return capture.rows;
  };
  const b = input.boundary;
  const validBoundary = b && sameScope(input.scope, b.scope) && nonblank(b.sourceRef) && b.drained
    && Number.isFinite(Date.parse(b.admittedAt)) && Number.isFinite(Date.parse(b.settledAt))
    && Date.parse(b.settledAt) >= Date.parse(b.admittedAt)
    && Number.isFinite(b.monotonicStartMs) && b.monotonicStartMs >= 0
    && Number.isFinite(b.monotonicEndMs) && b.monotonicEndMs >= b.monotonicStartMs;
  if (validBoundary) values.endToEndMs = b.monotonicEndMs - b.monotonicStartMs;
  else gaps.add('boundary:unsettled-or-missing');

  const models = census('models', input.models);
  if (models) {
    values.modelCalls = models.length;
    const validPurposes = models.every(m => ['model', 'extraction', 'refresh', 'authoring'].includes(m.purpose) && nonblank(m.purposeRef));
    const tokens = (rows: readonly GroundedModelUsage[], field: 'inputTokens' | 'outputTokens'): number | null => {
      if (rows.some(m => !nonblank(m.usageRef) || !integer(m[field]))) { gaps.add(`models:missing-final-${field}`); return null; }
      const total = rows.reduce((sum, m) => sum + m[field]!, 0);
      if (!integer(total)) { gaps.add('models:unsafe-token-total'); return null; }
      return total;
    };
    values.modelInputTokens = tokens(models, 'inputTokens');
    values.modelOutputTokens = tokens(models, 'outputTokens');
    if (!validPurposes) gaps.add('models:unclassified-caller-purpose');
    else for (const [purpose, count, inTokens, outTokens] of [
      ['extraction', 'extractionCalls', 'extractionInputTokens', 'extractionOutputTokens'],
      ['refresh', 'refreshCalls', 'refreshInputTokens', 'refreshOutputTokens'],
      ['authoring', 'agentAuthoringCalls', 'agentAuthoringInputTokens', 'agentAuthoringOutputTokens'],
    ] as const) {
      const selected = models.filter(m => m.purpose === purpose);
      // Authoring calls are typed-record dispatches. One provider request may
      // author zero, one or several records; its usage still belongs here.
      if (purpose !== 'authoring') values[count] = selected.length;
      values[inTokens] = tokens(selected, 'inputTokens');
      values[outTokens] = tokens(selected, 'outputTokens');
    }
  }
  const invocations = census('invocations', input.invocations);
  if (invocations) {
    if (invocations.some(i => !['consumer', 'internal', 'control'].includes(i.boundary) || !nonblank(i.originRef) || !nonblank(i.tool)))
      gaps.add('invocations:missing-origin');
    else {
      const foreground = invocations.filter(i => i.boundary === 'consumer');
      const canonicalCall = (i: GroundedInvocation) => {
        if (i.tool === 'tools:invoke' && i.args && typeof i.args === 'object' && 'name' in i.args
          && typeof i.args.name === 'string') return { tool: i.args.name, args: 'args' in i.args ? i.args.args : {} };
        return { tool: i.tool, args: i.args };
      };
      values.foregroundLookups = foreground.filter(i => lookups.has(canonicalCall(i).tool)).length;
      try {
        const normalized = foreground.map(i => canonicalJson(canonicalCall(i)));
        values.repeatedCalls = normalized.length - new Set(normalized).size;
      } catch { gaps.add('invocations:invalid-canonical-args'); }
    }
    if (invocations.some(i => !['retrieval', 'authoring', 'other'].includes(i.purpose) || !nonblank(i.purposeRef)
      || !['consumer', 'internal', 'control'].includes(i.boundary))) gaps.add('invocations:unclassified-caller-purpose');
    else {
      values.retrievalCalls = invocations.filter(i => i.purpose === 'retrieval' && i.boundary !== 'control').length;
      values.agentAuthoringCalls = invocations.filter(i => i.purpose === 'authoring' && i.boundary !== 'control').length;
    }
  }
  const durable = census('durable', input.durable);
  if (durable) {
    if (durable.every(step => step.source === 'live' || step.source === 'recorded')) values.durableSteps = durable.length;
    else gaps.add('durable:missing-replay-source');
  }
  const storage = census('storage', input.storage);
  if (storage) {
    // Completion coverage proves the operation count independently of whether
    // a write's original serialized value is available.
    values.storageOperations = storage.length;
    if (storage.some(op => !['read', 'control', 'write'].includes(op.kind)
      || (op.kind === 'write' ? !integer(op.persistedBytes) : op.persistedBytes !== null))) gaps.add('storage:missing-persisted-bytes');
    else {
      const bytes = storage.reduce((sum, op) => sum + (op.persistedBytes ?? 0), 0);
      if (integer(bytes)) values.storageBytes = bytes; else gaps.add('storage:unsafe-byte-total');
    }
  }
  const contracts = census('contracts', input.contracts);
  if (contracts) {
    const added = (before: readonly string[], after: readonly string[]): number => {
      if ([...before, ...after].some(path => !nonblank(path)) || new Set(before).size !== before.length
        || new Set(after).size !== after.length) throw new Error('invalid contract paths');
      const old = new Set(before); return after.filter(path => !old.has(path)).length;
    };
    try {
      values.newMandatoryFields = contracts.reduce((sum, c) => sum + added(c.beforeRequiredPaths, c.afterRequiredPaths), 0);
      values.newMandatoryNarrativeSurfaces = contracts.reduce((sum, c) => sum + added(c.beforeNarrativePaths, c.afterNarrativePaths), 0);
    } catch { values.newMandatoryFields = null; values.newMandatoryNarrativeSurfaces = null; gaps.add('contracts:invalid-path-census'); }
  }
  // Child work and recorder drains bound EVERY dimension, not merely latency.
  if (!validScope || !validBoundary) for (const key of GROUNDED_DIMENSIONS) values[key] = null;
  const checks = GROUNDED_DIMENSIONS.map(dimension => {
    const value = values[dimension];
    const provenance = retainMeasurementProvenance({
      startedAt: validBoundary ? b.admittedAt : '1970-01-01T00:00:00.000Z',
      finishedAt: validBoundary ? b.settledAt : '1970-01-01T00:00:00.000Z',
      procedure: { kind: 'grounded-evidence-capture', scope: input.scope, boundaryRef: b?.sourceRef ?? null,
        sources: Object.fromEntries(['models', 'invocations', 'durable', 'storage', 'contracts'].map(name => {
          const source = input[name as keyof Pick<GroundedMeasurementInput, 'models' | 'invocations' | 'durable' | 'storage' | 'contracts'>];
          return [name, source ? { ref: source.sourceRef, sha256: sourceHash(source), complete: source.complete } : null];
        })) },
      result: { dimension, value, gaps: [...gaps] }, predicateInput: { path: '$["value"]', value },
    });
    const check: RecordedRubricCheck = {
      id: `gec:${input.scope.caseId}:${input.scope.arm}:${input.scope.iteration}:${dimension}`,
      rubricRef: 'acceptance-grounded-evidence-and-continuity-2026-11-05', criterionKey: 'r-8', kind: 'instrument',
      value, unit: dimensionUnit(dimension),
      subject: { ref: `${fixture.edition}/${input.scope.caseId}/${input.scope.arm}/${input.scope.iteration}/${dimension}` }, provenance,
    };
    return { status: value === null ? 'unknown' as const : 'captured' as const, check };
  });
  const ledgerResults: RubricCheckResult[] = checks.map(({ status, check }) => ({
    check, verdict: status === 'captured' ? 'pass' : 'error',
    // test_runs.duration_ms is BIGINT; the precise monotonic scalar remains
    // unchanged in check.value. Round only the auxiliary row duration.
    measuredAt: check.provenance!.finishedAt, durationMs: values.endToEndMs === null ? null : Math.ceil(values.endToEndMs),
    ...(status === 'unknown' ? { detail: [...gaps].join('; ') } : {}),
  }));
  return { values, gaps: [...gaps], checks, ledgerResults, complete: checks.every(row => row.status === 'captured') };
}

/** Inspect the existing results ledger by exact subject AND retained source
 * identity. A file-level pass, an older passing scalar, or a row from another
 * run cannot repair a missing latest dimension. Callers select the exact run. */
export function readGroundedMeasurementRows(scope: GroundedMeasurementScope, rows: readonly {
  id: number; status: string; executionDetails: unknown;
}[]) {
  const values = Object.fromEntries(GROUNDED_DIMENSIONS.map(key => [key, null])) as Record<GroundedDimension, number | null>;
  const gaps: string[] = [];
  const prefix = `${fixture.edition}/${scope.caseId}/${scope.arm}/${scope.iteration}/`;
  const parsed = rows.map(row => ({ ...row, details: parseTestRunExecutionDetails(row.executionDetails) }));
  for (const dimension of GROUNDED_DIMENSIONS) {
    const selected = parsed.filter(row => row.details?.check?.subject?.ref === prefix + dimension);
    if (selected.length !== 1) { gaps.push(`${dimension}:missing-or-ambiguous-row`); continue; }
    const row = selected[0]!, check = row.details!.check!;
    let recordedScope: GroundedMeasurementScope | null = null;
    try { recordedScope = JSON.parse(check.provenance!.procedure.snapshot).scope; } catch { /* explicit gap below */ }
    if (row.status !== 'pass' || check.kind !== 'instrument' || check.criterionKey !== 'r-8'
      || check.rubricRef !== 'acceptance-grounded-evidence-and-continuity-2026-11-05'
      || check.id !== `gec:${scope.caseId}:${scope.arm}:${scope.iteration}:${dimension}` || check.unit !== dimensionUnit(dimension)
      || typeof check.value !== 'number' || !Number.isFinite(check.value) || check.value < 0
      || (dimension !== 'endToEndMs' && !integer(check.value))
      || !check.provenance || check.provenance.gaps.length || !recordedScope || !sameScope(scope, recordedScope)
      || row.details!.workspaceId !== scope.workspaceId || row.details!.harnessSlug !== scope.harness
      || row.details!.runGroupId !== scope.runId) { gaps.push(`${dimension}:unqualified-row`); continue; }
    values[dimension] = check.value;
  }
  return { values, gaps, complete: gaps.length === 0 };
}

export type GroundedBaselineState = 'success' | 'failure' | 'unknown';
export interface GroundedBaselineKey {
  caseId: string; arm: 'pre'; iteration: number; kind: 'oracle' | 'dimension'; name: string;
}
/** A cohort is pinned independently of the rows being classified. Recaptures
 * have their own run/evidence identities and never update an original cohort. */
export interface GroundedBaselinePin {
  scope: GroundedMeasurementScope;
  cohort: 'original' | 'measurement-recapture';
  generation: 'pre-intervention';
  version: string;
  sourceClock: string;
  observedAt: string;
  budgetHash: string;
  oracleHash: string;
}
function validGroundedBaselinePin(pin: GroundedBaselinePin): boolean {
  const c = fixture.cases.find(candidate => candidate.id === pin.scope.caseId);
  return !!c && scopeKeys.every(key => key === 'iteration' ? integer(pin.scope[key]) : nonblank(pin.scope[key]))
    && pin.scope.arm === 'pre' && pin.scope.manifestHash === GROUNDED_MANIFEST_SHA256
    && pin.generation === 'pre-intervention' && ['original', 'measurement-recapture'].includes(pin.cohort)
    && nonblank(pin.version) && nonblank(pin.sourceClock) && Number.isFinite(Date.parse(pin.observedAt))
    && pin.budgetHash === hash(fixture.budgets) && pin.oracleHash === hash(c.expected)
    && pin.scope.iteration >= 1 && pin.scope.iteration <= fixture.budgets.resumesPerCase;
}

/** Parent journeys have their own admission and drain. Their fixed population
 * comes from the frozen fixture, never from available child-case measurements. */
export function groundedJourneyCostCensus() {
  return fixture.cases.filter(c => /^J[1-9][0-9]*$/.test(c.id)).flatMap(c => {
    const iterations = 'iterations' in c.input ? c.input.iterations ?? 0 : 0;
    return Array.from({ length: iterations }, (_, index) => ({
      caseId: c.id, arm: 'pre' as const, iteration: index + 1,
    }));
  });
}
export interface GroundedJourneyCostCapture {
  pin: GroundedBaselinePin;
  sourceRef: string;
  rows: Parameters<typeof readGroundedMeasurementRows>[1];
}
/** Select one retained cohort explicitly. Recaptures and supplemental authoring
 * never fill original parents. Reuse the exact-scope scalar reader; do not sum
 * children or infer zero from missing records. This is cost coverage only,
 * independent of journey correctness, deadlines and post-intervention ratios. */
export function readGroundedJourneyCostRows(cohort: GroundedBaselinePin['cohort'],
  captures: readonly GroundedJourneyCostCapture[]) {
  const census = groundedJourneyCostCensus();
  const key = (scope: Pick<GroundedMeasurementScope, 'caseId' | 'arm' | 'iteration'>) =>
    `${scope.caseId}/${scope.arm}/${scope.iteration}`;
  const expected = new Set(census.map(key));
  const gaps: string[] = [];
  for (const capture of captures) {
    if (!expected.has(key(capture.pin.scope)) || capture.pin.cohort !== cohort)
      gaps.push(`${key(capture.pin.scope)}:foreign-parent-or-cohort`);
  }
  const observations = census.map(parent => {
    const selected = captures.filter(capture => key(capture.pin.scope) === key(parent) && capture.pin.cohort === cohort);
    const capture = selected.length === 1 ? selected[0]! : null;
    const parentGaps: string[] = [];
    let values = Object.fromEntries(GROUNDED_DIMENSIONS.map(name => [name, null])) as Record<GroundedDimension, number | null>;
    if (!capture) parentGaps.push('missing-or-duplicate-parent');
    else if (!validGroundedBaselinePin(capture.pin) || !nonblank(capture.sourceRef)) parentGaps.push('invalid-parent-pin-or-source');
    else {
      const result = readGroundedMeasurementRows(capture.pin.scope, capture.rows);
      values = result.values; parentGaps.push(...result.gaps);
      // Exactly one admitted scalar per required dimension exhausts the parent
      // population. Missing/replaced subjects are already rejected by the reader.
      if (capture.rows.length > GROUNDED_DIMENSIONS.length)
        parentGaps.push('unexpected-parent-scalar');
    }
    gaps.push(...parentGaps.map(gap => `${key(parent)}:${gap}`));
    return { ...parent, cohort, pin: capture?.pin ?? null, sourceRef: capture?.sourceRef ?? null,
      values, gaps: parentGaps, complete: parentGaps.length === 0 };
  });
  return { observations, gaps, complete: gaps.length === 0 };
}
export interface GroundedBaselineObservation {
  kind: GroundedBaselineKey['kind']; name: string;
  value: boolean | number | null;
  qualified: boolean;
  evidenceRef: string;
  writerRef: string;
}
export interface GroundedBaselineRow {
  key: GroundedBaselineKey;
  state: GroundedBaselineState;
  value: boolean | number | null;
  pin: GroundedBaselinePin;
  originalSha256: string;
  observation: GroundedBaselineObservation | null;
}
const baselineKey = (key: GroundedBaselineKey): string =>
  `${fixture.edition}/${key.caseId}/${key.arm}/${key.iteration}/${key.kind}/${key.name}`;

/** Census comes from the frozen fixture, never from completed observations.
 * Each top-level expected predicate is one oracle (its full nested value is
 * pinned by oracleHash); the prose `oracle` field describes the evaluator. */
export function groundedBaselineCensus(): GroundedBaselineKey[] {
  return fixture.cases.flatMap(c => Array.from({ length: fixture.budgets.resumesPerCase }, (_, index) =>
    [...Object.keys(c.expected).filter(name => name !== 'oracle').map(name => ({ kind: 'oracle' as const, name })),
      ...fixture.measurements.dimensions.map(name => ({ kind: 'dimension' as const, name }))]
      .map(atom => ({ caseId: c.id, arm: 'pre' as const, iteration: index + 1, ...atom })))).flat();
}

const BASELINE_PLAN_SHA256 = 'c878ad6686ffa0a31a1d8b0878dcf9bdaa2d0b62ae98379f530189fbc971e7d2';
const BASELINE_PLAN_REF = 'plan:grounded-evidence-and-continuity-2026-11-05@53';
type BaselineCheck = { kind: string; files: string[]; cases: {
  file: string; testName: string; plannedReason: string;
}[] };
type BaselineReuse = { ref: string; kind: string; provides: string; items: string[] };

/** Derive the required population from the independently retained plan, never
 * from a manifest or a result being checked. Whole rows are retained: comparing
 * just ids would miss a changed oracle, budget, owner or qualification gap. */
export function groundedBaselineManifestCensus() {
  if (baselinePlan.ref !== BASELINE_PLAN_REF || baselinePlan.sha256 !== BASELINE_PLAN_SHA256
    || createHash('sha256').update(baselinePlan.body, 'utf8').digest('hex') !== BASELINE_PLAN_SHA256)
    throw new Error('GEC baseline plan pin mismatch');
  const blocks = [...baselinePlan.body.matchAll(/```([^\n]*)\n([\s\S]*?)\n```/g)];
  const frozen = JSON.parse(blocks.find(block => block[1] === 'json')![2]!) as typeof fixture;
  if (hash(frozen) !== GROUNDED_MANIFEST_SHA256 || hash(fixture) !== hash(frozen))
    throw new Error('GEC baseline fixture pin mismatch');
  const reuse = JSON.parse(blocks.find(block => block[1] === 'reuse')![2]!) as { reused: BaselineReuse[] };
  const rows = (header: string): string[][] => {
    const start = baselinePlan.body.indexOf(header);
    if (start < 0) throw new Error(`GEC baseline table missing: ${header}`);
    const result: string[][] = [];
    for (const line of baselinePlan.body.slice(start).split('\n').slice(2)) {
      if (!line.startsWith('|')) break;
      result.push(line.split('|').slice(1, -1).map(cell => cell.trim()));
    }
    return result;
  };
  const owners = new Map(rows('| bar | implementing plan items | evidence plane |')
    .map(row => [row[0]!, row[1]!.split(',').map(item => item.trim())]));
  const checks = blocks.filter(block => block[1] === 'requirement').map((block, index) => {
    const requirementId = `R-${index + 1}`;
    const definition = JSON.parse(block[2]!) as { verification: { check: BaselineCheck } };
    const ownerItems = owners.get(requirementId);
    if (!ownerItems?.length) throw new Error(`GEC baseline check has no owner: ${requirementId}`);
    return { requirementId, ownerItems, check: definition.verification.check };
  });
  const selectors = checks.flatMap(row => row.check.cases.map(c => ({
    ...c, requirementId: row.requirementId, ownerItems: row.ownerItems,
  })));
  const census = {
    planRef: BASELINE_PLAN_REF, planSha256: BASELINE_PLAN_SHA256,
    fixtureHash: GROUNDED_MANIFEST_SHA256, edition: frozen.edition,
    cases: frozen.cases, dimensions: frozen.measurements.dimensions,
    sourceFamilies: rows('| Source family | Existing identity/version and lifecycle | Qualification gap |')
      .map(row => ({ family: row[0]!, identityAndLifecycle: row[1]!, qualificationGap: row[2]! })),
    reused: reuse.reused, checks, paths: [...new Set(checks.flatMap(row => row.check.files))], selectors,
    budgets: frozen.budgets, measurements: frozen.measurements, sliceApplicability: frozen.sliceApplicability,
    atomicKeys: groundedBaselineCensus(),
  };
  const counts = [census.cases.length, census.dimensions.length, census.sourceFamilies.length,
    census.reused.length, census.checks.length, census.paths.length, census.selectors.length];
  if (canonicalJson(counts) !== canonicalJson([52, 21, 15, 27, 10, 10, 23])
    || new Set(census.selectors.map(row => canonicalJson([row.file, row.testName]))).size !== 23)
    throw new Error('GEC baseline pinned census count mismatch');
  return census;
}

/** Regenerate-and-diff, including count and duplicate checks through exact row
 * identity. This qualifies only the census, never a baseline or product result. */
export function validateGroundedBaselineManifestCensus(candidate: unknown) {
  const expected = groundedBaselineManifestCensus();
  const gaps: string[] = [];
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
    return { censusMatches: false, gaps: ['manifest:missing-census'] };
  const record = candidate as Record<string, unknown>;
  for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
    try {
      if (!Object.hasOwn(record, key) || hash(record[key]) !== hash(expected[key])) gaps.push(`manifest:${key}:mismatch`);
    } catch { gaps.push(`manifest:${key}:invalid`); }
  }
  for (const key of Object.keys(record)) if (!Object.hasOwn(expected, key)) gaps.push(`manifest:${key}:unexpected`);
  return { censusMatches: gaps.length === 0, gaps };
}

/** Inputs are existing maintained-runner file/case ledger readbacks. A source
 * declaration or a route alone is deliberately insufficient. Failed executions
 * establish enrollment, not passing acceptance; skipped/todo cases establish
 * neither. The original receipt remains addressable instead of a new inventory. */
export interface GroundedBaselineEnrollmentRun {
  source: 'maintained-runner'; evidenceRef: string;
  file: string; executionDetails: unknown; cases: readonly RecordedTestCase[];
}
export function readGroundedBaselineEnrollment(runs: readonly GroundedBaselineEnrollmentRun[]) {
  return groundedBaselineManifestCensus().selectors.map(selector => {
    const receipts = runs.flatMap(run => {
      const details = parseTestRunExecutionDetails(run.executionDetails);
      if (run.source !== 'maintained-runner' || !run.evidenceRef.trim() || run.file !== selector.file
        || details?.filePath !== selector.file || details.collectionFailed
        || details.passed + details.failed === 0) return [];
      const cases = run.cases.filter(row => row.status === 'pass' || row.status === 'fail');
      if (!cases.length || !hasMatchingDeclaredCaseTitle(selector.testName, cases.map(row => row.caseKey))) return [];
      return [run.evidenceRef];
    });
    return { ...selector, status: receipts.length ? 'enrolled' as const : 'planned' as const, evidenceRefs: receipts };
  });
}

/** Project retained recorder bytes without re-running a model or re-measuring an
 * old census with current code. The two action predicates are independent: a
 * wrong next action need not dispatch the forbidden action. Original nulls stay
 * null, including when a later recorder learned to measure that dimension. */
export function projectGroundedBaselineCapture(input: {
  pin: GroundedBaselinePin;
  capture: { body: string; sha256: string; ref: string };
  /** C3's denial is in the companion DBOS oracle, not the model's answer. */
  durableCapture?: { body: string; sha256: string; ref: string };
}) {
  const object = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const gaps: string[] = [];
  const decode = (artifact: typeof input.capture) => {
    if (!nonblank(artifact.ref) || createHash('sha256').update(artifact.body).digest('hex') !== artifact.sha256)
      throw new Error('invalid-capture-artifact');
    return object(JSON.parse(artifact.body));
  };
  let capture: Record<string, unknown> = {}, durable: Record<string, unknown> = {};
  try { capture = decode(input.capture); } catch { gaps.push('invalid-capture-artifact'); }
  if (input.durableCapture) {
    try { durable = decode(input.durableCapture); } catch { gaps.push('invalid-durable-artifact'); }
  }
  const capturedInput = object(capture.input), measured = object(capture.measured);
  const scope = object(capture.scope ?? capturedInput.scope);
  const keys = groundedBaselineCensus().filter(key => key.caseId === input.pin.scope.caseId
    && key.iteration === input.pin.scope.iteration);
  const scopeMatches = (candidate: Record<string, unknown>) => scopeKeys.every(key => candidate[key] === input.pin.scope[key]);
  const checks = Array.isArray(measured.checks) ? measured.checks : [];
  const clock = capturedInput.boundary ?? checks.map(row => {
    const check = object(object(row).check), provenance = object(check.provenance);
    return [check.id, provenance.startedAt, provenance.finishedAt];
  });
  if (!scopeMatches(scope) || input.pin.sourceClock !== canonicalJson(clock)) gaps.push('capture-pin-mismatch');
  const observedAt = object(capturedInput.boundary).settledAt
    ?? object(object(object(checks[0]).check).provenance).finishedAt;
  if (observedAt !== input.pin.observedAt) gaps.push('capture-clock-mismatch');
  const qualified = gaps.length === 0;
  const caseId = input.pin.scope.caseId;
  const definition = fixture.cases.find(c => c.id === caseId);
  const expected = object(definition?.expected);
  const callsValue = capture.resumeDispatches ?? capture.consumerDispatches ?? capture.originalCalls;
  const calls = Array.isArray(callsValue) ? callsValue.map(object) : null;
  const validCalls = calls !== null && calls.every(call => nonblank(call.tool)
    && (caseId === 'C5' || caseId === 'C6' ? ['crash', 'recover'].includes(String(call.mode))
      : call.args !== null && typeof call.args === 'object' && !Array.isArray(call.args)));
  const matches = (call: Record<string, unknown> | undefined, predicate: unknown): boolean => {
    const p = object(predicate), args = object(call?.args);
    return call?.tool === p.tool && Object.entries(object(p.argsSubset))
      .every(([key, value]) => canonicalJson(args[key] ?? null) === canonicalJson(value));
  };
  const action = (name: string): boolean | null => {
    if (!validCalls || !calls) return null;
    if (['C1', 'C2', 'C4'].includes(caseId)) return name === 'allowed'
      ? calls.length > 0 && matches(calls[0], expected.allowed)
      : !calls.some(call => matches(call, expected.excluded));
    if (caseId === 'C3') {
      if (name === 'excluded') return !calls.some(call => call.tool === 'items:put');
      if (!input.durableCapture || !scopeMatches(object(durable.scope))
        || gaps.includes('invalid-durable-artifact')) return null;
      const outcome = object(object(durable.result).outcome);
      const originalCalls = durable.originalCalls;
      if (!Array.isArray(originalCalls)) return null;
      const denied = outcome.status === 'failed' && /not allowed for role worker/.test(String(outcome.error))
        && !originalCalls.some(call => object(call).mode === 'recover' && object(call).tool === 'items:put');
      return denied && calls[0]?.tool === 'coord:ask-owner' && calls[0]?.validAuthorityRequest === true;
    }
    if (caseId === 'C5' || caseId === 'C6') {
      const live = calls.filter(call => call.mode === 'recover').map(call => call.tool);
      if (name === 'excluded') return caseId === 'C5'
        ? canonicalJson(live) !== canonicalJson(object(expected.excluded).liveDispatch)
        : !live.includes('mail:send');
      const outcome = object(object(capture.result).outcome);
      if (caseId === 'C6') return outcome.status === 'needs-reconciliation' && live.length === 0;
      if (!Array.isArray(outcome.steps)) return null;
      const replay = outcome.steps.map(object).filter(step => step.source === 'recorded').map(step => step.tool);
      return outcome.status === 'succeeded' && canonicalJson(live) === canonicalJson(object(expected.allowed).liveDispatch)
        && canonicalJson(replay) === canonicalJson(object(expected.allowed).recordedReplay);
    }
    return null;
  };
  const observations: GroundedBaselineObservation[] = keys.map(key => {
    let value: boolean | number | null = null;
    const fragment = key.kind === 'oracle' ? `trace/${key.name}` : `measured/values/${key.name}`;
    if (qualified && key.kind === 'oracle') value = action(key.name);
    if (qualified && key.kind === 'dimension') {
      const found = checks.filter(row => object(object(row).check).subject
        && object(object(object(row).check).subject).ref === `${fixture.edition}/${caseId}/pre/${input.pin.scope.iteration}/${key.name}`);
      const check = found.length === 1 ? parseRecordedRubricCheck(object(found[0]).check) : null;
      const originalValue = object(measured.values)[key.name];
      if (check?.provenance && check.provenance.gaps.length === 0 && check.value === originalValue
        && typeof originalValue === 'number' && check.unit === dimensionUnit(key.name as GroundedDimension)
        && check.provenance.finishedAt === input.pin.observedAt) {
        try {
          const procedure = object(JSON.parse(check.provenance.procedure.snapshot!));
          if (scopeMatches(object(procedure.scope))) value = originalValue;
        } catch { /* An unavailable original procedure cannot qualify a scalar. */ }
      }
    }
    return { kind: key.kind, name: key.name, value, qualified: qualified && value !== null,
      evidenceRef: `${input.capture.ref}#sha256=${input.capture.sha256}/${fragment}`
        + (key.kind === 'oracle' && caseId === 'C3' && key.name === 'allowed' && input.durableCapture
          ? `;${input.durableCapture.ref}#sha256=${input.durableCapture.sha256}` : ''),
      writerRef: key.kind === 'oracle' ? 'grounded-evidence-measurement.ts:projectGroundedBaselineCapture'
        : 'grounded-evidence-measurement.ts:measureGroundedEvidence' };
  });
  const body = canonicalJson({ schemaVersion: 'grounded-baseline-observations-v1', pin: input.pin, observations });
  const original = { body, sha256: createHash('sha256').update(body).digest('hex') };
  return { pin: structuredClone(input.pin), original, source: { ref: input.capture.ref, sha256: input.capture.sha256 },
    gaps, classification: classifyGroundedBaseline({ pin: input.pin, original }) };
}

/** Original bytes, not a current passing capture, govern classification. The
 * existing test_runs check/provenance shape carries the exact original and pin;
 * this is a projection adapter, not another result store or acceptance gate. */
export function classifyGroundedBaseline(input: {
  pin: GroundedBaselinePin;
  original: { body: string; sha256: string };
}) {
  const { pin, original } = input;
  const expected = groundedBaselineCensus().filter(key => key.caseId === pin.scope.caseId
    && key.iteration === pin.scope.iteration);
  const gaps: string[] = [];
  const validPin = validGroundedBaselinePin(pin) && expected.length > 0;
  if (!validPin) gaps.push('invalid-baseline-pin');
  let observations: GroundedBaselineObservation[] = [];
  try {
    if (createHash('sha256').update(original.body, 'utf8').digest('hex') !== original.sha256)
      throw new Error('original-hash-mismatch');
    const decoded = JSON.parse(original.body);
    if (decoded.schemaVersion !== 'grounded-baseline-observations-v1' || hash(decoded.pin) !== hash(pin)
      || !Array.isArray(decoded.observations)) throw new Error('original-pin-or-shape-mismatch');
    observations = decoded.observations;
  } catch { gaps.push('invalid-immutable-original'); }
  const names = new Set(expected.map(baselineKey));
  const admitted = new Map<string, GroundedBaselineObservation[]>();
  for (const observation of observations) {
    if (!observation || typeof observation !== 'object') { gaps.push('invalid-original-observation'); continue; }
    const key = baselineKey({ caseId: pin.scope.caseId, arm: 'pre', iteration: pin.scope.iteration,
      kind: observation.kind, name: observation.name });
    if (!names.has(key)) { gaps.push(`unexpected-original:${key}`); continue; }
    const group = admitted.get(key) ?? []; group.push(observation); admitted.set(key, group);
  }
  const rows: GroundedBaselineRow[] = expected.map(key => {
    const matches = admitted.get(baselineKey(key)) ?? [];
    const observation = matches.length === 1 ? matches[0]! : null;
    if (matches.length !== 1) gaps.push(`${baselineKey(key)}:missing-or-duplicate-original`);
    const validObservation = observation && typeof observation.qualified === 'boolean'
      && nonblank(observation.evidenceRef) && nonblank(observation.writerRef)
      && (observation.value === null || (key.kind === 'oracle' ? typeof observation.value === 'boolean'
        : typeof observation.value === 'number' && Number.isFinite(observation.value) && observation.value >= 0
          && (key.name === 'endToEndMs' || integer(observation.value))));
    if (observation && !validObservation) gaps.push(`${baselineKey(key)}:invalid-original-observation`);
    const qualified = validPin && validObservation && observation.qualified && observation.value !== null;
    const value = qualified ? observation!.value : null;
    const state: GroundedBaselineState = value === null ? 'unknown' : value === false ? 'failure' : 'success';
    return { key, state, value, pin: structuredClone(pin), originalSha256: original.sha256,
      observation: observation ? structuredClone(observation) : null };
  });
  // Failures dominate missing/unknown siblings. Capture-file success is never
  // an input to this summary, and numeric zero remains a measured success.
  const state: GroundedBaselineState = rows.some(row => row.state === 'failure') ? 'failure'
    : !rows.length || rows.some(row => row.state === 'unknown') ? 'unknown' : 'success';
  return { rows, state, gaps, complete: validPin === true && gaps.length === 0,
    ledgerResults: groundedBaselineLedgerResults(rows) };
}

type GroundedBaselineCensusRow = Omit<GroundedBaselineRow, 'pin' | 'originalSha256'> & {
  pin: GroundedBaselinePin | null;
  originalSha256: string | null;
  gap?: string;
};

function groundedBaselineLedgerResults(rows: readonly GroundedBaselineCensusRow[]): RubricCheckResult[] {
  return rows.map(row => {
    // An absent or invalid source clock stays absent/invalid in the retained
    // row. The epoch only permits a diagnostic envelope, never an observation.
    const clock = row.pin?.observedAt;
    const ledgerClock = clock && Number.isFinite(Date.parse(clock)) ? clock : '1970-01-01T00:00:00.000Z';
    const provenance = retainMeasurementProvenance({ startedAt: ledgerClock, finishedAt: ledgerClock,
      procedure: { kind: 'grounded-baseline-classification', row },
      result: { state: row.state, value: row.value }, predicateInput: { path: '$["value"]', value: row.value },
    });
    return { check: { id: `gec-baseline:${hash(row.key)}`, kind: 'instrument',
      rubricRef: 'acceptance-grounded-evidence-and-continuity-2026-11-05', criterionKey: 'r-8',
      subject: { ref: baselineKey(row.key) }, value: row.value,
      unit: row.key.kind === 'dimension' ? dimensionUnit(row.key.name as GroundedDimension) : null, provenance },
    verdict: row.state === 'success' ? 'pass' : row.state === 'failure' ? 'fail' : 'error',
    measuredAt: ledgerClock, durationMs: null };
  });
}

/** Project the fixed population, including keys with no designated original.
 * Callers select the cohort explicitly; historical candidates and recaptures
 * cannot fill its holes. Duplicate designations stay unknown rather than picking
 * a newer/pass result. This extends the existing classifier and ledger format. */
export function classifyGroundedBaselineCensus(cohort: GroundedBaselinePin['cohort'],
  captures: readonly Parameters<typeof classifyGroundedBaseline>[0][]) {
  const census = groundedBaselineCensus();
  const groups = new Map<string, ReturnType<typeof classifyGroundedBaseline>[]>();
  const gaps: string[] = [];
  for (const capture of captures) {
    if (capture.pin.cohort !== cohort) {
      gaps.push(`${capture.pin.scope.caseId}/${capture.pin.scope.iteration}:foreign-cohort`);
      continue;
    }
    const classified = classifyGroundedBaseline(capture);
    if (!classified.rows.length) gaps.push('foreign-baseline-capture');
    gaps.push(...classified.gaps);
    for (const row of classified.rows) {
      const key = baselineKey(row.key), matches = groups.get(key) ?? [];
      matches.push(classified); groups.set(key, matches);
    }
  }
  const rows: GroundedBaselineCensusRow[] = census.map(key => {
    const id = baselineKey(key), matches = groups.get(id) ?? [];
    if (matches.length === 1) return matches[0]!.rows.find(row => baselineKey(row.key) === id)!;
    const gap = matches.length ? 'duplicate-designated-immutable-original'
      : 'no-designated-immutable-original-for-this-atomic-key';
    gaps.push(`${id}:${gap}`);
    return { key, state: 'unknown', value: null, pin: null, originalSha256: null, observation: null, gap };
  });
  const state: GroundedBaselineState = rows.some(row => row.state === 'failure') ? 'failure'
    : rows.some(row => row.state === 'unknown') ? 'unknown' : 'success';
  return { cohort, rows, state, gaps, complete: gaps.length === 0 && !rows.some(row => row.state === 'unknown'),
    ledgerResults: groundedBaselineLedgerResults(rows) };
}

/** Reclassify from original bytes and compare the exact persisted key-set,
 * state, scalar and provenance. Archived fixture scopes remain in provenance;
 * an explicit ledger scope locates their projection in the caller's workspace.
 * A newer ledger row cannot replace an original. */
export function readGroundedBaselineRows(input: Parameters<typeof classifyGroundedBaseline>[0], persisted: readonly {
  id: number; status: string; executionDetails: unknown;
}[], ledgerScope = { workspaceId: input.pin.scope.workspaceId, harnessSlug: input.pin.scope.harness,
  runGroupId: input.pin.scope.runId }) {
  const classified = classifyGroundedBaseline(input);
  const gaps = [...classified.gaps, ...groundedBaselineLedgerGaps(classified.ledgerResults, persisted, ledgerScope)];
  return { ...classified, gaps, integrity: gaps.length === 0 };
}

function groundedBaselineLedgerGaps(results: readonly RubricCheckResult[], persisted: readonly {
  id: number; status: string; executionDetails: unknown;
}[], ledgerScope: { workspaceId: string; harnessSlug: string; runGroupId: string }) {
  const gaps: string[] = [];
  if (![ledgerScope.workspaceId, ledgerScope.harnessSlug, ledgerScope.runGroupId].every(nonblank))
    gaps.push('invalid-ledger-scope');
  const expected = new Map(results.map(row => [row.check.subject!.ref, row]));
  const seen = new Set<string>();
  for (const row of persisted) {
    const details = parseTestRunExecutionDetails(row.executionDetails);
    const check = details?.check;
    const ref = check?.subject?.ref;
    const original = ref ? expected.get(ref) : undefined;
    if (!ref || !original || seen.has(ref)) { gaps.push('unexpected-or-duplicate-persisted-row'); continue; }
    seen.add(ref);
    if (row.status !== original.verdict || hash(check) !== hash(original.check)
      || details?.workspaceId !== ledgerScope.workspaceId || details.harnessSlug !== ledgerScope.harnessSlug
      || details.runGroupId !== ledgerScope.runGroupId) gaps.push(`${ref}:changed-persisted-observation`);
  }
  for (const ref of expected.keys()) if (!seen.has(ref)) gaps.push(`${ref}:missing-persisted-row`);
  return gaps;
}

/** Ledger integrity is separate from baseline readiness: a faithful persisted
 * unknown with a null pin is valid evidence of an unresolved census key. */
export function readGroundedBaselineCensusRows(cohort: GroundedBaselinePin['cohort'],
  captures: readonly Parameters<typeof classifyGroundedBaseline>[0][],
  persisted: Parameters<typeof readGroundedBaselineRows>[1],
  ledgerScope: { workspaceId: string; harnessSlug: string; runGroupId: string }) {
  const classified = classifyGroundedBaselineCensus(cohort, captures);
  const ledgerGaps = groundedBaselineLedgerGaps(classified.ledgerResults, persisted, ledgerScope);
  return { ...classified, ledgerGaps, integrity: ledgerGaps.length === 0 };
}

/** Persisted values use the SAME serialization supplied to the original write.
 * Reads and failed writes must be recorded too; only writes carry byte counts. */
export function groundedPersistedBytes(serializedValue: string | Uint8Array): number {
  return typeof serializedValue === 'string' ? Buffer.byteLength(serializedValue, 'utf8') : serializedValue.byteLength;
}

/** Wrap the collector's existing store methods. Admission ids are captured
 * BEFORE invocation and completed rows AFTER settlement, so a dropped row is
 * detectable without deriving the expected population from those same rows.
 * The caller seals only after the public action and its child work settle. */
export function observeGroundedStoreReads<T extends object>(input: {
  scope: GroundedMeasurementScope; deps: T; methods: readonly (keyof T)[]; sourceRef: string; attemptId: string;
}) {
  return observeGroundedStoreOperations({ ...input,
    operations: input.methods.map(method => ({ method, kind: 'read' as const })) });
}

/** Observe the existing storage boundary, including prototype methods. A write
 * can supply the index of its already-serialized argument; a failed or opaque
 * write keeps bytes unknown because it may have committed before throwing.
 * Never estimate persisted bytes from a returned result or reserialization. */
export function observeGroundedStoreOperations<T extends object>(input: {
  scope: GroundedMeasurementScope; deps: T; sourceRef: string; attemptId: string;
  /** Retain a synchronous original snapshot after each admission/terminal so
   * intentional producer death cannot erase its pending population. */
  onObservation?: () => void;
  onSqlObservation?: (observation: GroundedSqlObservation) => void;
  operations: readonly { method: keyof T; kind: 'read' | 'write'; serializedArgument?: number }[];
  /** Arm every pool in the selected consumer closure before run(). These are
   * postgres-js's actual admission/result hooks, not its bounded diagnostic ring.
   * A source-reviewed classifier may certify a read. Writes require their
   * original serialized argument at Query construction, before driver binding;
   * wire bytes, protocol parameters and returned rows cannot supply it. */
  postgres?: readonly { pool: string; client: postgres.Sql }[];
  /** Install on the actual loaded node-postgres prototypes before creating any
   * child clients. This covers Pool clients AND DBOS's standalone bootstrap
   * Clients without counting Pool.query's delegation a second time. */
  nodePostgres?: readonly { pool: string; clientPrototype: object; queryPrototype: object;
    serializerSourceRef: string;
    /** Opt in before constructing Clients; pin the installed client.js that
     * routes NoticeResponse and ReadyForQuery to its actual active Query. */
    serverMessageSourceRef?: string }[];
  isReadOnlySql?: (result: postgres.QueryResultDiagnostic) => boolean;
  /** Exact reviewed reads and session/transaction controls. A failed SELECT
   * needs its own registration; failure alone never proves zero write bytes. */
  nonPersistingSql?: readonly GroundedNonPersistingSql[];
  serverSqlWrites?: readonly GroundedServerSqlWrite[];
  /** Exact source-pinned tagged-template registration. Only these original
   * string arguments are already-serialized persisted values. Never serialize
   * an object here or infer a value from a similar-looking SQL statement.
   * Conditional writes use the same allOrNoneRows contract documented below. */
  serializedSqlWrites?: readonly { pool: string; sourceRef: string; template: readonly string[];
    command: 'INSERT' | 'UPDATE'; serializedArguments: readonly number[]; allOrNoneRows?: GroundedPersistedRows }[];
  /** postgres.js Bind stores each actual serializer output in Query.parameters.
   * Read it synchronously at the successful terminal, never serialize again.
   * Pin both writer and driver source and the exact emitted statement/arity;
   * protocol framing, returned bytes and unregistered parameters are excluded. */
  serializedSqlParameters?: readonly { pool: string; sourceRef: string; serializerSourceRef: string;
    queryHash: string; command: 'INSERT' | 'UPDATE'; parameterCount: number;
    persistedParameters: readonly number[];
    /** Source-reviewed conditional write: all selected values persist only when
     * CommandComplete affects this many rows. Zero certifies a no-op; a partial,
     * missing or invalid count leaves bytes unknown. 'zero-only' never qualifies
     * positive counts (including unchanged upsert retries). An empty parameter
     * projection is permitted ONLY with 'zero-only': server-derived values
     * cannot qualify positive writes from Bind bytes. Omit only when the reviewed
     * writer unconditionally persists every selected value on success. */
    allOrNoneRows?: GroundedPersistedRows;
    /** node-postgres only: source review proves that existing keys leave ALL
     * selected values unchanged. Reuse a separately captured initial census;
     * errors, overlapping keys and missing terminals poison that key's proof. */
    insertOrNoop?: GroundedInsertOrNoopCensus }[];
}) {
  const ids: string[] = [], rows: GroundedStorageOperation[] = [];
  let pending = 0, sealed = false, late = false, captureFailed = false, restored = false;
  const active = new AsyncLocalStorage<boolean>();
  const awaitingServerReady = new Set<string>();
  const notify = () => { try { input.onObservation?.(); } catch { captureFailed = true; } };
  const notifySql = (observation: Omit<GroundedSqlObservation, 'monotonicMs'>) => {
    if (!input.onSqlObservation) return;
    try { input.onSqlObservation({ ...observation, monotonicMs: performance.now() }); }
    catch { captureFailed = true; }
  };
  const marker = Symbol('grounded-store-admission');
  const outstanding = new Set<string>();
  // Query construction also captures SQL fragments that never execute on their
  // own. Keep the driver's live state independently of terminal callbacks.
  const queryStates = new Map<string, { readonly executed: boolean }>();
  const admissions: Array<{ id: string; origin: string | null;
    /** Original mapper outputs, including unregistered and pending queries.
     * These are diagnostic input bytes, never proof of a persisted write. */
    boundParameters?: { serializerSourceRef: string; parameterCount: number; complete: boolean;
      values: readonly { parameter: number; sha256: string | null; bytes: number }[] } }> = [];
  const restorers: Array<{ intact: () => boolean; restore: () => void }> = [];
  const optionsSeen = new Set<object>();
  // Validate the complete registration before installing ANY hook, so a bad
  // later registration cannot leave an earlier pool partially instrumented.
  if ((input.postgres?.length || input.nodePostgres?.length) && input.operations.length)
    throw new Error('GEC select one physical store boundary');
  for (const { pool, client } of input.postgres ?? []) {
    if (!pool.trim() || optionsSeen.has(client.options)) throw new Error('GEC duplicate or blank SQL pool');
    optionsSeen.add(client.options);
  }
  const nodeDrivers = (input.nodePostgres ?? []).map(driver => {
    const client = driver.clientPrototype as Record<string, unknown>;
    const query = driver.queryPrototype as Record<string, unknown>;
    if (!driver.pool.trim() || !driver.serializerSourceRef.trim() || optionsSeen.has(client) || optionsSeen.has(query)
      || typeof client.query !== 'function'
      || ['submit', 'handleReadyForQuery', 'handleError'].some(key => typeof query[key] !== 'function'))
      throw new Error('GEC invalid node-postgres driver boundary');
    if (driver.serverMessageSourceRef !== undefined && (!driver.serverMessageSourceRef.trim()
      || ['_getActiveQuery', '_handleNotice', '_handleReadyForQuery'].some(key => typeof client[key] !== 'function')))
      throw new Error('GEC invalid node-postgres server message boundary');
    optionsSeen.add(client); optionsSeen.add(query);
    return { ...driver, client, query };
  });
  const nonPersisting = new Map<string, GroundedNonPersistingSql>();
  const statementKey = (queryHash: string, command: string | null, status: string) =>
    JSON.stringify([queryHash, command, status]);
  for (const registration of input.nonPersistingSql ?? []) {
    const { queryHash, sourceRef, kind, command, status } = registration;
    if (!/^[a-f0-9]{64}$/.test(queryHash) || !sourceRef.trim()
      || !['read', 'control'].includes(kind) || !['ok', 'error'].includes(status)
      || (kind === 'read' ? command !== 'SELECT' && !(command === null && status === 'error')
        : status !== 'ok' || !['BEGIN', 'COMMIT', 'ROLLBACK', 'SET', 'SELECT', 'LISTEN', 'NOTIFY'].includes(command ?? '')))
      throw new Error('GEC invalid nonpersisting SQL registration');
    const key = statementKey(queryHash, command, status);
    if (nonPersisting.has(key)) throw new Error('GEC duplicate nonpersisting SQL registration');
    nonPersisting.set(key, { ...registration });
  }
  const writeRegistrations = new Map<string, { sourceRef: string; templateHash: string;
    command: 'INSERT' | 'UPDATE'; serializedArguments: readonly number[]; allOrNoneRows?: GroundedPersistedRows }>();
  for (const registration of input.serializedSqlWrites ?? []) {
    const { pool, sourceRef, template, command, serializedArguments, allOrNoneRows } = registration;
    if (!input.postgres?.some(p => p.pool === pool) || !sourceRef.trim()
      || template.length < 2 || template.some(part => typeof part !== 'string')
      || !['INSERT', 'UPDATE'].includes(command) || !serializedArguments.length
      || new Set(serializedArguments).size !== serializedArguments.length
      || serializedArguments.some(index => !integer(index) || index >= template.length - 1)
      || (allOrNoneRows !== undefined && allOrNoneRows !== 'zero-only' && (!integer(allOrNoneRows) || allOrNoneRows === 0)))
      throw new Error('GEC invalid original SQL write registration');
    const templateHash = hash(template), key = `${pool}:${templateHash}`;
    if (writeRegistrations.has(key)) throw new Error('GEC duplicate original SQL write registration');
    writeRegistrations.set(key, { sourceRef, templateHash, command, serializedArguments: [...serializedArguments], allOrNoneRows });
  }
  const parameterWrites = new Map<string, NonNullable<typeof input.serializedSqlParameters>[number]>();
  type InsertClaim = { key: string; prior: 'present' | 'absent'; contested: boolean };
  type InsertState = { census: GroundedInsertOrNoopCensus; censusHash: string;
    present: Set<string>; uncertain: Set<string>; pending: Map<string, Set<string>>; claims: Map<string, InsertClaim> };
  const insertStates = new Map<string, InsertState>();
  const insertPools = new Set<string>();
  for (const registration of input.serializedSqlParameters ?? []) {
    const { pool, sourceRef, serializerSourceRef, queryHash, command, parameterCount, persistedParameters, allOrNoneRows } = registration;
    if (!(input.postgres?.some(p => p.pool === pool) || nodeDrivers.some(p => p.pool === pool))
      || !sourceRef.trim() || !serializerSourceRef.trim()
      || !/^[a-f0-9]{64}$/.test(queryHash) || !['INSERT', 'UPDATE'].includes(command)
      || !integer(parameterCount) || (!persistedParameters.length && allOrNoneRows !== 'zero-only')
      || new Set(persistedParameters).size !== persistedParameters.length
      || persistedParameters.some(index => !integer(index) || index >= parameterCount)
      || (allOrNoneRows !== undefined && allOrNoneRows !== 'zero-only' && (!integer(allOrNoneRows) || allOrNoneRows === 0)))
      throw new Error('GEC invalid original SQL parameter registration');
    const key = `${pool}:${queryHash}`;
    if (parameterWrites.has(key)) throw new Error('GEC duplicate original SQL parameter registration');
    const census = registration.insertOrNoop;
    if (census) {
      if (!nodeDrivers.some(driver => driver.pool === pool) || command !== 'INSERT'
        || allOrNoneRows !== 'zero-only' || !sameScope(census.scope, input.scope)
        || !nonblank(census.sourceRef) || census.complete !== true || census.exclusive !== true
        || !census.keyParameters.length || new Set(census.keyParameters).size !== census.keyParameters.length
        || census.keyParameters.some(index => !integer(index) || index >= parameterCount)
        || census.initialKeys.some(row => row.length !== census.keyParameters.length
          || row.some(value => !/^[a-f0-9]{64}$/.test(value)))
        || new Set(census.initialKeys.map(row => canonicalJson(row))).size !== census.initialKeys.length
        || insertPools.has(pool)) throw new Error('GEC invalid insert-or-noop initial census');
      insertPools.add(pool);
      const original = structuredClone(census);
      insertStates.set(key, { census: original, censusHash: hash(original),
        present: new Set(original.initialKeys.map(row => canonicalJson(row))),
        uncertain: new Set(), pending: new Map(), claims: new Map() });
    }
    parameterWrites.set(key, { ...registration, persistedParameters: [...persistedParameters],
      ...(census ? { insertOrNoop: structuredClone(census) } : {}) });
  }
  const admitInsert = (state: InsertState, id: string,
    values: Map<number, { sha256: string | null }>) => {
    const hashes = state.census.keyParameters.map(index => values.get(index)?.sha256);
    if (hashes.some(value => typeof value !== 'string')) return;
    const key = canonicalJson(hashes), pendingKeys = state.pending.get(key) ?? new Set<string>();
    const contested = state.uncertain.has(key) || pendingKeys.size > 0;
    if (contested) {
      state.uncertain.add(key);
      for (const other of pendingKeys) state.claims.get(other)!.contested = true;
    }
    state.claims.set(id, { key, prior: state.present.has(key) ? 'present' : 'absent', contested });
    pendingKeys.add(id); state.pending.set(key, pendingKeys);
  };
  const settleInsert = (state: InsertState, id: string, successful: boolean,
    affectedRows: number | null, bytes: number | null): number | null => {
    const claim = state.claims.get(id);
    if (!claim) return null;
    state.pending.get(claim.key)!.delete(id);
    if (claim.contested || state.uncertain.has(claim.key) || !successful || bytes === null
      || (affectedRows !== 0 && affectedRows !== 1) || (affectedRows === 0 && claim.prior === 'absent')) {
      state.uncertain.add(claim.key); return null;
    }
    if (affectedRows === 1) state.present.add(claim.key);
    return affectedRows === 0 || claim.prior === 'present' ? 0 : bytes;
  };
  const bytesForOutcome = (bytes: number | null, allOrNoneRows: GroundedPersistedRows | undefined, affectedRows: number | null) =>
    bytes === null || allOrNoneRows === undefined ? bytes
      : affectedRows === 0 ? 0 : affectedRows === allOrNoneRows ? bytes : null;
  const serverWrites = structuredClone(input.serverSqlWrites ?? []);
  const serverWriteKeys = new Set<string>();
  for (const registration of serverWrites) {
    const driver = nodeDrivers.find(d => d.pool === registration.pool);
    const key = `${registration.pool}:${registration.queryHash}`;
    if (!driver?.serverMessageSourceRef || driver.serverMessageSourceRef !== registration.serverMessageSourceRef
      || !/^[a-f0-9]{64}$/.test(registration.queryHash) || !/^[a-f0-9]{64}$/.test(registration.marker)
      || !registration.sourceRef.trim() || !registration.triggerSourceRef.trim() || registration.exclusive !== true
      || !['INSERT', 'UPDATE'].includes(registration.command) || !registration.schema.trim() || !registration.table.trim()
      || !registration.columns.length || registration.columns.some(c => !c.trim())
      || new Set(registration.columns).size !== registration.columns.length || serverWriteKeys.has(key)
      || parameterWrites.has(key) || [...nonPersisting.values()].some(r => r.queryHash === registration.queryHash))
      throw new Error('GEC invalid server SQL write registration');
    serverWriteKeys.add(key);
  }
  const methodsSeen = new Set<keyof T>();
  for (const operation of input.operations) {
    if (typeof input.deps[operation.method] !== 'function') throw new Error(`GEC missing store method: ${String(operation.method)}`);
    if (methodsSeen.has(operation.method)) throw new Error(`GEC duplicate store method: ${String(operation.method)}`);
    methodsSeen.add(operation.method);
  }
  for (const driver of nodeDrivers) {
    const originalQuery = driver.client.query as (...args: unknown[]) => unknown;
    const originalSubmit = driver.query.submit as (...args: unknown[]) => unknown;
    const originalReady = driver.query.handleReadyForQuery as (...args: unknown[]) => unknown;
    const originalError = driver.query.handleError as (...args: unknown[]) => unknown;
    const originalNotice = driver.client._handleNotice as (...args: unknown[]) => unknown;
    const originalClientReady = driver.client._handleReadyForQuery as (...args: unknown[]) => unknown;
    const originalActiveQuery = driver.client._getActiveQuery as (...args: unknown[]) => unknown;
    type Query = Record<string, unknown>;
    type Entry = { id: string; admission: typeof admissions[number]; client: Query; backendProcessId: number | null;
      query?: Query; queryHash?: string; parameterCount?: number;
      values: Map<number, { parameter: number; sha256: string | null; bytes: number }>; bound: boolean;
      serverMessages?: NonNullable<GroundedStorageOperation['sql']>['serverMessages'] };
    // pg.Client._handleBackendKeyData writes this after the actual connection
    // handshake. A queued query can be admitted before that handshake finishes.
    const backendProcessId = (client: Query): number | null =>
      typeof client.processID === 'number' && Number.isSafeInteger(client.processID) && client.processID > 0
        ? client.processID : null;
    const current = new AsyncLocalStorage<Entry>();
    const queries = new WeakMap<object, Entry>();
    const submitted = new WeakMap<object, Entry>();
    const seenClients = new WeakSet<object>();
    let unattributedNotices = 0;
    const associate = (query: Query): Entry | undefined => {
      const entry = queries.get(query) ?? current.getStore();
      if (!entry) return;
      if ((entry.query && entry.query !== query) || (queries.has(query) && queries.get(query) !== entry)) {
        captureFailed = true; return;
      }
      entry.query = query; queries.set(query, entry);
      return entry;
    };
    const terminal = (query: Query, status: 'ok' | 'error') => {
      const entry = associate(query);
      if (!entry || !outstanding.has(entry.id)) return;
      const result = query._results as { command?: unknown; rowCount?: unknown } | undefined;
      const command = status === 'ok' && result && !Array.isArray(result) && typeof result.command === 'string'
        ? result.command : null;
      const affectedRows = command !== null && integer(result?.rowCount) ? result.rowCount : null;
      // The successful terminal must still name the exact statement submitted.
      const queryHash = entry.queryHash ?? (typeof query.text === 'string'
        ? createHash('sha256').update(query.text).digest('hex') : null);
      if (!queryHash || (entry.queryHash && (typeof query.text !== 'string'
        || createHash('sha256').update(query.text).digest('hex') !== entry.queryHash))) captureFailed = true;
      const reviewed = queryHash ? nonPersisting.get(statementKey(queryHash, command, status)) : undefined;
      const registration = queryHash ? parameterWrites.get(`${driver.pool}:${queryHash}`) : undefined;
      let kind: GroundedStorageOperation['kind'] = reviewed?.kind ?? (registration ? 'write' : 'unknown');
      let persistedBytes: number | null = null;
      let serializedParameters: NonNullable<GroundedStorageOperation['sql']>['serializedParameters'];
      const insertState = queryHash ? insertStates.get(`${driver.pool}:${queryHash}`) : undefined;
      if (registration) {
        if (reviewed) { captureFailed = true; kind = 'unknown'; }
        const values = registration.persistedParameters.flatMap(parameter => {
          const value = entry.values.get(parameter); return value ? [value] : [];
        });
        serializedParameters = { sourceRef: registration.sourceRef, serializerSourceRef: driver.serializerSourceRef,
          parameterCount: entry.parameterCount ?? 0, values };
        const bytes = values.reduce((sum, value) => sum + value.bytes, 0);
        const qualified = !reviewed && status === 'ok' && command === registration.command && entry.bound
          && entry.parameterCount === registration.parameterCount && entry.values.size === entry.parameterCount
          && registration.serializerSourceRef === driver.serializerSourceRef
          && values.length === registration.persistedParameters.length && integer(bytes);
        if (insertState) persistedBytes = settleInsert(insertState, entry.id, qualified, affectedRows, qualified ? bytes : null);
        else if (qualified) persistedBytes = bytesForOutcome(bytes, registration.allOrNoneRows, affectedRows);
      }
      const insertClaim = insertState?.claims.get(entry.id);
      rows.push({ id: entry.id, kind, persistedBytes, sql: { pool: driver.pool,
        queryId: Number(entry.id.split(':node:').at(-1)), queryHash: queryHash ?? '', command, status,
        backendProcessId: entry.backendProcessId, affectedRows,
        ...(entry.serverMessages ? { serverMessages: entry.serverMessages } : {}),
        ...(registration?.allOrNoneRows !== undefined
          ? { rowOutcome: { allOrNoneRows: registration.allOrNoneRows, affectedRows } } : {}),
        ...(reviewed ? { nonPersisting: { sourceRef: reviewed.sourceRef, kind: reviewed.kind } } : {}),
        ...(serializedParameters ? { serializedParameters } : {}),
        ...(insertState && insertClaim ? { insertOrNoop: { censusRef: insertState.census.sourceRef,
          censusHash: insertState.censusHash, keyHash: hash(insertClaim.key), prior: insertClaim.prior,
          contested: insertClaim.contested } } : {}) } });
      notifySql({ id: entry.id, pool: driver.pool, phase: 'terminal',
        query: typeof query.text === 'string' ? query.text : null, command, status,
        backendProcessId: entry.backendProcessId });
      outstanding.delete(entry.id); pending--; notify();
    };
    const query = function(this: Query, ...args: unknown[]) {
      if (!active.getStore()) {
        // A transaction cannot be proved if this physical Client executes an
        // unobserved statement between its recorded BEGIN and COMMIT.
        if (serverWrites.length && seenClients.has(this)) captureFailed = true;
        return Reflect.apply(originalQuery, this, args);
      }
      late ||= sealed;
      const id = `${input.attemptId}:store:${ids.length + 1}:node:${ids.length + 1}`;
      const admission: typeof admissions[number] = {
        id, origin: new Error().stack?.split('\n').slice(2, 10).join('\n') ?? null };
      const entry: Entry = { id, admission, client: this, backendProcessId: null, values: new Map(), bound: false,
        ...(driver.serverMessageSourceRef ? { serverMessages: { sourceRef: driver.serverMessageSourceRef,
          notices: [], transactionStatus: null } } : {}) };
      seenClients.add(this);
      ids.push(id); outstanding.add(id); pending++;
      admissions.push(admission);
      const queryText = typeof args[0] === 'string' ? args[0]
        : args[0] && typeof args[0] === 'object' && typeof (args[0] as Query).text === 'string'
          ? (args[0] as { text: string }).text : null;
      notifySql({ id, pool: driver.pool, phase: 'admission', query: queryText,
        backendProcessId: backendProcessId(this) });
      notify();
      try {
        const result = current.run(entry, () => Reflect.apply(originalQuery, this, args));
        // A queued Query submits in another query's async context. Bind its
        // identity NOW, before that context can run; never attribute by timing.
        if (!entry.query && Array.isArray(this._queryQueue)) {
          const queued = this._queryQueue.filter(candidate => candidate && typeof candidate === 'object'
            && !queries.has(candidate));
          if (queued.length === 1) { entry.query = queued[0]; queries.set(queued[0], entry); }
          else if (queued.length > 1) captureFailed = true;
        }
        return result;
      } catch (error) { captureFailed = true; throw error; }
    };
    const submit = function(this: Query, ...args: unknown[]) {
      const entry = associate(this);
      if (!entry) return Reflect.apply(originalSubmit, this, args);
      if (typeof this.text === 'string') entry.queryHash = createHash('sha256').update(this.text).digest('hex');
      else captureFailed = true;
      entry.parameterCount = Array.isArray(this.values) ? this.values.length : 0;
      entry.backendProcessId = backendProcessId(entry.client);
      submitted.set(entry.client, entry);
      if (driver.serverMessageSourceRef) awaitingServerReady.add(entry.id);
      notifySql({ id: entry.id, pool: driver.pool, phase: 'submit', query: typeof this.text === 'string' ? this.text : null,
        backendProcessId: entry.backendProcessId });
      const connection = args[0] as Record<string, unknown> | undefined;
      const originalBind = connection?.bind;
      if (!connection || typeof originalBind !== 'function') {
        captureFailed = true; return Reflect.apply(originalSubmit, this, args);
      }
      const bind = function(this: object, ...bindArgs: unknown[]) {
        const config = bindArgs[0] as { valueMapper?: unknown } | undefined;
        const mapper = config?.valueMapper;
        if (!config || typeof mapper !== 'function') { captureFailed = true; return Reflect.apply(originalBind, this, bindArgs); }
        const captured = { ...config, valueMapper: function(this: unknown, value: unknown, parameter: number) {
          // Call the ORIGINAL mapper exactly once. toJSON/toPostgres can be
          // stateful; a second serialization would fabricate persisted bytes.
          const serialized = Reflect.apply(mapper, this, [value, parameter]);
          if (!integer(parameter) || entry.values.has(parameter)) captureFailed = true;
          if (serialized === null) entry.values.set(parameter, { parameter, sha256: null, bytes: 0 });
          else if (typeof serialized === 'string' || serialized instanceof Uint8Array)
            entry.values.set(parameter, { parameter, sha256: createHash('sha256').update(serialized).digest('hex'),
              bytes: groundedPersistedBytes(serialized) });
          else captureFailed = true;
          return serialized;
        } };
        try {
          const result = Reflect.apply(originalBind, this, [captured, ...bindArgs.slice(1)]);
          entry.bound = true;
          return result;
        } finally {
          // Preserve the original mapper outputs before a terminal or a crash.
          // A partial serialization remains explicit and never invokes a mapper
          // again. The existing snapshot/journal owns retention and integrity.
          const values = [...entry.values.values()].sort((a, b) => a.parameter - b.parameter);
          entry.admission.boundParameters = { serializerSourceRef: driver.serializerSourceRef,
            parameterCount: entry.parameterCount ?? 0,
            complete: entry.bound && values.length === entry.parameterCount, values };
          const registrationKey = `${driver.pool}:${entry.queryHash}`;
          const state = insertStates.get(registrationKey), registration = parameterWrites.get(registrationKey);
          if (state && registration && entry.bound && entry.values.size === registration.parameterCount
            && entry.parameterCount === registration.parameterCount
            && registration.serializerSourceRef === driver.serializerSourceRef) admitInsert(state, entry.id, entry.values);
          notify();
        }
      };
      connection.bind = bind;
      try { return Reflect.apply(originalSubmit, this, args); }
      finally {
        if (connection.bind === bind) connection.bind = originalBind;
        else captureFailed = true;
      }
    };
    const ready = function(this: Query, ...args: unknown[]) {
      // pg routes row-decoder failures through handleError inside this method.
      if (!this._canceledDueToError) terminal(this, 'ok');
      return Reflect.apply(originalReady, this, args);
    };
    const error = function(this: Query, ...args: unknown[]) {
      terminal(this, 'error'); return Reflect.apply(originalError, this, args);
    };
    const notice = function(this: Query, ...args: unknown[]) {
      // Socket events do not carry the caller's AsyncLocalStorage context.
      // Read the driver's active Query; never infer identity from notice text,
      // matching SQL, backend PID alone, or the order of two connections.
      try {
        const query = Reflect.apply(originalActiveQuery, this, []);
        const entry = query && typeof query === 'object' ? queries.get(query) : undefined;
        if (entry || seenClients.has(this)) {
          late ||= sealed;
          const message = args[0] as Record<string, unknown> | null;
          const field = (key: string) => message && typeof message[key] === 'string' ? message[key] as string : null;
          const original = { message: field('message'), severity: field('severity'), code: field('code'),
            detail: field('detail'), where: field('where') };
          const associated = entry?.client === this && submitted.get(this) === entry ? entry : undefined;
          if (associated && backendProcessId(this) !== associated.backendProcessId) captureFailed = true;
          if (associated) associated.serverMessages?.notices.push(original);
          notifySql({ id: associated ? associated.id : `${input.attemptId}:unattributed-notice:${++unattributedNotices}`,
            pool: driver.pool, phase: 'notice', query: typeof associated?.query?.text === 'string' ? associated.query.text : null,
            backendProcessId: associated ? associated.backendProcessId : backendProcessId(this),
            serverMessageSourceRef: driver.serverMessageSourceRef, notice: original,
            association: associated ? 'executing-query' : 'unattributed' });
          notify();
        }
      } catch { captureFailed = true; }
      return Reflect.apply(originalNotice, this, args);
    };
    const clientReady = function(this: Query, ...args: unknown[]) {
      // pg clears its active Query before invoking Query.handleReadyForQuery;
      // failed statements were cleared even earlier in _handleErrorMessage.
      // Keep the exact submitted identity until its ReadyForQuery arrives.
      const entry = submitted.get(this);
      if (entry) {
        late ||= sealed;
        try {
          const message = args[0] as { status?: unknown } | undefined;
          const status = message?.status;
          const transactionStatus = status === 'I' || status === 'T' || status === 'E' ? status : null;
          const query = Reflect.apply(originalActiveQuery, this, []);
          if ((query && query !== entry.query) || transactionStatus === null
            || backendProcessId(this) !== entry.backendProcessId) captureFailed = true;
          if (entry.serverMessages) entry.serverMessages.transactionStatus = transactionStatus;
          notifySql({ id: entry.id, pool: driver.pool, phase: 'ready',
            query: typeof entry.query?.text === 'string' ? entry.query.text : null,
            backendProcessId: entry.backendProcessId, serverMessageSourceRef: driver.serverMessageSourceRef,
            transactionStatus });
          notify();
        } catch { captureFailed = true; }
        submitted.delete(this);
        awaitingServerReady.delete(entry.id);
      }
      return Reflect.apply(originalClientReady, this, args);
    };
    driver.client.query = query; driver.query.submit = submit;
    driver.query.handleReadyForQuery = ready; driver.query.handleError = error;
    if (driver.serverMessageSourceRef) {
      driver.client._handleNotice = notice; driver.client._handleReadyForQuery = clientReady;
    }
    restorers.push({ intact: () => driver.client.query === query && driver.query.submit === submit
        && driver.query.handleReadyForQuery === ready && driver.query.handleError === error
        && (!driver.serverMessageSourceRef || (driver.client._handleNotice === notice
          && driver.client._handleReadyForQuery === clientReady)),
      restore: () => {
        if (driver.client.query === query) driver.client.query = originalQuery;
        if (driver.query.submit === submit) driver.query.submit = originalSubmit;
        if (driver.query.handleReadyForQuery === ready) driver.query.handleReadyForQuery = originalReady;
        if (driver.query.handleError === error) driver.query.handleError = originalError;
        if (driver.serverMessageSourceRef) {
          if (driver.client._handleNotice === notice) driver.client._handleNotice = originalNotice;
          if (driver.client._handleReadyForQuery === clientReady) driver.client._handleReadyForQuery = originalClientReady;
        }
      } });
  }
  for (const { pool, client } of input.postgres ?? []) {
    const options = client.options;
    const priorContext = options.onquerycontext, priorResult = options.onresult;
    const onquerycontext: NonNullable<typeof options.onquerycontext> = query => {
      let prior: unknown;
      try { prior = priorContext?.(query); }
      catch (error) { if (active.getStore()) captureFailed = true; throw error; }
      if (!active.getStore()) return prior;
      late ||= sealed;
      const id = `${input.attemptId}:store:${ids.length + 1}:sql:${pool}`;
      ids.push(id); outstanding.add(id); pending++;
      if (query && typeof query.executed === 'boolean') queryStates.set(id, query);
      else captureFailed = true; // Older drivers cannot certify the population.
      admissions.push({ id, origin: new Error().stack?.split('\n').slice(2, 10).join('\n') ?? null });
      notifySql({ id, pool, phase: 'admission', query: null });
      let write: { command: 'INSERT' | 'UPDATE'; bytes: number | null; allOrNoneRows?: GroundedPersistedRows;
        evidence: NonNullable<GroundedStorageOperation['sql']>['serializedWrite'] } | undefined;
      try {
        // The existing hook receives the actual Query, whose constructor stores
        // strings/args before calling onquerycontext. Retain scalars now: the
        // caller can mutate its Query before a later terminal callback.
        const original = query as unknown as { tagged?: boolean; strings?: unknown; args?: unknown } | undefined;
        if (writeRegistrations.size && original?.tagged === true && Array.isArray(original.strings)
          && original.strings.every(part => typeof part === 'string')) {
          const registration = writeRegistrations.get(`${pool}:${hash(original.strings)}`);
          if (registration) {
            const args = original.args;
            const values = Array.isArray(args) && args.length === original.strings.length - 1
              ? registration.serializedArguments.flatMap(argument => typeof args[argument] === 'string'
                ? [{ argument, sha256: createHash('sha256').update(args[argument], 'utf8').digest('hex'),
                  bytes: groundedPersistedBytes(args[argument]) }] : []) : [];
            const total = values.reduce((sum, value) => sum + value.bytes, 0);
            write = { command: registration.command, allOrNoneRows: registration.allOrNoneRows,
              bytes: values.length === registration.serializedArguments.length && integer(total) ? total : null,
              evidence: { sourceRef: registration.sourceRef, templateHash: registration.templateHash, values } };
          }
        }
      } catch { captureFailed = true; }
      notify();
      return { marker, id, prior, write };
    };
    const onresult = (result: postgres.QueryResultDiagnostic) => {
      const context = result.context as { marker?: symbol; id?: string; prior?: unknown;
        write?: { command: string; bytes: number | null; allOrNoneRows?: GroundedPersistedRows;
          evidence: NonNullable<GroundedStorageOperation['sql']>['serializedWrite'] } } | undefined;
      if (context?.marker !== marker) { priorResult?.(result); return; }
      try {
        if (!context.id || !outstanding.delete(context.id)) { captureFailed = true; return; }
        const queryHash = createHash('sha256').update(result.query).digest('hex');
        // Diagnostic rowCount counts DataRow messages, NOT affected rows. Read
        // the actual single Result's CommandComplete count even without RETURNING.
        // Multi-statement results and failed queries cannot certify this outcome.
        const terminalResult = result.result as { command?: unknown; count?: unknown } | undefined;
        const affectedRows = result.status === 'ok' && terminalResult?.command === result.command
          && integer(terminalResult?.count) ? terminalResult.count : null;
        const reviewed = nonPersisting.get(statementKey(queryHash, result.command, result.status));
        let kind: GroundedStorageOperation['kind'] = reviewed?.kind ?? 'unknown';
        try { if (input.isReadOnlySql?.(result)) kind = 'read'; }
        catch { captureFailed = true; }
        let persistedBytes: number | null = null;
        let serializedParameters: NonNullable<GroundedStorageOperation['sql']>['serializedParameters'];
        if (context.write) {
          if (kind !== 'unknown' || (result.status === 'ok' && result.command !== context.write.command)) captureFailed = true;
          else {
            kind = 'write';
            if (result.status === 'ok') {
              // A mutable Query is not an immutable receipt. Certify bytes only
              // if the original strings still reach this terminal unchanged.
              const original = queryStates.get(context.id) as unknown as { strings?: unknown; args?: unknown };
              try {
                const evidence = context.write.evidence, args = original?.args;
                if (evidence && Array.isArray(original?.strings) && hash(original.strings) === evidence.templateHash
                  && Array.isArray(args) && args.length === original.strings.length - 1
                  && evidence.values.every(value => typeof args[value.argument] === 'string'
                    && createHash('sha256').update(args[value.argument], 'utf8').digest('hex') === value.sha256))
                  persistedBytes = bytesForOutcome(context.write.bytes, context.write.allOrNoneRows, affectedRows);
              } catch { captureFailed = true; }
            }
          }
        }
        const parameterWrite = parameterWrites.get(`${pool}:${queryHash}`);
        if (parameterWrite) {
          if (kind !== 'unknown' || context.write
            || (result.status === 'ok' && result.command !== parameterWrite.command)) captureFailed = true;
          else {
            kind = 'write';
            const original = queryStates.get(context.id) as unknown as {
              executed?: boolean; parameters?: unknown; statement?: { string?: unknown }; options?: { simple?: boolean } };
            const parameters = original?.parameters;
            // A successful extended-protocol terminal follows Bind. Its array
            // contains those same serializer outputs, including sql.json and
            // dynamic builders. Simple queries have no such serialization proof.
            if (result.status === 'ok' && original?.executed === true && !original.options?.simple
              && original.statement?.string === result.query && Array.isArray(parameters)
              && parameters.length === parameterWrite.parameterCount) {
              const values = parameterWrite.persistedParameters.flatMap<{ parameter: number; sha256: string | null; bytes: number }>(parameter => {
                const value = parameters[parameter];
                return value === null ? [{ parameter, sha256: null, bytes: 0 }]
                  : typeof value === 'string' ? [{ parameter,
                    sha256: createHash('sha256').update(value, 'utf8').digest('hex'), bytes: groundedPersistedBytes(value) }]
                  : [];
              });
              const total = values.reduce((sum, value) => sum + value.bytes, 0);
              serializedParameters = { sourceRef: parameterWrite.sourceRef,
                serializerSourceRef: parameterWrite.serializerSourceRef, parameterCount: parameterWrite.parameterCount, values };
              if (values.length === parameterWrite.persistedParameters.length && integer(total))
                persistedBytes = bytesForOutcome(total, parameterWrite.allOrNoneRows, affectedRows);
            }
          }
        }
        rows.push({ id: context.id, kind, persistedBytes, sql: {
          pool, queryId: result.queryId, queryHash,
          command: result.command, status: result.status,
          ...((parameterWrite?.allOrNoneRows ?? context.write?.allOrNoneRows) !== undefined
            ? { rowOutcome: { allOrNoneRows: (parameterWrite?.allOrNoneRows ?? context.write?.allOrNoneRows)!, affectedRows } } : {}),
          ...(reviewed ? { nonPersisting: { sourceRef: reviewed.sourceRef, kind: reviewed.kind } } : {}),
          ...(context.write ? { serializedWrite: context.write.evidence } : {}),
          ...(serializedParameters ? { serializedParameters } : {}),
        } });
        notifySql({ id: context.id, pool, phase: 'terminal', query: result.query,
          command: result.command, status: result.status });
        pending--; notify();
      } finally {
        // Keep existing diagnostic attribution byte-for-byte, even when the
        // terminal callback runs outside the caller's async context.
        priorResult?.({ ...result, context: context.prior });
      }
    };
    options.onquerycontext = onquerycontext;
    options.onresult = onresult;
    restorers.push({ intact: () => options.onquerycontext === onquerycontext && options.onresult === onresult,
      restore: () => {
        if (options.onquerycontext === onquerycontext) options.onquerycontext = priorContext;
        if (options.onresult === onresult) options.onresult = priorResult;
      } });
  }
  const wrapped = new Map<PropertyKey, (...args: unknown[]) => Promise<unknown>>();
  for (const operation of input.operations) {
    const name = operation.method, original = input.deps[name];
    if (typeof original !== 'function') throw new Error(`GEC missing store method: ${String(name)}`);
    if (wrapped.has(name)) throw new Error(`GEC duplicate store method: ${String(name)}`);
    wrapped.set(name, async (...args: unknown[]) => {
      late ||= sealed;
      const id = `${input.attemptId}:store:${ids.length + 1}:${String(name)}`;
      ids.push(id); pending++;
      const value = operation.serializedArgument === undefined ? undefined : args[operation.serializedArgument];
      const bytes = typeof value === 'string' || value instanceof Uint8Array ? groundedPersistedBytes(value) : null;
      let succeeded = false;
      try {
        const result = await Reflect.apply(original, input.deps, args);
        succeeded = true;
        return result;
      } finally {
        rows.push({ id, kind: operation.kind,
          persistedBytes: operation.kind === 'write' && succeeded ? bytes : null });
        pending--;
      }
    });
  }
  const deps = new Proxy(input.deps, { get(target, key) {
    if (wrapped.has(key)) return wrapped.get(key);
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const capture = (): GroundedCensus<GroundedStorageOperation> & { diagnostics: {
      pending: number; pendingIds: string[]; late: boolean; captureFailed: boolean; hooksIntact: boolean;
      serverMessagesPending: string[];
      admissions: typeof admissions; excludedUnexecutedIds: string[];
    } } => {
    const excluded = new Set([...queryStates].filter(([id, query]) => {
      // A live admission can execute immediately AFTER its snapshot is saved.
      // Only a final drain can exclude an independently unexecuted fragment.
      if (!sealed || query.executed !== false) return false;
      // A terminal result contradicting the driver's state is instrumentation
      // loss, never grounds to remove an observed physical operation.
      if (!outstanding.has(id)) { captureFailed = true; return false; }
      return true;
    }).map(([id]) => id));
    const pendingIds = [...outstanding].filter(id => !excluded.has(id));
    const complete = sealed && pendingIds.length === 0 && pending === outstanding.size && !late && !captureFailed
      && awaitingServerReady.size === 0 && (restored || restorers.every(hook => hook.intact()));
    const capturedRows = structuredClone(rows);
    qualifyGroundedServerWrites(capturedRows, complete, serverWrites);
    return { scope: { ...input.scope }, sourceRef: input.sourceRef,
      complete,
      diagnostics: { pending: pendingIds.length, pendingIds, late, captureFailed,
        serverMessagesPending: [...awaitingServerReady],
        hooksIntact: restored || restorers.every(hook => hook.intact()), admissions: structuredClone(admissions),
        excludedUnexecutedIds: [...excluded] },
      ids: ids.filter(id => !excluded.has(id)), rows: capturedRows };
  };
  return { deps, run: <R>(fn: () => R): R => {
      if (restored) throw new Error('GEC store recorder already restored');
      return active.run(true, fn);
    },
    restore: () => { captureFailed ||= awaitingServerReady.size > 0 || pending !== outstanding.size
        || [...outstanding].some(id => queryStates.get(id)?.executed !== false)
        || restorers.some(hook => !hook.intact());
      for (const hook of restorers) hook.restore(); restored = true; },
    snapshot: capture,
    seal: () => { sealed = true; return capture(); },
  };
}

/** Tap an existing dispatcher at its registered transport boundary. Registration
 * supplies purpose; neither returned prose nor a guessed tool-name heuristic
 * does. Unknown registrations, failures, repeats and nested calls remain in the
 * original census. Retain this census in the caller's existing recorder. */
export function observeGroundedToolDispatch<Rest extends unknown[], Result>(input: {
  scope: GroundedMeasurementScope; sourceRef: string; attemptId: string;
  boundary: GroundedInvocation['boundary']; originRef: string;
  /** Retain the original admission before a dispatched handler can kill its producer. */
  onObservation?: () => void;
  registrations: Readonly<Record<string, { purpose: GroundedInvocation['purpose']; purposeRef: string }>>;
  dispatch: (tool: string, args: unknown, ...rest: Rest) => Promise<Result>;
}) {
  const ids: string[] = [], rows: GroundedInvocation[] = [];
  const admissions: GroundedInvocation[] = [];
  const outstanding = new Set<string>();
  let pending = 0, sealed = false, late = false, captureFailed = false;
  const notify = () => { try { input.onObservation?.(); } catch { captureFailed = true; } };
  const dispatch = async (tool: string, args: unknown, ...rest: Rest): Promise<Result> => {
    late ||= sealed;
    const id = `${input.attemptId}:dispatch:${ids.length + 1}`;
    ids.push(id); pending++;
    const registration = Object.hasOwn(input.registrations, tool) ? input.registrations[tool] : undefined;
    let originalArgs: unknown;
    try { originalArgs = structuredClone(args); }
    catch { originalArgs = null; captureFailed = true; }
    const row: GroundedInvocation = { id, tool, args: originalArgs,
      boundary: input.boundary, originRef: input.originRef,
      purpose: registration?.purpose ?? 'unknown', purposeRef: registration?.purposeRef ?? '' };
    admissions.push(row); outstanding.add(id); notify();
    try { return await input.dispatch(tool, args, ...rest); }
    finally { rows.push(row); outstanding.delete(id); pending--; notify(); }
  };
  const capture = () => ({ scope: { ...input.scope }, sourceRef: input.sourceRef,
    complete: sealed && pending === 0 && !late && !captureFailed,
    ids: [...ids], rows: structuredClone(rows),
    diagnostics: { pending, pendingIds: [...outstanding], late, captureFailed, admissions: structuredClone(admissions) } });
  return { dispatch, snapshot: capture, seal: () => { sealed = true; return capture(); } };
}

/** Count actual host.runStep attempts including replay, preserving the host's
 * return/throw behavior. This does not guess DBOS persistence byte counts. */
export function observeGroundedDurableHost<T extends { runStep<R>(name: string, fn: () => Promise<R>): Promise<R> }>(input: {
  scope: GroundedMeasurementScope; host: T; sourceRef: string; attemptId: string;
}) {
  const ids: string[] = [], rows: Array<{ id: string; source: 'live' | 'recorded' }> = [];
  let pending = 0, sealed = false, late = false;
  const runStep = async <R>(name: string, fn: () => Promise<R>): Promise<R> => {
    late ||= sealed;
    const id = `${input.attemptId}:durable:${ids.length + 1}:${name}`;
    ids.push(id); pending++;
    let live = false;
    try {
      const result = await input.host.runStep(name, async () => { live = true; return fn(); });
      rows.push({ id, source: live ? 'live' : 'recorded' });
      return result;
    } finally { pending--; }
  };
  const host = new Proxy(input.host, { get(target, key) {
    if (key === 'runStep') return runStep;
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const capture = (complete: boolean): GroundedCensus<{ id: string; source: 'live' | 'recorded' }> => ({
    scope: { ...input.scope }, sourceRef: input.sourceRef, complete,
    ids: [...ids], rows: rows.map(row => ({ ...row })),
  });
  return { host,
    // Retain admitted work before a producer can die. A snapshot never closes
    // admission or certifies a drain, even when no step happens to be pending.
    snapshot: () => capture(false),
    seal: () => { sealed = true; return capture(pending === 0 && !late); },
  };
}

/** A measurement tap at the existing injected provider fetch seam. Every send,
 * including retries and failures, is admitted before transport. The caller binds
 * purpose at its registered model/extraction/refresh/authoring boundary and saves
 * the original response in its existing recorder, never in a second usage store.
 * Drain after the public action/children settle, then seal the census. */
export function observeGroundedModelFetch(input: {
  scope: GroundedMeasurementScope;
  sourceRef: string;
  attemptId: string;
  provider: 'codex' | 'anthropic';
  purpose: GroundedModelUsage['purpose'];
  purposeRef: string;
  fetchImpl: typeof fetch;
  retainTape: (tape: { id: string; provider: 'codex' | 'anthropic'; raw: string; sha256: string }) => Promise<string | null>;
}) {
  const ids: string[] = [], rows: GroundedModelUsage[] = [];
  const jobs = new Set<Promise<void>>();
  let pending = 0, sealed = false, late = false;
  const observedFetch: typeof fetch = async (request, options) => {
    late ||= sealed;
    const id = `${input.attemptId}:model:${ids.length + 1}`;
    ids.push(id); pending++;
    const row: GroundedModelUsage = { id, purpose: input.purpose, purposeRef: input.purposeRef,
      usageRef: null, inputTokens: null, outputTokens: null };
    let response: Response;
    try { response = await input.fetchImpl(request, options); }
    catch (error) { rows.push(row); pending--; throw error; }
    // A clone preserves the caller's original body/stream and return behavior.
    // If cloning, parsing, or retention fails, this admitted request stays unknown.
    let copy: Response;
    try { copy = response.clone(); }
    catch { rows.push(row); pending--; return response; }
    const job = (async () => {
      try {
        const raw = await copy.text();
        const sha256 = createHash('sha256').update(raw, 'utf8').digest('hex');
        const ref = await input.retainTape({ id, provider: input.provider, raw, sha256 });
        if (!response.ok || !nonblank(ref)) return;
        const usage = await groundedFinalProviderUsage(input.provider, raw);
        if (!usage) return;
        row.usageRef = `${ref}#sha256=${sha256}`;
        row.inputTokens = usage.inputTokens; row.outputTokens = usage.outputTokens;
      } catch { /* Recorder/transport gaps are retained as unknown, never free usage. */ }
      finally { rows.push(row); pending--; }
    })();
    jobs.add(job);
    void job.finally(() => jobs.delete(job));
    return response;
  };
  return {
    fetch: observedFetch,
    drain: async () => { await Promise.all([...jobs]); },
    seal: (): GroundedCensus<GroundedModelUsage> => {
      sealed = true;
      return { scope: { ...input.scope }, sourceRef: input.sourceRef, complete: pending === 0 && !late,
        ids: [...ids], rows: rows.map(row => ({ ...row })) };
    },
  };
}

/** Validate terminal presence before invoking the existing target parsers: those
 * parsers also serve playback and may default an absent token field to zero. */
async function groundedFinalProviderUsage(provider: 'codex' | 'anthropic', raw: string) {
  const object = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const valid = (value: unknown) => {
    const usage = object(value);
    return usage && integer(usage.input_tokens) && integer(usage.output_tokens) ? usage : null;
  };
  let json: Record<string, unknown> | null = null;
  try { json = object(JSON.parse(raw)); } catch { /* SSE below. */ }
  if (provider === 'anthropic' && json?.type === 'message' && nonblank(json.stop_reason) && valid(json.usage)) {
    const parsed = parseClaudeResultEvent(json);
    return { inputTokens: parsed.tokensIn!, outputTokens: parsed.tokensOut! };
  }
  // The generic streaming parser may discard an unfinished last frame. A
  // retained partial tail cannot certify complete final usage.
  if (!/\r?\n\r?\n$/.test(raw)) return null;
  const events: Record<string, unknown>[] = [];
  for await (const event of parseSseStream(new Response(raw).body)) {
    if (event.data === '[DONE]') continue;
    // A malformed provider frame is missing capture, even if a later frame looks complete.
    const value = object(JSON.parse(event.data));
    if (!value) return null;
    events.push(value);
  }
  if (provider === 'codex') {
    const terminal = events.filter(event => event.type === 'response.completed');
    const completed = terminal.length === 1 ? object(terminal[0]!.response) : null;
    if (!completed || !valid(completed.usage) || events.at(-1) !== terminal[0]
      || events.some(event => ['error', 'response.failed', 'response.incomplete'].includes(String(event.type)))) return null;
    const parsed = parseCodexResponsesSse(raw);
    // The target's replay parser has narrower framing support. Never let its
    // fallback zeros replace a present, nonzero terminal count.
    const usage = object(completed.usage)!;
    if (parsed.inputTokens !== usage.input_tokens || parsed.outputTokens !== usage.output_tokens) return null;
    return { inputTokens: parsed.inputTokens, outputTokens: parsed.outputTokens };
  }
  const starts = events.filter(event => event.type === 'message_start');
  const deltas = events.filter(event => event.type === 'message_delta');
  const startUsage = starts.length === 1 ? object(object(starts[0]!.message)?.usage) : null;
  const finalUsage = deltas.length > 0 ? object(deltas.at(-1)!.usage) : null;
  if (events.filter(event => event.type === 'message_stop').length !== 1 || events.at(-1)?.type !== 'message_stop'
    || events.some(event => event.type === 'error')
    || !integer(startUsage?.input_tokens) || !integer(finalUsage?.output_tokens)) return null;
  const parsed = parseClaudeResultEvent({ usage: { ...startUsage, ...finalUsage } });
  if (!integer(parsed.tokensIn) || !integer(parsed.tokensOut)) return null;
  return { inputTokens: parsed.tokensIn!, outputTokens: parsed.tokensOut! };
}

/** Census projected schemas instead of an agent-authored changed-field list.
 * Unsupported validation and unclassified new mandatory text remain unknown.
 * Original snapshots are retained by the existing recorder at sourceRef. */
export function captureGroundedContractChanges(input: {
  scope: GroundedMeasurementScope; sourceRef: string;
  before: GroundedSchemaSnapshot; after: GroundedSchemaSnapshot;
}) {
  const gaps: string[] = [], rows: GroundedContractChange[] = [];
  const snapshots = [input.before, input.after];
  const sourceHashes = snapshots.map(snapshot => hash(snapshot));
  const kinds = ['input', 'result', 'authority', 'acceptance'] as const;
  const admittedKinds: Array<readonly (typeof kinds)[number][]> =
    snapshots.map(snapshot => snapshot.requiredKinds ?? ['input']);
  for (const [index, declared] of admittedKinds.entries()) {
    if (!declared.length || new Set(declared).size !== declared.length || declared.some(kind => !kinds.includes(kind)))
      gaps.push(`contracts:${index === 0 ? 'before' : 'after'}-invalid-channel-population`);
  }
  if (hash([...admittedKinds[0]!].sort()) !== hash([...admittedKinds[1]!].sort()))
    gaps.push('contracts:channel-population-changed');
  const maps = snapshots.map((snapshot, index) => {
    const map = new Map(snapshot.rows.map(row => [row.id, row]));
    if (!snapshot.complete || !nonblank(snapshot.sourceRef) || !nonblank(snapshot.sourceFingerprint)
      || map.size !== snapshot.rows.length || new Set(snapshot.ids).size !== snapshot.ids.length
      || snapshot.ids.length !== map.size || snapshot.ids.some(id => !nonblank(id) || !map.has(id)))
      gaps.push(`contracts:${index === 0 ? 'before' : 'after'}-recorder-population-mismatch`);
    return map;
  });
  if (input.after.sourceFingerprint !== input.scope.sourceFingerprint) gaps.push('contracts:foreign-current-source');
  const ids: string[] = [];
  const sourceMaps = snapshots.map((snapshot, index) => {
    const sources = snapshot.sourceFiles;
    const map = new Map(sources?.rows.map(row => [row.id, row]) ?? []);
    if (sources && (new Set(sources.ids).size !== sources.ids.length || map.size !== sources.rows.length
      || sources.ids.length !== map.size || sources.ids.some(id => !nonblank(id) || !map.has(id))
      || sources.rows.some(row => !nonblank(row.sourceRef) || typeof row.body !== 'string'
        || createHash('sha256').update(row.body, 'utf8').digest('hex') !== row.sha256)))
      gaps.push(`contracts:${index === 0 ? 'before' : 'after'}-source-population-mismatch`);
    return map;
  });
  if (Boolean(input.before.sourceFiles) !== Boolean(input.after.sourceFiles))
    gaps.push('contracts:source-census-missing');
  for (const target of [...new Set(snapshots.flatMap(snapshot => [...snapshot.sourceFiles?.ids ?? []]))].sort()) {
    const id = JSON.stringify([target, 'source']); ids.push(id);
    const before = sourceMaps[0]!.get(target), after = sourceMaps[1]!.get(target);
    if (!before || !after || before.body !== after.body) {
      gaps.push(`contracts:${id}:changed-or-missing-source-needs-exact-detector`);
      continue;
    }
    rows.push({ id, beforeRequiredPaths: [], afterRequiredPaths: [], beforeNarrativePaths: [], afterNarrativePaths: [] });
  }
  for (const target of [...new Set([...input.before.ids, ...input.after.ids])].sort()) {
    for (const kind of kinds) {
      const key = `${kind}Schema` as 'inputSchema' | 'resultSchema' | 'authoritySchema' | 'acceptanceSchema';
      if (!admittedKinds.some(declared => declared.includes(kind))
        && !maps.some(map => map.get(target)?.[key] !== undefined)) continue;
      const id = JSON.stringify([target, kind]);
      ids.push(id);
      try {
        const schemas = maps.map((map, index) => {
          const row = map.get(target);
          if (row && admittedKinds[index]!.includes(kind) && row[key] === undefined)
            throw new Error('missing admitted contract channel');
          return row?.[key] ?? {};
        });
        // Identical retained bytes prove no additions even for a schema whose
        // conditional semantics require a more specialized changed-path reader.
        if (hash(schemas[0]) === hash(schemas[1])) {
          rows.push({ id, beforeRequiredPaths: [], afterRequiredPaths: [],
            beforeNarrativePaths: [], afterNarrativePaths: [] });
          continue;
        }
        const before = groundedRequiredSchemaPaths(schemas[0]);
        const after = groundedRequiredSchemaPaths(schemas[1]);
        const changedStrings = [...after.strings].filter(([path, node]) => before.strings.get(path)?.hash !== node.hash);
        if (changedStrings.some(([, node]) => node.kind === 'unknown')) gaps.push(`contracts:${id}:unclassified-mandatory-text`);
        rows.push({ id, beforeRequiredPaths: [...before.paths].sort(), afterRequiredPaths: [...after.paths].sort(),
          beforeNarrativePaths: [...before.strings].filter(([, node]) => node.kind === 'narrative').map(([path]) => path).sort(),
          afterNarrativePaths: [...after.strings].filter(([, node]) => node.kind === 'narrative').map(([path]) => path).sort() });
      } catch { gaps.push(`contracts:${id}:unsupported-schema`); }
    }
  }
  const census: GroundedCensus<GroundedContractChange> = {
    scope: { ...input.scope }, sourceRef: input.sourceRef, complete: gaps.length === 0, ids, rows,
  };
  return { census, gaps, sourceHashes };
}

function groundedRequiredSchemaPaths(schema: unknown) {
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(schema)) throw new Error('missing schema');
  const root = schema, paths = new Set<string>();
  const strings = new Map<string, { hash: string; kind: 'narrative' | 'identifier' | 'unknown' }>();
  const segment = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1');
  const visit = (node: unknown, path: string, required: boolean, refs: readonly string[], depth: number) => {
    if (!object(node) || depth > 64) throw new Error('unsupported schema');
    if (['oneOf', 'anyOf', 'if', 'then', 'else', 'not', 'dependentRequired', 'dependentSchemas', 'dependencies',
      'patternProperties', 'minProperties', 'maxProperties', 'minItems', 'maxItems', 'contains', 'prefixItems',
      'propertyNames', 'unevaluatedProperties', 'unevaluatedItems']
      .some(key => key in node) || Array.isArray(node.type)) throw new Error('conditional schema needs an exact detector');
    if ('$ref' in node && typeof node.$ref !== 'string') throw new Error('invalid ref');
    if (required && !node.type && !node.$ref && !node.allOf && !node.enum && !('const' in node)) throw new Error('untyped required value');
    if (typeof node.$ref === 'string') {
      if (!node.$ref.startsWith('#/') || refs.includes(node.$ref)) throw new Error('unresolved or recursive ref');
      let target: unknown = root;
      for (const part of node.$ref.slice(2).split('/')) target = object(target) ? target[part.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined;
      visit(target, path, required, [...refs, node.$ref], depth + 1);
    }
    if (required && node.type === 'string') {
      const kind = 'const' in node || Array.isArray(node.enum)
        || ['uuid', 'uri', 'date-time', 'date', 'time', 'email', 'hostname', 'ipv4', 'ipv6'].includes(String(node.format)) ? 'identifier'
        : ['text/plain', 'text/markdown'].includes(String(node.contentMediaType)) ? 'narrative' : 'unknown';
      const value = { hash: hash(node), kind } as const;
      if (strings.has(path) && strings.get(path)!.hash !== value.hash) throw new Error('overlapping string constraints');
      strings.set(path, value);
    }
    if (node.required !== undefined && (!Array.isArray(node.required) || node.required.some(key => !nonblank(key))
      || new Set(node.required).size !== node.required.length)) throw new Error('invalid required set');
    const mandatory = new Set((node.required ?? []) as string[]);
    const properties = object(node.properties) ? node.properties : {};
    for (const key of mandatory) {
      if (!(key in properties)) throw new Error('required property without a schema');
      paths.add(`${path}/${segment(key)}`);
    }
    for (const [key, child] of Object.entries(properties)) visit(child, `${path}/${segment(key)}`, mandatory.has(key), refs, depth + 1);
    if (node.items !== undefined) visit(node.items, `${path}/[]`, required, refs, depth + 1);
    if (node.allOf !== undefined) {
      if (!Array.isArray(node.allOf)) throw new Error('invalid allOf');
      for (const child of node.allOf) visit(child, path, required, refs, depth + 1);
    }
  };
  visit(root, '', false, [], 0);
  return { paths, strings };
}

export function compareGroundedPairedCost(before: readonly (number | null)[], after: readonly (number | null)[]) {
  if (before.length !== 3 || after.length !== 3 || [...before, ...after].some(n => n === null || !Number.isFinite(n) || n < 0))
    return { verdict: 'unknown' as const, baselineMedian: null, candidateMedian: null };
  const median = (ns: readonly (number | null)[]): number => [...ns as readonly number[]].sort((a, b) => a - b)[1]!;
  const baselineMedian = median(before), candidateMedian = median(after);
  return { verdict: (baselineMedian === 0 ? candidateMedian === 0 : candidateMedian <= baselineMedian * fixture.budgets.pairedMedianRatioMaximum)
    ? 'pass' as const : 'fail' as const, baselineMedian, candidateMedian };
}
