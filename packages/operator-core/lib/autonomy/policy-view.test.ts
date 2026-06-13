import { describe, expect, it } from 'vitest';
import { defaultPolicyFor, type AutonomyCategoryPolicy } from './policy';
import { decoratePolicyForView } from './policy-view';

function policy(over: Partial<AutonomyCategoryPolicy> & Pick<AutonomyCategoryPolicy, 'category'>): AutonomyCategoryPolicy {
  return { ...defaultPolicyFor(over.category), ...over };
}

describe('decoratePolicyForView', () => {
  it('merges display metadata for a known unprotected category', () => {
    const v = decoratePolicyForView(policy({ category: 'inbox-triage' }));
    expect(v.label).toBe('Inbox triage');
    expect(v.protected).toBe(false);
    expect(v.suggestedPosture).toBe('early-autonomy');
    expect(v.covers).toMatch(/inbox/i);
  });

  it('marks a protected category protected', () => {
    const v = decoratePolicyForView(policy({ category: 'release-deploy' }));
    expect(v.protected).toBe(true);
    expect(v.label).toBe('Release & deploy');
  });

  it('derives effective = never-auto when locked regardless of ceiling', () => {
    const v = decoratePolicyForView(
      policy({ category: 'implementation', ceiling: 'high', graduatedLevel: 'high', locked: true }),
    );
    expect(v.effectiveCeiling).toBe('never-auto');
  });

  it('derives effective = never-auto when a ceiling is set but nothing has graduated', () => {
    // The D-005 case the UI must explain: owner set a ceiling, but effective stays
    // none until the graduated level rises within it.
    const v = decoratePolicyForView(
      policy({ category: 'implementation', ceiling: 'low', graduatedLevel: 'never-auto' }),
    );
    expect(v.ceiling).toBe('low');
    expect(v.graduatedLevel).toBe('never-auto');
    expect(v.effectiveCeiling).toBe('never-auto');
  });

  it('derives effective = min(ceiling, graduated) when both rise', () => {
    const v = decoratePolicyForView(
      policy({ category: 'implementation', ceiling: 'high', graduatedLevel: 'low' }),
    );
    expect(v.effectiveCeiling).toBe('low');
  });
});
