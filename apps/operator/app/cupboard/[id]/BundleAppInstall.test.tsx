// @vitest-environment jsdom
/**
 * BundleAppInstall.test.tsx — render + behaviour coverage for the Cupboard
 * bundle-app install panel (cupboard-app-distribution-2026-07-14 P-008).
 * fetch is stubbed against /api/cupboard/install-app's { manifest, ok, review,
 * blockedByConflicts, deps, datatypes, blueprint } contract.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { HarnessListing } from '@papercusp/operator-core/lib/cupboard/types';

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m) } }));

import BundleAppInstall from './BundleAppInstall';

const listing = { id: 9, slug: 'demo-bundle', title: 'Demo Bundle', delivery_type: 'bundle' } as unknown as HarnessListing;

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  toastSuccess.mockClear();
  toastError.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('<BundleAppInstall /> (P-008)', () => {
  it('offers an Install button with no result shown yet', () => {
    render(<BundleAppInstall listing={listing} />);
    expect(screen.getByTestId('cupboard-bundle-app-install-btn')).toBeTruthy();
    expect(screen.queryByTestId('cupboard-bundle-app-review')).toBeNull();
    expect(screen.queryByTestId('cupboard-bundle-app-result')).toBeNull();
  });

  it('installs cleanly and shows the success summary', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        manifest: { name: 'Demo Bundle' },
        ok: true,
        blockedByConflicts: false,
        review: { clean: [{ kind: 'pack', ref: 'pack-y', status: 'clean' }], duplicates: [], conflicts: [] },
        deps: { installed: [{ name: 'pack-y', kind: 'pack' }] },
        datatypes: [{ id: 'dt.a', ok: true }],
        blueprint: null,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<BundleAppInstall listing={listing} />);
    fireEvent.click(screen.getByTestId('cupboard-bundle-app-install-btn'));

    await waitFor(() => expect(screen.getByTestId('cupboard-bundle-app-result')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/cupboard/install-app',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ listingId: listing.id, allowConflicts: false }),
      }),
    );
    expect(toastSuccess).toHaveBeenCalled();
    expect(screen.getByText(/1 pack\/plugin unit\(s\), 1 datatype\(s\)/)).toBeTruthy();
  });

  it('shows the conflict review and blocks install, then installs anyway on confirm', async () => {
    const blockedResponse = jsonResponse(
      {
        manifest: { name: 'Demo Bundle' },
        ok: false,
        blockedByConflicts: true,
        review: {
          clean: [{ kind: 'pack', ref: 'pack-y', status: 'clean' }],
          duplicates: [],
          conflicts: [{ kind: 'blueprint', ref: 'bp.demo', status: 'conflict', detail: 'already installed from a different source' }],
        },
        deps: null,
        datatypes: [],
        blueprint: null,
      },
      422,
    );
    const okResponse = jsonResponse({
      manifest: { name: 'Demo Bundle' },
      ok: true,
      blockedByConflicts: false,
      review: { clean: [], duplicates: [], conflicts: [] },
      deps: { installed: [] },
      datatypes: [],
      blueprint: { id: 'bp.demo', ok: true },
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(blockedResponse).mockResolvedValueOnce(okResponse);
    vi.stubGlobal('fetch', fetchMock);

    render(<BundleAppInstall listing={listing} />);
    fireEvent.click(screen.getByTestId('cupboard-bundle-app-install-btn'));

    await waitFor(() => expect(screen.getByTestId('cupboard-bundle-app-review')).toBeTruthy());
    expect(screen.getByText(/1 conflict/)).toBeTruthy();
    expect(screen.getByText(/blueprint: bp\.demo/)).toBeTruthy();
    expect(toastError).toHaveBeenCalled();
    // The generic Install button is hidden while the review is showing.
    expect(screen.queryByTestId('cupboard-bundle-app-install-btn')).toBeNull();

    fireEvent.click(screen.getByTestId('cupboard-bundle-app-install-anyway'));
    await waitFor(() => expect(screen.getByTestId('cupboard-bundle-app-result')).toBeTruthy());
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/cupboard/install-app',
      expect.objectContaining({ body: JSON.stringify({ listingId: listing.id, allowConflicts: true }) }),
    );
  });

  it('reports a request-level failure via toast without rendering a result', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'listing_not_found_or_unreachable' }, 404));
    vi.stubGlobal('fetch', fetchMock);

    render(<BundleAppInstall listing={listing} />);
    fireEvent.click(screen.getByTestId('cupboard-bundle-app-install-btn'));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(screen.queryByTestId('cupboard-bundle-app-result')).toBeNull();
    expect(screen.queryByTestId('cupboard-bundle-app-review')).toBeNull();
  });
});
