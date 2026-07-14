import { describe, expect, it, vi } from 'vitest';
import { sweepDeadOwnerControlState } from './dead-owner-control-sweep';

describe('sweepDeadOwnerControlState', () => {
  it('returns the entire owner/loop/hold batch from one SQL statement', async () => {
    const sql = vi.fn(async () => [{ owners: ['su-dead'], loops_terminated: '3', holds_lifted: '5' }]);
    Object.assign(sql, { unsafe: (value: string) => value });
    const result = await sweepDeadOwnerControlState(sql as never, { ownerGraceMs: 1, holdOpenGraceMs: 1 });
    expect(result).toEqual({ owners: ['su-dead'], loopsTerminated: 3, holdsLifted: 5 });
    // Two calls build the reusable liveness SQL fragments; the final tagged
    // call is the one atomic database statement containing both UPDATE CTEs.
    const fragments = sql.mock.calls.at(-1)![0] as TemplateStringsArray;
    expect(fragments.join('')).toContain('ended_loop AS');
    expect(fragments.join('')).toContain('lifted_hold AS');
  });
});
