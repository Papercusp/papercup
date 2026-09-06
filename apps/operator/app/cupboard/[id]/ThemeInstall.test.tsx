// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { HarnessListing } from '@papercusp/operator-core/lib/cupboard/types';
import type { CustomTheme } from '@/lib/theme';

const h = vi.hoisted(() => ({
  active: 'black',
  themes: [] as CustomTheme[],
  invalidate: vi.fn(),
  apply: vi.fn(),
  write: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@/lib/theme', () => ({
  CUSTOM_PREFIX: 'custom:',
  DEFAULT_THEME_ID: 'frost',
  useActiveTheme: () => h.active,
  useThemeCatalog: () => ({ themes: h.themes, error: null, invalidate: h.invalidate }),
  applyCustomThemes: (themes: CustomTheme[]) => h.apply(themes),
  writeActiveTheme: (id: string) => h.write(id),
}));
vi.mock('sonner', () => ({ toast: { success: h.success, error: h.error } }));
vi.mock('../../_components/RouteLink', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

import ThemeInstall, { findInstalledThemeForListing } from './ThemeInstall';

function listing(overrides: Partial<HarnessListing> = {}): HarnessListing {
  return {
    id: 'theme-listing-1' as unknown as number,
    slug: 'aurora',
    title: 'Aurora',
    description: 'A luminous palette',
    harness_link: '',
    listing_kind: 'theme',
    listing_ref: 'aurora',
    github_repository_id: 7,
    github_repo: 'acme/themes',
    github_url: 'https://github.com/acme/themes',
    github_repo_must_be_public: true,
    published_by_github_user_id: 10,
    provisional_owner_github_user_id: 10,
    claim_status: 'claimed',
    claimed_at: null,
    last_permission_verified_at: null,
    superseded_by_harness_id: null,
    contributor_count_estimate: 0,
    last_activity_at: null,
    language: null,
    tags: [],
    created_at: 0,
    updated_at: 0,
    release_version: '1.1.0',
    ...overrides,
  };
}

function installed(overrides: Partial<CustomTheme> = {}): CustomTheme {
  return {
    id: 'installed:abc',
    label: 'Aurora',
    tokens: { bg: '#101820', fg: '#f7f7f2', accent: '#ff8c42' },
    installed: true,
    packageRef: 'acme-themes-aurora-deadbeef',
    listingRef: 'aurora',
    version: '1.0.0',
    source: 'https://github.com/acme/themes',
    ...overrides,
  };
}

beforeEach(() => {
  h.active = 'black';
  h.themes = [];
  h.invalidate.mockClear();
  h.apply.mockClear();
  h.write.mockClear();
  h.success.mockClear();
  h.error.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('findInstalledThemeForListing', () => {
  it('matches source plus listing ref and keeps same-name publishers distinct', () => {
    const other = installed({ id: 'installed:other', source: 'https://github.com/other/themes' });
    const expected = installed();
    expect(findInstalledThemeForListing(listing(), [other, expected])).toBe(expected);
  });
});

describe('<ThemeInstall />', () => {
  it('installs without forcing selection and exposes the validated preview immediately', async () => {
    const response = installed({ ok: true } as Partial<CustomTheme>);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ...response,
      ok: true,
      operation: 'install',
      activeThemeId: 'custom:installed:abc',
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<ThemeInstall listing={listing()} />);
    fireEvent.click(screen.getByRole('button', { name: /install theme/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe('/api/cupboard/install-theme');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ listingId: 'theme-listing-1' });
    await screen.findByTestId('cupboard-theme-preview');
    expect(h.write).not.toHaveBeenCalled();
    expect(h.apply).toHaveBeenCalled();
    expect(h.invalidate).toHaveBeenCalled();
  });

  it('surfaces validation errors and remains uninstalled', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: 'theme failed semantic-token validation',
    }), { status: 422 })));

    render(<ThemeInstall listing={listing()} />);
    fireEvent.click(screen.getByRole('button', { name: /install theme/i }));

    await waitFor(() => expect(h.error).toHaveBeenCalled());
    expect(String(h.error.mock.calls[0][0])).toContain('semantic-token validation');
    expect(screen.getByTestId('cupboard-theme-install').getAttribute('data-installed')).toBe('false');
  });

  it('uses the canonical writer only when Use theme is clicked', () => {
    h.themes = [installed()];
    render(<ThemeInstall listing={listing()} />);

    fireEvent.click(screen.getByRole('button', { name: /use theme/i }));
    expect(h.write).toHaveBeenCalledWith('custom:installed:abc');
  });

  it('sends explicit update and leaves the active preference unchanged', async () => {
    h.themes = [installed()];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ...installed({ version: '1.1.0' }),
      ok: true,
      operation: 'update',
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<ThemeInstall listing={listing()} />);

    fireEvent.click(screen.getByRole('button', { name: /^update$/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      listingId: 'theme-listing-1',
      update: true,
    });
    expect(h.write).not.toHaveBeenCalled();
  });

  it('removing the active package falls back through writeActiveTheme', async () => {
    h.themes = [installed()];
    h.active = 'custom:installed:abc';
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<ThemeInstall listing={listing()} />);

    fireEvent.click(screen.getByRole('button', { name: /^remove$/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe('/api/themes/installed%3Aabc');
    expect(h.write).toHaveBeenCalledWith('frost');
    await waitFor(() => expect(screen.getByTestId('cupboard-theme-install').getAttribute('data-installed')).toBe('false'));
  });

  it('links installed package editing to a URL-backed independent copy', () => {
    h.themes = [installed()];
    render(<ThemeInstall listing={listing()} />);
    const link = screen.getByRole('link', { name: /edit as copy/i }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/settings/personalization?themeEdit=copy%3Acustom%3Ainstalled%3Aabc');
  });
});
