// @vitest-environment jsdom
/**
 * WorkRefPill component tests (chat-ref-pills-2026-07-26 P-003).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

afterEach(() => cleanup());

import { WorkRefPill } from './WorkRefPill';

describe('WorkRefPill — rendering modes', () => {
  it('renders a static, non-interactive pill when neither href nor onActivate is given', () => {
    render(<WorkRefPill id="WI-5929" kind="work-item" state="wip" />);
    const el = screen.getByLabelText('WI-5929');
    expect(el.tagName).toBe('SPAN');
    expect(el.textContent).toBe('WI-5929');
  });

  it('renders an <a> when href is given', () => {
    render(<WorkRefPill id="WI-5929" kind="work-item" href="/adv?tab=working&workItem=WI-5929" />);
    const el = screen.getByLabelText('WI-5929');
    expect(el.tagName).toBe('A');
    expect(el.getAttribute('href')).toBe('/adv?tab=working&workItem=WI-5929');
  });

  it('renders a <button> when onActivate is given and no href', () => {
    const onActivate = vi.fn();
    render(<WorkRefPill id="WI-5929" kind="work-item" onActivate={onActivate} />);
    const el = screen.getByLabelText('WI-5929');
    expect(el.tagName).toBe('BUTTON');
    expect((el as HTMLButtonElement).type).toBe('button');
  });

  it('prefers href over onActivate when both are given (still calls onActivate on click)', () => {
    const onActivate = vi.fn();
    render(<WorkRefPill id="WI-5929" kind="work-item" href="/adv?tab=working" onActivate={onActivate} />);
    const el = screen.getByLabelText('WI-5929');
    expect(el.tagName).toBe('A');
    fireEvent.click(el);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });
});

describe('WorkRefPill — accessible name', () => {
  it('accessible name is just the id when no title is given', () => {
    render(<WorkRefPill id="WI-5929" kind="work-item" />);
    expect(screen.getByLabelText('WI-5929')).toBeTruthy();
  });

  it('accessible name includes the title when given: "<id> — <title>"', () => {
    render(<WorkRefPill id="WI-5929" kind="work-item" title="WorkRefPill component" />);
    expect(screen.getByLabelText('WI-5929 — WorkRefPill component')).toBeTruthy();
  });

  it('always renders the bare id as the visible text, regardless of title', () => {
    render(<WorkRefPill id="P-003" kind="plan-item" title="Long descriptive title text" />);
    expect(screen.getByLabelText('P-003 — Long descriptive title text').textContent).toBe('P-003');
  });
});

describe('WorkRefPill — activation', () => {
  it('a <button> pill calls onActivate on click', () => {
    const onActivate = vi.fn();
    render(<WorkRefPill id="WI-5929" kind="work-item" onActivate={onActivate} />);
    fireEvent.click(screen.getByLabelText('WI-5929'));
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('an <a> pill calls onActivate on click (caller decides whether to preventDefault)', () => {
    const onActivate = vi.fn((e: React.MouseEvent) => e.preventDefault());
    render(<WorkRefPill id="WI-5929" kind="work-item" href="/adv" onActivate={onActivate} />);
    fireEvent.click(screen.getByLabelText('WI-5929'));
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('is keyboard-focusable: an <a> pill is reachable via tab order (no tabIndex=-1)', () => {
    render(<WorkRefPill id="WI-5929" kind="work-item" href="/adv" />);
    const el = screen.getByLabelText('WI-5929');
    expect(el.getAttribute('tabIndex')).not.toBe('-1');
  });

  it('is keyboard-focusable: a <button> pill is a real button (native Enter/Space activation, no tabIndex=-1)', () => {
    render(<WorkRefPill id="WI-5929" kind="work-item" onActivate={vi.fn()} />);
    const el = screen.getByLabelText('WI-5929');
    expect(el.tagName).toBe('BUTTON');
    expect(el.getAttribute('tabIndex')).not.toBe('-1');
  });
});

describe('WorkRefPill — state coloring (reuses the existing STATUS token table, no new colors)', () => {
  it('unknown state (default) and a recognized state render DIFFERENT colors', () => {
    const { unmount } = render(<WorkRefPill id="WI-1" kind="work-item" />);
    const unknownColor = getComputedStyle(screen.getByLabelText('WI-1')).color;
    unmount();

    render(<WorkRefPill id="WI-1" kind="work-item" state="done" />);
    const doneColor = getComputedStyle(screen.getByLabelText('WI-1')).color;

    expect(doneColor).not.toBe(unknownColor);
  });

  it('an unrecognized state string degrades gracefully to the neutral fallback (never throws)', () => {
    expect(() =>
      render(<WorkRefPill id="WI-1" kind="work-item" state={'totally-made-up' as never} />),
    ).not.toThrow();
    expect(screen.getByLabelText('WI-1')).toBeTruthy();
  });

  it.each(['open', 'wip', 'blocked', 'needs-human', 'done', 'dropped'] as const)(
    'renders without throwing for lifecycle state "%s"',
    (state) => {
      const { unmount } = render(<WorkRefPill id="WI-1" kind="work-item" state={state} />);
      expect(screen.getByLabelText('WI-1')).toBeTruthy();
      unmount();
    },
  );
});

describe('WorkRefPill — size', () => {
  it('accepts size="xs" and size="sm" (default) without throwing', () => {
    const { unmount } = render(<WorkRefPill id="WI-1" kind="work-item" size="xs" />);
    expect(screen.getByLabelText('WI-1')).toBeTruthy();
    unmount();
    render(<WorkRefPill id="WI-1" kind="work-item" size="sm" />);
    expect(screen.getByLabelText('WI-1')).toBeTruthy();
  });
});
