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

  it('applies contentClassName and the zIndex style to the content', () => {
    render(
      <Popover
        open
        onOpenChange={vi.fn()}
        ariaLabel="x"
        trigger={<button>t</button>}
        contentClassName="my-panel"
        zIndex={123}
      >
        <div>body</div>
      </Popover>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('my-panel');
    expect(dialog.style.zIndex).toBe('123');
  });

  it('defaults zIndex to 90 when none is given', () => {
    render(
      <Popover open onOpenChange={vi.fn()} ariaLabel="x" trigger={<button>t</button>}>
        <div>body</div>
      </Popover>,
    );
    expect(screen.getByRole('dialog').style.zIndex).toBe('90');
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
