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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { newCollisionResistantIssueTail } from './issues-engineer';

describe('newCollisionResistantIssueTail (EI-13285 collision-resistant EI id allocator)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a digits-only string (still fits the legacy EI-<n> ^EI-[0-9]+$ shape)', () => {
    const tail = newCollisionResistantIssueTail();
    expect(tail).toMatch(/^[0-9]+$/);
  });

  it('two INDEPENDENT, non-coordinating allocators minting in the SAME millisecond stay collision-resistant via the random tail', () => {
    // The exact EI-13285 failure mode was DETERMINISTIC collision: the old MAX(EI-<n>)+1
    // allocator, given the same shared state, hands two non-coordinating peer devices the
    // IDENTICAL "next" id every time. The fix replaces that deterministic scan with
    // time + a random tail, so two devices minting "at the same instant" collide only if
    // their random tails happen to coincide — no shared state is read to decide the value.
    //
    // We pin the clock to a SINGLE millisecond — the worst case, where the ms high-bits
    // give ZERO disambiguation and ALL collision resistance must come from the 20-bit
    // random tail (EI_ID_RAND_SPACE = 2**20 ≈ 1.05M in issues-engineer.ts). Then we mint a
    // large batch of same-instant ids and assert NEAR-TOTAL distinctness.
    //
    // Why not assert ZERO collisions (the original assertion)? The tail is deliberately
    // only 20 bits — a wider tail overflows PG bigint given the fixed 2026 epoch — so over
    // a batch this size the birthday paradox GUARANTEES a handful of tail collisions
    // (E[collisions] ≈ N²/(2·2²⁰) ≈ 11.9 for N=5000, and MORE the faster the loop runs).
    // A zero-collision assertion is therefore statistically impossible and was the source
    // of a ~17% green-checkpoint flake (WI-5507). The honest, hermetic guarantee is that
    // distinct count stays FAR above anything a low/zero-entropy (regressed) allocator
    // could produce — a bound independent of machine speed, so it never flakes.
    const FIXED_MS = Date.UTC(2026, 5, 15); // a fixed instant inside the id epoch
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_MS);

    const N = 5000;
    // Mean ≈ 11.9 collisions; a budget of 100 is ~8× the mean (~25σ) so P(exceeded) is
    // astronomically small (Poisson tail) — never flakes — while the regressed
    // deterministic allocator (all N ids identical ⇒ 4999 collisions) misses it by ~4900.
    const MAX_TAIL_COLLISIONS = 100;

    const ids = new Set<string>();
    for (let i = 0; i < N; i++) ids.add(newCollisionResistantIssueTail());

    const collisions = N - ids.size;
    expect(collisions).toBeLessThanOrEqual(MAX_TAIL_COLLISIONS);
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

  it('does not reintroduce the obsolete process-wide allocator advisory lock (EI-22022609340079560)', () => {
    const source = readFileSync(new URL('./issues-engineer.ts', import.meta.url), 'utf8');
    const allocatorStart = source.indexOf('async function nextIssueId');
    const allocatorEnd = source.indexOf('\n/**', allocatorStart);

    expect(allocatorStart).toBeGreaterThanOrEqual(0);
    expect(allocatorEnd).toBeGreaterThan(allocatorStart);
    expect(source.slice(allocatorStart, allocatorEnd)).not.toContain('pg_advisory_xact_lock');
  });
});
