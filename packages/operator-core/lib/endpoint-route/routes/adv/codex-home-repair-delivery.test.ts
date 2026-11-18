import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { REPAIR_SOURCE_PATHS, REPAIR_REQUIRED_CASES, REPAIR_PREREQUISITE_CASE, REPAIR_FINAL_CASE,
  repairDeliverySubject, validateRepairDelivery, runLiveRepairDelivery, normalizeRepairServingRuntime,
  type RepairDeliveryPacket, type RepairDeliveryReads } from './codex-home-repair-delivery';

const at = (second: number) => new Date(Date.UTC(2026, 10, 18, 0, 0, second)).toISOString();
const started = at(20);
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
function fixture() {
  const source = new Map(REPAIR_SOURCE_PATHS.map(path => [path, Buffer.from('accepted:' + path)]));
  const pin = (id: number) => ({ id, specId: 'REPAIR-DELIVERY', specRevision: 2,
    specFingerprint: 'a'.repeat(64), sourceFingerprint: 'source:frozen', environmentFingerprint: 'environment:both' });
  const sourceFiles = REPAIR_SOURCE_PATHS.map(path => {
    const bytes = source.get(path)!;
    return { path, sha256: digest(bytes.toString()), gitBlob: createHash('sha1')
      .update('blob ' + bytes.length + '\0').update(bytes).digest('hex') };
  });
  const runtime = (host: 'port-3170' | 'port-3070') => ({ host, processId: 'linux:boot:' + host,
    buildSha: 'b'.repeat(40), artifact: { status: 'measured' as const, sourceSha: 'b'.repeat(40),
      bundleSha256: digest(host), manifestSha256: digest('manifest:' + host),
      sourceBlobs: Object.fromEntries(sourceFiles.map(f => [f.path, f.gitBlob])), evidenceRef: 'artifact:' + host } });
  const packet: RepairDeliveryPacket = { schemaVersion: 1, workspaceId: 'fixture-workspace', harnessSlug: 'papercusp',
    planSlug: 'codex-home-repair-receipt-lifecycle-2026-11-17', implementerId: 'implementer',
    acceptedCommit: 'c'.repeat(40), frozenAt: at(10), sourceFiles,
    runtimes: { 'staging-operator': runtime('port-3170'), 'release-operator': runtime('port-3070') },
    operational: pin(1), tests: [pin(2), pin(3)], independentVerificationId: 4 };
  const row = (id: number, evidenceKind: string) => ({ ...pin(id), planSlug: packet.planSlug,
    workItemId: 'WI-1', evidenceKind, evidenceRef: 'fixture:' + id,
    fingerprints: { sourceFingerprint: pin(id).sourceFingerprint, environmentFingerprint: pin(id).environmentFingerprint },
    currentness: { overall: 'current', provenance: 'server-measured' }, createdBy: 'implementer',
    createdAt: at(5), observedAt: at(5), details: { codexHomeRepairDelivery: structuredClone(repairDeliverySubject(packet)) } });
  const op = row(1, 'operational');
  const tests = REPAIR_REQUIRED_CASES.map((test, index) => ({ ...row(index + 2, 'test'), testRunId: index + 100,
    testRunProvenance: { filePath: test.file, source: 'local', worktreeDirty: false, commitSha: packet.acceptedCommit },
    testRunExecution: { status: 'pass', passed: 1, failed: 0, skipped: 0, collectionFailed: false,
      filePath: test.file, testLayer: test.layer, startedAt: at(1), finishedAt: at(4),
      cases: [{ caseKey: test.testName as string, occurrence: 1, status: 'pass' }] } }));
  const iv = { ...row(4, 'independent-verification'), verifiesBindingId: 1, createdBy: 'independent',
    createdAt: at(15), observedAt: at(15) };
  const rows = [op, ...tests, iv];
  const bindings = vi.fn(async (_p: RepairDeliveryPacket, ids: number[]) => rows.filter(r => ids.includes(r.id)));
  const committedBytes = vi.fn(async (_commit: string, path: string) => source.get(path as typeof REPAIR_SOURCE_PATHS[number])!);
  const runtimeRead = vi.fn(async (plane: keyof typeof packet.runtimes, _commit: string, path: string, sha: string) => ({
    acceptedSource: { expectedSha256: sha, observedSha256: sha, matches: true, runtimeContainment: { [plane]: true } },
    observingRuntime: { ...structuredClone(packet.runtimes[plane]), artifact: { ...packet.runtimes[plane].artifact,
      sourceBlobs: { [path]: packet.runtimes[plane].artifact.sourceBlobs[path] } } },
  }));
  const related = vi.fn(async (a: string, b: string) => a === b);
  const reads: RepairDeliveryReads = { bindings, committedBytes, runtime: runtimeRead, related };
  return { packet, rows, op, tests, iv, reads, bindings, committedBytes, runtimeRead, related };
}
type Fixture = ReturnType<typeof fixture>;
const run = (f: Fixture, mode: 'prerequisite' | 'final' = 'prerequisite') => validateRepairDelivery(f.packet, mode, f.reads, started);

