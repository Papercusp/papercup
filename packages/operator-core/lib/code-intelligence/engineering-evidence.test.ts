import { describe, expect, it, vi } from 'vitest';
import { readEngineeringEvidence, type EngineeringEvidenceDeps, type EngineeringItem,
  type EngineeringProof, type EngineeringScope, type EngineeringSpec, type EngineeringSymbol } from './engineering-evidence';

const scope: EngineeringScope = { workspaceId: 'ee-owner', harness: 'ee-repo', root: '/fixture/ee-repo' };
const symbol: EngineeringSymbol = { path: 'src/evidence-feature.ts', name: 'evidenceFeature', line1: 3,
  versionedSymbolId: 'versioned-ee-symbol', fileFingerprint: 'f'.repeat(64), declarationFingerprint: 'd'.repeat(64) };
const item: EngineeringItem = { workspaceId: scope.workspaceId, harness: scope.harness,
  plan: 'ee-feature', item: 'P-001', anchorState: 'current' };
const spec: EngineeringSpec = { plan: item.plan, item: item.item, id: 'EE-1', revision: 2, currentRevision: 2,
  fingerprint: 's'.repeat(64), behavior: 'Returns the declared evidence and recoverable gaps.', lifecycle: 'active' };
const proof: EngineeringProof = { id: 51, plan: spec.plan, spec: spec.id, revision: 2, workItem: 'WI-ee-proof',
  evidenceRef: 'test-run:72101', kind: 'test', state: 'current', withdrawn: false,
  fingerprints: { sourceFingerprint: 'source-set', testFingerprint: 'test-set', fixtureFingerprint: 'fixture-set' },
  runId: 72101, reasons: [] };
function fixture(patch: Partial<EngineeringEvidenceDeps> = {}): EngineeringEvidenceDeps {
  return {
    authorize: vi.fn(async () => true), symbol: vi.fn(async () => [symbol]), sourceCurrent: vi.fn(async () => true), items: vi.fn(async () => [item]),
    specs: vi.fn(async () => [spec]), spec: vi.fn(async () => ({ ...spec, revision: 1 })),
    decisions: vi.fn(async () => [
      { plan: item.plan, id: 'D-001', title: 'Explicit', body: 'Owns this item.', itemRefs: ['P-001'], affects: [] },
      { plan: 'ee-other', id: 'D-002', title: 'Broader', body: 'Context only.', itemRefs: [], affects: [item.plan] },
      { plan: item.plan, id: 'D-003', title: 'Unscoped', body: 'No declared applicability.', itemRefs: [], affects: [] },
      { plan: item.plan, id: 'D-004', title: 'Administrative', body: 'Amendment receipt.', itemRefs: [], affects: [] },
    ]),
    proofs: vi.fn(async () => [proof]),
    run: vi.fn(async () => ({ id: proof.runId!, file: 'evidence-feature.integration.test.ts', status: 'pass', commit: 'c'.repeat(40) })),
    cases: vi.fn(async () => [{ runId: proof.runId!, key: 'ee.intent-exact', occurrence: 1, status: 'passed' }]), ...patch,
  };
}
const query = { symbol: { path: symbol.path, name: symbol.name, line1: symbol.line1 } };

