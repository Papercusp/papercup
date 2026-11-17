import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { harnessRoot } from '@papercusp/harness/paths';
import { DEFAULT_WORKSPACE_ID } from '../../workspace-registry';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { matchReactions } from '../../events';
import { mockResolvedTyped } from '../../testing/typed-mock';
import { parsePushSnapshot, type PushSnapshot } from '../../code-intelligence/push-snapshot';
import { buildSymbolSnapshot, relativeSymbolModule } from '../../../../../scripts/lib/code-intel-symbol-snapshot.mjs';
import * as anchorStore from '../../plan-items/anchor-store';
import * as workItems from '../../work-items';
import { setupPlanPgFixture, seedPlan, cleanupPlans, type PlanPgFixture } from './__tests__/_pg-tool-fixture';
import addTool from './add-item';
import editTool from './edit';
import getTool from './get';
import workItemGetTool from '../work_items/get';
import completeTool from '../work_items/complete';
import planItemStatusTool from './set-status';
import './set-status';
import '../../plan-items/reflect-rules';
import '../plan-items/release';
import { deriveIndexFromContent } from './derive-index';
import { hashPlanContent } from './content-hash';
import { writePlanLineNodes, readPlanLineNodes, repairSavedPlanLines, type SavedPlanLinesPreview } from './plan-line-graph';
import { mutateWorkItemDependenciesInTransaction, withWorkItemDependencyAdmissionTransaction } from '../../dbos/work-item-deps-store';
import backfillDependencyEdgesTool from './backfill-dependency-edges';
import { writePlanIndexRows } from './plan-index-rows';
import { withPlanLock } from './with-plan-lock';
import { prepareBlockerDecision } from '../../blocker-resolution-decision';
import { applyBlockerDecisionMutation, type BlockerDecisionMutation } from '../../blocker-resolution-persistence';
import { checkPlanStartable } from './plan-start-gate';
import * as lifecycle from '../../acceptance-bar-lifecycle-evaluator';
import * as admission from './plan-admission-gate';
import { resolvePlanItemAnchors } from '../../plan-items/anchors';
import { runWithWorkspace } from '../../workspace-als';
import { IMPLEMENTS_REL } from '../../plan-items/convert';
import { PLAN_ITEM_KIND, planItemRef } from '../../issue-blocks-merge';
import * as linkedWorkItems from '../../plan-items/reconcile-linked-work-items';
import type { LinkedWorkItem } from '../../plan-items/reconcile-linked-work-items';

it('round-trips intended changes through add, unrelated plan rewrites and target updates', async () => {
  const change = { action: 'modify', summary: 'Persist recovery state', reason: 'Avoid lost work' };
  const result = data(await add({ anchors: [{ symbol: 'linked', path: 'code.ts', change }] }));
  const item = result.results[0];
  expect(item.ok, JSON.stringify(item)).toBe(true);
  await add({ text: 'Unrelated index rewrite' });
  const read = data(await getTool.handler({ slug: SLUG, harness: HARNESS, mode: 'full', includeEnrichments: false } as never, ctx())).results[0];
  expect(read.items.find((i: any) => i.id === item.itemId).anchors[0].change).toEqual(change);
  expect(read.prose).toContain('Persist recovery state');
  const planned = { action: 'create', summary: 'Add recovery helper', reason: 'Keep existing queue ownership' };
  const edited = data(await editTool.handler({ slug: SLUG, harness: HARNESS, itemId: item.itemId,
    rationale: 'Implementation identified a new helper', anchors: [{ symbol: 'recoverNew', path: 'recovery.ts', change: planned }] } as never, ctx()));
  expect(edited.anchors[0]).toMatchObject({ path: 'recovery.ts', unknownReason: 'planned', change: planned });
  const stored = await anchorStore.readPlanItemAnchors({ workspaceId: WS, harnessSlug: HARNESS, planSlug: SLUG });
  expect(stored[item.itemId][0].change).toEqual(planned);
});

const fixture = vi.hoisted(() => ({ root: '', snapshot: null as PushSnapshot | null }));
vi.mock('../../plan-items/anchors', async importOriginal => {
  const actual = await importOriginal<typeof import('../../plan-items/anchors')>();
  return { ...actual, resolveHarnessAnchors: async (_workspace: string, _harness: string, inputs: import('../../plan-items/anchors').AnchorInput[]) =>
    actual.resolvePlanItemAnchors(inputs, { root: fixture.root, snapshot: fixture.snapshot, budgetMs: 5000 }) };
});
// These tests exercise the initial code-scope gate. Discovery is an independent
// prerequisite, so accept it here and keep the real scope and anchor checks intact.
vi.mock('../../plan-audits', async importOriginal => {
  const actual = await importOriginal<typeof import('../../plan-audits')>();
  return {
    ...actual,
    withCurrentDiscovery: (async (_input: unknown, accept: () => Promise<unknown>) => ({
      ok: true as const,
      result: await accept(),
    })) as typeof actual.withCurrentDiscovery,
  };
});
// Exercise the real completion writer and dependency reactions without launching
// independent graders or completion-verification agents from this local fixture.
vi.mock('../../grading-integrity', async importOriginal => {
  const actual = await importOriginal<typeof import('../../grading-integrity')>();
  return { ...actual, dispatchPendingGradingAudits: async () => ({ requestedTargetIds: [], receipts: [] }) };
});
vi.mock('../../harness/improvements/completion-verification-store', async importOriginal => {
  const actual = await importOriginal<typeof import('../../harness/improvements/completion-verification-store')>();
  return {
    ...actual,
    spawnCompletionVerificationForClose: async () => ({ outcome: 'no-dependents' }),
    applyCompletionVerdictForClose: async () => null,
    acceptCompletionOnSettlementForSubject: async () => null,
  };
});

const HARNESS = `zzz-anchors-${Date.now()}`;
const SLUG = 'zzz-plan-anchors';
const WS = DEFAULT_WORKSPACE_ID;
let fx: PlanPgFixture;
const source = 'export function linked() { return 1; }\n';
const digest = createHash('sha256').update(source).digest('hex');
const declarationDigest = createHash('sha256').update('export function linked() { return 1; }').digest('hex');
const ctx = () => ({ signal: new AbortController().signal, role: 'su', workspaceId: WS,
  log: () => {}, progress: () => {}, metadata: () => {},
  principal: { kind: 'agent', slug: 'agent-anchor-test', workspaceId: WS } }) as unknown as Parameters<typeof editTool.handler>[1];
function body() { return `---\ntitle: Anchor fixture\nslug: ${SLUG}\nstatus: draft\ncreated: 2026-10-22\nupdated: 2026-10-22\n---\n# Anchor fixture\n\n## Now\n\n**State:** Fixture.\n\n**Next:** Check links.\n\n## Phase 1 — Work\n\n- **P-001** \`todo\` Existing item\n\n## Decisions\n`; }
function data(result: unknown): any {
  const envelope = result as { data?: unknown; content?: { type: string; text?: string }[] };
  if (envelope.data !== undefined) return envelope.data;
  const text = envelope.content?.find(c => c.type === 'text' && c.text?.startsWith('{'))?.text;
  if (!text) throw new Error('No JSON tool result');
  return JSON.parse(text);
}
const add = (extra: Record<string, unknown> = {}) => addTool.handler({ slug: SLUG, harness: HARNESS,
  phase: 'Phase 1 — Work', text: 'Added item', importance: 'normal', ...extra } as never, ctx());
function linkedWorkItem(id: string, state: string, viaImplementsEdge: boolean, viaPlanLineNode = false): LinkedWorkItem {
  const canonical = viaPlanLineNode;
  return {
    id, kind: canonical ? 'feature' : 'change', family: canonical ? 'feature' : 'issue', harness: HARNESS,
    title: id, summary: id, state, assignee: null, takenAt: null, lastProgressAt: null,
    assignedBy: null, createdBy: null, severity: null, goalId: null, parent: null, payload: null,
    origin: 'local', auditVerdict: null, verifiedAuthorGithubUserId: null, rank: null, rankWriter: null,
    rankUpdatedAt: null, priority: null, terminalOwner: null, terminalCompletionRef: null,
    terminalCompletionEvidence: null, completionAuthority: state === 'done' ? 'proposed' : null,
    createdAt: '2026-11-12T00:00:00.000Z', updatedAt: '2026-11-12T00:00:00.000Z', closedAt: null,
    viaImplementsEdge, ...(viaPlanLineNode ? { viaPlanLineNode: true } : {}),
  };
}

