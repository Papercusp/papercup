/**
 * Revisioned scrutiny contracts carried by the existing item-type registry.
 * The contract is data (and therefore part of the type's content hash), not a
 * mutable global preset. Missing contracts retain the legacy review workflow.
 */
import { RISK_TIERS, type RiskTier } from '@papercusp/plan-parser';

export const SCRUTINY_REVIEW_MODES = ['automated', 'combined', 'specialist', 'dual'] as const;
export const SCRUTINY_TEST_SCOPES = ['automated', 'focused', 'integration', 'adversarial', 'recovery'] as const;

export interface ScrutinyPolicy {
  riskTier: RiskTier;
  review: (typeof SCRUTINY_REVIEW_MODES)[number];
  tests: (typeof SCRUTINY_TEST_SCOPES)[number];
  failureEvidence: boolean;
  rolloutEvidence: boolean;
}

/** Checks whose applicability varies; correctness and authority remain separate floors. */
export const SCRUTINY_CHECKS = [
  'rubric-vetting', 'blind-review', 'independent-grading', 'specialist-review', 'dual-review',
  'spec-test-adequacy', 'focused-regression', 'integration-evidence', 'adversarial-evidence',
  'recovery-evidence', 'failure-evidence', 'rollout-evidence',
] as const;
export type ScrutinyCheck = (typeof SCRUTINY_CHECKS)[number];

const PRESETS: Readonly<Record<RiskTier, Readonly<ScrutinyPolicy>>> = {
  trivial: { riskTier: 'trivial', review: 'automated', tests: 'automated', failureEvidence: false, rolloutEvidence: false },
  low: { riskTier: 'low', review: 'combined', tests: 'focused', failureEvidence: false, rolloutEvidence: false },
  moderate: { riskTier: 'moderate', review: 'combined', tests: 'integration', failureEvidence: true, rolloutEvidence: false },
  high: { riskTier: 'high', review: 'specialist', tests: 'adversarial', failureEvidence: true, rolloutEvidence: true },
  critical: { riskTier: 'critical', review: 'dual', tests: 'recovery', failureEvidence: true, rolloutEvidence: true },
};

/** Copy the preset into a definition so its revision pins the entire contract. */
export function scrutinyPolicyFor(tier: RiskTier): ScrutinyPolicy {
  return { ...PRESETS[tier] };
}

export function scrutinyPolicyIssues(policy: ScrutinyPolicy): string[] {
  const floor = PRESETS[policy.riskTier];
  const issues: string[] = [];
  if (SCRUTINY_REVIEW_MODES.indexOf(policy.review) < SCRUTINY_REVIEW_MODES.indexOf(floor.review)) {
    issues.push(`review must be at least ${floor.review} for ${policy.riskTier} risk`);
  }
  if (SCRUTINY_TEST_SCOPES.indexOf(policy.tests) < SCRUTINY_TEST_SCOPES.indexOf(floor.tests)) {
    issues.push(`tests must be at least ${floor.tests} for ${policy.riskTier} risk`);
  }
  if (floor.failureEvidence && !policy.failureEvidence) issues.push('failureEvidence is required at this risk tier');
  if (floor.rolloutEvidence && !policy.rolloutEvidence) issues.push('rolloutEvidence is required at this risk tier');
  return issues;
}

/** Inheritance cannot subtract an explicitly declared parent's obligations. */
export function mergeScrutinyPolicies(child: ScrutinyPolicy, parent: ScrutinyPolicy): ScrutinyPolicy {
  return {
    riskTier: RISK_TIERS[Math.max(RISK_TIERS.indexOf(child.riskTier), RISK_TIERS.indexOf(parent.riskTier))]!,
    review: SCRUTINY_REVIEW_MODES[Math.max(SCRUTINY_REVIEW_MODES.indexOf(child.review), SCRUTINY_REVIEW_MODES.indexOf(parent.review))]!,
    tests: SCRUTINY_TEST_SCOPES[Math.max(SCRUTINY_TEST_SCOPES.indexOf(child.tests), SCRUTINY_TEST_SCOPES.indexOf(parent.tests))]!,
    failureEvidence: child.failureEvidence || parent.failureEvidence,
    rolloutEvidence: child.rolloutEvidence || parent.rolloutEvidence,
  };
}

/** Undefined means the pre-existing, strict generic-core/code workflow. */
export function scrutinyChecks(policy?: ScrutinyPolicy): readonly ScrutinyCheck[] {
  if (!policy) return ['rubric-vetting', 'blind-review', 'independent-grading', 'spec-test-adequacy'];
  const checks = new Set<ScrutinyCheck>();
  const review = SCRUTINY_REVIEW_MODES.indexOf(policy.review);
  const tests = SCRUTINY_TEST_SCOPES.indexOf(policy.tests);
  if (review >= 1) checks.add('independent-grading');
  if (review >= 2) checks.add('specialist-review');
  if (review >= 3) checks.add('dual-review');
  if (tests >= 1) {
    checks.add('spec-test-adequacy');
    checks.add('focused-regression');
  }
  if (tests >= 2) checks.add('integration-evidence');
  if (tests >= 3) checks.add('adversarial-evidence');
  if (tests >= 4) checks.add('recovery-evidence');
  if (policy.failureEvidence) checks.add('failure-evidence');
  if (policy.rolloutEvidence) checks.add('rollout-evidence');
  return SCRUTINY_CHECKS.filter(check => checks.has(check));
}

/** Same-module changes can still remove review or evidence obligations. */
export function droppedScrutinyChecks(before?: ScrutinyPolicy, after?: ScrutinyPolicy): ScrutinyCheck[] {
  const kept = new Set(scrutinyChecks(after));
  return scrutinyChecks(before).filter(check => !kept.has(check));
}
