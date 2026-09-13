import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';

const h = vi.hoisted(() => ({
  boundedOrgTxn: vi.fn(),
  getModes: vi.fn(),
  getLoopStatus: vi.fn(),
  latestFleetMembership: vi.fn(),
  getSessionBrief: vi.fn(),
  fetchSelfWake: vi.fn(),
  readGoalHolderAuthority: vi.fn(),
  projectGoalHolderAuthority: vi.fn(),
  stackRefsForSession: vi.fn(),
}));

vi.mock('../../pg-bounded-txn', () => ({ boundedOrgTxn: h.boundedOrgTxn }));
vi.mock('../../modes/store', () => ({ getModes: h.getModes }));
vi.mock('../../harness/routines/loop', () => ({ getLoopStatus: h.getLoopStatus }));
vi.mock('../../fleet-membership-store', () => ({ latestFleetMembership: h.latestFleetMembership }));
vi.mock('../../session-brief', () => ({ getSessionBrief: h.getSessionBrief }));
vi.mock('./presence-selfwake', () => ({ fetchSelfWake: h.fetchSelfWake }));
vi.mock('../../goals/holder-authority', () => ({
  readGoalHolderAuthority: h.readGoalHolderAuthority,
  projectGoalHolderAuthority: h.projectGoalHolderAuthority,
}));
vi.mock('../../stack-binding-channel', () => ({ stackRefsForSession: h.stackRefsForSession }));

import { refreshControlAnchorAfterMutation } from './control-anchor';

const input = {
  ownerId: 'owner-1',
  workspaceId: 'workspace-1',
  origin: 'agent' as const,
  actorId: 'actor-1',
  source: 'loop:arm' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.getModes.mockResolvedValue([]);
  h.getLoopStatus.mockResolvedValue(null);
  h.latestFleetMembership.mockResolvedValue(null);
  h.getSessionBrief.mockResolvedValue(null);
  h.fetchSelfWake.mockResolvedValue(new Map());
  h.readGoalHolderAuthority.mockResolvedValue({
    status: 'none',
    goalId: null,
    electedOwnerId: null,
    electedEpoch: null,
    handoffExpiresAt: null,
  });
  h.projectGoalHolderAuthority.mockReturnValue(undefined);
  h.stackRefsForSession.mockReturnValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('refreshControlAnchorAfterMutation', () => {
  it('fails soft within a bounded refresh budget when the transaction never settles', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    h.boundedOrgTxn.mockImplementation(() => new Promise(() => undefined));

    const result = refreshControlAnchorAfterMutation(input);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(20_000);

    await expect(result).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('control-anchor:refresh exceeded 20000ms'));
    warn.mockRestore();
    expect(h.boundedOrgTxn).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        statementTimeoutMs: 8_000,
        lockTimeoutMs: 4_000,
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('reuses an existing transaction instead of opening a nested unbounded one', async () => {
    const state = {
      modes: [],
      loop: { active: false, intervalSec: null },
      carry: 'warm' as const,
      route: { kind: 'self' as const },
      scope: { workspace: input.workspaceId, harness: null, plan: null, items: [] },
    };
    const tx = vi.fn(async (strings: TemplateStringsArray) => {
      if (strings.join(' ').includes('INSERT INTO harness_shared.session_briefs')) {
        return [{
          control_generation: 1,
          control_state: state,
          control_updated_at: new Date('2026-09-13T00:00:00.000Z'),
          control_transition: null,
        }];
      }
      return [];
    }) as unknown as Sql;

    const result = await refreshControlAnchorAfterMutation({ ...input, sql: tx });

    expect(result).toMatchObject({ generation: 1 });
    expect(h.boundedOrgTxn).not.toHaveBeenCalled();
    expect(h.getSessionBrief).toHaveBeenCalledWith({ ownerId: input.ownerId }, tx);
    expect(h.fetchSelfWake).toHaveBeenCalledWith([input.ownerId], tx);
  });
});
