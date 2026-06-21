// @vitest-environment jsdom
/**
 * StepBackups.test.tsx — render-tier coverage for the SetupWizard "Backups"
 * step. Drives the /api/backups GET (loading → settings/kopia) and the PUT
 * toggle by stubbing fetch with a per-URL router. RouteLink is stubbed to a
 * plain anchor so the bprogress router-compat chain stays out of jsdom.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../RouteLink', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));

import { StepBackups } from './StepBackups';

/* A per-URL fetch router. `backups` is the body returned by GET /api/backups;
 * mutate it per test before render. PUT records the last body + replies ok. */
let backupsBody: unknown;
let putBodies: unknown[];
function installFetch() {
  putBodies = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      putBodies.push(JSON.parse(String(init.body)));
      return new Response('{"ok":true}', { status: 200 });
    }
    return new Response(JSON.stringify(backupsBody), { status: 200 });
  });
  vi.stubGlobal('fetch', fn as unknown as typeof fetch);
  return fn;
}

function settings(over: Record<string, unknown> = {}) {
  return {
    enabled: true,
    cadenceMode: 'both',
    cadenceMinutes: 30,
    retentionPreset: 'default',
    retentionCustom: null,
    eventTriggers: [],
    excludedPaths: [],
    ...over,
  };
}

beforeEach(() => {
  backupsBody = { workspaceId: 'w', settings: settings(), kopia: { ok: true, version: '0.1' } };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('StepBackups (SetupWizard backups step)', () => {
  it('renders the lead copy and bullet list', async () => {
    installFetch();
    render(<StepBackups />);
    expect(screen.getByText(/Papercusp uses/i)).toBeTruthy();
    expect(screen.getByText(/Restore from any snapshot/i)).toBeTruthy();
  });

  it('shows the loading state before the fetch resolves', () => {
    installFetch();
    render(<StepBackups />);
    expect(screen.getByText(/Loading current setting/i)).toBeTruthy();
  });

  it('renders the enabled toggle once settings load (checked, label "Backups enabled")', async () => {
    installFetch();
    render(<StepBackups />);
    const cb = await screen.findByRole('checkbox');
    expect(cb.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('Backups enabled')).toBeTruthy();
  });

  it('renders the disabled label when settings.enabled is false', async () => {
    backupsBody = { workspaceId: 'w', settings: settings({ enabled: false }), kopia: { ok: true } };
    installFetch();
    render(<StepBackups />);
    const cb = await screen.findByRole('checkbox');
    expect(cb.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('Backups disabled')).toBeTruthy();
  });

  it('toggling the checkbox PUTs the new enabled value', async () => {
    installFetch();
    render(<StepBackups />);
    const cb = await screen.findByRole('checkbox');
    fireEvent.click(cb); // currently enabled → toggles off
    await waitFor(() => expect(putBodies.length).toBe(1));
    expect((putBodies[0] as { enabled: boolean }).enabled).toBe(false);
    // After the PUT resolves the label flips to disabled.
    await waitFor(() => expect(screen.getByText('Backups disabled')).toBeTruthy());
  });

  it('shows the kopia-missing warning and disables the toggle when kopia is not ok', async () => {
    backupsBody = { workspaceId: 'w', settings: settings(), kopia: { ok: false, reason: 'kopia binary not found' } };
    installFetch();
    render(<StepBackups />);
    expect(await screen.findByText(/Kopia isn't installed in this runtime/i)).toBeTruthy();
    expect(screen.getByText(/kopia binary not found/i)).toBeTruthy();
    const cb = (await screen.findByRole('checkbox')) as HTMLButtonElement;
    expect(cb.disabled).toBe(true);
    expect(cb.getAttribute('aria-checked')).toBe('false'); // checked is forced off while kopia missing
    expect(screen.getByText(/Backups unavailable \(kopia not installed\)/i)).toBeTruthy();
  });

  it('surfaces a fetch error from a non-ok GET', async () => {
    putBodies = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch,
    );
    render(<StepBackups />);
    expect(await screen.findByText(/backups: 500/i)).toBeTruthy();
  });
});
