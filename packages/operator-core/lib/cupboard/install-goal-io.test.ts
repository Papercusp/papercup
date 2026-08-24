/**
 * install-goal-io — the gate ordering (harness → rubrics → place → validate →
 * seed), the refuse-don't-degrade contract validation, and the no-clobber /
 * inactive-stub seed semantics (work-on-everything-goal-2026-08-23 P-006,
 * D-002: install ≠ start).
 *
 * The PLACE step is mocked (installGoalFromCupboardCore): its git/network
 * mechanics are the generic self-describing installer's, already covered by
 * install-blueprint-core.test.ts, and the real core would copy into the real
 * user layer (~/.papercusp/goal-packages), which a unit test must never touch.
 * The schema/launch-settings validation and the seed seam run REAL.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalGoalPackage } from './goal-package-store';
import type { RubricRequirementDeps } from './rubric-requirements';

const mocks = vi.hoisted(() => ({
  core: vi.fn(),
  resolveListing: vi.fn(),
}));

vi.mock('./install-goal-core', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  installGoalFromCupboardCore: mocks.core,
}));
vi.mock('./resolve-listing-by-kind', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveListingByKind: mocks.resolveListing,
}));

import { installGoalFromCupboard } from './install-goal-io';

const PKG: LocalGoalPackage = {
  ref: 'keep-green',
  title: 'Keep the tree green',
  body: 'Duties: watch the gate.',
  standing: true,
  killCriterion: 'Owner retires the duty',
  tripwires: [{ metric: 'spend_usd', label: 'Spend', threshold: 500 }],
  budgetCents: 50_000,
  budgetWindowSec: 604_800,
  launchSettings: { autoStart: true },
  inputSchema: { type: 'object' },
  outputSchema: null,
  propertySchema: null,
  description: 'A standing stewardship package',
  requiresRubrics: [],
  version: '1.0.0',
  source: 'installed',
  dir: '/fake/keep-green',
  layer: 'user',
};

/** Rubric deps where nothing is provided anywhere — the strictest workspace. */
const noRubricDeps: RubricRequirementDeps = {
  hasWorkspaceRubric: async () => false,
  localRubricLayer: () => null,
  findRubricListing: async () => null,
};

const coreResult = (pkg: LocalGoalPackage = PKG) => ({
  ok: true as const,
  ref: pkg.ref,
  pkg,
  source: 'https://github.com/o/r',
  installedTo: `/fake/${pkg.ref}`,
});

beforeEach(() => {
  mocks.core.mockReset();
  mocks.resolveListing.mockReset();
  mocks.core.mockResolvedValue(coreResult());
});

describe('gate ordering', () => {
  it('refuses a seed-path install with no harness BEFORE anything is downloaded', async () => {
    const result = await installGoalFromCupboard({
      githubUrl: 'https://github.com/o/r',
      listingRef: 'keep-green',
    });
    expect(result).toMatchObject({ ok: false, status: 400 });
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toMatch(/harness required/);
    expect(mocks.core).not.toHaveBeenCalled();
  });

  it('refuses on an unresolvable required rubric BEFORE the clone, with the verdict attached', async () => {
    mocks.resolveListing.mockResolvedValue({
      githubUrl: 'https://github.com/o/r',
      ref: 'keep-green',
      requiresRubrics: JSON.stringify([{ rubricRef: 'nothing-provides-this' }]),
    });
    const result = await installGoalFromCupboard(
      { listingId: 'lst-1', harness: 'papercusp' },
      { rubricDeps: noRubricDeps },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.rubrics?.unresolvable).toEqual(['nothing-provides-this']);
    expect(mocks.core).not.toHaveBeenCalled();
  });
});

describe('contract validation (refuse, never degrade)', () => {
  it('422s a package whose inputSchema does not compile, and never calls the seeder', async () => {
    mocks.core.mockResolvedValue(
      coreResult({ ...PKG, inputSchema: { type: 'definitely-not-a-type' } }),
    );
    const seeder = vi.fn();
    const result = await installGoalFromCupboard(
      { githubUrl: 'https://github.com/o/r', listingRef: 'keep-green', harness: 'papercusp' },
      { rubricDeps: noRubricDeps, seedGoalStub: seeder },
    );
    expect(result).toMatchObject({ ok: false, status: 422 });
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toMatch(/inputSchema/);
    expect(seeder).not.toHaveBeenCalled();
  });

  it('422s launchSettings with an unknown key (the schema is strict on purpose)', async () => {
    mocks.core.mockResolvedValue(
      coreResult({ ...PKG, launchSettings: { bogusKnob: true } }),
    );
    const seeder = vi.fn();
    const result = await installGoalFromCupboard(
      { githubUrl: 'https://github.com/o/r', listingRef: 'keep-green', harness: 'papercusp' },
      { rubricDeps: noRubricDeps, seedGoalStub: seeder },
    );
    expect(result).toMatchObject({ ok: false, status: 422 });
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toMatch(/launchSettings/);
    expect(seeder).not.toHaveBeenCalled();
  });

  it('skipSeed places the dir and SKIPS validation — there is no insert to guard', async () => {
    mocks.core.mockResolvedValue(
      coreResult({ ...PKG, inputSchema: { type: 'definitely-not-a-type' } }),
    );
    const seeder = vi.fn();
    const result = await installGoalFromCupboard(
      { githubUrl: 'https://github.com/o/r', listingRef: 'keep-green', skipSeed: true },
      { rubricDeps: noRubricDeps, seedGoalStub: seeder },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.result).toMatchObject({ seeded: false, seedSkipped: 'skipped' });
    expect(seeder).not.toHaveBeenCalled();
  });
});

describe('the inactive-stub seed', () => {
  it('hands the seeder the full package (standing + budget window included) and reports its goal id', async () => {
    const seeder = vi.fn(async () => ({ seeded: true, goalId: 'keep-the-tree-green-abc123' }));
    const result = await installGoalFromCupboard(
      { githubUrl: 'https://github.com/o/r', listingRef: 'keep-green', harness: 'papercusp' },
      { rubricDeps: noRubricDeps, seedGoalStub: seeder },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(seeder).toHaveBeenCalledWith({ pkg: PKG, ref: 'keep-green', harness: 'papercusp' });
    expect(result.result).toMatchObject({
      seeded: true,
      goalId: 'keep-the-tree-green-abc123',
      ref: 'keep-green',
    });
    expect(result.result.pkg.standing).toBe(true);
    expect(result.result.pkg.budgetWindowSec).toBe(604_800);
  });

  it('reports the package-identity no-clobber as seeded:false / exists — never an error', async () => {
    const seeder = vi.fn(async () => ({ seeded: false, reason: 'exists' }));
    const result = await installGoalFromCupboard(
      { githubUrl: 'https://github.com/o/r', listingRef: 'keep-green', harness: 'papercusp' },
      { rubricDeps: noRubricDeps, seedGoalStub: seeder },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.result).toMatchObject({ seeded: false, seedSkipped: 'exists' });
  });

  it('a seeder throw does NOT fail the install — the dir is the re-seedable source, but the miss is reported', async () => {
    const seeder = vi.fn(async () => {
      throw new Error('pg exploded');
    });
    const result = await installGoalFromCupboard(
      { githubUrl: 'https://github.com/o/r', listingRef: 'keep-green', harness: 'papercusp' },
      { rubricDeps: noRubricDeps, seedGoalStub: seeder },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.result.seeded).toBe(false);
    expect(result.result.seedSkipped).toMatch(/pg exploded/);
  });
});
