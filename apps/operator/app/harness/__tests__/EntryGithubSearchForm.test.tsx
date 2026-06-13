/**
 * @vitest-environment jsdom
 *
 * EntryGithubSearchForm — the comb-hive-native-sharing P-009 GitHub search
 * panel: debounced search-as-you-type over the P-008 proxy, keyboard-navigable
 * results, authed/rate-limit/empty states, the URL-paste short-circuit, and the
 * pick → create-from-repo handoff (EntryGithubUrlForm prefilled). @testing-
 * library/react + vitest only.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EntryGithubSearchForm } from '../EntryGithubSearchForm';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// useLexicon reads THE_HIVE via useFlag — mock it (default-on → the-hive pack)
// so jsdom never touches the real flag bootstrap (fetch + EventSource).
const flagValues = vi.hoisted(() => ({}) as Record<string, boolean>);
vi.mock('@/lib/flag-hooks', () => ({ useFlag: (key: string) => flagValues[key] ?? true }));

const mockFetch = vi.fn<typeof fetch>();
beforeEach(() => {
  mockFetch.mockReset();
  for (const k of Object.keys(flagValues)) delete flagValues[k];
  vi.stubGlobal('fetch', mockFetch);
});
afterEach(() => cleanup());

interface FakeRepo {
  repoId: number;
  fullName: string;
  description: string | null;
  stars: number;
  language: string | null;
  updatedAt: string | null;
  htmlUrl: string;
  private: boolean;
  fork: boolean;
  defaultBranch: string | null;
}

function repo(over: Partial<FakeRepo> & { repoId: number; fullName: string; htmlUrl: string }): FakeRepo {
  return {
    description: null,
    stars: 0,
    language: null,
    updatedAt: null,
    private: false,
    fork: false,
    defaultBranch: 'main',
    ...over,
  };
}

/** Route the search GET → a payload; everything else → {}. */
function mockSearch(payload: Record<string, unknown>, status = 200) {
  mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url.includes('/api/github/search-repos')) {
      return new Response(JSON.stringify(payload), { status });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  });
}

/** Route the search GET → items, and the P-011 batch lookup → bindings (P-010). */
function mockSearchAndBindings(items: unknown[], bindings: unknown[]) {
  mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url.includes('/api/github/search-repos')) {
      return new Response(JSON.stringify({ ok: true, authed: true, items }), { status: 200 });
    }
    if (url.includes('/api/cupboard/bindings')) {
      return new Response(JSON.stringify({ bindings }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  });
}

function renderSearch(props?: { hiveScope?: string | null; initialMode?: 'new-hive' | 'into-hive' | 'standalone' }) {
  const onBack = vi.fn();
  const onCreated = vi.fn();
  render(
    <EntryGithubSearchForm
      onBack={onBack}
      onCreated={onCreated}
      hiveScope={props?.hiveScope ?? null}
      initialMode={props?.initialMode ?? 'new-hive'}
    />,
  );
  return { onBack, onCreated };
}

const RESULTS = [
  repo({ repoId: 1, fullName: 'octocat/hello-world', htmlUrl: 'https://github.com/octocat/hello-world', description: 'My first repo', stars: 1234, language: 'TypeScript', updatedAt: new Date().toISOString() }),
  repo({ repoId: 2, fullName: 'acme/widgets', htmlUrl: 'https://github.com/acme/widgets', description: 'Widget factory', stars: 12, language: 'Go' }),
];

