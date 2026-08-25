/**
 * P-007: the design-evidence gate as `work_items:complete` consumes it.
 *
 * Everything that DECIDES lives in `design-compare/gate.ts` (one reference) and
 * `design-compare/feature-gate.ts` (a whole feature). This module is the
 * adapter: it answers the two questions those modules deliberately do not —
 * WHICH feature a work-item's design obligation belongs to, and what a failure
 * to establish the obligation should do.
 *
 * D-006 governs the second answer. The contract runs REPORT-ONLY until P-008's
 * calibration and P-009's verification are green; enforcement is a separate
 * flag that P-011 flips. So the default outcome of a failure here is a message
 * on a successful completion, not a refusal.
 */
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import {
  DesignGateUnavailableError,
  evaluateFeatureDesignGate,
  renderFeatureDesignGate,
  type FeatureDesignGateResult,
} from '../../design-compare/feature-gate';

/**
 * The identifiers under which a work-item's design references may have been
 * ratified, most specific first.
 *
 * `featureId` on a design artifact is a caller-supplied opaque string, and the
 * rows in this workspace use the PLAN/feature slug rather than the work-item id
 * — so resolving only the work-item id would find nothing and report every
 * item as unratified, which is a gate that never fires wearing the costume of a
 * gate that always passes. Both are checked, and an obligation found under
 * either binds: the point is that no CHOICE of convention silently exempts the
 * work.
 */
export function designFeatureCandidates(workItem: {
  readonly id?: string | null;
  readonly sourcePlanSlug?: string | null;
}): readonly string[] {
  const out: string[] = [];
  if (workItem.sourcePlanSlug) out.push(workItem.sourcePlanSlug);
  if (workItem.id) out.push(workItem.id);
  return [...new Set(out)];
}

export type DesignEvidenceGateOutcome =
  /** No ratified reference under any candidate feature — P-007 leaves exploration unrestricted. */
  | { readonly status: 'not-applicable' }
  | { readonly status: 'satisfied'; readonly report: string }
  /**
   * Ratified work is missing current passing evidence. `enforced` is what
   * separates a refusal from a notice, and it is read from the flag rather than
   * decided here so that D-006's rollout is one switch rather than a judgement
   * spread across call sites.
   */
  | {
      readonly status: 'unsatisfied';
      readonly enforced: boolean;
      readonly report: string;
      readonly featureId: string;
      readonly blockingReferenceIds: readonly string[];
    }
  /**
   * The obligation could not be established. Reported, never converted into a
   * pass: "we could not check" and "there was nothing to check" are different
   * facts and only one of them is good news.
   */
  | { readonly status: 'unavailable'; readonly enforced: boolean; readonly report: string };

export interface DesignEvidenceGateDeps {
  /**
   * Evaluate one candidate feature. Injected so the gate is testable without a
   * database, and so the completion path holds no opinion about storage.
   */
  readonly evaluate: (featureId: string) => Promise<FeatureDesignGateResult>;
  readonly isEnabled?: () => Promise<boolean>;
  readonly isEnforcing?: () => Promise<boolean>;
}

async function flagOrFalse(read: () => Promise<boolean>): Promise<boolean> {
  try {
    return await read();
  } catch {
    // A flag we cannot read is not an enforcement mandate. Failing closed on the
    // ENFORCING flag would block completions because of a flag-service blip,
    // which is a far worse outcome than a missed report during one.
    return false;
  }
}

/**
 * Evaluate the design-evidence obligation for a work-item being closed.
 *
 * Candidate features are tried in order and the FIRST applicable one decides.
 * A feature with no ratified reference contributes nothing rather than
 * short-circuiting to "not applicable" — otherwise a work-item whose plan slug
 * happens to carry no references would exempt itself from an obligation
 * genuinely recorded under its own id.
 */
export async function designEvidenceCompletionGate(
  candidates: readonly string[],
  deps: DesignEvidenceGateDeps,
): Promise<DesignEvidenceGateOutcome> {
  const enabled = await flagOrFalse(
    deps.isEnabled ?? (() => getFlag(FLAGS.DESIGN_EVIDENCE_GATE) as Promise<boolean>),
  );
  if (!enabled || candidates.length === 0) return { status: 'not-applicable' };

  const enforced = await flagOrFalse(
    deps.isEnforcing ?? (() => getFlag(FLAGS.DESIGN_EVIDENCE_GATE_ENFORCING) as Promise<boolean>),
  );

  for (const featureId of candidates) {
    let result: FeatureDesignGateResult;
    try {
      result = await deps.evaluate(featureId);
    } catch (error) {
      if (error instanceof DesignGateUnavailableError) {
        return {
          status: 'unavailable',
          enforced,
          report: `design-evidence gate could not establish an obligation for '${featureId}': ${error.message}`,
        };
      }
      throw error;
    }

    if (!result.applicable) continue;

    if (result.satisfied) {
      return { status: 'satisfied', report: renderFeatureDesignGate(result) ?? '' };
    }
    return {
      status: 'unsatisfied',
      enforced,
      featureId,
      blockingReferenceIds: result.blocking.map((b) => b.referenceId),
      report: renderFeatureDesignGate(result) ?? '',
    };
  }

  return { status: 'not-applicable' };
}

/**
 * The refusal text used when enforcement is on.
 *
 * Names the ratified reference and every unmet case (the feature renderer
 * already does), and states plainly that no completion record was written —
 * the same contract the other completion gates state, because an agent that
 * cannot tell whether its close partially landed will retry and make it worse.
 */
export function renderDesignEvidenceRefusal(
  id: string,
  outcome: Extract<DesignEvidenceGateOutcome, { status: 'unsatisfied' }>,
): string {
  return (
    `refusing terminal completion for '${id}': ${outcome.report}\n` +
    'No completion record or state transition was written. Produce the missing evidence with ' +
    'design-phase.compare_render and complete again, or retract the reference if the design no ' +
    'longer applies.'
  );
}
