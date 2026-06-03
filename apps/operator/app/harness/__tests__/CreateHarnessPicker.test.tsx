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

function renderPicker(props?: { onCreated?: (slug: string) => void }) {
  const onOpenChange = vi.fn();
  const result = render(
    <CreateHarnessPicker open onOpenChange={onOpenChange} onCreated={props?.onCreated} />,
  );
  return { ...result, onOpenChange };
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
