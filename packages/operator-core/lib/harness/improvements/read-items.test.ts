import { describe, it, expect } from 'vitest';
import { issueToCandidate, readImprovementItems, readObservationItems, IMPROVEMENT_TOPIC, OBSERVATION_TOPIC } from './read-items';
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
    signalOrigin: 'organic',
    assigneeRank: null,
    rankWriter: null,
    rankUpdatedAt: null,
    lastProgressAt: null,
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

  it('maps payload.sourceRole → candidate.sourceRole (P-010 source-tag)', () => {
    const c = issueToCandidate(
      issue({
        id: 'EI-7',
        title: 'system-filed bug',
        kind: 'bug',
        payload: { sourceRole: 'system' },
      }),
    );
    expect(c.sourceRole).toBe('system');
  });

  it('extracts sourceRole for Queen, bee, and system roles (P-010)', () => {
    for (const role of ['Queen', 'cup', 'system', 'human'] as const) {
      const c = issueToCandidate(
        issue({
          id: `EI-${role}`,
          title: `${role}-filed idea`,
          kind: 'change',
          payload: { sourceRole: role },
        }),
      );
      expect(c.sourceRole).toBe(role);
    }
  });

  it('maps payload.findingClass → candidate.findingClass (frontier P-044 taxonomy slug)', () => {
    const c = issueToCandidate(
      issue({
        id: 'EI-8',
        title: 'resolution gap',
        kind: 'bug',
        payload: { findingClass: 'negative-space:resolution-gap' },
      }),
    );
    expect(c.findingClass).toBe('negative-space:resolution-gap');
    // absent / non-string stays absent
    expect(issueToCandidate(issue({ id: 'EI-9', title: 'y', kind: 'bug' })).findingClass).toBeUndefined();
    expect(
      issueToCandidate(issue({ id: 'EI-10', title: 'z', kind: 'bug', payload: { findingClass: 7 } })).findingClass,
    ).toBeUndefined();
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

  it('(P-040) filters by a Hive member-harness scope SET when harnessScopes is provided', async () => {
    const allIssues = [
      issue({ id: 'EI-1', title: 'operator-wide', kind: 'bug', scope: 'operator' }),
      issue({ id: 'EI-2', title: 'home issue', kind: 'change', scope: 'harness:my-hive' }),
      issue({ id: 'EI-3', title: 'member issue', kind: 'change', scope: 'harness:member-a' }),
      issue({ id: 'EI-4', title: 'other-hive issue', kind: 'change', scope: 'harness:other' }),
    ];
    const fakeList = async () => allIssues;
    // The Hive lens = the home + member-a scopes; 'other' and 'operator' are excluded.
    const items = await readImprovementItems(
      { harnessScopes: ['harness:my-hive', 'harness:member-a'] },
      { listIssues: fakeList },
    );
    expect(items.map((i) => i.id)).toEqual(['EI-2', 'EI-3']);
  });

  it('(P-040) harnessScopes takes precedence over harnessSlug when both are set', async () => {
    const allIssues = [
      issue({ id: 'EI-2', title: 'home', kind: 'change', scope: 'harness:my-hive' }),
      issue({ id: 'EI-9', title: 'foo', kind: 'bug', scope: 'harness:foo' }),
    ];
    const items = await readImprovementItems(
      { harnessSlug: 'foo', harnessScopes: ['harness:my-hive'] },
      { listIssues: async () => allIssues },
    );
    expect(items.map((i) => i.id)).toEqual(['EI-2']); // the scope set wins, not 'foo'
  });

  it('(P-040) an EMPTY harnessScopes set matches nothing (a Hive with no member harnesses)', async () => {
    const items = await readImprovementItems(
      { harnessScopes: [] },
      { listIssues: async () => [issue({ id: 'EI-1', title: 'x', kind: 'bug', scope: 'harness:my-hive' })] },
    );
    expect(items).toEqual([]);
  });
});

