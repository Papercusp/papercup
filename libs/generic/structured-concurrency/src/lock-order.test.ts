import { describe, expect, it } from 'vitest';
import { createLockOrdering, type OrderedLock } from './lock-order';

describe('createLockOrdering', () => {
  const { orderLocks, isCanonicalOrder, classRank } = createLockOrdering(['resource', 'db-schema', 'harness', 'file', 'work-item', 'plan-item']);

  it('is a total order across classes then keys', () => {
    const locks: OrderedLock[] = [
      { lockClass: 'plan-item', key: 'P-2' },
      { lockClass: 'file', key: 'b.ts' },
      { lockClass: 'file', key: 'a.ts' },
      { lockClass: 'resource', key: 'dev-server' },
    ];
    expect(orderLocks(locks).map((l) => `${l.lockClass}:${l.key}`)).toEqual([
      'resource:dev-server', 'file:a.ts', 'file:b.ts', 'plan-item:P-2',
    ]);
    expect(classRank('resource')).toBeLessThan(classRank('file'));
    expect(isCanonicalOrder([{ lockClass: 'file', key: 'b' }, { lockClass: 'file', key: 'a' }])).toBe(false);
  });

  it('ranks an unknown class last (acquired after every known class)', () => {
    expect(classRank('mystery')).toBe(Number.MAX_SAFE_INTEGER);
    const ordered = orderLocks([
      { lockClass: 'mystery', key: 'z' },
      { lockClass: 'resource', key: 'a' },
    ]);
    expect(ordered.map((l) => l.lockClass)).toEqual(['resource', 'mystery']);
  });

  it('is stable + pure (does not mutate its input)', () => {
    const input: OrderedLock[] = [{ lockClass: 'file', key: 'b' }, { lockClass: 'file', key: 'a' }];
    const out = orderLocks(input);
    expect(input.map((l) => l.key)).toEqual(['b', 'a']); // input untouched
    expect(out.map((l) => l.key)).toEqual(['a', 'b']);
  });
});
