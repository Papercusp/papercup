import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  DESKTOP_CANARY, DESIGN_ROLLOUT_CONTROLS, DESIGN_ROLLOUT_REVIEW_RUBRIC,
  designRolloutPolicySchema, evaluateDesignRollout, readDesignRolloutAdmission,
  type DesignRolloutPolicy, type RolloutScope,
} from './rollout';
import type { ScorecardEvidenceReadResult } from '../scorecards';
import { createInMemoryReferenceStore } from './reference-store';
import { ratifyReferenceVerb, type RatifyReferenceInput, type VerbDeps } from './verbs';

const root = resolve(import.meta.dirname, '../../../..');
const journey = JSON.parse(readFileSync(join(root, 'docs/evidence/desktop-design-journey-p002-2026-09-08.json'), 'utf8'));
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const scope: RolloutScope = {
  harnessSlug: 'papercusp', featureId: 'explicit-second-plan', referenceId: 'approved-screen',
  contentSha256: sha('image'), actorId: 'implementer',
  approval: { schemaVersion: 1, approvalRef: 'owner-turn:approved', planSlug: 'explicit-second-plan', planItemIds: ['P-001'], targetRoute: '/settings' },
};
const cohort = { harnessSlug: scope.harnessSlug, featureId: scope.featureId,
  planSlug: scope.approval.planSlug, planItemIds: ['P-001'], targetRoute: scope.approval.targetRoute };
const now = Date.parse('2026-09-08T23:00:00Z');
function policy(): DesignRolloutPolicy {
  const evidence = { path: 'evidence.txt', sha256: sha('saved evidence') };
  return {
    schemaVersion: 1, version: 'desktop-rollout-v1', author: 'implementer', scopeMode: 'explicit-approval',
    historical: { unadopted: 'preserve-existing-policy', adopted: 'preserve-obligation', migration: 'new-approved-revision' },
    canary: { featureId: DESKTOP_CANARY.featureId, referenceSha256: DESKTOP_CANARY.contentSha256,
      original: { buildId: journey.original.build.buildId, testRunRef: `test-run:${journey.original.testRunId}`, outcome: 'fail' },
      repaired: { buildId: journey.positive.build.buildId, testRunRef: `test-run:${journey.positive.testRunId}`, outcome: 'pass' },
      evidence: { path: 'journey.json', sha256: sha(JSON.stringify(journey)) }, connectivity: 'not-established' },
    controls: DESIGN_ROLLOUT_CONTROLS.map(id => ({ id, evidence, negative: 'fail', repaired: 'pass' })),
    authorGuidance: evidence, cohorts: [cohort], exceptions: [],
  };
}
function review(digest: string): ScorecardEvidenceReadResult {
  return { kind: 'found', scorecard: {
    issueId: 'EI-123', createdAt: '2026-09-08T22:30:00Z', createdBy: 'independent-reviewer',
    rubricRef: DESIGN_ROLLOUT_REVIEW_RUBRIC, rubricResolved: true, synthesized: false,
    subject: { kind: 'plan', ref: 'design-acceptance-journey-enforcement-2026-09-08' },
    auditTarget: { current: true, superseded: false, supersededBy: null, retracted: false, subjectRubricCurrentness: null },
    nKeys: 5, missingKeys: [], extraKeys: [], criteria: ['r-1', 'r-2', 'r-3', 'r-4', 'r-5'].map(key => ({ key, rating: 'healthy', evidence: JSON.stringify({
      designRolloutPolicySha256: digest, verdict: 'accepted', canaryGrade: 'pass',
    }) })),
  } };
}
const evaluate = (candidate: unknown, card = review(sha(JSON.stringify(candidate))), target = scope) =>
  evaluateDesignRollout({ policy: candidate, policySha256: sha(JSON.stringify(candidate)), review: card, scope: target, now });

