import { describe, expect, it } from 'vitest';
import { selectCanonicalIssue } from './issue-occurrence-ledger';

describe('selectCanonicalIssue', () => {
  it('prefers exact stable identity over a higher fuzzy score', () => {
    expect(selectCanonicalIssue(
      { schemaVersion: 'admission-identity-v1', titleKey: 'title:alpha failure', signalKey: null },
      [
        { id: 'WI-2', title: 'near alpha failure', eligible: true, similarity: 0.99 },
        { id: 'WI-1', title: 'Alpha failure', eligible: true, similarity: 0.8 },
      ],
    )?.id).toBe('WI-1');
  });

  it('never selects an advisory-only candidate', () => {
    expect(selectCanonicalIssue(
      { schemaVersion: 'admission-identity-v1', titleKey: 'title:alpha', signalKey: null },
      [{ id: 'WI-1', title: 'Alpha', eligible: false, similarity: 1 }],
    )).toBeNull();
  });

  it('uses score then id for deterministic fuzzy selection', () => {
    expect(selectCanonicalIssue(
      { schemaVersion: 'admission-identity-v1', titleKey: 'title:unrelated', signalKey: null },
      [
        { id: 'WI-9', title: 'candidate z', eligible: true, similarity: 0.9 },
        { id: 'WI-3', title: 'candidate a', eligible: true, similarity: 0.9 },
      ],
    )?.id).toBe('WI-3');
  });
});
