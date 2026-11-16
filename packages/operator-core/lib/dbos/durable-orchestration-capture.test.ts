// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureDurableProcessBoundary, composeDurableCaptureCensus, createDurableCaptureRecorder, materializeDurableCapture, reconstructDurableCapture,
  retainDurableCapture } from '../../test/_durable-orchestration-capture';
import type { GroundedCensus, GroundedInvocation, GroundedMeasurementScope } from '../grounded-evidence-measurement';

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
