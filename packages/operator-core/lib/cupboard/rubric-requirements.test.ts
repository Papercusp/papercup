/**
 * rubric-requirements — the install gate's resolution order and refusals
 * (cupboard-plan-rubric-recipe-sharing-2026-08-21 P-016, covering the P-011 cases the
 * plan names: satisfied-by-bundle / co-install / unresolvable).
 *
 * The ORDER is the thing under test, not just the outcomes. Each source is stubbed to
 * answer for exactly one ref, so a resolver that consulted them in the wrong order —
 * or consulted a later one after an earlier one already answered — produces a
 * different `providedBy` than the assertion expects.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  resolveRubricRequirements,
  rubricGateRefusal,
  type RubricRequirementDeps,
} from './rubric-requirements';

/** Deps that answer "absent" everywhere unless a case overrides one leg. */
function deps(over: Partial<RubricRequirementDeps> = {}): RubricRequirementDeps {
  return {
    hasWorkspaceRubric: async () => false,
    localRubricLayer: () => null,
    findRubricListing: async () => null,
    ...over,
  };
}

const LISTING = { listingId: 'uuid-1', githubUrl: 'https://github.com/o/r', ref: 'some-rubric' };

describe('resolveRubricRequirements', () => {
  it('a LIVE workspace rubric row satisfies, and short-circuits the later sources', async () => {
    const localRubricLayer = vi.fn(() => null);
    const findRubricListing = vi.fn(async () => null);
    const v = await resolveRubricRequirements(
      [{ rubricRef: 'plan-class-feature-ship' }],
      deps({ hasWorkspaceRubric: async () => true, localRubricLayer, findRubricListing }),
    );
    expect(v.ok).toBe(true);
    expect(v.requirements[0]).toMatchObject({ state: 'satisfied', providedBy: 'workspace' });
    // Short-circuit is the point: a satisfied requirement must not cost a Cupboard
    // round-trip per entry.
    expect(localRubricLayer).not.toHaveBeenCalled();
    expect(findRubricListing).not.toHaveBeenCalled();
  });

  it('the BUNDLED first-party set counts as provided (the common plan-class case)', async () => {
    const v = await resolveRubricRequirements(
      [{ rubricRef: 'plan-class-bugfix' }],
      deps({ localRubricLayer: () => 'bundled' }),
    );
    expect(v.ok).toBe(true);
    expect(v.satisfied).toEqual(['plan-class-bugfix']);
    expect(v.requirements[0]?.providedBy).toBe('bundled');
    expect(v.coInstall).toEqual([]);
  });

  it('a user-layer dir counts as provided even before it is seeded', async () => {
    const v = await resolveRubricRequirements(
      [{ rubricRef: 'x' }],
      deps({ localRubricLayer: () => 'user' }),
    );
    expect(v.requirements[0]).toMatchObject({ state: 'satisfied', providedBy: 'installed' });
  });

  it('a Cupboard rubric listing makes it INSTALLABLE — an offer, not a satisfaction', async () => {
    const v = await resolveRubricRequirements(
      [{ rubricRef: 'some-rubric' }],
      deps({ findRubricListing: async () => LISTING }),
    );
    expect(v.ok).toBe(true); // resolvable ⇒ not fatal…
    expect(v.coInstall).toEqual(['some-rubric']); // …but it IS an outstanding offer
    expect(v.satisfied).toEqual([]);
    expect(v.requirements[0]?.listing).toEqual(LISTING);
  });

  it('nothing provides it ⇒ UNRESOLVABLE and ok:false', async () => {
    const v = await resolveRubricRequirements([{ rubricRef: 'ghost' }], deps());
    expect(v.ok).toBe(false);
    expect(v.unresolvable).toEqual(['ghost']);
  });

  it('an OPTIONAL entry never blocks, however unresolvable', async () => {
    const v = await resolveRubricRequirements([{ rubricRef: 'ghost', optional: true }], deps());
    expect(v.ok).toBe(true);
    expect(v.unresolvable).toEqual([]);
    expect(v.missingOptional).toEqual(['ghost']);
  });

  it('an optional entry that is merely installable is reported, not offered', async () => {
    const v = await resolveRubricRequirements(
      [{ rubricRef: 'some-rubric', optional: true }],
      deps({ findRubricListing: async () => LISTING }),
    );
    expect(v.coInstall).toEqual([]);
    expect(v.missingOptional).toEqual(['some-rubric']);
  });

  it('an empty declaration resolves ok with nothing to do', async () => {
    const v = await resolveRubricRequirements([], deps());
    expect(v).toMatchObject({ ok: true, satisfied: [], coInstall: [], unresolvable: [] });
  });

  it('resolves a MIXED declaration entry-by-entry', async () => {
    const v = await resolveRubricRequirements(
      [{ rubricRef: 'have-it' }, { rubricRef: 'some-rubric' }, { rubricRef: 'ghost' }],
      deps({
        localRubricLayer: (ref) => (ref === 'have-it' ? 'bundled' : null),
        findRubricListing: async (ref) => (ref === 'some-rubric' ? LISTING : null),
      }),
    );
    expect(v.satisfied).toEqual(['have-it']);
    expect(v.coInstall).toEqual(['some-rubric']);
    expect(v.unresolvable).toEqual(['ghost']);
    expect(v.ok).toBe(false);
  });
});

describe('rubricGateRefusal', () => {
  it('lets a fully satisfied declaration through', async () => {
    const v = await resolveRubricRequirements(
      [{ rubricRef: 'a' }],
      deps({ localRubricLayer: () => 'bundled' }),
    );
    expect(rubricGateRefusal(v, { acceptCoInstall: false })).toBeNull();
  });

  it('refuses an unresolvable requirement with no remedy on offer', async () => {
    const v = await resolveRubricRequirements([{ rubricRef: 'ghost' }], deps());
    const r = rubricGateRefusal(v, { acceptCoInstall: true });
    expect(r?.error).toBe('required_rubrics_unresolvable');
    expect(r?.status).toBe(409);
    expect(r?.detail).toContain('ghost');
  });

  it('refuses an un-accepted co-install and NAMES the flag that fixes it', async () => {
    const v = await resolveRubricRequirements(
      [{ rubricRef: 'some-rubric' }],
      deps({ findRubricListing: async () => LISTING }),
    );
    const r = rubricGateRefusal(v, { acceptCoInstall: false });
    expect(r?.error).toBe('required_rubrics_need_co_install');
    expect(r?.detail).toContain('installRequiredRubrics');
    // Accepting it clears the refusal — the same verdict, a different answer.
    expect(rubricGateRefusal(v, { acceptCoInstall: true })).toBeNull();
  });

  it('an unresolvable entry outranks a co-installable one in the message', async () => {
    const v = await resolveRubricRequirements(
      [{ rubricRef: 'some-rubric' }, { rubricRef: 'ghost' }],
      deps({ findRubricListing: async (ref) => (ref === 'some-rubric' ? LISTING : null) }),
    );
    // Offering a co-install while another entry can never be satisfied would send
    // the caller round a loop that cannot terminate.
    expect(rubricGateRefusal(v, { acceptCoInstall: true })?.error).toBe(
      'required_rubrics_unresolvable',
    );
  });
});
