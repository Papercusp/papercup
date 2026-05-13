/**
 * @vitest-environment jsdom
 *
 * Tests for useNavHistory. Uses @testing-library/react's renderHook to
 * drive React state updates in jsdom.
 */

import { describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useNavHistory } from './useNavHistory';

type Route = { doc: string };

function makeStorage(initialParams: Record<string, unknown> = {}) {
  let params = { ...initialParams };
  const setParams = vi.fn((next: Record<string, unknown>) => {
    params = { ...params, ...next };
  });
  return {
    get params() { return params; },
    setParams,
    snapshot: () => ({ ...params }),
  };
}

describe('useNavHistory', () => {
  it('initializes with single-entry history at cursor 0', () => {
    const store = makeStorage();
    const { result } = renderHook(() =>
      useNavHistory<Route>({ doc: 'a' }, { params: store.params, setParams: store.setParams }),
    );
    expect(result.current.current).toEqual({ doc: 'a' });
    expect(result.current.canBack).toBe(false);
    expect(result.current.canForward).toBe(false);
  });

  it('push grows stack and advances cursor', () => {
    const store = makeStorage();
    const { result, rerender } = renderHook(
      ({ params }) => useNavHistory<Route>({ doc: 'a' }, { params, setParams: store.setParams }),
      { initialProps: { params: store.params } },
    );
    act(() => result.current.push({ doc: 'b' }));
    rerender({ params: store.params });
    expect(result.current.current).toEqual({ doc: 'b' });
    expect(result.current.canBack).toBe(true);
    expect(result.current.canForward).toBe(false);
  });

  it('back moves cursor, forward returns', () => {
    const store = makeStorage();
    const { result, rerender } = renderHook(
      ({ params }) => useNavHistory<Route>({ doc: 'a' }, { params, setParams: store.setParams }),
      { initialProps: { params: store.params } },
    );
    act(() => result.current.push({ doc: 'b' }));
    rerender({ params: store.params });
    act(() => result.current.push({ doc: 'c' }));
    rerender({ params: store.params });
    act(() => result.current.back());
    rerender({ params: store.params });
    expect(result.current.current).toEqual({ doc: 'b' });
    expect(result.current.canForward).toBe(true);
    act(() => result.current.forward());
    rerender({ params: store.params });
    expect(result.current.current).toEqual({ doc: 'c' });
  });

  it('push after back truncates forward tail (browser semantics)', () => {
    const store = makeStorage();
    const { result, rerender } = renderHook(
      ({ params }) => useNavHistory<Route>({ doc: 'a' }, { params, setParams: store.setParams }),
      { initialProps: { params: store.params } },
    );
    act(() => result.current.push({ doc: 'b' }));
    rerender({ params: store.params });
    act(() => result.current.push({ doc: 'c' }));
    rerender({ params: store.params });
    act(() => result.current.back());
    rerender({ params: store.params });
    act(() => result.current.push({ doc: 'x' }));
    rerender({ params: store.params });
    expect(result.current.current).toEqual({ doc: 'x' });
    expect(result.current.canForward).toBe(false);
  });

  it('back is no-op at start', () => {
    const store = makeStorage();
    const { result, rerender } = renderHook(
      ({ params }) => useNavHistory<Route>({ doc: 'a' }, { params, setParams: store.setParams }),
      { initialProps: { params: store.params } },
    );
    act(() => result.current.back());
    rerender({ params: store.params });
    expect(result.current.current).toEqual({ doc: 'a' });
    expect(result.current.canBack).toBe(false);
  });

  it('replace mutates current entry without growing stack', () => {
    const store = makeStorage();
    const { result, rerender } = renderHook(
      ({ params }) => useNavHistory<Route>({ doc: 'a' }, { params, setParams: store.setParams }),
      { initialProps: { params: store.params } },
    );
    act(() => result.current.push({ doc: 'b' }));
    rerender({ params: store.params });
    act(() => result.current.replace({ doc: 'b2' }));
    rerender({ params: store.params });
    expect(result.current.current).toEqual({ doc: 'b2' });
    expect(result.current.canBack).toBe(true);
    // Cursor still at 1 (didn't grow).
    act(() => result.current.back());
    rerender({ params: store.params });
    expect(result.current.current).toEqual({ doc: 'a' });
  });

  it('reset wipes history to single entry', () => {
    const store = makeStorage();
    const { result, rerender } = renderHook(
      ({ params }) => useNavHistory<Route>({ doc: 'a' }, { params, setParams: store.setParams }),
      { initialProps: { params: store.params } },
    );
    act(() => result.current.push({ doc: 'b' }));
    rerender({ params: store.params });
    act(() => result.current.push({ doc: 'c' }));
    rerender({ params: store.params });
    act(() => result.current.reset({ doc: 'z' }));
    rerender({ params: store.params });
    expect(result.current.current).toEqual({ doc: 'z' });
    expect(result.current.canBack).toBe(false);
    expect(result.current.canForward).toBe(false);
  });

  it('enforces capacity by dropping oldest', () => {
    const store = makeStorage();
    const cap = 3;
    const { result, rerender } = renderHook(
      ({ params }) =>
        useNavHistory<Route>(
          { doc: 'a' },
          { params, setParams: store.setParams, capacity: cap },
        ),
      { initialProps: { params: store.params } },
    );
    act(() => result.current.push({ doc: 'b' }));
    rerender({ params: store.params });
    act(() => result.current.push({ doc: 'c' }));
    rerender({ params: store.params });
    act(() => result.current.push({ doc: 'd' })); // 'a' should drop
    rerender({ params: store.params });
    expect(result.current.current).toEqual({ doc: 'd' });
    act(() => result.current.back());
    rerender({ params: store.params });
    act(() => result.current.back());
    rerender({ params: store.params });
    expect(result.current.current).toEqual({ doc: 'b' });
    expect(result.current.canBack).toBe(false);
  });

  it('hydrates from existing params.history', () => {
    const store = makeStorage({
      history: { stack: [{ doc: 'x' }, { doc: 'y' }, { doc: 'z' }], cursor: 1 },
    });
    const { result } = renderHook(() =>
      useNavHistory<Route>(
        { doc: 'fallback' },
        { params: store.params, setParams: store.setParams },
      ),
    );
    expect(result.current.current).toEqual({ doc: 'y' });
    expect(result.current.canBack).toBe(true);
    expect(result.current.canForward).toBe(true);
  });

  it('clamps an out-of-bounds saved cursor', () => {
    const store = makeStorage({
      history: { stack: [{ doc: 'x' }, { doc: 'y' }], cursor: 99 },
    });
    const { result } = renderHook(() =>
      useNavHistory<Route>(
        { doc: 'fallback' },
        { params: store.params, setParams: store.setParams },
      ),
    );
    expect(result.current.current).toEqual({ doc: 'y' });
  });

  it('ignores garbage saved history shape', () => {
    const store = makeStorage({ history: 'not-an-object' });
    const { result } = renderHook(() =>
      useNavHistory<Route>(
        { doc: 'fallback' },
        { params: store.params, setParams: store.setParams },
      ),
    );
    expect(result.current.current).toEqual({ doc: 'fallback' });
  });
});
