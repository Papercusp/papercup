import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { setupPlanPgFixture, type PlanPgFixture } from '../agent-tools/plans/__tests__/_pg-tool-fixture';
import { readNativePushOutcomes } from './native-adoption';
import { getRegisteredInstrument } from '../rubric-instrument-registry';
import { resolveScorecardInstrumentSnapshots } from '../scorecards';
import type { Rubric } from '../rubrics';
import { collectRecordedReuseWindows, evaluateReuseProvider, measureReuseMetrics, measureReuseWindow, readRecordedReuseWindows,
  measureRecordedReuseMetric, REUSE_MEASUREMENT_INSTRUMENT_KEYS,
  reuseHoldout, summarizeReuseWindows, type ReuseMeasuredWindow, type ReuseMeasurementActivity,
  type ReuseMeasurementExposure } from './reuse-measurement';
import { composeReuseBrief } from './reuse-brief-providers';
import { recordReuseBriefIssued } from './reuse-brief-ledger';

const at = '2026-10-01T00:00:00.000Z', now = '2026-10-01T00:31:00.000Z';
const exposure = (patch: Partial<ReuseMeasurementExposure> = {}): ReuseMeasurementExposure => ({
  id: 'e1', workspaceId: 'default', owner: 'owner', invocation: 'invocation', workItem: 'WI-1', provider: 'clones',
  at, issued: true, clientReceipt: null, selector: { paths: ['a.ts'], symbols: ['targetSymbol'] }, ...patch,
});
const activity = (patch: Partial<ReuseMeasurementActivity> = {}): ReuseMeasurementActivity => ({
  id: 'a1', workspaceId: 'default', owner: 'owner', at: '2026-10-01T00:01:00.000Z', tool: 'Read', status: 'ok', detail: { file: 'a.ts' }, ...patch,
});
const measure = (activities: ReuseMeasurementActivity[] = [], patch: Partial<ReuseMeasurementExposure> = {}, complete = true) =>
  measureReuseWindow({ exposure: exposure(patch), activities, now, activityCensusComplete: complete });

