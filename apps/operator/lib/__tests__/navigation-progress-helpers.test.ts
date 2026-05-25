import { describe, expect, it } from 'vitest';
import { shouldClearStaleBusyClass, shouldHideIdleProgressBar, shouldMaintainIdleProgress, shouldSuppressNavigationProgress } from '../../../operator-vite/src/components/navigation-progress-helpers';

describe('navigation progress helpers', () => {
  it('clears the stale busy class only when the router is idle', () => {
    expect(shouldClearStaleBusyClass(false)).toBe(true);
    expect(shouldClearStaleBusyClass(true)).toBe(false);
  });

  it('hides the idle progress bar only when the router is idle', () => {
    expect(shouldHideIdleProgressBar(false)).toBe(true);
    expect(shouldHideIdleProgressBar(true)).toBe(false);
  });

  it('maintains idle progress cleanup only while the router is not pending', () => {
    expect(shouldMaintainIdleProgress(false)).toBe(true);
    expect(shouldMaintainIdleProgress(true)).toBe(false);
  });
  it('suppresses navigation progress on the no-HMR desktop and preview hosts', () => {
    expect(shouldSuppressNavigationProgress('http://localhost:3070')).toBe(true);
    expect(shouldSuppressNavigationProgress('http://127.0.0.1:3070')).toBe(true);
    expect(shouldSuppressNavigationProgress('http://localhost:4173')).toBe(true);
    expect(shouldSuppressNavigationProgress('http://127.0.0.1:4173')).toBe(true);
    expect(shouldSuppressNavigationProgress('http://localhost:3055')).toBe(false);
  });
});
