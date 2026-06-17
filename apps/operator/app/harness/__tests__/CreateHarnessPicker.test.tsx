/**
 * @vitest-environment jsdom
 *
 * CreateHarnessPicker — the legacy P-012a/b/c/d picker tests PLUS the
 * comb-hive-native-sharing P-006/P-007/P-009 rework: the hive-native Create /
 * Join layout (flag-on), per-entry outcome explainers, and the "Search GitHub"
 * entry routing to the EntryGithubSearchForm panel (which feeds the
 * create-from-repo flow). Uses @testing-library/react + vitest only (no
 * jest-dom matchers).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { withNuqsTestingAdapter } from 'nuqs/adapters/testing';
import { FLAGS } from '@papercusp/flags';
import { CreateHarnessPicker } from '../CreateHarnessPicker';

// ── Global mock setup ──────────────────────────────────────────────────────

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// The picker calls useViewer() on mount, which fires a module-cached
// GET /api/viewer. In tests whose mockFetch doesn't return a Response for that
// URL it resolves undefined, and useViewer's `fetch(...).then()` throws
// "Cannot read properties of undefined (reading 'then')" — an unhandled
// rejection that fails the run (EXIT 1) even though every test passes. Stub the
// hook so no test fires the fetch; provide isViewer too (the share-offer step).
vi.mock('../../adv/harnesses/useViewer', () => ({
  useViewer: () => ({ viewer: null }),
  isViewer: () => false,
}));

// Per-key flag override map — the picker gates the hive-native layout on
// HIVE_FROM_GITHUB_URL and useLexicon reads THE_HIVE. Unset keys default true
// (both flags default-ON in FLAG_DEFAULTS). Mocking the hook keeps jsdom away
// from the real flag bootstrap (fetch + EventSource). vi.hoisted: the factory
// runs during hoisted module mocking, before module-scope consts initialize.
const flagValues = vi.hoisted(() => ({}) as Record<string, boolean>);
vi.mock('@/lib/flag-hooks', () => ({
  useFlag: (key: string) => flagValues[key] ?? true,
}));

const mockFetch = vi.fn<typeof fetch>();
beforeEach(() => {
  mockFetch.mockReset();
  for (const k of Object.keys(flagValues)) delete flagValues[k];
  vi.stubGlobal('fetch', mockFetch);
});
afterEach(() => cleanup());

function renderPicker(props?: {
  onCreated?: (slug: string, opts?: { hive?: string }) => void;
  hiveScope?: string | null;
  hiveLabel?: string;
}) {
  const onOpenChange = vi.fn();
  const result = render(
    <CreateHarnessPicker
      open
      onOpenChange={onOpenChange}
      onCreated={props?.onCreated}
      hiveScope={props?.hiveScope ?? null}
      hiveLabel={props?.hiveLabel ?? 'Hive'}
    />,
    // The picker's selected entry rides the `?picker=` nuqs param now.
    { wrapper: withNuqsTestingAdapter({ searchParams: '' }) },
  );
  return { ...result, onOpenChange };
}

/** Route fetch by URL so the viewer fetch is harmless + the create returns ok. */
function mockCreateOk(project: { slug: string; path: string }, extra: Record<string, unknown> = {}) {
  mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url.includes('/api/viewer')) return new Response(JSON.stringify({}), { status: 200 });
    return new Response(JSON.stringify({ ok: true, project, ...extra }), { status: 200 });
  });
}

/** The body of the most recent non-viewer POST the picker fired. */
function lastCreateBody(): Record<string, unknown> {
  const call = mockFetch.mock.calls.find((c) => {
    const url = typeof c[0] === 'string' ? c[0] : (c[0] as URL).toString();
    return !url.includes('/api/viewer');
  });
  return JSON.parse((call?.[1] as RequestInit).body as string) as Record<string, unknown>;
}

// ── P-006/P-007 — the hive-native Create / Join layout (flag on) ────────────

