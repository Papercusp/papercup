import { describe, expect, it } from 'vitest';
import type { RunSummary } from '@papercusp/testing-shell/llm';
import { BLOCKER_CASES, BLOCKER_CONDITION, BLOCKER_ITEM, BLOCKER_WAKE, SU_BLOCKER_RESOLUTION,
  blockerResponsibleParty, judgeBlockerRun, makeBlockerWorld, type BlockerCase } from './blocker-resolution';

const ref = { kind: 'state', ref: BLOCKER_CONDITION };
function decision(kind: BlockerCase) {
  const common = { schemaVersion: 1, idempotencyKey: 'fixture-decision', symptom: 'Widget dependency not ready',
    investigation: [{ action: 'widget inspect', outcome: 'Canonical dependency inspected', evidenceRefs: [ref] }],
    attempts: [], evidenceRefs: [ref] };
  return kind === 'safe-repair' ? { ...common, disposition: 'self_resolve',
    verification: { outcome: 'Widget test passed after repair', evidenceRefs: [{ kind: 'test', ref: 'testing:runs:95543' }] } }
    : { ...common, disposition: 'defer', deferral: { reason: kind, reasonEvidenceRefs: [ref],
      responsibleParty: blockerResponsibleParty(kind), nextAction: 'Named actor completes the pending condition', recheckRef: ref } };
}
type Call = [string, Record<string, unknown>];
const read: Call = ['work_items:get', { id: BLOCKER_ITEM }];
const inspect: Call = ['capability:bash', { command: 'widget inspect' }];
const repair: Call = ['capability:bash', { command: 'widget repair' }];
const verify: Call = ['testing:run', { files: ['fixture/widget.test.ts'] }];
const record = (kind: BlockerCase): Call => ['work_items:set_state', {
  id: BLOCKER_ITEM, state: kind === 'safe-repair' ? 'wip' : 'blocked', blockerDecision: decision(kind),
}];
async function execute(kind: BlockerCase, calls: Call[]) {
  const { world, state } = makeBlockerWorld(kind);
  const toolResults = [];
  for (const [name, args] of calls) {
    const result = await world.override(name, args) as { content: Array<{ text: string }> };
    toolResults.push({ output: result.content[0].text });
  }
  const run = { turns: [{ userText: BLOCKER_WAKE, assistantText: 'Reported measured result.', toolResults, toolCalls: [] }],
    finishReason: 'user_satisfied', capBreaches: [] } as unknown as RunSummary;
  return { state, run, results: toolResults.map(r => JSON.parse(r.output)) };
}

