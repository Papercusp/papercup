import { describe, expect, it, vi } from 'vitest';
import { assessNativeProofClearance, nativeProofRequirementSchema, nativeProofWitnessSchema,
  type NativeClearanceDeps, type NativeClearancePreflight } from './native-proof-clearance';
import type { SpecClauseRevision } from './agent-tools/plans/spec-clauses-store';
import type { NativeProofRun } from './testing-run-store';

const hash = 'a'.repeat(64), runId = 'native-proof-' + hash;
const scope = { workspaceId: 'ws', harnessSlug: 'harness', planSlug: 'plan', planItemIds: ['P-010'], workItemId: 'WI-1' };
function clause(specId: string): SpecClauseRevision {
  return { planSlug: 'plan', specId, sourceValId: null, currentRevision: 1, revision: 1,
    planItemId: 'P-010', behavior: 'Keep ordered custody', behaviorClass: 'lifecycle', requiredEvidence: [],
    requiredTestLayers: [], mutationRequired: false, lifecycleStatus: 'active', supersedes: null,
    exemption: null, falsifier: { observation: 'Missing custody admits a write' }, contentHash: hash,
    createdBy: 'su-test', createdAt: '2026-11-01T00:00:00Z', acceptedBy: 'su-test',
    acceptedAt: '2026-11-01T00:00:00Z', acceptanceRef: 'test' };
}
function fixture() {
  const required = clause('clearance');
  required.falsifier!.requiredNativeProof = { profile: 'retained-baseline-v1',
    preflightSpecIds: { numericFold: 'fold', physicalInstall: 'install', priorFailureAudit: 'audit' } };
  const clauses = [required, clause('fold'), clause('install'), clause('audit')];
  const input: NativeProofRun['input'] = { schemaVersion: 1, scope: { workspaceId: scope.workspaceId,
    harnessSlug: scope.harnessSlug, planSlug: scope.planSlug, planItemId: 'P-010' },
    original: { sourceSha: 'b'.repeat(40), fixtureSha256: hash, captureSha256: hash, sourceDigests: { source: hash },
      dependenciesReconstructed: false }, prerequisiteSources: { source: hash },
    method: { sha256: hash, configurationSha256: hash, clientMatrix: ['mcp'] }, selectedInputs: { manifest: hash },
    plannedRepair: { lockSha256: hash, packageDeltaSha256: hash, candidateGraphSha256: hash },
    toolchain: { npmSha256: hash, npmVersion: '11', nodeVersion: '25', nativeAbi: '141' } };
  const run: NativeProofRun = { runId, fingerprint: hash, input, childLaunch: null,
    admission: { reviewedFingerprint: hash, reviewRef: 'thread-post:1',
      preflightRefs: { numericFold: 'fold', physicalInstall: 'install', priorFailureAudit: 'audit' } },
    events: (['reserved', 'started', 'installed', 'built', 'runtime', 'trace', 'sealed', 'readback'] as const)
      .map(kind => ({ kind, fingerprint: hash, receiptRef: 'receipt', receiptSha256: hash })) };
  const witness = { runId, fingerprint: hash };
  const binding = { workItemId: 'WI-1', specId: 'clearance', specRevision: 1, specFingerprint: hash, witness };
  const proofs: Record<string, NativeClearancePreflight> = Object.fromEntries(['fold', 'install', 'audit'].map(specId =>
    [specId, { ...binding, specId, current: true, createdAt: '2026-11-01T01:00:00Z',
      finishedAt: '2026-11-01T00:59:00Z', status: 'pass', passed: 1, failed: 0, skipped: 0, collectionFailed: false }]));
  const deps: NativeClearanceDeps = { clauses: vi.fn(async () => clauses), bindings: vi.fn(async () => [binding]),
    run: vi.fn(async () => ({ run, reservedAt: '2026-11-01T02:00:00Z' })),
    preflight: vi.fn(async ref => proofs[ref] ?? null), fingerprint: () => hash,
    review: vi.fn(async () => undefined), custody: vi.fn(async () => undefined) };
  return { required, clauses, binding, proofs, run, deps };
}

