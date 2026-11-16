import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setupPlanPgFixture, registerHarnessProject, type PlanPgFixture } from '../plans/__tests__/_pg-tool-fixture';
import getPlanTool from '../plans/get';
import getTemplateDataTool from '../plans/get-template-data';
import getInputSchemaTool from '../plans/get-input-schema';
import { getPlanRow } from '../plans/source';
import { getRubricSuite, writeRubricSuite, listSuiteRubricsPage, advanceRubricSuiteRun } from '../../rubric-suites';
import { insertPlanRun, readPlanRunCheckpoint, compareAndSetPlanRunCheckpoint } from '../plans/runs';
import { runWithWorkspaceIfConcrete } from '../../workspace-als';
import { rubricSuiteTemplateDataSchema } from '../plans/rubric-suite-template';
import type { Rubric } from '../../rubrics';

let fx: PlanPgFixture;
const harnesses = ['zzz-suite-canonical-a', 'zzz-suite-canonical-b'] as const;
const member = (rubricId: string): Rubric => ({
  rubricId, workspaceId: fx.workspaceId, kind: 'standard', gradingAuthority: 'independent',
  characteristic: 'intent', title: rubricId, description: '', criteria: [],
  ratingScale: ['healthy', 'broken', 'unknown'], methodRef: null, status: 'active',
  createdBy: 'author', proposedBy: 'author', ratifiedBy: 'ratifier',
  createdAt: '2026-11-16T00:00:00Z', updatedAt: '2026-11-16T00:00:00Z',
});
// Only rubric lookup is substituted. Suite writes, row reads and plans:get use
// the production plan store and the app role against an isolated migrated DB.
const deps = { readRubric: async (ref: string) => ref === 'missing' ? null : member(ref) };
const scope = (harnessSlug: string) => ({ workspaceId: fx.workspaceId, harnessSlug });
const context = (harnessSlug: string) => ({
  ...scope(harnessSlug), role: 'su', isSuperuser: true,
  signal: new AbortController().signal, log: vi.fn(), progress: vi.fn(), emit: vi.fn(),
});

beforeAll(async () => {
  fx = await setupPlanPgFixture({ isolated: true });
  for (const harness of harnesses) await registerHarnessProject(fx.admin, fx.workspaceId, harness);
}, 120_000);
afterAll(async () => { await fx?.dispose(); });

