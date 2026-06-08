// @vitest-environment jsdom
/**
 * Tests for usePromptDialog — the imperative `window.prompt()` replacement.
 *
 * Parallel to useConfirmDialog but resolves to the typed string (or null on
 * cancel). Contract under test:
 *  - `prompt()` opens the dialog (element non-null, every option forwarded
 *    to PromptModal incl. the `validate` predicate);
 *  - the modal's `onSubmit(value)` resolves the promise to that value;
 *  - dismissal (`onOpenChange(false)`) resolves `null`;
 *  - a rapid re-open resolves the PRIOR promise as `null` before swapping
 *    in the new dialog;
 *  - focus returns to the triggering element after close.
 *
 * Driven through the element's wired callbacks (no Radix mount) so it stays
 * deterministic + console-clean under setup-fail-on-console.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { usePromptDialog } from './usePromptDialog';

afterEach(() => cleanup());

/** Shape of the props the hook wires onto the rendered <PromptModal>. */
interface PromptModalProps {
  open: boolean;
  title: string;
  label: string;
  body?: ReactNode;
  defaultValue?: string;
  placeholder?: string;
  submitLabel?: string;
  cancelLabel?: string;
  allowEmpty?: boolean;
  validate?: (value: string) => string | null;
  onSubmit: (value: string) => void;
  onOpenChange: (open: boolean) => void;
}

function propsOf(element: ReactNode): PromptModalProps | null {
  if (!element || typeof element !== 'object') return null;
  return (element as { props: PromptModalProps }).props;
}

describe('usePromptDialog', () => {
  it('renders no dialog until prompt() is called', () => {
    const { result } = renderHook(() => usePromptDialog());
    expect(result.current.element).toBeNull();
  });

  it('opens the dialog and forwards every option to PromptModal', () => {
    const validate = (v: string) => (v.length > 64 ? 'Max 64 chars' : null);
    const { result } = renderHook(() => usePromptDialog());
    act(() => {
      void result.current.prompt({
        title: 'Rename workspace',
        label: 'New name',
        defaultValue: 'old-name',
        placeholder: 'type a name',
        submitLabel: 'Rename',
        cancelLabel: 'Keep',
        allowEmpty: true,
        validate,
      });
    });
    const p = propsOf(result.current.element);
    expect(p).not.toBeNull();
    expect(p!.open).toBe(true);
    expect(p!.title).toBe('Rename workspace');
    expect(p!.label).toBe('New name');
    expect(p!.defaultValue).toBe('old-name');
    expect(p!.placeholder).toBe('type a name');
    expect(p!.submitLabel).toBe('Rename');
    expect(p!.cancelLabel).toBe('Keep');
    expect(p!.allowEmpty).toBe(true);
    // The validate predicate is passed straight through (the modal owns
    // when to run it).
    expect(p!.validate).toBe(validate);
  });

  it('resolves the promise to the submitted value and closes', async () => {
    const { result } = renderHook(() => usePromptDialog());
    let promise!: Promise<string | null>;
    act(() => {
      promise = result.current.prompt({ title: 'Name', label: 'Name' });
    });
    act(() => {
      propsOf(result.current.element)!.onSubmit('hello-world');
    });
    await expect(promise).resolves.toBe('hello-world');
    expect(result.current.element).toBeNull();
  });

  it('resolves null and closes when dismissed', async () => {
    const { result } = renderHook(() => usePromptDialog());
    let promise!: Promise<string | null>;
    act(() => {
      promise = result.current.prompt({ title: 'Name', label: 'Name' });
    });
    act(() => {
      propsOf(result.current.element)!.onOpenChange(false);
    });
    await expect(promise).resolves.toBeNull();
    expect(result.current.element).toBeNull();
  });

  it('preserves an empty-string submission distinct from cancel', async () => {
    const { result } = renderHook(() => usePromptDialog());
    let promise!: Promise<string | null>;
    act(() => {
      promise = result.current.prompt({ title: 'Name', label: 'Name', allowEmpty: true });
    });
    act(() => {
      propsOf(result.current.element)!.onSubmit('');
    });
    // '' is a submitted value, NOT a cancel (which would be null).
    await expect(promise).resolves.toBe('');
  });

  it('resolves a prior pending prompt as null when re-opened', async () => {
    const { result } = renderHook(() => usePromptDialog());
    let first!: Promise<string | null>;
    act(() => {
      first = result.current.prompt({ title: 'First', label: 'L1' });
    });
    let second!: Promise<string | null>;
    act(() => {
      second = result.current.prompt({ title: 'Second', label: 'L2' });
    });
    await expect(first).resolves.toBeNull();
    expect(propsOf(result.current.element)!.title).toBe('Second');
    act(() => {
      propsOf(result.current.element)!.onSubmit('done');
    });
    await expect(second).resolves.toBe('done');
  });

  it('keeps a stable prompt identity across renders', () => {
    const { result, rerender } = renderHook(() => usePromptDialog());
    const first = result.current.prompt;
    rerender();
    expect(result.current.prompt).toBe(first);
  });

  it('restores focus to the triggering element after close', async () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const { result } = renderHook(() => usePromptDialog());
    let promise!: Promise<string | null>;
    act(() => {
      promise = result.current.prompt({ title: 'Name', label: 'Name' });
    });
    act(() => {
      propsOf(result.current.element)!.onSubmit('x');
    });
    await promise;
    await act(async () => {
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    });
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('does not call validate itself (modal owns invocation)', () => {
    const validate = vi.fn((v: string) => null);
    const { result } = renderHook(() => usePromptDialog());
    act(() => {
      void result.current.prompt({ title: 'Name', label: 'Name', validate });
    });
    expect(validate).not.toHaveBeenCalled();
  });
});
