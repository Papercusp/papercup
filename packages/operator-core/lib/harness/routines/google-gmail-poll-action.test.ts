import { describe, expect, it, vi } from 'vitest';
import type { ExternalTriggerSourceRow } from '../../external-triggers/source-store';
import { GoogleGmailApiError } from '../../external-triggers/google-gmail';
import type { GooglePubSubReceivedMessage } from '../../external-triggers/google-pubsub';
import { getSystemAction } from './system-actions';
import { formatGoogleGmailPollLog, runGoogleGmailPoll } from './google-gmail-poll-action';

function source(id: string, emailAddress: string): ExternalTriggerSourceRow {
  return {
    id,
    workspaceId: 'papercusp-workspace',
    kind: 'gmail',
    ownerUserId: '22222222-2222-4222-8222-222222222222',
    credentialRef: `google-workspace:${id}`,
    providerAccountId: emailAddress,
    status: 'connected',
    config: {},
    cursor: { emailAddress, historyId: `history-${id}`, watchExpiration: '2026-08-28T00:00:00.000Z' },
  };
}

function doorbell(ackId: string, emailAddress: string): GooglePubSubReceivedMessage {
  return {
    ackId,
    message: {
      data: Buffer.from(JSON.stringify({ emailAddress, historyId: 'provider-hint' })).toString('base64'),
    },
  };
}

const CTX = {
  workspaceId: 'papercusp-workspace',
  installSlug: 'papercusp',
  triggerConfig: { max_messages: 25, renew_before_ms: 86_400_000 },
  payloadTemplate: null,
};

