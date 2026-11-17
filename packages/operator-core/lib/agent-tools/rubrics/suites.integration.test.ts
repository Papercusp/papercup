import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setupPlanPgFixture, registerHarnessProject, type PlanPgFixture } from '../plans/__tests__/_pg-tool-fixture';
import getPlanTool from '../plans/get';
import getTemplateDataTool from '../plans/get-template-data';
import getInputSchemaTool from '../plans/get-input-schema';
import { getPlanRow } from '../plans/source';
import { getRubricSuite, writeRubricSuite, listSuiteRubricsPage, advanceRubricSuiteRun,
  SUITE_SCORECARD_PAGE_SIZE } from '../../rubric-suites';
import { insertPlanRun, readPlanRunCheckpoint, compareAndSetPlanRunCheckpoint,
  appendPlanRunTurn, getPlanRun, listPlanRuns, markPlanRunResumed, readPlanRunTranscript,
  setPlanRunOutputs, setPlanRunStatus, sweepPlanRuns, PLAN_RUN_IDLE_ARCHIVE_MS } from '../plans/runs';
import { runWithWorkspaceIfConcrete } from '../../workspace-als';
import { activeWorkspaceId } from '../../workspace-registry';
import { rubricSuiteTemplateDataSchema } from '../plans/rubric-suite-template';
import { proposeRubric, type Rubric } from '../../rubrics';

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
  async function lineageFixture(label: string, edges: Array<[string, string]>, grader: string, count = 3) {
    const author = `${label}-author`;
    const rubricRef = `rubric-${label}`;
    const rubric = await proposeRubric({ rubricId: rubricRef, characteristic: 'intent', title: rubricRef,
      status: 'active', by: author, criteria: [{ key: 'behavior', title: 'Behavior',
        model: 'Only a proven independent grader decides the suite.', method: 'Read the complete lineage census.',
        driftMarkers: 'A grader outside a bounded prefix is treated as independent.' }] });
    await writeRubricSuite({ suiteRef: label, create: true, purpose: 'Native lineage eligibility', owner: 'accountable',
      members: [{ rubricRef }] }, scope(harnesses[0]));
    await fx.admin`INSERT INTO harness_shared.tool_invocations ${fx.admin(edges.map(([from, to], index) => ({
      workspace_id: fx.workspaceId, harness_slug: harnesses[0], plugin_name: 'agentmcp',
      tool_name: 'coord:rebind-identity', role: 'su', spawn_id: `${label}-edge-${index}`,
      window_key: `${label}-edge-${index}`, status: 'ok', args_json: { from, to }, coord_owner_id: to,
    })))}`;
    const now = Date.now();
    const rows = Array.from({ length: count }, (_, index) => ({
      issue_id: `EI-${label}-${index}`, created_by: index === 0 ? grader : index === count - 1 ? `${label}-independent` : author,
      created_at: new Date(now - index - 1).toISOString(),
      payload: { observation: { rubricRef, rubricRevision: rubric.revision, criteriaHash: rubric.criteriaHash,
        ratings: { behavior: { rating: index === count - 1 ? 'broken' : 'healthy', evidence: 'Native lineage fixture' } } } },
    }));
    await fx.admin`INSERT INTO harness_shared.engineer_issues
      (workspace_id, issue_id, kind, scope, title, body, severity, source, state,
       payload, created_by, signal_origin, created_at, updated_at)
      SELECT ${fx.workspaceId}, issue_id, 'change', 'harness:papercusp', 'Native lineage fixture', '',
        'minor', 'test', 'done', payload, created_by, 'organic', created_at, created_at
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
        AS fixture(issue_id text, created_by text, created_at timestamptz, payload jsonb)`;
    return { rubricRef, now };
  }

  async function finishLineageScan(suiteRef: string, now: number) {
    let result = await advanceRubricSuiteRun(suiteRef, { scope: scope(harnesses[0]), now });
    for (let step = 1; !result.scanComplete; step++) {
      expect(step).toBeLessThan(12);
      expect(result.go).toBe(false); expect(result.verdict).toBe('unknown');
      result = await advanceRubricSuiteRun(suiteRef, { scope: scope(harnesses[0]),
        ...JSON.parse(JSON.stringify(result.next)) });
    }
    return result;
  }

  it.each([63, 64, 65])('requires a complete native lineage census at $0 hops', async hops => {
    await runWithWorkspaceIfConcrete(fx.workspaceId, async () => {
      const label = `native-lineage-hop-${hops}`;
      const node = (index: number) => index === 0 ? `${label}-author` : `${label}-node-${index}`;
      const edges: Array<[string, string]> = Array.from({ length: hops }, (_, index) => [node(index), node(index + 1)]);
      const { rubricRef, now } = await lineageFixture(label, edges, node(hops));
      const result = await finishLineageScan(label, now);
      if (hops <= 64) {
        expect(result.verdict).toBe('fail');
        expect(result.members).toEqual([expect.objectContaining({ rubricRef, historyRead: 3, unreadable: 0,
          scorecardRef: `EI-${label}-2` })]);
      } else {
        expect(result.verdict).toBe('unknown'); expect(result.go).toBe(false); expect(result.aggregateComplete).toBe(false);
        expect(result.members).toEqual([expect.objectContaining({ rubricRef, scorecardRef: null,
          reason: expect.stringContaining('acceptance_lineage_census_incomplete') })]);
        // A new scan re-reads the repaired canonical graph; an old unknown run
        // cannot silently become an independent proof after the frontier changes.
        await fx.admin`DELETE FROM harness_shared.tool_invocations WHERE workspace_id=${fx.workspaceId}
          AND spawn_id=${`${label}-edge-64`}`;
        const recovered = await finishLineageScan(label, now);
        expect(recovered.runId).not.toBe(result.runId);
        expect(recovered.verdict).toBe('pass'); expect(recovered.go).toBe(true);
        expect(recovered.members[0]).toMatchObject({ scorecardRef: `EI-${label}-0`, unreadable: 0 });
        await expect(advanceRubricSuiteRun(label, { scope: scope(harnesses[0]), runId: result.runId }))
          .rejects.toThrow('canonical suite changed');
      }
    });
  }, 120_000);

  it.each([1023, 1024, 1025])('requires a complete native lineage census of $0 identities', async count => {
    await runWithWorkspaceIfConcrete(fx.workspaceId, async () => {
      const label = `native-lineage-census-${count}`;
      const edges: Array<[string, string]> = Array.from({ length: count - 1 }, (_, index) =>
        [`${label}-author`, `${label}-node-${index}`]);
      const { now } = await lineageFixture(label, edges, `${label}-node-${count - 2}`);
      const result = await finishLineageScan(label, now);
      expect(result.verdict).toBe(count <= 1024 ? 'fail' : 'unknown'); expect(result.go).toBe(false);
      expect(result.aggregateComplete).toBe(count <= 1024);
      if (count === 1025) expect(result.members[0].reason).toContain('acceptance_lineage_census_incomplete');
      else expect(result.members[0]).toMatchObject({ scorecardRef: `EI-${label}-2`, unreadable: 0 });
    });
  }, 120_000);

  it('keeps blank native grader identities unknown until a new run reads repaired evidence', async () => {
    await runWithWorkspaceIfConcrete(fx.workspaceId, async () => {
      const label = 'native-lineage-blank';
      const { now } = await lineageFixture(label, [[`${label}-author`, `${label}-child`]], '   ');
      const result = await finishLineageScan(label, now);
      expect(result.verdict).toBe('unknown'); expect(result.go).toBe(false); expect(result.aggregateComplete).toBe(false);
      expect(result.members[0]).toMatchObject({ scorecardRef: null, unreadable: 1,
        reason: expect.stringContaining('grader identity is unavailable') });
      await fx.admin`UPDATE harness_shared.engineer_issues SET created_by=${`${label}-independent`}
        WHERE workspace_id=${fx.workspaceId} AND issue_id=${`EI-${label}-0`}`;
      const recovered = await finishLineageScan(label, now);
      expect(recovered.verdict).toBe('pass'); expect(recovered.go).toBe(true);
      expect(recovered.members[0]).toMatchObject({ scorecardRef: `EI-${label}-0`, unreadable: 0 });
    });
  }, 120_000);

  it('terminates cyclic native lineage and recovers the independent card after a history page and restart', async () => {
    await runWithWorkspaceIfConcrete(fx.workspaceId, async () => {
      const label = 'native-lineage-cycle';
      const { now } = await lineageFixture(label, [[`${label}-author`, `${label}-child`],
        [`${label}-child`, `${label}-author`]], `${label}-child`, 501);
      const result = await finishLineageScan(label, now);
      expect(result.verdict).toBe('fail'); expect(result.aggregateComplete).toBe(true);
      expect(result.members[0]).toMatchObject({ scorecardRef: `EI-${label}-500`, historyRead: 501, unreadable: 0 });
    });
  }, 120_000);

  it('refuses a retired native rubric member without changing the stored suite', async () => {
    await runWithWorkspaceIfConcrete(fx.workspaceId, async () => {
      const rubricRef = 'native-retired-member';
      await proposeRubric({ rubricId: rubricRef, characteristic: 'intent', title: rubricRef, status: 'retired',
        by: 'native-retired-author', criteria: [{ key: 'behavior', title: 'Behavior', model: 'Retired rubric',
          method: 'Read the native rubric status.', driftMarkers: 'A retired member is accepted.' }] });
      const suiteRef = 'native-retired-suite';
      await writeRubricSuite({ suiteRef, create: true, purpose: 'Refuse retired members atomically',
        owner: 'accountable', members: [] }, scope(harnesses[0]));
      const before = await getPlanRow(suiteRef, scope(harnesses[0]));
      await expect(writeRubricSuite({ suiteRef, members: [{ rubricRef }] }, scope(harnesses[0])))
        .rejects.toThrow('retired_suite_member');
      expect(await getPlanRow(suiteRef, scope(harnesses[0]))).toEqual(before);
      await expect(writeRubricSuite({ suiteRef: 'native-retired-create', create: true, purpose: 'Invalid create',
        owner: 'accountable', members: [{ rubricRef }] }, scope(harnesses[0])))
        .rejects.toThrow('retired_suite_member');
      expect(await getPlanRow('native-retired-create', scope(harnesses[0]))).toBeNull();
    });
  }, 120_000);

  // Criteria are a full JSON array in one canonical rubric record, not a
  // scorecard-history page. Exercise a large array through the actual reader
  // so a future reuse of the row-page limit cannot omit its decisive last key.
  it.each([499, 500, 501])('reads all $0 current native criteria before deciding the member verdict', async count => {
    await runWithWorkspaceIfConcrete(fx.workspaceId, async () => {
      const suiteRef = `native-criteria-${count}`;
      const rubricRef = `rubric-${suiteRef}`;
      const criteria = Array.from({ length: count }, (_, index) => ({ key: `criterion-${index}`, title: `Criterion ${index}`,
        model: 'Every current criterion is required.', method: 'Read the canonical criterion array.',
        driftMarkers: 'The final failing criterion is omitted.' }));
      const rubric = await proposeRubric({ rubricId: rubricRef, characteristic: 'intent', title: rubricRef,
        status: 'active', by: `${suiteRef}-author`, criteria });
      await writeRubricSuite({ suiteRef, create: true, purpose: 'Complete current criterion population',
        owner: 'accountable', members: [{ rubricRef }] }, scope(harnesses[0]));
      const now = Date.now();
      const ratings = Object.fromEntries(criteria.map((criterion, index) => [criterion.key,
        { rating: index === count - 1 ? 'broken' : 'healthy', evidence: 'Native criterion fixture' }]));
      await fx.admin`INSERT INTO harness_shared.engineer_issues
        (workspace_id, issue_id, kind, scope, title, body, severity, source, state,
         payload, created_by, signal_origin, created_at, updated_at)
        VALUES (${fx.workspaceId}, ${`EI-${suiteRef}`}, 'change', 'harness:papercusp', 'Native criteria fixture', '',
          'minor', 'test', 'done', ${JSON.stringify({ observation: { rubricRef, rubricRevision: rubric.revision,
            criteriaHash: rubric.criteriaHash, ratings } })}::jsonb, ${`${suiteRef}-independent`}, 'organic',
          ${new Date(now - 1).toISOString()}, ${new Date(now - 1).toISOString()})`;
      const result = await finishLineageScan(suiteRef, now);
      expect(result.verdict).toBe('fail'); expect(result.aggregateComplete).toBe(true);
      expect(result.members[0]).toMatchObject({ scorecardRef: `EI-${suiteRef}`, historyRead: 1, unreadable: 0 });
    });
  }, 120_000);

  it.each([499, 500, 501, 1501].flatMap(count => [false, true].map(reverse => ({ count, reverse }))))(
    'recovers native scorecard history across restarts (count=$count reverse=$reverse)', async ({ count, reverse }) => {
      await runWithWorkspaceIfConcrete(fx.workspaceId, async () => {
        const suiteRef = `native-history-${count}-${reverse}`;
        const rubricRef = `rubric-${suiteRef}`;
        const rubric = await proposeRubric({ rubricId: rubricRef, characteristic: 'intent', title: rubricRef,
          status: 'active', by: 'history-author', criteria: [{ key: 'behavior', title: 'Behavior',
            model: 'The canonical input population is complete.', method: 'Read the complete history.',
            driftMarkers: 'A late decisive card is omitted.' }] });
        await writeRubricSuite({ suiteRef, create: true, purpose: 'Native history recovery', owner: 'accountable',
          members: [{ rubricRef }] }, scope(harnesses[0]));
        const now = Date.now();
        const rows = Array.from({ length: count }, (_, index) => ({
          issue_id: `EI-${suiteRef}-${index}`, created_by: index === count - 1 ? 'history-independent' : 'history-author',
          created_at: new Date(now - index - 1).toISOString(),
          payload: { observation: { rubricRef, rubricRevision: rubric.revision, criteriaHash: rubric.criteriaHash,
            ratings: { behavior: { rating: index === count - 1 ? 'broken' : 'healthy', evidence: 'Native SQL population fixture' } } } },
        }));
        if (reverse) rows.reverse();
        await fx.admin`INSERT INTO harness_shared.engineer_issues
          (workspace_id, issue_id, kind, scope, title, body, severity, source, state,
           payload, created_by, signal_origin, created_at, updated_at)
          SELECT ${fx.workspaceId}, issue_id, 'change', 'harness:papercusp', 'Native history fixture', '',
            'minor', 'test', 'done', payload, created_by, 'organic', created_at, created_at
          FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
            AS fixture(issue_id text, created_by text, created_at timestamptz, payload jsonb)`;
        let result = await advanceRubricSuiteRun(suiteRef, { scope: scope(harnesses[0]), now });
        let steps = 1;
        while (!result.scanComplete) {
          expect(result.verdict).toBe('unknown'); expect(result.go).toBe(false);
          expect(result.complete).toBe(false); expect(result.omitted).toBe(1);
          // Recreate the caller solely from the serialized continuation. Production
          // plan_runs.outputs and the real SQL reader retain every history page.
          const next = JSON.parse(JSON.stringify(result.next));
          expect(next).toEqual({ runId: result.runId });
          result = await advanceRubricSuiteRun(suiteRef, { scope: scope(harnesses[0]), ...next });
          steps++;
          expect(steps).toBeLessThanOrEqual(2 * Math.ceil(count / SUITE_SCORECARD_PAGE_SIZE));
        }
        expect(steps).toBe(2 * Math.ceil(count / SUITE_SCORECARD_PAGE_SIZE));
        expect(result.verdict).toBe('fail'); expect(result.go).toBe(false);
        expect(result.complete).toBe(true); expect(result.omitted).toBe(0);
        expect(result.members).toEqual([expect.objectContaining({ rubricRef, verdict: 'fail', historyRead: count,
          scorecardRef: `EI-${suiteRef}-${count - 1}` })]);
        expect(await fx.admin`SELECT count(*)::int AS n FROM harness_shared.engineer_issues
          WHERE workspace_id=${fx.workspaceId} AND payload->'observation'->>'rubricRef'=${rubricRef}`)
          .toEqual([expect.objectContaining({ n: count })]);
      });
    }, 120_000);

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
      await appendPlanRunTurn({ planRunId: runId, role: 'assistant', content: 'Original workspace', costUsd: 1 });
      const originalRun = await getPlanRun(runId);
      await expect(readPlanRunCheckpoint(runId, { ...custody, harnessSlug: harnesses[1] })).rejects.toThrow('checkpoint_not_found');
      expect(await compareAndSetPlanRunCheckpoint(runId, { ...custody, planSlug: 'other' }, stored, { step: 3 })).toBe(false);
      await runWithWorkspaceIfConcrete('other-workspace', async () => {
        expect(activeWorkspaceId()).toBe('other-workspace');
        await expect(readPlanRunCheckpoint(runId, custody)).rejects.toThrow('checkpoint_not_found');
        expect(await compareAndSetPlanRunCheckpoint(runId, custody, stored, { step: 3 })).toBe(false);
        expect(await getPlanRun(runId)).toBeNull();
        expect(await setPlanRunOutputs(runId, { stolen: true })).toBe(false);
        await setPlanRunStatus(runId, 'archived');
        expect(await markPlanRunResumed(runId, 'foreign')).toEqual({ claimed: false });
        await expect(appendPlanRunTurn({ planRunId: runId, role: 'user', content: 'Foreign write' })).rejects.toThrow('plan_run_not_found');
        expect(await readPlanRunTranscript(custody.sessionId)).toEqual({ turns: [], nextCursor: null });
        expect(await listPlanRuns(custody.planSlug, { harnessSlug: custody.harnessSlug })).toEqual([]);
        await sweepPlanRuns(Date.now() + PLAN_RUN_IDLE_ARCHIVE_MS + 1000);
      });
      expect(await readPlanRunCheckpoint(runId, custody)).toEqual(stored);
      expect(await getPlanRun(runId)).toEqual(originalRun);
      // Even malformed historical child rows cannot contaminate this workspace's
      // transcript, sequence allocation or summary cost/count.
      await fx.admin`INSERT INTO harness_shared.plan_run_turns
        (workspace_id, plan_run_id, harness_slug, seq, role, content, cost_usd, created_at)
        VALUES ('other-workspace', ${runId}, ${custody.harnessSlug}, 99, 'user', 'Foreign child', 100, ${Date.now()})`;
      expect(await appendPlanRunTurn({ planRunId: runId, role: 'user', content: 'Local continuation', costUsd: 2 })).toBe(2);
      expect((await readPlanRunTranscript(custody.sessionId)).turns.map(turn => turn.content))
        .toEqual(['Original workspace', 'Local continuation']);
      expect(await listPlanRuns(custody.planSlug, { harnessSlug: custody.harnessSlug }))
        .toEqual([expect.objectContaining({ id: runId, turnCount: 2, costUsd: 3 })]);
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
