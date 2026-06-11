/**
 * fleet-monitors.test.ts — pure unit coverage for the Phase-3 monitor family
 * (shared-hive-loop-e2e-testing-2026-06-10 P-012/P-013): presence ghosts and
 * the convergence-lag probe. The PG-backed scans/sweeps are covered on the
 * hermetic rig (fleet-monitors.integration.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { detectPresenceGhosts, measureConvergenceLag } from './fleet-monitors';

describe('detectPresenceGhosts', () => {
  const NOW = 1_000_000;
  it('a stale presence row anchoring live leases is a ghost; fresh or lease-free rows are not', () => {
    const ghosts = detectPresenceGhosts(
      [
        { devicePubkey: 'pk-dead', lastSeenMs: NOW - 60_000 }, // stale + holds work
        { devicePubkey: 'pk-idle', lastSeenMs: NOW - 60_000 }, // stale, no work → not reported
        { devicePubkey: 'pk-live', lastSeenMs: NOW - 1_000 }, // fresh → not reported
      ],
      [
        { workItemId: 'F-1', holderPubkey: 'pk-dead', expiresTsMs: NOW + 60_000 },
        { workItemId: 'F-2', holderPubkey: 'pk-dead', expiresTsMs: NOW - 1 }, // lapsed → not anchored
        { workItemId: 'F-3', holderPubkey: 'pk-live', expiresTsMs: NOW + 60_000 },
      ],
      { staleMs: 30_000, nowMs: NOW },
    );
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0]).toMatchObject({ devicePubkey: 'pk-dead', heldItems: ['F-1'], staleForMs: 60_000 });
  });
});

describe('measureConvergenceLag', () => {
  it('measures arrival lag and judges the SLO', async () => {
    let written = false;
    let polls = 0;
    const r = await measureConvergenceLag({
      write: async () => {
        written = true;
      },
      arrived: async () => written && ++polls >= 2, // arrives on the second poll
      sloMs: 10_000,
      pollMs: 5,
    });
    expect(r.arrived).toBe(true);
    expect(r.breach).toBe(false);
    expect(r.lagMs).toBeGreaterThanOrEqual(0);
  });

  it('a never-arriving probe times out as a breach (the non-arrival IS the signal)', async () => {
    const r = await measureConvergenceLag({
      write: async () => {},
      arrived: async () => false,
      sloMs: 20,
      pollMs: 5,
      timeoutMs: 60,
    });
    expect(r.arrived).toBe(false);
    expect(r.breach).toBe(true);
    expect(r.lagMs).toBeGreaterThanOrEqual(60);
  });
});
