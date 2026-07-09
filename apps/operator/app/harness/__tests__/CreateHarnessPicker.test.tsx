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
// POT_FROM_GITHUB_URL and useLexicon reads THE_HIVE. Unset keys default true
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
  // Capture URL writes: the picker now closes via a single atomic useQueryStates
  // write (clears ?create + ?picker together), NOT the onOpenChange callback.
  const urlUpdates: URLSearchParams[] = [];
  const result = render(
    <CreateHarnessPicker
      open
      onOpenChange={onOpenChange}
      onCreated={props?.onCreated}
      hiveScope={props?.hiveScope ?? null}
      hiveLabel={props?.hiveLabel ?? 'Hive'}
    />,
    // The picker's selected entry rides the `?picker=` nuqs param now.
    {
      wrapper: withNuqsTestingAdapter({
        searchParams: '',
        onUrlUpdate: (e) => urlUpdates.push(e.searchParams),
      }),
    },
  );
  return { ...result, onOpenChange, urlUpdates };
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

describe('P-006 — domain-first hive-native picker layout (flag on)', () => {
  it('renders the coding/work/comb-blueprint cards + the Join cards with outcome explainers', () => {
    renderPicker();
    // New coding hive — getByText throws if not found (presence assert, no jest-dom).
    screen.getByText('New local directory');
    screen.getByText('Existing local repo');
    screen.getByText('Search GitHub or enter URL');
    // New work hive (the single sub-option, distinct from its heading).
    screen.getByText('Start a work hive');
    // New hive from a Comb blueprint.
    screen.getByText('Search the Comb');
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

  it('groups entries under the four domain headings (coding / work / Comb blueprint / Join)', () => {
    renderPicker();
    screen.getByRole('heading', { name: 'New coding hive' });
    screen.getByRole('heading', { name: 'New work hive' });
    screen.getByRole('heading', { name: 'New hive from a Comb blueprint' });
    screen.getByRole('heading', { name: 'Join' });
    // The legacy Create / Local / Shared headings are gone.
    expect(screen.queryByRole('heading', { name: 'Create' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Local' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Shared' })).toBeNull();
  });

  it('shows the per-domain subheadings (hive-framed copy)', () => {
    renderPicker();
    screen.getByText('A hive that writes code against a repository.');
    screen.getByText('Non-coding work — research, writing, ops. Judged against a rubric; no repo.');
    screen.getByText('Start a hive from a published blueprint.');
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

// ── P-006 — New work hive (domain-generic-hive Brief 3) ─────────────────────

describe('P-006 — New work hive', () => {
  it('opens the work form and POSTs /api/harness/pots with blueprintId generic-hive', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    mockCreateOk({ slug: 'my-work', path: '/tmp/my-work' });
    renderPicker({ onCreated });

    await user.click(screen.getByText('Start a work hive'));
    // Work-framed heading + placeholder (distinct from the coding form).
    screen.getByRole('heading', { name: 'New work hive' });
    await user.type(screen.getByPlaceholderText('my-work-hive'), 'my-work');
    await user.type(screen.getByPlaceholderText('/home/user/projects'), '/tmp');
    await user.click(screen.getByRole('button', { name: 'Create Hive' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('my-work'));
    // The work domain sends the work blueprint id; coding would omit it.
    expect(lastCreateBody()).toMatchObject({ slug: 'my-work', blueprintId: 'work' });
    expect(mockFetch).toHaveBeenCalledWith('/api/harness/pots', expect.objectContaining({ method: 'POST' }));
  });

  it('a work hive ignores any selected hive scope (always a NEW top-level hive)', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    mockCreateOk({ slug: 'my-work', path: '/tmp/my-work' });
    // Even with a hive scope selected, work creates a new hive (no into-hive member).
    renderPicker({ onCreated, hiveScope: 'parent-hive' });

    await user.click(screen.getByText('Start a work hive'));
    await user.type(screen.getByPlaceholderText('my-work-hive'), 'my-work');
    await user.type(screen.getByPlaceholderText('/home/user/projects'), '/tmp');
    await user.click(screen.getByRole('button', { name: 'Create Hive' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('my-work'));
    // Single-arg onCreated (a root hive), not the {hive} member shape.
    expect(onCreated).toHaveBeenCalledWith('my-work');
    // Posts to the hives route (new hive), never the member projects route.
    expect(mockFetch).toHaveBeenCalledWith('/api/harness/pots', expect.objectContaining({ method: 'POST' }));
    expect(mockFetch).not.toHaveBeenCalledWith('/api/harness/projects', expect.anything());
  });
});

// ── P-006 — New hive from a Comb blueprint (search + instantiate) ────────────

describe('P-006 — New hive from a Comb blueprint', () => {
  it('searches blueprint listings, installs the picked blueprint, then creates a hive with its id', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (url.includes('/api/viewer')) return new Response(JSON.stringify({}), { status: 200 });
      if (url.includes('/api/cupboard/listings')) {
        return new Response(
          JSON.stringify({
            listings: [
              { id: 7, slug: 'research-hive', title: 'Research Hive', description: 'A hive for deep research.', listing_ref: 'research-hive', blueprint_kind: 'hive' },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes('/api/cupboard/install-blueprint')) {
        return new Response(JSON.stringify({ ok: true, id: 'research-hive' }), { status: 200 });
      }
      // /api/harness/pots
      return new Response(JSON.stringify({ ok: true, project: { slug: 'my-research', path: '/tmp/my-research' } }), { status: 200 });
    });
    renderPicker({ onCreated });

    await user.click(screen.getByText('Search the Comb'));
    await user.type(screen.getByPlaceholderText(/research, writing/), 'research');
    // Debounced search → the result renders.
    const result = await screen.findByText('Research Hive');
    await user.click(result);
    // The selected-blueprint create form takes over.
    await user.type(screen.getByPlaceholderText('my-hive'), 'my-research');
    await user.click(screen.getByRole('button', { name: 'Create Hive' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('my-research'));
    // Install fired, then the hive was created with the installed blueprint id.
    expect(mockFetch).toHaveBeenCalledWith('/api/cupboard/install-blueprint', expect.objectContaining({ method: 'POST' }));
    const hivesCall = mockFetch.mock.calls.find((c) => {
      const u = typeof c[0] === 'string' ? c[0] : (c[0] as URL).toString();
      return u.includes('/api/harness/pots');
    });
    expect(hivesCall).toBeDefined();
    expect(JSON.parse((hivesCall![1] as RequestInit).body as string)).toMatchObject({
      slug: 'my-research',
      blueprintId: 'research-hive',
    });
  });

  it('drops a known kind:harness blueprint from the results (hive-instantiable only)', async () => {
    const user = userEvent.setup();
    mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (url.includes('/api/viewer')) return new Response(JSON.stringify({}), { status: 200 });
      if (url.includes('/api/cupboard/listings')) {
        return new Response(
          JSON.stringify({
            listings: [
              { id: 1, slug: 'hive-bp', title: 'Hive BP', description: '', blueprint_kind: 'hive' },
              { id: 2, slug: 'harness-bp', title: 'Harness BP', description: '', blueprint_kind: 'harness' },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    renderPicker();

    await user.click(screen.getByText('Search the Comb'));
    await user.type(screen.getByPlaceholderText(/research, writing/), 'bp');
    await screen.findByText('Hive BP');
    // The harness-kind blueprint can't be a hive home, so it is filtered out.
    expect(screen.queryByText('Harness BP')).toBeNull();
  });
});

// ── Legacy layout (flag off) — preserved byte-for-byte ──────────────────────

describe('legacy picker layout (POT_FROM_GITHUB_URL off)', () => {
  it('renders the legacy cards under Local / Shared', () => {
    flagValues[FLAGS.POT_FROM_GITHUB_URL] = false;
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
    // No hive scope ⇒ a new local dir IS a new hive (Queen blueprint).
    screen.getByRole('heading', { name: /New hive from a local directory/i });
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
    // No hive scope ⇒ an existing repo IS a new hive (linked in place, Queen blueprint).
    screen.getByRole('heading', { name: /Existing repo as a new hive/i });
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

    // A new local dir IS a new hive (no scope): slug + parentDir only, posts to
    // /api/harness/pots (the Queen blueprint), no separate folder-name field.
    await user.type(screen.getByPlaceholderText('my-project'), 'my-proj');
    await user.type(screen.getByPlaceholderText('/home/user/projects'), '/tmp');
    await user.click(screen.getByRole('button', { name: 'Create Hive' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('my-proj'));
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/harness/pots',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

// ── P-012c — Entry 3 happy path ───────────────────────────────────────────

describe('P-012c — existing-local happy path', () => {
  it('with no scope, LINKS the existing repo in place as a NEW hive (POST /api/harness/pots with {path})', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    mockCreateOk({ slug: 'existing', path: '/repos/existing' });
    renderPicker({ onCreated });
    await user.click(screen.getByText('Existing local repo'));
    await user.type(screen.getByPlaceholderText('my-project'), 'existing');
    await user.type(screen.getByPlaceholderText('/home/user/projects/my-project'), '/repos/existing');
    // No scope ⇒ an existing repo IS a new hive (the Queen blueprint), linked in
    // place via the `path` arg — the create button reads "Create Hive".
    await user.click(screen.getByRole('button', { name: 'Create Hive' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('existing'));
    expect(mockFetch).toHaveBeenCalledWith('/api/harness/pots', expect.objectContaining({ method: 'POST' }));
    // A non-empty `path` links the existing dir in place as a hive (the contract);
    // no membership edge (no hive scope).
    expect(lastCreateBody()).toMatchObject({ slug: 'existing', path: '/repos/existing' });
    expect(lastCreateBody().hive).toBeUndefined();
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
    await user.type(screen.getByPlaceholderText('my-project'), 'foo');
    await user.type(screen.getByPlaceholderText('/home/user/projects'), '/tmp');
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
    // No scope ⇒ the existing-repo form creates a new hive ("Create Hive").
    await user.click(screen.getByRole('button', { name: 'Create Hive' }));

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
    flagValues[FLAGS.POT_FROM_GITHUB_URL] = false;
    const user = userEvent.setup();
    renderPicker();
    await user.click(screen.getByText('GitHub URL'));
    screen.getByText('Coming soon');
  });

  it('flag off: the stub back button returns to the picker', async () => {
    flagValues[FLAGS.POT_FROM_GITHUB_URL] = false;
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
    const { urlUpdates } = renderPicker();
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
    // G-002 honesty (Brief G): join-invite only SUBSCRIBES to the invite topic — it
    // cannot confirm the hive exists/announces (a withdrawn/wrong-but-well-formed
    // secret subscribes just the same). The copy must NOT unconditionally promise
    // the hive "will appear shortly"; it states the conditional + the dead-link case.
    const joinedText = screen.getByTestId('hive-invite-joined').textContent ?? '';
    expect(joinedText).toContain('appears in the Hives panel once its owner');
    expect(joinedText).toContain('appear if the invite was withdrawn or the link is wrong');
    expect(joinedText).not.toContain('shortly');
    const call = mockFetch.mock.calls.find((c) => String(c[0]).includes('/api/discovery/join-invite'));
    expect(JSON.parse((call?.[1] as RequestInit).body as string)).toEqual({ link: INVITE_LINK });

    // Joining creates no harness — Done just closes the picker. The close is a
    // single atomic nav write that clears ?create AND ?picker (the step was
    // 'hive-invite'); assert the step was cleared (the close fired).
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      const last = urlUpdates.at(-1);
      expect(last && last.get('picker')).toBeFalsy();
    });
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
  it('with a hive scope, offers Add-to-<hive> + New-<hive> and defaults into-hive', () => {
    renderPicker({ hiveScope: 'acme', hiveLabel: 'Hive' });
    const addBtn = screen.getByRole('tab', { name: 'Add to acme' });
    // The non-into-hive option is "New <hive>" — a new top-level hive. There is
    // no separate "from blueprint" tab anymore (it folded into New local directory).
    screen.getByRole('tab', { name: /New hive/i });
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(addBtn.getAttribute('aria-selected')).toBe('true');
  });

  it('without a hive scope, there is no creation-fork toggle at all', () => {
    renderPicker({ hiveScope: null });
    // No scope ⇒ the fork is hidden entirely; the default is a new top-level hive.
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
  });
});

describe('P-011 — add into hive stamps the membership', () => {
  it('a scoped existing-repo submit posts a MEMBER to /api/harness/projects with the hive + reports the membership', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    mockCreateOk({ slug: 'web', path: '/tmp/web' }, { membership: { hive: 'acme', edge: 'hive_slug' } });
    renderPicker({ onCreated, hiveScope: 'acme' });
    // Default mode is into-hive; go straight to the existing-local form.
    await user.click(screen.getByText('Existing local repo'));
    await user.type(screen.getByPlaceholderText('my-project'), 'web');
    await user.type(screen.getByPlaceholderText('/home/user/projects/my-project'), '/tmp/web');
    // Scoped ⇒ "Add to <hive>" path: a MEMBER linked in place, not a new hive.
    await user.click(screen.getByRole('button', { name: 'Add Hive' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('web', { hive: 'acme' }));
    expect(mockFetch).toHaveBeenCalledWith('/api/harness/projects', expect.objectContaining({ method: 'POST' }));
    expect(lastCreateBody()).toMatchObject({ slug: 'web', path: '/tmp/web', hive: 'acme' });
  });

  it('a scoped "New local directory" posts a MEMBER to /api/harness/projects with the hive', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    mockCreateOk({ slug: 'web', path: '/tmp/web' });
    renderPicker({ onCreated, hiveScope: 'acme' });
    // Default into-hive: a new local dir here becomes a member of acme, NOT a hive.
    await user.click(screen.getByText('New local directory'));
    await user.type(screen.getByPlaceholderText('my-project'), 'web');
    await user.type(screen.getByPlaceholderText('/home/user/projects'), '/tmp');
    await user.click(screen.getByRole('button', { name: 'Add Hive' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('web', { hive: 'acme' }));
    expect(mockFetch).toHaveBeenCalledWith('/api/harness/projects', expect.objectContaining({ method: 'POST' }));
    expect(lastCreateBody()).toMatchObject({ slug: 'web', hive: 'acme' });
  });

  it('switching to New-<hive> creates a new top-level hive (single-arg onCreated, posts /api/harness/pots)', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    mockCreateOk({ slug: 'solo', path: '/tmp/solo' });
    renderPicker({ onCreated, hiveScope: 'acme' });
    await user.click(screen.getByRole('tab', { name: /New hive/i }));
    await user.click(screen.getByText('New local directory'));
    await user.type(screen.getByPlaceholderText('my-project'), 'solo');
    await user.type(screen.getByPlaceholderText('/home/user/projects'), '/tmp');
    await user.click(screen.getByRole('button', { name: 'Create Hive' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('solo'));
    expect(mockFetch).toHaveBeenCalledWith('/api/harness/pots', expect.objectContaining({ method: 'POST' }));
    expect(lastCreateBody().hive).toBeUndefined();
  });
});
