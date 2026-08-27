/**
 * presence-include-detail.test.ts — P-011 include_detail: the held-files lane.
 * Guards the pure grouping (the fetch is the fail-soft cross-DB IO seam).
 */
import { describe, it, expect } from 'vitest';
import { groupHeldFilesByOwner, groupHeldLocksByOwner } from './presence-snapshot';

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

  it('retains exact lock handles and lease evidence for holder reconciliation', () => {
    const expires = new Date('2026-08-27T23:00:00.000Z');
    const out = groupHeldLocksByOwner(
      [
        {
          owner: 'su-a',
          node: 'packages/x.ts',
          lock_id: 'lock-z',
          coordination_domain: '/repo/staging',
          expires_ts: expires,
        },
        {
          owner: 'su-a',
          node: 'packages/a.ts',
          lock_id: 'lock-z',
          coordination_domain: '/repo/staging',
          expires_ts: expires,
        },
        {
          owner: 'su-a',
          node: 'packages/other.ts',
          lock_id: 'lock-a',
          coordination_domain: '/repo/staging',
          expires_ts: new Date('2026-08-27T22:30:00.000Z'),
        },
        // Waiter/path-interest rows have no lock metadata and must not be
        // presented as an active held lock.
        { owner: 'su-a', node: 'queued.ts' },
        { owner: 'su-b', node: 'outside.ts', lock_id: 'lock-b', coordination_domain: '/repo', expires_ts: expires },
      ],
      new Set(['su-a']),
    );

    expect(out.get('su-a')).toEqual([
      {
        lockId: 'lock-z',
        path: 'packages/a.ts',
        coordinationDomain: '/repo/staging',
        expiresAt: '2026-08-27T23:00:00.000Z',
      },
      {
        lockId: 'lock-a',
        path: 'packages/other.ts',
        coordinationDomain: '/repo/staging',
        expiresAt: '2026-08-27T22:30:00.000Z',
      },
      {
        lockId: 'lock-z',
        path: 'packages/x.ts',
        coordinationDomain: '/repo/staging',
        expiresAt: '2026-08-27T23:00:00.000Z',
      },
    ]);
    expect(out.has('su-b')).toBe(false);
  });
});
