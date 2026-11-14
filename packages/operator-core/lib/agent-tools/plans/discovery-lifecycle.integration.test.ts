/** The motivating draft stays untouched; these are private, versioned copies. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveIndexFromContent } from './derive-index';
import { writePlanIndexRows } from './plan-index-rows';
import { readPlanLineNodes, writePlanLineNodes } from './plan-line-graph';
import { seedPlan, setupPlanPgFixture, type PlanPgFixture } from './__tests__/_pg-tool-fixture';
import { checkDraftItemStartGate } from './draft-item-start-gate';
import getInputSchemaTool from './get-input-schema';
import { discoveryDeclarationSchema, type DiscoveryDeclaration } from './plan-declarations';
import { resolveDiscoveryAuditContext } from './plan-declaration-resolvers';
import { recordCurrentDiscoveryAudit, withCurrentDiscovery } from '../../plan-audits';
import * as discoveryAudits from '../../plan-audits';
import * as activationGate from './plan-activation-gate';
import { withPlanLock } from './with-plan-lock';
import { persistResearchBatch, researchSubjects, suggestResearchAnchors } from '../../code-intelligence/research-trail';
import { acceptFeedbackRequestCore, getFeedbackCore, type GetFeedbackDeps, type GetFeedbackRequest } from '../../consult/get-feedback-core';
import { BAR_CRITIQUE_POLICY } from '../../consult/selection-policies';
import { evaluateBarCritiqueGate, type BarCritiqueClause } from './plan-start-critique-gate';
import { bindSpecEvidence, listSpecEvidence, measureWorkItemsEvidenceForScope, measureRepoFilesEvidenceAtRoot } from './spec-evidence-store';
import { listSpecClauses, setSpecClause, type SpecClauseSql } from './spec-clauses-store';
import { getWorkItem, setWorkItemState } from '../../work-items';
import { runWithWorkspace } from '../../workspace-als';
import { seedAcceptanceBarsInTransaction } from '../../acceptance-bar-seed';
import { getRubric } from '../../rubrics';
import { readAcceptanceBarContractSnapshot } from '../../acceptance-bar-contract-snapshot';
import { evaluateAcceptanceBarLifecycle } from '../../acceptance-bar-lifecycle-evaluator';
import { specTestAdequacyCompletionGate } from '../work_items/spec-test-adequacy-gate';
import complete from '../work_items/complete';
import { evaluateSpecTestAdequacy } from './spec-test-adequacy';
import { resolveSourceBarTestRequirements } from './source-bar-test-requirements';
import type { ScorecardRow } from '../../scorecards';
import { reconcilePlanAuthoredDependenciesNow } from '../../plan-items/reconcile-linked-work-items';
import { deployTriggerRefusalReason } from '../../release/deploy-trigger-refusal';
import { computeDeployStatus } from '../../release-deploy-launch';
import type { GitPipelineSnapshot } from '../../git-pipeline-stats';
import { assertDiscoveryShippedIdentity, type DiscoveryShippedTarget } from '../../../test/discovery-guidance-http-scenario';
import { listRuntimeVintage, reportRuntimeVintage } from '../../runtime-vintage';
import { measureRuntimeEnvironment } from '../../remote-runtime-identity';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { getBuildInfo } from '../../build-info';
import { mutateWorkItemDependenciesInTransaction, withWorkItemDependencyAdmissionTransaction } from '../../dbos/work-item-deps-store';

// Select the private repository, as the production registry selects a checkout.
// The completion, evidence, dependency and acceptance gates remain unmocked.
const deliveryRoot = vi.hoisted(() => ({ path: '' }));
vi.mock('../../harness-registry', async original => ({
  ...await original<typeof import('../../harness-registry')>(),
  loadHarnessRegistry: async () => ({ projects: [] }),
  resolveHarnessContentPath: () => deliveryRoot.path,
}));
vi.mock('../coordination/identity', async original => ({
  ...await original<typeof import('../coordination/identity')>(),
  resolveAgentIdentity: () => ({ ownerId: 'su-discovery-lifecycle-fixture', ownerLabel: 'private discovery fixture', source: 'test' }),
  deriveFleetMembership: () => ({ fleetSlug: null, fleetRole: null }),
}));
// Keep external dispatch outside this private database; the complete handler,
// its contract gates and the terminal/plan reflection writers remain real.
vi.mock('../../events', async original => ({
  ...await original<typeof import('../../events')>(), fireReactionInProcess: async () => ({ ok: true }),
}));
vi.mock('../../grading-integrity', async original => ({
  ...await original<typeof import('../../grading-integrity')>(),
  dispatchPendingGradingAudits: async () => ({ requestedTargetIds: [], receipts: [] }),
}));
vi.mock('../../harness/improvements/completion-verification-store', async original => ({
  ...await original<typeof import('../../harness/improvements/completion-verification-store')>(),
  spawnCompletionVerificationForClose: async () => ({ outcome: 'no-dependents' }),
  applyCompletionVerdictForClose: async () => null, acceptCompletionOnSettlementForSubject: async () => null,
}));
vi.mock('../../scorecards', async original => {
  const actual = await original<typeof import('../../scorecards')>();
  return { ...actual, listScorecards: async (filter: Parameters<typeof actual.listScorecards>[0]) => {
    const rows = await fx.admin`SELECT payload->'fixtureCard' AS card FROM harness_shared.work_items
      WHERE workspace_id=${fx.workspaceId} AND harness_slug=${harness} AND payload ? 'fixtureCard'`;
    return rows.map(row => row.card as ScorecardRow).filter(card =>
      (!filter?.subjectRef || card.subject?.ref === filter.subjectRef) &&
      (!filter?.rubricRef || card.rubricRef === filter.rubricRef));
  } };
});

// Exact quoted owner text, including indentation and line breaks. The later
// plan revision is a different fixture and cannot stand in for this source.
const ORIGINAL_CENSUS_SOURCE_REF = 'session_turn:codex:01a1ad43-3ec6-7ce2-aa28-c27483998798:15';
const ORIGINAL_CENSUS_QUOTE = `  1. P-001 — Establish the baseline and identify actual gaps.
     Inventory existing implementations and related work before changing them. Measure
     whether proofs are actually consumed, how much valid work survives interruption, how
     long optional warming holds the qualification resource, and where candidate completion
     time goes. A property already implemented and proven gets adopted rather than rebuilt.`;
const ORIGINAL_CENSUS = ORIGINAL_CENSUS_QUOTE.slice('  1. P-001 — '.length);
const OWNER = 'su-discovery-lifecycle-fixture';
let fx: PlanPgFixture;
let root: string;
let sequence = 0;
let harness: string;
let slug: string;
let content: string;
const input = () => ({ workspaceId: fx.workspaceId, harnessSlug: harness, planSlug: slug, createdBy: OWNER });
const resolver: NonNullable<Parameters<typeof recordCurrentDiscoveryAudit>[1]>['context'] =
  (draft, previous, prior, historicalTargets) => resolveDiscoveryAuditContext(draft, previous, {
    repoRoot: root, workspaceId: fx.workspaceId, sql: fx.admin, harnessSlug: harness,
    ownerId: OWNER, planSlug: slug, prior, historicalTargets,
  });
const questions: DiscoveryDeclaration['questions'] = [
  { id: 'Q-1', kind: 'current-behavior', question: 'What proof warming already exists?',
    stopCondition: 'Read the current cache and its consumer.', outcome: 'unresolved' },
  { id: 'Q-2', kind: 'gap', question: 'What required behavior is still missing?',
    stopCondition: 'Compare the existing consumer with the requested retained proof.', outcome: 'unresolved' },
  { id: 'Q-3', kind: 'feasibility', question: 'Can the existing cache serve the missing caller?',
    stopCondition: 'Trace its key and lifetime contract at the caller.', outcome: 'unresolved' },
];
const pending: DiscoveryDeclaration = { questions, findings: [], notApplicable: null };
function plan(declaration: DiscoveryDeclaration, reconciled = false) {
  return `---\nslug: ${slug}\nstatus: draft\n---\n# Proof warming fixture\n\n## Phase 1\n\n` +
    (reconciled
      ? '- **P-002** `todo` Reuse the existing keyed cache at the missing child-consumption caller\n'
      : `- **P-001** \`todo\` ${ORIGINAL_CENSUS}\n`) +
    `\n## Discovery\n\n\`\`\`discovery\n${JSON.stringify(declaration)}\n\`\`\`\n`;
}
async function revision(next: string) {
  content = next;
  await seedPlan(fx.admin, fx.workspaceId, harness, slug, next);
  const hash = createHash('sha256').update(next).digest('hex');
  await withWorkItemDependencyAdmissionTransaction(fx.admin, async tx => {
    const scope = { workspaceId: fx.workspaceId, harnessSlug: harness, planSlug: slug };
    const index = deriveIndexFromContent(next);
    const previous = await readPlanLineNodes(tx as never, { ...scope, slug });
    await writePlanIndexRows(tx as never, scope, index);
    const mutations = await writePlanLineNodes(tx as never, { ...scope, slug }, previous, index.items);
    if (mutations.length) await mutateWorkItemDependenciesInTransaction(tx, {
      workspaceId: DEFAULT_COORD_WORKSPACE, itemWorkspaceId: fx.workspaceId, mutations,
    });
    await tx`UPDATE harness_shared.harness_plans SET content_hash=${hash},version=version+1
      WHERE workspace_id=${fx.workspaceId} AND harness_slug=${harness} AND plan_slug=${slug}`;
    await tx`INSERT INTO harness_shared.plan_revisions
      (workspace_id,harness_slug,plan_slug,seq,content_hash,content_snapshot,rationale,author_kind,author_id,session_id,session_kind,created_at)
      SELECT ${fx.workspaceId},${harness},${slug},COALESCE(MAX(seq),0)+1,${hash},${next},
        'isolated original-failure fixture','agent',${OWNER},'fixture','codex',${Date.now()}
      FROM harness_shared.plan_revisions WHERE workspace_id=${fx.workspaceId} AND harness_slug=${harness} AND plan_slug=${slug}`;
  });
}
const finalized = () => recordCurrentDiscoveryAudit(input(), { context: resolver });
const current = () => withCurrentDiscovery(input(), async () => undefined, { context: resolver });
function revisedFindings(): DiscoveryDeclaration {
  return { questions: questions.map(question => ({ ...question, outcome: 'answered' })), notApplicable: null,
    findings: [{ id: 'F-1', questions: questions.map(question => question.id),
      conclusion: 'The keyed cache already warms and retains proof; only the child-consumption caller is missing.',
      evidenceRefs: ['source:proof-cache.ts'], dispositions: [
        { target: 'P-001', decision: 'remove', reason: 'The census is performed; remove duplicate implementation discovery.' },
        { target: 'P-002', decision: 'reuse', reason: 'Reuse the existing key/lifetime contract at the missing caller.' },
      ] }],
  };
}
function reviewDeps(context = resolver) {
  const route = vi.fn(async () => { throw new Error('REVIEW_ROUTING_ADMITTED'); });
  const open = vi.fn(async () => { throw new Error('UNEXPECTED_CONVERSATION'); });
  const deps = { getSql: () => fx.admin, route, open,
    withCurrentDiscovery: ((request, accept) => withCurrentDiscovery(request, accept, { context })) as NonNullable<GetFeedbackDeps['withCurrentDiscovery']>,
  } as unknown as GetFeedbackDeps;
  const request: GetFeedbackRequest = { workspaceId: fx.workspaceId, requesterId: OWNER,
    policy: BAR_CRITIQUE_POLICY, originTaskRef: slug, harnessSlug: harness, allowDispatch: true,
    question: 'Review the full BARs and reconciled current draft against original owner intent; do not defer the census into implementation.' };
  return { route, open, attempt: () => getFeedbackCore(request, deps) };
}
async function startAttempt(itemId = 'P-001') {
  return checkDraftItemStartGate({ slug, itemId, toStatus: 'wip', readPlanContent: async () => content,
    evaluateDiscovery: async () => { const result = await current(); return result.ok ? { ok: true as const }
      : { ok: false as const, error: result.error, nextAction: 'nextAction' in result ? result.nextAction : undefined }; },
    // Existing activation/authority checks are separately covered; this isolates discovery.
    evaluateGate: async () => ({ satisfied: true }), hasCoveringWorkItem: async () => false });
}
beforeAll(async () => {
  fx = await setupPlanPgFixture({ isolated: true });
  await fx.admin.unsafe(await readFile(fileURLToPath(new URL(
    '../../../../../libs/papercusp/libs/db/sql/1619-plan-discovery-audits.sql', import.meta.url)), 'utf8'));
  root = await mkdtemp(join(tmpdir(), 'discovery-lifecycle-'));
  deliveryRoot.path = root;
}, 120_000);
afterAll(async () => { await fx?.dispose(); if (root) await rm(root, { recursive: true, force: true }); });
beforeEach(async () => {
  harness = `zzz-discovery-lifecycle-${++sequence}`;
  slug = `proof-warming-discovery-${sequence}`;
  await writeFile(join(root, 'proof-cache.ts'), 'export const retainedProofCache = new Map();\n');
  await persistResearchBatch({ workspace: fx.workspaceId, owner: OWNER, harness, client: 'codex', calls: [] },
    [{ kind: 'path', requested: 'proof-cache.ts', path: 'proof-cache.ts', seenAt: Date.now() }]);
  await revision(plan(pending));
});

/** Synthetic receipts below are calibration inputs in a private database. They
 * never certify this plan's live R11 or stand in for the independent HTTP run. */
