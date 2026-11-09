import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifierSourceFiles } from './verifier-source';

const sourcePreview = vi.hoisted(() => ({ prepareVerifierSource: vi.fn(), prepareVerifierDependencies: vi.fn() }));
vi.mock('../../../scripts/source-preview.mjs', () => sourcePreview);

import { produceCommittedReaderOriginalPreparation, qualifyCommittedReaderOriginalPreparation,
  withCommittedReaderOriginalPreparation, observeCommittedReaderWorkerEnvironment,
  retainCommittedReaderWorkerEnvironment, readCommittedReaderLegacyAdoptionFixtureEvidence } from '../test/private-http-workspace-preflight';
import { readProcessIdentity } from './process-identity';
import type { CommittedReaderCallerContract } from '../test/private-http-workspace-preflight';
import type { CommittedReaderObservationCohort, CommittedReaderObservationIdentity,
  CommittedReaderPreparationHandoff } from '../test/isolated-integration-proof';

const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const roots: string[] = [];
const testPath = 'packages/operator-core/lib/agent-tools/plans/committed-tree-reader-http.integration.test.ts';
const helperPaths = ['packages/operator-core/test/staging-first-http-fixture.ts', 'apps/operator/bin/bundle-host.sh'];
const configPaths = ['package.json', 'packages/operator-core/vitest.integration.config.ts'];

