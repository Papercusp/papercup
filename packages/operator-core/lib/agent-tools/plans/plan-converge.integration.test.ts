/** Recipe controls plus real PostgreSQL evaluator/audit/certifier composition.
 * The condition-upsert integration suite separately exercises the actual filing
 * writer, terminal replay, revision/workspace isolation and concurrent retries. */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setupPlanPgFixture, seedPlan, type PlanPgFixture } from './__tests__/_pg-tool-fixture';
import { setSpecClause } from './spec-clauses-store';
import evaluateTool from './evaluate-spec-test-adequacy';
import auditTool from './audit';
import certifyTool from './certify-spec-clauses';
import { validateRecipeBindings } from '../../recipe-contract';
import { PAPERCUSP_WORKSPACE_ID } from '../../harness/papercusp-workspace';
import { bindSpecEvidence, measureAndPinRepoFilesEvidenceAtRoot } from './spec-evidence-store';
import { createOneWorkItem } from '../work_items/_create-core';
import { parseTestRunExecutionDetails, type TestRunExecutionDetails } from '@papercusp/test-config/execution-details';

// Fix external class/root metadata for the isolated baseline. Clause/evidence
// reads and all three handlers use their real production SQL and file measurers.
vi.mock('../../harness-registry', async original => ({
  ...(await original<typeof import('../../harness-registry')>()),
  loadHarnessRegistry: async () => ({ projects: [{ slug: 'papercusp',
    path: fileURLToPath(new URL('../../../../../', import.meta.url)) }] }),
}));
vi.mock('../../rubrics', async original => ({
  ...(await original<typeof import('../../rubrics')>()),
  getAcceptanceRubricsForPlan: async () => [{ rubricId: 'converge-acceptance', classRef: 'plan-class-feature-ship' }],
  getRetiredAcceptanceRubricsForPlan: async () => [],
}));
const script = readFileSync(new URL('./fixtures/plan-converge.recipe.txt', import.meta.url), 'utf8');
const bindingSchema = JSON.parse(readFileSync(new URL('./fixtures/plan-converge.bindings.json', import.meta.url), 'utf8'));
const auditItems = [{ itemId: 'P-003', verdict: 'implemented', citations: [
  { kind: 'test', path: 'packages/operator-core/lib/agent-tools/plans/plan-converge.integration.test.ts' },
] }];
type Body = Record<string, any>;
function execute(tools: Body, inputs: Body = {}) {
  const bindings = { values: { planSlug: 'converge-pg', harness: 'papercusp', classRef: 'plan-class-feature-ship', auditItems, ...inputs } };
  const checked = validateRecipeBindings({ schema: bindingSchema, bindings });
  if (!checked.ok) throw new Error(JSON.stringify(checked));
  return vm.runInNewContext(`(async () => {\n${script}\n})()`, { tools, inputs: checked.value.inputs }) as Promise<Body>;
}
function controls(rows: Body[], options: { audit?: Body; certify?: Body; filed?: Body } = {}) {
  const evaluate = vi.fn(async () => ({ ok: true, rows }));
  const audit = vi.fn(async () => options.audit ?? { ok: true });
  const certify = vi.fn(async () => options.certify ?? { ok: true, counts: { filed: 0 } });
  const create = vi.fn(async () => options.filed ?? { ok: true, results: [{ ok: true, id: 'WI-gap', workItem: { id: 'WI-gap', assignee: 'converge-owner' } }] });
  const tools = { plans: { evaluateSpecTestAdequacy: evaluate, audit, certifySpecClauses: certify },
    coord: { whoami: async () => ({ ownerId: 'converge-owner' }) }, workItems: { create } };
  return { tools, evaluate, audit, certify, create };
}
const row = (overrides: Body = {}) => ({ specId: 'SPEC-A', specRevision: 3, planItemId: 'P-003', verdict: 'unknown', wouldBlock: ['falsifiability'], ...overrides });

