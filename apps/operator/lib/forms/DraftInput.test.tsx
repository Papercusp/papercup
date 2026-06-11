// @vitest-environment jsdom
/**
 * DraftInput — commit-on-blur semantics for auto-save settings pages.
 * The contract: typing never reaches onCommit; blur/Enter commit only a
 * VALID, changed draft; an invalid draft is flagged and the committed
 * value stays untouched; Escape reverts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DraftInput, DraftTextarea } from './DraftInput';

afterEach(cleanup);

const notFable = (d: string) => (d === 'bad' ? 'value is bad' : null);

function setup(props: Partial<Parameters<typeof DraftInput>[0]> = {}) {
  const onCommit = vi.fn();
  render(<DraftInput aria-label="field" value="initial" onCommit={onCommit} validate={notFable} {...props} />);
  return { onCommit, input: screen.getByLabelText('field') as HTMLInputElement };
}

describe('DraftInput', () => {
  it('does not commit while typing', () => {
    const { onCommit, input } = setup();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'draft' } });
    expect(input.value).toBe('draft');
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('commits a changed valid draft on blur', () => {
    const { onCommit, input } = setup();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'edited' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('edited');
  });

  it('commits on Enter', () => {
    const { onCommit, input } = setup();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'edited' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('edited');
  });

  it('does not commit an unchanged draft on blur', () => {
    const { onCommit, input } = setup();
    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('blocks an invalid draft: no commit, error shown after the blur attempt', () => {
    const { onCommit, input } = setup();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'bad' } });
    // No error flash mid-edit before a commit attempt.
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('value is bad');
    // The draft stays visible so the user can fix it.
    expect(input.value).toBe('bad');
  });

  it('clears the flag the moment the draft validates again', () => {
    const { input } = setup();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'bad' } });
    fireEvent.blur(input);
    expect(screen.getByRole('alert')).toBeTruthy();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'good' } });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('Escape reverts the draft to the committed value', () => {
    const { onCommit, input } = setup();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'oops' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('initial');
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('adopts an external value change while idle, not mid-edit', () => {
    const onCommit = vi.fn();
    const { rerender } = render(
      <DraftInput aria-label="field" value="one" onCommit={onCommit} />,
    );
    const input = screen.getByLabelText('field') as HTMLInputElement;
    // Idle: hydration / reset adopts.
    rerender(<DraftInput aria-label="field" value="two" onCommit={onCommit} />);
    expect(input.value).toBe('two');
    // Mid-edit: external churn must not eat keystrokes.
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'typing' } });
    rerender(<DraftInput aria-label="field" value="three" onCommit={onCommit} />);
    expect(input.value).toBe('typing');
  });
});

describe('DraftTextarea', () => {
  it('commits on blur and keeps Enter for newlines', () => {
    const onCommit = vi.fn();
    render(<DraftTextarea aria-label="area" value="" onCommit={onCommit} />);
    const area = screen.getByLabelText('area') as HTMLTextAreaElement;
    fireEvent.focus(area);
    fireEvent.change(area, { target: { value: 'line' } });
    fireEvent.keyDown(area, { key: 'Enter' });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.blur(area);
    expect(onCommit).toHaveBeenCalledWith('line');
  });
});
