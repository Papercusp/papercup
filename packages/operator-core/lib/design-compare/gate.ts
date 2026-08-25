/**
 * P-007: the completion gate over ratified design evidence.
 *
 * This module is the DECIDING half and it is deliberately pure: it takes the
 * views `get_design_evidence` already returns and produces a verdict. No
 * storage, no clock, no flags. Everything that needs I/O lives in the adapter
 * (`agent-tools/work_items/design-evidence-gate.ts`), which is what makes the
 * rules below testable without a database and, more importantly, what makes
 * them testable at all — a rule that can only be exercised through a completion
 * call is a rule nobody writes a calibration case for.
 *
 * Three constraints from the plan shape every decision here:
 *
 *   D-004  Only deterministic engine evidence controls the verdict. Advisory
 *          prose is never read — see `advisory` never appearing below.
 *   P-007  Unratified exploration is unrestricted; ratified work must supply
 *          CURRENT PASSING evidence for EVERY required viewport/state, and a
 *          refusal must be actionable.
 *   P-007  Visual evidence SUPPLEMENTS responsive/interaction/functional/
 *          accessibility validation; it never replaces it. A pass from this
 *          gate must not be readable as "this work is validated".
 */
import type { CaptureEnvironment, CompareVerdict, InvalidReason } from './contract';
import { environmentsMatch } from './contract';
import type { CoverageView, EvidenceView, GetDesignEvidenceResult } from './verbs';

/**
 * The four conditions P-007 names, as a closed set.
 *
 * `missing` and `stale` are split because their REMEDIES differ and that is the
 * whole point of a refusal: "no comparison has been run for this case" is fixed
 * by running one, "your evidence is bound to revision 3 and the active revision
 * is 4" is fixed by re-running against the current reference. Collapsing them —
 * which is what `coverage[].evidenceArtifactId === null` does on its own —
 * produces a refusal that names the wrong action.
 */
export const DESIGN_GATE_FAILURE_KINDS = ['missing', 'stale', 'invalid', 'failing'] as const;
export type DesignGateFailureKind = (typeof DESIGN_GATE_FAILURE_KINDS)[number];

/**
 * Why a case is in the state it is in, at a finer grain than `kind`.
 *
 * Split from `kind` rather than widening it because P-007's refusal vocabulary
 * is exactly four words and this is the detail UNDER one of them. In particular
 * `unreadable-schema` is an `invalid`: a stored record this build cannot parse
 * is not evidence, and reporting it as anything softer is how a gate passes on
 * a record it never read.
 */
export type DesignGateFailureReason =
  | 'no-evidence'
  | 'superseded-revision'
  | 'unreadable-schema'
  | 'engine-invalid'
  | 'diff-exceeds-policy'
  | 'no-required-cases';

export interface DesignGateFailure {
  readonly caseId: string;
  readonly kind: DesignGateFailureKind;
  readonly reason: DesignGateFailureReason;
  readonly environment: CaptureEnvironment;
  /** Why the reference requires this case, carried through so a refusal explains itself. */
  readonly rationale: string;
  /** The stored record this failure is about, when one exists. */
  readonly evidenceArtifactId?: string;
  /** Deterministic detail from the engine. Never advisory prose (D-004). */
  readonly detail?: string;
  readonly invalidReason?: InvalidReason;
  /** The concrete next action. This is what makes the refusal actionable. */
  readonly remedy: string;
}

export interface DesignGateSatisfiedCase {
  readonly caseId: string;
  readonly environment: CaptureEnvironment;
  readonly evidenceArtifactId: string;
}

/**
 * What a PASS from this gate deliberately does NOT establish.
 *
 * Exported as data, and asserted by the tests, because P-007's "supplements
 * rather than replaces" is otherwise a sentence in a plan that no code carries.
 * Every satisfied verdict ships this list, so a caller rendering the result
 * cannot present a green design gate as a validated work item without also
 * rendering what it excluded.
 */
export const DESIGN_GATE_DOES_NOT_ESTABLISH: readonly string[] = [
  'responsive behavior beyond the exact viewports ratified as required cases',
  'interaction behavior (focus, keyboard, pointer, transitions)',
  'functional correctness of anything behind the rendered pixels',
  'accessibility (roles, names, contrast, focus order, assistive-tech behavior)',
];

