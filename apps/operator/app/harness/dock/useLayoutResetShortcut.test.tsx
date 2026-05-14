/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useLayoutResetShortcut } from './useLayoutResetShortcut';

function fireShiftEsc(type: 'keydown' | 'keyup' = 'keydown') {
  const ev = new KeyboardEvent(type, {
    key: 'Escape',
    shiftKey: true,
    cancelable: true,
  });
  window.dispatchEvent(ev);
  return ev;
}

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => vi.useRealTimers());

describe('useLayoutResetShortcut', () => {
  it('triggers after 1s of Shift+Esc held down', () => {
    const onReset = vi.fn();
    renderHook(() => useLayoutResetShortcut(onReset));
    fireShiftEsc('keydown');
    expect(onReset).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(onReset).toHaveBeenCalled();
  });

  it('does NOT trigger if released before 1s', () => {
    const onReset = vi.fn();
    renderHook(() => useLayoutResetShortcut(onReset));
    fireShiftEsc('keydown');
    vi.advanceTimersByTime(500);
    // Release before timeout
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape' }));
    vi.advanceTimersByTime(2000);
    expect(onReset).not.toHaveBeenCalled();
  });

  it('does NOT trigger on Esc alone (no Shift)', () => {
    const onReset = vi.fn();
    renderHook(() => useLayoutResetShortcut(onReset));
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape' }),
    );
    vi.advanceTimersByTime(2000);
    expect(onReset).not.toHaveBeenCalled();
  });

  it('does NOT trigger on Shift+Esc with modifier (Ctrl etc.)', () => {
    const onReset = vi.fn();
    renderHook(() => useLayoutResetShortcut(onReset));
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        shiftKey: true,
        ctrlKey: true,
      }),
    );
    vi.advanceTimersByTime(2000);
    expect(onReset).not.toHaveBeenCalled();
  });

  it('repeats are debounced (held key only triggers once)', () => {
    const onReset = vi.fn();
    renderHook(() => useLayoutResetShortcut(onReset));
    fireShiftEsc('keydown');
    fireShiftEsc('keydown');
    fireShiftEsc('keydown');
    vi.advanceTimersByTime(1000);
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('release-and-re-press resets the timer', () => {
    const onReset = vi.fn();
    renderHook(() => useLayoutResetShortcut(onReset));
    fireShiftEsc('keydown');
    vi.advanceTimersByTime(900);
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape' }));
    vi.advanceTimersByTime(2000);
    expect(onReset).not.toHaveBeenCalled();
    // Re-press → still need full 1s
    fireShiftEsc('keydown');
    vi.advanceTimersByTime(500);
    expect(onReset).not.toHaveBeenCalled();
    vi.advanceTimersByTime(600);
    expect(onReset).toHaveBeenCalled();
  });
});