describe('P-006/P-007 — hive-native picker layout (flag on)', () => {
  it('renders the Create cards + the Join cards with outcome explainers', () => {
    renderPicker();
    // Create group — getByText throws if not found (presence assert, no jest-dom).
    screen.getByText('New local directory');
    screen.getByText('Existing local repo');
    screen.getByText('Search GitHub or enter URL');
    // Join group — the demoted underline affordances are gone; these are cards now.
    screen.getByText('Browse the Comb');
    screen.getByText('Hive invite');
    // The legacy per-hive "Hive link" join card is retired.
    expect(screen.queryByText('Hive link')).toBeNull();
    // The renamed entry replaces the old "GitHub URL" card.
    expect(screen.queryByText('GitHub URL')).toBeNull();
    // No leftover demoted affordances.
    expect(screen.queryByText(/I have a harness link/)).toBeNull();
    expect(screen.queryByText(/I have a hive invite/)).toBeNull();
  });

  it('groups entries under Create and Join headings (not Local/Shared)', () => {
    renderPicker();
    screen.getByRole('heading', { name: 'Create' });
    screen.getByRole('heading', { name: 'Join' });
    expect(screen.queryByRole('heading', { name: 'Local' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Shared' })).toBeNull();
  });

  it('shows the Create + Join subheadings (hive-framed copy)', () => {
    renderPicker();
    screen.getByText('Start a new hive, or add a repository to one.');
    screen.getByText('Collaborate on a hive someone else published.');
  });

  it('the Search GitHub card carries the create-or-join outcome explainer (P-007)', () => {
    renderPicker();
    screen.getByText('Find any repo on GitHub and create or join a hive from it.');
  });

  it('Browse the Comb is a link to /cupboard', () => {
    renderPicker();
    const link = screen.getByText('Browse the Comb').closest('a');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('/cupboard');
  });

  it('shows the add-a-harness heading', () => {
    renderPicker();
    screen.getByRole('heading', { name: 'Add a Hive' });
  });

  it('renders no Phase 1b badge in the picker (label removed)', () => {
    renderPicker();
    expect(screen.queryByText('Phase 1b')).toBeNull();
  });
});

// ── Legacy layout (flag off) — preserved byte-for-byte ──────────────────────

describe('legacy picker layout (HIVE_FROM_GITHUB_URL off)', () => {
  it('renders the legacy cards under Local / Shared', () => {
    flagValues[FLAGS.HIVE_FROM_GITHUB_URL] = false;
    renderPicker();
    screen.getByText('New local directory');
    screen.getByText('Existing local repo');
    screen.getByText('GitHub URL');
    screen.getByRole('heading', { name: 'Local' });
    screen.getByRole('heading', { name: 'Shared' });
    // The legacy per-hive "Hive link" join card is retired.
    expect(screen.queryByText('Hive link')).toBeNull();
    // None of the hive-native surfaces.
    expect(screen.queryByText('Search GitHub')).toBeNull();
    expect(screen.queryByText('Browse the Comb')).toBeNull();
    expect(screen.queryByText(/I have a harness link/)).toBeNull();
    expect(screen.queryByText(/I have a hive invite/)).toBeNull();
  });
});

// ── Entry 1 form navigation ────────────────────────────────────────────────

describe('Entry 1 — new local directory navigation', () => {
  it('clicking the card opens the new-local form', async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(screen.getByText('New local directory'));
    screen.getByRole('heading', { name: 'New local directory' });
    screen.getByPlaceholderText('/home/user/projects');
  });

  it('back button returns to picker', async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(screen.getByText('New local directory'));
    await user.click(screen.getByText('← Back'));
    screen.getByRole('heading', { name: 'Add a Hive' });
  });
});

// ── Entry 3 form navigation ────────────────────────────────────────────────

describe('Entry 3 — existing local repo navigation', () => {
  it('clicking the card opens the existing-local form', async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(screen.getByText('Existing local repo'));
    screen.getByRole('heading', { name: 'Existing local repo' });
    screen.getByPlaceholderText('/home/user/projects/my-project');
  });
});

// ── P-012b — Entry 1 happy path ───────────────────────────────────────────

