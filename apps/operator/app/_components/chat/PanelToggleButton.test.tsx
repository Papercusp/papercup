// @vitest-environment jsdom
/**
 * PanelToggleButton — the panel show/hide GRAMMAR, guarded.
 *
 * Two popups (SessionChatModal, GoalDetailPanel) render ten of these, and the
 * whole reason the component exists is that the grammar was previously written
 * out at each call site — where it drifted: the goal popup's five toggles
 * swapped their text on click ("Orders" → "Hide orders") while the sessions
 * popup's kept a constant label and moved a chevron
 * [owner 2026-08-10: "mimic the design used in the equivalent popup in the
 * sessions tab for the hide and expand buttons instead of how it is currently
 * 'hide order hide brief etc.'"].
 *
 * So these cases pin the two claims a reader of that owner report would check:
 * the VISIBLE label never changes, and the chevron points where the panel is
 * about to move. Both are invisible to a test that only clicks the button and
 * asserts the callback fired — which is what the call sites already had.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import PanelToggleButton from './PanelToggleButton';

afterEach(cleanup);

/** The chevron actually rendered, by lucide's own `lucide-<name>` stamp. */
function chevron(btn: HTMLElement): { dir: 'left' | 'right' | null; leads: boolean } {
  const svg = btn.querySelector('svg');
  if (!svg) return { dir: null, leads: false };
  const dir = svg.classList.contains('lucide-chevron-left')
    ? 'left'
    : svg.classList.contains('lucide-chevron-right')
      ? 'right'
      : null;
  /* Leading = the glyph comes before the label TEXT NODE. `firstElementChild`
     is the wrong probe and silently passes both ways: the label is a bare text
     node, so the svg is the first ELEMENT whether it leads or trails. */
  return { dir, leads: btn.firstChild === svg };
}

describe('PanelToggleButton', () => {
  it('keeps the label CONSTANT in both states — the button names the panel, never the verb', () => {
    const { rerender } = render(
      <PanelToggleButton label="Orders" side="left" open={false} onToggle={() => {}} data-testid="t" />,
    );
    expect(screen.getByTestId('t').textContent).toBe('Orders');
    rerender(
      <PanelToggleButton label="Orders" side="left" open onToggle={() => {}} data-testid="t" />,
    );
    // The regression this exists to catch: "Hide orders" here re-widens the
    // control under the reader's cursor and shuffles every button beside it.
    expect(screen.getByTestId('t').textContent).toBe('Orders');
  });

  /* The whole rule in four rows. A left-pointing chevron always LEADS the label
     and a right-pointing one always TRAILS it, because the glyph sits on the
     side the panel's inner edge is about to travel toward. */
  const cases: Array<{ side: 'left' | 'right'; open: boolean; dir: 'left' | 'right'; leads: boolean }> = [
    { side: 'left', open: true, dir: 'left', leads: true }, // closes leftward
    { side: 'left', open: false, dir: 'right', leads: false }, // opens rightward
    { side: 'right', open: true, dir: 'right', leads: false }, // closes rightward
    { side: 'right', open: false, dir: 'left', leads: true }, // opens leftward
  ];
  for (const c of cases) {
    it(`points the chevron ${c.dir} (${c.leads ? 'leading' : 'trailing'}) for a ${c.open ? 'open' : 'closed'} ${c.side}-side panel`, () => {
      render(
        <PanelToggleButton
          label="Panel"
          side={c.side}
          open={c.open}
          onToggle={() => {}}
          data-testid="t"
        />,
      );
      const btn = screen.getByTestId('t');
      expect(chevron(btn)).toEqual({ dir: c.dir, leads: c.leads });
      // Exactly ONE chevron — an earlier hand-written call site could (and a
      // future edit still could) render both by getting a ternary backwards.
      expect(btn.querySelectorAll('svg').length).toBe(1);
    });
  }

  it('spells the ACTION out for a screen reader, which cannot see a chevron point', () => {
    const { rerender } = render(
      <PanelToggleButton
        label="Activity"
        describe="agent activity"
        side="right"
        open={false}
        onToggle={() => {}}
        data-testid="t"
      />,
    );
    expect(screen.getByTestId('t').getAttribute('aria-label')).toBe('Show agent activity');
    expect(screen.getByTestId('t').getAttribute('aria-pressed')).toBe('false');
    rerender(
      <PanelToggleButton
        label="Activity"
        describe="agent activity"
        side="right"
        open
        onToggle={() => {}}
        data-testid="t"
      />,
    );
    expect(screen.getByTestId('t').getAttribute('aria-label')).toBe('Hide agent activity');
    expect(screen.getByTestId('t').getAttribute('aria-pressed')).toBe('true');
  });

  it('falls back to the lower-cased label when no `describe` is given', () => {
    render(<PanelToggleButton label="Fleet" side="right" open={false} onToggle={() => {}} data-testid="t" />);
    expect(screen.getByTestId('t').getAttribute('aria-label')).toBe('Show fleet');
  });

  it('fires the toggle once per click', () => {
    const onToggle = vi.fn();
    render(<PanelToggleButton label="Brief" side="left" open onToggle={onToggle} data-testid="t" />);
    fireEvent.click(screen.getByTestId('t'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
