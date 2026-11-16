import { describe, expect, it } from 'vitest';
import { RISK_TIERS } from '@papercusp/plan-parser';
import { parseItemTypeDefinition } from './definitions';
import {
  droppedScrutinyChecks, mergeScrutinyPolicies, scrutinyChecks, scrutinyPolicyFor,
} from './scrutiny';

describe('revisioned risk scrutiny contracts', () => {
  it('retains the strict review workflow when a legacy definition has no contract', () => {
    expect(scrutinyChecks()).toEqual(['rubric-vetting', 'blind-review', 'independent-grading', 'spec-test-adequacy']);
  });

  it('separates automatic trivial validation, combined review and specialist/dual review', () => {
    expect(scrutinyChecks(scrutinyPolicyFor('trivial'))).toEqual([]);
    expect(scrutinyChecks(scrutinyPolicyFor('low'))).toEqual([
      'independent-grading', 'spec-test-adequacy', 'focused-regression',
    ]);
    expect(scrutinyChecks(scrutinyPolicyFor('moderate'))).toContain('integration-evidence');
    expect(scrutinyChecks(scrutinyPolicyFor('high'))).toContain('specialist-review');
    expect(scrutinyChecks(scrutinyPolicyFor('critical'))).toEqual(expect.arrayContaining([
      'specialist-review', 'dual-review', 'recovery-evidence', 'rollout-evidence',
    ]));
  });

  it.each(RISK_TIERS)('stores the full %s contract in the definition rather than a mutable preset reference', tier => {
    const scrutiny = scrutinyPolicyFor(tier);
    const definition = parseItemTypeDefinition({
      schemaVersion: 1, id: `acme/code-${tier}`, revision: 1, title: tier,
      modules: ['generic-core', 'code'], scrutiny,
    });
    expect(definition.ok).toBe(true);
    if (definition.ok) expect(definition.definition.scrutiny).toEqual(scrutiny);
    scrutiny.review = 'dual';
    expect(scrutinyPolicyFor(tier).review).toBe(tier === 'critical' ? 'dual' : tier === 'high' ? 'specialist' : tier === 'trivial' ? 'automated' : 'combined');
  });

  it('refuses a high-risk type that declares automated review or omits recovery/rollout evidence', () => {
    const parsed = parseItemTypeDefinition({
      schemaVersion: 1, id: 'acme/unsafe', revision: 1, title: 'unsafe',
      modules: ['generic-core', 'code'],
      scrutiny: { ...scrutinyPolicyFor('high'), review: 'automated', failureEvidence: false, rolloutEvidence: false },
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues.join(' ')).toMatch(/review.*specialist/);
  });

  it('detects weaker review despite an unchanged generic-core/code module set', () => {
    expect(droppedScrutinyChecks(scrutinyPolicyFor('high'), scrutinyPolicyFor('low'))).toEqual(expect.arrayContaining([
      'specialist-review', 'adversarial-evidence', 'failure-evidence', 'rollout-evidence',
    ]));
    expect(droppedScrutinyChecks(undefined, scrutinyPolicyFor('low'))).toEqual(['rubric-vetting', 'blind-review']);
    expect(droppedScrutinyChecks(scrutinyPolicyFor('high'), scrutinyPolicyFor('critical'))).toEqual([]);
  });

  it('keeps the stricter parent review/evidence obligations when a child requests a lower tier', () => {
    const parent = scrutinyPolicyFor('critical');
    expect(mergeScrutinyPolicies(scrutinyPolicyFor('low'), parent)).toEqual(parent);
  });
});
