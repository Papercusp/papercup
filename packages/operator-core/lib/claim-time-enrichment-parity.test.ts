/**
 * WI-41182 — the recurrence guard for claim-time trap-guard drift.
 *
 * THE CLASS THIS CATCHES: six guards accumulated across four claim surfaces over
 * ~6 weeks, each wired by hand wherever its author was looking. Nothing defined
 * "the set", so nothing could notice a leg landing at three surfaces and missing
 * the fourth — and three of them did exactly that. Measured before the fix:
 * get_next 6/6, work_items:claim 6/6, claim_next 5/6, plan_items:claim 2/6.
 * Every miss was silent: a claim that skipped a guard looked exactly like a claim
 * that passed one.
 *
 * ⚠ WHAT THIS TEST DOES AND DOES NOT PROVE. It is a WIRING check, not a
 * behavioural one: it proves each surface can reach each guard, not that the
 * guard fires correctly — those are the ports' own tests. That is the right scope
 * here, because the defect being guarded was never a broken guard; it was a guard
 * that was never called at all. Do not "strengthen" this by asserting on rendered
 * warning text: the four surfaces deliberately render some legs differently
 * (claim_next emits premises as `brief.rendered`, get_next emits the whole brief),
 * and pinning that here would fail on a legitimate presentation change.
 *
 * ⚠ WHY SOURCE INSPECTION RATHER THAN INVOCATION. Invoking the four tools would
 * need the full claim substrate (org PG, leases, identity) stood up per surface —
 * an integration test whose failure mode is "the fixture broke", which is exactly
 * the shape that gets quarantined and then silently stops guarding. Reading the
 * source asks the one question that actually regressed, and cannot be flaked by
 * infrastructure. The permanent controls below keep it honest.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLAIM_TIME_ENRICHMENT_LEGS, type ClaimTimeEnrichmentLeg } from './claim-time-enrichment';

const LIB = __dirname;

/**
 * The exported port function that IS each leg. A surface satisfies a leg by
 * calling this directly, or by delegating to `buildClaimTimeEnrichment` (which
 * the first test proves calls all six).
 *
 * ⚠ Adding a member to CLAIM_TIME_ENRICHMENT_LEGS without adding it here fails
 * the exhaustiveness check below — deliberately. That failure is the reminder to
 * wire the new leg at every surface, which is the whole point of this file.
 */
const LEG_IMPLEMENTATION: Record<ClaimTimeEnrichmentLeg, string> = {
  planDecisions: 'getClaimTimePlanDecisions',
  priorAttemptBrief: 'getClaimTimePriorAttemptBrief',
  premises: 'getClaimTimePremises',
  retraction: 'getClaimTimeRetractionAdvisory',
  authorship: 'getClaimTimeAuthorshipRevalidationHint',
  planContradiction: 'getClaimTimePlanItemContradiction',
  behaviorContract: 'getClaimTimeBehaviorContract',
  pathHints: 'getClaimTimeStalePathHints',
  planItemLanded: 'getClaimTimePlanItemLanded',
};

/** Every surface that hands an agent a claimed item and is therefore obliged to warn it. */
const CLAIM_SURFACES: Record<string, string> = {
  'scheduler:get_next': join(LIB, 'agent-tools/scheduler/get_next.ts'),
  'work_items:claim': join(LIB, 'agent-tools/work_items/claim.ts'),
  'work_items:claim_next': join(LIB, 'agent-tools/work_items/claim_next.ts'),
  'plan_items:claim': join(LIB, 'agent-tools/plan-items/claim.ts'),
};

const DELEGATES_TO_PORT = 'buildClaimTimeEnrichment';

function attachesLeg(source: string, leg: ClaimTimeEnrichmentLeg): boolean {
  return source.includes(DELEGATES_TO_PORT) || source.includes(LEG_IMPLEMENTATION[leg]);
}

