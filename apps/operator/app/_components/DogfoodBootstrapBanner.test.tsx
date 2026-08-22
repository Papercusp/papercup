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
    // EI-10456: assert the INTENT (offsets below the env bar via --pc-env-bar-h,
    // never overlaps at top:0), NOT the exact serialized var() string. jsdom's
    // cssstyle serializes/validates a var() value on the standard `top` property
    // inconsistently across versions (whitespace after the comma, or an older
    // cssstyle that validated `top` as a length and dropped the value to ''),
    // which flip-flaked the old exact-equality assertion (`expected '' to be
    // 'var(--pc-env-bar-h, 0px)'`). A substring check on the custom-property
    // reference is stable across cssstyle serialization variance.
    expect(banner.style.top).toContain('--pc-env-bar-h');
    expect(banner.style.top).not.toBe('0px');
    expect(banner.style.top).not.toBe('0');
  });

  // WI-4729 is EI-9921 on the OTHER axis. EI-9921 stopped this bar eclipsing the
  // EnvSwitcherBar vertically; it still spanned the full viewport width at that
  // same top, so with its ~2.1e9 z-index (vs `.op-chat-sidebar`'s 1300) it
  // covered the chat sidebar's top ~30px — the header row — cutting off the
  // Papercup cup mark, which is exactly the symptom WI-4729 reported. The bar
  // must dock AFTER the chat sidebar via `--op-chat-w`, the same offset every
  // other viewport-anchored surface already uses (LeftSidebar, the dev-admin
  // rail, quick-panel, globals.css's `.operator-panel`).
  //
  // Asserted as a substring on the custom-property reference for the same
  // cssstyle-serialization reason documented on the EI-9921 case above. This
  // fails on the pre-fix `left: 0` (serialized '0px'), so it is falsifiable.
  it('WI-4729: docks after the chat sidebar via --op-chat-w, never covering its header at left:0', () => {
    progress = errorProgress({
      hasError: false,
      inProgress: true,
      clone: { step: 'clone', status: 'running', ts: 1, detail: 'Sign in to GitHub to begin the download' },
      activeStep: 'clone',
      activeDetail: 'Sign in to GitHub to begin the download',
    });
    render(<DogfoodBootstrapBanner />);
    const banner = screen.getByTestId('dogfood-bootstrap-banner');
    expect(banner.style.left).toContain('--op-chat-w');
    expect(banner.style.left).not.toBe('0px');
    expect(banner.style.left).not.toBe('0');
  });

  // EI-20500569364275377: the fixed banner must not intercept browser pointer
  // hit-testing for controls underneath it. Its dismiss button is the sole
  // intentional hit target and explicitly opts back in.
  it('EI-20500569364275377: is pointer-transparent except for its dismiss button', () => {
    progress = errorProgress();
    render(<DogfoodBootstrapBanner />);
    const banner = screen.getByTestId('dogfood-bootstrap-banner');
    const dismiss = screen.getByTestId('dogfood-bootstrap-dismiss');

    expect(banner.style.pointerEvents).toBe('none');
    expect(dismiss.style.pointerEvents).toBe('auto');
  });
});
