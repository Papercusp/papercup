/**
 * presence-include-detail.test.ts — P-011 include_detail: the held-files lane.
 * Guards the pure grouping (the fetch is the fail-soft cross-DB IO seam).
 */
import { describe, it, expect } from 'vitest';
import { groupHeldFilesByOwner } from './presence-snapshot';

describe('groupHeldFilesByOwner (P-011 include_detail)', () => {
  it('groups holders by owner, restricted to the roster, sorted, skipping the tree-root node', () => {
    const holders = [
      { owner: 'su-a', node: 'packages/x.ts' },
      { owner: 'su-a', node: 'packages/a.ts' },
      { owner: 'su-b', node: 'libs/y.ts' },
      { owner: 'su-c', node: 'libs/z.ts' }, // not in the roster → excluded
      { owner: 'su-a', node: '' }, // tree-root intent, not a file → skipped
    ];
    const out = groupHeldFilesByOwner(holders, new Set(['su-a', 'su-b']));
    expect(out.get('su-a')).toEqual(['packages/a.ts', 'packages/x.ts']); // sorted (byte-stable)
    expect(out.get('su-b')).toEqual(['libs/y.ts']);
    expect(out.has('su-c')).toBe(false); // a holder outside the roster is dropped
  });

  it('is empty for no holders or an empty roster', () => {
    expect(groupHeldFilesByOwner([], new Set(['su-a'])).size).toBe(0);
    expect(groupHeldFilesByOwner([{ owner: 'su-a', node: 'x.ts' }], new Set()).size).toBe(0);
  });
});