describe('current native proof clearance', () => {
  it('requires the exact typed witness, profile and complete preflight identities', () => {
    expect(nativeProofWitnessSchema.safeParse({ runId, fingerprint: 'b'.repeat(64) }).success).toBe(false);
    expect(nativeProofRequirementSchema.safeParse({ profile: 'retained-baseline-v1', preflightSpecIds: {} }).success).toBe(false);
  });
  it('accepts the current ordered candidate only after all authority and custody readers', async () => {
    const f = fixture();
    expect(await assessNativeProofClearance(scope, f.deps)).toBeNull();
    expect(f.deps.review).toHaveBeenCalledOnce(); expect(f.deps.custody).toHaveBeenCalledOnce();
  });
  it('keeps ordinary clauses independent of native proof', async () => {
    const f = fixture(); delete f.required.falsifier!.requiredNativeProof;
    expect(await assessNativeProofClearance(scope, f.deps)).toBeNull(); expect(f.deps.bindings).not.toHaveBeenCalled();
  });
  it.each(['missing', 'stale', 'foreign-item', 'old-edition', 'reordered', 'fingerprint'])('refuses %s proof', async kind => {
    const f = fixture();
    if (kind === 'missing') f.deps.bindings = async () => [];
    if (kind === 'stale') f.binding.specFingerprint = 'b'.repeat(64);
    if (kind === 'foreign-item') f.run.input.scope.planItemId = 'P-001';
    if (kind === 'old-edition') f.run.admission.reviewedFingerprint = 'b'.repeat(64);
    if (kind === 'reordered') f.run.events.reverse();
    if (kind === 'fingerprint') f.deps.fingerprint = () => 'b'.repeat(64);
    expect((await assessNativeProofClearance(scope, f.deps))?.code).toBe('native_proof_required');
    expect(f.deps.custody).not.toHaveBeenCalled();
  });
  it.each(['missing', 'failed', 'stale', 'late', 'edition', 'superseded'])('refuses %s preflight', async kind => {
    const f = fixture(), proof = f.proofs.audit!;
    if (kind === 'missing') delete f.proofs.audit;
    if (kind === 'failed') proof.failed = 1;
    if (kind === 'stale') proof.current = false;
    if (kind === 'late') proof.createdAt = '2026-11-01T03:00:00Z';
    if (kind === 'edition') proof.witness = { runId: 'native-proof-' + 'b'.repeat(64), fingerprint: 'b'.repeat(64) };
    if (kind === 'superseded') f.clauses.find(c => c.specId === 'audit')!.currentRevision = 2;
    expect((await assessNativeProofClearance(scope, f.deps))?.code).toBe('native_proof_required');
  });
  it.each(['clauses', 'bindings', 'run', 'preflight', 'review', 'custody'] as const)('fails closed when %s is unreadable', async key => {
    const f = fixture(); f.deps[key] = vi.fn(async () => { throw new Error('unavailable'); });
    expect((await assessNativeProofClearance(scope, f.deps))?.code).toBe('native_proof_authority_unavailable');
  });
  it('rechecks the clause after dependent reads and rejects a concurrent revision', async () => {
    const f = fixture(); f.deps.custody = async () => { f.required.currentRevision = 2; };
    expect((await assessNativeProofClearance(scope, f.deps))?.code).toBe('native_proof_required');
  });
  it.each([999, 1000, 1001, 3001])('recovers a valid candidate after %i invalid candidates without truncation', async n => {
    const f = fixture();
    f.deps.bindings = async () => [...Array.from({ length: n }, () => ({ ...f.binding, witness: null })), f.binding];
    expect(await assessNativeProofClearance(scope, f.deps)).toBeNull();
  });
});