it('accepts a complete canonical repair delivery packet', async () => {
  const f = fixture();
  expect(await run(f)).toMatchObject({ ok: true, bindingIds: [1, 2, 3] });
  expect(f.bindings).toHaveBeenCalledExactlyOnceWith(f.packet, [1, 2, 3]);
  for (const source of f.packet.sourceFiles) {
    expect(f.committedBytes).toHaveBeenCalledWith(f.packet.acceptedCommit, source.path);
    for (const plane of ['staging-operator', 'release-operator'])
      expect(f.runtimeRead).toHaveBeenCalledWith(plane, f.packet.acceptedCommit, source.path, source.sha256);
  }
  const observed = f.runtimeRead.getMockImplementation()!;
  f.runtimeRead.mockImplementation(async (...args) => {
    const value = await observed(...args), runtime = value.observingRuntime;
    return { ...value, observingRuntime: normalizeRepairServingRuntime({ ...runtime, buildSha: runtime.buildSha.slice(0, 11) }) };
  });
  expect(await run(f)).toMatchObject({ ok: true });
});

it('rejects substituted canonical receipt source artifact runtime and test identities', async () => {
  const mutations: Array<(f: Fixture) => void> = [
    f => { f.op.specId = 'other-clause'; }, f => { f.op.specRevision++; },
    f => { f.op.fingerprints.sourceFingerprint = 'other-source'; },
    f => { f.op.fingerprints.environmentFingerprint = 'other-environment'; },
    f => { f.op.planSlug = 'another-plan' as typeof f.op.planSlug; },
    f => { f.packet.workspaceId = 'other-workspace'; }, f => { f.packet.harnessSlug = 'other-harness'; },
    f => { f.packet.sourceFiles[0]!.sha256 = 'd'.repeat(64); },
    f => { f.packet.sourceFiles[0]!.gitBlob = 'd'.repeat(40); },
    f => { f.packet.sourceFiles[1] = f.packet.sourceFiles[0]!; },
    f => { f.packet.runtimes['release-operator'].artifact.bundleSha256 = 'd'.repeat(64); },
    f => { f.packet.runtimes['staging-operator'].processId = 'other-process'; },
    f => { f.tests[0]!.testRunProvenance.commitSha = 'd'.repeat(40); },
    f => { f.tests[0]!.testRunProvenance.worktreeDirty = true; },
    f => { f.tests[0]!.testRunExecution.filePath = 'another.test.ts'; },
    f => { f.tests[0]!.testRunExecution.testLayer = 'integration'; },
    f => { f.tests[0]!.testRunExecution.cases[0]!.caseKey = 'another passing case'; },
    f => { f.tests[0]!.testRunExecution.cases[0]!.occurrence = 2; },
    f => {
      const observed = f.runtimeRead.getMockImplementation()!;
      f.runtimeRead.mockImplementation(async (...args) => {
        const value = await observed(...args);
        // Deliberately remove the observed identity at the untrusted runtime boundary.
        Reflect.deleteProperty(value, 'observingRuntime');
        return value;
      });
    },
  ];
  for (const [index, change] of mutations.entries()) {
    const f = fixture(); change(f);
    expect(await run(f), 'isolated substitution ' + index).toMatchObject({ ok: false });
  }
  // Keep the packet, canonical operational row and source fixed. Substitute
  // just the actually observed runtime so no stale subject can explain refusal.
  for (const plane of ['staging-operator', 'release-operator'] as const) {
    for (const field of ['process', 'host', 'bundle', 'manifest', 'source', 'blob', 'containment']) {
      const f = fixture(), observed = f.runtimeRead.getMockImplementation()!;
      f.runtimeRead.mockImplementation(async (...args) => {
        const value = await observed(...args);
        if (args[0] !== plane) return value;
        if (field === 'process') value.observingRuntime.processId = 'other-process';
        if (field === 'host') value.observingRuntime.host = plane === 'staging-operator' ? 'port-3070' : 'port-3170';
        if (field === 'bundle') value.observingRuntime.artifact.bundleSha256 = 'd'.repeat(64);
        if (field === 'manifest') value.observingRuntime.artifact.manifestSha256 = 'd'.repeat(64);
        if (field === 'source') value.observingRuntime.artifact.sourceSha = 'd'.repeat(40);
        if (field === 'blob') value.observingRuntime.artifact.sourceBlobs[args[2]] = 'd'.repeat(40);
        if (field === 'containment') value.acceptedSource.runtimeContainment[plane] = false;
        return value;
      });
      expect(await run(f), 'isolated observed runtime ' + plane + ' ' + field).toMatchObject({ ok: false,
        reason: 'runtime ' + (field === 'containment' ? 'accepted containment: ' : 'artifact identity: ') + plane });
    }
  }
  expect(await run(fixture())).toMatchObject({ ok: true });
  for (const plane of ['staging-operator', 'release-operator'] as const) {
    for (const length of [1, 7, 39, 40]) {
      const f = fixture(), runtime = f.packet.runtimes[plane];
      runtime.buildSha = length === 40 ? 'd'.repeat(40) : runtime.artifact.sourceSha.slice(0, length);
      // Keep the canonical frozen subject and observed runtime synchronized so
      // only the build/source identity relation can explain the refusal.
      f.op.details.codexHomeRepairDelivery = structuredClone(repairDeliverySubject(f.packet));
      expect(await run(f), plane + ' build length ' + length).toMatchObject({ ok: false });
    }
    for (const invalid of ['mismatch', 'null', 'empty', 'one-character', 'missing-artifact', 'unmeasured', 'short-source']) {
      const runtime = fixture().packet.runtimes[plane];
      const raw: { host: string; processId: string; buildSha: unknown; artifact?: unknown } = structuredClone(runtime);
      raw.buildSha = runtime.buildSha.slice(0, 11);
      if (invalid === 'mismatch') raw.buildSha = 'd'.repeat(11);
      if (invalid === 'null') raw.buildSha = null;
      if (invalid === 'empty') raw.buildSha = '';
      if (invalid === 'one-character') raw.buildSha = runtime.buildSha.slice(0, 1);
      if (invalid === 'missing-artifact') Reflect.deleteProperty(raw, 'artifact');
      if (invalid === 'unmeasured') raw.artifact = { ...runtime.artifact, status: 'unmeasured' };
      if (invalid === 'short-source') raw.artifact = { ...runtime.artifact, sourceSha: 'b'.repeat(39) };
      expect(() => normalizeRepairServingRuntime(raw), plane + ' raw observation ' + invalid).toThrow();
    }
  }
});

