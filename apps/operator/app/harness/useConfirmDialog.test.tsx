// @vitest-environment jsdom
/**
 * Tests for useConfirmDialog — the imperative `window.confirm()` replacement.
 *
 * The hook's whole contract is the promise plumbing + the `<ConfirmModal>`
 * element it hands back:
 *  - `confirm()` opens the dialog (element becomes non-null and forwards
 *    every option through to ConfirmModal's props);
 *  - the modal's `onConfirm` resolves the promise `true` and unmounts it;
 *  - dismissal (`onOpenChange(false)`) resolves `false` and unmounts it;
 *  - a rapid re-open resolves the PRIOR promise as `false` before swapping
 *    in the new dialog (never leaves a dangling promise);
 *  - focus returns to the triggering element after close.
 *
 * Driven through the element's wired callbacks rather than mounting Radix,
 * so it's deterministic + console-clean under setup-fail-on-console.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useConfirmDialog } from './useConfirmDialog';

afterEach(() => cleanup());

/** Shape of the props the hook wires onto the rendered <ConfirmModal>. */
interface ConfirmModalProps {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  requireType?: string;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
}

/** Read the props off the returned element, or null when no dialog is open. */
function propsOf(element: ReactNode): ConfirmModalProps | null {
  if (!element || typeof element !== 'object') return null;
  return (element as { props: ConfirmModalProps }).props;
}

describe('useConfirmDialog', () => {
  it('renders no dialog until confirm() is called', () => {
    const { result } = renderHook(() => useConfirmDialog());
    expect(result.current.element).toBeNull();
    expect(propsOf(result.current.element)).toBeNull();
  });

  it('opens the dialog and forwards every option to ConfirmModal', () => {
    const { result } = renderHook(() => useConfirmDialog());
    act(() => {
      void result.current.confirm({
        title: 'Disable plugin?',
        body: 'The config is preserved.',
        confirmLabel: 'Disable',
        cancelLabel: 'Keep',
        destructive: true,
        requireType: 'DISABLE',
      });
    });
    const p = propsOf(result.current.element);
    expect(p).not.toBeNull();
    expect(p!.open).toBe(true);
    expect(p!.title).toBe('Disable plugin?');
    expect(p!.body).toBe('The config is preserved.');
    expect(p!.confirmLabel).toBe('Disable');
    expect(p!.cancelLabel).toBe('Keep');
    expect(p!.destructive).toBe(true);
    expect(p!.requireType).toBe('DISABLE');
  });

  it('leaves optional fields undefined when omitted', () => {
    const { result } = renderHook(() => useConfirmDialog());
    act(() => {
      void result.current.confirm({ title: 'Sure?', body: 'Body' });
    });
    const p = propsOf(result.current.element)!;
    expect(p.confirmLabel).toBeUndefined();
    expect(p.destructive).toBeUndefined();
    expect(p.requireType).toBeUndefined();
  });

  it('resolves the promise true and closes when confirmed', async () => {
    const { result } = renderHook(() => useConfirmDialog());
    let promise!: Promise<boolean>;
    act(() => {
      promise = result.current.confirm({ title: 'Go?', body: 'Body' });
    });
    act(() => {
      propsOf(result.current.element)!.onConfirm();
    });
    await expect(promise).resolves.toBe(true);
    expect(result.current.element).toBeNull();
  });

  it('resolves the promise false and closes when dismissed', async () => {
    const { result } = renderHook(() => useConfirmDialog());
    let promise!: Promise<boolean>;
    act(() => {
      promise = result.current.confirm({ title: 'Go?', body: 'Body' });
    });
    act(() => {
      // onOpenChange(false) is the overlay/Esc dismissal path.
      propsOf(result.current.element)!.onOpenChange(false);
    });
    await expect(promise).resolves.toBe(false);
    expect(result.current.element).toBeNull();
  });

  it('resolves a prior pending confirm as false when re-opened', async () => {
    const { result } = renderHook(() => useConfirmDialog());
    let first!: Promise<boolean>;
    act(() => {
      first = result.current.confirm({ title: 'First', body: 'B1' });
    });
    let second!: Promise<boolean>;
    act(() => {
      second = result.current.confirm({ title: 'Second', body: 'B2' });
    });
    // The first promise is auto-cancelled (false); the live dialog is now
    // the second one.
    await expect(first).resolves.toBe(false);
    expect(propsOf(result.current.element)!.title).toBe('Second');
    act(() => {
      propsOf(result.current.element)!.onConfirm();
    });
    await expect(second).resolves.toBe(true);
  });

  it('keeps a stable confirm identity across renders', () => {
    const { result, rerender } = renderHook(() => useConfirmDialog());
    const first = result.current.confirm;
    rerender();
    expect(result.current.confirm).toBe(first);
  });

  it('restores focus to the triggering element after close', async () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const { result } = renderHook(() => useConfirmDialog());
    let promise!: Promise<boolean>;
    act(() => {
      promise = result.current.confirm({ title: 'Go?', body: 'Body' });
    });
    act(() => {
      propsOf(result.current.element)!.onConfirm();
    });
    await promise;
    // close() restores focus on the next animation frame.
    await act(async () => {
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    });
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});
