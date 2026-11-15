import { describe, expect, it, vi } from 'vitest';
import { MANAGED_CAPABILITY_DISPOSITIONS, type ManagedCapabilityFamilyId } from '@papercusp/orchestrator/managed-capability-contract';
import { declareRealClientMatrix } from '@papercusp/orchestrator/managed-capability-matrix';
import { getRegisteredInstrument } from './rubric-instrument-registry';
import type { listSpecEvidence } from './agent-tools/plans/spec-evidence-store';
import type { listSpecClauses } from './agent-tools/plans/spec-clauses-store';
import {
  MANAGED_INVENTORY_EVIDENCE_INSTRUMENT, managedCapabilityControlsFromEvidence,
  managedCapabilityInventoryRescore, measureManagedCapabilityInventory, parseManagedCapabilityInventoryGaps,
  retainedInventoryHistory,
  qualifyManagedCapabilityNativeControls, managedCapabilityManualReceiptSchema,
  type ManagedCapabilityManualObservation,
} from './managed-capability-inventory-evidence';

type Evidence = Awaited<ReturnType<typeof listSpecEvidence>>[number];
type Clause = Awaited<ReturnType<typeof listSpecClauses>>[number];
const NOW = new Date('2026-11-09T01:00:00Z');
const scenario = declareRealClientMatrix(undefined, { purpose: 'replacement-acceptance' })[0]!;
const clause = { planSlug: 'managed-agent-capability-contract-and-native-cutover-2026-09-13', specId: 'exact-atom',
  revision: 4, contentHash: 'spec-sha', sourceBar: { barHash: 'bar-sha' } } as Clause;

function row(): Evidence {
  return {
    id: 21, planSlug: clause.planSlug, specId: clause.specId, specRevision: 4, specFingerprint: 'spec-sha',
    evidenceKind: 'operational', evidenceRef: 'operational:original-receipt', observedAt: NOW.toISOString(),
    details: { evidencePlane: 'live', managedCapabilityObservation: { scenarioId: scenario.id,
      role: 'positive', clientVersion: 'client-v1', caseTitle: 'journey > exact case', occurrence: 0 } },
    fingerprints: { sourceFingerprint: 'source-sha', environmentFingerprint: 'env-sha' },
    currentness: { overall: 'current' },
    serverMeasurement: { status: 'measured', measuredDimensions: ['source', 'environment'] },
    testRunId: 123, testRunProvenance: { filePath: 'canonical.test.ts' },
    testRunExecution: { filePath: 'canonical.test.ts', testLayer: 'operational', collectionFailed: false,
      startedAt: '2026-11-09T00:58:00Z', finishedAt: '2026-11-09T00:59:00Z', runtimeEnvironment: { fingerprint: 'runtime-sha' },
      cases: [{ caseKey: 'journey > exact case', occurrence: 0, status: 'pass' }] },
  } as unknown as Evidence;
}