describe('google-gmail-poll system action', () => {
  it('full-backfills a cursorless mailbox before establishing its watch', async () => {
    const fresh: ExternalTriggerSourceRow = {
      ...source('source-new', 'new@example.com'),
      cursor: {},
    };
    let persisted = fresh;
    const order: string[] = [];
    const syncSource = vi.fn(async (_sql, current: ExternalTriggerSourceRow) => {
      order.push('sync');
      expect(current.cursor).not.toHaveProperty('historyId');
      persisted = {
        ...current,
        cursor: {
          emailAddress: 'new@example.com',
          historyId: 'history-after-full',
          lastSyncAt: '2026-08-27T12:00:00.000Z',
        },
      };
      return {
        mode: 'full' as const,
        messages: 7,
        historyPages: 0,
        messagePages: 1,
        historyId: 'history-after-full',
        backfill: null,
      };
    });
    const getSource = vi.fn(async () => {
      order.push('reload');
      return persisted;
    });
    const ensureWatch = vi.fn(async (_sql, current: ExternalTriggerSourceRow) => {
      order.push('watch');
      expect(current.cursor).toMatchObject({
        emailAddress: 'new@example.com',
        historyId: 'history-after-full',
        lastSyncAt: '2026-08-27T12:00:00.000Z',
      });
      return {
        renewed: true,
        emailAddress: 'new@example.com',
        historyId: 'history-after-full',
        expiration: '2026-09-03T12:00:00.000Z',
        source: {
          ...current,
          cursor: {
            ...current.cursor,
            watchExpiration: '2026-09-03T12:00:00.000Z',
          },
        },
      };
    });

    const result = await runGoogleGmailPoll(CTX, {
      sql: {} as never,
      listSources: vi.fn(async () => [fresh]),
      getSource,
      resolveAccessToken: vi.fn(async () => 'token-new'),
      provision: vi.fn(async () => ({
        projectId: 'project',
        subscriptionId: 'subscription',
        topicName: 'projects/project/topics/shared',
        subscriptionName: 'projects/project/subscriptions/subscription',
        topic: 'existing' as const,
        subscription: 'existing' as const,
        publisherGrant: 'existing' as const,
      })),
      ensureWatch,
      ensureFlagshipBinding: vi.fn(),
      pull: vi.fn(async () => []),
      acknowledge: vi.fn(async () => 0),
      syncSource,
    });

    expect(order).toEqual(['sync', 'reload', 'watch']);
    expect(syncSource).toHaveBeenCalledTimes(1);
    expect(getSource).toHaveBeenCalledWith(expect.anything(), 'papercusp-workspace', 'source-new');
    expect(result).toEqual({
      sources: 1,
      succeeded: 1,
      failed: 0,
      renewed: 1,
      watchDeferred: 0,
      watchThrottled: 0,
      quotaThrottled: 0,
      pulled: 0,
      acknowledged: 0,
      messages: 7,
      fullResyncs: 1,
      failures: [],
    });
  });

  it('defers watch renewal while the backfill is parked on a quota cool-down and the watch is still valid', async () => {
    const now = new Date('2026-09-16T02:04:12.000Z');
    const parked: ExternalTriggerSourceRow = {
      ...source('source-parked', 'parked@example.com'),
      cursor: {
        emailAddress: 'parked@example.com',
        historyId: 'history-pinned',
        watchExpiration: '2026-09-22T00:00:00.000Z',
        backfill: {
          status: 'throttled',
          pageToken: 'page-4',
          pages: 3,
          messages: 158,
          startedAt: '2026-09-16T02:02:00.000Z',
          completedAt: null,
          throttledUntil: '2026-09-16T02:05:00.000Z',
          throttleCount: 1,
        },
      },
    };
    const ensureWatch = vi.fn();
    const updateSource = vi.fn(async () => parked);
    const result = await runGoogleGmailPoll(CTX, {
      sql: {} as never,
      now: () => now,
      listSources: vi.fn(async () => [parked]),
      getSource: vi.fn(async () => parked),
      resolveAccessToken: vi.fn(async () => 'token-parked'),
      provision: vi.fn(async () => ({
        projectId: 'project',
        subscriptionId: 'subscription',
        topicName: 'projects/project/topics/shared',
        subscriptionName: 'projects/project/subscriptions/subscription',
        topic: 'existing' as const,
        subscription: 'existing' as const,
        publisherGrant: 'existing' as const,
      })),
      ensureWatch,
      ensureFlagshipBinding: vi.fn(),
      pull: vi.fn(async () => []),
      acknowledge: vi.fn(async () => 0),
      // The parked chunk is skipped inside the sync; only the history replay runs.
      syncSource: vi.fn(async () => ({
        mode: 'incremental' as const,
        messages: 0,
        historyPages: 1,
        messagePages: 0,
        historyId: 'history-pinned',
        backfill: null,
      })),
      updateSource,
    });

    // Renewing here would only spend the quota the chunk just exhausted; the
    // watch has days left, so the renewal waits for the cool-down to lift.
    expect(ensureWatch).not.toHaveBeenCalled();
    expect(updateSource).not.toHaveBeenCalled();
    expect(result).toMatchObject({ succeeded: 1, failed: 0, renewed: 0, watchDeferred: 1, watchThrottled: 0, failures: [] });
    expect(formatGoogleGmailPollLog(result)).toContain('watch_deferred=1 watch_throttled=0');
  });

  it('treats a per-user quota 403 on watch renewal as a pause and keeps the source connected', async () => {
    // No watch yet (cursor just pinned) and the cool-down already lifted, so the
    // renewal IS attempted — and the quota is still exhausted from the chunk.
    const fresh: ExternalTriggerSourceRow = {
      ...source('source-quota', 'quota@example.com'),
      cursor: { emailAddress: 'quota@example.com', historyId: 'history-pinned' },
    };
    const ensureWatch = vi.fn(async () => {
      throw new GoogleGmailApiError(
        403,
        'watch',
        "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user'",
      );
    });
    const updateSource = vi.fn(async () => fresh);
    const result = await runGoogleGmailPoll(CTX, {
      sql: {} as never,
      listSources: vi.fn(async () => [fresh]),
      getSource: vi.fn(async () => fresh),
      resolveAccessToken: vi.fn(async () => 'token-quota'),
      provision: vi.fn(async () => ({
        projectId: 'project',
        subscriptionId: 'subscription',
        topicName: 'projects/project/topics/shared',
        subscriptionName: 'projects/project/subscriptions/subscription',
        topic: 'existing' as const,
        subscription: 'existing' as const,
        publisherGrant: 'existing' as const,
      })),
      ensureWatch,
      ensureFlagshipBinding: vi.fn(),
      pull: vi.fn(async () => []),
      acknowledge: vi.fn(async () => 0),
      updateSource,
    });

    expect(ensureWatch).toHaveBeenCalledTimes(1);
    // The old behaviour recorded this as status='degraded' + lastError and the
    // settings UI flapped every minute of the cool-down (WI-10001549).
    expect(updateSource).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ status: 'degraded' }),
    );
    expect(result).toMatchObject({ succeeded: 1, failed: 0, renewed: 0, watchDeferred: 0, watchThrottled: 1, failures: [] });
  });

  it('treats a per-user quota 403 on history.list as a pause: no degrade, no failure, cursor untouched (EI-23429618437235533)', async () => {
    // The chunk in the previous poll spent the per-user minute; this poll's
    // history.list is the first call to hit the exhausted quota.
    const pending: ExternalTriggerSourceRow = {
      ...source('source-quota', 'quota@example.com'),
      cursor: {
        emailAddress: 'quota@example.com',
        historyId: 'history-pinned',
        backfill: { status: 'pending', pageToken: 'page-4', pages: 3, messages: 666, startedAt: '2026-09-16T02:02:51.000Z' },
      },
    };
    const syncSource = vi.fn(async () => {
      throw new GoogleGmailApiError(
        403,
        'history_list',
        "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user'",
      );
    });
    const updateSource = vi.fn(async () => pending);
    const result = await runGoogleGmailPoll(CTX, {
      sql: {} as never,
      listSources: vi.fn(async () => [pending]),
      getSource: vi.fn(async () => pending),
      resolveAccessToken: vi.fn(async () => 'token-quota'),
      provision: vi.fn(async () => ({
        projectId: 'project',
        subscriptionId: 'subscription',
        topicName: 'projects/project/topics/shared',
        subscriptionName: 'projects/project/subscriptions/subscription',
        topic: 'existing' as const,
        subscription: 'existing' as const,
        publisherGrant: 'existing' as const,
      })),
      syncSource,
      ensureWatch: vi.fn(),
      ensureFlagshipBinding: vi.fn(),
      pull: vi.fn(async () => []),
      acknowledge: vi.fn(async () => 0),
      updateSource,
    });

    expect(syncSource).toHaveBeenCalledTimes(1);
    // Previously this was recorded as status='degraded' + lastError; nothing
    // about the mailbox is wrong, so the row is not written at all.
    expect(updateSource).not.toHaveBeenCalled();
    expect(result).toMatchObject({ failed: 0, quotaThrottled: 1, fullResyncs: 0, failures: [] });
    expect(formatGoogleGmailPollLog(result)).toContain('quota_throttled=1');
  });

  it('re-syncs a cursored mailbox whose resumable backfill is still pending (EI-23378389605835281)', async () => {
    const resuming: ExternalTriggerSourceRow = {
      ...source('source-resume', 'resume@example.com'),
      cursor: {
        emailAddress: 'resume@example.com',
        historyId: 'history-pinned',
        watchExpiration: '2026-09-03T12:00:00.000Z',
        backfill: { status: 'pending', pageToken: 'page-3', pages: 2, messages: 400 },
      },
    };
    const syncSource = vi.fn(
      async (
        _sql: unknown,
        _current: ExternalTriggerSourceRow,
        _accessToken: string,
        _options?: { backfillMessagesPerSync?: number },
      ) => ({
        mode: 'incremental' as const,
        messages: 200,
        historyPages: 1,
        messagePages: 1,
        historyId: 'history-pinned',
        backfill: null,
      }),
    );
    const result = await runGoogleGmailPoll(
      { ...CTX, triggerConfig: { ...CTX.triggerConfig, backfill_messages_per_sync: 50 } },
      {
        sql: {} as never,
        listSources: vi.fn(async () => [resuming]),
        getSource: vi.fn(async () => resuming),
        resolveAccessToken: vi.fn(async () => 'token-resume'),
        provision: vi.fn(async () => ({
          projectId: 'project',
          subscriptionId: 'subscription',
          topicName: 'projects/project/topics/shared',
          subscriptionName: 'projects/project/subscriptions/subscription',
          topic: 'existing' as const,
          subscription: 'existing' as const,
          publisherGrant: 'existing' as const,
        })),
        ensureWatch: vi.fn(async (_sql, current: ExternalTriggerSourceRow) => ({
          renewed: false,
          emailAddress: 'resume@example.com',
          historyId: 'history-pinned',
          expiration: '2026-09-03T12:00:00.000Z',
          source: current,
        })),
        ensureFlagshipBinding: vi.fn(),
        pull: vi.fn(async () => []),
        acknowledge: vi.fn(async () => 0),
        syncSource,
      },
    );

    // The pinned history cursor alone used to mean "nothing to do"; the pending
    // backfill must keep the source on the per-poll sync path with its budget.
    expect(syncSource).toHaveBeenCalledTimes(1);
    expect(syncSource.mock.calls[0]?.[3]).toEqual({ backfillMessagesPerSync: 50 });
    expect(result).toMatchObject({ succeeded: 1, failed: 0, messages: 200, fullResyncs: 0 });
  });

  it('renews watches, reconciles matching mailboxes, and drains irrelevant broadcast doorbells', async () => {
    const sources = [source('source-a', 'a@example.com'), source('source-b', 'b@example.com')];
    const acknowledged: string[][] = [];
    const ensureFlagshipBinding = vi.fn();
    const syncSource = vi.fn(async (_sql, current: ExternalTriggerSourceRow) => ({
      mode: current.id === 'source-a' ? ('incremental' as const) : ('full' as const),
      messages: current.id === 'source-a' ? 2 : 3,
      historyPages: 1,
      messagePages: 0,
      historyId: `next-${current.id}`,
      backfill: null,
    }));

    const result = await runGoogleGmailPoll(CTX, {
      sql: {} as never,
      listSources: vi.fn(async () => sources),
      resolveAccessToken: vi.fn(async (current) => `token-${current.id}`),
      provision: vi.fn(async () => ({
        projectId: 'project',
        subscriptionId: 'subscription',
        topicName: 'projects/project/topics/shared',
        subscriptionName: 'projects/project/subscriptions/subscription',
        topic: 'existing' as const,
        subscription: 'existing' as const,
        publisherGrant: 'existing' as const,
      })),
      ensureWatch: vi.fn(async (_sql, current) => ({
        renewed: current.id === 'source-a',
        emailAddress: String(current.cursor.emailAddress),
        historyId: String(current.cursor.historyId),
        expiration: String(current.cursor.watchExpiration),
        source: current,
      })),
      ensureFlagshipBinding,
      pull: vi.fn(async () => [
        doorbell('ack-a', 'a@example.com'),
        doorbell('ack-b', 'b@example.com'),
        doorbell('ack-irrelevant', 'someone-else@example.com'),
      ]),
      syncSource,
      acknowledge: vi.fn(async (_workspaceId, ackIds) => {
        acknowledged.push(ackIds);
        return ackIds.length;
      }),
    });

    expect(ensureFlagshipBinding).toHaveBeenCalledTimes(2);
    expect(ensureFlagshipBinding).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      'papercusp-workspace',
      sources[0],
      'owner:22222222-2222-4222-8222-222222222222',
    );
    expect(ensureFlagshipBinding).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'papercusp-workspace',
      sources[1],
      'owner:22222222-2222-4222-8222-222222222222',
    );
    expect(result).toEqual({
      sources: 2,
      succeeded: 2,
      failed: 0,
      renewed: 1,
      watchDeferred: 0,
      watchThrottled: 0,
      quotaThrottled: 0,
      pulled: 3,
      acknowledged: 3,
      messages: 5,
      fullResyncs: 1,
      failures: [],
    });
    expect(syncSource).toHaveBeenCalledTimes(2);
    expect(acknowledged).toEqual([['ack-a', 'ack-b', 'ack-irrelevant']]);
  });

  it('leaves a failed mailbox doorbell unacked while acknowledging successful sources', async () => {
    const sources = [source('source-good', 'good@example.com'), source('source-bad', 'bad@example.com')];
    const updateSource = vi.fn(async () => source('updated', 'updated@example.com'));
    const acknowledge = vi.fn(async (_workspaceId: string, ackIds: string[]) => ackIds.length);
    const result = await runGoogleGmailPoll(CTX, {
      sql: {} as never,
      listSources: vi.fn(async () => sources),
      resolveAccessToken: vi.fn(async () => 'token'),
      provision: vi.fn(async () => ({
        projectId: 'project',
        subscriptionId: 'subscription',
        topicName: 'projects/project/topics/shared',
        subscriptionName: 'projects/project/subscriptions/subscription',
        topic: 'existing' as const,
        subscription: 'existing' as const,
        publisherGrant: 'existing' as const,
      })),
      ensureWatch: vi.fn(async (_sql, current) => ({
        renewed: false,
        emailAddress: String(current.cursor.emailAddress),
        historyId: String(current.cursor.historyId),
        expiration: String(current.cursor.watchExpiration),
        source: current,
      })),
      ensureFlagshipBinding: vi.fn(),
      pull: vi.fn(async () => [doorbell('ack-good', 'good@example.com'), doorbell('ack-bad', 'bad@example.com')]),
      syncSource: vi.fn(async (_sql, current) => {
        if (current.id === 'source-bad') throw new Error('google_gmail_history_list_503');
        return {
          mode: 'incremental' as const,
          messages: 1,
          historyPages: 1,
          messagePages: 0,
          historyId: 'next',
          backfill: null,
        };
      }),
      acknowledge,
      updateSource,
    });

    expect(result).toMatchObject({
      sources: 2,
      succeeded: 1,
      failed: 1,
      acknowledged: 1,
      messages: 1,
      failures: [
        {
          sourceId: 'source-bad',
          status: 'degraded',
          error: 'google_gmail_history_list_503',
        },
      ],
    });
    expect(acknowledge).toHaveBeenCalledWith('papercusp-workspace', ['ack-good']);
    expect(updateSource).toHaveBeenCalledWith(expect.anything(), 'papercusp-workspace', 'source-bad', {
      status: 'degraded',
      lastError: 'google_gmail_history_list_503',
    });
    expect(formatGoogleGmailPollLog(result)).toContain(
      'failures=[{"sourceId":"source-bad","status":"degraded","error":"google_gmail_history_list_503"}]',
    );
  });

  it('refreshes and retries one Gmail 401 before marking the source terminal', async () => {
    const current = source('source-refresh', 'refresh@example.com');
    const updateSource = vi.fn();
    const syncTokens: string[] = [];
    let authenticatedCalls = 0;
    const withAccessTokenRetry = async <T>(
      _source: ExternalTriggerSourceRow,
      _installSlug: string,
      operation: (accessToken: string) => Promise<T>,
    ): Promise<T> => {
      authenticatedCalls += 1;
      try {
        return await operation('stale-token');
      } catch (cause) {
        if (!(cause instanceof GoogleGmailApiError) || cause.status !== 401) throw cause;
        return operation('fresh-token');
      }
    };

    const result = await runGoogleGmailPoll(CTX, {
      sql: {} as never,
      listSources: vi.fn(async () => [current]),
      withAccessTokenRetry,
      provision: vi.fn(async () => ({
        projectId: 'project',
        subscriptionId: 'subscription',
        topicName: 'projects/project/topics/shared',
        subscriptionName: 'projects/project/subscriptions/subscription',
        topic: 'existing' as const,
        subscription: 'existing' as const,
        publisherGrant: 'existing' as const,
      })),
      ensureWatch: vi.fn(async (_sql, sourceRow) => ({
        renewed: false,
        emailAddress: String(sourceRow.cursor.emailAddress),
        historyId: String(sourceRow.cursor.historyId),
        expiration: String(sourceRow.cursor.watchExpiration),
        source: sourceRow,
      })),
      ensureFlagshipBinding: vi.fn(),
      pull: vi.fn(async () => [doorbell('ack-refresh', 'refresh@example.com')]),
      syncSource: vi.fn(async (_sql, _sourceRow, accessToken) => {
        syncTokens.push(accessToken);
        if (accessToken === 'stale-token') {
          throw new GoogleGmailApiError(401, 'message_get', 'Invalid Credentials');
        }
        return {
          mode: 'incremental' as const,
          messages: 1,
          historyPages: 1,
          messagePages: 0,
          historyId: 'next-refresh',
          backfill: null,
        };
      }),
      acknowledge: vi.fn(async (_workspaceId, ackIds) => ackIds.length),
      updateSource,
    });

    expect(result).toMatchObject({ sources: 1, succeeded: 1, failed: 0, acknowledged: 1, messages: 1 });
    expect(syncTokens).toEqual(['stale-token', 'fresh-token']);
    expect(authenticatedCalls).toBe(2);
    expect(updateSource).not.toHaveBeenCalled();
  });

  it('isolates a revoked mailbox until an account-targeted reconnect resumes its preserved cursor', async () => {
    const revokedId = 'source-revoked';
    const siblingId = 'source-sibling';
    const initial = [source(revokedId, 'revoked@example.com'), source(siblingId, 'sibling@example.com')];
    const state = new Map(initial.map((current) => [current.id, current]));
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
    const resolveAccessToken = vi.fn(async (current: ExternalTriggerSourceRow) => `token:${current.credentialRef}`);
    const ensureWatch = vi.fn(async (_sql, current: ExternalTriggerSourceRow) => {
      if (pass === 0 && current.id === revokedId) {
        throw new Error('google_gmail_watch_401:Invalid Credentials');
      }
      return {
        renewed: false,
        emailAddress: String(current.cursor.emailAddress),
        historyId: String(current.cursor.historyId),
        expiration: String(current.cursor.watchExpiration),
        source: current,
      };
    });
    const syncSource = vi.fn(async (_sql, current: ExternalTriggerSourceRow) => {
      const historyId = `next-${current.id}-pass-${pass}`;
      state.set(current.id, { ...current, cursor: { ...current.cursor, historyId } });
      return {
        mode: 'incremental' as const,
        messages: 1,
        historyPages: 1,
        messagePages: 0,
        historyId,
        backfill: null,
      };
    });
    const acknowledge = vi.fn(async (_workspaceId: string, ackIds: string[]) => ackIds.length);
    const deps = {
      sql: {} as never,
      listSources: vi.fn(async () => [...state.values()].filter((current) => current.status !== 'error')),
      resolveAccessToken,
      provision: vi.fn(async () => ({
        projectId: 'project',
        subscriptionId: 'subscription',
        topicName: 'projects/project/topics/shared',
        subscriptionName: 'projects/project/subscriptions/subscription',
        topic: 'existing' as const,
        subscription: 'existing' as const,
        publisherGrant: 'existing' as const,
      })),
      ensureWatch,
      ensureFlagshipBinding: vi.fn(),
      pull: vi.fn(async () =>
        pass === 0
          ? [doorbell('ack-revoked', 'revoked@example.com'), doorbell('ack-sibling', 'sibling@example.com')]
          : [doorbell('ack-revoked-redelivery', 'revoked@example.com')],
      ),
      acknowledge,
      syncSource,
      updateSource,
    };

    const failed = await runGoogleGmailPoll(CTX, deps);

    expect(failed).toMatchObject({
      sources: 2,
      succeeded: 1,
      failed: 1,
      acknowledged: 1,
      failures: [{ sourceId: revokedId, status: 'error', error: 'google_gmail_watch_401:Invalid Credentials' }],
    });
    expect(acknowledge).toHaveBeenNthCalledWith(1, 'papercusp-workspace', ['ack-sibling']);
    expect(state.get(revokedId)).toMatchObject({
      status: 'error',
      cursor: { historyId: `history-${revokedId}` },
    });
    expect(state.get(siblingId)).toMatchObject({
      status: 'connected',
      cursor: { historyId: `next-${siblingId}-pass-0` },
    });

    const beforeReconnect = state.get(revokedId)!;
    state.set(revokedId, {
      ...beforeReconnect,
      status: 'connected',
      credentialRef: 'google-workspace:reconnected-revoked',
    });
    pass = 1;
    const recovered = await runGoogleGmailPoll(CTX, deps);

    expect(recovered).toMatchObject({ sources: 2, succeeded: 2, failed: 0, acknowledged: 1 });
    expect(acknowledge).toHaveBeenNthCalledWith(2, 'papercusp-workspace', ['ack-revoked-redelivery']);
    expect(syncSource.mock.calls.map(([, current]) => current.id)).toEqual([siblingId, revokedId]);
    expect(state.get(revokedId)).toMatchObject({
      status: 'connected',
      credentialRef: 'google-workspace:reconnected-revoked',
      cursor: { historyId: `next-${revokedId}-pass-1` },
    });
    expect(state.get(siblingId)?.cursor).toMatchObject({ historyId: `next-${siblingId}-pass-0` });
    expect(updateSource).toHaveBeenCalledTimes(1);
  });

  it('clears a degraded source after the next successful idle poll', async () => {
    let current = source('source-idle', 'idle@example.com');
    let accessTokenAttempts = 0;
    const updateSource = vi.fn(async (_sql, _workspaceId, _sourceId, input) => {
      current = { ...current, status: input.status };
      return current;
    });
    const ensureWatch = vi.fn(async () => ({
      renewed: false,
      emailAddress: String(current.cursor.emailAddress),
      historyId: String(current.cursor.historyId),
      expiration: String(current.cursor.watchExpiration),
      source: current,
    }));
    const deps = {
      sql: {} as never,
      listSources: vi.fn(async () => [current]),
      resolveAccessToken: vi.fn(async () => {
        accessTokenAttempts += 1;
        if (accessTokenAttempts === 1) throw new Error('google_workspace_token_503');
        return 'token';
      }),
      provision: vi.fn(async () => ({
        projectId: 'project',
        subscriptionId: 'subscription',
        topicName: 'projects/project/topics/shared',
        subscriptionName: 'projects/project/subscriptions/subscription',
        topic: 'existing' as const,
        subscription: 'existing' as const,
        publisherGrant: 'existing' as const,
      })),
      ensureWatch,
      ensureFlagshipBinding: vi.fn(),
      pull: vi.fn(async () => []),
      acknowledge: vi.fn(async () => 0),
      syncSource: vi.fn(),
      updateSource,
    };

    const failed = await runGoogleGmailPoll(CTX, deps);
    const recovered = await runGoogleGmailPoll(CTX, deps);

    expect(failed).toMatchObject({ sources: 1, succeeded: 0, failed: 1, pulled: 0 });
    expect(recovered).toMatchObject({ sources: 1, succeeded: 1, failed: 0, pulled: 0 });
    expect(ensureWatch).toHaveBeenCalledTimes(1);
    expect(updateSource).toHaveBeenCalledTimes(2);
    expect(updateSource).toHaveBeenNthCalledWith(1, expect.anything(), 'papercusp-workspace', 'source-idle', {
      status: 'degraded',
      lastError: 'google_workspace_token_503',
    });
    expect(updateSource).toHaveBeenNthCalledWith(2, expect.anything(), 'papercusp-workspace', 'source-idle', {
      status: 'connected',
      lastError: null,
      connected: true,
    });
  });

  it('contains shared Pub/Sub provisioning failures and degrades every mailbox', async () => {
    const sources = [source('source-a', 'a@example.com'), source('source-b', 'b@example.com')];
    const updateSource = vi.fn(async () => sources[0]);
    const provisionError = 'google_pubsub_create_topic_403:User not authorized to perform this action.';
    const pull = vi.fn();
    const result = await runGoogleGmailPoll(CTX, {
      sql: {} as never,
      listSources: vi.fn(async () => sources),
      ensureFlagshipBinding: vi.fn(),
      provision: vi.fn(async () => {
        throw new Error(provisionError);
      }),
      pull,
      updateSource,
    });

    expect(result).toEqual({
      sources: 2,
      succeeded: 0,
      failed: 2,
      renewed: 0,
      watchDeferred: 0,
      watchThrottled: 0,
      quotaThrottled: 0,
      pulled: 0,
      acknowledged: 0,
      messages: 0,
      fullResyncs: 0,
      failures: [
        { sourceId: 'source-a', status: 'degraded', error: provisionError },
        { sourceId: 'source-b', status: 'degraded', error: provisionError },
      ],
    });
    expect(updateSource).toHaveBeenCalledTimes(2);
    expect(updateSource).toHaveBeenNthCalledWith(1, expect.anything(), 'papercusp-workspace', 'source-a', {
      status: 'degraded',
      lastError: provisionError,
    });
    expect(updateSource).toHaveBeenNthCalledWith(2, expect.anything(), 'papercusp-workspace', 'source-b', {
      status: 'degraded',
      lastError: provisionError,
    });
    expect(pull).not.toHaveBeenCalled();
  });

  it('registers the durable handler', () => {
    expect(getSystemAction('google-gmail-poll')).toBeTypeOf('function');
  });
});
