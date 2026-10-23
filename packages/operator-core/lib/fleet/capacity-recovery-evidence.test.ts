import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BRIEF_ADMIN, computeIdentityHash, JUDGE_PROMPT_SCAFFOLD_VERSION } from '@papercusp/testing-shell/llm';
import { S42_CASES, S42_ITEM, S42_PROMPT } from '../llm-testing/scenarios/su/S42-drain-watch-recheck';
import { LUNA_CAPACITY_PLAN, LUNA_CAPACITY_INSTRUMENTS, lunaCapacityInstruments, validateCapacityRecoveryProof, validateCapacityShipmentProof,
  validateCapacityDiagnosticProof, validateCapacityContinuationProof, validateCapacityContractProof, validateCapacityNativeLlmRun,
  type NativeCapacityLlmRun, type NativeCapacityLlmContext,
  type CapacityRecoveryProof, type CapacityShipmentProof, type CapacityDiagnosticProof } from './capacity-recovery-evidence';

const hash = (value: string) => value.repeat(64);
const stamp = (minute: number) => `2026-10-23T12:${String(minute).padStart(2, '0')}:00.000Z`;
const candidate = () => ({ commit: 'a'.repeat(40), sourceDigest: hash('b'), buildDigest: hash('c'),
  specSetHash: hash('d'), barSetHash: hash('e') });

it('rejects jointly forged or superseded hashes even when the artifact is internally consistent', () => {
  const proof = shipment();
  const current = { specSetHash: hash('d'), barSetHash: hash('e'), sourceFingerprint: 'sha256-file-set-v1:' + hash('b') };
  expect(validateCapacityContractProof(proof, current).status).toBe('pass');
  for (const field of ['specSetHash', 'barSetHash', 'sourceDigest'] as const) {
    const forged = shipment();
    for (const c of [forged.candidate, forged.acceptance.candidate, forged.green.candidate, ...forged.evidence.map(e => e.candidate)]) c[field] = hash('9');
    expect(validateCapacityContractProof(forged, current).status).toBe('fail');
  }
  expect(validateCapacityContractProof(proof, { ...current, sourceFingerprint: 'unmeasured' }).status).toBe('fail');
});
function census(): CapacityRecoveryProof {
  const effectiveSpec = { ref: 'member-override', revision: 4, maxConcurrentClaims: 2 };
  return { schemaVersion: 'luna-capacity-recovery-v1', plan: LUNA_CAPACITY_PLAN, candidate: candidate(),
    snapshot: { id: 'census-1', observedAt: stamp(0), generation: 'generation-4', fleet: 'luna',
      leaderId: 'leader', leaderAfterId: 'leader', fleetCap: 2, receiptRef: 'roster-receipt', roster: ['member'],
      members: [{ id: 'member', effectiveSpec, runtimeState: 'parked', wakeable: true,
        ownerRestricted: false, gateProtected: false, activeClaims: 0, activeIds: [], heldIds: ['WI-blocked'],
        blockerParkedIds: ['WI-blocked'], admittedIds: ['WI-next'],
        typedBlockers: [{ workItemId: 'WI-blocked', ref: 'work-item:done:WI-peer', status: 'active', receiptRef: 'blocker-receipt' }],
        disposition: 'eligible', reason: 'Member-specific admission and spare capacity verified', receiptRef: 'oracle-receipt' }] },
    recoveries: [{ snapshotId: 'census-1', memberId: 'member', leaderId: 'leader', leaderReceiptRef: 'leader-action',
      effectiveSpec, restrictionsRecheckedAt: stamp(1), ownerRestricted: false, gateProtected: false,
      control: { verb: 'coord:wake', memberId: 'member', actorId: 'leader', receiptRef: 'wake-action', invokedAt: stamp(2) },
      turn: { id: 'native-turn', memberId: 'member', triggerReceiptRef: 'wake-action', startedAt: stamp(3) },
      claim: { workItemId: 'WI-next', memberId: 'member', takenBy: 'member', takenAt: stamp(4),
        receiptRef: 'claim-action', writers: ['member'], writerAuditReceiptRef: 'writer-census' } }] };
}
function shipment(): CapacityShipmentProof {
  return { schemaVersion: 'luna-capacity-shipment-v1', plan: LUNA_CAPACITY_PLAN, candidate: candidate(),
    acceptance: { ref: 'acceptance-1', reviewerId: 'independent', authorId: 'author', implementerIds: ['author'],
      verdict: 'accept', pendingFindings: [], candidate: candidate(), acceptedAt: stamp(2), receiptRef: 'acceptance-receipt' },
    evidence: (['R-1', 'R-2', 'R-3', 'R-4', 'R-5'] as const).map(barKey => ({ barKey, candidate: candidate(),
      fingerprint: hash('f'), observedAt: stamp(1), receiptRef: 'evidence-' + barKey })),
    green: { runId: 'green-1', verdict: 'green', candidate: candidate(), ownerId: 'gate-owner', actorId: 'gate-owner', receiptRef: 'green-receipt' },
    release: { deployId: 'deploy-1', commit: candidate().commit, sourceDigest: hash('b'), buildDigest: hash('c'),
      deployedAt: stamp(3), receiptRef: 'release-receipt' },
    probe: { runtime: 'release-operator', sourceDigest: hash('b'), buildDigest: hash('c'), observedAt: stamp(4),
      verdict: 'pass', receiptRef: 'release-probe' } };
}

