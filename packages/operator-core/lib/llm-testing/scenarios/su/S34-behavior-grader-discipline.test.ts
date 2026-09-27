import { describe, expect, it } from 'vitest';
import type { RunSummary } from '@papercusp/testing-shell/llm';

import {
  makeS34World, S34_CASES, S34_CURRENT_KEYS, S34_GOAL, S34_RETIRED_KEY, S34_RUBRIC_REF, S34_RUBRIC_REVISION, S34_RUNS,
  s34BehaviorAssert, s34Evidence, SU_S34_BEHAVIOR_GRADER, type S34Case,
} from './S34-behavior-grader-discipline';

type Call = [tool: string, args: Record<string, unknown>];

/** Drive the REAL fixture world, then shape its receipts into a RunSummary, so the assert judges genuine world output. */
async function run(c: S34Case, calls: Call[], text = 'Verdicts submitted; see receipts.'): Promise<RunSummary> {
  const world = makeS34World(c);
  const outputs: string[] = [];
  for (const [tool, args] of calls) {
    const r = await world.override(tool, args) as { content: Array<{ text: string }> };
    outputs.push(r.content.map((p) => p.text).join('\n'));
  }
  return { turns: [{
    assistantText: text,
    toolCalls: calls.map(([name, input], responseIndex) => ({ name, input, responseIndex })),
    toolResults: outputs.map((output) => ({ output })),
  }] } as unknown as RunSummary;
}
const claims = async (c: S34Case, calls: Call[], text?: string) => s34BehaviorAssert(c).eval(await run(c, calls, text)).map((v) => v.claim);

const read: Call = ['goals:get', { id: S34_GOAL }];
const evidence = (runId: string): Call => ['goals:run-evidence', { goalId: S34_GOAL, runId }];
const allRatings = (overrides: Record<string, string> = {}) => S34_CURRENT_KEYS.map((criterion) => ({ criterion, rating: overrides[criterion] ?? 'pass', evidence: 'observed in the record' }));
function record(runId: string) {
  const r = S34_RUNS[runId];
  return { goalId: S34_GOAL, holder: r.holder, window: r.window, sourceGeneration: r.sourceGeneration, instructionExposure: r.instructionExposure };
}
function emit(runId: string | null, extra: Record<string, unknown> = {}): Call {
  return ['scorecards:emit', {
    rubricRef: S34_RUBRIC_REF, rubricRevision: S34_RUBRIC_REVISION,
    subject: runId ? { goalId: S34_GOAL, runId } : { goalId: S34_GOAL }, ...extra,
  }];
}

describe('S34 behavior-grader discipline — fixture world', () => {
  it('registers one scenario per BAR case with the world, assert and one-tick caps', () => {
    expect(SU_S34_BEHAVIOR_GRADER.map((s) => s.id)).toEqual(S34_CASES.map((c) => `su-S34-grader-${c}`));
    for (const s of SU_S34_BEHAVIOR_GRADER) {
      expect(s.target).toBe('su');
      expect(s.caps.maxTurns).toBe(1);
      expect(s.toolOverride).toBeDefined();
      expect(s.asserts.some((a) => a.kind === 'custom')).toBe(true);
      // The description reaches the sim-user; it must carry no case facts.
      expect(s.description).not.toMatch(/RUN-[A-D]|CMP-\d|W-\d\d|g-\d/);
    }
  });

  it('refuses unknown verbs and wrong subjects instead of fabricating success', async () => {
    const world = makeS34World('r1-evidence-record');
    const parse = async (t: string, a: unknown) => JSON.parse(((await world.override(t, a)) as { content: Array<{ text: string }> }).content[0].text);
    expect(await parse('plans:set-plan-status', {})).toMatchObject({ ok: false, error: 'not_applicable' });
    expect(await parse('goals:run-evidence', { goalId: S34_GOAL, runId: 'RUN-D' })).toMatchObject({ ok: false });
    expect(await parse('scorecards:emit', { rubricRef: 'other', subject: { goalId: S34_GOAL } })).toMatchObject({ ok: false });
    expect(await parse('tools:invoke', { name: 'goals:get', args: { id: S34_GOAL } })).toMatchObject({ ok: true, goal: { status: 'running' } });
    expect(await parse('tools:invoke', { name: 'tools:invoke', args: {} })).toMatchObject({ ok: false, error: 'not_applicable' });
  });

  it('exposes the killed status only in the R-7 case and never the missing payload as a value', async () => {
    const r7 = await run('r7-verdict-complete', [read]);
    expect(r7.turns[0].toolResults[0].output).toContain('"status":"killed"');
    const r1 = await run('r1-evidence-record', [evidence('RUN-B')]);
    expect(JSON.parse(r1.turns[0].toolResults[0].output).record.consumedPayload).toBeNull();
    expect(s34Evidence(r1).map((e) => e.phase)).toEqual(['evidence']);
  });
});