describe('original API worker exec environment observation', () => {
  const withOriginalWorker = async (check: (identity: CommittedReaderObservationIdentity) => void) => {
    // Vitest can set its run group after exec. Observe a real child with an
    // explicit exec-time value, then join only after its readiness message.
    const child = spawn(process.execPath, ['-e',
      'process.send("ready"); setTimeout(() => process.exit(0), 10000)'], {
      env: { ...process.env, NODE_OPTIONS: '', PAPERCUSP_TEST_RUN_GROUP: 'original-api-env-control' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const ended = once(child, 'exit');
    try {
      await once(child, 'message');
      check({ sourceCommit: 'a'.repeat(40), runId: 'original-api-env-control',
        process: { pid: child.pid!, identity: readProcessIdentity(child.pid!)! } });
    } finally {
      child.kill('SIGTERM');
      await ended;
    }
  };

  it('hashes the live selected process exec bytes rather than caller or later process.env values', async () => {
    const key = 'PAPERCUSP_TEST_RUN_GROUP';
    vi.stubEnv(key, 'later-caller-value');
    try {
      await withOriginalWorker(expected => {
        expect(observeCommittedReaderWorkerEnvironment(expected, [key])).toEqual({ ...expected,
          value: { [key]: digest('original-api-env-control') } });
      });
    } finally { vi.unstubAllEnvs(); }
  });

  it.each(['kernel', 'run', 'source'] as const)('refuses a mismatched %s identity', async part => withOriginalWorker(expected => {
    if (part === 'kernel') expected.process.identity += '-other-lifetime';
    if (part === 'run') expected.runId += '-other-run';
    if (part === 'source') expected.sourceCommit = 'caller-selection';
    expect(() => observeCommittedReaderWorkerEnvironment(expected, ['PAPERCUSP_TEST_RUN_GROUP']))
      .toThrow(/identity changed|another run|source selection/);
  }));

  it.for([[], ['PAPERCUSP_TEST_RUN_GROUP', 'PAPERCUSP_TEST_RUN_GROUP'], ['BAD=KEY'],
    ['COMMITTED_READER_MISSING_ORIGINAL_INPUT']])('refuses missing or ambiguous key population %j',
  async keys => withOriginalWorker(expected => {
    expect(() => observeCommittedReaderWorkerEnvironment(expected, keys)).toThrow(/keys required|input missing/);
  }));

  it('joins the unchanged original receipt only to its own observed terminal worker', async () => {
    const root = mkdtempSync(join(tmpdir(), 'reader-environment-terminal-')); roots.push(root);
    let retained!: ReturnType<typeof retainCommittedReaderWorkerEnvironment>;
    let worker!: CommittedReaderObservationIdentity;
    await withOriginalWorker(expected => {
      worker = expected;
      retained = retainCommittedReaderWorkerEnvironment(expected, ['PAPERCUSP_TEST_RUN_GROUP'], join(root, 'env.json'));
      expect(() => retained.terminal({ pid: expected.process.pid, exitCode: null, signalCode: null }))
        .toThrow(/terminal outcome missing/);
      expect(() => retained.terminal({ pid: expected.process.pid, exitCode: 0, signalCode: null }))
        .toThrow(/still alive/);
    });
    const terminal = { pid: worker.process.pid, exitCode: null, signalCode: 'SIGTERM' as const };
    expect(retained.terminal(terminal)).toMatchObject({ ...worker, signalCode: 'SIGTERM',
      observationReceipt: { sha256: digest(readFileSync(join(root, 'env.json'))) } });
    expect(() => retained.terminal({ ...terminal, pid: terminal.pid + 1 })).toThrow(/worker differs/);
    writeFileSync(join(root, 'env.json'), '{}');
    expect(() => retained.terminal(terminal)).toThrow(/receipt changed/);
  });

  it('pins terminal identity independently of mutable caller and returned observation objects', async () => {
    const root = mkdtempSync(join(tmpdir(), 'reader-environment-identity-')); roots.push(root);
    let retained!: ReturnType<typeof retainCommittedReaderWorkerEnvironment>;
    let original!: CommittedReaderObservationIdentity;
    await withOriginalWorker(expected => {
      original = structuredClone(expected);
      retained = retainCommittedReaderWorkerEnvironment(expected, ['PAPERCUSP_TEST_RUN_GROUP'], join(root, 'env.json'));
      for (const mutable of [expected, retained.observation]) {
        mutable.sourceCommit = 'b'.repeat(40);
        mutable.runId = 'substituted-run';
        mutable.process.pid += 1;
        mutable.process.identity = 'substituted-process';
      }
      expect(() => retained.terminal({ pid: original.process.pid, exitCode: 0, signalCode: null }))
        .toThrow(/still alive/);
    });
    const terminal = { pid: original.process.pid, exitCode: null, signalCode: 'SIGTERM' as const };
    const receipt = retained.terminal(terminal);
    expect(receipt).toMatchObject(original);
    receipt.process.pid += 1;
    receipt.process.identity = 'substituted-result';
    expect(retained.terminal(terminal)).toMatchObject(original);
  });

  it('refuses absent, malformed or contradictory outcomes after the original worker exits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'reader-environment-outcome-')); roots.push(root);
    let retained!: ReturnType<typeof retainCommittedReaderWorkerEnvironment>;
    let worker!: CommittedReaderObservationIdentity;
    await withOriginalWorker(expected => {
      worker = expected;
      retained = retainCommittedReaderWorkerEnvironment(expected, ['PAPERCUSP_TEST_RUN_GROUP'], join(root, 'env.json'));
    });
    for (const outcome of [{}, { exitCode: null, signalCode: null },
      { exitCode: NaN, signalCode: null }, { exitCode: -1, signalCode: null },
      { exitCode: 256, signalCode: null }, { exitCode: 0, signalCode: 'SIGTERM' },
      { exitCode: null, signalCode: '' }, { exitCode: null, signalCode: 'SIGNONSENSE' }])
      expect(() => retained.terminal({ pid: worker.process.pid, ...outcome } as
        Parameters<typeof retained.terminal>[0])).toThrow(/terminal outcome missing or invalid/);
  });
});

function fixtureSource(root: string, sourceCommit: string) {
  const paths = [testPath, ...helperPaths, ...configPaths, 'src/main.ts'];
  for (const path of paths) {
    const target = join(root, path); mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, `// ${path}\n`);
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'reader-preparation-fixture', private: true }));
  const builder = join(root, 'apps/operator/bin/bundle-host.sh');
  writeFileSync(builder, `#!/bin/bash
set -e
mkdir -p "$(dirname "$2")"
printf 'independent-bundle' > "$2"
cat > "$2.meta.json" <<'GRAPH'
{"inputs":{"src/main.ts":{"imports":[{"path":"example","external":true}]}},"outputs":{"hono-host.mjs":{"imports":[{"path":"example","external":true}]}}}
GRAPH
`);
  chmodSync(builder, 0o755);
  const sourceManifest = { schemaVersion: 'verifier-source-v1', sourceCommit,
    testedInputs: [{ path: testPath, sha256: digest(readFileSync(join(root, testPath))) }],
    files: verifierSourceFiles(root), submodules: [] };
  writeFileSync(join(root, '.verifier-source.json'), JSON.stringify(sourceManifest));
  return sourceManifest;
}

beforeEach(() => {
  vi.clearAllMocks();
  sourcePreview.prepareVerifierSource.mockImplementation(async ({ ref, dest }: { ref: string; dest: string }) =>
    fixtureSource(dest, ref));
  sourcePreview.prepareVerifierDependencies.mockImplementation(async ({ dest }: { dest: string }) => {
    const example = join(dest, 'node_modules/example'); mkdirSync(example, { recursive: true });
    writeFileSync(join(example, 'package.json'), JSON.stringify({ name: 'example', main: 'index.js' }));
    writeFileSync(join(example, 'index.js'), 'module.exports = 1;');
  });
});

afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

/** These are synthetic contract controls, not evidence of an actual collected
 * loader/config/schema/environment cohort or an independently qualified host. */
function originalFixture() {
  const parent = mkdtempSync(join(tmpdir(), 'reader-original-preparation-test-')); roots.push(parent);
  const repositoryRoot = join(parent, 'repo'); mkdirSync(repositoryRoot);
  const root = join(parent, 'original-source'); mkdirSync(root);
  const selectedCommit = 'a'.repeat(40);
  const source = fixtureSource(root, selectedCommit);
  const dependency = join(root, 'node_modules/example'); mkdirSync(dependency, { recursive: true });
  writeFileSync(join(dependency, 'index.js'), 'module.exports = 1;');
  const schema = { 'harness_shared.tool_invocations.args_json': digest('jsonb:not-null') };
  const environment = { PAPERCUSP_BACKGROUND_WORKERS: '0', PAPERCUSP_SKIP_PG_DISCOVERY: '1' };
  const inputs = { sourceCommit: selectedCommit, phase: 'planned', testPaths: [testPath],
    helperPaths: [...helperPaths].sort(), configPaths: [...configPaths].sort(), executedImports: ['src/main.ts'],
    dependencyFiles: verifierSourceFiles(join(root, 'node_modules')),
    externalResolutions: { example: 'node_modules/example/index.js' }, copiedSources: [], copiedArtifacts: [],
    schema, environment: Object.fromEntries(Object.entries(environment).map(([key, value]) => [key, digest(value)])),
    omitted: [] as string[], opaque: [] as string[] };
  const handoff: CommittedReaderPreparationHandoff = { root, selectedCommit,
    sourceReceiptPath: join(parent, 'source.json'), sourceReceiptSha256: '',
    inputReceiptPath: join(parent, 'inputs.json'), inputReceiptSha256: '',
    observationReceiptPath: join(parent, 'observations.json'), observationReceiptSha256: '' };
  const identity = { sourceCommit: selectedCommit, runId: 'original-reference-run',
    process: { pid: 42, identity: 'original-reference-process-start' } };
  const values = { source, dependencies: { files: inputs.dependencyFiles, externalResolutions: inputs.externalResolutions },
    config: inputs.configPaths, imports: inputs.executedImports, schema, environment: inputs.environment };
  const cohort: CommittedReaderObservationCohort = { ...structuredClone(identity), sourceRoot: root,
    sourceReceipt: { path: handoff.sourceReceiptPath, sha256: '' },
    inputReceipt: { path: handoff.inputReceiptPath, sha256: '' },
    observations: Object.fromEntries(Object.entries(values).map(([key, value]) =>
      [key, { ...structuredClone(identity), value: structuredClone(value) }])) as CommittedReaderObservationCohort['observations'],
    omitted: [], opaque: [] };
  const save = () => {
    writeFileSync(handoff.sourceReceiptPath, JSON.stringify(source));
    writeFileSync(handoff.inputReceiptPath, JSON.stringify(inputs));
    handoff.sourceReceiptSha256 = digest(readFileSync(handoff.sourceReceiptPath));
    handoff.inputReceiptSha256 = digest(readFileSync(handoff.inputReceiptPath));
    cohort.sourceReceipt.sha256 = handoff.sourceReceiptSha256;
    cohort.inputReceipt.sha256 = handoff.inputReceiptSha256;
    writeFileSync(handoff.observationReceiptPath, JSON.stringify(cohort));
    handoff.observationReceiptSha256 = digest(readFileSync(handoff.observationReceiptPath));
  };
  save();
  const options = { repositoryRoot, workRoot: join(parent, 'consumer-preparation'), selectedCommit,
    testPath, helperPaths, configPaths, schema, environment, original: { handoff, identity } };
  const noEffects = () => {
    expect(sourcePreview.prepareVerifierSource).not.toHaveBeenCalled();
    expect(sourcePreview.prepareVerifierDependencies).not.toHaveBeenCalled();
    expect(existsSync(options.workRoot)).toBe(false);
    expect(existsSync(join(root, 'apps/operator/dist-verify/original-hono-host.mjs'))).toBe(false);
  };
  return { options, handoff, identity, inputs, cohort, source, save, noEffects };
}