describe('EntryGithubSearchForm — P-009 search panel', () => {
  it('debounced query fires one search and renders results with stars + language', async () => {
    const user = userEvent.setup();
    mockSearch({ ok: true, authed: true, items: RESULTS });
    renderSearch();
    await user.type(screen.getByRole('searchbox'), 'hello');

    const rows = await screen.findAllByTestId('gh-search-result');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('octocat/hello-world');
    expect(rows[0].textContent).toContain('★ 1.2k');
    expect(rows[0].textContent).toContain('TypeScript');
    // The proxy GET was hit (once — debounced).
    const searchCalls = mockFetch.mock.calls.filter((c) => String(c[0]).includes('/api/github/search-repos'));
    expect(searchCalls.length).toBe(1);
    expect(String(searchCalls[0][0])).toContain('q=hello');
  });

  it('authed:false renders the anonymous sign-in nudge', async () => {
    const user = userEvent.setup();
    mockSearch({ ok: true, authed: false, items: RESULTS });
    renderSearch();
    await user.type(screen.getByRole('searchbox'), 'hello');
    const nudge = await screen.findByTestId('gh-search-signin-nudge');
    expect(nudge.textContent).toContain('anonymously');
  });

  it('a 429 surfaces the rate-limit message with the retry seconds (never silent empty)', async () => {
    const user = userEvent.setup();
    mockSearch({ error: 'github_rate_limited', retryAfterSec: 42, authed: true }, 429);
    renderSearch();
    await user.type(screen.getByRole('searchbox'), 'hello');
    const alert = await waitFor(() => screen.getByRole('alert'));
    expect(alert.textContent).toContain('rate-limited');
    expect(alert.textContent).toContain('42');
  });

  it('empty results show the no-match copy', async () => {
    const user = userEvent.setup();
    mockSearch({ ok: true, authed: true, items: [] });
    renderSearch();
    await user.type(screen.getByRole('searchbox'), 'zzzznotareporg');
    await waitFor(() => screen.getByText(/No repositories matched/));
  });

  it('pasting a repo URL short-circuits to the create form (no search fired), prefilled', async () => {
    const user = userEvent.setup();
    mockSearch({ ok: true, authed: true, items: RESULTS });
    renderSearch();
    await user.type(screen.getByRole('searchbox'), 'https://github.com/octocat/hello-world');
    await user.click(await screen.findByTestId('gh-search-url-continue'));

    // The create form (EntryGithubUrlForm) is now mounted, URL prefilled.
    screen.getByRole('heading', { name: 'GitHub URL' });
    const urlInput = screen.getByPlaceholderText('https://github.com/owner/repo') as HTMLInputElement;
    expect(urlInput.value).toBe('https://github.com/octocat/hello-world');
    // A URL query never hits the search proxy.
    expect(mockFetch.mock.calls.some((c) => String(c[0]).includes('/api/github/search-repos'))).toBe(false);
  });

  it('picking a result opens the create form prefilled with that repo', async () => {
    const user = userEvent.setup();
    mockSearch({ ok: true, authed: true, items: RESULTS });
    renderSearch();
    await user.type(screen.getByRole('searchbox'), 'hello');
    const rows = await screen.findAllByTestId('gh-search-result');
    await user.click(rows[0]);

    screen.getByRole('heading', { name: 'GitHub URL' });
    const urlInput = screen.getByPlaceholderText('https://github.com/owner/repo') as HTMLInputElement;
    expect(urlInput.value).toBe('https://github.com/octocat/hello-world');
  });

  it('keyboard ArrowDown + Enter picks the second result', async () => {
    const user = userEvent.setup();
    mockSearch({ ok: true, authed: true, items: RESULTS });
    renderSearch();
    await user.type(screen.getByRole('searchbox'), 'hello');
    await screen.findAllByTestId('gh-search-result');
    await user.keyboard('{ArrowDown}{Enter}');

    const urlInput = screen.getByPlaceholderText('https://github.com/owner/repo') as HTMLInputElement;
    expect(urlInput.value).toBe('https://github.com/acme/widgets');
  });

  it('into-hive mode threads through to the create form opened from a pick', async () => {
    const user = userEvent.setup();
    mockSearch({ ok: true, authed: true, items: RESULTS });
    renderSearch({ hiveScope: 'acme', initialMode: 'into-hive' });
    await user.type(screen.getByRole('searchbox'), 'hello');
    const rows = await screen.findAllByTestId('gh-search-result');
    await user.click(rows[0]);

    const addBtn = screen.getByRole('button', { name: 'Add to acme' });
    expect(addBtn.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('EntryGithubSearchForm — P-010 existing-hive badges', () => {
  it('badges a result whose repo already has a Hive (claimed)', async () => {
    const user = userEvent.setup();
    mockSearchAndBindings(RESULTS, [
      { repo_id: 1, hive_pubkey: 'K'.repeat(43) + '=', hive_title: 'Demo Hive', claim_status: 'claimed', listing_id: 'h1' },
    ]);
    renderSearch();
    await user.type(screen.getByRole('searchbox'), 'hello');
    const badge = await screen.findByTestId('gh-search-hive-badge');
    expect(badge.textContent).toContain('Hive exists: Demo Hive');
    expect(badge.textContent).toContain('claimed');
    // Only the bound repo (id 1) is badged — the other result has no binding.
    expect(screen.getAllByTestId('gh-search-hive-badge')).toHaveLength(1);
  });

  it('shows "unclaimed" when the existing Hive listing is unclaimed', async () => {
    const user = userEvent.setup();
    mockSearchAndBindings(RESULTS, [
      { repo_id: 1, hive_pubkey: 'K'.repeat(43) + '=', hive_title: 'Demo Hive', claim_status: 'unclaimed', listing_id: 'h1' },
    ]);
    renderSearch();
    await user.type(screen.getByRole('searchbox'), 'hello');
    const badge = await screen.findByTestId('gh-search-hive-badge');
    expect(badge.textContent).toContain('unclaimed');
  });

  it('a binding without a hive_pubkey (legacy shared harness) is not badged', async () => {
    const user = userEvent.setup();
    mockSearchAndBindings(RESULTS, [
      { repo_id: 1, hive_pubkey: null, hive_title: null, claim_status: 'unclaimed', listing_id: 'h1' },
    ]);
    renderSearch();
    await user.type(screen.getByRole('searchbox'), 'hello');
    await screen.findAllByTestId('gh-search-result');
    // Give the (resolved) bindings fetch a tick — still no badge.
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('gh-search-hive-badge')).toBeNull();
  });

  it('degrades to no badges when the batch lookup is empty/unavailable', async () => {
    const user = userEvent.setup();
    mockSearch({ ok: true, authed: true, items: RESULTS }); // /api/cupboard/bindings → {}
    renderSearch();
    await user.type(screen.getByRole('searchbox'), 'hello');
    await screen.findAllByTestId('gh-search-result');
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('gh-search-hive-badge')).toBeNull();
  });
});
