// @vitest-environment jsdom
/**
 * NavigationProgress render coverage (Phase B6) — the headless router→progress-bar
 * driver. It renders nothing; its behaviour is the effect that advances/finishes
 * the bprogress bar off TanStack Router's `status`. Pins the three branches:
 *   • pending → start() + un-hides the bar;
 *   • idle → stop() + the stale-busy-class cleanup (removes bprogress-busy, hides bar);
 *   • suppressed origin (the :3070/:4173 embed) → never start(), force-idle cleanup.
 * `useRouterState` and `useProgress` are mocked; `window.location` is stubbed per case.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

const H = vi.hoisted(() => ({
  pending: false,
  start: vi.fn(),
  stop: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  useRouterState: ({ select }: { select: (s: { status: string }) => unknown }) =>
    select({ status: H.pending ? 'pending' : 'idle' }),
}));
vi.mock('@bprogress/react', () => ({
  useProgress: () => ({ start: H.start, stop: H.stop }),
}));

import { NavigationProgress } from './NavigationProgress';

function setOrigin(origin: string) {
  Object.defineProperty(window, 'location', {
    value: { ...window.location, origin },
    writable: true,
    configurable: true,
  });
}

beforeEach(() => {
  H.pending = false;
  H.start = vi.fn();
  H.stop = vi.fn();
  setOrigin('http://example.test'); // a non-suppressed origin by default
  document.documentElement.classList.add('bprogress-busy');
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('<NavigationProgress>', () => {
  it('renders nothing (headless driver)', () => {
    const { container } = render(<NavigationProgress />);
    expect(container.firstChild).toBeNull();
  });

  it('starts the bar while the router is pending', () => {
    H.pending = true;
    render(<NavigationProgress />);
    expect(H.start).toHaveBeenCalled();
    expect(H.stop).not.toHaveBeenCalled();
  });

  it('settles (stop + clears the stale busy class) when idle', () => {
    vi.useFakeTimers();
    H.pending = false;
    render(<NavigationProgress />);
    expect(H.stop).toHaveBeenCalled();
    // the cleanup is deferred 200ms after stop() — advance the timer
    vi.advanceTimersByTime(250);
    expect(document.documentElement.classList.contains('bprogress-busy')).toBe(false);
  });

  it('hides an existing idle bar element on settle', () => {
    vi.useFakeTimers();
    H.pending = false;
    const bar = document.createElement('div');
    bar.className = 'bprogress';
    document.body.appendChild(bar);
    render(<NavigationProgress />);
    vi.advanceTimersByTime(250);
    expect(bar.style.opacity).toBe('0');
    expect(bar.style.pointerEvents).toBe('none');
    bar.remove();
  });

  it('suppresses progress on an embedded origin: never starts, even while pending', () => {
    setOrigin('http://localhost:3070');
    H.pending = true;
    render(<NavigationProgress />);
    // suppress branch short-circuits before the pending start()
    expect(H.start).not.toHaveBeenCalled();
    expect(document.documentElement.classList.contains('bprogress-busy')).toBe(false);
  });
});
