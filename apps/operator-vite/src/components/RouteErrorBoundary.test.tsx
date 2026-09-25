// @vitest-environment jsdom
/**
 * RouteErrorBoundary coverage — the boundary that wraps the route <Outlet/> so a
 * single tab's render throw shows a recoverable card (Reload / Try again / details)
 * instead of latching TanStack's bare root boundary across every tab. Covers: pass-
 * through when children render; the fallback on a caught throw; the WORKING Reload
 * (hardReload); Try-again re-render; the details expand/collapse toggle; and the
 * escape-on-navigate reset (a changed location clears the error).
 *
 * componentDidCatch logs via console.error by design — React also logs the caught
 * error — so every throwing test suppresses console.error (Vitest is fail-on-console).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const H = vi.hoisted(() => ({ href: '/adv?tab=a', hardReload: vi.fn(), explode: true }));

vi.mock('@tanstack/react-router', () => ({ useLocation: () => ({ href: H.href }) }));
vi.mock('@papercusp/operator-core/lib/hard-reload', () => ({ hardReload: H.hardReload }));

import RouteErrorBoundary, {
  CHUNK_DELAYED_RETRY_MAX,
  CHUNK_DELAYED_RETRY_WINDOW_MS,
  delayedChunkRetryMs,
  pruneRetryLog,
} from './RouteErrorBoundary';
import { resetRenderCrashReportDedupForTest } from '../lib/render-crash-report';

// Throws based on a module-level flag rather than a prop, so a re-render driven by
// the boundary's OWN setState (Try again) re-evaluates the latest flag — exactly
// how a transient cause (a stale chunk that got refetched) clears in production.
function Boom(): React.ReactElement {
  if (H.explode) throw new Error('kaboom in a tab');
  return <div data-testid="happy">all good</div>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  H.href = '/adv?tab=a';
  // Clear (don't reassign) — the vi.mock factory bound this exact fn reference.
  H.hardReload.mockClear();
  H.explode = true;
  resetRenderCrashReportDedupForTest();
});

describe('<RouteErrorBoundary>', () => {
  it('renders children when nothing throws', () => {
    H.explode = false;
    render(
      <RouteErrorBoundary>
        <Boom />
      </RouteErrorBoundary>,
    );
    expect(screen.getByTestId('happy')).toBeTruthy();
  });

  it('shows the recoverable fallback card when a child throws', () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <RouteErrorBoundary>
        <Boom />
      </RouteErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('This view hit an error')).toBeTruthy();
    expect(screen.getByText('Reload')).toBeTruthy();
    expect(screen.getByText('Try again')).toBeTruthy();
    // Stack is hidden until expanded.
    expect(screen.queryByText(/kaboom in a tab/)).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith('/api/desktop/telemetry-report', expect.objectContaining({ method: 'POST' }));
  });

  it('Reload calls hardReload (the desktop-host-safe reload)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <RouteErrorBoundary>
        <Boom />
      </RouteErrorBoundary>,
    );
    fireEvent.click(screen.getByText('Reload'));
    expect(H.hardReload).toHaveBeenCalledTimes(1);
  });

  it('Show details toggles the stack trace open and closed', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <RouteErrorBoundary>
        <Boom />
      </RouteErrorBoundary>,
    );
    fireEvent.click(screen.getByText('Show details'));
    // The error text now shows in BOTH the message surface and the JS stack
    // (ErrorDetail surfaces message + component stack + stack), so match all.
    expect(screen.getAllByText(/kaboom in a tab/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText('Hide details'));
    expect(screen.queryAllByText(/kaboom in a tab/).length).toBe(0);
  });

  it('Try again clears the error and re-renders the children once the cause is gone', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <RouteErrorBoundary>
        <Boom />
      </RouteErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    // The transient cause clears, THEN Try again re-mounts the children (the
    // boundary's setState re-renders Boom, which now reads explode=false).
    H.explode = false;
    fireEvent.click(screen.getByText('Try again'));
    expect(screen.getByTestId('happy')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('escapes on navigate: a changed location clears the latched error', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { rerender } = render(
      <RouteErrorBoundary>
        <Boom />
      </RouteErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    // Navigate (new ?tab=) — the functional wrapper threads the new href as
    // resetKey, so componentDidUpdate clears the error and the new route mounts.
    H.explode = false;
    H.href = '/adv?tab=b';
    rerender(
      <RouteErrorBoundary>
        <Boom />
      </RouteErrorBoundary>,
    );
    expect(screen.getByTestId('happy')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('delayedChunkRetryMs', () => {
  const chunkErr = new Error('Importing a module script failed.');

  it('is null for a non-chunk error', () => {
    expect(delayedChunkRetryMs(new Error('kaboom'), 100_000, 90_000, 0)).toBeNull();
  });

  it('is null when the immediate path owns it (debounce already expired)', () => {
    expect(delayedChunkRetryMs(chunkErr, 200_000, 100_000, 0)).toBeNull();
  });

  it('waits out the remaining debounce plus the build-settle pad', () => {
    // last reload 10s ago → 50s of debounce left + 5s pad
    expect(delayedChunkRetryMs(chunkErr, 110_000, 100_000, 0)).toBe(55_000);
  });

  it('gives up past the retry cap so a broken build cannot reload-loop', () => {
    expect(delayedChunkRetryMs(chunkErr, 110_000, 100_000, CHUNK_DELAYED_RETRY_MAX)).toBeNull();
    expect(
      delayedChunkRetryMs(chunkErr, 110_000, 100_000, CHUNK_DELAYED_RETRY_MAX - 1),
    ).toBe(55_000);
  });
});

describe('pruneRetryLog', () => {
  it('drops timestamps outside the sliding window so an exhausted tab heals', () => {
    const now = 10_000_000;
    const stale = now - CHUNK_DELAYED_RETRY_WINDOW_MS - 1;
    const fresh = now - 1_000;
    expect(pruneRetryLog(JSON.stringify([stale, fresh]), now)).toEqual([fresh]);
  });
  it('tolerates garbage and legacy scalar values', () => {
    expect(pruneRetryLog('not json', 1_000)).toEqual([]);
    expect(pruneRetryLog('5', 1_000)).toEqual([]); // old lifetime-counter format
    expect(pruneRetryLog(null, 1_000)).toEqual([]);
    expect(pruneRetryLog(JSON.stringify(['x', 500]), 1_000)).toEqual([500]);
  });
});
