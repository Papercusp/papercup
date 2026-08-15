/**
 * P-015 — the D-009 recurrence guard.
 *
 * FALSIFIABILITY DISCIPLINE. A guard that has never failed is a guard nobody has tested, and
 * the safe way to prove this one CAN fail is a permanent in-file control rather than a mutation
 * of the shared tree (CLAUDE.md § "Proving a guard is falsifiable" — the tier-1 case, since the
 * subject is a module we import). Each control below is a deliberately NARROWER rule; every
 * `expect` that a control MISSES a fixture the real guard CATCHES is what proves the widening
 * is load-bearing rather than decorative. The calibration block then shows the controls are not
 * simply broken — they agree with the real guard on the healthy and the obvious cases.
 */

import { describe, expect, it, vi } from 'vitest';
import type { SeedManifest, SeedStoreEntry } from '@papercusp/seed-bundle';
import {
  DEFAULT_CORESTORE_SIZE_FLOOR_BYTES,
  SEED_ACK_FULL_HISTORY_ENV,
  assertSeedNotDegraded,
  isFullHistoryAcknowledged,
  judgeSeedDegradation,
} from './seed-degradation-guard.js';

// ── fixtures ───────────────────────────────────────────────────────────────────────────
// The degraded values are the REAL ones from papercusp-desktop/src-tauri/seed/manifest.json
// (cut 2026-07-21), so the guard is calibrated against the artifact it exists to reject.
const CORE_A = '5b00878b7df0637b4f758129d02bc797d6c1928e18bc3751cb27b9ca0d541bac';
const CORE_B = 'aa11bb22cc33dd44ee55ff6677889900aabbccddeeff00112233445566778899';
const SHIPPED_DEGRADED_BYTES = 1_998_388_355;
const SHIPPED_DEGRADED_BLOCKS = 461_475;

function manifest(stores: SeedStoreEntry[]): SeedManifest {
  return { seedFormatVersion: 1, potId: 'papercusp', cutAtEpoch: 1, cutHlc: 'h', cutTs: 0, stores };
}

function corestore(meta: Record<string, unknown>, sizeBytes = SHIPPED_DEGRADED_BYTES): SeedStoreEntry {
  return { kind: 'corestore', hash: 'h', sizeBytes, source: { type: 'resource', path: '/x' }, meta };
}

const gitEntry: SeedStoreEntry = {
  kind: 'git',
  hash: 'g',
  sizeBytes: 131_296_503,
  source: { type: 'resource', path: '/g' },
};

/** State 2 — the shipped lie: labelled sparse, starts at 0, ships every block. */
const DEGRADED = manifest([
  gitEntry,
  corestore({ coreKeys: [CORE_A], coreLengths: { [CORE_A]: SHIPPED_DEGRADED_BLOCKS }, coreSparseFrom: { [CORE_A]: 0 } }),
]);

/** State 2, partial — one core healthy, one degraded. The same lie, and the case a
 *  whole-manifest "are they ALL zero?" rule cannot see. */
const PARTIALLY_DEGRADED = manifest([
  gitEntry,
  corestore({
    coreKeys: [CORE_A, CORE_B],
    coreLengths: { [CORE_A]: 460_000, [CORE_B]: SHIPPED_DEGRADED_BLOCKS },
    coreSparseFrom: { [CORE_A]: 459_000, [CORE_B]: 0 },
  }),
]);

/** State 3 — a genuine sparse cut: a real suffix start, and a head-span-sized payload. */
const HEALTHY_SPARSE = manifest([
  gitEntry,
  corestore(
    { coreKeys: [CORE_A], coreLengths: { [CORE_A]: SHIPPED_DEGRADED_BLOCKS }, coreSparseFrom: { [CORE_A]: 461_000 } },
    41 * 1024 * 1024,
  ),
]);

/** State 1 — an honestly-labelled full cut (no coreSparseFrom key at all), still a 50x installer. */
const HONEST_FULL = manifest([
  gitEntry,
  corestore({ coreKeys: [CORE_A], coreLengths: { [CORE_A]: SHIPPED_DEGRADED_BLOCKS } }),
]);

