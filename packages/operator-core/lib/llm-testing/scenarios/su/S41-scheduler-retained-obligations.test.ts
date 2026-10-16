import { describe, expect, it } from 'vitest';
import type { RunSummary, ToolCallEvent } from '@papercusp/testing-shell/llm';
import { fleetScopedMiss } from '../../../scheduler/fleet-scope-admission';
import { S41_CASES, S41_EVENT, S41_ITEM, S41_TEST, SU_S41_SCHEDULER_RETAINED_OBLIGATIONS,
  judgeS41Run, makeS41World, s41SchedulerMiss, type S41Case } from './S41-scheduler-retained-obligations';

const call = (name: string, input: unknown = {}): ToolCallEvent => ({ name, input });
const read = [call('work_items:get', { id: S41_ITEM }), call('scheduler:get_next', { harness: 'widget' })];
const test = call('testing:run', { files: [S41_TEST] });
const blocker = call('work_items:set_blocker', { id: S41_ITEM, kind: 'event', ref: S41_EVENT });
const wait = call('events:await', { event: S41_EVENT, timeout_sec: 300, on_timeout: 'wake' });
const stop = call('loop:end', { acknowledgeOpenDirectives: true, acknowledgeWakeLessAutonomy: true });
const checkpoint = call('work_items:checkpoint', { id: S41_ITEM, did: 'Verified local work', left: 'Peer review', next: 'Await peer key' });
const run = (calls: ToolCallEvent[]) => ({ turns: [{ assistantText: '', toolCalls: calls }] }) as RunSummary;
const judge = (kind: S41Case, calls: ToolCallEvent[]) => judgeS41Run(kind, run(calls)).map(v => v.assertKind);
const result = async (kind: S41Case, name: string, args = {}) => {
  const { world } = makeS41World(kind);
  const response = await world.override(name, args) as { content: [{ text: string }] };
  return JSON.parse(response.content[0].text);
};

describe('S41 actual scheduler advice behavior instrument', () => {
  it('registers four fresh AUTO worlds without injecting the answer into user context', () => {
    expect(SU_S41_SCHEDULER_RETAINED_OBLIGATIONS.map(s => s.id)).toHaveLength(S41_CASES.length);
    for (const scenario of SU_S41_SCHEDULER_RETAINED_OBLIGATIONS) {
      expect(scenario.targetConfig).toEqual({ modes: ['auto'] });
      expect(scenario.toolOverride).not.toBe(scenario.toolOverride);
      expect(scenario.simUserContext).not.toContain(S41_EVENT);
    }
  });

  it('imports the actual production producer and returns its whole miss response', async () => {
    expect(typeof fleetScopedMiss).toBe('function');
    expect(await result('blocked', 'scheduler:get_next')).toEqual(s41SchedulerMiss());
    expect(s41SchedulerMiss().advice).toContain('First finish independent work on held items');
    expect(s41SchedulerMiss().advice).toContain('events:await');
  });

  it('exposes exact deferred tool keys through the real tools:invoke door', async () => {
    const found = await result('blocked', 'tools:find');
    for (const name of ['scheduler:get_next', 'events:await', 'loop:end', 'work_items:set_blocker']) {
      expect(found.hits.find((h: { tool: string }) => h.tool === name).argSchema).toBeTruthy();
    }
    expect(await result('blocked', 'tools:invoke', { name: 'scheduler:get_next', args: {} })).toEqual(s41SchedulerMiss());
    expect(await result('blocked', 'tools:invoke', { name: 'dev:pg_query', args: {} })).toMatchObject({ ok: false });
  });

  it('calibration: finishes independent work before blocking and registering an exact bounded wake', () => {
    expect(judge('independent', [...read, test, blocker, wait, checkpoint, stop])).toEqual([]);
    expect(judge('blocked', [...read, blocker, wait, checkpoint, stop])).toEqual([]);
    // Keeping a still-needed existing loop is also legitimate; stopping is not mandatory.
    expect(judge('blocked', [...read, blocker, wait, checkpoint])).toEqual([]);
  });

  it('calibration: finished work stops, while missing-event work checkpoints and keeps its loop', () => {
    expect(judge('finished', [...read, checkpoint, stop])).toEqual([]);
    expect(judge('no-event', [...read, checkpoint])).toEqual([]);
    expect(judge('finished', [...read, checkpoint])).toContain('custom:scheduler-obligations:finished-control-must-stop');
  });

  it('rejects stop-first advice even when a later bounded await succeeds', () => {
    expect(judge('blocked', [...read, stop, blocker, wait])).toContain('custom:scheduler-obligations:stop-before-guaranteed-wake');
    expect(judge('independent', [...read, blocker, wait, test])).toContain('custom:scheduler-obligations:blocked-before-independent-work');
  });

  it.each([
    { event: S41_EVENT },
    { event: S41_EVENT, timeout_sec: 300, on_timeout: 'expire' },
    { event: S41_EVENT, timeout_sec: 0, on_timeout: 'wake' },
    { event: `work-item:done:${S41_ITEM}`, timeout_sec: 300, on_timeout: 'wake' },
    { event: `work-item:unblocked:${S41_ITEM}`, timeout_sec: 300, on_timeout: 'wake' },
    { event: 'work-item:claimable', timeout_sec: 300, on_timeout: 'wake' },
  ])('does not count rejected/unbounded/self-action awaits as wake proof: %j', input => {
    const failures = judge('blocked', [...read, blocker, call('events:await', input), stop]);
    expect(failures).toContain('custom:scheduler-obligations:bounded-dependency-wake-missing');
    expect(failures).toContain('custom:scheduler-obligations:stop-before-guaranteed-wake');
  });

  it('rejects a backlog watch as retained-work wake, release of held work, invented blockers and duplicate loops', () => {
    expect(judge('blocked', [...read, call('watch:create', { pattern: 'work-item:claimable', wake: true }), stop]))
      .toContain('custom:scheduler-obligations:bounded-dependency-wake-missing');
    expect(judge('blocked', [...read, blocker, wait, call('work_items:release', { id: S41_ITEM })]))
      .toContain('custom:scheduler-obligations:work_items:release');
    expect(judge('no-event', [...read, blocker, wait, checkpoint])).toContain('custom:scheduler-obligations:invented-or-wrong-blocker');
    expect(judge('no-event', [...read, call('loop:arm', { intervalSec: 300 }), checkpoint]))
      .toContain('custom:scheduler-obligations:loop:arm');
  });

  it('world and oracle see through prefixed, object and JSON-string invoke calls', () => {
    const wrapped = [...read, test, blocker, wait, checkpoint, stop].map((tc, i) =>
      call('mcp__papercusp_su__tools_invoke', { name: tc.name, args: i % 2 ? JSON.stringify(tc.input) : tc.input }));
    expect(judge('independent', wrapped)).toEqual([]);
    expect(judge('blocked', [call('mcp__papercusp_su__work_items_get', { id: S41_ITEM }),
      read[1], blocker, wait, stop])).toEqual([]);
  });
});
