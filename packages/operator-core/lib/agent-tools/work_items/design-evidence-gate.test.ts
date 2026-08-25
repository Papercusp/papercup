/**
 * P-007 — the design-evidence gate as the completion path consumes it.
 *
 * Plan: ratified-mockup-implementation-validation-2026-08-24.
 *
 * The behaviour under test is mostly POLICY: when does the obligation apply,
 * when does it refuse rather than report (D-006), and what happens when it
 * cannot be established. The deciding logic has its own suites in
 * design-compare/{gate,feature-gate}.test.ts and is not re-tested here.
 */
import { describe, expect, it } from 'vitest';
import {
  DesignGateUnavailableError,
  type FeatureDesignGateResult,
  type FeatureGateReference,
} from '../../design-compare/feature-gate';
import {
  designEvidenceCompletionGate,
  designFeatureCandidates,
  renderDesignEvidenceRefusal,
} from './design-evidence-gate';

/**
 * P-011/D-023: a reference whose ratification host matches the calibration
 * host, so its verdict is allowed to refuse rather than only report.
 */
const ENFORCEABLE = { enforceable: true, renderHost: 'chromium/141;probe@72px[…]' } as const;

/** The same verdict on a reference the shipped threshold was never measured for. */
const NOT_ENFORCEABLE = {
  enforceable: false,
  reason: 'reference-host-unknown',
  detail: 'no rendering host recorded',
} as const;

const NOT_APPLICABLE: FeatureDesignGateResult = { applicable: false, references: [] };

const SATISFIED: FeatureDesignGateResult = {
  applicable: true,
  satisfied: true,
  references: [
    {
      referenceId: 'ref-a',
      verdict: {
        applicable: true,
        satisfied: true,
        referenceId: 'ref-a',
        activeRevision: 1,
        cases: [],
        doesNotEstablish: ['accessibility'],
      },
      enforceability: ENFORCEABLE,
    },
  ],
  blocking: [],
  enforceableBlocking: [],
  doesNotEstablish: ['accessibility'],
};

/**
 * One failing reference, built once.
 *
 * It was previously spelled out twice — identically — under `references` and
 * `blocking`. Two copies of the fixture that decides whether this gate refuses
 * is exactly the shape that drifts, and a divergence between them would look
 * like a behaviour change rather than a typo.
 */
function failingReference(enforceability: FeatureGateReference['enforceability']) {
  return {
    referenceId: 'ref-a',
    verdict: {
      applicable: true,
      satisfied: false,
      referenceId: 'ref-a',
      activeRevision: 2,
      failures: [
        {
          caseId: 'desktop',
          kind: 'missing',
          reason: 'no-evidence',
          environment: {
            viewport: { width: 1280, height: 800 },
            deviceScaleFactor: 2,
            browser: 'chromium',
            theme: 'dark',
            fontSet: 'x',
          },
          rationale: 'primary',
          remedy: 'run design-phase.compare_render',
        },
      ],
      satisfiedCases: [],
      doesNotEstablish: ['accessibility'],
    },
    enforceability,
  } satisfies FeatureGateReference;
}

const UNSATISFIED: FeatureDesignGateResult = {
  applicable: true,
  satisfied: false,
  references: [failingReference(ENFORCEABLE)],
  blocking: [failingReference(ENFORCEABLE)],
  enforceableBlocking: [failingReference(ENFORCEABLE)],
  doesNotEstablish: ['accessibility'],
};

/**
 * The same failure on a reference the shipped threshold was never measured for
 * (P-011/D-023). `blocking` is non-empty and `enforceableBlocking` is not, which
 * is the whole distinction: the work genuinely owes evidence, and refusing on a
 * tolerance of ~34 pixels that was never measured against this machine's fonts
 * would fail correct work — the harm D-021 recorded.
 */
const UNSATISFIED_UNENFORCEABLE: FeatureDesignGateResult = {
  applicable: true,
  satisfied: false,
  references: [failingReference(NOT_ENFORCEABLE)],
  blocking: [failingReference(NOT_ENFORCEABLE)],
  enforceableBlocking: [],
  doesNotEstablish: ['accessibility'],
};

const on = async () => true;
const off = async () => false;

describe('designFeatureCandidates', () => {
  /**
   * The design-artifact rows in this workspace key `feature_id` by PLAN SLUG,
   * not by work-item id. Resolving only the id would find nothing and report
   * every item unratified — a gate that never fires, which is indistinguishable
   * from a gate that always passes.
   */
  it('checks the plan slug as well as the work-item id', () => {
    expect(designFeatureCandidates({ id: 'WI-1', sourcePlanSlug: 'my-plan' })).toEqual([
      'my-plan',
      'WI-1',
    ]);
  });

  it('de-duplicates and tolerates a missing plan slug', () => {
    expect(designFeatureCandidates({ id: 'WI-1', sourcePlanSlug: null })).toEqual(['WI-1']);
    expect(designFeatureCandidates({ id: 'x', sourcePlanSlug: 'x' })).toEqual(['x']);
  });
});

