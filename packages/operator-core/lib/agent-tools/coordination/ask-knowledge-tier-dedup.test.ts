/**
 * ask-knowledge-tier-dedup.test.ts — runKnowledgeTier's dedup + ordering + top-N
 * (ask-knowledge-tier.ts), unit.
 *
 * The conversations integration test covers the memory hit/miss/harness-scope
 * branches, but NOT the final reduction:
 *   const byRef = new Map();
 *   for (const c of candidates.sort((a,b) => b.score - a.score)) if (!has) set;
 *   return { candidates: [...].slice(0, limit) … }
 * Here the SAME ref can arrive twice because the memory store is fanned over
 * MULTIPLE pseudo-user keys (asker_id ∪ workspace:<id> ∪ harness:<slug>) — the
 * same memory can match under more than one key, so the same `mem0:<id>` ref
 * shows up with different scores. The dedup must keep the HIGHEST-scored copy,
 * the sort must be score-descending across sources, and the result must be
 * capped at the limit. We exercise the REAL reduction via the memory path.
 *
 * search:semantic is degraded to ZERO candidates with a throwing `sql` (no PG in
 * this unit layer) so only the memory candidates reach the reduction — exactly
 * the per-source degradation the tier promises (it still records the surface as
 * `searched`, it just contributes nothing). The MemoryBackend is INJECTED via
 * deps (generalize-memory-backend-swappable D-003) — a stub that deliberately
 * does NOT dedupe across pools, so the tier's own reduction is what's on trial.
 */

import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { scopesOf, type MemoryBackend, type MemoryEntry } from '../../memory/backend';
import {
  runKnowledgeTier,
  type KnowledgeTierDeps,
} from './ask-knowledge-tier';

type Mem = { id: string; text: string; score?: number };

/** A backend stub returning a different result set per fanned scope key —
 *  flattened WITHOUT per-id dedup (the tier's reduction is under test). */
function stubBackend(byKey: Record<string, Mem[]>): MemoryBackend {
  return {
    name: 'stub',
    available: async () => ({ ok: true }),
    search: async (_q, opts): Promise<MemoryEntry[]> =>
      scopesOf(opts.scope).flatMap((k) => (byKey[k] ?? []).map((m) => ({ ...m, scope: k }))),
    list: async () => [],
    get: async () => null,
    remember: async () => ({ ids: [] }),
    forget: async () => {},
    update: async () => {},
  };
}

/** A `sql` whose use throws, so the search:semantic branch degrades to nothing
 *  (the try/catch swallows it) and only the memory store feeds the reduction. */
const throwingSql = (() => {
  const fn = () => {
    throw new Error('search surface absent in this unit layer');
  };
  return fn as unknown as Sql;
})();

function deps(backend: MemoryBackend): KnowledgeTierDeps {
  return { sql: throwingSql, backend };
}

describe('runKnowledgeTier — dedup by ref, cross-source ordering, top-N', () => {
  it('keeps the HIGHEST-scored copy of a duplicate ref across keys (one survivor)', async () => {
    // The same memory id 'm1' matches under the asker key AND the workspace key
    // with DIFFERENT scores — they collapse to one candidate at the higher score.
    const backend = stubBackend({
      agA: [{ id: 'm1', text: 'zero-cache down', score: 0.4 }],
      'workspace:default': [{ id: 'm1', text: 'zero-cache down', score: 0.95 }],
    });
    const res = await runKnowledgeTier({ query: 'q', workspaceId: 'default', asker_id: 'agA' }, deps(backend));

    const m1 = res.candidates.filter((c) => c.ref === 'mem0:m1');
    expect(m1).toHaveLength(1); // deduped
    expect(m1[0].score).toBe(0.95); // the higher score survived
    // memory was queried; search:semantic contributed NO candidates (it degraded
    // to empty with no real index here), so every survivor is a memory candidate.
    expect(res.searched).toContain('mem0');
    expect(res.candidates.every((c) => c.source === 'mem0')).toBe(true);
  });

  it('sorts the surviving candidates by score descending', async () => {
    const backend = stubBackend({
      'workspace:default': [
        { id: 'lo', text: 'low', score: 0.1 },
        { id: 'hi', text: 'high', score: 0.9 },
        { id: 'mid', text: 'mid', score: 0.5 },
      ],
    });
    const res = await runKnowledgeTier({ query: 'q', workspaceId: 'default', asker_id: 'agA' }, deps(backend));
    expect(res.candidates.map((c) => c.ref)).toEqual(['mem0:hi', 'mem0:mid', 'mem0:lo']);
    expect(res.candidates.map((c) => c.score)).toEqual([0.9, 0.5, 0.1]);
  });

  it('caps the result at the limit (top-N) after dedup', async () => {
    const many: Mem[] = Array.from({ length: 8 }, (_, i) => ({
      id: `m${i}`,
      text: `mem ${i}`,
      score: i / 10, // 0.0 … 0.7
    }));
    const backend = stubBackend({ 'workspace:default': many });
    const res = await runKnowledgeTier({ query: 'q', workspaceId: 'default', asker_id: 'agA', limit: 3 }, deps(backend));

    expect(res.candidates).toHaveLength(3);
    // The top-3 by score (descending): m7(0.7), m6(0.6), m5(0.5).
    expect(res.candidates.map((c) => c.ref)).toEqual(['mem0:m7', 'mem0:m6', 'mem0:m5']);
  });

  it('dedup runs BEFORE the top-N slice — a duplicate does not consume a slot', async () => {
    // 'dup' appears under two keys; without dedup-before-slice the lower copy
    // could push a distinct lower-scored candidate out of a limit-2 window.
    const backend = stubBackend({
      agA: [{ id: 'dup', text: 'd', score: 0.3 }],
      'workspace:default': [
        { id: 'dup', text: 'd', score: 0.8 },
        { id: 'other', text: 'o', score: 0.5 },
      ],
    });
    const res = await runKnowledgeTier({ query: 'q', workspaceId: 'default', asker_id: 'agA', limit: 2 }, deps(backend));
    // Two DISTINCT refs survive (dup@0.8, other@0.5), not three rows.
    expect(res.candidates.map((c) => c.ref)).toEqual(['mem0:dup', 'mem0:other']);
    expect(res.candidates.find((c) => c.ref === 'mem0:dup')?.score).toBe(0.8);
  });

  it('a memory missing a score sorts as 0 (the ?? 0 default), below scored peers', async () => {
    const backend = stubBackend({
      'workspace:default': [
        { id: 'noscore', text: 'n' }, // score undefined → 0
        { id: 'scored', text: 's', score: 0.2 },
      ],
    });
    const res = await runKnowledgeTier({ query: 'q', workspaceId: 'default', asker_id: 'agA' }, deps(backend));
    expect(res.candidates.map((c) => c.ref)).toEqual(['mem0:scored', 'mem0:noscore']);
    expect(res.candidates.find((c) => c.ref === 'mem0:noscore')?.score).toBe(0);
  });

  it('an unavailable backend degrades to zero memory candidates (still no throw)', async () => {
    const backend = stubBackend({});
    backend.available = async () => ({ ok: false, reason: 'memory_backend_disabled' });
    const res = await runKnowledgeTier({ query: 'q', workspaceId: 'default', asker_id: 'agA' }, deps(backend));
    expect(res.candidates).toEqual([]);
    expect(res.searched).not.toContain('mem0');
  });
});