describe('Luna census and managed-pickup semantic proof', () => {
  it('accepts a complete leader-coordinated same-member admitted-item pickup', () => {
    expect(validateCapacityRecoveryProof(census())).toEqual({ status: 'pass', violations: [] });
  });
  it('accepts a fully disposed empty eligible set without waking anyone', () => {
    const p = census(); p.snapshot.members[0].admittedIds = []; p.snapshot.members[0].disposition = 'no-work'; p.recoveries = [];
    expect(validateCapacityRecoveryProof(p).status).toBe('pass');
  });
  it('rejects a cap increase forged consistently in both the census and recovery', () => {
    const p = census();
    p.snapshot.members[0].effectiveSpec = { ...p.snapshot.members[0].effectiveSpec, maxConcurrentClaims: 3 };
    p.recoveries[0].effectiveSpec = { ...p.recoveries[0].effectiveSpec, maxConcurrentClaims: 3 };
    expect(validateCapacityRecoveryProof(p).violations).toEqual(expect.arrayContaining([
      'effective-cap-exceeds-fleet:member', 'recovery-cap-exceeds-fleet:member',
    ]));
  });
  it('preserves a narrower effective member cap', () => {
    const p = census();
    p.snapshot.members[0].effectiveSpec = { ...p.snapshot.members[0].effectiveSpec, maxConcurrentClaims: 1 };
    p.recoveries[0].effectiveSpec = { ...p.recoveries[0].effectiveSpec, maxConcurrentClaims: 1 };
    expect(validateCapacityRecoveryProof(p).status).toBe('pass');
  });
  const invalid: Array<[string, (p: CapacityRecoveryProof) => void, string]> = [
    ['missing census identity', p => { p.snapshot.roster.push('omitted'); }, 'census-population'],
    ['duplicate census identity', p => { p.snapshot.roster.push('member'); }, 'census-population'],
    ['leader replacement', p => { p.snapshot.leaderAfterId = 'replacement'; }, 'leader-changed'],
    ['missing genuine typed blocker', p => { p.snapshot.members[0].typedBlockers = []; }, 'untyped-exemption:member'],
    ['forged active count', p => { p.snapshot.members[0].activeClaims = 1; }, 'claim-accounting:member'],
    ['hidden cap2 claims', p => { const m = p.snapshot.members[0]; m.activeIds = ['WI-a', 'WI-b']; m.activeClaims = 2;
      m.heldIds.push('WI-a', 'WI-b'); }, 'false-disposition:member'],
    ['owner-only override', p => { p.snapshot.members[0].ownerRestricted = true; }, 'false-disposition:member'],
    ['arbitrary protected gate', p => { p.snapshot.members[0].gateProtected = true; }, 'false-disposition:member'],
    ['stale/historical runtime', p => { p.snapshot.members[0].runtimeState = 'ended'; }, 'false-disposition:member'],
    ['unknown passed as empty', p => { p.snapshot.members[0].admittedIds = null; p.snapshot.members[0].disposition = 'unknown'; p.recoveries = []; }, 'unknown-is-not-empty'],
    ['queued wake without pickup', p => { p.recoveries = []; }, 'eligible-without-pickup'],
    ['unrelated member turn', p => { p.recoveries[0].turn.memberId = 'other'; }, 'pickup-identity-or-duplicate-writer'],
    ['unrelated work-item claim', p => { p.recoveries[0].claim.workItemId = 'WI-foreign'; }, 'pickup-identity-or-duplicate-writer'],
    ['duplicate writer', p => { p.recoveries[0].claim.writers.push('other'); }, 'pickup-identity-or-duplicate-writer'],
    ['old held item called new pickup', p => { p.recoveries[0].claim.workItemId = 'WI-blocked'; }, 'pickup-identity-or-duplicate-writer'],
    ['spec revision changed at action', p => { p.recoveries[0].effectiveSpec = { ...p.recoveries[0].effectiveSpec, revision: 5 }; }, 'recovery-permission-change'],
    ['raised effective cap', p => { p.recoveries[0].effectiveSpec = { ...p.recoveries[0].effectiveSpec, maxConcurrentClaims: 3 }; }, 'recovery-permission-change'],
    ['wrong action authority', p => { p.recoveries[0].control.actorId = 'outsider'; }, 'recovery-authority'],
    ['unrelated turn trigger', p => { p.recoveries[0].turn.triggerReceiptRef = 'other-wake'; }, 'unmanaged-pickup'],
    ['replacement launch', p => { p.recoveries[0].control.verb = 'capability:launch-agent'; }, 'unmanaged-pickup'],
    ['claim predates recovery', p => { p.recoveries[0].claim.takenAt = stamp(1); }, 'pickup-time-or-stale-recheck'],
    ['stale frozen census', p => { p.recoveries[0].control.invokedAt = stamp(20); }, 'pickup-time-or-stale-recheck'],
  ];
  it.each(invalid)('rejects %s', (_name, mutate, failure) => {
    const p = census(); mutate(p); expect(validateCapacityRecoveryProof(p).violations).toContain(failure);
  });
  it('rejects a receipt with no observed turn or no per-member disposition', () => {
    expect(validateCapacityRecoveryProof({ ...census(), recoveries: [{ control: census().recoveries[0].control }] }).status).toBe('fail');
    expect(validateCapacityRecoveryProof({ ...census(), snapshot: { ...census().snapshot, members: [{}] } }).status).toBe('fail');
  });
});

