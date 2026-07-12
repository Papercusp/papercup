/**
 * agent-activity-bus.test.ts — the cross-CLI activity bridge's NOTIFY-payload
 * parser, plus (EI-9991) the failed-LISTEN retry-with-backoff behavior.
 *
 * `ownerFromPayload` extracts the owner_id from the migration-143 payload
 * `"<workspace_id>::<owner_id>"`; a wrong parse means the /api/activity/stream
 * fan-out wakes the wrong (or no) subscriber. Pure — importing the module opens
 * no connection (the bus is lazy-start), so those cases need no mocks.
 *
 * The retry suite mirrors pg-notify-bus.test.ts's EI-9920 coverage: `postgres`
 * and `./pg-listen-hub` are mocked so no real DB connection is ever opened, and
 * fake timers drive the retry backoff deterministically.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-activity-bus.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ownerFromPayload } from './agent-activity-bus';

describe('ownerFromPayload', () => {
  it('returns "" for an undefined/empty payload', () => {
    expect(ownerFromPayload(undefined)).toBe('');
    expect(ownerFromPayload('')).toBe('');
  });

  it('extracts the owner_id after the "::" delimiter', () => {
    expect(ownerFromPayload('ws-default::su-abc')).toBe('su-abc');
  });

  it('returns "" when there is no delimiter', () => {
    expect(ownerFromPayload('no-delimiter-here')).toBe('');
  });

  it('keeps everything after the FIRST delimiter (owner ids may contain "::")', () => {
    expect(ownerFromPayload('ws::su::weird::id')).toBe('su::weird::id');
  });

  it('handles an empty workspace or empty owner side', () => {
    expect(ownerFromPayload('::su-only')).toBe('su-only');
    expect(ownerFromPayload('ws-only::')).toBe('');
  });
});

const listen = vi.fn();
const end = vi.fn().mockResolvedValue(undefined);
const postgresFactory = vi.fn((_url?: string, _opts?: unknown) => ({ listen, end }));

vi.mock('postgres', () => ({
  default: (url?: string, opts?: unknown) => postgresFactory(url, opts),
}));
vi.mock('./embedded-pg-discovery', () => ({ getHarnessAdminUrl: () => 'postgres://test' }));
vi.mock('./pg-listen-hub', () => ({
  listenHubEnabled: () => false,
  hubListen: vi.fn(),
}));

describe('agent-activity-bus — EI-9991 retry-on-failed-start (mirrors EI-9920)', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.useFakeTimers();
    listen.mockReset();
    end.mockReset().mockResolvedValue(undefined);
    postgresFactory.mockClear();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Fresh module state per test (started/handlers/retryTimer are module-scoped).
    vi.resetModules();
  });

  afterEach(async () => {
    const { _stopForTests } = await import('./agent-activity-bus');
    await _stopForTests();
    consoleErrorSpy.mockRestore();
    vi.useRealTimers();
  });

  it('a failed LISTEN (CONNECTION_DESTROYED) retries and eventually connects — the handler is not left permanently dead', async () => {
    listen
      .mockRejectedValueOnce(new Error('write CONNECTION_DESTROYED localhost:15968'))
      .mockResolvedValueOnce(undefined);

    const { onAgentActivity } = await import('./agent-activity-bus');
    const handler = vi.fn();
    onAgentActivity(handler);

    await vi.advanceTimersByTimeAsync(0);
    expect(listen).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(499);
    expect(listen).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1); // 500ms backoff elapses → retry succeeds
    expect(listen).toHaveBeenCalledTimes(2);
  });

  it('unsubscribing while a retry is pending cancels it — no leaked reconnect for an empty bus', async () => {
    listen.mockRejectedValue(new Error('still down'));

    const { onAgentActivity } = await import('./agent-activity-bus');
    const unsubscribe = onAgentActivity(vi.fn());

    await vi.advanceTimersByTimeAsync(0); // attempt 1 fails, retry scheduled
    expect(listen).toHaveBeenCalledTimes(1);

    unsubscribe();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(listen).toHaveBeenCalledTimes(1); // never retried into an empty bus
  });

  it('a well-formed first start never schedules a retry and fans out the owner_id', async () => {
    listen.mockResolvedValueOnce(undefined);

    const { onAgentActivity } = await import('./agent-activity-bus');
    const handler = vi.fn();
    onAgentActivity(handler);
    await vi.advanceTimersByTimeAsync(0);

    expect(listen).toHaveBeenCalledTimes(1);
    const onNotify = listen.mock.calls[0][1] as (payload: string) => void;
    onNotify('ws-default::su-abc');
    expect(handler).toHaveBeenCalledWith('su-abc');

    await vi.advanceTimersByTimeAsync(60_000);
    expect(listen).toHaveBeenCalledTimes(1);
  });
});
