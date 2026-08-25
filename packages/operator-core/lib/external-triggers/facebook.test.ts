import { describe, expect, it, vi } from 'vitest';
import {
  facebookPersonalVaultOAuthField,
  normalizeFacebookPhoto,
  normalizeFacebookPost,
  normalizeFacebookProfile,
  syncFacebookPersonalVaultSource,
} from './facebook';
import type { ExternalTriggerSourceRow } from './source-store';

const NOW = new Date('2026-08-23T04:00:00.000Z');

function source(cursor: Record<string, unknown> = {}): ExternalTriggerSourceRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    workspaceId: 'papercusp-workspace',
    kind: 'facebook',
    ownerUserId: '22222222-2222-4222-8222-222222222222',
    credentialRef: 'facebook-personal-vault:owner',
    providerAccountId: 'facebook-user-1',
    status: 'connected',
    config: {},
    cursor,
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function deps(fetchImpl: typeof fetch) {
  const ingested: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  return {
    ingested,
    updates,
    value: {
      fetch: fetchImpl,
      now: () => NOW,
      apiOrigin: 'https://graph.test',
      createPersonalSink: vi.fn(async () => ({
        kind: 'personal-vault' as const,
        ref: 'user:owner',
        deliver: async () => undefined,
      })),
      ingest: vi.fn(async (_sql, input) => {
        ingested.push(input as unknown as Record<string, unknown>);
        return { ok: true, event: {} as never, deliveries: [] };
      }),
      updateSource: vi.fn(async (_sql, _workspaceId, _sourceId, input) => {
        updates.push(input as unknown as Record<string, unknown>);
        return source((input.cursor as Record<string, unknown> | undefined) ?? {});
      }),
    },
  };
}

describe('Facebook Personal Vault adapter', () => {
  it('accepts only the fixed opaque plugin reference', () => {
    expect(facebookPersonalVaultOAuthField('facebook-personal-vault:owner-1')).toBe('owner-1');
    expect(() => facebookPersonalVaultOAuthField('other-plugin:owner')).toThrow(
      'facebook_personal_vault_credential_ref_invalid',
    );
    expect(() => facebookPersonalVaultOAuthField('facebook-personal-vault:../owner')).toThrow(
      'facebook_personal_vault_credential_ref_invalid',
    );
  });

  it('walks cursor pages, uses the prior since watermark, and advances only after every delivery succeeds', async () => {
    const urls: URL[] = [];
    const fetchImpl = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const url = new URL(request instanceof Request ? request.url : request.toString());
      urls.push(url);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer server-side-token');
      if (url.pathname === '/me') {
        return json({ id: 'owner-1', name: 'Owner', about: 'Builder' });
      }
      if (url.pathname === '/me/feed' && !url.searchParams.has('after')) {
        return json({
          data: [{
            id: 'post-1',
            message: 'First post',
            created_time: '2026-08-23T02:00:00.000Z',
            updated_time: '2026-08-23T02:05:00.000Z',
            from: { name: 'Owner' },
          }],
          paging: { cursors: { after: 'feed-page-2' }, next: 'https://graph.test/me/feed?after=feed-page-2&access_token=redacted' },
        });
      }
      if (url.pathname === '/me/feed') {
        return json({ data: [{ id: 'post-2', story: 'Shared a link', created_time: '2026-08-23T03:00:00.000Z' }] });
      }
      return json({ data: [{
        id: 'photo-1',
        name: 'Launch photo',
        created_time: '2026-08-23T03:30:00.000Z',
        picture: 'https://images.test/photo-1.jpg',
      }] });
    }) as unknown as typeof fetch;
    const d = deps(fetchImpl);
    const result = await syncFacebookPersonalVaultSource(
      {} as never,
      source({ since: '2026-08-23T01:00:00.000Z', keep: 'yes' }),
      'server-side-token',
      d.value,
    );

    expect(result).toEqual({
      profile: 1,
      posts: 2,
      photos: 1,
      feedPages: 2,
      photoPages: 1,
      since: NOW.toISOString(),
    });
    expect(urls.map((url) => url.pathname)).toEqual(['/me', '/me/feed', '/me/feed', '/me/photos']);
    for (const url of urls.slice(1)) {
      expect(url.searchParams.get('since')).toBe(String(Date.parse('2026-08-23T01:00:00.000Z') / 1000));
      expect(url.searchParams.has('access_token')).toBe(false);
    }
    expect(urls[2].searchParams.get('after')).toBe('feed-page-2');
    expect(d.ingested.map((input) => input.event)).toEqual([
      'profile.synced',
      'post.synced',
      'post.synced',
      'photo.synced',
    ]);
    expect(d.ingested.map((input) => input.dedupeKey)).toEqual([
      expect.stringMatching(/^facebook:profile:owner-1:/),
      'facebook:post:post-1:2026-08-23T02:05:00.000Z',
      'facebook:post:post-2:2026-08-23T03:00:00.000Z',
      'facebook:photo:photo-1:2026-08-23T03:30:00.000Z',
    ]);
    expect(d.updates).toEqual([expect.objectContaining({
      status: 'connected',
      connected: true,
      cursor: {
        since: NOW.toISOString(),
        lastSyncAt: NOW.toISOString(),
        profileId: 'owner-1',
        keep: 'yes',
      },
    })]);
    expect(JSON.stringify(d.updates)).not.toContain('server-side-token');
  });

  it('does not advance the source cursor when a later provider page fails', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return json({ id: 'owner-1', name: 'Owner' });
      if (calls === 2) {
        return json({ data: [{ id: 'post-1', message: 'Delivered once' }], paging: { cursors: { after: 'next' } } });
      }
      return json({ error: { message: 'temporary outage' } }, 503);
    }) as unknown as typeof fetch;
    const d = deps(fetchImpl);

    await expect(syncFacebookPersonalVaultSource(
      {} as never,
      source({ since: '2026-08-23T01:00:00.000Z' }),
      'token',
      d.value,
    )).rejects.toThrow('facebook_graph_feed_list_503');
    expect(d.updates).toEqual([]);
    expect(d.ingested.map((input) => input.event)).toEqual(['profile.synced', 'post.synced']);
  });

  it('normalizes only the supported profile, post, and photo metadata surface', () => {
    expect(normalizeFacebookProfile({ id: 'owner', name: 'Owner', about: 'About me' })).toEqual({
      id: 'owner', author: 'Owner', text: 'About me', entityType: 'profile',
    });
    expect(normalizeFacebookPost({
      id: 'post', message: 'Hello', from: { name: 'Owner' }, permalink_url: 'https://facebook.test/post',
    })).toEqual(expect.objectContaining({
      id: 'post', author: 'Owner', text: 'Hello', entityType: 'post',
    }));
    expect(normalizeFacebookPhoto({ id: 'photo', picture: 'https://images.test/photo.jpg' })).toEqual(
      expect.objectContaining({
        id: 'photo', text: '(Facebook photo)', entityType: 'photo',
        media: [{ url: 'https://images.test/photo.jpg' }],
      }),
    );
  });
});