it('fails closed for missing unavailable failed absent skipped or unexecuted delivery evidence', async () => {
  const changes: Array<(f: Fixture) => void> = [
    f => { f.bindings.mockResolvedValue([]); }, f => { f.bindings.mockRejectedValue(new Error('ledger unavailable')); },
    f => { f.committedBytes.mockRejectedValue(new Error('immutable source unavailable')); },
    f => { f.runtimeRead.mockRejectedValue(new Error('runtime unavailable')); },
    f => { f.op.currentness.overall = 'stale'; }, f => { f.op.currentness.provenance = 'caller'; },
    f => { f.tests[0]!.testRunExecution.status = 'fail'; },
    f => { f.tests[0]!.testRunExecution.failed = 1; },
    f => { f.tests[0]!.testRunExecution.passed = 0; f.tests[0]!.testRunExecution.skipped = 1;
      f.tests[0]!.testRunExecution.cases[0]!.status = 'skip'; },
    f => { f.tests[0]!.testRunExecution.cases = []; },
    f => { f.tests[0]!.testRunExecution.collectionFailed = true; },
    f => { f.tests[0]!.testRunId = 0; },
  ];
  for (const [index, change] of changes.entries()) {
    const f = fixture(); change(f);
    expect(await run(f), 'isolated missing proof ' + index).toMatchObject({ ok: false });
  }
  for (const plane of ['staging-operator', 'release-operator'] as const) {
    const f = fixture(), observed = f.runtimeRead.getMockImplementation()!;
    f.runtimeRead.mockImplementation(async (...args) => {
      if (args[0] === plane) throw new Error('runtime unavailable: ' + plane);
      return observed(...args);
    });
    expect(await run(f), 'isolated unavailable runtime ' + plane)
      .toMatchObject({ ok: false, reason: 'runtime unavailable: ' + plane });
  }
  expect(await validateRepairDelivery({}, 'prerequisite', fixture().reads, started)).toMatchObject({ ok: false });
  vi.stubEnv('PAPERCUSP_CODEX_HOME_REPAIR_LIVE', '');
  try { await expect(runLiveRepairDelivery('prerequisite')).rejects.toThrow('explicit live admission required'); }
  finally { vi.unstubAllEnvs(); }
});

