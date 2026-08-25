/**
 * Mockup-to-implementation validation: the ratification lifecycle.
 *
 * Plan: ratified-mockup-implementation-validation-2026-08-24 (P-001).
 *
 * D-001 is the whole point of this module: exploration is unconstrained, and
 * enforcement begins ONLY at an explicit ratification transition. Nothing here
 * may reach backward into the exploratory phase — an exploring image has no
 * state in this machine at all, which is why `exploring` is modelled as the
 * absence of a ratification record rather than as a state we track.
 */

import type { CaptureEnvironment, ReferenceClass, ReferenceIdentity } from './contract';

/**
 * The lifecycle of a ratified reference. `exploring` is deliberately NOT here:
 * a proposal that has never been ratified is not in this machine.
 */
export const RATIFICATION_STATES = [
  /** Ratified and in force. Exactly one revision of a reference may be active. */
  'active',
  /** Replaced by a newer revision. Its evidence can no longer satisfy a gate. */
  'superseded',
  /** Withdrawn without a replacement. The surface is unratified again. */
  'retracted',
] as const;
export type RatificationState = (typeof RATIFICATION_STATES)[number];

/** Where the reference image came from, recorded immutably at ratification. */
export interface ReferenceProvenance {
  /** 'upload' | 'artifact-capture' | 'figma-export' | 'derived-from'. */
  readonly source: string;
  /** Original filename, artifact URL, Figma node id, or source reference id. */
  readonly sourceRef: string;
  /** Who ratified it. */
  readonly ratifiedBy: string;
  readonly ratifiedAt: string;
  /**
   * For a 'derived-reference' (D-007): the incommensurable reference this was
   * derived from, so the audit trail back to the original mockup survives.
   */
  readonly derivedFrom?: string;
}

/**
 * One required comparison case: a viewport/state pair that must independently
 * pass. Requirement 9 — a passing case never covers a different one.
 */
export interface RequiredCase {
  readonly caseId: string;
  readonly environment: CaptureEnvironment;
  /** Why this case is required (e.g. 'mobile breakpoint', 'error state'). */
  readonly rationale: string;
}

export interface RatifiedReference {
  readonly identity: ReferenceIdentity;
  readonly state: RatificationState;
  readonly provenance: ReferenceProvenance;
  /** The environment the reference image itself is contracted at. */
  readonly referenceEnvironment: CaptureEnvironment;
  /** Every case that must pass before dependent work may complete. */
  readonly requiredCases: readonly RequiredCase[];
  /** Set when state is 'superseded' — the revision that replaced this one. */
  readonly supersededByRevision?: number;
}

export interface RatificationError {
  readonly code:
    | 'not-active'
    | 'no-required-cases'
    | 'duplicate-case'
    | 'revision-not-monotonic'
    | 'class-mismatch'
    | 'missing-derivation';
  readonly message: string;
}

/**
 * Validate a proposed ratification before it is persisted.
 *
 * Returns every problem rather than the first, so a caller fixing a submission
 * is not led through them one round-trip at a time.
 */
export function validateRatification(
  candidate: RatifiedReference,
  previous?: RatifiedReference,
): readonly RatificationError[] {
  const errors: RatificationError[] = [];

  if (candidate.requiredCases.length === 0) {
    errors.push({
      code: 'no-required-cases',
      message:
        'a ratified reference must declare at least one required case; with none, the gate has nothing to verify and would pass vacuously',
    });
  }

  const seen = new Set<string>();
  for (const c of candidate.requiredCases) {
    if (seen.has(c.caseId)) {
      errors.push({
        code: 'duplicate-case',
        message: `required case id '${c.caseId}' is declared more than once`,
      });
    }
    seen.add(c.caseId);
  }

  if (previous) {
    if (candidate.identity.revision <= previous.identity.revision) {
      errors.push({
        code: 'revision-not-monotonic',
        message: `revision must increase: got ${candidate.identity.revision}, previous is ${previous.identity.revision}`,
      });
    }
    if (candidate.identity.referenceClass !== previous.identity.referenceClass) {
      errors.push({
        code: 'class-mismatch',
        message:
          `reference class cannot change across revisions of the same reference ` +
          `(${previous.identity.referenceClass} -> ${candidate.identity.referenceClass}); ` +
          'ratify a new reference instead',
      });
    }
  }

  if (
    candidate.identity.referenceClass === 'derived-reference' &&
    !candidate.provenance.derivedFrom
  ) {
    errors.push({
      code: 'missing-derivation',
      message:
        "a 'derived-reference' must record provenance.derivedFrom — the incommensurable reference it was derived from (D-007); without it the audit trail back to the original mockup is lost",
    });
  }

  return errors;
}

/**
 * Does revising a reference invalidate evidence bound to the old revision?
 *
 * Requirement 2 says yes, unconditionally. This function exists so that rule is
 * stated in one place and tested, rather than being re-derived at each call site
 * where someone might decide a "small" change should not invalidate.
 */
export function revisionInvalidatesEvidence(
  evidenceRevision: number,
  currentRevision: number,
): boolean {
  return evidenceRevision !== currentRevision;
}

/** Apply a revision: the old reference is superseded, the new one is active. */
export function superseded(
  previous: RatifiedReference,
  byRevision: number,
): RatifiedReference {
  return { ...previous, state: 'superseded', supersededByRevision: byRevision };
}

/**
 * Is this reference class eligible to carry a deterministic gate by default?
 *
 * This is only the STARTING position; calibration (P-002/P-008) records the
 * measured answer in the versioned policy, which is what actually governs.
 * D-007's reasoning: a model-painted raster is not commensurable with a real
 * render, so it starts advisory-only and must earn a gate, not lose one.
 */
export function defaultEligibilityFor(
  referenceClass: ReferenceClass,
): 'gateable' | 'advisory-only' {
  switch (referenceClass) {
    case 'artifact-capture':
    case 'figma-export':
    case 'derived-reference':
      return 'gateable';
    case 'raster-mockup':
      return 'advisory-only';
  }
}
