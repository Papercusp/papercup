import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpecClauseRevision } from './spec-clauses-store';
import { hashPlanContent } from './content-hash';
import { evaluatePlanSpecQuality } from './spec-quality';
import { computeSpecSetHash, SPEC_SET_HASH_VERSION } from './spec-clause-compiler';
import * as buildInfo from '../../build-info';
import { scorecardEvidenceFingerprint } from '../../scorecards';
import { applyPayloadTier } from '@papercusp/tooldef';
import { applyResultDoor } from '../../result-door';

const reads = vi.hoisted(() => ({ plan: vi.fn(), clauses: vi.fn(), snapshot: vi.fn(), rubrics: vi.fn(), rubricRevision: vi.fn(), rubric: vi.fn(), discovery: vi.fn() }));
vi.mock('../../plan-audits', async original => ({ ...await original<typeof import('../../plan-audits')>(),
  withCurrentDiscovery: reads.discovery }));
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: () => ({ ownerId: 'su-replay-test' }) }));
vi.mock('./source', async (original) => ({ ...await original<typeof import('./source')>(), readPlanBySlug: reads.plan }));
vi.mock('./revisions', async (original) => ({ ...await original<typeof import('./revisions')>(), getPlanRevisionSnapshot: reads.snapshot }));
vi.mock('./spec-clauses-store', async (original) => ({ ...await original<typeof import('./spec-clauses-store')>(), listSpecClauses: reads.clauses }));
vi.mock('../../rubrics', async (original) => ({ ...await original<typeof import('../../rubrics')>(),
  getAcceptanceRubricsForPlan: reads.rubrics, getRubric: reads.rubricRevision, readRubric: reads.rubric }));
vi.mock('./_ctx-opts', async (original) => ({ ...await original<typeof import('./_ctx-opts')>(),
  ctxToPlanSourceOpts: async () => ({}), resolveEffectiveHarnessSlug: () => 'papercusp' }));
vi.mock('../_harness-scope', async (original) => ({ ...await original<typeof import('../_harness-scope')>(), harnessScopedCtx: (_h: unknown, ctx: unknown) => ctx }));
import tool from './evaluate-spec-quality';
import { emitScorecard } from '../scorecards/emit';

const oldBody = '---\ntitle: Replay fixture\nstatus: ready\n---\n## Items\n- **P-001** `todo` Accept an event';
const newBody = oldBody + '\n- **P-002** `todo` Validate an event';
const oldHash = hashPlanContent(oldBody);
const oldClause: SpecClauseRevision = {
  planSlug: 'quality-plan', specId: 'SPEC-001', sourceValId: 'VAL-001', currentRevision: 1, revision: 1,
  planItemId: 'P-001', behavior: 'POST /events returns 202 for a valid event', behaviorClass: 'happy-path',
  requiredEvidence: [], requiredTestLayers: ['integration'], mutationRequired: false,
  lifecycleStatus: 'active', supersedes: null, exemption: null, falsifier: null,
  contentHash: 'a'.repeat(64), createdBy: 'author', createdAt: '2026-08-20T00:00:00.000Z',
  acceptedBy: 'reviewer', acceptedAt: '2026-08-20T00:00:00.000Z', acceptanceRef: 'D-001',
};
const newClause = { ...oldClause, currentRevision: 2, revision: 2, contentHash: 'b'.repeat(64),
  behavior: 'POST /events returns 201 for a valid event', createdAt: '2026-08-21T00:00:00.000Z',
  acceptedAt: '2026-08-21T00:00:00.010Z' };
const oldEvaluation = evaluatePlanSpecQuality({ planSlug: 'quality-plan', harnessSlug: 'papercusp',
  planItemIds: ['P-001'], clauses: [oldClause], classRef: 'plan-class-feature-ship' });
const replaySnapshot = { planContentHash: oldHash, clausesAsOf: '2026-08-20T00:00:00.001Z' };
const replayArgs = { slug: 'quality-plan', harness: 'papercusp', classRef: 'plan-class-feature-ship' as const,
  expectedSpecSetHash: oldEvaluation.specSetHash, replaySnapshot };
const call = async (args: Record<string, unknown>) => {
  const result = await tool.handler(tool.args.parse(args), {} as never);
  return (result as { data: Record<string, any> }).data;
};

afterEach(() => vi.restoreAllMocks());

