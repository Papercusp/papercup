import { describe, it, expect } from 'vitest';
import { planExpansion, isExpandNode, renderExpansion } from './plan-expansion';

const inp = (over: Partial<Parameters<typeof planExpansion>[0]> = {}) => ({
  parentId: 'WI-1',
  parentHarness: 'papercup',
  children: [{ title: 'a' }, { title: 'b' }],
  by: 'agent:x',
  authoritative: true,
  ...over,
});

describe('planExpansion', () => {
  it('plans valid children with the parent stamp + inherited harness', () => {
    const plan = planExpansion(inp({ children: [{ title: 'Build X', files: ['x.ts'], brief: 'do it' }] }));
    expect(plan.children).toHaveLength(1);
    const c = plan.children[0];
    expect(c.kind).toBe('task');
    expect(c.title).toBe('Build X');
    expect(c.parent).toBe('WI-1');
    expect(c.harness).toBe('papercup');
    expect(c.payload).toMatchObject({ expanded_from: 'WI-1', files: ['x.ts'], brief: 'do it' });
  });

  it('authoritative ⇒ disposed; bee ⇒ proposed', () => {
    expect(planExpansion(inp({ authoritative: true })).disposition).toBe('disposed');
    expect(planExpansion(inp({ authoritative: false })).disposition).toBe('proposed');
  });

  it('drops empty + duplicate titles (deduped case-insensitively)', () => {
    const plan = planExpansion(inp({ children: [{ title: ' ' }, { title: 'Dup' }, { title: 'dup' }] }));
    expect(plan.children.map((c) => c.title)).toEqual(['Dup']);
    expect(plan.dropped).toEqual([
      { title: ' ', reason: 'empty title' },
      { title: 'dup', reason: 'duplicate title' },
    ]);
  });

  it('caps the number of children', () => {
    const children = Array.from({ length: 5 }, (_, i) => ({ title: `c${i}` }));
    const plan = planExpansion(inp({ children, maxChildren: 3 }));
    expect(plan.children).toHaveLength(3);
    expect(plan.dropped).toHaveLength(2);
    expect(plan.dropped[0].reason).toContain('cap');
  });

  it('omits empty file/brief fields from the child payload', () => {
    const plan = planExpansion(inp({ children: [{ title: 't', files: ['', '  '], brief: '   ' }] }));
    expect(plan.children[0].payload).toEqual({ expanded_from: 'WI-1' });
  });

  it('WI-1400: drops a title already expanded from this parent in a prior call, case-insensitively', () => {
    const plan = planExpansion(
      inp({
        children: [{ title: 'dup-child' }, { title: 'Fresh Child' }],
        existingChildTitles: new Set(['dup-child']),
      }),
    );
    expect(plan.children.map((c) => c.title)).toEqual(['Fresh Child']);
    expect(plan.dropped).toEqual([
      { title: 'dup-child', reason: 'already expanded from this parent in a prior call — pass force:true to re-expand anyway' },
    ]);
  });

  it('WI-1400: existingChildTitles omitted ⇒ no cross-call dedup (today\'s additive behavior)', () => {
    const plan = planExpansion(inp({ children: [{ title: 'dup-child' }] }));
    expect(plan.children.map((c) => c.title)).toEqual(['dup-child']);
    expect(plan.dropped).toEqual([]);
  });
});

describe('isExpandNode', () => {
  it('detects the expand marker on a payload', () => {
    expect(isExpandNode({ expand: true })).toBe(true);
    expect(isExpandNode({ expand_here: true })).toBe(true);
    expect(isExpandNode({ expand: false })).toBe(false);
    expect(isExpandNode({})).toBe(false);
    expect(isExpandNode(null)).toBe(false);
    expect(isExpandNode('nope')).toBe(false);
  });
});

describe('renderExpansion', () => {
  it('renders a greppable line with disposition + count + titles', () => {
    const plan = planExpansion(inp({ children: [{ title: 'A' }, { title: 'B' }], authoritative: false }));
    const line = renderExpansion(plan);
    expect(line).toContain('⟐ expand (proposed)');
    expect(line).toContain('2 child node(s)');
    expect(line).toContain('A, B');
  });
});
