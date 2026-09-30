/**
 * pui-chat-first-ux-2026-09-28 P-009: the durable client lease that ends an
 * attached PUI engine once no client is watching it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetSuClientLeaseForTest,
  _sweepSuClientLeasesForTest,
  detachSuClientLease,
  grantSuClientLease,
  suClientLeaseConfig,
  superviseSuClientLease,
  trackSuClientStream,
  type SuClientLeaseStore,
} from './su-session-client-lease';

/** An in-memory lease table with a controllable clock, mirroring the SQL. */
function memoryStore() {
  let now = 0;
  const rows = new Map<number, { leaseUntil: number | null; detachedAt: number | null }>();
  const row = (id: number) => {
    let current = rows.get(id);
    if (!current) { current = { leaseUntil: null, detachedAt: null }; rows.set(id, current); }
    return current;
  };
  const calls = { grant: [] as number[], renew: [] as number[][] };
  const store: SuClientLeaseStore = {
    async grant(id, ttlMs) { calls.grant.push(id); Object.assign(row(id), { leaseUntil: now + ttlMs, detachedAt: null }); },
    async renew(ids, ttlMs) {
      calls.renew.push([...ids]);
      for (const id of ids) row(id).leaseUntil = Math.max(row(id).leaseUntil ?? now, now + ttlMs);
    },
    async detach(id) { row(id).detachedAt = now; return true; },
    async expired(ids) {
      return ids.filter((id) => {
        const r = rows.get(id);
        return r && r.detachedAt === null && r.leaseUntil !== null && r.leaseUntil < now;
      });
    },
  };
  return { store, calls, advance: (ms: number) => { now += ms; }, row };
}

describe('su-session client lease', () => {
  let mem: ReturnType<typeof memoryStore>;
  beforeEach(() => {
    mem = memoryStore();
    _resetSuClientLeaseForTest(mem.store);
  });
  afterEach(() => {
    vi.useRealTimers();
    _resetSuClientLeaseForTest();
  });

  it('an open stream grants a lease and renews it until the stream closes', async () => {
    vi.useFakeTimers();
    const { ttlMs, renewMs } = suClientLeaseConfig();
    const release = trackSuClientStream(41);
    expect(mem.calls.grant).toEqual([41]);

    await vi.advanceTimersByTimeAsync(renewMs);
    expect(mem.calls.renew).toEqual([[41]]);

    release();
    release(); // idempotent: a double close must not drop another stream's count
    await vi.advanceTimersByTimeAsync(renewMs * 3);
    expect(mem.calls.renew).toHaveLength(1);
    expect(ttlMs).toBeGreaterThan(renewMs);
  });

  it('keeps renewing while ANY stream for the session is still open', async () => {
    vi.useFakeTimers();
    const { renewMs } = suClientLeaseConfig();
    const first = trackSuClientStream(7);
    const second = trackSuClientStream(7);
    first();
    await vi.advanceTimersByTimeAsync(renewMs);
    expect(mem.calls.renew).toEqual([[7]]);
    second();
  });

  it('ends a supervised engine exactly once when its lease lapses', async () => {
    const onExpired = vi.fn();
    superviseSuClientLease(9, onExpired);
    await grantSuClientLease(9, 1_000);

    await _sweepSuClientLeasesForTest();
    expect(onExpired).not.toHaveBeenCalled();

    mem.advance(1_001);
    await _sweepSuClientLeasesForTest();
    await _sweepSuClientLeasesForTest();
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it('a detached session outlives its lease; attaching again re-arms it', async () => {
    const onExpired = vi.fn();
    superviseSuClientLease(11, onExpired);
    await grantSuClientLease(11, 1_000);
    await detachSuClientLease(11);

    mem.advance(5_000);
    await _sweepSuClientLeasesForTest();
    expect(onExpired).not.toHaveBeenCalled();

    const release = trackSuClientStream(11); // a client attaches: the detach is cleared
    release();
    mem.advance(suClientLeaseConfig().ttlMs + 1);
    await _sweepSuClientLeasesForTest();
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it('a session with no lease granted yet is never ended', async () => {
    const onExpired = vi.fn();
    superviseSuClientLease(13, onExpired);
    mem.advance(10_000_000);
    await _sweepSuClientLeasesForTest();
    expect(onExpired).not.toHaveBeenCalled();
  });

  it('an unreadable lease keeps the engine: a lease read failure is not evidence', async () => {
    const onExpired = vi.fn();
    _resetSuClientLeaseForTest({ ...mem.store, expired: async () => { throw new Error('db down'); } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    superviseSuClientLease(15, onExpired);
    await _sweepSuClientLeasesForTest();
    expect(onExpired).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('releasing a stale supervision never removes a newer one for the same session', async () => {
    const stale = vi.fn();
    const current = vi.fn();
    const releaseStale = superviseSuClientLease(17, stale);
    superviseSuClientLease(17, current); // a resumed engine re-registers
    releaseStale();
    await grantSuClientLease(17, 1);
    mem.advance(2);
    await _sweepSuClientLeasesForTest();
    expect(stale).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledTimes(1);
  });

  it('the TTL override keeps renew and sweep strictly inside the lease', () => {
    const previous = process.env.PAPERCUSP_SU_CLIENT_LEASE_TTL_MS;
    process.env.PAPERCUSP_SU_CLIENT_LEASE_TTL_MS = '3000';
    try {
      const config = suClientLeaseConfig();
      expect(config.ttlMs).toBe(3_000);
      expect(config.renewMs).toBeLessThan(config.ttlMs);
      expect(config.sweepMs).toBeLessThan(config.ttlMs);
      expect(config.initialMs).toBeGreaterThanOrEqual(config.ttlMs);
    } finally {
      if (previous === undefined) delete process.env.PAPERCUSP_SU_CLIENT_LEASE_TTL_MS;
      else process.env.PAPERCUSP_SU_CLIENT_LEASE_TTL_MS = previous;
    }
  });
});
