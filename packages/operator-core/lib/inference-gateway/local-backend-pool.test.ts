import { describe, expect, it, vi } from 'vitest';
import {
  AFFINITY_MAX_OWNERS,
  AFFINITY_TTL_MS,
  createLocalBackendPool,
  HEALTH_FAIL_THRESHOLD,
  isSaturatedFor,
  nextHealthState,
  pickLeastLoaded,
  pickWithAffinity,
  type LocalBackend,
  type LocalBackendCandidate,
} from './local-backend-pool';

const engineCapacity = (freeSlots: number, totalSlots = freeSlots) => ({
  freeSlots,
  totalSlots,
  contextTokens: 131_072,
  observedAtMs: Date.now(),
  source: '/props',
});

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
    expect(pickLeastLoaded([cand({ backend: a, inFlight: 2, engineCapacity: engineCapacity(0, 2) })], 'ornith-35b')).toBeNull();
  });

  it('returns null when candidates is empty', () => {
    expect(pickLeastLoaded([], 'ornith-35b')).toBeNull();
  });

  it('treats unknown/stale engine capacity as unbounded for routing', () => {
    const unknown = backend({ maxConcurrent: 1 });
    expect(pickLeastLoaded([cand({ backend: unknown, inFlight: 100 })], 'ornith-35b')?.id).toBe('b1');
    expect(isSaturatedFor([cand({ backend: unknown, inFlight: 100 })], 'ornith-35b')).toBe(false);
  });

  it('exclude skips an id already tried this request (in-request failover)', () => {
    const a = backend({ id: 'a' });
    const b = backend({ id: 'b' });
    const picked = pickLeastLoaded([cand({ backend: a }), cand({ backend: b })], 'ornith-35b', new Set(['a']));
    expect(picked?.id).toBe('b');
  });
});

