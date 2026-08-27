// @vitest-environment jsdom
/**
 * DesktopConsoleLaunchBridge — setup rejection coverage for the Windows
 * console-launch relay. A browser must not redeem an untargeted ticket, a
 * different desktop must not redeem a targeted ticket, and an actual Tauri
 * webview with a dead content-origin bridge must fail its own request
 * immediately rather than consuming the agent's 30s timeout.
 */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  desktopAllowed: false,
  desktopRuntime: false,
  clientId: 'desktop-a',
  listener: null as ((event: { name: string; args?: unknown }) => void) | null,
}));

vi.mock('@/lib/ipc-status-tauri', () => ({
  canUseContentOriginDesktopActions: () => h.desktopAllowed,
  isDesktop: () => h.desktopRuntime,
}));
vi.mock('@papercusp/operator-core/lib/ui/client-id', () => ({
  getOrCreateClientId: () => h.clientId,
}));
vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: (listener: (event: { name: string; args?: unknown }) => void) => {
    h.listener = listener;
    return () => { h.listener = null; };
  },
}));

import DesktopConsoleLaunchBridge from './DesktopConsoleLaunchBridge';

const response = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });

async function mountAndEmit(args: Record<string, unknown>) {
  render(<DesktopConsoleLaunchBridge />);
  await act(async () => { await Promise.resolve(); });
  await act(async () => {
    h.listener?.({ name: 'console.launch-request', args });
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  h.desktopAllowed = false;
  h.desktopRuntime = false;
  h.clientId = 'desktop-a';
  h.listener = null;
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('DesktopConsoleLaunchBridge setup rejection', () => {
  it('does not let a plain browser consume an untargeted ticket', async () => {
    await mountAndEmit({ ticket: 'ticket-1' });

    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not let a different desktop consume a targeted ticket', async () => {
    h.desktopRuntime = true;
    await mountAndEmit({ ticket: 'ticket-2', targetClientId: 'desktop-other' });

    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports an unavailable Tauri bridge immediately from its desktop webview', async () => {
    h.desktopRuntime = true;
    vi.mocked(fetch).mockImplementation(async (input) => {
      if (String(input).endsWith('/console/launch-claim')) {
        return response({ granted: true });
      }
      return response({ status: 'ok', known: true });
    });

    await mountAndEmit({ ticket: 'ticket-3', targetClientId: 'desktop-a' });

    expect(fetch).toHaveBeenCalledTimes(2);
    const [claimUrl, claimInit] = vi.mocked(fetch).mock.calls[0];
    expect(claimUrl).toBe('/api/agent-mcp/console/launch-claim');
    expect(JSON.parse(String(claimInit?.body))).toEqual({
      ticket: 'ticket-3',
      clientId: 'desktop-a',
    });
    const [resultUrl, resultInit] = vi.mocked(fetch).mock.calls[1];
    expect(resultUrl).toBe('/api/agent-mcp/console/launch-result');
    expect(JSON.parse(String(resultInit?.body))).toMatchObject({
      ticket: 'ticket-3',
      ok: false,
      error: expect.stringMatching(/bridge unavailable/i),
    });
  });
});
