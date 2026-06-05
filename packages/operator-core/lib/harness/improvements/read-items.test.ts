import { describe, it, expect } from 'vitest';
import { deriveKind, issueToCandidate, readImprovementItems, IMPROVEMENT_TOPIC } from './read-items';
import type { EngineerIssue } from '../../issues-engineer';

function issue(p: Partial<EngineerIssue> & { id: string; title: string }): EngineerIssue {
  return {
    scope: 'operator',
    body: '',
    severity: 'minor',
    source: 'su',
    state: 'open',
    assignee: null,
    foundDuring: null,
    linkedFeatureId: null,
    createdBy: 'su-test',
    createdAt: '2026-06-04T00:00:00Z',
    updatedAt: '2026-06-04T00:00:00Z',
    ...p,
  };
}

describe('deriveKind', () => {
  it('parses [bug]/[change]/[feature] prefixes (case-insensitive)', () => {
    expect(deriveKind('[bug] x')).toEqual({ kind: 'bug', cleanTitle: 'x' });
    expect(deriveKind('[Change] make it bigger')).toEqual({ kind: 'change', cleanTitle: 'make it bigger' });
    expect(deriveKind('[FEATURE] new tab')).toEqual({ kind: 'feature', cleanTitle: 'new tab' });
  });
  it('defaults to change when no prefix', () => {
    expect(deriveKind('just a title')).toEqual({ kind: 'change', cleanTitle: 'just a title' });
  });
});

describe('issueToCandidate', () => {
  it('maps an engineer_issue to a candidate, deriving kind + clean title', () => {
    const c = issueToCandidate(issue({ id: 'EI-9', title: '[bug] presence overflows', severity: 'major', scope: 'operator' }));
    expect(c).toMatchObject({ id: 'EI-9', kind: 'bug', title: 'presence overflows', severity: 'major', scope: 'operator' });
  });
});

describe('readImprovementItems', () => {
  it('queries the papercusp-improvement topic and maps to candidates (injected lister, no PG)', async () => {
    const calls: unknown[] = [];
    const fakeList = async (filter: unknown) => {
      calls.push(filter);
      return [
        issue({ id: 'EI-1', title: '[bug] a', severity: 'critical' }),
        issue({ id: 'EI-2', title: 'a plain change' }),
      ];
    };
    const items = await readImprovementItems({}, { listIssues: fakeList });
    expect(calls[0]).toMatchObject({ topic: IMPROVEMENT_TOPIC });
    expect(items.map((i) => i.kind)).toEqual(['bug', 'change']);
    expect(items.map((i) => i.id)).toEqual(['EI-1', 'EI-2']);
  });

  it('passes the state filter through', async () => {
    let seen: any;
    await readImprovementItems({ state: 'open' }, { listIssues: async (f) => ((seen = f), []) });
    expect(seen).toMatchObject({ topic: IMPROVEMENT_TOPIC, state: 'open' });
  });
});
