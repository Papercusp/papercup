// @vitest-environment jsdom
/**
 * Select.test.tsx — the Radix Select wrapper's OWN logic: the empty-value
 * defensive filter (Radix throws on a '' Item value), flat-vs-group rendering
 * (the `kind:'group'` discriminant), disabled passthrough, the aria-label on the
 * trigger, and the onChange → onValueChange wiring.
 *
 * @radix-ui/react-select is mocked to inert passthroughs so the items render
 * inline (no portal / open-state machine) — this isolates the wrapper's mapping
 * logic deterministically instead of driving Radix's flaky jsdom open behavior.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('@radix-ui/react-select', () => ({
  Root: ({ children, onValueChange }: { children: ReactNode; onValueChange: (v: string) => void }) => (
    <div>{children}<button data-testid="fire-change" onClick={() => onValueChange('picked')} /></div>
  ),
  Trigger: ({ children, ...rest }: { children: ReactNode } & Record<string, unknown>) => (
    <button aria-label={rest['aria-label'] as string} data-testid={rest['data-testid'] as string} id={rest.id as string}>{children}</button>
  ),
  Value: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
  Icon: ({ children }: { children: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children: ReactNode }) => <>{children}</>,
  Content: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Viewport: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Group: ({ children }: { children: ReactNode }) => <div role="group">{children}</div>,
  Label: ({ children }: { children: ReactNode }) => <div data-testid="group-label">{children}</div>,
  Item: ({ children, value, disabled }: { children: ReactNode; value: string; disabled?: boolean }) => (
    <div role="option" data-value={value} aria-disabled={disabled || undefined}>{children}</div>
  ),
  ItemText: ({ children }: { children: ReactNode }) => <>{children}</>,
  ItemIndicator: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { Select } from './Select';

afterEach(cleanup);

describe('Select', () => {
  it('renders the trigger with the aria-label', () => {
    render(<Select value="a" onChange={() => {}} ariaLabel="Pick one" options={[{ value: 'a', label: 'A' }]} />);
    expect(screen.getByLabelText('Pick one')).toBeTruthy();
  });

  it('renders flat options and drops empty-value ones (the Radix crash guard)', () => {
    render(
      <Select
        value="a"
        onChange={() => {}}
        options={[{ value: '', label: 'none' }, { value: 'a', label: 'A' }, { value: 'b', label: 'B' }]}
      />,
    );
    const opts = screen.getAllByRole('option');
    expect(opts.map((o) => o.getAttribute('data-value'))).toEqual(['a', 'b']);
  });

  it('renders groups with their label, filtering empty options inside the group', () => {
    render(
      <Select
        value="g1a"
        onChange={() => {}}
        options={[
          { kind: 'group', label: 'Group One', options: [{ value: '', label: 'skip' }, { value: 'g1a', label: 'G1A' }] },
          { value: 'flat', label: 'Flat' },
        ]}
      />,
    );
    expect(screen.getByTestId('group-label').textContent).toBe('Group One');
    expect(screen.getByRole('group')).toBeTruthy();
    expect(screen.getAllByRole('option').map((o) => o.getAttribute('data-value'))).toEqual(['g1a', 'flat']);
  });

  it('passes the disabled flag through to the option', () => {
    render(<Select value="a" onChange={() => {}} options={[{ value: 'a', label: 'A', disabled: true }]} />);
    expect(screen.getByRole('option').getAttribute('aria-disabled')).toBe('true');
  });

  it('wires onChange to the Radix onValueChange', () => {
    const onChange = vi.fn();
    render(<Select value="a" onChange={onChange} options={[{ value: 'a', label: 'A' }]} />);
    fireEvent.click(screen.getByTestId('fire-change'));
    expect(onChange).toHaveBeenCalledWith('picked');
  });
});