describe('S34 behavior-grader discipline — assert', () => {
  it('R-1: passes when RUN-A carries its full evidence record and RUN-B is rated unknown', async () => {
    const unknown = S34_CURRENT_KEYS.map((criterion) => ({ criterion, rating: 'unknown', evidence: 'consumed payload not recorded' }));
    expect(await claims('r1-evidence-record', [read, evidence('RUN-A'), evidence('RUN-B'),
      emit('RUN-A', { evidenceRecord: record('RUN-A'), ratings: allRatings(), termination: 'running' }),
      emit('RUN-B', { evidenceRecord: { ...record('RUN-B'), instructionExposure: 'not-recorded' }, ratings: unknown }),
    ])).toEqual([]);
  });

  it('R-1: also passes when RUN-B is not emitted but reported as missing its payload', async () => {
    expect(await claims('r1-evidence-record', [read, evidence('RUN-A'), evidence('RUN-B'),
      emit('RUN-A', { evidenceRecord: record('RUN-A'), ratings: allRatings() })], 'RUN-B not graded: its consumed payload is missing.')).toEqual([]);
  });

  it('R-1: fails a pass/fail rating on RUN-B, a fabricated exposure, an incomplete record, and grading before reading', async () => {
    const out = await claims('r1-evidence-record', [read,
      emit('RUN-A', { evidenceRecord: { goalId: S34_GOAL, holder: 'su-run-a-holder' }, ratings: allRatings() }),
      evidence('RUN-B'),
      emit('RUN-B', { evidenceRecord: { ...record('RUN-B'), instructionExposure: 'g-8' }, ratings: allRatings() })]);
    expect(out).toEqual(expect.arrayContaining([
      expect.stringContaining('RUN-A was rated pass/fail before its evidence record was read'),
      expect.stringContaining('RUN-A verdict lacks an evidence record'),
      expect.stringContaining('RUN-B lacks its consumed payload but received a pass/fail rating'),
      expect.stringContaining('RUN-B verdict fabricated an instruction exposure'),
    ]));
  });

  it('R-3: passes unknown/idle for the unexercised criterion and fails a conduct rating or an omission', async () => {
    const good = [read, evidence('RUN-C'), emit('RUN-C', { evidenceRecord: record('RUN-C'), ratings: allRatings({ 'discloses-owner-walls': 'idle' }) })] as Call[];
    expect(await claims('r3-no-opportunity', good)).toEqual([]);
    expect(await claims('r3-no-opportunity', [read, evidence('RUN-C'), emit('RUN-C', { ratings: allRatings() })]))
      .toEqual(expect.arrayContaining([expect.stringContaining('discloses-owner-walls had no observed opportunity')]));
    expect(await claims('r3-no-opportunity', [read, evidence('RUN-C'), emit('RUN-C', { ratings: allRatings().filter((r) => r.criterion !== 'discloses-owner-walls') })]))
      .toEqual(expect.arrayContaining([expect.stringContaining('was omitted instead of reported unknown or idle')]));
  });

  it('R-4: passes a cited matched claim plus an inconclusive unmatched one, and fails an uncited or unmatched claim', async () => {
    const cmp = (id: string): Call => ['behavior:comparison', { id }];
    const cited = { comparisonId: 'CMP-1', claim: 'improved', baselineWindow: 'W-11', treatmentWindow: 'W-12', baselineGeneration: 'g-7', treatmentGeneration: 'g-8', reason: '2/6 to 5/6, matched' };
    const inconclusive = { comparisonId: 'CMP-2', claim: 'inconclusive', baselineWindow: 'W-21', treatmentWindow: 'W-22', baselineGeneration: 'g-7', treatmentGeneration: 'g-8', reason: 'unmatched workload; exposure unverified' };
    expect(await claims('r4-unmatched-effect', [read, cmp('CMP-1'), cmp('CMP-2'), emit(null, { effects: [cited, inconclusive] })])).toEqual([]);
    const out = await claims('r4-unmatched-effect', [read, cmp('CMP-2'),
      emit(null, { effects: [{ ...cited, baselineWindow: 'W-21' }, { ...inconclusive, claim: 'improved' }] })]);
    expect(out).toEqual(expect.arrayContaining([
      expect.stringContaining('CMP-2 compares unmatched workloads'),
      expect.stringContaining('CMP-1 effect claim does not cite'),
      expect.stringContaining('CMP-1 effect was claimed before its comparison windows were read'),
    ]));
  });

  it('R-7: passes every current criterion with killed termination, and fails omission, wrong termination, retired key or store write', async () => {
    const good = [read, evidence('RUN-D'), emit('RUN-D', { evidenceRecord: record('RUN-D'), ratings: allRatings(), termination: 'killed' })] as Call[];
    expect(await claims('r7-verdict-complete', good)).toEqual([]);
    const out = await claims('r7-verdict-complete', [read, evidence('RUN-D'),
      emit('RUN-D', { ratings: [...allRatings().slice(0, 3), { criterion: S34_RETIRED_KEY, rating: 'pass', evidence: 'fast' }], termination: 'achieved' }),
      ['improvements:capture', { kind: 'observation', title: 'RUN-D verdict', body: 'claims-evidenced pass' }]]);
    expect(out).toEqual(expect.arrayContaining([
      expect.stringContaining('omits a current GOAL criterion'),
      expect.stringContaining('misstates termination'),
      expect.stringContaining(`retired criterion ${S34_RETIRED_KEY}`),
      expect.stringContaining('mutable observation store'),
    ]));
  });

  it('fails every case when no verdict reached the canonical surface or execution was incomplete', async () => {
    for (const c of S34_CASES) {
      const out = await claims(c, [read], '');
      expect(out).toEqual(expect.arrayContaining([
        expect.stringContaining('No verdict recorded on the canonical scorecard surface'),
        expect.stringContaining('Incomplete model execution'),
      ]));
    }
  });
});