export type DesignGateVerdict =
  | {
      readonly applicable: false;
      /**
       * `unratified` is the ordinary case and is NOT a deficiency: P-007 keeps
       * exploration unrestricted, so a surface nobody ratified imposes nothing.
       * `retracted` is called out separately because it is a state a surface
       * ENTERED deliberately, and an auditor reading "not applicable" deserves
       * to know which of the two they are looking at.
       */
      readonly reason: 'unratified' | 'retracted';
      readonly referenceId: string;
    }
  | {
      readonly applicable: true;
      readonly satisfied: true;
      readonly referenceId: string;
      readonly activeRevision: number;
      readonly cases: readonly DesignGateSatisfiedCase[];
      readonly doesNotEstablish: readonly string[];
    }
  | {
      readonly applicable: true;
      readonly satisfied: false;
      readonly referenceId: string;
      readonly activeRevision: number;
      readonly failures: readonly DesignGateFailure[];
      readonly satisfiedCases: readonly DesignGateSatisfiedCase[];
      readonly doesNotEstablish: readonly string[];
    };

function remedyFor(
  reason: DesignGateFailureReason,
  referenceId: string,
  activeRevision: number,
  caseId: string,
): string {
  switch (reason) {
    case 'no-evidence':
      return `run design-phase.compare_render for case '${caseId}' against ${referenceId} revision ${activeRevision}`;
    case 'superseded-revision':
      return `re-run design-phase.compare_render for case '${caseId}': the stored result is bound to an older revision of ${referenceId}, and revision ${activeRevision} is active`;
    case 'unreadable-schema':
      return `re-run design-phase.compare_render for case '${caseId}': the stored result was written under a compare-result schema this build cannot read, so it is not evidence`;
    case 'engine-invalid':
      return `resolve the invalid comparison for case '${caseId}' and re-run design-phase.compare_render — an invalid result is never a pass`;
    case 'diff-exceeds-policy':
      return `fix the implementation for case '${caseId}' until it matches ${referenceId} revision ${activeRevision} within the recorded policy, or ratify a new revision if the DESIGN changed`;
    case 'no-required-cases':
      return `re-ratify ${referenceId}: its active revision declares no required cases, so there is nothing for the gate to verify`;
  }
}

/**
 * Classify one required case that `coverage` reported as uncovered.
 *
 * `coverage` sets `evidenceArtifactId: null` for three genuinely different
 * situations — nothing was ever run, something was run against a superseded
 * revision, and something was run whose record this build cannot parse — because
 * its own job is only to answer "is there current evidence". Recovering the
 * distinction here, from the evidence list, is what lets the refusal name the
 * right action instead of telling everyone to "run a comparison" including the
 * people who already did.
 *
 * Preference order matters: an unreadable record outranks a superseded one,
 * because we cannot know which revision an unparseable record was bound to. We
 * report what we actually established, never the more convenient reading.
 */
function classifyUncovered(
  required: CoverageView,
  evidence: readonly EvidenceView[],
): {
  kind: DesignGateFailureKind;
  reason: DesignGateFailureReason;
  match?: EvidenceView;
} {
  const sameEnvironment = evidence.filter((e) =>
    environmentsMatch(e.deterministic.environment, required.environment),
  );
  const unreadable = sameEnvironment.find((e) => e.schemaVersionMismatch);
  if (unreadable) return { kind: 'invalid', reason: 'unreadable-schema', match: unreadable };

  // Not current, but readable: it was measured against a revision that is no
  // longer active. That is the stale case, and it is the one an agent is most
  // likely to believe is a pass — the record says `verdict: 'pass'` right on it.
  const superseded = sameEnvironment.find((e) => !e.current);
  if (superseded) return { kind: 'stale', reason: 'superseded-revision', match: superseded };

  return { kind: 'missing', reason: 'no-evidence' };
}

function failureFromVerdict(
  verdict: CompareVerdict,
): { kind: DesignGateFailureKind; reason: DesignGateFailureReason } | undefined {
  if (verdict === 'pass') return undefined;
  if (verdict === 'invalid') return { kind: 'invalid', reason: 'engine-invalid' };
  return { kind: 'failing', reason: 'diff-exceeds-policy' };
}

/**
 * Evaluate the design-evidence obligation for ONE ratified reference.
 *
 * Fails closed everywhere it is uncertain. The two places that matters:
 * an active revision declaring zero required cases is a REFUSAL rather than a
 * vacuous pass (ratification already forbids it, so reaching that state means
 * something upstream is wrong and a green light would hide it), and evidence
 * this build cannot parse is invalid rather than ignored.
 */
