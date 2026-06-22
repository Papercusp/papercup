// @vitest-environment jsdom
/**
 * StepLogins.test.tsx — render-tier coverage for the SetupWizard sign-in step.
 * StepLogins is a thin wrapper that mounts the shared AuthSignInCards with the
 * wizard intro, so the real branch logic under test lives in AuthSignInCards:
 * the two provider cards, the intro line, the browser-dev disabled state vs the
 * tauri enabled state, the "✓ Signed in" badge + re-sign-in label, and the
 * browser desktop-only note. isTauriNative + InlinePtyTerminal are mocked; a
 * per-URL fetch router seeds pty-commands + agent-auth-status.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

let isTauriNativeValue: boolean;
vi.mock('@papercusp/operator-core/lib/pty-tauri', () => ({ isTauriNative: () => isTauriNativeValue }));
vi.mock('./InlinePtyTerminal', () => ({ InlinePtyTerminal: () => <div data-testid="pty" /> }));

import { StepLogins } from './StepLogins';

let specsOk: boolean;
let auth: { claude: boolean; codex: boolean; omp: boolean };
function installFetch() {
  const fn = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('/api/desktop/setup-pty-commands')) {
      if (!specsOk) return new Response('{}', { status: 500 });
      return new Response(
        JSON.stringify({
          loginClaude: { command: 'claude', args: ['/login'], cwd: '/', env: {} },
          loginCodex: { command: 'codex', args: ['login'], cwd: '/', env: {} },
          loginOmp: { command: 'omp', args: ['/login'], cwd: '/', env: {} },
        }),
        { status: 200 },
      );
    }
    if (u.includes('/api/desktop/agent-auth-status')) {
      return new Response(JSON.stringify(auth), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
  vi.stubGlobal('fetch', fn as unknown as typeof fetch);
  return fn;
}

beforeEach(() => {
  isTauriNativeValue = false;
  specsOk = true;
  auth = { claude: false, codex: false, omp: false };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('StepLogins (SetupWizard sign-in step)', () => {
  it('renders the wizard intro line and both provider cards', async () => {
    installFetch();
    render(<StepLogins />);
    expect(screen.getByText(/Sign in to your accounts/i)).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Claude account/i })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Codex account/i })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /OMP \/ ChatGPT account/i })).toBeTruthy();
  });

  it('keeps the sign-in buttons disabled until the pty specs resolve', async () => {
    installFetch();
    render(<StepLogins />);
    const claudeBtn = screen.getByRole('button', { name: /Sign in to Claude/i }) as HTMLButtonElement;
    // Specs are async — the button is disabled until they land, then enables.
    await waitFor(() => expect(claudeBtn.disabled).toBe(false));
  });

  it('shows the "✓ Signed in" badge + a Re-sign-in label when a provider is authed', async () => {
    auth = { claude: true, codex: false, omp: false };
    installFetch();
    render(<StepLogins />);
    expect(await screen.findByText('✓ Signed in')).toBeTruthy();
    expect(await screen.findByRole('button', { name: /Re-sign in to Claude/i })).toBeTruthy();
  });

  it('in browser dev, clicking sign-in shows the desktop-only note (no pty spawn)', async () => {
    installFetch();
    render(<StepLogins />);
    const claudeBtn = screen.getByRole('button', { name: /Sign in to Claude/i }) as HTMLButtonElement;
    await waitFor(() => expect(claudeBtn.disabled).toBe(false));
    fireEvent.click(claudeBtn);
    expect(screen.getByText(/Terminal sign-in runs inside the Papercusp desktop app/i)).toBeTruthy();
    expect(screen.queryByTestId('pty')).toBeNull();
  });

  it('inside tauri, clicking sign-in spawns the inline pty terminal and shows Running…', async () => {
    isTauriNativeValue = true;
    installFetch();
    render(<StepLogins />);
    const claudeBtn = screen.getByRole('button', { name: /Sign in to Claude/i }) as HTMLButtonElement;
    await waitFor(() => expect(claudeBtn.disabled).toBe(false));
    fireEvent.click(claudeBtn);
    expect(screen.getByTestId('pty')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Running…/i })).toBeTruthy();
  });
});
