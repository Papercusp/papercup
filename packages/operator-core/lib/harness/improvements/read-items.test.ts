import { describe, it, expect } from 'vitest';
import { issueToCandidate, readImprovementItems, IMPROVEMENT_TOPIC } from './read-items';
import type { EngineerIssue } from '../../issues-engineer';

function issue(p: Partial<EngineerIssue> & { id: string; title: string }): EngineerIssue {
  return {
    kind: 'bug',
    scope: 'operator',
    body: '',
    severity: 'minor',
    source: 'su',
    state: 'open',
    assignee: null,
    assignedBy: null,
    assignedAt: null,
    payload: null,
    foundDuring: null,
    linkedFeatureId: null,
    createdBy: 'su-test',
    assigneeRank: null,
    rankWriter: null,
    rankUpdatedAt: null,
    createdAt: '2026-06-04T00:00:00Z',
    updatedAt: '2026-06-04T00:00:00Z',
    ...p,
  };
}

describe('issueToCandidate — native kind column (close-loop D-002, deriveKind retired)', () => {
  it('reads the kind COLUMN, not the title (no prefix parsing)', () => {
    const c = issueToCandidate(issue({ id: 'EI-9', title: 'presence overflows', kind: 'bug', severity: 'major' }));
    expect(c).toMatchObject({ id: 'EI-9', kind: 'bug', title: 'presence overflows', severity: 'major', scope: 'operator' });
  });

  it('kind=change passes through', () => {
    expect(issueToCandidate(issue({ id: 'EI-2', title: 'make it bigger', kind: 'change' })).kind).toBe('change');
  });

  it('payload.improvementKind=feature refines a change to a feature candidate', () => {
    const c = issueToCandidate(issue({ id: 'EI-3', title: 'new tab', kind: 'change', payload: { improvementKind: 'feature' } }));
    expect(c.kind).toBe('feature');
  });

  it('maps payload.paths → candidate.paths (the protected-path gate feed)', () => {
    const c = issueToCandidate(
      issue({ id: 'EI-4', title: 'x', kind: 'bug', payload: { paths: ['packages/operator-core/lib/release/deploy.ts', 7] } }),
    );
    expect(c.paths).toEqual(['packages/operator-core/lib/release/deploy.ts']); // non-strings dropped
  });

  it('maps payload.implementAttempts + payload.needsHuman + assignedAt (the close-loop lifecycle)', () => {
    const c = issueToCandidate(
      issue({
        id: 'EI-5',
        title: 'x',
        kind: 'bug',
        assignee: 'improvement-runner',
        assignedAt: '2026-06-05T01:00:00Z',
        payload: { implementAttempts: 2, needsHuman: true },
      }),
    );
    expect(c.attempts).toBe(2);
    expect(c.needsHuman).toBe(true);
    expect(c.assignedAt).toBe('2026-06-05T01:00:00Z');
  });

  it('omits the lifecycle fields when the payload has none', () => {
    const c = issueToCandidate(issue({ id: 'EI-6', title: 'x', kind: 'bug' }));
    expect(c.attempts).toBeUndefined();
    expect(c.needsHuman).toBeUndefined();
    expect(c.paths).toBeUndefined();
  });
});

describe('readImprovementItems', () => {
  it('queries the papercusp-improvement topic and maps to candidates (injected lister, no PG)', async () => {
    const calls: unknown[] = [];
    const fakeList = async (filter: unknown) => {
      calls.push(filter);
      return [
        issue({ id: 'EI-1', title: 'a', kind: 'bug', severity: 'critical' }),
        issue({ id: 'EI-2', title: 'a plain change', kind: 'change' }),
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

  it('(P-010) filters by harness scope when harnessSlug is provided', async () => {
    const allIssues = [
      issue({ id: 'EI-1', title: 'a bug', kind: 'bug', scope: 'operator' }),
      issue({ id: 'EI-2', title: 'harness-foo issue', kind: 'change', scope: 'harness:foo' }),
      issue({ id: 'EI-3', title: 'harness-bar issue', kind: 'change', scope: 'harness:bar' }),
      issue({ id: 'EI-4', title: 'another foo issue', kind: 'change', scope: 'harness:foo' }),
    ];
    const fakeList = async () => allIssues;

    // With no harnessSlug, should return all
    const all = await readImprovementItems({}, { listIssues: fakeList });
    expect(all.length).toBe(4);

    // With harnessSlug='foo', should return only 'harness:foo' scoped issues
    const fooItems = await readImprovementItems({ harnessSlug: 'foo' }, { listIssues: fakeList });
    expect(fooItems.length).toBe(2);
    expect(fooItems.map((i) => i.id)).toEqual(['EI-2', 'EI-4']);
    expect(fooItems.every((i) => i.scope === 'harness:foo')).toBe(true);

    // With harnessSlug='bar', should return only 'harness:bar' scoped issues
    const barItems = await readImprovementItems({ harnessSlug: 'bar' }, { listIssues: fakeList });
    expect(barItems.length).toBe(1);
    expect(barItems[0]?.id).toBe('EI-3');
  });
});