describe('R16 provider-specific recorded outcome windows', () => {
  it('pins independently precomputed provider/work-item hash cohorts across retries', () => {
    expect(reuseHoldout('WI-8', 'clones')).toBe(true);
    expect(reuseHoldout('WI-1', 'clones')).toBe(false);
    expect(reuseHoldout('WI-8', 'coverage')).toBe(false);
    expect(reuseHoldout('WI-12', 'coverage')).toBe(true);
    expect(() => measure([], { workItem: 'WI-8' })).toThrow('held-out');
  });
  it('partitions acted-on, not-acted-on and unknown without counting issuance as delivery', () => {
    const positive = measure([activity()]);
    const negative = measure([activity({ detail: { file: 'unrelated.ts' } })], { id: 'e2' });
    const unknown = measure([], { id: 'e3' }, false);
    expect(summarizeReuseWindows([positive, negative, unknown]).clones).toEqual({ issued: 3, delivered: 0, deliveryUnknown: 3,
      actedOn: { positive: 1, negative: 1, unknown: 1 }, grepAfterPush: { positive: 0, negative: 2, unknown: 1 } });
    expect(measure([], { clientReceipt: { ref: 'client-receipt:1', observedAt: now } }).delivered).toBe(true);
  });
  it.each(['clones', 'cochange', 'provenance', 'sql', 'coverage', 'semantic', 'grep', 'first-touch'])(
    'uses the declared selector for %s grep outcomes', provider => {
      expect(measure([activity({ tool: 'Grep', detail: { pattern: 'targetSymbol' } })], { provider }).grepAfterPush).toBe(true);
      expect(measure([activity({ tool: 'Grep', detail: { pattern: 'otherSymbol' } })], { provider }).grepAfterPush).toBe(false);
    });
  it('bounds the window to twenty invocations before the thirty-minute limit', () => {
    const activities = Array.from({ length: 21 }, (_, i) => activity({ id: String(i).padStart(2, '0'),
      at: new Date(Date.parse(at) + (i + 1) * 1_000).toISOString(), detail: { file: i === 20 ? 'a.ts' : 'other.ts' } }));
    const result = measure(activities);
    expect(result.endedBy).toBe('invocations');
    expect(result.end).toBe('2026-10-01T00:00:20.000Z');
    expect(result.activityIds).toHaveLength(20);
    expect(result.actedOn).toBe(false);
    expect(measure([activity({ at: '2026-10-01T00:30:01.000Z' })]).actedOn).toBe(false);
  });
  it('leaves open, missing, malformed and truncated activity unknown; preserves positives', () => {
    expect(measureReuseWindow({ exposure: exposure(), activities: [], now: at, activityCensusComplete: true }).actedOn).toBeNull();
    expect(measure([activity({ detail: null })]).actedOn).toBeNull();
    expect(measure([activity({ truncated: true })]).actedOn).toBeNull();
    expect(measure([activity({ detail: null }), activity({ id: 'a2' })]).actedOn).toBe(true);
    expect(measure([activity({ tool: 'Grep', detail: { pattern: '(target|other)' } })]).grepAfterPush).toBeNull();
    expect(measure([activity({ tool: 'Bash', detail: { command: "rg 'target.*' ." } })]).grepAfterPush).toBeNull();
  });
  it('anchors absolute paths to the activity harness and isolates unrelated owners', () => {
    const a = activity({ harness: 'fixture', detail: { file_path: '/fixture/a.ts' }, tool: 'mcp__papercusp_su__capability_read' });
    expect(measure([a]).actedOn).toBeNull();
    expect(measureReuseWindow({ exposure: exposure(), activities: [a], now, activityCensusComplete: true,
      repoRoots: new Map([['fixture', '/fixture']]) }).actedOn).toBe(true);
    expect(measure([activity({ owner: 'someone-else' })]).actedOn).toBe(false);
    expect(measure([activity({ workspaceId: 'foreign' })]).actedOn).toBe(false);
  });
  it('deduplicates evidence and refuses conflicting identities', () => {
    const w = measure([activity(), activity()]);
    expect(w.activityIds).toEqual(['a1']);
    expect(summarizeReuseWindows([w, w]).clones.issued).toBe(1);
    expect(() => measure([activity(), activity({ detail: null })])).toThrow('Conflicting');
    expect(() => summarizeReuseWindows([w, { ...w, actedOn: false }])).toThrow('Conflicting');
  });
  it('uses numeric invocation identity to break timestamp ties before applying the cap', () => {
    const rows = Array.from({ length: 21 }, (_, i) => activity({ id: String(i + 1),
      detail: { file: i === 20 ? 'a.ts' : 'other.ts' } }));
    const w = measure(rows.reverse());
    expect(w.activityIds).toEqual(Array.from({ length: 20 }, (_, i) => String(i + 1)));
    expect(w.actedOn).toBe(false);
  });
});

