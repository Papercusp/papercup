/**
 * role-slot-live-resolve.test.ts — EI-13620 regression: `@role:<role>` must
 * resolve against the LIVE roster (agentRole match + a non-`ended` derived
 * sessionState), scoped workspace-wide for a singleton pot role (mug/kettle/
 * papercup/papercup-deep) and hive-scoped otherwise, and must fail SOFT to []
 * on any read error rather than throwing (a coord:send must never break
 * because a presence read hiccuped).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const listPresenceMock = vi.fn();
const fetchWakeabilityMock = vi.fn();

vi.mock('./presence', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listPresence: (...a: unknown[]) => listPresenceMock(...a),
}));
vi.mock('./presence-wakeability', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchWakeability: (...a: unknown[]) => fetchWakeabilityMock(...a),
}));

import { resolveLiveRoleHolders } from './role-slot-live-resolve';

function presenceRow(overrides: Record<string, unknown> = {}) {
  return {
    ownerId: 'mug-owner-1',
    agentRole: 'mug',
    stale: false,
    heartbeatAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveLiveRoleHolders', () => {
  it('resolves a wakeable session currently holding the role', async () => {
    listPresenceMock.mockResolvedValue([presenceRow()]);
    fetchWakeabilityMock.mockResolvedValue(
      new Map([['mug-owner-1', { wakeable: true, liveTurn: false }]]),
    );
    const got = await resolveLiveRoleHolders('mug', { workspaceId: 'ws-1' });
    expect(got).toEqual(['mug-owner-1']);
  });

  it('canonicalizes the pot-rename dual (a row stored under the old "queen" role still matches "mug")', async () => {
    listPresenceMock.mockResolvedValue([presenceRow({ agentRole: 'queen' })]);
    fetchWakeabilityMock.mockResolvedValue(
      new Map([['mug-owner-1', { wakeable: true, liveTurn: false }]]),
    );
    const got = await resolveLiveRoleHolders('mug', { workspaceId: 'ws-1' });
    expect(got).toEqual(['mug-owner-1']);
  });

  it('excludes a row whose derived sessionState is ended (not wakeable, no live turn)', async () => {
    listPresenceMock.mockResolvedValue([presenceRow({ stale: true })]);
    fetchWakeabilityMock.mockResolvedValue(
      new Map([['mug-owner-1', { wakeable: false, liveTurn: false }]]),
    );
    const got = await resolveLiveRoleHolders('mug', { workspaceId: 'ws-1' });
    expect(got).toEqual([]);
  });

  it('a live turn counts even without a standing wake-await (a one-turn agent mid-work)', async () => {
    listPresenceMock.mockResolvedValue([presenceRow()]);
    fetchWakeabilityMock.mockResolvedValue(
      new Map([['mug-owner-1', { wakeable: false, liveTurn: true }]]),
    );
    const got = await resolveLiveRoleHolders('mug', { workspaceId: 'ws-1' });
    expect(got).toEqual(['mug-owner-1']);
  });

  it('excludes a non-matching role and never pays the wakeability query', async () => {
    listPresenceMock.mockResolvedValue([presenceRow({ agentRole: 'cup' })]);
    const got = await resolveLiveRoleHolders('mug', { workspaceId: 'ws-1' });
    expect(got).toEqual([]);
    expect(fetchWakeabilityMock).not.toHaveBeenCalled();
  });

  it('fails soft to [] when listPresence throws (never breaks the send)', async () => {
    listPresenceMock.mockRejectedValue(new Error('db down'));
    const got = await resolveLiveRoleHolders('mug', { workspaceId: 'ws-1' });
    expect(got).toEqual([]);
  });

  it('fails soft to [] on an empty role', async () => {
    const got = await resolveLiveRoleHolders('', { workspaceId: 'ws-1' });
    expect(got).toEqual([]);
    expect(listPresenceMock).not.toHaveBeenCalled();
  });

  it('ignores potSlug for a workspace-singleton role (one Mug per workspace, not per hive)', async () => {
    listPresenceMock.mockResolvedValue([presenceRow()]);
    fetchWakeabilityMock.mockResolvedValue(
      new Map([['mug-owner-1', { wakeable: true, liveTurn: false }]]),
    );
    await resolveLiveRoleHolders('mug', { workspaceId: 'ws-1', potSlug: 'some-hive' });
    expect(listPresenceMock).toHaveBeenCalledWith({ workspaceId: 'ws-1', potSlug: null });
  });

  it('scopes a non-singleton (pipeline) role lookup by the given potSlug', async () => {
    listPresenceMock.mockResolvedValue([presenceRow({ agentRole: 'scoper' })]);
    fetchWakeabilityMock.mockResolvedValue(
      new Map([['mug-owner-1', { wakeable: true, liveTurn: false }]]),
    );
    await resolveLiveRoleHolders('scoper', { workspaceId: 'ws-1', potSlug: 'some-hive' });
    expect(listPresenceMock).toHaveBeenCalledWith({ workspaceId: 'ws-1', potSlug: 'some-hive' });
  });
});
