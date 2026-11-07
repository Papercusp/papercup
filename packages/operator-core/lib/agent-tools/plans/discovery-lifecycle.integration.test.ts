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
  await fx.admin.begin(async tx => {
    const scope = { workspaceId: fx.workspaceId, harnessSlug: harness, planSlug: slug };
    const index = deriveIndexFromContent(next);
    const previous = await readPlanLineNodes(tx as never, { ...scope, slug });
    await writePlanIndexRows(tx as never, scope, index);
    await writePlanLineNodes(tx as never, { ...scope, slug }, previous, index.items);
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

describe('original proof-warming discovery before review and implementation', () => {
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