describe('inventory comparison reads canonical spec and case evidence', () => {
  it('uses recorded verdict, exact occurrence and execution time rather than an authored pass or binding time', () => {
    const evidence = row();
    const [control] = managedCapabilityControlsFromEvidence([evidence], [clause], [scenario]);
    expect(control).toMatchObject({ outcome: 'pass', live: false, observedAt: '2026-11-09T00:59:00Z',
      identity: { sourceFingerprint: 'source-sha', barHash: 'bar-sha', runtimeFingerprint: 'runtime-sha',
        environmentFingerprint: 'env-sha' }, ref: { bindingId: 21, occurrence: 0, caseTitle: 'journey > exact case' } });
    evidence.testRunExecution!.cases![0]!.status = 'fail';
    expect(managedCapabilityControlsFromEvidence([evidence], [clause], [scenario])[0]!.outcome).toBe('fail');
    evidence.testRunExecution!.cases![0]!.occurrence = 1;
    expect(managedCapabilityControlsFromEvidence([evidence], [clause], [scenario])[0]!.outcome).toBe('unknown');
  });

  it('does not replace a selected case with a whole-file pass, suffix, duplicate or skipped case', () => {
    const evidence = row();
    evidence.testRunExecution!.cases = [];
    expect(managedCapabilityControlsFromEvidence([evidence], [clause], [scenario])[0]!.outcome).toBe('unknown');
    evidence.testRunExecution!.cases = [{ caseKey: 'journey > other > exact case', occurrence: 0, status: 'pass', durationMs: 1 }];
    expect(managedCapabilityControlsFromEvidence([evidence], [clause], [scenario])[0]!.outcome).toBe('unknown');
    evidence.testRunExecution!.cases = [row().testRunExecution!.cases![0]!, row().testRunExecution!.cases![0]!];
    expect(managedCapabilityControlsFromEvidence([evidence], [clause], [scenario])[0]!.outcome).toBe('unknown');
    evidence.testRunExecution!.cases = [{ ...row().testRunExecution!.cases![0]!, status: 'skip' }];
    expect(managedCapabilityControlsFromEvidence([evidence], [clause], [scenario])[0]!.outcome).toBe('unknown');
  });

  it('keeps automated contradiction checks separate from live proof and refuses missing source/runtime identity', () => {
    const evidence = row(); evidence.testRunExecution!.testLayer = 'integration';
    expect(managedCapabilityControlsFromEvidence([evidence], [clause], [scenario])[0]!.live).toBe(false);
    evidence.testRunExecution!.runtimeEnvironment = null;
    expect(managedCapabilityControlsFromEvidence([evidence], [clause], [scenario])[0]!.currentness).toBe('unknown');
    expect(managedCapabilityControlsFromEvidence([row()], [], [scenario])[0]!.outcome).toBe('unknown');
    const withdrawn = row(); Object.assign(withdrawn, { withdrawal: { at: NOW.toISOString() } });
    expect(managedCapabilityControlsFromEvidence([withdrawn], [clause], [scenario])[0]!.withdrawn).toBe(true);
  });

  it('reads scoped live evidence and separate withdrawn history, preserving explicit notChecked coverage', async () => {
    const old = row(); Object.assign(old, { id: 20, withdrawal: { at: NOW.toISOString() } });
    const evidence = vi.fn().mockResolvedValueOnce([row()]).mockResolvedValueOnce([old, row()]);
    const inventory = [MANAGED_CAPABILITY_DISPOSITIONS.find(d => d.family === scenario.family)!];
    const report = await measureManagedCapabilityInventory({ workspaceId: 'workspace', harnessSlug: 'papercusp' }, {
      evidence, clauses: vi.fn().mockResolvedValue([clause]), versions: async () => ({ [scenario.client]: 'client-v1' }),
      baseline: async () => ({ inventory: [{ family: scenario.family, gapIds: inventory[0]!.gaps.map(g => g.id) }], refs: ['git:baseline'] }),
      inventory, scenarios: [scenario], now: NOW,
    });
    expect(evidence.mock.calls[0]![0]).toMatchObject({ workspaceId: 'workspace', harnessSlug: 'papercusp',
      planSlugs: [clause.planSlug] });
    expect(evidence.mock.calls[1]![0]).toMatchObject({ includeRetracted: true, measurementMode: 'metadata' });
    expect(report.observations.map(o => o.ref.bindingId)).toEqual([20, 21]);
    expect(report.verdict).toBe('unknown');
    expect(report.coverage.notChecked).toEqual([scenario.id]);
    expect(report.baselineEvidenceRefs).toEqual(['git:baseline']);
    expect(report.unknownReasons).toContain('installed-client-receipt-qualification-required');
    expect(report.missingDetectors).toContain('packages/operator-core/lib/agent-tools/capability/managed-capability-api.e2e.test.ts');
  });

  it('retains historical acceptance gaps in the production inventory without claiming missing native observations passed', async () => {
    // The live R-13 comparison caught these removals before a qualified control pair existed.
    const historicalGaps = new Map<ManagedCapabilityFamilyId, string[]>([
      ['shell-ssh-interpreters', ['shell-start-once-response-yield']],
      ['jobs-output-stop-pty', ['pty-resize-completion-reattach', 'job-response-deadline-continuity']],
      ['script-orchestration-kernels', ['kernel-state-media-contract']],
      ['edit-write-patch-notebook', ['patch-notebook-adapters']],
    ]);
    const report = await measureManagedCapabilityInventory({ workspaceId: 'workspace', harnessSlug: 'papercusp' }, {
      evidence: vi.fn().mockResolvedValue([]), clauses: vi.fn().mockResolvedValue([]),
      versions: async () => ({}), artifacts: async () => new Map(), now: NOW,
      baseline: async () => ({
        inventory: MANAGED_CAPABILITY_DISPOSITIONS.map(disposition => ({ family: disposition.family,
          gapIds: [...new Set([...disposition.gaps.map(gap => gap.id), ...(historicalGaps.get(disposition.family) ?? [])])],
        })),
        refs: ['fixture:retained-historical-acceptance-gaps'],
      }),
    });
    expect(report.integrityIssues).toEqual([]);
    expect(report.coverage.checked).toEqual([]);
    expect(report.coverage.notChecked).toEqual(report.coverage.population);
    expect(report.verdict).toBe('unknown');
  });

  it('registers a runnable subject-scoped reader and refuses a different subject before any probe', async () => {
    const instrument = getRegisteredInstrument(MANAGED_INVENTORY_EVIDENCE_INSTRUMENT);
    expect(instrument).toMatchObject({ evaluator: 'platform', rescore: { scope: 'subject' } });
    const result = await managedCapabilityInventoryRescore().resolve({ workspaceId: 'workspace', harnessSlug: 'papercusp',
      windowStart: NOW.toISOString(), windowEnd: NOW.toISOString(), subject: { kind: 'plan', ref: 'another-plan' } });
    expect(result.verdict).toBe('unknown');
    const stale = await managedCapabilityInventoryRescore().resolve({ workspaceId: 'workspace', harnessSlug: 'papercusp',
      windowStart: '2026-01-01T00:00:00Z', windowEnd: '2026-01-02T00:00:00Z',
      subject: { kind: 'plan', ref: clause.planSlug } });
    expect(stale).toEqual({ verdict: 'unknown', detail: 'current_completed_observation_window_required' });
  });
});

