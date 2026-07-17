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
    onResponse,
  }: {
    args: { question: string; options?: unknown };
    answered?: { picks: unknown[]; declined?: boolean };
    onResponse: (response:
      | { action: 'submit'; picks: Array<{ option_id: string; label: string }> }
      | { action: 'decline' }
    ) => void;
  }) => (
    <div
      data-testid="card"
      data-answered={answered ? 'true' : 'false'}
      data-options={Array.isArray(args.options) ? String(args.options.length) : 'invalid'}
    >
      {args.question}
      <button
        data-testid="submit"
        onClick={() => onResponse({
          action: 'submit',
          picks: [{ option_id: 'a', label: 'A' }],
        })}
      >submit</button>
      <button data-testid="decline" onClick={() => onResponse({ action: 'decline' })}>
        decline
      </button>
    </div>
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
    fireEvent.click(screen.getByTestId('submit'));
    expect(onAnswer).toHaveBeenCalledWith({ picks: [{ option_id: 'a', label: 'A' }] });
  });

  it('renders from STRINGIFIED options — the model encoding slip persisted raw (operator_turns seq 12076)', () => {
    const onAnswer = vi.fn();
    const node = renderCard('chat:ask_choice', {
      args: {
        question: 'Q',
        options: '[{"id":"a","label":"A"},{"id":"b","label":"B"}]',
      },
      onAnswer,
    });
    expect(node).not.toBeNull();
    renderResult(node);
    expect(screen.getByTestId('card').getAttribute('data-options')).toBe('2');
  });

  it('still declines to render when the options string is not a JSON array', () => {
    expect(
      renderCard('chat:ask_choice', {
        args: { question: 'Q', options: 'not json' },
        onAnswer: vi.fn(),
      }),
    ).toBeNull();
  });

  it('bridges Skip/decline to a persisted declined answer payload (WI-4976)', () => {
    const onAnswer = vi.fn();
    const node = renderCard('chat:ask_choice', {
      args: { question: 'Q', options: [{ id: 'a', label: 'A' }] },
      onAnswer,
    });
    renderResult(node);
    fireEvent.click(screen.getByTestId('decline'));
    expect(onAnswer).toHaveBeenCalledWith({ picks: [], declined: true });
  });
});
