import { describe, expect, it, vi } from 'vitest';
import {
  runGoogleCalendarPoll,
} from './google-calendar-poll-action';
import { googleWorkspaceOAuthField } from '../../external-triggers/google-workspace';
import { getSystemAction } from './system-actions';
import type { ExternalTriggerSourceRow } from '../../external-triggers/source-store';

function source(id: string, credentialRef = 'google-workspace:owner'): ExternalTriggerSourceRow {
  return {
    id,
    workspaceId: 'papercusp-workspace',
    kind: 'gcal',
    ownerUserId: '22222222-2222-4222-8222-222222222222',
    credentialRef,
    status: 'connected',
    config: {},
    cursor: {},
  };
}

describe('google-calendar-poll system action', () => {
  it('accepts only the fixed Google Workspace OAuth plugin reference', () => {
    expect(googleWorkspaceOAuthField('google-workspace:owner-1')).toBe('owner-1');
    expect(() => googleWorkspaceOAuthField('other-plugin:owner')).toThrow(
      'google_workspace_credential_ref_invalid',
    );
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

    const result = await runGoogleCalendarPoll({
      workspaceId: 'papercusp-workspace',
      installSlug: 'papercusp',
      triggerConfig: { lead_minutes: 20 },
      payloadTemplate: null,
    }, {
      sql: {} as never,
      listSources: vi.fn(async () => sources),
      resolveAccessToken: vi.fn(async (current) => {
        if (current.id === 'source-auth') throw new Error('google_workspace_oauth_not_connected:owner');
        return 'token';
      }),
      syncSource,
      updateSource,
    });

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
    expect(syncSource).toHaveBeenCalledWith(
      expect.anything(),
      sources[0],
      'token',
      { leadMinutes: 20 },
    );
    expect(updateSource).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      'papercusp-workspace',
      'source-auth',
      { status: 'error', lastError: 'google_workspace_oauth_not_connected:owner' },
    );
    expect(updateSource).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'papercusp-workspace',
      'source-provider',
      { status: 'degraded', lastError: 'google_calendar_incremental_list_503' },
    );
  });

  it('registers the durable handler', () => {
    expect(getSystemAction('google-calendar-poll')).toBeTypeOf('function');
  });
});
