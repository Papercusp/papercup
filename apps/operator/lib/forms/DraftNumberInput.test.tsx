// @vitest-environment jsdom
/**
 * DraftNumberInput — the shared numeric commit-on-blur primitive behind
 * voice NumField, the user-page number overrides, and omp NumberControl.
 * Contract: typing never commits; blur/Enter commit only a finite, in-range,
 * changed number; invalid drafts are flagged inline and the committed value
 * holds; Escape reverts; external echoes adopt only while idle; emptyDraft
 * picks between "error" (a pref that always has a number) and "ignore"
 * (an optional override where empty means nothing entered).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DraftNumberInput } from './DraftNumberInput';

afterEach(cleanup);

function setup(props: Partial<Parameters<typeof DraftNumberInput>[0]> = {}) {
  const onCommit = vi.fn();
  render(<DraftNumberInput aria-label="num" value={30} min={20} max={500} onCommit={onCommit} {...props} />);
  return { onCommit, input: screen.getByLabelText('num') as HTMLInputElement };
}

describe('DraftNumberInput', () => {
  it('does not commit while typing', () => {
    const { onCommit, input } = setup();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '3' } });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('commits a changed in-range number on blur, and on Enter', () => {
    const { onCommit, input } = setup();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '35' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(35);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '40' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenLastCalledWith(40);
  });

  it('does not commit an unchanged value', () => {
    const { onCommit, input } = setup();
    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('blocks out-of-range: no commit, inline error, draft kept', () => {
    const { onCommit, input } = setup();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '9999' } });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/out of range \(20–500\)/);
    expect(input.value).toBe('9999');
  });

  it('reports one-sided bounds correctly', () => {
    const { input } = setup({ min: 20, max: undefined });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.blur(input);
    expect(screen.getByRole('alert').textContent).toMatch(/must be ≥ 20/);
  });

  it('emptyDraft=invalid (default): empty field errors instead of saving 0', () => {
    const { onCommit, input } = setup();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/not a number/);
  });

  it('emptyDraft=ignore: empty field is a silent no-op (optional override)', () => {
    const { onCommit, input } = setup({ emptyDraft: 'ignore', value: null });
    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
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
    const { rerender } = render(<DraftNumberInput aria-label="num" value={30} onCommit={onCommit} />);
    const input = screen.getByLabelText('num') as HTMLInputElement;
    rerender(<DraftNumberInput aria-label="num" value={45} onCommit={onCommit} />);
    expect(input.value).toBe('45');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '12' } });
    rerender(<DraftNumberInput aria-label="num" value={50} onCommit={onCommit} />);
    expect(input.value).toBe('12');
  });

  it('renders empty for an unset (null) value', () => {
    const onCommit = vi.fn();
    render(<DraftNumberInput aria-label="num" value={null} onCommit={onCommit} />);
    expect((screen.getByLabelText('num') as HTMLInputElement).value).toBe('');
  });
});
