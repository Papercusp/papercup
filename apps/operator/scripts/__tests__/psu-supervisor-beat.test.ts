/**
 * psu supervisor presence beat (agent-liveness-heartbeat-hardening-2026-06-12
 * P-004/P-005): while psu is the agent's live parent, it POSTs the bootstrap-su
 * heartbeat endpoint so a session in a long no-tool-call turn stays presence-
 * warm. Pins: immediate first beat, per-interval re-beat, unref'd timer (never
 * holds psu open), no-op without ownerId, and fail-soft on a down operator.
 */
import { describe, test, expect, vi } from 'vitest';
import { hostname } from 'node:os';
import { startSupervisorBeat, SUPERVISOR_BEAT_MS } from '../psu-launcher.mjs';

interface FakeTimer {
  unref: ReturnType<typeof vi.fn>;
}

function makeTimerCapture() {
  let tick: (() => void) | null = null;
  const timer: FakeTimer = { unref: vi.fn() };
  const setIntervalImpl = ((fn: () => void, _ms: number) => {
    tick = fn;
    return timer;
  }) as unknown as typeof setInterval;
  return { setIntervalImpl, timer, fire: () => tick?.() };
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe('startSupervisorBeat', () => {
  test('beats immediately with the owner id + bearer, then per interval', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"ok":true}'));
    const { setIntervalImpl, timer, fire } = makeTimerCapture();

    const t = startSupervisorBeat('su-test-session', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      operatorUrl: 'http://127.0.0.1:9999',
      token: 'tok-1',
      setIntervalImpl,
    });
    await flush();

    expect(t).toBe(timer);
    expect(timer.unref).toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:9999/api/agent-mcp/console/bootstrap-su/heartbeat');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok-1');
    // pid/host were added to the beat body (agent-liveness-heartbeat-hardening
    // follow-on, coord:presence liveness parity) so the presence roster can tell
    // sessions on the same ownerId apart by process/host — pid is process-specific,
    // so match it structurally rather than pinning an exact number.
    expect(JSON.parse(String(init.body))).toEqual({
      ownerId: 'su-test-session',
      pid: expect.any(Number),
      host: hostname(),
    });

    fire();
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('no ownerId → no timer, no fetch', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}'));
    const { setIntervalImpl } = makeTimerCapture();
    expect(
      startSupervisorBeat(null, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        setIntervalImpl,
      }),
    ).toBeNull();
    await flush();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('a down operator is a missed beat, never a throw or error loop', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const { setIntervalImpl, fire } = makeTimerCapture();
    expect(() =>
      startSupervisorBeat('su-test-session', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        token: '',
        setIntervalImpl,
      }),
    ).not.toThrow();
    await flush();
    // Next tick still tries again (no self-disable on failure).
    fire();
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('the default cadence stays a real supervisor cadence (≤ the roster LIVE window ×2)', () => {
    // 60s beats keep a 10-min claims window trivially warm and cost one tiny
    // UPDATE/min; this guards against an accidental order-of-magnitude bump.
    expect(SUPERVISOR_BEAT_MS).toBeLessThanOrEqual(120_000);
  });
});
