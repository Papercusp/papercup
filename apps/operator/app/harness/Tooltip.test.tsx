// @vitest-environment jsdom
/**
 * Tooltip.test.tsx — render-tier coverage for the harness Tooltip wrapper
 * (a thin Radix-Tooltip composition). The interesting branch is the
 * `if (!label) return <>{children}</>` guard: with no label the trigger is
 * rendered bare (no Radix Provider/Root), with a label the Radix tree wraps
 * it. Hover-revealed `RT.Content` lives in a Portal and is gated behind
 * pointer-intent timers, so we assert the always-present trigger + the
 * guard branch rather than the deferred content.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { Tooltip } from './Tooltip';

afterEach(cleanup);

describe('Tooltip (harness Radix-Tooltip wrapper)', () => {
  it('renders children bare when no label is given (guard branch)', () => {
    render(
      <Tooltip label={null}>
        <button>plain trigger</button>
      </Tooltip>,
    );
    const btn = screen.getByText('plain trigger');
    expect(btn).toBeTruthy();
    // The bare-children branch does NOT wrap the trigger in a Radix tooltip
    // trigger, so there is no aria-describedby data-state attribute on it.
    expect(btn.getAttribute('data-state')).toBeNull();
  });

  it('renders children bare when label is an empty string (falsy guard)', () => {
    render(
      <Tooltip label="">
        <button>empty label</button>
      </Tooltip>,
    );
    expect(screen.getByText('empty label')).toBeTruthy();
  });

  it('wraps the trigger in a Radix tooltip when a label is present', () => {
    render(
      <Tooltip label="help text">
        <button>has tooltip</button>
      </Tooltip>,
    );
    const btn = screen.getByText('has tooltip');
    expect(btn).toBeTruthy();
    // Radix Tooltip.Trigger (asChild) stamps data-state on the trigger DOM
    // node, distinguishing the wrapped branch from the bare branch.
    expect(btn.getAttribute('data-state')).toBeTruthy();
  });

  it('forwards the trigger child element through Tooltip.Trigger asChild', () => {
    render(
      <Tooltip label="x">
        <a href="/foo" data-testid="anchor-trigger">link trigger</a>
      </Tooltip>,
    );
    // asChild composition keeps the original element type (an <a>, not a
    // wrapper <button>) and its href.
    const anchor = screen.getByTestId('anchor-trigger');
    expect(anchor.tagName).toBe('A');
    expect(anchor.getAttribute('href')).toBe('/foo');
  });
});