describe('isSaturatedFor', () => {
  const cand = (over: Partial<LocalBackendCandidate> & { backend: LocalBackend }): LocalBackendCandidate => ({
    inFlight: 0,
    healthy: true,
    ...over,
  });

  it('is true when the model is served but every backend is at maxConcurrent (retryable backpressure → 429)', () => {
    const a = backend({ id: 'a', maxConcurrent: 2 });
    const b = backend({ id: 'b', maxConcurrent: 1 });
    expect(isSaturatedFor([cand({ backend: a, inFlight: 2, engineCapacity: engineCapacity(0, 2) }), cand({ backend: b, inFlight: 1, engineCapacity: engineCapacity(0, 1) })], 'ornith-35b')).toBe(true);
  });

  it('is false when a slot is free (select() would return a backend, not shed)', () => {
    const a = backend({ id: 'a', maxConcurrent: 2 });
    const b = backend({ id: 'b', maxConcurrent: 2 });
    expect(isSaturatedFor([cand({ backend: a, inFlight: 2 }), cand({ backend: b, inFlight: 1 })], 'ornith-35b')).toBe(false);
  });

  it('is false when no backend serves the model (unmatched — a genuine dead end → 502, not saturation)', () => {
    const a = backend({ id: 'a', models: ['other-model'], maxConcurrent: 2 });
    expect(isSaturatedFor([cand({ backend: a, inFlight: 2 })], 'ornith-35b')).toBe(false);
  });

  it('is false when the only serving backend is unhealthy (dead end → 502, not saturation)', () => {
    const a = backend({ id: 'a', maxConcurrent: 2 });
    expect(isSaturatedFor([cand({ backend: a, inFlight: 2, healthy: false })], 'ornith-35b')).toBe(false);
  });

  it('is false when the only serving backend is disabled (dead end → 502, not saturation)', () => {
    const a = backend({ id: 'a', enabled: false, maxConcurrent: 2 });
    expect(isSaturatedFor([cand({ backend: a, inFlight: 2 })], 'ornith-35b')).toBe(false);
  });

  it('is false for an empty candidate set', () => {
    expect(isSaturatedFor([], 'ornith-35b')).toBe(false);
  });

  it('excludes an already-tried id — saturation is judged over the REMAINING candidates', () => {
    // `a` (saturated) is excluded; `b` still has a free slot → not saturated over what is left to try.
    const a = backend({ id: 'a', maxConcurrent: 2 });
    const b = backend({ id: 'b', maxConcurrent: 2 });
    expect(
      isSaturatedFor([cand({ backend: a, inFlight: 2 }), cand({ backend: b, inFlight: 0 })], 'ornith-35b', new Set(['a'])),
    ).toBe(false);
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

  it('uses fresh engine freeSlots as the routing ceiling and reconciles pool starts/ends', () => {
    const pool = createLocalBackendPool([backend({ id: 'a', maxConcurrent: 99 })]);
    pool.updateEngineCapacity('a', { freeSlots: 1, totalSlots: 2, contextTokens: 131_072, observedAtMs: Date.now(), source: '/props' });
    expect(pool.select('ornith-35b')?.id).toBe('a');
    pool.recordStart('a');
    expect(pool.select('ornith-35b')).toBeNull();
    expect(pool.saturatedFor('ornith-35b')).toBe(true);
    pool.recordEnd('a');
    expect(pool.select('ornith-35b')?.id).toBe('a');
  });

  it('retains engine capacity for surviving backends across reload and drops removed ids', () => {
    const pool = createLocalBackendPool([backend({ id: 'a' }), backend({ id: 'b' })]);
    const reading = { freeSlots: 2, totalSlots: 2, observedAtMs: Date.now(), source: '/props' };
    pool.setEngineCapacity('a', reading);
    pool.reload([backend({ id: 'a', maxConcurrent: 1 })]);
    expect(pool.engineCapacity('a')).toEqual(reading);
    expect(pool.engineCapacity('b')).toBeNull();
    expect(pool.select('ornith-35b')?.id).toBe('a');
    pool.setEngineCapacity('a', null);
    expect(pool.engineCapacity('a')).toBeNull();
    // Clearing physical evidence restores unbounded routing, never the stale registry ceiling.
    pool.recordStart('a');
    expect(pool.select('ornith-35b')?.id).toBe('a');
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

describe('slot affinity (P-028)', () => {
  const cand = (over: Partial<LocalBackendCandidate> & { backend: LocalBackend }): LocalBackendCandidate => ({
    inFlight: 0,
    healthy: true,
    ...over,
  });

  it('pickWithAffinity prefers the sticky backend even when a sibling is less loaded', () => {
    const a = backend({ id: 'a' });
    const b = backend({ id: 'b' });
    const r = pickWithAffinity([cand({ backend: a, inFlight: 3 }), cand({ backend: b, inFlight: 0 })], 'ornith-35b', 'a');
    expect(r).toEqual({ backend: a, outcome: 'hit' });
  });

  it('pickWithAffinity falls over (never queues) when the sticky backend is saturated — a counted switch', () => {
    const a = backend({ id: 'a', maxConcurrent: 1 });
    const b = backend({ id: 'b' });
    const r = pickWithAffinity([cand({ backend: a, inFlight: 1, engineCapacity: engineCapacity(0, 1) }), cand({ backend: b })], 'ornith-35b', 'a');
    expect(r).toEqual({ backend: b, outcome: 'switch' });
  });

  it('pickWithAffinity with no preference is plain least-loaded — a cold assignment', () => {
    const a = backend({ id: 'a' });
    const r = pickWithAffinity([cand({ backend: a })], 'ornith-35b', null);
    expect(r).toEqual({ backend: a, outcome: 'cold' });
  });

  it('pickWithAffinity: nothing eligible → null pick, null outcome (no affinity event)', () => {
    const a = backend({ id: 'a', maxConcurrent: 1 });
    const r = pickWithAffinity([cand({ backend: a, inFlight: 1, engineCapacity: engineCapacity(0, 1) })], 'ornith-35b', 'a');
    expect(r).toEqual({ backend: null, outcome: null });
  });

  it('pool.select with ownerId sticks to the last backend across hops and counts hits/cold', () => {
    const pool = createLocalBackendPool([backend({ id: 'a' }), backend({ id: 'b' })]);
    const first = pool.select('ornith-35b', undefined, 'owner-1');
    expect(first?.id).toBe('a'); // deterministic tie-break assigns 'a'
    pool.recordStart('a');
    pool.recordStart('a'); // 'a' now busier than 'b' — least-loaded would pick 'b'
    expect(pool.select('ornith-35b', undefined, 'owner-1')?.id).toBe('a'); // sticky wins
    expect(pool.affinityStats()).toMatchObject({ hits: 1, cold: 1, switches: 0, trackedOwners: 1 });
  });

  it('pool.select without ownerId stays pure least-loaded and records no affinity event', () => {
    const pool = createLocalBackendPool([backend({ id: 'a' })]);
    expect(pool.select('ornith-35b')?.id).toBe('a');
    expect(pool.affinityStats()).toMatchObject({ hits: 0, cold: 0, switches: 0, trackedOwners: 0 });
  });

  it('a saturated sticky backend produces a switch and the NEW backend becomes sticky', () => {
    const pool = createLocalBackendPool([backend({ id: 'a', maxConcurrent: 1 }), backend({ id: 'b' })]);
    pool.updateEngineCapacity('a', { freeSlots: 1, totalSlots: 1, observedAtMs: Date.now(), source: '/props' });
    expect(pool.select('ornith-35b', undefined, 'owner-1')?.id).toBe('a');
    pool.recordStart('a'); // 'a' at capacity
    expect(pool.select('ornith-35b', undefined, 'owner-1')?.id).toBe('b'); // switch
    pool.recordEnd('a'); // 'a' free again — but 'b' is sticky now
    expect(pool.select('ornith-35b', undefined, 'owner-1')?.id).toBe('b');
    expect(pool.affinityStats()).toMatchObject({ hits: 1, cold: 1, switches: 1 });
  });

  it('reload() drops affinity entries pointing at removed backends (next select is cold, not a phantom hit)', () => {
    const pool = createLocalBackendPool([backend({ id: 'a' }), backend({ id: 'b' })]);
    pool.select('ornith-35b', undefined, 'owner-1'); // sticky 'a'
    pool.reload([backend({ id: 'b' })]);
    expect(pool.select('ornith-35b', undefined, 'owner-1')?.id).toBe('b');
    expect(pool.affinityStats()).toMatchObject({ cold: 2, hits: 0, switches: 0 });
  });

  it('the affinity map is bounded: beyond AFFINITY_MAX_OWNERS the oldest owner is evicted', () => {
    const pool = createLocalBackendPool([backend({ id: 'a' })]);
    for (let i = 0; i < AFFINITY_MAX_OWNERS + 1; i++) pool.select('ornith-35b', undefined, `owner-${i}`);
    expect(pool.affinityStats().trackedOwners).toBe(AFFINITY_MAX_OWNERS);
    // owner-0 was evicted → its next select is a cold assignment, not a hit
    const before = pool.affinityStats().cold;
    pool.select('ornith-35b', undefined, 'owner-0');
    expect(pool.affinityStats().cold).toBe(before + 1);
  });

  it('a sticky entry older than AFFINITY_TTL_MS is treated as cold (the KV is long recycled)', () => {
    vi.useFakeTimers();
    try {
      const pool = createLocalBackendPool([backend({ id: 'a' })]);
      pool.select('ornith-35b', undefined, 'owner-1');
      vi.advanceTimersByTime(AFFINITY_TTL_MS + 1);
      pool.select('ornith-35b', undefined, 'owner-1');
      expect(pool.affinityStats()).toMatchObject({ cold: 2, hits: 0, switches: 0 });
    } finally {
      vi.useRealTimers();
    }
  });
});
