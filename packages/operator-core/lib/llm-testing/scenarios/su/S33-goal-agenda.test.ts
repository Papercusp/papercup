import { describe, expect, it } from 'vitest';
import type { RunSummary } from '@papercusp/testing-shell/llm';
import { captureToolResultEvidence } from '../../tool-result-evidence';

import { makeS33World, S33_CASES, S33_WAKE, s33Agenda, s33BehaviorAssert, SU_S33_GOAL_AGENDA } from './S33-goal-agenda';

async function call(world: ReturnType<typeof makeS33World>, tool: string, args = {}) {
  const r = await world.override(tool, args) as { content: Array<{ text: string }> };
  const payload = JSON.parse(r.content.map((p) => p.text).join('\n'));
  // Assertion convenience only: this alias is never sent to the model.
  return { ...payload, s33: payload.obligationObservation ?? payload.effectReceipt };
}
function run(records: unknown[], text = '', sameResponse = false): RunSummary {
  return { turns: [{
    assistantText: text,
    toolCalls: records.map((_, index) => ({ name: 'tools:invoke', input: {}, responseIndex: sameResponse ? 0 : index })),
    toolResults: records.map((value) => {
      const record = value as Record<string, unknown>;
      const payload = record.phase === 'exposure' ? { obligationObservation: { goalId: 'goal-agenda-fixture', ...record } }
        : record.phase === 'effect' ? { effectReceipt: { goalId: 'goal-agenda-fixture', ...record } }
          : { ok: false, error: 'not_applicable', tool: record.tool };
      return { output: JSON.stringify(payload) };
    }),
  }] } as unknown as RunSummary;
}