describe('P-012b — new-local happy path', () => {
  it('creates harness and calls onCreated on success', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    // CreateHarnessPicker calls useViewer() on mount → GET /api/viewer. With a
    // single mockResolvedValueOnce that viewer fetch (which fires first, before
    // the cache warms) eats the create response, so the POST returns undefined
    // and onCreated never fires. Route by URL so the viewer fetch is harmless.
    mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (url.includes('/api/viewer')) return new Response(JSON.stringify({}), { status: 200 });
      return new Response(
        JSON.stringify({ ok: true, project: { slug: 'my-proj', path: '/tmp/my-proj' } }),
        { status: 200 },
      );
    });
    renderPicker({ onCreated });
    await user.click(screen.getByText('New local directory'));

    // slug field — first 'my-project' placeholder on the form
    await user.type(screen.getAllByPlaceholderText('my-project')[0], 'my-proj');
    await user.type(screen.getByPlaceholderText('/home/user/projects'), '/tmp');
    await user.type(screen.getAllByPlaceholderText('my-project')[1], 'my-proj');
    await user.click(screen.getByRole('button', { name: 'Create Hive' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('my-proj'));
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/harness/projects',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

// ── P-012c — Entry 3 happy path ───────────────────────────────────────────

describe('P-012c — existing-local happy path', () => {
  it('adds harness and calls onCreated on success', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ok: true, project: { slug: 'existing', path: '/repos/existing' } }),
        { status: 200 },
      ),
    );
    renderPicker({ onCreated });
    await user.click(screen.getByText('Existing local repo'));
    await user.type(screen.getByPlaceholderText('my-project'), 'existing');
    await user.type(screen.getByPlaceholderText('/home/user/projects/my-project'), '/repos/existing');
    await user.click(screen.getByRole('button', { name: 'Add Hive' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('existing'));
  });
});

// ── P-012d — error display ────────────────────────────────────────────────

describe('P-012d — error messages', () => {
  it('shows dest_exists message', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: 'Destination already exists', code: 'dest_exists' }),
        { status: 409 },
      ),
    );
    renderPicker();
    await user.click(screen.getByText('New local directory'));
    await user.type(screen.getAllByPlaceholderText('my-project')[0], 'foo');
    await user.type(screen.getByPlaceholderText('/home/user/projects'), '/tmp');
    await user.type(screen.getAllByPlaceholderText('my-project')[1], 'foo');
    await user.click(screen.getByRole('button', { name: 'Create Hive' }));

    const alert = await waitFor(() => screen.getByRole('alert'));
    expect(alert.textContent).toContain('A directory with that name already exists');
  });

  it('shows invalid_path message', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: 'path is invalid', code: 'invalid_path' }),
        { status: 400 },
      ),
    );
    renderPicker();
    await user.click(screen.getByText('Existing local repo'));
    await user.type(screen.getByPlaceholderText('my-project'), 'foo');
    await user.type(screen.getByPlaceholderText('/home/user/projects/my-project'), '/bad/../path');
    await user.click(screen.getByRole('button', { name: 'Add Hive' }));

    const alert = await waitFor(() => screen.getByRole('alert'));
    expect(alert.textContent).toContain('That path is invalid');
  });
});

// ── P-009 — the Search GitHub entry routing ────────────────────────────────