describe('same-row plan-line adoption', () => {
  const ID = 'WI-900000000000001';
  const CHILD = 'WI-900000000000002';
  async function seedIssue() {
    await fx.admin`INSERT INTO harness_shared.work_items
      (workspace_id,harness_slug,feature_id,item_kind,title,summary,status,nature,audience,
       taken_by,taken_at,source_plan_slug,source_plan_item_ids,payload,created_ts,updated_ts,ts)
      VALUES (${WS},${HARNESS},${ID},'bug','Original title','Original summary','blocked','work','agent',
        'agent-anchor-test','2026-11-12 12:00:00.123456+00','historical-source',ARRAY['P-099'],
        '{"_claimHold":true,"claim_hold_by":"independent","custom":{"keep":null}}'::jsonb,1,2,1)`;
    await fx.admin`INSERT INTO harness_shared.work_items
      (workspace_id,harness_slug,feature_id,item_kind,title,status,parent_id,payload,created_ts,updated_ts,ts)
      VALUES (${WS},${HARNESS},${CHILD},'task','Preserved descendant','open',${ID},'{"reservation":"kept"}'::jsonb,1,2,1)`;
  }
  async function adoption() {
    const parsed = workItemGetTool.args.parse({ id: ID, harness: HARNESS, adoptionSnapshot: true });
    const result = data(await workItemGetTool.handler(parsed, ctx())).results[0];
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.adoptionSnapshot).toMatchObject({ schemaVersion: 1, fingerprint: expect.stringMatching(/^v1:[a-f0-9]{64}$/) });
    const [plan] = await fx.admin`SELECT version,content_hash FROM harness_shared.harness_plans
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG}`;
    return { id: ID, expectedPlanVersion: Number(plan.version), expectedPlanHash: plan.content_hash,
      expectedAdoptionFingerprint: result.adoptionSnapshot.fingerprint };
  }
  async function snapshot() {
    const [row] = await fx.admin`SELECT jsonb_build_object(
      'plan',(SELECT jsonb_agg(to_jsonb(p)) FROM harness_shared.harness_plans p WHERE workspace_id=${WS} AND harness_slug=${HARNESS}),
      'rows',(SELECT jsonb_agg(to_jsonb(w) ORDER BY feature_id) FROM harness_shared.work_items w WHERE workspace_id=${WS} AND harness_slug=${HARNESS}),
      'index',(SELECT jsonb_agg(to_jsonb(i) ORDER BY item_id) FROM harness_shared.plan_items i WHERE workspace_id=${WS} AND harness_slug=${HARNESS}),
      'anchors',(SELECT jsonb_agg(to_jsonb(a)) FROM harness_shared.plan_item_anchors a WHERE workspace_id=${WS} AND harness_slug=${HARNESS}),
      'revisions',(SELECT jsonb_agg(to_jsonb(r) ORDER BY seq) FROM harness_shared.plan_revisions r WHERE workspace_id=${WS} AND harness_slug=${HARNESS}),
      'deps',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM harness_shared.work_item_deps d WHERE blocked_ref=${ID} OR blocker_ref=${ID}),
      'links',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM harness_shared.coord_links l WHERE src_ref=${ID} OR dst_ref=${ID})
    ) AS value`;
    return row.value;
  }
  async function protectedRows() {
    return fx.admin`SELECT (to_jsonb(w)-ARRAY['plan_slug','plan_line_id','plan_seq','plan_phase',
      'plan_importance','plan_decision_refs','plan_deliverable','plan_owner_gate_marker','plan_line_text',
      'updated_ts','origin'])::text AS value FROM harness_shared.work_items w
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND feature_id IN (${ID},${CHILD}) ORDER BY feature_id`;
  }
  it('adopts the original held issue without changing protected state or minting a sibling', async () => {
    await seedIssue();
    const before = await protectedRows();
    const count = await fx.admin`SELECT feature_id FROM harness_shared.work_items WHERE workspace_id=${WS} AND harness_slug=${HARNESS}`;
    const result = data(await add({ adoptExistingWorkItem: await adoption() })).results[0];
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(await protectedRows()).toEqual(before);
    const after = await fx.admin`SELECT feature_id FROM harness_shared.work_items WHERE workspace_id=${WS} AND harness_slug=${HARNESS}`;
    expect(after.map(r => r.feature_id).sort()).toEqual(count.map(r => r.feature_id).sort());
    const nodes = await readPlanLineNodes(fx.admin, { workspaceId: WS, harnessSlug: HARNESS, slug: SLUG });
    expect(nodes.find(n => n.id === result.itemId)).toMatchObject({ featureId: ID, status: 'blocked', kind: 'bug' });
    const [index] = await fx.admin`SELECT status FROM harness_shared.plan_items WHERE workspace_id=${WS}
      AND harness_slug=${HARNESS} AND plan_slug=${SLUG} AND item_id=${result.itemId}`;
    expect(index.status).toBe('blocked');
    const [plan] = await fx.admin`SELECT content,content_hash FROM harness_shared.harness_plans WHERE workspace_id=${WS}
      AND harness_slug=${HARNESS} AND plan_slug=${SLUG}`;
    expect(plan.content).toContain(`**${result.itemId}** \`blocked\``);
    const revisions = await fx.admin`SELECT content_hash FROM harness_shared.plan_revisions WHERE workspace_id=${WS}
      AND harness_slug=${HARNESS} AND plan_slug=${SLUG} ORDER BY seq DESC LIMIT 1`;
    expect(revisions[0].content_hash).toBe(plan.content_hash);
  });
  it('passes validated adoption into the writer before persistence without INSERT', async () => {
    await seedIssue();
    // The existing prior-node map intentionally does NOT contain the newly allocated line.
    expect((await readPlanLineNodes(fx.admin, { workspaceId: WS, harnessSlug: HARNESS, slug: SLUG }))
      .some(n => n.featureId === ID)).toBe(false);
    const result = data(await add({ adoptExistingWorkItem: await adoption() })).results[0];
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const rows = await fx.admin`SELECT feature_id,status FROM harness_shared.work_items WHERE workspace_id=${WS}
      AND harness_slug=${HARNESS} AND plan_slug=${SLUG} AND plan_line_id=${result.itemId}`;
    expect([...rows]).toEqual([{ feature_id: ID, status: 'blocked' }]);
  });
  it('completes the adopted legacy row as its canonical line and clears the dependent readiness floor', async () => {
    await fx.admin`INSERT INTO harness_shared.work_items
      (workspace_id,harness_slug,feature_id,item_kind,title,summary,status,nature,audience,
       taken_by,taken_at,source_plan_slug,source_plan_item_ids,payload,admission,created_ts,updated_ts,ts)
      VALUES (${WS},${HARNESS},${ID},'bug','Legacy execution','Original accepted execution','wip','work','agent',
        'agent-anchor-test',now(),${SLUG},ARRAY['P-002'],'{}'::jsonb,'admitted',1,2,1)`;

    const adoptionToken = await adoption();
    const adopted = data(await add({ text: 'Legacy execution', adoptExistingWorkItem: adoptionToken })).results[0];
    expect(adopted.ok, JSON.stringify(adopted)).toBe(true);
    expect(adopted.itemId).toBe('P-002');

    const dependent = data(await add({ text: 'Dependent work', blockedBy: ['P-002'] })).results[0];
    expect(dependent.ok, JSON.stringify(dependent)).toBe(true);
    const [dependentNode] = (await readPlanLineNodes(fx.admin,
      { workspaceId: WS, harnessSlug: HARNESS, slug: SLUG })).filter(node => node.id === dependent.itemId);
    expect(dependentNode).toBeDefined();
    const [blockedBefore] = await fx.admin`SELECT harness_shared.work_item_is_blocked(
      ${HARNESS},${dependentNode!.featureId},${WS}) AS blocked`;
    expect(blockedBefore.blocked).toBe(true);

    const closeArgs = completeTool.args.parse({
      id: ID,
      harness: HARNESS,
      state: 'done',
      assumptions: 'none',
      changeKinds: ['no-code-change'],
      changeKindReason: 'This isolated fixture closes an existing row and changes no source files.',
      completion: {
        summary: 'Complete the accepted legacy execution on its canonical plan line.',
        testsRun: 'npm run test:file -- packages/operator-core/lib/agent-tools/plans/item-anchors.integration.test.ts',
        testResult: 'The original row becomes the terminal graph node and its dependent readiness floor clears.',
        verifiedHow: 'automated-test',
        filesChanged: [],
        verification: { workOutcome: 'other-no-new-change' },
        rootCauseVerification: {
          contractVersion: 2,
          hypothesis: 'The legacy execution and canonical plan line use separate work-item identities.',
          alternativeHypothesis: 'The canonical plan line retains the legacy execution identity.',
          distinguishingTest: 'Complete the adopted row, then compare its identity with the terminal graph node and dependent readiness predicate.',
          testResult: 'The graph node retains the legacy row identity and the dependent readiness predicate clears.',
          testProcedure: 'Read the work-item row, canonical plan-line node, and work_item_is_blocked result after completion.',
          predictedObservations: {
            hypothesis: 'The terminal graph node has a different feature id and the dependent remains blocked.',
            alternativeHypothesis: 'The terminal graph node has the legacy feature id and the dependent is no longer blocked.',
          },
          actualObservation: 'The terminal graph node uses the legacy feature id and work_item_is_blocked returns false for its dependent.',
          evidenceRefs: ['test:packages/operator-core/lib/agent-tools/plans/item-anchors.integration.test.ts'],
        },
      },
    });
    const blockersBeforeClose = await runWithWorkspace(WS, () =>
      workItems.readUnresolvedDepBlockers(ID, HARNESS));
    expect(blockersBeforeClose).toEqual([]);
    const dependentBlockers = await runWithWorkspace(WS, () =>
      workItems.readUnresolvedDepBlockers(dependentNode!.featureId, HARNESS));
    expect(dependentBlockers).toMatchObject([{ ref: ID, kind: 'issue', satisfaction: 'settled' }]);
    const closeResponse = await runWithWorkspace(WS, () => completeTool.handler(closeArgs,
      { ...ctx(), uiClientId: 'agent-anchor-test', isSuperuser: true } as never));
    const closeResult = data(closeResponse).results[0];
    expect(closeResult.ok, JSON.stringify(closeResult)).toBe(true);

    const [stored] = await fx.admin`SELECT feature_id,status,plan_slug,plan_line_id,
        payload -> '_completionEvidence' AS completion_evidence
      FROM harness_shared.work_items WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND feature_id=${ID}`;
    expect(stored).toMatchObject({ feature_id: ID, status: 'done', plan_slug: SLUG,
      plan_line_id: 'P-002', completion_evidence: expect.any(Object) });
    const line = (await readPlanLineNodes(fx.admin,
      { workspaceId: WS, harnessSlug: HARNESS, slug: SLUG })).find(node => node.id === 'P-002');
    expect(line).toMatchObject({ featureId: ID, status: 'done' });
    const [canonicalRows] = await fx.admin`SELECT count(*)::int AS count FROM harness_shared.work_items
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG} AND plan_line_id='P-002'`;
    expect(canonicalRows.count).toBe(1);
    const [blockedAfter] = await fx.admin`SELECT harness_shared.work_item_is_blocked(
      ${HARNESS},${dependentNode!.featureId},${WS}) AS blocked`;
    expect(blockedAfter.blocked).toBe(false);
  });
  it('reconciles a committed split-ID execution onto its canonical line without copying child proof', async () => {
    const scope = { workspaceId: WS, harnessSlug: HARNESS, slug: SLUG };
    const [canonical] = await readPlanLineNodes(fx.admin, scope);
    expect(canonical).toMatchObject({ id: 'P-001', status: 'todo', kind: 'feature' });
    const executionId = 'WI-900000000000003';
    // Model a started plan: the migration-only claim hold has already been lifted,
    // while the canonical graph identity remains the original feature row.
    await fx.admin`UPDATE harness_shared.work_items
      SET payload = COALESCE(payload, '{}'::jsonb) - '_claimHold' - 'claim_hold_by' - 'claim_hold_at' - 'claim_hold_reason'
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND feature_id=${canonical.featureId}`;
    const dependent = data(await add({ text: 'Dependent work', blockedBy: ['P-001'] })).results[0];
    expect(dependent.ok, JSON.stringify(dependent)).toBe(true);
    const [dependentNode] = (await readPlanLineNodes(fx.admin, scope))
      .filter(node => node.id === dependent.itemId);
    expect(dependentNode).toBeDefined();
    const [blockedBefore] = await fx.admin`SELECT harness_shared.work_item_is_blocked(
      ${HARNESS}, ${dependentNode!.featureId}, ${WS}) AS blocked`;
    expect(blockedBefore.blocked).toBe(true);

    const planStamp = {
      plan_slug: SLUG,
      item_id: 'P-001',
      harness_slug: HARNESS,
      item_text_hash: 'split-id-fixture',
    };
    await fx.admin`INSERT INTO harness_shared.work_items
      (workspace_id,harness_slug,feature_id,item_kind,title,summary,status,nature,audience,
       taken_by,taken_at,source_plan_slug,source_plan_item_ids,payload,admission,created_ts,updated_ts,ts)
      VALUES (${WS},${HARNESS},${executionId},'change','Accepted execution','Execution proof stays on this row',
        'wip','work','agent','agent-anchor-test',now(),${SLUG},ARRAY['P-001'],
        ${JSON.stringify({ plan_item: planStamp })}::text::jsonb,'admitted',1,2,1)`;
    await fx.admin`INSERT INTO harness_shared.coord_links
      (workspace_id,src_kind,src_ref,dst_kind,dst_ref,rel)
      VALUES (${DEFAULT_COORD_WORKSPACE},'issue',${executionId},${PLAN_ITEM_KIND},
        ${planItemRef(SLUG,'P-001')},${IMPLEMENTS_REL})`;

    // `plans:add-item` above persists the status parsed from the plan body, so
    // promote only after setup. This makes the completion reflection exercise
    // the admitted active-plan lifecycle writer instead of the draft exception.
    const [activePlan] = await fx.admin`UPDATE harness_shared.harness_plans
      SET status='active', op_status=NULL
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG}
      RETURNING status`;
    expect(activePlan.status).toBe('active');

    // A linked terminal row is not enough to authorize the canonical lifecycle
    // projection: its completion must have committed authority and persisted
    // evidence. Prove the status tool still refuses a proposed child close.
    await fx.admin`UPDATE harness_shared.work_items SET status='done', authority='proposed',
      payload=payload || '{"_completionEvidence":{"verifiedHow":"automated-test"}}'::jsonb
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND feature_id=${executionId}`;
    const linkedLookup = vi.spyOn(linkedWorkItems, 'findAllLinkedWorkItems');
    mockResolvedTyped(linkedLookup, [
      linkedWorkItem(canonical.featureId, 'open', false, true),
      linkedWorkItem(executionId, 'done', true),
    ]);
    let refused: any;
    try {
      refused = data(await planItemStatusTool.handler(planItemStatusTool.args.parse({
        slug: SLUG, harness: HARNESS, item: 'P-001', status: 'done', onlyIfNoOtherOpenCoverage: true,
      }), ctx())).results[0];
    } finally {
      linkedLookup.mockRestore();
    }
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('plan_line_status_change_requires_lifecycle_writer');
    expect((await readPlanLineNodes(fx.admin, scope).then(nodes => nodes.find(node => node.id === 'P-001')))
      ?.status).toBe('todo');
    await fx.admin`UPDATE harness_shared.work_items SET status='wip', authority=NULL,
      payload=payload - '_completionEvidence'
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND feature_id=${executionId}`;

    const closeArgs = completeTool.args.parse({
      id: executionId,
      harness: HARNESS,
      state: 'done',
      assumptions: 'none',
      changeKinds: ['no-code-change'],
      changeKindReason: 'This isolated fixture closes an existing execution row and changes no source files.',
      completion: {
        summary: 'Close the accepted execution child in the split-ID fixture.',
        testsRun: 'npm run test:file -- packages/operator-core/lib/agent-tools/plans/item-anchors.integration.test.ts',
        testResult: 'The completion handler returns its lifecycle receipt for assertion by this integration test.',
        verifiedHow: 'automated-test',
        filesChanged: [],
        verification: { workOutcome: 'other-no-new-change' },
      },
    });
    const closeResponse = await runWithWorkspace(WS, () => completeTool.handler(closeArgs,
      { ...ctx(), uiClientId: 'agent-anchor-test', isSuperuser: true } as never));
    const closeResult = data(closeResponse).results[0];
    expect(closeResult.ok, JSON.stringify(closeResult)).toBe(true);
    expect(closeResult.finish, JSON.stringify(closeResult)).toMatchObject({ complete: true, planItem: 'done' });

    const [execution] = await fx.admin`SELECT feature_id,status,authority,
        payload -> '_completionEvidence' AS completion_evidence
      FROM harness_shared.work_items
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND feature_id=${executionId}`;
    expect(execution).toMatchObject({ feature_id: executionId, status: 'done',
      authority: 'committed', completion_evidence: expect.any(Object) });
    const [lineRow] = await fx.admin`SELECT feature_id,status,terminal_owner,authority,terminal_completion_ref,
        payload -> '_completionEvidence' AS completion_evidence
      FROM harness_shared.work_items
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND feature_id=${canonical.featureId}`;
    expect(lineRow).toMatchObject({ feature_id: canonical.featureId, status: 'done',
      terminal_owner: null, authority: null, terminal_completion_ref: null, completion_evidence: null });
    expect(lineRow.feature_id).not.toBe(execution.feature_id);
    expect((await readPlanLineNodes(fx.admin, scope).then(nodes => nodes.find(node => node.id === 'P-001'))))
      .toMatchObject({ featureId: canonical.featureId, status: 'done' });
    const [blockedAfter] = await fx.admin`SELECT harness_shared.work_item_is_blocked(
      ${HARNESS}, ${dependentNode!.featureId}, ${WS}) AS blocked`;
    expect(blockedAfter.blocked).toBe(false);
  });
  it('does not reflect a source-plan-only duplicate drop while its stamped sibling remains open', async () => {
    const scope = { workspaceId: WS, harnessSlug: HARNESS, slug: SLUG };
    const duplicateId = 'F-generated-duplicate';
    const siblingId = 'WI-canonical-source-sibling';
    const planStamp = {
      plan_slug: SLUG,
      item_id: 'P-001',
      harness_slug: HARNESS,
      item_text_hash: 'source-only-fixture',
    };
    const [canonical] = await readPlanLineNodes(fx.admin, scope);
    expect(canonical).toMatchObject({ id: 'P-001', status: 'todo' });
    const [activePlan] = await fx.admin`UPDATE harness_shared.harness_plans
      SET status='active', op_status=NULL
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG}
      RETURNING status`;
    expect(activePlan.status).toBe('active');

    // This generated row has only source-plan columns. It deliberately has no
    // payload.plan_item stamp and no implements edge to P-001.
    await fx.admin`INSERT INTO harness_shared.work_items
      (workspace_id,harness_slug,feature_id,item_kind,title,summary,status,nature,audience,
       taken_by,taken_at,source_plan_slug,source_plan_item_ids,payload,admission,created_ts,updated_ts,ts)
      VALUES (${WS},${HARNESS},${duplicateId},'feature','Generated duplicate','Duplicate of source work',
        'wip','work','agent','agent-anchor-test',now(),${SLUG},ARRAY['P-001'],'{}'::jsonb,'admitted',1,2,1)`;
    // The original source sibling is canonically bound and remains open.
    await fx.admin`INSERT INTO harness_shared.work_items
      (workspace_id,harness_slug,feature_id,item_kind,title,summary,status,nature,audience,
       taken_by,taken_at,source_plan_slug,source_plan_item_ids,payload,admission,created_ts,updated_ts,ts)
      VALUES (${WS},${HARNESS},${siblingId},'bug','Canonical source sibling','Still covers P-001',
        'open','work','agent','agent-anchor-test',now(),${SLUG},ARRAY['P-001'],
        ${JSON.stringify({ plan_item: planStamp })}::text::jsonb,'admitted',1,2,1)`;
    await fx.admin`INSERT INTO harness_shared.coord_links
      (workspace_id,src_kind,src_ref,dst_kind,dst_ref,rel)
      VALUES (${DEFAULT_COORD_WORKSPACE},'issue',${siblingId},${PLAN_ITEM_KIND},
        ${planItemRef(SLUG,'P-001')},${IMPLEMENTS_REL})`;

    const completion = {
      summary: 'Drop the generated duplicate without changing its source plan item.',
      testsRun: 'npm run test:file -- packages/operator-core/lib/agent-tools/plans/item-anchors.integration.test.ts',
      testResult: 'The duplicate closes while the canonically bound source sibling and P-001 remain open.',
      verifiedHow: 'automated-test',
      filesChanged: [],
      verification: { workOutcome: 'other-no-new-change' },
    };
    const closeArgs = completeTool.args.parse({
      id: duplicateId,
      harness: HARNESS,
      state: 'dropped',
      assumptions: 'none',
      changeKinds: ['no-code-change'],
      changeKindReason: 'This isolated fixture closes a generated duplicate and changes no source files.',
      completion,
    });
    const closeResponse = await runWithWorkspace(WS, () => completeTool.handler(closeArgs,
      { ...ctx(), uiClientId: 'agent-anchor-test', isSuperuser: true } as never));
    const closeResult = data(closeResponse).results[0];
    expect(closeResult.ok, JSON.stringify(closeResult)).toBe(true);
    // Finish reports the preserved canonical status even when coverage prevents
    // this source-only duplicate from closing the shared plan line.
    expect(closeResult.finish, JSON.stringify(closeResult)).toMatchObject({ complete: true, planItem: 'todo' });
    expect(JSON.stringify(closeResult.finish)).toContain('coverage_guard');

    const [duplicate] = await fx.admin`SELECT feature_id AS id,status AS state,
        source_plan_slug AS "sourcePlanSlug",source_plan_item_ids AS "sourcePlanItemIds",payload
      FROM harness_shared.work_items
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND feature_id=${duplicateId}`;
    expect(duplicate).toMatchObject({
      id: duplicateId, state: 'dropped', sourcePlanSlug: SLUG, sourcePlanItemIds: ['P-001'],
    });
    expect(duplicate.payload).not.toHaveProperty('plan_item');

    // Exercise the exact asynchronous reaction matcher with the completed row.
    // Source-plan columns must not become a substitute for the plan_item stamp.
    const completionEvent = {
      tool: 'work_items:complete',
      args: closeArgs,
      result: {
        ok: true,
        data: { completion, finish: closeResult.finish, workItem: duplicate },
      },
      ctx: { ...ctx(), uiClientId: 'agent-anchor-test', isSuperuser: true },
    };
    expect(matchReactions(completionEvent as never)
      .some(action => action.rule.id === 'plan-item-reflect:complete')).toBe(false);

    const [sibling] = await fx.admin`SELECT status,payload -> 'plan_item' AS plan_item
      FROM harness_shared.work_items
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND feature_id=${siblingId}`;
    expect(sibling).toMatchObject({ status: 'open', plan_item: planStamp });
    expect((await readPlanLineNodes(fx.admin, scope).then(nodes => nodes.find(node => node.id === 'P-001')))
      ?.status).toBe('todo');
  });
  it('preserves ordinary creation and D011 parks', async () => {
    const result = data(await add()).results[0];
    expect(result.ok).toBe(true);
    const [node] = await fx.admin`SELECT payload FROM harness_shared.work_items WHERE workspace_id=${WS}
      AND harness_slug=${HARNESS} AND plan_slug=${SLUG} AND plan_line_id=${result.itemId}`;
    expect(node.payload).toMatchObject({ _claimHold: true, claim_hold_by: 'migration:plan-line-work-item-nodes' });
  });
  it.each(['row','hold','descendant','dependency','coordination'])('rejects edge-only or hold-only changes without timestamp changes: %s', async kind => {
    await seedIssue();
    const token = await adoption();
    const timestamps=await fx.admin`SELECT feature_id,updated_ts,taken_at::text FROM harness_shared.work_items
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND feature_id IN (${ID},${CHILD}) ORDER BY feature_id`;
    if (kind === 'row') await fx.admin`UPDATE harness_shared.work_items SET summary='changed' WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND feature_id=${ID}`;
    if (kind === 'hold') await fx.admin`UPDATE harness_shared.work_items SET payload=payload||'{"claim_hold_reason":"changed"}'::jsonb WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND feature_id=${ID}`;
    if (kind === 'descendant') await fx.admin`UPDATE harness_shared.work_items SET payload='{"reservation":"changed"}'::jsonb WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND feature_id=${CHILD}`;
    if (kind === 'dependency') await fx.admin`INSERT INTO harness_shared.work_item_deps (workspace_id,blocked_kind,blocked_ref,blocker_kind,blocker_ref)
      VALUES (${DEFAULT_COORD_WORKSPACE},'issue',${ID},'issue',${CHILD})`;
    if (kind === 'coordination') await fx.admin`INSERT INTO harness_shared.coord_links (workspace_id,src_kind,src_ref,dst_kind,dst_ref,rel)
      VALUES (${DEFAULT_COORD_WORKSPACE},'issue',${ID},'issue',${CHILD},'relates')`;
    expect(await fx.admin`SELECT feature_id,updated_ts,taken_at::text FROM harness_shared.work_items
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND feature_id IN (${ID},${CHILD}) ORDER BY feature_id`).toEqual(timestamps);
    const fresh = await adoption();
    expect(fresh.expectedAdoptionFingerprint).not.toBe(token.expectedAdoptionFingerprint);
    const before = await snapshot();
    expect(data(await add({ adoptExistingWorkItem: token })).results[0]).toMatchObject({ ok: false, error: 'adoption_snapshot_stale' });
    expect(await snapshot()).toEqual(before);
  });
  it.each(['foreign-holder','terminal','parent','observation','underscore-observation','binding','plan-version','plan-hash'])('refuses invalid adoption atomically: %s', async kind => {
    await seedIssue();
    if (kind === 'foreign-holder') await fx.admin`UPDATE harness_shared.work_items SET taken_by='other' WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND feature_id=${ID}`;
    if (kind === 'terminal') await fx.admin`UPDATE harness_shared.work_items SET status='resolved' WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND feature_id=${ID}`;
    if (kind === 'parent') await fx.admin`UPDATE harness_shared.work_items SET parent_id=${(await readPlanLineNodes(fx.admin,{workspaceId:WS,harnessSlug:HARNESS,slug:SLUG}))[0].featureId} WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND feature_id=${ID}`;
    if (kind === 'observation' || kind === 'underscore-observation') await fx.admin`UPDATE harness_shared.work_items SET payload=payload||${JSON.stringify({[kind === 'observation' ? 'lane' : '_lane']:'observation'})}::text::jsonb WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND feature_id=${ID}`;
    if (kind === 'binding') await fx.admin`UPDATE harness_shared.work_items SET plan_slug='another',plan_line_id='P-999' WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND feature_id=${ID}`;
    const token = await adoption();
    if (kind === 'plan-version') token.expectedPlanVersion++;
    if (kind === 'plan-hash') token.expectedPlanHash='0'.repeat(64);
    const before = await snapshot();
    expect(data(await add({ adoptExistingWorkItem: token })).results[0].ok).toBe(false);
    expect(await snapshot()).toEqual(before);
  });
  it('keeps bulk adoption per-item and refuses a spent token independently', async () => {
    await seedIssue();
    const token=await adoption();
    const args={slug:SLUG,harness:HARNESS,phase:'Phase 1 — Work',importance:'normal',items:[
      {text:'Adopt',adoptExistingWorkItem:token},{text:'Spent snapshot',adoptExistingWorkItem:token},{text:'Ordinary'}]};
    expect(addTool.args.safeParse({...args,adoptExistingWorkItem:token}).success).toBe(false);
    const result=data(await addTool.handler(addTool.args.parse(args),ctx()));
    expect(result.results.map((r: {ok:boolean})=>r.ok)).toEqual([true,false,true]);
    expect(result.results[1].error).toBe('adoption_plan_stale');
    const [original]=await fx.admin`SELECT feature_id FROM harness_shared.work_items WHERE workspace_id=${WS}
      AND harness_slug=${HARNESS} AND plan_slug=${SLUG} AND plan_line_id=${result.results[0].itemId}`;
    expect(original.feature_id).toBe(ID);
  });
  it('admits one concurrent same-row adoption without minting a competing node',async()=>{
    await seedIssue();
    const token=await adoption();
    const results=await Promise.all([add({adoptExistingWorkItem:token}),add({adoptExistingWorkItem:token})]);
    expect(results.map(r=>data(r).results[0].ok).sort()).toEqual([false,true]);
    const rows=await fx.admin`SELECT feature_id FROM harness_shared.work_items WHERE workspace_id=${WS}
      AND harness_slug=${HARNESS} AND plan_slug=${SLUG} AND plan_line_id<>'P-001'`;
    expect([...rows]).toEqual([{feature_id:ID}]);
  });
  it('rechecks the complete fingerprint on serialization retry',async()=>{
    await seedIssue();
    const token=await adoption();
    const before=await snapshot();
    const original=workItems.readWorkItemAdoptionProjectionInTransaction;
    let attempts=0;
    const projection=vi.spyOn(workItems,'readWorkItemAdoptionProjectionInTransaction').mockImplementation(async(tx,scope,lock)=>{
      attempts++;
      const [isolation]=await tx`SHOW transaction_isolation`;
      expect(isolation.transaction_isolation).toBe('serializable');
      const [held]=await tx`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted) AS held`;
      expect(held.held).toBe(true);
      expect(lock).toBe(true);
      if(attempts===2)await fx.admin`UPDATE harness_shared.work_items SET payload=payload||'{"retryHold":"new"}'::jsonb
        WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND feature_id=${ID}`;
      return original(tx,scope,lock);
    });
    vi.spyOn(anchorStore,'writePlanItemAnchors').mockImplementationOnce(async()=>{
      throw Object.assign(new Error('controlled serialization conflict after candidate writes'),{code:'40001'});
    });
    try {
      expect(data(await add({adoptExistingWorkItem:token,anchors:[]})).results[0])
        .toMatchObject({ok:false,error:'adoption_snapshot_stale'});
      expect(attempts).toBeGreaterThanOrEqual(2);
      const after=await snapshot();
      expect({...after,rows:undefined}).toEqual({...before,rows:undefined});
      const [row]=await fx.admin`SELECT plan_slug,payload FROM harness_shared.work_items WHERE workspace_id=${WS}
        AND harness_slug=${HARNESS} AND feature_id=${ID}`;
      expect(row).toMatchObject({plan_slug:null,payload:{retryHold:'new'}});
    } finally {projection.mockRestore();}
  });
  it.each(['nodes','edges'])('refuses complete-set overflow without a partial fingerprint: %s',async kind=>{
    await seedIssue();
    if(kind==='nodes')await fx.admin`INSERT INTO harness_shared.work_items
      (workspace_id,harness_slug,feature_id,item_kind,title,status,parent_id,payload)
      SELECT ${WS},${HARNESS},'WI-overflow-'||g,'task','Overflow child','open',${ID},'{}'::jsonb FROM generate_series(1,255) g`;
    else await fx.admin`INSERT INTO harness_shared.coord_links (workspace_id,src_kind,src_ref,dst_kind,dst_ref,rel)
      SELECT ${DEFAULT_COORD_WORKSPACE},'issue',${ID},'issue',${CHILD},'overflow-'||g FROM generate_series(1,2049) g`;
    const before=await snapshot();
    const result=data(await workItemGetTool.handler(workItemGetTool.args.parse({id:ID,harness:HARNESS,adoptionSnapshot:true}),ctx())).results[0];
    expect(result).toMatchObject({ok:false,error:'adoption_snapshot_too_large'});
    expect(result.adoptionSnapshot).toBeUndefined();
    expect(await snapshot()).toEqual(before);
  });
  it.each(['self','cycle'])('rolls back adoption and its strict revision on invalid DAG admission: %s',async kind=>{
    await seedIssue();
    if(kind==='cycle') {
      const [node]=await readPlanLineNodes(fx.admin,{workspaceId:WS,harnessSlug:HARNESS,slug:SLUG});
      await fx.admin`INSERT INTO harness_shared.work_item_deps(workspace_id,blocked_kind,blocked_ref,blocker_kind,blocker_ref)
        VALUES(${DEFAULT_COORD_WORKSPACE},'feature',${HARNESS+'#'+node.featureId},'issue',${ID})`;
    }
    const token=await adoption();
    const before=await snapshot();
    expect(data(await add({adoptExistingWorkItem:token,blockedBy:[kind==='self'?'P-002':'P-001']})).results[0].ok).toBe(false);
    expect(await snapshot()).toEqual(before);
  });
  it('refuses foreign private scope and unauthenticated snapshot requests without exposing a token',async()=>{
    await seedIssue();
    const before=await snapshot();
    for(const unauthenticated of [false,true]) {
      const context={signal:new AbortController().signal,role:'su',workspaceId:unauthenticated?WS:'another-workspace',
        log:()=>{},progress:()=>{},metadata:()=>{},
        principal:unauthenticated?undefined:{kind:'agent',slug:'agent-anchor-test',workspaceId:WS}} as never;
      const result=data(await workItemGetTool.handler(workItemGetTool.args.parse({id:ID,harness:HARNESS,adoptionSnapshot:true}),context)).results[0];
      expect(result.ok).toBe(false);expect(result.adoptionSnapshot).toBeUndefined();
    }
    expect(await snapshot()).toEqual(before);
  });
});
async function clearFixtureWorkItems() {
  const items = await fx.admin<{ feature_id: string }[]>`SELECT feature_id FROM harness_shared.work_items
    WHERE workspace_id=${WS} AND harness_slug=${HARNESS}`;
  const endpoints = items.map(({ feature_id }) => `${HARNESS}#${feature_id}`);
  const allRefs=[...endpoints,...items.map(row=>row.feature_id)];
  if (endpoints.length) {
    await fx.admin`DELETE FROM harness_shared.work_item_deps WHERE workspace_id=${DEFAULT_COORD_WORKSPACE}
      AND (blocked_ref=ANY(${allRefs}::text[]) OR blocker_ref=ANY(${allRefs}::text[]))`;
    await fx.admin`DELETE FROM harness_shared.coord_links WHERE workspace_id=${DEFAULT_COORD_WORKSPACE}
      AND (src_ref=ANY(${allRefs}::text[]) OR dst_ref=ANY(${allRefs}::text[]))`;
  }
  await fx.admin`DELETE FROM harness_shared.work_items WHERE workspace_id=${WS} AND harness_slug=${HARNESS}`;
}