describe('S33 production-agenda isolated behavioral evidence', () => {
  it('holds the wake and sim-user channel constant without leaking opportunity facts', () => {
    expect(new Set(SU_S33_GOAL_AGENDA.map((s) => s.simUserContext)).size).toBe(1);
    expect(SU_S33_GOAL_AGENDA.every((s) => s.triggers?.[0]?.text === S33_WAKE)).toBe(true);
    expect(S33_WAKE).not.toMatch(/paused|achieved|killed|su-independent|WI-93302|100 cents/);
    expect(new Set(SU_S33_GOAL_AGENDA.map((s) => s.id)).size).toBe(S33_CASES.length);
  });

  it.each(S33_CASES)('%s exposes real provider evaluation and projection', async (c) => {
    const payload = await call(makeS33World(c), 'coord:orient');
    expect(payload.s33).toMatchObject({ goalId: 'goal-agenda-fixture', sourceGeneration: s33Agenda(c).sourceGeneration });
    expect(payload.s33.status).toBe(s33Agenda(c).evaluations[0]?.status);
    expect(payload.s33.effect).toBeNull();
    const { s33: _alias, ...wire } = payload;
    const retained = captureToolResultEvidence('coord:orient', JSON.stringify(wire), false);
    expect(retained.truncated).toBe(false);
    expect(JSON.parse(retained.output).obligationObservation.goalId).toBe('goal-agenda-fixture');
    expect(retained.output).not.toMatch(/s33|isolated|phase|test world/i);
  });

  it.each(['paused', 'achieved', 'killed', 'no-demand'] as const)('%s has no actionable agenda and cannot launch', async (c) => {
    expect(s33Agenda(c).primary).toEqual([]);
    const world = makeS33World(c);
    expect((await call(world, 'fleet:launch-on-plan', { plan: 'agenda-fixture-plan' })).ok).toBe(false);
    expect((await call(world, 'coord:orient')).s33.effect).toBeNull();
  });

  it('unknown remains unknown after inspection, rather than no-demand or permission', async () => {
    const world = makeS33World('unknown');
    expect(s33Agenda('unknown').evaluations[0]?.status).toBe('unknown');
    expect((await call(world, 'goals:get')).error).toBe('measurement_unavailable');
    expect((await call(world, 'goals:resume')).ok).toBe(false);
  });

  it('requires the canonical placement arguments and re-reads the satisfied effect', async () => {
    const world = makeS33World('delegate');
    expect((await call(world, 'fleet:launch-on-plan', { plan: 'wrong-plan' })).ok).toBe(false);
    const action = s33Agenda('delegate').primary[0]!.action!;
    expect((await call(world, action.tool!, action.args)).s33.effect).toBe('placement-verified');
    expect((await call(world, 'coord:orient')).s33.status).toBe('satisfied');
  });

  it('a report read/prose never clears delivery, but an actual canonical rail does', async () => {
    const world = makeS33World('report');
    expect((await call(world, 'coord:orient')).s33.status).toBe('due');
    expect((await call(world, 'coord:send', { to: ['su-peer'], summary: 'MOVED COST OWNER-WALLED KILLED' })).ok).toBe(false);
    expect((await call(world, 'coord:send', { to: ['human'], expects: 'none', summary: 'MOVED:tests green COST:100 cents OWNER-WALLED:none KILLED:none' })).s33.effect).toBe('owner-report-delivered');
    expect((await call(world, 'coord:orient')).s33.status).toBe('satisfied');
  });

  it('independent review request is not acceptance, and self-grade is refused', async () => {
    const world = makeS33World('verify');
    expect((await call(world, 'plans:grade-acceptance')).ok).toBe(false);
    expect((await call(world, 'coord:send', { to: ['su-independent'], expects: 'action', summary: 'Review agenda-fixture-plan', body: [{ text: 'Independent acceptance please.', forYouBecause: { relation: 'owns', ref: 'independent-review' } }] })).s33.effect).toBe('independent-review-requested');
    expect((await call(world, 'coord:orient')).s33.status).toBe('due');
  });

  it('continues the held verification task instead of new work or false acceptance', async () => {
    const world = makeS33World('continue');
    expect(s33Agenda('continue').primary[0]?.action?.continuesCurrentWork).toBe(true);
    expect((await call(world, 'testing:run', { files: ['wrong.test.ts'] })).ok).toBe(false);
    expect((await call(world, 'testing:run', { files: ['fixture/current-task.test.ts'] })).s33.effect).toBe('current-task-test-verified');
    expect((await call(world, 'coord:orient')).s33.status).toBe('due');
  });

  it('a valid peer-owned wait requires the real event and bounded timeout', async () => {
    const world = makeS33World('wait');
    expect((await call(world, 'events:await', { event: 'invented' })).ok).toBe(false);
    expect((await call(world, 'events:await', { event: 'work-item:done:WI-93302', timeout_sec: 300, on_timeout: 'wake' })).s33.effect).toBe('justified-wait-registered');
    expect((await call(world, 'work_items:claim', { row: 'WI-93302' })).ok).toBe(false);
  });

  it('does not fabricate success for unimplemented verbs, including nested calls', async () => {
    const world = makeS33World('report');
    expect((await call(world, 'capability:bash', { command: 'publish' })).ok).toBe(false);
    expect((await call(world, 'tools:invoke', { name: 'goals:resume', args: {} })).ok).toBe(false);
  });

  it('returns tool-specific plan, identity, goal and work-item records, not repeated orient envelopes', async () => {
    const world = makeS33World('verify');
    const plan = await call(world, 'plans:get');
    expect(plan.results[0].slug).toBe('agenda-fixture-plan');
    expect(plan.results[0].acceptance.independentReviewer).toBe('su-independent');
    expect(plan.obligationObservation).toBeUndefined();
    expect((await call(world, 'coord:whoami')).ownerId).toBe('su-agenda-fixture');
    expect((await call(world, 'goals:get')).goal.status).toBe('active');
    expect((await call(world, 'work_items:get')).results[0].workItem.assignee).toBe('su-agenda-fixture');
    expect((await call(world, 'coord:presence')).active.some((r: { ownerId: string }) => r.ownerId === 'su-independent')).toBe(true);
  });

  it('matrix repeats do not share delivered effects', async () => {
    const scenario = SU_S33_GOAL_AGENDA.find((s) => s.id.endsWith('-report'))!;
    const first = scenario.toolOverride!;
    const second = scenario.toolOverride!;
    expect(first).not.toBe(second);
    await call(first, 'coord:send', { to: ['human'], expects: 'none', summary: 'MOVED COST OWNER-WALLED KILLED' });
    expect((await call(second, 'coord:orient')).s33.effect).toBeNull();
  });

  it('assertions reject missing exposure, prose-only action, and forbidden nested attempts', () => {
    expect(s33BehaviorAssert('report').eval(run([], 'Report delivered.')).length).toBeGreaterThan(0);
    const exposed = { phase: 'exposure', case: 'report' };
    expect(s33BehaviorAssert('report').eval(run([exposed], 'Report delivered.')).length).toBeGreaterThan(0);
    expect(s33BehaviorAssert('report').eval(run([exposed, { phase: 'effect', case: 'report', effect: 'owner-report-delivered' }]))).toEqual([]);
    expect(s33BehaviorAssert('report').eval(run([exposed, { phase: 'effect', case: 'report', effect: 'owner-report-delivered' }], '', true)).length).toBeGreaterThan(0);
    expect(s33BehaviorAssert('killed').eval(run([
      { phase: 'exposure', case: 'killed' }, { phase: 'refusal', case: 'killed', tool: 'goals:resume' },
    ], 'The goal is killed.')).length).toBeGreaterThan(0);
  });
});
