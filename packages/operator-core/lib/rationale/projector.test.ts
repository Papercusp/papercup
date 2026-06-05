import { describe, it, expect } from 'vitest';
import { rationaleProjector, firstSentence } from './projector';
import type { RationaleSource } from './types';

describe('firstSentence', () => {
  it('takes the first sentence', () => {
    expect(firstSentence('Use PG. Not files.')).toBe('Use PG.');
  });
  it('collapses whitespace and falls back to the whole text when no terminator', () => {
    expect(firstSentence('a   b\n c')).toBe('a b c');
  });
  it('truncates past the max with an ellipsis', () => {
    const long = 'x'.repeat(300);
    const out = firstSentence(long, 50);
    expect(out.length).toBe(50);
    expect(out.endsWith('…')).toBe(true);
  });
  it('returns empty for empty input', () => {
    expect(firstSentence('   ')).toBe('');
  });
});

describe('rationaleProjector — plan decisions', () => {
  const plan: RationaleSource = {
    kind: 'plan',
    slug: 'my-plan',
    planTitle: 'My Plan',
    planStatus: 'active',
    topics: ['coordination-substrate', 'db-tooling'],
    decisions: [
      { id: 'D-001', title: 'Use PG', body: 'PG by default. Files are the exception.', date: '2026-06-01' },
      { id: 'D-002', title: 'Topics are the lens', body: 'Index by topic.', date: '2026-06-02' },
    ],
  };

  it('contributes each decision under each topic (decisions × topics)', () => {
    const out = rationaleProjector(plan);
    expect(out).toHaveLength(4); // 2 decisions × 2 topics
    const keys = new Set(out.map((c) => c.key));
    expect(keys).toEqual(new Set(['coordination-substrate', 'db-tooling']));
  });

  it('uses the decision id as entryId (unique per key) and stamps kind + sortKey', () => {
    const out = rationaleProjector(plan);
    const inCoord = out.filter((c) => c.key === 'coordination-substrate');
    expect(inCoord.map((c) => c.entryId).sort()).toEqual(['D-001', 'D-002']);
    expect(inCoord.every((c) => c.kind === 'decision')).toBe(true);
    expect(inCoord.find((c) => c.entryId === 'D-001')!.sortKey).toBe('2026-06-01');
  });

  it('renders a compact, drill-in-able entry', () => {
    const out = rationaleProjector(plan);
    const e = out.find((c) => c.entryId === 'D-001' && c.key === 'db-tooling')!.entry;
    expect(e).toMatchObject({
      kind: 'decision',
      ref: 'D-001 @ my-plan',
      title: 'Use PG',
      summary: 'PG by default.',
      home: 'my-plan',
      state: 'active',
      date: '2026-06-01',
    });
  });

  it('strips a leading "Date:" line that the plan writer leaves in the body', () => {
    const out = rationaleProjector({
      ...plan,
      topics: ['db-tooling'],
      decisions: [{ id: 'D-009', title: 'X', body: 'Date: 2026-06-02\nThe real reason. More.', date: '2026-06-02' }],
    });
    expect(out[0]!.entry.summary).toBe('The real reason.');
  });

  it('contributes nothing when there are no topics or no decisions', () => {
    expect(rationaleProjector({ ...plan, topics: [] })).toEqual([]);
    expect(rationaleProjector({ ...plan, decisions: [] })).toEqual([]);
  });

  it('de-dupes and trims topic keys so a malformed tag cannot break the diff', () => {
    const out = rationaleProjector({
      ...plan,
      topics: ['coordination-substrate', ' coordination-substrate ', ''],
      decisions: [plan.decisions[0]!],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.key).toBe('coordination-substrate');
  });
});

describe('rationaleProjector — work items', () => {
  const wi: RationaleSource = {
    kind: 'work_item',
    id: 'WI-042',
    title: 'Fix the thing',
    summary: 'The thing was broken. Now fixed.',
    state: 'open',
    topics: ['coord-dx'],
    createdAt: '2026-06-03T00:00:00.000Z',
  };

  it('contributes the item under each of its topics with its state', () => {
    const out = rationaleProjector(wi);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ key: 'coord-dx', entryId: 'WI-042', kind: 'work_item' });
    expect(out[0]!.entry).toMatchObject({
      kind: 'work_item',
      ref: 'WI-042',
      title: 'Fix the thing',
      summary: 'The thing was broken.',
      home: 'WI-042',
      state: 'open',
      date: '2026-06-03T00:00:00.000Z',
    });
  });

  it('contributes nothing when untagged', () => {
    expect(rationaleProjector({ ...wi, topics: [] })).toEqual([]);
  });
});

describe('rationaleProjector — insights', () => {
  const insight: RationaleSource = {
    kind: 'insight',
    slug: 'db-not-transport',
    title: 'DB is not a transport',
    description: 'Do not poll PG as a message channel. Use push.',
    tags: ['coordination-substrate', 'db-tooling'],
  };

  it('contributes the insight under each frontmatter tag', () => {
    const out = rationaleProjector(insight);
    expect(out).toHaveLength(2);
    expect(out.every((c) => c.kind === 'insight' && c.entryId === 'db-not-transport')).toBe(true);
    expect(out[0]!.entry).toMatchObject({
      kind: 'insight',
      ref: 'db-not-transport',
      title: 'DB is not a transport',
      summary: 'Do not poll PG as a message channel.',
      home: 'db-not-transport',
    });
    // Insights carry no intrinsic date → no sortKey.
    expect(out[0]!.sortKey).toBeUndefined();
  });

  it('contributes nothing when untagged', () => {
    expect(rationaleProjector({ ...insight, tags: [] })).toEqual([]);
  });
});