describe('R16 frozen measurement units and efficacy', () => {
  it('measures exact units and keeps unresolved populations separate', () => {
    expect(measureReuseMetrics({ addedNonGeneratedLines: 200, duplicateAddedLines: 10, lineCensusComplete: true,
      callCensusComplete: true, workItems: [
        { id: 'a', eligible: true, firstWriteAt: now, successfulSearchAt: at, complete: true },
        { id: 'b', eligible: true, firstWriteAt: at, successfulSearchAt: now, complete: true },
        { id: 'c', eligible: true, firstWriteAt: null, successfulSearchAt: null, complete: false },
      ], calls: [{ id: '1', resolved: true, from: 'a', to: 'b' }, { id: '2', resolved: true, from: 'a', to: 'a' },
        { id: '3', resolved: false, from: 'a', to: null }] })).toMatchObject({
      redundancy: { value: 50, numerator: 10, denominator: 200 }, searchBeforeWrite: { value: 0.5, unknown: 1 },
      crossFileCalls: { value: 0.5, denominator: 2, unknown: 1 },
    });
    expect(measureReuseMetrics({ addedNonGeneratedLines: 0, duplicateAddedLines: 0, lineCensusComplete: true,
      callCensusComplete: true, workItems: [], calls: [] }).redundancy.value).toBeNull();
  });
  const population = (treatment: boolean, holdout: boolean): ReuseMeasuredWindow[] => {
    const windows: ReuseMeasuredWindow[] = [];
    for (let i = 0, t = 0, h = 0; t < 100 || h < 100; i++) {
      const workItem = `WI-${i}`, held = reuseHoldout(workItem, 'clones');
      if (held ? h >= 100 : t >= 100) continue;
      const w = measure([], { id: `e${i}`, workItem, issued: !held });
      w.actedOn = w.grepAfterPush = held ? holdout : treatment;
      windows.push(w); if (held) h++; else t++;
    }
    return windows;
  };
  const evaluate = (windows: ReuseMeasuredWindow[], patch = {}) => evaluateReuseProvider({ provider: 'clones',
    workspaceId: 'default', experimentStartedAt: at, now: '2026-10-16T00:00:00.000Z', windows, ...patch });
  it('disables only a mature ineffective population and retains a mature beneficial population', () => {
    const disabled = evaluate(population(false, true));
    expect(disabled).toMatchObject({ mature: true, confidence: 'measured', action: 'disable', reversible: true });
    expect(disabled.arms.treatment.actedOn.interval!.upper).toBeLessThan(disabled.arms.holdout.actedOn.interval!.lower);
    expect(evaluate(population(true, false))).toMatchObject({ mature: true, action: 'keep' });
    const mixed = population(false, true).map(w => ({ ...w, grepAfterPush: !w.holdout }));
    expect(evaluate(mixed).action).toBe('keep');
  });
  it('refuses disabling on immature, unknown, stale or foreign populations', () => {
    const windows = population(false, true);
    expect(evaluate(windows, { now: '2026-10-02T00:00:00.000Z' })).toMatchObject({ mature: false, action: 'keep', confidence: 'unknown' });
    expect(evaluate(windows.map(w => ({ ...w, actedOn: null })))).toMatchObject({ mature: false, action: 'keep' });
    expect(evaluate(windows, { now: '2026-11-01T00:00:00.000Z' }).mature).toBe(false);
    expect(evaluate(windows, { workspaceId: 'foreign' }).mature).toBe(false);
    expect(evaluate([...windows, ...windows]).arms.treatment.actedOn.observed).toBe(100);
    expect(() => evaluate(windows.map(w => ({ ...w, holdout: !w.holdout })))).toThrow('cohort');
  });
});

