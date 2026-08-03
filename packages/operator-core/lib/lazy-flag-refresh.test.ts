/**
 * lazy-flag-refresh.test.ts — the contract every migrated config-cache module now depends on
 * (EI-19416650993725684).
 *
 * These are not incidental properties. Each one, if it broke, would break silently in production:
 * a flag flip that stops taking effect, a cache that never populates, or a duplicated subscription
 * that multiplies every refresh. The source lint and the partial-mock importability test both cover
 * the IMPORT-time half of the class; this file covers the RUNTIME half.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Callbacks handed to onFlagChange, so a test can fire the bus by hand. */
let subscribers: Array<(key: string | null) => void> = [];
const onFlagChangeMock = vi.fn((cb: (key: string | null) => void) => {
  subscribers.push(cb);
});

vi.mock('@papercusp/flags/server', () => ({
  onFlagChange: (cb: (key: string | null) => void) => onFlagChangeMock(cb),
}));

import { lazyFlagRefresh, type UnpopulatedState } from './lazy-flag-refresh';

/**
 * A stand-in for the REQUIRED unpopulated-state declaration (EI-19448574704459898). These runtime
 * tests are about arming/refresh mechanics, so they use the safest kind; the declaration's own
 * consistency rules are enforced at the source level by
 * `scripts/check-no-module-scope-flag-subscribe.mjs`, since they are a property of the CALL SITE's
 * literal arguments rather than anything observable at runtime.
 */
const DECL: UnpopulatedState = {
  kind: 'gates-an-override-store',
  serves: 'the baked test default',
};

const fire = (key: string | null): void => {
  for (const cb of [...subscribers]) cb(key);
};

beforeEach(() => {
  subscribers = [];
  onFlagChangeMock.mockClear();
});

describe('arming', () => {
  it('touches the flags surface only when armed, never at construction', () => {
    const refresh = vi.fn();
    lazyFlagRefresh(refresh, { keys: ['my.flag'], unpopulated: DECL });
    // Constructing must be inert — this is the property that keeps a caller's IMPORT pure.
    expect(onFlagChangeMock).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('subscribes exactly once no matter how many readers arm', () => {
    const refresh = vi.fn();
    const arm = lazyFlagRefresh(refresh, { keys: ['my.flag'], unpopulated: DECL });
    arm();
    arm();
    arm();
    // A duplicated subscription would multiply every subsequent refresh — the reason arming is
    // idempotent rather than "just call onFlagChange in each reader".
    expect(onFlagChangeMock).toHaveBeenCalledTimes(1);
    expect(subscribers).toHaveLength(1);
  });

  it('kicks one immediate refresh on the arming call — the boot-reload stand-in', () => {
    const refresh = vi.fn();
    const arm = lazyFlagRefresh(refresh, { keys: ['my.flag'], unpopulated: DECL });
    arm();
    // Without this, a cache whose only other refresh is a 60s timer would serve its default for a
    // full interval after first use, where the old module-scope form got populated at boot.
    expect(refresh).toHaveBeenCalledTimes(1);
    arm();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('which keys trigger a refresh', () => {
  it('refreshes on a declared key and ignores an unrelated one', () => {
    const refresh = vi.fn();
    lazyFlagRefresh(refresh, { keys: ['a.flag', 'b.flag'], unpopulated: DECL })();
    refresh.mockClear();

    fire('a.flag');
    expect(refresh).toHaveBeenCalledTimes(1);
    fire('b.flag');
    expect(refresh).toHaveBeenCalledTimes(2);
    fire('unrelated.flag');
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('always refreshes on the null bus-wide reload, even with no declared keys', () => {
    const refresh = vi.fn();
    // The no-keys form: a cache that is not flag-GATED but still wants the "refresh now" signal
    // (quota-overrides is exactly this shape).
    lazyFlagRefresh(refresh, {
      unpopulated: { kind: 'not-flag-gated', serves: 'the baked test default' },
    })();
    refresh.mockClear();

    fire(null);
    expect(refresh).toHaveBeenCalledTimes(1);
    fire('any.flag');
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('a failing refresh never reaches the reader that armed it', () => {
  it('swallows a synchronous throw', () => {
    const arm = lazyFlagRefresh(
      () => {
        throw new Error('config read blew up');
      },
      { keys: ['my.flag'], unpopulated: DECL },
    );
    // The arming call happens INSIDE a sync hot-path getter; a throw here would surface as an
    // unrelated dispatch failure in whichever caller happened to read the cache first.
    expect(() => arm()).not.toThrow();
    expect(() => fire('my.flag')).not.toThrow();
  });

  it('swallows a rejected promise', async () => {
    const arm = lazyFlagRefresh(
      async () => {
        throw new Error('PG unreachable');
      },
      { keys: ['my.flag'], unpopulated: DECL },
    );
    expect(() => arm()).not.toThrow();
    fire('my.flag');
    // An unhandled rejection here would take down the process under Node's default policy.
    await new Promise((r) => setTimeout(r, 0));
  });
});
