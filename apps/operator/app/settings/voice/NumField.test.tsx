// @vitest-environment jsdom
/**
 * NumField — commit-on-blur number field with range validation.
 * Regression suite for the /settings/voice keystroke-save bug (2026-06-12):
 * typing must never commit, out-of-range/NaN drafts must be flagged and held
 * (the old inputs clamped and PUT on every keystroke), and an external value
 * echo must not eat in-progress edits.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NumField } from './NumField';

afterEach(cleanup);

function setup(props: Partial<Parameters<typeof NumField>[0]> = {}) {
  const onCommit = vi.fn();
  render(<NumField label="field" value={30} min={20} max={500} onCommit={onCommit} {...props} />);
  return { onCommit, input: screen.getByLabelText('field') as HTMLInputElement };
}

describe('NumField', () => {
  it('does not commit while typing', () => {
    const { onCommit, input } = setup();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '3' } }); // mid-typing toward 35
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('commits a changed in-range number on blur', () => {
    const { onCommit, input } = setup();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '35' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(35);
  });

  it('commits on Enter', () => {
    const { onCommit, input } = setup();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '40' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith(40);
  });

  it('does not commit an unchanged value on blur', () => {
    const { onCommit, input } = setup();
    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('blocks an out-of-range value: no commit, inline error, draft kept', () => {
    const { onCommit, input } = setup();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '9999' } });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/out of range \(20–500\)/);
    expect(input.value).toBe('9999');
  });

  it('blocks an empty/NaN draft (the old code saved 0 for an empty field)', () => {
    const { onCommit, input } = setup();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/not a number/);
  });

  it('Escape reverts the draft and clears the error', () => {
    const { onCommit, input } = setup();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '9999' } });
    fireEvent.blur(input);
    expect(screen.getByRole('alert')).toBeTruthy();
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('30');
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('adopts an external value change while idle, not mid-edit', () => {
    const onCommit = vi.fn();
    const { rerender } = render(<NumField label="field" value={30} onCommit={onCommit} />);
    const input = screen.getByLabelText('field') as HTMLInputElement;
    // Idle: a peer field's save echoes the whole prefs object back — adopt.
    rerender(<NumField label="field" value={45} onCommit={onCommit} />);
    expect(input.value).toBe('45');
    // Mid-edit: the echo must not eat keystrokes.
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '12' } });
    rerender(<NumField label="field" value={50} onCommit={onCommit} />);
    expect(input.value).toBe('12');
  });
});
