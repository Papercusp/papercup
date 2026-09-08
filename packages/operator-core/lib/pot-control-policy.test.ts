import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  stored: {} as Record<string, unknown>,
  listener: null as ((event: { name: string }) => void) | null,
  subscribe: vi.fn(),
}));

vi.mock('@papercusp/scheduled-registry', () => ({
  managedSetInterval: vi.fn(),
}));

vi.mock('./lazy-flag-refresh', () => ({
  lazyFlagRefresh: (refresh: () => void | Promise<void>) => () => void refresh(),
}));

vi.mock('./operator-state-pg', () => ({
  readOperatorState: vi.fn(async () => state.stored),
  writeOperatorState: vi.fn(async (_table: string, payload: Record<string, unknown>) => {
    state.stored = payload;
  }),
}));

vi.mock('./sync-sse', () => ({
  subscribe: state.subscribe.mockImplementation(async (
    listener: (event: { name: string }) => void,
    opts?: { filter?: (event: { name: string }) => boolean },
  ) => {
    state.listener = (event) => {
      if (opts?.filter && !opts.filter(event)) return;
      listener(event);
    };
    return { send: listener, close: vi.fn() };
  }),
}));

const { placementOverride, refreshPotControlPolicy, readPotControlPolicy } = await import('./pot-control-policy');

beforeEach(() => {
  state.stored = {};
  state.listener = null;
  state.subscribe.mockClear();
});

describe('work-scope policy cache invalidation', () => {
  it('reads the explicitly requested workspace for dispatch authorization', async () => {
    const { readOperatorState } = await import('./operator-state-pg');
    await readPotControlPolicy('dispatch-workspace');
    expect(readOperatorState).toHaveBeenLastCalledWith('operator_pot_control_policy', 'dispatch-workspace');
  });

  it('refreshes a peer process cache when workScope.policy is invalidated', async () => {
    state.stored = { workScope: { mode: 'enforce', allowHarnesses: ['papercusp'] } };

    placementOverride();
    await vi.waitFor(() => expect(state.listener).not.toBeNull());
    expect(placementOverride().workScope).toEqual(state.stored.workScope);

    state.stored = {
      workScope: {
        mode: 'enforce',
        allowHarnesses: ['papercusp'],
        exceptions: [{ workItem: 'WI-2146963', reason: 'owner-directed takeover' }],
      },
    };
    state.listener!({ name: 'workScope.policy' });

    await vi.waitFor(() => expect(placementOverride().workScope).toEqual(state.stored.workScope));
    expect(state.subscribe).toHaveBeenCalledOnce();
    // Unrelated query invalidations must not refresh the policy cache.
    state.stored = { workScope: { mode: 'enforce', allowHarnesses: ['sidestage'] } };
    state.listener!({ name: 'accounts.pool' });
    await Promise.resolve();
    expect(placementOverride().workScope).toEqual({
      mode: 'enforce',
      allowHarnesses: ['papercusp'],
      exceptions: [{ workItem: 'WI-2146963', reason: 'owner-directed takeover' }],
    });
  });
});
