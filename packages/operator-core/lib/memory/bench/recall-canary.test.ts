/**
 * recall-canary — the live recall canary (EI-10047, live-store half).
 * Dep-injected so no PG/embedder is needed: the pure query derivation +
 * pair building, the measurement loop, and the orchestration edges (flag
 * gate, seed, decay-reseed, ok/degraded transitions and their alert/resolve
 * wiring, non-fatal failure).
 */
import { describe, it, expect } from 'vitest';
import {
  buildCanaryPairs,
  deriveCanaryQuery,
  measureCanaryPairs,
  runRecallCanary,
  RECALL_CANARY_TARGET_PAIRS,
  type CanaryCandidate,
  type RecallCanaryDeps,
} from './recall-canary';
import type { RecallCanaryPair, RecallCanarySet, RecallCanaryStatus } from './recall-canary-read';
import type { MemoryEntry } from '../backend';

const LONG_TEXT =
  '[self:su-abc 2026-07-01] The embed sidecar exposes a shared harrier endpoint on port 3384 ' +
  'so every operator process reuses one model instance instead of loading duplicate ONNX ' +
  'runtimes; saturation shows up as op-deadline timeouts rather than crashes.';

function candidates(n: number, scope = 'pool-a'): CanaryCandidate[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `mem-${i}`,
    scope,
    text: `${LONG_TEXT} variant ${i} with extra distinguishing trailing words appended here`,
  }));
}

function entry(id: string): MemoryEntry {
  return { id, text: 'x', scope: 'pool-a' };
}

function frozenSet(pairs: RecallCanaryPair[], baseline: number, backend = 'hybrid'): RecallCanarySet {
  return { id: 1, version: 3, backend, pairs, baselineRAt10: baseline, createdAt: '2026-07-01T00:00:00Z' };
}

function pairsOf(n: number): RecallCanaryPair[] {
  return Array.from({ length: n }, (_, i) => ({
    memoryId: `mem-${i}`,
    scope: 'pool-a',
    query: `query ${i}`,
    style: 'fragment' as const,
  }));
}

/** Deps where every seam is a controllable stub; tests override what they exercise. */
function stubDeps(over: Partial<RecallCanaryDeps> = {}): {
  deps: RecallCanaryDeps;
  recorded: Array<{ status: RecallCanaryStatus }>;
  notified: string[];
  resolved: string[];
} {
  const recorded: Array<{ status: RecallCanaryStatus }> = [];
  const notified: string[] = [];
  const resolved: string[] = [];
  const deps: RecallCanaryDeps = {
    flag: async () => true,
    sql: {} as never,
    backend: { name: 'hybrid', search: async () => [] },
    sample: async () => candidates(30),
    verifyTargets: async (_sql, ids) => new Set(ids),
    loadSet: async () => null,
    saveSet: async () => ({ id: 9, version: 4 }),
    record: async (_sql, _ws, m) => {
      recorded.push({ status: m.status });
      return recorded.length;
    },
    prevStatus: async () => 'ok',
    notify: async (n) => {
      notified.push(n.conditionKey);
    },
    resolve: async (n) => {
      resolved.push(n.conditionKey);
    },
    log: () => {},
    ...over,
  };
  return { deps, recorded, notified, resolved };
}

const INPUT = { workspaceId: 'ws-1', installSlug: 'op' };

describe('deriveCanaryQuery', () => {
  it('fragment: ~10 mid-body words, provenance brackets stripped', () => {
    const q = deriveCanaryQuery(LONG_TEXT, 'fragment');
    expect(q).toBeTruthy();
    expect(q!.split(' ').length).toBe(10);
    expect(q).not.toContain('[self:');
    expect(LONG_TEXT).toContain(q!.split(' ')[0]);
  });

  it('keyword: distinct long words in original order, no exact phrase', () => {
    const q = deriveCanaryQuery(LONG_TEXT, 'keyword');
    expect(q).toBeTruthy();
    const words = q!.split(' ');
    expect(words.length).toBeLessThanOrEqual(6);
    expect(words.every((w) => w.length >= 5)).toBe(true);
    expect(LONG_TEXT).not.toContain(q!); // not a verbatim substring
  });

  it('returns null for bodies too thin to probe', () => {
    expect(deriveCanaryQuery('too short to derive anything from', 'fragment')).toBeNull();
  });

  it('is deterministic', () => {
    expect(deriveCanaryQuery(LONG_TEXT, 'fragment')).toBe(deriveCanaryQuery(LONG_TEXT, 'fragment'));
  });
});