describe('manual qualification requires measured artifacts and exact native execution', () => {
  function fixture() {
    const evidence = row();
    const control = managedCapabilityControlsFromEvidence([evidence], [clause], [scenario])[0]!;
    const receipt: ManagedCapabilityManualObservation = { bindingId: evidence.id, scenarioId: scenario.id,
      role: control.role, file: control.ref.file, caseTitle: control.ref.caseTitle, occurrence: control.ref.occurrence,
      identity: { ...control.identity }, outcome: 'pass', observedAt: control.observedAt, observerOwnerId: 'native-observer',
      sideEffects: [{ ref: 'native-call:exact', observation: 'Private file bytes inspected after the recorded call' }],
      native: { advSessionId: 42, nativeSessionId: 'native-session', nativeTurnId: 'native-turn',
        sourceSha256: 'a'.repeat(64), callRecordIndex: 2, resultRecordIndex: 3 },
      call: { name: MANAGED_CAPABILITY_DISPOSITIONS.find(d => d.family === scenario.family)!.managedAuthorities
        .find(name => name.includes(':'))!, arguments: '{"file_path":"private.txt"}',
        output: 'original native result', isError: false, calledAt: '2026-11-09T00:58:10Z', at: '2026-11-09T00:58:11Z' } };
    evidence.details.nativeObservationArtifactBindingId = 22;
    const artifactRow = { ...row(), id: 22, createdBy: receipt.observerOwnerId };
    const artifact = { schemaVersion: 'managed-capability-manual-observations-v1', workspaceId: 'workspace',
      harnessSlug: 'papercusp', planSlug: clause.planSlug, observations: [receipt] };
    const read = { artifact, sha256: 'b'.repeat(64), measuredAtCommit: 'c'.repeat(40) as string | null };
    const native = vi.fn(async () => true);
    const run = async () => (await qualifyManagedCapabilityNativeControls({ workspaceId: 'workspace', harnessSlug: 'papercusp' },
      [evidence, artifactRow], [control], { artifacts: async () => new Map([[22, read]]), native }))[0]!;
    return { evidence, control, receipt, artifactRow, artifact, read, native, run };
  }

  it('qualifies a measured exact receipt only after the native reader accepts it, retaining functional failures', async () => {
    const f = fixture();
    expect((await f.run()).live).toBe(true);
    expect(f.native).toHaveBeenCalledWith({ workspaceId: 'workspace', harnessSlug: 'papercusp' }, f.receipt, scenario.client);
    f.native.mockResolvedValue(false);
    expect((await f.run()).live).toBe(false);
    f.native.mockResolvedValue(true); f.control.outcome = 'fail'; f.receipt.outcome = 'fail';
    expect(await f.run()).toMatchObject({ live: true, outcome: 'fail' });
  });

  it.each(['workspace', 'harness', 'plan', 'binding', 'scenario', 'role', 'file', 'case', 'occurrence',
    'client', 'criterion', 'source', 'runtime', 'environment', 'verdict', 'observer', 'time', 'replayed',
    'future', 'duplicate', 'uncommitted', 'withdrawn', 'stale', 'unknown', 'missing-side-effects', 'authored-live', 'unrelated-tool'] as const)
  ('refuses a %s receipt before native qualification', async fault => {
    const f = fixture();
    if (fault === 'workspace') f.artifact.workspaceId = 'another';
    if (fault === 'harness') f.artifact.harnessSlug = 'another';
    if (fault === 'plan') f.artifact.planSlug = 'another';
    if (fault === 'binding') f.receipt.bindingId++;
    if (fault === 'scenario') f.receipt.scenarioId = 'another';
    if (fault === 'role') f.receipt.role = 'refusal';
    if (fault === 'file') f.receipt.file = 'another.test.ts';
    if (fault === 'case') f.receipt.caseTitle = 'another case';
    if (fault === 'occurrence') f.receipt.occurrence++;
    if (fault === 'client') f.receipt.identity.clientVersion = 'another';
    if (fault === 'criterion') f.receipt.identity.barHash = 'another';
    if (fault === 'source') f.receipt.identity.sourceFingerprint = 'another';
    if (fault === 'runtime') f.receipt.identity.runtimeFingerprint = 'another';
    if (fault === 'environment') f.receipt.identity.environmentFingerprint = 'another';
    if (fault === 'verdict') f.receipt.outcome = 'fail';
    if (fault === 'observer') f.artifactRow.createdBy = 'another';
    if (fault === 'time') f.receipt.observedAt = '2026-11-09T00:59:01Z';
    if (fault === 'replayed') f.receipt.call.calledAt = '2026-11-09T00:57:59Z';
    if (fault === 'future') f.receipt.call.at = '2026-11-09T00:59:01Z';
    if (fault === 'duplicate') f.artifact.observations.push(structuredClone(f.receipt));
    if (fault === 'uncommitted') f.read.measuredAtCommit = null;
    if (fault === 'withdrawn') Object.assign(f.artifactRow, { withdrawal: { at: NOW.toISOString() } });
    if (fault === 'stale') f.artifactRow.currentness.overall = 'stale';
    if (fault === 'unknown') f.control.outcome = 'unknown';
    if (fault === 'missing-side-effects') f.receipt.sideEffects = [];
    if (fault === 'authored-live') Object.assign(f.receipt, { live: true });
    if (fault === 'unrelated-tool') f.receipt.call.name = 'mcp__papercusp_su__coord_whoami';
    expect((await f.run()).live).toBe(false);
    expect(f.native).not.toHaveBeenCalled();
  });

  it('refuses reuse of one original native call as two controls and accepts distinct original calls', async () => {
    const f = fixture();
    const other = { ...f.control, ref: { ...f.control.ref, bindingId: 23 }, role: 'refusal' as const };
    const otherRow = { ...f.evidence, id: 23 };
    const otherReceipt = { ...structuredClone(f.receipt), bindingId: 23, role: 'refusal' as const };
    f.artifact.observations.push(otherReceipt);
    const run = () => qualifyManagedCapabilityNativeControls({ workspaceId: 'workspace', harnessSlug: 'papercusp' },
      [f.evidence, f.artifactRow, otherRow], [f.control, other], {
        artifacts: async () => new Map([[22, f.read]]), native: f.native,
      });
    expect((await run()).map(c => c.live)).toEqual([false, false]);
    otherReceipt.native.callRecordIndex = 4; otherReceipt.native.resultRecordIndex = 5;
    expect((await run()).map(c => c.live)).toEqual([true, true]);
  });

  it('rejects legacy generic receipt shapes rather than treating tags as manual provenance', () => {
    expect(managedCapabilityManualReceiptSchema.safeParse({ live: true, runId: 'a-runtime' }).success).toBe(false);
  });

  it.each(['codex', 'omp'] as const)('does not count unused native ordinal fields as distinct %s execution', async client => {
    const f = fixture();
    const positive = { ...f.control, client };
    const refusal = { ...positive, ref: { ...positive.ref, bindingId: 23 }, role: 'refusal' as const };
    const otherRow = { ...f.evidence, id: 23 };
    const otherReceipt = { ...structuredClone(f.receipt), bindingId: 23, role: 'refusal' as const };
    otherReceipt.native.resultContentIndex = 99; // Neither client reads this field.
    if (client === 'codex') otherReceipt.native.callContentIndex = 99;
    f.artifact.observations.push(otherReceipt);
    const result = await qualifyManagedCapabilityNativeControls({ workspaceId: 'workspace', harnessSlug: 'papercusp' },
      [f.evidence, f.artifactRow, otherRow], [positive, refusal], {
        artifacts: async () => new Map([[22, f.read]]), native: f.native,
      });
    expect(result.map(c => c.live)).toEqual([false, false]);
  });
});