describe('desktop rollout prerequisites, paired with a reachable positive', () => {
  it('[desktop.rollout.canary-pair] requires the actual original-negative/repaired-positive identities', () => {
    const candidate = policy();
    expect(journey.original.cases.every((row: { shellReady: boolean; desktopWorkspacePresent: boolean }) => row.shellReady && !row.desktopWorkspacePresent)).toBe(true);
    expect(journey.positive.status).toBe('pass');
    expect(evaluate(candidate).satisfied).toBe(true);
    candidate.canary.original = { ...candidate.canary.repaired, outcome: 'fail' };
    expect(evaluate(candidate).reason).toBe('invalid-rollout-policy');
  });
  it('[desktop.rollout.negative-census] removing or duplicating any named control prevents expansion', () => {
    expect(evaluate(policy()).satisfied).toBe(true);
    for (const id of DESIGN_ROLLOUT_CONTROLS) {
      const candidate = policy(); candidate.controls = candidate.controls.filter(row => row.id !== id);
      expect(evaluate(candidate).satisfied, id).toBe(false);
      candidate.controls.push(candidate.controls[0]!);
      expect(evaluate(candidate).satisfied, `duplicate replacing ${id}`).toBe(false);
    }
  });
  it('[desktop.rollout.migration-policy] refuses silent historical reclassification', () => {
    const candidate = policy(); expect(evaluate(candidate).satisfied).toBe(true);
    expect(evaluate({ ...candidate, historical: undefined }).satisfied).toBe(false);
    expect(evaluate({ ...candidate, historical: { ...candidate.historical, migration: 'automatic' } }).satisfied).toBe(false);
  });
  it('[desktop.rollout.exception-policy] an exception is owned, reviewed, scoped, temporary and only defers new adoption', () => {
    const candidate = policy(); expect(evaluate(candidate).satisfied).toBe(true);
    const exception = { id: 'temporary', version: 1, scope: cohort, owner: 'scope-owner', reason: 'awaiting approved reference', approvalRef: 'owner-turn:defer',
      startsAt: '2026-09-08T22:00:00Z', expiresAt: '2026-09-09T22:00:00Z', disposition: 'defer-new-adoption' as const };
    candidate.exceptions = [exception];
    expect(evaluate(candidate).reason).toBe('adoption-explicitly-deferred');
    for (const change of [{ owner: '' }, { approvalRef: '' }, { expiresAt: '2026-10-01T00:00:00Z' }, { disposition: 'waive-failed-proof' }]) {
      expect(evaluate({ ...candidate, exceptions: [{ ...exception, ...change }] }).reason).toBe('invalid-rollout-policy');
    }
    candidate.exceptions = [{ ...exception, startsAt: '2026-09-07T00:00:00Z', expiresAt: '2026-09-08T00:00:00Z' }];
    expect(evaluate(candidate).reason).toBe('expired-rollout-exception');
  });
  it('[desktop.rollout.no-keyword-scope] only the reviewed exact cohort can expand', () => {
    const candidate = policy(); expect(evaluate(candidate).satisfied).toBe(true);
    expect(evaluate(candidate, undefined, { ...scope, featureId: 'ui-desktop-screen-design' }).reason).toBe('outside-reviewed-cohort');
    expect(evaluate({ ...candidate, scopeMode: 'title-keywords' }).reason).toBe('invalid-rollout-policy');
    for (const change of [{ harnessSlug: 'another' }, { approval: { ...scope.approval, targetRoute: '/elsewhere' } }, { approval: { ...scope.approval, planItemIds: ['P-002'] } }]) {
      expect(evaluate(candidate, undefined, { ...scope, ...change }).reason).toBe('outside-reviewed-cohort');
    }
  });
  it('requires an independent accepted review bound to these policy bytes', () => {
    const candidate = policy(); const card = review(sha(JSON.stringify(candidate)));
    expect(evaluate(candidate, card).satisfied).toBe(true);
    expect(evaluate(candidate, { kind: 'not_found' }).reason).toBe('independent-review-missing');
    if (card.kind !== 'found') throw new Error('fixture');
    for (const change of [{ createdBy: 'implementer' }, { provisional: { reason: 'working' } }, { missingKeys: ['R-5'] }, { rubricRef: 'unrelated' }]) {
      expect(evaluate(candidate, { ...card, scorecard: { ...card.scorecard, ...change } } as ScorecardEvidenceReadResult).satisfied).toBe(false);
    }
    candidate.version = 'unreviewed-revision'; expect(evaluate(candidate, card).reason).toBe('policy-review-mismatch');
  });
});

