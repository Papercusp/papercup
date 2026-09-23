// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hostedBrowser = vi.hoisted(() => ({
  readMarker: vi.fn(),
  bootstrap: vi.fn(),
}));

vi.mock('../../lib/hosted-browser-api', () => ({
  readHostedBrowserApiMarker: hostedBrowser.readMarker,
  bootstrapHostedWorkspaceSelection: hostedBrowser.bootstrap,
}));

import HostedWorkspaceSelectionGate from './HostedWorkspaceSelectionGate';

beforeEach(() => {
  hostedBrowser.readMarker.mockReset();
  hostedBrowser.bootstrap.mockReset();
});

afterEach(() => cleanup());

describe('HostedWorkspaceSelectionGate', () => {
  it('does not delay the local operator', () => {
    hostedBrowser.readMarker.mockReturnValue(null);

    render(
      <HostedWorkspaceSelectionGate>
        <div data-testid="sync-started" />
      </HostedWorkspaceSelectionGate>,
    );

    expect(screen.getByTestId('sync-started')).toBeTruthy();
    expect(hostedBrowser.bootstrap).not.toHaveBeenCalled();
  });

  it('waits for hosted workspace selection before mounting sync', async () => {
    hostedBrowser.readMarker.mockReturnValue({ controlPlaneWorkspaceId: 'control-plane' });
    let resolveBootstrap!: (result: 'selected') => void;
    hostedBrowser.bootstrap.mockReturnValue(new Promise<'selected'>((resolve) => {
      resolveBootstrap = resolve;
    }));

    render(
      <HostedWorkspaceSelectionGate>
        <div data-testid="sync-started" />
      </HostedWorkspaceSelectionGate>,
    );

    expect(screen.getByRole('status').textContent).toBe('Loading your workspace…');
    expect(screen.queryByTestId('sync-started')).toBeNull();
    expect(hostedBrowser.bootstrap).toHaveBeenCalledTimes(1);

    await act(async () => resolveBootstrap('selected'));

    expect(screen.getByTestId('sync-started')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