it('rejects self-referential and future detector receipts', async () => {
  for (const title of [REPAIR_PREREQUISITE_CASE, REPAIR_FINAL_CASE]) {
    const f = fixture(); f.tests[0]!.testRunExecution.cases[0]!.caseKey = title;
    expect(await run(f)).toMatchObject({ ok: false, reason: 'detector cannot cite itself' });
  }
  for (const field of ['createdAt', 'observedAt'] as const) {
    const f = fixture(); f.tests[0]![field] = started;
    expect(await run(f)).toMatchObject({ ok: false, reason: 'self-referential or future detector receipt' });
  }
  const f = fixture(); f.packet.frozenAt = at(21);
  expect(await run(f)).toMatchObject({ ok: false, reason: 'packet must precede detector' });
});

it('pins accepted delivery bytes when the working tree changes', async () => {
  const f = fixture();
  let mutableBytes = Buffer.from('before-edit');
  expect(await run(f)).toMatchObject({ ok: true });
  mutableBytes = Buffer.from('after-edit');
  expect(await run(f)).toMatchObject({ ok: true });
  expect(f.committedBytes.mock.calls.every(([sha]) => sha === f.packet.acceptedCommit)).toBe(true);
  // A reader substituted with mutable bytes cannot satisfy the frozen digest.
  f.committedBytes.mockResolvedValue(mutableBytes);
  expect(await run(f)).toMatchObject({ ok: false, reason: expect.stringContaining('accepted source bytes') });
});

