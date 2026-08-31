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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
   * EI-21925095206580441: RP.Content used to carry NO surface styling at
   * all, so a caller that forgot to paint `contentClassName` (or passed one
   * with no background rule) rendered a fully TRANSPARENT panel — every
   * structural assertion (rows present, role=dialog, aria-label) is equally
   * true of an invisible panel, so only a screenshot ever caught it.
   *
   * `pc-popover-content` (Popover.css) is now stamped unconditionally so the
   * failure mode inverts: painted-by-default, explicitly-overridden rather
   * than silently-invisible. This asserts BOTH halves of that fix, so
   * either regressing alone fails the test:
   *  - the TSX still merges the default class in (with AND without a
   *    caller contentClassName);
   *  - the stylesheet still declares a background for it.
   */
  it('always stamps the default pc-popover-content surface class, painted opaque', () => {
    render(
      <Popover open onOpenChange={vi.fn()} ariaLabel="x" trigger={<button>t</button>}>
        <div>body</div>
      </Popover>,
    );
    expect(screen.getByRole('dialog').classList.contains('pc-popover-content')).toBe(true);
  });

  it('keeps the default surface class alongside a caller contentClassName', () => {
    render(
      <Popover open onOpenChange={vi.fn()} ariaLabel="x" trigger={<button>t</button>} contentClassName="my-panel">
        <div>body</div>
      </Popover>,
    );
    const classes = screen.getByRole('dialog').classList;
    expect(classes.contains('pc-popover-content')).toBe(true);
    expect(classes.contains('my-panel')).toBe(true);
  });

  it('Popover.css declares a background for .pc-popover-content — the actual paint, not just the class name', () => {
    const css = readFileSync(join(__dirname, 'Popover.css'), 'utf8');
    const rule = /:where\(\.pc-popover-content\)\s*\{([^}]*)\}/.exec(css);
    expect(rule, 'expected a :where(.pc-popover-content) { ... } rule in Popover.css').toBeTruthy();
    expect(/background\s*:/.test(rule![1])).toBe(true);
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

/**
 * Focus-trap containment (WI-10013).
 *
 * A modal dialog traps focus to its own DOM subtree. Radix's default portal
 * target is `document.body`, so a popover opened from inside a modal mounts
 * OUTSIDE the trap — and the trap then reverts any focus landing in the panel
 * back to the trigger. The panel renders, positions, reports `opacity: 1`, and
 * is completely un-typeable.
 *
 * ⚠ THE OBVIOUS TEST FOR THIS DOES NOT WORK. Asserting `document.activeElement`
 * is the panel's input passes in jsdom whether or not the bug is present,
 * because nothing here competes for focus — no real modal focus trap is
 * running. A jsdom focus assertion is necessary-but-not-sufficient and it
 * green-lit a broken fix for this exact component once already.
 *
 * What jsdom CAN decide is CONTAINMENT, which is the actual invariant: the
 * panel must be a descendant of the trapping dialog. Assert that instead.
 */
describe('Popover portal containment inside a modal focus trap', () => {
  function ModalHost({ children }: { children: ReactElement }) {
    return (
      <div role="dialog" aria-modal="true" data-testid="modal-host">
        {children}
      </div>
    );
  }

  it('hosts the panel INSIDE the nearest aria-modal dialog, not on document.body', () => {
    render(
      <ModalHost>
        <Popover open onOpenChange={vi.fn()} ariaLabel="Rubrics" trigger={<button>pill</button>}>
          <input data-testid="panel-input" />
        </Popover>
      </ModalHost>,
    );
    const modal = screen.getByTestId('modal-host');
    const input = screen.getByTestId('panel-input');
    // The invariant: focus can only survive if the panel lives inside the trap.
    expect(modal.contains(input)).toBe(true);
  });

  it('still portals to document.body when there is NO modal ancestor', () => {
    render(
      <Popover open onOpenChange={vi.fn()} ariaLabel="Rubrics" trigger={<button>pill</button>}>
        <input data-testid="free-input" />
      </Popover>,
    );
    const input = screen.getByTestId('free-input');
    const modal = document.querySelector('[role="dialog"][aria-modal="true"]');
    // No trapping ancestor -> unchanged Radix default (body-hosted).
    expect(modal).toBeNull();
    expect(document.body.contains(input)).toBe(true);
  });

  it('honours an explicit portalContainer override over auto-detection', () => {
    const target = document.createElement('div');
    target.setAttribute('data-testid', 'explicit-host');
    document.body.appendChild(target);
    render(
      <ModalHost>
        <Popover
          open
          onOpenChange={vi.fn()}
          ariaLabel="Rubrics"
          portalContainer={target}
          trigger={<button>pill</button>}
        >
          <input data-testid="override-input" />
        </Popover>
      </ModalHost>,
    );
    const input = screen.getByTestId('override-input');
    expect(target.contains(input)).toBe(true);
    expect(screen.getByTestId('modal-host').contains(input)).toBe(false);
    target.remove();
  });
});