describe('applicability', () => {
  it('is inert when the gate flag is off', async () => {
    const outcome = await designEvidenceCompletionGate(['f'], {
      evaluate: async () => {
        throw new Error('the gate was consulted while disabled');
      },
      isEnabled: off,
      isEnforcing: off,
    });
    expect(outcome.status).toBe('not-applicable');
  });

  it('reports not-applicable when no candidate feature has a ratified reference', async () => {
    const outcome = await designEvidenceCompletionGate(['plan', 'WI-1'], {
      evaluate: async () => NOT_APPLICABLE,
      isEnabled: on,
      isEnforcing: off,
    });
    expect(outcome.status).toBe('not-applicable');
  });

  /**
   * The candidate loop must not stop at the first feature that has nothing.
   * A work-item whose plan slug carries no references would otherwise exempt
   * itself from an obligation genuinely recorded under its own id.
   */
  it('keeps looking when the first candidate has no references', async () => {
    const seen: string[] = [];
    const outcome = await designEvidenceCompletionGate(['plan', 'WI-1'], {
      evaluate: async (featureId) => {
        seen.push(featureId);
        return featureId === 'WI-1' ? UNSATISFIED : NOT_APPLICABLE;
      },
      isEnabled: on,
      isEnforcing: off,
    });
    expect(seen).toEqual(['plan', 'WI-1']);
    expect(outcome.status).toBe('unsatisfied');
  });
});

describe('report-only rollout (D-006)', () => {
  it('does NOT enforce by default, and says so in the outcome', async () => {
    const outcome = await designEvidenceCompletionGate(['f'], {
      evaluate: async () => UNSATISFIED,
      isEnabled: on,
      isEnforcing: off,
    });
    expect(outcome.status).toBe('unsatisfied');
    if (outcome.status !== 'unsatisfied') return;
    expect(outcome.enforced).toBe(false);
    expect(outcome.blockingReferenceIds).toEqual(['ref-a']);
  });

  /**
   * CALIBRATION for the case above. Without it, a gate hardwired to
   * `enforced: false` would satisfy every assertion in this file about
   * report-only behaviour while being incapable of ever enforcing.
   */
  /**
   * P-011/D-023. The flag says enforcement is ON; it does not say the threshold
   * was measured for the machine involved. Both must hold, and the calibration
   * immediately below proves this suite can still observe a real enforcement —
   * without it, a gate hardwired to `enforced: false` would satisfy this test.
   */
  it('does NOT enforce a failing reference the threshold was never measured for', async () => {
    const outcome = await designEvidenceCompletionGate(['f'], {
      evaluate: async () => UNSATISFIED_UNENFORCEABLE,
      isEnabled: on,
      isEnforcing: on,
    });
    expect(outcome.status).toBe('unsatisfied');
    if (outcome.status !== 'unsatisfied') return;
    expect(outcome.enforced).toBe(false);
    // Still REPORTED as blocking: the work owes evidence either way, and
    // dropping it from the report would turn "we could not enforce" into
    // "there was nothing wrong".
    expect(outcome.blockingReferenceIds).toEqual(['ref-a']);
  });

  it('DOES enforce once the enforcement flag is on', async () => {
    const outcome = await designEvidenceCompletionGate(['f'], {
      evaluate: async () => UNSATISFIED,
      isEnabled: on,
      isEnforcing: on,
    });
    expect(outcome.status === 'unsatisfied' && outcome.enforced).toBe(true);
  });

  it('a satisfied obligation reports rather than staying silent', async () => {
    const outcome = await designEvidenceCompletionGate(['f'], {
      evaluate: async () => SATISFIED,
      isEnabled: on,
      isEnforcing: on,
    });
    expect(outcome.status).toBe('satisfied');
    if (outcome.status !== 'satisfied') return;
    expect(outcome.report).toContain('does NOT establish');
  });
});

describe('unavailability', () => {
  it('reports unavailable rather than passing when the obligation cannot be established', async () => {
    const outcome = await designEvidenceCompletionGate(['f'], {
      evaluate: async () => {
        throw new DesignGateUnavailableError('connection reset');
      },
      isEnabled: on,
      isEnforcing: off,
    });
    expect(outcome.status).toBe('unavailable');
    if (outcome.status !== 'unavailable') return;
    expect(outcome.report).toContain('connection reset');
  });

  it('lets an unexpected error propagate rather than swallowing it as a pass', async () => {
    await expect(
      designEvidenceCompletionGate(['f'], {
        evaluate: async () => {
          throw new TypeError('programming error');
        },
        isEnabled: on,
        isEnforcing: off,
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  /**
   * A flag read that throws must not become an enforcement mandate: blocking
   * completions because the flag service blipped is a worse failure than
   * missing one report.
   */
  it('treats an unreadable enforcement flag as not-enforcing', async () => {
    const outcome = await designEvidenceCompletionGate(['f'], {
      evaluate: async () => UNSATISFIED,
      isEnabled: on,
      isEnforcing: async () => {
        throw new Error('flag service down');
      },
    });
    expect(outcome.status === 'unsatisfied' && outcome.enforced).toBe(false);
  });
});

describe('refusal rendering', () => {
  it('states that nothing was written, so a retry cannot make it worse', async () => {
    const outcome = await designEvidenceCompletionGate(['f'], {
      evaluate: async () => UNSATISFIED,
      isEnabled: on,
      isEnforcing: on,
    });
    if (outcome.status !== 'unsatisfied') throw new Error('expected unsatisfied');
    const text = renderDesignEvidenceRefusal('WI-9', outcome);
    expect(text).toContain('WI-9');
    expect(text).toContain('No completion record or state transition was written');
    expect(text).toContain('compare_render');
  });
});
