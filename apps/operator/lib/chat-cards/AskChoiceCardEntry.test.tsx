// @vitest-environment jsdom
/**
 * AskChoiceCardEntry.test.tsx — coverage for the registry-side glue that wires
 * `chat:ask_choice` into the chat-card registry. Importing the module is a side
 * effect (registerCard); we then drive it via renderCard and assert the entry's
 * payload-validation branches (null for missing/empty payloads) + the prop
 * bridge to AskChoiceCard (args + answered passed through, onAnswer fans the
 * commit out). AskChoiceCard is stubbed to a marker so this asserts the entry's
 * logic, not the card's internals.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

// Stub the card so the entry's validation + prop-bridge is what's under test.
vi.mock('@/app/_components/chat/AskChoiceCard', () => ({
  AskChoiceCard: ({
    args,
    answered,
    onAnswer,
  }: {
    args: { question: string };
    answered?: { picks: unknown[] };
    onAnswer: (commit: { picks: Array<{ option_id: string; label: string }> }) => void;
  }) => (
    <button
      data-testid="card"
      data-answered={answered ? 'true' : 'false'}
      onClick={() => onAnswer({ picks: [{ option_id: 'a', label: 'A' }] })}
    >
      {args.question}
    </button>
  ),
}));

// Importing the entry registers the card as a side effect.
import './AskChoiceCardEntry';
import { renderCard } from './registry';

afterEach(cleanup);

function renderResult(node: ReactNode | null) {
  return render(<>{node}</>);
}

describe('AskChoiceCardEntry (chat:ask_choice registry glue)', () => {
  it('registers a renderer under chat:ask_choice', () => {
    const node = renderCard('chat:ask_choice', {
      args: { question: 'Pick?', options: [{ id: 'a', label: 'A' }] },
      onAnswer: vi.fn(),
    });
    expect(node).toBeTruthy();
  });

  it('renders the AskChoiceCard for a valid payload', () => {
    const node = renderCard('chat:ask_choice', {
      args: { question: 'Deploy now?', options: [{ id: 'y', label: 'Yes' }] },
      onAnswer: vi.fn(),
    });
    renderResult(node);
    expect(screen.getByTestId('card')).toBeTruthy();
    expect(screen.getByText('Deploy now?')).toBeTruthy();
  });

  it('returns null when args is missing or not an object', () => {
    expect(renderCard('chat:ask_choice', { args: undefined, onAnswer: vi.fn() })).toBeNull();
    expect(renderCard('chat:ask_choice', { args: 'nope', onAnswer: vi.fn() })).toBeNull();
  });

  it('returns null when the question is missing', () => {
    const node = renderCard('chat:ask_choice', {
      args: { options: [{ id: 'a', label: 'A' }] },
      onAnswer: vi.fn(),
    });
    expect(node).toBeNull();
  });

  it('returns null when options is absent or empty', () => {
    expect(
      renderCard('chat:ask_choice', { args: { question: 'Q', options: [] }, onAnswer: vi.fn() }),
    ).toBeNull();
    expect(
      renderCard('chat:ask_choice', { args: { question: 'Q' }, onAnswer: vi.fn() }),
    ).toBeNull();
  });

  it('passes answered through and bridges onAnswer to the consumer callback', () => {
    const onAnswer = vi.fn();
    const node = renderCard('chat:ask_choice', {
      args: { question: 'Q', options: [{ id: 'a', label: 'A' }] },
      answered: { picks: [{ option_id: 'a', label: 'A' }] },
      onAnswer,
    });
    renderResult(node);
    const card = screen.getByTestId('card');
    expect(card.getAttribute('data-answered')).toBe('true');
    fireEvent.click(card);
    expect(onAnswer).toHaveBeenCalledWith({ picks: [{ option_id: 'a', label: 'A' }] });
  });
});
