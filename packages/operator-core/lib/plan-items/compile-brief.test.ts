import { describe, it, expect } from 'vitest';
import { compilePlanItemBrief, decisionsForItem } from './compile-brief';

describe('compilePlanItemBrief', () => {
  it('returns empty when there is no enrichment beyond the item text', () => {
    expect(compilePlanItemBrief({ itemId: 'P-002', itemText: 'Do the thing' })).toBe('');
    expect(
      compilePlanItemBrief({
        itemId: 'P-002',
        itemText: 'x',
        planFocus: { state: '', next: '' },
        decisions: [],
      }),
    ).toBe('');
  });

  it('includes the plan focus (state + next) and restates the task', () => {
    const b = compilePlanItemBrief({
      itemId: 'P-002',
      itemText: 'Touch-set exclusion',
      planFocus: { state: 'Building the four bets', next: 'Start P-002' },
    });
    expect(b).toContain('## Task — P-002');
    expect(b).toContain('Touch-set exclusion');
    expect(b).toContain('## Plan focus');
    expect(b).toContain('Building the four bets');
    expect(b).toContain('Next: Start P-002');
  });

  it('includes bearing decisions with id, title, and body', () => {
    const b = compilePlanItemBrief({
      itemId: 'P-002',
      itemText: 'x',
      decisions: [
        {
          id: 'D-002',
          title: 'Minimal layer',
          body: 'No new engine; the work_item queue is the coordination layer.',
        },
      ],
    });
    expect(b).toContain('## Decisions bearing on this item');
    expect(b).toContain('D-002 — Minimal layer');
    expect(b).toContain('No new engine');
  });

  it('includes the plan title in the header when given', () => {
    const b = compilePlanItemBrief({
      itemId: 'P-1',
      itemText: 't',
      planFocus: { state: 's' },
      planTitle: 'My Plan',
    });
    expect(b).toContain('## Task — P-1 · My Plan');
  });

  it('respects maxChars and clips with a trailing ellipsis', () => {
    const big = 'lorem ipsum '.repeat(500);
    const b = compilePlanItemBrief({
      itemId: 'P-9',
      itemText: 'x',
      decisions: [{ id: 'D-1', title: 'T', body: big }],
      maxChars: 300,
    });
    expect(b.length).toBeLessThanOrEqual(300);
    expect(b.endsWith('…')).toBe(true);
  });
});

describe('decisionsForItem', () => {
  const parsed = {
    items: [
      { id: 'P-001', decisionRefs: ['D-001', 'D-002', 'D-001'] }, // dup D-001
      { id: 'P-002', decisionRefs: [] },
    ],
    decisions: [
      { id: 'D-001', title: 'One', body: 'b1' },
      { id: 'D-002', title: 'Two', body: 'b2' },
      { id: 'D-009', title: 'Nine', body: 'b9' },
    ],
  };

  it('resolves refs in order and dedups', () => {
    const ds = decisionsForItem(parsed, 'P-001');
    expect(ds.map((d) => d.id)).toEqual(['D-001', 'D-002']);
  });

  it('returns [] for an item with no refs', () => {
    expect(decisionsForItem(parsed, 'P-002')).toEqual([]);
  });

  it('tolerates a partial/mocked parse and unresolved refs', () => {
    expect(decisionsForItem(null, 'P-001')).toEqual([]);
    expect(decisionsForItem({}, 'P-001')).toEqual([]);
    expect(
      decisionsForItem({ items: [{ id: 'P-1', decisionRefs: ['D-X'] }] }, 'P-1'),
    ).toEqual([]); // ref with no matching decision is skipped
  });
});