beforeEach(() => {
  vi.resetAllMocks();
  reads.discovery.mockImplementation(async (_input: unknown, accept: () => Promise<unknown>) => ({ ok: true, result: await accept() }));
  reads.plan.mockResolvedValue({ row: { items: [{ id: 'P-001' }, { id: 'P-002' }], template: null,
    templateData: null, inputSchema: null, contentHash: hashPlanContent(newBody) }, parsed: { items: [] } });
  reads.rubrics.mockResolvedValue([{ classRef: 'plan-class-feature-ship' }]);
  reads.snapshot.mockImplementation(async (_slug, hash) => ({ contentSnapshot: hash === oldHash ? oldBody : newBody,
    contentSnapshotHash: hash === oldHash ? oldHash : hashPlanContent(newBody) }));
  reads.clauses.mockImplementation(async (args) => args.asOf === replaySnapshot.clausesAsOf ? [oldClause] : [newClause]);
});

describe('immutable spec-quality replay (WI-10007284)', () => {
  it.each(['clauses', 'plan'])('preserves historical reflection but refuses new publication after current %s change', async change => {
    const historical = await call(replayArgs);
    expect(historical).toMatchObject({ ok: true, verdict: 'pass' });
    expect(reads.plan).not.toHaveBeenCalled();
    if (change === 'plan') reads.clauses.mockResolvedValue([oldClause]);
    reads.rubric.mockResolvedValue({ kind: 'found', rubric: {
      rubricId: 'spec-quality', kind: 'standard', status: 'active',
      criteria: Object.keys(historical.ratings).map(key => ({ key, title: key })),
      ratingScale: ['pass', 'fail', 'unknown'],
    } });
    const dispatchTool = vi.fn(async (_name: string, args: Record<string, unknown>) => {
      const { payloadTier: _tier, ...evaluatorArgs } = args;
      return call(evaluatorArgs);
    });
    const result = await emitScorecard(historical.scorecardDraft, { createdBy: 'su-replay-test' }, {
      getEvaluatorBuild: buildInfo.getBuildInfo,
      resolveSpecQualityPlanSubject: async () => ({ planSlug: 'quality-plan', harnessSlug: 'papercusp' }),
      withCurrentDiscovery: reads.discovery,
      dispatchTool,
    });
    expect(result).toMatchObject({ ok: false, code: 'invalid_spec_quality_binding' });
    expect(dispatchTool).toHaveBeenCalledOnce();
    expect(dispatchTool.mock.calls[0][1]).not.toHaveProperty('replaySnapshot');
    expect(reads.plan).toHaveBeenCalledOnce();
  });

  it('pins live BAR scope evaluation to an immutable rubric revision and replays it after the scope changes', async () => {
    const rubric = { rubricId: 'acceptance-quality-plan', revision: 8, criteriaHash: 'c'.repeat(64),
      kind: 'acceptance', subjectPlan: 'quality-plan', subjectHarnessSlug: 'papercusp', classRef: 'plan-class-feature-ship',
      criteria: [{ key: 'r-17', barKey: 'R-17', requiredScope: ['P-001'] }] };
    const projection = { ...newClause, specId: 'AUTO-BAR-R-17-P-001', sourceValId: null,
      sourceBar: { rubricSlug: rubric.rubricId, rubricRevision: 4, barKey: 'R-17',
        barHash: 'd'.repeat(64), barSetHash: 'e'.repeat(64), evidencePlane: 'tree' } };
    reads.plan.mockResolvedValue({ row: { items: [{ id: 'P-001' }], template: null,
      templateData: null, inputSchema: null, contentHash: oldHash }, parsed: { items: [] } });
    reads.clauses.mockResolvedValue([newClause, projection]);
    reads.rubrics.mockResolvedValue([rubric]);
    const live = await call({ slug: 'quality-plan', harness: 'papercusp' });
    expect(live.replaySnapshot.acceptanceRubric).toEqual({ rubricId: rubric.rubricId, revision: 8, criteriaHash: rubric.criteriaHash });
    reads.rubrics.mockResolvedValue([{ ...rubric, revision: 9, criteriaHash: 'f'.repeat(64),
      criteria: [{ key: 'r-17', barKey: 'R-17', requiredScope: ['P-002'] }] }]);
    reads.rubricRevision.mockResolvedValue(rubric);
    const replay = await call({ slug: 'quality-plan', harness: 'papercusp', classRef: 'plan-class-feature-ship',
      expectedSpecSetHash: live.specSetHash, replaySnapshot: live.replaySnapshot });
    expect(reads.rubricRevision).toHaveBeenCalledWith(rubric.rubricId, 8);
    expect(replay.ratings).toEqual(live.ratings);
  });

  it('refuses a missing pinned rubric instead of substituting the live scope', async () => {
    reads.rubricRevision.mockResolvedValue(null);
    const result = await call({ ...replayArgs, replaySnapshot: { ...replaySnapshot,
      acceptanceRubric: { rubricId: 'acceptance-quality-plan', revision: 8, criteriaHash: 'c'.repeat(64) } } });
    expect(result).toMatchObject({ ok: false, error: 'acceptance_rubric_snapshot_unavailable' });
    expect(result).not.toHaveProperty('scorecardDraft');
    expect(reads.rubrics).not.toHaveBeenCalled();
  });

  it.each([null, '', ' \t '].flatMap(sha => ['full', 'summary'].flatMap(detail =>
    ['fresh', 'replay'].map(route => ({ sha, detail, route })))))(
    'refuses an unpinned live evaluator before reads ($route, $detail, SHA=$sha)', async ({ sha, detail, route }) => {
      vi.spyOn(buildInfo, 'getBuildInfo').mockReturnValue({ ...buildInfo.getBuildInfo(), sha });
      const result = await call({ ...(route === 'replay' ? replayArgs : { slug: 'quality-plan', harness: 'papercusp' }), detail });
      expect(result).toMatchObject({ ok: false, code: 'spec_quality_evaluator_mismatch' });
      expect(result.error).toContain('verified build identity');
      expect(result).not.toHaveProperty('scorecardDraft');
      expect(result).not.toHaveProperty('scorecardBinding');
      for (const read of Object.values(reads)) expect(read).not.toHaveBeenCalled();
    });

  it('keeps an exact complete evidence binding through the bounded replay transport (WI-6554700010045887)', async () => {
    const full = await call(replayArgs);
    const summary = await call({ ...replayArgs, detail: 'summary' });
    const tiered = applyPayloadTier({ toolName: 'plans:evaluate-spec-quality', shape: undefined,
      response: { data: summary }, tier: 'full', explicitFullRequest: true,
      args: { ...replayArgs, detail: 'summary', payloadTier: 'full' } });
    const doored = applyResultDoor({ content: [{ type: 'text' as const, text: JSON.stringify(tiered.data) }] },
      { toolName: 'plans:evaluate-spec-quality', workspaceId: 'spec-quality-replay-test' });
    const delivered = JSON.parse(doored.content[0].text);
    expect(delivered).toMatchObject({ ok: true, evaluatorBuild: full.evaluatorBuild,
      specSetHashVersion: full.specSetHashVersion, specSetHash: full.specSetHash,
      scorecardBinding: { subject: full.scorecardDraft.subject,
        evidenceFingerprint: scorecardEvidenceFingerprint({ rubricRef: full.scorecardDraft.rubricRef,
          ratings: full.scorecardDraft.ratings }) } });
    expect(JSON.stringify(tiered.data).length).toBeLessThan(2000);
    expect(tiered.data).not.toHaveProperty('scorecardDraft');
    expect(tiered.data).not.toHaveProperty('ratings');
    const changed = { ...full.scorecardDraft, ratings: { ...full.scorecardDraft.ratings,
      falsifiability: { ...full.ratings.falsifiability, evidence: full.ratings.falsifiability.evidence + ' changed' } } };
    expect(scorecardEvidenceFingerprint({ rubricRef: changed.rubricRef, ratings: changed.ratings }))
      .not.toBe(summary.scorecardBinding.evidenceFingerprint);
  });

  it('keeps summary replay fail-closed on a different spec set', async () => {
    const result = await call({ ...replayArgs, detail: 'summary', expectedSpecSetHash: 'f'.repeat(64) });
    expect(result).toMatchObject({ ok: false, error: 'spec_set_hash_mismatch' });
    expect(result).not.toHaveProperty('scorecardBinding');
  });

  it('binds the executable quality recipe to the serving evaluator and hash protocol', async () => {
    const result = await call({ slug: 'quality-plan', harness: 'papercusp' });
    expect(result.scorecardDraft.rerunRecipe).toMatchObject({
      evaluator: 'plans:evaluate-spec-quality', evaluatorBuild: buildInfo.getBuildInfo(),
      specSetHashVersion: SPEC_SET_HASH_VERSION,
      args: { expectedSpecSetHash: result.specSetHash, evaluatorBuild: buildInfo.getBuildInfo(),
        specSetHashVersion: SPEC_SET_HASH_VERSION, replaySnapshot: result.replaySnapshot },
    });
    expect((await call(result.scorecardDraft.rerunRecipe.args)).ratings).toEqual(result.ratings);
  });

  it.each([
    { specSetHashVersion: 1 },
    { evaluatorBuild: { sha: 'older-evaluator', version: '0.0.0' } },
    { evaluatorBuild: { sha: null, version: '0.0.0' } },
  ])('refuses an incompatible evaluator before any snapshot or clause read: %j', async pin => {
    const result = await call({ ...replayArgs, ...pin });
    expect(result).toMatchObject({ ok: false, code: 'spec_quality_evaluator_mismatch' });
    expect(result).not.toHaveProperty('scorecardDraft');
    expect(reads.snapshot).not.toHaveBeenCalled();
    expect(reads.clauses).not.toHaveBeenCalled();
  });

  it('the same clauses reproduce the old hash only when falsifiers are omitted, never by replaying v1 on v2', async () => {
    const falsifier = { observation: 'A valid request returns a rejection', probeMethod: 'Send a valid event' };
    const clauses = [{ ...oldClause, falsifier }];
    const legacyHash = computeSpecSetHash(clauses.map(({ falsifier: _ignored, ...row }) => row));
    const currentHash = computeSpecSetHash(clauses);
    expect(currentHash).not.toBe(legacyHash);
    expect(computeSpecSetHash(clauses)).toBe(currentHash);
    reads.clauses.mockResolvedValue(clauses);
    const incompatible = await call({ ...replayArgs, expectedSpecSetHash: legacyHash, specSetHashVersion: 1 });
    expect(incompatible).toMatchObject({ ok: false, code: 'spec_quality_evaluator_mismatch' });
    expect(reads.clauses).not.toHaveBeenCalled();
    expect(computeSpecSetHash([{ ...clauses[0]!, falsifier: { ...falsifier, probeMethod: 'Send a valid event twice' } }]))
      .not.toBe(currentHash);
  });

  it('preserves historical reflection without requiring live discovery or recruiting a reviewer', async () => {
    reads.discovery.mockResolvedValue({ ok: false, error: 'discovery_not_ready' });
    expect(await call(replayArgs)).toMatchObject({ ok: true, specSetHash: oldEvaluation.specSetHash });
    expect(reads.discovery).not.toHaveBeenCalled();
  });
  it('reproduces all eight historical findings after both the clause and live item population change', async () => {
    const replay = await call(replayArgs);
    expect(replay).toMatchObject({ ok: true, verdict: 'pass', specSetHash: oldEvaluation.specSetHash, planItemCount: 1 });
    expect(Object.keys(replay.ratings)).toHaveLength(8);
    expect(replay.details.exemptionCensus).toMatchObject({
      specSetHash: oldEvaluation.specSetHash,
      currentClauseCount: 1,
      exemptClauseCount: 0,
      validExemptionSpecIds: [],
      invalidExemptionSpecIds: [],
      rows: [{
        specId: oldClause.specId,
        revision: oldClause.revision,
        planItemId: oldClause.planItemId,
        lifecycleStatus: oldClause.lifecycleStatus,
        behaviorClass: oldClause.behaviorClass,
        exemptionDeclared: false,
        valid: null,
      }],
    });
    expect(replay.ratings['explicit-non-behavioral-exemptions'].evidence)
      .toContain(`row census SHA-256=${replay.details.exemptionCensus.censusSha256}`);
    for (const [key, value] of Object.entries(oldEvaluation.ratings)) {
      expect(replay.ratings[key].rating).toBe(value.rating);
      expect(replay.ratings[key].evidence).toContain(value.evidence);
      const marker = ' Historical replay (same rated snapshot): plans:evaluate-spec-quality ';
      const probe = JSON.parse(replay.ratings[key].evidence.split(marker)[1].slice(0, -1));
      expect((await call(probe)).ratings).toEqual(replay.ratings);
    }
    expect(reads.plan).not.toHaveBeenCalled();
    expect(reads.rubrics).not.toHaveBeenCalled();
    expect(reads.snapshot).toHaveBeenCalledWith('quality-plan', oldHash, { exactBody: true });
  });

  it('retains the live hash refusal and never offers a draft for a newer set', async () => {
    const result = await call({ ...replayArgs, replaySnapshot: undefined });
    expect(result).toMatchObject({ ok: false, error: 'spec_set_hash_mismatch' });
    expect(result.specSetHash).not.toBe(oldEvaluation.specSetHash);
    expect(result).not.toHaveProperty('scorecardDraft');
  });

  it('rejects a later clause-set hash paired with an earlier replay cutoff', async () => {
    const laterEvaluation = evaluatePlanSpecQuality({ planSlug: 'quality-plan', harnessSlug: 'papercusp',
      planItemIds: ['P-001'], clauses: [newClause], classRef: 'plan-class-feature-ship' });
    expect(Date.parse(newClause.acceptedAt)).toBeGreaterThan(Date.parse(replaySnapshot.clausesAsOf));

    const replay = await call({ ...replayArgs, expectedSpecSetHash: laterEvaluation.specSetHash });
    expect(replay).toMatchObject({
      ok: false,
      error: 'spec_set_hash_mismatch',
      expectedSpecSetHash: laterEvaluation.specSetHash,
      specSetHash: oldEvaluation.specSetHash,
    });
    expect(replay).not.toHaveProperty('scorecardDraft');
  });

  it('issues a deterministic, already-reconstructed replay recipe for fresh grades', async () => {
    const first = await call({ slug: 'quality-plan', harness: 'papercusp' });
    const second = await call({ slug: 'quality-plan', harness: 'papercusp' });
    expect(first.ok).toBe(true);
    expect(first).toEqual(second);
    expect(reads.snapshot).toHaveBeenCalledWith('quality-plan', hashPlanContent(newBody),
      { workspaceId: undefined, exactBody: true });
    expect(Date.parse(first.replaySnapshot.clausesAsOf)).toBeGreaterThanOrEqual(Date.parse(newClause.acceptedAt));
    const replay = await call({ slug: 'quality-plan', harness: 'papercusp', classRef: first.classRef,
      expectedSpecSetHash: first.specSetHash, replaySnapshot: first.replaySnapshot });
    expect(replay.ratings).toEqual(first.ratings);
  });

  it.each(['missing-plan', 'corrupt-plan', 'missing-clauses', 'store-unavailable', 'wrong-cutoff', 'future-cutoff'])(
    'fails closed for %s without falling back to live data', async (failure) => {
      let args = replayArgs;
      if (failure === 'missing-plan') reads.snapshot.mockResolvedValue(null);
      if (failure === 'corrupt-plan') reads.snapshot.mockResolvedValue({ contentSnapshot: newBody, contentSnapshotHash: hashPlanContent(newBody) });
      if (failure === 'missing-clauses') reads.clauses.mockResolvedValue([]);
      if (failure === 'store-unavailable') reads.snapshot.mockRejectedValue(new Error('store offline'));
      if (failure === 'wrong-cutoff') args = { ...args, replaySnapshot: { ...replaySnapshot, clausesAsOf: '2026-08-21T00:00:00.001Z' } };
      if (failure === 'future-cutoff') args = { ...args, replaySnapshot: { ...replaySnapshot, clausesAsOf: '2999-08-21T00:00:00.001Z' } };
      const result = await call(args);
      expect(result.ok).toBe(false);
      expect(result).not.toHaveProperty('scorecardDraft');
      expect(reads.plan).not.toHaveBeenCalled();
    });

  it('refuses incomplete snapshot identities before any store read', () => {
    expect(tool.args.safeParse({ slug: 'quality-plan', replaySnapshot }).success).toBe(false);
    expect(tool.args.safeParse({ ...replayArgs, expectedSpecSetHash: undefined }).success).toBe(false);
    expect(tool.args.safeParse({ ...replayArgs, replaySnapshot: { ...replaySnapshot, clausesAsOf: 'invalid' } }).success).toBe(false);
    expect(reads.snapshot).not.toHaveBeenCalled();
  });
});
