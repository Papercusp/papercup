// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CustomerDataControls } from './CustomerDataControls';
import { hostedBrowserApiMarker } from '@/lib/hosted-browser-api';

afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  delete window.__PAPERCUSP_HOSTED_BROWSER__;
});

describe('hosted customer data downloads', () => {
  it('shows no hosted action on a local profile', () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    render(<CustomerDataControls />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('downloads from the account route with cookies and no caller-selected tenant, then releases its object URL', async () => {
    window.__PAPERCUSP_HOSTED_BROWSER__ = hostedBrowserApiMarker('control');
    const blob = new Blob(['{"receiptId":"receipt","stores":[]}'], { type: 'application/json' });
    const fetcher = vi.fn(async () => ({ ok: true, blob: async () => blob }));
    vi.stubGlobal('fetch', fetcher);
    const createObjectURL = vi.fn(() => 'blob:export');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<CustomerDataControls />);
    fireEvent.click(screen.getByRole('button', { name: 'Download organization data' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('download is ready'));
    expect(fetcher).toHaveBeenCalledWith('/api/hosted/browser/data/organization/export', expect.objectContaining({
      method: 'POST', credentials: 'include', cache: 'no-store', body: '{}',
    }));
    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:export');
    expect(document.querySelector('a[download]')).toBeNull();
  });

  it('explains a permission refusal without downloading its response', async () => {
    window.__PAPERCUSP_HOSTED_BROWSER__ = hostedBrowserApiMarker('control');
    const blob = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, blob })));
    render(<CustomerDataControls />);
    fireEvent.click(screen.getByRole('button', { name: 'Download organization data' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('administrator access'));
    expect(blob).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Download organization data' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('offers personal download through the user route without organization-admin authority', async () => {
    window.__PAPERCUSP_HOSTED_BROWSER__ = hostedBrowserApiMarker('control');
    const fetcher = vi.fn(async () => ({ ok: true, blob: async () => new Blob(['{}']) }));
    vi.stubGlobal('fetch', fetcher);
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:personal', revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<CustomerDataControls />);
    fireEvent.click(screen.getByRole('button', { name: 'Download my data' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('account data download is ready'));
    expect(fetcher).toHaveBeenCalledWith('/api/hosted/browser/data/user/export', expect.objectContaining({ body: '{}', credentials: 'include' }));
  });
});
