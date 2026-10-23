import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  PARTIAL_TASK_CHECKPOINT_SCHEMA,
  PARTIAL_TASK_SKIP_LIST_SCHEMA,
  normalizePartialFiles,
  partialTaskCheckpointPath,
  partialTaskSkipListPath,
  readPartialTaskCheckpoint,
  writePartialTaskCheckpointAtomic,
  evaluatePartialTaskContinuation,
  readPartialNativeCompletion,
  registerPartialNativeProducer,
  readPartialNativeProducer,
  preparePartialContinuationManifest,
} from '../../../../scripts/lib/partial-task-resume.mjs';

const ID = {
  root: '/repo',
  taskKey: '@papercusp/operator-core :: test:integration',
  sourceCommit: 'a'.repeat(40),
  sourceDigest: 'b'.repeat(64),
};

describe('partial-task-resume', () => {
  it('normalizes workspace paths and rejects paths outside the workspace', () => {
    expect(normalizePartialFiles(['./lib/a.test.ts', '/repo/lib/b.test.ts', '../escape.test.ts'], '/repo'))
      .toEqual(['lib/a.test.ts', 'lib/b.test.ts']);
  });

  it('round-trips a checkpoint and bounds passed files to its selected manifest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'partial-task-resume-'));
    const file = partialTaskCheckpointPath(dir, ID.root, ID.taskKey);
    writePartialTaskCheckpointAtomic(file, {
      ...ID,
      selectedFiles: ['lib/b.test.ts', 'lib/a.test.ts'],
      passedFiles: ['lib/a.test.ts', 'lib/foreign.test.ts'],
      state: 'partial',
    });
    expect(readPartialTaskCheckpoint(file, ID)).toMatchObject({
      schemaVersion: PARTIAL_TASK_CHECKPOINT_SCHEMA,
      selectedFiles: ['lib/a.test.ts', 'lib/b.test.ts'],
      passedFiles: ['lib/a.test.ts'],
      state: 'partial',
    });
  });

  it('refuses a checkpoint whose source identity moved', () => {
    const dir = mkdtempSync(join(tmpdir(), 'partial-task-resume-'));
    const file = partialTaskCheckpointPath(dir, ID.root, ID.taskKey);
    writePartialTaskCheckpointAtomic(file, { ...ID, selectedFiles: ['a.test.ts'], passedFiles: ['a.test.ts'], state: 'partial' });
    expect(readPartialTaskCheckpoint(file, { ...ID, sourceDigest: 'c'.repeat(64) })).toBeNull();
  });

  it('writes a distinct skip-list channel that cannot be mistaken for a pass proof', () => {
    const dir = mkdtempSync(join(tmpdir(), 'partial-task-resume-'));
    const skip = partialTaskSkipListPath(dir, { ...ID, passedFiles: ['lib/a.test.ts'] });
    const parsed = JSON.parse(readFileSync(skip.path, 'utf8'));
    expect(parsed).toEqual({
      schema: PARTIAL_TASK_SKIP_LIST_SCHEMA,
      taskKey: ID.taskKey,
      sourceCommit: ID.sourceCommit,
      sourceDigest: ID.sourceDigest,
      files: ['lib/a.test.ts'],
    });
    expect(parsed).not.toHaveProperty('runContext');
    expect(parsed).not.toHaveProperty('runnerIdentity');
  });
});

