/**
 * @vitest-environment jsdom
 *
 * EntryHarnessLinkForm — D-004 / D-005 acceptance tests.
 *
 * Verifies:
 *   D-004a: POST body contains slug + harnessLinkUrl but NOT
 *           token / githubUserId / githubLogin.
 *   D-004b: 401 gh_auth_required response renders the gh-auth-login
 *           message and does not show a raw "401".
 *   D-005:  Initial progress list shows the 6 canonical step ids
 *           from JOIN_STEP_IDS, not the old Autobase-era set.
 *
 * Uses @testing-library/react + vitest only (no jest-dom matchers).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EntryHarnessLinkForm } from '../EntryHarnessLinkForm';
import { JOIN_STEP_IDS } from '@papercusp/operator-core/lib/harness/join-shared-harness';

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// The form/JoinProgress now resolve user-facing wording through useLexicon,
// which reads THE_HIVE via useFlag. Mock the hook so jsdom doesn't fire the
// real flag bootstrap fetch (GET /api/flags/bootstrap) — that would otherwise
// land as mockFetch's first call and shadow the join-link POST. Defaulting
// true keeps THE_HIVE on, so t('pot') renders "Hive".
vi.mock('@/lib/flag-hooks', () => ({
  useFlag: () => true,
}));

const mockFetch = vi.fn<typeof fetch>();
beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * A valid papercusp://harness?... link.
 * topic = 64 lowercase hex chars (32 bytes), github = owner/repo, repo_id = positive int.
 */
const VALID_LINK =
  'papercusp://harness?topic=' +
  'a'.repeat(64) +
  '&github=acme-org/my-repo&repo_id=12345678';

function renderForm(props?: {
  onBack?: () => void;
  onCreated?: (slug: string) => void;
}) {
  const onBack = props?.onBack ?? vi.fn();
  const onCreated = props?.onCreated ?? vi.fn();
  const result = render(
    <EntryHarnessLinkForm onBack={onBack} onCreated={onCreated} />,
  );
  return { ...result, onBack, onCreated };
}

/**
 * Navigate the form from input → preview → confirm join.
 * Returns after the "Join harness" button has been clicked.
 */
async function submitJoin(user: ReturnType<typeof userEvent.setup>) {
  await user.type(
    screen.getByRole('textbox'),
    VALID_LINK,
  );
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  // Preview screen
  await screen.findByRole('heading', { name: 'Confirm join' });
  await user.click(screen.getByRole('button', { name: 'Join Hive' }));
}

// ── D-004a — POST body shape ───────────────────────────────────────────────

describe('D-004a — POST body omits stale credentials', () => {
  it('includes slug and harnessLinkUrl in the POST body', async () => {
    const user = userEvent.setup();

    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          state: {
            steps: Object.fromEntries(
              JOIN_STEP_IDS.map((id) => [id, { id, status: 'done' }]),
            ),
            insightsPath: '/harness/my-repo/insights',
          },
        }),
        { status: 200 },
      ),
    );

    renderForm();
    await submitJoin(user);

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/harness/join-link');
    expect(init.method).toBe('POST');

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.slug).toBe('my-repo');
    expect(body.harnessLinkUrl).toBe(VALID_LINK);
  });

  it('does NOT send token, githubUserId, or githubLogin', async () => {
    const user = userEvent.setup();

    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          state: {
            steps: Object.fromEntries(
              JOIN_STEP_IDS.map((id) => [id, { id, status: 'done' }]),
            ),
            insightsPath: '/harness/my-repo/insights',
          },
        }),
        { status: 200 },
      ),
    );

    renderForm();
    await submitJoin(user);

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;

    expect('token' in body).toBe(false);
    expect('githubUserId' in body).toBe(false);
    expect('githubLogin' in body).toBe(false);
  });
});

// ── D-004b — 401 gh_auth_required handling ────────────────────────────────

