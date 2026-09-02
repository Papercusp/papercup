import { describe, expect, it, vi } from 'vitest';
import { deriveFleetControlVisibility, resolvePresenceFleet, type FleetMembership } from './presence-fleet';

const LAUNCH: FleetMembership = { fleetSlug: 'launch-fleet', fleetRole: 'member' };

describe('resolvePresenceFleet', () => {
  it('uses current presence membership over stale launch environment', async () => {
    const fetcher = vi.fn(async () =>
      new Map([['su-1', { fleetSlug: 'live-fleet', fleetRole: 'leader' }]]),
    );
    await expect(resolvePresenceFleet('su-1', LAUNCH, fetcher)).resolves.toEqual({
      fleetSlug: 'live-fleet',
      fleetRole: 'leader',
    });
  });

  it('treats a successful empty read as authoritative fleet absence', async () => {
    const fetcher = vi.fn(async () => new Map<string, FleetMembership>());
    await expect(resolvePresenceFleet('su-1', LAUNCH, fetcher)).resolves.toEqual({
      fleetSlug: null,
      fleetRole: null,
    });
  });

  it('falls back to launch membership only when the presence read fails', async () => {
    const fetcher = vi.fn(async (): Promise<Map<string, FleetMembership>> => {
      throw new Error('pg unavailable');
    });
    await expect(resolvePresenceFleet('su-1', LAUNCH, fetcher)).resolves.toEqual(LAUNCH);
  });

  it('uses launch membership for an unattributable caller without reading presence', async () => {
    const fetcher = vi.fn(async () => new Map<string, FleetMembership>());
    await expect(resolvePresenceFleet(undefined, LAUNCH, fetcher)).resolves.toEqual(LAUNCH);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
