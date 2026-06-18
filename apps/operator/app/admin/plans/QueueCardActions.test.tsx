// @vitest-environment jsdom
/**
 * Tests for <QueueCardActions> — the Queue detail-pane action buttons.
 *
 * Pure presentational: options → buttons, with the terminal-vs-navigational
 * dispatch (terminal fires `submit` with picks; terminal:false fires
 * `navigate`), the busy→disabled state, the per-option style class + --nav
 * marker, and the answered→"✓ picks" collapse.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { QueueCardActions } from './QueueCardActions';
import type { AskChoiceArgs, AskChoiceAnswered } from '@/app/_components/chat/AskChoiceCard';

afterEach(() => cleanup());

type Opt = AskChoiceArgs['options'][number];
const opt = (o: Opt): Opt => o;

describe('QueueCardActions', () => {
  it('renders nothing when there are no options', () => {
    const { container } = render(<QueueCardActions options={[]} onResponse={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('collapses to a ✓ summary once answered', () => {
    const answered: AskChoiceAnswered = {
      picks: [
        { option_id: 'a', label: 'Resolve' },
        { option_id: 'b', label: 'Escalate' },
      ],
      at: 0,
    };
    render(<QueueCardActions options={[opt({ id: 'a', label: 'Resolve' })]} answered={answered} onResponse={() => {}} />);
    expect(screen.getByText('✓ Resolve · Escalate')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders a button per option with its label', () => {
    render(
      <QueueCardActions
        options={[opt({ id: 'a', label: 'Resolve' }), opt({ id: 'b', label: 'Drop' })]}
        onResponse={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Resolve' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Drop' })).toBeTruthy();
  });

  it('fires a submit response for a terminal option', () => {
    const onResponse = vi.fn();
    render(<QueueCardActions options={[opt({ id: 'a', label: 'Resolve' })]} onResponse={onResponse} />);
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    expect(onResponse).toHaveBeenCalledWith({
      action: 'submit',
      picks: [{ option_id: 'a', label: 'Resolve' }],
    });
  });

  it('fires a navigate response for a non-terminal option', () => {
    const onResponse = vi.fn();
    render(
      <QueueCardActions
        options={[opt({ id: 'chat', label: '💬 Chat', terminal: false })]}
        onResponse={onResponse}
      />,
    );
    const btn = screen.getByRole('button', { name: '💬 Chat' });
    expect(btn.className).toContain('pc-items__action--nav');
    fireEvent.click(btn);
    expect(onResponse).toHaveBeenCalledWith({ action: 'navigate', option_id: 'chat', label: '💬 Chat' });
  });

  it('disables all actions while busy', () => {
    render(
      <QueueCardActions
        options={[opt({ id: 'a', label: 'Resolve' }), opt({ id: 'b', label: 'Drop' })]}
        busy
        onResponse={() => {}}
      />,
    );
    for (const b of screen.getAllByRole('button')) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('applies the option style class without leaking the hint as a native title', () => {
    render(
      <QueueCardActions
        options={[opt({ id: 'a', label: 'Delete', style: 'danger', hint: 'Permanently remove' })]}
        onResponse={() => {}}
      />,
    );
    const btn = screen.getByRole('button', { name: 'Delete' });
    expect(btn.className).toContain('pc-items__action--danger');
    expect(btn.getAttribute('title')).toBeNull();
  });

  it('does not add native title text when no hint is provided', () => {
    render(<QueueCardActions options={[opt({ id: 'a', label: 'Resolve' })]} onResponse={() => {}} />);
    expect(screen.getByRole('button', { name: 'Resolve' }).getAttribute('title')).toBeNull();
  });
});
