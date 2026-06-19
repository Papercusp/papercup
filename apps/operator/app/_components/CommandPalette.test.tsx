// @vitest-environment jsdom
/**
 * CommandPalette (⌘K / Ctrl+P) — the app-wide command palette. Props-driven
 * (open / onClose / commands) wrapper over cmdk + a Radix non-modal dialog,
 * forceMount'd so the tree is always in the DOM. We drive: the open→hidden
 * rendering of the input + footer, the grouped command list (sections), the
 * onSelect → perform()+onClose handler, the empty-state copy, and the closed
 * state. useLexicon is mocked to an identity resolver.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

/* ── Mocks ─────────────────────────────────────────────────────────── */
vi.mock('@/lib/useLexicon', () => ({
  useLexicon: () => (term: string) => term,
}));

// cmdk drives the active item into view via scrollIntoView, which jsdom
// does not implement — polyfill it so the list can mount.
beforeEach(() => {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = vi.fn();
  }
});

import CommandPalette, { type Command } from './CommandPalette';

function cmd(over: Partial<Command> = {}): Command {
  return {
    id: 'c1',
    title: 'Start triage',
    section: 'Quick actions',
    perform: vi.fn(),
    ...over,
  };
}

afterEach(cleanup);

describe('CommandPalette (global ⌘K palette)', () => {
  it('renders the search input + footer hints when open', () => {
    render(<CommandPalette open onClose={vi.fn()} commands={[cmd()]} />);
    expect(screen.getByLabelText('Search commands')).toBeTruthy();
    expect(screen.getByText('run')).toBeTruthy(); // footer "↵ run"
    expect(screen.getByText('navigate')).toBeTruthy();
  });

  it('renders the supplied commands, grouped under their section heading', () => {
    render(
      <CommandPalette
        open
        onClose={vi.fn()}
        commands={[
          cmd({ id: 'a', title: 'Start triage', section: 'Quick actions' }),
          cmd({ id: 'b', title: 'Open docs', section: 'Quick actions', subtitle: 'reference' }),
        ]}
      />,
    );
    expect(screen.getByText('Start triage')).toBeTruthy();
    expect(screen.getByText('Open docs')).toBeTruthy();
    expect(screen.getByText('reference')).toBeTruthy(); // subtitle
  });

  it('selecting a command runs perform() and closes the palette', () => {
    const onClose = vi.fn();
    const perform = vi.fn();
    render(<CommandPalette open onClose={onClose} commands={[cmd({ id: 'a', title: 'Run me', perform })]} />);
    fireEvent.click(screen.getByText('Run me'));
    expect(perform).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders the empty-state copy when there are no commands to match', () => {
    render(<CommandPalette open onClose={vi.fn()} commands={[]} />);
    expect(screen.getByText('No matches')).toBeTruthy();
  });

  it('renders a shortcut keycap when a command declares one', () => {
    render(<CommandPalette open onClose={vi.fn()} commands={[cmd({ id: 'a', title: 'Toggle', shortcut: '⌘B' })]} />);
    expect(screen.getByText('⌘B')).toBeTruthy();
  });

  it('does not render the input bar when closed (forceMount tree stays hidden)', () => {
    // forceMount keeps the dialog tree in the DOM but Radix sets the closed
    // state; the input is still queryable, so assert via the dialog data-state.
    render(<CommandPalette open={false} onClose={vi.fn()} commands={[cmd()]} />);
    const content = document.querySelector('[aria-label="Command palette"]');
    expect(content?.getAttribute('data-state')).toBe('closed');
  });
});