describe('R16 repeatable existing-ledger reads', () => {
  let fx: PlanPgFixture;
  beforeAll(async () => { fx = await setupPlanPgFixture({ isolated: true }); }, 180_000);
  afterAll(async () => { await fx?.dispose(); });
  it('repeats the same scoped result without changing issued rows or coercing unknowns', async () => {
    const window = measure([activity()], { workspaceId: fx.workspaceId });
    const subject = JSON.stringify({ schema: 'reuse-measurement-v1', sourceRefs: ['fixture:known-activity-population'],
      observation: { exposure: exposure({ workspaceId: fx.workspaceId }), activities: [activity()], now, activityCensusComplete: true } });
    await fx.admin`INSERT INTO harness_shared.code_intel_pushes
      (workspace_id, owner_id, turn_id, leg, subject, chars, pushed_at)
      VALUES (${fx.workspaceId}, 'owner', 'fixture-turn', 'reuse-measurement', ${subject}, 0, ${at}),
        (${fx.workspaceId}, 'owner', 'fixture-turn', 'reuse-clones', 'issued-only', 100, ${at})`;
    const input = { workspaceId: fx.workspaceId, start: at, end: now };
    const first = await readRecordedReuseWindows(fx.admin, input), second = await readRecordedReuseWindows(fx.admin, input);
    expect(first).toEqual([window]); expect(second).toEqual(first);
    expect(summarizeReuseWindows(first)).toEqual(summarizeReuseWindows(second));
    expect(await readRecordedReuseWindows(fx.admin, { ...input, workspaceId: 'foreign' })).toEqual([]);
    const rows = await fx.admin`SELECT chars FROM harness_shared.code_intel_pushes WHERE workspace_id = ${fx.workspaceId} ORDER BY id`;
    expect(rows.map(r => r.chars)).toEqual([0, 100]);
    const issued = await readNativePushOutcomes({ workspaceId: fx.workspaceId, windowStart: at, windowEnd: now }, fx.admin);
    expect(issued.map(r => r.leg)).toEqual(['reuse-clones']);
    // Changing the RAW event changes the recomputed outcome; replaying a stored
    // verdict would keep the old positive and fail this assertion.
    const altered = JSON.parse(subject);
    altered.observation.activities[0].detail.file = 'unrelated.ts';
    await fx.admin`UPDATE harness_shared.code_intel_pushes SET subject = ${JSON.stringify(altered)}
      WHERE workspace_id = ${fx.workspaceId} AND leg = 'reuse-measurement'`;
    expect((await readRecordedReuseWindows(fx.admin, input))[0]!.actedOn).toBe(false);
  });
  it('registered instruments recompute exact-window raw populations with explicit ledger units', async () => {
    const scope = { workspaceId: fx.workspaceId, harnessSlug: 'fixture', windowStart: at, windowEnd: now };
    expect((await measureRecordedReuseMetric(fx.admin, scope, 'redundancy')).verdict).toBe('unknown');
    const record = { schema: 'reuse-metrics-v1', harness: 'fixture', windowStart: at, windowEnd: now,
      sourceRefs: ['fixture:line-changes', 'fixture:tool-invocations', 'fixture:resolved-calls'], population: {
        addedNonGeneratedLines: 200, duplicateAddedLines: 10, lineCensusComplete: true, callCensusComplete: true,
        workItems: [{ id: 'a', eligible: true, firstWriteAt: now, successfulSearchAt: at, complete: true }],
        calls: [{ id: 'a', resolved: true, from: 'a.ts', to: 'b.ts' }],
      } };
    await fx.admin`INSERT INTO harness_shared.code_intel_pushes
      (workspace_id, owner_id, turn_id, leg, subject, chars)
      VALUES (${fx.workspaceId}, 'metric-fixture', 'turn', 'reuse-metrics', ${JSON.stringify(record)}, 0)`;
    for (const metric of ['redundancy', 'searchBeforeWrite', 'crossFileCalls'] as const) {
      const instrument = getRegisteredInstrument(REUSE_MEASUREMENT_INSTRUMENT_KEYS[metric]);
      expect(instrument?.evaluator).toBe('platform');
      if (instrument?.evaluator !== 'platform') throw new Error('Missing registered metric');
      const result = await instrument.rescore!.resolve(scope);
      expect(result).toMatchObject({ verdict: 'pass', value: metric === 'redundancy' ? 50 : 100 });
      expect(instrument.rescore!.unit).toBe(metric === 'redundancy' ? 'count' : '%');
    }
    const rubric = { ref: 'reuse-measurement-fixture', workspaceId: fx.workspaceId,
      subjectPlan: 'reuse-metrics-fixture', subjectHarnessSlug: 'fixture',
      criteria: Object.values(REUSE_MEASUREMENT_INSTRUMENT_KEYS)
        .map(key => ({ key, check: { kind: 'instrument', instrumentKey: key } })) } as unknown as Rubric;
    const subject = { kind: 'plan', ref: 'reuse-metrics-fixture', windowStart: at, windowEnd: now } as const;
    const snapshots = await resolveScorecardInstrumentSnapshots({ rubric, subject }, { now: () => Date.parse(now) });
    expect(snapshots?.[REUSE_MEASUREMENT_INSTRUMENT_KEYS.redundancy]).toMatchObject({
      verdict: 'pass', provenance: 'platform-computed', value: { quantity: 50, unit: 'count' } });
    expect(snapshots?.[REUSE_MEASUREMENT_INSTRUMENT_KEYS.searchBeforeWrite]).toMatchObject({
      verdict: 'pass', value: { quantity: 100, unit: '%' } });
    const unscoped = await resolveScorecardInstrumentSnapshots({ rubric: { ...rubric, subjectHarnessSlug: undefined }, subject },
      { now: () => Date.parse(now) });
    expect(unscoped?.[REUSE_MEASUREMENT_INSTRUMENT_KEYS.redundancy]?.verdict).toBe('unknown');
    expect((await measureRecordedReuseMetric(fx.admin, { ...scope, harnessSlug: 'other' }, 'redundancy')).verdict).toBe('unknown');
    expect((await measureRecordedReuseMetric(fx.admin, { ...scope, windowEnd: '2026-10-02T00:00:00.000Z' }, 'redundancy')).verdict).toBe('unknown');
    record.population.duplicateAddedLines = 20;
    await fx.admin`UPDATE harness_shared.code_intel_pushes SET subject = ${JSON.stringify(record)}
      WHERE workspace_id = ${fx.workspaceId} AND leg = 'reuse-metrics'`;
    expect((await measureRecordedReuseMetric(fx.admin, scope, 'redundancy')).value).toBe(100);
  });
  it('collects actual composition, push and activity rows for both arms; recollection updates raw evidence without duplicate outcomes', async () => {
    const owner = 'live-collector-fixture', start = '2026-10-03T00:00:00.000Z', end = '2026-10-03T00:31:00.000Z';
    const context = { surface: 'claim' as const, workspaceId: fx.workspaceId, owner,
      invocation: 'controlled-collector-dispatch', workItem: 'WI-12', paths: ['clones.ts', 'coverage.ts'],
      sourceVersion: 'controlled-source-v1', repository: { workspaceId: fx.workspaceId, rootPath: '/fixture', harness: 'collector-fixture' } };
    const composed = await composeReuseBrief({ base: { mandatory: 'retained', advice: [] as string[] }, context,
      deadline: Date.now() + 6000, enabled: async () => true,
      append: (base, contribution) => ({ ...base, advice: [...base.advice, contribution.text] }),
      providers: (['clones', 'coverage'] as const).map(id => ({ id, read: async () => ({ status: 'measured' as const,
        sourceVersion: context.sourceVersion, indexVersion: 'controlled-index', lines: [`${id}.ts:1 candidate`], citedPaths: [`${id}.ts`] }) })) });
    expect(composed.observations.map(row => row.status)).toEqual(['issued', 'held-out']);
    await fx.admin`INSERT INTO harness_shared.identity_hook_turns (workspace_id, owner_id, turn_id)
      VALUES (${fx.workspaceId}, ${owner}, 'collector-turn')`;
    expect(await recordReuseBriefIssued({ context, observations: composed.observations,
      recover: { tool: 'work_items:get', args: { id: 'WI-12' } } }, new AbortController().signal)).toBe(true);
    await fx.admin`UPDATE harness_shared.code_intel_pushes SET pushed_at = ${start}::timestamptz
      WHERE workspace_id = ${fx.workspaceId} AND owner_id = ${owner}`;
    const insertActivity = async (tool: string, detail: object, suffix: string, activityOwner = owner) => fx.admin`
      INSERT INTO harness_shared.agent_activity (workspace_id, owner_id, harness_slug, kind, phase, tool_name, status, detail, created_at)
      VALUES (${fx.workspaceId}, ${activityOwner}, 'collector-fixture', 'tool', 'post', ${tool}, 'ok',
        ${JSON.stringify(detail)}::jsonb, ${`2026-10-03T00:0${suffix}:00.000Z`}::timestamptz)`;
    await insertActivity('Read', { file_path: '/fixture/clones.ts' }, '1');
    await insertActivity('Grep', { pattern: 'coverage.ts' }, '2');
    await insertActivity('Read', { file: 'coverage.ts' }, '3', 'foreign-owner');
    const scope = { workspaceId: fx.workspaceId, harnessSlug: 'collector-fixture', start, end, now: end,
      repoRoots: new Map([['collector-fixture', '/fixture']]) };
    const first = await collectRecordedReuseWindows(fx.admin, scope);
    expect(first.rejected).toEqual([]);
    expect(first.recorded).toHaveLength(2);
    expect(first.windows.find(w => w.exposure.provider === 'clones')).toMatchObject({ issued: true, holdout: false,
      delivered: null, actedOn: true, grepAfterPush: null, complete: false });
    expect(first.windows.find(w => w.exposure.provider === 'coverage')).toMatchObject({ issued: false, holdout: true,
      delivered: null, actedOn: null, grepAfterPush: true, complete: false });
    expect((await collectRecordedReuseWindows(fx.admin, scope)).recorded).toEqual([]);
    expect(await readRecordedReuseWindows(fx.admin, scope)).toEqual(first.windows);
    expect((await collectRecordedReuseWindows(fx.admin, { ...scope, harnessSlug: 'foreign' })).windows).toEqual([]);
    const largeDetail = Array.from({ length: 160 }, (_, i) => createHash('sha256').update(`activity-${i}`).digest('hex')).join('');
    await insertActivity('Read', { file: 'coverage.ts', retainedDiagnostic: largeDetail }, '4');
    await collectRecordedReuseWindows(fx.admin, scope);
    const latest = await readRecordedReuseWindows(fx.admin, scope);
    expect(latest).toHaveLength(2);
    expect(latest.find(w => w.exposure.provider === 'coverage')!.actedOn).toBe(true);
    const raw = await fx.admin`SELECT subject, suggested_call, chars FROM harness_shared.code_intel_pushes
      WHERE workspace_id = ${fx.workspaceId} AND owner_id = ${owner} AND leg = 'reuse-measurement' ORDER BY id DESC LIMIT 1`;
    expect(raw[0]!.chars).toBe(0);
    expect(raw[0]!.subject.length).toBeLessThan(256);
    expect(JSON.parse(raw[0]!.suggested_call).sourceRefs).toContainEqual(expect.stringMatching(/^agent-activity:\d+$/));
    const instrument = getRegisteredInstrument(REUSE_MEASUREMENT_INSTRUMENT_KEYS.providerOutcomes);
    if (instrument?.evaluator !== 'platform') throw new Error('Missing provider outcome instrument');
    const live = await instrument.rescore!.resolve({ workspaceId: fx.workspaceId, harnessSlug: 'collector-fixture',
      windowStart: start, windowEnd: end });
    expect(live.verdict).toBe('unknown'); // Four providers have no exposure census.
    const detail = JSON.parse(live.detail!);
    expect(detail.byProvider.coverage).toMatchObject({ issued: 0, deliveryUnknown: 1,
      actedOn: { positive: 1, negative: 0, unknown: 0 }, grepAfterPush: { positive: 1 } });
    expect(detail.notObserved.sort()).toEqual(['cochange', 'provenance', 'semantic', 'sql']);
    expect(detail.recommendations.every((r: { action: string; mature: boolean }) => r.action === 'keep' && !r.mature)).toBe(true);
    await fx.admin`UPDATE harness_shared.code_intel_pushes SET suggested_call = suggested_call || ' '
      WHERE workspace_id = ${fx.workspaceId} AND id = (SELECT max(id) FROM harness_shared.code_intel_pushes
        WHERE workspace_id = ${fx.workspaceId} AND owner_id = ${owner} AND leg = 'reuse-measurement')`;
    await expect(readRecordedReuseWindows(fx.admin, scope)).rejects.toThrow('payload digest mismatch');
  });
});
