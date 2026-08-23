// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PersonalVaultSettingsPage from './page';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

const status = {
  ok: true,
  enabled: true,
  workspaceId: 'papercusp-workspace',
  user: { id: 'user-1', displayName: 'Owner' },
  stats: {
    sources: [{ source: 'gmail', documents: 12, newest_at: '2026-08-20T12:00:00Z' }],
    unembedded: 2,
  },
  grants: [],
  supportedSources: ['gmail', 'calendar', 'contacts', 'facebook', 'instagram', 'x'],
  embedding: { mode: 'gemma', localOnly: true },
};

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/user/personal-vault' && (!init?.method || init.method === 'GET')) {
      return Response.json(status);
    }
    if (url === '/api/user/personal-vault' && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as { enabled: boolean };
      return Response.json({ ok: true, enabled: body.enabled });
    }
    if (url === '/api/user/personal-vault/grants/preview') {
      return Response.json({
        ok: true,
        planSlug: 'meeting-prep-brief',
        harnessSlug: 'papercusp',
        principalType: 'plan-template',
        principalId: 'meeting-prep-brief',
        declaredScopes: ['personal:gmail', 'personal:calendar'],
      });
    }
    throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => cleanup());

describe('PersonalVaultSettingsPage', () => {
  it('renders the local-only posture and imported source status', async () => {
    render(<PersonalVaultSettingsPage />);
    expect(await screen.findByRole('heading', { name: 'Personal Vault' })).toBeTruthy();
    expect(screen.getByText(/vectors are produced only by the local EmbeddingGemma model/i)).toBeTruthy();
    expect(screen.getAllByText('personal:gmail').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('12')).toBeTruthy();
  });

  it('uses the owner kill-switch endpoint without deleting data', async () => {
    render(<PersonalVaultSettingsPage />);
    const toggle = await screen.findByRole('checkbox', { name: /Enable Personal Vault imports/i });
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/user/personal-vault',
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ enabled: false }) }),
      );
    });
    expect(screen.getByText(/It does not delete anything/i)).toBeTruthy();
  });

  it('explains how to acquire supported provider archives with official links and formats', async () => {
    render(<PersonalVaultSettingsPage />);
    const instructions = (await screen.findByRole('heading', { name: 'How to get an archive' })).parentElement;
    expect(instructions?.textContent).toContain('choose only Mail, Calendar, and Contacts');
    expect(instructions?.textContent).toContain('Choose Messages, all time, and JSON');
    expect(instructions?.textContent).toContain('Settings and privacy → Your account');

    const links = screen.getAllByRole('link');
    expect(links.find((link) => link.textContent === 'Google Takeout')?.getAttribute('href'))
      .toBe('https://takeout.google.com/settings/takeout');
    expect(links.find((link) => link.textContent === 'Export your information guide')?.getAttribute('href'))
      .toBe('https://www.facebook.com/help/212802592074644');
    expect(links.find((link) => link.textContent === 'official X archive guide')?.getAttribute('href'))
      .toBe('https://help.x.com/en/managing-your-account/accessing-your-x-data');
    expect(links.every((link) => link.getAttribute('target') === '_blank')).toBe(true);
    expect(links.every((link) => link.getAttribute('rel')?.includes('noopener'))).toBe(true);
  });

  it('previews the plan declaration before the owner can approve it', async () => {
    render(<PersonalVaultSettingsPage />);
    fireEvent.change(await screen.findByLabelText('Plan slug'), { target: { value: 'meeting-prep-brief' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review access' }));
    expect(await screen.findByRole('heading', { name: 'Approve access for meeting-prep-brief' })).toBeTruthy();
    expect(screen.getAllByText('personal:gmail').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('personal:calendar')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Approve declared scopes' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
