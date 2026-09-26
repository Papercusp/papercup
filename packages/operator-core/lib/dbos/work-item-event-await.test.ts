import { describe, expect, it } from 'vitest';
import type { WorkItemEventWaitInput } from './work-item-event-await';
import type { WorkItem } from '../work-items';
import type { KeyFireRow } from '../events/await/types';

// The copy-out mutation probe loads the subject from its mirrored path. The
// ordinary suite uses the tracked module and keeps the same assertions.
const { awaitWorkItemCompletionEvent } = await import(
  /* @vite-ignore */ process.env.PAPERCUSP_WAIT_BRIDGE_PROBE_PATH ?? './work-item-event-await'
) as typeof import('./work-item-event-await');

const input: WorkItemEventWaitInput = {
  itemId: 'WI-123', harnessSlug: 'papercusp', workspaceId: 'papercusp-workspace',
  deadlineAt: '2026-09-24T12:00:00Z', pollMs: 100,
};

function item(state: string, intent?: string): WorkItem {
  return {
    id: input.itemId, harness: input.harnessSlug, state,
    completionAuthority: state === 'done' ? 'committed' : null,
    payload: intent ? { _completionEventIntentId: intent } : {},
  } as WorkItem;
}

function latch(intent: string): KeyFireRow {
  return { lastPayload: { completionIntentId: intent } } as KeyFireRow;
}

describe('DBOS canonical work-item completion consumer bridge', () => {
  it('waits for a matching published event and returns the current successful outcome', async () => {
    const reads = [item('wip'), item('done', 'cycle-1'), item('done', 'cycle-1'), item('done', 'cycle-1')];
    let now = Date.parse('2026-09-24T11:00:00Z');
    const sleeps: number[] = [];
    let latched = false;
    const result = await awaitWorkItemCompletionEvent(input, {
      readItem: async () => reads.shift() ?? item('done', 'cycle-1'),
      readLatch: async () => latched ? latch('cycle-1') : null,
      sleep: async (ms) => { sleeps.push(ms); now += ms; latched = true; },
      now: () => now,
    });
    expect(result).toEqual({
      kind: 'settled', itemId: input.itemId, state: 'done', successful: true,
      source: 'completion-event', completionIntentId: 'cycle-1',
    });
    expect(sleeps.length).toBeGreaterThan(0);
  });

  it('returns a late subscriber from current terminal state and distinguishes dropped', async () => {
    const result = await awaitWorkItemCompletionEvent(input, {
      readItem: async () => item('dropped'),
      readLatch: async () => { throw new Error('late state must not depend on an old latch'); },
      sleep: async () => { throw new Error('already settled'); },
    });
    expect(result).toMatchObject({ kind: 'settled', state: 'dropped', successful: false, source: 'current-state' });
  });

  it('reports settlement without claiming an unvalidated result succeeded', async () => {
    const unverified = { ...item('done'), completionAuthority: null };
    const noAuthority = await awaitWorkItemCompletionEvent(input, {
      readItem: async () => unverified,
      sleep: async () => { throw new Error('already settled'); },
    });
    expect(noAuthority).toMatchObject({ kind: 'settled', state: 'done', successful: false });

    const pinnedWithoutResult = { ...item('done'), payload: { blueprintOperation: {
      kind: 'blueprint-operation', operationId: 'run', specificationRevision: 'a'.repeat(64),
    } } };
    const noOutput = await awaitWorkItemCompletionEvent(input, {
      readItem: async () => pinnedWithoutResult,
      sleep: async () => { throw new Error('already settled'); },
    });
    expect(noOutput).toMatchObject({ kind: 'settled', state: 'done', successful: false });
  });

  it('rejects an old completion when the item reopens before delivery', async () => {
    const reads = [item('done', 'old'), item('wip'), item('done', 'new'), item('done', 'new')];
    let now = Date.parse('2026-09-24T11:00:00Z');
    const result = await awaitWorkItemCompletionEvent(input, {
      readItem: async () => reads.shift() ?? item('done', 'new'),
      readLatch: async () => latch(reads.length > 2 ? 'old' : 'new'),
      sleep: async (ms) => { now += ms; },
      now: () => now,
    });
    expect(result).toMatchObject({
      kind: 'settled', state: 'done', successful: true,
      source: 'completion-event', completionIntentId: 'new',
    });
  });

  it('rechecks the current cycle after validating a settled result', async () => {
    const reads = [item('done', 'old'), item('done', 'old'), item('wip'),
      item('done', 'new'), item('done', 'new'), item('done', 'new')];
    let now = Date.parse('2026-09-24T11:00:00Z');
    let latchReads = 0;
    const result = await awaitWorkItemCompletionEvent(input, {
      readItem: async () => reads.shift() ?? item('done', 'new'),
      readLatch: async () => latch(latchReads++ === 0 ? 'old' : 'new'),
      sleep: async (ms) => { now += ms; },
      now: () => now,
    });
    expect(result).toMatchObject({
      kind: 'settled', state: 'done', successful: true,
      source: 'completion-event', completionIntentId: 'new',
    });
    expect(latchReads).toBe(2);
  });

  it('uses an absolute deadline that a workflow replay cannot extend', async () => {
    const result = await awaitWorkItemCompletionEvent({ ...input, deadlineAt: '2026-09-24T11:00:00Z' }, {
      readItem: async () => item('wip'), now: () => Date.parse('2026-09-24T11:00:00Z'),
      sleep: async () => { throw new Error('deadline already passed'); },
    });
    expect(result).toEqual({ kind: 'pending', itemId: input.itemId, lastState: 'wip', reason: 'deadline' });
  });
});