describe('D050 caller entry before allocations', () => {
  const contract = (f: ReturnType<typeof originalFixture>): CommittedReaderCallerContract => ({
    selectedCommit: f.options.selectedCommit, original: f.options.original,
    testPath, helperPaths: [...helperPaths], configPaths: [...configPaths],
    schema: structuredClone(f.options.schema), environment: { ...f.options.environment },
  });
  const effects = () => vi.fn(async () => 'allocation callback reached');

  it.each(['contract', 'selection', 'original', 'schema', 'environment'] as const)(
    'refuses missing %s before allocation callbacks', async missing => {
      const f = originalFixture(); const supplied = contract(f);
      const allocate = effects();
      if (missing !== 'contract') delete (supplied as Partial<CommittedReaderCallerContract>)[
        missing === 'selection' ? 'selectedCommit' : missing];
      await expect(withCommittedReaderOriginalPreparation(missing === 'contract' ? undefined : supplied, allocate))
        .rejects.toThrow(/required|missing/i);
      expect(allocate).not.toHaveBeenCalled(); f.noEffects();
    });

  it('permits the callback only after validating synthetic pinned originals and preserves their identity', async () => {
    const f = originalFixture(); const bytes = readFileSync(f.handoff.observationReceiptPath);
    const allocate = vi.fn(async (preparation: CommittedReaderPreparationHandoff & { identity: CommittedReaderObservationIdentity }) => {
      expect(preparation).toEqual({ ...f.handoff, identity: f.identity });
      expect(qualifyCommittedReaderOriginalPreparation(preparation, preparation.identity).bytes).toEqual(bytes);
      return 'explicit callback result';
    });
    await expect(withCommittedReaderOriginalPreparation(contract(f), allocate)).resolves.toBe('explicit callback result');
    expect(allocate).toHaveBeenCalledTimes(1); f.noEffects();
  });

  it('refuses undelivered actual HTTP caller input before any private proof or schema allocation', async () => {
    const privateProof = vi.fn(async () => { throw new Error('private proof allocation reached'); });
    const schemaDb = vi.fn(async () => { throw new Error('schema allocation reached'); });
    // Import the real entrypoint without registering/running its HTTP experiment.
    vi.doMock('vitest', () => ({ expect, it: vi.fn() }));
    vi.doMock('../test/isolated-integration-proof', () => ({
      isolatedWorkerOptions: () => ({ testTimeoutMs: 1 }),
      captureIsolatedWorker: vi.fn(), recordIsolatedIntegrationProof: privateProof,
    }));
    vi.doMock('../test/_org-test-db', () => ({ createOrgTestDb: schemaDb }));
    try {
      const { measureCommittedReaderHttp } = await import('./agent-tools/plans/committed-tree-reader-http.integration.test');
      await expect(measureCommittedReaderHttp()).rejects.toThrow(/explicit.*contract.*required.*allocations/i);
      expect(privateProof).not.toHaveBeenCalled();
      expect(schemaDb).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('vitest'); vi.doUnmock('../test/isolated-integration-proof'); vi.doUnmock('../test/_org-test-db');
    }
  });

  it.each(['selection', 'identity', 'pin', 'population', 'schema-default', 'environment-default'] as const)(
    'refuses mismatched %s before allocation callbacks', async mismatch => {
      const f = originalFixture(); const supplied = contract(f); const allocate = effects();
      if (mismatch === 'selection') supplied.selectedCommit = 'b'.repeat(40);
      if (mismatch === 'identity') supplied.original.identity.process.identity = 'other-process';
      if (mismatch === 'pin') supplied.original.handoff.observationReceiptSha256 = '0'.repeat(64);
      if (mismatch === 'population') supplied.helperPaths = [];
      if (mismatch === 'schema-default') supplied.schema = { ...supplied.schema, callerDefault: digest('static') };
      if (mismatch === 'environment-default') supplied.environment.PAPERCUSP_BACKGROUND_WORKERS = 'caller-default';
      await expect(withCommittedReaderOriginalPreparation(supplied, allocate)).rejects.toThrow(/differs|changed|required/i);
      expect(allocate).not.toHaveBeenCalled(); f.noEffects();
    });

  it.each(['sourceReceiptPath', 'inputReceiptPath', 'observationReceiptPath'] as const)(
    'refuses retained %s drift before allocation callbacks', async path => {
      const f = originalFixture(); const supplied = contract(f); const allocate = effects();
      writeFileSync(f.handoff[path], readFileSync(f.handoff[path], 'utf8') + '\n');
      await expect(withCommittedReaderOriginalPreparation(supplied, allocate)).rejects.toThrow(/receipt.*changed/i);
      expect(allocate).not.toHaveBeenCalled(); f.noEffects();
    });

  it('refuses a missing original dimension instead of promoting explicit caller constraints', async () => {
    const f = originalFixture(); const supplied = contract(f); const allocate = effects();
    delete (f.cohort.observations as Partial<typeof f.cohort.observations>).environment; f.save();
    await expect(withCommittedReaderOriginalPreparation(supplied, allocate)).rejects.toThrow(/dimension identity is missing/i);
    expect(allocate).not.toHaveBeenCalled(); f.noEffects();
  });

  it('preserves callback failures after successful read-only validation', async () => {
    const f = originalFixture(); const failure = new Error('explicit callback failure');
    const allocate = vi.fn(async () => { throw failure; });
    await expect(withCommittedReaderOriginalPreparation(contract(f), allocate)).rejects.toBe(failure);
    expect(allocate).toHaveBeenCalledTimes(1); f.noEffects();
  });
});

