// @vitest-environment jsdom
/**
 * TerminalTab.test.tsx — branch coverage for the /dev xterm terminal embed.
 *
 * The component auto-starts on mount: resolve a harness slug (/api/installed) →
 * spawn a pty (/pty/spawn) → boot xterm → subscribe via @papercusp/sse. The
 * xterm boot itself is an effect-only embed with no branch logic of its own,
 * and its dynamic `import('@xterm/xterm')` is not reliably interceptable by
 * vi.mock under vitest (the real module races in), so we DON'T assert the
 * post-spawn terminal — those would be flaky. Instead we cover the branches
 * that resolve BEFORE the xterm import:
 *   - the header chrome (Terminal label, status line, restart button)
 *   - the "no project found" error state (early return, no slug)
 *   - the spawn-failed error state (early return, non-OK spawn)
 * These are the component's real testable decisions; the terminal stream itself
 * is exercised by the live app, not jsdom.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

/* ── Mocks for the heavy terminal edges ─────────────────────────────── */
vi.mock('@papercusp/sse', () => ({
  createResilientEventSource: vi.fn(() => ({ close: vi.fn() })),
}));
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));

import TerminalTab from './TerminalTab';

/* ── fetch stub ─────────────────────────────────────────────────────── */
let installedProjects: Array<{ slug: string; exists?: boolean }>;
let spawnStatus: number;
const fetchCalls: string[] = [];

function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      fetchCalls.push(`${init?.method ?? 'GET'} ${u}`);
      if (u.endsWith('/api/installed')) {
        return new Response(JSON.stringify({ projects: installedProjects }), { status: 200 });
      }
      if (u.includes('/pty/spawn')) {
        if (spawnStatus !== 200) return new Response('nope', { status: spawnStatus });
        return new Response(JSON.stringify({ id: 'pty-1', pid: 4242, command: 'bash' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }),
  );
}

beforeEach(() => {
  installedProjects = [{ slug: 'demo', exists: true }];
  spawnStatus = 200;
  fetchCalls.length = 0;
  Element.prototype.scrollIntoView = vi.fn();
  // xterm probes matchMedia on open() if the real module ever races in — keep
  // it from throwing an unhandled rejection that fails an unrelated test.
  if (!window.matchMedia) {
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(),
    }) as unknown as typeof window.matchMedia;
  }
  installFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('TerminalTab (/dev xterm terminal)', () => {
  it('renders the header chrome (Terminal label, status line, restart button)', () => {
    render(<TerminalTab />);
    expect(screen.getByText('Terminal')).toBeTruthy();
    expect(screen.getByText(/status:/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /restart/i })).toBeTruthy();
  });

  it('shows the "no project found" error when /api/installed has no usable project', async () => {
    installedProjects = [];
    render(<TerminalTab />);
    await waitFor(() => expect(screen.getByText('error')).toBeTruthy());
    expect(screen.getByText(/no .* project found/i)).toBeTruthy();
    // Bailed before spawning a pty.
    expect(fetchCalls.some((c) => c.includes('/pty/spawn'))).toBe(false);
  });

  it('treats a project with exists:false as no usable project', async () => {
    installedProjects = [{ slug: 'ghost', exists: false }];
    render(<TerminalTab />);
    await waitFor(() => expect(screen.getByText('error')).toBeTruthy());
    expect(screen.getByText(/no .* project found/i)).toBeTruthy();
  });

  it('shows the spawn-failed error when the pty spawn route returns non-OK', async () => {
    spawnStatus = 500;
    render(<TerminalTab />);
    await waitFor(() => expect(screen.getByText('error')).toBeTruthy());
    expect(screen.getByText(/spawn failed/i)).toBeTruthy();
    // It DID attempt the spawn for the resolved slug.
    expect(fetchCalls.some((c) => c.includes('/api/harness/demo/pty/spawn'))).toBe(true);
  });
});
