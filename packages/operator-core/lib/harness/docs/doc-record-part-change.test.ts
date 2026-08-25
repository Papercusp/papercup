import { describe, expect, it } from 'vitest';
import { docPartHasChanges, type DocPartComparable } from './doc-record';

function part(overrides: Partial<DocPartComparable> = {}): DocPartComparable {
  return {
    body: 'rule body',
    kind: 'invariant',
    ordinal: 3,
    clientScope: ['all'],
    projectRank: 100,
    targetSection: 'Rules',
    rationalePartKey: null,
    ...overrides,
  };
}

describe('docPartHasChanges', () => {
  it('recognizes a true no-op across body and every persisted column', () => {
    expect(docPartHasChanges(part(), part())).toBe(false);
  });

  it('allows a rank-only edit when the body is unchanged', () => {
    expect(docPartHasChanges(part(), part({ projectRank: 101 }))).toBe(true);
  });

  it('recognizes body, ordinal, kind, section, rationale, and scope edits', () => {
    const edits: Partial<DocPartComparable>[] = [
      { body: 'new rule body' },
      { ordinal: 4 },
      { kind: 'recipe' },
      { targetSection: 'Other rules' },
      { rationalePartKey: 'why-this' },
      { clientScope: ['claude'] },
    ];

    for (const edit of edits) expect(docPartHasChanges(part(), part(edit))).toBe(true);
  });

  it('treats equal client-scope values as unchanged even when arrays are distinct', () => {
    expect(docPartHasChanges(part({ clientScope: ['all'] }), part({ clientScope: ['all'] }))).toBe(false);
  });
});
