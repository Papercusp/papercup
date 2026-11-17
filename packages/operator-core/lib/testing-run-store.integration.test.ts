import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { withNativeProofLedger } from '../test/isolated-integration-proof';
import { canonicalJson } from '@papercusp/hash-chain';
import { captureConfigurationSnapshot } from '@papercusp/test-config/configuration-snapshot';
import type { OrgTestDb } from '../test/_org-test-db';
import { getRunAsync, TestingRunSnapshotUnavailableError, persistHarnessTestRunsWithIds,
  insertDocumentationRunInput, readDocumentationRunInput, persistRunSnapshot, prunePersistedRunSnapshots,
  nativeProofFingerprint, reserveNativeProofRun, readNativeProofRun, appendNativeProofEvent, executeNativeProofOnce,
  executeNativeProofChildOnce, enterNativeProofChild, type NativeProofChildHandoff,
  type NativeProofInput, type NativeProofAdmission,
  type DocumentationRunInput, type RunSnapshot } from './testing-run-store';
import { executeOperationalRun } from './agent-tools/testing/record-run';
import { parseTestRunExecutionDetails, stableRecordedRuntimeEnvironment } from '@papercusp/test-config/execution-details';
import { configureRuntimeVintageStore, resetRuntimeVintageStore, InMemoryRuntimeVintageStore,
  reportRuntimeVintage, listRuntimeVintage, measureRuntimeVintageEnvironment } from './runtime-vintage';

const { createOrgTestDb } = await import('../test/_org-test-db');

