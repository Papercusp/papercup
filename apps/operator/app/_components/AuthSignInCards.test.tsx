// @vitest-environment jsdom
//
// AuthSignInCards — the one-click OAuth provider cards (Claude / ChatGPT).
// Pure-render component with three external deps mocked: isTauriNative (the
// desktop-vs-browser fork), InlinePtyTerminal (the spawned pty child), and the
// two /api/desktop fetches (pty-command specs + auth status). We assert the
// provider cards, the signed-in badge from the status probe, the browser-dev
// "use the desktop app" note, and the desktop path mounting the pty terminal.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';

const { tauriRef } = vi.hoisted(() => ({ tauriRef: { value: false } }));

vi.mock('@papercusp/operator-core/lib/pty-tauri', () => ({
  isTauriNative: () => tauriRef.value,
}));

// The pty child spawns a real Tauri PTY; render a marker that echoes the
// command it was handed so the desktop path is observable without a pty.
vi.mock('./SetupWizard/InlinePtyTerminal', () => ({
  InlinePtyTerminal: ({ command }: { command: string }) => (
    <div data-testid="pty-terminal">{command}</div>
  ),
}));

import { AuthSignInCards } from './AuthSignInCards';

const SPECS = {
  loginClaude: { command: 'claude', args: ['/login'], cwd: '/home', env: {} },
  loginOmp: { command: 'omp', args: ['/login'], cwd: '/home', env: {} },
};

function mockFetch(authStatus: { claude: boolean; omp: boolean }) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/desktop/setup-pty-commands')) {
      return new Response(JSON.stringify(SPECS), { status: 200 });
    }
    if (url.includes('/api/desktop/agent-auth-status')) {
      return new Response(JSON.stringify(authStatus), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  });
}

beforeEach(() => {
  tauriRef.value = false;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('<AuthSignInCards />', () => {
  it('renders both provider cards and an optional intro', async () => {
    vi.stubGlobal('fetch', mockFetch({ claude: false, omp: false }));
    render(<AuthSignInCards intro="Connect your accounts." />);
    expect(screen.getByText('Connect your accounts.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Claude account' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'ChatGPT account' })).toBeTruthy();
    // Sign-in buttons enable once the pty-command specs resolve.
    await waitFor(() =>
      expect((screen.getByRole('button', { name: /sign in to claude/i }) as HTMLButtonElement).disabled).toBe(false),
    );
  });

  it('keeps the sign-in buttons disabled until the pty-command specs resolve', () => {
    // A fetch that never returns the specs keeps buttons disabled.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    render(<AuthSignInCards />);
    const btn = screen.getByRole('button', { name: /sign in to claude/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('shows the "✓ Signed in" badge for a provider the status probe reports as connected', async () => {
    vi.stubGlobal('fetch', mockFetch({ claude: true, omp: false }));
    render(<AuthSignInCards />);
    // Claude reports signed-in → badge + "Re-sign in" affordance.
    await waitFor(() => expect(screen.getByText('✓ Signed in')).toBeTruthy());
    expect(screen.getByRole('button', { name: /re-sign in to claude/i })).toBeTruthy();
    // ChatGPT is not signed in → plain "Sign in".
    expect(screen.getByRole('button', { name: /sign in to chatgpt/i })).toBeTruthy();
  });

  it('in browser dev (not Tauri), clicking a card shows the "use the desktop app" note instead of spawning a pty', async () => {
    tauriRef.value = false;
    vi.stubGlobal('fetch', mockFetch({ claude: false, omp: false }));
    render(<AuthSignInCards />);
    const btn = await waitFor(() => {
      const b = screen.getByRole('button', { name: /sign in to claude/i }) as HTMLButtonElement;
      expect(b.disabled).toBe(false);
      return b;
    });
    fireEvent.click(btn);
    expect(screen.getByText(/terminal sign-in runs inside the papercusp desktop app/i)).toBeTruthy();
    expect(screen.queryByTestId('pty-terminal')).toBeNull();
  });

  it('in the desktop app (Tauri), clicking a card mounts the inline pty terminal with the provider spec', async () => {
    tauriRef.value = true;
    vi.stubGlobal('fetch', mockFetch({ claude: false, omp: false }));
    render(<AuthSignInCards />);
    const btn = await waitFor(() => {
      const b = screen.getByRole('button', { name: /sign in to claude/i }) as HTMLButtonElement;
      expect(b.disabled).toBe(false);
      return b;
    });
    fireEvent.click(btn);
    const term = await screen.findByTestId('pty-terminal');
    expect(term.textContent).toBe('claude'); // loginClaude.command
    // The active card's button flips to "Running…".
    expect(screen.getByRole('button', { name: /running…/i })).toBeTruthy();
  });
});