describe('native engineering evidence contract', () => {
  it('ee.intent-exact: preserves exact revision, binding, run and case identities without claiming execution', async () => {
    const graph = await readEngineeringEvidence(query, scope, fixture());
    expect(graph.nodes.find(n => n.kind === 'spec')?.data).toMatchObject({ id: 'EE-1', revision: 2, fingerprint: spec.fingerprint });
    expect(graph.nodes.find(n => n.kind === 'proof')?.data).toMatchObject({ id: 51, evidenceRef: 'test-run:72101', fingerprints: proof.fingerprints });
    expect(graph.nodes.find(n => n.kind === 'test-case')?.data).toEqual({ runId: 72101, key: 'ee.intent-exact', occurrence: 1, status: 'passed' });
    expect(graph.edges.map(e => e.basis)).toEqual(expect.arrayContaining(['declared-anchor', 'item-spec', 'proof-binding', 'recorded-test-run', 'recorded-case']));
    expect(graph.edges.every(e => e.knowledge === 'explicit' && Boolean(e.authority.tool))).toBe(true);
    expect(graph.execution.status).toBe('unobserved');
    expect(graph.gaps.some(g => g.code === 'exact-spec-case-mapping-not-measured')).toBe(true);
  });
  it('ee.decision-scope: separates itemRefs, broader affects and deliberately requested unscoped history', async () => {
    const graph = await readEngineeringEvidence(query, scope, fixture());
    expect(graph.nodes.filter(n => n.kind === 'decision').map(n => n.data.decision)).toEqual(['D-001', 'D-002']);
    expect(graph.edges.filter(e => e.basis === 'decision-item-ref')).toHaveLength(1);
    expect(graph.edges.filter(e => e.basis === 'plan-affects')).toHaveLength(1);
    const history = await readEngineeringEvidence({ ...query, includeContext: true }, scope, fixture());
    expect(history.edges.filter(e => e.basis === 'unscoped-context')).toHaveLength(2);
    expect(history.gaps.filter(g => g.code === 'decision-applicability-unknown')).toHaveLength(2);
  });
  it('ee.homonym: requires a single resolved declaration and never queries ownership on ambiguity', async () => {
    const deps = fixture({ symbol: async () => [symbol, { ...symbol, versionedSymbolId: 'homonym' }] });
    const graph = await readEngineeringEvidence(query, scope, deps);
    expect(graph.nodes).toEqual([]); expect(graph.gaps[0]?.code).toBe('ambiguous-symbol');
    expect(deps.items).not.toHaveBeenCalled();
  });
  it('ee.tenant-repo: denies unregistered roots before any content read', async () => {
    const deps = fixture({ authorize: async () => false });
    await expect(readEngineeringEvidence(query, scope, deps)).rejects.toThrow('scope_forbidden');
    expect(deps.symbol).not.toHaveBeenCalled(); expect(deps.items).not.toHaveBeenCalled();
  });
  it.each([{ ...item, workspaceId: 'ee-foreign' }, { ...item, harness: 'foreign-repo' }])('ee.foreign: rejects adapter scope expansion: %j', async foreign => {
    const deps = fixture({ items: async () => [foreign] });
    const graph = await readEngineeringEvidence(query, scope, deps);
    expect(graph.nodes.map(n => n.kind)).toEqual(['symbol']); expect(deps.specs).not.toHaveBeenCalled();
    expect(JSON.stringify(graph)).not.toContain('foreign-repo');
  });
  it('ee.spec-superseded: attaches historical proof only to its own immutable revision', async () => {
    const graph = await readEngineeringEvidence(query, scope, fixture({ proofs: async () => [{ ...proof, revision: 1 }] }));
    const historical = graph.nodes.find(n => n.kind === 'spec' && n.data.revision === 1)!;
    const binding = graph.nodes.find(n => n.kind === 'proof')!;
    expect(historical.state).toBe('historical'); expect(binding.state).toBe('historical');
    expect(graph.edges.find(e => e.to === binding.id && e.basis === 'proof-binding')?.from).toBe(historical.id);
  });
  it('ee.retracted: withdrawal cannot remain current support', async () => {
    const graph = await readEngineeringEvidence(query, scope, fixture({ proofs: async () => [{ ...proof, withdrawn: true }] }));
    expect(graph.nodes.find(n => n.kind === 'proof')?.state).toBe('historical');
    expect(graph.nodes.find(n => n.kind === 'proof')?.ref.args.includeRetracted).toBe(true);
  });
  it('ee.spec-retired: a retired current pointer cannot advertise current support', async () => {
    const graph = await readEngineeringEvidence(query, scope, fixture({ specs: async () => [{ ...spec, lifecycle: 'retired' }] }));
    expect(graph.nodes.find(n => n.kind === 'spec')?.state).toBe('historical');
    expect(graph.nodes.find(n => n.kind === 'proof')?.state).toBe('historical');
    expect(graph.edges.find(e => e.basis === 'item-spec')?.state).toBe('historical');
  });
  it('ee.source-race: revalidates captured code after slower authority reads', async () => {
    const graph = await readEngineeringEvidence(query, scope, fixture({ sourceCurrent: async () => false }));
    expect(graph.nodes.find(n => n.kind === 'symbol')?.state).toBe('unknown');
    expect(graph.edges.find(e => e.basis === 'declared-anchor')?.state).toBe('unknown');
    expect(graph.gaps.some(g => g.code === 'source-revalidation-failed')).toBe(true);
  });
  it('ee.pruned: missing test receipts remain resolving unknown nodes', async () => {
    const deps = fixture({ run: async () => null });
    const graph = await readEngineeringEvidence(query, scope, deps);
    expect(graph.nodes.find(n => n.kind === 'test-run')).toMatchObject({ state: 'unknown', data: { id: 72101, present: false } });
    expect(graph.gaps.some(g => g.code === 'test-run-unavailable' && g.at.args.testRunIds)).toBe(true);
    expect(deps.cases).not.toHaveBeenCalled();
  });
  it('ee.fingerprint-types: retains the canonical stale/unknown classification without recomparing unlike hashes', async () => {
    const graph = await readEngineeringEvidence(query, scope, fixture({ proofs: async () => [{ ...proof, state: 'unknown',
      fingerprints: { declaration: 'same', file: 'same' }, reasons: ['server-measurement-unavailable'] }] }));
    expect(graph.nodes.find(n => n.kind === 'proof')?.state).toBe('unknown');
    expect(graph.gaps.some(g => g.code === 'proof-unknown')).toBe(true);
  });
  it('ee.bounds: bounds adapter I/O, nodes, edges and omitted-row recovery', async () => {
    const deps = fixture({ cases: vi.fn(async () => Array.from({ length: 21 }, (_, i) => ({ runId: 72101,
      key: `ee.case-${i}`, occurrence: 1, status: 'passed' }))) });
    const graph = await readEngineeringEvidence(query, scope, deps);
    expect(deps.items).toHaveBeenCalledWith(scope, query, symbol, 9);
    expect(deps.cases).toHaveBeenCalledWith(scope, 72101, 21);
    expect(graph.nodes.filter(n => n.kind === 'test-case')).toHaveLength(20);
    expect(graph.truncated).toBe(true); expect(graph.gaps.some(g => g.code === 'row-limit' && g.at.tool === 'testing:runs')).toBe(true);
    const small = await readEngineeringEvidence({ ...query, limit: 3 }, scope, fixture());
    expect(small.nodes.length).toBeLessThanOrEqual(3); expect(small.truncated).toBe(true);
    expect(small.edges.every(e => small.nodes.some(n => n.id === e.from) && small.nodes.some(n => n.id === e.to))).toBe(true);
  });
  it('ee.authority-unavailable: preserves a useful partial result and recovery when one store fails', async () => {
    const graph = await readEngineeringEvidence(query, scope, fixture({ proofs: async () => { throw new Error('unavailable'); } }));
    expect(graph.nodes.some(n => n.kind === 'spec')).toBe(true);
    expect(graph.gaps.some(g => g.code === 'authority-unavailable' && g.at.tool === 'plans:get-specs')).toBe(true);
    expect(JSON.stringify(graph)).not.toContain('Error:');
  });
  it.each(['/outside.ts', '../outside.ts', 'src/../outside.ts', 'src\\outside.ts'])('rejects unsafe paths before authorization: %s', async path => {
    const deps = fixture();
    await expect(readEngineeringEvidence({ symbol: { path } }, scope, deps)).rejects.toThrow('selector_invalid');
    expect(deps.authorize).not.toHaveBeenCalled();
  });
});
