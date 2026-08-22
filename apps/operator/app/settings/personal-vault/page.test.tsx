import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('PersonalVaultSettingsPage', () => {
  it('renders the local-only posture and imported source status', async () => {
    render(<PersonalVaultSettingsPage />);
    expect(await screen.findByRole('heading', { name: 'Personal Vault' })).toBeInTheDocument();
    expect(screen.getByText(/vectors are produced only by the local EmbeddingGemma model/i)).toBeInTheDocument();
    expect(screen.getByText('personal:gmail')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
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
    expect(screen.getByText(/It does not delete anything/i)).toBeInTheDocument();
  });

  it('previews the plan declaration before the owner can approve it', async () => {
    render(<PersonalVaultSettingsPage />);
    fireEvent.change(await screen.findByLabelText('Plan slug'), { target: { value: 'meeting-prep-brief' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review access' }));
    expect(await screen.findByRole('heading', { name: 'Approve access for meeting-prep-brief' })).toBeInTheDocument();
    expect(screen.getByText('personal:gmail')).toBeInTheDocument();
    expect(screen.getByText('personal:calendar')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve declared scopes' })).toBeEnabled();
  });
});
