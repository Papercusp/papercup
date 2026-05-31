/**
 * navigation-progress-helpers.test.ts — P-020 bootstrap.
 *
 * First test file in operator-vite. Covers the pure helper predicates that
 * guard the NavigationProgress component's CSS class / visibility logic.
 *
 * These are deterministic pure functions — no mocks, no DOM needed.
 */

import { describe, expect, it } from 'vitest';
import {
  shouldClearStaleBusyClass,
  shouldHideIdleProgressBar,
  shouldMaintainIdleProgress,
  shouldSuppressNavigationProgress,
} from '../navigation-progress-helpers';

describe('shouldClearStaleBusyClass', () => {
  it('returns true when not pending (clears the stale busy class)', () => {
    expect(shouldClearStaleBusyClass(false)).toBe(true);
  });
  it('returns false while pending (keeps the class)', () => {
    expect(shouldClearStaleBusyClass(true)).toBe(false);
  });
});

describe('shouldHideIdleProgressBar', () => {
  it('hides the bar when not pending', () => {
    expect(shouldHideIdleProgressBar(false)).toBe(true);
  });
  it('shows the bar while pending', () => {
    expect(shouldHideIdleProgressBar(true)).toBe(false);
  });
});

describe('shouldMaintainIdleProgress', () => {
  it('maintains idle progress when not pending', () => {
    expect(shouldMaintainIdleProgress(false)).toBe(true);
  });
  it('does not maintain while pending', () => {
    expect(shouldMaintainIdleProgress(true)).toBe(false);
  });
});

describe('shouldSuppressNavigationProgress', () => {
  it('suppresses for localhost:3070', () => {
    expect(shouldSuppressNavigationProgress('http://localhost:3070')).toBe(true);
  });
  it('suppresses for 127.0.0.1:3070', () => {
    expect(shouldSuppressNavigationProgress('http://127.0.0.1:3070')).toBe(true);
  });
  it('suppresses for localhost:4173 (preview server)', () => {
    expect(shouldSuppressNavigationProgress('http://localhost:4173')).toBe(true);
  });
  it('suppresses for 127.0.0.1:4173', () => {
    expect(shouldSuppressNavigationProgress('http://127.0.0.1:4173')).toBe(true);
  });
  it('does not suppress for arbitrary origins', () => {
    expect(shouldSuppressNavigationProgress('https://papercuspai.com')).toBe(false);
    expect(shouldSuppressNavigationProgress('http://localhost:3055')).toBe(false);
    expect(shouldSuppressNavigationProgress('')).toBe(false);
  });
});
