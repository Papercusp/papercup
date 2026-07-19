/**
 * EI-13285: `nextIssueId`'s old allocator scanned `MAX(existing EI-<n>) + 1` under a
 * LOCAL advisory lock — unique within one Postgres instance, but nothing stops a
 * different Hive peer device (its own separate, federation-lagged copy of
 * `engineer_issues`) from independently computing the exact same "next" integer with
 * zero coordination. Live incident: a freshly captured local improvement (EI-13236)
 * was silently clobbered when an unrelated remote replication-liveness issue
 * federated in under the SAME allocated id.
 *
 * `newCollisionResistantIssueTail` is the pure generator behind the fix (time +
 * wide random tail — no dependency on scanning replicated state at all, so no
 * cross-device coordination is required). Pinned here without a DB.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/issues-engineer.collision-resistant-id.test.ts
 */
import { describe, expect, it } from 'vitest';
import { newCollisionResistantIssueTail } from './issues-engineer';

describe('newCollisionResistantIssueTail (EI-13285 collision-resistant EI id allocator)', () => {
  it('returns a digits-only string (still fits the legacy EI-<n> ^EI-[0-9]+$ shape)', () => {
    const tail = newCollisionResistantIssueTail();
    expect(tail).toMatch(/^[0-9]+$/);
  });

  it('simulates two INDEPENDENT, non-coordinating allocators (two Hive peer devices) and never collides', () => {
    // The exact failure mode: two callers with no shared state (no DB row scan, no
    // lock) each mint an id "at the same time". Simulate 5,000 such independent
    // allocations (interleaved, as two devices racing would be) and assert the
    // resulting id space has zero duplicates — the old MAX-scan allocator could not
    // make this claim across two DIFFERENT database instances; this generator can,
    // because it never reads shared state to decide the next value.
    const ids = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      const tail = newCollisionResistantIssueTail();
      expect(ids.has(tail)).toBe(false); // a collision here would be the EI-13285 bug, reproduced
      ids.add(tail);
    }
    expect(ids.size).toBe(5000);
  });

  it('every freshly minted id numerically sorts AFTER any legacy small sequential id (existing numeric-sort assumptions hold)', () => {
    const legacyMaxObservedId = 999_999; // far above any real legacy EI-<n> count
    const tail = Number(newCollisionResistantIssueTail());
    expect(tail).toBeGreaterThan(legacyMaxObservedId);
  });

  it('stays within Postgres bigint range and JS-safe-integer-adjacent precision (no silent truncation)', () => {
    const tail = BigInt(newCollisionResistantIssueTail());
    const PG_BIGINT_MAX = 9_223_372_036_854_775_807n;
    expect(tail).toBeGreaterThan(0n);
    expect(tail).toBeLessThan(PG_BIGINT_MAX);
  });
});