describe('P-009 — Search GitHub entry', () => {
  it('flag on (default): the card opens the search panel (not the create form yet)', async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(screen.getByText('Search GitHub or enter URL'));
    // The search panel — its own heading + searchbox; the create-form heading
    // ('GitHub URL') only appears after a result/URL is picked.
    screen.getByRole('heading', { name: 'Search GitHub or enter URL' });
    screen.getByRole('searchbox');
    expect(screen.queryByRole('heading', { name: 'GitHub URL' })).toBeNull();
    // The selected entry rides the nuqs `?picker=github-url` axis (unchanged id).
  });

  it('flag off: the GitHub URL card still shows the coming-soon stub', async () => {
    flagValues[FLAGS.HIVE_FROM_GITHUB_URL] = false;
    const user = userEvent.setup();
    renderPicker();
    await user.click(screen.getByText('GitHub URL'));
    screen.getByText('Coming soon');
  });

  it('flag off: the stub back button returns to the picker', async () => {
    flagValues[FLAGS.HIVE_FROM_GITHUB_URL] = false;
    const user = userEvent.setup();
    renderPicker();
    await user.click(screen.getByText('GitHub URL'));
    await user.click(screen.getByText('← Back'));
    screen.getByRole('heading', { name: 'Add a Hive' });
  });

  it('pasting a URL in search short-circuits to the create form, prefilled', async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(screen.getByText('Search GitHub or enter URL'));
    await user.type(screen.getByRole('searchbox'), 'https://github.com/octocat/hello-world');
    // The URL short-circuit affordance — Continue → the create flow.
    await user.click(await screen.findByTestId('gh-search-url-continue'));
    // EntryGithubUrlForm now mounted with the URL prefilled.
    screen.getByRole('heading', { name: 'GitHub URL' });
    const urlInput = screen.getByPlaceholderText('https://github.com/owner/repo') as HTMLInputElement;
    expect(urlInput.value).toBe('https://github.com/octocat/hello-world');
  });

  it('into-hive picker mode threads into-hive into the create form opened from search', async () => {
    const user = userEvent.setup();
    renderPicker({ hiveScope: 'acme' });
    await user.click(screen.getByText('Search GitHub or enter URL'));
    await user.type(screen.getByRole('searchbox'), 'https://github.com/octocat/hello-world');
    await user.click(await screen.findByTestId('gh-search-url-continue'));
    // The create form inherits the picker fork (into-hive when a scope is set).
    const addBtn = screen.getByRole('button', { name: 'Add to acme' });
    expect(addBtn.getAttribute('aria-pressed')).toBe('true');
  });
});

// ── P-006 — the Join "Hive invite" card (invitee side) ─────────────────────

describe('P-006 — Hive invite card', () => {
  const INVITE_LINK = `papercusp://hive?secret=${'deadbeef'.repeat(4)}&title=Acme+Shop`;

  it('the card opens the join form', async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(screen.getByText('Hive invite'));
    screen.getByRole('heading', { name: 'Join a hive by invite' });
    screen.getByPlaceholderText('papercusp://hive?pubkey=…&secret=…&title=…');
  });

  it('joining POSTs the artifact to /api/discovery/join-invite and shows the success copy', async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderPicker();
    mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (url.includes('/api/discovery/join-invite')) {
        return new Response(JSON.stringify({ ok: true, joined: true }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    await user.click(screen.getByText('Hive invite'));
    await user.type(
      screen.getByPlaceholderText('papercusp://hive?pubkey=…&secret=…&title=…'),
      INVITE_LINK,
    );
    await user.click(screen.getByRole('button', { name: 'Join' }));

    await waitFor(() => screen.getByTestId('hive-invite-joined'));
    expect(screen.getByTestId('hive-invite-joined').textContent).toContain(
      'Joined the invite directory — the hive will appear in the Hives panel shortly.',
    );
    const call = mockFetch.mock.calls.find((c) => String(c[0]).includes('/api/discovery/join-invite'));
    expect(JSON.parse((call?.[1] as RequestInit).body as string)).toEqual({ link: INVITE_LINK });

    // Joining creates no harness — Done just closes the picker.
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('a malformed link errors inline without POSTing (the route parser runs client-side too)', async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(screen.getByText('Hive invite'));
    await user.type(
      screen.getByPlaceholderText('papercusp://hive?pubkey=…&secret=…&title=…'),
      'not-an-invite-link',
    );
    await user.click(screen.getByRole('button', { name: 'Join' }));

    const alert = await waitFor(() => screen.getByRole('alert'));
    expect(alert.textContent).toContain('doesn’t look like a hive invite link');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('directory_unavailable (gh-unauthed box) maps to the gh-auth copy', async () => {
    const user = userEvent.setup();
    renderPicker();
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, code: 'directory_unavailable' }), { status: 503 }),
    );
    await user.click(screen.getByText('Hive invite'));
    await user.type(
      screen.getByPlaceholderText('papercusp://hive?pubkey=…&secret=…&title=…'),
      INVITE_LINK,
    );
    await user.click(screen.getByRole('button', { name: 'Join' }));

    const alert = await waitFor(() => screen.getByRole('alert'));
    expect(alert.textContent).toContain('gh auth login');
  });
});

