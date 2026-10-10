import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { ExternalTriggerSourceRow } from '../../external-triggers/source-store';
import { syncGoogleContacts } from '../../personal-vault/live-sink';
import { getSystemAction, type SystemActionCtx } from './system-actions';
import {
  runConnectorSyncAction,
  runGoogleContactsPersonalVaultPoll,
  type GoogleContactsPersonalVaultPollDeps,
} from './connector-sync-action';

const ctx: SystemActionCtx = {
  workspaceId: 'papercusp-workspace',
  installSlug: 'papercusp',
  triggerConfig: {},
  payloadTemplate: null,
};

function source(id: string, config: Record<string, unknown> = {}): ExternalTriggerSourceRow {
  return {
    id,
    workspaceId: ctx.workspaceId,
    kind: 'contacts',
    ownerUserId: '22222222-2222-4222-8222-222222222222',
    providerAccountId: `${id}@example.com`,
    credentialRef: `google-workspace:${id}`,
    status: 'connected',
    config,
    cursor: {},
  };
}

describe('connector-sync Google Contacts Personal Vault path', () => {
  it('polls connected sources with their token-store install and retries a People API 401', async () => {
    const current = source('contacts-one', { installSlug: 'google-install' });
    const sql = {} as Sql;
    const listSources = vi.fn(async () => [current]);
    const syncContacts = vi.fn(async (_sql: Sql, input: Parameters<typeof syncGoogleContacts>[1]) => {
      if (input.accessToken === 'expired-token') throw new Error('google_people_401');
      return { contacts: 2, pages: 2, nextPageToken: null };
    });
    const withAccessTokenRetry: NonNullable<GoogleContactsPersonalVaultPollDeps['withAccessTokenRetry']> =
      async (_source, _installSlug, call) => {
        const first = await call('expired-token');
        if (first.status === 401) return (await call('fresh-token')).result;
        return first.result;
      };
    const updateSource = vi.fn(async () => current);
    const deps: GoogleContactsPersonalVaultPollDeps = {
      listSources,
      syncContacts,
      withAccessTokenRetry: vi.fn(withAccessTokenRetry),
      updateSource,
    };

    const result = await runGoogleContactsPersonalVaultPoll(ctx, sql, deps);

    expect(result).toEqual({ sources: 1, succeeded: 1, failed: 0, contacts: 2, pages: 2, failures: [] });
    expect(listSources).toHaveBeenCalledWith(sql, ctx.workspaceId, 'contacts');
    expect(deps.withAccessTokenRetry).toHaveBeenCalledWith(current, 'google-install', expect.any(Function));
    expect(syncContacts).toHaveBeenNthCalledWith(1, sql, {
      workspaceId: ctx.workspaceId,
      userId: current.ownerUserId,
      sourceId: current.id,
      providerAccountId: current.providerAccountId,
      accessToken: 'expired-token',
    });
    expect(syncContacts).toHaveBeenNthCalledWith(2, sql, expect.objectContaining({ accessToken: 'fresh-token' }));
    expect(updateSource).toHaveBeenCalledWith(sql, ctx.workspaceId, current.id, {
      status: 'connected',
      lastError: null,
      connected: true,
    });
  });

  it('keeps transient provider failures degraded and terminal refreshed 401s reconnect-required', async () => {
    const providerFailure = source('contacts-provider');
    const authFailure = source('contacts-auth');
    const sql = {} as Sql;
    const updateSource = vi.fn(async () => providerFailure);
    const deps: GoogleContactsPersonalVaultPollDeps = {
      listSources: vi.fn(async () => [providerFailure, authFailure]),
      withAccessTokenRetry: async (current, _installSlug, call) => {
        if (current.id === authFailure.id) throw new Error('oauth: contacts still 401 after refresh; reconnect required');
        const response = await call('token');
        return response.result;
      },
      syncContacts: vi.fn(async () => {
        throw new Error('google_people_503');
      }),
      updateSource,
    };

    const result = await runGoogleContactsPersonalVaultPoll(ctx, sql, deps);

    expect(result).toMatchObject({ sources: 2, succeeded: 0, failed: 2, contacts: 0, pages: 0 });
    expect(result.failures).toEqual([
      { sourceId: providerFailure.id, status: 'degraded', error: 'google_people_503' },
      {
        sourceId: authFailure.id,
        status: 'error',
        error: 'oauth: contacts still 401 after refresh; reconnect required',
      },
    ]);
    expect(updateSource).toHaveBeenNthCalledWith(1, sql, ctx.workspaceId, providerFailure.id, {
      status: 'degraded',
      lastError: 'google_people_503',
    });
    expect(updateSource).toHaveBeenNthCalledWith(2, sql, ctx.workspaceId, authFailure.id, {
      status: 'error',
      lastError: 'oauth: contacts still 401 after refresh; reconnect required',
    });
  });

  it('runs the Contacts poller from the existing connector-sync action', async () => {
    const sql = {} as Sql;
    const runGoogleContacts = vi.fn(async (): Promise<Awaited<ReturnType<typeof runGoogleContactsPersonalVaultPoll>>> => ({
      sources: 1,
      succeeded: 1,
      failed: 0,
      contacts: 2,
      pages: 1,
      failures: [],
    }));

    const result = await runConnectorSyncAction(ctx, {
      sql,
      reconcilePush: vi.fn(async () => ({ sources: [] }) as never),
      runConnectorWakes: vi.fn(async () => ({ sources: [] }) as never),
      runConnectorSync: vi.fn(async () => ({ providers: [], sources: [] }) as never),
      runParticipantBackfills: vi.fn(async () => []),
      runGoogleContacts,
    });

    expect(getSystemAction('connector-sync')).toBeTypeOf('function');
    expect(runGoogleContacts).toHaveBeenCalledWith(ctx, sql);
    expect(result.diagnostics).toMatchObject({ contactsSources: 1, contactsSynced: 2, contactsPages: 1, contactsFailed: 0 });
  });
});