describe('converge recipe controls (not PostgreSQL proof)', () => {
  it('defaults to an actually executed read-only audit/certifier preview', async () => {
    const c = controls([row(), row({ specId: 'SPEC-PASS', verdict: 'pass', wouldBlock: [] })]);
    expect(await execute(c.tools)).toMatchObject({ ok: true, dryRun: true, nonPassing: 1,
      gaps: [{ classification: 'major', action: 'would-file' }] });
    expect(c.audit).toHaveBeenCalledWith(expect.objectContaining({ phase: 'completion', dryRun: true, items: auditItems }));
    expect(c.evaluate.mock.calls[0][0]).not.toHaveProperty('planItemIds');
    expect(c.certify).toHaveBeenCalledWith(expect.objectContaining({ specIds: ['SPEC-PASS'], dryRun: true }));
    expect(c.create).not.toHaveBeenCalled();
  });
  it('keeps critical/major/minor/outdated distinct and maps outdated to the existing issue vocabulary', async () => {
    for (const [blockers, verdict, classification, severity] of [
      [['falsifiability'], 'missing', 'critical', 'critical'],
      [['falsifiability'], 'implemented', 'major', 'major'],
      [['traceability'], 'implemented', 'minor', 'minor'],
      [['freshness'], 'implemented', 'outdated', 'minor'],
    ] as const) {
      const c = controls([row({ wouldBlock: [...blockers] })]);
      const result = await execute(c.tools, { dryRun: false, auditItems: [{ ...auditItems[0], verdict }] });
      expect(result).toMatchObject({ ok: true, gaps: [{ classification, severity, id: 'WI-gap' }] });
      expect(c.create).toHaveBeenCalledWith(expect.objectContaining({ severity, assign_to: 'converge-owner',
        conditionReplay: 'include-terminal', conditionKey: 'spec-gap:papercusp/converge-pg/SPEC-A@3',
        links: [{ rel: 'about', target_kind: 'plan', target_ref: 'converge-pg', target_harness: 'papercusp' }] }));
    }
  });
  it('does not certify passing tests when the reviewed implementation is incomplete', async () => {
    const c = controls([row({ verdict: 'pass', wouldBlock: [] })]);
    expect(await execute(c.tools, { dryRun: false, auditItems: [{ itemId: 'P-003', verdict: 'partial' }] }))
      .toMatchObject({ ok: true, nonPassing: 1, gaps: [{ blockers: ['code-truth'] }] });
    expect(c.certify).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    const stale = controls([row({ wouldBlock: ['freshness', 'falsifiability', 'plan-class-risk-floor'],
      ratings: { freshness: { rating: 'fail' } } })]);
    expect(await execute(stale.tools)).toMatchObject({ ok: true, gaps: [{ classification: 'outdated' }] });
    const unreviewed = controls([row({ planItemId: 'P-004', verdict: 'pass', wouldBlock: [] })]);
    expect(await execute(unreviewed.tools)).toMatchObject({ ok: true, nonPassing: 1, gaps: [{ blockers: ['code-truth'] }] });
  });
  it('refuses partial audits, certification failures, invalid identity and unaccountable filings', async () => {
    const partial = controls([row()], { audit: { ok: true, partial: true, rejectedItemIds: ['P-003'] } });
    expect(await execute(partial.tools)).toMatchObject({ ok: false, phase: 'code-truth' });
    expect(partial.create).not.toHaveBeenCalled(); expect(partial.certify).not.toHaveBeenCalled();
    const cert = controls([row()], { certify: { ok: false, error: 'replay_failed' } });
    expect(await execute(cert.tools)).toMatchObject({ ok: false, phase: 'certify' });
    const refused = controls([row()], { certify: { ok: true, counts: { refused: 1 } } });
    expect(await execute(refused.tools)).toMatchObject({ ok: false, phase: 'certify' });
    expect(refused.create).not.toHaveBeenCalled();
    const identity = controls([row({ specRevision: 0 })]);
    expect(await execute(identity.tools)).toMatchObject({ ok: false, error: 'invalid_clause_identity' });
    const owner = controls([row()], { filed: { ok: true, results: [{ ok: true, workItem: { id: 'WI-unclaimed' } }] } });
    expect(await execute(owner.tools, { dryRun: false })).toMatchObject({ ok: false, phase: 'file' });
    const links = controls([row()], { filed: { ok: true, results: [{ ok: true,
      workItem: { id: 'WI-unlinked', assignee: 'converge-owner' }, inlineLinkWarnings: ['link refused'] }] } });
    expect(await execute(links.tools, { dryRun: false })).toMatchObject({ ok: false, phase: 'file' });
  });
});

