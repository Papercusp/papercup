import { describe, expect, it, vi } from 'vitest';
import { GOOGLE_CONTACTS_CONNECTIONS_ENDPOINT } from '../oauth/providers';
import {
  GOOGLE_GMAIL_PROFILE_ENDPOINT,
  probeGoogleContactsAccess,
  resolveGoogleWorkspaceProviderAccount,
} from './google-workspace';

describe('Google Contacts scope probe', () => {
  it('uses the contacts-scoped connections resource, never the profile-only people/me resource', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));

    const result = await probeGoogleContactsAccess('  contacts-token  ', fetchMock as typeof fetch);
    const [request, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    const url = new URL(String(request));

    expect(result).toEqual({ status: 200, endpoint: url.toString() });
    expect(url.origin + url.pathname).toBe(GOOGLE_CONTACTS_CONNECTIONS_ENDPOINT);
    expect(url.pathname).not.toBe('/v1/people/me');
    expect(url.searchParams.get('personFields')).toBe('names,emailAddresses');
    expect(url.searchParams.get('pageSize')).toBe('1');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer contacts-token');
  });

  it('reports the upstream status so a rejected token is not reported as healthy', async () => {
    const fetchMock = vi.fn(async () => new Response('forbidden', { status: 403 }));

    await expect(probeGoogleContactsAccess('contacts-token', fetchMock as typeof fetch))
      .rejects.toThrow('google_contacts_403');
  });
});

describe('Google Workspace provider account identity', () => {
  it('resolves and normalizes the Gmail account behind the exchanged token', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ emailAddress: ' Owner.Second@Example.COM ', historyId: '123' }),
    );

    await expect(
      resolveGoogleWorkspaceProviderAccount('  workspace-token  ', fetchMock as typeof fetch),
    ).resolves.toEqual({
      providerAccountId: 'owner.second@example.com',
      displayName: 'owner.second@example.com',
    });
    expect(fetchMock).toHaveBeenCalledWith(GOOGLE_GMAIL_PROFILE_ENDPOINT, {
      headers: { Authorization: 'Bearer workspace-token' },
    });
  });

  it('fails closed when the token cannot identify a Gmail account', async () => {
    await expect(
      resolveGoogleWorkspaceProviderAccount(
        'workspace-token',
        vi.fn(async () => Response.json({}, { status: 200 })) as typeof fetch,
      ),
    ).rejects.toThrow('google_workspace_profile_email_required');
    await expect(
      resolveGoogleWorkspaceProviderAccount(
        'workspace-token',
        vi.fn(async () => new Response('forbidden', { status: 403 })) as typeof fetch,
      ),
    ).rejects.toThrow('google_workspace_profile_403');
  });
});
