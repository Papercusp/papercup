/**
 * Cupboard rate-limit primitives — the abuse controls behind publish/report.
 *
 * KV-counter limits (per-IP list, per-user report) and the durable D1
 * publish counter (5/hr per github_user_id, hour-bucketed UPSERT). Tiny
 * in-memory KV + D1 fakes; no Workers runtime needed.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  RateLimitError,
  checkIpListPerMinute,
  checkUserReportHourly,
  checkAndRecordUserPublishHourly,
} from '../ratelimit.ts';
import type { Env } from '../env.ts';

class FakeKV {
  m = new Map<string, string>();
  async get(k: string): Promise<string | null> {
    return this.m.get(k) ?? null;
  }
  async put(k: string, v: string): Promise<void> {
    this.m.set(k, v);
  }
}

function fakePublishDb() {
  const rows: Array<{ github_user_id: number; window_start: number; count: number }> = [];
  const DB = {
    prepare(sql: string) {
      return {
        bind(...b: unknown[]) {
          return {
            async first<T>(): Promise<T | null> {
              if (/SELECT count/i.test(sql)) {
                const [u, w] = b as [number, number];
                const r = rows.find((x) => x.github_user_id === u && x.window_start === w);
                return (r ? { count: r.count } : null) as T | null;
              }
              return null;
            },
            async run() {
              if (/INSERT INTO publish_rate_limit/i.test(sql)) {
                const [u, w] = b as [number, number];
                const r = rows.find((x) => x.github_user_id === u && x.window_start === w);
                if (r) r.count += 1;
                else rows.push({ github_user_id: u, window_start: w, count: 1 });
              }
              return { success: true };
            },
          };
        },
      };
    },
  };
  return { DB, rows };
}

let kv: FakeKV;
function env(over: Partial<Env> = {}): Env {
  return {
    COUNTERS: kv,
    RATE_PER_IP_LIST_PER_MINUTE: '3',
    RATE_PER_USER_REPORT_HOURLY: '2',
    RATE_PER_USER_PUBLISH_HOURLY: '5',
    ...over,
  } as unknown as Env;
}

beforeEach(() => {
  kv = new FakeKV();
});

describe('checkIpListPerMinute', () => {
  it('allows requests up to the cap then throws RateLimitError', async () => {
    const e = env();
    await checkIpListPerMinute(e, '1.2.3.4'); // 1
    await checkIpListPerMinute(e, '1.2.3.4'); // 2
    await checkIpListPerMinute(e, '1.2.3.4'); // 3 (cap=3, increments after the check)
    await expect(checkIpListPerMinute(e, '1.2.3.4')).rejects.toBeInstanceOf(RateLimitError);
  });

  it('is a no-op for an empty IP or a zero cap', async () => {
    await expect(checkIpListPerMinute(env(), '')).resolves.toBeUndefined();
    await expect(checkIpListPerMinute(env({ RATE_PER_IP_LIST_PER_MINUTE: '0' }), '9.9.9.9')).resolves.toBeUndefined();
  });

  it('counts per-IP independently', async () => {
    const e = env({ RATE_PER_IP_LIST_PER_MINUTE: '1' });
    await checkIpListPerMinute(e, 'a');
    await expect(checkIpListPerMinute(e, 'a')).rejects.toBeInstanceOf(RateLimitError);
    await expect(checkIpListPerMinute(e, 'b')).resolves.toBeUndefined(); // different IP unaffected
  });
});

describe('checkUserReportHourly', () => {
  it('caps reports per user (default applies via env) then throws', async () => {
    const e = env(); // cap 2
    await checkUserReportHourly(e, 42);
    await checkUserReportHourly(e, 42);
    await expect(checkUserReportHourly(e, 42)).rejects.toBeInstanceOf(RateLimitError);
  });
});

describe('checkAndRecordUserPublishHourly (durable D1 counter)', () => {
  it('allows up to 5 publishes in a window, then throws on the 6th', async () => {
    const { DB } = fakePublishDb();
    const e = env({ DB } as Partial<Env>);
    const now = 1_700_000_000_000;
    for (let i = 0; i < 5; i++) await checkAndRecordUserPublishHourly(e, 7, now);
    await expect(checkAndRecordUserPublishHourly(e, 7, now)).rejects.toBeInstanceOf(RateLimitError);
  });

  it('resets in a new hour bucket', async () => {
    const { DB } = fakePublishDb();
    const e = env({ DB } as Partial<Env>);
    const h1 = 1_700_000_000_000;
    const h2 = h1 + 3_600_000;
    for (let i = 0; i < 5; i++) await checkAndRecordUserPublishHourly(e, 7, h1);
    // next hour → fresh allowance
    await expect(checkAndRecordUserPublishHourly(e, 7, h2)).resolves.toBeUndefined();
  });

  it('counts per-user independently', async () => {
    const { DB } = fakePublishDb();
    const e = env({ DB } as Partial<Env>);
    const now = 1_700_000_000_000;
    for (let i = 0; i < 5; i++) await checkAndRecordUserPublishHourly(e, 1, now);
    await expect(checkAndRecordUserPublishHourly(e, 1, now)).rejects.toBeInstanceOf(RateLimitError);
    await expect(checkAndRecordUserPublishHourly(e, 2, now)).resolves.toBeUndefined();
  });
});
