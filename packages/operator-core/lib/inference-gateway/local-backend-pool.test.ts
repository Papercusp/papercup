import { describe, expect, it, vi } from 'vitest';
import {
  createLocalBackendPool,
  HEALTH_FAIL_THRESHOLD,
  nextHealthState,
  pickLeastLoaded,
  type LocalBackend,
  type LocalBackendCandidate,
} from './local-backend-pool';

function backend(over: Partial<LocalBackend> = {}): LocalBackend {
  return {
    id: 'b1',
    kind: 'llama-server',
    baseUrl: 'http://127.0.0.1:8081',
    models: ['ornith-35b'],
    maxConcurrent: 4,
    enabled: true,
    ...over,
  };
}

describe('pickLeastLoaded', () => {
  const cand = (over: Partial<LocalBackendCandidate> & { backend: LocalBackend }): LocalBackendCandidate => ({
    inFlight: 0,
    healthy: true,
    ...over,
  });

  it('picks the least-loaded eligible candidate serving the model', () => {
    const a = backend({ id: 'a' });
    const b = backend({ id: 'b' });
    const picked = pickLeastLoaded([cand({ backend: a, inFlight: 3 }), cand({ backend: b, inFlight: 1 })], 'ornith-35b');
    expect(picked?.id).toBe('b');
  });

  it('breaks ties by id (deterministic)', () => {
    const a = backend({ id: 'zzz' });
    const b = backend({ id: 'aaa' });
    const picked = pickLeastLoaded([cand({ backend: a }), cand({ backend: b })], 'ornith-35b');
    expect(picked?.id).toBe('aaa');
  });

  it('excludes a backend not serving the requested model', () => {
    const a = backend({ id: 'a', models: ['other-model'] });
    expect(pickLeastLoaded([cand({ backend: a })], 'ornith-35b')).toBeNull();
  });

  it('excludes a disabled backend', () => {
    const a = backend({ enabled: false });
    expect(pickLeastLoaded([cand({ backend: a })], 'ornith-35b')).toBeNull();
  });

  it('excludes an unhealthy backend', () => {
    const a = backend();
    expect(pickLeastLoaded([cand({ backend: a, healthy: false })], 'ornith-35b')).toBeNull();
  });

  it('excludes a backend already at maxConcurrent (saturated — shed, do not queue onto it)', () => {
    const a = backend({ maxConcurrent: 2 });
    expect(pickLeastLoaded([cand({ backend: a, inFlight: 2 })], 'ornith-35b')).toBeNull();
  });

  it('returns null when candidates is empty', () => {
    expect(pickLeastLoaded([], 'ornith-35b')).toBeNull();
  });

  it('exclude skips an id already tried this request (in-request failover)', () => {
    const a = backend({ id: 'a' });
    const b = backend({ id: 'b' });
    const picked = pickLeastLoaded([cand({ backend: a }), cand({ backend: b })], 'ornith-35b', new Set(['a']));
    expect(picked?.id).toBe('b');
  });
});

describe('nextHealthState', () => {
  it('a success is immediately healthy and resets the failure streak', () => {
    const prev = { healthy: false, lastCheckedAt: 0, latencyMs: null, error: 'x', consecutiveFailures: 5 };
    const next = nextHealthState(prev, true, 42, null, 1000);
    expect(next).toEqual({ healthy: true, lastCheckedAt: 1000, latencyMs: 42, error: null, consecutiveFailures: 0 });
  });

  it('a single failure does not demote a previously-healthy backend', () => {
    const next = nextHealthState(undefined, false, 0, 'connect refused', 1000);
    expect(next.consecutiveFailures).toBe(1);
    expect(next.healthy).toBe(true); // 1 < HEALTH_FAIL_THRESHOLD
  });

  it(`demotes to unhealthy after ${HEALTH_FAIL_THRESHOLD} consecutive failures`, () => {
    let state = undefined as ReturnType<typeof nextHealthState> | undefined;
    for (let i = 0; i < HEALTH_FAIL_THRESHOLD; i++) {
      state = nextHealthState(state, false, 0, 'timeout', 1000 + i);
    }
    expect(state?.healthy).toBe(false);
    expect(state?.consecutiveFailures).toBe(HEALTH_FAIL_THRESHOLD);
  });

  it('preserves the last known latency across a failure (does not null it out)', () => {
    const prev = { healthy: true, lastCheckedAt: 0, latencyMs: 30, error: null, consecutiveFailures: 0 };
    const next = nextHealthState(prev, false, 0, 'boom', 500);
    expect(next.latencyMs).toBe(30);
  });
});