describe('independent qualification manifest preparation', () => {
  const tasks = [
    { id: 'workspace :: test', dir: 'packages/example', command: 'vitest run' },
    { id: 'root :: guard', dir: '.', command: 'node scripts/guard.mjs', isInvariantGuard: true },
  ];
  const selected = { schemaVersion: 1, kind: 'full-gate', phase: 'selection-preparation', executed: false,
    tasks: [{ ...tasks[0], runner: 'vitest', files: ['packages/example/a.test.ts'],
      selectedSpecifications: [{ testFile: 'packages/example/a.test.ts', pool: 'forks', projectName: null,
        testNamePattern: null, testIds: null, testTagsFilter: null, testLines: null }] }],
    unenumerated: [{ task: 'root :: guard', reason: 'unsupported-task-command' }], commandObligations: [] };
  const postSuite = { schemaVersion: 1, coverage: 'complete', units: [
    { id: 'post:lint', kind: 'post-suite', path: 'scripts/lint.mjs' },
  ] };
  const prepare = (overrides = {}) => preparePartialContinuationManifest({ tasks, selection: selected, postSuite, ...overrides });

  it('keeps command guards and post-suite obligations in the independently selected population', () => {
    expect(prepare()).toEqual({ status: 'ready', reason: null, operationalAcceptance: false,
      manifest: { schemaVersion: 1, units: [
        { id: 'guard:root :: guard', kind: 'guard', path: 'package.json' },
        postSuite.units[0],
        { id: 'test:packages/example/a.test.ts', kind: 'test', path: 'packages/example/a.test.ts' },
      ] } });
  });

  it('refuses omitted or foreign tasks, unknown native selection and an absent post-suite population', () => {
    expect(prepare({ tasks: tasks.slice(0, 1) })).toMatchObject({ status: 'refused', reason: 'foreign-task-selection' });
    expect(prepare({ tasks: [...tasks, { id: 'missing', dir: '.', command: 'vitest run' }] }))
      .toMatchObject({ status: 'refused', reason: 'task-selection-unmeasured' });
    expect(prepare({ selection: { ...selected, tasks: [{ ...selected.tasks[0], selectedSpecifications: [] }] } }))
      .toMatchObject({ status: 'refused', reason: 'native-specifications-unmeasured' });
    expect(prepare({ selection: { ...selected, tasks: [{ ...selected.tasks[0],
      selectedSpecifications: [{ ...selected.tasks[0]!.selectedSpecifications[0], pool: null }] }] } }))
      .toMatchObject({ status: 'refused', reason: 'native-specifications-unmeasured' });
    expect(prepare({ postSuite: undefined })).toMatchObject({ status: 'refused', reason: 'post-suite-population-unmeasured' });
    expect(prepare({ selection: { ...selected, unenumerated: [null] } }))
      .toMatchObject({ status: 'refused', reason: 'task-population-unmeasured' });
  });

  it('retains exact policy exclusions and refuses unselected, duplicate or undocumented exemptions', () => {
    const exclusion = { unitId: 'post:lint', reason: 'candidate predates check', policyRef: 'policy:pre-ratchet' };
    expect(prepare({ exclusions: [exclusion] })).toMatchObject({ status: 'ready', manifest: { units: [
      { id: 'guard:root :: guard' }, { id: 'post:lint', exclusion: { reason: exclusion.reason, policyRef: exclusion.policyRef } },
      { id: 'test:packages/example/a.test.ts' },
    ] } });
    for (const exclusions of [[{ ...exclusion, unitId: 'foreign' }], [exclusion, exclusion], [{ ...exclusion, policyRef: '' }]])
      expect(prepare({ exclusions })).toMatchObject({ status: 'refused', reason: 'exclusion-population-invalid' });
  });

  it('refuses overlapping native populations and duplicate post-suite identities', () => {
    const duplicate = { ...tasks[0], id: 'another :: test' };
    expect(prepare({ tasks: [...tasks, duplicate], selection: { ...selected,
      tasks: [...selected.tasks, { ...selected.tasks[0], ...duplicate }] } }))
      .toMatchObject({ status: 'refused', reason: 'test-population-overlapping-or-invalid' });
    expect(prepare({ postSuite: { ...postSuite, units: [...postSuite.units, ...postSuite.units] } }))
      .toMatchObject({ status: 'refused', reason: 'manifest-population-invalid' });
  });

  const commandFixture = (runner = 'command-check') => {
    const root = mkdtempSync(join(tmpdir(), 'continuation-command-'));
    const file = 'input.mjs';
    writeFileSync(join(root, file), 'export const input = 1;\n');
    const inputs = [{ path: file, sha256: createHash('sha256').update(readFileSync(join(root, file))).digest('hex') }];
    const commandTask = { id: 'command :: test', dir: '.', command: 'node input.mjs' };
    const command = { kind: 'command-check', command: commandTask.command, inputs, executed: false,
      discovery: { files: [file], inputs, executed: false, runtimeClosure: 'unmeasured', operationalAcceptance: false } };
    const entry = { ...commandTask, runner, files: [file], commandObligations: [command] };
    const selection = { ...selected, tasks: [entry],
      commandObligations: [{ ...command, task: commandTask.id }],
      unenumerated: [{ task: commandTask.id, reason: 'unexecuted-command-obligations' }] };
    return { root, file, inputs, command, entry, selection, tasks: [commandTask], postSuite };
  };

  it('keeps a discovered command and its test files as separate unsatisfied obligations', () => {
    const fixture = commandFixture();
    try {
      const prepared = preparePartialContinuationManifest(fixture);
      expect(prepared).toMatchObject({ status: 'ready', operationalAcceptance: false,
        manifest: { units: [
          { id: 'command:command :: test:0', kind: 'guard', path: 'package.json' },
          postSuite.units[0], { id: 'test:input.mjs', kind: 'test', path: 'input.mjs' },
        ] } });
      const expected = { ...ID, root: fixture.root, attemptId: 'logical-one', candidate: ID.sourceCommit,
        repairHead: null, manifest: prepared.manifest!, runContext: 'ci', runnerIdentity: 'runner' };
      const evaluation = evaluatePartialTaskContinuation({ root: fixture.root, taskKey: ID.taskKey,
        continuation: { ...expected, schemaVersion: 1, receipts: [] } }, expected);
      expect(evaluation).toMatchObject({ verdict: 'incomplete', run: [
        'command:command :: test:0', 'post:lint', 'test:input.mjs',
      ] });
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });

  it('retains Astro check inputs as a command guard without relabeling them as tests', () => {
    const fixture = commandFixture('astro-check');
    try {
      expect(preparePartialContinuationManifest(fixture)).toMatchObject({ status: 'ready', manifest: { units: [
        { id: 'command:command :: test:0', kind: 'guard' }, postSuite.units[0],
      ] } });
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });

  it('preserves an independently discovered npm lifecycle hook around native tests', () => {
    const fixture = commandFixture();
    try {
      const hook = { ...fixture.command, kind: 'npm-lifecycle', script: 'pretest' };
      const selection = { ...selected, tasks: [{ ...selected.tasks[0],
        lifecycleCommands: [{ script: hook.script, command: hook.command }], commandObligations: [hook] }],
        commandObligations: [{ ...hook, task: tasks[0]!.id }],
        unenumerated: [{ task: tasks[0]!.id, reason: 'unexecuted-lifecycle-command' }, ...selected.unenumerated] };
      expect(prepare({ root: fixture.root, selection })).toMatchObject({ status: 'ready', manifest: { units: [
        { id: 'command:workspace :: test:0', kind: 'guard' }, { id: 'guard:root :: guard' },
        postSuite.units[0], { id: 'test:packages/example/a.test.ts' },
      ] } });
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });

  it.each(['missing-root', 'missing-inputs', 'missing-discovery', 'false-execution', 'foreign-command',
    'unknown-residue', 'omitted-command', 'changed-input', 'removed-input'])(
    'refuses command preparation with %s', mutation => {
      const fixture = commandFixture();
      const originalRoot = fixture.root;
      try {
        if (mutation === 'missing-root') fixture.root = undefined as unknown as string;
        if (mutation === 'missing-inputs') fixture.command.inputs = [];
        if (mutation === 'missing-discovery') fixture.command.discovery = undefined as unknown as typeof fixture.command.discovery;
        if (mutation === 'false-execution') fixture.command.executed = true;
        if (mutation === 'foreign-command') fixture.command.command = 'node foreign.mjs';
        if (mutation === 'unknown-residue') fixture.selection.unenumerated[0]!.reason = 'unsupported-task-command';
        if (mutation === 'omitted-command') fixture.selection.commandObligations = [];
        if (mutation === 'changed-input') writeFileSync(join(fixture.root, fixture.file), 'changed');
        if (mutation === 'removed-input') rmSync(join(fixture.root, fixture.file));
        expect(preparePartialContinuationManifest(fixture)).toMatchObject({ status: 'refused', manifest: null });
      } finally { rmSync(originalRoot, { recursive: true, force: true }); }
    });
});

describe('partial-task continuation proof composition', () => {
  const units = [
    { id: 'test-a', kind: 'test', path: 'lib/a.test.ts' },
    { id: 'guard-a', kind: 'guard', path: 'scripts/guard.mjs' },
    { id: 'post-a', kind: 'post-suite', path: 'scripts/post.mjs' },
  ];
  const expected = { ...ID, attemptId: 'logical-one', candidate: ID.sourceCommit, repairHead: null,
    manifest: { schemaVersion: 1, units }, runContext: 'ci', runnerIdentity: 'proof-v3 node' };
  const receipt = (unit: typeof units[number]) => ({ unitId: unit.id, completionId: `completion:${unit.id}`,
    observedAtMs: 100, state: 'pass', worktreeDirty: false, observedCount: 1, firstAttemptVerdict: 'pass',
    proof: { recordedSha: ID.sourceCommit, executedModules: [unit.path, 'lib/shared.ts'],
      readPaths: ['fixtures/input.json'], inputsCaptured: true, opaqueReasons: [] as string[],
      runContext: 'ci', runnerIdentity: 'proof-v3 node' } });
  const checkpoint = () => ({ ...ID, selectedFiles: ['lib/a.test.ts'], passedFiles: [], state: 'partial',
    continuation: { schemaVersion: 1, attemptId: expected.attemptId, candidate: expected.candidate,
      repairHead: null, manifest: structuredClone(expected.manifest), receipts: units.map(receipt) } });
  const evaluate = (value = checkpoint(), overrides = {}, changed: string[] | null = []) =>
    evaluatePartialTaskContinuation(value, { ...expected, ...overrides }, { changedBetween: () => changed });

  it('recovers the same pending population from the durable checkpoint in a fresh read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'partial-continuation-'));
    const path = partialTaskCheckpointPath(dir, ID.root, ID.taskKey);
    const saved = checkpoint();
    saved.continuation.receipts = saved.continuation.receipts.filter(row => row.unitId !== 'post-a');
    writePartialTaskCheckpointAtomic(path, saved);
    const recovered = readPartialTaskCheckpoint(path, ID);
    expect(evaluate(recovered)).toMatchObject({ status: 'ready', run: ['post-a'],
      reused: ['guard-a', 'test-a'], verdict: 'incomplete', counts: { selected: 3, passed: 2, pending: 1 } });
  });

  it('composes a green verdict only from valid proofs of the complete selected population', () => {
    expect(evaluate()).toMatchObject({ verdict: 'green', run: [], reused: ['guard-a', 'post-a', 'test-a'],
      counts: { selected: 3, required: 3, passed: 3, pending: 0 } });
  });

  it.each(units)('retains a missing or invalid $kind as pending rather than green', unit => {
    const missing = checkpoint();
    missing.continuation.receipts = missing.continuation.receipts.filter(row => row.unitId !== unit.id);
    expect(evaluate(missing)).toMatchObject({ verdict: 'incomplete', run: [unit.id] });
    const opaque = checkpoint();
    opaque.continuation.receipts.find(row => row.unitId === unit.id)!.proof.opaqueReasons = ['socket'];
    expect(evaluate(opaque)).toMatchObject({ verdict: 'incomplete', run: [unit.id] });
  });

  it.each(['attemptId', 'candidate', 'repairHead'] as const)('refuses a moved %s', key => {
    expect(evaluate(checkpoint(), { [key]: 'different' })).toMatchObject({ status: 'refused', verdict: 'incomplete' });
  });

  it('refuses changed selection, duplicate receipts and foreign receipt identities', () => {
    expect(evaluate(checkpoint(), { manifest: { schemaVersion: 1, units: units.slice(1) } })).toMatchObject({
      status: 'refused', reason: 'manifest-mismatch' });
    const duplicate = checkpoint();
    duplicate.continuation.receipts.push(receipt(units[0]!));
    expect(evaluate(duplicate)).toMatchObject({ status: 'refused', reason: 'receipt-population-invalid' });
    const foreign = checkpoint();
    foreign.continuation.receipts[0]!.unitId = 'foreign';
    expect(evaluate(foreign)).toMatchObject({ status: 'refused', verdict: 'incomplete' });
    const aliased = checkpoint();
    aliased.continuation.receipts[1]!.completionId = aliased.continuation.receipts[0]!.completionId;
    expect(evaluate(aliased)).toMatchObject({ status: 'refused', reason: 'receipt-population-invalid' });
  });

  it('invalidates relevant source and input changes while retaining an unrelated-change control', () => {
    const newer = 'c'.repeat(40);
    expect(evaluate(checkpoint(), { sourceCommit: newer }, ['docs/unrelated.md'])).toMatchObject({ verdict: 'green', run: [] });
    for (const changed of ['lib/shared.ts', 'fixtures/input.json', 'package-lock.json'])
      expect(evaluate(checkpoint(), { sourceCommit: newer }, [changed])).toMatchObject({ verdict: 'incomplete',
        run: ['guard-a', 'post-a', 'test-a'], reused: [] });
    expect(evaluate(checkpoint(), { sourceCommit: newer }, null)).toMatchObject({ verdict: 'incomplete', reused: [] });
  });

  it('requires matching runner and context, captured inputs and a clean first-attempt pass', () => {
    for (const overrides of [{ runnerIdentity: 'different' }, { runContext: 'different' }])
      expect(evaluate(checkpoint(), overrides)).toMatchObject({ verdict: 'incomplete', reused: [] });
    for (const corrupt of [
      (row: ReturnType<typeof receipt>) => { row.proof.inputsCaptured = false; },
      (row: ReturnType<typeof receipt>) => { row.worktreeDirty = true; },
      (row: ReturnType<typeof receipt>) => { row.observedCount = 0; },
      (row: ReturnType<typeof receipt>) => { row.firstAttemptVerdict = 'fail'; },
    ]) {
      const value = checkpoint();
      corrupt(value.continuation.receipts[0]!);
      expect(evaluate(value)).toMatchObject({ verdict: 'incomplete', run: ['test-a'] });
    }
  });

  it('retains failure and infrastructure outcomes and retries them only under an explicit policy', () => {
    const value = checkpoint();
    value.continuation.receipts[0]!.state = 'fail';
    value.continuation.receipts[1]!.state = 'infra';
    expect(evaluate(value)).toMatchObject({ verdict: 'red', run: [], reused: ['post-a'],
      retainedFailures: ['test-a'], infrastructure: ['guard-a'] });
    expect(evaluate(value, { retryStates: ['fail', 'infra'] })).toMatchObject({ verdict: 'red',
      run: ['guard-a', 'test-a'], reused: ['post-a'] });
  });

  it('requires exact documented exclusions and refuses empty or entirely excluded success', () => {
    const value = checkpoint();
    const manifest = { schemaVersion: 1, units: units.map(unit => ({ ...unit,
      exclusion: { policyRef: 'policy:owned-exclusion', reason: 'not applicable to this candidate' } })) };
    value.continuation.manifest = manifest;
    expect(evaluate(value, { manifest })).toMatchObject({ verdict: 'incomplete', run: [], reused: [],
      excluded: ['guard-a', 'post-a', 'test-a'] });
    expect(evaluate(value)).toMatchObject({ status: 'refused', reason: 'manifest-mismatch' });
    expect(evaluate(checkpoint(), { manifest: { schemaVersion: 1, units: [] } })).toMatchObject({ status: 'refused' });
  });

  it('detects a torn or modified durable continuation rather than recovering its pass names', () => {
    const dir = mkdtempSync(join(tmpdir(), 'partial-continuation-'));
    const path = partialTaskCheckpointPath(dir, ID.root, ID.taskKey);
    writePartialTaskCheckpointAtomic(path, checkpoint());
    const text = readFileSync(path, 'utf8');
    // A persisted envelope is validated before any legacy passedFiles field is returned.
    const parsed = JSON.parse(text);
    parsed.continuation.receipts[0].proof.inputsCaptured = false;
    writeFileSync(path, JSON.stringify(parsed));
    expect(readPartialTaskCheckpoint(path, ID)).toBeNull();
    writeFileSync(path, text.slice(0, -12));
    expect(readPartialTaskCheckpoint(path, ID)).toBeNull();
  });
});

describe('native durable continuation outcomes', () => {
  const selectedSpecifications = [{ testFile: 'lib/a.test.ts', projectName: null, pool: 'forks',
    testNamePattern: null, testLines: null, testIds: null, testTagsFilter: null }];
  const manifest = { schemaVersion: 1, units: [{ id: 'a', kind: 'test', path: 'lib/a.test.ts' },
    { id: 'guard', kind: 'guard', path: 'scripts/guard.mjs' }] };
  const expected = { ...ID, attemptId: 'attempt-one', workspaceName: '@repo/tests', manifest, selectedSpecifications };
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const snapshot = () => ({ workspaceName: expected.workspaceName, recordedSha: ID.sourceCommit, worktreeDirty: false,
    completionCheckpoint: { schemaVersion: 1, qualificationAttemptId: expected.attemptId,
      runGroupId: 'physical-run-one', runContext: 'ci', runnerIdentity: 'proof-v3 node', state: 'partial', noPersist: true },
    configSources: { status: 'unchanged' },
    rows: [{ testFile: 'lib/a.test.ts', executedModules: ['lib/a.test.ts'], inputsCaptured: true,
      readPaths: ['/repo/fixtures/input.json'], opaqueReasons: [] as string[] }],
    nativeRun: { schemaVersion: 'native-vitest-run-v1', startedAtMs: 100, gaps: [] as string[], finishedAtMs: null as number | null,
      reason: null as string | null, unhandledErrorCount: null as number | null, modulePopulationMatched: false,
      selectedManifest: { specifications: structuredClone(selectedSpecifications), sha256: hash(selectedSpecifications) },
      files: [{ testFile: 'lib/a.test.ts', completionId: 'completion-a', observedAtMs: 123, state: 'passed',
        firstAttemptVerdict: 'pass', cases: [{ status: 'pass' }],
        proof: { sourceEvidence: { schemaVersion: 'vite-collected-source-evidence-v1', status: 'stable',
          sources: [{ path: 'lib/a.test.ts', sha256: 'a'.repeat(64), currentSha256: 'a'.repeat(64) }], reasons: [] } } }] } });
  const read = (value = snapshot(), overrides = {}, classify = true, producerOverrides: Record<string, unknown> | null = null) => {
    const dir = mkdtempSync(join(tmpdir(), 'native-continuation-'));
    const file = join(dir, 'out.json');
    writeFileSync(file, JSON.stringify({ ...value, completionIntegrity: { schemaVersion: 1, sha256: hash(value) } }));
    try {
      const producer = producerOverrides === null ? null : registerPartialNativeProducer(file, {
        attemptId: expected.attemptId, runGroupId: 'physical-run-one', root: ID.root, taskKey: ID.taskKey,
        workspaceName: expected.workspaceName, sourceCommit: ID.sourceCommit, registeredAtMs: 50,
        command: { cmd: '/node', argv: ['vitest', 'run'], cwd: ID.root }, selectedSpecifications,
        ...producerOverrides,
      }, { TEST_SECRET: 'credential-never-written' });
      return readPartialNativeCompletion(file, { ...expected, ...overrides,
        ...(producer ? { producerPath: producer.path } : {}) }, classify
        ? { classifyReadPaths: () => ({ readPaths: ['fixtures/input.json'], opaqueReasons: [] }) } : {});
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };

  it('requires a pre-start producer with the exact independently selected native specifications', () => {
    expect(read(snapshot(), {}, true, {})).toMatchObject({ status: 'ready' });
    for (const producer of [
      { attemptId: 'foreign' }, { runGroupId: 'foreign' }, { sourceCommit: 'foreign' },
      { registeredAtMs: 101 }, { taskKey: 'foreign' },
      { selectedSpecifications: [{ ...selectedSpecifications[0], testNamePattern: 'one case' }] },
    ]) expect(read(snapshot(), {}, true, producer)).toMatchObject({ status: 'refused', reason: 'native-producer-mismatch' });
  });

  it('accepts selection recovered with JSONB key ordering while still checking the native manifest digest', () => {
    const recovered = selectedSpecifications.map(spec => Object.fromEntries(Object.entries(spec).reverse()));
    expect(read(snapshot(), { selectedSpecifications: recovered }, true, {})).toMatchObject({ status: 'ready' });
    const damaged = snapshot();
    damaged.nativeRun.selectedManifest.sha256 = '0'.repeat(64);
    expect(read(damaged, { selectedSpecifications: recovered }, true, {}))
      .toMatchObject({ status: 'refused', reason: 'native-selection-mismatch' });
  });

  it('seals immutable enrollment without persisting environment secrets and rejects altered identity', () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-producer-')), out = join(dir, 'out.json');
    const registration = { ...ID, attemptId: expected.attemptId, runGroupId: 'run-one',
      workspaceName: expected.workspaceName, registeredAtMs: 50, selectedSpecifications,
      command: { cmd: '/node', argv: ['vitest', 'run'], cwd: ID.root } };
    try {
      const saved = registerPartialNativeProducer(out, registration, { TOKEN: 'credential-never-written' });
      expect(readFileSync(saved.path, 'utf8')).not.toContain('credential-never-written');
      expect(readPartialNativeProducer(saved.path, { ...ID, command: registration.command })).toEqual(saved.producer);
      expect(readPartialNativeProducer(saved.path, { environmentDigest: '0'.repeat(64) })).toBeNull();
      expect(readPartialNativeProducer(saved.path, { command: { ...registration.command, argv: ['other'] } })).toBeNull();
      expect(() => registerPartialNativeProducer(out, { ...registration, runGroupId: 'overwrite' }, {})).toThrow();
      expect(readPartialNativeProducer(saved.path, { runGroupId: 'run-one' })).not.toBeNull();
      const altered = JSON.parse(readFileSync(saved.path, 'utf8')); altered.taskKey = 'foreign';
      writeFileSync(saved.path, JSON.stringify(altered));
      expect(readPartialNativeProducer(saved.path, {})).toBeNull();
      expect(() => registerPartialNativeProducer(join(dir, 'duplicate.json'), {
        ...registration, selectedSpecifications: [...selectedSpecifications, ...selectedSpecifications],
      }, {})).toThrow('native-producer-registration-invalid');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('recovers a committed module before the terminal hook and composes its proof with pending guards', () => {
    const recovered = read();
    expect(recovered).toMatchObject({ status: 'ready', receipts: [{ unitId: 'a', completionId: 'completion-a',
      state: 'pass', observedCount: 1, proof: { opaqueReasons: [], inputsCaptured: true } }],
      origin: { runGroupId: 'physical-run-one', startedAtMs: 100, sourceCommit: ID.sourceCommit } });
    const checkpoint = { ...ID, continuation: { schemaVersion: 1, attemptId: expected.attemptId,
      candidate: ID.sourceCommit, repairHead: null, manifest, receipts: recovered.receipts } };
    expect(evaluatePartialTaskContinuation(checkpoint, { ...expected, candidate: ID.sourceCommit,
      repairHead: null, runContext: 'ci', runnerIdentity: 'proof-v3 node' })).toMatchObject({
      verdict: 'incomplete', reused: ['a'], run: ['guard'] });
  });

  it('requires independent exact selection including case filters and attempt identity', () => {
    expect(read(snapshot(), { attemptId: 'other' })).toMatchObject({ status: 'refused' });
    const filtered = snapshot();
    filtered.nativeRun.selectedManifest.specifications[0]!.testNamePattern = 'one case' as never;
    filtered.nativeRun.selectedManifest.sha256 = hash(filtered.nativeRun.selectedManifest.specifications);
    expect(read(filtered)).toMatchObject({ status: 'refused', reason: 'native-selection-mismatch' });
  });

  it('retains failure and infrastructure outcomes without promoting them to passes', () => {
    const failed = snapshot();
    failed.nativeRun.files[0]!.state = 'failed';
    expect(read(failed)).toMatchObject({ status: 'ready', receipts: [{ state: 'fail' }] });
    failed.nativeRun.files[0]!.state = 'error';
    expect(read(failed)).toMatchObject({ status: 'ready', receipts: [{ state: 'infra' }] });
  });

  it('never reuses unclassified, opaque, unstable or terminal-error proof', () => {
    expect(read(snapshot(), {}, false).receipts[0]!.proof.inputsCaptured).toBe(false);
    for (const damage of [
      (v: ReturnType<typeof snapshot>) => { v.nativeRun.files[0]!.proof.sourceEvidence.status = 'unknown'; },
      (v: ReturnType<typeof snapshot>) => { v.nativeRun.files[0]!.cases = []; },
      (v: ReturnType<typeof snapshot>) => { v.rows[0]!.opaqueReasons = ['socket']; },
      (v: ReturnType<typeof snapshot>) => { v.nativeRun.finishedAtMs = 200; v.nativeRun.reason = 'failed'; v.nativeRun.unhandledErrorCount = 1; },
    ]) {
      const value = snapshot(); damage(value);
      expect(read(value).receipts[0]!.proof.opaqueReasons.length).toBeGreaterThan(0);
    }
    const duplicate = snapshot(); duplicate.nativeRun.files.push(duplicate.nativeRun.files[0]!);
    expect(read(duplicate)).toMatchObject({ status: 'refused', reason: 'native-receipt-population-invalid' });
  });

  it('refuses a torn or altered snapshot even if its pass file names look valid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-corruption-')), file = join(dir, 'out.json');
    const value = snapshot();
    writeFileSync(file, JSON.stringify({ ...value, completionIntegrity: { schemaVersion: 1, sha256: '0'.repeat(64) } }));
    expect(readPartialNativeCompletion(file, expected)).toMatchObject({ status: 'refused', reason: 'snapshot-integrity-invalid' });
    writeFileSync(file, '{');
    expect(readPartialNativeCompletion(file, expected)).toMatchObject({ status: 'refused', reason: 'snapshot-unreadable' });
  });
});
