import { describe, expect, it } from 'vitest';
import { worstMemberVerdict } from '@papercusp/release-profile';
import { rubricSuiteTemplateDataSchema } from '../plans/rubric-suite-template';
import { validateTemplateData } from '../plans/template-registry';
import { parsePlan } from '@papercusp/plan-parser';
import type { Rubric } from '../../rubrics';
import type { ScorecardRow } from '../../scorecards';
import type { withPlanLock } from '../plans/with-plan-lock';
import { writeRubricSuite, getRubricSuite, evaluateRubricSuite, readSuiteScorecardPage,
  listSuiteRubricsPage, StaleSuiteCursorError, SUITE_PAGE_SIZE, SUITE_MAX_PAGE_SIZE,
  SUITE_SCORECARD_PAGE_SIZE, readSuiteScorecardResult, readSuiteDefinitionPage, boundSuiteMemberResult, boundSuiteListResult,
  advanceRubricSuiteRun, type SuiteRunStore, type SuiteDeps, type SuiteCursor } from '../../rubric-suites';

const suite = {
  purpose: 'Check the behavior promised by the original plans',
  owner: 'su-accountable',
  members: [{ rubricRef: 'memory-intent' }],
  rescoreIntervalMs: 30 * 24 * 60 * 60_000,
};

describe('rubric suite data and aggregation', () => {
  it('registers suite data with the existing plan-template validator', () => {
    expect(validateTemplateData('rubric-suite', suite)).toEqual({ ok: true, data: suite });
  });

  it('round-trips all members without a membership cap', () => {
    for (const count of [99, 100, 101, 499, 500, 501, 1_501]) {
      const members = Array.from({ length: count }, (_, index) => ({ rubricRef: `rubric-${index}` }));
      expect(rubricSuiteTemplateDataSchema.parse({ ...suite, members }).members).toEqual(members);
    }
  });

  it('rejects duplicate identities and obsolete mandatory flags explicitly', () => {
    expect(rubricSuiteTemplateDataSchema.safeParse({ ...suite, members: [...suite.members, ...suite.members] }).success).toBe(false);
    expect(rubricSuiteTemplateDataSchema.safeParse({ ...suite, members: [{ rubricRef: 'memory-intent', mandatory: false }] }).success).toBe(false);
  });

  it('rejects an invalid identity intact instead of trimming it', () => {
    const parsed = rubricSuiteTemplateDataSchema.safeParse({ ...suite, members: [{ rubricRef: ' memory-intent ' }] });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]?.path).toEqual(['members', 0, 'rubricRef']);
  });

  it('keeps failure decisive in any order and unknown decisive over passing members', () => {
    expect(worstMemberVerdict(['pass', 'unknown', 'fail'])).toBe('fail');
    expect(worstMemberVerdict(['fail', 'pass', 'unknown'])).toBe('fail');
    expect(worstMemberVerdict(['pass', 'unknown', 'pass'])).toBe('unknown');
    expect(worstMemberVerdict(['unknown', 'unknown'])).toBe('unknown');
    expect(worstMemberVerdict(['pass', 'pass'])).toBe('pass');
  });

  it('does not turn an empty population into a passing verdict', () => {
    expect(worstMemberVerdict([])).toBe('unknown');
  });
});

const NOW = Date.parse('2026-11-16T12:00:00Z');
const scope = { workspaceId: 'suite-test', harnessSlug: 'papercusp' };
const rubric = (rubricId: string): Rubric => ({
  rubricId, workspaceId: scope.workspaceId, kind: 'standard', gradingAuthority: 'independent',
  characteristic: 'intent', title: rubricId, description: '', status: 'active', revision: 1,
  criteriaHash: 'current-criteria', criteria: [{ key: 'behavior', title: 'Behavior', model: 'When called it works', method: 'Measure behavior', driftMarkers: 'Fails' }],
  ratingScale: ['healthy', 'degraded', 'broken', 'unknown'], methodRef: null,
  createdBy: 'author', proposedBy: 'author', ratifiedBy: 'ratifier',
  createdAt: new Date(NOW - 1000).toISOString(), updatedAt: new Date(NOW - 1000).toISOString(),
});
const card = (rubricRef: string, rating = 'healthy', patch: Partial<ScorecardRow> = {}): ScorecardRow => ({
  issueId: `card-${rubricRef}`, rubricRef, rubricRevision: 1, criteriaHash: 'current-criteria',
  createdBy: 'independent', createdAt: new Date(NOW - 100).toISOString(),
  ratings: { behavior: { rating, evidence: 'Measured the promised behavior' } }, nKeys: 1,
  missingKeys: [], extraKeys: [], rubricResolved: true, synthesized: false, score10: null, linkedItems: [], ...patch,
});

