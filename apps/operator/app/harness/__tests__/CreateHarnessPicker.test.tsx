/**
 * @vitest-environment jsdom
 *
 * CreateHarnessPicker — P-012a/b/c/d/e unit tests.
 * Uses @testing-library/react + vitest only (no jest-dom matchers).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

const mockFetch = vi.fn<typeof fetch>();
beforeEach(() => {
  mockFetch.mockReset();
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

// ── P-012a — picker renders 4 entry cards ─────────────────────────────────

describe('P-012a — picker step', () => {
  it('renders 4 entry buttons', () => {
    renderPicker();
    // getByText throws if not found — asserts presence without jest-dom
    screen.getByText('New local directory');
    screen.getByText('Existing local repo');
    screen.getByText('GitHub URL');
    screen.getByText('Harness link');
  });

  it('renders no Phase 1b badge in the picker (label removed)', () => {
    renderPicker();
    expect(screen.queryByText('Phase 1b')).toBeNull();
  });

  it('shows the add-a-harness heading', () => {
    renderPicker();
    screen.getByRole('heading', { name: 'Add a harness' });
  });

  it('groups entries under Local and Shared headings', () => {
    renderPicker();
    screen.getByRole('heading', { name: 'Local' });
    screen.getByRole('heading', { name: 'Shared' });
  });

  it('shows the Shared collaboration subheading', () => {
    renderPicker();
    screen.getByText('Work on these repositories collaboratively.');
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
    screen.getByRole('heading', { name: 'Add a harness' });
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
    await user.click(screen.getByRole('button', { name: 'Create harness' }));

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
    await user.click(screen.getByRole('button', { name: 'Add harness' }));

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
    await user.click(screen.getByRole('button', { name: 'Create harness' }));

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
    await user.click(screen.getByRole('button', { name: 'Add harness' }));

    const alert = await waitFor(() => screen.getByRole('alert'));
    expect(alert.textContent).toContain('That path is invalid');
  });
});

// ── P-012e — Coming-soon stubs ─────────────────────────────────────────────

describe('P-012e — Coming-soon stubs', () => {
  it('GitHub URL card shows coming-soon stub on click', async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(screen.getByText('GitHub URL'));
    screen.getByText('Coming soon');
  });

  it('Harness link card opens the EntryHarnessLinkForm (no longer a stub)', async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(screen.getByText('Harness link'));
    // EntryHarnessLinkForm renders an input for the harness link.
    expect(screen.queryByText('Coming soon')).toBeNull();
  });

  it('coming-soon stub has a back button that returns to picker', async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(screen.getByText('GitHub URL'));
    await user.click(screen.getByText('← Back'));
    screen.getByRole('heading', { name: 'Add a harness' });
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
    await user.click(screen.getByRole('button', { name: 'Add harness' }));

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
    await user.click(screen.getByRole('button', { name: 'Add harness' }));

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