describe('bounded saved-line graph reconciliation', () => {
  const scope = { workspaceId: WS, harnessSlug: HARNESS, slug: SLUG };
  const lineId = (n: number) => `P-${String(n).padStart(3, '0')}`;
  async function prepare(extra = 'todo', blocker = 'P-001', terminalExisting = false, options: {
    prose?: string;
    incoming?: { id: string; oldBlockers: string[]; addedBlocker: string };
  } = {}) {
    const lines = Array.from({ length: 26 }, (_, i) => `- **${lineId(i + 1)}** \`${i < 22 ? (i === 2 && terminalExisting ? 'done' : 'todo') : extra}\` Saved item ${i + 1}${i >= 22 ? ` blocked-by: ${i === 22 ? blocker : lineId(i)}` : ''}`);
    const incoming = options.incoming;
    const originalLines = lines.map((line, i) => incoming?.id === lineId(i + 1) && incoming.oldBlockers.length
      ? `${line} blocked-by: ${incoming.oldBlockers.join(', ')}` : line);
    const savedLines = originalLines.map((line, i) => {
      const savedLine = line.replaceAll('P-026', incoming?.addedBlocker ?? 'P-026');
      return incoming?.id === lineId(i + 1)
        ? `${savedLine}${incoming.oldBlockers.length ? ', ' : ' blocked-by: '}${incoming.addedBlocker}`
        : savedLine;
    });
    const original = body().replace('- **P-001** `todo` Existing item', originalLines.slice(0, 22).join('\n'));
    const saved = body().replace('- **P-001** `todo` Existing item', savedLines.join('\n')) + (options.prose ?? '');
    await withWorkItemDependencyAdmissionTransaction(fx.admin, async tx => {
      const mutations = await writePlanLineNodes(tx, scope, await readPlanLineNodes(tx, scope), deriveIndexFromContent(original).items);
      await mutateWorkItemDependenciesInTransaction(tx, { workspaceId: DEFAULT_COORD_WORKSPACE, itemWorkspaceId: WS, mutations });
    });
    await fx.admin`UPDATE harness_shared.work_items SET taken_by='retained-holder',
      payload=payload || '{"retainedClaim":{"proof":"unchanged"}}'::jsonb
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG} AND plan_line_id='P-002'`;
    if (terminalExisting) await fx.admin`UPDATE harness_shared.work_items SET terminal_owner='retained-completer',
      terminal_completion_ref='fixture:retained-completion', authority='committed',closed_ts=${Date.now()},
      payload=payload || '{"_completionEvidence":{"summary":"retained fixture evidence"}}'::jsonb
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG} AND plan_line_id='P-003'`;
    // Like the actual Frontier case, saved todo predates a canonical hold.
    await fx.admin`UPDATE harness_shared.work_items SET status='blocked'
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG} AND plan_line_id='P-004'`;
    await fx.admin`UPDATE harness_shared.harness_plans SET content=${saved},content_hash=${hashPlanContent(saved)},
      items=${JSON.stringify(deriveIndexFromContent(saved).items)}::text::jsonb
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG}`;
    const [first] = await readPlanLineNodes(fx.admin, scope);
    // A separate plan is an external edge endpoint, not a missing saved line.
    const producer = { ...scope, slug: `${SLUG}-external` };
    await seedPlan(fx.admin, WS, HARNESS, producer.slug, body());
    await fx.admin.begin(tx => writePlanLineNodes(tx as never, producer, [], deriveIndexFromContent(body()).items));
    const [external] = await readPlanLineNodes(fx.admin, producer);
    await fx.admin`INSERT INTO harness_shared.work_item_deps
      (workspace_id,blocked_kind,blocked_ref,blocker_kind,blocker_ref,created_by,satisfaction)
      VALUES (${DEFAULT_COORD_WORKSPACE},'feature',${`${HARNESS}#${first.featureId}`},
        'feature',${`${HARNESS}#${external.featureId}`},'saved-lines-test','success')`;
    await fx.admin`INSERT INTO harness_shared.coord_links (workspace_id,src_kind,src_ref,dst_kind,dst_ref,rel)
      VALUES (${DEFAULT_COORD_WORKSPACE},'feature',${`${HARNESS}#${first.featureId}`},
        'feature',${`${HARNESS}#${external.featureId}`},'relates')`;
    const [parent] = await fx.admin`SELECT version FROM harness_shared.harness_plans
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG}`;
    return { ...scope, expectedVersion: Number(parent.version), expectedContentHash: hashPlanContent(saved) };
  }
  async function retained() {
    return {
      rows: [...await fx.admin`SELECT jsonb_build_object('row',to_jsonb(w),'xmin',w.xmin::text)::text AS record
        FROM harness_shared.work_items w WHERE w.workspace_id=${WS} AND w.harness_slug=${HARNESS}
          AND w.plan_slug=${SLUG} AND w.plan_line_id < 'P-023' ORDER BY w.plan_line_id`],
      deps: [...await fx.admin`SELECT jsonb_build_object('row',to_jsonb(d),'xmin',d.xmin::text)::text AS record
        FROM harness_shared.work_item_deps d WHERE d.workspace_id=${DEFAULT_COORD_WORKSPACE}
          AND d.created_by='saved-lines-test' ORDER BY d.id`],
      links: [...await fx.admin`SELECT jsonb_build_object('row',to_jsonb(l),'xmin',l.xmin::text)::text AS record
        FROM harness_shared.coord_links l WHERE l.workspace_id=${DEFAULT_COORD_WORKSPACE}
          AND l.src_ref LIKE ${`${HARNESS}#%`} ORDER BY l.id`],
    };
  }
  async function census() {
    return [...await fx.admin`SELECT to_jsonb(w)::text AS record FROM harness_shared.work_items w
      WHERE w.workspace_id=${WS} AND w.harness_slug=${HARNESS} ORDER BY w.feature_id`];
  }
  it('previews without mutation, preserves 22 complete rows and external edges, adds four parked lines, and is idempotent', async () => {
    const input = await prepare('todo', 'P-001', true);
    const prior = await retained();
    const all = await census();
    const preview = await repairSavedPlanLines(fx.admin, { ...input, dryRun: true });
    expect(preview.missingItems.map(item => item.id)).toEqual(['P-023', 'P-024', 'P-025', 'P-026']);
    expect(preview.representedRows).toHaveLength(22);
    expect(preview.representedRows.join('\n')).toContain('retained fixture evidence');
    expect(await census()).toEqual(all);
    expect(await retained()).toEqual(prior);
    const result = await repairSavedPlanLines(fx.admin, { ...input, dryRun: false, preview: preview.preview });
    expect(result).toMatchObject({ nodesAdded: 4, edgesWritten: 4 });
    expect(await retained()).toEqual(prior);
    const after = await readPlanLineNodes(fx.admin, scope);
    expect(after).toHaveLength(26);
    expect(after.slice(22).map(({ featureId, kind, planSlug, ...item }) => item))
      .toEqual(preview.missingItems.map(item => ({ ...item, deliverable: item.deliverable ?? null })));
    const added = await fx.admin`SELECT status,taken_by,payload FROM harness_shared.work_items
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG} AND plan_line_id >= 'P-023'`;
    expect(added).toHaveLength(4);
    for (const row of added) expect(row).toMatchObject({ status: 'open', taken_by: null,
      payload: { _claimHold: true, claim_hold_by: 'migration:plan-line-work-item-nodes' } });
    const settled = await census();
    expect(await repairSavedPlanLines(fx.admin, { ...input, dryRun: false, preview: preview.preview }))
      .toMatchObject({ alreadyReconciled: true, nodesAdded: 0, edgesWritten: 0 });
    expect(await census()).toEqual(settled);
    expect(data(await editTool.handler({ slug: SLUG, harness: HARNESS, old_string: 'Check links.',
      new_string: 'Graph reconciliation retained all tasks.' } as never, ctx())).ok).toBe(true);
  });
  it('repairs whitespace-only represented edits while preserving canonical row bytes', async () => {
    const input = await prepare('todo', 'P-001', true);
    const before = await readPlanLineNodes(fx.admin, scope);
    const cosmetic = before.map(item => item.id === 'P-002'
      ? { ...item, text: item.text.replace('Saved item', 'Saved   item') } : item);
    await withWorkItemDependencyAdmissionTransaction(fx.admin, async tx => {
      const mutations = await writePlanLineNodes(tx, scope, before, cosmetic);
      expect(mutations).toEqual([]);
    });
    expect((await readPlanLineNodes(fx.admin, scope)).find(item => item.id === 'P-002')?.text)
      .toBe(before.find(item => item.id === 'P-002')?.text);
    const [parent] = await fx.admin`SELECT content FROM harness_shared.harness_plans
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG}`;
    const content = parent.content.replace('Saved item 2\n', 'Saved   item 2\n');
    input.expectedContentHash = hashPlanContent(content);
    await fx.admin`UPDATE harness_shared.harness_plans SET content=${content},content_hash=${input.expectedContentHash},
      items=${JSON.stringify(deriveIndexFromContent(content).items)}::text::jsonb
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG}`;
    const prior = await retained();
    const all = await census();
    const savedLines = { slug: SLUG, expectedVersion: input.expectedVersion, expectedContentHash: input.expectedContentHash };
    const callPublic = (dryRun: boolean, preview?: SavedPlanLinesPreview) => backfillDependencyEdgesTool.handler(
      backfillDependencyEdgesTool.args.parse({ harness: HARNESS, dryRun, savedLines: { ...savedLines, preview } }), ctx());
    const { preview } = data(await callPublic(true)) as Awaited<ReturnType<typeof repairSavedPlanLines>>;
    expect(await census()).toEqual(all);
    expect(data(await callPublic(false, preview))).toMatchObject({ nodesAdded: 4, edgesWritten: 4 });
    expect(await retained()).toEqual(prior);
    expect(data(await callPublic(false, preview)))
      .toMatchObject({ alreadyReconciled: true, nodesAdded: 0, edgesWritten: 0 });
    expect(await retained()).toEqual(prior);
  });
  it.each([
    { label: 'Frontier P-017 to P-026', id: 'P-017', oldBlockers: ['P-014', 'P-016'], addedBlocker: 'P-026',
      prose: '\n### D-031 — placement\n1. P-007 placement. Asked: a new partition or bounded existing storage.' },
    { label: 'durable continuation P-006 to P-041', id: 'P-006', oldBlockers: ['P-005'], addedBlocker: 'P-041',
      prose: '\n### D-027 — acceptance\n1. P-006 is accepted on two pieces of evidence...' },
  ])('repairs $label with decision prose while preserving the existing subgraph', async ({ prose, label, ...incoming }) => {
    const input = await prepare('todo', 'P-001', true, { incoming, prose });
    const prior = await retained();
    const existingEdges = [...await fx.admin`SELECT d.id::text AS id,
      jsonb_build_object('row',to_jsonb(d),'xmin',d.xmin::text)::text AS record
      FROM harness_shared.work_item_deps d WHERE d.workspace_id=${DEFAULT_COORD_WORKSPACE}
        AND d.created_by=${`plan-dependency:${HARNESS}/${SLUG}`} ORDER BY d.id`];
    expect(existingEdges).toHaveLength(incoming.oldBlockers.length);
    const all = await census();
    const savedLines = { slug: SLUG, expectedVersion: input.expectedVersion, expectedContentHash: input.expectedContentHash };
    const callPublic = (dryRun: boolean, preview?: SavedPlanLinesPreview) => backfillDependencyEdgesTool.handler(
      backfillDependencyEdgesTool.args.parse({ harness: HARNESS, dryRun, savedLines: { ...savedLines, preview } }), ctx());
    const { preview, missingItems } = data(await callPublic(true)) as Awaited<ReturnType<typeof repairSavedPlanLines>>;
    expect(missingItems).toHaveLength(4);
    expect(missingItems.map(item => item.id)).toContain(incoming.addedBlocker);
    expect(await census()).toEqual(all);
    expect(data(await callPublic(false, preview)))
      .toMatchObject({ nodesAdded: 4, edgesWritten: 5 });
    expect(await retained()).toEqual(prior);
    const preservedEdges = [...await fx.admin`SELECT d.id::text AS id,
      jsonb_build_object('row',to_jsonb(d),'xmin',d.xmin::text)::text AS record
      FROM harness_shared.work_item_deps d WHERE d.workspace_id=${DEFAULT_COORD_WORKSPACE}
        AND d.id::text=ANY(${existingEdges.map(edge => edge.id)}::text[]) ORDER BY d.id`];
    expect(preservedEdges).toEqual(existingEdges);
    expect((await readPlanLineNodes(fx.admin, scope)).find(node => node.id === incoming.id)?.blockedBy)
      .toEqual([...incoming.oldBlockers, incoming.addedBlocker]);
    const settled = await census();
    expect(data(await callPublic(false, preview)))
      .toMatchObject({ alreadyReconciled: true, nodesAdded: 0, edgesWritten: 0 });
    expect(await census()).toEqual(settled);
  });
  it.each(['add', 'remove'])('refuses an existing-to-existing blocker %s during additive repair', async kind => {
    const input = await prepare('todo', 'P-001', true, {
      incoming: { id: 'P-017', oldBlockers: ['P-014', 'P-016'], addedBlocker: 'P-026' },
    });
    const [parent] = await fx.admin`SELECT content FROM harness_shared.harness_plans
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG}`;
    const content = parent.content.replace('blocked-by: P-014, P-016, P-026', kind === 'add'
      ? 'blocked-by: P-014, P-016, P-001, P-026' : 'blocked-by: P-014, P-026');
    input.expectedContentHash = hashPlanContent(content);
    await fx.admin`UPDATE harness_shared.harness_plans SET content=${content},content_hash=${input.expectedContentHash},
      items=${JSON.stringify(deriveIndexFromContent(content).items)}::text::jsonb
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG}`;
    const prior = await census();
    const graph = await readPlanLineNodes(fx.admin, scope);
    await expect(repairSavedPlanLines(fx.admin, { ...input, dryRun: true })).rejects.toThrow('saved_plan_lines_not_additive');
    expect(await census()).toEqual(prior);
    expect(await readPlanLineNodes(fx.admin, scope)).toEqual(graph);
  });
  it('rolls back an existing-to-new cycle without changing represented rows or edges', async () => {
    const input = await prepare('todo', 'P-017', true, {
      incoming: { id: 'P-017', oldBlockers: ['P-014', 'P-016'], addedBlocker: 'P-026' },
    });
    const prior = await census();
    const graph = await readPlanLineNodes(fx.admin, scope);
    const { preview } = await repairSavedPlanLines(fx.admin, { ...input, dryRun: true });
    await expect(repairSavedPlanLines(fx.admin, { ...input, dryRun: false, preview })).rejects.toThrow();
    expect(await census()).toEqual(prior);
    expect(await readPlanLineNodes(fx.admin, scope)).toEqual(graph);
  });
  it('rejects a stale incoming-edge preview after an existing dependency changes', async () => {
    const input = await prepare('todo', 'P-001', true, {
      incoming: { id: 'P-017', oldBlockers: ['P-014', 'P-016'], addedBlocker: 'P-026' },
    });
    const { preview } = await repairSavedPlanLines(fx.admin, { ...input, dryRun: true });
    await fx.admin`UPDATE harness_shared.work_item_deps SET satisfaction='success'
      WHERE workspace_id=${DEFAULT_COORD_WORKSPACE} AND created_by=${`plan-dependency:${HARNESS}/${SLUG}`}`;
    const prior = await census();
    const graph = await readPlanLineNodes(fx.admin, scope);
    await expect(repairSavedPlanLines(fx.admin, { ...input, dryRun: false, preview })).rejects.toThrow('saved_plan_lines_preview_changed');
    expect(await census()).toEqual(prior);
    expect(await readPlanLineNodes(fx.admin, scope)).toEqual(graph);
  });

  it.each(['claim', 'hold', 'state', 'completion', 'dependency', 'link'])('rejects a real apply after concurrent %s changes without adding rows', async kind => {
    const input = await prepare('todo', 'P-001', true);
    const { preview } = await repairSavedPlanLines(fx.admin, { ...input, dryRun: true });
    if (kind === 'claim') await fx.admin`UPDATE harness_shared.work_items SET taken_by='other-holder'
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG} AND plan_line_id='P-002'`;
    if (kind === 'hold') await fx.admin`UPDATE harness_shared.work_items SET payload=payload || '{"newHold":true}'::jsonb
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG} AND plan_line_id='P-002'`;
    if (kind === 'state') await fx.admin`UPDATE harness_shared.work_items SET status='blocked'
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG} AND plan_line_id='P-002'`;
    if (kind === 'completion') await fx.admin`UPDATE harness_shared.work_items SET terminal_completion_ref='fixture:changed-completion'
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG} AND plan_line_id='P-003'`;
    if (kind === 'dependency') await fx.admin`UPDATE harness_shared.work_item_deps SET satisfaction='settled'
      WHERE workspace_id=${DEFAULT_COORD_WORKSPACE} AND created_by='saved-lines-test'`;
    if (kind === 'link') await fx.admin`UPDATE harness_shared.coord_links SET rel='changed'
      WHERE workspace_id=${DEFAULT_COORD_WORKSPACE} AND src_ref LIKE ${`${HARNESS}#%`}`;
    const before = await census();
    const edges = await retained();
    await expect(repairSavedPlanLines(fx.admin, { ...input, dryRun: false, preview })).rejects.toThrow(/saved_plan_lines_(preview_changed|not_additive)/);
    expect(await census()).toEqual(before);
    expect(await retained()).toEqual(edges);
  });
  it.each(['node', 'edge'])('rolls back the complete repair after the first inserted %s fails', async kind => {
    const input = await prepare();
    const { preview } = await repairSavedPlanLines(fx.admin, { ...input, dryRun: true });
    const all = await census();
    const prior = await retained();
    const table = kind === 'node' ? 'work_items' : 'work_item_deps';
    const condition = kind === 'node'
      ? `NEW.harness_slug='${HARNESS}' AND NEW.plan_slug='${SLUG}' AND NEW.plan_line_id='P-023'`
      : `NEW.created_by='plan-dependency:${HARNESS}/${SLUG}'`;
    await fx.admin.unsafe(`CREATE FUNCTION harness_shared.reject_saved_line_repair() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN IF ${condition} THEN RAISE EXCEPTION 'saved-line ${kind} rollback injection'; END IF; RETURN NEW; END $fn$;
      CREATE TRIGGER reject_saved_line_repair AFTER INSERT ON harness_shared.${table}
        FOR EACH ROW EXECUTE FUNCTION harness_shared.reject_saved_line_repair()`);
    try {
      await expect(repairSavedPlanLines(fx.admin, { ...input, dryRun: false, preview })).rejects.toThrow(`saved-line ${kind} rollback injection`);
      expect(await census()).toEqual(all);
      expect(await retained()).toEqual(prior);
    } finally {
      await fx.admin.unsafe(`DROP TRIGGER reject_saved_line_repair ON harness_shared.${table}; DROP FUNCTION harness_shared.reject_saved_line_repair()`);
    }
  });
  it.each(['wip', 'done', 'blocked', 'needs-human', 'unrecognized'])('refuses a saved missing %s state', async state => {
    const input = await prepare(state);
    const prior = await census();
    await expect(repairSavedPlanLines(fx.admin, { ...input, dryRun: true })).rejects.toThrow('saved_plan_lines_not_additive');
    expect(await census()).toEqual(prior);
  });
  it.each(['parent', 'witness', 'text', 'sequence', 'expired'])('refuses changed %s without mutation', async kind => {
    const input = await prepare();
    const { preview } = await repairSavedPlanLines(fx.admin, { ...input, dryRun: true });
    if (kind === 'parent') await fx.admin`UPDATE harness_shared.harness_plans SET version=version+1
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG}`;
    if (kind === 'witness') await fx.admin`UPDATE harness_shared.harness_plans SET items='[]'::jsonb
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG}`;
    if (kind === 'text') await fx.admin`UPDATE harness_shared.work_items SET plan_line_text='Changed represented meaning'
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG} AND plan_line_id='P-002'`;
    if (kind === 'sequence') await fx.admin`UPDATE harness_shared.work_items SET plan_seq=100
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG} AND plan_line_id='P-022'`;
    if (kind === 'expired') preview.issuedAt = new Date(Date.now() - 300_001).toISOString();
    const prior = await census();
    await expect(repairSavedPlanLines(fx.admin, { ...input, dryRun: false, preview })).rejects.toThrow(/saved_plan_lines_/);
    expect(await census()).toEqual(prior);
  });
  it('refuses dangling blockers and a cycle without leaving partial nodes', async () => {
    for (const blocker of ['P-099', 'P-026']) {
      await clearFixtureWorkItems();
      await cleanupPlans(fx.admin, WS, HARNESS);
      await seedPlan(fx.admin, WS, HARNESS, SLUG, body());
      const input = await prepare('todo', blocker);
      const prior = await census();
      if (blocker === 'P-099') await expect(repairSavedPlanLines(fx.admin, { ...input, dryRun: true })).rejects.toThrow('saved_plan_lines_not_additive');
      else {
        const { preview } = await repairSavedPlanLines(fx.admin, { ...input, dryRun: true });
        await expect(repairSavedPlanLines(fx.admin, { ...input, dryRun: false, preview })).rejects.toThrow();
      }
      expect(await census()).toEqual(prior);
    }
  });
  it('keeps the ordinary edge-only handler separate and requires an exact saved-line scope', async () => {
    const ordinary = data(await backfillDependencyEdgesTool.handler({ harness: HARNESS, dryRun: true, planSlugs: [] } as never, ctx()));
    expect(ordinary).toMatchObject({ dryRun: true, plansScanned: 0 });
    expect(ordinary).not.toHaveProperty('nodesAdded');
    const input = await prepare();
    const request = { slug: SLUG, expectedVersion: input.expectedVersion, expectedContentHash: input.expectedContentHash };
    const preview = data(await backfillDependencyEdgesTool.handler({ harness: HARNESS, savedLines: request } as never, ctx()));
    expect(preview).toMatchObject({ dryRun: true, nodesAdded: 0 });
    await expect(backfillDependencyEdgesTool.handler({ harness: HARNESS, savedLines: request, planSlugs: [] } as never, ctx())).rejects.toThrow('saved_plan_lines_single_scope_required');
  });
});
beforeAll(async () => {
  fx = await setupPlanPgFixture({ isolated: true });
  // The draft is deliberately not armed until these isolated real-PG tests pass.
  const migration = join(harnessRoot(), '../../libs/db/sql/1559-plan-item-code-anchors.sql');
  const ddl = await readFile(migration, 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return readFile(migration + '.DRAFT', 'utf8');
    throw error;
  });
  await fx.admin.unsafe(ddl);
  const intentDdl = await readFile(new URL('../../../../../libs/papercusp/libs/db/sql/1610-plan-anchor-change-intent.sql', import.meta.url), 'utf8');
  await fx.admin.unsafe(intentDdl);
  await fx.admin.unsafe(intentDdl);
  fixture.root = await mkdtemp(join(tmpdir(), 'plan-anchor-handler-'));
  await writeFile(join(fixture.root, 'code.ts'), source);
  const caller = "import { linked } from './code';\nlinked();\n";
  await writeFile(join(fixture.root, 'flow.test.ts'), caller);
  const files: Record<string, string> = { 'code.ts': source, 'flow.test.ts': caller };
  const paths = Object.keys(files);
  const symbols = buildSymbolSnapshot({ files: paths, readSource: path => files[path] ?? null,
    resolveModule: (path, specifier) => relativeSymbolModule(path, specifier, new Set(paths)) });
  fixture.snapshot = parsePushSnapshot(JSON.stringify({ schema: 'graph-dependency-snapshot-v1',
    index: { backend: 'first-party-imports', lastCommit: 'd'.repeat(40) }, generatedAt: new Date().toISOString(),
    edges: [{ importer: 'flow.test.ts', imported: 'code.ts',
      importerSha256: createHash('sha256').update(caller).digest('hex') }], symbols }));
  expect(fixture.snapshot?.symbols?.get('linked')).toHaveLength(1);
}, 180_000);
beforeEach(async () => {
  vi.restoreAllMocks();
  await fx.admin`DELETE FROM harness_shared.plan_item_anchors WHERE workspace_id=${WS} AND harness_slug=${HARNESS}`;
  await clearFixtureWorkItems();
  await cleanupPlans(fx.admin, WS, HARNESS);
  await seedPlan(fx.admin, WS, HARNESS, SLUG, body());
  const scope = { workspaceId: WS, harnessSlug: HARNESS, slug: SLUG };
  const index = deriveIndexFromContent(body());
  await fx.admin.begin(async tx => {
    await writePlanLineNodes(tx as never, scope, [], index.items);
    await writePlanIndexRows(tx as unknown as Parameters<typeof writePlanIndexRows>[0], { ...scope, planSlug: SLUG }, index);
  });
  expect((await readPlanLineNodes(fx.admin, scope)).map(item => item.id)).toEqual(['P-001']);
});
afterAll(async () => {
  if (fx) {
    await fx.admin`DELETE FROM harness_shared.plan_item_anchors WHERE workspace_id=${WS} AND harness_slug=${HARNESS}`;
    await clearFixtureWorkItems();
    await cleanupPlans(fx.admin, WS, HARNESS);
    await fx.dispose();
  }
  if (fixture.root) await rm(fixture.root, { recursive: true, force: true });
});

describe('plan item anchors through the real plan tools', () => {
  const change = { action: 'modify' as const, summary: 'Persist recovery state', reason: 'Prevent lost work' };
  async function executable(status = 'active', suffix = '') {
    const before = await readPlanLineNodes(fx.admin, { workspaceId: WS, harnessSlug: HARNESS, slug: SLUG });
    // The writer's preimage is canonical nodes with durable featureId, never
    // a parsed index or an empty array for an already materialized plan.
    expect(before.map(item => item.id)).toEqual(['P-001']);
    expect(before.every(item => Boolean(item.featureId))).toBe(true);
    const content = body().replace('status: draft', `status: ${status}`).replace('Existing item', `Existing item${suffix}`);
    const index = deriveIndexFromContent(content);
    await fx.admin`UPDATE harness_shared.harness_plans SET content=${content}, content_hash=${hashPlanContent(content)},
      status=${status}, verification_profile='coding', op_status=NULL
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG}`;
    await fx.admin.begin(async tx => {
      await writePlanLineNodes(tx as never, { workspaceId: WS, harnessSlug: HARNESS, slug: SLUG }, before, index.items);
      await writePlanIndexRows(tx as never, { workspaceId: WS, harnessSlug: HARNESS, planSlug: SLUG }, index);
    });
  }
  async function storeAnchors(inputs: Parameters<typeof resolvePlanItemAnchors>[0]) {
    const anchors = await resolvePlanItemAnchors(inputs, { root: fixture.root, snapshot: fixture.snapshot, budgetMs: 5000 });
    await fx.admin.begin(tx => anchorStore.writePlanItemAnchors(tx, {
      workspaceId: WS, harnessSlug: HARNESS, planSlug: SLUG }, { itemId: 'P-001', anchors }, 'agent-anchor-test'));
  }
  async function snapshot() {
    return {
      plans: [...await fx.admin`SELECT content, content_hash, version, status, op_status FROM harness_shared.harness_plans
        WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG}`],
      anchors: await anchorStore.readPlanItemAnchors({ workspaceId: WS, harnessSlug: HARNESS, planSlug: SLUG }),
      items: [...await fx.admin`SELECT * FROM harness_shared.work_items WHERE workspace_id=${WS} AND harness_slug=${HARNESS} ORDER BY feature_id`],
      lines: await readPlanLineNodes(fx.admin, { workspaceId: WS, harnessSlug: HARNESS, slug: SLUG }),
    };
  }
  async function start() {
    // Keep the production start gate, input decision and anchor persistence.
    // These unrelated acceptance/governance decisions are outside this fixture.
    const a = vi.spyOn(lifecycle, 'readAndEvaluateAcceptanceBarLifecycle');
    mockResolvedTyped(a, {
      phase: 'pre-start', applicable: true, satisfied: true, codes: [], blockingBars: [], contractCodes: [],
      codeAttribution: [], staleGradingScorecardId: null, nextRepair: null, message: null,
    });
    const b = vi.spyOn(admission, 'checkPlanAdmission');
    mockResolvedTyped(b, { admitted: true, skipped: 'no-admission-policy' });
    try { return await checkPlanStartable(SLUG, { workspaceId: WS, harnessSlug: HARNESS }); }
    finally { a.mockRestore(); b.mockRestore(); }
  }
  it('refuses absent initial scope at the real start boundary without mutation', async () => {
    await executable('ready');
    const before = await snapshot();
    expect(await start()).toMatchObject({ ok: false, refusal: { code: 'initial_change_scope_missing' } });
    expect(await snapshot()).toEqual(before);
  });
  it('refuses incomplete target action intended change or rationale at the real start boundary without mutation', async () => {
    await executable('ready');
    for (const field of ['target', 'action', 'summary', 'reason']) {
      await storeAnchors([{ path: 'code.ts', change }]);
      const value = field === 'target' ? { ...change } : { ...change, [field]: '' };
      if (field === 'target') await fx.admin`UPDATE harness_shared.plan_item_anchors SET requested='', path=NULL, symbol_name=NULL
        WHERE workspace_id=${WS} AND harness_slug=${HARNESS}`;
      else await fx.admin`UPDATE harness_shared.plan_item_anchors SET change_intent=${JSON.stringify(value)}::text::jsonb
        WHERE workspace_id=${WS} AND harness_slug=${HARNESS}`;
      const before = await snapshot();
      expect(await start(), field).toMatchObject({ ok: false, refusal: { code: 'initial_change_scope_missing' } });
      expect(await snapshot(), field).toEqual(before);
    }
  });
  it('accepts valid scope and non-code planned-create and investigation controls at the real start boundary', async () => {
    await executable('ready');
    for (const anchors of [[{ path: 'code.ts', change }],
      [{ path: 'future.ts', change: { ...change, action: 'create' as const } }],
      [{ symbol: 'unknown', change: { ...change, action: 'investigate' as const } }]]) {
      await storeAnchors(anchors);
      expect(await start()).toMatchObject({ ok: true });
    }
    await executable('ready', ' deliverable: doc');
    await storeAnchors([]);
    expect(await start()).toMatchObject({ ok: true });
  });
  it('refuses an active-plan coding item addition with absent or incomplete initial scope before mutation', async () => {
    await executable();
    for (const anchors of [undefined, [], [{ path: 'code.ts' }]]) {
      const before = await snapshot();
      const result = data(await add({ anchors }));
      expect(result.results[0]).toMatchObject({ ok: false, error: 'initial_change_scope_missing' });
      expect(await snapshot()).toEqual(before);
    }
    // Malformed supplied fields are rejected by the real public tool schema
    // before its handler; missing optional metadata reaches the scope gate above.
    for (const field of ['action', 'summary', 'reason']) {
      const before = await snapshot();
      expect(addTool.args.safeParse({ slug: SLUG, harness: HARNESS, phase: 'Phase 1 — Work', text: 'Added item',
        anchors: [{ path: 'code.ts', change: { ...change, [field]: '' } }] }).success).toBe(false);
      expect(await snapshot()).toEqual(before);
    }
  });
  it('refuses an active-plan edit that removes or invalidates executable initial scope before mutation', async () => {
    await executable();
    await storeAnchors([{ path: 'code.ts', change }]);
    for (const anchors of [[], [{ path: 'code.ts' }]]) {
      const before = await snapshot();
      expect(data(await editTool.handler({ slug: SLUG, harness: HARNESS, itemId: 'P-001', anchors } as never, ctx())))
        .toMatchObject({ ok: false, code: 'initial_change_scope_missing' });
      expect(await snapshot()).toEqual(before);
    }
    for (const field of ['action', 'summary', 'reason']) {
      const before = await snapshot();
      expect(editTool.args.safeParse({ slug: SLUG, harness: HARNESS, itemId: 'P-001',
        anchors: [{ path: 'code.ts', change: { ...change, [field]: '' } }] }).success).toBe(false);
      expect(await snapshot()).toEqual(before);
    }
  });
  it('admits active-plan scoped additions and complete scope evolution with non-code controls', async () => {
    await executable(); // P-001 deliberately retains unrelated legacy missing scope.
    const beforeLegacy = (await snapshot()).lines.find(item => item.id === 'P-001');
    for (const anchors of [[{ path: 'code.ts', change }],
      [{ path: 'future.ts', change: { ...change, action: 'create' } }],
      [{ symbol: 'unknown', change: { ...change, action: 'investigate' } }]]) {
      const result = data(await add({ anchors })).results[0];
      expect(result.ok, JSON.stringify(result)).toBe(true);
      const edited = data(await editTool.handler({ slug: SLUG, harness: HARNESS, itemId: result.itemId,
        anchors: [{ path: 'code.ts', change: { ...change, summary: 'Revised complete scope' } }] } as never, ctx()));
      expect(edited.ok, JSON.stringify(edited)).toBe(true);
    }
    expect(data(await add({ deliverable: 'doc' })).results[0].ok).toBe(true);
    expect((await snapshot()).lines.find(item => item.id === 'P-001')).toEqual(beforeLegacy);
  });
  it('preserves unrelated accepted anchors across concurrent plan rewrites', async () => {
    await storeAnchors([{ path: 'code.ts', change }]);
    const first = (await snapshot()).anchors['P-001'];
    const results = await Promise.all([
      add({ anchors: [{ path: 'future.ts', change: { ...change, action: 'create' } }] }),
      add({ text: 'Independent item', anchors: [{ symbol: 'linked', change }] }),
    ]);
    const added = results.map(result => data(result).results[0]);
    expect(added.every(result => result.ok), JSON.stringify(added)).toBe(true);
    const after = (await snapshot()).anchors;
    expect(after['P-001']).toEqual(first);
    expect(added.map(result => after[result.itemId][0].change)).toEqual([{ ...change, action: 'create' }, change]);
  });
  it('preserves canonical blocked state and an external success dependency across a prose rewrite', async () => {
    const scope = { workspaceId: WS, harnessSlug: HARNESS, slug: SLUG };
    const [node] = await readPlanLineNodes(fx.admin, scope);
    const producerSlug = `${SLUG}-producer`;
    await seedPlan(fx.admin, WS, HARNESS, producerSlug, body());
    await fx.admin.begin(tx => writePlanLineNodes(tx as never, { ...scope, slug: producerSlug }, [],
      deriveIndexFromContent(body()).items));
    const [producer] = await readPlanLineNodes(fx.admin, { ...scope, slug: producerSlug });
    const retainedPayload = { blockerResolution: { evidence: 'external producer must succeed' } };
    await fx.admin`UPDATE harness_shared.work_items SET status='blocked', taken_by='agent-anchor-test',
      payload=${JSON.stringify(retainedPayload)}::text::jsonb
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND feature_id=${node.featureId}`;
    await fx.admin`INSERT INTO harness_shared.work_item_deps
      (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type, created_by, satisfaction)
      VALUES (${DEFAULT_COORD_WORKSPACE}, 'feature', ${`${HARNESS}#${node.featureId}`},
        'feature', ${`${HARNESS}#${producer.featureId}`}, 'blocks', 'anchor-test', 'success')`;
    const read = async () => data(await getTool.handler({ slug: SLUG, harness: HARNESS,
      mode: 'full', includeRaw: true, includeEnrichments: false } as never, ctx())).results[0];
    const preserved = async () => ({
      node: [...await fx.admin`SELECT feature_id,status,taken_by,payload,closed_ts FROM harness_shared.work_items
        WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND feature_id=${node.featureId}`],
      deps: [...await fx.admin`SELECT * FROM harness_shared.work_item_deps
        WHERE workspace_id=${DEFAULT_COORD_WORKSPACE} AND blocked_kind='feature'
          AND blocked_ref=${`${HARNESS}#${node.featureId}`}`],
    });
    const before = await preserved();
    expect(before.deps).toHaveLength(1);
    expect(before.deps[0].satisfaction).toBe('success');
    expect((await readPlanLineNodes(fx.admin, scope))[0]).toMatchObject({ status: 'blocked', blockedBy: [] });
    expect((await read()).items[0]).toMatchObject({ storedStatus: 'blocked', effectiveStatus: 'blocked' });
    const edited = data(await editTool.handler({ slug: SLUG, harness: HARNESS,
      old_string: 'Check links.', new_string: 'Retain the producer gate.' } as never, ctx()));
    expect(edited.ok, JSON.stringify(edited)).toBe(true);
    const after = await read();
    expect(after.items[0]).toMatchObject({ storedStatus: 'blocked', effectiveStatus: 'blocked' });
    expect(after.raw).toContain('`blocked` Existing item');
    expect(await preserved()).toEqual(before);
  });
  it('persists explicit blocked creation and updates, then permits an explicit reopen', async () => {
    const scope = { workspaceId: WS, harnessSlug: HARNESS, slug: SLUG };
    const original = await readPlanLineNodes(fx.admin, scope);
    const desired = [{ ...original[0], status: 'blocked' },
      { ...original[0], id: 'P-002', status: 'blocked', text: 'New explicit gate' }];
    await fx.admin.begin(tx => writePlanLineNodes(tx as never, scope, original, desired));
    const stored = await fx.admin`SELECT plan_line_id,status FROM harness_shared.work_items
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG} ORDER BY plan_seq`;
    expect(stored.map(row => row.status)).toEqual(['blocked', 'blocked']);
    const blocked = await readPlanLineNodes(fx.admin, scope);
    expect(blocked.map(row => row.status)).toEqual(['blocked', 'blocked']);
    // Reopening is an intentional lifecycle projection, not an unrelated edit.
    await fx.admin.begin(tx => writePlanLineNodes(tx as never, scope, blocked,
      blocked.map(row => ({ ...row, status: 'todo' }))));
    expect((await readPlanLineNodes(fx.admin, scope)).map(row => row.status)).toEqual(['todo', 'todo']);
    expect((await fx.admin`SELECT status FROM harness_shared.work_items
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG}`)
      .map(row => row.status)).toEqual(['open', 'open']);
  });
  it.each([
    ['needs-human', 'needs-human'], ['wip', 'wip'], ['done', 'done'], ['resolved', 'done'],
    ['closed', 'done'], ['dropped', 'dropped'], ['superseded', 'dropped'], ['open', 'todo'],
  ])('retains canonical %s projection as %s', async (status, expected) => {
    await fx.admin`UPDATE harness_shared.work_items SET status=${status}
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG}`;
    const [node] = await readPlanLineNodes(fx.admin, { workspaceId: WS, harnessSlug: HARNESS, slug: SLUG });
    expect(node.status).toBe(expected);
  });
  it.each(['prose', 'anchors'] as const)('refuses %s edits before a partial graph can erase a legacy-writer addition', async kind => {
    const legacy = body().replace('\n## Decisions\n', '\n- **P-002** `blocked` Dependent item blocked-by: P-001\n\n## Decisions\n');
    const index = deriveIndexFromContent(legacy);
    // Model an old writer adding a line to both saved bytes and their JSON index
    // after P-001 was already materialized by the graph-aware writer.
    await fx.admin`UPDATE harness_shared.harness_plans
      SET content=${legacy}, content_hash=${hashPlanContent(legacy)}, items=${JSON.stringify(index.items)}::jsonb
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG}`;
    const scope = { workspaceId: WS, harnessSlug: HARNESS, slug: SLUG };
    const nodes = await readPlanLineNodes(fx.admin, scope);
    expect(nodes.map(item => item.id)).toEqual(['P-001']);
    const saved = () => fx.admin`SELECT content, content_hash, version, items
      FROM harness_shared.harness_plans
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG}`;
    const before = await saved();

    const edit = kind === 'prose'
      ? { old_string: 'Check links.', new_string: 'Keep all registered tasks.' }
      : { itemId: 'P-001', anchors: [{ path: 'code.ts', change }] };
    const edited = data(await editTool.handler({ slug: SLUG, harness: HARNESS, ...edit } as never, ctx()));
    expect(edited).toMatchObject({ ok: false, code: 'plan_line_graph_incomplete', missingItemIds: ['P-002'] });
    expect(await saved()).toEqual(before);
    expect(await readPlanLineNodes(fx.admin, scope)).toEqual(nodes);
    expect(await anchorStore.readPlanItemAnchors({ ...scope, planSlug: SLUG })).toEqual({});
  });

  it.each(['empty', 'mismatched'] as const)('keeps graph authority when an %s legacy index cannot witness extra saved lines', async kind => {
    const stale = body().replace('\n## Decisions\n', '\n- **P-002** `todo` Stale body-only item\n\n## Decisions\n');
    const items = kind === 'empty' ? [] : deriveIndexFromContent(body()).items;
    await fx.admin`UPDATE harness_shared.harness_plans
      SET content=${stale}, content_hash=${hashPlanContent(stale)}, items=${JSON.stringify(items)}::jsonb
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG}`;
    const edited = data(await editTool.handler({ slug: SLUG, harness: HARNESS,
      old_string: 'Check links.', new_string: 'Keep graph authority.',
    } as never, ctx()));
    expect(edited.ok, JSON.stringify(edited)).toBe(true);
    const [saved] = await fx.admin`SELECT content FROM harness_shared.harness_plans
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG}`;
    expect(saved.content).toContain('Keep graph authority.');
    expect(saved.content).not.toContain('Stale body-only item');
  });

  it('preserves legacy item IDs and dependencies through an anchor-only edit without graph rows', async () => {
    const legacy = body().replace('\n## Decisions\n', '\n- **P-002** `blocked` Dependent item blocked-by: P-001\n\n## Decisions\n');
    const index = deriveIndexFromContent(legacy);
    await clearFixtureWorkItems();
    await fx.admin`UPDATE harness_shared.harness_plans
      SET content=${legacy}, content_hash=${hashPlanContent(legacy)}, items=${JSON.stringify(index.items)}::jsonb
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG}`;
    const scope = { workspaceId: WS, harnessSlug: HARNESS, slug: SLUG };
    expect(await readPlanLineNodes(fx.admin, scope)).toEqual([]);

    const read = async () => data(await getTool.handler({
      slug: SLUG, harness: HARNESS, mode: 'full', includeRaw: true, includeEnrichments: false,
    } as never, ctx())).results[0];
    const before = await read();
    expect(before.items.map((item: { id: string }) => item.id)).toEqual(['P-001', 'P-002']);
    expect(before.items[1].blockedBy).toEqual(['P-001']);

    const edited = data(await editTool.handler({ slug: SLUG, harness: HARNESS, itemId: 'P-002',
      anchors: [{ path: 'code.ts', change: { action: 'modify', summary: 'Update dependent source', reason: 'Preserve the approved task' } }],
    } as never, ctx()));
    expect(edited.ok, JSON.stringify(edited)).toBe(true);
    const after = await read();
    expect(after.items.map((item: { id: string }) => item.id)).toEqual(['P-001', 'P-002']);
    expect(after.items[1].blockedBy).toEqual(['P-001']);
    expect(after.items[1].anchors[0].path).toBe('code.ts');
    expect(after.raw).toContain('Existing item');
    expect(after.raw).toContain('Dependent item');

    const followup = data(await editTool.handler({ slug: SLUG, harness: HARNESS,
      old_string: 'Dependent item', new_string: 'Revised dependent item',
    } as never, ctx()));
    expect(followup.ok, JSON.stringify(followup)).toBe(true);
    const revised = await read();
    expect(revised.items[1].text).toBe('Revised dependent item');
    expect(revised.items[1].blockedBy).toEqual(['P-001']);
  });

  it('add and item-edit store equivalent resolved links that survive plan-index rewrites and read back', async () => {
    const result = data(await add({ anchors: [{ symbol: 'linked' }] }));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const added = result.results[0];
    expect(added.ok).toBe(true);
    expect(added.anchors[0]).toMatchObject({
      symbolId: 'code.ts:1:linked', symbolName: 'linked', path: 'code.ts',
      signature: 'export function linked() ', contentHash: declarationDigest, resolution: 'resolved',
      consumers: [{ path: 'flow.test.ts', line: 2 }], consumersTotal: 1, tests: ['flow.test.ts'],
    });
    const edited = data(await editTool.handler({ slug: SLUG, harness: HARNESS, itemId: 'P-001', anchors: [{ symbol: 'linked' }] } as never, ctx()));
    expect(edited.anchors).toEqual(added.anchors);
    await add({ text: 'Unrelated index rewrite' });
    const read = data(await getTool.handler({ slug: SLUG, harness: HARNESS, mode: 'full', includeEnrichments: false } as never, ctx())).results[0];
    expect(read.ok).toBe(true);
    for (const id of ['P-001', added.itemId]) {
      expect(read.items.find((item: any) => item.id === id)?.anchors[0]).toMatchObject(added.anchors[0]);
    }
    expect(read.prose).toContain('↳ code:');
  });
  it.each(['done', 'dropped'])('refuses an unauthenticated %s graph projection and rolls back the plan rewrite', async status => {
    const scope = { workspaceId: WS, harnessSlug: HARNESS, slug: SLUG };
    const before = await readPlanLineNodes(fx.admin, scope);
    const featureId = before[0].featureId;
    await fx.admin`UPDATE harness_shared.work_items SET taken_by='agent-anchor-test'
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND feature_id=${featureId}`;
    const proposed = body().replace('`todo`', '`' + status + '`');
    await expect(fx.admin.begin(async tx => {
      await tx`UPDATE harness_shared.harness_plans SET content=${proposed}, version=version + 1
        WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG}`;
      await writePlanLineNodes(tx as never, scope, before, deriveIndexFromContent(proposed).items);
    })).rejects.toThrow('plan_line_status_change_requires_lifecycle_writer');
    const [stored] = await fx.admin`SELECT status, taken_by, authority, terminal_owner, closed_ts
      FROM harness_shared.work_items
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND feature_id=${featureId}`;
    expect(stored).toMatchObject({ status: 'open', taken_by: 'agent-anchor-test',
      authority: null, terminal_owner: null, closed_ts: null });
    const [plan] = await fx.admin`SELECT content FROM harness_shared.harness_plans
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG}`;
    expect(plan.content).toBe(body());
  });

  it.each([
    { status: 'active', opStatus: null },
    { status: 'draft', opStatus: 'started' },
  ])('rejects a terminal plan rewrite after execution admission: %j', async ({ status, opStatus }) => {
    await fx.admin`UPDATE harness_shared.harness_plans SET status=${status}, op_status=${opStatus}
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG}`;
    await expect(withPlanLock(null, {
      workspaceId: WS, harnessSlug: HARNESS, slug: SLUG, intent: 'terminal projection regression',
    }, async () => ({ newBody: body().replace('`todo`', '`done`'), value: { ok: true } })))
      .rejects.toThrow('plan_line_status_change_requires_lifecycle_writer');
    expect((await readPlanLineNodes(fx.admin, { workspaceId: WS, harnessSlug: HARNESS, slug: SLUG }))[0].status)
      .toBe('todo');
  });

  it('preserves an existing terminal authority record during an unrelated graph rewrite', async () => {
    const scope = { workspaceId: WS, harnessSlug: HARNESS, slug: SLUG };
    const [node] = await readPlanLineNodes(fx.admin, scope);
    // Seed an already-settled row; the projection must preserve its authority.
    await fx.admin`UPDATE harness_shared.work_items SET status='done', authority='committed',
      terminal_owner='agent-anchor-test', taken_by=NULL
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND feature_id=${node.featureId}`;
    const before = await readPlanLineNodes(fx.admin, scope);
    await fx.admin.begin(tx => writePlanLineNodes(tx as never, scope, before,
      before.map(item => ({ ...item, text: 'Revised settled item' }))));
    const [stored] = await fx.admin`SELECT status, authority, terminal_owner, taken_by, plan_line_text
      FROM harness_shared.work_items
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND feature_id=${node.featureId}`;
    expect(stored).toMatchObject({ status: 'done', authority: 'committed',
      terminal_owner: 'agent-anchor-test', taken_by: null, plan_line_text: 'Revised settled item' });
  });

  it('anchor-only edits preserve stored prose and reconcile stale graph line text', async () => {
    const canonical = body().replace('Existing item', 'Reconciled native item').replace('`todo`', '`wip`');
    await fx.admin`
      UPDATE harness_shared.harness_plans
      SET content=${canonical}, content_hash=${hashPlanContent(canonical)}, version=version + 1
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG}
    `;
    const [stale] = await readPlanLineNodes(fx.admin, { workspaceId: WS, harnessSlug: HARNESS, slug: SLUG });
    expect(stale).toMatchObject({ text: 'Existing item', status: 'todo' });
    await fx.admin`
      UPDATE harness_shared.work_items SET status='wip'
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND feature_id=${stale.featureId}
    `;
    expect((await readPlanLineNodes(fx.admin, { workspaceId: WS, harnessSlug: HARNESS, slug: SLUG }))[0].status)
      .toBe('wip');

    const edited = data(await editTool.handler({ slug: SLUG, harness: HARNESS, itemId: 'P-001',
      anchors: [{ symbol: 'linked' }] } as never, ctx()));
    expect(edited.ok, JSON.stringify(edited)).toBe(true);

    const [stored] = await fx.admin<{ content: string; content_hash: string }[]>`
      SELECT content, content_hash FROM harness_shared.harness_plans
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG}
    `;
    expect(stored.content).toBe(canonical);
    expect(stored.content_hash).toBe(hashPlanContent(canonical));
    expect((await readPlanLineNodes(fx.admin, { workspaceId: WS, harnessSlug: HARNESS, slug: SLUG }))[0])
      .toMatchObject({ text: 'Reconciled native item', status: 'wip' });
    expect((await anchorStore.readPlanItemAnchors({ workspaceId: WS, harnessSlug: HARNESS, planSlug: SLUG }))['P-001'][0])
      .toMatchObject({ symbolName: 'linked', path: 'code.ts' });
  });
  it('file links retain content hashes, unresolved links retain reasons, and general plans get no no-links warning', async () => {
    const added = data(await add({ anchors: [{ path: 'code.ts' }, { symbol: 'absent' }] })).results[0];
    expect(added.anchors).toMatchObject([{ path: 'code.ts', contentHash: digest, resolution: 'resolved' },
      { requested: 'absent', resolution: 'unknown', unknownReason: 'not-found' }]);
    const noLinks = data(await add()).results[0];
    expect(noLinks.ok).toBe(true);
    expect(noLinks.warnings).toEqual([expect.stringContaining('no code links')]);
    await fx.admin`UPDATE harness_shared.harness_plans SET verification_profile='general'
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG}`;
    expect(data(await add()).results[0].warnings).toBeUndefined();
  });
  it('a storage failure rolls back the plan mutation and its rebuilt index', async () => {
    await add({ text: 'Populate the derived index' });
    const beforeItems = await fx.admin`SELECT item_id FROM harness_shared.plan_items
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG} ORDER BY item_id`;
    const beforePlan = await fx.admin`SELECT content,version FROM harness_shared.harness_plans
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG}`;
    expect(beforeItems.length).toBeGreaterThan(0);
    const write = vi.spyOn(anchorStore, 'writePlanItemAnchors').mockRejectedValueOnce(new Error('fixture storage failure'));
    const result = data(await add({ anchors: [{ path: 'code.ts' }] }));
    expect(write).toHaveBeenCalledOnce();
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain('fixture storage failure');
    const rows = await fx.admin`SELECT item_id FROM harness_shared.plan_items
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG} ORDER BY item_id`;
    expect(rows.map(row => row.item_id)).toEqual(beforeItems.map(row => row.item_id));
    const afterPlan = await fx.admin`SELECT content,version FROM harness_shared.harness_plans
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG}`;
    expect(afterPlan.map(row => [row.content, row.version])).toEqual(beforePlan.map(row => [row.content, row.version]));
  });
  describe('atomic blocker decision before graph lifecycle writes', () => {
    async function prepare() {
      const [node] = await readPlanLineNodes(fx.admin, { workspaceId: WS, harnessSlug: HARNESS, slug: SLUG });
      await fx.admin`UPDATE harness_shared.work_items SET taken_by='agent-anchor-test'
        WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND feature_id=${node.featureId}`;
      const [{ payload }] = await fx.admin`SELECT payload FROM harness_shared.work_items
        WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND feature_id=${node.featureId}`;
      const ref = { kind: 'state' as const, ref: 'state:dependency.health' };
      const prepared = prepareBlockerDecision(payload, {
        schemaVersion: 1, idempotencyKey: 'plan-atomic-decision', disposition: 'self_resolve',
        symptom: 'Dependency endpoint was unavailable',
        investigation: [{ action: 'Read dependency health', outcome: 'Endpoint recovered', evidenceRefs: [ref] }],
        attempts: [], evidenceRefs: [ref], verification: { outcome: 'Recovery verified', evidenceRefs: [ref] },
      }, { ownerId: 'agent-anchor-test', custodianId: 'agent-anchor-test',
        sessionId: 'authenticated-plan-session', workItemId: node.featureId });
      if (!prepared.ok) throw new Error(JSON.stringify(prepared));
      const mutation: BlockerDecisionMutation = { prepared, expectedState: 'open',
        expectedCustodianId: 'agent-anchor-test', expectedExternalBlockers: undefined, payloadPatch: {}, unset: [] };
      const proposed = body().replace('`todo`', '`wip`');
      const apply = (tx: Parameters<typeof applyBlockerDecisionMutation>[0]) =>
        applyBlockerDecisionMutation(tx, { workspace: WS, harness: HARNESS, id: node.featureId }, mutation);
      const read = async () => ({
        plan: [...await fx.admin`SELECT content,content_hash,version,items FROM harness_shared.harness_plans
          WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG}`],
        index: [...await fx.admin`SELECT * FROM harness_shared.plan_items
          WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG}`],
        node: [...await fx.admin`SELECT * FROM harness_shared.work_items
          WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND feature_id=${node.featureId}`],
        revisions: [...await fx.admin`SELECT * FROM harness_shared.plan_revisions
          WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG} ORDER BY seq`],
      });
      return { node, mutation, proposed, apply, read };
    }
    it('commits decision, graph lifecycle, body and index in the same transaction', async () => {
      const test = await prepare();
      const before = await test.read();
      const result = await withPlanLock(null, {
        workspaceId: WS, harnessSlug: HARNESS, slug: SLUG, intent: 'atomic blocker decision regression',
        beforeGraphWriteInTransaction: tx => test.apply(tx),
      }, async () => ({ newBody: test.proposed, value: { ok: true } }));
      expect(result.kind).toBe('applied');
      const after = await test.read();
      expect(Number(after.plan[0].version)).toBe(Number(before.plan[0].version) + 1);
      expect(after.plan[0].content).toBe(test.proposed);
      expect(after.index[0].status).toBe('wip');
      expect(after.node[0]).toMatchObject({ status: 'wip', taken_by: 'agent-anchor-test',
        payload: { blockerResolution: { history: [{ authorId: 'agent-anchor-test', sessionId: 'authenticated-plan-session' }] } } });
    });
    it('rolls back body and index when the old canonical custody fence rejects the decision', async () => {
      const test = await prepare();
      test.mutation.expectedCustodianId = 'another-agent';
      const before = await test.read();
      await expect(withPlanLock(null, {
        workspaceId: WS, harnessSlug: HARNESS, slug: SLUG, intent: 'atomic blocker CAS regression',
        beforeGraphWriteInTransaction: tx => test.apply(tx),
      }, async () => ({ newBody: test.proposed, value: { ok: true } })))
        .rejects.toMatchObject({ code: 'blocker_decision_revision_conflict' });
      expect(await test.read()).toEqual(before);
    });
    it('rolls back the decision when the later graph lifecycle write fails', async () => {
      const test = await prepare();
      const before = await test.read();
      await fx.admin.unsafe(`CREATE FUNCTION harness_shared.reject_blocker_plan_graph() RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN IF NEW.payload ? 'blockerResolution' AND NEW.status='wip' THEN
          RAISE EXCEPTION 'injected plan graph failure'; END IF; RETURN NEW; END $fn$;
        CREATE TRIGGER reject_blocker_plan_graph BEFORE UPDATE ON harness_shared.work_items
        FOR EACH ROW EXECUTE FUNCTION harness_shared.reject_blocker_plan_graph()`);
      try {
        await expect(withPlanLock(null, {
          workspaceId: WS, harnessSlug: HARNESS, slug: SLUG, intent: 'atomic blocker graph rollback regression',
          beforeGraphWriteInTransaction: tx => test.apply(tx),
        }, async () => ({ newBody: test.proposed, value: { ok: true } })))
          .rejects.toThrow('injected plan graph failure');
        expect(await test.read()).toEqual(before);
      } finally {
        await fx.admin.unsafe(`DROP TRIGGER reject_blocker_plan_graph ON harness_shared.work_items;
          DROP FUNCTION harness_shared.reject_blocker_plan_graph()`);
      }
    });
    it('rolls back decision and lifecycle when a later transaction hook rejects', async () => {
      const test = await prepare();
      const before = await test.read();
      await expect(withPlanLock(null, {
        workspaceId: WS, harnessSlug: HARNESS, slug: SLUG, intent: 'atomic blocker late rollback regression',
        beforeGraphWriteInTransaction: tx => test.apply(tx),
        inTransaction: async () => { throw new Error('injected late plan failure'); },
      }, async () => ({ newBody: test.proposed, value: { ok: true } })))
        .rejects.toThrow('injected late plan failure');
      expect(await test.read()).toEqual(before);
    });
  });
  it('pasted generated link lines do not become plan content or a stale receipt hash', async () => {
    const edited = data(await editTool.handler({ slug: SLUG, harness: HARNESS, old_string: 'Existing item',
      new_string: 'Existing item\n  ↳ code: generated display only' } as never, ctx()));
    expect(edited.ok).toBe(true);
    const [row] = await fx.admin`SELECT content,content_hash FROM harness_shared.harness_plans
      WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug=${SLUG}`;
    expect(row.content).not.toContain('↳ code:');
    expect(edited.contentHash).toBe(row.content_hash);
  });
});
