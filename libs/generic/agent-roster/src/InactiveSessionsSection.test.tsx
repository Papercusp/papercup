// @vitest-environment jsdom
import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InactiveSessionsSection, type InactiveSessionsSectionProps } from './InactiveSessionsSection';
import type { EndedSessionRow, EndedSessionsPage } from './sessions';

function endedRow(over: Partial<EndedSessionRow> = {}): EndedSessionRow {
  return {
    id: 1,
    planSlug: null,
    agent: 'claude',
    role: null,
    feature: null,
    label: null,
    coordOwnerId: 'su-abcdef12',
    startedAt: '2026-07-09T01:00:00Z',
    endedAt: '2026-07-09T01:30:00Z',
    exitCode: 0,
    ...over,
  };
}

const NOW = Date.parse('2026-07-09T02:00:00Z');

/** A host with local expand state — the portal's shape. */
function Host(props: Omit<InactiveSessionsSectionProps, 'expanded' | 'onExpandedChange'> & { initiallyExpanded?: boolean }) {
  const { initiallyExpanded = false, ...rest } = props;
  const [expanded, setExpanded] = useState(initiallyExpanded);
  return <InactiveSessionsSection {...rest} expanded={expanded} onExpandedChange={setExpanded} />;
}

const page = (sessions: EndedSessionRow[], hasMore = false): EndedSessionsPage => ({ sessions, hasMore, nextBefore: hasMore ? 'cur' : null });

beforeEach(() => {
  // jsdom has no IntersectionObserver; the section wires one for infinite scroll.
  vi.stubGlobal('IntersectionObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('InactiveSessionsSection (host-free)', () => {
  it('loads the first page through the host loader on expand and renders --nocheck rows', async () => {
    const loadPage = vi.fn(async () => page([endedRow({ id: 7, label: 'a real session name' })]));
    render(<Host activeOwnerIds={new Set()} nowMs={NOW} loadPage={loadPage} />);

    expect(loadPage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('inactive-sessions-toggle'));

    const row = await waitFor(() => screen.getByTestId('inactive-session-7'));
    expect(loadPage).toHaveBeenCalledWith(null);
    // The roster row's 5-col grid reserves col 1 for the checkbox; a checkbox-less
    // row MUST drop it via --nocheck or the name lands in the 16px glyph column.
    expect(row.className).toContain('pc-agents-roster__row--nocheck');
    expect(row.textContent).toContain('a real session name');
  });

  it('shows the loaded count with a trailing + while more pages remain', async () => {
    const loadPage = vi.fn(async () => page([endedRow({ id: 7 }), endedRow({ id: 8, coordOwnerId: 'su-bbbbbb12' })], true));
    render(<Host activeOwnerIds={new Set()} nowMs={NOW} loadPage={loadPage} />);
    expect(screen.queryByTestId('inactive-sessions-count')).toBeNull();
    fireEvent.click(screen.getByTestId('inactive-sessions-toggle'));

    const count = await waitFor(() => screen.getByTestId('inactive-sessions-count'));
    expect(count.textContent).toContain('(2+)');
    expect(count.className).toContain('pc-agents-roster__group-count');
  });

  it('activates an openable row through the host seam, and never an unopenable one', async () => {
    const onRowActivate = vi.fn();
    const rows = [endedRow({ id: 1, coordOwnerId: 'su-open0001' }), endedRow({ id: 2, coordOwnerId: null })];
    render(
      <Host activeOwnerIds={new Set()} nowMs={NOW} loadPage={async () => page(rows)} onRowActivate={onRowActivate} initiallyExpanded />,
    );

    const openable = await waitFor(() => screen.getByTestId('inactive-session-1'));
    const inert = screen.getByTestId('inactive-session-2');
    expect(openable.getAttribute('role')).toBe('button');
    expect(inert.getAttribute('role')).toBeNull();
    expect(inert.className).toContain('is-unopenable');

    fireEvent.click(openable);
    fireEvent.keyDown(openable, { key: 'Enter' });
    fireEvent.click(inert);
    fireEvent.keyDown(inert, { key: 'Enter' });

    expect(onRowActivate).toHaveBeenCalledTimes(2);
    expect(onRowActivate).toHaveBeenCalledWith(rows[0]);
  });

  it('honours a host isOpenable predicate over the default', async () => {
    const onRowActivate = vi.fn();
    const rows = [endedRow({ id: 1, coordOwnerId: 'su-open0001', sessionId: null })];
    render(
      <Host
        activeOwnerIds={new Set()}
        nowMs={NOW}
        loadPage={async () => page(rows)}
        onRowActivate={onRowActivate}
        isOpenable={(r) => Boolean(r.sessionId)}
        initiallyExpanded
      />,
    );
    const row = await waitFor(() => screen.getByTestId('inactive-session-1'));
    expect(row.className).toContain('is-unopenable');
    fireEvent.click(row);
    expect(onRowActivate).not.toHaveBeenCalled();
  });

  it('elides a running agent\'s ended rows unless focused on that agent', async () => {
    const rows = [endedRow({ id: 1, coordOwnerId: 'su-live00001' }), endedRow({ id: 2, coordOwnerId: 'su-gone00001' })];
    const { unmount } = render(
      <Host activeOwnerIds={new Set(['su-live00001'])} nowMs={NOW} loadPage={async () => page(rows)} initiallyExpanded />,
    );
    await waitFor(() => screen.getByTestId('inactive-session-2'));
    expect(screen.queryByTestId('inactive-session-1')).toBeNull();
    unmount();

    render(
      <Host activeOwnerIds={new Set(['su-live00001'])} nowMs={NOW} loadPage={async () => page(rows)} focusOwnerId="su-live00001" />,
    );
    // A focus deep-link auto-expands and shows only that owner's history.
    await waitFor(() => screen.getByTestId('inactive-session-1'));
    expect(screen.queryByTestId('inactive-session-2')).toBeNull();
    expect(screen.getByTestId('inactive-sessions-toggle').getAttribute('aria-expanded')).toBe('true');
  });

  it('reports a loader failure instead of spinning', async () => {
    render(<Host activeOwnerIds={new Set()} nowMs={NOW} loadPage={async () => { throw new Error('boom'); }} initiallyExpanded />);
    await waitFor(() => expect(screen.getByTestId('inactive-sessions-list').textContent).toContain('Couldn’t load inactive sessions.'));
  });
});