/** One injected canonical plan seam, shared by the writer and every reader. */
function fixture() {
  const plans = new Map<string, { template: string; templateData: unknown; title: string; version: number; content: string }>();
  const rubrics = new Map<string, Rubric>();
  const histories = new Map<string, ScorecardRow[]>();
  const historyCursors: Array<{ before?: string; limit?: number }> = [];
  const writePlan: typeof withPlanLock = async (_ctx, opts, mutate) => {
    const prior = plans.get(opts.slug);
    const result = await mutate(prior?.content ?? null, prior ? {
      version: prior.version, contentHash: 'fixture-hash', templateData: prior.templateData,
      planStatus: 'draft', opStatus: null, inputSchema: null, outputSchema: null, nowNote: null,
    } : null, scope);
    const content = result.newBody ?? prior?.content ?? '';
    const parsed = parsePlan(content, { filePath: `${opts.slug}.md` });
    const version = (prior?.version ?? 0) + 1;
    plans.set(opts.slug, { content, version, template: parsed.frontmatter.template ?? '',
      title: parsed.frontmatter.title ?? opts.slug, templateData: result.templateData?.data ?? prior?.templateData });
    return { kind: 'applied', value: result.value, filePath: `${opts.slug}.md`, version, scope };
  };
  const deps: SuiteDeps = {
    readPlan: async slug => plans.get(slug) ?? null, writePlan,
    readRubric: async ref => rubrics.get(ref) ?? null,
    related: async (a, b) => a === b || b === 'author-child' || b === 'author-rebound',
    scorecardPage: async (filter = {}) => {
      historyCursors.push({ before: filter.before?.issueId, limit: filter.limit });
      const rows = histories.get(filter.rubricRef ?? '') ?? [];
      const start = filter.before ? rows.findIndex(row => row.issueId === filter.before?.issueId) + 1 : 0;
      const limit = filter.limit ?? 100;
      return { rows: rows.slice(start, start + limit), hasMore: start + limit < rows.length };
    },
  };
  const add = (ref: string, rating?: string) => { rubrics.set(ref, rubric(ref)); if (rating) histories.set(ref, [card(ref, rating)]); };
  const create = (ref = 'test-suite', refs = ['one']) => writeRubricSuite({ suiteRef: ref, create: true, name: 'Test suite', purpose: 'Check intent', owner: 'accountable', members: refs.map(rubricRef => ({ rubricRef })), rescoreIntervalMs: 1000 }, scope, {}, deps);
  const read = (ref = 'test-suite') => getRubricSuite(ref, scope, deps);
  const evaluate = (ref = 'test-suite') => evaluateRubricSuite(ref, scope, deps, NOW);
  const edit = (patch: Parameters<typeof writeRubricSuite>[0]) => writeRubricSuite(patch, scope, {}, deps);
  return { plans, rubrics, histories, historyCursors, deps, add, create, read, evaluate, edit };
}

/** Serializes every read/write so no process-local state survives a simulated restart. */
function runStoreFixture() {
  let serialized = '{}';
  const encode = (value: unknown) => JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);
  const key = (ref: string, scope: object) => JSON.stringify([ref, scope]);
  const store: SuiteRunStore = {
    create: async (ref, scope) => {
      const rows = JSON.parse(serialized); const id = Object.keys(rows).length + 1;
      rows[id] = { scope: key(ref, scope), value: null }; serialized = encode(rows); return id;
    },
    read: async (id, ref, scope) => {
      const row = JSON.parse(serialized)[id];
      if (!row || row.scope !== key(ref, scope)) throw new Error('plan_run_checkpoint_not_found');
      return row.value;
    },
    save: async (id, ref, scope, prior, next) => {
      const rows = JSON.parse(serialized); const row = rows[id];
      if (!row || row.scope !== key(ref, scope) || encode(row.value) !== encode(prior)) return false;
      row.value = next; serialized = encode(rows); return true;
    },
  };
  return store;
}

