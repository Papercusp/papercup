import { describe, it, expect } from 'vitest';
import { guardReaction, MAX_REACTION_DEPTH } from './loop-guard';

describe('guardReaction', () => {
  it('allows a first reaction (no prior cause) and roots the chain', () => {
    const d = guardReaction({ cause: undefined, ruleId: 'r1', rootRunId: 'run-1' });
    expect(d.allow).toBe(true);
    if (d.allow) {
      expect(d.nextCause).toEqual({ depth: 1, chain: ['r1'], ruleId: 'r1', rootRunId: 'run-1' });
    }
  });

  it('increments depth and appends to the chain', () => {
    const d = guardReaction({
      cause: { depth: 2, chain: ['a', 'b'], ruleId: 'b', rootRunId: 'root' },
      ruleId: 'c',
      rootRunId: 'ignored-when-cause-present',
    });
    expect(d.allow).toBe(true);
    if (d.allow) {
      expect(d.nextCause).toEqual({ depth: 3, chain: ['a', 'b', 'c'], ruleId: 'c', rootRunId: 'root' });
    }
  });

  it('drops when depth would exceed the cap', () => {
    const d = guardReaction({
      cause: { depth: MAX_REACTION_DEPTH, chain: ['x'], ruleId: 'x', rootRunId: 'root' },
      ruleId: 'y',
      rootRunId: 'root',
    });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe('depth_exceeded');
  });

  // S3: the LAST-allowed step — a trigger at depth MAX-1 still fires, stamping its
  // reaction at exactly MAX. The cap is `nextDepth > MAX` (computed depth+1), so
  // MAX itself is allowed and only the NEXT step (the drop above) is blocked. This
  // pins the inclusive boundary the existing drop test leaves open.
  it('allows the last step that lands exactly on the cap (depth MAX-1 → MAX)', () => {
    const d = guardReaction({
      cause: { depth: MAX_REACTION_DEPTH - 1, chain: ['x'], ruleId: 'x', rootRunId: 'root' },
      ruleId: 'y',
      rootRunId: 'root',
    });
    expect(d.allow).toBe(true);
    if (d.allow) {
      expect(d.nextCause.depth).toBe(MAX_REACTION_DEPTH);
      expect(d.nextCause.chain).toEqual(['x', 'y']);
    }
  });

  it('drops a cycle (the rule already appears in the chain)', () => {
    const d = guardReaction({
      cause: { depth: 1, chain: ['loop'], ruleId: 'loop', rootRunId: 'root' },
      ruleId: 'loop',
      rootRunId: 'root',
    });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe('cycle');
  });
});
