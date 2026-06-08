// @vitest-environment jsdom
/**
 * Tests for <LazyDetails> — a native <details> that defers mounting its
 * children until the first expand, then keeps them mounted across later
 * collapse/expand cycles (so child state survives).
 *
 * The key behaviours: collapsed → children absent; first expand → children
 * mount; a subsequent collapse keeps them mounted; defaultOpen renders them
 * up front. Toggling is driven through the native <details> open flag + the
 * `toggle` event (deterministic; doesn't lean on jsdom's summary-click).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { LazyDetails } from './LazyDetails';

afterEach(() => cleanup());

const child = <span data-testid="child">expensive child</span>;

// jsdom doesn't dispatch the native `toggle` event when `.open` flips, so
// drive both directly. fireEvent(node, event) wraps the dispatch in act.
function expand(details: HTMLDetailsElement) {
  act(() => { details.open = true; });
  fireEvent(details, new Event('toggle'));
}
function collapse(details: HTMLDetailsElement) {
  act(() => { details.open = false; });
  fireEvent(details, new Event('toggle'));
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
    expect(document.querySelector('details')?.hasAttribute('open')).toBe(true);
  });

  it('mounts children on first expand', () => {
    render(<LazyDetails summary="More">{child}</LazyDetails>);
    expect(screen.queryByTestId('child')).toBeNull();
    expand(document.querySelector('details') as HTMLDetailsElement);
    expect(screen.getByTestId('child')).toBeTruthy();
  });

  it('keeps children mounted across a later collapse', () => {
    render(<LazyDetails summary="More">{child}</LazyDetails>);
    const details = document.querySelector('details') as HTMLDetailsElement;
    expand(details);
    expect(screen.getByTestId('child')).toBeTruthy();
    collapse(details);
    // Once mounted, children stay in the DOM (details just hides them) so
    // internal child state survives the collapse.
    expect(screen.getByTestId('child')).toBeTruthy();
  });
});
