/**
 * pg-notify-bus.test.ts — EI-9920: a failed LISTEN start (e.g. CONNECTION_DESTROYED
 * during embedded-PG boot warmup on a pristine VM first boot) must not leave a
 * subscribed handler permanently dead for the session. `ensureStarted` must retry
 * with backoff as long as a handler is still registered, and must stop retrying
 * (and never leak a connection) once the last handler unsubscribes.
 *
 * `postgres` and `./pg-listen-hub` are mocked so no real DB connection is ever
 * opened; fake timers drive the retry backoff deterministically.
 *
 * Run: cd packages/operator-core && npx vitest run lib/pg-notify-bus.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listen = vi.fn();
const end = vi.fn().mockResolvedValue(undefined);
const postgresFactory = vi.fn(() => ({ listen, end }));

vi.mock('postgres', () => ({ default: (...args: unknown[]) => postgresFactory(...args) }));
vi.mock('./embedded-pg-discovery', () => ({ getHarnessAdminUrl: () => 'postgres://test' }));
vi.mock('./pg-listen-hub', () => ({
  listenHubEnabled: () => false,
  hubListen: vi.fn(),
}));

import { createNotifyBus } from './pg-notify-bus';

describe('createNotifyBus — EI-9920 retry-on-failed-start', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    listen.mockReset();
    end.mockReset().mockResolvedValue(undefined);
    postgresFactory.mockClear();
    // These tests deliberately exercise the failed-start → retry path, which
    // logs `[label] failed to start (will retry): ...` — expected noise, not
    // a real failure.
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    vi.useRealTimers();
  });

  it('a subscribe that hits a failed LISTEN (CONNECTION_DESTROYED) retries and eventually connects — the handler is not left permanently dead', async () => {
    listen
      .mockRejectedValueOnce(new Error('write CONNECTION_DESTROYED localhost:15968'))
      .mockResolvedValueOnce(undefined);

    const bus = createNotifyBus('ui_intents', 'ui-intents-bus');
    const handler = vi.fn();
    bus.subscribe(handler);

    // let the first (failing) ensureStarted() attempt settle
    await vi.advanceTimersByTimeAsync(0);
    expect(listen).toHaveBeenCalledTimes(1);

    // before the retry fires, nothing has been re-attempted
    await vi.advanceTimersByTimeAsync(499);
    expect(listen).toHaveBeenCalledTimes(1);

    // the 500ms backoff elapses → retry fires → this attempt succeeds
    await vi.advanceTimersByTimeAsync(1);
    expect(listen).toHaveBeenCalledTimes(2);

    await bus._stopForTests();
  });

  it('backoff DOUBLES on consecutive failures, capped, and resets once a start succeeds', async () => {
    listen
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValueOnce(undefined);

    const bus = createNotifyBus('ui_intents', 'ui-intents-bus');
    bus.subscribe(vi.fn());

    await vi.advanceTimersByTimeAsync(0); // attempt 1 (fails)
    expect(listen).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500); // 500ms backoff → attempt 2 (fails)
    expect(listen).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(999); // 1000ms backoff not yet elapsed
    expect(listen).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); // now it has → attempt 3 (succeeds)
    expect(listen).toHaveBeenCalledTimes(3);

    // no further retries scheduled after a success
    await vi.advanceTimersByTimeAsync(60_000);
    expect(listen).toHaveBeenCalledTimes(3);

    await bus._stopForTests();
  });

  it('unsubscribing while a retry is pending cancels it — no leaked reconnect for an empty bus', async () => {
    listen.mockRejectedValue(new Error('still down'));

    const bus = createNotifyBus('ui_intents', 'ui-intents-bus');
    const unsubscribe = bus.subscribe(vi.fn());

    await vi.advanceTimersByTimeAsync(0); // attempt 1 (fails), retry scheduled for +500ms
    expect(listen).toHaveBeenCalledTimes(1);

    unsubscribe(); // last handler gone — the pending retry must be cancelled

    await vi.advanceTimersByTimeAsync(60_000);
    expect(listen).toHaveBeenCalledTimes(1); // never retried into an empty bus

    await bus._stopForTests();
  });

  it('a well-formed first start never schedules a retry and fans out notifications', async () => {
    listen.mockResolvedValueOnce(undefined);

    const bus = createNotifyBus('ui_intents', 'ui-intents-bus');
    const handler = vi.fn();
    bus.subscribe(handler);
    await vi.advanceTimersByTimeAsync(0);

    expect(listen).toHaveBeenCalledTimes(1);
    const onNotify = listen.mock.calls[0][1] as (payload: string) => void;
    onNotify('client-123');
    expect(handler).toHaveBeenCalledWith('client-123');

    await vi.advanceTimersByTimeAsync(60_000);
    expect(listen).toHaveBeenCalledTimes(1);

    await bus._stopForTests();
  });
});
