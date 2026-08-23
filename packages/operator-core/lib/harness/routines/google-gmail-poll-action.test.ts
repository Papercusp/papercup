import { describe, expect, it, vi } from 'vitest';
import type { ExternalTriggerSourceRow } from '../../external-triggers/source-store';
import type { GooglePubSubReceivedMessage } from '../../external-triggers/google-pubsub';
import { getSystemAction } from './system-actions';
import { runGoogleGmailPoll } from './google-gmail-poll-action';

function source(id: string, emailAddress: string): ExternalTriggerSourceRow {
  return {
    id,
    workspaceId: 'papercusp-workspace',
    kind: 'gmail',
    ownerUserId: '22222222-2222-4222-8222-222222222222',
    credentialRef: `google-workspace:${id}`,
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
  it('renews watches, reconciles matching mailboxes, and drains irrelevant broadcast doorbells', async () => {
    const sources = [source('source-a', 'a@example.com'), source('source-b', 'b@example.com')];
    const acknowledged: string[][] = [];
    const syncSource = vi.fn(async (_sql, current: ExternalTriggerSourceRow) => ({
      mode: current.id === 'source-a' ? ('incremental' as const) : ('full' as const),
      messages: current.id === 'source-a' ? 2 : 3,
      historyPages: 1,
      messagePages: 0,
      historyId: `next-${current.id}`,
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

    expect(result).toEqual({
      sources: 2,
      succeeded: 2,
      failed: 0,
      renewed: 1,
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
      pull: vi.fn(async () => [doorbell('ack-good', 'good@example.com'), doorbell('ack-bad', 'bad@example.com')]),
      syncSource: vi.fn(async (_sql, current) => {
        if (current.id === 'source-bad') throw new Error('google_gmail_history_list_503');
        return {
          mode: 'incremental' as const,
          messages: 1,
          historyPages: 1,
          messagePages: 0,
          historyId: 'next',
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
  });

  it('contains shared Pub/Sub provisioning failures and degrades every mailbox', async () => {
    const sources = [source('source-a', 'a@example.com'), source('source-b', 'b@example.com')];
    const updateSource = vi.fn(async () => sources[0]);
    const provisionError = 'google_pubsub_create_topic_403:User not authorized to perform this action.';
    const pull = vi.fn();
    const result = await runGoogleGmailPoll(CTX, {
      sql: {} as never,
      listSources: vi.fn(async () => sources),
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
