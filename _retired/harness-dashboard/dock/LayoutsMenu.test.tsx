/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { LayoutsMenu } from './LayoutsMenu';
import { bindDockApi } from './dock-actions';

function makeFakeApi() {
  return {
    addPanel: vi.fn(),
    getPanel: vi.fn(),
    removePanel: vi.fn(),
    panels: [],
    activeGroup: null,
    toJSON: vi.fn(() => ({
      grid: { root: { type: 'leaf', data: { views: [], id: 'r' } }, height: 0, width: 0, orientation: 'HORIZONTAL' },
      panels: {},
    })),
  } as unknown as Parameters<typeof bindDockApi>[0];
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  bindDockApi(makeFakeApi());
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/_list')) {
      return new Response(
        JSON.stringify({
          layouts: [
            { name: 'review', updatedTs: Date.now() - 5 * 60_000 },
            { name: 'debug', updatedTs: Date.now() - 60 * 60_000 },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (init?.method === 'PUT') {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
  bindDockApi(null);
});

describe('LayoutsMenu', () => {
  it('renders the trigger button', () => {
    render(<LayoutsMenu />);
    expect(screen.getByLabelText('Layouts menu')).toBeTruthy();
  });

  it('opens the menu on click and fetches the list', async () => {
    render(<LayoutsMenu />);
    fireEvent.click(screen.getByLabelText('Layouts menu'));
    expect(screen.getByRole('menu')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('review')).toBeTruthy());
    expect(screen.getByText('debug')).toBeTruthy();
    // /_list endpoint hit
    expect(
      (globalThis.fetch as unknown as { mock: { calls: Array<[string]> } }).mock.calls.some(
        ([u]) => String(u).endsWith('/_list'),
      ),
    ).toBe(true);
  });

  it('marks the currentLayoutName as "current"', async () => {
    render(<LayoutsMenu currentLayoutName="review" />);
    fireEvent.click(screen.getByLabelText('Layouts menu'));
    await waitFor(() => expect(screen.getByText('review')).toBeTruthy());
    // 'current' badge present next to review
    expect(screen.getByText('current')).toBeTruthy();
  });

  it('Save current as… opens prompt + dispatches PUT on submit', async () => {
    render(<LayoutsMenu />);
    fireEvent.click(screen.getByLabelText('Layouts menu'));
    fireEvent.click(screen.getByText('+ Save current as…'));
    // Prompt modal opens — input is the easiest unique handle.
    const input = (await waitFor(() =>
      screen.getByLabelText('Name'),
    )) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'my-layout' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(
      () => {
        const calls = (globalThis.fetch as unknown as { mock: { calls: Array<[string, RequestInit | undefined]> } })
          .mock.calls;
        const putCall = calls.find(([, init]) => init?.method === 'PUT');
        expect(putCall).toBeDefined();
        expect(String(putCall![0])).toContain('/api/dock-layouts/my-layout');
      },
      { timeout: 3000 },
    );
  });

  it('Save cancel: no PUT', async () => {
    render(<LayoutsMenu />);
    fireEvent.click(screen.getByLabelText('Layouts menu'));
    fireEvent.click(screen.getByText('+ Save current as…'));
    // Wait for the prompt to open (input labelled Name).
    await waitFor(() => screen.getByLabelText('Name'));
    fireEvent.click(screen.getByText('Cancel'));
    // Give microtasks a tick.
    await Promise.resolve();
    const calls = (globalThis.fetch as unknown as { mock: { calls: Array<[string, RequestInit | undefined]> } }).mock.calls;
    const putCall = calls.find(([, init]) => init?.method === 'PUT');
    expect(putCall).toBeUndefined();
  });

  it('Reset to default dispatches papercusp:dock-reset-layout', async () => {
    const handler = vi.fn();
    window.addEventListener('papercusp:dock-reset-layout', handler);
    try {
      render(<LayoutsMenu />);
      fireEvent.click(screen.getByLabelText('Layouts menu'));
      fireEvent.click(screen.getByText('↺ Reset to default'));
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('papercusp:dock-reset-layout', handler);
    }
  });

  it('clicking a saved layout dispatches papercusp:dock-load-layout', async () => {
    const handler = vi.fn();
    window.addEventListener('papercusp:dock-load-layout', handler);
    try {
      render(<LayoutsMenu />);
      fireEvent.click(screen.getByLabelText('Layouts menu'));
      await waitFor(() => expect(screen.getByText('debug')).toBeTruthy());
      fireEvent.click(screen.getByText('debug'));
      expect(handler).toHaveBeenCalledTimes(1);
      const evt = handler.mock.calls[0][0] as CustomEvent<{ name: string }>;
      expect(evt.detail.name).toBe('debug');
    } finally {
      window.removeEventListener('papercusp:dock-load-layout', handler);
    }
  });
});
