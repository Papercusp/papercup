import { describe, expect, it } from 'vitest';
import type { SymbolSite } from './contracts';
import { preregister, type AnswerKey, type ArmCapabilities, type FairCase } from './fair-comparison';
import { guardedArm, type FairArm } from './fair-comparison-arms';
import { preregMismatch, runArm, scoreRuns } from './fair-comparison-run';

const cases: FairCase[] = [
  { id: 'c-callers', intent: 'callers', subject: 'f', tags: [], source: 'authored' },
  { id: 'c-def', intent: 'definition', subject: 'f', tags: [], source: 'authored' },
];
const keys: AnswerKey[] = [
  { caseId: 'c-callers', sites: ['a.ts:3'], aliases: {}, rejected: [], neutral: ['a.ts:1'] },
  { caseId: 'c-def', sites: ['a.ts:1'], aliases: {}, rejected: [], neutral: [] },
];
const capsA: ArmCapabilities = { armId: 'arm-a', version: '1', intents: ['callers', 'definition'], licence: 'first-party' };
const capsB: ArmCapabilities = { armId: 'arm-b', version: '2', intents: ['callers'], licence: 'permissive' };
const prereg = preregister({ cases, keys, arms: [capsA, capsB], reps: 3, seed: 7 });
const site = (k: string): SymbolSite => ({ path: k.split(':')[0]!, line1: Number(k.split(':')[1]), kind: null });

function fakeArm(caps: ArmCapabilities, answers: Record<string, string[]>, opts: { indexOk?: boolean; asked?: string[] } = {}): FairArm & { closed: () => boolean } {
  let closed = false;
  const arm = guardedArm({
    capabilities: caps,
    unavailable: null,
    index: async () => ({ wallMs: 1, peakRssKb: null, ok: opts.indexOk ?? true, error: opts.indexOk === false ? 'boom' : null, loadAvg1: null }),
    ask: async (k) => {
      opts.asked?.push(k.id);
      return { sites: (answers[k.id] ?? []).map(site), error: null };
    },
    close: async () => {
      closed = true;
    },
  });
  return Object.assign(arm, { closed: () => closed });
}

describe('preregistration is enforced before an arm runs', () => {
  it('refuses an unregistered arm, a changed version or intent set, and a changed corpus', () => {
    expect(preregMismatch({ ...capsA, armId: 'other' }, cases, prereg)).toMatch(/not in preregistration/);
    expect(preregMismatch({ ...capsA, version: '9' }, cases, prereg)).toMatch(/version/);
    expect(preregMismatch({ ...capsA, intents: ['callers'] }, cases, prereg)).toMatch(/intents differ/);
    expect(preregMismatch(capsA, cases.slice(0, 1), prereg)).toMatch(/corpus differs/);
    expect(preregMismatch(capsA, [...cases].reverse(), prereg)).toBeNull();
  });
  it('runArm throws on a mismatch instead of producing answers', async () => {
    await expect(runArm(fakeArm({ ...capsA, version: '9' }, {}), cases, prereg)).rejects.toThrow(/run refused/);
  });
  it('rejects changed same-id corpus and budget before indexing or querying', async () => {
    const asked: string[] = [];
    const arm = fakeArm(capsA, {}, { asked });
    const changed = [{ ...cases[0]!, subject: 'different', language: 'go' }, cases[1]!];
    await expect(runArm(arm, changed, prereg)).rejects.toThrow(/corpus semantics/);
    await expect(runArm(arm, cases, { ...prereg, budgets: { ...prereg.budgets, rssMbMax: 999 } }))
      .rejects.toThrow(/budget differs/);
    expect(asked).toEqual([]);
    expect(arm.closed()).toBe(false);
  });
});

describe('runArm', () => {
  it('indexes once, answers every case once per rep in a seeded order, and closes the arm', async () => {
    const asked: string[] = [];
    const arm = fakeArm(capsA, { 'c-callers': ['a.ts:3'] }, { asked });
    const run = await runArm(arm, cases, prereg, () => 't');
    expect(run.reps.map((r) => r.rep)).toEqual([1, 2, 3]);
    expect(run.reps.every((r) => r.answers.length === cases.length)).toBe(true);
    expect(asked).toHaveLength(6);
    expect(run.preregHash).toBe(prereg.hash);
    expect(arm.closed()).toBe(true);
    const again: string[] = [];
    await runArm(fakeArm(capsA, {}, { asked: again }), cases, prereg);
    expect(again).toEqual(asked);
  });
  it('a failed index yields no reps (reported, never scored as wrong)', async () => {
    const run = await runArm(fakeArm(capsA, {}, { indexOk: false }), cases, prereg);
    expect(run.index?.ok).toBe(false);
    expect(run.reps).toEqual([]);
  });
});