/** What `cutHiveSeed` returns on the reuse path BEFORE the graft — git only. Judging this
 *  object instead of the final manifest is the reuse-path blind spot (D-023). */
const PRE_GRAFT_GIT_ONLY = manifest([gitEntry]);

/** A tiny core legitimately starting at 0 — there is no history to trim. Must NOT trip. */
const SMALL_CORE = manifest([
  gitEntry,
  corestore({ coreKeys: [CORE_A], coreLengths: { [CORE_A]: 12 }, coreSparseFrom: { [CORE_A]: 0 } }, 4 * 1024),
]);

/**
 * The FILTERED current-state projection — the path that ACTUALLY SHIPS. `cut-seed-cli` passes
 * `filtered: true` unconditionally, and seed-provider-corestore's `if (filtered)` branch returns
 * before the sparse block, deliberately omitting `coreSparseFrom` ("a complete current-state
 * projection, not a source-log suffix"). So it lands here labelled `full`.
 *
 * REAL values from the 2026-08-15 0.0.17-alpha cut, which this guard refused ~81 minutes in:
 * 76 blocks — the head snapshot's exact chunk count — carrying 318,544,683 B, against a
 * 1,788,251-block own-log. Oversized, but it CANNOT be history: no core is long enough to hold any.
 */
const PROJECTION_BLOCKS = 76;
const PROJECTION_BYTES = 318_544_683;
const FILTERED_PROJECTION = manifest([
  gitEntry,
  corestore({ coreKeys: [CORE_A], coreLengths: { [CORE_A]: PROJECTION_BLOCKS } }, PROJECTION_BYTES),
]);

/** CONTROL for that qualifier: the SAME oversized payload, but with history-sized blocks. Relaxing
 *  the floor by BYTES alone would let this through; it must still be REFUSED. That is what proves
 *  the block-count qualifier is load-bearing rather than a hole punched in the floor. */
const OVERSIZED_WITH_HISTORY = manifest([
  gitEntry,
  corestore({ coreKeys: [CORE_A], coreLengths: { [CORE_A]: SHIPPED_DEGRADED_BLOCKS } }, PROJECTION_BYTES),
]);

/** CONTROL, fail-safe direction: oversized, and the manifest records NO length for its core. The
 *  payload cannot be PROVEN harmless, so the floor must still fire. */
const OVERSIZED_UNKNOWN_LENGTH = manifest([
  gitEntry,
  corestore({ coreKeys: [CORE_A] }, PROJECTION_BYTES),
]);

// ── deliberately-wrong controls, kept permanently ──────────────────────────────────────

/** CONTROL 1 — the narrow rule: fail only when EVERY core starts at 0. Blind to a partial. */
function naiveAllZerosGuard(m: SeedManifest): boolean {
  const e = m.stores.find((s) => s.kind === 'corestore');
  const from = e?.meta?.coreSparseFrom as Record<string, number> | undefined;
  if (!from) return true;
  return !Object.values(from).every((v) => v === 0);
}

/** CONTROL 2 — label-only: trust the absence of a sparse label, never weigh the payload size. */
function labelOnlyGuard(m: SeedManifest): boolean {
  const e = m.stores.find((s) => s.kind === 'corestore');
  const from = e?.meta?.coreSparseFrom as Record<string, number> | undefined;
  if (!from) return true;
  return Object.values(from).every((v) => v > 0);
}

const real = (m: SeedManifest, origin: 'fresh' | 'reuse' = 'fresh') => judgeSeedDegradation(m, { origin }).ok;

