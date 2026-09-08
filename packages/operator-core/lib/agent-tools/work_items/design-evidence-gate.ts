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
import { z } from 'zod';
import { activeWorkspaceId } from '../../workspace-registry';
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
  /** Persist on the work item's existing payload when an approved design is a deliverable. */
  readonly requiredReferences?: unknown;
}

const requiredReferencesSchema = z
  .array(
    z
      .object({
        featureId: z.string().trim().min(1),
        referenceId: z.string().trim().min(1),
      })
      .strict(),
  )
  .max(32);

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
 * Every candidate contributes its obligations. A passing plan reference or an
 * advisory comparison must not hide a failing item reference. Explicit reference
 * requirements also prevent a missing ratification from becoming "not applicable".
 */
export async function designEvidenceCompletionGate(
  candidates: readonly string[],
  deps: DesignEvidenceGateDeps,
): Promise<DesignEvidenceGateOutcome> {
  const enabled = await flagOrFalse(
    deps.isEnabled ?? (() => getFlag(FLAGS.DESIGN_EVIDENCE_GATE, activeWorkspaceId()) as Promise<boolean>),
  );
  if (!enabled) return { status: 'not-applicable' };

  const enforced = await flagOrFalse(
    deps.isEnforcing ?? (() => getFlag(FLAGS.DESIGN_EVIDENCE_GATE_ENFORCING, activeWorkspaceId()) as Promise<boolean>),
  );

  const declared = requiredReferencesSchema.safeParse(deps.requiredReferences ?? []);
  if (!declared.success) {
    return {
      status: 'unavailable',
      enforced,
      report:
        'design-evidence gate: payload.designReferences must be an array of { featureId, referenceId } obligations; no design check was skipped.',
    };
  }
  const featureIds = [...new Set([...candidates, ...declared.data.map((ref) => ref.featureId)])];
  const reports: string[] = [];
  const failures: Array<{ featureId: string; referenceIds: string[]; enforced: boolean }> = [];
  const unavailable: string[] = [];
  for (const featureId of featureIds) {
    try {
      const result = await deps.evaluate(featureId);
      const missing = declared.data.filter(
        (ref) =>
          ref.featureId === featureId &&
          !result.references.some(
            (reference) => reference.referenceId === ref.referenceId && reference.verdict.applicable,
          ),
      );
      if (missing.length) {
        const referenceIds = missing.map((ref) => ref.referenceId);
        failures.push({ featureId, referenceIds, enforced });
        reports.push(
          `design '${featureId}': required reference(s) ${referenceIds.join(', ')} are not actively ratified. Register the approved image with design-phase.ratify_reference; absence is not a waiver.`,
        );
      }
      if (!result.applicable) continue;
      reports.push(`design '${featureId}': ${renderFeatureDesignGate(result) ?? ''}`);
      if (result.satisfied) {
        continue;
      }
      // P-011/D-023: the flag says enforcement is ON; it does not say this
      // particular comparison was measured on a machine the threshold speaks for.
      // Both must hold. `enforceableBlocking` is the subset of failing references
      // whose ratification host matches the calibration host — for anything else,
      // the derived tolerance (about 34 pixels of a 1280x800 render) was never
      // measured against that machine's fonts, and refusing on it would fail
      // correct work, which is precisely what D-021 forbade.
      //
      // The refusal is driven by that subset rather than by `blocking` so an
      // unenforceable reference can never suppress a calibrated failure beside it.
      failures.push({
        enforced: enforced && result.enforceableBlocking.length > 0,
        featureId,
        referenceIds: result.blocking.map((b) => b.referenceId),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof DesignGateUnavailableError) {
        unavailable.push(`design-evidence gate could not establish an obligation for '${featureId}': ${message}`);
        continue;
      }
      // Keep D-006's rollout contract and the enforcement flip on one policy
      // value. The completion caller must not guess here: this adapter has
      // already read the real flag, so an unexpected evaluator/renderer fault
      // reports while rollout is report-only and refuses once enforcement is on.
      unavailable.push(`design-evidence gate failed unexpectedly for '${featureId}': ${message}`);
    }
  }
  const report = [...reports, ...unavailable].join('\n\n');
  // A known enforced failure remains a failure even if another lookup is unavailable.
  if (failures.some((failure) => failure.enforced) || (failures.length && !unavailable.length)) {
    return {
      status: 'unsatisfied',
      enforced: failures.some((failure) => failure.enforced),
      featureId: failures[0].featureId,
      blockingReferenceIds: [...new Set(failures.flatMap((failure) => failure.referenceIds))],
      report,
    };
  }
  if (unavailable.length) return { status: 'unavailable', enforced, report };
  if (reports.length) return { status: 'satisfied', report };
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
