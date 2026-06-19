// @vitest-environment jsdom
/**
 * StudioTab.test.tsx — render-branch coverage for the /dev Drizzle Studio embed.
 * Exercises the three render states gated on the /api/dev/drizzle-studio probe:
 *   - checking (initial, before the first probe resolves)
 *   - offline (running: false) + the error / lastStderr branches + Start click
 *   - running (running: true) + the toolbar (port, external link, Stop click)
 * The probe is a plain fetch we stub per-method; no sync/nuqs here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import StudioTab from './StudioTab';

/* ── fetch stub ─────────────────────────────────────────────────────── */
// The component GETs on mount + polls; POST starts, DELETE stops. We drive
// the GET body per-test via `getBody`, and record method calls to assert
// handlers fire.
let getBody: Record<string, unknown>;
let postBody: Record<string, unknown>;
const calls: Array<{ method: string }> = [];

function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ method });
      if (method === 'POST') {
        return new Response(JSON.stringify(postBody), { status: 200 });
      }
      if (method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify(getBody), { status: 200 });
    }),
  );
}

beforeEach(() => {
  getBody = { running: false };
  postBody = { running: false };
  calls.length = 0;
  installFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('StudioTab (/dev Drizzle Studio embed)', () => {
  it('shows the connecting state before the first probe resolves, then the offline state', async () => {
    render(<StudioTab />);
    // Synchronous first render: checking === true.
    expect(screen.getByText(/Connecting to Drizzle Studio/i)).toBeTruthy();
    // After the GET resolves (running:false) → offline empty state.
    await waitFor(() => expect(screen.getByText(/Drizzle Studio is not running/i)).toBeTruthy());
    expect(screen.getByRole('button', { name: /Start Drizzle Studio/i })).toBeTruthy();
  });

  it('renders the lastStderr block in the offline state', async () => {
    getBody = { running: false, lastStderr: 'EADDRINUSE: port busy' };
    render(<StudioTab />);
    await waitFor(() => expect(screen.getByText(/EADDRINUSE: port busy/i)).toBeTruthy());
  });

  it('Start button POSTs and surfaces a returned error', async () => {
    postBody = { running: false, error: 'spawn failed' };
    render(<StudioTab />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Start Drizzle Studio/i })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /Start Drizzle Studio/i }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    await waitFor(() => expect(screen.getByText(/spawn failed/i)).toBeTruthy());
  });

  it('renders the running toolbar (port, external link, Stop) when the gateway is up', async () => {
    getBody = { running: true, port: 4983 };
    render(<StudioTab />);
    await waitFor(() => expect(screen.getByText(/running on :4983/i)).toBeTruthy());
    // Toolbar title + external link + Stop button + iframe.
    expect(screen.getByRole('button', { name: /Stop/i })).toBeTruthy();
    const link = screen.getByRole('link', { name: /Open in new tab/i }) as HTMLAnchorElement;
    expect(link.href).toContain('local.drizzle.studio');
    expect(link.href).toContain('port=4983');
    expect(document.querySelector('iframe.pc-studio-iframe')).toBeTruthy();
  });

  it('Stop button issues a DELETE then refreshes', async () => {
    getBody = { running: true, port: 4983 };
    render(<StudioTab />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Stop/i })).toBeTruthy());

    // After Stop, the refresh GET returns running:false → back to offline.
    getBody = { running: false };
    fireEvent.click(screen.getByRole('button', { name: /Stop/i }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
    await waitFor(() => expect(screen.getByText(/Drizzle Studio is not running/i)).toBeTruthy());
  });
});
