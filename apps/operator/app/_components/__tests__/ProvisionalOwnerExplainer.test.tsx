/**
 * @vitest-environment jsdom
 *
 * ProvisionalOwnerExplainer — P-069d tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wsLocalKey } from '@papercusp/operator-core/lib/browser-workspace';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  ProvisionalOwnerExplainer,
  shouldShowProvisionalOwnerExplainer,
} from '../ProvisionalOwnerExplainer';

const FLAG_KEY = wsLocalKey('papercusp.provisionalOwner.shown.v1');

// This project's jsdom env ships a localStorage shell whose methods
// throw. Install a real in-memory Storage so the component's
// optional-chain guards don't swallow our setItem.
function installLocalStorageShim(): void {
  const store = new Map<string, string>();
  const shim: Storage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(k: string) {
      return store.has(k) ? store.get(k)! : null;
    },
    key(i: number) {
      return Array.from(store.keys())[i] ?? null;
    },
    removeItem(k: string) {
      store.delete(k);
    },
    setItem(k: string, v: string) {
      store.set(k, String(v));
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: shim,
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  installLocalStorageShim();
  globalThis.localStorage.removeItem(FLAG_KEY);
});

afterEach(() => {
  cleanup();
  try {
    globalThis.localStorage?.removeItem?.(FLAG_KEY);
  } catch {
    // ignore
  }
});

describe('ProvisionalOwnerExplainer — P-069d', () => {
  it('does not render when open=false', () => {
    render(
      <ProvisionalOwnerExplainer
        open={false}
        ownerLogin="alice"
        harnessSlug="papercup"
        onClose={() => {}}
      />,
    );
    expect(screen.queryByTestId('provisional-owner-explainer')).toBeNull();
  });

  it('renders dialog with owner login + slug when open', () => {
    render(
      <ProvisionalOwnerExplainer
        open={true}
        ownerLogin="alice"
        harnessSlug="papercup"
        onClose={() => {}}
      />,
    );
    const dialog = screen.getByTestId('provisional-owner-explainer');
    expect(dialog).toBeTruthy();
    expect(dialog.textContent).toContain('papercup');
    expect(dialog.textContent).toContain('@alice');
    expect(dialog.textContent).toContain('provisional owner');
  });

  it('marks seen-locally when opened', () => {
    render(
      <ProvisionalOwnerExplainer
        open={true}
        ownerLogin="alice"
        harnessSlug="papercup"
        onClose={() => {}}
      />,
    );
    expect(shouldShowProvisionalOwnerExplainer()).toBe(false);
  });

  it('calls onClose when dismiss clicked', () => {
    const close = vi.fn();
    render(
      <ProvisionalOwnerExplainer
        open={true}
        ownerLogin="alice"
        harnessSlug="papercup"
        onClose={close}
      />,
    );
    fireEvent.click(screen.getByTestId('provisional-owner-explainer-dismiss'));
    expect(close).toHaveBeenCalledOnce();
  });

  it('overlay click also calls onClose', () => {
    const close = vi.fn();
    render(
      <ProvisionalOwnerExplainer
        open={true}
        ownerLogin="alice"
        harnessSlug="papercup"
        onClose={close}
      />,
    );
    fireEvent.click(screen.getByTestId('provisional-owner-explainer'));
    expect(close).toHaveBeenCalledOnce();
  });

  it('clicking inside dialog body does NOT close', () => {
    const close = vi.fn();
    render(
      <ProvisionalOwnerExplainer
        open={true}
        ownerLogin="alice"
        harnessSlug="papercup"
        onClose={close}
      />,
    );
    const title = screen.getByText(/You're the provisional owner/);
    fireEvent.click(title);
    expect(close).not.toHaveBeenCalled();
  });

  it('shouldShowProvisionalOwnerExplainer is true initially', () => {
    expect(shouldShowProvisionalOwnerExplainer()).toBe(true);
  });

  it('shouldShowProvisionalOwnerExplainer is false after dialog opened once', () => {
    const { unmount } = render(
      <ProvisionalOwnerExplainer
        open={true}
        ownerLogin="alice"
        harnessSlug="papercup"
        onClose={() => {}}
      />,
    );
    unmount();
    expect(shouldShowProvisionalOwnerExplainer()).toBe(false);
  });
});
