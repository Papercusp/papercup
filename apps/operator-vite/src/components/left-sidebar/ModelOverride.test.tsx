// @vitest-environment jsdom
/**
 * ModelOverride — the session-only per-agent model override control shared by the
 * Sentinel + Overwatch tabs (model-override-sidebar-2026-06-23). Covers the pure
 * spec split/join, the sentinel round-trip for the two "unset" choices, and the
 * override/default indicator + write wiring.
 *
 * The control renders the shared `Select` primitive (design-simplification P-009
 * retired its native <select>s). `@radix-ui/react-select` is mocked to inert
 * passthroughs — the same pattern harness/Select.test.tsx uses — so options render
 * inline and a pick is a plain click, instead of driving Radix's flaky jsdom
 * open-state machine.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, within } from '@testing-library/react';

vi.mock('@radix-ui/react-select', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  const Ctx = React.createContext<{ value: string; disabled?: boolean; onValueChange: (v: string) => void }>({
    value: '',
    onValueChange: () => {},
  });
  type Kids = { children?: React.ReactNode };
  return {
    Root: ({ children, value, onValueChange, disabled }: Kids & { value: string; onValueChange: (v: string) => void; disabled?: boolean }) => (
      <Ctx.Provider value={{ value, onValueChange, disabled }}>
        <div data-rs-root="">{children}</div>
      </Ctx.Provider>
    ),
    Trigger: ({ children, ...rest }: Kids & Record<string, unknown>) => {
      const { value, disabled } = React.useContext(Ctx);
      return (
        <button
          type="button"
          aria-label={rest['aria-label'] as string}
          className={rest.className as string}
          data-value={value}
          disabled={disabled}
        >
          {children}
        </button>
      );
    },
    Value: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
    Icon: ({ children }: Kids) => <>{children}</>,
    Portal: ({ children }: Kids) => <>{children}</>,
    Content: ({ children }: Kids) => <div>{children}</div>,
    Viewport: ({ children }: Kids) => <div>{children}</div>,
    Group: ({ children }: Kids) => <div role="group">{children}</div>,
    Label: ({ children }: Kids) => <div>{children}</div>,
    Item: ({ children, value, disabled }: Kids & { value: string; disabled?: boolean }) => {
      const { onValueChange } = React.useContext(Ctx);
      return (
        <button type="button" role="option" data-value={value} disabled={disabled} onClick={() => onValueChange(value)}>
          {children}
        </button>
      );
    },
    ItemText: ({ children }: Kids) => <>{children}</>,
    ItemIndicator: ({ children }: Kids) => <>{children}</>,
  };
});

import ModelOverride, { splitSpec, joinSpec, NO_MODEL, NO_EFFORT } from './ModelOverride';

afterEach(cleanup);

/** The picker trigger for `label`, and the Select subtree that owns its options. */
function picker(label: string) {
  const trigger = screen.getByLabelText(label);
  const root = trigger.closest('[data-rs-root]') as HTMLElement;
  return { trigger, root };
}

describe('splitSpec / joinSpec', () => {
  it('splits model[:effort] and round-trips', () => {
    expect(splitSpec('opus:high')).toEqual({ model: 'opus', effort: 'high' });
    expect(splitSpec('sonnet')).toEqual({ model: 'sonnet', effort: '' });
    expect(splitSpec(null)).toEqual({ model: '', effort: '' });
    expect(joinSpec('opus', 'high')).toBe('opus:high');
    expect(joinSpec('sonnet', '')).toBe('sonnet');
    expect(joinSpec('', 'high')).toBeNull(); // no model ⇒ no override
  });
});

describe('ModelOverride control', () => {
  it('shows "workspace default" and an unset picker when not overridden', () => {
    render(<ModelOverride label="Sentinel model" override={null} onWrite={() => {}} busy={false} />);
    expect(screen.getByText('workspace default')).toBeTruthy();
    expect(picker('Sentinel model — model').trigger.getAttribute('data-value')).toBe(NO_MODEL);
    expect(picker('Sentinel model — effort').trigger.getAttribute('data-value')).toBe(NO_EFFORT);
    // No reset (OverridableSetting shows the reset only while overridden).
    expect(screen.queryByRole('button', { name: /reset/i })).toBeNull();
  });

  it('disables the effort picker until a model is chosen', () => {
    render(<ModelOverride label="Sentinel model" override={null} onWrite={() => {}} busy={false} />);
    expect((picker('Sentinel model — effort').trigger as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    render(<ModelOverride label="Sentinel model" override={'opus'} onWrite={() => {}} busy={false} />);
    expect((picker('Sentinel model — effort').trigger as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows "session override" + the model/effort when overridden', () => {
    render(<ModelOverride label="Sentinel model" override={'opus:high'} onWrite={() => {}} busy={false} />);
    expect(screen.getByText('session override')).toBeTruthy();
    expect(picker('Sentinel model — model').trigger.getAttribute('data-value')).toBe('opus');
    expect(picker('Sentinel model — effort').trigger.getAttribute('data-value')).toBe('high');
  });

  it('writes the joined spec when the model changes', () => {
    const onWrite = vi.fn();
    render(<ModelOverride label="Sentinel model" override={null} onWrite={onWrite} busy={false} />);
    const { root } = picker('Sentinel model — model');
    fireEvent.click(within(root).getByRole('option', { name: 'sonnet' }));
    expect(onWrite).toHaveBeenCalledWith('sonnet');
  });

  it('preserves the model when only the effort changes', () => {
    const onWrite = vi.fn();
    render(<ModelOverride label="Overwatch model" override={'opus'} onWrite={onWrite} busy={false} />);
    const { root } = picker('Overwatch model — effort');
    fireEvent.click(within(root).getByRole('option', { name: 'effort: xhigh' }));
    expect(onWrite).toHaveBeenCalledWith('opus:xhigh');
  });

  it('clears the override when the model picker returns to (workspace default)', () => {
    const onWrite = vi.fn();
    render(<ModelOverride label="Sentinel model" override={'opus:high'} onWrite={onWrite} busy={false} />);
    const { root } = picker('Sentinel model — model');
    fireEvent.click(within(root).getByRole('option', { name: '(workspace default)' }));
    expect(onWrite).toHaveBeenCalledWith(null);
  });

  it('drops the effort back to the model default via "effort: default"', () => {
    const onWrite = vi.fn();
    render(<ModelOverride label="Sentinel model" override={'opus:high'} onWrite={onWrite} busy={false} />);
    const { root } = picker('Sentinel model — effort');
    fireEvent.click(within(root).getByRole('option', { name: 'effort: default' }));
    expect(onWrite).toHaveBeenCalledWith('opus');
  });

  it('clears the override via reset', () => {
    const onWrite = vi.fn();
    render(<ModelOverride label="Sentinel model" override={'opus:high'} onWrite={onWrite} busy={false} />);
    fireEvent.click(screen.getByRole('button', { name: /reset Sentinel model to default/i }));
    expect(onWrite).toHaveBeenCalledWith(null);
  });
});
