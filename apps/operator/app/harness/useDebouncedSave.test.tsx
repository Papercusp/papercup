// @vitest-environment jsdom
/**
 * Tests for useDebouncedSave — the canonical per-field auto-save hook.
 * Covers: skipFirst behaviour, debounce window, flush(), error path,
 * flush-on-unmount/pagehide (a pending edit is persisted, never dropped),
 * and lastSavedAt tracking.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDebouncedSave } from './useDebouncedSave';

// Flush all pending microtasks under fake timers. Two pumps catches a
// promise resolved inside a promise (the common shape of `await persist();
// setLastSavedAt(now)`).
async function flushMicrotasks() {
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useDebouncedSave', () => {
  it('does not save on first render (skipFirst default)', async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useDebouncedSave({ foo: 'a' }, persist));
    await act(async () => { await vi.runAllTimersAsync(); });
    expect(persist).not.toHaveBeenCalled();
  });

  it('saves on value change after debounce window', async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(
      ({ v }) => useDebouncedSave(v, persist),
      { initialProps: { v: { foo: 'a' } } },
    );
    rerender({ v: { foo: 'b' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(299); });
    expect(persist).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith({ foo: 'b' });
  });

  it('coalesces rapid changes into a single save', async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(
      ({ v }) => useDebouncedSave(v, persist, { ms: 100 }),
      { initialProps: { v: 1 } },
    );
    rerender({ v: 2 });
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    rerender({ v: 3 });
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    rerender({ v: 4 });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenLastCalledWith(4);
  });

  it('saves immediately when ms is zero for committed settings controls', async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(
      ({ v }) => useDebouncedSave(v, persist, { ms: 0 }),
      { initialProps: { v: 'a' } },
    );
    rerender({ v: 'b' });
    await flushMicrotasks();
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith('b');
  });

  it('flush() persists immediately, cancelling the pending debounce', async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const { result, rerender } = renderHook(
      ({ v }) => useDebouncedSave(v, persist),
      { initialProps: { v: 'a' } },
    );
    rerender({ v: 'b' });
    await act(async () => { await result.current.flush(); });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith('b');
    // Pending timer was cancelled — nothing else fires.
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('updates lastSavedAt after a successful save', async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const { result, rerender } = renderHook(
      ({ v }) => useDebouncedSave(v, persist),
      { initialProps: { v: 'a' } },
    );
    expect(result.current.lastSavedAt).toBeNull();
    rerender({ v: 'b' });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    await flushMicrotasks();
    expect(result.current.lastSavedAt).toBeInstanceOf(Date);
  });

  it('calls onError when persist throws', async () => {
    const onError = vi.fn();
    const err = new Error('nope');
    const persist = vi.fn().mockRejectedValue(err);
    const { rerender } = renderHook(
      ({ v }) => useDebouncedSave(v, persist, { onError }),
      { initialProps: { v: 'a' } },
    );
    rerender({ v: 'b' });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    await flushMicrotasks();
    expect(onError).toHaveBeenCalledWith(err);
  });

  it('flushes a pending save on unmount instead of dropping it', async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const { rerender, unmount } = renderHook(
      ({ v }) => useDebouncedSave(v, persist),
      { initialProps: { v: 'a' } },
    );
    rerender({ v: 'b' });
    unmount();
    await flushMicrotasks();
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith('b');
    // The cancelled timer doesn't fire a second save later.
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('does not save on unmount when nothing is pending', async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const { rerender, unmount } = renderHook(
      ({ v }) => useDebouncedSave(v, persist),
      { initialProps: { v: 'a' } },
    );
    rerender({ v: 'b' });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    await flushMicrotasks();
    expect(persist).toHaveBeenCalledTimes(1);
    unmount();
    await flushMicrotasks();
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('flushes a pending save on pagehide (reload/navigation)', async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(
      ({ v }) => useDebouncedSave(v, persist),
      { initialProps: { v: 'a' } },
    );
    rerender({ v: 'b' });
    await act(async () => { window.dispatchEvent(new Event('pagehide')); });
    await flushMicrotasks();
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith('b');
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('respects skipFirst: false (saves on first render)', async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useDebouncedSave({ foo: 'a' }, persist, { skipFirst: false }));
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(persist).toHaveBeenCalledTimes(1);
  });
});
