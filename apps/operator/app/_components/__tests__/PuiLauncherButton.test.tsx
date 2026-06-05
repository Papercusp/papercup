/**
 * @vitest-environment jsdom
 *
 * PuiLauncherButton — the "PUI" CTA next to OPS in the global header (Brief 26).
 * Verifies it renders (label + terminal glyph + the OPS-matching CTA classes)
 * and that a click POSTs the launch route and toasts the outcome.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

import { PuiLauncherButton } from '../PuiLauncherButton';

const fetchMock = vi.fn();

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PuiLauncherButton', () => {
  it('renders a PUI button with a terminal glyph, matching the OPS CTA classes', () => {
    render(<PuiLauncherButton />);
    const btn = screen.getByRole('button', { name: /pui workbench/i });
    expect(btn.textContent).toContain('PUI');
    expect(btn.className).toContain('pc-header-cta');
    expect(btn.className).toContain('pc-header-cta--mission');
    // The TerminalMark SVG glyph is present inside the orb.
    expect(btn.querySelector('.pc-header-cta-orb svg')).not.toBeNull();
  });

  it('click → POSTs /api/adv/sessions/launch-pui and toasts success with the terminal name', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'ok', terminal: 'gnome-terminal', pid: 99 }));
    render(<PuiLauncherButton />);
    fireEvent.click(screen.getByRole('button', { name: /pui workbench/i }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/adv/sessions/launch-pui',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(String(toastSuccess.mock.calls[0][0])).toContain('gnome-terminal');
    expect(toastError).not.toHaveBeenCalled();
  });

  it('click → toasts an error when the launch fails (status:error)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'error', error: 'pui not found' }));
    render(<PuiLauncherButton />);
    fireEvent.click(screen.getByRole('button', { name: /pui workbench/i }));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(String(toastError.mock.calls[0][0])).toContain('pui not found');
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
