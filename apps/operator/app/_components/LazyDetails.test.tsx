// @vitest-environment jsdom
/**
 * Tests for <LazyDetails> — a Radix Collapsible disclosure that defers mounting
 * its children until the first expand, then keeps them mounted across later
 * collapse/expand cycles (so child state survives).
 *
 * Migrated from a native <details>/<summary> to @radix-ui/react-collapsible per
 * the design-primitives migration: toggling is driven by CLICKING the
 * Collapsible.Trigger (the summary), and the disclosure state is read from Radix's
 * `data-state` attribute rather than the native `.open` flag. The keep-mounted
 * invariant is preserved by `Collapsible.Content forceMount` + the `opened` gate.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { LazyDetails } from './LazyDetails';

afterEach(() => cleanup());

const child = <span data-testid="child">expensive child</span>;

/** Toggle the disclosure by clicking its trigger (the summary text). */
function toggle(summary = 'More'): void {
  fireEvent.click(screen.getByText(summary));
}

describe('LazyDetails', () => {
  it('renders the summary but not the children when collapsed', () => {
    render(<LazyDetails summary="More">{child}</LazyDetails>);
    expect(screen.getByText('More')).toBeTruthy();
    expect(screen.queryByTestId('child')).toBeNull();
  });

  it('renders children up front when defaultOpen', () => {
    render(<LazyDetails summary="More" defaultOpen>{child}</LazyDetails>);
    expect(screen.getByTestId('child')).toBeTruthy();
    // Radix marks the open trigger/root with data-state="open".
    expect(screen.getByText('More').getAttribute('data-state')).toBe('open');
  });

  it('mounts children on first expand', () => {
    render(<LazyDetails summary="More">{child}</LazyDetails>);
    expect(screen.queryByTestId('child')).toBeNull();
    toggle();
    expect(screen.getByTestId('child')).toBeTruthy();
  });

  it('keeps children mounted across a later collapse', () => {
    render(<LazyDetails summary="More">{child}</LazyDetails>);
    toggle(); // expand
    expect(screen.getByTestId('child')).toBeTruthy();
    toggle(); // collapse
    // Once mounted, children stay in the DOM (Collapsible just hides them via
    // forceMount) so internal child state survives the collapse.
    expect(screen.getByTestId('child')).toBeTruthy();
  });

  it('forwards className and summaryClassName', () => {
    const { container } = render(
      <LazyDetails summary="More" className="outer-cls" summaryClassName="sum-cls">
        {child}
      </LazyDetails>,
    );
    expect(container.querySelector('.outer-cls')).toBeTruthy();
    expect(screen.getByText('More').className).toBe('sum-cls');
  });
});
