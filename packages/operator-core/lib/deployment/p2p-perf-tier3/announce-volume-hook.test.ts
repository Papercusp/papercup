/**
 * The P-015 forward-hook guard (p2p-performance-suite-2026-06-07).
 *
 * This test is the DURABLE REMINDER: it asserts the announce-volume scenario is
 * present-but-pending. The moment the hive-directory substrate ships and
 * `hiveDirectoryReady()` is flipped to detect it, the pending assertions here
 * FAIL — forcing whoever ships it to implement the real scenario (the activation
 * steps are in announce-volume-hook.ts's header) instead of letting the hook rot.
 */

import { describe, it, expect } from 'vitest';
import {
  ANNOUNCE_VOLUME_DESIGN,
  AnnounceVolumePendingError,
  announceVolumeScenario,
  hiveDirectoryReady,
} from './announce-volume-hook';

describe('P-015 forward hook: tier3.announce-volume (blocked on p2p-hive-directory-2026-06-06)', () => {
  it('documents the network-scale design', () => {
    expect(ANNOUNCE_VOLUME_DESIGN.scenarioId).toBe('tier3.announce-volume');
    expect(ANNOUNCE_VOLUME_DESIGN.blockedOnPlan).toBe('p2p-hive-directory-2026-06-06');
    expect(ANNOUNCE_VOLUME_DESIGN.scalingAxis).toContain('network');
    expect(ANNOUNCE_VOLUME_DESIGN.metrics.length).toBeGreaterThan(0);
  });

  it('is PENDING until the hive-directory substrate exists — flip this test when it ships', async () => {
    // When hiveDirectoryReady() becomes true, BOTH assertions fail → implement the
    // real scenario per the hook header, then rewrite this test around it.
    expect(hiveDirectoryReady()).toBe(false);
    await expect(
      announceVolumeScenario({ launcher: { slots: [] }, nodeCount: 3 }),
    ).rejects.toBeInstanceOf(AnnounceVolumePendingError);
  });
});
