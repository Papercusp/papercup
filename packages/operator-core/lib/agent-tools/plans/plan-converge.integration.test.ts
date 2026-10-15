/** Recipe controls plus real PostgreSQL evaluator/audit/certifier composition.
 * The condition-upsert integration suite separately exercises the actual filing
 * writer, terminal replay, revision/workspace isolation and concurrent retries. */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setupPlanPgFixture, seedPlan, type PlanPgFixture } from './__tests__/_pg-tool-fixture';
import { setSpecClause } from './spec-clauses-store';
import evaluateTool from './evaluate-spec-test-adequacy';
import auditTool from './audit';
import certifyTool from './certify-spec-clauses';
import { validateRecipeBindings } from '../../recipe-contract';

// Only authoritative class metadata is fixed here. Clause/evidence reads and all
// three handlers use real production SQL against the isolated baseline database.
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
  });
  it('refuses partial audits, certification failures, invalid identity and unaccountable filings', async () => {
    const partial = controls([row()], { audit: { ok: true, partial: true, rejectedItemIds: ['P-003'] } });
    expect(await execute(partial.tools)).toMatchObject({ ok: false, phase: 'code-truth' });
    expect(partial.create).not.toHaveBeenCalled(); expect(partial.certify).not.toHaveBeenCalled();
    const cert = controls([row()], { certify: { ok: false, error: 'replay_failed' } });
    expect(await execute(cert.tools)).toMatchObject({ ok: false, phase: 'certify' });
    const identity = controls([row({ specRevision: 0 })]);
    expect(await execute(identity.tools)).toMatchObject({ ok: false, error: 'invalid_clause_identity' });
    const owner = controls([row()], { filed: { ok: true, results: [{ ok: true, workItem: { id: 'WI-unclaimed' } }] } });
    expect(await execute(owner.tools, { dryRun: false })).toMatchObject({ ok: false, phase: 'file' });
  });
});

describe('converge real PostgreSQL composition', () => {
  let fx: PlanPgFixture;
  const slug = 'converge-real-pg-fixture';
  const ctx = { isSuperuser: true, uiClientId: 'su-converge-pg', ownerId: 'su-converge-pg',
    workspaceId: 'default', harnessSlug: 'papercusp', log: () => {} } as never;
  beforeAll(async () => {
    fx = await setupPlanPgFixture();
    await seedPlan(fx.admin, fx.workspaceId, 'papercusp', slug,
      `---\nslug: ${slug}\ntitle: Converge fixture\nstatus: active\n---\n# Converge fixture\n\n## Tasks\n\n- **P-003** \`todo\` Reject unproved completion.\n`);
    const written = await setSpecClause({ harnessSlug: 'papercusp', planSlug: slug, specId: 'SPEC-UNBOUND',
      expectedRevision: 0, planItemId: 'P-003', behavior: 'Reject completion without measured proof.',
      behaviorClass: 'boundary', requiredEvidence: ['real PostgreSQL row'], requiredTestLayers: ['integration'],
      lifecycleStatus: 'active', acceptanceRef: 'fixture-accepted', actorId: 'su-converge-pg',
      falsifier: { observation: 'Unproved completion succeeds.', probeMethod: 'Attempt completion without proof.' } });
    expect(written.status).toBe('created');
  }, 120_000);
  afterAll(async () => { await fx?.dispose(); });
  it('reads a persisted unbound clause through all three real handlers and writes no gap in default preview', async () => {
    const call = async (tool: typeof evaluateTool | typeof auditTool | typeof certifyTool, args: Body) =>
      (await tool.handler(tool.args.parse(args) as never, ctx) as { data: Body }).data;
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
});