describe('readObservationItems (turn-end-reflection-observations-2026-06-14 D-005)', () => {
  it('queries the SEPARATE observation topic — NEVER the improvement topic (keeps observations out of the work pipeline)', async () => {
    let seen: any;
    await readObservationItems({}, { listIssues: async (f) => ((seen = f), []) });
    expect(seen).toMatchObject({ topic: OBSERVATION_TOPIC });
    expect(seen.topic).not.toBe(IMPROVEMENT_TOPIC);
  });

  it('maps observation rows to candidates', async () => {
    const items = await readObservationItems(
      {},
      { listIssues: async () => [issue({ id: 'EI-OBS-1', title: 'docs were stale', kind: 'change' })] },
    );
    expect(items.map((i) => i.id)).toEqual(['EI-OBS-1']);
  });
});

describe('readImprovementItems — signal provenance gate (frontier P-002 / D-002)', () => {
  const mixedStore = [
    issue({ id: 'EI-1', title: 'a real bug', kind: 'bug' }), // organic (helper default)
    issue({ id: 'EI-2', title: 'planted flaky test', kind: 'bug', signalOrigin: 'drill' }),
    issue({ id: 'EI-3', title: 'replay counterfactual artifact', kind: 'change', signalOrigin: 'replay' }),
    issue({ id: 'EI-4', title: 'shadow ablation artifact', kind: 'change', signalOrigin: 'shadow' }),
  ];

  it('DEFAULT read passes the organic-only allowlist down to listIssues (SQL-side filter)', async () => {
    let seen: any;
    await readImprovementItems({}, { listIssues: async (f) => ((seen = f), []) });
    expect(seen.signalOrigins).toEqual(['organic']);
  });

  it('DEFAULT read excludes every synthetic row even when the lister ignores signalOrigins (belt + braces)', async () => {
    // Fake lister returns the FULL mixed store regardless of the filter — the
    // TS-side gate must still keep drill/replay/shadow away from the consumer.
    const items = await readImprovementItems({}, { listIssues: async () => mixedStore });
    expect(items.map((i) => i.id)).toEqual(['EI-1']);
    expect(items[0]?.origin).toBe('organic');
  });

  it('a row with NO stored origin reads as organic (pre-migration legacy semantics)', async () => {
    const legacy = issue({ id: 'EI-9', title: 'legacy row', kind: 'bug' });
    delete (legacy as unknown as Record<string, unknown>).signalOrigin;
    const items = await readImprovementItems({}, { listIssues: async () => [legacy] });
    expect(items.map((i) => i.id)).toEqual(['EI-9']);
  });

  it('a junk origin value fails CLOSED — excluded from organic reads', async () => {
    const junk = issue({ id: 'EI-9', title: 'junk-origin row', kind: 'bug' });
    (junk as unknown as Record<string, unknown>).signalOrigin = 'mystery';
    const items = await readImprovementItems({}, { listIssues: async () => [junk] });
    expect(items).toEqual([]);
  });

  it('explicit opt-in sees exactly the requested origins (the vaccination measurement read)', async () => {
    const items = await readImprovementItems({ origins: ['drill'] }, { listIssues: async () => mixedStore });
    expect(items.map((i) => i.id)).toEqual(['EI-2']);
    expect(items[0]?.origin).toBe('drill');
  });

  it('multi-origin opt-in composes (replay + shadow audit read)', async () => {
    const items = await readImprovementItems(
      { origins: ['replay', 'shadow'] },
      { listIssues: async () => mixedStore },
    );
    expect(items.map((i) => i.id)).toEqual(['EI-3', 'EI-4']);
  });

  it('issueToCandidate carries the origin onto the candidate', () => {
    const c = issueToCandidate(issue({ id: 'EI-2', title: 'planted', kind: 'bug', signalOrigin: 'drill' }));
    expect(c.origin).toBe('drill');
  });
});