const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
function diskFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'design-rollout-')); cleanup.push(dir);
  const candidate = policy(); const bytes = JSON.stringify(candidate); const digest = sha(bytes);
  writeFileSync(join(dir, 'policy.json'), bytes); writeFileSync(join(dir, 'evidence.txt'), 'saved evidence');
  writeFileSync(join(dir, 'journey.json'), JSON.stringify(journey));
  const target = { ...scope, approval: { ...scope.approval, rollout: {
    schemaVersion: 1 as const, policyPath: 'policy.json', policySha256: digest, reviewCardRef: 'EI-123',
  } } };
  const readReview = vi.fn(async () => review(digest));
  const readRun = vi.fn(async (id: number) => ({ status: id === journey.original.testRunId ? 'fail' : 'pass', framework: 'playwright', filePath: journey.sourceTest }));
  return { dir, candidate, target, readReview, readRun, read: () => readDesignRolloutAdmission(target, { root: dir, now, readReview, readRun }) };
}
describe('ratification integration with confined artifacts and independent review ledger', () => {
  it('re-hashes policy and every census/guidance artifact before admitting a wider obligation', async () => {
    const fixture = diskFixture(); expect((await fixture.read()).satisfied).toBe(true);
    expect(fixture.readReview).toHaveBeenCalledWith('EI-123');
    writeFileSync(join(fixture.dir, 'evidence.txt'), 'changed after review');
    expect((await fixture.read()).reason).toBe('stale-rollout-evidence');
    writeFileSync(join(fixture.dir, 'policy.json'), '{}');
    expect((await fixture.read()).reason).toBe('stale-rollout-policy');
  });
  it('the exact canary is admitted; a changed image, route or harness is a new rollout', async () => {
    const canary = { ...scope, ...DESKTOP_CANARY, approval: { ...scope.approval, planSlug: DESKTOP_CANARY.featureId, targetRoute: DESKTOP_CANARY.targetRoute } };
    expect((await readDesignRolloutAdmission(canary, { now })).reason).toBe('desktop-canary');
    for (const change of [{ harnessSlug: 'other' }, { contentSha256: sha('changed') }, { approval: { ...canary.approval, targetRoute: '/other' } }]) {
      expect((await readDesignRolloutAdmission({ ...canary, ...change }, { now })).reason).toBe('rollout-registration-required');
    }
  });
  it('checks the saved shell/destination pair and corroborates both browser FILE verdicts', async () => {
    const fixture = diskFixture(); expect((await fixture.read()).satisfied).toBe(true);
    expect(fixture.readRun).toHaveBeenCalledWith(journey.original.testRunId);
    expect(fixture.readRun).toHaveBeenCalledWith(journey.positive.testRunId);
    fixture.readRun.mockResolvedValueOnce({ status: 'pass', framework: 'vitest', filePath: journey.sourceTest });
    expect((await fixture.read()).reason).toBe('canary-browser-run-unproven');
    const changed = structuredClone(journey); changed.original.cases[0].desktopWorkspacePresent = true;
    writeFileSync(join(fixture.dir, 'journey.json'), JSON.stringify(changed));
    fixture.candidate.canary.evidence.sha256 = sha(JSON.stringify(changed));
    const bytes = JSON.stringify(fixture.candidate); writeFileSync(join(fixture.dir, 'policy.json'), bytes);
    fixture.target.approval.rollout.policySha256 = sha(bytes);
    expect((await fixture.read()).reason).toBe('canary-pair-unproven');
  });
  it('the actual ratification verb refuses absent rollout, accepts reviewed policy, and keeps historical scope unconstrained', async () => {
    const fixture = diskFixture(); const store = createInMemoryReferenceStore();
    const env = { viewport: { width: 1, height: 1 }, deviceScaleFactor: 1, browser: 'chromium', theme: 'light', fontSet: 'test', state: 'empty' };
    const input: RatifyReferenceInput = { featureId: scope.featureId, referenceId: scope.referenceId, revision: 1,
      contentSha256: scope.contentSha256, referenceClass: 'raster-mockup',
      image: { locator: 'test:image', mediaType: 'image/png', byteLength: 5, width: 1, height: 1 }, referenceEnvironment: env,
      requiredCases: [{ caseId: 'empty', environment: env, target: { targetKind: 'page-route', targetId: '/settings' }, rationale: 'empty' }],
      provenance: { source: 'upload', sourceRef: 'test:image' }, approval: scope.approval };
    const deps: VerbDeps = { harnessSlug: scope.harnessSlug, store, now: () => now, clock: () => new Date(now).toISOString(),
      materializeReferenceImage: async () => ({ path: 'test:image', contentSha256: scope.contentSha256 }), comparison: {} as VerbDeps['comparison'],
      rolloutAdmission: candidate => readDesignRolloutAdmission(candidate, { now, root: fixture.dir, readReview: fixture.readReview, readRun: fixture.readRun }) };
    const caller = { actorId: scope.actorId, role: 'reviewer' };
    expect(await ratifyReferenceVerb(input, caller, deps)).toMatchObject({ ok: false, detail: 'rollout-registration-required' });
    expect(await store.listFeatureReferenceIds({ harnessSlug: scope.harnessSlug, featureId: scope.featureId })).toEqual([]);
    expect(await ratifyReferenceVerb({ ...input, approval: fixture.target.approval }, caller, deps)).toMatchObject({ ok: true });
    expect(await ratifyReferenceVerb({ ...input, featureId: 'historical-ui-desktop-screen', referenceId: 'historical-screen', approval: undefined }, caller, deps)).toMatchObject({ ok: true });
    expect(designRolloutPolicySchema.safeParse(fixture.candidate).success).toBe(true);
  });
});
