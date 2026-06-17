/**
 * @vitest-environment jsdom
 *
 * EntryGithubUrlForm — hive-from-github-url-2026-06-11 P-011 unit tests:
 * client URL validation, slug auto-derive, visibility copy, the three-mode
 * submit bodies, errorCodeToCopy mapping, join-offer rendering + the
 * per-member-link join, and the no-links create-anyway (force) resubmit.
 * Same conventions as CreateHarnessPicker.test.tsx (no jest-dom matchers).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  EntryGithubUrlForm,
  deriveSlugFromRepo,
  errorCodeToCopy,
  parseGithubUrlClient,
  stepForErrorCode,
} from '../EntryGithubUrlForm';

// useLexicon → flag bootstrap (fetch + EventSource) is mocked out; the form
// only resolves the 'pot' term ("Hive"/"hive").
vi.mock('@/lib/useLexicon', () => ({
  useLexicon:
    () =>
    (key: string, opts?: { plural?: boolean; lower?: boolean }) => {
      const base = key === 'pot' ? (opts?.plural ? 'Hives' : 'Hive') : key;
      return opts?.lower ? base.toLowerCase() : base;
    },
}));

const mockFetch = vi.fn<typeof fetch>();
beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
});
afterEach(() => cleanup());

function renderForm(props?: {
  onBack?: () => void;
  onCreated?: (slug: string, opts?: { hive?: string }) => void;
  hiveScope?: string | null;
  initialMode?: 'new-hive' | 'into-hive' | 'standalone';
}) {
  const onBack = props?.onBack ?? vi.fn();
  const onCreated = props?.onCreated ?? vi.fn();
  const result = render(
    <EntryGithubUrlForm
      onBack={onBack}
      onCreated={onCreated}
      hiveScope={props?.hiveScope ?? null}
      initialMode={props?.initialMode ?? 'new-hive'}
    />,
  );
  return { ...result, onBack, onCreated };
}

/** JSON responder keyed on the request URL substring. */
function respondByUrl(routes: Record<string, { status: number; body: unknown }>) {
  mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    for (const [needle, r] of Object.entries(routes)) {
      if (url.includes(needle)) return new Response(JSON.stringify(r.body), { status: r.status });
    }
    return new Response(JSON.stringify({ error: `unmocked ${url}` }), { status: 500 });
  });
}

/** All POST bodies fired at a URL substring, in order. */
function postedBodies(needle: string): Record<string, unknown>[] {
  return mockFetch.mock.calls
    .filter((c) => {
      const url = typeof c[0] === 'string' ? c[0] : (c[0] as URL).toString();
      return url.includes(needle);
    })
    .map((c) => JSON.parse((c[1] as RequestInit).body as string) as Record<string, unknown>);
}

const VALID_URL = 'https://github.com/acme/web';
const TOPIC = 'a'.repeat(64);
const memberLink = (repo: string, id: number) =>
  `papercusp://harness?topic=${TOPIC}&github=acme/${repo}&repo_id=${id}`;

// ── Pure helpers ────────────────────────────────────────────────────────────

describe('parseGithubUrlClient', () => {
  it('accepts https and ssh shapes, rejects everything else', () => {
    expect(parseGithubUrlClient('https://github.com/acme/web')).toEqual({ owner: 'acme', repo: 'web' });
    expect(parseGithubUrlClient('https://github.com/acme/web.git')).toEqual({ owner: 'acme', repo: 'web' });
    expect(parseGithubUrlClient('git@github.com:acme/web.git')).toEqual({ owner: 'acme', repo: 'web' });
    expect(parseGithubUrlClient('https://gitlab.com/acme/web')).toBeNull();
    expect(parseGithubUrlClient('github.com/acme/web')).toBeNull();
    expect(parseGithubUrlClient('not a url')).toBeNull();
    expect(parseGithubUrlClient('')).toBeNull();
  });
});

