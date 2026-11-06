import { describe, expect, it } from 'vitest';
import {
  acceptanceBarAtomicityIssues,
  acceptanceBarCandidateHash,
  acceptanceBarProjectedBehavior,
  assertChangedAcceptanceBarProjectionsAtomic,
} from './acceptance-bar-projection';

describe('acceptance BAR candidate identity', () => {
  const candidate = (declaredAt: string) => ({
    subjectContent: 'The served consumer receives current guidance.',
    templateData: { criteria: [{ key: 'R-11', model: 'Current guidance is delivered.',
      barProvenance: { declaredAt, declaredBy: 'author', lifecycle: 'pre-implementation' } }] },
    generatedSpecifications: [{ specId: 'AUTO-BAR-R-11-P-007', expectedRevision: 0 }],
  });

  it('keeps a newly added BAR stable across separate preview and apply timestamps without mutating its provenance', () => {
    const first = candidate('2026-11-06T09:00:00.000Z');
    const second = candidate('2026-11-06T09:00:01.000Z');
    expect(acceptanceBarCandidateHash(first)).toBe(acceptanceBarCandidateHash(second));
    expect(first.templateData.criteria[0]!.barProvenance.declaredAt).toBe('2026-11-06T09:00:00.000Z');
  });

  it.each(['model', 'declaredBy', 'lifecycle', 'subjectContent', 'generatedSpecifications'] as const)(
    'still refuses real candidate drift in %s', field => {
      const before = candidate('2026-11-06T09:00:00.000Z');
      const after = candidate('2026-11-06T09:00:01.000Z');
      if (field === 'model') after.templateData.criteria[0]!.model = 'Obsolete guidance is allowed.';
      else if (field === 'declaredBy' || field === 'lifecycle') after.templateData.criteria[0]!.barProvenance[field] = 'changed';
      else if (field === 'subjectContent') after.subjectContent = 'Changed scope.';
      else after.generatedSpecifications[0]!.expectedRevision = 1;
      expect(acceptanceBarCandidateHash(before)).not.toBe(acceptanceBarCandidateHash(after));
    },
  );
});

describe('acceptance BAR projection atomicity', () => {
  it('checks the exact behavior persisted to the projected spec clause', () => {
    const criterion = {
      key: 'R-1',
      title: 'The request is accepted',
      model: 'The request is accepted. The response streams its body.',
    };

    expect(acceptanceBarProjectedBehavior(criterion)).toBe('The response streams its body.');
    expect(acceptanceBarAtomicityIssues([criterion])).toEqual([]);
  });

  it('rejects a new BAR projection with independently observable outcomes', () => {
    expect(acceptanceBarAtomicityIssues([{
      key: 'R-4',
      title: 'The event is accepted',
      model: 'A valid event is accepted and its payload is streamed.',
    }])).toEqual([{
      barKey: 'R-4',
      behavior: 'A valid event is accepted and its payload is streamed.',
      reason: 'behavior joins multiple independently observable outcomes',
    }]);
    expect(() => assertChangedAcceptanceBarProjectionsAtomic([{
      key: 'R-4',
      model: 'A valid event is accepted and its payload is streamed.',
    }])).toThrow('acceptance_bar_non_atomic_projection');
  });

  it('allows an unchanged legacy BAR but rejects a non-atomic change to it', () => {
    const prior = [{
      key: 'R-5',
      title: 'Voice journeys work',
      model: 'Each desktop-local voice and cloud voice journey meets its consent and cleanup contract.',
    }];

    expect(acceptanceBarAtomicityIssues(prior, prior)).toEqual([]);
    expect(acceptanceBarAtomicityIssues([{
      ...prior[0]!,
      model: 'Each desktop-local voice and cloud voice journey meets its consent and cleanup contract. Push delivery opens the deep link.',
    }], prior)).toHaveLength(1);
  });

  it('does not apply outcome atomicity checks to disclosure criteria', () => {
    expect(acceptanceBarAtomicityIssues([{
      key: 'D-1',
      role: 'disclosure',
      model: 'The report names both the owner and the release track.',
    }])).toEqual([]);
  });
});
