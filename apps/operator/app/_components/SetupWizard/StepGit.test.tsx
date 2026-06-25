// @vitest-environment jsdom
/**
 * StepGit.test.tsx — render-tier coverage for the SetupWizard "Git identity"
 * step. Seeds identity / preflight / pty-commands / agent-auth-status from a
 * per-URL fetch router, then drives the git-identity save form (success + error)
 * and asserts the GitHub section is enabled (no longer alpha-gated) but gated on
 * the GitHub CLI being installed. Tooltip passes through, the pty tauri detector
 * + InlinePtyTerminal are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/app/harness/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@papercusp/operator-core/lib/pty-tauri', () => ({ isTauriNative: () => false }));
vi.mock('./InlinePtyTerminal', () => ({ InlinePtyTerminal: () => null }));

import { StepGit } from './StepGit';

/* fetch router for the four endpoints StepGit hits. */
let identityBody: unknown;
let identityOk: boolean;
let postFails: boolean;
let posts: unknown[];
function installFetch() {
  posts = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/api/desktop/git-identity')) {
      if (init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)));
        if (postFails) return new Response(JSON.stringify({ error: 'bad email' }), { status: 400 });
        const b = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ name: b.name, email: b.email }), { status: 200 });
      }
      return new Response(JSON.stringify(identityBody), { status: identityOk ? 200 : 500 });
    }
    if (u.includes('/api/desktop/preflight')) {
      return new Response(JSON.stringify({ checks: [{ name: 'gh', status: 'missing' }] }), { status: 200 });
    }
    if (u.includes('/api/desktop/setup-pty-commands')) {
      return new Response(JSON.stringify({ loginGithub: { command: 'gh', args: ['auth'], cwd: '/', env: {} } }), { status: 200 });
    }
    if (u.includes('/api/desktop/agent-auth-status')) {
      return new Response(JSON.stringify({ github: false }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
  vi.stubGlobal('fetch', fn as unknown as typeof fetch);
  return fn;
}

beforeEach(() => {
  identityBody = { source: 'none' };
  identityOk = true;
  postFails = false;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('StepGit (SetupWizard git-identity step)', () => {
  it('renders the lead copy and, after load, the not-configured status', async () => {
    installFetch();
    render(<StepGit />);
    expect(screen.getByText(/Every commit Papercusp makes/i)).toBeTruthy();
    expect(await screen.findByText('Not configured.')).toBeTruthy();
    expect(screen.getByText(/Fill in your name and email below/i)).toBeTruthy();
  });

  it('seeds the name/email drafts from an existing git config and shows "Ready."', async () => {
    identityBody = { name: 'Ada Lovelace', email: 'ada@x.io', source: 'global' };
    installFetch();
    render(<StepGit />);
    expect(await screen.findByText('Ready.')).toBeTruthy();
    await waitFor(() => {
      expect((screen.getByPlaceholderText('Your Name') as HTMLInputElement).value).toBe('Ada Lovelace');
      expect((screen.getByPlaceholderText('you@example.com') as HTMLInputElement).value).toBe('ada@x.io');
    });
    // Configured → the button reads "Update git identity".
    expect(screen.getByRole('button', { name: /Update git identity/i })).toBeTruthy();
  });

  it('the save button is disabled until both name and email are filled', async () => {
    installFetch();
    render(<StepGit />);
    await screen.findByText('Not configured.');
    const save = screen.getByRole('button', { name: /Save git identity/i }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText('Your Name'), { target: { value: 'Grace' } });
    expect(save.disabled).toBe(true); // email still empty
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'grace@x.io' } });
    expect(save.disabled).toBe(false);
  });

  it('saving POSTs the trimmed identity and flips the status to Ready', async () => {
    installFetch();
    render(<StepGit />);
    await screen.findByText('Not configured.');
    fireEvent.change(screen.getByPlaceholderText('Your Name'), { target: { value: '  Grace  ' } });
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: ' grace@x.io ' } });
    fireEvent.click(screen.getByRole('button', { name: /Save git identity/i }));
    await waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0]).toEqual({ name: 'Grace', email: 'grace@x.io' });
    expect(await screen.findByText('Ready.')).toBeTruthy();
  });

  it('a failing save surfaces the server error message', async () => {
    postFails = true;
    installFetch();
    render(<StepGit />);
    await screen.findByText('Not configured.');
    fireEvent.change(screen.getByPlaceholderText('Your Name'), { target: { value: 'Grace' } });
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'grace@x.io' } });
    fireEvent.click(screen.getByRole('button', { name: /Save git identity/i }));
    expect(await screen.findByText(/bad email/i)).toBeTruthy();
  });

  it('the GitHub section is enabled (no longer alpha-gated) but gated on the GitHub CLI being installed', async () => {
    installFetch();
    render(<StepGit />);
    await screen.findByText('Not configured.');
    const ghBtn = screen.getByRole('button', { name: /Sign in to GitHub/i }) as HTMLButtonElement;
    // Preflight reports `gh` missing (+ the stubbed non-Tauri detector) → the button
    // stays disabled and the CLI-not-detected hint shows the install path.
    expect(ghBtn.disabled).toBe(true);
    expect(screen.getByText(/GitHub CLI not detected/i)).toBeTruthy();
    expect(screen.getByText(/bundled Papercusp workspace is private/i)).toBeTruthy();
    // The old alpha-gate hint is gone now that GitHub auth is re-enabled (dogfood
    // clone-on-first-boot needs the sign-in), so it must NOT render.
    expect(screen.queryByText(/disabled while Papercusp is in alpha/i)).toBeNull();
  });
});
