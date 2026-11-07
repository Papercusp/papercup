/**
 * Side-effect-free activation-readiness wiring. The helper owns the dynamic
 * production imports so plans:get and plans:audit can expose the same
 * plans:start candidate preview without opening a consult thread.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const M = vi.hoisted(() => ({
  getOrgPg: vi.fn(),
  routeConsult: vi.fn(),
  buildQueryEmbedderResolved: vi.fn(),
  resolveSessionStates: vi.fn(),
  planStartConsult: vi.fn(),
  fetchTurnExcerpts: vi.fn(),
}));

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: M.getOrgPg,
}));
vi.mock('../../consult/relevance-router', () => ({ routeConsult: M.routeConsult }));
vi.mock('../search/embedder', () => ({ buildQueryEmbedderResolved: M.buildQueryEmbedderResolved }));
vi.mock('../coordination/liveness-oracle', () => ({ resolveSessionStates: M.resolveSessionStates }));
vi.mock('../../consult/plan-start-consult', () => ({
  planStartConsult: M.planStartConsult,
  fetchTurnExcerpts: M.fetchTurnExcerpts,
}));
// Runtime build identity is best-effort and may be null when no baked/env SHA
// is available and Git resolution fails. Keep this unit test independent of the
// runner's Git state by injecting a stable value.
vi.mock('../../build-info', () => ({ getBuildInfo: () => ({ sha: 'abc1234', version: '0.0.0' }) }));

import { ACTIVATION_STAGE_IDS, activationDeclarationReadiness, collectActivationReadiness,
  previewPlanStartConsult, unavailableActivationReadiness, matchingActivationConsult,
  type ActivationReadinessBasis, type ActivationReadinessReaders } from './get-activation-readiness';

const params = {
  workspaceId: 'workspace-a',
  requesterId: 'su-reader',
  planSlug: 'plan-a',
  planContent: '---\nslug: plan-a\n---\n\n## Now\nship it',
};

beforeEach(() => {
  vi.clearAllMocks();
  const sql = vi.fn();
  M.getOrgPg.mockReturnValue({ sql });
  M.buildQueryEmbedderResolved.mockResolvedValue({
    mode: 'gemma',
    dims: 768,
    profile: {
      profileId: 'gemma-embeddinggemma-300m-768@v1',
      model: 'onnx-community/embeddinggemma-300m-ONNX',
      revision: 'v1',
      targetDims: 768,
      normalization: 'l2',
      distanceMetric: 'cosine',
      queryRecipe: 'gemma-query-v1',
      documentRecipe: 'gemma-document-v1',
    },
    embed: 'embedder',
  });
  M.resolveSessionStates.mockResolvedValue(
    new Map([['peer-live', { ownerId: 'peer-live', sessionState: 'live' }]]),
  );
  M.routeConsult.mockImplementation(async (_routeParams, options) => {
    options.getSql();
    const liveness = await options.getLiveness(['peer-live']);
    return { liveness };
  });
  M.fetchTurnExcerpts.mockResolvedValue([
    {
      ownerId: 'peer-dead',
      session_id: 'session-dead',
      turn_idx: 4,
      ts: null,
      sim: 0.7,
      excerpt: 'prior attempt',
    },
  ]);
});

describe('previewPlanStartConsult', () => {
  it('preserves every unknown stage and dependency when diagnostic setup is unavailable', () => {
    const result = unavailableActivationReadiness(new Error('reader offline'));
    expect(result.stages.map(s => s.id)).toEqual([...ACTIVATION_STAGE_IDS]);
    expect(result.stages.every(s => s.status === 'unknown' && s.detail === 'reader offline')).toBe(true);
    expect(result.stages.find(s => s.id === 'quality-audit')?.dependencies).toEqual(['spec-quality']);
    expect(result).toMatchObject({ ready: false, freshness: 'unknown', basis: null,
      counts: { total: 13, returned: 13, omitted: 0 }, consult: { outcome: 'unavailable' } });
  });
  it('wires production routing, liveness, and excerpt callbacks without opening a consult', async () => {
    M.planStartConsult.mockImplementation(async (consultParams, deps) => {
      await deps.route({
        workspaceId: consultParams.workspaceId,
        requesterId: consultParams.requesterId,
        question: 'plan query',
      });
      const excerpts = await deps.getExcerpts([{
        ownerId: 'peer-dead',
        evidence: [{ session_id: 'session-dead', turn_idx: 4, ts: null, sim: 0.7 }],
      }]);
      return { outcome: 'proceed_with_excerpts', candidates: [], excerpts };
    });

    const result = await previewPlanStartConsult(params);

    expect(result).toMatchObject({
      outcome: 'proceed_with_excerpts',
      excerpts: [{ ownerId: 'peer-dead', excerpt: 'prior attempt' }],
      productShaping: { advisory: true, status: 'missing', semanticCompleteness: 'not-measured' },
    });
    expect(M.buildQueryEmbedderResolved).toHaveBeenCalledTimes(1);
    expect(M.planStartConsult).toHaveBeenCalledWith(params, expect.any(Object));
    expect(M.routeConsult).toHaveBeenCalledWith(
      {
        workspaceId: 'workspace-a',
        requesterId: 'su-reader',
        question: 'plan query',
        telemetry: expect.objectContaining({ caller: 'plans:activation-preview', policy: 'consult-default', buildSha: expect.any(String) }),
      },
      expect.any(Object),
    );
    expect(M.resolveSessionStates).toHaveBeenCalledWith(
      [{ ownerId: 'peer-live' }],
      { hydratePerId: true },
    );
    expect(M.fetchTurnExcerpts).toHaveBeenCalledWith(
      expect.any(Function),
      'workspace-a',
      [{ ownerId: 'peer-dead', evidence: [{ session_id: 'session-dead', turn_idx: 4, ts: null, sim: 0.7 }] }],
    );
  });

  it('reports an unavailable advisory outcome when production wiring cannot initialize', async () => {
    M.buildQueryEmbedderResolved.mockRejectedValue(new Error('embedder unavailable'));

    const result = await previewPlanStartConsult(params);

    expect(result).toMatchObject({
      outcome: 'unavailable',
      error: 'consult_preview_unavailable',
      message: 'Consult candidate preview could not be evaluated (embedder unavailable).',
      productShaping: { advisory: true, status: 'missing', reviewerBrief: { sourceRefs: [] } },
    });
    expect(M.planStartConsult).not.toHaveBeenCalled();
  });

  it('keeps the original-intent review available even when consult routing is unavailable', async () => {
    M.buildQueryEmbedderResolved.mockRejectedValue(new Error('embedder unavailable'));
    const sourceRef = 'session_turn:codex:original:1';
    const planContent = '## Product shaping\n```product-shaping\n' + JSON.stringify({
      audience: 'Collaborators', problem: 'Readers can accidentally publish', outcome: 'Readers retain read access without publishing',
      nonGoals: ['Role administration'], sourceRefs: [sourceRef], context: [], scenarios: [], considerations: [],
    }) + '\n```';
    const result = await previewPlanStartConsult({ ...params, planContent });
    expect(result).toMatchObject({ outcome: 'unavailable', productShaping: {
      status: 'incomplete', advisory: true, sourceContentVerified: false,
      reviewerBrief: { sourceRefs: [sourceRef], planSection: 'Product shaping' },
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'normal_journey_missing' })]),
    } });
    expect(result.productShaping?.reviewerBrief.instructions[0]).toContain('BEFORE');
  });
});

// plan-reuse-and-library-declarations-2026-10-20 R-3.
describe('activationDeclarationReadiness', () => {
  const plan = (sections = '') =>
    `---\ntitle: Plan A\nslug: plan-a\nstatus: draft\n---\n\n## Items\n\n- **P-001** \`todo\` Do the thing.\n${sections}`;
  const librariesNotApplicable =
    '\n## Third-party libraries\n\n```libraries\n{"needs":[],"notApplicable":"No library could do this."}\n```\n';

  it('R-3: readiness lists a missing declaration section as a blocker', () => {
    const readiness = activationDeclarationReadiness(plan(librariesNotApplicable), 'draft');
    expect(readiness).toMatchObject({
      ready: false,
      applies: true,
      reuse: 'missing',
      libraries: 'not-applicable',
      blockers: [{ code: 'plan_declarations_invalid', section: 'Existing infrastructure reused', status: 'missing' }],
    });
    expect(readiness.blockers).toHaveLength(1);
  });

  it('R-3 / D-013 #1: a plan with no status is gated (fail closed)', () => {
    expect(activationDeclarationReadiness(plan(), null)).toMatchObject({
      ready: false, applies: true, reuse: 'missing', libraries: 'missing',
    });
  });

  it('R-3: readiness reports no blockers for an active plan (no retrofit)', () => {
    expect(activationDeclarationReadiness(plan(), 'active')).toMatchObject({
      ready: true, applies: false, reuse: 'missing', libraries: 'missing', blockers: [],
    });
  });
});

describe('collectActivationReadiness', () => {
  const basis: ActivationReadinessBasis = { workspaceId: 'w', harnessSlug: 'h', planSlug: 'p',
    planRevision: 1, planHash: 'plan', requesterId: 'reader', policyHash: 'policy',
    specSetHash: 'specs', evidenceHash: 'evidence' };
  function readers(): ActivationReadinessReaders {
    return { readBasis: vi.fn().mockResolvedValue({ ...basis }),
      stages: Object.fromEntries(ACTIVATION_STAGE_IDS.map(id => [id,
        vi.fn().mockResolvedValue({ status: 'pass', codes: [`${id}_ready`], nextAction: 'Continue canonical start.' })])) };
  }
  it.each(['workspaceId', 'harnessSlug', 'planSlug', 'planHash', 'requesterId', 'policyHash'] as const)(
    'never reuses consultation advice across a changed %s', key => {
      const consult = { outcome: 'unavailable' as const, error: 'consult_preview_unavailable' as const, message: 'honest failure' };
      const receipt = { basis, consult };
      expect(matchingActivationConsult(receipt, { ...basis })).toBe(consult);
      expect(matchingActivationConsult(receipt, { ...basis, [key]: 'different' })).toBeUndefined();
      expect(matchingActivationConsult(undefined, basis)).toBeUndefined();
      expect(matchingActivationConsult(receipt, undefined)).toBeUndefined();
    });
  it('reports three independent blockers without an early return', async () => {
    const r = readers();
    for (const id of ['source-discovery', 'inputs', 'anchors'] as const)
      r.stages[id] = vi.fn().mockResolvedValue({ status: 'blocked', codes: [id + '_missing'], nextAction: 'Repair ' + id });
    const result = await collectActivationReadiness(r);
    expect(result.stages.filter(s => s.status === 'blocked').map(s => s.id)).toEqual(['source-discovery', 'inputs', 'anchors']);
    expect(result).toMatchObject({ schemaVersion: 1, advisory: true, ready: false, freshness: 'current',
      counts: { total: 13, returned: 13, omitted: 0 } });
  });
  it('waits on quality dependencies while admission, lane and promotion remain independently visible', async () => {
    const r = readers();
    r.stages['bar-contract'] = vi.fn().mockResolvedValue({ status: 'blocked', codes: ['bar_contract_missing'], nextAction: 'Repair BAR.' });
    r.stages.lane = vi.fn().mockResolvedValue({ status: 'blocked', codes: ['floor-gated'], nextAction: 'Inspect named floor.' });
    r.stages.promotion = vi.fn().mockResolvedValue({ status: 'waiting', codes: ['waiting-for-promotion'], nextAction: 'Use canonical start.' });
    const result = await collectActivationReadiness(r);
    expect(r.stages['spec-quality']).not.toHaveBeenCalled();
    expect(result.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'admission', status: 'pass' }),
      expect.objectContaining({ id: 'lane', status: 'blocked', codes: ['floor-gated'] }),
      expect.objectContaining({ id: 'promotion', status: 'waiting' }),
      expect.objectContaining({ id: 'contract-critique', status: 'waiting', dependencies: ['spec-quality', 'quality-audit'] }),
    ]));
  });
  it.each(['planRevision', 'planHash', 'requesterId', 'policyHash', 'specSetHash', 'evidenceHash'] as const)(
    'invalidates successful observations when %s moves', async key => {
      const r = readers();
      vi.mocked(r.readBasis).mockResolvedValueOnce({ ...basis }).mockResolvedValueOnce({ ...basis,
        [key]: key === 'planRevision' ? 2 : 'changed' });
      const result = await collectActivationReadiness(r);
      expect(result).toMatchObject({ ready: false, freshness: 'changed' });
      expect(result.stages.every(s => s.status === 'unknown' && s.codes[0] === 'activation_basis_changed')).toBe(true);
    });
  it('does not treat an unavailable reader, malformed observation or absent fingerprint as passed', async () => {
    const r = readers();
    delete r.stages.inputs;
    r.stages.anchors = vi.fn().mockResolvedValue({ status: 'pass', codes: [], nextAction: 'Continue.' });
    let result = await collectActivationReadiness(r);
    expect(result.stages.filter(s => s.status === 'unknown').map(s => s.id)).toEqual(['inputs', 'anchors']);
    vi.mocked(r.readBasis).mockRejectedValue(new Error('identity store unavailable'));
    result = await collectActivationReadiness(r);
    expect(result).toMatchObject({ ready: false, freshness: 'unknown', basis: null });
    expect(result.stages.every(s => s.status === 'unknown')).toBe(true);
  });
  it('bounds detail without silently removing stages', async () => {
    const r = readers();
    r.stages.inputs = vi.fn().mockResolvedValue({ status: 'blocked', codes: Array(30).fill('x'.repeat(300)),
      evidenceRefs: Array(20).fill('y'.repeat(400)), detail: 'z'.repeat(4000), nextAction: 'a'.repeat(3000) });
    const result = await collectActivationReadiness(r);
    expect(result.counts).toEqual({ total: 13, returned: 13, omitted: 0 });
    expect(result.stages[2]).toMatchObject({ omittedDetail: { codes: 22, evidenceRefs: 12 } });
    expect(JSON.stringify(result).length).toBeLessThan(11000);
  });
});
