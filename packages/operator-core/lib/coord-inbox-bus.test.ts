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
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: orgSql }) }));

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

    const { onCoordInbox } = await import('./coord-inbox-bus');
    onCoordInbox(vi.fn());

    await vi.advanceTimersByTimeAsync(0); // attempt 1 fails
    expect(listen).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(499);
    expect(listen).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1); // 500ms backoff elapses → retry succeeds
    expect(listen).toHaveBeenCalledTimes(2);
  });

  it('unsubscribing while a retry is pending cancels it — no leaked reconnect for an empty bus', async () => {
    listen.mockRejectedValue(new Error('still down'));

    const { onCoordInbox } = await import('./coord-inbox-bus');
    const unsubscribe = onCoordInbox(vi.fn());

    await vi.advanceTimersByTimeAsync(0); // attempt 1 fails, retry scheduled
    expect(listen).toHaveBeenCalledTimes(1);

    unsubscribe();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(listen).toHaveBeenCalledTimes(1); // never retried into an empty bus
  });

  it('a well-formed first start never schedules a retry', async () => {
    listen.mockResolvedValueOnce(undefined);

    const { onCoordInbox } = await import('./coord-inbox-bus');
    onCoordInbox(vi.fn());
    await vi.advanceTimersByTimeAsync(0);

    expect(listen).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(listen).toHaveBeenCalledTimes(1);
  });
});