describe('Luna independent acceptance and released-artifact join', () => {
  it('accepts exact accepted candidate, R1-R5, green verdict, artifact and runtime identities', () => {
    expect(validateCapacityShipmentProof(shipment())).toEqual({ status: 'pass', violations: [] });
  });
  const invalid: Array<[string, (p: CapacityShipmentProof) => void, string]> = [
    ['self-acceptance', p => { p.acceptance.reviewerId = 'author'; }, 'acceptance-not-independent-or-settled'],
    ['implementation lineage reviewer', p => { p.acceptance.implementerIds.push('independent'); }, 'acceptance-not-independent-or-settled'],
    ['pending findings', p => { p.acceptance.pendingFindings.push('unfixed'); }, 'acceptance-not-independent-or-settled'],
    ['foreign accepted candidate', p => { p.acceptance.candidate.commit = 'f'.repeat(40); }, 'candidate-identity'],
    ['different accepted BARs', p => { p.acceptance.candidate.barSetHash = hash('a'); }, 'candidate-identity'],
    ['different green candidate', p => { p.green.candidate.sourceDigest = hash('a'); }, 'candidate-identity'],
    ['missing R5 proof', p => { p.evidence.pop(); }, 'r1-r5-proof-join'],
    ['duplicate R1 replacing R5', p => { p.evidence[4].barKey = 'R-1'; }, 'r1-r5-proof-join'],
    ['foreign R1 source', p => { p.evidence[0].candidate.sourceDigest = hash('a'); }, 'r1-r5-proof-join'],
    ['post-acceptance evidence', p => { p.evidence[0].observedAt = stamp(3); }, 'r1-r5-proof-join'],
    ['gate takeover', p => { p.green.actorId = 'author'; }, 'live-gate-owner'],
    ['released source mutation', p => { p.release.sourceDigest = hash('a'); }, 'released-source-identity'],
    ['changed-file containment only', p => { p.release.commit = 'f'.repeat(40); }, 'release-provenance-chain'],
    ['unexplained build digest', p => { p.release.buildDigest = hash('a'); }, 'release-provenance-chain'],
    ['foreign runtime', p => { p.probe.buildDigest = hash('a'); }, 'release-runtime-identity'],
    ['shipment before acceptance', p => { p.release.deployedAt = stamp(1); }, 'shipment-order'],
  ];
  it.each(invalid)('rejects %s', (_name, mutate, failure) => {
    const p = shipment(); mutate(p); expect(validateCapacityShipmentProof(p).violations).toContain(failure);
  });
  it('requires a deterministic chain attested by the same independent reviewer for a different artifact', () => {
    const p = shipment(); p.release.commit = 'f'.repeat(40); p.release.buildDigest = hash('a'); p.probe.buildDigest = hash('a');
    p.provenance = { candidateCommit: p.candidate.commit, artifactCommit: p.release.commit,
      sourceDigest: p.candidate.sourceDigest, inputBuildDigest: p.candidate.buildDigest,
      artifactDigest: p.release.buildDigest, acceptanceRef: p.acceptance.ref, verifiedBy: p.acceptance.reviewerId,
      deterministic: true, receiptRef: 'deterministic-build-receipt' };
    expect(validateCapacityShipmentProof(p).status).toBe('pass');
    p.provenance.verifiedBy = 'author';
    expect(validateCapacityShipmentProof(p).violations).toContain('release-provenance-chain');
  });
  it('fails closed on absent, partial and red-verdict receipts', () => {
    expect(validateCapacityShipmentProof(null).status).toBe('fail');
    expect(validateCapacityShipmentProof({ candidate: candidate() }).status).toBe('fail');
    expect(validateCapacityShipmentProof({ ...shipment(), green: { ...shipment().green, verdict: 'red' } }).status).toBe('fail');
  });
});

