/**
 * coord-inbox-bus — the human-relevance predicate that decides whether a
 * coord_event_log insert should wake the human-facing inbox push (P-002), plus
 * (EI-9991) the failed-LISTEN retry-with-backoff behavior.
 *
 * Regression guard: the originally-shipped producer filtered the NOTIFY
 * payload's `writer_key === 'human'`, but a direct `coord:send {to:['human']}`
 * stores `writer_key = sender` (the human-recipiency lives in `body.to`), so it
 * woke on ZERO real human messages. Relevance MUST key off `to`, never
 * `writer_key`. These cases pin that.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { isHumanRelevantRow } from './coord-inbox-bus';

describe('isHumanRelevantRow', () => {
  it('messages addressed to human are relevant', () => {
    expect(isHumanRelevantRow('messages', ['human'])).toBe(true);
    expect(isHumanRelevantRow('messages', ['su-x', 'human', '*'])).toBe(true);
  });

  it('messages NOT addressed to human are not relevant (writer_key bug regression)', () => {
    expect(isHumanRelevantRow('messages', ['su-a', 'su-b'])).toBe(false);
    expect(isHumanRelevantRow('messages', ['*'])).toBe(false); // pure broadcast — matches the reader (to.includes('human') only)
    expect(isHumanRelevantRow('messages', [])).toBe(false);
    expect(isHumanRelevantRow('messages', ['su-subscriber'])).toBe(false); // fan-out notify to a subscriber id
  });

  it('handoffs addressed to human are relevant; to a peer are not', () => {
    expect(isHumanRelevantRow('handoffs', ['human'])).toBe(true);
    expect(isHumanRelevantRow('handoffs', ['su-x'])).toBe(false);
  });

  it('any escalation row is relevant (open shown / resolution drops it on refetch)', () => {
    expect(isHumanRelevantRow('escalations', null)).toBe(true);
    expect(isHumanRelevantRow('escalations', ['human'])).toBe(true);
  });

  it('plan-events and unknown surfaces are never relevant', () => {
    expect(isHumanRelevantRow('plan-events', ['human'])).toBe(false);
    expect(isHumanRelevantRow('something-else', ['human'])).toBe(false);
  });

  it('tolerates a malformed / non-array `to`', () => {
    expect(isHumanRelevantRow('messages', undefined)).toBe(false);
    expect(isHumanRelevantRow('messages', 'human')).toBe(false);
    expect(isHumanRelevantRow('messages', { human: true })).toBe(false);
  });
});

// ─── EI-9991 retry-on-failed-start (mirrors EI-9920 / pg-notify-bus.test.ts) ───
// `postgres`, `./pg-listen-hub`, and `@papercusp/db-org` (the initCursor peek
// query) are mocked so no real DB connection is ever opened; fake timers drive
// the retry backoff deterministically.

const listen = vi.fn();
const end = vi.fn().mockResolvedValue(undefined);
const postgresFactory = vi.fn((_url?: string, _opts?: unknown) => ({ listen, end }));
// initCursor's tagged-template query — resolves to a single "no history yet" row.
const orgSql = vi.fn(() => Promise.resolve([{ max_id: '0' }]));

vi.mock('postgres', () => ({
  default: (url?: string, opts?: unknown) => postgresFactory(url, opts),
}));
vi.mock('./embedded-pg-discovery', () => ({ getHarnessAdminUrl: () => 'postgres://test' }));
vi.mock('./pg-listen-hub', () => ({
  listenHubEnabled: () => false,
  hubListen: vi.fn(),
}));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: orgSql }),
  // coord-inbox-bus.ts's dedicated LISTEN connection spreads this into its
  // `postgres()` options (mirrors the sync-sse.test.ts EI-18122461766429683 fix) —
  // the mock must export it or the real module's named import is `undefined`,
  // so calling it throws inside ensureStarted's try/catch and `postgres(...)` (the
  // mocked factory `listen` sits behind) is never reached: every listen-mock
  // assertion below sees 0 calls instead of the expected reconnect attempts.
  longLivedPoolConnectionOptions: (_label: string) => ({
    onnotice: () => {},
    connection: {},
  }),
}));

describe('coord-inbox-bus — EI-9991 retry-on-failed-start (mirrors EI-9920)', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.useFakeTimers();
    listen.mockReset();
    end.mockReset().mockResolvedValue(undefined);
    postgresFactory.mockClear();
    orgSql.mockClear().mockImplementation(() => Promise.resolve([{ max_id: '0' }]));
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.resetModules(); // fresh module state per test (started/handlers/retryTimer are module-scoped)
  });

  afterEach(async () => {
    const { _stopForTests } = await import('./coord-inbox-bus');
    await _stopForTests();
    consoleErrorSpy.mockRestore();
    vi.useRealTimers();
  });

  it('a failed LISTEN (CONNECTION_DESTROYED) retries and eventually connects — the handler is not left permanently dead', async () => {
    listen
      .mockRejectedValueOnce(new Error('write CONNECTION_DESTROYED localhost:15968'))
      .mockResolvedValueOnce(undefined);

    const { onCoordInbox, _coordInboxTestSeam } = await import('./coord-inbox-bus');
    onCoordInbox(vi.fn());

    // Deterministically settle attempt 1 via the module's own awaitable-startup
    // seam (`_coordInboxTestSeam.ready`, == `ensureStarted`) instead of a
    // fixed-time `advanceTimersByTimeAsync(0)` guess. `onCoordInbox` already
    // started the attempt synchronously (its `startPromise` is set before this
    // line runs), so `ready()` here just awaits that SAME in-flight promise
    // (memoized — it does not start a second attempt); it blocks until
    // initCursor's DB peek + the listen() call + the retry catch handler have
    // all actually run, so it can't under-flush the way a fixed
    // advanceTimersByTimeAsync(0) tick can under heavy real CPU contention
    // (observed flaky only inside a loaded test:affected run, load1 > 40).
    await _coordInboxTestSeam.ready();
    expect(listen).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(499);
    expect(listen).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1); // 500ms backoff elapses → retry fires
    await _coordInboxTestSeam.ready(); // settle the retry attempt too (same race)
    expect(listen).toHaveBeenCalledTimes(2);
  });

  it('unsubscribing while a retry is pending cancels it — no leaked reconnect for an empty bus', async () => {
    listen.mockRejectedValue(new Error('still down'));

    const { onCoordInbox, _coordInboxTestSeam } = await import('./coord-inbox-bus');
    const unsubscribe = onCoordInbox(vi.fn());

    await _coordInboxTestSeam.ready(); // attempt 1 fails, retry scheduled — deterministic settle, see note above
    expect(listen).toHaveBeenCalledTimes(1);

    unsubscribe();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(listen).toHaveBeenCalledTimes(1); // never retried into an empty bus
  });

  // WI-10004194: a close that ran while the start was still in flight saw
  // started=false and did nothing; the start must close itself when it finds
  // no handler left, or the LISTEN connection stays open with nobody to wake.
  it('WI-10004194: a start that finishes after the last handler left closes its LISTEN', async () => {
    let resolveListen!: () => void;
    listen.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveListen = resolve; }));

    const { onCoordInbox, _coordInboxTestSeam } = await import('./coord-inbox-bus');
    const unsubscribe = onCoordInbox(vi.fn());
    await vi.waitFor(() => expect(listen).toHaveBeenCalledTimes(1));

    unsubscribe(); // mid-start: nothing to close yet
    expect(end).not.toHaveBeenCalled();

    resolveListen();
    await _coordInboxTestSeam.ready();
    expect(end).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('a well-formed first start never schedules a retry', async () => {
    listen.mockResolvedValueOnce(undefined);

    const { onCoordInbox, _coordInboxTestSeam } = await import('./coord-inbox-bus');
    onCoordInbox(vi.fn());
    await _coordInboxTestSeam.ready(); // deterministic settle — see note above

    expect(listen).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(listen).toHaveBeenCalledTimes(1);
  });
});
