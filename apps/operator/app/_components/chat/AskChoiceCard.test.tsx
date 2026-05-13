// @vitest-environment jsdom
/**
 * AskChoiceCard component tests — covers onResponse + Skip button.
 *
 * Plan: bespoke-card-improvements-2026-05-13.md §4.9 + §7.5
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';

afterEach(() => cleanup());

import { AskChoiceCard } from './AskChoiceCard';

const args = {
  question: 'Pick one',
  options: [
    { id: 'a', label: 'Option A' },
    { id: 'b', label: 'Option B' },
  ],
};

const optButton = (label: string) =>
  screen.getByRole('button', { name: new RegExp(`^${label}$`, 'i') });

describe('AskChoiceCard', () => {
  it('single-select: onResponse fires {action:submit, picks} on click', () => {
    const onResponse = vi.fn();
    render(<AskChoiceCard args={args} onResponse={onResponse} />);
    fireEvent.click(optButton('Option A'));
    expect(onResponse).toHaveBeenCalledWith({
      action: 'submit',
      picks: [{ option_id: 'a', label: 'Option A' }],
    });
  });

  it('legacy onAnswer prop still receives picks on submit', () => {
    const onAnswer = vi.fn();
    render(<AskChoiceCard args={args} onAnswer={onAnswer} />);
    fireEvent.click(optButton('Option B'));
    expect(onAnswer).toHaveBeenCalledWith({
      picks: [{ option_id: 'b', label: 'Option B' }],
    });
  });

  it('both onResponse and onAnswer fire on submit (bridge)', () => {
    const onResponse = vi.fn();
    const onAnswer = vi.fn();
    render(<AskChoiceCard args={args} onResponse={onResponse} onAnswer={onAnswer} />);
    fireEvent.click(optButton('Option A'));
    expect(onResponse).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledTimes(1);
  });

  it('single-select: Skip link renders when allowDecline (default) and fires decline', () => {
    const onResponse = vi.fn();
    render(<AskChoiceCard args={args} onResponse={onResponse} />);
    const skip = screen.getByRole('button', { name: /Skip this question/i });
    fireEvent.click(skip);
    expect(onResponse).toHaveBeenCalledWith({ action: 'decline' });
  });

  it('single-select: Skip link hidden when allowDecline=false', () => {
    const onResponse = vi.fn();
    render(<AskChoiceCard args={args} onResponse={onResponse} allowDecline={false} />);
    expect(screen.queryByRole('button', { name: /Skip/i })).toBeNull();
  });

  it('multi-select: Skip button next to Submit; fires decline (no picks)', () => {
    const onResponse = vi.fn();
    render(<AskChoiceCard args={{ ...args, multi: true }} onResponse={onResponse} />);
    const skip = screen.getByRole('button', { name: /^Skip$/ });
    fireEvent.click(skip);
    expect(onResponse).toHaveBeenCalledWith({ action: 'decline' });
  });

  it('multi-select: Submit fires {action:submit} with toggled picks', () => {
    const onResponse = vi.fn();
    render(<AskChoiceCard args={{ ...args, multi: true }} onResponse={onResponse} />);
    // Multi-select renders each option as role=checkbox, not button.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Option A' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Option B' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(onResponse).toHaveBeenCalledWith({
      action: 'submit',
      picks: [
        { option_id: 'a', label: 'Option A' },
        { option_id: 'b', label: 'Option B' },
      ],
    });
  });

  it('answered state: buttons disabled, picked option highlighted', () => {
    const onResponse = vi.fn();
    render(
      <AskChoiceCard
        args={args}
        answered={{ picks: [{ option_id: 'a', label: 'Option A' }], at: 0 }}
        onResponse={onResponse}
      />,
    );
    const a = optButton('Option A') as HTMLButtonElement;
    expect(a.disabled).toBe(true);
    fireEvent.click(a);
    expect(onResponse).not.toHaveBeenCalled();
  });

  it('answered + disableWhenAnswered=false keeps onResponse callable (replay mode)', () => {
    const onResponse = vi.fn();
    render(
      <AskChoiceCard
        args={args}
        answered={{ picks: [{ option_id: 'a', label: 'Option A' }], at: 0 }}
        onResponse={onResponse}
        disableWhenAnswered={false}
      />,
    );
    fireEvent.click(optButton('Option B'));
    expect(onResponse).toHaveBeenCalled();
  });
});
