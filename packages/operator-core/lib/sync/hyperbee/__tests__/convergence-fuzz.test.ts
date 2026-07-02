/**
 * convergence-fuzz.test.ts — Brief D (shared-hive-release-testing): the seeded
 * property-based convergence sweep over the REAL merge core + a faithful PG
 * `fed_ts`-guard transcription. See `_convergence-fuzz-rig.ts`.
 *
 * Two regimes (the rig's DEFAULT guard now models the SHIPPED production guard,
 * `fed_hlc` — migration 314 + the projection writeToPg, D-001 fix):
 *   - 'monotone' (no clock skew): HLC order == fed_ts order. Convergence MUST
 *     hold over a large seed sweep — this is the reusable regression guard.
 *   - 'skew' (recv-advance inversions, the production reality): with the unified
 *     `fed_hlc` guard the sweep now CONVERGES (the D-001 fix). The pre-314 bug is
 *     pinned by an explicit `guardOrder:'fed_ts'` characterisation/teeth test.
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

describe('convergence fuzz — skew regime: the LEGACY fed_ts guard diverges, the shipped fed_hlc guard converges', () => {
  // Characterisation/teeth (the pre-314 bug): under the LEGACY `fed_ts`-ordered
  // guard, recv-advance inversions still produce divergent peers — the D-001 S0.
  // Pinned with an explicit `guardOrder:'fed_ts'` so the harness keeps its teeth
  // (a generator that stops creating inversions would silently pass otherwise).
  it('LEGACY fed_ts guard: detects at least one divergent seed under skew (teeth)', async () => {
    let diverged = 0;
    const example: { seed: number; distinct: string[] } | null = await (async () => {
      let found: { seed: number; distinct: string[] } | null = null;
      for (let seed = 1; seed <= SWEEP; seed++) {
        const r = await runConvergenceFuzz({ seed, peers: 4, ops: 40, keys: 6, regime: 'skew', skewProb: 0.6, guardOrder: 'fed_ts' });
        if (!r.converged) {
          diverged++;
          if (!found) found = { seed, distinct: r.distinct };
        }
      }
      return found;
    })();
    expect(diverged).toBeGreaterThan(0);
    expect(example).not.toBeNull();
  });

  // RELEASE INVARIANT (D-001 fix): the SAME skew sweep, against the SHIPPED
  // production guard (`fed_hlc`, the rig default), now FULLY CONVERGES on every
  // seed. This is the gate flipped from `it.fails` → passing once migration 314 +
  // the projection guard change landed (findings-J).
  it('S0 (D-001) FIXED: the skew sweep fully converges under the shipped fed_hlc guard', async () => {
    const failures: Array<{ seed: number; distinct: string[] }> = [];
    for (let seed = 1; seed <= SWEEP; seed++) {
      const r = await runConvergenceFuzz({ seed, peers: 4, ops: 40, keys: 6, regime: 'skew', skewProb: 0.6 });
      if (!r.converged) failures.push({ seed, distinct: r.distinct });
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

describe('WI-1672 — exact fed_hlc ties under the PRODUCTION topology (skipOwnOps + lockstep counters)', () => {
  // The live split-brain (wi1544 rig, 2026-07-02): after any recv-ratchet
  // episode every peer's clock advances by counter only, in lockstep, so two
  // concurrent writers mint IDENTICAL (ms, count) stamps. The fold's lwwPick
  // never arbitrates local-vs-remote for CDC tables (skipOwnOps) — the PG
  // guard's tie-ACCEPTING `>=` is the only arbiter, and it accepts the remote
  // op on BOTH peers: they stably SWAP winners. `localAuthorApply` models
  // exactly that topology; `lockstep` makes the ties routine, as observed live.
  // delProb: 0 — these tests pin put-vs-put tie ORDERING. Dels under this
  // topology trip an ORTHOGONAL gap (local-del resurrection, pinned below):
  // node ids cannot fix an arbitration the store never gets to make.
  const base = {
    peers: 4,
    ops: 40,
    keys: 6,
    regime: 'monotone' as const,
    lockstep: true,
    localAuthorApply: true,
    delProb: 0,
  };

  it('TEETH (the bug): node-LESS stamps split-brain on exact hlc ties — divergent seeds exist', async () => {
    let diverged = 0;
    for (let seed = 1; seed <= SWEEP; seed++) {
      if (!(await runConvergenceFuzz({ ...base, seed, nodeIds: false })).converged) diverged++;
    }
    expect(diverged).toBeGreaterThan(0);
  });

  it(`FIXED (migration 459): node-carrying stamps make the order total — all ${SWEEP} seeds converge`, async () => {
    const failures: Array<{ seed: number; distinct: string[] }> = [];
    for (let seed = 1; seed <= SWEEP; seed++) {
      const r = await runConvergenceFuzz({ ...base, seed, nodeIds: true });
      if (!r.converged) failures.push({ seed, distinct: r.distinct });
    }
    expect(failures).toEqual([]);
  });

  it('FIXED under skew as well: production topology + recv-advance inversions + node stamps converge', async () => {
    const failures: number[] = [];
    for (let seed = 1; seed <= SWEEP; seed++) {
      const r = await runConvergenceFuzz({
        ...base,
        seed,
        regime: 'skew',
        skewProb: 0.6,
        nodeIds: true,
      });
      if (!r.converged) failures.push(seed);
    }
    expect(failures).toEqual([]);
  });
});

describe('WI-1684 — local-del resurrection under skipOwnOps (no tombstone): a SEPARATE open gap', () => {
  // Found while fixing WI-1672: an author DELETES a row locally (trigger path —
  // row gone, NO tombstone) and its own del is skipOwnOps-excluded from its own
  // fold. A CONCURRENT foreign put with a LOWER hlc then wins the author's fold
  // among foreign ops alone and hits the projection's no-row insert path, which
  // has nothing to arbitrate against → the row is resurrected on the author
  // peer ONLY. Every other peer folds del + put together, the del wins, the row
  // stays deleted: split-brain on row PRESENCE. Node ids (migration 459) cannot
  // fix this — it is a missing-tombstone gap, not an ordering tie.
  // CHARACTERISATION/TEETH: pins that the gap exists TODAY. Flip to a
  // convergence assertion when WI-1684 lands a fix (tombstones, or folding own
  // ops into the winners map).
  it('TEETH: dels + production topology diverge on row presence even WITH node ids', async () => {
    let diverged = 0;
    for (let seed = 1; seed <= SWEEP; seed++) {
      const r = await runConvergenceFuzz({
        seed,
        peers: 4,
        ops: 40,
        keys: 6,
        regime: 'monotone',
        lockstep: true,
        localAuthorApply: true,
        nodeIds: true, // the WI-1672 fix is ON — and does not help here
        delProb: 0.12,
      });
      if (!r.converged) diverged++;
    }
    expect(diverged).toBeGreaterThan(0);
  });
});
