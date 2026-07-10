/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wsLocalKey } from '@papercusp/operator-core/lib/browser-workspace';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { DockOnboarding, _resetDockOnboardingForTests } from './DockOnboarding';

// Polyfill window.localStorage — vitest's jsdom env in this repo
// surfaces a partial Storage (warn: --localstorage-file). Provide a
// minimal Map-backed store so DockOnboarding's set/get work.
function installLocalStoragePolyfill() {
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
      setItem: (k: string, v: string) => store.set(k, String(v)),
      removeItem: (k: string) => store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}

beforeEach(() => {
  installLocalStoragePolyfill();
  _resetDockOnboardingForTests();
});
afterEach(() => cleanup());

describe('DockOnboarding', () => {
  it('renders the intro bubble on first mount (no localStorage flag)', () => {
    render(<DockOnboarding />);
    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.getByText(/Drag tabs/i)).toBeTruthy();
  });

  it('does not render when localStorage flag is set', () => {
    window.localStorage.setItem(wsLocalKey('papercusp:dock-onboarded'), '1');
    render(<DockOnboarding />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('dismiss button hides bubble + writes flag', () => {
    render(<DockOnboarding />);
    expect(window.localStorage.getItem(wsLocalKey('papercusp:dock-onboarded'))).toBeNull();
    const btn = screen.getByLabelText('Dismiss onboarding');
    fireEvent.click(btn);
    expect(screen.queryByRole('status')).toBeNull();
    expect(window.localStorage.getItem(wsLocalKey('papercusp:dock-onboarded'))).toBe('1');
  });

  it('stays dismissed after re-mount', () => {
    const { unmount } = render(<DockOnboarding />);
    fireEvent.click(screen.getByLabelText('Dismiss onboarding'));
    unmount();
    cleanup();
    render(<DockOnboarding />);
    expect(screen.queryByRole('status')).toBeNull();
  });
});