describe('durable suite evaluation', () => {
  it('resumes bounded history at N-1 N N+1 and many pages, including a decisive record after the boundary', async () => {
    for (const count of [499, 500, 501, 1501]) {
      const f = fixture(); const store = runStoreFixture(); f.add('one'); await f.create();
      await f.edit({ suiteRef: 'test-suite', rescoreIntervalMs: null });
      f.histories.set('one', Array.from({ length: count }, (_, i) => card('one', i === count - 1 ? 'broken' : 'healthy', {
        issueId: `history-${i}`, createdBy: i === count - 1 ? 'independent' : 'author-child', createdAt: new Date(NOW - i - 1).toISOString(),
      })));
      let result = await advanceRubricSuiteRun('test-suite', { scope, now: NOW }, { ...f.deps }, { ...store });
      let steps = 1;
      while (!result.scanComplete) {
        expect(result.go).toBe(false); expect(result.verdict).toBe('unknown'); expect(result.complete).toBe(false);
        const next = JSON.parse(JSON.stringify(result.next));
        result = await advanceRubricSuiteRun('test-suite', { scope, ...next }, { ...f.deps }, { ...store }); steps++;
      }
      expect(steps).toBe(2 * Math.ceil(count / SUITE_SCORECARD_PAGE_SIZE));
      expect(result.verdict).toBe('fail'); expect(result.go).toBe(false);
      expect(result.members[0].historyRead).toBe(count);
      expect(f.historyCursors.length).toBe(steps);
      expect(f.historyCursors.filter(c => c.before === undefined)).toHaveLength(2);
    }
  });

  it('detects changed early evidence in the verification pass and refuses stale history or suite scope', async () => {
    const f = fixture(); const store = runStoreFixture(); f.add('one', 'healthy'); f.add('two', 'healthy'); await f.create('verify-suite', ['one', 'two']);
    let result = await advanceRubricSuiteRun('verify-suite', { scope, now: NOW }, f.deps, store);
    result = await advanceRubricSuiteRun('verify-suite', { scope, runId: result.runId }, f.deps, store);
    f.histories.set('one', [card('one', 'broken')]);
    await expect(advanceRubricSuiteRun('verify-suite', { scope, runId: result.runId }, f.deps, store)).rejects.toBeInstanceOf(StaleSuiteCursorError);
    await expect(advanceRubricSuiteRun('verify-suite', { scope: { ...scope, harnessSlug: 'other' }, runId: result.runId }, f.deps, store)).rejects.toThrow('plan_run_checkpoint_not_found');
    f.plans.get('verify-suite')!.version++;
    await expect(advanceRubricSuiteRun('verify-suite', { scope, runId: result.runId }, f.deps, store)).rejects.toBeInstanceOf(StaleSuiteCursorError);
  });

  it('serializes concurrent resumes without losing or recounting a committed history page', async () => {
    const f = fixture(); const store = runStoreFixture(); f.add('one'); await f.create();
    f.histories.set('one', Array.from({ length: 1001 }, (_, i) => card('one', 'healthy', {
      issueId: `history-${i}`, createdBy: 'author', createdAt: new Date(NOW - i - 1).toISOString(),
    })));
    const first = await advanceRubricSuiteRun('test-suite', { scope, now: NOW }, f.deps, store);
    const resumes = await Promise.allSettled([0, 1].map(() => advanceRubricSuiteRun('test-suite', { scope, runId: first.runId }, f.deps, store)));
    expect(resumes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(resumes.find(r => r.status === 'rejected')).toMatchObject({ reason: expect.objectContaining({ message: expect.stringContaining('progress_conflict') }) });
    const resumed = await advanceRubricSuiteRun('test-suite', { scope, runId: first.runId }, f.deps, store);
    expect(resumed.scanComplete).toBe(false);
    expect(f.historyCursors.at(-1)?.before).toBe('history-999');
  });
  it('rejects completed run reads when their source evidence has changed', async () => {
    const f = fixture(); const store = runStoreFixture(); f.add('one', 'healthy'); await f.create();
    const first = await advanceRubricSuiteRun('test-suite', { scope, now: NOW }, f.deps, store);
    const final = await advanceRubricSuiteRun('test-suite', { scope, runId: first.runId }, f.deps, store);
    expect(final.go).toBe(true); expect(final.scanComplete).toBe(true);
    f.histories.set('one', [card('one', 'broken')]);
    await expect(advanceRubricSuiteRun('test-suite', { scope, runId: first.runId }, f.deps, store)).rejects.toBeInstanceOf(StaleSuiteCursorError);
  });
});

describe('canonical suite operations and acceptance', () => {
  it('follows byte-bounded list summaries to exhaustion without a false complete claim', async () => {
    const f = fixture(); const refs = Array.from({ length: 101 }, (_, i) => `list-${i}`);
    for (const ref of refs) f.add(ref); await f.create('list-suite', refs);
    let next: { offset: number; suiteVersion: number } | null = { offset: 0, suiteVersion: 1 };
    const seen: string[] = [];
    do {
      const raw = await listSuiteRubricsPage('list-suite', { ...next! }, scope, f.deps);
      const page: { rubrics: Array<{ rubricId: string; title: string }>; complete: boolean; next: { offset: number; suiteVersion: number } | null } = boundSuiteListResult({ ...raw, rubrics: raw.rubrics.map(r => ({ rubricId: r.rubricId, title: r.title })) }, next!.offset, 1000);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(1000);
      expect(page.complete).toBe(false); seen.push(...page.rubrics.map(r => r.rubricId));
      next = page.next ? JSON.parse(JSON.stringify(page.next)) : null;
    } while (next);
    expect(seen).toEqual(refs);
  });
  it('recovers the canonical definition after byte paging and rejects stale list membership', async () => {
    const f = fixture(); const refs = Array.from({ length: 101 }, (_, i) => `definition-${i}`);
    for (const ref of refs) f.add(ref); await f.create('definition-suite', refs);
    const seen: string[] = []; let cursor: SuiteCursor | undefined;
    do {
      const page = await readSuiteDefinitionPage('definition-suite', { scope, cursor, byteLimit: 1100, now: NOW }, { ...f.deps });
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(1100);
      seen.push(...page.members.map(m => m.rubricRef)); cursor = page.next ? JSON.parse(JSON.stringify(page.next)) : undefined;
    } while (cursor);
    expect(seen).toEqual(refs);
    const first = await listSuiteRubricsPage('definition-suite', { limit: 100 }, scope, f.deps);
    await f.edit({ suiteRef: 'definition-suite', members: [{ rubricRef: refs[0]! }] });
    await expect(listSuiteRubricsPage('definition-suite', { offset: first.nextOffset!, suiteVersion: first.snapshot }, scope, f.deps)).rejects.toBeInstanceOf(StaleSuiteCursorError);
  });
  it('recovers byte-bounded display pages while a late failure determines the aggregate', async () => {
    const f = fixture(); const refs = Array.from({ length: 31 }, (_, i) => `member-${i}`);
    for (const ref of refs) f.add(ref, ref === refs.at(-1) ? 'broken' : 'healthy'); await f.create('byte-suite', refs);
    const seen: string[] = []; let cursor: SuiteCursor | undefined;
    do {
      const page = await readSuiteScorecardResult('byte-suite', { scope, cursor, now: NOW, byteLimit: 1500 }, { ...f.deps });
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(1500);
      expect(page.verdict).toBe('fail'); expect(page.coverage.total).toBe(31);
      if (page.omitted) expect(page.complete).toBe(false);
      seen.push(...page.members.map(m => m.rubricRef));
      cursor = page.next ? JSON.parse(JSON.stringify(page.next)) : undefined;
    } while (cursor);
    expect(seen).toEqual(refs);
  });
  it('byte boundary preserves records at N-1 N N+1 and refuses an oversized identity intact', () => {
    const member = { rubricRef: 'one', verdict: 'pass' as const, reason: 'measured', scorecardRef: 'card-one', rubricRevision: 1, historyRead: 1, unreadable: 0 };
    const snapshot = { suiteRef: 'suite', scopeKey: 'scope', version: 1, comparisonTime: new Date(NOW).toISOString() };
    const two = boundSuiteMemberResult({ ok: true }, [member, { ...member, rubricRef: 'two' }, { ...member, rubricRef: 'tri' }], snapshot, 0, 4);
    const n = Buffer.byteLength(JSON.stringify({ ...two, returned: 2, omitted: 2, members: two.members.slice(0, 2), next: { ...snapshot, offset: 2 } }));
    for (const budget of [n - 1, n, n + 1]) {
      const page = boundSuiteMemberResult({ ok: true }, two.members, snapshot, 0, 4, budget);
      expect(page.returned).toBe(budget < n ? 1 : 2);
      expect(page.next?.offset).toBe(page.returned);
    }
    const identity = 'intact-' + 'x'.repeat(2000);
    expect(() => boundSuiteMemberResult({}, [{ ...member, rubricRef: identity }], snapshot, 0, 1, 500)).toThrow(identity);
  });
  it('refuses a continuation used for another suite or workspace', async () => {
    const f = fixture(); f.add('one'); f.add('two'); await f.create('a', ['one', 'two']); await f.create('b', ['one', 'two']);
    const page = await readSuiteScorecardPage('a', { scope, limit: 1, now: NOW }, f.deps);
    await expect(readSuiteScorecardPage('b', { scope, cursor: page.next! }, f.deps)).rejects.toBeInstanceOf(StaleSuiteCursorError);
    await expect(readSuiteScorecardPage('a', { scope: { ...scope, workspaceId: 'other' }, cursor: page.next! }, f.deps)).rejects.toBeInstanceOf(StaleSuiteCursorError);
  });
  it('rejects aggregate continuation when rubric or scorecard evidence changes between pages', async () => {
    const f = fixture(); f.add('one', 'healthy'); f.add('two', 'healthy'); await f.create('fresh-suite', ['one', 'two']);
    const first = await readSuiteScorecardResult('fresh-suite', { scope, limit: 1, now: NOW }, f.deps);
    f.histories.set('one', [card('one', 'broken')]);
    await expect(readSuiteScorecardResult('fresh-suite', { scope, cursor: first.next! }, f.deps)).rejects.toBeInstanceOf(StaleSuiteCursorError);
    const restarted = await readSuiteScorecardResult('fresh-suite', { scope, limit: 1, now: NOW }, f.deps);
    expect(restarted.verdict).toBe('fail'); f.rubrics.get('two')!.revision = (f.rubrics.get('two')!.revision ?? 0) + 1;
    await expect(readSuiteScorecardResult('fresh-suite', { scope, cursor: restarted.next! }, f.deps)).rejects.toBeInstanceOf(StaleSuiteCursorError);
  });
  it('keeps continuation stable when only read-time scorecard diagnostics change', async () => {
    const f = fixture(); f.add('one', 'healthy'); f.add('two', 'healthy'); await f.create('stable-suite', ['one', 'two']);
    const first = await readSuiteScorecardResult('stable-suite', { scope, limit: 1, now: NOW }, f.deps);
    const stored = f.histories.get('one')![0];
    stored.score10 = 9;
    stored.linkedItems = [{ rel: 'relates', dst: { kind: 'work-item', ref: 'WI-later-link' } }];
    stored.omittedActionCount = 7;
    const next = await readSuiteScorecardResult('stable-suite', { scope, cursor: JSON.parse(JSON.stringify(first.next)) }, { ...f.deps });
    expect(next.verdict).toBe('pass'); expect(next.members.map(m => m.rubricRef)).toEqual(['two']);
    expect(next.snapshot.sourceFingerprint).toBe(first.snapshot.sourceFingerprint);
  });
  it('maps ratings through the release rule independently of scale order or passRatings', async () => {
    const f = fixture(); f.add('one'); await f.create();
    f.rubrics.get('one')!.ratingScale = ['degraded', 'unknown', 'healthy'];
    f.rubrics.get('one')!.criteria[0].passRatings = ['degraded'];
    for (const [rating, verdict] of [[' GOOD ', 'pass'], ['exceptional', 'pass'], ['Unknown', 'unknown'], ['degraded', 'fail'], ['custom-best', 'fail']]) {
      f.histories.set('one', [card('one', rating)]);
      expect((await f.evaluate()).verdict).toBe(verdict);
    }
  });
  it('R-1 Suite verdict is the worst member verdict', async () => {
    const f = fixture(); for (const [ref, rating] of [['pass', 'healthy'], ['unknown', 'unknown'], ['fail', 'broken'], ['degraded', 'degraded']]) f.add(ref, rating);
    for (const refs of [['pass', 'unknown', 'fail'], ['fail', 'pass', 'unknown'], ['unknown', 'pass'], ['unknown'], ['pass'], ['pass', 'degraded']]) {
      const id = `mix-${refs.join('-')}`; await f.create(id, refs);
      expect((await f.evaluate(id)).verdict).toBe(refs.includes('fail') || refs.includes('degraded') ? 'fail' : refs.includes('unknown') ? 'unknown' : 'pass');
    }
  });
  it('R-6 Suite read returns the written members', async () => {
    const f = fixture(); f.add('one'); f.add('two'); await f.create();
    expect((await f.read())?.members).toEqual([{ rubricRef: 'one' }]);
    await f.edit({ suiteRef: 'test-suite', members: [{ rubricRef: 'two' }] });
    expect((await f.read())?.members).toEqual([{ rubricRef: 'two' }]);
  });
  it('persists member additions replacements and removals without retaining a removed failure', async () => {
    const f = fixture(); f.add('one', 'healthy'); f.add('two', 'broken'); await f.create();
    expect((await f.evaluate()).verdict).toBe('pass');
    await f.edit({ suiteRef: 'test-suite', members: [{ rubricRef: 'one' }, { rubricRef: 'two' }] });
    expect((await f.read())?.members).toEqual([{ rubricRef: 'one' }, { rubricRef: 'two' }]);
    expect((await f.evaluate()).verdict).toBe('fail');
    await f.edit({ suiteRef: 'test-suite', members: [{ rubricRef: 'two' }] });
    expect((await f.read())?.members).toEqual([{ rubricRef: 'two' }]);
    expect((await f.evaluate()).verdict).toBe('fail');
    await f.edit({ suiteRef: 'test-suite', members: [{ rubricRef: 'one' }] });
    expect((await f.read())?.members).toEqual([{ rubricRef: 'one' }]);
    expect((await f.evaluate()).verdict).toBe('pass');
    expect(f.histories.get('two')?.[0].ratings.behavior.rating).toBe('broken');
  });
  it('uses a failing criterion among passing criteria as the member verdict', async () => {
    const f = fixture(); f.add('one');
    f.rubrics.get('one')!.criteria.push({ ...f.rubrics.get('one')!.criteria[0], key: 'other' });
    const ratings = { behavior: { rating: 'healthy', evidence: 'Passing control' },
      other: { rating: 'healthy', evidence: 'Initially passing second criterion' } };
    f.histories.set('one', [card('one', 'healthy', { ratings, nKeys: 2 })]); await f.create();
    expect((await f.evaluate()).verdict).toBe('pass');
    ratings.other = { rating: 'broken', evidence: 'Decisive failing second criterion' };
    expect((await f.evaluate()).members[0].verdict).toBe('fail');
    expect((await f.evaluate()).verdict).toBe('fail');
  });
  it('keeps an old current scorecard eligible when the suite declares no rescore interval', async () => {
    const f = fixture(); f.add('one');
    f.histories.set('one', [card('one', 'healthy', { createdAt: new Date(NOW - 86_400_000).toISOString() })]);
    await f.create(); expect((await f.evaluate()).verdict).toBe('unknown');
    await f.edit({ suiteRef: 'test-suite', rescoreIntervalMs: null });
    expect((await f.read())?.rescoreIntervalMs).toBeNull();
    expect((await f.evaluate()).members[0].verdict).toBe('pass');
    expect((await f.evaluate()).verdict).toBe('pass');
  });
  it('refuses missing and retired members atomically on create and edit', async () => {
    const f = fixture(); f.add('one'); f.rubrics.set('retired', { ...rubric('retired'), status: 'retired' });
    await f.create(); const before = JSON.stringify([...f.plans]);
    for (const rubricRef of ['absent', 'retired']) {
      await expect(f.edit({ suiteRef: 'test-suite', members: [{ rubricRef }] })).rejects.toThrow();
      expect(JSON.stringify([...f.plans])).toBe(before);
      await expect(f.create(`invalid-${rubricRef}`, [rubricRef])).rejects.toThrow();
      expect(await f.read(`invalid-${rubricRef}`)).toBeNull();
      expect(JSON.stringify([...f.plans])).toBe(before);
    }
  });
  it('R-40 A rubric in two suites stays in both', async () => {
    const f = fixture(); f.add('shared', 'broken'); await f.create('suite-a', ['shared']); await f.create('suite-b', ['shared']);
    for (const ref of ['suite-a', 'suite-b']) { expect((await f.read(ref))?.members).toEqual([{ rubricRef: 'shared' }]); expect((await f.evaluate(ref)).verdict).toBe('fail'); }
  });
  it('R-41 List-by-suite read returns the active members', async () => {
    const f = fixture(); for (const ref of ['shared', 'removed', 'other']) f.add(ref);
    await f.create('suite-a', ['shared', 'removed']); await f.create('suite-b', ['shared', 'other']);
    await f.edit({ suiteRef: 'suite-a', members: [{ rubricRef: 'shared' }] });
    expect((await listSuiteRubricsPage('suite-a', {}, scope, f.deps)).rubrics.map(r => r.rubricId)).toEqual(['shared']);
  });
  it('R-41 List-by-suite excludes members of other suites', async () => {
    const f = fixture(); for (const ref of ['shared', 'only-a', 'only-b']) f.add(ref);
    await f.create('suite-a', ['shared', 'only-a']); await f.create('suite-b', ['shared', 'only-b']);
    expect((await listSuiteRubricsPage('suite-b', {}, scope, f.deps)).rubrics.map(r => r.rubricId)).toEqual(['shared', 'only-b']);
  });
  it('R-42 Suite scorecard read returns member and combined verdicts', async () => {
    const f = fixture(); for (const [ref, rating] of [['pass', 'healthy'], ['fail', 'broken'], ['degraded', 'degraded']]) f.add(ref, rating); f.add('ungraded');
    f.histories.set('fail', [card('fail', 'healthy', { issueId: 'author-new', createdBy: 'author-child', createdAt: new Date(NOW - 50).toISOString() }), card('fail', 'broken')]);
    await f.create('mixed-suite', ['pass', 'fail', 'degraded', 'ungraded']); const result = await f.evaluate('mixed-suite');
    expect(result.members.map(m => [m.rubricRef, m.verdict])).toEqual([['pass', 'pass'], ['fail', 'fail'], ['degraded', 'fail'], ['ungraded', 'unknown']]);
    expect(result.verdict).toBe('fail'); expect(result.go).toBe(false); expect(result.coverage).toEqual({ pass: 1, fail: 2, unknown: 1, total: 4 });
  });
  it('R-7 Ungraded members are reported, not dropped', async () => {
    const f = fixture(); for (const ref of ['missing', 'old-revision', 'aged']) f.add(ref);
    f.histories.set('old-revision', [card('old-revision', 'healthy', { rubricRevision: 0 })]);
    f.histories.set('aged', [card('aged', 'healthy', { createdAt: new Date(NOW - 1001).toISOString() })]);
    await f.create('unknown-suite', ['missing', 'old-revision', 'aged']); const result = await f.evaluate('unknown-suite');
    expect(result.members.map(m => m.verdict)).toEqual(['unknown', 'unknown', 'unknown']); expect(result.coverage).toEqual({ pass: 0, fail: 0, unknown: 3, total: 3 });
  });
  it('R-37 An empty suite is unknown', async () => {
    const f = fixture(); f.add('one', 'healthy'); await f.create(); await f.edit({ suiteRef: 'test-suite', members: [] });
    expect(await f.evaluate()).toMatchObject({ verdict: 'unknown', go: false }); await f.create('empty-suite', []); expect(await f.evaluate('empty-suite')).toMatchObject({ verdict: 'unknown', go: false });
  });
  it('R-34 Suites are plan-store records', async () => {
    const f = fixture(); f.add('one'); await f.create(); expect((await f.deps.readPlan('test-suite', scope))?.template).toBe('rubric-suite');
    expect(parsePlan(f.plans.get('test-suite')!.content, { filePath: 'test-suite.md' }).frontmatter.title).toBe('Test suite');
    await f.edit({ suiteRef: 'test-suite', name: 'Edited suite' }); expect((await f.deps.readPlan('test-suite', scope))?.title).toBe('Edited suite');
  });
  it('R-46 Suite metadata round-trips on create', async () => {
    const f = fixture(); f.add('one'); await f.create(); expect(await f.read()).toMatchObject({ name: 'Test suite', purpose: 'Check intent', owner: 'accountable', rescoreIntervalMs: 1000 });
  });
  it('R-46 Suite metadata edit round-trips', async () => {
    const f = fixture(); f.add('one'); await f.create(); await f.edit({ suiteRef: 'test-suite', name: 'Different name', purpose: 'Different purpose', owner: 'different-owner', rescoreIntervalMs: 2000 });
    expect(await f.read()).toMatchObject({ name: 'Different name', purpose: 'Different purpose', owner: 'different-owner', rescoreIntervalMs: 2000 });
  });
  it('R-46 Membership-only edit preserves suite metadata', async () => {
    const f = fixture(); f.add('one'); f.add('two'); await f.create(); const before = await f.read();
    await f.edit({ suiteRef: 'test-suite', members: [{ rubricRef: 'two' }] }); expect(await f.read()).toEqual({ ...before, version: before!.version + 1, members: [{ rubricRef: 'two' }] });
  });
  it('R-50 Canonical plan record is the sole suite membership source', async () => {
    const f = fixture(); f.add('one', 'healthy'); f.add('two', 'broken'); await f.create(); expect((await f.evaluate()).verdict).toBe('pass');
    const row = f.plans.get('test-suite')!; row.templateData = { ...suite, members: [{ rubricRef: 'two' }] }; row.version++;
    expect((await f.read())?.members).toEqual([{ rubricRef: 'two' }]); expect((await f.evaluate()).verdict).toBe('fail'); expect(f.rubrics.get('two')?.composes).toBeUndefined();
    expect((await evaluateRubricSuite('test-suite', scope, { ...f.deps, readPlan: async ref => f.plans.get(ref) ?? null }, NOW)).verdict).toBe('fail');
  });
  it('R-48 Suite consumers recover complete membership at N-1 N N+1 across permutations and restarts', async () => {
    for (const n of [SUITE_PAGE_SIZE, SUITE_MAX_PAGE_SIZE]) for (const count of [n - 1, n, n + 1, n * 3 + 1]) for (const reverse of [false, true]) {
      const f = fixture(); const refs = Array.from({ length: count }, (_, i) => `member-${i}`);
      for (const ref of refs) f.add(ref, ref === refs.at(-1) ? 'broken' : 'healthy'); if (reverse) refs.reverse(); await f.create('boundary-suite', refs);
      const collected: string[] = []; let cursor: SuiteCursor | undefined;
      do {
        const restored: SuiteCursor | undefined = cursor ? JSON.parse(JSON.stringify(cursor)) : undefined;
        const page = await readSuiteScorecardPage('boundary-suite', { scope, limit: n, cursor: restored, now: NOW }, { ...f.deps });
        expect(page.total).toBe(count); expect(page.returned + page.omitted + (restored?.offset ?? 0)).toBe(count);
        collected.push(...page.members.map(m => m.rubricRef)); cursor = page.next ?? undefined;
      } while (cursor);
      expect(collected).toEqual(refs); expect(new Set(collected).size).toBe(count); expect((await f.evaluate('boundary-suite')).verdict).toBe('fail');
      const first = await readSuiteScorecardPage('boundary-suite', { scope, limit: n, now: NOW }, f.deps);
      if (first.next) { f.plans.get('boundary-suite')!.version++; await expect(readSuiteScorecardPage('boundary-suite', { scope, cursor: first.next }, f.deps)).rejects.toBeInstanceOf(StaleSuiteCursorError); expect((await readSuiteScorecardPage('boundary-suite', { scope, now: NOW }, f.deps)).snapshot.version).toBe(2); }
    }
    for (const count of [SUITE_SCORECARD_PAGE_SIZE - 1, SUITE_SCORECARD_PAGE_SIZE, SUITE_SCORECARD_PAGE_SIZE + 1, SUITE_SCORECARD_PAGE_SIZE * 3 + 1]) {
      const f = fixture(); f.add('one'); await f.create(); f.histories.set('one', Array.from({ length: count }, (_, i) => card('one', i === count - 1 ? 'broken' : 'healthy', { issueId: `history-${i}`, createdBy: i === count - 1 ? 'independent' : i % 2 ? 'author-child' : 'author-rebound', createdAt: new Date(NOW - i - 1).toISOString() })));
      await f.edit({ suiteRef: 'test-suite', rescoreIntervalMs: null }); const result = await f.evaluate(); expect(result.verdict).toBe('fail'); expect(result.members[0].historyRead).toBe(count);
      expect(f.historyCursors.every(c => c.limit === SUITE_SCORECARD_PAGE_SIZE)).toBe(true); expect(f.historyCursors.length).toBe(Math.ceil(count / SUITE_SCORECARD_PAGE_SIZE));
    }
  });
  it('uses an older complete independent card when newer partial and author cards exist', async () => {
    const f = fixture(); f.add('one'); await f.create(); f.histories.set('one', [card('one', 'healthy', { issueId: 'partial', ratings: {}, missingKeys: ['behavior'] }), card('one', 'healthy', { issueId: 'author', createdBy: 'author' }), card('one', 'broken')]);
    expect((await f.evaluate()).verdict).toBe('fail'); f.histories.set('one', [card('one', 'healthy', { ratings: {}, missingKeys: ['behavior'] })]); expect((await f.evaluate()).verdict).toBe('unknown');
  });
  it('refuses invalid member refs, stale writes and duplicate identities atomically', async () => {
    const f = fixture(); f.add('one'); await f.create(); const before = JSON.stringify([...f.plans]);
    for (const input of [{ members: [{ rubricRef: 'absent' }] }, { members: [{ rubricRef: 'one' }, { rubricRef: 'one' }] }, { expectedVersion: 9, purpose: 'stale edit' }]) { await expect(f.edit({ suiteRef: 'test-suite', ...input })).rejects.toThrow(); expect(JSON.stringify([...f.plans])).toBe(before); }
  });
  it('reports missing rubrics and unreadable history instead of dropping members', async () => {
    const f = fixture(); f.add('one'); await f.create(); f.rubrics.delete('one'); const missing = await f.evaluate(); expect(missing.coverage).toEqual({ pass: 0, fail: 0, unknown: 1, total: 1 }); expect(missing.complete).toBe(false);
    f.add('one', 'healthy'); const result = await evaluateRubricSuite('test-suite', scope, { ...f.deps, scorecardPage: async () => { throw new Error('unreadable'); } }, NOW); expect(result.verdict).toBe('unknown'); expect(result.complete).toBe(false);
  });
  it('rejects a non-advancing history continuation explicitly', async () => {
    const f = fixture(); f.add('one', 'healthy'); await f.create(); const result = await evaluateRubricSuite('test-suite', scope, { ...f.deps, scorecardPage: async () => ({ rows: [card('one')], hasMore: true }) }, NOW); expect(result.verdict).toBe('unknown'); expect(result.members[0].reason).toContain('did_not_advance');
  });
});