it('accepts independent verification of the exact frozen operational delivery binding', async () => {
  const f = fixture();
  expect(await run(f, 'final')).toMatchObject({ ok: true, bindingIds: [1, 2, 3, 4] });
  expect(f.related).toHaveBeenCalledWith('independent', 'implementer', f.packet.workspaceId);
});

async function verifyCitedAuthorLineage() {
  const independent = fixture();
  independent.tests.forEach((row, index) => { row.createdBy = 'test-author:' + index; });
  expect(await run(independent, 'final')).toMatchObject({ ok: true });
  for (const author of new Set([independent.packet.implementerId, independent.op.createdBy,
    ...independent.tests.map(row => row.createdBy)])) {
    expect(independent.related).toHaveBeenCalledWith(independent.iv.createdBy, author, independent.packet.workspaceId);
  }
  expect(independent.related).toHaveBeenCalledTimes(3);
  for (const index of [0, 1]) {
    for (const unavailable of [false, true]) {
      const f = fixture(), citedAuthor = 'cited-test-author';
      f.tests[index]!.createdBy = citedAuthor;
      f.related.mockImplementation(async (first, second) => {
        if (second === citedAuthor) {
          if (unavailable) throw new Error('cited-author lineage unavailable');
          return true;
        }
        return first === second;
      });
      expect(await run(f, 'final'), 'test author ' + index + ' unavailable=' + unavailable)
        .toMatchObject({ ok: false, reason: unavailable ? 'cited-author lineage unavailable' : 'IV related lineage' });
    }
  }
}

it('rejects independent verification of substituted test operational packet clause revision runtime lineage or stale bindings', async () => {
  const changes: Array<(f: Fixture) => void> = [
    f => { f.iv.verifiesBindingId = f.tests[0]!.id; }, f => { f.iv.verifiesBindingId = 999; },
    f => { f.iv.evidenceKind = 'test'; }, f => { f.iv.specId = 'other-clause'; },
    f => { f.iv.specRevision++; }, f => { f.iv.specFingerprint = 'd'.repeat(64); },
    f => { f.iv.fingerprints.sourceFingerprint = 'other-source'; },
    f => { f.iv.fingerprints.environmentFingerprint = 'other-environment'; },
    f => { f.iv.details.codexHomeRepairDelivery.runtimes['release-operator'].processId = 'other-runtime'; },
    f => { f.iv.details.codexHomeRepairDelivery.acceptedCommit = 'd'.repeat(40); },
    f => { f.iv.currentness.overall = 'stale'; }, f => { f.iv.currentness.overall = 'unknown'; },
    f => { f.iv.createdBy = 'implementer'; }, f => { f.related.mockResolvedValue(true); },
    f => { f.related.mockRejectedValue(new Error('lineage unavailable')); },
    f => { f.iv.observedAt = f.op.observedAt; }, f => { f.iv.createdAt = started; },
    f => { delete f.packet.independentVerificationId; },
    f => { f.bindings.mockImplementation(async (_p, ids) => f.rows.filter(r => ids.includes(r.id) && r.id !== f.iv.id)); },
  ];
  for (const [index, change] of changes.entries()) {
    const f = fixture(); change(f);
    expect(await run(f, 'final'), 'isolated IV substitution ' + index).toMatchObject({ ok: false });
  }
  await verifyCitedAuthorLineage();
});

