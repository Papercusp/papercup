/**
 * Regression pin for the stuck-page-dim bug (2026-06-10): the jump-gate
 * warp dims <main> to opacity 0.55 with a fill-forwards WAAPI animation.
 * A finished fill-forwards animation still APPLIES its effect until
 * cancel() — style.removeProperty cannot clear it — so the warp registry
 * must keep FINISHED animations cancellable. The old implementation
 * dropped animations from the registry on `finished`, which let the
 * 120ms dim (always finished before the route committed) escape the
 * enter-pass cancel and park the whole app at 55% brightness.
 */
import { describe, expect, it, vi } from 'vitest';
import { __warpAnimationsForTests as warp } from './RouteTransitionProvider';

function makeFakeAnimation(): Animation & { cancel: ReturnType<typeof vi.fn> } {
  let resolveFinished: (a: Animation) => void = () => {};
  const fake = {
    cancel: vi.fn(),
    finished: new Promise<Animation>((resolve) => {
      resolveFinished = resolve;
    }),
    finish() {
      resolveFinished(fake as unknown as Animation);
    },
  };
  return fake as unknown as Animation & {
    cancel: ReturnType<typeof vi.fn>;
    finish: () => void;
  };
}

describe('warp animation registry', () => {
  it('keeps a FINISHED animation in the registry so the enter pass can cancel its fill-forwards effect', async () => {
    const anim = makeFakeAnimation();
    warp.track(anim);

    (anim as unknown as { finish: () => void }).finish();
    // Let any `finished`-promise reactions run — the buggy implementation
    // dropped the animation from the registry here.
    await Promise.resolve();
    await Promise.resolve();

    expect(warp.registry.has(anim)).toBe(true);

    warp.cancelAll();
    expect(anim.cancel).toHaveBeenCalledTimes(1);
    expect(warp.registry.size).toBe(0);
  });

  it('cancelAll cancels still-running animations too', () => {
    const anim = makeFakeAnimation();
    warp.track(anim);
    warp.cancelAll();
    expect(anim.cancel).toHaveBeenCalledTimes(1);
    expect(warp.registry.size).toBe(0);
  });
});