async function deliveryFixture() {
  const testPath = 'delivery.integration.test.ts';
  const title = 'same caller receives discovery guidance';
  const ordinary = 'DISCOVERY-CURRENT-BUILD';
  const finalSpec = 'AUTO-BAR-R-11-P-008';
  const requirement = {
    intent: { request: 'Retain current discovery proof before independent exact release acceptance.',
      sourceRefs: ['fixture:discovery-r11'] },
    acceptance: { condition: 'Both current-build and independently measured exact release receipts are required.',
      falsifier: 'An abandoned prerequisite or a different release is accepted.', requiredScope: ['same-session journey'],
      evidencePlane: 'live', evidenceRuntime: 'release-operator', requiredTestLayers: ['integration'] },
    verification: { method: 'Read canonical completion and exact artifact receipts.',
      check: { kind: 'tests', files: [testPath], cases: [{ file: testPath, testName: title }] } },
  };
  await revision(`---\nslug: ${slug}\nstatus: active\n---\n# Discovery delivery fixture\n\n` +
    `## Requirements\n\n**R-11 — Exact release delivery.**\n\`\`\`requirement\n${JSON.stringify(requirement)}\n\`\`\`\n\n` +
    '## Design\n\n### Bar-to-work map for this plan\n\n| bar | implementing plan items | evidence plane |\n' +
    '|---|---|---|\n| R-11 | P-008 | live |\n\n## Work\n\n' +
    '- **P-007** `todo` Current-build discovery contribution\n' +
    '- **P-008** `todo` Independent exact release acceptance (blocked-by: P-007)\n');
  await fx.admin`UPDATE harness_shared.harness_plans SET status='active'
    WHERE workspace_id=${fx.workspaceId} AND harness_slug=${harness} AND plan_slug=${slug}`;
  const nodes = await readPlanLineNodes(fx.admin, { workspaceId: fx.workspaceId, harnessSlug: harness, slug });
  const prerequisite = nodes.find(node => node.id === 'P-007')!.featureId;
  const finalItem = nodes.find(node => node.id === 'P-008')!.featureId;
  expect(nodes.find(node => node.id === 'P-008')?.blockedBy).toEqual(['P-007']);
  const [subject] = await fx.admin`SELECT version FROM harness_shared.harness_plans
    WHERE workspace_id=${fx.workspaceId} AND harness_slug=${harness} AND plan_slug=${slug}`;
  const subjectVersion = Number(subject?.version);
  expect(subjectVersion).toBeGreaterThan(0);
  const seeded = await fx.admin.begin(tx => seedAcceptanceBarsInTransaction({ executor: tx as unknown as SpecClauseSql,
    workspaceId: fx.workspaceId, harnessSlug: harness, planSlug: slug, planContent: content,
    planTitle: 'Discovery delivery fixture', planStatus: 'active', planVersion: subjectVersion,
    adoptionEpoch: 1, cohort: 'post-epoch', classRef: 'plan-class-feature-ship', actorId: OWNER, now: new Date() }));
  expect(seeded, JSON.stringify(seeded)).toMatchObject({ ok: true });
  const [draft] = await listSpecClauses({ harnessSlug: harness, planSlug: slug, specIds: [finalSpec] });
  if (!draft) throw new Error('final clause not seeded');
  await setSpecClause({ harnessSlug: harness, planSlug: slug, specId: finalSpec,
    expectedRevision: draft.revision, planItemId: 'P-008', behavior: draft.behavior,
    behaviorClass: draft.behaviorClass, requiredEvidence: draft.requiredEvidence,
    requiredTestLayers: draft.requiredTestLayers, mutationRequired: draft.mutationRequired,
    falsifier: { ...draft.falsifier!, requiredSuccessfulWorkItemIds: [prerequisite] },
    sourceBar: draft.sourceBar!, acceptanceRef: draft.acceptanceRef!,
    lifecycleStatus: 'active', actorId: 'su-independent-fixture-reviewer' });
  await setSpecClause({ harnessSlug: harness, planSlug: slug, specId: ordinary, expectedRevision: 0,
    planItemId: 'P-007', behavior: 'The same served caller receives current-build discovery guidance.',
    behaviorClass: 'happy-path', requiredEvidence: ['live'], requiredTestLayers: ['integration'],
    mutationRequired: false, lifecycleStatus: 'active', actorId: OWNER });
  await fx.admin`UPDATE harness_shared.work_items SET taken_by=${OWNER},taken_at=now(),admission='admitted',
      kind='feature',payload=payload-'_claimHold'-'claim_hold_by'-'claim_hold_at'-'claim_hold_reason'
    WHERE workspace_id=${fx.workspaceId} AND harness_slug=${harness} AND feature_id=ANY(${[prerequisite, finalItem]})`;
  await writeFile(join(root, testPath), 'expect(discoveryGuidance).toBe(true);\n');
  const runtimeUnits = [`discovery-private-fixture-${sequence}`];
  await reportRuntimeVintage({ workspaceId: fx.workspaceId, unit: runtimeUnits[0]!,
    treeSha: 'a'.repeat(40), pid: process.pid });
  const environmentFingerprint = await measureRuntimeEnvironment(await listRuntimeVintage(fx.workspaceId), runtimeUnits);
  expect(environmentFingerprint, 'Private live evidence needs a measured execution environment').toMatch(/^[a-f0-9]{64}$/);
  const runtimeWitness = { schemaVersion: 1, units: runtimeUnits,
    fingerprint: environmentFingerprint!, observedAt: new Date().toISOString() };
  const recipe = { schemaVersion: 1 as const, kind: 'repo-files' as const,
    sourcePaths: ['proof-cache.ts'], testPaths: [testPath], fixturePaths: [testPath], runtimeUnits };
  const pins = { ...await measureRepoFilesEvidenceAtRoot(root, recipe), environmentFingerprint };
  const mutation = { schemaVersion: 1, probeInvocationId: `discovery-delivery-${sequence}`, mode: 'copy-out',
    subjectPath: 'proof-cache.ts', mutateExpression: 's/Map/null/', againstCommit: null,
    subjectBeforeSha256: createHash('sha256').update(await readFile(join(root, 'proof-cache.ts'))).digest('hex'),
    subjectAfterSha256: 'f'.repeat(64), mutantDiff: '-Map\n+null\n', mutantDiffTruncated: false,
    testCommandSha256: 'a'.repeat(64),
    testFileSha256: createHash('sha256').update(await readFile(join(root, testPath))).digest('hex') };
  async function execution(status: 'pass' | 'fail', leg?: 'baseline' | 'mutant') {
    // The real closure gate also reads clean build and per-case identities.
    const commitSha = getBuildInfo().sha;
    expect(commitSha).toMatch(/^[a-f0-9]{7,64}$/);
    const details = { schemaVersion: 1, root, filePath: testPath, runGroupId: null,
      workspaceId: fx.workspaceId, harnessSlug: harness, testNamePattern: null, testLayer: 'integration',
      passed: status === 'pass' ? 1 : 0, failed: status === 'fail' ? 1 : 0, skipped: 0,
      collectionFailed: false, mutationPhase: leg ?? null, commitSha, worktreeDirty: false,
      runtimeEnvironmentBefore: runtimeWitness, runtimeEnvironmentAfter: runtimeWitness,
      passedCaseTitles: status === 'pass' ? [title] : [], failedCaseTitles: status === 'fail' ? [title] : [],
      ...(leg ? { mutation: { ...mutation, leg } } : {}) };
    const [run] = await fx.admin`INSERT INTO harness_shared.test_runs
      (workspace_id,harness_slug,file_path,framework,source,status,finished_at,worktree_dirty,commit_sha,execution_details)
      VALUES (${fx.workspaceId},${harness},${testPath},'vitest',${leg ? 'mutation-probe' : 'local'},${status},
        now(),false,${commitSha},${JSON.stringify(details)}::jsonb) RETURNING id`;
    await fx.admin`INSERT INTO harness_shared.test_case_runs
      (test_run_id,case_index,case_key,occurrence,status,duration_ms)
      VALUES (${Number(run!.id)},0,${title},1,${status},1)`;
    return Number(run!.id);
  }
  await execution('pass', 'baseline');
  const mutant = await execution('fail', 'mutant');
  const passed = await execution('pass');
  async function bind(item: string, specId: string, kind: 'test' | 'counterexample') {
    const result = await bindSpecEvidence({ workspaceId: fx.workspaceId, harnessSlug: harness,
      planSlug: slug, workItemId: item, specId, evidenceKind: kind, evidenceRef: `${kind}:${testPath}`,
      ...pins,
      testRunId: kind === 'test' ? passed : mutant, actorId: OWNER,
      details: { currentMeasurement: recipe, evidencePlane: 'live',
        evidenceRuntime: item === prerequisite ? 'staging-operator' : 'release-operator',
        adequacy: { targeted: specId, fixtureCalibrated: true, falsifiable: true, testLayer: 'integration',
          pathReachable: true, oracleIndependent: true, collected: true, skipped: false, executed: true,
          outcome: kind === 'test' ? 'passed' : 'caught', testCases: [title], coverageRungs: { l3: true } } } });
    expect(result, JSON.stringify(result)).toMatchObject({
      status: expect.stringMatching(/^(created|unchanged)$/), specId, workItemId: item,
    });
  }
  await bind(prerequisite, ordinary, 'test');
  await bind(prerequisite, ordinary, 'counterexample');
  const [ordinaryClause] = await listSpecClauses({ harnessSlug: harness, planSlug: slug, specIds: [ordinary] });
  const ordinaryEvidence = await listSpecEvidence({ workspaceId: fx.workspaceId, harnessSlug: harness,
    planSlugs: [slug], workItemIds: [prerequisite] });
  const evaluated = evaluateSpecTestAdequacy({ clause: ordinaryClause!, evidence: ordinaryEvidence,
    classRef: 'plan-class-feature-ship' });
  expect(evaluated.verdict, JSON.stringify(evaluated)).toBe('pass');
  // Isolated independent-card inputs, not a dispatched or live acceptance grade.
  const ordinaryCard = { issueId: `SC-${sequence}`, createdAt: new Date().toISOString(),
    createdBy: 'su-independent-fixture-grader', subject: evaluated.scorecardDraft.subject,
    rubricRef: 'spec-test-adequacy', ratings: evaluated.ratings, nKeys: Object.keys(evaluated.ratings).length,
    missingKeys: [], extraKeys: [], rubricResolved: true, synthesized: false, score10: 10, linkedItems: [],
    rerunRecipe: evaluated.scorecardDraft.rerunRecipe,
    gradingAudit: { state: 'passed', metaRubricRef: 'grading-integrity', stampedAt: new Date().toISOString() },
    gradingAuditCurrentness: { state: 'current' } } as unknown as ScorecardRow;
  await fx.admin`UPDATE harness_shared.work_items SET payload=${JSON.stringify({ fixtureCard: ordinaryCard })}::jsonb
    WHERE workspace_id=${fx.workspaceId} AND harness_slug=${harness} AND feature_id=${prerequisite}`;
  async function completionGate(id: string) {
    const workItem = await getWorkItem(id, harness);
    if (!workItem) throw new Error('missing fixture work item');
    return specTestAdequacyCompletionGate({ workItem, workspaceId: fx.workspaceId,
      attestation: { classRef: 'plan-class-feature-ship' } });
  }
  async function closeCurrent() {
    const gate = await completionGate(prerequisite);
    expect(gate, JSON.stringify(gate)).toMatchObject({ ok: true, applicable: true });
    const result = await close(prerequisite);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    const receipt = await getWorkItem(prerequisite, harness);
    if (!receipt) throw new Error('canonical close lost the prerequisite');
    expect(receipt).toMatchObject({ state: 'done' });
    // The canonical handler persists _completionEvidence without a free-text
    // terminalCompletionRef. Pin that measured evidence, owner and authority.
    const pin = await measureWorkItemsEvidenceForScope(fx.workspaceId, harness, receiptRecipe);
    expect(pin.sourceFingerprint).toMatch(/^sha256-work-item-receipts-v1:/);
    return pin;
  }
  async function close(id: string) {
    const result = await complete.handler(complete.args.parse({ id, harness, state: 'done', assumptions: 'none',
      changeKinds: ['no-code-change'], changeKindReason: 'Private database contract calibration without repository deliverables.',
      specAdequacy: { classRef: 'plan-class-feature-ship' },
      completion: { summary: 'Private discovery delivery contract calibration', testsRun: testPath,
        testResult: 'Recorded private fixture execution passed', verifiedHow: 'integration', filesChanged: [],
        verification: { workOutcome: 'verified-existing' },
        ...(id === finalItem ? { discharges: ['R-11'] } : {}) },
    }), { uiClientId: OWNER, isSuperuser: true, workspaceId: fx.workspaceId } as never);
    return (result as { data: { results: Array<Record<string, unknown>> } }).data.results[0]!;
  }
  async function expectFinalRefused() {
    const result = await close(finalItem);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: false, specAdequacy: { applicable: true } });
    const retained = await getWorkItem(finalItem, harness);
    expect(retained).toMatchObject({ state: 'open', terminalCompletionRef: null });
    expect((retained?.payload as Record<string, unknown> | undefined)?._completion).toBeUndefined();
    expect((await acceptance(true)).verdict.satisfied).toBe(false);
  }
  const receiptRecipe = { schemaVersion: 1 as const, kind: 'work-items' as const,
    workItemIds: [prerequisite], successfulCompletionReceipts: true as const, runtimeUnits };
  const target = { runtime: 'release-operator', processStartedAtMs: Date.now(),
    source: { entry: '/release/hono-host.mjs', sha256: 'a'.repeat(64) },
    artifact: { status: 'measured', sourceSha: 'b'.repeat(40), bundleSha256: 'a'.repeat(64) },
    health: { sha: 'b'.repeat(10), service: 'papercusp-operator' } } as DiscoveryShippedTarget;
  async function bindFinal(selected = target, includeReceipt = true) {
    // The existing runner's identity predicate runs before a successful exact
    // release execution can be bound. Wrong/private candidates create no proof.
    assertDiscoveryShippedIdentity(selected);
    const pin = await measureWorkItemsEvidenceForScope(fx.workspaceId, harness, receiptRecipe);
    // Keep executable test/fixture identity and the successful prerequisite
    // receipt as separate measured bindings; neither substitutes for the other.
    const retained = includeReceipt ? await bindSpecEvidence({ workspaceId: fx.workspaceId, harnessSlug: harness,
      planSlug: slug, workItemId: finalItem, specId: finalSpec, evidenceKind: 'manual',
      evidenceRef: `work-item:${prerequisite}`, ...pin, actorId: OWNER,
      // This row measures a stored record; executable live proof is separate.
      details: { currentMeasurement: receiptRecipe } }) : null;
    if (includeReceipt) expect(retained, JSON.stringify(retained)).toMatchObject({ status: 'created' });
    await bind(finalItem, finalSpec, 'test');
    await bind(finalItem, finalSpec, 'counterexample');
    const [clause] = await listSpecClauses({ harnessSlug: harness, planSlug: slug, specIds: [finalSpec] });
    const evidence = await listSpecEvidence({ workspaceId: fx.workspaceId, harnessSlug: harness,
      planSlugs: [slug], workItemIds: [finalItem] });
    const sourceBarTestRequirements = await resolveSourceBarTestRequirements(clause!.sourceBar);
    expect(sourceBarTestRequirements).toMatchObject({ status: 'required', files: [testPath] });
    const evaluation = evaluateSpecTestAdequacy({ clause: clause!, evidence, classRef: 'plan-class-feature-ship',
      sourceBarTestRequirements });
    expect(evaluation.verdict, JSON.stringify({ verdict: evaluation.verdict,
      blocked: Object.fromEntries(Object.entries(evaluation.ratings)
        .filter(([, rating]) => !['pass', 'not-applicable'].includes(rating.rating))
        .map(([key, rating]) => [key, { rating: rating.rating, evidence: rating.evidence.slice(0, 1200) }])) }))
      .toBe(includeReceipt ? 'pass' : 'fail');
    const card = { ...ordinaryCard, issueId: `SC-FINAL-${sequence}`, subject: evaluation.scorecardDraft.subject,
      ratings: evaluation.ratings, rerunRecipe: evaluation.scorecardDraft.rerunRecipe };
    await fx.admin`UPDATE harness_shared.work_items SET payload=payload||${JSON.stringify({ fixtureCard: card })}::jsonb
      WHERE workspace_id=${fx.workspaceId} AND harness_slug=${harness} AND feature_id=${finalItem}`;
  }
  async function acceptance(healthy: boolean) {
    const rubric = await getRubric(`acceptance-${slug}`);
    if (!rubric) throw new Error('missing fixture acceptance rubric');
    const ratings = { 'r-11': { rating: healthy ? 'healthy' : 'unknown',
      evidence: 'Synthetic independent exact artifact calibration; never live delivery evidence.' } };
    const base = { createdAt: new Date(Date.now() + 1000).toISOString(), rubricRef: rubric.rubricId,
      rubricRevision: rubric.revision, criteriaHash: rubric.criteriaHash, ratings,
      nKeys: 1, missingKeys: [], extraKeys: [], rubricResolved: true, synthesized: false,
      score10: healthy ? 10 : null, linkedItems: [] };
    const independent = { ...base, issueId: 'SC-INDEPENDENT', createdBy: 'su-independent-fixture-grader',
      supersededBy: 'SC-AUTHOR' } as ScorecardRow;
    const author = { ...base, issueId: 'SC-AUTHOR', createdBy: OWNER,
      createdAt: new Date(Date.now() + 2000).toISOString(), supersedes: independent.issueId,
      acceptance: { verdict: 'accept', reasoning: 'The independent fixture proof matches.' } } as ScorecardRow;
    const snapshot = await readAcceptanceBarContractSnapshot(slug, {
      readScorecards: async () => ({ rows: [author, independent], limit: 100, truncated: false }),
      readVettingScorecards: async () => ({ rows: [], limit: 100, truncated: false }),
      readCurrentCritique: async () => ({ consultId: 'fixture-full-critique', workItemId: null,
        rubricRevision: rubric.revision!, criteriaHash: rubric.criteriaHash!,
        createdAt: new Date().toISOString(), critics: ['su-independent-fixture-critic'] }),
      readParties: async identities => new Map(identities.map(identity => [identity, identity])),
      readGraderSelectionVia: async () => new Map([['su-independent-fixture-grader', 'floor' as const]]),
    }, { harnessSlug: harness });
    return { snapshot, verdict: evaluateAcceptanceBarLifecycle(snapshot, 'ship') };
  }
  return { prerequisite, finalItem, finalSpec, closeCurrent, close, expectFinalRefused, completionGate, bindFinal, receiptRecipe,
    acceptance, target };
}