describe('[plan:language-neutral-code-documentation-integration-2026-11-12] [R-12] immutable documentation input (real PG)', () => {
  let db: OrgTestDb;
  const storeSql = () => db.adminSql as unknown as Parameters<typeof insertDocumentationRunInput>[0];
  beforeAll(async () => {
    db = await createOrgTestDb();
    // Exercise the allocator's draft in an isolated database before arming it.
    // After arming, the normal fixture migration runner supplies this column;
    // replay also checks that the migration remains idempotent.
    const armed = new URL('../../../libs/papercusp/libs/db/sql/1640-documentation-run-input.sql', import.meta.url);
    const draft = new URL(armed.href + '.DRAFT');
    await db.adminSql.unsafe(readFileSync(existsSync(armed) ? armed : draft, 'utf8'));
  }, 120_000);
  afterAll(async () => { await db?.cleanup(); });
  const input = (): DocumentationRunInput => ({
    runId: randomUUID(), taskId: null, startedAt: 1_700_000_000_000,
    kind: 'node', label: 'documentation input', filePath: null,
    command: ['node', 'verify.mjs'], requestedFiles: [], cwd: '/fixture',
    source: { commit: 'a'.repeat(40), porcelain: '' },
    configuration: captureConfigurationSnapshot({ NODE_ENV: 'production' }),
  });
  const snapshot = (value: DocumentationRunInput): RunSnapshot => ({
    runId: value.runId, kind: value.kind, label: value.label,
    command: [...value.command], startedAt: value.startedAt,
    status: 'running', exitCode: null, finishedAt: null, output: '', truncated: false,
  });
  const read = async (runId: string) => (await db.adminSql`
    SELECT * FROM harness_shared.testing_run_snapshots WHERE run_id = ${runId}
  `)[0];

  it('[baseline] [pair:transaction] retains a canonical digest across JSONB key ordering', async () => {
    const value = input();
    await db.adminSql.begin(async tx => {
      await insertDocumentationRunInput(tx as unknown as Parameters<typeof insertDocumentationRunInput>[0], value);
    });
    const row = await read(value.runId);
    expect(row.documentation_input.input).toEqual(value);
    expect(row.documentation_input.inputSha256).toBe(createHash('sha256').update(canonicalJson(value)).digest('hex'));
    expect(createHash('sha256').update(canonicalJson(row.documentation_input.input)).digest('hex'))
      .toBe(row.documentation_input.inputSha256);
    await expect(readDocumentationRunInput(storeSql(), value.runId)).resolves.toEqual({ status: 'found',
      input: value, inputSha256: row.documentation_input.inputSha256 });
  });

  it('[falsifier] [pair:transaction] leaves no input row when its owning transaction rolls back', async () => {
    const value = input();
    await expect(db.adminSql.begin(async tx => {
      await insertDocumentationRunInput(tx as unknown as Parameters<typeof insertDocumentationRunInput>[0], value);
      throw new Error('capture transaction rolled back');
    })).rejects.toThrow('capture transaction rolled back');
    expect(await read(value.runId)).toBeUndefined();
    await expect(readDocumentationRunInput(storeSql(), value.runId)).resolves.toEqual({ status: 'absent' });
  });

  const mutations = [
    ['command', `command = '["node","rewrite"]'::jsonb`],
    ['start', "started_at = started_at + interval '1 second'"],
    ['task', "task_id = 'different-task'"],
    ['kind', "kind = 'shell'"],
    ['label', "label = 'different label'"],
    ['file', "file_path = 'different.test.ts'"],
    ['run', "run_id = run_id || '-rewrite'"],
    ['input', 'documentation_input = NULL'],
  ] as const;
  it.each(mutations)('[baseline] [pair:immutable-%s] advances lifecycle with input unchanged', async () => {
    const value = input();
    await insertDocumentationRunInput(storeSql(), value);
    const before = await read(value.runId);
    await expect(persistRunSnapshot({ ...snapshot(value), status: 'pass', exitCode: 0,
      finishedAt: value.startedAt + 1000, output: 'observed pass' }, storeSql())).resolves.toBe(true);
    const after = await read(value.runId);
    expect(after).toMatchObject({ status: 'pass', output: 'observed pass', exit_code: 0 });
    expect(after.documentation_input).toEqual(before.documentation_input);
    expect(after.started_at).toEqual(before.started_at);
    expect(after.command).toEqual(before.command);
  });
  it.each(mutations)('[falsifier] [pair:immutable-%s] rejects input reinterpretation', async (_name, mutation) => {
    const value = input();
    await insertDocumentationRunInput(storeSql(), value);
    const before = await read(value.runId);
    await expect(db.adminSql.unsafe(`UPDATE harness_shared.testing_run_snapshots SET ${mutation} WHERE run_id = $1`, [value.runId]))
      .rejects.toMatchObject({ code: '23514' });
    expect(await read(value.runId)).toEqual(before);
  });

  it('[baseline] [pair:late-promotion] preserves ordinary snapshot upsert behavior', async () => {
    const value = input();
    await expect(persistRunSnapshot(snapshot(value), storeSql())).resolves.toBe(true);
    await expect(persistRunSnapshot({ ...snapshot(value), command: ['node', 'ordinary-update.mjs'],
      startedAt: value.startedAt + 1000 }, storeSql())).resolves.toBe(true);
    const row = await read(value.runId);
    expect(row.documentation_input).toBeNull();
    expect(row.command).toEqual(['node', 'ordinary-update.mjs']);
  });
  it('[falsifier] [pair:late-promotion] refuses to promote an existing ordinary row or replay an input insert', async () => {
    const value = input();
    await persistRunSnapshot(snapshot(value), storeSql());
    await expect(db.adminSql`UPDATE harness_shared.testing_run_snapshots
      SET documentation_input = ${JSON.stringify({ schemaVersion: 1, input: value, inputSha256: 'a'.repeat(64) })}::jsonb
      WHERE run_id = ${value.runId}`).rejects.toMatchObject({ code: '23514' });
    await expect(insertDocumentationRunInput(storeSql(), value)).rejects.toMatchObject({ code: '23505' });
    const row = await read(value.runId);
    expect(row.documentation_input).toBeNull();
  });

  it('[baseline] [pair:retention] prunes an expired ordinary snapshot', async () => {
    const value = input();
    await persistRunSnapshot({ ...snapshot(value), status: 'pass', exitCode: 0,
      finishedAt: value.startedAt + 1000 }, storeSql());
    expect(await read(value.runId)).toBeDefined();
    await prunePersistedRunSnapshots(storeSql());
    expect(await read(value.runId)).toBeUndefined();
  });
  it('[falsifier] [pair:retention] retains documentation input beyond transient snapshot expiry', async () => {
    const value = input();
    await insertDocumentationRunInput(storeSql(), value);
    await persistRunSnapshot({ ...snapshot(value), status: 'pass', exitCode: 0,
      finishedAt: value.startedAt + 1000 }, storeSql());
    const before = await read(value.runId);
    await prunePersistedRunSnapshots(storeSql());
    expect(await read(value.runId)).toEqual(before);
  });
});

