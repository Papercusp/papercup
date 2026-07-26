// @vitest-environment jsdom
/**
 * Combobox — the searchable single-select built for
 * `hud-session-launcher-and-board-tabs-2026-07-26` P-003, then reshaped to
 * input-as-control per the owner's follow-up ("make the search dropdowns show
 * as a text box to type in with the default as just the default text").
 *
 * What is REAL here and what is stubbed, and why:
 *   - cmdk runs for real. Filtering, scoring and the empty state ARE the
 *     feature under test, so mocking it would leave the requirement
 *     ("shows the full list on focus, filters as you type") unverified.
 *     It needs a scrollIntoView polyfill in jsdom — same as
 *     CommandPalette.test.tsx.
 *   - `harness/Popover` is stubbed to a plain open/closed wrapper. It is a
 *     thin Radix Popover shim whose behaviour (portalling, outside-dismiss,
 *     Escape, anchoring) is Radix's to guarantee, not ours, and driving
 *     Radix's collision/measurement code in jsdom tests the polyfills rather
 *     than this component. Same call made by UserPicker.test.tsx.
 *
 * No jest-dom matchers — this workspace's vitest setup doesn't register the
 * Chai plugin, so `.toBeDisabled()` throws "Invalid Chai property" instead of
 * failing honestly (WI-5963). Assert on DOM properties directly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('../Popover', () => ({
  // In anchor mode the anchor renders inline and unwrapped; the panel is
  // present only while open. That is all this component depends on.
  Popover: ({
    open,
    anchor,
    children,
  }: {
    open: boolean;
    anchor: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <div>
      {anchor}
      {open ? <div data-testid="popover-panel">{children}</div> : null}
    </div>
  ),
}));

// cmdk scrolls the active item into view; jsdom has no such method.
beforeEach(() => {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = vi.fn();
  }
});
afterEach(cleanup);

import { Combobox, flattenComboboxEntries, type ComboboxEntry } from '../Combobox';

const NONE = '__none__';

const OPTIONS: ComboboxEntry[] = [
  { value: NONE, label: 'Select plan…' },
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

function box(name = 'Plan'): HTMLInputElement {
  return screen.getByRole('combobox', { name }) as HTMLInputElement;
}

function optionLabels(): string[] {
  return within(screen.getByTestId('popover-panel'))
    .queryAllByRole('option')
    .map((el) => el.querySelector('.h-combobox__item-label')?.textContent ?? '');
}

function renderBox(props: Partial<React.ComponentProps<typeof Combobox>> = {}) {
  return render(
    <Combobox
      value={null}
      onChange={vi.fn()}
      options={OPTIONS}
      ariaLabel="Plan"
      emptyValue={NONE}
      placeholder="Select plan…"
      {...props}
    />,
  );
}

describe('Combobox', () => {
  it('renders the control as a TEXT BOX, not a button', () => {
    // The owner's follow-up ask: the dropdown should BE a text box you type
    // in. A <button> trigger that opens a panel containing a search field is
    // exactly what this replaced.
    renderBox();
    const el = box();
    expect(el.tagName).toBe('INPUT');
    expect(screen.queryByRole('button', { name: 'Plan' })).toBeNull();
  });

  it('shows the DEFAULT as placeholder text, with the box itself empty', () => {
    // "with the default as just the default text" — the sentinel row's label
    // must not be echoed back as if the user had typed it.
    renderBox({ value: NONE });
    expect(box().value).toBe('');
    expect(box().placeholder).toBe('Select plan…');
  });

  it('shows the FULL list on focus, before anything is typed', () => {
    renderBox();
    expect(screen.queryByTestId('popover-panel')).toBeNull();
    fireEvent.focus(box());
    expect(optionLabels()).toEqual([
      'Select plan…',
      'Alpha rollout',
      'Beta migration',
      'Gamma cleanup',
    ]);
  });

  it('shows the full list on focus EVEN WHEN a value is already selected', () => {
    // The subtle one: the box displays "Gamma cleanup", but focusing must not
    // filter the list down to that one row — otherwise you could never switch
    // to a different option without clearing the text first.
    renderBox({ value: 'gamma-plan' });
    expect(box().value).toBe('Gamma cleanup');
    fireEvent.focus(box());
    expect(optionLabels()).toHaveLength(4);
  });

  it('filters as you type, matching on the visible label', () => {
    renderBox();
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: 'beta' } });
    expect(optionLabels()).toEqual(['Beta migration']);
  });

  it('also matches on keywords that are never rendered (the plan slug)', () => {
    renderBox();
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: 'alpha-plan' } });
    expect(optionLabels()).toEqual(['Alpha rollout']);
  });

  it('renders the P-007 detail line as a second row line', () => {
    renderBox();
    fireEvent.focus(box());
    expect(
      within(screen.getByTestId('popover-panel')).getByText('updated 26 Jul 2026, 14:03 · today'),
    ).toBeTruthy();
  });

  it('shows the empty state when nothing matches', () => {
    renderBox({ emptyLabel: 'No plans match' });
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: 'zzzzz' } });
    expect(optionLabels()).toEqual([]);
    expect(within(screen.getByTestId('popover-panel')).getByText('No plans match')).toBeTruthy();
  });

  it('selecting an option reports its value and closes the panel', () => {
    const onChange = vi.fn();
    renderBox({ onChange });
    fireEvent.focus(box());
    fireEvent.click(within(screen.getByTestId('popover-panel')).getByText('Beta migration'));
    expect(onChange).toHaveBeenCalledWith('beta-plan');
    expect(screen.queryByTestId('popover-panel')).toBeNull();
  });

  it('re-focusing after a filtered session shows the full list again', () => {
    // Regression guard: if the typed draft survived the close, refocusing
    // would silently show a filtered list and options would look like they
    // had vanished.
    renderBox();
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: 'beta' } });
    expect(optionLabels()).toEqual(['Beta migration']);
    fireEvent.click(within(screen.getByTestId('popover-panel')).getByText('Beta migration'));
    fireEvent.focus(box());
    expect(optionLabels()).toHaveLength(4);
  });

  it('the box displays the selected option label once chosen', () => {
    const { rerender } = renderBox({ value: null });
    expect(box().value).toBe('');
    rerender(
      <Combobox
        value="gamma-plan"
        onChange={vi.fn()}
        options={OPTIONS}
        ariaLabel="Plan"
        emptyValue={NONE}
        placeholder="Select plan…"
      />,
    );
    expect(box().value).toBe('Gamma cleanup');
  });

  it('Escape closes the panel and restores the shown selection', () => {
    renderBox({ value: 'gamma-plan' });
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: 'alph' } });
    expect(box().value).toBe('alph');
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(screen.queryByTestId('popover-panel')).toBeNull();
    expect(box().value).toBe('Gamma cleanup');
  });

  it('blurring abandons the typed draft rather than committing it', () => {
    const onChange = vi.fn();
    renderBox({ value: 'gamma-plan', onChange });
    fireEvent.focus(box());
    fireEvent.change(box(), { target: { value: 'nonsense' } });
    fireEvent.blur(box());
    expect(onChange).not.toHaveBeenCalled();
    expect(box().value).toBe('Gamma cleanup');
    expect(screen.queryByTestId('popover-panel')).toBeNull();
  });

  it('does not open while disabled', () => {
    renderBox({ disabled: true });
    const el = box();
    expect(el.disabled).toBe(true);
    fireEvent.focus(el);
    expect(screen.queryByTestId('popover-panel')).toBeNull();
  });

  it('the list is its own bounded scroll container (P-006)', () => {
    // The overflow bug the owner hit was a list with no ceiling and no
    // scrollbar, so the tail of a long plan list was unreachable. The ceiling
    // itself is CSS (.h-combobox__list); what this asserts is that the element
    // carrying that class is the one wrapping the options, i.e. it can bite.
    renderBox();
    fireEvent.focus(box());
    const list = screen.getByTestId('popover-panel').querySelector('.h-combobox__list');
    expect(list).not.toBeNull();
    expect(within(list as HTMLElement).queryAllByRole('option').length).toBe(4);
  });

  it('flattenComboboxEntries drops group nesting but preserves order', () => {
    expect(flattenComboboxEntries(OPTIONS).map((o) => o.value)).toEqual([
      NONE,
      'alpha-plan',
      'beta-plan',
      'gamma-plan',
    ]);
  });
});