describe('converge real PostgreSQL composition', () => {
  let fx: PlanPgFixture;
  const slug = 'converge-real-pg-fixture';
  const ctx = { isSuperuser: true, uiClientId: 'su-converge-pg', ownerId: 'su-converge-pg',
    workspaceId: PAPERCUSP_WORKSPACE_ID, harnessSlug: 'papercusp', log: () => {}, metadata: () => {} } as never;
  const call = async (tool: typeof evaluateTool | typeof auditTool | typeof certifyTool, args: Body) =>
    (await tool.handler(tool.args.parse(args) as never, ctx) as { data: Body }).data;
  beforeAll(async () => {
    fx = await setupPlanPgFixture();
    // Operator-home scope intentionally resolves to PAPERCUSP_WORKSPACE_ID.
    // Seed that same key rather than the generic fixture's default workspace.
    await seedPlan(fx.admin, PAPERCUSP_WORKSPACE_ID, 'papercusp', slug,
      `---\nslug: ${slug}\ntitle: Converge fixture\nstatus: active\n---\n# Converge fixture\n\n## Tasks\n\n- **P-003** \`todo\` Reject unproved completion.\n`);
    await fx.admin`INSERT INTO harness_shared.plan_items
      (workspace_id, harness_slug, plan_slug, item_id, seq, item_text, status)
      VALUES (${PAPERCUSP_WORKSPACE_ID}, 'papercusp', ${slug}, 'P-003', 0, 'Reject unproved completion.', 'todo')
      ON CONFLICT (workspace_id, harness_slug, plan_slug, item_id) DO NOTHING`;
    const written = await setSpecClause({ harnessSlug: 'papercusp', planSlug: slug, specId: 'SPEC-UNBOUND',
      expectedRevision: 0, planItemId: 'P-003', behavior: 'Reject completion without measured proof.',
      behaviorClass: 'boundary', requiredEvidence: ['real PostgreSQL row'], requiredTestLayers: ['integration'],
      lifecycleStatus: 'active', acceptanceRef: 'fixture-accepted', actorId: 'su-converge-pg',
      falsifier: { observation: 'Unproved completion succeeds.', probeMethod: 'Attempt completion without proof.' } });
    expect(written.status).toBe('created');
  }, 120_000);
  afterAll(async () => { await fx?.dispose(); });
  it('reads a persisted unbound clause through all three real handlers and writes no gap in default preview', async () => {
    const evaluate = vi.fn((args: Body) => call(evaluateTool, args));
    const audit = vi.fn((args: Body) => call(auditTool, args));
    const certify = vi.fn((args: Body) => call(certifyTool, args));
    const create = vi.fn();
    const result = await execute({ plans: { evaluateSpecTestAdequacy: evaluate, audit, certifySpecClauses: certify },
      workItems: { create } }, { planSlug: slug });
    expect(result).toMatchObject({ ok: true, dryRun: true, evaluated: 1, nonPassing: 1,
      gaps: [{ specId: 'SPEC-UNBOUND', revision: 1, classification: 'major', action: 'would-file' }] });
    expect(audit).toHaveBeenCalledOnce(); expect(certify).toHaveBeenCalledOnce();
    expect(result.audit).toMatchObject({ preview: true, itemsAuditedThisPass: 1 });
    expect(result.certification.counts).toMatchObject({ clauses: 1, filed: 0, notPassing: 1 });
    expect(create).not.toHaveBeenCalled();
    const rows = await fx.admin`SELECT feature_id FROM harness_shared.work_items
      WHERE payload->'specConformanceGap'->>'planSlug' = ${slug}`;
    expect(rows).toHaveLength(0);
  }, 120_000);

  it('files only non-passing persisted clauses, preserves passing proof and reuses the exact revision on a second run', async () => {
    const root = fileURLToPath(new URL('../../../../../', import.meta.url));
    const testPath = 'packages/operator-core/lib/agent-tools/plans/plan-converge.integration.test.ts';
    const measurement = { schemaVersion: 1 as const, kind: 'repo-files' as const,
      sourcePaths: ['packages/operator-core/lib/agent-tools/plans/fixtures/plan-converge.recipe.txt'],
      testPaths: [testPath], fixturePaths: ['packages/operator-core/lib/agent-tools/plans/fixtures/plan-converge.bindings.json'] };
    const measured = await measureAndPinRepoFilesEvidenceAtRoot(root, measurement);
    // This ledger is fixture INPUT, not a claimed test run. Production evidence
    // reads must distinguish its pass/fail outcomes and stale measured bytes.
    await fx.admin`INSERT INTO harness_shared.work_items
      (feature_id, workspace_id, harness_slug, title, status, item_kind, payload, created_ts)
      VALUES ('WI-CONVERGE-PROOF', ${PAPERCUSP_WORKSPACE_ID}, 'papercusp', 'Proof fixture', 'open', 'feature', '{}', 0)`;
    for (const [specId, itemId, status, stale] of [
      ['SPEC-PASS', 'P-004', 'pass', false], ['SPEC-FAIL', 'P-005', 'fail', false],
      ['SPEC-STALE', 'P-006', 'pass', true],
    ] as const) {
      await fx.admin`INSERT INTO harness_shared.plan_items
        (workspace_id, harness_slug, plan_slug, item_id, seq, item_text, status)
        VALUES (${PAPERCUSP_WORKSPACE_ID}, 'papercusp', ${slug}, ${itemId}, ${Number(itemId.slice(2))}, ${specId}, 'todo')`;
      expect(await setSpecClause({ harnessSlug: 'papercusp', planSlug: slug, specId, expectedRevision: 0,
        planItemId: itemId, behavior: `Observe ${specId} through the real evaluator.`, behaviorClass: 'boundary',
        requiredEvidence: ['integration'], requiredTestLayers: ['integration'], lifecycleStatus: 'active',
        acceptanceRef: 'fixture-accepted', actorId: 'su-converge-pg',
        falsifier: { observation: 'The wrong proof outcome passes.', probeMethod: 'Read the persisted test outcome.' } }))
        .toMatchObject({ status: 'created' });
      const execution: TestRunExecutionDetails = { schemaVersion: 1, root, filePath: testPath,
        runGroupId: null, workspaceId: PAPERCUSP_WORKSPACE_ID, harnessSlug: 'papercusp',
        testNamePattern: null, testLayer: 'integration', mutationPhase: null, commitSha: null, worktreeDirty: false,
        ...(status === 'pass' ? { passedCaseTitles: ['persisted proof fixture'] } : { failedCaseTitles: ['persisted proof fixture'] }),
        passed: status === 'pass' ? 1 : 0, failed: status === 'fail' ? 1 : 0, skipped: 0, collectionFailed: false };
      // Validate fixtures with the very parser the evidence reader consumes;
      // incomplete status-only rows must never masquerade as passing proof.
      expect(parseTestRunExecutionDetails(execution)).toEqual(execution);
      const [run] = await fx.admin`INSERT INTO harness_shared.test_runs
        (workspace_id, harness_slug, file_path, framework, status, source, worktree_dirty, execution_details)
        VALUES (${PAPERCUSP_WORKSPACE_ID}, 'papercusp', ${testPath}, 'vitest', ${status}, 'local', false,
          ${JSON.stringify(execution)}::text::jsonb) RETURNING id`;
      await fx.admin`INSERT INTO harness_shared.test_case_runs (test_run_id, case_index, case_key, status)
        VALUES (${run.id}, 0, 'persisted proof fixture', ${status})`;
      const { pin: _pin, ...fingerprints } = measured;
      expect(await bindSpecEvidence({ harnessSlug: 'papercusp', planSlug: slug, specId,
        workItemId: 'WI-CONVERGE-PROOF', evidenceKind: 'test', evidenceRef: `test-run:${run.id}:${testPath}`,
        testRunId: Number(run.id), ...fingerprints,
        ...(stale ? { sourceFingerprint: 'deliberately-stale-source' } : {}), actorId: 'su-converge-pg',
        details: { currentMeasurement: measurement, adequacy: { fixtureCalibrated: true, falsifiable: true,
          pathReachable: true, oracleIndependent: true, collected: true, skipped: false, executed: true,
          outcome: 'passed', targeted: specId, testLayer: 'integration', testCases: ['persisted proof fixture'],
          coverageRungs: { l3: true } } } })).toMatchObject({ status: 'created' });
      if (status === 'pass') {
        // Seed the canonical negative-control leg as evaluator INPUT alongside
        // its passing baseline. A boolean attestation cannot make proof pass.
        const mutant: TestRunExecutionDetails = { ...execution, mutationPhase: 'mutant', passed: 0, failed: 1,
          passedCaseTitles: [], failedCaseTitles: ['persisted proof fixture'] };
        expect(parseTestRunExecutionDetails(mutant)).toEqual(mutant);
        const [red] = await fx.admin`INSERT INTO harness_shared.test_runs
          (workspace_id, harness_slug, file_path, framework, status, source, worktree_dirty, execution_details, output_tail)
          VALUES (${PAPERCUSP_WORKSPACE_ID}, 'papercusp', ${testPath}, 'vitest', 'fail', 'mutation-probe', false,
            ${JSON.stringify(mutant)}::text::jsonb, 'persisted proof fixture: expected true to be false') RETURNING id`;
        await fx.admin`INSERT INTO harness_shared.test_case_runs (test_run_id, case_index, case_key, status)
          VALUES (${red.id}, 0, 'persisted proof fixture', 'fail')`;
        expect(await bindSpecEvidence({ harnessSlug: 'papercusp', planSlug: slug, specId,
          workItemId: 'WI-CONVERGE-PROOF', evidenceKind: 'mutation', evidenceRef: `test-run:${red.id}:${testPath}`,
          testRunId: Number(red.id), ...fingerprints,
          ...(stale ? { sourceFingerprint: 'deliberately-stale-source' } : {}), actorId: 'su-converge-pg',
          details: { currentMeasurement: measurement, adequacy: { fixtureCalibrated: true,
            pathReachable: true, oracleIndependent: true, collected: true, skipped: false, executed: true,
            outcome: 'killed', targeted: specId, testLayer: 'integration', testCases: ['persisted proof fixture'] } } }))
          .toMatchObject({ status: 'created' });
      }
    }
    const reviewed = ['P-003', 'P-004', 'P-005', 'P-006'].map(itemId => ({
      ...auditItems[0], itemId, verdict: itemId === 'P-005' ? 'missing' : 'implemented',
    }));
    const create = vi.fn(async (args: Body) => {
      const result = await createOneWorkItem(args as never, ctx);
      return { ok: result.ok, results: [result.ok ? { ...result, id: result.workItem.id } : result] };
    });
    const tools = { plans: {
      evaluateSpecTestAdequacy: (args: Body) => call(evaluateTool, args),
      audit: (args: Body) => call(auditTool, args), certifySpecClauses: (args: Body) => call(certifyTool, args),
    }, coord: { whoami: async () => ({ ownerId: 'su-converge-pg' }) }, workItems: { create } };
    const evaluated = await call(evaluateTool, { harness: 'papercusp', slug, classRef: 'plan-class-feature-ship', detail: 'full' });
    const passing = evaluated.rows.find((entry: Body) => entry.specId === 'SPEC-PASS');
    expect(passing.verdict, JSON.stringify(passing.ratings)).toBe('pass');
    const preview = await execute(tools, { planSlug: slug, auditItems: reviewed });
    expect(preview, JSON.stringify(preview)).toMatchObject({ ok: true, dryRun: true, evaluated: 4, nonPassing: 3 });
    expect(create).not.toHaveBeenCalled();
    const first = await execute(tools, { planSlug: slug, auditItems: reviewed, dryRun: false });
    expect(first, JSON.stringify(first)).toMatchObject({ ok: true, nonPassing: 3 });
    expect(first.gaps.map((gap: Body) => gap.specId).sort()).toEqual(['SPEC-FAIL', 'SPEC-STALE', 'SPEC-UNBOUND']);
    expect(first.gaps.find((gap: Body) => gap.specId === 'SPEC-FAIL')).toMatchObject({ classification: 'critical' });
    expect(first.gaps.find((gap: Body) => gap.specId === 'SPEC-STALE')).toMatchObject({ classification: 'outdated' });
    const second = await execute(tools, { planSlug: slug, auditItems: reviewed, dryRun: false });
    expect(second, JSON.stringify(second)).toMatchObject({ ok: true });
    expect(second.gaps.map((gap: Body) => gap.id)).toEqual(first.gaps.map((gap: Body) => gap.id));
    const stored = await fx.admin`SELECT feature_id, taken_by, payload FROM harness_shared.work_items
      WHERE payload->'specConformanceGap'->>'planSlug' = ${slug}`;
    expect(stored).toHaveLength(3);
    expect(stored.every(item => item.taken_by === 'su-converge-pg')).toBe(true);
    const links = await fx.admin`SELECT count(*)::int AS count FROM harness_shared.coord_links
      WHERE workspace_id = ${PAPERCUSP_WORKSPACE_ID} AND src_ref IN ${fx.admin(stored.map(item => item.feature_id))}
        AND dst_kind = 'plan' AND dst_ref = ${slug} AND rel = 'about'`;
    expect(links[0].count).toBe(3);
  }, 120_000);
});
