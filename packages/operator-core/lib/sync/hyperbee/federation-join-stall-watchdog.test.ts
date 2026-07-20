import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  evaluateFederationJoinStall,
  checkFederationJoinStall,
  _resetFederationJoinStallAlertsForTests,
  DEFAULT_FEDERATION_JOIN_STALL_MS,
} from './federation-join-stall-watchdog';
import { recordBootEvent, _resetBootHistoryForTests } from './boot-history';

vi.mock('../../severe-event-broadcast', () => ({
  broadcastSevereEvent: vi.fn().mockResolvedValue(true),
  broadcastSevereEventResolvedMany: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../attention-notify', () => ({
  notifyAttention: vi.fn().mockResolvedValue(undefined),
}));

describe('evaluateFederationJoinStall (pure)', () => {
  it('is healthy when nothing has ever joined this process lifetime', () => {
    expect(evaluateFederationJoinStall(null, Date.now()).stalled).toBe(false);
  });

  it('is healthy when the latest outcome is join_succeeded, however old', () => {
    const v = evaluateFederationJoinStall(
      { kind: 'join_succeeded', ts: Date.now() - 10 * 60 * 60 * 1000, message: undefined },
      Date.now(),
    );
    expect(v.stalled).toBe(false);
  });

  it('is NOT stalled while a swarm_join_failed is still within the stale window', () => {
    const now = Date.now();
    const v = evaluateFederationJoinStall(
      { kind: 'swarm_join_failed', ts: now - 5 * 60 * 1000, message: 'gh not authenticated' },
      now,
      DEFAULT_FEDERATION_JOIN_STALL_MS,
    );
    expect(v.stalled).toBe(false);
    expect(v.failedForMs).toBe(5 * 60 * 1000);
  });

  it('IS stalled once a swarm_join_failed has persisted past the stale window (EI-16949/WI-757 repro shape)', () => {
    const now = Date.now();
    const v = evaluateFederationJoinStall(
      { kind: 'swarm_join_failed', ts: now - 45 * 60 * 1000, message: 'local-announce-identity: gh not authenticated' },
      now,
      DEFAULT_FEDERATION_JOIN_STALL_MS,
    );
    expect(v.stalled).toBe(true);
    expect(v.reason).toContain('gh not authenticated');
    expect(v.reason).toContain('silently LOCAL-ONLY');
  });
});

describe('checkFederationJoinStall (boot-history integration)', () => {
  beforeEach(() => {
    _resetBootHistoryForTests();
    _resetFederationJoinStallAlertsForTests();
  });
  afterEach(() => {
    _resetBootHistoryForTests();
    _resetFederationJoinStallAlertsForTests();
    vi.clearAllMocks();
  });

  it('alarms once for a harness stuck on swarm_join_failed, then recovers on a later join_succeeded', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const t0 = Date.now();
      recordBootEvent('ws-1', 'fed-a', 'swarm_join_failed', 'gh not authenticated');

      const pass1 = await checkFederationJoinStall(30 * 60 * 1000);
      expect(pass1.alarmed).toEqual([]); // within the stale window

      vi.setSystemTime(t0 + 40 * 60 * 1000);
      const pass2 = await checkFederationJoinStall(30 * 60 * 1000);
      expect(pass2.alarmed).toEqual(['ws-1:fed-a']);

      // One-shot: a THIRD sweep with no new events must not re-alarm.
      const pass3 = await checkFederationJoinStall(30 * 60 * 1000);
      expect(pass3.alarmed).toEqual([]);

      // Recovery: a later join_succeeded clears the alert.
      vi.setSystemTime(t0 + 41 * 60 * 1000);
      recordBootEvent('ws-1', 'fed-a', 'join_succeeded', 'topic=abc');
      const pass4 = await checkFederationJoinStall(30 * 60 * 1000);
      expect(pass4.recovered).toEqual(['ws-1:fed-a']);
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('never alarms a harness that has no join outcome recorded', async () => {
    const result = await checkFederationJoinStall();
    expect(result.alarmed).toEqual([]);
    expect(result.recovered).toEqual([]);
  });
});
