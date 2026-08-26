import { describe, expect, it, vi } from 'vitest';
import type { ExternalTriggerSourceRow } from '../../external-triggers/source-store';
import { getSystemAction } from './system-actions';
import { runFacebookPersonalVaultPoll } from './facebook-personal-vault-poll-action';

function source(id: string, providerAccountId = 'facebook-user-1'): ExternalTriggerSourceRow {
  return {
    id,
    workspaceId: 'papercusp-workspace',
    kind: 'facebook',
    ownerUserId: '22222222-2222-4222-8222-222222222222',
    credentialRef: `facebook-personal-vault:${providerAccountId}`,
    providerAccountId,
    status: 'connected',
    config: {},
    cursor: {},
  };
}

describe('facebook-personal-vault-poll system action', () => {
  it('isolates sources and distinguishes terminal auth failures from retryable provider faults', async () => {
    const sources = [source('source-good'), source('source-auth'), source('source-provider')];
    const updateSource = vi.fn(async () => source('updated'));
    const syncSource = vi.fn(async (_sql, current: ExternalTriggerSourceRow) => {
      if (current.id === 'source-provider') throw new Error('facebook_graph_feed_list_503');
      return { profile: 1, posts: 2, photos: 3, feedPages: 1, photoPages: 1, since: 'now' };
    });

    const result = await runFacebookPersonalVaultPoll({
      workspaceId: 'papercusp-workspace',
      installSlug: 'papercusp',
      triggerConfig: {},
      payloadTemplate: null,
    }, {
      sql: {} as never,
      listSources: vi.fn(async () => sources),
      resolveAccessToken: vi.fn(async (current) => {
        if (current.id === 'source-auth') throw new Error('facebook_personal_vault_oauth_not_connected:owner');
        return 'token';
      }),
      syncSource,
      updateSource,
    });

    expect(result).toEqual({
      sources: 3,
      succeeded: 1,
      failed: 2,
      profiles: 1,
      posts: 2,
      photos: 3,
      failures: [
        { sourceId: 'source-auth', status: 'error', error: 'facebook_personal_vault_oauth_not_connected:owner' },
        { sourceId: 'source-provider', status: 'degraded', error: 'facebook_graph_feed_list_503' },
      ],
    });
    expect(updateSource).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      'papercusp-workspace',
      'source-auth',
      { status: 'error', lastError: 'facebook_personal_vault_oauth_not_connected:owner' },
    );
    expect(updateSource).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'papercusp-workspace',
      'source-provider',
      { status: 'degraded', lastError: 'facebook_graph_feed_list_503' },
    );
  });

  it('resolves and syncs each Facebook account through its own credential and cursor', async () => {
    const sources = [source('source-one', 'facebook-user-1'), source('source-two', 'facebook-user-2')];
    const resolveAccessToken = vi.fn(async (current: ExternalTriggerSourceRow) =>
      `token:${current.providerAccountId}`,
    );
    const syncSource = vi.fn(async () => ({
      profile: 1,
      posts: 1,
      photos: 1,
      feedPages: 1,
      photoPages: 1,
      since: 'now',
    }));

    await expect(
      runFacebookPersonalVaultPoll(
        {
          workspaceId: 'papercusp-workspace',
          installSlug: 'papercusp',
          triggerConfig: {},
          payloadTemplate: null,
        },
        {
          sql: {} as never,
          listSources: vi.fn(async () => sources),
          resolveAccessToken,
          syncSource,
        },
      ),
    ).resolves.toMatchObject({ sources: 2, succeeded: 2, failed: 0, profiles: 2, posts: 2, photos: 2 });
    expect(resolveAccessToken).toHaveBeenNthCalledWith(1, sources[0], 'papercusp');
    expect(resolveAccessToken).toHaveBeenNthCalledWith(2, sources[1], 'papercusp');
    expect(syncSource).toHaveBeenNthCalledWith(1, expect.anything(), sources[0], 'token:facebook-user-1');
    expect(syncSource).toHaveBeenNthCalledWith(2, expect.anything(), sources[1], 'token:facebook-user-2');
  });

  it('registers the durable handler', () => {
    expect(getSystemAction('facebook-personal-vault-poll')).toBeTypeOf('function');
  });
});
