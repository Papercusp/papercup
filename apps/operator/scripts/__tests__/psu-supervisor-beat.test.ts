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

/**
 * EI-19412221266350408 — psu exits when its session is authoritatively FINISHED.
 *
 * The zombie: psu outlived its agent session by ~9h holding a fleet slot, a pid and a
 * cgroup with nothing inside it — and THIS beat is what made it look healthy, warming the
 * presence row long after the session died.
 *
 * Every test below is really about ONE property: the ONLY thing that may terminate psu is
 * a REPEATED, EXPLICIT terminal verdict on an established session. The asymmetry is the
 * whole design — a lingering zombie costs a slot, a wrongly-killed launcher costs a live
 * agent (and, on a fresh launch, a fleet that cannot boot). So the negative cases here
 * matter more than the positive one.
 */
describe('startSupervisorBeat — terminal-session self-exit (EI-19412221266350408)', () => {
  const reply = (body: string) => vi.fn(async () => new Response(body));
  const TERMINAL = '{"ok":true,"sessionTerminal":true,"sessionState":"ended"}';
  const HEALTHY = '{"ok":true}';

  /** Arm the beat with an established session (uptime well past the floor). */
  function arm(fetchImpl: ReturnType<typeof reply>, over: Record<string, unknown> = {}) {
    const onTerminalSession = vi.fn();
    const { setIntervalImpl, fire } = makeTimerCapture();
    startSupervisorBeat('su-zombie', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      operatorUrl: 'http://127.0.0.1:9999',
      token: 't',
      setIntervalImpl,
      uptimeMsFn: () => 60 * 60_000, // an hour up — established
      onTerminalSession,
      ...over,
    });
    return { onTerminalSession, fire };
  }

  test('exits after TWO consecutive terminal verdicts on an established session', async () => {
    const { onTerminalSession, fire } = arm(reply(TERMINAL));
    await flush();
    expect(onTerminalSession, 'one verdict must not be enough').not.toHaveBeenCalled();
    fire();
    await flush();
    expect(onTerminalSession).toHaveBeenCalledTimes(1);
  });

  test('a SINGLE terminal verdict never exits — one sample is not a verdict', async () => {
    const fetchImpl = vi.fn();
    fetchImpl.mockResolvedValueOnce(new Response(TERMINAL));
    fetchImpl.mockResolvedValue(new Response(HEALTHY));
    const { onTerminalSession, fire } = arm(fetchImpl as never);
    await flush();
    fire();
    await flush();
    expect(onTerminalSession).not.toHaveBeenCalled();
  });

  test('a healthy beat RESETS the streak — terminal/healthy/terminal is not two in a row', async () => {
    const fetchImpl = vi.fn();
    fetchImpl.mockResolvedValueOnce(new Response(TERMINAL));
    fetchImpl.mockResolvedValueOnce(new Response(HEALTHY));
    fetchImpl.mockResolvedValue(new Response(TERMINAL));
    const { onTerminalSession, fire } = arm(fetchImpl as never);
    await flush();
    fire();
    await flush();
    fire();
    await flush();
    expect(onTerminalSession).not.toHaveBeenCalled();
  });

  test('NEVER exits during startup, however many terminal verdicts arrive', async () => {
    // The suicide-on-startup guard. A fresh session has declared no intent and armed no
    // wake, so it is the most likely to be misjudged AND the most costly to kill: the
    // failure would be a fleet that cannot boot, not one leaked slot.
    const { onTerminalSession, fire } = arm(reply(TERMINAL), { uptimeMsFn: () => 5_000 });
    await flush();
    fire();
    await flush();
    fire();
    await flush();
    expect(onTerminalSession).not.toHaveBeenCalled();
  });

  test('a FAILED beat proves nothing — it resets the streak instead of counting toward it', async () => {
    const fetchImpl = vi.fn();
    fetchImpl.mockResolvedValueOnce(new Response(TERMINAL));
    fetchImpl.mockRejectedValueOnce(new Error('operator down'));
    fetchImpl.mockResolvedValue(new Response(TERMINAL));
    const { onTerminalSession, fire } = arm(fetchImpl as never);
    await flush();
    fire(); // the throw — streak back to 0
    await flush();
    fire(); // terminal again, but only #1 since the reset
    await flush();
    expect(onTerminalSession).not.toHaveBeenCalled();
  });

  test('an unreadable body is not a terminal verdict', async () => {
    const { onTerminalSession, fire } = arm(reply('not json at all'));
    await flush();
    fire();
    await flush();
    expect(onTerminalSession).not.toHaveBeenCalled();
  });

  test('a normal {ok:true} beat never exits — the pre-existing contract is untouched', async () => {
    const { onTerminalSession, fire } = arm(reply(HEALTHY));
    await flush();
    fire();
    await flush();
    fire();
    await flush();
    expect(onTerminalSession).not.toHaveBeenCalled();
  });
});
