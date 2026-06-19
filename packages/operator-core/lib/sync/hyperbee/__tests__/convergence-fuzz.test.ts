/**
 * convergence-fuzz.test.ts — Brief D (shared-hive-release-testing): the seeded
 * property-based convergence sweep over the REAL merge core + a faithful PG
 * `fed_ts`-guard transcription. See `_convergence-fuzz-rig.ts`.
 *
 * Two regimes:
 *   - 'monotone' (no clock skew): HLC order == fed_ts order. Convergence MUST
 *     hold over a large seed sweep — this is the reusable regression guard.
 *   - 'skew' (recv-advance inversions, the production reality): the fuzzer FINDS
 *     the D-001 split-brain. Asserted as a known divergence (will flip to
 *     "converges" once the merge fold + PG guard are unified — see findings-D).
 */
import { describe, expect, it } from 'vitest';
import { runConvergenceFuzz, type FuzzOptions } from './_convergence-fuzz-rig';

const SWEEP = 120; // seeds per sweep — deterministic, ~instant (no PG, no network)

describe('convergence fuzz — monotone regime (no clock skew) MUST always converge', () => {
  it(`converges on all ${SWEEP} seeds across 5 content types, 4 peers`, async () => {
    const failures: Array<{ seed: number; distinct: string[] }> = [];
    for (let seed = 1; seed <= SWEEP; seed++) {
      const opts: FuzzOptions = { seed, peers: 4, ops: 40, keys: 6, regime: 'monotone' };
      const r = await runConvergenceFuzz(opts);
      if (!r.converged) failures.push({ seed, distinct: r.distinct });
    }
    expect(failures).toEqual([]);
  });

  it('converges under heavier load (8 peers, 120 ops, 10 keys)', async () => {
    const failures: number[] = [];
    for (let seed = 1; seed <= 40; seed++) {
      const r = await runConvergenceFuzz({ seed, peers: 8, ops: 120, keys: 10, regime: 'monotone' });
      if (!r.converged) failures.push(seed);
    }
    expect(failures).toEqual([]);
  });
});

describe('convergence fuzz — skew regime FINDS the D-001 divergence', () => {
  // EXPECTED-RED on the convergence invariant: with recv-advance inversions the
  // sweep produces divergent peers. We assert the fuzzer DETECTS this (≥1 seed
  // diverges) — i.e. the property-based harness has teeth. When D-001 is fixed
  // (one ordering key of record), this sweep will converge on every seed and the
  // `expect(...).toBeGreaterThan(0)` below flips RED, signalling the guard's
  // removal. The companion `it.fails` makes the intent explicit for CI.
  it('detects at least one divergent seed under skew (the fuzzer has teeth)', async () => {
    let diverged = 0;
    const example: { seed: number; distinct: string[] } | null = await (async () => {
      let found: { seed: number; distinct: string[] } | null = null;
      for (let seed = 1; seed <= SWEEP; seed++) {
        const r = await runConvergenceFuzz({ seed, peers: 4, ops: 40, keys: 6, regime: 'skew', skewProb: 0.6 });
        if (!r.converged) {
          diverged++;
          if (!found) found = { seed, distinct: r.distinct };
        }
      }
      return found;
    })();
    // The fuzzer must surface the S0 — if this is ever 0, either the bug is fixed
    // (good — invert this test) or the generator stopped creating inversions.
    expect(diverged).toBeGreaterThan(0);
    expect(example).not.toBeNull();
  });

  it.fails('S0 (D-001): the skew sweep MUST fully converge (release invariant) — it does not', async () => {
    const failures: number[] = [];
    for (let seed = 1; seed <= SWEEP; seed++) {
      const r = await runConvergenceFuzz({ seed, peers: 4, ops: 40, keys: 6, regime: 'skew', skewProb: 0.6 });
      if (!r.converged) failures.push(seed);
    }
    expect(failures).toEqual([]);
  });
});

describe('D-001 fix VALIDATION — an LWW-ordered guard converges even under skew', () => {
  // Same skew sweep that diverges above, but the materialised store's guard
  // orders by the merge's own comparator (`lwwPick`) instead of `fed_ts` — the
  // proposed fix ("one ordering key of record end to end", put AND del). This
  // proves the fix DIRECTION empirically on the very harness that exposes the
  // bug: convergence is restored across the whole seed sweep. (De-risks the
  // owner's design decision; it does NOT change production code.)
  it(`skew regime converges on all ${SWEEP} seeds when the guard orders by lwwPick (not fed_ts)`, async () => {
    const failures: Array<{ seed: number; distinct: string[] }> = [];
    for (let seed = 1; seed <= SWEEP; seed++) {
      const r = await runConvergenceFuzz({
        seed,
        peers: 4,
        ops: 40,
        keys: 6,
        regime: 'skew',
        skewProb: 0.6,
        guardOrder: 'lww', // ← the fix
      });
      if (!r.converged) failures.push({ seed, distinct: r.distinct });
    }
    expect(failures).toEqual([]);
  });

  it('the SAME seeds that diverge under fed_ts converge under lww (paired A/B)', async () => {
    let divergedUnderFedTs = 0;
    let divergedUnderLww = 0;
    for (let seed = 1; seed <= SWEEP; seed++) {
      const base = { seed, peers: 4, ops: 40, keys: 6, regime: 'skew' as const, skewProb: 0.6 };
      if (!(await runConvergenceFuzz({ ...base, guardOrder: 'fed_ts' })).converged) divergedUnderFedTs++;
      if (!(await runConvergenceFuzz({ ...base, guardOrder: 'lww' })).converged) divergedUnderLww++;
    }
    expect(divergedUnderFedTs).toBeGreaterThan(0); // the bug is present today…
    expect(divergedUnderLww).toBe(0); // …and the lwwPick-ordered guard fixes every one
  });
});
