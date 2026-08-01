/**
 * fetch-coalescer.test.ts — WI-6418.
 *
 * The first test is the LIVELOCK REGRESSION, written to reproduce the observed
 * production failure rather than to exercise the API: N drivers each drive a
 * fetch for the same repo while an earlier one is still streaming, and every
 * one of them opens its own session. On the real system each of those sessions
 * killed (later: was refused by) the transfer already in progress, so a 4.1GB
 * pot served 145MB→790MB nine times over and converged never.
 *
 * The assertion that matters is therefore about SESSIONS OPENED, not about
 * return values: it is opening the second session that does the damage.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  fetchCoalescerKey,
  inFlightFetchCountForTest,
  isFetchInFlight,
  withFetchCoalescing,
} from './fetch-coalescer';

/** A fetch that stays "streaming" until released — a stand-in for the ~175s
 *  multi-GB transfer that the ~15s drive period kept interrupting. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const KEY = fetchCoalescerKey('topic-abc', 'papercusp');

describe('withFetchCoalescing (WI-6418 — one in-flight fetch per repo)', () => {
  it('REGRESSION: concurrent drives for the same repo open exactly ONE session', async () => {
    const gate = deferred();
    const openSession = vi.fn(() => gate.promise);

    // Driver 1 starts the long transfer.
    const first = withFetchCoalescing(KEY, openSession);
    // Drivers 2..12 arrive while it is still streaming — on this fleet, one
    // every ~15s from a different staggered git-sync routine.
    const rest = await Promise.all(Array.from({ length: 11 }, () => withFetchCoalescing(KEY, openSession)));

    // THE BUG: pre-fix this was 12.
    expect(openSession).toHaveBeenCalledTimes(1);
    expect(rest.every((r) => !r.ran && r.reason === 'already-in-flight')).toBe(true);

    gate.resolve();
    await expect(first).resolves.toEqual({ ran: true, result: undefined });
  });

  it('admits the next fetch once the in-flight one settles (the refusal is not sticky)', async () => {
    const gate = deferred();
    const first = withFetchCoalescing(KEY, () => gate.promise);
    expect((await withFetchCoalescing(KEY, async () => 'B')).ran).toBe(false);

    gate.resolve();
    await first;

    // A refusal that outlived its transfer would wedge the repo forever —
    // strictly worse than the livelock it replaced.
    await expect(withFetchCoalescing(KEY, async () => 'C')).resolves.toEqual({ ran: true, result: 'C' });
  });

  it('releases the entry when the fetch THROWS, and propagates the error', async () => {
    await expect(
      withFetchCoalescing(KEY, async () => {
        throw new Error('serve refused: busy-streaming');
      }),
    ).rejects.toThrow('busy-streaming');

    expect(isFetchInFlight(KEY)).toBe(false);
    await expect(withFetchCoalescing(KEY, async () => 'after-throw')).resolves.toEqual({
      ran: true,
      result: 'after-throw',
    });
  });

  it('releases the entry when the fetch throws SYNCHRONOUSLY', async () => {
    // `fn()` is called inside the registration path, so a synchronous throw
    // takes a different route out than a rejected promise does.
    await expect(
      withFetchCoalescing(KEY, (): Promise<never> => {
        throw new Error('sync boom');
      }),
    ).rejects.toThrow('sync boom');
    expect(inFlightFetchCountForTest()).toBe(0);
  });

  it('does not block a DIFFERENT repo, or the same repo on a different topic', async () => {
    const gate = deferred();
    const held = withFetchCoalescing(KEY, () => gate.promise);

    // Different repo, same topic.
    await expect(
      withFetchCoalescing(fetchCoalescerKey('topic-abc', 'other-repo'), async () => 'ok'),
    ).resolves.toEqual({ ran: true, result: 'ok' });
    // Same repo, different topic — a genuinely separate transfer.
    await expect(
      withFetchCoalescing(fetchCoalescerKey('topic-zzz', 'papercusp'), async () => 'ok'),
    ).resolves.toEqual({ ran: true, result: 'ok' });

    gate.resolve();
    await held;
  });

  it('two callers in the SAME TICK cannot both start (registration precedes any await)', async () => {
    const gate = deferred();
    const openSession = vi.fn(() => gate.promise);

    // No await between them — the race the guard has to close.
    const [a, b] = await Promise.all([
      withFetchCoalescing(KEY, openSession).catch(() => null),
      withFetchCoalescing(KEY, openSession),
    ]).catch(() => [null, null]);
    void a;
    void b;

    expect(openSession).toHaveBeenCalledTimes(1);
    gate.resolve();
  });

  it('leaks nothing across a full cycle', async () => {
    expect(inFlightFetchCountForTest()).toBe(0);
    await withFetchCoalescing(KEY, async () => 'x');
    expect(inFlightFetchCountForTest()).toBe(0);
  });
});
