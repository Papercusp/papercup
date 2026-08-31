import { describe, expect, it, vi } from 'vitest';

import type { LivenessVerdict } from '../agent-tools/coordination/liveness-oracle';
import type { SessionState } from '../agent-tools/coordination/presence-wakeability';
import {
  getModesForOwnersWithLiveness,
  getModesWithLiveness,
  modeRegistrationLive,
  resolveModeSetsFromRows,
} from './liveness';
import type { ModeRow } from './store';

function row(ownerId: string, mode = 'grade'): ModeRow {
  return {
    workspaceId: 'ws',
    ownerId,
    axisKey: `overlay:${mode}`,
    mode,
    reason: 'test',
    setBy: ownerId,
    ownerDirected: false,
    setAt: '2026-08-31T00:00:00.000Z',
    subject: null,
  };
}

function verdict(ownerId: string, sessionState: SessionState | null): LivenessVerdict {
  return {
    ownerId,
    sessionState,
    ...(sessionState == null ? { signalMissing: true as const } : {}),
    wakeable: sessionState === 'live' || sessionState === 'parked',
    liveTurn: sessionState === 'live',
    confirmLiveness: sessionState == null || sessionState === 'draining' || sessionState === 'suspect',
    heartbeatFresh: sessionState !== 'ended',
  };
}

describe('liveness-aware mode reads (P-007)', () => {
  it('uses tri-state staffing semantics instead of treating every durable row as live', () => {
    expect(modeRegistrationLive('live')).toBe(true);
    expect(modeRegistrationLive('parked')).toBe(true);
    expect(modeRegistrationLive('recorded')).toBe(true);
    expect(modeRegistrationLive('ended')).toBe(false);
    expect(modeRegistrationLive('draining')).toBeNull();
    expect(modeRegistrationLive('suspect')).toBeNull();
    expect(modeRegistrationLive(null)).toBeNull();
  });

  it('retains ended registrations for history while reporting positive death', () => {
    const rows = new Map([
      ['ended-owner', [row('ended-owner')]],
      ['live-owner', [row('live-owner', 'auto')]],
    ]);
    const resolved = resolveModeSetsFromRows(
      ['ended-owner', 'live-owner', 'no-modes'],
      rows,
      new Map([
        ['ended-owner', verdict('ended-owner', 'ended')],
        ['live-owner', verdict('live-owner', 'parked')],
        ['no-modes', verdict('no-modes', 'live')],
      ]),
    );

    expect(resolved.get('ended-owner')).toMatchObject({
      sessionState: 'ended',
      live: false,
      modes: [{ mode: 'grade' }],
    });
    expect(resolved.get('live-owner')).toMatchObject({
      sessionState: 'parked',
      live: true,
      modes: [{ mode: 'auto' }],
    });
    expect(resolved.get('no-modes')).toMatchObject({ live: true, modes: [] });
  });

  it('hydrates point-read liveness and preserves unknown when the oracle degrades', async () => {
    const getModesFn = vi.fn(async () => [row('owner')]);
    const resolveSessionStatesFn = vi.fn(async () => {
      throw new Error('oracle unavailable');
    });

    const resolved = await getModesWithLiveness('ws', 'owner', {
      getModesFn,
      resolveSessionStatesFn,
    });

    expect(getModesFn).toHaveBeenCalledWith('ws', 'owner', undefined);
    expect(resolveSessionStatesFn).toHaveBeenCalledWith([{ ownerId: 'owner' }], {
      hydratePerId: true,
    });
    expect(resolved).toMatchObject({
      ownerId: 'owner',
      sessionState: null,
      live: null,
      modes: [{ mode: 'grade' }],
    });
  });

  it('batch-reads mode rows and liveness once for a bounded survey', async () => {
    const getModesForOwnersFn = vi.fn(
      async () =>
        new Map([
          ['a', [row('a')]],
          ['b', [row('b', 'ideate')]],
        ]),
    );
    const resolveSessionStatesFn = vi.fn(
      async () =>
        new Map([
          ['a', verdict('a', 'ended')],
          ['b', verdict('b', 'recorded')],
        ]),
    );

    const resolved = await getModesForOwnersWithLiveness('ws', ['a', 'b', 'a'], {
      getModesForOwnersFn,
      resolveSessionStatesFn,
    });

    expect(getModesForOwnersFn).toHaveBeenCalledOnce();
    expect(getModesForOwnersFn).toHaveBeenCalledWith('ws', ['a', 'b'], undefined);
    expect(resolveSessionStatesFn).toHaveBeenCalledWith([{ ownerId: 'a' }, { ownerId: 'b' }], { hydratePerId: true });
    expect(resolved.get('a')?.live).toBe(false);
    expect(resolved.get('b')?.live).toBe(true);
  });
});
