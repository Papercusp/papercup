/**
 * P-328 (D-030): the scheduled sweep's pure evaluators, its delivery loop, and the relay-limit
 * alert. The SQL read is covered by alert-sweep.integration.test.ts against real Postgres.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  AUTH_FAILURE_ALERT_THRESHOLD,
  COUNTED_AUTH_FAILURE_REASONS,
  KEY_EXPIRY_LEAD_MS,
  USAGE_SPIKE_MIN_CALLS,
  __resetRelayAlertMemo,
  onRelayUsageReported,
  parseRelayUsageReport,
  relayLimitNotification,
  runConnectedAppAlertSweep,
  sweepAlertNotification,
  sweepAlertsFor,
  type SweepKey,
} from './alert-sweep';

const NOW = new Date('2026-09-30T13:20:00.000Z');

function key(over: Partial<SweepKey> = {}): SweepKey {
  return {
    id: 'app1',
    workspace_id: 'ws1',
    kind: 'app',
    label: 'Zapier',
    user_email: 'maker@example.com',
    expires_at: null,
    calls_last_hour: 0,
    calls_prior_7d: 0,
    auth_failures: 0,
    last_failure_reason: null,
    creator_removed: false,
    ...over,
  };
}

const kinds = (k: SweepKey) => sweepAlertsFor(k, NOW).map((a) => a.kind);

describe('sweepAlertsFor', () => {
  it('raises nothing for a quiet, healthy key', () => {
    expect(kinds(key())).toEqual([]);
  });

  it('usage spike needs the floor even when the key was silent before', () => {
    expect(kinds(key({ calls_last_hour: USAGE_SPIKE_MIN_CALLS - 1 }))).toEqual([]);
    expect(kinds(key({ calls_last_hour: USAGE_SPIKE_MIN_CALLS }))).toEqual(['usage-spike']);
  });

  it('usage spike is relative to the prior week for a busy key', () => {
    // 168 hours x 100 calls = 100/hour baseline -> spike at 1000.
    const busy = { calls_prior_7d: 168 * 100 };
    expect(kinds(key({ ...busy, calls_last_hour: 999 }))).toEqual([]);
    expect(kinds(key({ ...busy, calls_last_hour: 1000 }))).toEqual(['usage-spike']);
  });

  it('auth failures alert at the threshold', () => {
    expect(kinds(key({ auth_failures: AUTH_FAILURE_ALERT_THRESHOLD - 1 }))).toEqual([]);
    expect(kinds(key({ auth_failures: AUTH_FAILURE_ALERT_THRESHOLD, last_failure_reason: 'mismatch' }))).toEqual(['auth-failures']);
  });

  it('warns inside the expiry lead, not before it and not after expiry', () => {
    const at = (ms: number) => new Date(NOW.getTime() + ms);
    expect(kinds(key({ expires_at: at(KEY_EXPIRY_LEAD_MS + 60_000) }))).toEqual([]);
    expect(kinds(key({ expires_at: at(KEY_EXPIRY_LEAD_MS) }))).toEqual(['key-expiring']);
    expect(kinds(key({ expires_at: at(-60_000) }))).toEqual([]);
  });

  it('creator removed needs a recorded creator', () => {
    expect(kinds(key({ creator_removed: true }))).toEqual(['creator-removed']);
    expect(kinds(key({ creator_removed: true, user_email: null }))).toEqual([]);
  });
});

describe('sweepAlertNotification dedupe keys', () => {
  it('are stable per condition window, so a re-run never notifies twice', () => {
    const a = sweepAlertsFor(key({ calls_last_hour: 500, auth_failures: 20, last_failure_reason: 'rotated' }), NOW);
    const b = sweepAlertsFor(key({ calls_last_hour: 900, auth_failures: 40, last_failure_reason: 'rotated' }), new Date(NOW.getTime() + 60_000));
    expect(a.map((x) => sweepAlertNotification(x).dedupeKey)).toEqual(b.map((x) => sweepAlertNotification(x).dedupeKey));
    expect(a.map((x) => sweepAlertNotification(x).dedupeKey)).toEqual([
      'connected-app:usage-spike:app1:2026-09-30',
      'connected-app:auth-failures:app1:2026-09-30T13',
    ]);
  });

  it('a renewed lifetime can warn again; a new creator email is a new alert', () => {
    const exp = (d: string) => sweepAlertNotification(sweepAlertsFor(key({ expires_at: new Date(d) }), NOW)[0]).dedupeKey;
    expect(exp('2026-10-03T00:00:00Z')).not.toEqual(exp('2026-10-04T00:00:00Z'));
    const removed = sweepAlertNotification(sweepAlertsFor(key({ creator_removed: true, user_email: 'A@x.com' }), NOW)[0]);
    expect(removed.dedupeKey).toBe('connected-app:creator-removed:app1:a@x.com');
    expect(removed.workspaceId).toBe('ws1');
  });
});

describe('COUNTED_AUTH_FAILURE_REASONS', () => {
  it('counts refusals of a known key but not owner-chosen states or unnamed keys', () => {
    for (const r of ['mismatch', 'rotated', 'revoked', 'expired', 'token_endpoint_only']) expect(COUNTED_AUTH_FAILURE_REASONS.has(r)).toBe(true);
    for (const r of ['paused', 'remote_access_off', 'unknown', 'malformed']) expect(COUNTED_AUTH_FAILURE_REASONS.has(r)).toBe(false);
  });
});

describe('runConnectedAppAlertSweep', () => {
  it('delivers every alert and keeps going past a failed delivery', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const notify = vi.fn(async (input: { dedupeKey: string }) => {
      if (input.dedupeKey.includes('usage-spike')) throw new Error('push down');
      return { delivered: true };
    });
    const result = await runConnectedAppAlertSweep({
      now: () => NOW,
      load: async () => [
        key({ id: 'a', calls_last_hour: 300 }),
        key({ id: 'b', auth_failures: 12, last_failure_reason: 'expired' }),
        key({ id: 'c' }),
      ],
      notify,
    });
    expect(result.keys).toBe(3);
    expect(result.failed).toBe(1);
    expect(result.alerts.map((a) => `${a.kind}:${a.app.id}`)).toEqual(['auth-failures:b']);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('relay limit alert (D-006)', () => {
  const limit = 10 * 1024 ** 3;

  it('parses only a well-formed portal report', () => {
    expect(parseRelayUsageReport({ month: '2026-09-01', bytes: 5, limitBytes: limit })).toEqual({ month: '2026-09-01', bytes: 5, limitBytes: limit });
    expect(parseRelayUsageReport(null)).toBeNull();
    expect(parseRelayUsageReport({ month: '2026-09', bytes: 5, limitBytes: limit })).toBeNull();
    expect(parseRelayUsageReport({ month: '2026-09-01', bytes: -1, limitBytes: limit })).toBeNull();
    expect(parseRelayUsageReport({ month: '2026-09-01', bytes: 5, limitBytes: 0 })).toBeNull();
  });

  it('is silent under 80%, warns at 80%, and reports the limit reached', () => {
    expect(relayLimitNotification('ws1', { month: '2026-09-01', bytes: limit * 0.79, limitBytes: limit })).toBeNull();
    const near = relayLimitNotification('ws1', { month: '2026-09-01', bytes: limit * 0.8, limitBytes: limit });
    expect(near?.dedupeKey).toBe('connected-app:relay-limit-near:ws1:2026-09-01');
    const reached = relayLimitNotification('ws1', { month: '2026-09-01', bytes: limit, limitBytes: limit });
    expect(reached?.dedupeKey).toBe('connected-app:relay-limit-reached:ws1:2026-09-01');
    expect(reached?.importance).toBe('high');
  });

  it('onRelayUsageReported notifies once per crossing and never throws', async () => {
    __resetRelayAlertMemo();
    const notify = vi.fn(async () => ({}));
    expect(await onRelayUsageReported('ws1', { month: '2026-09-01', bytes: limit * 0.9, limitBytes: limit }, notify)).toBe(true);
    // Every later relayed call in the same band reports again; the process raises it only once.
    expect(await onRelayUsageReported('ws1', { month: '2026-09-01', bytes: limit * 0.95, limitBytes: limit }, notify)).toBe(false);
    expect(await onRelayUsageReported('ws1', { month: '2026-09-01', bytes: 1, limitBytes: limit }, notify)).toBe(false);
    expect(await onRelayUsageReported('ws1', 'garbage', notify)).toBe(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failing = vi.fn(async () => { throw new Error('down'); });
    expect(await onRelayUsageReported('ws1', { month: '2026-09-01', bytes: limit, limitBytes: limit }, failing)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    // A failed raise is forgotten, so the next report of the same crossing retries it.
    expect(await onRelayUsageReported('ws1', { month: '2026-09-01', bytes: limit, limitBytes: limit }, notify)).toBe(true);
    expect(notify).toHaveBeenCalledTimes(2);
    __resetRelayAlertMemo();
  });
});
