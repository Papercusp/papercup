/** Host-private T06 instrumentation. Install through installOperatorCache only
 * in an exclusive benchmark process. The original cache, L2 wrapper, clock,
 * single-flight and invalidation policy still perform every operation.
 * Counter attribution is conditional on that process isolation; raw observations
 * are retained even when overlapping work makes attribution unavailable. */
import type { Cache, CacheOutcome, CacheReadReason, GetOrSetOptions } from '@papercusp/cache';
import type { CachedReadToolStats } from '../cache/cached-read';

type Counters = Pick<CachedReadToolStats, 'builds' | 'buildsCompleted' | 'buildErrors' | 'l2Hits' | 'l2Misses' | 'l2Errors'>;
const counterKeys = ['builds', 'buildsCompleted', 'buildErrors', 'l2Hits', 'l2Misses', 'l2Errors'] as const;
interface FactoryObservation {
  call: number;
  workspaceId: string;
  key: string;
  generation: Record<string, number>;
  generationAfter?: Record<string, number>;
  startedAtMs: number;
  completedAtMs?: number;
  before: Counters | null;
  after?: Counters | null;
  error?: string;
  sourceBuilds: number | null;
}
interface LookupObservation {
  call: number;
  workspaceId: string;
  key: string;
  options: { tags: readonly string[]; softTtlMs?: number; hardTtlMs?: number; cacheEmpty?: boolean };
  startedAtMs: number;
  completedAtMs?: number;
  outcome?: CacheOutcome;
  reason?: CacheReadReason;
  error?: string;
}

export function observeLatencyAttentionCache(target: Cache,
  readStats: () => Record<string, CachedReadToolStats>) {
  const lookups: LookupObservation[] = [], factories: FactoryObservation[] = [];
  const issues = new Set<string>(), pending = new Set<Promise<unknown>>();
  let serial = 0;
  const counters = (): Counters | null => {
    try {
      const row = readStats()['plans:attention'];
      if (row === undefined) return Object.fromEntries(counterKeys.map(key => [key, 0])) as Counters;
      if (counterKeys.some(key => !Number.isSafeInteger(row[key]) || row[key] < 0))
        throw new Error('missing or invalid source counters');
      return Object.fromEntries(counterKeys.map(key => [key, row[key]])) as Counters;
    } catch {
      issues.add('source-counters-unavailable'); return null;
    }
  };
  const initial = counters();
  if (initial && initial.builds !== initial.buildsCompleted) issues.add('source-build-predates-observer');

  const getOrSet: Cache['getOrSet'] = <V>(workspaceId: string, key: string,
    factory: () => V | Promise<V>, options: GetOrSetOptions = {}): Promise<V> => {
    if (!key.startsWith('plans:attention|')) return target.getOrSet(workspaceId, key, factory, options);
    const call = ++serial;
    const lookup: LookupObservation = { call, workspaceId, key, startedAtMs: performance.now(),
      options: { tags: [...(options.tags ?? [])],
        ...(options.softTtlMs !== undefined ? { softTtlMs: options.softTtlMs } : {}),
        ...(options.hardTtlMs !== undefined ? { hardTtlMs: options.hardTtlMs } : {}),
        ...(options.cacheEmpty !== undefined ? { cacheEmpty: options.cacheEmpty } : {}) } };
    lookups.push(lookup);
    // This closure is entered by the REAL cache build, after its single-flight
    // test and generation capture. Its factory may still return an L2 hit.
    const observedFactory = (): V | Promise<V> => {
      if (pending.size) issues.add('overlapping-effective-factories');
      const row: FactoryObservation = { call, workspaceId, key,
        generation: target.generationSnapshot(workspaceId, options.tags ?? []),
        startedAtMs: performance.now(), before: counters(), sourceBuilds: null };
      factories.push(row);
      let value: V | Promise<V>;
      try { value = factory(); }
      catch (error) { finish(error); throw error; }
      function finish(error?: unknown) {
        row.completedAtMs = performance.now();
        row.generationAfter = target.generationSnapshot(workspaceId, options.tags ?? []);
        row.after = counters();
        if (error !== undefined) row.error = String(error);
        if (row.before && row.after) {
          const started = row.after.builds - row.before.builds;
          const completed = row.after.buildsCompleted - row.before.buildsCompleted;
          if ((started === 0 || started === 1) && started === completed &&
              counterKeys.every(key => row.after![key] >= row.before![key])) {
            row.sourceBuilds = started;
            if (started === 0 && row.after.l2Hits - row.before.l2Hits !== 1)
              issues.add('effective-factory-without-source-or-l2-evidence');
          }
          else issues.add('source-counter-window-not-exclusive');
        }
      }
      // Preserve synchronous returns (including the bypass path). The observer
      // does not introduce an await before the real factory starts.
      if (!value || typeof (value as Promise<V>).then !== 'function') { finish(); return value; }
      const tracked = Promise.resolve(value).then(result => { finish(); return result; },
        error => { finish(error); throw error; });
      pending.add(tracked);
      void tracked.then(() => pending.delete(tracked), () => pending.delete(tracked));
      return tracked;
    };
    const result = target.getOrSet(workspaceId, key, observedFactory, { ...options,
      onOutcome(outcome, reason) {
        lookup.outcome = outcome; lookup.reason = reason;
        options.onOutcome?.(outcome, reason);
      } });
    return result.then(value => { lookup.completedAtMs = performance.now(); return value; }, error => {
      lookup.completedAtMs = performance.now(); lookup.error = String(error); throw error;
    });
  };
  // Bind methods to their original receiver, including methods using #private
  // state. Reads of properties such as stats also retain their original receiver.
  const cache = new Proxy(target, { get(receiver, property) {
    if (property === 'getOrSet') return getOrSet;
    const value = Reflect.get(receiver, property, receiver);
    return typeof value === 'function' ? value.bind(receiver) : value;
  } });
  return { cache,
    async drain() { while (pending.size) await Promise.allSettled([...pending]); },
    snapshot() {
      const current = counters();
      const incomplete = pending.size > 0 || factories.some(row => row.completedAtMs === undefined);
      const allIssues = [...issues];
      if (incomplete) allIssues.push('effective-factories-still-running');
      if (current && current.builds !== current.buildsCompleted) allIssues.push('source-builds-still-running');
      // A retained reference to the original cache can bypass the facade. The
      // whole-window census catches completed source/L2 work between observed
      // factories as well as the overlap check inside a factory's own window.
      if (!incomplete && initial && current && counterKeys.some(key =>
        current[key] - initial[key] !== factories.reduce((total, row) =>
          total + (row.before && row.after ? row.after[key] - row.before[key] : 0), 0)))
        allIssues.push('source-counter-census-mismatch');
      const attributable = allIssues.length === 0;
      return structuredClone({
        scope: 'exclusive private host; every plans:attention cache read must use this facade',
        attribution: attributable ? 'exclusive-counter-windows' : 'unavailable', issues: allIssues,
        lookups, factories: factories.map(row => ({ ...row, sourceBuilds: attributable ? row.sourceBuilds : null })),
        sourceBuildsByKeyGeneration: attributable ? factories.map(row => ({ workspaceId: row.workspaceId,
          key: row.key, generation: row.generation, sourceBuilds: row.sourceBuilds })) : null,
        initialCounters: initial, finalCounters: current,
      });
    },
  };
}