describe('createLocalBackendPool', () => {
  it('starts empty and reload() populates entries', () => {
    const pool = createLocalBackendPool();
    expect(pool.size()).toBe(0);
    pool.reload([backend({ id: 'a' }), backend({ id: 'b' })]);
    expect(pool.size()).toBe(2);
    expect(pool.entries().map((b) => b.id).sort()).toEqual(['a', 'b']);
  });

  it('select() honors in-flight tracking (recordStart/recordEnd) for least-loaded routing', () => {
    const pool = createLocalBackendPool([backend({ id: 'a' }), backend({ id: 'b' })]);
    pool.recordStart('a');
    pool.recordStart('a');
    expect(pool.inFlight('a')).toBe(2);
    expect(pool.select('ornith-35b', undefined)?.id).toBe('b'); // a is busier
    pool.recordEnd('a');
    pool.recordEnd('a');
    expect(pool.inFlight('a')).toBe(0);
  });

  it('recordEnd never goes negative', () => {
    const pool = createLocalBackendPool([backend()]);
    pool.recordEnd('b1');
    expect(pool.inFlight('b1')).toBe(0);
  });

  it('reload() drops in-flight/health state for ids no longer registered, keeps it for survivors', () => {
    const pool = createLocalBackendPool([backend({ id: 'a' }), backend({ id: 'b' })]);
    pool.recordStart('a');
    pool.recordOutcome('b', false, 'boom');
    pool.reload([backend({ id: 'a' })]); // 'b' dropped
    expect(pool.inFlight('a')).toBe(1); // survivor keeps its counter
    expect(pool.health().has('b')).toBe(false); // dropped id's health is gone
  });

  it('recordOutcome feeds live failures into health — a backend fails out of selection within HEALTH_FAIL_THRESHOLD', () => {
    const pool = createLocalBackendPool([backend({ id: 'a' }), backend({ id: 'b' })]);
    for (let i = 0; i < HEALTH_FAIL_THRESHOLD; i++) pool.recordOutcome('a', false, 'ECONNREFUSED');
    expect(pool.select('ornith-35b')?.id).toBe('b'); // 'a' unhealthy, routes around it
    pool.recordOutcome('a', true);
    expect(pool.health().get('a')?.healthy).toBe(true); // a single success immediately restores it
  });

  it('recordOutcome for an unregistered id is a no-op (no crash, no phantom health entry)', () => {
    const pool = createLocalBackendPool([backend({ id: 'a' })]);
    expect(() => pool.recordOutcome('ghost', false)).not.toThrow();
    expect(pool.health().has('ghost')).toBe(false);
  });

  it('runHealthChecks probes each backend baseUrl/v1/models and records ok/error', async () => {
    const pool = createLocalBackendPool([backend({ id: 'a', baseUrl: 'http://a' }), backend({ id: 'b', baseUrl: 'http://b' })]);
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === 'http://a/v1/models') return new Response('{}', { status: 200 });
      return new Response('boom', { status: 500 });
    }) as unknown as typeof fetch;
    await pool.runHealthChecks(fetchImpl);
    expect(pool.health().get('a')?.healthy).toBe(true);
    expect(pool.health().get('b')?.healthy).toBe(true); // 1 failure < threshold, still healthy
    expect(pool.health().get('b')?.error).toMatch(/500/);
  });

  it('runHealthChecks demotes a backend after repeated failed probes', async () => {
    const pool = createLocalBackendPool([backend({ id: 'a' })]);
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 503 })) as unknown as typeof fetch;
    for (let i = 0; i < HEALTH_FAIL_THRESHOLD; i++) await pool.runHealthChecks(fetchImpl);
    expect(pool.health().get('a')?.healthy).toBe(false);
    expect(pool.select('ornith-35b')).toBeNull();
  });

  it('runHealthChecks records a thrown/rejected probe (connection error) as a failure, not a crash', async () => {
    const pool = createLocalBackendPool([backend({ id: 'a' })]);
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await pool.runHealthChecks(fetchImpl);
    expect(pool.health().get('a')?.error).toMatch(/ECONNREFUSED/);
  });
});