it('requires the exact final live case at final-item closure while prerequisite proof remains passing', async () => {
  // Exercise completion's actual owned selector and adequacy evaluator, rather
  // than asserting a second, test-only implementation of its closure rule.
  const [{ selectSourceBarTestRequirements }, { evaluateSpecTestAdequacy }] = await Promise.all([
    import('../../../agent-tools/plans/source-bar-test-requirements'), import('../../../agent-tools/plans/spec-test-adequacy'),
  ]);
  const finalFile = 'packages/operator-core/lib/endpoint-route/routes/adv/codex-home-repair-final-delivery.live.e2e.test.ts';
  const prerequisite = REPAIR_REQUIRED_CASES[0];
  const check = { kind: 'tests' as const, files: [prerequisite.file, finalFile],
    filesByPlanItem: { 'P-003': [prerequisite.file], 'P-002': [finalFile] },
    cases: [{ file: prerequisite.file, testName: prerequisite.testName }, { file: finalFile, testName: REPAIR_FINAL_CASE }] };
  const f = fixture();
  const grade = (owner: string, file: string, title: string, state = 'pass') => {
    const specId = 'AUTO-BAR-R-4-' + owner;
    const testLayer = file === finalFile ? 'e2e' : prerequisite.layer;
    const clause = { planSlug: f.packet.planSlug, specId, sourceValId: specId, currentRevision: 1, revision: 1,
      planItemId: owner, behavior: 'The exact delivery case passes.', behaviorClass: 'happy-path', requiredEvidence: [],
      requiredTestLayers: [testLayer], mutationRequired: false, lifecycleStatus: 'active', supersedes: null,
      exemption: null, falsifier: null, contentHash: 'a'.repeat(64), createdBy: 'implementer', createdAt: at(1),
      acceptedBy: 'reviewer', acceptedAt: at(2), acceptanceRef: 'D-007' };
    const row = { ...structuredClone(f.tests[0]!), specId, specRevision: 1, specFingerprint: clause.contentHash,
      evidenceRef: file, details: { adequacy: { testCases: [title], targeted: specId, testLayer,
        pathReachable: state === 'pass', collected: true,
        executed: state !== 'unexecuted', skipped: state === 'skip', outcome: state === 'pass' ? 'passed' : state } },
      currentness: { ...f.tests[0]!.currentness, comparisonSupplied: true,
        dimensions: Object.fromEntries(['spec','source','test','fixture','rubric','environment','coverageEvidence','testRun'].map(k => [k, 'current'])),
        staleReasons: [], unknownReasons: [] },
      testRunProvenance: { ...f.tests[0]!.testRunProvenance, filePath: file, framework: 'vitest', mutationPhase: null },
      testRunExecution: { ...f.tests[0]!.testRunExecution, status: state === 'fail' ? 'fail' : 'pass',
        passed: state === 'pass' ? 1 : 0, failed: state === 'fail' ? 1 : 0, skipped: state === 'skip' ? 1 : 0,
        filePath: file, testLayer, passedCaseTitles: state === 'pass' ? [title] : [],
        cases: state === 'unexecuted' ? [] : [{ caseKey: title, occurrence: 1,
          status: state === 'fail' ? 'fail' : state === 'skip' ? 'skip' : 'pass' }] } };
    const requirements = { status: 'required' as const, ...selectSourceBarTestRequirements(check, owner) };
    const result = evaluateSpecTestAdequacy({ clause: clause as Parameters<typeof evaluateSpecTestAdequacy>[0]['clause'],
      evidence: [row] as unknown as Parameters<typeof evaluateSpecTestAdequacy>[0]['evidence'],
      classRef: 'plan-class-bugfix', sourceBarTestRequirements: requirements });
    return result.ratings['correct-layer'];
  };
  for (const [owner, file, title] of [['P-003', prerequisite.file, prerequisite.testName],
    ['P-002', finalFile, REPAIR_FINAL_CASE]]) {
    const rating = grade(owner!, file!, title!);
    expect(rating.rating, rating.evidence).toBe('pass');
  }
  for (const [file, title, state] of [[prerequisite.file, prerequisite.testName, 'pass'],
    [finalFile, 'another passing case', 'pass'], [finalFile, REPAIR_FINAL_CASE, 'fail'],
    [finalFile, REPAIR_FINAL_CASE, 'skip'], [finalFile, REPAIR_FINAL_CASE, 'unexecuted']]) {
    expect(grade('P-002', file!, title!, state).rating).not.toBe('pass');
  }
});
