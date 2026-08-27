import { describe, expect, it, vi } from 'vitest';
import { runGoogleCalendarPoll } from './google-calendar-poll-action';
import { googleWorkspaceOAuthField } from '../../external-triggers/google-workspace';
import { getSystemAction } from './system-actions';
import type { ExternalTriggerSourceRow } from '../../external-triggers/source-store';

function source(
  id: string,
  credentialRef = 'google-workspace:owner',
  providerAccountId = 'owner@example.com',
): ExternalTriggerSourceRow {
  return {
    id,
    workspaceId: 'papercusp-workspace',
    kind: 'gcal',
    ownerUserId: '22222222-2222-4222-8222-222222222222',
    credentialRef,
    providerAccountId,
    status: 'connected',
    config: {},
    cursor: {},
  };
}

describe('google-calendar-poll system action', () => {
  it('accepts only the fixed Google Workspace OAuth plugin reference', () => {
    expect(googleWorkspaceOAuthField('google-workspace:owner-1')).toBe('owner-1');
    expect(() => googleWorkspaceOAuthField('other-plugin:owner')).toThrow('google_workspace_credential_ref_invalid');
    expect(() => googleWorkspaceOAuthField('google-workspace:../owner')).toThrow(
      'google_workspace_credential_ref_invalid',
    );
  });

  it('isolates source failures, retries provider faults as degraded, and aggregates successful deliveries', async () => {
    const sources = [source('source-good'), source('source-auth'), source('source-provider')];
    const updateSource = vi.fn(async () => source('updated'));
    const syncSource = vi.fn(async (_sql, current: ExternalTriggerSourceRow) => {
      if (current.id === 'source-provider') throw new Error('google_calendar_incremental_list_503');
      return {
        mode: 'incremental' as const,
        created: 2,
        updated: 3,
        upcoming: 4,
        changePages: 1,
        upcomingPages: 1,
        syncToken: 'next',
      };
    });

    const result = await runGoogleCalendarPoll(
      {
        workspaceId: 'papercusp-workspace',
        installSlug: 'papercusp',
        triggerConfig: { lead_minutes: 20 },
        payloadTemplate: null,
      },
      {
        sql: {} as never,
        listSources: vi.fn(async () => sources),
        resolveAccessToken: vi.fn(async (current) => {
          if (current.id === 'source-auth') throw new Error('google_workspace_oauth_not_connected:owner');
          return 'token';
        }),
        syncSource,
        updateSource,
      },
    );

    expect(result).toEqual({
      sources: 3,
      succeeded: 1,
      failed: 2,
      created: 2,
      updated: 3,
      upcoming: 4,
      failures: [
        {
          sourceId: 'source-auth',
          status: 'error',
          error: 'google_workspace_oauth_not_connected:owner',
        },
        {
          sourceId: 'source-provider',
          status: 'degraded',
          error: 'google_calendar_incremental_list_503',
        },
      ],
    });
    expect(syncSource).toHaveBeenCalledWith(expect.anything(), sources[0], 'token', { leadMinutes: 20 });
    expect(updateSource).toHaveBeenNthCalledWith(1, expect.anything(), 'papercusp-workspace', 'source-auth', {
      status: 'error',
      lastError: 'google_workspace_oauth_not_connected:owner',
    });
    expect(updateSource).toHaveBeenNthCalledWith(2, expect.anything(), 'papercusp-workspace', 'source-provider', {
      status: 'degraded',
      lastError: 'google_calendar_incremental_list_503',
    });
  });

  it('keeps a revoked account terminal across recurrences until only that account reconnects', async () => {
    const revokedId = 'calendar-revoked';
    const siblingId = 'calendar-sibling';
    const initial = [
      source(revokedId, 'google-workspace:revoked', 'revoked@example.com'),
      source(siblingId, 'google-workspace:sibling', 'sibling@example.com'),
    ];
    const state = new Map(initial.map((current) => [current.id, current]));
    const syncAttempts: Array<{ id: string; credentialRef: string | null; syncToken: unknown }> = [];
    let pass = 0;
    const updateSource = vi.fn(async (_sql, _workspaceId, sourceId: string, input) => {
      const current = state.get(sourceId)!;
      const updated: ExternalTriggerSourceRow = {
        ...current,
        status: input.status,
        cursor: input.cursor ?? current.cursor,
      };
      state.set(sourceId, updated);
      return updated;
    });
    const syncSource = vi.fn(async (_sql, current: ExternalTriggerSourceRow) => {
      syncAttempts.push({
        id: current.id,
        credentialRef: current.credentialRef,
        syncToken: current.cursor.syncToken,
      });
      if (pass === 0 && current.id === revokedId) {
        throw new Error('google_calendar_incremental_list_401:Invalid Credentials');
      }
      const syncToken = `next-${current.id}-pass-${pass}`;
      state.set(current.id, { ...current, cursor: { ...current.cursor, syncToken } });
      return {
        mode: 'incremental' as const,
        created: 1,
        updated: 0,
        upcoming: 0,
        changePages: 1,
        upcomingPages: 1,
        syncToken,
      };
    });
    const deps = {
      sql: {} as never,
      listSources: vi.fn(async () => [...state.values()].filter((current) => current.status !== 'error')),
      resolveAccessToken: vi.fn(async (current: ExternalTriggerSourceRow) => `token:${current.credentialRef}`),
      syncSource,
      updateSource,
    };
    const ctx = {
      workspaceId: 'papercusp-workspace',
      installSlug: 'papercusp',
      triggerConfig: {},
      payloadTemplate: null,
    };

    const failed = await runGoogleCalendarPoll(ctx, deps);
    expect(failed).toMatchObject({
      sources: 2,
      succeeded: 1,
      failed: 1,
      failures: [
        {
          sourceId: revokedId,
          status: 'error',
          error: 'google_calendar_incremental_list_401:Invalid Credentials',
        },
      ],
    });
    expect(state.get(revokedId)).toMatchObject({ status: 'error', cursor: {} });
    expect(state.get(siblingId)).toMatchObject({
      status: 'connected',
      cursor: { syncToken: `next-${siblingId}-pass-0` },
    });

    pass = 1;
    const stillDisconnected = await runGoogleCalendarPoll(ctx, deps);
    expect(stillDisconnected).toMatchObject({ sources: 1, succeeded: 1, failed: 0 });
    expect(syncAttempts.map(({ id }) => id)).toEqual([revokedId, siblingId, siblingId]);
    expect(updateSource).toHaveBeenCalledTimes(1);

    const beforeReconnect = state.get(revokedId)!;
    state.set(revokedId, {
      ...beforeReconnect,
      status: 'connected',
      credentialRef: 'google-workspace:reconnected-revoked',
    });
    pass = 2;
    const recovered = await runGoogleCalendarPoll(ctx, deps);

    expect(recovered).toMatchObject({ sources: 2, succeeded: 2, failed: 0 });
    expect(syncAttempts).toContainEqual({
      id: revokedId,
      credentialRef: 'google-workspace:reconnected-revoked',
      syncToken: undefined,
    });
    expect(state.get(revokedId)).toMatchObject({
      status: 'connected',
      credentialRef: 'google-workspace:reconnected-revoked',
      cursor: { syncToken: `next-${revokedId}-pass-2` },
    });
    expect(updateSource).toHaveBeenCalledTimes(1);
  });

  it('registers the durable handler', () => {
    expect(getSystemAction('google-calendar-poll')).toBeTypeOf('function');
  });
});
