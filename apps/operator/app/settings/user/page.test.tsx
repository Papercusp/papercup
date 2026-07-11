// @vitest-environment jsdom
/**
 * User-settings page — render-tier coverage for the override surface migrated
 * onto the shared <OverridableSetting> primitive (sentinel-herald P-035).
 *
 * The page's three fetches (auth/me, user/preferences, workspace voice-prefs)
 * are stubbed so we control which keys are overridden. We assert the migrated
 * chrome: an overridden row shows the shared "override" badge + a "Clear" reset
 * button (wired to the DELETE), a non-overridden row shows the "default" badge
 * and NO reset, and the workspace-value hint still renders for overrides.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within, fireEvent } from '@testing-library/react';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// RouteLink pulls next router context; stub to a plain anchor.
vi.mock('@/app/_components/RouteLink', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
const { syncPrefs } = vi.hoisted(() => ({
  syncPrefs: { user: {} as Record<string, unknown>, workspace: {} as Record<string, unknown> },
}));
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: ({ queryName }: { queryName: string }) => ({
    data: queryName === 'userPreferences.current' ? [{ payload: syncPrefs.user }] : [syncPrefs.workspace],
    loading: false,
    fetching: false,
    error: null,
    invalidate: vi.fn(),
  }),
}));

import UserSettingsPage from './page';

const ME = { user: { id: 'u1', username: 'ada', display_name: 'Ada', has_password: true } };

/** workspace defaults + the user override map drive the override surface. */
function stubFetches(opts: { workspace: Record<string, unknown>; user: Record<string, unknown> }) {
  syncPrefs.workspace = opts.workspace;
  syncPrefs.user = opts.user;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.includes('/api/auth/me')) return new Response(JSON.stringify(ME), { status: 200 });
      if (u.includes('/api/user/preferences') && method === 'GET')
        return new Response(JSON.stringify({ payload: opts.user }), { status: 200 });
      if (u.includes('/api/user/preferences')) return new Response('{}', { status: 200 }); // PATCH/DELETE
      if (u.includes('operator-voice-prefs')) return new Response(JSON.stringify(opts.workspace), { status: 200 });
      return new Response('{}', { status: 200 });
    }),
  );
}

beforeEach(() => {
  stubFetches({
    // porcupineKeyword is overridden by the user; voiceMaxSpokenWords is not.
    // (This was `wakeWordKeyword` until settings-audit 2026-07-09 — a phantom key
    // that exists in no VoicePrefs schema, which this test had enshrined as its
    // canonical example of an overridden key.)
    workspace: { porcupineKeyword: 'Jarvis', voiceMaxSpokenWords: 60 },
    user: { porcupineKeyword: 'Computer' },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('UserSettingsPage override surface (shared OverridableSetting)', () => {
  it('an overridden row shows the override badge, the workspace hint, and a Clear reset', async () => {
    render(<UserSettingsPage />);
    await waitFor(() => expect(screen.getByText('Wake word (Porcupine)')).toBeTruthy());

    // The shared primitive renders the label inside .pc-override; find that row.
    const label = screen.getByText('Wake word (Porcupine)');
    const row = label.closest('.pc-override') as HTMLElement;
    expect(row).toBeTruthy();
    // Overridden → "override" badge (not "default") and a Clear reset button.
    expect(within(row).getByText('override')).toBeTruthy();
    const clear = within(row).getByRole('button', { name: /Reset Wake word \(Porcupine\) to default/i });
    expect(clear.textContent).toContain('Clear');
    // The workspace-value hint persists next to the row.
    expect(screen.getByText(/workspace:/)).toBeTruthy();
  });

  it('a non-overridden row shows the default badge and no reset', async () => {
    render(<UserSettingsPage />);
    await waitFor(() => expect(screen.getByText('Max spoken words per reply')).toBeTruthy());
    const row = screen.getByText('Max spoken words per reply').closest('.pc-override') as HTMLElement;
    expect(within(row).getByText('default')).toBeTruthy();
    expect(within(row).queryByRole('button', { name: /to default/i })).toBeNull();
  });

  it('clicking Clear fires the DELETE for that override key', async () => {
    render(<UserSettingsPage />);
    await waitFor(() => expect(screen.getByText('Wake word (Porcupine)')).toBeTruthy());
    const row = screen.getByText('Wake word (Porcupine)').closest('.pc-override') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: /Reset Wake word \(Porcupine\) to default/i }));
    await waitFor(() =>
      expect(
        (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some(
          ([u, init]) =>
            String(u).includes('/api/user/preferences') &&
            String(u).includes('porcupineKeyword') &&
            (init as RequestInit | undefined)?.method === 'DELETE',
        ),
      ).toBe(true),
    );
  });
});

describe('UserSettingsPage auto-login fallback (owner report 2026-06-23)', () => {
  it('renders the settings (NOT "Not signed in") when /api/auth/me has no user', async () => {
    // Under single-user auto-login the route returns { autoLogin: true, user: null }
    // (no cookie session). The page must fall back to the default identity and
    // render normally — matching UserPicker — instead of the old "Not signed in".
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes('/api/auth/me'))
          return new Response(JSON.stringify({ autoLogin: true, user: null }), { status: 200 });
        if (u.includes('/api/user/preferences'))
          return new Response(JSON.stringify({ payload: {} }), { status: 200 });
        if (u.includes('operator-voice-prefs')) return new Response(JSON.stringify({}), { status: 200 });
        return new Response('{}', { status: 200 });
      }),
    );
    render(<UserSettingsPage />);
    await waitFor(() => expect(screen.getByText('User preferences')).toBeTruthy());
    expect(screen.queryByText(/Not signed in/i)).toBeNull();
    // Falls back to the default display name ("User").
    expect(screen.getByText(/just for User/)).toBeTruthy();
  });
});
