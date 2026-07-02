/**
 * Unit tests for agent-drive-mode — the owner→drive-mode guard that keeps
 * OWNER-DIRECTED (responsive) sessions out of the drain/reap population
 * (queen-fleet-authority-boundary-2026-07-02 P-001 / D-001).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const getPresence = vi.fn();
vi.mock('./presence', () => ({ getPresence: (...a: unknown[]) => getPresence(...a) }));

import { classifyOwnerDriveMode, isResponsiveOwner } from './agent-drive-mode';

beforeEach(() => {
  vi.clearAllMocks();
  getPresence.mockResolvedValue(null);
});

describe('agent-drive-mode (P-001 / D-001)', () => {
  it('a roleless su- owner id is responsive WITHOUT a presence read (the guard holds even if PG is down)', async () => {
    const c = await classifyOwnerDriveMode('su-173cbb09-c016-4d62-8806-70487830c24f');
    expect(c).toEqual({ kind: 'su', driveMode: 'responsive' });
    expect(await isResponsiveOwner('su-173cbb09-c016-4d62-8806-70487830c24f')).toBe(true);
    // Fast path: never touched presence for an su- id.
    expect(getPresence).not.toHaveBeenCalled();
  });

  it('an explicit su presence role is responsive', async () => {
    getPresence.mockResolvedValue({ ownerId: 's-x', agentRole: 'su' });
    expect(await classifyOwnerDriveMode('s-x')).toEqual({ kind: 'su', driveMode: 'responsive' });
    expect(await isResponsiveOwner('s-x')).toBe(true);
  });

  it('sentinel (operator) + planner presence roles are responsive', async () => {
    getPresence.mockResolvedValue({ ownerId: 's-op', agentRole: 'operator' });
    expect(await classifyOwnerDriveMode('s-op')).toEqual({ kind: 'sentinel', driveMode: 'responsive' });
    getPresence.mockResolvedValue({ ownerId: 's-pl', agentRole: 'planner' });
    expect(await classifyOwnerDriveMode('s-pl')).toEqual({ kind: 'planner', driveMode: 'responsive' });
  });

  it('a bee / queen / overwatch is auto (drainable) — the maxBees population', async () => {
    getPresence.mockResolvedValue({ ownerId: 's-bee', agentRole: 'worker' });
    expect((await classifyOwnerDriveMode('s-bee')).driveMode).toBe('auto');
    expect(await isResponsiveOwner('s-bee')).toBe(false);

    getPresence.mockResolvedValue({ ownerId: 's-q', agentRole: 'queen' });
    expect(await classifyOwnerDriveMode('s-q')).toEqual({ kind: 'queen', driveMode: 'auto' });

    getPresence.mockResolvedValue({ ownerId: 's-ow', agentRole: 'overwatch' });
    expect(await classifyOwnerDriveMode('s-ow')).toEqual({ kind: 'overwatch', driveMode: 'auto' });
  });

  it('an unknown non-su owner with no presence falls to bee/auto (never over-PROTECT the unknown)', async () => {
    getPresence.mockResolvedValue(null);
    expect(await classifyOwnerDriveMode('s-mystery')).toEqual({ kind: 'bee', driveMode: 'auto' });
    expect(await isResponsiveOwner('s-mystery')).toBe(false);
  });

  it('a presence read error falls back to id-only classification (best-effort)', async () => {
    getPresence.mockRejectedValue(new Error('pg down'));
    // non-su → bee/auto (drainable default); su- id already short-circuits before the read.
    expect((await classifyOwnerDriveMode('s-bee')).driveMode).toBe('auto');
    expect(await isResponsiveOwner('su-abc')).toBe(true);
  });
});
