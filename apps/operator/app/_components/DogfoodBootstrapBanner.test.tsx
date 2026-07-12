// @vitest-environment jsdom
/**
 * DogfoodBootstrapBanner.test.tsx — the app-wide, NON-blocking dogfood-clone bar.
 *
 * Public-release (WI-791): the dogfood clone is best-effort/non-fatal, so a
 * terminal-error bar must (a) read as non-fatal (NOT the old scary "Setting up
 * Papercusp workspace failed"), and (b) be DISMISSIBLE — never an app-wide nag a
 * public user (who can't access the private submodules) is stuck with.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import type { DogfoodBootstrapProgress } from './useDogfoodBootstrapProgress';

let progress: DogfoodBootstrapProgress;
vi.mock('./useDogfoodBootstrapProgress', async (orig) => {
  const actual = await orig<typeof import('./useDogfoodBootstrapProgress')>();
  return { ...actual, useDogfoodBootstrapProgress: () => progress };
});

import { DogfoodBootstrapBanner } from './DogfoodBootstrapBanner';

const errorProgress = (over: Partial<DogfoodBootstrapProgress> = {}): DogfoodBootstrapProgress => ({
  rows: [],
  clone: { step: 'clone', status: 'error', ts: 1 },
  hasRows: true,
  hasError: true,
  networkError: false,
  gitMissing: false,
  ready: false,
  inProgress: false,
  ...over,
});

afterEach(() => cleanup());

describe('DogfoodBootstrapBanner (public-release)', () => {
  it('frames a terminal error as non-fatal — not the old scary "failed" copy', () => {
    progress = errorProgress();
    render(<DogfoodBootstrapBanner />);
    expect(screen.getByText(/works fine without it/i)).toBeTruthy();
    expect(screen.queryByText(/Setting up Papercusp workspace failed/i)).toBeNull();
  });

  it('is DISMISSIBLE — the × hides the bar so it is never an unclearable nag', () => {
    progress = errorProgress();
    render(<DogfoodBootstrapBanner />);
    expect(screen.getByTestId('dogfood-bootstrap-banner')).toBeTruthy();
    fireEvent.click(screen.getByTestId('dogfood-bootstrap-dismiss'));
    expect(screen.queryByTestId('dogfood-bootstrap-banner')).toBeNull();
  });

  it('git-missing reads as optional, not a hard block', () => {
    progress = errorProgress({ gitMissing: true });
    render(<DogfoodBootstrapBanner />);
    expect(screen.getByText(/optional; the app works without it/i)).toBeTruthy();
  });

  it('stays hidden when there are no rows / nothing in progress', () => {
    progress = { ...errorProgress(), hasRows: false };
    const { container } = render(<DogfoodBootstrapBanner />);
    expect(container.firstChild).toBeNull();
  });

  // EI-9921: on a fresh/pristine install the "Sign in to GitHub…" banner used to
  // sit at `top: 0` — the SAME fixed position as the persistent EnvSwitcherBar —
  // and, having the higher z-index, permanently eclipsed the env switcher until
  // sign-in. It must instead stack BELOW the env bar via the same
  // `--pc-env-bar-h` offset convention EnvSwitcherBar documents (and globals.css's
  // .pc-header rule already uses), so both stay visible/usable together.
  it('EI-9921: offsets below the env-switcher bar via --pc-env-bar-h, never overlaps it at top:0', () => {
    progress = errorProgress({
      hasError: false,
      inProgress: true,
      clone: { step: 'clone', status: 'running', ts: 1, detail: 'Sign in to GitHub to begin the download' },
      activeStep: 'clone',
      activeDetail: 'Sign in to GitHub to begin the download',
    });
    render(<DogfoodBootstrapBanner />);
    const banner = screen.getByTestId('dogfood-bootstrap-banner');
    expect(banner.style.top).toBe('var(--pc-env-bar-h, 0px)');
    expect(banner.style.top).not.toBe('0px');
  });
});