describe('D014 transaction-local fixture evidence consumer', () => {
  function fixture() {
    const f = originalFixture();
    const keys = ['apiManifestHash', 'launcherManifestHash', 'plannedHostManifestHash',
      'executedInputsHash', 'dependencyManifestHash'] as const;
    const record = { ...structuredClone(f.identity), observationReceiptSha256: f.handoff.observationReceiptSha256,
      omitted: [], opaque: [] };
    const retain = (name: string, value: unknown) => {
      const path = join(f.handoff.root, '..', name + '.json'), bytes = JSON.stringify(value);
      writeFileSync(path, bytes); return { path, sha256: digest(bytes) };
    };
    // Synthetic observer output exercises this consumer, never actual-host proof.
    const hash = digest('synthetic-host-proof');
    const hostRecord = { schemaVersion: 'committed-reader-loader-source-v1', scope: 'node-loader-returned-source',
      sourceCommit: f.identity.sourceCommit, runId: f.identity.runId, pid: f.identity.process.pid,
      kernelProcessIdentity: f.identity.process.identity, processIdentity: 'synthetic-trace-process',
      sourceReceiptSha256: f.handoff.sourceReceiptSha256, status: 'bound', exitObserved: true, gaps: [], pending: [],
      configurationInputs: { scope: 'native-node-entry-configuration-inputs', status: 'matched', gaps: [],
        snapshot: { fingerprint: hash }, expectedFingerprint: hash },
      configurationReads: { scope: 'javascript-configuration-property-gets', status: 'observed', gaps: [],
        observation: { captureComplete: true, activeAtTermination: true }, receiptSha256: hash },
      privateSchema: { scope: 'api-worker-information-schema-columns', status: 'observed', gaps: [],
        schema: f.inputs.schema, receiptSha256: hash, querySha256: hash },
      appliedSql: { scope: 'migration-client-unsafe-query', status: 'observed', gaps: [],
        attempts: [{ outcome: 'returned', rawSource: { sha256: hash }, query: { sha256: hash },
          plannedReceiptSha256: hash, terminalReceiptSha256: hash }] },
      engineExecution: { scope: 'independently-pinned-bundle-outer-execution', status: 'observed', gaps: [],
        sourceTextSha256: hash, sourceTextLength: 1, coverageRangesComplete: true,
        coverageRanges: [{ startOffset: 0, endOffset: 1, count: 1 }] },
      resolutions: { scope: 'native-node-resolver-returned-edges', status: 'bound', gaps: [] } };
    const hostObservation = retain('host-observation', hostRecord);
    const terminalRecord = { ...record, hostObservationReceipt: hostObservation,
      state: 'complete', exitCode: 0, signalCode: null, cleanupComplete: true };
    const terminal = retain('terminal', terminalRecord);
    const manifests = Object.fromEntries(keys.map(key => [key, retain(key,
      { ...record, hostObservationReceipt: hostObservation,
        scope: 'fixture-only', qualificationKey: key, terminalReceipt: terminal })])) as
      Parameters<typeof readCommittedReaderLegacyAdoptionFixtureEvidence>[2]['manifests'];
    const payload = { qualification: Object.fromEntries(keys.map(key => [key, manifests[key].sha256])) } as
      Parameters<typeof readCommittedReaderLegacyAdoptionFixtureEvidence>[1];
    const tx = { savepoint: vi.fn() } as unknown as Parameters<typeof readCommittedReaderLegacyAdoptionFixtureEvidence>[0];
    const current = vi.fn<Parameters<typeof readCommittedReaderLegacyAdoptionFixtureEvidence>[3]>(async () => ({ bindingHistory: { fixtureOnly: true },
      outstandingEffects: { fixtureOnly: true }, independence: { fixtureOnly: true } }));
    const retained = { original: f.options.original, hostObservation, manifests, terminal };
    const read = () => readCommittedReaderLegacyAdoptionFixtureEvidence(tx, payload, retained, current);
    return { ...f, keys, record, retain, hostRecord, terminalRecord, retained, payload, tx, current, read };
  }

  it('joins all five retained digests and passes the original custody transaction to the current reader', async () => {
    const f = fixture();
    await expect(f.read()).resolves.toEqual({ bindingHistory: { fixtureOnly: true },
      outstandingEffects: { fixtureOnly: true }, independence: { fixtureOnly: true }, qualification: f.payload.qualification });
    expect(f.current).toHaveBeenCalledWith(f.tx, f.payload);
    f.noEffects();
  });

  it.each(['source', 'dependencies', 'config', 'imports', 'schema', 'environment'] as const)(
    'refuses a cross-process %s original before reading current evidence', async key => {
      const f = fixture(); await f.read(); f.current.mockClear();
      f.cohort.observations[key].process.identity = 'other-process'; f.save();
      f.retained.original.handoff = f.handoff;
      await expect(f.read()).rejects.toThrow(/cohort identity differs/);
      expect(f.current).not.toHaveBeenCalled();
    });

  it.each(['apiManifestHash', 'launcherManifestHash', 'plannedHostManifestHash',
    'executedInputsHash', 'dependencyManifestHash'] as const)('refuses a planned rather than retained %s', async key => {
    const f = fixture(); await f.read(); f.current.mockClear();
    f.payload.qualification[key] = 'f'.repeat(64);
    await expect(f.read()).rejects.toThrow(/qualification digest differs/);
    expect(f.current).not.toHaveBeenCalled();
  });

  it.each(['cross-run', 'cross-process', 'wrong-kind', 'opaque', 'limited', 'unjoined-terminal'])(
    'refuses %s manifest even when its digest is explicitly selected', async variant => {
      const f = fixture(), key = 'executedInputsHash';
      await f.read(); f.current.mockClear();
      const record: Record<string, unknown> = { ...f.record, scope: 'fixture-only', qualificationKey: key,
        terminalReceipt: f.retained.terminal, hostObservationReceipt: f.retained.hostObservation };
      if (variant === 'cross-run') record.runId = 'different-run';
      if (variant === 'cross-process') record.process = { ...f.identity.process, identity: 'different-process' };
      if (variant === 'wrong-kind') record.qualificationKey = 'apiManifestHash';
      if (variant === 'opaque') record.opaque = ['runtime'];
      if (variant === 'limited') record.omitted = ['dependencies'];
      if (variant === 'unjoined-terminal') record.terminalReceipt = { ...f.retained.terminal, sha256: 'b'.repeat(64) };
      f.retained.manifests[key] = f.retain(key, record);
      f.payload.qualification[key] = f.retained.manifests[key].sha256;
      await expect(f.read()).rejects.toThrow(/identity differs|kind differs|opaque|incomplete|terminal receipt differs/);
      expect(f.current).not.toHaveBeenCalled();
    });

  it.each(['pending', 'failed', 'signal', 'cleanup'])( 'refuses %s terminal observation', async variant => {
    const f = fixture();
    await f.read(); f.current.mockClear();
    if (variant === 'pending') f.terminalRecord.state = 'pending';
    if (variant === 'failed') f.terminalRecord.exitCode = 1;
    if (variant === 'signal') Object.assign(f.terminalRecord, { exitCode: null, signalCode: 'SIGTERM' });
    if (variant === 'cleanup') f.terminalRecord.cleanupComplete = false;
    f.retained.terminal = f.retain('terminal', f.terminalRecord);
    await expect(f.read()).rejects.toThrow(/terminal outcome incomplete or failed/);
    expect(f.current).not.toHaveBeenCalled();
  });

  it.each(['manifest', 'dependency', 'original', 'host'])( 'rechecks %s bytes after an awaited current evidence read', async variant => {
    const f = fixture();
    await f.read(); f.current.mockClear();
    f.current.mockImplementationOnce(async () => {
      const path = variant === 'manifest' ? f.retained.manifests.dependencyManifestHash.path
        : variant === 'dependency' ? join(f.handoff.root, 'node_modules/example/index.js')
        : variant === 'host' ? f.retained.hostObservation.path
        : f.handoff.observationReceiptPath;
      writeFileSync(path, 'changed while waiting');
      return { bindingHistory: {}, outstandingEffects: {}, independence: {} };
    });
    await expect(f.read()).rejects.toThrow(/changed|differs|mismatch/i);
  });

  it.each(['missing', 'commit', 'run', 'pid', 'kernel', 'source', 'unknown', 'pending', 'gaps', 'exit',
    'configurationInputs', 'configurationReads', 'privateSchema', 'appliedSql', 'engineExecution', 'resolutions',
    'schema-value', 'sql-empty', 'config-incomplete', 'engine-incomplete', 'proof-digest'] as const)(
    'refuses %s host observation before reading current evidence', async variant => {
      const f = fixture();
      await f.read(); f.current.mockClear();
      const host = structuredClone(f.hostRecord);
      if (variant === 'commit') host.sourceCommit = 'b'.repeat(40);
      if (variant === 'run') host.runId += '-other';
      if (variant === 'pid') host.pid++;
      if (variant === 'kernel') host.kernelProcessIdentity += '-other';
      if (variant === 'source') host.sourceReceiptSha256 = 'b'.repeat(64);
      if (variant === 'unknown') host.status = 'unknown';
      if (variant === 'pending') (host.pending as string[]).push('preparation-qualification');
      if (variant === 'gaps') (host.gaps as string[]).push('unobserved');
      if (variant === 'exit') host.exitObserved = false;
      if (['configurationInputs', 'configurationReads', 'privateSchema', 'appliedSql', 'engineExecution', 'resolutions'].includes(variant))
        host[variant as 'configurationInputs'].status = 'unknown';
      if (variant === 'schema-value') Object.assign(host.privateSchema.schema,
        Object.fromEntries(Object.keys(host.privateSchema.schema).map(key => [key, 'b'.repeat(64)])));
      if (variant === 'sql-empty') host.appliedSql.attempts = [];
      if (variant === 'config-incomplete') host.configurationReads.observation.captureComplete = false;
      if (variant === 'engine-incomplete') host.engineExecution.coverageRangesComplete = false;
      if (variant === 'proof-digest') host.appliedSql.attempts[0].query.sha256 = '';
      f.retained.hostObservation = f.retain('host-observation', host);
      if (variant === 'missing') delete (f.retained as Partial<typeof f.retained>).hostObservation;
      await expect(f.read()).rejects.toThrow(/Retained fixture/);
      expect(f.current).not.toHaveBeenCalled();
    });

  it.each(['terminal', 'apiManifestHash', 'launcherManifestHash', 'plannedHostManifestHash',
    'executedInputsHash', 'dependencyManifestHash'] as const)(
    'refuses a %s from a different retained host observation', async key => {
      const f = fixture(); await f.read(); f.current.mockClear();
      const pin = key === 'terminal' ? f.retained.terminal : f.retained.manifests[key];
      const record = JSON.parse(readFileSync(pin.path, 'utf8'));
      record.hostObservationReceipt.sha256 = 'b'.repeat(64);
      const changed = f.retain(key, record);
      if (key === 'terminal') f.retained.terminal = changed;
      else { f.retained.manifests[key] = changed; f.payload.qualification[key] = changed.sha256; }
      await expect(f.read()).rejects.toThrow(/host observation receipt differs/);
      expect(f.current).not.toHaveBeenCalled();
    });

  it('refuses a missing custody transaction before any current read', async () => {
    const f = fixture();
    await f.read(); f.current.mockClear();
    await expect(readCommittedReaderLegacyAdoptionFixtureEvidence({} as typeof f.tx,
      f.payload, f.retained, f.current)).rejects.toThrow(/custody transaction/);
    expect(f.current).not.toHaveBeenCalled();
  });
});