/** P-008's authored blockers as withPlanLock persisted them (read back from work_item_deps). */
async function finalBlockedBy() {
  const nodes = await readPlanLineNodes(fx.admin, { workspaceId: fx.workspaceId, harnessSlug: harness, slug });
  return nodes.find(node => node.id === 'P-008')?.blockedBy;
}

describe('original proof-warming discovery before review and implementation', () => {
  it('completes current-build discovery before exact-shipped acceptance without certifying final delivery', async () => {
    await runWithWorkspace(fx.workspaceId, async () => {
      const delivery = await deliveryFixture();
      // P-008 is a unified plan-line node: withPlanLock owns its authored dependency
      // graph, including settled prerequisites. The legacy D-050 reconcile is a no-op
      // for it and must never subtract the P-007 edge once that row becomes terminal.
      expect(await reconcilePlanAuthoredDependenciesNow(slug, 'P-008', harness, OWNER)).toBeNull();
      const receipt = await delivery.closeCurrent();
      expect(await reconcilePlanAuthoredDependenciesNow(slug, 'P-008', harness, OWNER)).toBeNull();
      expect(await finalBlockedBy()).toEqual(['P-007']);
      expect((await getWorkItem(delivery.finalItem, harness))?.state).toBe('open');
      expect((await delivery.acceptance(false)).verdict.satisfied).toBe(false);
      expect(await delivery.completionGate(delivery.finalItem)).toMatchObject({ ok: false });
      await delivery.expectFinalRefused();
      // The production green-deploy predicate consumes pipeline state, not a
      // plan's final acceptance. No live gate is read or changed by this fixture.
      const deploy = computeDeployStatus({ gate: { consecutiveReds: 0, stalled: false, fireStale: false,
        lastGreenAtMs: Date.now(), verdictStale: false, flakyWorkspaces: [], failingTests: [] },
        deploy: { ready: { sha: 'b'.repeat(40) }, deployed: { sha: 'c'.repeat(40) },
          deployedBehindGreenPin: 1, greenPinBehindStaging: 0, deployedBehindStaging: 1,
          greenPinAtStagingHead: true, errors: [] },
        routines: { releaseTrigger: { name: 'release-trigger', active: true, cron: '0 */15 * * * *',
          lastFiredAtMs: Date.now(), nextFireAtMs: Date.now() + 900_000, pause: null } },
        recent: [], activeRun: null,
      } as unknown as GitPipelineSnapshot);
      expect(deploy.canTriggerGreen, JSON.stringify(deploy)).toBe(true);
      expect(deployTriggerRefusalReason(deploy)).toBeNull();
      for (const wrong of [
        { ...delivery.target, runtime: 'staging-operator' },
        { ...delivery.target, runtime: 'private-source-fixture' },
        { ...delivery.target, health: { ...delivery.target.health, sha: 'd'.repeat(10) } },
        // A verification rebuild differs from the bundle already loaded at
        // deployment, even when it claims the same source commit.
        { ...delivery.target, source: { ...delivery.target.source, sha256: 'e'.repeat(64) } },
      ]) {
        await expect(delivery.bindFinal(wrong as DiscoveryShippedTarget)).rejects.toThrow();
        expect(await delivery.completionGate(delivery.finalItem)).toMatchObject({ ok: false });
        await delivery.expectFinalRefused();
      }
      await delivery.bindFinal();
      expect(await delivery.completionGate(delivery.finalItem)).toMatchObject({ ok: true, applicable: true });
      const final = await delivery.acceptance(true);
      expect(final.verdict, JSON.stringify(final.snapshot)).toMatchObject({ satisfied: true });
      const closed = await delivery.close(delivery.finalItem);
      expect(closed, JSON.stringify(closed)).toMatchObject({ ok: true });
      expect(await getWorkItem(delivery.finalItem, harness)).toMatchObject({ state: 'done' });
      expect((await measureWorkItemsEvidenceForScope(fx.workspaceId, harness, delivery.receiptRecipe)).sourceFingerprint)
        .toBe(receipt.sourceFingerprint);
    });
  }, 120_000);

  it('refuses final discovery delivery for abandoned missing wrong or stale current-build receipts', async () => {
    await runWithWorkspace(fx.workspaceId, async () => {
      const delivery = await deliveryFixture();
      // A missing successful receipt cannot be measured or admitted.
      await expect(delivery.bindFinal()).rejects.toThrow('successful_completion_receipt_unavailable');
      expect(await delivery.completionGate(delivery.finalItem)).toMatchObject({ ok: false });
      await delivery.expectFinalRefused();
      await delivery.closeCurrent();
      // Passing exact-artifact tests without the declared receipt must still fail.
      await delivery.bindFinal(delivery.target, false);
      expect(await delivery.completionGate(delivery.finalItem)).toMatchObject({ ok: false });
      await delivery.expectFinalRefused();
      await delivery.bindFinal();
      expect(await delivery.completionGate(delivery.finalItem)).toMatchObject({ ok: true });
      const [pin] = await listSpecEvidence({ workspaceId: fx.workspaceId, harnessSlug: harness,
        planSlugs: [slug], workItemIds: [delivery.finalItem], evidenceKinds: ['test'] });
      expect(pin?.currentness.overall).toBe('current');
      // Wrong or replaced immutable refs invalidate the SAME retained binding.
      await fx.admin`UPDATE harness_shared.work_items SET terminal_completion_ref='test-run:wrong-current-build'
        WHERE workspace_id=${fx.workspaceId} AND harness_slug=${harness} AND feature_id=${delivery.prerequisite}`;
      expect(await delivery.completionGate(delivery.finalItem)).toMatchObject({ ok: false });
      await delivery.expectFinalRefused();
      // Ordinary terminal scheduling is preserved, without buying final proof.
      await setWorkItemState(delivery.prerequisite, 'dropped', { harness, by: OWNER, family: 'feature',
        completionRef: 'private-fixture:abandoned-prerequisite', completionAuthority: 'committed',
        completionEvidence: { summary: 'Abandoned contribution calibration; never successful delivery proof.' } });
      expect(await reconcilePlanAuthoredDependenciesNow(slug, 'P-008', harness, OWNER)).toBeNull();
      expect(await finalBlockedBy()).toEqual(['P-007']);
      await expect(measureWorkItemsEvidenceForScope(fx.workspaceId, harness, delivery.receiptRecipe))
        .rejects.toThrow('successful_completion_receipt_unavailable');
      expect(await delivery.completionGate(delivery.finalItem)).toMatchObject({ ok: false });
      await delivery.expectFinalRefused();
    });
  }, 120_000);

  it('retains and remeasures successful prerequisite receipts through the canonical evidence store', async () => {
    await runWithWorkspace(fx.workspaceId, async () => {
    await revision(plan(revisedFindings(), true));
    const prerequisite = `WI-700${sequence}7`;
    const finalItem = `WI-700${sequence}8`;
    await fx.admin`INSERT INTO harness_shared.work_items
      (workspace_id,harness_slug,feature_id,kind,title,status,taken_by,source_plan_slug,source_plan_item_ids)
      VALUES (${fx.workspaceId},${harness},${prerequisite},'feature','current-build contribution','open',${OWNER},${slug},ARRAY['P-002']::text[]),
             (${fx.workspaceId},${harness},${finalItem},'feature','final delivery','open',${OWNER},${slug},ARRAY['P-002']::text[])`;
    // Real terminal writer; the receipt is synthetic, confined to this private DB.
    // It verifies receipt composition only and cannot serve as live delivery evidence.
    const closed = await setWorkItemState(prerequisite, 'done', { harness, by: OWNER, family: 'feature',
      completionRef: 'test-run:immutable-current-build', completionAuthority: 'committed',
      completionEvidence: { summary: 'current-build fixture verified', testsRun: 'private fixture',
        testResult: 'passed', verifiedHow: 'isolated gate inputs', filesChanged: [] } });
    expect(closed).toMatchObject({ state: 'done', terminalCompletionRef: 'test-run:immutable-current-build' });
    const measurement = { schemaVersion: 1 as const, kind: 'work-items' as const,
      workItemIds: [prerequisite], successfulCompletionReceipts: true as const };
    const pin = await measureWorkItemsEvidenceForScope(fx.workspaceId, harness, measurement);
    await setSpecClause({ harnessSlug: harness, planSlug: slug,
      specId: 'DISCOVERY-PREREQUISITE-RECEIPT', expectedRevision: 0, planItemId: 'P-002',
      behavior: 'Final delivery consumes the same successful current-build receipt.',
      behaviorClass: 'non-automated', requiredTestLayers: [], mutationRequired: false,
      lifecycleStatus: 'active', actorId: OWNER });
    expect(await bindSpecEvidence({ workspaceId: fx.workspaceId, harnessSlug: harness, planSlug: slug,
      workItemId: finalItem, specId: 'DISCOVERY-PREREQUISITE-RECEIPT', evidenceKind: 'manual',
      evidenceRef: `work-item:${prerequisite}`, sourceFingerprint: pin.sourceFingerprint,
      actorId: OWNER, details: { currentMeasurement: measurement } })).toMatchObject({ status: 'created' });
    const read = async () => (await listSpecEvidence({ workspaceId: fx.workspaceId, harnessSlug: harness,
      planSlugs: [slug], workItemIds: [finalItem] }))[0]!;
    expect((await read()).currentness.overall).toBe('current');
    // Neither a checkpoint nor unrelated payload bookkeeping changes the receipt.
    await fx.admin`UPDATE harness_shared.work_items SET payload=COALESCE(payload,'{}'::jsonb)||'{"checkpoint":"new note"}'::jsonb
      WHERE workspace_id=${fx.workspaceId} AND harness_slug=${harness} AND feature_id=${prerequisite}`;
    expect((await read()).currentness.overall).toBe('current');
    await fx.admin`UPDATE harness_shared.work_items SET terminal_completion_ref='test-run:replacement'
      WHERE workspace_id=${fx.workspaceId} AND harness_slug=${harness} AND feature_id=${prerequisite}`;
    expect((await read()).currentness.overall).toBe('stale');
    await fx.admin`UPDATE harness_shared.work_items SET status='dropped'
      WHERE workspace_id=${fx.workspaceId} AND harness_slug=${harness} AND feature_id=${prerequisite}`;
    expect((await read()).currentness.overall).not.toBe('current');
    await expect(measureWorkItemsEvidenceForScope(fx.workspaceId, harness, measurement))
      .rejects.toThrow(`successful_completion_receipt_unavailable:${prerequisite}`);
    });
  });

  it('DISCOVERY-R4 current reconciled discovery permits amended full BAR review while a new start waits for current independent clearance', async () => {
    const review = reviewDeps();
    expect(await review.attempt()).toMatchObject({ error: 'discovery_not_ready' });
    await revision(plan(revisedFindings(), true));
    expect(await finalized()).toMatchObject({ ok: true, discovery: { readiness: { ready: true } } });
    await expect(review.attempt()).rejects.toThrow('REVIEW_ROUTING_ADMITTED');
    expect(review.route).toHaveBeenCalledOnce();
    // Reconciliation authorizes asking for review; it cannot stand in for an
    // independent answer about the amended contract at the production start gate.
    const clause: BarCritiqueClause = { specId: 'DISCOVERY-REVIEW', revision: 2,
      behavior: 'Reuse the existing cache at the reconciled caller.', behaviorClass: 'happy-path',
      requiredEvidence: ['tree'], requiredTestLayers: ['integration'], mutationRequired: false,
      exemption: null, falsifier: { observation: 'The caller starts against an unreviewed contract.' },
      lifecycleStatus: 'active', createdAt: new Date().toISOString(), sourceBar: null };
    expect(evaluateBarCritiqueGate({ planSlug: slug, currentClauses: [clause], critiques: [],
      authorPartyKeys: new Set([OWNER]), threshold: 1 }))
      .toMatchObject({ satisfied: false, code: 'critique_missing', critics: [] });
    expect(await current()).toMatchObject({ ok: true });
  });

  it('DISCOVERY-R8 persisted draft-to-review journey retains evidence', async () => {
    expect(await finalized()).toMatchObject({ ok: true, discovery: { readiness: { ready: false } } });
    const review = reviewDeps();
    expect(await review.attempt()).toMatchObject({ error: 'discovery_not_ready' });
    await revision(plan(revisedFindings(), true));
    const reconciled = await finalized();
    expect(reconciled).toMatchObject({ ok: true, discovery: { readiness: { ready: true } } });
    if (!reconciled.ok) throw new Error('reconciliation failed');
    const [stored] = await fx.admin`SELECT discovery, audited_plan_content_hash AS content_hash FROM harness_shared.plan_audits
      WHERE workspace_id=${fx.workspaceId} AND harness_slug=${harness} AND plan_slug=${slug}
        AND audit_kind='discovery' ORDER BY audit_seq DESC LIMIT 1`;
    expect(stored.discovery.evidence).toEqual(reconciled.discovery.evidence);
    expect(stored.content_hash).toBe(createHash('sha256').update(content).digest('hex'));
    // A restarted consumer reads the retained assessment, then a relevant source
    // delta must close admission without erasing that earlier observation.
    expect(await current()).toMatchObject({ ok: true });
    await expect(review.attempt()).rejects.toThrow('REVIEW_ROUTING_ADMITTED');
    await writeFile(join(root, 'proof-cache.ts'), 'export const retainedProofCache = null;\n');
    expect(await current()).toMatchObject({ ok: false, error: 'discovery_not_ready' });
    expect(await review.attempt()).toMatchObject({ error: 'discovery_not_ready' });
    expect(review.route).toHaveBeenCalledOnce();
    const [retained] = await fx.admin`SELECT discovery FROM harness_shared.plan_audits
      WHERE workspace_id=${fx.workspaceId} AND harness_slug=${harness} AND plan_slug=${slug}
        AND audit_kind='discovery' ORDER BY audit_seq DESC LIMIT 1`;
    expect(retained.discovery).toEqual(stored.discovery);
  });

  it('DISCOVERY-R9 proof warming is reconciled before review', async () => {
    expect(content).toContain(ORIGINAL_CENSUS);
    const review = reviewDeps();
    expect(await review.attempt()).toMatchObject({ error: 'discovery_not_ready' });
    expect(await startAttempt()).toMatchObject({ error: 'discovery_not_ready' });
    expect(review.route).not.toHaveBeenCalled();
    const declaration = revisedFindings();
    await revision(plan(declaration, true));
    expect(await review.attempt()).toMatchObject({ error: 'discovery_not_ready' });
    expect(await finalized()).toMatchObject({ ok: true, discovery: { readiness: { ready: true } } });
    const accepted = await withCurrentDiscovery(input(), async (_tx, subject) => subject.content, { context: resolver });
    expect(accepted).toMatchObject({ ok: true, result: content });
    expect(content).not.toContain(ORIGINAL_CENSUS);
    expect(content).toContain('Reuse the existing keyed cache at the missing child-consumption caller');
    await expect(review.attempt()).rejects.toThrow('REVIEW_ROUTING_ADMITTED');
    expect(review.route).toHaveBeenCalledOnce();
    expect(review.open).not.toHaveBeenCalled();
    expect(await startAttempt('P-002')).toBeNull();
  });

  it('EI-28751347466140676 a nested same-plan discovery admission reuses the held lock instead of refusing plan_busy', async () => {
    await revision(plan(revisedFindings(), true));
    expect(await finalized()).toMatchObject({ ok: true, discovery: { readiness: { ready: true } } });
    // scorecards:emit holds this admission while it replays plans:evaluate-spec-quality,
    // which re-enters withCurrentDiscovery for the same plan.
    const nested = await withCurrentDiscovery(input(), async () =>
      withCurrentDiscovery(input(), async (_tx, subject) => subject.version, { context: resolver }), { context: resolver });
    expect(nested).toMatchObject({ ok: true, result: { ok: true } });
    // The admission ends with its callback; a later fresh call takes its own lock.
    expect(await withCurrentDiscovery(input(), async () => 'after', { context: resolver }))
      .toMatchObject({ ok: true, result: 'after' });
  });

  it('plans:get-input-schema reports the Discovery refusal for a legacy ready plan', async () => {
    await revision(content.replace('status: draft', 'status: ready'));
    expect(await current()).toMatchObject({ ok: false, error: 'discovery_not_ready' });

    const args = getInputSchemaTool.args.parse({ slug, harness });
    const result = await getInputSchemaTool.handler(args, {
      workspaceId: fx.workspaceId,
      harnessSlug: harness,
    } as never) as { data: { results: Array<Record<string, unknown>> } };

    expect(result.data.results[0]).toMatchObject({
      slug,
      source: 'none',
      required: [],
      missing: [],
      ready: false,
      code: 'discovery_not_ready',
      issues: ['discovery_not_ready'],
      hint: expect.any(String),
    });
  });

  it('DISCOVERY-R10 derives discovery facts and finalizes first delta batch and retry paths without redundant authored confirmations', async () => {
    const declaration = revisedFindings();
    const finding = declaration.findings[0]!;
    declaration.findings = [{ ...finding, dispositions: [finding.dispositions[0]!] },
      { ...finding, id: 'F-2', dispositions: [finding.dispositions[1]!] }];
    await revision(plan(declaration, true));
    const first = await finalized();
    expect(first).toMatchObject({ ok: true, reused: false, discovery: { readiness: { ready: true } } });
    expect(await finalized()).toMatchObject({ ok: true, reused: true });
    await writeFile(join(root, 'proof-cache.ts'), 'export const retainedProofCache = new Map<string, unknown>();\n');
    expect(await current()).toMatchObject({ ok: false, error: 'discovery_not_ready' });
    // The agent supplies the changed judgment, not source hashes, revision ids,
    // readiness attestations or another account of facts the server can derive.
    declaration.findings = declaration.findings.map(row => ({ ...row,
      conclusion: row.conclusion + ' The changed cache now accepts string keys; keep the caller key as a string.' }));
    await revision(plan(declaration, true));
    const delta = await finalized();
    expect(delta).toMatchObject({ ok: true, reused: false, discovery: { readiness: { ready: true } } });
    if (!first.ok || !delta.ok) throw new Error('batch finalization failed');
    expect(delta.discovery.evidence).not.toEqual(first.discovery.evidence);
    expect(await finalized()).toMatchObject({ ok: true, reused: true });
    await revision(content + '\n## Now\nBookkeeping only.\n');
    expect(await finalized()).toMatchObject({ ok: true, reused: true });
    const [{ count }] = await fx.admin`SELECT count(*)::int AS count FROM harness_shared.plan_audits
      WHERE workspace_id=${fx.workspaceId} AND harness_slug=${harness} AND plan_slug=${slug} AND audit_kind='discovery'`;
    expect(count).toBe(2);
  });

  it('pins the exact motivating owner quote and source before exercising its correction', () => {
    expect(ORIGINAL_CENSUS_SOURCE_REF).toBe('session_turn:codex:01a1ad43-3ec6-7ce2-aa28-c27483998798:15');
    expect(createHash('sha256').update(ORIGINAL_CENSUS_QUOTE).digest('hex'))
      .toBe('b32d209c99a9c56e40843ef0cd422106ca474d572f3ddb0afbb8fc6d0b1f21ce');
    expect(content).toContain(ORIGINAL_CENSUS);
    expect(plan(revisedFindings(), true)).not.toContain(ORIGINAL_CENSUS);
    expect(plan(revisedFindings(), true)).toContain('Reuse the existing keyed cache at the missing child-consumption caller');
  });

  it('refuses a barrier-controlled source change before an actual review request can route, open or persist', async () => {
    await revision(plan(revisedFindings(), true));
    expect(await finalized()).toMatchObject({ ok: true, discovery: { readiness: { ready: true } } });
    let measured!: () => void;
    let release!: () => void;
    const measurement = new Promise<void>(resolve => { measured = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    let reads = 0;
    const review = reviewDeps(async (...args) => {
      const observed = await resolver(...args);
      if (++reads === 1) { measured(); await barrier; }
      return observed;
    });
    const [{ count: before }] = await fx.admin`SELECT count(*)::int AS count FROM harness_shared.plan_audits
      WHERE workspace_id=${fx.workspaceId} AND harness_slug=${harness} AND plan_slug=${slug}`;
    const attempt = review.attempt();
    await measurement;
    try { await writeFile(join(root, 'proof-cache.ts'), 'export const retainedProofCache = null;\n'); }
    finally { release(); }
    expect(await attempt).toMatchObject({ error: 'discovery_not_ready' });
    expect(review.route).not.toHaveBeenCalled();
    expect(review.open).not.toHaveBeenCalled();
    const [{ count: after }] = await fx.admin`SELECT count(*)::int AS count FROM harness_shared.plan_audits
      WHERE workspace_id=${fx.workspaceId} AND harness_slug=${harness} AND plan_slug=${slug}`;
    const [{ count: requests }] = await fx.admin`SELECT count(*)::int AS count FROM harness_shared.consult_state
      WHERE workspace_id=${fx.workspaceId} AND requester_id=${OWNER}`;
    expect(after).toBe(before);
    expect(requests).toBe(0);
  });

  it('converges concurrent and restarted current review acceptance on one persisted request', async () => {
    await revision(plan(revisedFindings(), true));
    expect(await finalized()).toMatchObject({ ok: true, discovery: { readiness: { ready: true } } });
    let opened!: () => void;
    let release!: () => void;
    const opening = new Promise<void>(resolve => { opened = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const created: string[] = [];
    const open: GetFeedbackDeps['open'] = async input => {
      const rows = await fx.admin`INSERT INTO harness_shared.coord_conversations
        (workspace_id,id,kind,asker_id,title,body)
        VALUES (${fx.workspaceId},${input.id!},'consult',${OWNER},${input.title},${input.body})
        ON CONFLICT (workspace_id,id) DO NOTHING RETURNING id`;
      if (rows.length) { created.push(input.id!); opened(); await barrier; }
      return { conversation_id: input.id!, thread_id: input.id!, delivered: 0 };
    };
    const deps: Pick<GetFeedbackDeps, 'getSql' | 'open' | 'withCurrentDiscovery'> = {
      getSql: () => fx.admin, open,
      withCurrentDiscovery: (input, accept) => withCurrentDiscovery(input, accept, { context: resolver }),
    };
    const request: GetFeedbackRequest = { workspaceId: fx.workspaceId, requesterId: OWNER,
      harnessSlug: harness, originTaskRef: slug, policy: BAR_CRITIQUE_POLICY,
      question: 'Review the complete reconciled current BAR set.', requestKey: slug };
    const first = acceptFeedbackRequestCore(request, deps);
    await opening;
    try {
      expect(await acceptFeedbackRequestCore(request, deps)).toMatchObject({ error: 'discovery_not_ready' });
    } finally { release(); }
    const accepted = await first;
    expect(accepted).toMatchObject({ ok: true, verdict: 'accepted' });
    expect(await acceptFeedbackRequestCore(request, deps)).toMatchObject(accepted);
    expect(created).toHaveLength(1);
    const [{ count }] = await fx.admin`SELECT count(*)::int AS count FROM harness_shared.consult_state
      WHERE workspace_id=${fx.workspaceId} AND conversation_id=${created[0]!}`;
    expect(count).toBe(1);
  });

  it('guards the canonical draft-to-ready writer before activation effects and preserves the draft on refusal', async () => {
    const original = discoveryAudits.withCurrentDiscovery;
    const localSource: typeof withCurrentDiscovery = (request, accept, _effects, transaction) =>
      original(request, accept, { context: resolver }, transaction);
    const discovery = vi.spyOn(discoveryAudits, 'withCurrentDiscovery').mockImplementation(localSource);
    const reachedActivation = new Error('RECONCILED_DISCOVERY_REACHED_ACTIVATION');
    const activation = vi.spyOn(activationGate, 'evaluateConversationActivationGate')
      .mockImplementation(async () => { throw reachedActivation; });
    const transition = () => withPlanLock({ workspaceId: fx.workspaceId, harnessSlug: harness },
      { slug, workspaceId: fx.workspaceId, harnessSlug: harness, actorId: OWNER,
        intent: 'lifecycle fixture enters implementation review' },
      async current => ({ newBody: current!.replace('status: draft', 'status: ready'), value: 'ready' }));
    try {
      const [before] = await fx.admin`SELECT content,version FROM harness_shared.harness_plans
        WHERE workspace_id=${fx.workspaceId} AND harness_slug=${harness} AND plan_slug=${slug}`;
      expect(await transition()).toMatchObject({ kind: 'refused', value: { code: 'discovery_not_ready' } });
      expect(activation).not.toHaveBeenCalled();
      const [after] = await fx.admin`SELECT content,version FROM harness_shared.harness_plans
        WHERE workspace_id=${fx.workspaceId} AND harness_slug=${harness} AND plan_slug=${slug}`;
      expect(after).toEqual(before);
      await revision(plan(revisedFindings(), true));
      expect(await finalized()).toMatchObject({ ok: true, discovery: { readiness: { ready: true } } });
      await expect(transition()).rejects.toBe(reachedActivation);
      expect(activation).toHaveBeenCalledTimes(1);
      expect(discovery.mock.calls.every(call => call[3] !== undefined)).toBe(true);
    } finally {
      activation.mockRestore();
      discovery.mockRestore();
    }
  });

  it('refuses the exact deferred census and a falsely asserted ready record before routing/opening/starting', async () => {
    const review = reviewDeps();
    for (const declaration of [pending, { ...pending, questions: questions.map(question => ({ ...question, outcome: 'answered' as const })) }]) {
      await revision(plan(declaration));
      expect(await finalized()).toMatchObject({ ok: true, discovery: { readiness: { ready: false } } });
      expect(await review.attempt()).toMatchObject({ error: 'discovery_not_ready' });
      expect(await startAttempt()).toMatchObject({ error: 'discovery_not_ready' });
    }
    expect(discoveryDeclarationSchema.safeParse({ ...pending, ready: true }).success).toBe(false);
    expect(review.route).not.toHaveBeenCalled();
    expect(review.open).not.toHaveBeenCalled();
    const [{ count }] = await fx.admin`SELECT count(*)::int AS count FROM harness_shared.consult_state
      WHERE workspace_id=${fx.workspaceId} AND origin_task_ref=${slug}`;
    expect(count).toBe(0);
  });

  it('incorporates actual source findings, removes duplicate census work, then admits the corrected revision', async () => {
    await finalized();
    await revision(plan(revisedFindings(), true));
    expect(await startAttempt('P-002')).toMatchObject({ error: 'discovery_not_ready' });
    const result = await finalized();
    expect(result).toMatchObject({ ok: true, discovery: { readiness: { ready: true } } });
    expect(await startAttempt('P-002')).toBeNull();
    const review = reviewDeps();
    await expect(review.attempt()).rejects.toThrow('REVIEW_ROUTING_ADMITTED');
    expect(review.route).toHaveBeenCalledOnce();
    const accepted = await withCurrentDiscovery(input(), async (_tx, subject) => subject.content, { context: resolver });
    expect(accepted).toMatchObject({ ok: true, result: content });
    // A plain replay models a restarted caller; it reads canonical state again.
    expect(await current()).toMatchObject({ ok: true });
  });

  it('consumes existing code-intelligence research results through canonical evidence and rejects unsupported tool-only output', async () => {
    await fx.admin`DELETE FROM harness_shared.code_intel_research_trails
      WHERE workspace_id=${fx.workspaceId} AND owner_id=${OWNER} AND harness_slug=${harness}`;
    const capture = { workspace: fx.workspaceId, owner: OWNER, harness, client: 'codex', root,
      calls: [{ tool: 'Read', toolInput: { file_path: join(root, 'proof-cache.ts') } }] };
    const subjects = await researchSubjects(capture, null);
    expect(subjects).toMatchObject([{ kind: 'path', path: 'proof-cache.ts' }]);
    await persistResearchBatch(capture, subjects);
    const advice = await suggestResearchAnchors(fx.workspaceId, OWNER, harness);
    expect(advice).toMatchObject({ sourceRefs: ['source:proof-cache.ts'], manualEntry: true });
    const declaration = revisedFindings();
    declaration.findings[0]!.evidenceRefs = advice.sourceRefs;
    await revision(plan(declaration, true));
    const result = await finalized();
    expect(result).toMatchObject({ ok: true, discovery: { readiness: { ready: true } } });
    if (!result.ok) throw new Error('canonical discovery finalization refused research source');
    const fingerprint = createHash('sha256').update(await readFile(join(root, 'proof-cache.ts'))).digest('hex');
    expect(result.discovery.evidence).toContainEqual({
      ref: advice.sourceRefs[0], state: 'current', usable: true, fingerprint,
    });
    expect(result.discovery.findings?.['F-1']?.evidence).toEqual({ 'source:proof-cache.ts': fingerprint });
    const [{ discovery: retained }] = await fx.admin`SELECT discovery FROM harness_shared.plan_audits
      WHERE workspace_id=${fx.workspaceId} AND harness_slug=${harness} AND plan_slug=${slug}
        AND audit_kind='discovery' ORDER BY audit_seq DESC LIMIT 1`;
    expect(retained.evidence).toEqual(result.discovery.evidence);
    expect(await current()).toMatchObject({ ok: true });

    await writeFile(join(root, 'proof-cache.ts'), 'export const retainedProofCache = null;\n');
    const review = reviewDeps();
    expect(await review.attempt()).toMatchObject({ error: 'discovery_not_ready' });
    expect(await startAttempt('P-002')).toMatchObject({ error: 'discovery_not_ready' });
    expect(review.route).not.toHaveBeenCalled();
    expect(review.open).not.toHaveBeenCalled();

    await fx.admin`DELETE FROM harness_shared.code_intel_research_trails
      WHERE workspace_id=${fx.workspaceId} AND owner_id=${OWNER} AND harness_slug=${harness}`;
    expect(await suggestResearchAnchors(fx.workspaceId, OWNER, harness)).toMatchObject({
      sourceRefs: [], reason: 'trail not captured for this client',
    });
    const unsupported = revisedFindings();
    unsupported.findings[0]!.evidenceRefs = ['tool:research-trail'];
    await revision(plan(unsupported, true));
    expect(await finalized()).toMatchObject({ ok: true, discovery: { readiness: { ready: false, state: 'unknown' } } });
    expect(await review.attempt()).toMatchObject({ error: 'discovery_not_ready' });
    expect(await startAttempt('P-002')).toMatchObject({ error: 'discovery_not_ready' });
    expect(review.route).not.toHaveBeenCalled();
    expect(review.open).not.toHaveBeenCalled();
    // No capture is required when current confined source independently supports a fresh judgment.
    const fallback = revisedFindings();
    fallback.findings[0]!.conclusion = 'Current source now has no retained cache; reuse its existing caller seam after restoring the cache.';
    await revision(plan(fallback, true));
    expect(await finalized()).toMatchObject({ ok: true, discovery: { readiness: { ready: true } } });
  });

  it('uses current source fallback, retains provenance after trail GC, and refuses relevant source mutation', async () => {
    await revision(plan(revisedFindings(), true));
    expect(await finalized()).toMatchObject({ ok: true, discovery: { readiness: { ready: true } } });
    await fx.admin`DELETE FROM harness_shared.code_intel_research_trails
      WHERE workspace_id=${fx.workspaceId} AND owner_id=${OWNER} AND harness_slug=${harness}`;
    expect(await current()).toMatchObject({ ok: true });
    await writeFile(join(root, 'proof-cache.ts'), 'export const retainedProofCache = null;\n');
    const review = reviewDeps();
    expect(await review.attempt()).toMatchObject({ error: 'discovery_not_ready' });
    expect(review.route).not.toHaveBeenCalled();
    expect(await startAttempt('P-002')).toMatchObject({ error: 'discovery_not_ready' });
  });

  it('measures confined current source without optional client research capture and keeps missing authority unknown', async () => {
    await fx.admin`DELETE FROM harness_shared.code_intel_research_trails
      WHERE workspace_id=${fx.workspaceId} AND owner_id=${OWNER} AND harness_slug=${harness}`;
    await revision(plan(revisedFindings(), true));
    expect(await finalized()).toMatchObject({ ok: true, discovery: { readiness: { ready: true } } });
    const unavailable = (draft: string, previous: string | null, prior?: Parameters<typeof resolveDiscoveryAuditContext>[2]['prior']) =>
      resolveDiscoveryAuditContext(draft, previous, { repoRoot: null, workspaceId: fx.workspaceId,
        sql: fx.admin, harnessSlug: harness, ownerId: OWNER, planSlug: slug, prior });
    expect(await withCurrentDiscovery(input(), async () => 'must not run', { context: unavailable }))
      .toMatchObject({ ok: false, discovery: { readiness: { state: 'unknown' } } });
    const outside = revisedFindings();
    outside.findings[0]!.evidenceRefs = ['source:../proof-cache.ts'];
    await revision(plan(outside, true));
    expect(await finalized()).toMatchObject({ ok: true, discovery: { readiness: { ready: false, state: 'unknown' } } });
  });

  it('supports evidence-backed no-change and a bounded nonblocking implementation experiment without copied facts', async () => {
    const declaration: DiscoveryDeclaration = { notApplicable: 'Current source establishes this general review; no material unknowns remain.',
      questions: [], findings: [{ id: 'F-1', questions: [], conclusion: 'Keep the evidenced existing scope unchanged.',
        evidenceRefs: ['source:proof-cache.ts'], dispositions: [{ target: 'P-001', decision: 'unchanged', reason: 'Current behavior supports the scope.' }] }] };
    await revision(plan(declaration));
    expect(await finalized()).toMatchObject({ ok: true, discovery: { readiness: { ready: true } } });
    const experiment = revisedFindings();
    experiment.questions[2] = { ...experiment.questions[2]!, outcome: 'experiment',
      rationale: 'Implementation timing cannot invalidate the demonstrated cache reuse or scope.',
      bounds: 'Measure one caller within one retained-proof lifetime; stop if its existing contract changes.' };
    await revision(plan(experiment, true));
    expect(await finalized()).toMatchObject({ ok: true, discovery: { readiness: { ready: true } } });
    expect(discoveryDeclarationSchema.safeParse({ ...experiment, fingerprint: 'copied', ready: true }).success).toBe(false);
  });

  it('batches multiple findings into one idempotent persistence operation across retries, concurrency and cosmetic edits', async () => {
    const declaration = revisedFindings();
    const finding = declaration.findings[0]!;
    declaration.findings = [{ ...finding, dispositions: [finding.dispositions[0]!] },
      { ...finding, id: 'F-2', dispositions: [finding.dispositions[1]!] }];
    await revision(plan(declaration, true));
    const results = await Promise.all([finalized(), finalized()]);
    expect(results.some(result => result.ok && result.discovery.readiness.ready), JSON.stringify(results)).toBe(true);
    for (const result of results) {
      if (result.ok) expect(result.discovery.readiness.ready).toBe(true);
      else expect(result.error).toBe('plan_busy');
    }
    // The writer deliberately refuses contended try-locks. Replaying the same
    // operation must reuse the winning audit without a second authored record.
    expect(await finalized()).toMatchObject({ ok: true, reused: true, discovery: { readiness: { ready: true } } });
    await revision(content.replace('# Proof warming fixture', '# Proof warming fixture   ') + '\n## Now\nBookkeeping only.\n');
    expect(await finalized()).toMatchObject({ ok: true, reused: true });
    const [{ count }] = await fx.admin`SELECT count(*)::int AS count FROM harness_shared.plan_audits
      WHERE workspace_id=${fx.workspaceId} AND harness_slug=${harness} AND plan_slug=${slug} AND audit_kind='discovery'`;
    expect(count).toBe(1);
  });
});