describe('P010 native proof admission on the existing run ledger (real PG)', () => {
  let db: OrgTestDb;
  const sql = () => db.adminSql as unknown as Parameters<typeof executeNativeProofOnce>[0];
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const childEntry = 'packages/operator-core/test/native-proof-successor.mts';
  const childSha = () => createHash('sha256').update(readFileSync(new URL('../test/native-proof-successor.mts', import.meta.url))).digest('hex');
  const kinds = ['installed', 'built', 'runtime', 'trace', 'sealed', 'readback'] as const;
  const input = (): NativeProofInput => ({
    schemaVersion: 1,
    scope: { workspaceId: 'native-proof-fixture', harnessSlug: 'fixture', planSlug: randomUUID() },
    original: { sourceSha: 'a'.repeat(40), fixtureSha256: hash('fixture'), captureSha256: hash('capture'),
      sourceDigests: { 'adapter-a.ts': hash('original a'), 'adapter-b.ts': hash('original b') },
      dependenciesReconstructed: false },
    prerequisiteSources: { 'harness.ts': hash('harness'), 'installer.mjs': hash('installer'), [childEntry]: childSha() },
    method: { sha256: hash('method'), configurationSha256: hash('configuration'),
      clientMatrix: ['mcp:text', 'ptool:text'] },
    selectedInputs: { 'package.json': hash('manifest'), 'package-lock.json': hash('original lock'), '.npmrc': null },
    plannedRepair: { lockSha256: hash('repaired lock'), packageDeltaSha256: hash('delta'),
      candidateGraphSha256: hash('complete graph') },
    toolchain: { npmSha256: hash('npm executable'), npmVersion: '11.19.0', nodeVersion: '25.9.0', nativeAbi: '141' },
  });
  const admission = (value: NativeProofInput): NativeProofAdmission => ({
    reviewedFingerprint: nativeProofFingerprint(value).fingerprint,
    reviewRef: 'review:independent-method-fixture', preflightRefs: {
      numericFold: 'test_runs:numeric', physicalInstall: 'test_runs:physical', priorFailureAudit: 'audit:pre-run' },
  });
  beforeAll(async () => {
    db = await createOrgTestDb();
    for (const name of ['1641-native-proof-run-input', '1642-native-proof-child-launch']) {
      const armed = new URL('../../../libs/papercusp/libs/db/sql/' + name + '.sql', import.meta.url);
      const migration = readFileSync(existsSync(armed) ? armed : new URL(armed.href + '.DRAFT'), 'utf8');
      await db.adminSql.unsafe(migration);
      await db.adminSql.unsafe(migration); // prove replay before arming
    }
  }, 120_000);
  afterAll(async () => { await db?.cleanup(); });

  const built = async () => {
    const value = input();
    return executeNativeProofOnce(sql(), value, admission(value), async intent => {
      for (const kind of ['installed', 'built'] as const) intent = await appendNativeProofEvent(sql(),
        intent.runId, intent.fingerprint, intent.events.length,
        { kind, receiptRef: 'retained:' + kind, receiptSha256: hash(kind) });
      return intent;
    });
  };
  async function successor(message: object) {
    return new Promise<{ code: number | null; messages: Array<{ effect?: string; error?: string; pid: number }> }>((resolve, reject) => {
      const child = fork(fileURLToPath(new URL('../test/native-proof-successor.mts', import.meta.url)), [], {
        execArgv: ['--import', 'tsx/esm'], timeout: 60_000,
        env: { ...process.env, PAPERCUSP_TEST_RUNS_DB_URL: db.adminDsn }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      const messages: Array<{ effect?: string; error?: string; pid: number }> = [];
      let diagnostics = '';
      child.stdout?.on('data', chunk => { diagnostics += chunk; });
      child.stderr?.on('data', chunk => { diagnostics += chunk; });
      child.on('message', value => { messages.push(value as typeof messages[number]); });
      child.on('error', reject);
      child.on('close', code => {
        if (messages.length === 0) reject(new Error('Native successor produced no receipt: ' + diagnostics));
        else resolve({ code, messages });
      });
      child.send(message);
    });
  }

  it('commits exactly one fork authorization and one child start on the original built intent', async () => {
    const intent = await built();
    const forks: NativeProofChildHandoff[] = [];
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => executeNativeProofChildOnce(sql(),
      intent.runId, intent.fingerprint, childEntry, async handoff => {
        expect((await readNativeProofRun(sql(), intent.runId))!.childLaunch?.state).toBe('authorized');
        forks.push(handoff);
      })));
    expect(attempts.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    expect(forks).toHaveLength(1);
    let effects = 0;
    const children = await Promise.allSettled(Array.from({ length: 8 }, () => enterNativeProofChild(sql(),
      forks[0]!, childEntry, childSha(), async started => {
        expect((await readNativeProofRun(sql(), intent.runId))!.childLaunch?.state).toBe('started');
        expect(started.fingerprint).toBe(intent.fingerprint); effects++;
      })));
    expect(children.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    expect(effects).toBe(1);
    expect((await readNativeProofRun(sql(), intent.runId))!.input).toEqual(intent.input);
  });

  it('uses the explicit shared ledger and canonical JSON parameters despite a separate product database pin', async () => {
    const intent = await built();
    await withNativeProofLedger({ PAPERCUSP_TEST_RUNS_DB_URL: db.adminDsn,
      HARNESS_ADMIN_DATABASE_URL: 'postgresql://127.0.0.1:1/disposable-product' }, async ledger => {
      expect(await readNativeProofRun(ledger, intent.runId)).toEqual(intent);
      const rows = await ledger`SELECT jsonb_typeof(${JSON.stringify({ nativeProof: true })}::jsonb) AS parameter_type`;
      expect(rows).toEqual([{ parameter_type: 'object' }]);
      await executeNativeProofChildOnce(ledger, intent.runId, intent.fingerprint, childEntry, async handoff => {
        await enterNativeProofChild(ledger, handoff, childEntry, childSha(), async started => {
          expect(started.runId).toBe(intent.runId);
          expect((await readNativeProofRun(sql(), intent.runId))!.childLaunch?.state).toBe('started');
        });
      });
    });
  });

  it('consumes a serialized handoff in a fresh child and refuses replay in another fresh process', async () => {
    const intent = await built();
    await executeNativeProofChildOnce(sql(), intent.runId, intent.fingerprint, childEntry, async handoff => {
      const first = await successor({ mode: 'child', handoff });
      expect(first.code, JSON.stringify(first)).toBe(0);
      expect(first.messages).toEqual([{ effect: intent.runId, pid: expect.any(Number), parameterType: 'object' }]);
      expect(first.messages[0]!.pid).not.toBe(process.pid);
      const replay = await successor({ mode: 'child', handoff });
      expect(replay.code).toBe(2);
      expect(replay.messages).toEqual([{ error: expect.stringContaining('consumed'), pid: expect.any(Number) }]);
    });
    const parentReplay = await successor({ mode: 'parent', input: intent.input, admission: intent.admission });
    expect(parentReplay.code).toBe(2);
    expect(parentReplay.messages[0]!.error).toContain('already consumed');
  }, 120_000);

  it.each(['before-fork', 'after-child-start'])('retains unknown %s custody without another fork', async phase => {
    const intent = await built();
    let handoff: NativeProofChildHandoff | undefined;
    await expect(executeNativeProofChildOnce(sql(), intent.runId, intent.fingerprint, childEntry, async value => {
      handoff = value;
      if (phase === 'after-child-start') await enterNativeProofChild(sql(), value, childEntry, childSha(), async () => {
        throw new Error('crash after child start');
      });
      throw new Error('crash before fork');
    })).rejects.toThrow('crash');
    const retained = await readNativeProofRun(sql(), intent.runId);
    expect(retained!.childLaunch?.state).toBe(phase === 'before-fork' ? 'authorized' : 'started');
    let effects = 0;
    await expect(executeNativeProofChildOnce(sql(), intent.runId, intent.fingerprint, childEntry, async () => { effects++; }))
      .rejects.toThrow('already authorized');
    if (phase === 'after-child-start') await expect(enterNativeProofChild(sql(), handoff!, childEntry, childSha(), async () => { effects++; }))
      .rejects.toThrow('consumed');
    expect(effects).toBe(0);
    expect(await readNativeProofRun(sql(), intent.runId)).toEqual(retained);
  });

  it('refuses missing preparation or substituted entry point before any child effect', async () => {
    const value = input();
    const reserved = await reserveNativeProofRun(sql(), value, admission(value));
    let effects = 0;
    await expect(executeNativeProofChildOnce(sql(), reserved.runId, reserved.fingerprint, childEntry, async () => { effects++; }))
      .rejects.toThrow('built intent');
    const intent = await built();
    await executeNativeProofChildOnce(sql(), intent.runId, intent.fingerprint, childEntry, async handoff => {
      for (const changed of [{ ...handoff, fingerprint: hash('other edition') },
        { ...handoff, entryPoint: 'other-child.mts' }, { ...handoff, entryPointSha256: hash('substituted child') }])
        await expect(enterNativeProofChild(sql(), changed, childEntry, childSha(), async () => { effects++; })).rejects.toThrow();
      await expect(appendNativeProofEvent(sql(), intent.runId, intent.fingerprint, 4,
        { kind: 'runtime', receiptRef: 'runtime', receiptSha256: hash('runtime') })).rejects.toMatchObject({ code: '23514' });
      expect((await readNativeProofRun(sql(), intent.runId))!.childLaunch?.state).toBe('authorized');
    });
    expect(effects).toBe(0);
  });

  it.each(['clear', 'entry', 'digest', 'edition', 'state'])('rejects %s child-custody tampering in PostgreSQL', async mutation => {
    const intent = await built();
    await executeNativeProofChildOnce(sql(), intent.runId, intent.fingerprint, childEntry, async handoff => {
      await enterNativeProofChild(sql(), handoff, childEntry, childSha(), async () => {});
    });
    const retained = await readNativeProofRun(sql(), intent.runId);
    const changed = mutation === 'clear' ? null : { ...retained!.childLaunch,
      ...(mutation === 'entry' ? { entryPoint: 'other.mts' } : {}),
      ...(mutation === 'digest' ? { entryPointSha256: hash('other') } : {}),
      ...(mutation === 'edition' ? { fingerprint: hash('other') } : {}),
      ...(mutation === 'state' ? { state: 'authorized' } : {}) };
    await expect(db.adminSql`UPDATE harness_shared.testing_run_snapshots SET native_proof_child_launch =
      ${JSON.stringify(changed)}::jsonb WHERE run_id = ${intent.runId}`).rejects.toMatchObject({ code: '23514' });
    expect(await readNativeProofRun(sql(), intent.runId)).toEqual(retained);
  });

  it('races independent continuations before the entire allocation/prepare/execute closure', async () => {
    const value = input();
    const effects: string[] = [];
    const launch = () => executeNativeProofOnce(sql(), value, admission(value), async intent => {
      const durable = await readNativeProofRun(sql(), intent.runId);
      expect(durable!.events.map(event => event.kind)).toEqual(['reserved', 'started']);
      effects.push('allocate', 'prepare', 'execute');
    });
    const results = await Promise.allSettled(Array.from({ length: 8 }, launch));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(effects).toEqual(['allocate', 'prepare', 'execute']);
    const runId = 'native-proof-' + nativeProofFingerprint(value).fingerprint;
    expect((await readNativeProofRun(sql(), runId))!.events).toHaveLength(2);
  });

  it('resumes the serialized unstarted original reservation exactly once', async () => {
    const value = input();
    const reserved = await reserveNativeProofRun(sql(), value, admission(value));
    const successor = JSON.parse(JSON.stringify({ input: value, admission: admission(value), runId: reserved.runId }));
    let starts = 0;
    await executeNativeProofOnce(sql(), successor.input, successor.admission, async intent => {
      expect(intent.runId).toBe(successor.runId); starts++;
    });
    await expect(executeNativeProofOnce(sql(), successor.input, successor.admission, async () => { starts++; }))
      .rejects.toThrow('already consumed');
    expect(starts).toBe(1);
  });

  it('refuses an uncommitted transaction client before entering any protected effect', async () => {
    const value = input();
    let effects = 0;
    await db.adminSql.begin(async tx => {
      await expect(executeNativeProofOnce(tx as unknown as Parameters<typeof executeNativeProofOnce>[0],
        value, admission(value), async () => { effects++; })).rejects.toThrow('committing ledger pool');
    });
    expect(effects).toBe(0);
    expect(await readNativeProofRun(sql(), 'native-proof-' + nativeProofFingerprint(value).fingerprint)).toBeNull();
  });

  it.each([0, 1, 2, 3, 4, 5, 6])('keeps interrupted started custody after %i observations without a replacement launch', async count => {
    const value = input();
    let intent = await reserveNativeProofRun(sql(), value, admission(value));
    intent = await appendNativeProofEvent(sql(), intent.runId, intent.fingerprint, 1, { kind: 'started' });
    for (const kind of kinds.slice(0, count)) intent = await appendNativeProofEvent(sql(), intent.runId,
      intent.fingerprint, intent.events.length, { kind, receiptRef: 'retained:' + kind,
        receiptSha256: hash(kind === 'readback' ? 'sealed' : kind) });
    const serialized = JSON.parse(JSON.stringify(intent));
    expect(await readNativeProofRun(sql(), serialized.runId)).toEqual(serialized);
    let effects = 0;
    await expect(executeNativeProofOnce(sql(), serialized.input, serialized.admission, async () => { effects++; }))
      .rejects.toThrow('already consumed');
    expect(effects).toBe(0);
    expect(await readNativeProofRun(sql(), intent.runId)).toEqual(intent);
  });

  it('retains a committed start when the protected closure fails before its first observation', async () => {
    const value = input();
    await expect(executeNativeProofOnce(sql(), value, admission(value), async () => {
      throw new Error('crash before observation');
    })).rejects.toThrow('crash before observation');
    const intent = await reserveNativeProofRun(sql(), value, admission(value));
    expect(intent.events.map(event => event.kind)).toEqual(['reserved', 'started']);
    await expect(executeNativeProofOnce(sql(), value, admission(value), async () => {}))
      .rejects.toThrow('already consumed');
  });

  it('canonicalizes map and client permutations; cosmetic review changes retain the original intent', async () => {
    const value = input();
    const permuted = structuredClone(value);
    permuted.method.clientMatrix.reverse();
    permuted.selectedInputs = Object.fromEntries(Object.entries(permuted.selectedInputs).reverse());
    permuted.original.sourceDigests = Object.fromEntries(Object.entries(permuted.original.sourceDigests).reverse());
    expect(nativeProofFingerprint(permuted)).toEqual(nativeProofFingerprint(value));
    const first = await reserveNativeProofRun(sql(), value, admission(value));
    const cosmetic = { ...admission(permuted), reviewRef: 'review:cosmetic-label-only' };
    expect(await reserveNativeProofRun(sql(), permuted, cosmetic)).toEqual(first);
  });

  it.each(['original', 'prerequisiteSources', 'method', 'selectedInputs', 'plannedRepair', 'toolchain'])
    ('refuses a missing prelaunch %s before any protected effect', async key => {
      const value = input();
      const reviewed = admission(value);
      delete (value as unknown as Record<string, unknown>)[key];
      let effects = 0;
      await expect(executeNativeProofOnce(sql(), value, reviewed, async () => { effects++; })).rejects.toThrow();
      expect(effects).toBe(0);
    });

  it.each(['runId', 'runtimeLabel', 'port', 'attempt', 'installedTreeSha256', 'servedRuntimeSha256'])
    ('refuses attempt-local or later-observed field %s instead of minting a new edition', async key => {
      const value = input();
      const reviewed = admission(value);
      Object.assign(value, { [key]: 'pending-or-label' });
      let effects = 0;
      await expect(executeNativeProofOnce(sql(), value, reviewed, async () => { effects++; })).rejects.toThrow();
      expect(effects).toBe(0);
    });

  it('requires a content-changed edition to have its own matching review', async () => {
    const value = input();
    const reviewed = admission(value);
    const changed = structuredClone(value);
    changed.plannedRepair.lockSha256 = hash('different lock');
    expect(nativeProofFingerprint(changed).fingerprint).not.toBe(reviewed.reviewedFingerprint);
    let effects = 0;
    await expect(executeNativeProofOnce(sql(), changed, reviewed, async () => { effects++; }))
      .rejects.toThrow('not the reviewed edition');
    expect(effects).toBe(0);
  });

  it('appends pending install/build/runtime/trace observations to the same intent without rekeying', async () => {
    const value = input();
    let intent = await reserveNativeProofRun(sql(), value, admission(value));
    const original = structuredClone(intent);
    intent = await appendNativeProofEvent(sql(), intent.runId, intent.fingerprint, 1, { kind: 'started' });
    for (const kind of kinds) {
      intent = await appendNativeProofEvent(sql(), intent.runId, intent.fingerprint, intent.events.length,
        { kind, receiptRef: 'retained:' + kind, receiptSha256: hash(kind === 'readback' ? 'sealed' : kind) });
      expect(intent.runId).toBe(original.runId);
      expect(intent.fingerprint).toBe(original.fingerprint);
      expect(intent.input).toEqual(original.input);
      expect(await readNativeProofRun(sql(), intent.runId)).toEqual(intent);
    }
    expect(intent.events.map(event => event.kind)).toEqual(['reserved', 'started', ...kinds]);
  });

  it('refuses reordered, missing, stale and detached observations without dropping prior custody', async () => {
    const value = input();
    let intent = await reserveNativeProofRun(sql(), value, admission(value));
    intent = await appendNativeProofEvent(sql(), intent.runId, intent.fingerprint, 1, { kind: 'started' });
    const receipt = { receiptRef: 'retained:installed', receiptSha256: hash('installed') };
    await expect(appendNativeProofEvent(sql(), intent.runId, intent.fingerprint, 2, { kind: 'built', ...receipt }))
      .rejects.toThrow('event order');
    await expect(appendNativeProofEvent(sql(), intent.runId, intent.fingerprint, 2, { kind: 'installed' }))
      .rejects.toThrow('complete retained receipt');
    await expect(appendNativeProofEvent(sql(), intent.runId, hash('other edition'), 2, { kind: 'installed', ...receipt }))
      .rejects.toThrow('already consumed');
    intent = await appendNativeProofEvent(sql(), intent.runId, intent.fingerprint, 2, { kind: 'installed', ...receipt });
    await expect(appendNativeProofEvent(sql(), intent.runId, intent.fingerprint, 2, { kind: 'installed', ...receipt }))
      .rejects.toThrow('already consumed');
    expect(await readNativeProofRun(sql(), intent.runId)).toEqual(intent);
  });

  it.each(['input', 'events', 'reorder', 'detach', 'replay-start', 'delete'])
    ('enforces %s custody in PostgreSQL even when a caller bypasses the helper', async mutation => {
      const value = input();
      let intent = await reserveNativeProofRun(sql(), value, admission(value));
      intent = await appendNativeProofEvent(sql(), intent.runId, intent.fingerprint, 1, { kind: 'started' });
      const changed = structuredClone(intent.events);
      if (mutation === 'events') changed[0]!.kind = 'started';
      if (mutation === 'reorder') changed.push({ kind: 'built', fingerprint: intent.fingerprint,
        receiptRef: 'retained:built', receiptSha256: hash('built') });
      if (mutation === 'detach') changed.push({ kind: 'installed', fingerprint: hash('detached'),
        receiptRef: 'retained:installed', receiptSha256: hash('installed') });
      if (mutation === 'replay-start') changed.push({ kind: 'started', fingerprint: intent.fingerprint });
      const query = mutation === 'delete'
        ? db.adminSql`DELETE FROM harness_shared.testing_run_snapshots WHERE run_id = ${intent.runId}`
        : mutation === 'input'
          ? db.adminSql`UPDATE harness_shared.testing_run_snapshots SET native_proof_input = NULL WHERE run_id = ${intent.runId}`
          : db.adminSql`UPDATE harness_shared.testing_run_snapshots SET native_proof_events = ${JSON.stringify(changed)}::jsonb
              WHERE run_id = ${intent.runId}`;
      await expect(query).rejects.toMatchObject({ code: '23514' });
      expect(await readNativeProofRun(sql(), intent.runId)).toEqual(intent);
    });

  it('retains the complete original intent across ordinary snapshot expiry', async () => {
    const value = input();
    const intent = await reserveNativeProofRun(sql(), value, admission(value));
    await db.adminSql`UPDATE harness_shared.testing_run_snapshots
      SET finished_at = now() - interval '2 hours', status = 'error' WHERE run_id = ${intent.runId}`;
    await prunePersistedRunSnapshots(sql());
    expect(await readNativeProofRun(sql(), intent.runId)).toEqual(intent);
  });

  it('rejects a substituted seal readback digest and retains the unqualified sealed original', async () => {
    const value = input();
    let intent = await reserveNativeProofRun(sql(), value, admission(value));
    intent = await appendNativeProofEvent(sql(), intent.runId, intent.fingerprint, 1, { kind: 'started' });
    for (const kind of kinds.filter(kind => kind !== 'readback')) intent = await appendNativeProofEvent(sql(),
      intent.runId, intent.fingerprint, intent.events.length,
      { kind, receiptRef: 'retained:' + kind, receiptSha256: hash(kind) });
    await expect(appendNativeProofEvent(sql(), intent.runId, intent.fingerprint, 7,
      { kind: 'readback', receiptRef: 'retained:readback', receiptSha256: hash('substituted seal') }))
      .rejects.toMatchObject({ code: '23514' });
    expect(await readNativeProofRun(sql(), intent.runId)).toEqual(intent);
  });
});

describe('foreground evidence recovery (real PG)', () => {
  let db: OrgTestDb;
  // postgres.js `Sql` is not structurally assignable to the store's narrower tagged-template
  // `SqlLike` parameter (its call signature's values are `ParameterOrFragment`, not `unknown`),
  // so pass the real-PG client through the store's own declared parameter type.
  const storeSql = () => db.adminSql as unknown as NonNullable<Parameters<typeof getRunAsync>[1]>;
  const scope = { workspaceId: 'foreground-workspace', harnessSlug: 'foreground-harness', root: '/fixture' };
  const runId = 'foreground-origin';

  beforeAll(async () => { db = await createOrgTestDb(); }, 120_000);
  afterAll(async () => { await db?.cleanup(); });
  beforeEach(async () => {
    await db.adminSql`DELETE FROM harness_shared.task_ledger`;
  });

  async function insertTask(input: {
    taskId?: string; state?: string; workspace?: string; harness?: string; root?: string;
    launchedBy?: string; foreground?: boolean;
  } = {}) {
    const taskId = input.taskId ?? 'foreground-task';
    await db.adminSql`
      INSERT INTO harness_shared.task_ledger (
        task_id, root_task_id, workspace_id, harness_slug, cwd, class, title, argv, launched_by, state, detail
      ) VALUES (
        ${taskId}, ${taskId}, ${input.workspace ?? scope.workspaceId}, ${input.harness ?? scope.harnessSlug},
        ${input.root ?? scope.root}, 'test-run', 'foreground test', ${db.adminSql.json(['node', 'scripts/test-files.mjs'])},
        ${input.launchedBy ?? `testing:run:${runId}`}, ${input.state ?? 'running'},
        ${db.adminSql.json({ runGroup: runId, foreground: input.foreground ?? true })}
      )
    `;
  }

  it.each(['pending', 'running'])('preserves a %s foreground task with no snapshot', async state => {
    await insertTask({ state });
    await expect(getRunAsync(runId, storeSql(), scope)).resolves.toMatchObject({
      runId, taskId: 'foreground-task', status: 'running', finishedAt: null, exitCode: null,
    });
  });

  it.each([
    { workspace: 'other-workspace' }, { harness: 'other-harness' }, { root: '/other-root' },
    { launchedBy: 'testing:run:other-origin' }, { foreground: false },
  ])('does not use a task outside the exact origin scope: %j', async input => {
    await insertTask(input);
    const positive = await db.adminSql`SELECT task_id FROM harness_shared.task_ledger WHERE task_id = 'foreground-task'`;
    expect(positive).toHaveLength(1);
    await expect(getRunAsync(runId, storeSql(), scope)).resolves.toBeNull();
  });

  it('keeps an ambiguous foreground identity unknown', async () => {
    await insertTask();
    await insertTask({ taskId: 'other-foreground-task' });
    await expect(getRunAsync(runId, storeSql(), scope)).rejects.toBeInstanceOf(TestingRunSnapshotUnavailableError);
  });

  it('does not use a stranded process as evidence that the whole task ended', async () => {
    await insertTask({ state: 'stranded' });
    await expect(getRunAsync(runId, storeSql(), scope)).rejects.toBeInstanceOf(TestingRunSnapshotUnavailableError);
  });

  it('does not turn an ended foreground task into a passing test', async () => {
    await insertTask({ state: 'ended_unobserved' });
    await expect(getRunAsync(runId, storeSql(), scope)).resolves.toBeNull();
  });
});

describe('native operational execution provenance (real PG and kernel)', () => {
  let db: OrgTestDb;
  const workspaceId = 'operational-workspace';
  beforeAll(async () => { db = await createOrgTestDb(); }, 120_000);
  afterAll(async () => { await db?.cleanup(); });
  beforeEach(() => configureRuntimeVintageStore(new InMemoryRuntimeVintageStore()));
  afterEach(() => resetRuntimeVintageStore());

  it.each([false, true])('persists actual runtime observations; source drift=%s remains distinguishable', async drift => {
    await reportRuntimeVintage({ workspaceId, unit: 'native-check-runtime',
      treeSha: 'a'.repeat(40), pid: process.pid });
    const result = await executeOperationalRun({
      filePath: 'lib/testing-run-store.integration.test.ts', name: 'measured operational check',
      command: ['executeGreenMainAdmissionWindow', workspaceId, 'original-install',
        '1791000000000', '1791604800000'], framework: 'operational',
      runtimeUnits: ['native-check-runtime'],
      run: async () => {
        if (drift) await reportRuntimeVintage({ workspaceId, unit: 'native-check-runtime',
          treeSha: 'b'.repeat(40), pid: process.pid });
        return { exitCode: 0, summary: 'Measured actual runtime.',
          assertions: [{ id: 'kernel-runtime-observed', passed: true, evidence: 'Current test process observed.' }] };
      },
    }, { workspaceId, harnessSlug: 'operational-harness', projectDir: process.cwd() }, {
      snapshot: () => ({ commit: 'a'.repeat(40), porcelain: '' }),
      verifyDefinition: async () => true,
      readRuntime: async (units, workspace) => measureRuntimeVintageEnvironment(await listRuntimeVintage(workspace), units),
      persist: params => persistHarnessTestRunsWithIds({ ...params,
        sql: db.adminSql as unknown as NonNullable<Parameters<typeof persistHarnessTestRunsWithIds>[0]['sql']> }),
    });
    expect(result.ok).toBe(true);
    const [row] = await db.adminSql`SELECT workspace_id, harness_slug, execution_details
      FROM harness_shared.test_runs WHERE id = ${result.testRunIds![0]}`;
    expect(row.workspace_id).toBe(workspaceId);
    expect(row.harness_slug).toBe('operational-harness');
    const execution = parseTestRunExecutionDetails(row.execution_details);
    expect(execution).toMatchObject({ passed: 1, failed: 0, worktreeDirty: false,
      operational: { schemaVersion: 1, command: ['executeGreenMainAdmissionWindow',
        workspaceId, 'original-install', '1791000000000', '1791604800000'] } });
    expect(execution?.runtimeEnvironmentBefore).toBeDefined();
    expect(execution?.runtimeEnvironmentAfter).toBeDefined();
    expect(Boolean(stableRecordedRuntimeEnvironment(execution?.runtimeEnvironmentBefore,
      execution?.runtimeEnvironmentAfter))).toBe(!drift);
    expect(execution).not.toHaveProperty('testLayer');
  });

  it('does not publish native evidence when its cited definition is absent at the source commit', async () => {
    let executed = false;
    const result = await executeOperationalRun({
      filePath: 'docs/evidence/future-output.json', name: 'uncommitted output is not a definition',
      command: ['native', 'future-output'], framework: 'operational',
      runtimeUnits: ['native-check-runtime'],
      run: async () => {
        executed = true;
        return { exitCode: 0, summary: 'Should not run.',
          assertions: [{ id: 'unexpected', passed: true, evidence: 'Unexpected' }] };
      },
    }, { workspaceId, harnessSlug: 'operational-harness', projectDir: process.cwd() }, {
      snapshot: () => ({ commit: 'a'.repeat(40), porcelain: '' }),
      verifyDefinition: async () => false,
      readRuntime: async () => 'b'.repeat(64),
      persist: params => persistHarnessTestRunsWithIds({ ...params,
        sql: db.adminSql as unknown as NonNullable<Parameters<typeof persistHarnessTestRunsWithIds>[0]['sql']> }),
    });
    expect(result).toMatchObject({ ok: false, error: 'operational_check_definition_unavailable' });
    expect(executed).toBe(false);
    const rows = await db.adminSql`SELECT id FROM harness_shared.test_runs
      WHERE workspace_id = ${workspaceId} AND file_path = 'docs/evidence/future-output.json'`;
    expect(rows).toHaveLength(0);
  });

  it('preserves the native failure and server error classification when real PG rejects persistence', async () => {
    const result = await executeOperationalRun({
      filePath: 'lib/testing-run-store.integration.test.ts', name: 'failed native scenario and ledger',
      command: ['native', 'failed-scenario'], framework: 'operational', runtimeUnits: [],
      run: async () => { throw new Error('subject did not pick up the verdict'); },
    }, { workspaceId, harnessSlug: 'operational-harness', projectDir: process.cwd() }, {
      snapshot: () => ({ commit: 'a'.repeat(40), porcelain: '' }), verifyDefinition: async () => true,
      persist: params => persistHarnessTestRunsWithIds({ ...params,
        sql: () => db.adminSql`SELECT * FROM harness_shared.native_recorder_missing_table` }),
    });
    expect(result).toMatchObject({ ok: false, error: 'ledger_write_failed', observed: { status: 'fail',
      artifact: { exitCode: 1, assertions: [{ id: 'native-check-exception', passed: false,
        evidence: 'subject did not pick up the verdict' }] } },
      persistence: { written: 0, ids: [], failure: { phase: 'insert', rowIndex: 0, errorCode: '42P01' } },
    });
    expect(result).not.toHaveProperty('testRunIds');
    expect(JSON.stringify(result)).not.toContain('native_recorder_missing_table');
  });
});
