/**
 * @vitest-environment jsdom
 *
 * BootstrapProgressIndicatorClient tests.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { BootstrapProgressIndicatorClient } from '../BootstrapProgressIndicatorClient';

afterEach(() => {
  cleanup();
});

function fetchReturning(body: unknown): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

function fetchFail(): typeof fetch {
  return vi.fn(async () => new Response('', { status: 500 })) as unknown as typeof fetch;
}

describe('BootstrapProgressIndicatorClient', () => {
  it('renders nothing when snapshot is null', async () => {
    render(
      <BootstrapProgressIndicatorClient
        slug="papercup"
        fetchImpl={fetchReturning({ progress: null })}
        refreshIntervalMs={0}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('bootstrap-progress-indicator')).toBeNull();
  });

  it('renders nothing when total = 0', async () => {
    render(
      <BootstrapProgressIndicatorClient
        slug="papercup"
        fetchImpl={fetchReturning({
          progress: {
            workspaceId: 'ws-1',
            harnessSlug: 'papercup',
            mergedOps: 0,
            highestSeen: 0,
            lastChangeMs: 1000,
            caughtUp: true,
          },
        })}
        refreshIntervalMs={0}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('bootstrap-progress-indicator')).toBeNull();
  });

  it('renders syncing pill when merged < highestSeen', async () => {
    render(
      <BootstrapProgressIndicatorClient
        slug="papercup"
        fetchImpl={fetchReturning({
          progress: {
            workspaceId: 'ws-1',
            harnessSlug: 'papercup',
            mergedOps: 5,
            highestSeen: 10,
            lastChangeMs: 1000,
            caughtUp: false,
          },
        })}
        refreshIntervalMs={0}
      />,
    );
    await waitFor(() => {
      expect(
        screen
          .getByTestId('bootstrap-progress-indicator')
          .getAttribute('data-state'),
      ).toBe('syncing');
    });
  });

  it('renders caught-up pill when merged === highestSeen', async () => {
    render(
      <BootstrapProgressIndicatorClient
        slug="papercup"
        fetchImpl={fetchReturning({
          progress: {
            workspaceId: 'ws-1',
            harnessSlug: 'papercup',
            mergedOps: 10,
            highestSeen: 10,
            lastChangeMs: 1000,
            caughtUp: true,
          },
        })}
        refreshIntervalMs={0}
      />,
    );
    await waitFor(() => {
      expect(
        screen
          .getByTestId('bootstrap-progress-indicator')
          .getAttribute('data-state'),
      ).toBe('caught-up');
    });
  });

  it('dismiss button hides the indicator', async () => {
    render(
      <BootstrapProgressIndicatorClient
        slug="papercup"
        fetchImpl={fetchReturning({
          progress: {
            workspaceId: 'ws-1',
            harnessSlug: 'papercup',
            mergedOps: 5,
            highestSeen: 10,
            lastChangeMs: 1000,
            caughtUp: false,
          },
        })}
        refreshIntervalMs={0}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('bootstrap-progress-indicator')).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId('bootstrap-progress-dismiss'));
    expect(screen.queryByTestId('bootstrap-progress-indicator')).toBeNull();
  });

  it('stays empty on fetch failure', async () => {
    render(
      <BootstrapProgressIndicatorClient
        slug="papercup"
        fetchImpl={fetchFail()}
        refreshIntervalMs={0}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('bootstrap-progress-indicator')).toBeNull();
  });

  it('appends idle_ms query param when provided', async () => {
    let capturedUrl = '';
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      capturedUrl =
        typeof input === 'string' ? input : (input as URL).toString();
      return new Response(JSON.stringify({ progress: null }), { status: 200 });
    }) as unknown as typeof fetch;
    render(
      <BootstrapProgressIndicatorClient
        slug="papercup"
        idleMs={5000}
        fetchImpl={fetchImpl}
        refreshIntervalMs={0}
      />,
    );
    await waitFor(() => {
      expect(capturedUrl).toContain('idle_ms=5000');
    });
  });

  it('URL-encodes the slug', async () => {
    let capturedUrl = '';
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      capturedUrl =
        typeof input === 'string' ? input : (input as URL).toString();
      return new Response(JSON.stringify({ progress: null }), { status: 200 });
    }) as unknown as typeof fetch;
    render(
      <BootstrapProgressIndicatorClient
        slug="a/b"
        fetchImpl={fetchImpl}
        refreshIntervalMs={0}
      />,
    );
    await waitFor(() => {
      expect(capturedUrl).toContain('/harness/a%2Fb/bootstrap-progress');
    });
  });
});