describe('serving diagnostic semantic proof', () => {
  const diagnostic = (): CapacityDiagnosticProof => ({ schemaVersion: 'luna-capacity-diagnostic-v1',
    plan: LUNA_CAPACITY_PLAN, candidate: candidate(),
    runtime: { id: 'staging-operator', containsSource: true, sourceDigest: hash('b'), buildDigest: hash('c'),
      observedAt: stamp(0), receiptRef: 'runtime-containment' },
    scope: { fleet: 'luna', harness: 'papercusp', specRef: 'luna-spec', specRevision: 4,
      populationBasis: 'caller-neutral fleet admission after shared floors', receiptRef: 'brief-read' },
    status: 'measured', briefCount: 4, callerCount: 3,
    reconciliation: { specRef: 'luna-spec', specRevision: 4, harness: 'papercusp',
      callerFloorExclusions: [{ id: 'WI-cooldown', reason: 'caller-specific cooldown', receiptRef: 'floor-read' }], receiptRef: 'caller-read' },
    diagnosticBudgetMs: 12_000, deadlineReceiptRef: 'bounded-diagnostic-read' });
  it('reconciles the same scope while accounting explicitly for caller-only floors', () => {
    expect(validateCapacityDiagnosticProof(diagnostic()).status).toBe('pass');
  });
  it('accepts an explicitly unknown diagnostic with an authorized bounded recovery', () => {
    const p = diagnostic(); p.status = 'degraded'; p.briefCount = null; p.callerCount = null; delete p.reconciliation;
    p.degraded = { reasonClass: 'diagnostic-timeout', reason: 'Bounded diagnostic unavailable',
      recoveryVerb: 'work_items:claimable', recoveryActorId: 'leader', retryOrEscalationCondition: 'Retry once after runtime readiness; then record blocker', receiptRef: 'timeout-receipt' };
    expect(validateCapacityDiagnosticProof(p).status).toBe('pass');
    p.briefCount = 0;
    expect(validateCapacityDiagnosticProof(p).violations).toContain('degraded-not-explicit-unknown');
  });
  it('rejects missing or unbounded degraded recovery', () => {
    const p = diagnostic(); p.status = 'degraded'; p.briefCount = null;
    expect(validateCapacityDiagnosticProof(p).status).toBe('fail');
  });
  it('rejects contradictory measured/degraded residue in either direction', () => {
    const p = diagnostic();
    p.degraded = { reasonClass: 'timeout', reason: 'Unknown', recoveryVerb: 'work_items:claimable',
      recoveryActorId: 'leader', retryOrEscalationCondition: 'Retry once after readiness', receiptRef: 'timeout' };
    expect(validateCapacityDiagnosticProof(p).violations).toContain('measured-with-degraded-residue');
    p.status = 'degraded'; p.briefCount = null; p.callerCount = null;
    expect(validateCapacityDiagnosticProof(p).violations).toContain('degraded-not-explicit-unknown');
  });
  it('rejects source/build skew and the insufficient 750ms serving budget', () => {
    const p = diagnostic(); p.runtime.sourceDigest = hash('a');
    expect(validateCapacityDiagnosticProof(p).violations).toContain('serving-source-identity');
    p.runtime.sourceDigest = hash('b'); p.diagnosticBudgetMs = 750;
    expect(validateCapacityDiagnosticProof(p).status).toBe('fail');
  });
  it('rejects unreconciled counts and a different caller effective spec', () => {
    const p = diagnostic(); p.callerCount = 4;
    expect(validateCapacityDiagnosticProof(p).violations).toContain('unreconciled-caller-floors');
    p.callerCount = 3; p.reconciliation!.specRevision = 5;
    expect(validateCapacityDiagnosticProof(p).violations).toContain('caller-population-mismatch');
  });
  it('rejects duplicate caller-floor exclusions and unmeasured healthy scope', () => {
    const p = diagnostic(); p.reconciliation!.callerFloorExclusions.push(p.reconciliation!.callerFloorExclusions[0]); p.briefCount = 5;
    expect(validateCapacityDiagnosticProof(p).violations).toContain('unreconciled-caller-floors');
    p.scope.specRevision = null;
    expect(validateCapacityDiagnosticProof(p).violations).toContain('measured-scope-incomplete');
  });
});

