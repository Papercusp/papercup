import { describe, expect, it, vi } from 'vitest';
import {
  acknowledgeSlackSocketEnvelope,
  connectOwnedSlackSource,
  normalizeSlackSocketEnvelope,
  postSlackThreadMessage,
  reconcileSlackHistoryOnce,
  resolveSlackSocketCredentials,
  SLACK_APP_MANIFEST_TEMPLATE,
} from './slack';
import type { ExternalTriggerSourceRow } from './source-store';

const NOW = new Date('2026-08-22T12:00:00.000Z');

function source(overrides: Partial<ExternalTriggerSourceRow> = {}): ExternalTriggerSourceRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    workspaceId: 'papercusp-workspace',
    kind: 'slack',
    ownerUserId: '22222222-2222-4222-8222-222222222222',
    credentialRef: 'slack-socket:owner',
    providerAccountId: 'T1',
    status: 'connected',
    config: { installSlug: 'papercusp', botUserId: 'UPAPER', channels: ['C1', 'D1'] },
    cursor: {},
    ...overrides,
  };
}

describe('Slack external-trigger adapter', () => {
  it('ships a Socket Mode manifest with the event, history, command, and reply scopes', () => {
    expect(SLACK_APP_MANIFEST_TEMPLATE.settings).toMatchObject({
      socket_mode_enabled: true,
      interactivity: { is_enabled: true },
      event_subscriptions: {
        bot_events: ['app_mention', 'message.im', 'reaction_added', 'message.channels', 'message.groups'],
      },
    });
    // slack-messages-to-bug-reports P-002: the report-bug gestures need the reaction
    // scope and the "Report a bug" message shortcut.
    expect(SLACK_APP_MANIFEST_TEMPLATE.oauth_config.scopes.bot).toEqual(expect.arrayContaining(['reactions:read', 'files:read']));
    // The org connector's conversations.list and a report's channel name need the channel read
    // scopes; the reporter's display name needs users:read (P-005, D-012).
    expect(SLACK_APP_MANIFEST_TEMPLATE.oauth_config.scopes.bot).toEqual(
      expect.arrayContaining(['channels:read', 'groups:read', 'users:read']),
    );
    expect(SLACK_APP_MANIFEST_TEMPLATE.features.shortcuts).toEqual([
      expect.objectContaining({ type: 'message', callback_id: 'papercusp_report_bug', name: 'Report a bug' }),
    ]);
    expect(SLACK_APP_MANIFEST_TEMPLATE.oauth_config.scopes.bot).toEqual(expect.arrayContaining([
      'app_mentions:read', 'channels:history', 'groups:history', 'im:history', 'mpim:history', 'commands',
      // The flagship below calls chat.postMessage; without this the canonical
      // generated app can ingest a mention but fails its reply with missing_scope.
      'chat:write',
    ]));
  });

  it('ACKs every burst envelope synchronously before async work can start', () => {
    const sent: string[] = [];
    for (const id of ['e-1', 'e-2', 'e-3']) {
      expect(acknowledgeSlackSocketEnvelope({ envelope_id: id }, (payload) => sent.push(payload))).toBe(true);
    }
    expect(sent.map((payload) => JSON.parse(payload))).toEqual([
      { envelope_id: 'e-1' }, { envelope_id: 'e-2' }, { envelope_id: 'e-3' },
    ]);
  });

  it('normalizes mention, DM, and slash-command envelopes with event_id dedupe', () => {
    const mention = normalizeSlackSocketEnvelope({
      envelope_id: 'env-1', type: 'events_api', payload: {
        event_id: 'Ev1', event_time: 1_777_000_000,
        event: { type: 'app_mention', channel: 'C1', user: 'U1', text: '<@UPAPER> hello', ts: '1777000000.1' },
      },
    });
    expect(mention).toMatchObject({ event: 'mention', externalId: 'Ev1', dedupeKey: 'slack:Ev1', channelId: 'C1' });
    expect(mention?.payload).toMatchObject({ id: 'Ev1', mentions: ['UPAPER'], text: '<@UPAPER> hello' });

    expect(normalizeSlackSocketEnvelope({
      type: 'events_api', payload: {
        event_id: 'Ev2', event: { type: 'message', channel_type: 'im', channel: 'D1', user: 'U2', text: 'hello', ts: '2.0' },
      },
    })).toMatchObject({ event: 'dm', dedupeKey: 'slack:Ev2', channelId: 'D1' });

    expect(normalizeSlackSocketEnvelope({
      envelope_id: 'env-3', type: 'slash_commands', payload: {
        trigger_id: 'trigger-3', command: '/papercusp', text: 'run triage', channel_id: 'C1', user_id: 'U3',
      },
    })).toMatchObject({ event: 'slash-command', dedupeKey: 'slack:trigger-3' });
  });

  it('stores dual tokens through the OAuth storage adapter and returns only an opaque source reference', async () => {
    const configs = new Map<string, Record<string, unknown>>();
    const storage = {
      read: vi.fn(async (plugin: string, harness: string) => configs.get(`${plugin}:${harness}`) ?? {}),
      update: vi.fn(async (plugin: string, harness: string, patch: Record<string, unknown>) => {
        configs.set(`${plugin}:${harness}`, { ...(configs.get(`${plugin}:${harness}`) ?? {}), ...patch });
      }),
    };
    const calls: unknown[] = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push([strings, values]);
      return Promise.resolve([source({
        credentialRef: 'slack-socket:owner',
        status: 'connecting',
        config: { installSlug: 'papercusp', teamId: 'T1', botUserId: 'UPAPER', channels: ['C1'] },
      })]);
    }) as never;
    const connected = await connectOwnedSlackSource(sql, {
      workspaceId: 'papercusp-workspace', ownerUserId: '22222222-2222-4222-8222-222222222222',
      installSlug: 'papercusp', field: 'owner', appToken: 'xapp-secret', botToken: 'xoxb-secret', channels: ['C1'],
    }, {
      storage,
      apiOrigin: 'https://slack.test',
      fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true, team_id: 'T1', user_id: 'UPAPER' }))) as never,
    });
    expect(connected).toMatchObject({ credentialRef: 'slack-socket:owner', status: 'connecting' });
    expect(JSON.stringify(connected)).not.toContain('xapp-secret');
    expect(JSON.stringify(connected)).not.toContain('xoxb-secret');
    expect(await resolveSlackSocketCredentials(connected, 'papercusp', storage)).toEqual({
      appToken: 'xapp-secret', botToken: 'xoxb-secret',
    });
    expect(calls).toHaveLength(1);
  });

  it('posts a bounded bot reply to the exact originating thread', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      channel: 'C1',
      ts: '1777000001.4',
    }))) as never;
    await expect(postSlackThreadMessage('xoxb-secret', {
      channelId: 'C1',
      threadId: '1777000000.1',
      text: '  Done — here is the answer.  ',
    }, { fetch: fetchImpl, apiOrigin: 'https://slack.test' })).resolves.toEqual({
      channelId: 'C1',
      threadId: '1777000000.1',
      messageTs: '1777000001.4',
    });
    expect(fetchImpl).toHaveBeenCalledWith('https://slack.test/api/chat.postMessage', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ authorization: 'Bearer xoxb-secret' }),
      body: JSON.stringify({
        channel: 'C1',
        thread_ts: '1777000000.1',
        text: 'Done — here is the answer.',
      }),
    }));
  });

  it('honors Retry-After and advances a bounded history cursor one page at a time', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const updateSource = vi.fn(async (_sql, _workspace, _id, input) => {
      updates.push(input as Record<string, unknown>);
      return source({ status: input.status, cursor: input.cursor ?? {} });
    });
    const limited = await reconcileSlackHistoryOnce({} as never, source(), 'xoxb-token', {
      now: () => NOW,
      fetch: vi.fn(async () => new Response('', { status: 429, headers: { 'retry-after': '90' } })) as never,
      updateSource,
    });
    expect(limited).toMatchObject({ rateLimited: true, channelId: 'C1', messages: 0 });
    expect(updates[0]).toMatchObject({
      status: 'degraded',
      cursor: { historyNextAt: '2026-08-22T12:01:30.000Z' },
    });

    updates.length = 0;
    const ingest = vi.fn(async () => ({ ok: true, event: {} as never, deliveries: [] }));
    const synced = await reconcileSlackHistoryOnce({} as never, source(), 'xoxb-token', {
      now: () => NOW,
      fetch: vi.fn(async () => new Response(JSON.stringify({
        ok: true,
        messages: [
          { ts: '1777032000.2', user: 'U2', text: 'ordinary channel message' },
          { ts: '1777032000.1', user: 'U1', text: '<@UPAPER> do the thing' },
        ],
        response_metadata: { next_cursor: 'page-2' },
      }))) as never,
      updateSource,
      ingest,
    });
    expect(synced).toMatchObject({ rateLimited: false, channelId: 'C1', messages: 1 });
    expect(ingest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      event: 'mention', dedupeKey: 'slack:C1:1777032000.1', datatypeId: 'chat-message',
    }));
    expect(updates[0]).toMatchObject({
      cursor: { historyPageCursor: 'page-2', historyChannelIndex: 0, historyNextAt: '2026-08-22T12:01:00.000Z' },
    });
  });
});
