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
  // present only while open. That is all `Combobox` depends on.
  //
  // `ComboboxMenu` uses TRIGGER mode instead, so the stub also mirrors the one
  // behaviour it leans on there: Radix's `Popover.Trigger` toggles the root's
  // open state. Without that a click test would have to reach past the
  // component and set `open` by hand, which tests the test.
  //
  // `zIndex` is surfaced on the panel because it is load-bearing, not cosmetic:
  // a menu below the popper wrapper floor paints behind the app shell and is
  // unclickable (P-006), and jsdom cannot catch that by rendering.
  Popover: ({
    open,
    anchor,
    trigger,
    onOpenChange,
    zIndex,
    children,
  }: {
    open: boolean;
    anchor?: React.ReactNode;
    trigger?: React.ReactNode;
    onOpenChange?: (next: boolean) => void;
    zIndex?: number;
    children: React.ReactNode;
  }) => (
    <div>
      {anchor}
      {trigger ? (
        <span onClick={() => onOpenChange?.(!open)}>{trigger}</span>
      ) : null}
      {open ? (
        <div data-testid="popover-panel" data-z-index={zIndex == null ? undefined : String(zIndex)}>
          {children}
        </div>
      ) : null}
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

import {
  Combobox,
  ComboboxMenu,
  flattenComboboxEntries,
  type ComboboxEntry,
} from '../Combobox';

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

/**
 * ComboboxMenu — the trigger-as-control sibling, built for WI-10013.
 *
 * [owner 2026-08-03] "the grade mode popup should not offer to ask the
 * agent, it should just have a scroll and a search filter in the dropdown."
 *
 * The menu it replaced capped its list at 8 and then offered a row that asked
 * the agent to do the reading. So the requirement under test is specifically
 * that a LONG list is fully present and narrowable by typing — not merely that
 * a search box renders.
 */
describe('ComboboxMenu', () => {
  /* 23 rows: more than the cap that used to truncate this menu, so a
     reintroduced cap fails here rather than passing on a short fixture. */
  const RUBRICS: ComboboxEntry[] = Array.from({ length: 23 }, (_, i) => ({
    value: `rubric-${String(i).padStart(2, '0')}`,
    label: `Rubric ${String(i).padStart(2, '0')}`,
    detail: i === 3 ? 'measures release hygiene' : `characteristic ${i}`,
    keywords: i === 3 ? ['measures release hygiene'] : undefined,
  }));

  function renderMenu(props: Partial<React.ComponentProps<typeof ComboboxMenu>> = {}) {
    const onChange = vi.fn();
    render(
      <ComboboxMenu
        value={null}
        onChange={onChange}
        options={RUBRICS}
        ariaLabel="GRADE is off. Change it."
        testId="chat-mode-mode-grade"
        searchPlaceholder="Search rubrics…"
        triggerChildren={<span>GRADE off ▾</span>}
        {...props}
      />,
    );
    return { onChange };
  }

  const openMenu = () => fireEvent.click(screen.getByTestId('chat-mode-mode-grade'));
  const rows = () => within(screen.getByTestId('popover-panel')).queryAllByRole('option');

  it('renders the caller-supplied trigger and keeps the panel shut until clicked', () => {
    renderMenu();
    expect(screen.getByTestId('chat-mode-mode-grade').textContent).toContain('GRADE off ▾');
    expect(screen.queryByTestId('popover-panel')).toBeNull();
  });

  /**
   * ⚠ READ BEFORE TRUSTING THIS ONE. It is a NECESSARY but NOT SUFFICIENT check,
   * and it has already been observed passing while the real app did the opposite.
   *
   * In jsdom nothing competes for focus, so React's `autoFocus` alone satisfies
   * this assertion. Measured live in an isolated headless Tauri instance on
   * 2026-08-03, the SAME code left `document.activeElement` on the chat popup's
   * `session-chat-conversation` container — an ancestor focus manager ran after
   * commit and took it back, so the reader had to click the box before typing.
   * That is why the component focuses via a rAF as well; this test cannot tell
   * the two implementations apart. A focus regression here must be re-checked in
   * a real webview, never signed off from this green.
   */
  it('opens on click and puts focus in the search box, so the reader can just type', () => {
    renderMenu();
    openMenu();
    const search = screen.getByTestId('chat-mode-mode-grade-search') as HTMLInputElement;
    expect(search.placeholder).toBe('Search rubrics…');
    expect(document.activeElement).toBe(search);
  });

  it('lists EVERY option with an empty query — the truncation is gone', () => {
    renderMenu();
    openMenu();
    expect(rows()).toHaveLength(23);
  });

  it('filters as you type — the owner asked for a search FILTER, not just a box', () => {
    renderMenu();
    openMenu();
    fireEvent.change(screen.getByTestId('chat-mode-mode-grade-search'), {
      target: { value: 'Rubric 07' },
    });
    const shown = rows().map((r) => r.textContent);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain('Rubric 07');
  });

  it('searches the second line too, so a rubric is findable by what it measures', () => {
    renderMenu();
    openMenu();
    fireEvent.change(screen.getByTestId('chat-mode-mode-grade-search'), {
      target: { value: 'release hygiene' },
    });
    expect(rows().map((r) => r.textContent)).toEqual([expect.stringContaining('Rubric 03')]);
  });

  it('picking a row reports it and closes', () => {
    const { onChange } = renderMenu();
    openMenu();
    fireEvent.click(rows()[5]);
    expect(onChange).toHaveBeenCalledWith('rubric-05');
    expect(screen.queryByTestId('popover-panel')).toBeNull();
  });

  it('re-opening starts from the full list, not the last query', () => {
    renderMenu();
    openMenu();
    fireEvent.change(screen.getByTestId('chat-mode-mode-grade-search'), {
      target: { value: 'Rubric 07' },
    });
    expect(rows()).toHaveLength(1);
    openMenu(); // close
    openMenu(); // and back
    expect((screen.getByTestId('chat-mode-mode-grade-search') as HTMLInputElement).value).toBe('');
    expect(rows()).toHaveLength(23);
  });

  it('notifies the caller on open, so an unbounded option set can be fetched lazily', () => {
    const onOpenChange = vi.fn();
    renderMenu({ onOpenChange });
    openMenu();
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it('says "no matches" rather than rendering an empty panel', () => {
    renderMenu();
    openMenu();
    fireEvent.change(screen.getByTestId('chat-mode-mode-grade-search'), {
      target: { value: 'zzzznothing' },
    });
    expect(rows()).toHaveLength(0);
    expect(screen.getByTestId('popover-panel').textContent).toContain('No matches');
  });

  /**
   * THE guard that jsdom cannot otherwise give us. `harness/Popover` defaults
   * its Content to z-index 90, and Radix copies a popper Content's z-index onto
   * the position:fixed wrapper inline — overriding harness.css's 1500 floor. 90
   * clears `<main>` (70) but NOT `.oracle-dock--maximal-hud` (1450), which is
   * where this menu lives. At 90 it would mount, position, report opacity 1 and
   * be completely unclickable — the P-006 defect the owner reported as "None of
   * the option selector dropdowns are working in the bottom panel".
   *
   * jsdom does not paint, so no render test can catch it. Asserting the VALUE
   * handed to the Popover is the honest guard at this layer. Primitive-level
   * fix tracked as EI-19470132622399873.
   */
  it('defaults to the popper wrapper floor, so it cannot paint behind the dock', () => {
    renderMenu();
    openMenu();
    expect(screen.getByTestId('popover-panel').getAttribute('data-z-index')).toBe('1500');
  });

  it('is disabled-safe: a disabled trigger cannot open the panel', () => {
    renderMenu({ disabled: true });
    const trigger = screen.getByTestId('chat-mode-mode-grade') as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    openMenu();
    expect(screen.queryByTestId('popover-panel')).toBeNull();
  });
});