describe('native continuation layer and fresh-render coverage', () => {
  const bindings = () => {
    const row = (id: number, filePath: string, testLayer: 'unit' | 'llm', passedCaseTitles: string[] = [], scenarioId?: string) => ({
      bindingId: id, testRunId: id + 10, currentness: 'current', status: 'pass', failed: 0,
      passed: 1, collectionFailed: false, testLayer, filePath, passedCaseTitles,
      sourceFingerprint: 'sha256-file-set-v1:' + hash('b'),
      ...(scenarioId ? { scenarioId, nativeRunIds: ['native-' + id] } : {}),
    });
    return [
      ...['preexisting', 'during-registration', 'empty'].map((arrival, i) => row(i + 1, 'lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts', 'llm', [], 'su-S42-drain-watch-' + arrival)),
      row(4, 'lib/agent-tools/events/watch.test.ts', 'unit', ['the drained-lane contract is IDEMPOTENT']),
      row(5, 'lib/agent-tools/scheduler/idle-loop-recipe-pin.test.ts', 'unit', ['fresh codex member render', 'fresh claude member render']),
      row(6, 'lib/llm-testing/scenarios/su/S42-drain-watch-recheck.test.ts', 'unit',
        ['preexisting', 'during-registration', 'empty'].map(a => 'accepts the correct ' + a + ' lifecycle')),
    ];
  };
  it('requires native successful evidence for each arrival world plus all three source guards', () => {
    expect(validateCapacityContinuationProof(bindings()).status).toBe('pass');
  });
  it.each(['preexisting', 'during-registration', 'empty'])('rejects missing native %s coverage', arrival => {
    expect(validateCapacityContinuationProof(bindings().filter(b => b.scenarioId !== 'su-S42-drain-watch-' + arrival)).violations)
      .toContain('missing-native-arrival:' + arrival);
  });
  it('rejects stale/failed native evidence and repeated bindings', () => {
    const rows = bindings();
    expect(validateCapacityContinuationProof([{ ...rows[0], currentness: 'stale' }, ...rows.slice(1)]).status).toBe('fail');
    expect(validateCapacityContinuationProof([{ ...rows[0], failed: 1 }, ...rows.slice(1)]).status).toBe('fail');
    expect(validateCapacityContinuationProof([...rows, rows[0]]).violations).toContain('duplicate-native-binding');
  });
  it('rejects a source pin without executed fresh renders or lifecycle cases', () => {
    const rows = bindings(); rows[4].passedCaseTitles = ['source text contains the rule'];
    expect(validateCapacityContinuationProof(rows).violations).toContain('missing-fresh-render:codex');
    rows[5].passedCaseTitles = [];
    expect(validateCapacityContinuationProof(rows).violations).toContain('missing-lifecycle-calibration');
  });
  it('rejects unrelated scenario files, mixed candidate sources, missing rich runs and reused rich reports', () => {
    const rows = bindings(); rows[0].filePath = 'foreign/scenario.ts';
    expect(validateCapacityContinuationProof(rows).violations).toContain('unverified-native-llm-run:1');
    rows[1].sourceFingerprint = 'sha256-file-set-v1:' + hash('9');
    expect(validateCapacityContinuationProof(rows).violations).toContain('mixed-candidate-source');
    rows[1].nativeRunIds = rows[2].nativeRunIds;
    expect(validateCapacityContinuationProof(rows).violations).toContain('duplicate-native-llm-run');
    rows[2].nativeRunIds = [];
    expect(validateCapacityContinuationProof(rows).violations).toContain('unverified-native-llm-run:3');
  });
});

