// @vitest-environment jsdom
/**
 * API keys settings page — the RETIREMENT guard for the OAuth sign-in cards
 * (default-deploy-account-2026-08-08 P-001).
 *
 * The sign-in cards were removed from THIS page only; the `AuthSignInCards` component itself
 * is still live and still tested (it is what the Setup Wizard's StepLogins mounts). So the
 * property under test is not "the component is gone" but "this page no longer offers account
 * sign-in, and points at the one place that does" — the deploy-account pool, which is now the
 * single home for account logins and for marking one of them the machine default.
 *
 * Worth a test rather than trusting the deletion: a page whose whole job is credentials is
 * exactly where someone re-adds a "sign in with Claude" button in good faith, and doing so
 * would silently re-open the second, competing account-login surface this plan collapsed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
// RouteLink needs the app-shell ProgressProvider, which this page-level render does not mount.
// Standing in a plain anchor keeps the href assertion below meaningful — that link is the whole
// point of the removal (it is where account logins moved TO).
vi.mock('@/app/_components/RouteLink', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));
vi.mock('@/lib/useLexicon', () => ({
  useLexicon: () => (key: string, opts?: { plural?: boolean; lower?: boolean }) => {
    const word = opts?.plural ? `${key}s` : key;
    return opts?.lower ? word.toLowerCase() : word;
  },
}));

import ApiKeysPage from './page';

const EMPTY_CREDS = {
  anthropic_api_key: null,
  openai_api_key: null,
  zeroentropy_api_key: null,
  github_pat: null,
  updated_at: null,
  path: '~/.papercusp/credentials.json',
};

// /api/agent-mcp/operator-credentials serves the VOICE engine snapshot on this page (not a
// credential list) — every engine key must be present or the render throws on `.configured`.
const UNCONFIGURED = { configured: false, apiKey: null };
const EMPTY_VOICE = {
  elevenlabs: UNCONFIGURED,
  openai: UNCONFIGURED,
  cartesia: UNCONFIGURED,
  deepgram: UNCONFIGURED,
  picovoice: UNCONFIGURED,
};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes('search-providers')
        ? { providers: [] }
        : url.includes('operator-credentials')
          ? EMPTY_VOICE
          : EMPTY_CREDS;
      return { ok: true, json: async () => body } as Response;
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('API keys settings page — sign-in cards retired (P-001)', () => {
  const renderPage = async () => {
    render(<ApiKeysPage />);
    // The page renders a "Loading…" shell until the credential fetches settle; asserting the
    // ABSENCE of sign-in affordances against that shell would pass for the wrong reason.
    await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
  };

  it('renders the key-entry surface (the control that proves the page mounted)', async () => {
    await renderPage();
    expect(screen.getByRole('heading', { name: 'API keys', level: 1 })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /API keys — Core/ })).toBeTruthy();
  });

  it('offers NO account sign-in affordance any more', async () => {
    await renderPage();
    // Asserted on ACTIONABLE CONTROLS, not on vocabulary. The page legitimately still says the
    // words "Claude Code OAuth session" while explaining WHEN an Anthropic API key is needed —
    // an earlier draft of this test failed on a bare /OAuth/ text match and was wrong to. The
    // property is that nothing here STARTS a login, which is what AuthSignInCards rendered
    // (a per-provider `Sign in to <label>` button). Matching on the affordance rather than the
    // component name also catches a hand-rolled replacement.
    expect(screen.queryByRole('button', { name: /sign in|log in/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /sign in|log in/i })).toBeNull();
    expect(screen.queryByText(/sign in with your/i)).toBeNull(); // the cards' own descriptions
    expect(screen.queryByText(/connect your accounts/i)).toBeNull(); // the cards' intro
  });

  it('routes subscription logins to the deploy-account pool instead', async () => {
    // The removal is only safe because the page SAYS where logins moved to. Without this the
    // owner is left on a page titled "API keys" with no path to a Claude subscription at all.
    await renderPage();
    const link = screen.getByRole('link', { name: /deploy account/i });
    expect(link.getAttribute('href')).toBe('/settings/deploy-accounts');
  });

  it('mentions that a deploy account can be made the machine default', async () => {
    await renderPage();
    expect(screen.getByText(/marked the default for everything on this machine/i)).toBeTruthy();
  });
});
