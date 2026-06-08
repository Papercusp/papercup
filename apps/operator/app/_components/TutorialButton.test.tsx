// @vitest-environment jsdom
/**
 * Tests for <TutorialButton> — the header "Tutorial" button.
 *
 * On click it (1) dispatches the `oracle:start-tutorial` window event and
 * (2) persists a one-shot intent flag in localStorage (so a click that beats
 * OracleDock's lazy listener isn't dropped). The flag write is wrapped in
 * try/catch, so a throwing localStorage must NOT block the event dispatch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import TutorialButton from './TutorialButton';

// The harness <Tooltip> uses a bare Radix Root, so callers (the app shell)
// must supply a TooltipProvider — mirror that in the test.
function renderButton() {
  return render(
    <Tooltip.Provider delayDuration={0}>
      <TutorialButton />
    </Tooltip.Provider>,
  );
}

function installLocalStorage(): void {
  const store = new Map<string, string>();
  const ls: Storage = {
    get length() { return store.size; },
    clear: () => store.clear(),
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
  };
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true });
}

beforeEach(() => {
  installLocalStorage();
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe('TutorialButton', () => {
  it('renders an accessible button', () => {
    renderButton();
    const btn = screen.getByRole('button', { name: 'Walk me through the app' });
    expect(btn.textContent).toContain('Tutorial');
  });

  it('dispatches oracle:start-tutorial and persists the intent flag on click', () => {
    const handler = vi.fn();
    window.addEventListener('oracle:start-tutorial', handler);
    const setItem = vi.spyOn(localStorage, 'setItem');
    try {
      renderButton();
      fireEvent.click(screen.getByRole('button', { name: 'Walk me through the app' }));
      expect(handler).toHaveBeenCalledTimes(1);
      expect(setItem).toHaveBeenCalledWith(expect.any(String), '1');
    } finally {
      window.removeEventListener('oracle:start-tutorial', handler);
    }
  });

  it('still dispatches the event when localStorage throws', () => {
    const handler = vi.fn();
    window.addEventListener('oracle:start-tutorial', handler);
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('quota');
    });
    try {
      renderButton();
      fireEvent.click(screen.getByRole('button', { name: 'Walk me through the app' }));
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('oracle:start-tutorial', handler);
    }
  });
});