describe('original native S42 trace and prompt provenance', () => {
  const expected = (arrival: string): NativeCapacityLlmContext => ({ scenarioId: 'su-S42-drain-watch-' + arrival,
    scenarioVersion: 6, scenarioHash: hash('a'), personaId: BRIEF_ADMIN.id, personaTraits: BRIEF_ADMIN.traits,
    rubricVersion: 'current-rubric', provider: 'anthropic', systemSha256: [hash('b')] });
  const native = (arrival: string): NativeCapacityLlmRun => {
    const context = expected(arrival);
    const toolCalls = [{ name: 'watch:create', input: { pattern: 'work-item:claimable', wake: true, once: false } },
      { name: 'scheduler:get_next', input: {} }, arrival === 'empty' ? { name: 'loop:end', input: {} }
        : { name: 'work_items:checkpoint', input: { id: S42_ITEM, next: 'Run the focused reproduction.' } }];
    const models = { sutModel: 'claude-sonnet-4-6', judgeModel: 'claude-sonnet-4-6' };
    return { ...context, ...models, id: 'native-' + arrival, status: 'passed',
      identityHash: computeIdentityHash({ ...context, ...models, judgeScaffoldVersion: JUDGE_PROMPT_SCAFFOLD_VERSION }),
      turns: [{ userText: S42_PROMPT, assistantText: '', toolCalls }] as NativeCapacityLlmRun['turns'],
      rawEvents: [{ name: 'tool_definition_manifest', data: { schemaVersion: 'su-tool-definitions-v1',
        provider: 'anthropic', systemSha256: hash('b'), definitions: [], sha256: createHash('sha256').update('[]').digest('hex') } },
      ...toolCalls.map(data => ({ name: 'tool_call', data }))] };
  };
  it.each(S42_CASES)('replays an original %s trace with the current scenario, persona, prompt and client', arrival => {
    expect(validateCapacityNativeLlmRun(native(arrival), expected(arrival))).toEqual({ status: 'pass', violations: [] });
  });
  it('rejects success labels attached to a claim-only model transcript', () => {
    const r = native('preexisting'); r.turns[0].toolCalls.pop(); r.rawEvents.pop();
    expect(validateCapacityNativeLlmRun(r, expected('preexisting')).violations)
      .toContain('custom:drain-watch-recheck:claimed-work-never-progressed');
  });
  it('rejects a normalized trace substituted independently of the stored original tape', () => {
    const r = native('preexisting'); r.rawEvents.pop();
    expect(validateCapacityNativeLlmRun(r, expected('preexisting')).violations).toContain('native-trace-custody-mismatch');
  });
  it('rejects stale scenario/source/identity and a different native arrival world', () => {
    for (const change of [{ scenarioVersion: 5 }, { scenarioHash: hash('9') }, { identityHash: hash('9') },
      { personaId: 'foreign' }, { scenarioId: 'su-S42-drain-watch-empty' }]) {
      expect(validateCapacityNativeLlmRun({ ...native('preexisting'), ...change }, expected('preexisting')).status).toBe('fail');
    }
  });
  it('rejects missing, altered or foreign-client prompt manifests', () => {
    const r = native('empty'); r.rawEvents = r.rawEvents.filter(e => e.name !== 'tool_definition_manifest');
    expect(validateCapacityNativeLlmRun(r, expected('empty')).violations).toContain('native-prompt-manifest-missing');
    for (const change of [{ provider: 'codex' }, { systemSha256: hash('9') }, { definitions: ['substituted'] }]) {
      const r = native('empty'); r.rawEvents[0].data = { ...r.rawEvents[0].data as object, ...change };
      expect(validateCapacityNativeLlmRun(r, expected('empty')).violations).toContain('native-prompt-or-client-mismatch');
    }
  });
});

