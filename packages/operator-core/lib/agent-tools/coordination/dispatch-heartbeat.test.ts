/**
 * dispatch-heartbeat — the turn-level presence beat at the dispatch seam
 * (agent-liveness-heartbeat-hardening-2026-06-12 P-001/P-002). Pins: beat
 * fires for a resolvable owner, throttles within the window, re-fires after
 * it, skips anonymous callers without throwing, and swallows beat failures.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import {
  maybeBeatPresenceOnDispatch,
  __resetDispatchHeartbeatThrottle,
  DISPATCH_BEAT_INTERVAL_MS,
} from './dispatch-heartbeat';

/** A superuser ctx — resolveAgentIdentity maps uiClientId → ownerId. */
const SU_CTX = { isSuperuser: true, uiClientId: 'su-test-owner-1', workspaceId: 'ws' };

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe('maybeBeatPresenceOnDispatch', () => {
  beforeEach(() => {
    __resetDispatchHeartbeatThrottle();
  });

  test('beats the resolved owner exactly once per throttle window', async () => {
    const beat = vi.fn(async () => {});
    let t = 1_000_000;
    const now = () => t;

    maybeBeatPresenceOnDispatch(SU_CTX, { beat, now });
    maybeBeatPresenceOnDispatch(SU_CTX, { beat, now }); // same instant — throttled
    t += DISPATCH_BEAT_INTERVAL_MS - 1;
    maybeBeatPresenceOnDispatch(SU_CTX, { beat, now }); // still inside — throttled
    await flush();
    expect(beat).toHaveBeenCalledTimes(1);
    expect(beat).toHaveBeenCalledWith('su-test-owner-1');

    t += 2; // crosses the window
    maybeBeatPresenceOnDispatch(SU_CTX, { beat, now });
    await flush();
    expect(beat).toHaveBeenCalledTimes(2);
  });

  test('different owners throttle independently', async () => {
    const beat = vi.fn(async () => {});
    const now = () => 5_000_000;
    maybeBeatPresenceOnDispatch(SU_CTX, { beat, now });
    maybeBeatPresenceOnDispatch(
      { isSuperuser: true, uiClientId: 'su-test-owner-2' },
      { beat, now },
    );
    await flush();
    expect(beat.mock.calls.map((c) => c[0])).toEqual(['su-test-owner-1', 'su-test-owner-2']);
  });

  test('anonymous / unresolvable ctx is skipped without throwing', async () => {
    const beat = vi.fn(async () => {});
    // No identity markers at all → resolveAgentIdentity throws → swallowed.
    expect(() => maybeBeatPresenceOnDispatch({}, { beat })).not.toThrow();
    // Superuser ctx MISSING uiClientId → resolver throws → swallowed.
    expect(() =>
      maybeBeatPresenceOnDispatch({ isSuperuser: true }, { beat }),
    ).not.toThrow();
    await flush();
    expect(beat).not.toHaveBeenCalled();
  });

  test('a failing beat is swallowed and retried on the next window', async () => {
    const beat = vi.fn(async () => {
      throw new Error('pg down');
    });
    let t = 9_000_000;
    const now = () => t;
    expect(() => maybeBeatPresenceOnDispatch(SU_CTX, { beat, now })).not.toThrow();
    await flush();
    expect(beat).toHaveBeenCalledTimes(1);

    t += DISPATCH_BEAT_INTERVAL_MS + 1;
    maybeBeatPresenceOnDispatch(SU_CTX, { beat, now });
    await flush();
    expect(beat).toHaveBeenCalledTimes(2);
  });

  test('power-user and signed-spawn identities beat under their own ids', async () => {
    const beat = vi.fn(async () => {});
    const now = () => 12_000_000;
    maybeBeatPresenceOnDispatch(
      { isPowerUser: true, uiClientId: 'pus-abc', workspaceId: 'ws' },
      { beat, now },
    );
    maybeBeatPresenceOnDispatch(
      { principal: { slug: 'oracle', workspaceId: 'ws' } },
      { beat, now },
    );
    await flush();
    expect(beat.mock.calls.map((c) => c[0])).toEqual(['pus-abc', 'oracle']);
  });
});