describe('buildCanaryPairs', () => {
  it('caps at the target and mixes styles', () => {
    const pairs = buildCanaryPairs(
      candidates(60, 'a').concat(candidates(60, 'b'), candidates(60, 'c')),
    );
    expect(pairs.length).toBe(RECALL_CANARY_TARGET_PAIRS);
    expect(new Set(pairs.map((p) => p.style)).size).toBe(2);
  });

  it('spreads across scopes (per-scope cap)', () => {
    const pairs = buildCanaryPairs(candidates(60, 'only-scope'));
    expect(pairs.length).toBe(10); // MAX_PAIRS_PER_SCOPE
  });

  it('skips candidates whose body cannot yield a query', () => {
    const thin: CanaryCandidate[] = [{ id: 'm', scope: 's', text: 'tiny' }];
    expect(buildCanaryPairs(thin)).toEqual([]);
  });
});

describe('measureCanaryPairs', () => {
  it('counts hits within top-10 and zero-hit queries', async () => {
    const pairs = pairsOf(4);
    const m = await measureCanaryPairs(async (q) => {
      if (q === 'query 0') return [entry('mem-0')]; // hit
      if (q === 'query 1') return [entry('other')]; // miss, non-empty
      return []; // queries 2,3: zero-hit
    }, pairs);
    expect(m.scored).toBe(4);
    expect(m.hits).toBe(1);
    expect(m.zeroHits).toBe(2);
    expect(m.latencyP50Ms).not.toBeNull();
  });
});