it('registered instruments distinguish valid, contradicted and missing/native-unreadable evidence', () => {
  for (const instrument of lunaCapacityInstruments('/repo')) {
    const phase = Object.entries(LUNA_CAPACITY_INSTRUMENTS).find(([, key]) => key === instrument.key)?.[0];
    expect(instrument.argv).toContain('/repo/scripts/verify-fleet-capacity-recovery.mts');
    expect(instrument.parse(JSON.stringify({ scope: 'luna-capacity-semantic-v1', phase, status: 'pass', bindingIds: [1] }), { now: 0 })).toBe(1);
    expect(instrument.parse(JSON.stringify({ scope: 'luna-capacity-semantic-v1', phase, status: 'fail', bindingIds: [1] }), { now: 0 })).toBe(0);
    expect(instrument.parse(JSON.stringify({ scope: 'luna-capacity-semantic-v1', phase, status: 'unknown', bindingIds: [] }), { now: 0 })).toBeNull();
    expect(instrument.parse('not json', { now: 0 })).toBeNull();
  }
});

it('the registered native CLI boots and rejects an invalid scope before any database read', () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const runner = fileURLToPath(new URL('../../../../scripts/verify-fleet-capacity-recovery.mts', import.meta.url));
  const stdout = execFileSync(process.execPath, ['--import', 'tsx', runner, root, 'invalid-phase'],
    { cwd: root, encoding: 'utf8', timeout: 30_000 });
  const result = JSON.parse(stdout.trim().split('\n').at(-1)!);
  expect(result).toMatchObject({ scope: 'luna-capacity-semantic-v1', phase: 'invalid-phase',
    status: 'unknown', bindingIds: [], violations: ['invalid-instrument-scope'] });
}, 35_000);