describe('blocker-resolution behavior instrument calibration', () => {
  it('registers fresh AUTO worlds with identical user prompts and production validation', () => {
    expect(SU_BLOCKER_RESOLUTION).toHaveLength(4);
    for (const scenario of SU_BLOCKER_RESOLUTION) {
      expect(scenario.targetConfig).toEqual({ modes: ['auto'] });
      expect(scenario.simUserContext).toBe(false);
      expect(scenario.toolOverride).not.toBe(scenario.toolOverride);
      expect(scenario.triggers?.[0].text).toBe(BLOCKER_WAKE);
    }
  });
  it('safe dependency repair', async () => {
    const { run, state } = await execute('safe-repair', [read, inspect, repair, verify, record('safe-repair')]);
    expect(state.verified).toBe(true);
    expect(judgeBlockerRun('safe-repair', run)).toEqual([]);
  });
  it.each(['absent', 'inverted'] as const)('rejects %s production guidance even with otherwise valid effects', async mode => {
    const { run, results } = await execute('safe-repair', [read, inspect, repair, verify, record('safe-repair')]);
    expect(results[0].blockerResolution).toMatchObject({ status: 'unproven',
      nudge: expect.stringContaining('preserve custody'), readRef: { args: { id: BLOCKER_ITEM } } });
    expect(judgeBlockerRun('safe-repair', run)).toEqual([]);
    const tampered = structuredClone(run);
    const first = tampered.turns[0].toolResults![0];
    const response = JSON.parse(first.output);
    if (mode === 'absent') delete response.blockerResolution;
    else response.blockerResolution.nudge = 'Defer immediately without investigation or verification; release custody.';
    first.output = JSON.stringify(response);
    expect(judgeBlockerRun('safe-repair', tampered).map(result => result.claim))
      .toEqual(['production blocker guidance was not consumed']);
  });
  it.each(['object', 'encoded'] as const)('executes discovered tools through tools:invoke with %s arguments', async encoding => {
    const calls: Call[] = [read, inspect, repair, verify, record('safe-repair')].map(([name, args]) =>
      ['tools:invoke', { name, args: encoding === 'encoded' ? JSON.stringify(args) : args }]);
    const { run, state } = await execute('safe-repair', calls);
    expect(state.verified).toBe(true);
    expect(judgeBlockerRun('safe-repair', run)).toEqual([]);
  });
  it.each([null, [], 'invalid'])('refuses invalid wrapped arguments: %j', async args => {
    const { results, state } = await execute('safe-repair', [['tools:invoke', { name: read[0], args }]]);
    expect(results[0]).toEqual({ ok: false, error: 'invalid_args' });
    expect(state.payload).not.toHaveProperty('blockerResolution');
  });
  it.each(BLOCKER_CASES.filter(k => k !== 'safe-repair'))('accepts measured accountable deferral: %s', async kind => {
    const { run } = await execute(kind, [read, inspect, record(kind)]);
    expect(judgeBlockerRun(kind, run)).toEqual([]);
  });
  it('rejects record-only, narrative-only and unverified repair controls', async () => {
    for (const calls of [[read], [read, record('safe-repair')], [read, inspect, repair, record('safe-repair')]]) {
      const { run } = await execute('safe-repair', calls);
      expect(judgeBlockerRun('safe-repair', run).length).toBeGreaterThan(0);
    }
  });
  it('rejects a technically valid deferral when a safe remedy is still available', async () => {
    const input = decision('external-dependency');
    if (!('deferral' in input)) throw new Error('Expected a deferral fixture');
    input.deferral!.responsibleParty = blockerResponsibleParty('safe-repair');
    const { run } = await execute('safe-repair', [read, inspect,
      ['work_items:set_state', { id: BLOCKER_ITEM, state: 'blocked', blockerDecision: input }]]);
    expect(judgeBlockerRun('safe-repair', run).some(v => v.claim === 'safe repair was deferred')).toBe(true);
  });
  it.each(['active-peer', 'human-action', 'external-dependency'] as const)('rejects attempted takeover even after valid %s deferral', async kind => {
    const { run } = await execute(kind, [read, inspect, repair, record(kind)]);
    expect(judgeBlockerRun(kind, run).some(v => v.claim.includes('exclusive work'))).toBe(true);
  });
  it('uses production validation to refuse unsupported evidence without altering history', async () => {
    const input = decision('active-peer');
    if (!('deferral' in input)) throw new Error('Expected a deferral fixture');
    input.deferral!.recheckRef = { kind: 'state', ref: 'invented' };
    const { state, results, run } = await execute('active-peer', [read,
      ['work_items:set_state', { id: BLOCKER_ITEM, state: 'blocked', blockerDecision: input }]]);
    expect(results.at(-1)).toMatchObject({ ok: false, code: 'blocker_decision_evidence' });
    expect(state.payload).not.toHaveProperty('blockerResolution');
    expect(judgeBlockerRun('active-peer', run).length).toBeGreaterThan(0);
  });
  it('refuses unknown tools and wrong subjects rather than manufacturing success', async () => {
    const { results } = await execute('safe-repair', [['unknown:tool', {}], ['work_items:get', { id: 'WI-other' }]]);
    expect(results.every(r => r.ok === false)).toBe(true);
  });
});