describe('runRecallCanary', () => {
  it('skips when the flag is OFF', async () => {
    const { deps, recorded } = stubDeps({ flag: async () => false });
    const out = await runRecallCanary(INPUT, deps);
    expect(out).toEqual({ ran: false, skipReason: 'flag-off' });
    expect(recorded).toEqual([]);
  });

  it('seeds a fresh set when none exists and records status seeded', async () => {
    const { deps, recorded, notified } = stubDeps({
      backend: { name: 'hybrid', search: async (q: string) => [entry('mem-0')] },
    });
    const out = await runRecallCanary(INPUT, deps);
    expect(out.ran).toBe(true);
    if (out.ran) expect(out.status).toBe('seeded');
    expect(recorded).toEqual([{ status: 'seeded' }]);
    expect(notified).toEqual([]); // seeding never alerts
  });

  it('reseeds when the live backend name differs from the frozen set', async () => {
    const { deps } = stubDeps({
      loadSet: async () => frozenSet(pairsOf(10), 0.9, 'claude-file'),
      backend: { name: 'hybrid', search: async () => [] },
    });
    const out = await runRecallCanary(INPUT, deps);
    expect(out.ran && out.status).toBe('seeded');
    if (out.ran) expect(out.metrics.notes).toContain('backend changed');
  });

  it('healthy run: status ok, no alert', async () => {
    const pairs = pairsOf(10);
    const { deps, notified, resolved } = stubDeps({
      loadSet: async () => frozenSet(pairs, 0.9),
      // every probe finds its target → r@10 = 1.0 ≥ baseline
      backend: { name: 'hybrid', search: async (q: string) => [entry(`mem-${q.split(' ')[1]}`)] },
    });
    const out = await runRecallCanary(INPUT, deps);
    expect(out.ran && out.status).toBe('ok');
    expect(notified).toEqual([]);
    expect(resolved).toEqual([]);
  });

  it('alerts on the ok→degraded edge (recall drop > 5pt)', async () => {
    const pairs = pairsOf(10);
    const { deps, notified } = stubDeps({
      loadSet: async () => frozenSet(pairs, 0.9),
      // half the probes miss (non-empty results, so not a blackout): r@10 = .5 vs .9
      backend: {
        name: 'hybrid',
        search: async (q: string) => {
          const i = Number(q.split(' ')[1]);
          return i < 5 ? [entry(`mem-${i}`)] : [entry('other')];
        },
      },
      prevStatus: async () => 'ok',
    });
    const out = await runRecallCanary(INPUT, deps);
    expect(out.ran && out.status).toBe('degraded');
    expect(notified).toEqual(['memory-live-recall-canary:degraded']);
  });

  it('classifies a zero-hit blackout as degraded even with a low baseline', async () => {
    const pairs = pairsOf(10);
    const { deps, notified } = stubDeps({
      loadSet: async () => frozenSet(pairs, 0.04), // baseline so low a drop alone wouldn't trip
      backend: { name: 'hybrid', search: async () => [] },
    });
    const out = await runRecallCanary(INPUT, deps);
    expect(out.ran && out.status).toBe('degraded');
    if (out.ran) expect(out.metrics.notes).toContain('blackout');
    expect(notified.length).toBe(1);
  });

  it('does not re-alert while already degraded; resolves on recovery', async () => {
    const pairs = pairsOf(10);
    const still = stubDeps({
      loadSet: async () => frozenSet(pairs, 0.9),
      backend: { name: 'hybrid', search: async () => [entry('other')] },
      prevStatus: async () => 'degraded',
    });
    const out1 = await runRecallCanary(INPUT, still.deps);
    expect(out1.ran && out1.status).toBe('degraded');
    expect(still.notified).toEqual([]); // no duplicate alert

    const healed = stubDeps({
      loadSet: async () => frozenSet(pairs, 0.9),
      backend: { name: 'hybrid', search: async (q: string) => [entry(`mem-${q.split(' ')[1]}`)] },
      prevStatus: async () => 'degraded',
    });
    const out2 = await runRecallCanary(INPUT, healed.deps);
    expect(out2.ran && out2.status).toBe('ok');
    expect(healed.resolved).toEqual(['memory-live-recall-canary:degraded']);
  });

  it('excludes forgotten targets from scoring (natural churn is not degradation)', async () => {
    const pairs = pairsOf(10);
    const { deps, notified } = stubDeps({
      loadSet: async () => frozenSet(pairs, 0.9),
      // 2 targets gone (under the decay threshold); the other 8 all hit
      verifyTargets: async (_sql, ids) => new Set(ids.slice(2)),
      backend: { name: 'hybrid', search: async (q: string) => [entry(`mem-${q.split(' ')[1]}`)] },
    });
    const out = await runRecallCanary(INPUT, deps);
    expect(out.ran && out.status).toBe('ok');
    if (out.ran) {
      expect(out.metrics.pairsMissing).toBe(2);
      expect(out.metrics.pairsScored).toBe(8);
      expect(out.metrics.rAt10).toBe(1);
    }
    expect(notified).toEqual([]);
  });

  it('reseeds (status decayed, no alert) when too many targets are gone', async () => {
    const pairs = pairsOf(10);
    const { deps, recorded, notified } = stubDeps({
      loadSet: async () => frozenSet(pairs, 0.9),
      verifyTargets: async () => new Set(['mem-0', 'mem-1']), // 8/10 gone
      backend: { name: 'hybrid', search: async () => [] },
    });
    const out = await runRecallCanary(INPUT, deps);
    expect(out.ran && out.status).toBe('decayed');
    expect(recorded).toEqual([{ status: 'decayed' }]);
    expect(notified).toEqual([]);
  });

  it('turns any thrown failure into a non-fatal failed outcome', async () => {
    const { deps } = stubDeps({
      loadSet: async () => {
        throw new Error('pg down');
      },
    });
    const out = await runRecallCanary(INPUT, deps);
    expect(out).toEqual({ ran: false, skipReason: 'failed', error: 'pg down' });
  });
});