export function evaluateDesignGate(view: GetDesignEvidenceResult): DesignGateVerdict {
  const active = view.reference;

  if (!active) {
    // No ACTIVE revision. Distinguish "never ratified" from "ratified and then
    // retracted" using the revision history, which is exactly what it is for.
    const everRatified = view.revisions.length > 0;
    return {
      applicable: false,
      reason: everRatified ? 'retracted' : 'unratified',
      referenceId: '',
    };
  }

  const referenceId = active.referenceId;
  const activeRevision = active.activeRevision;

  if (view.coverage.length === 0) {
    return {
      applicable: true,
      satisfied: false,
      referenceId,
      activeRevision,
      satisfiedCases: [],
      doesNotEstablish: DESIGN_GATE_DOES_NOT_ESTABLISH,
      failures: [
        {
          caseId: '(none declared)',
          kind: 'invalid',
          reason: 'no-required-cases',
          environment: active.referenceEnvironment,
          rationale:
            'an active ratified reference must declare at least one required case; this one declares none',
          remedy: remedyFor('no-required-cases', referenceId, activeRevision, '(none declared)'),
        },
      ],
    };
  }

  const failures: DesignGateFailure[] = [];
  const satisfiedCases: DesignGateSatisfiedCase[] = [];

  for (const required of view.coverage) {
    if (required.evidenceArtifactId === null) {
      const { kind, reason, match } = classifyUncovered(required, view.evidence);
      failures.push({
        caseId: required.caseId,
        kind,
        reason,
        environment: required.environment,
        rationale: required.rationale,
        ...(match ? { evidenceArtifactId: match.artifactId } : {}),
        ...(match?.deterministic.detail ? { detail: match.deterministic.detail } : {}),
        remedy: remedyFor(reason, referenceId, activeRevision, required.caseId),
      });
      continue;
    }

    const outcome = failureFromVerdict(required.verdict ?? 'invalid');
    if (!outcome) {
      satisfiedCases.push({
        caseId: required.caseId,
        environment: required.environment,
        evidenceArtifactId: required.evidenceArtifactId,
      });
      continue;
    }

    const record = view.evidence.find((e) => e.artifactId === required.evidenceArtifactId);
    failures.push({
      caseId: required.caseId,
      kind: outcome.kind,
      reason: outcome.reason,
      environment: required.environment,
      rationale: required.rationale,
      evidenceArtifactId: required.evidenceArtifactId,
      ...(record?.deterministic.detail ? { detail: record.deterministic.detail } : {}),
      ...(record?.deterministic.invalidReason
        ? { invalidReason: record.deterministic.invalidReason }
        : {}),
      remedy: remedyFor(outcome.reason, referenceId, activeRevision, required.caseId),
    });
  }

  if (failures.length === 0) {
    return {
      applicable: true,
      satisfied: true,
      referenceId,
      activeRevision,
      cases: satisfiedCases,
      doesNotEstablish: DESIGN_GATE_DOES_NOT_ESTABLISH,
    };
  }

  return {
    applicable: true,
    satisfied: false,
    referenceId,
    activeRevision,
    failures,
    satisfiedCases,
    doesNotEstablish: DESIGN_GATE_DOES_NOT_ESTABLISH,
  };
}

/**
 * Render a refusal an agent can act on without a second lookup.
 *
 * Deliberately names every failing case rather than the first: an agent told
 * about one missing viewport fixes it, re-runs, and is refused again for the
 * next. The whole obligation in one message is the difference between one
 * remediation cycle and four.
 */
export function renderDesignGateRefusal(
  verdict: Extract<DesignGateVerdict, { applicable: true; satisfied: false }>,
): string {
  const lines = verdict.failures.map((f) => {
    const v = f.environment.viewport;
    const where = `${v.width}x${v.height}@${f.environment.deviceScaleFactor}x ${f.environment.theme}${
      f.environment.state ? ` [${f.environment.state}]` : ''
    }`;
    const detail = f.detail ? ` — ${f.detail}` : '';
    const invalid = f.invalidReason ? ` (${f.invalidReason})` : '';
    return `  • ${f.caseId} [${f.kind}${invalid}] ${where}: ${f.rationale}${detail}\n    → ${f.remedy}`;
  });
  const covered =
    verdict.satisfiedCases.length > 0
      ? `\n${verdict.satisfiedCases.length} required case(s) already have current passing evidence.`
      : '';
  return (
    `ratified design reference '${verdict.referenceId}' (revision ${verdict.activeRevision}) ` +
    `requires current passing evidence for every required case; ${verdict.failures.length} do not have it:\n` +
    lines.join('\n') +
    covered
  );
}

/**
 * Render the report-only form (D-006), for the rollout in which the gate
 * measures without blocking.
 *
 * A separate renderer rather than a flag on the one above, because these say
 * genuinely different things: one is a refusal, the other is a notice that a
 * refusal WOULD have happened. Sharing a renderer is how a report starts
 * reading like a block.
 */
export function renderDesignGateReport(verdict: DesignGateVerdict): string | undefined {
  if (!verdict.applicable) return undefined;
  if (verdict.satisfied) {
    return (
      `design evidence: ${verdict.cases.length} required case(s) current and passing against ` +
      `'${verdict.referenceId}' revision ${verdict.activeRevision}. ` +
      `This does NOT establish: ${DESIGN_GATE_DOES_NOT_ESTABLISH.join('; ')}.`
    );
  }
  return `design evidence (REPORT ONLY — not blocking this completion): ${renderDesignGateRefusal(verdict)}`;
}
