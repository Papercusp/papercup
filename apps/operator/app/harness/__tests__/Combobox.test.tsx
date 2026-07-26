// @vitest-environment jsdom
/**
 * Combobox — the searchable single-select built for
 * `hud-session-launcher-and-board-tabs-2026-07-26` P-003.
 *
 * What is REAL here and what is stubbed, and why:
 *   - cmdk runs for real. Filtering, scoring and the empty state ARE the
 *     feature under test, so mocking it would leave the requirement
 *     ("shows the full list on focus, filters as you type") unverified.
 *     It needs a scrollIntoView polyfill in jsdom — same as
 *     CommandPalette.test.tsx.
 *   - `harness/Popover` is stubbed to a plain open/closed wrapper. It is a
 *     thin Radix Popover shim whose behaviour (portalling, outside-click,
 *     Escape, focus restore) is Radix's to guarantee, not ours, and driving
 *     Radix's collision/measurement code in jsdom tests the polyfills rather
 *     than this component. Same call made by UserPicker.test.tsx.
 *
 * No jest-dom matchers — this workspace's vitest setup doesn't register the
 * Chai plugin, so `.toBeDisabled()` throws "Invalid Chai property" instead of
 * failing honestly (WI-5963). Assert on DOM properties directly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('../Popover', async () => {
  const { cloneElement, isValidElement } = await import('react');
  return {
    Popover: ({
      open,
      onOpenChange,
      trigger,
      children,
    }: {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      trigger: React.ReactNode;
      children: React.ReactNode;
    }) => (
      <div>
        {/* Radix's `Popover.Trigger asChild` composes the toggle onto the
            child element rather than wrapping it — the Combobox trigger has
            no onClick of its own precisely because Radix supplies it. The
            stub has to do the same or the panel could never open. */}
        {isValidElement(trigger)
          ? cloneElement(trigger as React.ReactElement<{ onClick?: () => void }>, {
              onClick: () => onOpenChange(!open),
            })
          : trigger}
        {open ? <div data-testid="popover-panel">{children}</div> : null}
      </div>
    ),
  };
});

// cmdk scrolls the active item into view; jsdom has no such method.
beforeEach(() => {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = vi.fn();
  }
});
afterEach(cleanup);

import { Combobox, flattenComboboxEntries, type ComboboxEntry } from '../Combobox';

const OPTIONS: ComboboxEntry[] = [
  { value: '__none__', label: 'Select plan…' },
  {
    kind: 'group',
    label: 'papercusp',
    options: [
      {
        value: 'alpha-plan',
        label: 'Alpha rollout',
        detail: 'updated 26 Jul 2026, 14:03 · today',
        keywords: ['alpha-plan'],
      },
      { value: 'beta-plan', label: 'Beta migration', detail: 'updated 25 Jul 2026, 09:12 · yesterday' },
    ],
  },
  { kind: 'group', label: 'sheets', options: [{ value: 'gamma-plan', label: 'Gamma cleanup' }] },
];

function open(name = 'Plan') {
  fireEvent.click(screen.getByRole('button', { name }));
}

function optionLabels(): string[] {
  return within(screen.getByTestId('popover-panel'))
    .queryAllByRole('option')
    .map((el) => el.querySelector('.h-combobox__item-label')?.textContent ?? '');
}

