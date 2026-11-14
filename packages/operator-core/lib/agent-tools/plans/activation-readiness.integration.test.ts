/** Real PostgreSQL state boundary for the existing activation diagnostic. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedPlan, setupPlanPgFixture, type PlanPgFixture } from './__tests__/_pg-tool-fixture';
import { readPlanActivationReadiness, createPlanActivationReadinessRequest, previewPlanStartConsult,
  collectActivationReadiness, ACTIVATION_STAGE_IDS,
  type ActivationReadinessBasis, type ActivationReadinessReaders } from './get-activation-readiness';
import { checkPlanAdmission, configurePlanAdmissionCertificateSource,
  configurePlanAdmissionPolicySource, configurePlanAdmissionShadowSink } from './plan-admission-gate';
import { deriveIndexFromContent } from './derive-index';
import { writePlanIndexRows } from './plan-index-rows';
import { readPlanLineNodes, writePlanLineNodes } from './plan-line-graph';
import { readPlanBySlug } from './source';
import { listSpecClauses, setSpecClause } from './spec-clauses-store';
import { evaluatePlanSpecQuality } from './spec-quality';
import { buildBarCritiqueRecord, evaluateBarCritiqueGate } from './plan-start-critique-gate';
import { mergeActivationAuditCoverage, type ActivationAuditPayload } from '../../plan-audits';
import { checkExecutionPlan } from './plan-execution-guard';
import getTool from './get';
import auditTool from './audit';
import startTool from './start';
import { autoStartAfterActivationAudit } from './auto-start-after-audit';
import { conformanceActivationVerdict } from '../../spec-conformance/activation-gate';

const advice = vi.hoisted(() => ({ compute: vi.fn(), route: vi.fn() }));
vi.mock('../search/embedder', () => ({ buildQueryEmbedderResolved: async () => null }));
vi.mock('../../consult/plan-start-consult', async orig => {
  const actual = await orig<typeof import('../../consult/plan-start-consult')>();
  advice.compute.mockImplementation(actual.planStartConsult);
  return { ...actual, planStartConsult: advice.compute };
});
vi.mock('../../consult/relevance-router', async orig => ({
  ...(await orig<typeof import('../../consult/relevance-router')>()),
  routeConsult: advice.route,
}));

let fx: PlanPgFixture;
let serial = 0;
let slug: string;
let workItemId: string;
const harness = 'zzz-activation-readiness';
const requesterId = 'su-readiness-integration';
const shadow = vi.fn();
// Separate categories are intentional: scorecards share the existing work table.
const FORBIDDEN_FAMILIES = {
  'plan-content-status': ['harness_plans'],
  'clauses-specs': ['plan_spec_clauses', 'plan_spec_clause_revisions'],
  'audits-pins-evidence': ['plan_audits', 'plan_type_pins', 'spec_evidence_bindings'],
  'claims-admission-promotion': ['work_items', 'work_item_deps', 'pot_policy'],
  'review-consult-recruitment': ['consult_state', 'coord_conversations', 'coord_thread_posts'],
  scorecards: ['work_items'],
} as const;
async function snapshot() {
  const result: Record<string, unknown> = {};
  for (const [family, tables] of Object.entries(FORBIDDEN_FAMILIES)) {
    result[family] = await Promise.all(tables.map(async table => {
      // Table names come only from the constant population above. Failure is
      // propagated: an unavailable measurement can never establish no delta.
      const [row] = await fx.admin.unsafe(`SELECT md5(COALESCE(jsonb_agg(to_jsonb(r)
        ORDER BY to_jsonb(r)::text),'[]'::jsonb)::text) AS fingerprint FROM harness_shared.${table} r`);
      if (!row?.fingerprint) throw new Error('unavailable snapshot: ' + table);
      return [table, row.fingerprint];
    }));
  }
  result['shadow-observations'] = shadow.mock.calls;
  return JSON.parse(JSON.stringify(result));
}
const request = () => ({ workspaceId: fx.workspaceId, harnessSlug: harness, planSlug: slug, requesterId,
  consult: { outcome: 'proceed_no_candidates' } as never });
beforeAll(async () => {
  fx = await setupPlanPgFixture({ isolated: true });
  for (const table of new Set(Object.values(FORBIDDEN_FAMILIES).flat())) {
    const [row] = await fx.admin`SELECT to_regclass(${'harness_shared.' + table})::text AS name`;
    expect(row?.name, 'required no-write snapshot table: ' + table).toBeTruthy();
  }
}, 120_000);
afterAll(async () => { configurePlanAdmissionPolicySource(null); configurePlanAdmissionShadowSink(null);
  configurePlanAdmissionCertificateSource(null); await fx?.dispose(); });
beforeEach(async () => {
  advice.compute.mockClear();
  advice.route.mockReset().mockResolvedValue({ qualified: [], snapshot: { candidates: [] } });
  slug = 'readiness-draft-' + ++serial;
  shadow.mockClear();
  configurePlanAdmissionPolicySource(async () => null);
  configurePlanAdmissionCertificateSource({ resolve: async () => ({ certificate: null }) });
  configurePlanAdmissionShadowSink({ record: shadow });
  const content = `---\nslug: ${slug}\nstatus: draft\n---\n\n## Phase 1\n\n- **P-001** \`todo\` Implement a scoped behavior.\n`;
  await seedPlan(fx.admin, fx.workspaceId, harness, slug, content);
  await fx.admin.begin(async tx => {
    const index = deriveIndexFromContent(content);
    await writePlanIndexRows(tx as never, { workspaceId: fx.workspaceId, harnessSlug: harness, planSlug: slug }, index);
    await writePlanLineNodes(tx as never, { workspaceId: fx.workspaceId, harnessSlug: harness, slug },
      [], index.items);
  });
  const nodes = await readPlanLineNodes(fx.admin as never, { workspaceId: fx.workspaceId, harnessSlug: harness, slug });
  expect(nodes.map(n => n.id), 'fixture must contain canonical graph population').toEqual(['P-001']);
  const indexRows = await fx.admin`SELECT item_id FROM harness_shared.plan_items
    WHERE workspace_id=${fx.workspaceId} AND harness_slug=${harness} AND plan_slug=${slug}`;
  expect(indexRows.map(r => r.item_id), 'spec writer compatibility index must match graph').toEqual(['P-001']);
  workItemId = nodes[0].featureId;
  await fx.admin`UPDATE harness_shared.harness_plans SET status='draft',verification_profile='coding',
    input_schema='{"type":"object","required":["target"],"properties":{"target":{"type":"string"}}}'::jsonb,
    template_data='{}'::jsonb WHERE workspace_id=${fx.workspaceId} AND harness_slug=${harness} AND plan_slug=${slug}`;
});

describe('activation readiness application-read-only boundary', () => {
  it('pins the same live contract as spec quality while retaining superseded and retired history', async () => {
    const write = { harnessSlug: harness, planSlug: slug, planItemId: 'P-001',
      behavior: 'A changed input is rejected before a write.', behaviorClass: 'boundary' as const,
      requiredEvidence: ['code'], requiredTestLayers: ['unit'], actorId: requesterId,
      falsifier: { observation: 'The changed input is accepted.', probeMethod: 'Run the invalid-input fixture.' } };
    const scope = { workspaceId: fx.workspaceId, harnessSlug: harness, planSlug: slug };
    for (let index = 0; index < 22; index++) {
      const lifecycleStatus = index < 20 ? 'draft' : index === 20 ? 'superseded' : 'retired';
      const result = await fx.admin.begin(tx => setSpecClause({ ...write, expectedRevision: 0,
        specId: 'CONTRACT-' + index, lifecycleStatus },
      { executor: tx as never, workspaceId: fx.workspaceId, harnessSlug: harness }));
      expect(result).toMatchObject({ status: 'created' });
    }
    const original = await listSpecClauses(scope);
    expect(original).toHaveLength(22);
    expect(original.filter(clause => clause.lifecycleStatus === 'draft')).toHaveLength(20);
    const qualityHash = (clauses: typeof original) => evaluatePlanSpecQuality({
      harnessSlug: harness, planSlug: slug, planItemIds: ['P-001'], clauses,
      classRef: 'plan-class-feature-ship',
    }).specSetHash;
    const before = await snapshot();
    const diagnostic = await readPlanActivationReadiness(request());
    if (!diagnostic.basis) throw new Error('The canonical readiness basis must be available.');
    expect(diagnostic.basis.specSetHash).toBe(qualityHash(original));
    expect(await snapshot()).toEqual(before);
    expect(await listSpecClauses(scope)).toEqual(original);

    // A matching pin must still invalidate when the live contract changes.
    const changed = await fx.admin.begin(tx => setSpecClause({ ...write, specId: 'CONTRACT-0',
      expectedRevision: 1, lifecycleStatus: 'draft', behavior: 'A changed input is rejected before any external effect.' },
    { executor: tx as never, workspaceId: fx.workspaceId, harnessSlug: harness }));
    expect(changed).toMatchObject({ status: 'revised' });
    const current = await listSpecClauses(scope);
    const updated = await readPlanActivationReadiness(request());
    if (!updated.basis) throw new Error('The updated readiness basis must be available.');
    expect(updated.basis.specSetHash).toBe(qualityHash(current));
    expect(updated.basis.specSetHash).not.toBe(diagnostic.basis.specSetHash);
    expect(current.filter(clause => ['superseded', 'retired'].includes(clause.lifecycleStatus)))
      .toEqual(original.filter(clause => ['superseded', 'retired'].includes(clause.lifecycleStatus)));
  }, 120_000);

  it('previews the activation audit Conformance refusal and requirement keys without writes', async () => {
    const read = await readPlanBySlug(slug, { workspaceId: fx.workspaceId, harnessSlug: harness });
    const content = read!.row.content + '\n## Requirements\n\n' + ['R-1', 'R-2'].map(key =>
      `**${key} — Preserve executable acceptance.**\n\`\`\`requirement\n${JSON.stringify({
        intent: { request: 'Preserve acceptance', sourceRefs: ['owner directive #1'] },
        acceptance: { condition: 'Acceptance holds.', falsifier: 'Acceptance fails.', passRatings: ['healthy'] },
        verification: { method: 'Inspect acceptance.' },
      })}\n\`\`\``).join('\n\n');
    await seedPlan(fx.admin, fx.workspaceId, harness, slug, content);
    const gate = conformanceActivationVerdict(content);
    expect(gate).toMatchObject({ ok: false, error: 'conformance_requirement_unenforced' });
    const before = await snapshot();
    const result = await readPlanActivationReadiness(request());
    expect(result.ready).toBe(false);
    expect(result.stages.find(s => s.id === 'conformance')).toMatchObject({
      status: 'blocked', codes: [gate.error], evidenceRefs: gate.problems.map(p => p.barKey),
    });
    expect(await snapshot()).toEqual(before);
  }, 120_000);

  it('controlled before and after blocker trace preserves the refusal and reveals independent blockers', async () => {
    const ctx = { workspaceId: fx.workspaceId, harnessSlug: harness,
      uiClientId: requesterId, isSuperuser: true } as never;
    const before = await snapshot();
    const start = await startTool.handler(startTool.args.parse({ slug, harness }), ctx) as { data: any };
    const primary = start.data.results[0];
    const get = await getTool.handler(getTool.args.parse({ slug, harness,
      activationReadiness: true, includeEnrichments: false, mode: 'meta' }), ctx) as { data: any };
    const diagnostic = get.data.results[0].activationReadiness;
    const known = ['declarations', 'inputs', 'anchors'];
    const blocked = diagnostic.stages.filter((s: any) => s.status === 'blocked').map((s: any) => s.id);
    // The baseline is the still-supported primary refusal, not a timing claim
    // or a reconstructed old implementation. Both observations use one draft.
    expect(primary.ok).toBe(false);
    expect(primary.error).toBeTruthy();
    expect(diagnostic.ready).toBe(false);
    expect(blocked).toEqual(expect.arrayContaining(known));
    expect(diagnostic.basis).toEqual(primary.activationReadiness.basis);
    expect(await snapshot()).toEqual(before);
    console.info('ACTIVATION_CONTROLLED_TRACE ' + JSON.stringify({ journey: 'blockers',
      before: { surface: 'primary-refusal', ready: primary.ok, error: primary.error },
      after: { surface: 'activationReadiness', ready: diagnostic.ready, known, blocked } }));
  }, 120_000);

  it('controlled before and after consult trace preserves advice and routes once through auto-start receipt reuse', async () => {
    const { consult: _fixtureAdvice, ...params } = request();
    const before = await snapshot();
    // Measure the former two-caller composition without sharing its receipt.
    const baselineStart = await readPlanActivationReadiness(params);
    const baselineAudit = await readPlanActivationReadiness(params);
    expect(advice.compute).toHaveBeenCalledTimes(2);
    expect(advice.route).toHaveBeenCalledTimes(2);
    const beforeComputes = advice.compute.mock.calls.length;
    const beforeRoutes = advice.route.mock.calls.length;
    advice.compute.mockClear();
    advice.route.mockClear();
    const read = await readPlanBySlug(slug, { workspaceId: fx.workspaceId, harnessSlug: harness });
    const outcome = await autoStartAfterActivationAudit({ slug, harness, planContent: read!.row.content,
      start: async () => {
        const nested = await createPlanActivationReadinessRequest(params);
        await nested.quality();
        const actual = await previewPlanStartConsult({ workspaceId: fx.workspaceId, requesterId,
          planSlug: slug, planContent: read!.row.content });
        return { data: { results: [{ ok: true,
          activationConsult: nested.recordConsult(actual) }] } };
      } });
    expect(outcome.attempted).toBe(true);
    if (!outcome.attempted || !outcome.started) throw new Error('successful nested-start receipt required');
    expect(outcome.activationConsult).toBeDefined();
    const current = await readPlanActivationReadiness({ ...params, consultReceipt: outcome.activationConsult });
    expect(current.consult).toEqual(baselineStart.consult);
    expect(current.consult).toEqual(baselineAudit.consult);
    expect(current.ready).toBe(baselineAudit.ready);
    expect(advice.compute).toHaveBeenCalledTimes(1);
    expect(advice.route).toHaveBeenCalledTimes(1);
    expect(await snapshot()).toEqual(before);
    console.info('ACTIVATION_CONTROLLED_TRACE ' + JSON.stringify({ journey: 'consult',
      before: { computes: beforeComputes, routes: beforeRoutes, ready: baselineAudit.ready, advice: baselineAudit.consult },
      after: { computes: advice.compute.mock.calls.length, routes: advice.route.mock.calls.length,
        ready: current.ready, advice: current.consult } }));
  }, 120_000);

  it('keeps get, activation audit and refused start on the same real diagnostic basis', async () => {
    const ctx = { workspaceId: fx.workspaceId, harnessSlug: harness,
      uiClientId: requesterId, isSuperuser: true } as never;
    const before = await snapshot();
    const get = await getTool.handler(getTool.args.parse({ slug, harness,
      activationReadiness: true, includeEnrichments: false, mode: 'meta' }), ctx) as { data: any };
    const audit = await auditTool.handler(auditTool.args.parse({ slug, harness,
      phase: 'activation', dryRun: true, sourceRanges: [], mappings: [] }), ctx) as { data: any };
    const start = await startTool.handler(startTool.args.parse({ slug, harness }), ctx) as { data: any };
    const read = get.data.results[0];
    const refused = start.data.results[0];
    expect(read.ok, JSON.stringify(get.data)).toBe(true);
    expect(audit.data.ok).toBe(false);
    expect(audit.data.error).toBeTruthy();
    expect(refused.ok).toBe(false);
    expect(refused.error).toBeTruthy();
    const diagnostics = [read.activationReadiness, audit.data.activationReadiness, refused.activationReadiness];
    for (const diagnostic of diagnostics) {
      expect(diagnostic).toMatchObject({ schemaVersion: 1, advisory: true, ready: false,
        counts: { total: ACTIVATION_STAGE_IDS.length, returned: ACTIVATION_STAGE_IDS.length, omitted: 0 } });
      expect(diagnostic.stages.map((stage: { id: string }) => stage.id)).toEqual([...ACTIVATION_STAGE_IDS]);
      expect(diagnostic.stages.find((stage: { id: string }) => stage.id === 'conformance'))
        .toMatchObject({ status: 'not-applicable', codes: ['conformance_not_applicable'] });
    }
    const project = (diagnostic: any) => ({ basis: diagnostic.basis, freshness: diagnostic.freshness,
      stages: diagnostic.stages.filter((s: any) => s.id !== 'consult') });
    expect(diagnostics[0]).toMatchObject({ ready: false, freshness: 'current',
      counts: { total: 14, returned: 14, omitted: 0 } });
    expect(project(diagnostics[1])).toEqual(project(diagnostics[0]));
    expect(project(diagnostics[2])).toEqual(project(diagnostics[0]));
    for (const id of ['declarations', 'inputs', 'anchors']) {
      expect(diagnostics[0].stages.find((s: any) => s.id === id)?.status, id).toBe('blocked');
    }
    // The preview deliberately does not recruit/route; this difference is
    // explicit and must not hide a disagreement in the other thirteen stages.
    expect(diagnostics[1].consult).toMatchObject({ outcome: 'unavailable' });
    expect(await snapshot()).toEqual(before);
    expect(shadow).not.toHaveBeenCalled();
  }, 120_000);

  it('routes one actual advisory for unchanged start and audit diagnostic collection', async () => {
    const { consult: _fixtureAdvice, ...params } = request();
    const startRequest = await createPlanActivationReadinessRequest(params);
    await startRequest.quality();
    const read = await readPlanBySlug(slug, { workspaceId: fx.workspaceId, harnessSlug: harness });
    const actual = await previewPlanStartConsult({ workspaceId: fx.workspaceId, requesterId,
      planSlug: slug, planContent: read!.row.content });
    const receipt = startRequest.recordConsult(actual);
    expect(receipt?.basis, 'receipt must come from the real measured PG scope').toBeDefined();
    const startDiagnostic = await startRequest.collect();
    const before = await snapshot();
    const auditDiagnostic = await readPlanActivationReadiness({ ...params, consultReceipt: receipt });
    expect(startDiagnostic.consult).toEqual(actual);
    expect(auditDiagnostic.consult).toEqual(actual);
    expect(advice.compute).toHaveBeenCalledTimes(1);
    expect(advice.route).toHaveBeenCalledTimes(1);
    expect(await snapshot()).toEqual(before);
    await readPlanActivationReadiness({ ...params, requesterId: 'different-requester', consultReceipt: receipt });
    expect(advice.compute).toHaveBeenCalledTimes(2);
    expect(advice.route).toHaveBeenCalledTimes(2);
  }, 120_000);
  it('reports independent draft blockers without changing application rows or shadow observations', async () => {
    const before = await snapshot();
    const result = await readPlanActivationReadiness(request());
    expect(result.counts).toEqual({ total: 14, returned: 14, omitted: 0 });
    for (const [id, code] of [['declarations', 'plan_declarations_invalid'], ['inputs', 'missing_required'],
      ['anchors', 'initial_change_scope_missing']]) {
      const stage = result.stages.find(s => s.id === id);
      expect({ status: stage?.status, codes: stage?.codes }, 'independent stage: ' + id)
        .toEqual({ status: 'blocked', codes: [code] });
    }
    expect(result.ready).toBe(false);
    expect(await snapshot()).toEqual(before);
    expect(shadow).not.toHaveBeenCalled();
  }, 120_000);

  it('allows ordinary invocation telemetry while detecting application-state changes', async () => {
    const before = await snapshot();
    await fx.admin`INSERT INTO harness_shared.route_invocations (workspace_id,method,path,status,duration_ms)
      VALUES (${fx.workspaceId},'TOOL','plans:get','ok',1)`;
    expect(await snapshot()).toEqual(before);
    await fx.admin`UPDATE harness_shared.harness_plans SET status='ready'
      WHERE workspace_id=${fx.workspaceId} AND harness_slug=${harness} AND plan_slug=${slug}`;
    expect((await snapshot())['plan-content-status']).not.toEqual(before['plan-content-status']);
  });

  it.each(Object.keys(FORBIDDEN_FAMILIES))('detects a forbidden mutation in %s', async family => {
    const before = await snapshot();
    if (family === 'plan-content-status') {
      await fx.admin`UPDATE harness_shared.harness_plans SET status='ready'
        WHERE workspace_id=${fx.workspaceId} AND harness_slug=${harness} AND plan_slug=${slug}`;
    } else if (family === 'clauses-specs') {
      // Use the real append-only writer: the current pointer/revision FK is
      // deferred inside its transaction and must not be guessed in a fixture.
      const result = await fx.admin.begin(tx => setSpecClause({ harnessSlug: harness, planSlug: slug,
        specId: 'NEGATIVE-CONTROL', expectedRevision: 0, planItemId: 'P-001',
        behavior: 'A changed input is rejected before a write.', behaviorClass: 'boundary',
        requiredEvidence: ['code'], requiredTestLayers: ['unit'], lifecycleStatus: 'draft', actorId: requesterId,
        falsifier: { observation: 'The changed input is accepted.', probeMethod: 'Run the invalid-input fixture.' } },
      { executor: tx as never, workspaceId: fx.workspaceId, harnessSlug: harness }));
      expect(result).toMatchObject({ status: 'created' });
    } else if (family === 'audits-pins-evidence') {
      await fx.admin`INSERT INTO harness_shared.plan_type_pins
        (workspace_id,harness_slug,plan_slug,kind,type_id,revision,content_hash,pinned_by,pin_reason)
        VALUES (${fx.workspaceId},${harness},${slug},'plan-type','fixture/control',1,${'a'.repeat(64)},${requesterId},'negative control')`;
    } else if (family === 'claims-admission-promotion') {
      await fx.admin`UPDATE harness_shared.work_items SET taken_by=${requesterId},taken_at=${Date.now()}
        WHERE workspace_id=${fx.workspaceId} AND harness_slug=${harness} AND feature_id=${workItemId}`;
    } else if (family === 'review-consult-recruitment') {
      await fx.admin`INSERT INTO harness_shared.coord_conversations
        (workspace_id,id,kind,scope,harness_slug,asker_id)
        VALUES (${fx.workspaceId},${'fixture-' + slug},'consult','harness',${harness},${requesterId})`;
    } else if (family === 'scorecards') {
      await fx.admin`UPDATE harness_shared.work_items SET payload=payload ||
        ${JSON.stringify({ observation: { rubricRef: 'specification-quality', subject: { kind: 'plan', ref: slug } } })}::jsonb
        WHERE workspace_id=${fx.workspaceId} AND harness_slug=${harness} AND feature_id=${workItemId}`;
    }
    expect((await snapshot())[family], family).not.toEqual(before[family]);
  });

  it('detects a real admission shadow while the read-only verdict suppresses it', async () => {
    configurePlanAdmissionPolicySource(async () => ({ policyVersion: 1, quorumBps: 10000, approvalBps: 10000,
      ratificationWindowSec: 60, materiality: { maxChangedLines: 0, maxChangedItems: 0 }, mode: 'shadow' }));
    const row = (await readPlanBySlug(slug, { workspaceId: fx.workspaceId, harnessSlug: harness }))!.row;
    const subject = { slug, door: 'start' as const, opts: { workspaceId: fx.workspaceId, harnessSlug: harness }, row };
    const before = await snapshot();
    await checkPlanAdmission({ ...subject, readOnly: true });
    expect(await snapshot()).toEqual(before);
    await checkPlanAdmission(subject);
    expect((await snapshot())['shadow-observations']).not.toEqual(before['shadow-observations']);
  });

  it('marks observations unknown after a real mid-read plan write', async () => {
    configurePlanAdmissionPolicySource(async () => {
      await fx.admin`UPDATE harness_shared.harness_plans SET version=version+1
        WHERE workspace_id=${fx.workspaceId} AND harness_slug=${harness} AND plan_slug=${slug}`;
      return null;
    });
    const result = await readPlanActivationReadiness(request());
    expect(result).toMatchObject({ ready: false, freshness: 'changed' });
    expect(result.stages.filter(s => s.status === 'pass')).toEqual([]);
  }, 120_000);

  it('source coverage, exemptions and execution fences survive preview while existing plan lanes remain unchanged', async () => {
    const coverage: ActivationAuditPayload = { sourceRanges: [{ sourceKind: 'codex', sessionId: 'fixture-source',
      fromTurn: 1, toTurn: 1 }], mappings: [{ id: 'M-001', sourceRefs: ['session_turn:codex:fixture-source:1'],
      requirement: 'Keep the existing discovery and paperwork implementation lanes.',
      planTargets: ['P-001'], disposition: 'covered' }], repairedOmissions: [],
      rejectedOrSuperseded: [], unresolvedBlockers: [] };
    const empty: ActivationAuditPayload = { sourceRanges: [], mappings: [], repairedOmissions: [],
      rejectedOrSuperseded: [], unresolvedBlockers: [] };
    const merged = mergeActivationAuditCoverage(coverage, empty);
    expect(merged.ok).toBe(true);
    if (!merged.ok) throw new Error('source coverage must carry forward');
    expect(merged.activation).toEqual(coverage);
    const exemption = { authority: 'fixture-P-001', rationale: 'An existing non-code acceptance obligation.',
      scope: ['source-coverage'] };
    const saved = await fx.admin.begin(tx => setSpecClause({ harnessSlug: harness, planSlug: slug,
      specId: 'PRESERVED-EXEMPTION', expectedRevision: 0, planItemId: 'P-001',
      behavior: 'Existing source coverage and its exemption remain unchanged.', behaviorClass: 'boundary',
      requiredEvidence: ['code'], requiredTestLayers: ['unit'], lifecycleStatus: 'exempt',
      exemption, actorId: requesterId, falsifier: { observation: 'The exemption is removed.' } },
    { executor: tx as never, workspaceId: fx.workspaceId, harnessSlug: harness }));
    expect(saved).toMatchObject({ status: 'created' });
    for (const lane of ['existing-discovery', 'existing-paperwork']) {
      await seedPlan(fx.admin, fx.workspaceId, harness, lane, `---\nslug: ${lane}\nstatus: active\n---\n`);
    }
    const before = await snapshot();
    const binding = { planSlug: slug, harnessSlug: harness };
    const fence = await checkExecutionPlan(binding, fx.workspaceId);
    expect(fence.length, 'a preview cannot issue a canonical start proof').toBeGreaterThan(0);
    await readPlanActivationReadiness(request());
    expect(await checkExecutionPlan(binding, fx.workspaceId)).toEqual(fence);
    expect(await snapshot()).toEqual(before);
    const [clause] = await listSpecClauses({ workspaceId: fx.workspaceId, harnessSlug: harness, planSlug: slug });
    expect(clause.exemption).toEqual(exemption);
    expect(mergeActivationAuditCoverage(merged.activation, empty)).toMatchObject({ ok: true,
      activation: coverage, carriedMappingIds: ['M-001'] });
  }, 120_000);

  it('cosmetic lifecycle carry preserves review provenance while material behavior falsifier evidence and policy drift invalidate it', async () => {
    const write = { harnessSlug: harness, planSlug: slug, specId: 'REVIEW-PIN', planItemId: 'P-001',
      behavior: 'A current receipt authorizes only its original scope.', behaviorClass: 'boundary' as const,
      requiredEvidence: ['code'], requiredTestLayers: ['unit'], lifecycleStatus: 'draft' as const,
      actorId: requesterId, falsifier: { observation: 'A stale receipt is accepted.' } };
    await fx.admin.begin(tx => setSpecClause({ ...write, expectedRevision: 0 },
      { executor: tx as never, workspaceId: fx.workspaceId, harnessSlug: harness }));
    const read = () => listSpecClauses({ workspaceId: fx.workspaceId, harnessSlug: harness, planSlug: slug });
    const original = await read();
    const record = buildBarCritiqueRecord({ planSlug: slug, closedAt: new Date().toISOString(),
      answeredAt: original[0].createdAt, clausesAsOfClose: original, history: original });
    const critics = ['independent-a', 'independent-b'].map(partyKey => ({ consultId: partyKey,
      criticId: partyKey, partyKey, record }));
    const gate = (currentClauses: typeof original, threshold = 2) => evaluateBarCritiqueGate({ planSlug: slug,
      currentClauses, critiques: critics, threshold, authorPartyKeys: new Set([requesterId]) });
    expect(gate(original).satisfied).toBe(true);
    const before = await snapshot();
    await readPlanActivationReadiness(request());
    expect(await snapshot()).toEqual(before);
    expect(gate(await read()).satisfied).toBe(true);
    const originalReceipt = JSON.stringify(critics);
    await fx.admin.begin(tx => setSpecClause({ ...write, expectedRevision: 1, lifecycleStatus: 'active' },
      { executor: tx as never, workspaceId: fx.workspaceId, harnessSlug: harness }));
    const lifecycle = await read();
    expect(gate(lifecycle).satisfied).toBe(true);
    expect(JSON.stringify(critics)).toBe(originalReceipt);
    expect(gate(lifecycle, 3).satisfied, 'a stricter current reviewer policy must still apply').toBe(false);
    for (const [key, value] of [['behavior', 'A materially different contract.'],
      ['falsifier', { observation: 'A different invalid outcome is observed.' }],
      ['requiredEvidence', ['tree']]] as const) {
      const current = (await read())[0];
      await fx.admin.begin(tx => setSpecClause({ ...write, expectedRevision: current.revision,
        [key]: value, lifecycleStatus: 'active' },
      { executor: tx as never, workspaceId: fx.workspaceId, harnessSlug: harness }));
      expect(gate(await read())).toMatchObject({ satisfied: false, code: 'critique_stale' });
      expect(JSON.stringify(critics)).toBe(originalReceipt);
    }
  }, 120_000);

  it('partitions pass blocked waiting unknown and exempt stages without early return', async () => {
    const basis: ActivationReadinessBasis = { workspaceId: fx.workspaceId, harnessSlug: harness, planSlug: slug,
      planRevision: 1, planHash: 'hash', requesterId, policyHash: 'policy', specSetHash: 'spec', evidenceHash: 'proof' };
    const readers: ActivationReadinessReaders = { readBasis: async () => basis,
      stages: Object.fromEntries(ACTIVATION_STAGE_IDS.map(id => [id, async () => ({
        status: 'pass', codes: ['ready'], nextAction: 'Continue canonical start.' })])) };
    readers.stages.inputs = async () => ({ status: 'blocked', codes: ['missing_required'], nextAction: 'Supply target.' });
    readers.stages['bar-contract'] = async () => ({ status: 'unknown', codes: ['unavailable'], nextAction: 'Restore BAR read.' });
    readers.stages.anchors = async () => ({ status: 'not-applicable', codes: ['exempt'], nextAction: 'Retain exemption.' });
    const result = await collectActivationReadiness(readers);
    expect(new Set(result.stages.map(s => s.status))).toEqual(new Set(['pass', 'blocked', 'waiting', 'unknown', 'not-applicable']));
    expect(result.stages.find(s => s.id === 'quality-audit')).toMatchObject({ status: 'waiting', dependencies: ['spec-quality'] });
  });
});