describe('deriveSlugFromRepo', () => {
  it('kebab-cases the repo name', () => {
    expect(deriveSlugFromRepo('My_Repo')).toBe('my-repo');
    expect(deriveSlugFromRepo('web')).toBe('web');
    expect(deriveSlugFromRepo('a..b--C')).toBe('a-b-c');
  });
});

describe('errorCodeToCopy', () => {
  it('maps both routes’ clone codes to actionable copy', () => {
    expect(errorCodeToCopy('clone_auth_required', '', 'hive')).toContain('gh auth login');
    expect(errorCodeToCopy('auth_required', '', 'hive')).toContain('gh auth login');
    expect(errorCodeToCopy('clone_not_found', '', 'hive')).toContain('Repository not found');
    expect(errorCodeToCopy('clone_dest_exists', '', 'hive')).toContain('already exists on disk');
    expect(errorCodeToCopy('invalid_url', '', 'hive')).toContain('github.com/owner/repo');
    expect(errorCodeToCopy('slug_exhausted', '', 'hive')).toContain('Advanced');
    expect(errorCodeToCopy('hive_create_failed', 'boom', 'hive')).toContain('boom');
    expect(errorCodeToCopy(undefined, 'raw message', 'hive')).toBe('raw message');
  });
});

describe('stepForErrorCode', () => {
  it('settles the failure on the step the code belongs to', () => {
    expect(stepForErrorCode('invalid_url')).toBe('resolve');
    expect(stepForErrorCode('hive_not_found')).toBe('lookup');
    expect(stepForErrorCode('clone_auth_required')).toBe('clone');
    expect(stepForErrorCode('blueprint_failed')).toBe('detect');
    expect(stepForErrorCode('member_create_failed')).toBe('create');
    expect(stepForErrorCode('slug_exhausted')).toBe('create');
  });
});

// ── Form validation ─────────────────────────────────────────────────────────