describe('P-015 seed degradation guard', () => {
  describe('catches the D-009 class', () => {
    it('REFUSES the manifest the 2026-07-21 release actually shipped', () => {
      const v = judgeSeedDegradation(DEGRADED);
      expect(v.ok).toBe(false);
      expect(v.label).toBe('sparse');
      expect(v.findings.map((f) => f.code)).toContain('sparse-label-but-full-history');
      expect(v.message).toMatch(/461,475 blocks/);
    });

    it('REFUSES a partial degradation — one bad core among healthy siblings', () => {
      const v = judgeSeedDegradation(PARTIALLY_DEGRADED);
      expect(v.ok).toBe(false);
      const finding = v.findings.find((f) => f.code === 'sparse-label-but-full-history');
      expect(finding?.cores).toEqual([CORE_B]);
    });

    it('REFUSES an honestly-labelled FULL cut on the size floor', () => {
      const v = judgeSeedDegradation(HONEST_FULL);
      expect(v.ok).toBe(false);
      expect(v.label).toBe('full');
      expect(v.findings.map((f) => f.code)).toEqual(['corestore-exceeds-size-floor']);
    });

    it('REFUSES a sparse-from-0 claim whose length the manifest does not record', () => {
      const v = judgeSeedDegradation(
        manifest([corestore({ coreKeys: [CORE_A], coreSparseFrom: { [CORE_A]: 0 } }, 1024)]),
      );
      expect(v.ok).toBe(false);
      expect(v.findings.map((f) => f.code)).toEqual(['sparse-label-unverifiable-length']);
    });

    it('REFUSES an oversized payload whose blocks COULD hold history', () => {
      // Same bytes as the legitimate projection below. Only the block count differs, so this is
      // the case a bytes-only relaxation would wrongly admit.
      const v = judgeSeedDegradation(OVERSIZED_WITH_HISTORY);
      expect(v.ok).toBe(false);
      expect(v.findings.map((f) => f.code)).toEqual(['corestore-exceeds-size-floor']);
    });

    it('REFUSES an oversized payload whose core lengths are unrecorded — fail safe', () => {
      // Not provably harmless ⇒ still refused. The qualifier must never turn "unknown" into "fine".
      const v = judgeSeedDegradation(OVERSIZED_UNKNOWN_LENGTH);
      expect(v.ok).toBe(false);
      expect(v.findings.map((f) => f.code)).toEqual(['corestore-exceeds-size-floor']);
    });
  });

  describe('does not fire on healthy seeds', () => {
    it('passes a genuine sparse cut', () => {
      expect(judgeSeedDegradation(HEALTHY_SPARSE).ok).toBe(true);
    });

    it('PASSES the filtered current-state projection the shipping path produces', () => {
      // THE 2026-08-15 REGRESSION. This exact manifest (76 blocks / 318,544,683 B) failed the
      // 0.0.17-alpha cut ~81 minutes in, after the seed had already been built. It is oversized
      // by bytes and honest by label; the guard must judge it on what actually separates a
      // projection from a history dump.
      const v = judgeSeedDegradation(FILTERED_PROJECTION);
      expect(v.ok).toBe(true);
      expect(v.label).toBe('full');
      expect(v.sizeBytes).toBeGreaterThan(DEFAULT_CORESTORE_SIZE_FLOOR_BYTES);
      expect(v.findings).toEqual([]);
    });

    it('keeps the block-count qualifier honest: same bytes, history-sized blocks ⇒ opposite verdict', () => {
      // The pair differs ONLY in coreLengths, which is the whole claim of the qualifier.
      expect(judgeSeedDegradation(FILTERED_PROJECTION).ok).toBe(true);
      expect(judgeSeedDegradation(OVERSIZED_WITH_HISTORY).ok).toBe(false);
    });

    it('passes a small core that legitimately starts at 0', () => {
      expect(judgeSeedDegradation(SMALL_CORE).ok).toBe(true);
    });

    it('passes a manifest with no corestore at all', () => {
      const v = judgeSeedDegradation(PRE_GRAFT_GIT_ONLY);
      expect(v.ok).toBe(true);
      expect(v.label).toBe('no-corestore');
    });
  });

  describe('the reuse path (D-023) — the branch that actually ships', () => {
    it('judges a GRAFTED degraded corestore, and quotes the reuse remedy', () => {
      // graftCorestoreEntry copies the prior entry verbatim, coreSparseFrom included.
      const grafted = manifest([...PRE_GRAFT_GIT_ONLY.stores, DEGRADED.stores[1]!]);
      const v = judgeSeedDegradation(grafted, { origin: 'reuse' });
      expect(v.ok).toBe(false);
      expect(v.message).toMatch(/PAPERCUSP_SEED_REUSE_CORESTORE=0/);
    });

    it('CONTROL: judging the pre-graft manifest instead would pass the same degraded seed', () => {
      // This is the blind spot, stated as an executable fact: the object cutHiveSeed returns on
      // the reuse path carries no corestore, so a guard wired there can never see the lie.
      expect(judgeSeedDegradation(PRE_GRAFT_GIT_ONLY).ok).toBe(true);
      const grafted = manifest([...PRE_GRAFT_GIT_ONLY.stores, DEGRADED.stores[1]!]);
      expect(judgeSeedDegradation(grafted, { origin: 'reuse' }).ok).toBe(false);
    });
  });

  describe('falsifiability — each control MISSES what the real guard catches', () => {
    it('CONTROL 1 (all-zeros rule) passes the partial degradation the real guard refuses', () => {
      expect(naiveAllZerosGuard(PARTIALLY_DEGRADED)).toBe(true); // control: clean
      expect(real(PARTIALLY_DEGRADED)).toBe(false); // real guard: refuses
    });

    it('CONTROL 2 (label-only rule) passes the honest 1.9 GB full cut the real guard refuses', () => {
      expect(labelOnlyGuard(HONEST_FULL)).toBe(true); // control: clean
      expect(real(HONEST_FULL)).toBe(false); // real guard: refuses
    });

    it('CALIBRATION: both controls agree with the real guard on healthy + obviously-degraded', () => {
      // Without this the controls above could be passing everything, which would make the two
      // assertions above vacuous rather than evidence.
      expect(naiveAllZerosGuard(HEALTHY_SPARSE)).toBe(true);
      expect(labelOnlyGuard(HEALTHY_SPARSE)).toBe(true);
      expect(real(HEALTHY_SPARSE)).toBe(true);

      expect(naiveAllZerosGuard(DEGRADED)).toBe(false);
      expect(labelOnlyGuard(DEGRADED)).toBe(false);
      expect(real(DEGRADED)).toBe(false);
    });
  });

  describe('the acknowledgement env', () => {
    it('throws by default on a degraded manifest', () => {
      expect(() => assertSeedNotDegraded(DEGRADED, { env: {} })).toThrow(/REFUSING a degraded seed/);
    });

    it('lets an EXPLICIT acknowledgement through, and still returns the not-ok verdict', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const v = assertSeedNotDegraded(DEGRADED, { env: { [SEED_ACK_FULL_HISTORY_ENV]: '1' } });
        expect(v.ok).toBe(false);
        // The whole defect class is silence, so the acknowledged path must ANNOUNCE itself.
        expect(warn).toHaveBeenCalledOnce();
        expect(warn.mock.calls[0]![0]).toMatch(/BY EXPLICIT ACKNOWLEDGEMENT/);
      } finally {
        warn.mockRestore();
      }
    });

    it('only `1` acknowledges — a truthy-looking value is not an acknowledgement', () => {
      for (const value of ['0', 'true', 'yes', '', undefined]) {
        expect(isFullHistoryAcknowledged({ [SEED_ACK_FULL_HISTORY_ENV]: value })).toBe(false);
      }
      expect(isFullHistoryAcknowledged({ [SEED_ACK_FULL_HISTORY_ENV]: '1' })).toBe(true);
    });

    it('does not throw on a clean manifest regardless of the env', () => {
      expect(() => assertSeedNotDegraded(HEALTHY_SPARSE, { env: {} })).not.toThrow();
    });
  });

  describe('floors', () => {
    it('the size floor sits clear of both a sparse seed and the known-bad core', () => {
      expect(41 * 1024 * 1024).toBeLessThan(DEFAULT_CORESTORE_SIZE_FLOOR_BYTES);
      expect(SHIPPED_DEGRADED_BYTES).toBeGreaterThan(DEFAULT_CORESTORE_SIZE_FLOOR_BYTES);
    });

    it('floors are overridable so a caller can tighten them', () => {
      expect(judgeSeedDegradation(HEALTHY_SPARSE, { sizeFloorBytes: 1024 }).ok).toBe(false);
    });
  });
});
