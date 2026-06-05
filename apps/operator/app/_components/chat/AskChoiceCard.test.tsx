// @vitest-environment jsdom
/**
 * AskChoiceCard component tests — covers onResponse + Skip button.
 *
 * Plan: bespoke-card-improvements-2026-05-13.md §4.9 + §7.5
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';

afterEach(() => cleanup());

import { AskChoiceCard, type AskChoiceArgs } from './AskChoiceCard';

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

  it('renders a CardSpec.report body block between question and options', () => {
    const withReport: AskChoiceArgs = {
      ...args,
      report: {
        title: 'Fleet status',
        plans: [
          {
            title: 'Rate-limit v2',
            status: 'active',
            items: [{ id: 'P-001', text: 'Error classifier', status: 'done' }],
          },
        ],
      },
    };
    const { container } = render(<AskChoiceCard args={withReport} />);
    // The shared ReportBlockCard renders inside the ask-choice card body.
    expect(container.querySelector('.ask-choice-report .report-block-card')).toBeTruthy();
    expect(screen.getByText('Fleet status')).toBeTruthy();
    expect(screen.getByText('Error classifier')).toBeTruthy();
    // Options still render after the block.
    expect(optButton('Option A')).toBeTruthy();
  });

  it('renders no report block when args.report is absent', () => {
    const { container } = render(<AskChoiceCard args={args} />);
    expect(container.querySelector('.ask-choice-report')).toBeNull();
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

// Non-terminal "navigate" options (inbox-cards-unification Phase A / D-003):
// clicking one opens a sub-surface (💬 Chat / View log) and leaves the card
// live — it does NOT submit/answer.
describe('AskChoiceCard — non-terminal (navigate) options', () => {
  const navArgs: AskChoiceArgs = {
    question: 'Resolve or chat',
    options: [
      { id: 'resolve', label: 'Resolve', style: 'primary' },
      { id: 'chat', label: 'Chat', terminal: false },
    ],
  };

  it('non-terminal click fires {action:navigate} and does NOT submit', () => {
    const onResponse = vi.fn();
    render(<AskChoiceCard args={navArgs} onResponse={onResponse} />);
    fireEvent.click(optButton('Chat'));
    expect(onResponse).toHaveBeenCalledWith({ action: 'navigate', option_id: 'chat', label: 'Chat' });
    expect(onResponse).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'submit' }),
    );
  });

  it('card stays live after navigate — a terminal option still submits', () => {
    const onResponse = vi.fn();
    render(<AskChoiceCard args={navArgs} onResponse={onResponse} />);
    fireEvent.click(optButton('Chat'));
    fireEvent.click(optButton('Resolve'));
    expect(onResponse).toHaveBeenLastCalledWith({
      action: 'submit',
      picks: [{ option_id: 'resolve', label: 'Resolve' }],
    });
  });

  it('navigate renders as the quiet secondary nav-btn, not a terminal option', () => {
    render(<AskChoiceCard args={navArgs} onResponse={vi.fn()} />);
    expect((optButton('Chat') as HTMLElement).className).toContain('ask-choice-nav-btn');
  });

  it('legacy onAnswer does NOT fire on navigate (only submit)', () => {
    const onAnswer = vi.fn();
    render(<AskChoiceCard args={navArgs} onAnswer={onAnswer} onResponse={vi.fn()} />);
    fireEvent.click(optButton('Chat'));
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('answered state disables the navigate option too', () => {
    render(
      <AskChoiceCard
        args={navArgs}
        answered={{ picks: [{ option_id: 'resolve', label: 'Resolve' }], at: 0 }}
        onResponse={vi.fn()}
      />,
    );
    expect((optButton('Chat') as HTMLButtonElement).disabled).toBe(true);
  });

  it('multi-select ignores terminal flag — every option is a checkbox toggle', () => {
    render(<AskChoiceCard args={{ ...navArgs, multi: true }} onResponse={vi.fn()} />);
    // In multi mode the 'chat' option renders inline as a checkbox, not a nav-btn.
    expect(screen.getByRole('checkbox', { name: 'Chat' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Chat$/ })).toBeNull();
  });
});
