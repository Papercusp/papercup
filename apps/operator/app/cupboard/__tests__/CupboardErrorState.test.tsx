/**
 * @vitest-environment jsdom
 *
 * CupboardErrorState (EI-215) — the shared friendly error slot for the
 * Cupboard listings/tools/detail surfaces. Pins the two halves of the fix:
 * raw exception text never renders as the headline (WebKit's
 * "TypeError: Load failed" was the live repro), and an inline Retry
 * affordance re-invokes the fetch.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CupboardErrorState, friendlyCupboardError } from '../CupboardErrorState';

afterEach(() => cleanup());

describe('friendlyCupboardError', () => {
  it('maps WebKit network failures to reachability copy', () => {
    expect(friendlyCupboardError('TypeError: Load failed', 'listings')).toMatch(
      /Couldn't reach the Cupboard server/,
    );
    expect(friendlyCupboardError('TypeError: Failed to fetch', 'tools')).toMatch(
      /Couldn't reach the Cupboard server/,
    );
  });

  it('maps HTTP 404 on the detail surface to unpublished/removed copy', () => {
    expect(friendlyCupboardError('Error: HTTP 404', 'this listing')).toMatch(
      /doesn't exist/,
    );
  });

  it('maps HTTP 503 to the configuration hint and 5xx to a server-error line', () => {
    expect(friendlyCupboardError('Error: HTTP 503', 'listings')).toMatch(
      /PAPERCUSP_CUPBOARD_URL/,
    );
    expect(friendlyCupboardError('Error: HTTP 500', 'listings')).toMatch(/HTTP 500/);
  });
});

describe('CupboardErrorState', () => {
  it('renders friendly headline, keeps the raw error muted, and Retry fires the callback', () => {
    const onRetry = vi.fn();
    render(<CupboardErrorState raw="TypeError: Load failed" what="listings" onRetry={onRetry} />);

    // Friendly copy is present; the raw text appears only in the muted span.
    expect(screen.getByText(/Couldn't reach the Cupboard server/)).toBeTruthy();
    expect(screen.getByText('(TypeError: Load failed)')).toBeTruthy();

    fireEvent.click(screen.getByTestId('cupboard-error-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
