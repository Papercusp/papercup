/**
 * Unit tests for the auto-revert executor registry (B-16 / P-081).
 */
import { describe, it, expect } from 'vitest';
import {
  BUILTIN_REVERTERS,
  executeRevertVia,
  makeRevertRegistry,
  registerReverter,
  type RevertHelpers,
  type Reverter,
} from './revert-executor';
import type { TripwireRow } from './store';
import type { RevertHandle } from './core';

function rowWith(revertHandle: RevertHandle): TripwireRow {
  return {
    id: 'tw-1',
    workspaceId: 'default',
    category: 'work-prioritization',
    findingClass: 'work_items:set_priority',
    action: 'work_items:set_priority',
    riskTier: 'low',
    reversibility: 'reversible',
    revertHandle,
    decision: null,
    status: 'tripped',
    tripReason: 'gym-regression',
    armedAtMs: 1000,
    windowUntilMs: 2000,
    resolvedAtMs: 1500,
    revertedAtMs: null,
    resolvedBy: 'sweep',
  };
}

function fakeHelpers(): { helpers: RevertHelpers; calls: { state: unknown[]; priority: unknown[] } } {
  const calls = { state: [] as unknown[], priority: [] as unknown[] };
  return {
    calls,
    helpers: {
      setWorkItemState: async (id, state, opts) => void calls.state.push({ id, state, opts }),
      setWorkItemPriority: async (id, priority, opts) => void calls.priority.push({ id, priority, opts }),
    },
  };
}

describe('built-in reverters', () => {
  it('work-item-state restores the prior state via setWorkItemState', async () => {
    const { helpers, calls } = fakeHelpers();
    const out = await executeRevertVia(
      rowWith({ kind: 'work-item-state', id: 'WI-9', priorState: 'todo', harness: 'h1' }),
      makeRevertRegistry(),
      helpers,
    );
    expect(out.reverted).toBe(true);
    expect(calls.state).toEqual([{ id: 'WI-9', state: 'todo', opts: { harness: 'h1', by: 'autonomy-revert' } }]);
  });

  it('work-item-priority restores the prior priority (null allowed)', async () => {
    const { helpers, calls } = fakeHelpers();
    const out = await executeRevertVia(
      rowWith({ kind: 'work-item-priority', id: 'WI-3', priorPriority: 5 }),
      makeRevertRegistry(),
      helpers,
    );
    expect(out.reverted).toBe(true);
    expect(calls.priority).toEqual([{ id: 'WI-3', priority: 5, opts: {} }]);

    const { helpers: h2, calls: c2 } = fakeHelpers();
    await executeRevertVia(rowWith({ kind: 'work-item-priority', id: 'WI-4' }), makeRevertRegistry(), h2);
    expect(c2.priority).toEqual([{ id: 'WI-4', priority: null, opts: {} }]);
  });

  it('a handle missing required fields → reverted:false, no op called', async () => {
    const { helpers, calls } = fakeHelpers();
    const out = await executeRevertVia(rowWith({ kind: 'work-item-state', id: 'WI-9' }), makeRevertRegistry(), helpers);
    expect(out.reverted).toBe(false);
    expect(calls.state).toEqual([]);
  });
});

describe('executeRevertVia dispatch', () => {
  it('an unknown handle kind → reverted:false with a note', async () => {
    const { helpers } = fakeHelpers();
    const out = await executeRevertVia(rowWith({ kind: 'git-revert', sha: 'abc' }), makeRevertRegistry(), helpers);
    expect(out.reverted).toBe(false);
    expect(out.note).toMatch(/no reverter registered for handle kind 'git-revert'/);
  });

  it('a reverter that throws is caught → reverted:false (never wedges the sweep)', async () => {
    const { helpers } = fakeHelpers();
    const boom: Reverter = async () => {
      throw new Error('kaboom');
    };
    const registry = makeRevertRegistry();
    registerReverter(registry, 'work-item-state', boom);
    const out = await executeRevertVia(rowWith({ kind: 'work-item-state', id: 'x', priorState: 'todo' }), registry, helpers);
    expect(out.reverted).toBe(false);
    expect(out.note).toMatch(/kaboom/);
  });

  it('a caller can register a reverter for a new kind (the execution-layer extension point)', async () => {
    const { helpers } = fakeHelpers();
    let seen: RevertHandle | null = null;
    const registry = makeRevertRegistry({
      'flag-flip': async (h) => {
        seen = h;
        return { reverted: true, note: 'flag restored' };
      },
    });
    const out = await executeRevertVia(rowWith({ kind: 'flag-flip', key: 'x', priorEnabled: false }), registry, helpers);
    expect(out.reverted).toBe(true);
    expect(seen).toMatchObject({ kind: 'flag-flip', priorEnabled: false });
  });

  it('ships exactly the two canonical built-ins', () => {
    expect(Object.keys(BUILTIN_REVERTERS).sort()).toEqual(['work-item-priority', 'work-item-state']);
  });
});
