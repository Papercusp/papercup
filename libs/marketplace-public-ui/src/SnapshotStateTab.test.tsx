// @vitest-environment jsdom
/**
 * SnapshotStateTab.test.tsx — whole-app-coverage P-008.
 *
 * The snapshot state inspector lazily fetches issues/features/memory from the
 * package API in an effect; `fetch` is stubbed so the test stays hermetic (no
 * network) and `waitFor` settles the effect inside act. Asserts the no-metadata
 * fallback and the prop-derived capture-metadata + feature-counts rendering.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { SnapshotStateTab } from './SnapshotStateTab';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => '',
      } as unknown as Response),
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SnapshotStateTab', () => {
  it('renders the no-metadata fallback when snapshot is absent', async () => {
    render(<SnapshotStateTab slug="s" version="1.0.0" apiBase="http://x" />);
    expect(screen.getByText(/no captured state metadata/i)).toBeTruthy();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
  });

  it('renders capture metadata from the snapshot prop', async () => {
    render(
      <SnapshotStateTab
        slug="s"
        version="1.0.0"
        apiBase="http://x"
        snapshot={{ sourceHarness: 'coding-1', iteration: 4, includesProject: true }}
      />,
    );
    expect(screen.getByText('Capture metadata')).toBeTruthy();
    expect(screen.getByText('coding-1')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
    expect(screen.getByText(/included in tarball/i)).toBeTruthy();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
  });

  it('marks project files not-included and renders feature counts', async () => {
    render(
      <SnapshotStateTab
        slug="s"
        version="1.0.0"
        apiBase="http://x"
        snapshot={{ includesProject: false, featureCounts: { done: 3, todo: 2 } }}
      />,
    );
    expect(screen.getByText(/not included \(recipe only\)/i)).toBeTruthy();
    expect(screen.getByText('Feature counts')).toBeTruthy();
    expect(screen.getByText('done')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
  });
});
