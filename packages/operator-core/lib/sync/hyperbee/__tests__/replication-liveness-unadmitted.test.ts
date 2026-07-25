/**
 * WI-5781 — the EXPECTED-but-unadmitted replication axis.
 *
 * Every other axis samples logs drawn from the ADMITTED set (the sole caller of
 * `sampleReplicationLiveness` runs inside the merge pass's per-admitted-log
 * loop), so a log that is never admitted is never iterated, never sampled, and
 * emits nothing at all. That made "replication is dead" and "replication is
 * healthy" the same observable — silence — on a member frame that buffered the
 * owner's announce instead of admitting it.
 *
 * These tests pin the axis that can see that case.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  _resetReplicationLivenessForTests,
  clearUnadmittedPeer,
  getReplicationLiveness,
  sampleUnadmittedPeer,
  type ReplicationStallEpisode,
} from '../replication-liveness';

const WS = 'ws1';
const H = 'hello-world';
const KEY = '5fe26c2e0135';
const GRACE = 60_000;

describe('replication-liveness: expected-but-unadmitted axis (WI-5781)', () => {
  beforeEach(() => {
    _resetReplicationLivenessForTests();
  });

  it('does NOT alarm inside the grace window', () => {
    const episodes: ReplicationStallEpisode[] = [];
    const t0 = 1_000_000;

    sampleUnadmittedPeer(
      WS,
      H,
      { keyHex: KEY, pendingSinceMs: t0 },
      { nowMs: t0 + GRACE - 1, graceMs: GRACE, onStallEpisode: (e) => episodes.push(e) },
    );

    expect(episodes).toEqual([]);
  });

  it('alarms once the peer has been expected-but-unadmitted past the grace window', () => {
    const episodes: ReplicationStallEpisode[] = [];
    const t0 = 1_000_000;

    sampleUnadmittedPeer(
      WS,
      H,
      { keyHex: KEY, pendingSinceMs: t0, reason: 'buffered awaiting membership' },
      { nowMs: t0 + GRACE + 1, graceMs: GRACE, onStallEpisode: (e) => episodes.push(e) },
    );

    expect(episodes).toHaveLength(1);
    expect(episodes[0].kind).toBe('expected_never_admitted');
    expect(episodes[0].logKeyHex).toBe(KEY);
    expect(episodes[0].detail).toContain('NEVER been admitted');
    expect(episodes[0].detail).toContain('buffered awaiting membership');
  });

  it('is EDGE-triggered — one episode per stall, not one per merge pass', () => {
    const episodes: ReplicationStallEpisode[] = [];
    const t0 = 1_000_000;
    const opts = { graceMs: GRACE, onStallEpisode: (e: ReplicationStallEpisode) => episodes.push(e) };

    // The merge pass runs continuously; a per-pass alarm would be a log flood.
    for (let i = 1; i <= 5; i += 1) {
      sampleUnadmittedPeer(WS, H, { keyHex: KEY, pendingSinceMs: t0 }, { ...opts, nowMs: t0 + GRACE + i * 1000 });
    }

    expect(episodes).toHaveLength(1);
  });

  it('a re-announce does NOT reset the pending clock', () => {
    const episodes: ReplicationStallEpisode[] = [];
    const t0 = 1_000_000;
    const opts = { graceMs: GRACE, onStallEpisode: (e: ReplicationStallEpisode) => episodes.push(e) };

    // A peer that re-announces every few seconds would otherwise never age past
    // the grace window and would stay permanently invisible — the same
    // absorbing-state shape this axis exists to break.
    sampleUnadmittedPeer(WS, H, { keyHex: KEY, pendingSinceMs: t0 }, { ...opts, nowMs: t0 + 1000 });
    sampleUnadmittedPeer(
      WS,
      H,
      { keyHex: KEY, pendingSinceMs: t0 + GRACE }, // re-buffered "just now"
      { ...opts, nowMs: t0 + GRACE + 1 },
    );

    expect(episodes).toHaveLength(1);
    expect(episodes[0].stalledForMs).toBeGreaterThan(GRACE);
  });

  it('reports recovery when the peer is finally admitted, so the durable EI auto-resolves', () => {
    const episodes: ReplicationStallEpisode[] = [];
    const recoveries: ReplicationStallEpisode[] = [];
    const t0 = 1_000_000;

    sampleUnadmittedPeer(
      WS,
      H,
      { keyHex: KEY, pendingSinceMs: t0 },
      { nowMs: t0 + GRACE + 1, graceMs: GRACE, onStallEpisode: (e) => episodes.push(e) },
    );
    expect(episodes).toHaveLength(1);

    clearUnadmittedPeer(WS, H, KEY, { nowMs: t0 + GRACE + 5000, onRecovery: (e) => recoveries.push(e) });

    expect(recoveries).toHaveLength(1);
    expect(recoveries[0].kind).toBe('expected_never_admitted');
    expect(getReplicationLiveness({ workspaceId: WS }).find((h) => h.harnessSlug === H)).toBeUndefined();
  });

  it('does NOT report a recovery for a peer that never alarmed', () => {
    const recoveries: ReplicationStallEpisode[] = [];
    const t0 = 1_000_000;

    sampleUnadmittedPeer(WS, H, { keyHex: KEY, pendingSinceMs: t0 }, { nowMs: t0 + 1, graceMs: GRACE });
    clearUnadmittedPeer(WS, H, KEY, { nowMs: t0 + 2, onRecovery: (e) => recoveries.push(e) });

    expect(recoveries).toEqual([]);
  });

  it('surfaces a harness that has ONLY unadmitted peers — the whole point of the axis', () => {
    const t0 = 1_000_000;
    // Such a harness has ZERO sampled logs by definition, so it would be absent
    // from the read surface entirely if the axis did not add its registry key.
    sampleUnadmittedPeer(
      WS,
      H,
      { keyHex: KEY, pendingSinceMs: t0, reason: 'buffered awaiting membership' },
      { nowMs: t0 + GRACE + 1, graceMs: GRACE, onStallEpisode: () => {} },
    );

    const harness = getReplicationLiveness({ workspaceId: WS, nowMs: t0 + GRACE + 1 }).find(
      (h) => h.harnessSlug === H,
    );

    expect(harness).toBeDefined();
    expect(harness?.logs).toEqual([]); // nothing admitted — silence, previously
    expect(harness?.counts.expectedNeverAdmitted).toBe(1);
    expect(harness?.expectedNeverAdmitted[0]).toMatchObject({
      keyHex: KEY,
      alarmed: true,
      reason: 'buffered awaiting membership',
    });
  });
});