describe('scoreRuns', () => {
  it('refuses reinterpreting saved answers with a changed question, seed key or budget', async () => {
    const run = await runArm(fakeArm(capsA, {}), cases, prereg);
    expect(() => scoreRuns([run], [{ ...cases[0]!, subject: 'changed' }, cases[1]!], keys, {}, prereg))
      .toThrow(/corpus semantics changed/);
    expect(() => scoreRuns([run], cases, [{ ...keys[0]!, sites: [] }, keys[1]!], {}, prereg))
      .toThrow(/seed answer key changed/);
    expect(() => scoreRuns([run], cases, keys, {}, { ...prereg, budgets: { ...prereg.budgets, rssMbMax: 999 } }))
      .toThrow(/changed preregistration content or budget/);
  });
  it('lists every unadjudicated site with the arms that named it, and stays inconclusive', async () => {
    const a = await runArm(fakeArm(capsA, { 'c-callers': ['a.ts:3', 'b.ts:9'], 'c-def': ['a.ts:1'] }), cases, prereg);
    const b = await runArm(fakeArm(capsB, { 'c-callers': ['b.ts:9', 'c.ts:2'] }), cases, prereg);
    const scored = scoreRuns([a, b], cases, keys, {}, prereg);
    expect(scored.pending).toEqual([{ caseId: 'c-callers', sites: ['b.ts:9', 'c.ts:2'], namedBy: { 'b.ts:9': ['arm-a', 'arm-b'], 'c.ts:2': ['arm-b'] } }]);
    expect(scored.decision.kind).toBe('inconclusive');
  });
  it('applies recorded verdicts so the pooled key credits the arm that found a new valid site', async () => {
    const a = await runArm(fakeArm(capsA, { 'c-callers': ['a.ts:3', 'b.ts:9'], 'c-def': ['a.ts:1'] }), cases, prereg);
    const b = await runArm(fakeArm(capsB, { 'c-callers': ['a.ts:3'] }), cases, prereg);
    const scored = scoreRuns([a, b], cases, keys, { 'c-callers': [{ site: 'b.ts:9', verdict: 'valid', note: 'a real caller' }] }, prereg);
    expect(scored.pending).toEqual([]);
    expect(scored.keys.find((k) => k.caseId === 'c-callers')?.sites).toEqual(['a.ts:3', 'b.ts:9']);
    const f1 = (id: string) => scored.aggregates.find((x) => x.armId === id);
    expect(f1('arm-a')).toBeDefined();
    expect(f1('arm-b')).toBeDefined();
  });
  it('refuses runs made under another preregistration', async () => {
    const other = preregister({ cases, keys, arms: [capsA, capsB], reps: 3, seed: 8 });
    const a = await runArm(fakeArm(capsA, {}), cases, other);
    expect(() => scoreRuns([a], cases, keys, {}, prereg)).toThrow(/another preregistration/);
  });
  it('refuses two runs of the same arm, so a superseded run is never scored beside its rerun', async () => {
    const failed = await runArm(fakeArm(capsA, { 'c-def': ['a.ts:1'] }), cases, prereg);
    const rerun = await runArm(fakeArm(capsA, { 'c-def': ['a.ts:1'], 'c-callers': ['a.ts:3'] }), cases, prereg);
    const b = await runArm(fakeArm(capsB, {}), cases, prereg);
    expect(() => scoreRuns([failed, b, rerun], cases, keys, {}, prereg)).toThrow(/more than one run for arm\(s\) arm-a/);
    // Control: the same runs with the superseded one removed score normally.
    expect(scoreRuns([b, rerun], cases, keys, {}, prereg).aggregates.filter((x) => x.armId === 'arm-a')).toHaveLength(1);
  });
});
