// @vitest-environment jsdom
/**
 * InlinePtyTerminal.test.tsx — the "blank setup terminal" empty-state (WI-2934).
 *
 * Owner-flagged first-run polish: the pane must never be a dead black box while
 * a slow / sign-in-gated command spins up. Two robust layers, deliberately
 * AVOIDING the flaky path — xterm's dynamic `import('@xterm/xterm')` is not
 * reliably mockable under vitest (it races in real; see TerminalTab.test.tsx),
 * and the first-byte hide fires only AFTER that import + ptySpawn resolve, so we
 * do NOT drive pty-data in jsdom. Instead:
 *   1. shouldShowPtyPlaceholder — the pure predicate: every show/hide branch.
 *   2. render smoke — the SYNCHRONOUS initial paint shows the placeholder
 *      (Tauri native), honors a custom message, and renders nothing off-Tauri.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

let tauriNative = true;
vi.mock('@papercusp/operator-core/lib/pty-tauri', () => ({
  isTauriNative: () => tauriNative,
}));
// ptySpawn is only reached inside the async xterm effect; a never-resolving stub
// keeps that path parked past our synchronous assertions (no late setState).
vi.mock('@papercusp/operator-core/lib/tauri-bindings', () => ({
  commands: {
    ptySpawn: vi.fn(() => new Promise(() => {})),
    ptyKill: vi.fn(),
    ptyWrite: vi.fn(),
    ptyResize: vi.fn(),
  },
}));

import { InlinePtyTerminal, shouldShowPtyPlaceholder } from './InlinePtyTerminal';

beforeEach(() => {
  tauriNative = true;
  // xterm probes matchMedia on open() if the real module races in — keep it
  // from throwing an unhandled rejection that trips an unrelated assertion.
  if (!window.matchMedia) {
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    }) as unknown as typeof window.matchMedia;
  }
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('shouldShowPtyPlaceholder', () => {
  it('shows while there is no output, no error, and no exit', () => {
    expect(shouldShowPtyPlaceholder({ hasOutput: false, error: null, exitedCode: null })).toBe(true);
  });
  it('hides once the pty has produced output', () => {
    expect(shouldShowPtyPlaceholder({ hasOutput: true, error: null, exitedCode: null })).toBe(false);
  });
  it('hides on a spawn/attach error', () => {
    expect(shouldShowPtyPlaceholder({ hasOutput: false, error: 'boom', exitedCode: null })).toBe(false);
  });
  it('hides once the process has exited (both 0 and non-zero)', () => {
    expect(shouldShowPtyPlaceholder({ hasOutput: false, error: null, exitedCode: 0 })).toBe(false);
    expect(shouldShowPtyPlaceholder({ hasOutput: false, error: null, exitedCode: 3 })).toBe(false);
  });
});

describe('InlinePtyTerminal empty-state', () => {
  it('shows the default "Starting…" placeholder on mount (never a blank box)', () => {
    render(<InlinePtyTerminal command="bash" />);
    const ph = screen.getByTestId('inline-pty-placeholder');
    expect(ph.textContent).toContain('Starting…');
  });

  it('honors a custom placeholder message', () => {
    render(<InlinePtyTerminal command="bash" placeholder="Starting onboarding…" />);
    expect(screen.getByTestId('inline-pty-placeholder').textContent).toContain('Starting onboarding…');
  });

  it('renders nothing outside the Tauri native webview', () => {
    tauriNative = false;
    const { container } = render(<InlinePtyTerminal command="bash" />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('inline-pty-placeholder')).toBeNull();
  });
});