describe('form validation', () => {
  it('rejects a non-GitHub URL client-side without calling the backend', async () => {
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByPlaceholderText('https://github.com/owner/repo'), 'https://gitlab.com/a/b');
    await user.click(screen.getByRole('button', { name: 'Create hive' }));
    screen.getByText(/Not a valid GitHub repository URL/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('shows the public privacy explainer with Public selected by default', () => {
    renderForm();
    const publicRadio = screen.getByRole('radio', { name: /Public/ }) as HTMLInputElement;
    expect(publicRadio.checked).toBe(true);
    screen.getByText(
      "Anyone on the network can discover this hive; contributors' GitHub identities, including your own, are visible.",
    );
  });

  it('auto-derives the slug under the Advanced expander', async () => {
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByPlaceholderText('https://github.com/owner/repo'), 'https://github.com/Acme/My_Repo');
    await user.click(screen.getByText(/Advanced: customize slug/));
    const slugInput = screen.getByPlaceholderText('my-repo') as HTMLInputElement;
    expect(slugInput.value).toBe('my-repo');
  });
});

// ── new-hive submit ─────────────────────────────────────────────────────────

describe('new-hive mode', () => {
  it('POSTs to /api/harness/hives/from-repo and shows the created summary', async () => {
    const user = userEvent.setup();
    respondByUrl({
      '/api/harness/hives/from-repo': {
        status: 200,
        body: {
          ok: true,
          created: { hiveSlug: 'web-hive', memberSlug: 'web', memberPath: '/tmp/web', defaultBranch: 'main' },
          bindingUnverified: false,
          publish: { announced: true, cupboard: { attempted: true, rowsCreated: 1, rowsFailed: 0 } },
        },
      },
    });
    const { onCreated } = renderForm();
    await user.type(screen.getByPlaceholderText('https://github.com/owner/repo'), VALID_URL);
    await user.click(screen.getByRole('button', { name: 'Create hive' }));

    await waitFor(() => screen.getByRole('heading', { name: /Hive created/ }));
    expect(postedBodies('/api/harness/hives/from-repo')[0]).toMatchObject({
      githubUrl: VALID_URL,
      visibility: 'public',
    });
    screen.getByText('web-hive');
    screen.getByText('web');
    screen.getByText(/Announced to the hive directory/);

    await user.click(screen.getByRole('button', { name: 'Done' }));
    // A new hive becomes the focused scope — single-arg onCreated.
    expect(onCreated).toHaveBeenCalledWith('web-hive');
  });

  it('test-verify is opt-in (hardening D-001): unchecked sends no runTests; checked sends true', async () => {
    const user = userEvent.setup();
    respondByUrl({
      '/api/harness/hives/from-repo': {
        status: 200,
        body: { ok: true, created: { hiveSlug: 'web-hive', memberSlug: 'web', memberPath: '/tmp/web' }, bindingUnverified: false, publish: { skipped: 'private' } },
      },
    });
    renderForm();
    const optin = screen.getByTestId('verify-tests-optin').querySelector('input')!;
    expect(optin.checked).toBe(false); // default OFF — running repo code is opt-in
    await user.type(screen.getByPlaceholderText('https://github.com/owner/repo'), VALID_URL);
    await user.click(screen.getByRole('button', { name: 'Create hive' }));
    await waitFor(() => expect(postedBodies('/api/harness/hives/from-repo')).toHaveLength(1));
    expect(postedBodies('/api/harness/hives/from-repo')[0]).not.toHaveProperty('runTests');

    cleanup();
    mockFetch.mockClear();
    respondByUrl({
      '/api/harness/hives/from-repo': {
        status: 200,
        body: { ok: true, created: { hiveSlug: 'web-hive', memberSlug: 'web', memberPath: '/tmp/web' }, bindingUnverified: false, publish: { skipped: 'private' } },
      },
    });
    renderForm();
    await user.click(screen.getByTestId('verify-tests-optin'));
    await user.type(screen.getByPlaceholderText('https://github.com/owner/repo'), VALID_URL);
    await user.click(screen.getByRole('button', { name: 'Create hive' }));
    await waitFor(() => expect(postedBodies('/api/harness/hives/from-repo')).toHaveLength(1));
    expect(postedBodies('/api/harness/hives/from-repo')[0]).toMatchObject({ runTests: true });
  });

  it('learning pack: default selection submits papercusp-default; "none" submits null; success card shows the seeded line (learning-packs P-006)', async () => {
    const user = userEvent.setup();
    respondByUrl({
      '/api/harness/hives/from-repo': {
        status: 200,
        body: {
          ok: true,
          created: {
            hiveSlug: 'web-hive',
            memberSlug: 'web',
            memberPath: '/tmp/web',
            seededLearnings: { packId: 'papercusp-default', packVersion: '1.0.0', count: 28 },
          },
          bindingUnverified: false,
          publish: { skipped: 'private' },
        },
      },
    });
    renderForm();
    // The picker defaults to the Papercusp pack and explains the seeding.
    const picker = screen.getByTestId('learning-pack-picker').querySelector('select')!;
    expect(picker.value).toBe('papercusp-default');
    await user.type(screen.getByPlaceholderText('https://github.com/owner/repo'), VALID_URL);
    await user.click(screen.getByRole('button', { name: 'Create hive' }));
    await waitFor(() => expect(postedBodies('/api/harness/hives/from-repo')).toHaveLength(1));
    expect(postedBodies('/api/harness/hives/from-repo')[0]).toMatchObject({ learningPack: 'papercusp-default' });
    // Success summary: the seeded-learnings line + the view & edit link.
    const line = await screen.findByTestId('seeded-learnings-line');
    expect(line.textContent).toContain('Started with 28 default learnings');
    expect(line.querySelector('a')?.getAttribute('href')).toBe('/adv?tab=learning&lview=learnings&lhive=web-hive');

    cleanup();
    mockFetch.mockClear();
    respondByUrl({
      '/api/harness/hives/from-repo': {
        status: 200,
        body: { ok: true, created: { hiveSlug: 'web-hive', memberSlug: 'web', memberPath: '/tmp/web' }, bindingUnverified: false, publish: { skipped: 'private' } },
      },
    });
    renderForm();
    await user.selectOptions(screen.getByTestId('learning-pack-picker').querySelector('select')!, 'none');
    await user.type(screen.getByPlaceholderText('https://github.com/owner/repo'), VALID_URL);
    await user.click(screen.getByRole('button', { name: 'Create hive' }));
    await waitFor(() => expect(postedBodies('/api/harness/hives/from-repo')).toHaveLength(1));
    expect(postedBodies('/api/harness/hives/from-repo')[0]).toMatchObject({ learningPack: null });
  });

  it('beacon consent (B-07 / C-2): shown for public, default OFF, unchecked sends beaconConsent:false', async () => {
    const user = userEvent.setup();
    respondByUrl({
      '/api/harness/hives/from-repo': {
        status: 200,
        body: { ok: true, created: { hiveSlug: 'web-hive', memberSlug: 'web', memberPath: '/tmp/web' }, bindingUnverified: false, publish: { announced: true, cupboard: { attempted: true, rowsCreated: 1, rowsFailed: 0 } } },
      },
    });
    renderForm();
    const beacon = screen.getByTestId('beacon-consent-optin').querySelector('input')!;
    expect(beacon.checked).toBe(false); // default OFF — publishing a beacon is opt-in (D-002)
    screen.getByText(/Also publish a live status beacon\?/);
    await user.type(screen.getByPlaceholderText('https://github.com/owner/repo'), VALID_URL);
    await user.click(screen.getByRole('button', { name: 'Create hive' }));
    await waitFor(() => expect(postedBodies('/api/harness/hives/from-repo')).toHaveLength(1));
    expect(postedBodies('/api/harness/hives/from-repo')[0]).toMatchObject({ visibility: 'public', beaconConsent: false });
  });

  it('beacon consent: checking the box sends beaconConsent:true', async () => {
    const user = userEvent.setup();
    respondByUrl({
      '/api/harness/hives/from-repo': {
        status: 200,
        body: { ok: true, created: { hiveSlug: 'web-hive', memberSlug: 'web', memberPath: '/tmp/web' }, bindingUnverified: false, publish: { announced: true, cupboard: { attempted: true, rowsCreated: 1, rowsFailed: 0 } } },
      },
    });
    renderForm();
    await user.click(screen.getByTestId('beacon-consent-optin'));
    await user.type(screen.getByPlaceholderText('https://github.com/owner/repo'), VALID_URL);
    await user.click(screen.getByRole('button', { name: 'Create hive' }));
    await waitFor(() => expect(postedBodies('/api/harness/hives/from-repo')).toHaveLength(1));
    expect(postedBodies('/api/harness/hives/from-repo')[0]).toMatchObject({ beaconConsent: true });
  });

  it('beacon consent: a PRIVATE hive hides the question and sends no beaconConsent (no publish ⇒ no beacon)', async () => {
    const user = userEvent.setup();
    respondByUrl({
      '/api/harness/hives/from-repo': {
        status: 200,
        body: { ok: true, created: { hiveSlug: 'web-hive', memberSlug: 'web', memberPath: '/tmp/web' }, bindingUnverified: false, publish: { skipped: 'private' } },
      },
    });
    renderForm();
    await user.click(screen.getByRole('radio', { name: /Private/ }));
    expect(screen.queryByTestId('beacon-consent-optin')).toBeNull();
    await user.type(screen.getByPlaceholderText('https://github.com/owner/repo'), VALID_URL);
    await user.click(screen.getByRole('button', { name: 'Create hive' }));
    await waitFor(() => expect(postedBodies('/api/harness/hives/from-repo')).toHaveLength(1));
    expect(postedBodies('/api/harness/hives/from-repo')[0]).not.toHaveProperty('beaconConsent');
    expect(postedBodies('/api/harness/hives/from-repo')[0]).toMatchObject({ visibility: 'private' });
  });

  it('shows the invite secret for an invite hive', async () => {
    const user = userEvent.setup();
    respondByUrl({
      '/api/harness/hives/from-repo': {
        status: 200,
        body: {
          ok: true,
          created: { hiveSlug: 'web-hive', memberSlug: 'web', memberPath: '/tmp/web' },
          bindingUnverified: false,
          publish: { announced: true, inviteSecret: 's3cret-topic', cupboard: { attempted: false, skipped: 'invite' } },
        },
      },
    });
    renderForm();
    await user.type(screen.getByPlaceholderText('https://github.com/owner/repo'), VALID_URL);
    await user.click(screen.getByRole('radio', { name: /Invite/ }));
    await user.click(screen.getByRole('button', { name: 'Create hive' }));

    await waitFor(() => screen.getByTestId('invite-secret'));
    expect(screen.getByTestId('invite-secret').textContent).toBe('s3cret-topic');
    expect(postedBodies('/api/harness/hives/from-repo')[0].visibility).toBe('invite');
  });

  it('shows + copies the FULL invite link when present, instead of the bare secret (hardening P-006)', async () => {
    const user = userEvent.setup();
    const inviteLink = `papercusp://hive?pubkey=${encodeURIComponent('B'.repeat(43) + '=')}&secret=${'ab12'.repeat(8)}&title=web-hive`;
    respondByUrl({
      '/api/harness/hives/from-repo': {
        status: 200,
        body: {
          ok: true,
          created: { hiveSlug: 'web-hive', memberSlug: 'web', memberPath: '/tmp/web' },
          bindingUnverified: false,
          publish: {
            announced: true,
            inviteSecret: 'ab12'.repeat(8),
            inviteLink,
            cupboard: { attempted: false, skipped: 'invite' },
          },
        },
      },
    });
    renderForm();
    await user.type(screen.getByPlaceholderText('https://github.com/owner/repo'), VALID_URL);
    await user.click(screen.getByRole('radio', { name: /Invite/ }));
    await user.click(screen.getByRole('button', { name: 'Create hive' }));

    await waitFor(() => screen.getByTestId('invite-link'));
    // The full artifact is shown; the bare-secret fallback is NOT rendered.
    expect(screen.getByTestId('invite-link').textContent).toBe(inviteLink);
    expect(screen.queryByTestId('invite-secret')).toBeNull();

    // Copy puts the FULL artifact on the clipboard and confirms.
    await user.click(screen.getByTestId('invite-copy'));
    expect(await window.navigator.clipboard.readText()).toBe(inviteLink);
    await screen.findByText('Copied ✓');
  });

  it('shows the duplicateOf warning when force-created past an existing hive', async () => {
    const user = userEvent.setup();
    respondByUrl({
      '/api/harness/hives/from-repo': {
        status: 200,
        body: {
          ok: true,
          created: {
            hiveSlug: 'web-hive',
            memberSlug: 'web',
            memberPath: '/tmp/web',
            duplicateOf: { kind: 'hive', hivePubkey: 'pk', source: 'directory' },
          },
          bindingUnverified: false,
          publish: { skipped: 'private' },
        },
      },
    });
    renderForm();
    await user.type(screen.getByPlaceholderText('https://github.com/owner/repo'), VALID_URL);
    await user.click(screen.getByRole('button', { name: 'Create hive' }));

    await waitFor(() => screen.getByText(/Created as a duplicate of an existing hive/));
  });
});

// ── Error mapping (rendered) ────────────────────────────────────────────────

describe('error rendering', () => {
  it('maps clone_auth_required to the gh-auth copy and offers retry', async () => {
    const user = userEvent.setup();
    respondByUrl({
      '/api/harness/hives/from-repo': {
        status: 401,
        body: { error: 'authentication required', code: 'clone_auth_required' },
      },
    });
    renderForm();
    await user.type(screen.getByPlaceholderText('https://github.com/owner/repo'), VALID_URL);
    await user.click(screen.getByRole('button', { name: 'Create hive' }));

    const alert = await waitFor(() => screen.getByRole('alert'));
    expect(alert.textContent).toContain('GitHub authentication required');
    screen.getByRole('button', { name: 'Edit & retry' });
  });

  it('maps slug_exhausted to the customize-slug copy', async () => {
    const user = userEvent.setup();
    respondByUrl({
      '/api/harness/hives/from-repo': {
        status: 409,
        body: { error: 'no free slug', code: 'slug_exhausted' },
      },
    });
    renderForm();
    await user.type(screen.getByPlaceholderText('https://github.com/owner/repo'), VALID_URL);
    await user.click(screen.getByRole('button', { name: 'Create hive' }));

    const alert = await waitFor(() => screen.getByRole('alert'));
    expect(alert.textContent).toContain('Customize the slug under Advanced');
  });
});

// ── Join offer ──────────────────────────────────────────────────────────────

describe('join offer (existing hive)', () => {
  const existingHive = (links: string[]) => ({
    ok: true,
    existing: {
      kind: 'hive',
      hive: {
        hiveId: 'hive-1',
        title: 'Acme Web',
        ownerGithubLogin: 'octocat',
        claimStatus: 'claimed',
        ...(links.length ? { memberLinks: links } : {}),
      },
      coords: { owner: 'acme', repo: 'web' },
      source: 'directory',
      bindingUnverified: false,
    },
  });

  it('renders the confirm card and joins the HIVE via /api/discovery/join-hive (P-007 hardening)', async () => {
    const user = userEvent.setup();
    respondByUrl({
      '/api/harness/hives/from-repo': { status: 200, body: existingHive([memberLink('web', 1), memberLink('api', 2)]) },
      '/api/discovery/join-hive': {
        status: 200,
        body: { ok: true, hiveSlug: 'acme-web', members: [{ ok: true }, { ok: true }] },
      },
    });
    const { onCreated } = renderForm();
    await user.type(screen.getByPlaceholderText('https://github.com/owner/repo'), VALID_URL);
    await user.click(screen.getByRole('button', { name: 'Create hive' }));

    await waitFor(() => screen.getByText('Acme Web'));
    screen.getByText(/A hive already exists for this repository/);
    screen.getByText('owner: octocat');
    screen.getByText('claim status: claimed');

    await user.click(screen.getByRole('button', { name: 'Join hive' }));
    await waitFor(() => screen.getByText(/Joined 2\/2 member harnesses/));

    // ONE composed call carrying every member link — the route runs the
    // per-link joins AND materializes the local remote-hive view (D-007).
    const joins = postedBodies('/api/discovery/join-hive');
    expect(joins).toHaveLength(1);
    expect(joins[0]).toMatchObject({
      hiveId: 'hive-1', // the offer's hiveId, passed through verbatim
      memberLinks: [memberLink('web', 1), memberLink('api', 2)],
    });
    expect(postedBodies('/api/harness/join-link')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Done' }));
    // onCreated gets the materialized VIEW slug — the focused scope.
    expect(onCreated).toHaveBeenCalledWith('acme-web');
  });

  it('no member links → "isn’t joinable yet" + Create-anyway resubmits with force', async () => {
    const user = userEvent.setup();
    let call = 0;
    mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (url.includes('/api/harness/hives/from-repo')) {
        call += 1;
        if (call === 1) return new Response(JSON.stringify(existingHive([])), { status: 200 });
        return new Response(
          JSON.stringify({
            ok: true,
            created: {
              hiveSlug: 'web-hive',
              memberSlug: 'web',
              memberPath: '/tmp/web',
              duplicateOf: { kind: 'hive', source: 'directory' },
            },
            bindingUnverified: false,
            publish: { announced: true, cupboard: { attempted: true, rowsCreated: 0, rowsFailed: 1 } },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({}), { status: 500 });
    });
    renderForm();
    await user.type(screen.getByPlaceholderText('https://github.com/owner/repo'), VALID_URL);
    await user.click(screen.getByRole('button', { name: 'Create hive' }));

    await waitFor(() => screen.getByText(/isn’t joinable yet/));
    expect(screen.queryByRole('button', { name: 'Join hive' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Create anyway' }));
    await waitFor(() => screen.getByText(/Created as a duplicate/));
    const bodies = postedBodies('/api/harness/hives/from-repo');
    expect(bodies).toHaveLength(2);
    expect(bodies[0].force).toBeUndefined();
    expect(bodies[1].force).toBe(true);
  });

  it('renders a legacy shared-harness offer with its single join link', async () => {
    const user = userEvent.setup();
    respondByUrl({
      '/api/harness/hives/from-repo': {
        status: 200,
        body: {
          ok: true,
          existing: {
            kind: 'legacy_shared_harness',
            binding: { harnessSlug: 'old-web', harnessLink: memberLink('web', 1), claimStatus: 'unclaimed' },
            source: 'local-cache',
            bindingUnverified: false,
          },
        },
      },
      '/api/harness/join-link': { status: 200, body: { ok: true, state: {} } },
    });
    renderForm();
    await user.type(screen.getByPlaceholderText('https://github.com/owner/repo'), VALID_URL);
    await user.click(screen.getByRole('button', { name: 'Create hive' }));

    await waitFor(() => screen.getByText(/A shared harness already exists/));
    screen.getByText('old-web');
    await user.click(screen.getByRole('button', { name: 'Join harness' }));
    await waitFor(() => screen.getByText(/Joined 1\/1 member harness/));
  });
});

// ── into-hive + standalone modes ────────────────────────────────────────────

describe('into-hive mode', () => {
  it('sends intoHive (no visibility) and reports the membership to onCreated', async () => {
    const user = userEvent.setup();
    respondByUrl({
      '/api/harness/hives/from-repo': {
        status: 200,
        body: {
          ok: true,
          created: { hiveSlug: 'acme', memberSlug: 'web', memberPath: '/tmp/web' },
          bindingUnverified: false,
          publish: { skipped: 'unpublished_hive' },
        },
      },
    });
    const { onCreated } = renderForm({ hiveScope: 'acme', initialMode: 'into-hive' });
    await user.type(screen.getByPlaceholderText('https://github.com/owner/repo'), VALID_URL);
    await user.click(screen.getByRole('button', { name: 'Add repository' }));

    await waitFor(() => screen.getByRole('heading', { name: /Added to acme/ }));
    const body = postedBodies('/api/harness/hives/from-repo')[0];
    expect(body).toMatchObject({ githubUrl: VALID_URL, intoHive: 'acme' });
    expect(body.visibility).toBeUndefined();

    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onCreated).toHaveBeenCalledWith('web', { hive: 'acme' });
  });
});

describe('standalone mode (D-007)', () => {
  it('uses the projects route with the derived slug and no hive', async () => {
    const user = userEvent.setup();
    respondByUrl({
      '/api/harness/projects': {
        status: 200,
        body: { ok: true, project: { slug: 'web', path: '/clones/web' }, blueprint: { generated: true } },
      },
    });
    const { onCreated } = renderForm();
    await user.click(screen.getByRole('button', { name: 'Standalone' }));
    await user.type(screen.getByPlaceholderText('https://github.com/owner/repo'), VALID_URL);
    await user.click(screen.getByRole('button', { name: 'Clone & register' }));

    await waitFor(() => screen.getByRole('heading', { name: /Harness created/ }));
    expect(postedBodies('/api/harness/projects')[0]).toMatchObject({ slug: 'web', githubUrl: VALID_URL });
    expect(postedBodies('/api/harness/hives/from-repo')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onCreated).toHaveBeenCalledWith('web');
  });

  it('maps the projects route’s bare clone codes (dest_exists)', async () => {
    const user = userEvent.setup();
    respondByUrl({
      '/api/harness/projects': {
        status: 409,
        body: { error: 'destination exists', code: 'dest_exists' },
      },
    });
    renderForm();
    await user.click(screen.getByRole('button', { name: 'Standalone' }));
    await user.type(screen.getByPlaceholderText('https://github.com/owner/repo'), VALID_URL);
    await user.click(screen.getByRole('button', { name: 'Clone & register' }));

    const alert = await waitFor(() => screen.getByRole('alert'));
    expect(alert.textContent).toContain('already exists on disk');
  });
});
