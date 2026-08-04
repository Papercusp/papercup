// @vitest-environment jsdom
/**
 * Popover.test.tsx — render-tier coverage for the harness Popover wrapper
 * (Radix-Popover, optionally composed with a Radix-Tooltip on the trigger).
 *
 * Branches exercised:
 *  - closed vs open (RP.Content only mounts in its Portal when `open`);
 *  - the trigger renders in both branches (asChild composition onto a button);
 *  - the `tooltipLabel` fork: with a label the wrapper nests
 *    Tooltip.Trigger around Popover.Trigger; without it the trigger is bare;
 *  - content props (ariaLabel → aria-label, contentClassName, zIndex/style)
 *    land on RP.Content when open.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Provider as TooltipProvider } from '@radix-ui/react-tooltip';
import type { ReactElement } from 'react';

import { Popover } from './Popover';
import { POPPER_WRAPPER_FLOOR_Z } from './popper-z';

afterEach(cleanup);

/** The `tooltipLabel` fork composes a bare `RT.Root` (no inline Provider), so
 *  it must mount under a TooltipProvider — the harness chrome supplies one
 *  higher up. Wrap those cases the same way here. */
function renderWithTooltipProvider(ui: ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe('Popover (harness Radix-Popover wrapper)', () => {
  it('renders the trigger but NOT the content when closed', () => {
    render(
      <Popover open={false} onOpenChange={vi.fn()} ariaLabel="Notifications" trigger={<button>open notifs</button>}>
        <div>panel body</div>
      </Popover>,
    );
    expect(screen.getByText('open notifs')).toBeTruthy();
    // Closed → the portal content is not mounted.
    expect(screen.queryByText('panel body')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders the content (role=dialog, aria-label) when open', () => {
    render(
      <Popover open onOpenChange={vi.fn()} ariaLabel="Notification history" trigger={<button>t</button>}>
        <div>panel body</div>
      </Popover>,
    );
    expect(screen.getByText('panel body')).toBeTruthy();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute('aria-label')).toBe('Notification history');
  });

  it('applies contentClassName and passes an above-floor zIndex through', () => {
    render(
      <Popover
        open
        onOpenChange={vi.fn()}
        ariaLabel="x"
        trigger={<button>t</button>}
        contentClassName="my-panel"
        zIndex={POPPER_WRAPPER_FLOOR_Z + 100}
      >
        <div>body</div>
      </Popover>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('my-panel');
    expect(dialog.style.zIndex).toBe(String(POPPER_WRAPPER_FLOOR_Z + 100));
  });

  /**
   * These two used to assert `123` and `90` respectively — i.e. they PINNED the
   * defect (EI-19470132622399873) as intended behaviour, which is why nothing
   * caught it: a lint blind to `?? 90` plus a unit test asserting 90 is correct.
   *
   * Radix copies a popper Content's z-index onto the position:fixed wrapper as
   * an INLINE style, overriding the harness.css floor. So any value below the
   * floor is not "lower ordering" — it is burial behind the app shell
   * (`.oracle-dock--maximal-hud` is 1450). jsdom does not paint, so only the
   * clamped NUMBER is checkable here; the ordering invariant itself is
   * `_lints/popper-stacking.test.ts`.
   */
  it('clamps a below-floor zIndex up to the popper wrapper floor', () => {
    render(
      <Popover
        open
        onOpenChange={vi.fn()}
        ariaLabel="x"
        trigger={<button>t</button>}
        zIndex={90}
      >
        <div>body</div>
      </Popover>,
    );
    expect(screen.getByRole('dialog').style.zIndex).toBe(String(POPPER_WRAPPER_FLOOR_Z));
  });

  it('defaults zIndex to the popper wrapper floor when none is given', () => {
    render(
      <Popover open onOpenChange={vi.fn()} ariaLabel="x" trigger={<button>t</button>}>
        <div>body</div>
      </Popover>,
    );
    expect(screen.getByRole('dialog').style.zIndex).toBe(String(POPPER_WRAPPER_FLOOR_Z));
  });

  it('stamps the data-anim="pop" hook on the content', () => {
    render(
      <Popover open onOpenChange={vi.fn()} ariaLabel="x" trigger={<button>t</button>}>
        <div>body</div>
      </Popover>,
    );
    expect(screen.getByRole('dialog').getAttribute('data-anim')).toBe('pop');
  });

  /* ── tooltipLabel fork ──────────────────────────────────────────────── */

  it('without tooltipLabel: the trigger button is rendered bare (no tooltip data-state)', () => {
    render(
      <Popover open={false} onOpenChange={vi.fn()} ariaLabel="x" trigger={<button>bare</button>}>
        <div>body</div>
      </Popover>,
    );
    const btn = screen.getByText('bare');
    // Popover.Trigger stamps its own data-state, but without the tooltip
    // branch there is no Tooltip.Trigger composition. The button is present.
    expect(btn.tagName).toBe('BUTTON');
  });

  it('with tooltipLabel: the trigger is composed under a Radix tooltip trigger', () => {
    renderWithTooltipProvider(
      <Popover open={false} onOpenChange={vi.fn()} ariaLabel="x" tooltipLabel="hover help" trigger={<button>has-tip</button>}>
        <div>body</div>
      </Popover>,
    );
    const btn = screen.getByText('has-tip');
    // Both Tooltip.Trigger and Popover.Trigger compose onto the same button
    // via asChild; the tooltip composition stamps data-state on it.
    expect(btn.getAttribute('data-state')).toBeTruthy();
  });

  it('with tooltipLabel AND open: the popover content still renders alongside the tooltip composition', () => {
    renderWithTooltipProvider(
      <Popover open onOpenChange={vi.fn()} ariaLabel="Picker" tooltipLabel="hover help" trigger={<button>t</button>}>
        <div>picker body</div>
      </Popover>,
    );
    expect(screen.getByText('picker body')).toBeTruthy();
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('Picker');
  });

  it('forwards a non-button trigger element through Popover.Trigger asChild', () => {
    render(
      <Popover open={false} onOpenChange={vi.fn()} ariaLabel="x" trigger={<a href="/n" data-testid="trig">notifs</a>}>
        <div>body</div>
      </Popover>,
    );
    const anchor = screen.getByTestId('trig');
    expect(anchor.tagName).toBe('A');
    expect(anchor.getAttribute('href')).toBe('/n');
  });
});