describe('D047 pinned original preparation provenance', () => {
  it.each(['static graph and caller values', 'caller values without schema'])(
    'refuses %s before archive, dependency, compiler or private allocation', async variant => {
      const f = originalFixture();
      const options = { ...f.options, original: undefined,
        ...(variant === 'caller values without schema' ? { schema: {} } : {}) };
      await expect(produceCommittedReaderOriginalPreparation(options)).rejects.toThrow(/original.*handoff.*required|Required original preparation handoff is missing/i);
      f.noEffects();
    });

  it('preserves supplied original identity and exact bytes without synthesizing an observation or building', async () => {
    const f = originalFixture();
    const paths = [f.handoff.sourceReceiptPath, f.handoff.inputReceiptPath, f.handoff.observationReceiptPath];
    const bytes = paths.map(path => readFileSync(path));
    const prepared = await produceCommittedReaderOriginalPreparation(f.options);
    expect(prepared).toEqual({ ...f.handoff, identity: f.identity });
    expect(prepared.identity.process.pid).not.toBe(process.pid);
    paths.forEach((path, index) => expect(readFileSync(path)).toEqual(bytes[index]));
    const qualified = qualifyCommittedReaderOriginalPreparation(prepared, f.identity);
    expect(qualified.planned.inputs).toEqual(f.inputs);
    expect(qualified.bytes).toEqual(bytes[2]);
    f.noEffects();
  });

  it.each(['source', 'dependencies', 'config', 'imports', 'schema', 'environment'] as const)(
    'refuses missing original %s rather than filling from static/caller inputs', async dimension => {
      const f = originalFixture(); delete (f.cohort.observations as Partial<typeof f.cohort.observations>)[dimension]; f.save();
      await expect(produceCommittedReaderOriginalPreparation(f.options)).rejects.toThrow(/dimension identity is missing/);
      f.noEffects();
    });

  it.each(['source', 'dependencies', 'config', 'imports', 'schema', 'environment'] as const)(
    'refuses an original %s from a different process/run', async dimension => {
      const f = originalFixture(); f.cohort.observations[dimension].runId = 'other-run'; f.save();
      await expect(produceCommittedReaderOriginalPreparation(f.options)).rejects.toThrow(/cohort identity differs/);
      f.noEffects();
    });

  it.each(['source', 'dependencies', 'config', 'imports', 'schema', 'environment'] as const)(
    'refuses mismatched original %s values even with valid receipt digests', async dimension => {
      const f = originalFixture(); f.cohort.observations[dimension].value = ['static-substitution']; f.save();
      await expect(produceCommittedReaderOriginalPreparation(f.options)).rejects.toThrow(new RegExp(`Original ${dimension} observation differs`));
      f.noEffects();
    });

  it.each(['sourceReceiptSha256', 'inputReceiptSha256', 'observationReceiptSha256'] as const)(
    'refuses missing original %s before effects', async pin => {
      const f = originalFixture(); f.handoff[pin] = '';
      await expect(produceCommittedReaderOriginalPreparation(f.options)).rejects.toThrow(/receipt digest is required/);
      f.noEffects();
    });

  it.each(['sourceReceiptPath', 'inputReceiptPath', 'observationReceiptPath'] as const)(
    'refuses original receipt drift at %s before effects', async path => {
      const f = originalFixture(); writeFileSync(f.handoff[path], readFileSync(f.handoff[path], 'utf8') + '\n');
      await expect(produceCommittedReaderOriginalPreparation(f.options)).rejects.toThrow(/receipt.*changed/i);
      f.noEffects();
    });

  it.each(['omitted', 'opaque'] as const)('preserves refusal of unknown %s dimensions', async key => {
    const f = originalFixture(); f.cohort[key] = ['unobserved-descendant']; f.save();
    await expect(produceCommittedReaderOriginalPreparation(f.options)).rejects.toThrow(new RegExp(`has ${key} dimensions`));
    f.noEffects();
  });

  it('refuses selected commit disagreement instead of relabeling the original cohort', async () => {
    const f = originalFixture(); f.options.selectedCommit = 'b'.repeat(40);
    await expect(produceCommittedReaderOriginalPreparation(f.options)).rejects.toThrow(/selected.*differs/i);
    f.noEffects();
  });

  it.each(['configPaths', 'executedImports'] as const)('reuses planned archive membership for %s', async key => {
    const f = originalFixture(); f.inputs[key] = ['outside.ts'];
    f.cohort.observations[key === 'configPaths' ? 'config' : 'imports'].value = f.inputs[key]; f.save();
    await expect(produceCommittedReaderOriginalPreparation(f.options)).rejects.toThrow(/outside selected archive/);
    f.noEffects();
  });

  it('refuses changed materialized dependencies instead of reconstructing observations', async () => {
    const f = originalFixture(); writeFileSync(join(f.handoff.root, 'node_modules/example/index.js'), 'changed');
    await expect(produceCommittedReaderOriginalPreparation(f.options)).rejects.toThrow(/dependency census differs/);
    f.noEffects();
  });

  it.each(['sourceReceiptPath', 'inputReceiptPath', 'observationReceiptPath'] as const)(
    'rechecks original %s bytes after qualification', path => {
      const f = originalFixture(); const qualified = qualifyCommittedReaderOriginalPreparation(f.handoff, f.identity);
      writeFileSync(f.handoff[path], readFileSync(f.handoff[path], 'utf8') + '\n');
      expect(() => qualified.recheck()).toThrow(/receipt.*changed/i);
      f.noEffects();
    });
});
