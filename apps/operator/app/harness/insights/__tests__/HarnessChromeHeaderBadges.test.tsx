/**
 * @vitest-environment jsdom
 *
 * HarnessChromeHeaderBadges tests.
 *
 * Only verifies the composition surface (which children render). Each
 * child has its own test suite.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { HarnessChromeHeaderBadges } from '../HarnessChromeHeaderBadges';

afterEach(() => {
  cleanup();
});

// Stub fetch so each child's mount-effect doesn't error in jsdom.
function stubFetch(): void {
  (globalThis as { fetch?: typeof fetch }).fetch = vi.fn(async () =>
    new Response(JSON.stringify({}), { status: 200 }),
  ) as unknown as typeof fetch;
}

describe('HarnessChromeHeaderBadges', () => {
  it('renders the wrapper', async () => {
    stubFetch();
    render(<HarnessChromeHeaderBadges slug="papercup" />);
    await waitFor(() => {
      expect(
        screen.getByTestId('harness-chrome-header-badges'),
      ).toBeTruthy();
    });
  });

  it('renders substrate-status badge by default', async () => {
    stubFetch();
    render(<HarnessChromeHeaderBadges slug="papercup" />);
    await waitFor(() => {
      expect(screen.getByTestId('substrate-status-badge')).toBeTruthy();
    });
  });

  it('hides substrate badge when hideSubstrateBadge', async () => {
    stubFetch();
    render(
      <HarnessChromeHeaderBadges
        slug="papercup"
        hideSubstrateBadge
      />,
    );
    await waitFor(() => {
      expect(
        screen.getByTestId('harness-chrome-header-badges'),
      ).toBeTruthy();
    });
    expect(screen.queryByTestId('substrate-status-badge')).toBeNull();
  });

  it('hides bootstrap progress when hideBootstrapProgress (and there is nothing to show)', async () => {
    stubFetch();
    render(
      <HarnessChromeHeaderBadges
        slug="papercup"
        hideBootstrapProgress
      />,
    );
    await waitFor(() => {
      expect(
        screen.getByTestId('harness-chrome-header-badges'),
      ).toBeTruthy();
    });
    expect(screen.queryByTestId('bootstrap-progress-indicator')).toBeNull();
  });

  it('hides both children when both flags set (only wrapper renders)', async () => {
    stubFetch();
    render(
      <HarnessChromeHeaderBadges
        slug="papercup"
        hideSubstrateBadge
        hideBootstrapProgress
      />,
    );
    const wrap = screen.getByTestId('harness-chrome-header-badges');
    expect(wrap).toBeTruthy();
    expect(wrap.textContent).toBe('');
  });
});