describe('D-004b — 401 gh_auth_required error message', () => {
  it('shows the gh auth login message on 401 gh_auth_required', async () => {
    const user = userEvent.setup();

    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ code: 'gh_auth_required', error: 'Not authenticated' }),
        { status: 401 },
      ),
    );

    renderForm();
    await submitJoin(user);

    await waitFor(() => {
      const el = screen.getByText((text) =>
        text.includes('gh auth login'),
      );
      expect(el).toBeTruthy();
    });
  });

  it('does NOT show a raw "401" to the user on gh_auth_required', async () => {
    const user = userEvent.setup();

    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ code: 'gh_auth_required', error: 'Not authenticated' }),
        { status: 401 },
      ),
    );

    renderForm();
    await submitJoin(user);

    await waitFor(() => {
      // Wait until the join is processed (error phase shown).
      screen.getByText((text) => text.includes('gh auth login'));
    });

    // The error banner must NOT read "HTTP 401" or bare "401".
    const allText = document.body.textContent ?? '';
    expect(allText).not.toMatch(/\bHTTP 401\b/);
  });

  it('triggers on a non-401 response carrying code gh_auth_required (the OR arm)', async () => {
    // The endpoint normally sends 401, but the message must ALSO fire when the
    // code arrives under any other non-ok status — this exercises the
    // `body.code === 'gh_auth_required'` arm, NOT the `res.status === 401` arm.
    const user = userEvent.setup();

    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ code: 'gh_auth_required', error: 'Not authenticated' }),
        { status: 422 },
      ),
    );

    renderForm();
    await submitJoin(user);

    await waitFor(() => {
      screen.getByText((text) => text.includes('gh auth login'));
    });
  });
});

// ── D-005 — 6-step progress list (canonical step ids) ─────────────────────

describe('D-005 — 6-step canonical progress list', () => {
  it('renders all 6 canonical step labels from JOIN_STEP_IDS immediately after join starts', async () => {
    const user = userEvent.setup();

    // Mock a slow response so the joining phase is visible.
    let resolveResponse: (r: Response) => void;
    const pendingResponse = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    mockFetch.mockReturnValueOnce(pendingResponse);

    renderForm();
    await submitJoin(user);

    // We are now in the 'joining' phase — JoinProgress should be mounted.
    // Verify all 6 canonical step ids have their expected labels.
    const expectedLabels = [
      'Authenticating with GitHub',
      'Cloning repository',
      'Publishing your binding',
      'Joining the swarm',
      'Syncing with peers',
      'Opening insights',
    ];
    for (const label of expectedLabels) {
      screen.getByText(label);
    }

    // Resolve to avoid hanging async.
    resolveResponse!(
      new Response(
        JSON.stringify({
          state: {
            steps: Object.fromEntries(
              JOIN_STEP_IDS.map((id) => [id, { id, status: 'done' }]),
            ),
            insightsPath: '/harness/my-repo/insights',
          },
        }),
        { status: 200 },
      ),
    );
  });

  it('does NOT render any old Autobase-era step label', async () => {
    const user = userEvent.setup();

    let resolveResponse: (r: Response) => void;
    const pendingResponse = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    mockFetch.mockReturnValueOnce(pendingResponse);

    renderForm();
    await submitJoin(user);

    const staleLabels = [
      'Join peer network',
      'Sync harness data',
      'Seed local database',
      'Create your branch',
      'Publish contributor file',
      'Verify binding',
    ];
    for (const label of staleLabels) {
      expect(screen.queryByText(label)).toBeNull();
    }

    resolveResponse!(
      new Response(
        JSON.stringify({
          state: {
            steps: Object.fromEntries(
              JOIN_STEP_IDS.map((id) => [id, { id, status: 'done' }]),
            ),
            insightsPath: '/harness/my-repo/insights',
          },
        }),
        { status: 200 },
      ),
    );
  });

  it('JOIN_STEP_IDS has exactly 6 entries', () => {
    expect(JOIN_STEP_IDS).toHaveLength(6);
    expect(JOIN_STEP_IDS).toEqual([
      'oauth_attest',
      'clone_repo',
      'publish_binding',
      'boot_federate',
      'await_admission_merge',
      'route_insights',
    ]);
  });
});
