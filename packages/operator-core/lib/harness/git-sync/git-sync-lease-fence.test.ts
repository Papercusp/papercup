import { describe, expect, it } from 'vitest';
import { createGitSyncLeaseFence, GitSyncLeaseLostError } from './git-sync-lease-fence';

const LIMIT = 480_000;

function fenceAt(start: number) {
  let clock = start;
  const fence = createGitSyncLeaseFence({
    slug: 'papercusp',
    acquiredAt: start,
    unconfirmedLimitMs: LIMIT,
    now: () => clock,
  });
  return {
    fence,
    advance: (ms: number) => {
      clock += ms;
      return clock;
    },
  };
}

describe('git-sync lease fence (WI-10006724)', () => {
  it('holds while refreshes keep confirming inside the limit', () => {
    const { fence, advance } = fenceAt(1_000);
    for (let i = 0; i < 20; i += 1) {
      fence.confirm(advance(60_000));
      expect(() => fence.assertHeld()).not.toThrow();
    }
    expect(fence.lost).toBeNull();
  });

  it('trips on a refused refresh and stays tripped after later confirmations', () => {
    const { fence, advance } = fenceAt(1_000);
    fence.markLost('refused', 'git-sync:papercusp: held by another owner');
    fence.confirm(advance(60_000));
    expect(() => fence.assertHeld()).toThrow(GitSyncLeaseLostError);
    expect(fence.lost?.leaseLossCause).toBe('refused');
    expect(fence.lost?.code).toBe('git_sync_lease_lost');
  });

  it('trips at the next Git command once no refresh was confirmed for the limit', () => {
    const { fence, advance } = fenceAt(1_000);
    advance(LIMIT - 1);
    expect(() => fence.assertHeld()).not.toThrow();
    advance(1);
    expect(() => fence.assertHeld()).toThrow(/lease lost \(unconfirmed\)/);
    expect(fence.lost?.leaseLossCause).toBe('unconfirmed');
  });

  it('does not re-arm when a refresh succeeds only AFTER an unconfirmed gap', () => {
    // A same-owner refresh can re-grant an expired row; another fire may have
    // written inside the gap, so the late success must not count as continuity.
    const { fence, advance } = fenceAt(1_000);
    fence.confirm(advance(LIMIT + 5_000));
    expect(fence.lost?.leaseLossCause).toBe('unconfirmed');
    expect(() => fence.assertHeld()).toThrow(GitSyncLeaseLostError);
  });

  it('keeps the first loss when several are reported', () => {
    const { fence } = fenceAt(1_000);
    const first = fence.markLost('refused', 'first');
    const second = fence.markLost('unconfirmed', 'second');
    expect(second).toBe(first);
    expect(fence.lost?.detail).toBe('first');
  });

  it('ignores an out-of-order older confirmation', () => {
    const { fence, advance } = fenceAt(1_000);
    const t1 = advance(60_000);
    fence.confirm(t1);
    fence.confirm(t1 - 30_000);
    advance(LIMIT - 1);
    expect(() => fence.assertHeld()).not.toThrow();
  });
});