describe('rubric suites through the canonical plan store', () => {
  it('resumes a suite scan from persisted plan-run output after JSONB round-trip', async () => {
    const suiteRef = 'persisted-progress';
    await writeRubricSuite({ suiteRef, create: true, purpose: 'Durable progress', owner: 'accountable',
      members: [{ rubricRef: 'ungraded' }] }, scope(harnesses[0]), {}, deps);
    const evidence = { ...deps, scorecardPage: async () => ({ rows: [], hasMore: false }) };
    const first = await advanceRubricSuiteRun(suiteRef, { scope: scope(harnesses[0]) }, evidence);
    expect(first.scanComplete).toBe(false); expect(first.go).toBe(false);
    const resumed = await advanceRubricSuiteRun(suiteRef, { scope: scope(harnesses[0]), runId: first.runId }, { ...evidence });
    expect(resumed.scanComplete).toBe(true); expect(resumed.verdict).toBe('unknown');
    expect(resumed.members.map(m => m.rubricRef)).toEqual(['ungraded']);
    await expect(advanceRubricSuiteRun(suiteRef, { scope: scope(harnesses[1]), runId: first.runId }, evidence)).rejects.toThrow('suite_not_found');
  });

  it('commits exactly one concurrent checkpoint and enforces plan/harness/workspace custody', async () => {
    await runWithWorkspaceIfConcrete(fx.workspaceId, async () => {
      const custody = { planSlug: 'checkpoint-cas', harnessSlug: harnesses[0], sessionId: 'suite-checkpoint-fixture' };
      const runId = await insertPlanRun({ ...custody, planContentHash: 'fixture', note: null,
        launchedBy: 'test', title: 'Checkpoint CAS', status: 'idle' });
      expect(await readPlanRunCheckpoint(runId, custody)).toBeNull();
      const writes = await Promise.all([1, 2].map(step => compareAndSetPlanRunCheckpoint(runId, custody, null, { step })));
      expect(writes.filter(Boolean)).toHaveLength(1);
      const stored = await readPlanRunCheckpoint(runId, custody);
      expect(stored).toEqual({ step: writes[0] ? 1 : 2 });
      await expect(readPlanRunCheckpoint(runId, { ...custody, harnessSlug: harnesses[1] })).rejects.toThrow('checkpoint_not_found');
      expect(await compareAndSetPlanRunCheckpoint(runId, { ...custody, planSlug: 'other' }, stored, { step: 3 })).toBe(false);
      await runWithWorkspaceIfConcrete('other-workspace', async () => {
        await expect(readPlanRunCheckpoint(runId, custody)).rejects.toThrow('checkpoint_not_found');
      });
      expect(await readPlanRunCheckpoint(runId, custody)).toEqual(stored);
    });
  });

  it('R-34 Suites are plan-store records', async () => {
    const suiteRef = 'canonical-suite';
    const data = { purpose: 'Verify original intent', owner: 'accountable',
      members: [{ rubricRef: 'one' }], rescoreIntervalMs: 1000 };
    await writeRubricSuite({ suiteRef, create: true, name: 'Canonical suite', ...data }, scope(harnesses[0]), context(harnesses[0]), deps);
    const row = await getPlanRow(suiteRef, scope(harnesses[0]));
    expect(row).toMatchObject({ template: 'rubric-suite', templateData: data, title: 'Canonical suite' });
    expect(rubricSuiteTemplateDataSchema.parse(row!.templateData)).toEqual(data);
    const result = await getPlanTool.handler(getPlanTool.args.parse({ slug: suiteRef,
      harness: harnesses[0], mode: 'full', includeHistory: false, includeEnrichments: false }), context(harnesses[0]));
    expect(result).toHaveProperty('data.results');
    expect((result as { data: { results: unknown[] } }).data.results[0]).toMatchObject({
      ok: true, title: 'Canonical suite', frontmatter: { template: 'rubric-suite' },
    });
    const structured = await getTemplateDataTool.handler(getTemplateDataTool.args.parse({ slug: suiteRef,
      harness: harnesses[0] }), context(harnesses[0]));
    expect((structured as { data: { results: unknown[] } }).data.results[0]).toMatchObject({
      ok: true, template: 'rubric-suite', templateData: data,
    });
    const schema = await getInputSchemaTool.handler(getInputSchemaTool.args.parse({ slug: suiteRef,
      harness: harnesses[0] }), context(harnesses[0]));
    expect((schema as { data: { results: unknown[] } }).data.results[0]).toMatchObject({
      ok: true, source: 'template', template: 'rubric-suite', values: data,
      required: expect.arrayContaining(['purpose', 'owner', 'members']),
    });
    await writeRubricSuite({ suiteRef, name: 'Renamed', members: [{ rubricRef: 'two' }] }, scope(harnesses[0]), context(harnesses[0]), deps);
    expect(await getRubricSuite(suiteRef, scope(harnesses[0]))).toMatchObject({ name: 'Renamed',
      purpose: data.purpose, owner: data.owner, rescoreIntervalMs: 1000, members: [{ rubricRef: 'two' }] });
    const before = await getPlanRow(suiteRef, scope(harnesses[0]));
    await expect(writeRubricSuite({ suiteRef, members: [{ rubricRef: 'missing' }] }, scope(harnesses[0]), {}, deps)).rejects.toThrow('unknown_suite_member');
    expect(await getPlanRow(suiteRef, scope(harnesses[0]))).toEqual(before);
  });

  it('R-50 Canonical plan record is the sole suite membership source', async () => {
    const suiteRef = 'same-suite-slug';
    for (const [index, harness] of harnesses.entries()) {
      await writeRubricSuite({ suiteRef, create: true, purpose: 'Scoped intent', owner: 'accountable',
        members: [{ rubricRef: `member-${index}` }] }, scope(harness), context(harness), deps);
    }
    for (const [index, harness] of harnesses.entries()) {
      const page = await listSuiteRubricsPage(suiteRef, {}, scope(harness), deps);
      expect(page.rubrics.map(r => r.rubricId)).toEqual([`member-${index}`]);
    }
    const replacement = { purpose: 'Edited canonical source', owner: 'accountable', members: [{ rubricRef: 'replacement' }] };
    await fx.admin`UPDATE harness_shared.harness_plans SET template_data=${JSON.stringify(replacement)}::jsonb, version=version+1
      WHERE workspace_id=${fx.workspaceId} AND harness_slug=${harnesses[0]} AND plan_slug=${suiteRef}`;
    expect((await listSuiteRubricsPage(suiteRef, {}, scope(harnesses[0]), deps)).rubrics.map(r => r.rubricId)).toEqual(['replacement']);
    expect((await listSuiteRubricsPage(suiteRef, {}, scope(harnesses[1]), deps)).rubrics.map(r => r.rubricId)).toEqual(['member-1']);
    await expect(getRubricSuite(suiteRef, { ...scope(harnesses[0]), workspaceId: 'unrelated-workspace' })).rejects.toThrow(/workspace 'unrelated-workspace'/);
  });
});