describe('Combobox', () => {
  it('shows the FULL list on open, before anything is typed', () => {
    // The literal owner requirement: "show the full list if you focus it
    // before typing into it".
    render(<Combobox value={null} onChange={vi.fn()} options={OPTIONS} ariaLabel="Plan" />);
    expect(screen.queryByTestId('popover-panel')).toBeNull();
    open();
    expect(optionLabels()).toEqual([
      'Select plan…',
      'Alpha rollout',
      'Beta migration',
      'Gamma cleanup',
    ]);
  });

  it('filters as you type, matching on the visible label', () => {
    render(<Combobox value={null} onChange={vi.fn()} options={OPTIONS} ariaLabel="Plan" />);
    open();
    fireEvent.change(screen.getByRole('combobox', { name: 'Search Plan' }), {
      target: { value: 'beta' },
    });
    expect(optionLabels()).toEqual(['Beta migration']);
  });

  it('also matches on keywords that are never rendered (the plan slug)', () => {
    // Slugs are searchable but not shown — a human half-remembers the slug
    // from a plan doc while the list shows titles.
    render(<Combobox value={null} onChange={vi.fn()} options={OPTIONS} ariaLabel="Plan" />);
    open();
    fireEvent.change(screen.getByRole('combobox', { name: 'Search Plan' }), {
      target: { value: 'alpha-plan' },
    });
    expect(optionLabels()).toEqual(['Alpha rollout']);
  });

  it('renders the P-007 detail line as a second row line', () => {
    render(<Combobox value={null} onChange={vi.fn()} options={OPTIONS} ariaLabel="Plan" />);
    open();
    const panel = within(screen.getByTestId('popover-panel'));
    expect(panel.getByText('updated 26 Jul 2026, 14:03 · today')).toBeTruthy();
  });

  it('shows the empty state when nothing matches', () => {
    render(
      <Combobox
        value={null}
        onChange={vi.fn()}
        options={OPTIONS}
        ariaLabel="Plan"
        emptyLabel="No plans match"
      />,
    );
    open();
    fireEvent.change(screen.getByRole('combobox', { name: 'Search Plan' }), {
      target: { value: 'zzzzz' },
    });
    expect(optionLabels()).toEqual([]);
    expect(within(screen.getByTestId('popover-panel')).getByText('No plans match')).toBeTruthy();
  });

  it('selecting an option reports its value and closes the panel', () => {
    const onChange = vi.fn();
    render(<Combobox value={null} onChange={onChange} options={OPTIONS} ariaLabel="Plan" />);
    open();
    fireEvent.click(within(screen.getByTestId('popover-panel')).getByText('Beta migration'));
    expect(onChange).toHaveBeenCalledWith('beta-plan');
    expect(screen.queryByTestId('popover-panel')).toBeNull();
  });

  it('reopening after a filtered session shows the full list again', () => {
    // Regression guard for the obvious bug: if the query survived the close,
    // reopening would silently show a filtered list and options would look
    // like they had vanished.
    render(<Combobox value={null} onChange={vi.fn()} options={OPTIONS} ariaLabel="Plan" />);
    open();
    fireEvent.change(screen.getByRole('combobox', { name: 'Search Plan' }), {
      target: { value: 'beta' },
    });
    expect(optionLabels()).toEqual(['Beta migration']);
    fireEvent.click(within(screen.getByTestId('popover-panel')).getByText('Beta migration'));
    open();
    expect(optionLabels()).toHaveLength(4);
  });

  it('the trigger shows the selected option label, and the placeholder when unselected', () => {
    const { rerender } = render(
      <Combobox
        value={null}
        onChange={vi.fn()}
        options={OPTIONS}
        ariaLabel="Plan"
        placeholder="Pick one…"
      />,
    );
    expect(screen.getByRole('button', { name: 'Plan' }).textContent).toContain('Pick one…');
    rerender(
      <Combobox
        value="gamma-plan"
        onChange={vi.fn()}
        options={OPTIONS}
        ariaLabel="Plan"
        placeholder="Pick one…"
      />,
    );
    expect(screen.getByRole('button', { name: 'Plan' }).textContent).toContain('Gamma cleanup');
  });

  it('does not open while disabled', () => {
    render(
      <Combobox value={null} onChange={vi.fn()} options={OPTIONS} ariaLabel="Plan" disabled />,
    );
    const trigger = screen.getByRole('button', { name: 'Plan' }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    fireEvent.click(trigger);
    expect(screen.queryByTestId('popover-panel')).toBeNull();
  });

  it('the list is its own bounded scroll container (P-006)', () => {
    // The overflow bug the owner hit was a list with no ceiling and no
    // scrollbar, so the tail of a long plan list was simply unreachable. The
    // ceiling itself is CSS (.h-combobox__list); what this asserts is that
    // the element carrying that class is the one wrapping the options, i.e.
    // the class can actually bite.
    render(<Combobox value={null} onChange={vi.fn()} options={OPTIONS} ariaLabel="Plan" />);
    open();
    const list = screen.getByTestId('popover-panel').querySelector('.h-combobox__list');
    expect(list).not.toBeNull();
    expect(within(list as HTMLElement).queryAllByRole('option').length).toBe(4);
  });

  it('flattenComboboxEntries drops group nesting but preserves order', () => {
    expect(flattenComboboxEntries(OPTIONS).map((o) => o.value)).toEqual([
      '__none__',
      'alpha-plan',
      'beta-plan',
      'gamma-plan',
    ]);
  });
});
