/**
 * seed-e2e-measurement.test.ts — the P-010 packaged-install E2E acceptance logic.
 *
 * Pure/hermetic: the heavy packaged-install measure seam is INJECTED, so every
 * acceptance check (usable / join-exercised / delta-only / faster) is proven with
 * no build and no real install. The actual two-install measurement is
 * build-dependent (deploys frozen) and covered by the honest rig-required seam.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  evaluateSeedE2E,
  runSeedE2EMeasurement,
  unavailablePackagedMeasure,
  PACKAGED_MEASURE_BUILD_REQUIRED,
  DEFAULT_SEED_E2E_THRESHOLDS,
  type BootMeasurement,
} from './seed-e2e-measurement';

const COLD: BootMeasurement = {
  mode: 'cold',
  wallMs: 300_000, // 5 min full-history first boot
  bytesTransferred: 5_000_000_000, // ~5 GB whole history
  plansVisible: 12,
  workItemsVisible: 340,
  repoUsable: true,
  joinExercised: true,
};

const SEEDED: BootMeasurement = {
  mode: 'seeded',
  wallMs: 40_000, // 40s: restore + delta
  bytesTransferred: 200_000_000, // ~200 MB delta (4% of cold)
  plansVisible: 12,
  workItemsVisible: 341, // one more than the seed snapshot — delta caught up
  repoUsable: true,
  joinExercised: true,
};

describe('evaluateSeedE2E — the happy path', () => {
  it('seeded reaches a usable hive, delta-only, join exercised, faster ⇒ PASS', () => {
    const v = evaluateSeedE2E(COLD, SEEDED);
    expect(v.ok).toBe(true);
    expect(v.summary).toMatch(/PASS/);
    expect(v.checks.every((c) => c.ok)).toBe(true);
    // every acceptance dimension is represented
    const names = v.checks.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining(['modes-correct', 'cold-usable', 'seeded-usable', 'join-exercised-both', 'delta-only', 'seeded-faster']),
    );
  });
});

describe('evaluateSeedE2E — each failure dimension', () => {
  it('seeded not usable (no plans) ⇒ FAIL on seeded-usable', () => {
    const v = evaluateSeedE2E(COLD, { ...SEEDED, plansVisible: 0 });
    expect(v.ok).toBe(false);
    expect(v.checks.find((c) => c.name === 'seeded-usable')!.ok).toBe(false);
  });

  it('seeded bypassed the real join ⇒ FAIL on join-exercised-both (D-007)', () => {
    const v = evaluateSeedE2E(COLD, { ...SEEDED, joinExercised: false });
    expect(v.ok).toBe(false);
    const c = v.checks.find((x) => x.name === 'join-exercised-both')!;
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/seeded.joinExercised=false/);
  });

  it('seeded transferred too much (not delta-only) ⇒ FAIL on delta-only', () => {
    // 2 GB is 40% of cold's 5 GB — over the 25% cap.
    const v = evaluateSeedE2E(COLD, { ...SEEDED, bytesTransferred: 2_000_000_000 });
    expect(v.ok).toBe(false);
    const c = v.checks.find((x) => x.name === 'delta-only')!;
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/40\.0%/);
  });

  it('bytes not measured ⇒ FAIL on delta-only with a clear reason', () => {
    const { bytesTransferred: _c, ...coldNoBytes } = COLD;
    const { bytesTransferred: _s, ...seededNoBytes } = SEEDED;
    const v = evaluateSeedE2E(coldNoBytes as BootMeasurement, seededNoBytes as BootMeasurement);
    const c = v.checks.find((x) => x.name === 'delta-only')!;
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/not measured/);
  });

  it('seeded not faster ⇒ FAIL on seeded-faster when required', () => {
    const v = evaluateSeedE2E(COLD, { ...SEEDED, wallMs: 400_000 });
    expect(v.ok).toBe(false);
    expect(v.checks.find((c) => c.name === 'seeded-faster')!.ok).toBe(false);
  });

  it('the cold baseline itself failing ⇒ FAIL on cold-usable (guards a broken baseline)', () => {
    const v = evaluateSeedE2E({ ...COLD, repoUsable: false }, SEEDED);
    expect(v.ok).toBe(false);
    expect(v.checks.find((c) => c.name === 'cold-usable')!.ok).toBe(false);
  });

  it('swapped/mislabeled modes ⇒ FAIL on modes-correct', () => {
    const v = evaluateSeedE2E({ ...COLD, mode: 'seeded' }, SEEDED);
    expect(v.checks.find((c) => c.name === 'modes-correct')!.ok).toBe(false);
  });
});

describe('evaluateSeedE2E — thresholds', () => {
  it('requireFaster:false drops the wall-time gate', () => {
    const v = evaluateSeedE2E(
      COLD,
      { ...SEEDED, wallMs: 400_000 },
      { ...DEFAULT_SEED_E2E_THRESHOLDS, requireFaster: false },
    );
    expect(v.checks.some((c) => c.name === 'seeded-faster')).toBe(false);
    // still passes on the other dimensions
    expect(v.ok).toBe(true);
  });

  it('a stricter delta cap (10%) rejects a 4% -> still ok, but a 20% transfer fails', () => {
    const strict = { ...DEFAULT_SEED_E2E_THRESHOLDS, maxDeltaFraction: 0.1 };
    expect(evaluateSeedE2E(COLD, SEEDED, strict).ok).toBe(true); // 4% <= 10%
    const twentyPct = evaluateSeedE2E(COLD, { ...SEEDED, bytesTransferred: 1_000_000_000 }, strict);
    expect(twentyPct.checks.find((c) => c.name === 'delta-only')!.ok).toBe(false); // 20% > 10%
  });
});

describe('runSeedE2EMeasurement', () => {
  it('measures cold then seeded via the injected seam and evaluates ⇒ PASS', async () => {
    const measure = vi.fn(async (mode: 'cold' | 'seeded') => (mode === 'cold' ? COLD : SEEDED));
    const v = await runSeedE2EMeasurement({ measure });
    expect(v.ok).toBe(true);
    expect(measure).toHaveBeenCalledWith('cold');
    expect(measure).toHaveBeenCalledWith('seeded');
    expect(measure).toHaveBeenCalledTimes(2);
  });

  it('the DEFAULT measure is build-required (honest, no fabricated numbers)', async () => {
    await expect(runSeedE2EMeasurement()).rejects.toThrow(PACKAGED_MEASURE_BUILD_REQUIRED);
    await expect(unavailablePackagedMeasure('cold')).rejects.toThrow(/PACKAGED BUILD/);
  });
});