// ── P-010/P-011 — the creation fork (D-005) ────────────────────────────────

describe('P-010 — creation fork toggle', () => {
  it('with a hive scope, offers New-hive + Add-to-<hive> + Standalone and defaults into-hive', () => {
    renderPicker({ hiveScope: 'acme', hiveLabel: 'Hive' });
    screen.getByRole('tab', { name: /New hive/ });
    const addBtn = screen.getByRole('tab', { name: 'Add to acme' });
    screen.getByRole('tab', { name: 'Standalone' });
    // Default into-hive → the "added into <hive>" hint + selected toggle.
    expect(addBtn.getAttribute('aria-selected')).toBe('true');
    screen.getByText('acme');
  });

  it('without a hive scope, there is no Add-to button and standalone is the default', () => {
    renderPicker({ hiveScope: null });
    expect(screen.queryByRole('tab', { name: /^Add to/ })).toBeNull();
    screen.getByRole('tab', { name: /New hive/ });
    expect(screen.getByRole('tab', { name: 'Standalone' }).getAttribute('aria-selected')).toBe('true');
  });
});

describe('P-011 — add into hive stamps the membership', () => {
  it('into-hive mode sends `hive` in the create body + reports the membership to onCreated', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    mockCreateOk({ slug: 'web', path: '/tmp/web' }, { membership: { hive: 'acme', edge: 'hive_slug' } });
    renderPicker({ onCreated, hiveScope: 'acme' });
    // Default mode is into-hive; go straight to the existing-local form.
    await user.click(screen.getByText('Existing local repo'));
    await user.type(screen.getByPlaceholderText('my-project'), 'web');
    await user.type(screen.getByPlaceholderText('/home/user/projects/my-project'), '/tmp/web');
    await user.click(screen.getByRole('button', { name: 'Add Hive' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('web', { hive: 'acme' }));
    expect(lastCreateBody()).toMatchObject({ slug: 'web', path: '/tmp/web', hive: 'acme' });
  });

  it('switching to Standalone drops the membership (no `hive` in the body, single-arg onCreated)', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    mockCreateOk({ slug: 'solo', path: '/tmp/solo' });
    renderPicker({ onCreated, hiveScope: 'acme' });
    await user.click(screen.getByRole('tab', { name: 'Standalone' }));
    await user.click(screen.getByText('Existing local repo'));
    await user.type(screen.getByPlaceholderText('my-project'), 'solo');
    await user.type(screen.getByPlaceholderText('/home/user/projects/my-project'), '/tmp/solo');
    await user.click(screen.getByRole('button', { name: 'Add Hive' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('solo'));
    expect(lastCreateBody().hive).toBeUndefined();
  });
});

describe('P-010 — new hive from blueprint', () => {
  it('clicking New-hive opens the hive form and posts to /api/harness/hives (no membership)', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    mockCreateOk({ slug: 'newhive', path: '/tmp/newhive' }, { hive: true });
    renderPicker({ onCreated, hiveScope: 'acme', hiveLabel: 'Hive' });
    await user.click(screen.getByRole('tab', { name: /New hive/ }));
    screen.getByRole('heading', { name: /New hive from blueprint/ });
    await user.type(screen.getByPlaceholderText('my-hive'), 'newhive');
    await user.click(screen.getByRole('button', { name: /Create hive/ }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('newhive'));
    expect(
      mockFetch.mock.calls.some((c) => {
        const url = typeof c[0] === 'string' ? c[0] : (c[0] as URL).toString();
        return url === '/api/harness/hives';
      }),
    ).toBe(true);
  });
});
