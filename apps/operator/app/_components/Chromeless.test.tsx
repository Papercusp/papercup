// @vitest-environment jsdom
/**
 * Tests for <Chromeless> — toggles the `papercusp-chromeless` body class
 * (globals.css hides the root header/dock/widget for iframe-embedded routes).
 *
 * Covers: renders null; unconditionally adds the class on mount + removes on
 * unmount; and the `auto` mode which only applies when inside an iframe
 * (window.self !== window.top).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import Chromeless from './Chromeless';

afterEach(() => {
  cleanup();
  document.body.classList.remove('papercusp-chromeless');
});

const CLASS = 'papercusp-chromeless';

describe('Chromeless', () => {
  it('renders nothing', () => {
    const { container } = render(<Chromeless />);
    expect(container.firstChild).toBeNull();
  });

  it('adds the body class on mount and removes it on unmount', () => {
    const { unmount } = render(<Chromeless />);
    expect(document.body.classList.contains(CLASS)).toBe(true);
    unmount();
    expect(document.body.classList.contains(CLASS)).toBe(false);
  });

  it('does NOT apply in auto mode when not inside an iframe (self === top)', () => {
    // jsdom: window.self === window.top by default → auto is a no-op.
    render(<Chromeless auto />);
    expect(document.body.classList.contains(CLASS)).toBe(false);
  });

  it('applies in auto mode when inside an iframe (self !== top)', () => {
    const realTop = window.top;
    Object.defineProperty(window, 'top', { value: {}, configurable: true });
    try {
      render(<Chromeless auto />);
      expect(document.body.classList.contains(CLASS)).toBe(true);
    } finally {
      Object.defineProperty(window, 'top', { value: realTop, configurable: true });
    }
  });
});