describe('claim-time enrichment parity (WI-41182)', () => {
  it('names an implementation for every registered leg', () => {
    // Calibration: if the registry and this map drift apart, every other
    // assertion below silently narrows. Check that first, so a shrunk map can
    // never look like passing parity.
    expect(Object.keys(LEG_IMPLEMENTATION).sort()).toEqual([...CLAIM_TIME_ENRICHMENT_LEGS].sort());
  });

  it('the shared port attaches every registered leg', () => {
    const port = readFileSync(join(LIB, 'claim-time-enrichment.ts'), 'utf8');
    for (const leg of CLAIM_TIME_ENRICHMENT_LEGS) {
      expect(port, `the port must call ${LEG_IMPLEMENTATION[leg]} for leg "${leg}"`).toContain(
        LEG_IMPLEMENTATION[leg],
      );
    }
  });

  it.each(Object.entries(CLAIM_SURFACES))('%s attaches every registered leg', (surface, path) => {
    const source = readFileSync(path, 'utf8');
    const missing = CLAIM_TIME_ENRICHMENT_LEGS.filter((leg) => !attachesLeg(source, leg));
    expect(
      missing,
      `${surface} does not attach: ${missing.join(', ')}. Either call the leg's port directly or ` +
        `delegate the whole set to ${DELEGATES_TO_PORT}. A claim surface that skips a guard is ` +
        `indistinguishable, to the agent it answers, from one where the guard passed.`,
    ).toEqual([]);
  });

  /**
   * PERMANENT CONTROLS (repo mutation-probe policy, "a MODULE / logic you import"
   * row): a deliberately-wrong source kept in the test file forever, rather than
   * mutating a real file to prove falsifiability. Without these, the parity
   * assertion above would still pass if `attachesLeg` were broken to return true
   * unconditionally — the failure mode that turns a guard into decoration.
   */
  describe('falsifiability controls', () => {
    /**
     * The omitted leg is `planContradiction` because that was claim_next's real
     * pre-fix shape — a surface attaching every leg but one.
     *
     * ⚠ DERIVED from the registry, deliberately, rather than a hand-written list of
     * imports. This fixture is a description of CLAIM_TIME_ENRICHMENT_LEGS, and a
     * hand-maintained second copy of a registry drifts from it: the literal version
     * of this fixture failed the moment a seventh leg was registered, reporting the
     * new leg as "missing" from a control whose only intended omission was
     * planContradiction. Building it from the registry keeps the control asserting
     * the one thing it is for — that `attachesLeg` returns false for a leg a surface
     * does not attach — without needing an edit every time the leg set grows.
     */
    const OMITTED_LEG: ClaimTimeEnrichmentLeg = 'planContradiction';
    const SURFACE_MISSING_ONE_LEG = CLAIM_TIME_ENRICHMENT_LEGS.filter((leg) => leg !== OMITTED_LEG)
      .map((leg) => `import { ${LEG_IMPLEMENTATION[leg]} } from './${leg}-port';`)
      .join('\n');

    it('rejects a surface that omits a leg', () => {
      const missing = CLAIM_TIME_ENRICHMENT_LEGS.filter((leg) => !attachesLeg(SURFACE_MISSING_ONE_LEG, leg));
      expect(missing).toEqual([OMITTED_LEG]);
    });

    it('accepts a surface that delegates the whole set to the port', () => {
      const delegating = `import { ${DELEGATES_TO_PORT} } from './claim-time-enrichment';`;
      const missing = CLAIM_TIME_ENRICHMENT_LEGS.filter((leg) => !attachesLeg(delegating, leg));
      expect(missing).toEqual([]);
    });

    it('rejects a surface that attaches nothing', () => {
      const missing = CLAIM_TIME_ENRICHMENT_LEGS.filter((leg) => !attachesLeg('export default {};', leg));
      expect(missing).toEqual([...CLAIM_TIME_ENRICHMENT_LEGS]);
    });
  });
});