describe('historical inventory baseline uses literal committed declarations', () => {
  it('refuses shallow or unreadable history before accepting a short path log as complete', async () => {
    const shallow = vi.fn(async () => 'true\n');
    expect(await retainedInventoryHistory(shallow)).toBeUndefined();
    expect(shallow).toHaveBeenCalledTimes(1);
    expect(shallow.mock.calls[0]).toEqual([['rev-parse', '--is-shallow-repository'], expect.any(String)]);
    expect(await retainedInventoryHistory(async () => { throw new Error('unavailable'); })).toBeUndefined();
  });

  it('unions complete history instead of letting a later unrelated commit hide a removed gap', async () => {
    const source = (gap: boolean) => `export const MANAGED_CAPABILITY_DISPOSITIONS =
      [{family:'delegation',gaps:${gap ? "[{id:'removed-gap'}]" : '[]'}}] as const;`;
    const old = 'a'.repeat(40), recent = 'b'.repeat(40);
    const run = vi.fn(async (args: string[]) => args[0] === 'rev-parse' ? 'false\n'
      : args[0] === 'log' ? `${recent}\n${old}\n` : source(args[1]!.startsWith(old)));
    expect(await retainedInventoryHistory(run)).toMatchObject({ inventory: [{ family: 'delegation', gapIds: ['removed-gap'] }],
      refs: [expect.stringContaining(recent), expect.stringContaining(old)] });
    expect(await retainedInventoryHistory(async args => args[0] === 'rev-parse' ? 'false\n'
      : Array.from({ length: 65 }, () => old).join('\n'))).toBeUndefined();
  });

  it('extracts gap ids and explicit closed ledgers without executing source', async () => {
    const source = `throw Error('must never execute');
      export const MANAGED_CAPABILITY_DISPOSITIONS = [
        { family: 'jobs-output-stop-pty', gaps: [{ id: 'old-gap' }] },
        { family: 'delegation', gaps: [] }
      ] as const satisfies readonly unknown[];`;
    expect(await parseManagedCapabilityInventoryGaps(source)).toEqual([
      { family: 'jobs-output-stop-pty', gapIds: ['old-gap'] }, { family: 'delegation', gapIds: [] },
    ]);
  });

  it.each([`[{family:'delegation',gaps:compute()}]`, `[{family:'delegation',gaps:[{id:dynamic}]}]`,
    `[{family:'delegation',gaps:[]},{family:'delegation',gaps:[]}]`, `[{family:'invented',gaps:[]}]`, `[]`])(
    'leaves an unparseable/ambiguous baseline unknown: %s', async expression => {
      expect(await parseManagedCapabilityInventoryGaps(`export const MANAGED_CAPABILITY_DISPOSITIONS = ${expression}`)).toBeUndefined();
    });
});
