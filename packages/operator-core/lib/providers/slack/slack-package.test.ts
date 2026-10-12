/**
 * The `slack` provider package (plan cupboard-distributable-integrations-2026-10-10 P-006):
 * libs/papercusp/plugins/slack — a Cupboard-installable sandboxed daemon provider that declares
 * pasted credentials, a Slack app manifest, a host-held Socket Mode ingress, the `chat-message`
 * datatype, and the `chat.channels` / `chat.reply` capabilities.
 *
 * Covers the package's pure logic (provider.mjs) and its JSON-RPC daemon wrapper (daemon.mjs)
 * spawned as a real process.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PROVIDER_INGRESS_NORMALIZE_CAPABILITY,
  providerAppRegistrationUrl,
  providerCredentialForHost,
  validateProviderDeclaration,
  type HostFetchRequest,
  type HostFetchResponse,
} from '@papercusp/plugin-sdk';
import { validateDatatypePayload } from '../../datatype-payload-validation';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const PACKAGE_DIR = resolve(REPO_ROOT, 'libs/papercusp/plugins/slack');
const manifest = JSON.parse(readFileSync(resolve(PACKAGE_DIR, 'papercusp.json'), 'utf8'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const provider: any = await import(pathToFileURL(resolve(PACKAGE_DIR, 'provider.mjs')).href);

/** A token-shaped fake, assembled at runtime so no credential-shaped literal sits in the tree. */
const fakeToken = (prefix: string) => [prefix, '1234567890', '0987654321', 'AbCdEf'].join('-');

/** The workspace's canonical chat-message payload schema (harness_shared.datatype_registry). */
const CHAT_MESSAGE_SCHEMA = {
  type: 'object',
  required: ['id', 'text'],
  properties: {
    id: { type: 'string', minLength: 1 },
    text: { type: 'string' },
    sender: { type: 'string' },
    mentions: { type: 'array', items: { type: 'string' } },
    threadId: { type: 'string' },
    channelId: { type: 'string' },
    occurredAt: { type: 'string' },
    attachments: { type: 'array', items: { type: 'object' } },
  },
  additionalProperties: true,
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): HostFetchResponse {
  return { status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), bodyEncoding: 'utf8' };
}

function eventsEnvelope(event: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { envelope_id: 'env-1', type: 'events_api', payload: { event_id: 'Ev01', team_id: 'T1', event, ...extra } };
}

describe('slack package manifest', () => {
  it('is a valid provider declaration that the Cupboard installs as a sandboxed daemon', () => {
    expect(validateProviderDeclaration(manifest)).toEqual([]);
    expect(manifest.runtime).toEqual({ kind: 'daemon', daemonCommand: ['node', 'daemon.mjs'] });
    expect(manifest.provider.id).toBe('slack');
    expect(manifest.provider.datatypes).toEqual(['chat-message']);
    expect(manifest.provider.capabilities).toEqual(
      expect.arrayContaining([PROVIDER_INGRESS_NORMALIZE_CAPABILITY, 'chat.channels', 'chat.reply']),
    );
    // Setup is pasted, never OAuth: the package carries no client registration.
    expect(manifest.provider.oauth).toBeUndefined();
  });

  it('opens the socket with the app-level token and sends the bot token only to slack.com', () => {
    const socket = manifest.provider.ingress.socket;
    expect(socket.credential).toBe('app_token');
    expect(socket.open).toEqual({ url: 'https://slack.com/api/apps.connections.open', method: 'POST', urlField: 'url' });
    expect(socket.ackField).toBe('envelope_id');
    expect(socket.reconnect).toEqual({ field: 'type', values: ['disconnect'] });
    // Interactive envelopes skip the serialized chain so the report form opens inside Slack's
    // 3-second trigger_id window (D-025 ruling 2).
    expect(socket.immediate).toEqual({ field: 'type', values: ['interactive'] });
    expect(providerCredentialForHost(manifest.provider, 'slack.com')?.key).toBe('bot_token');
    const credential = (key: string) => manifest.provider.setup.credentials.find((c: { key: string }) => c.key === key);
    const matches = (key: string, value: string) => new RegExp(`^(?:${credential(key).pattern})$`).test(value);
    expect(credential('app_token').hosts).toBeUndefined();
    expect(matches('app_token', fakeToken('xapp'))).toBe(true);
    expect(matches('bot_token', fakeToken('xoxb'))).toBe(true);
    // Pasting one token into the other's field is refused on the card.
    expect(matches('bot_token', fakeToken('xapp'))).toBe(false);
    expect(matches('app_token', fakeToken('xoxb'))).toBe(false);
  });

  it('creates the Slack app from its manifest with Socket Mode and the scopes the capabilities use', () => {
    const registration = manifest.provider.setup.appRegistration;
    const url = new URL(providerAppRegistrationUrl(registration));
    expect(url.origin + url.pathname).toBe('https://api.slack.com/apps');
    const definition = JSON.parse(url.searchParams.get('manifest_json') ?? 'null');
    expect(definition).toEqual(registration.definition);
    expect(definition.settings.socket_mode_enabled).toBe(true);
    expect(definition.oauth_config.scopes.bot).toEqual(
      expect.arrayContaining(['chat:write', 'channels:read', 'groups:read', 'channels:history', 'app_mentions:read', 'reactions:read']),
    );
    expect(definition.settings.event_subscriptions.bot_events).toEqual(
      expect.arrayContaining(['app_mention', 'message.channels', 'message.groups', 'message.im', 'reaction_added']),
    );
    // The "Report a bug" message shortcut the provider answers with its form.
    expect(definition.features.shortcuts).toEqual([
      expect.objectContaining({ type: 'message', callback_id: provider.SLACK_REPORT_SHORTCUT_CALLBACK_ID }),
    ]);
    expect(definition.settings.interactivity).toEqual({ is_enabled: true });
  });
});

/** A host.fetch that must not be called: plain posts and ignored gestures read nothing from Slack. */
const noFetch = async (): Promise<HostFetchResponse> => {
  throw new Error('fetched');
};

/**
 * A fake slack.com behind host.fetch: conversations.replies answers from `messages` (keyed
 * `channel:ts`), views.open succeeds. Every request is recorded.
 */
function fakeSlack(messages: Record<string, { text: string; user: string; thread_ts?: string }> = {}) {
  const seen: HostFetchRequest[] = [];
  const fetchSlack = async (request: HostFetchRequest) => {
    seen.push(request);
    const url = new URL(request.url);
    if (url.pathname === '/api/conversations.replies') {
      const channel = url.searchParams.get('channel');
      const ts = url.searchParams.get('ts');
      const message = messages[`${channel}:${ts}`];
      return json({ ok: true, messages: message ? [{ ts, ...message }] : [] });
    }
    if (url.pathname === '/api/views.open') return json({ ok: true, view: { id: 'V-open' } });
    return json({ ok: false, error: 'unknown_method' });
  };
  return { seen, fetchSlack };
}

function interactiveEnvelope(payload: Record<string, unknown>) {
  return { envelope_id: 'env-int', type: 'interactive', accepts_response_payload: false, payload };
}

const REPORTED_TS = '1712345678.000200';

describe('ingress.normalize', () => {
  it('records a channel post as a chat-message with its channel, author and text', async () => {
    const result = await provider.normalizeEnvelope(
      eventsEnvelope({ type: 'message', channel: 'C42', channel_type: 'channel', user: 'U7', text: 'The export button 500s <@U9>', ts: '1712345678.000200' }),
    );
    expect(result.records).toHaveLength(1);
    const [record] = result.records;
    expect(record).toMatchObject({ datatype: 'chat-message', nativeId: 'C42:1712345678.000200', event: 'message', version: 'message:C42:1712345678.000200' });
    expect(record.payload).toMatchObject({
      id: 'Ev01',
      channelId: 'C42',
      threadId: '1712345678.000200',
      sender: 'U7',
      text: 'The export button 500s <@U9>',
      mentions: ['U9'],
      occurredAt: '2024-04-05T19:34:38.000Z',
      extensions: { slack: { ts: '1712345678.000200', eventType: 'message', channelType: 'channel', teamId: 'T1' } },
    });
    expect(validateDatatypePayload(CHAT_MESSAGE_SCHEMA, record.payload).ok).toBe(true);
  });

  it('keeps a reply in its thread and names the thread root', async () => {
    const [record] = (await provider.normalizeEnvelope(
      eventsEnvelope({ type: 'message', channel: 'C42', user: 'U7', text: 'Still broken', ts: '1712345700.000100', thread_ts: '1712345678.000200' }),
    )).records;
    expect(record.payload.threadId).toBe('1712345678.000200');
    expect(record.payload.extensions.slack.threadTs).toBe('1712345678.000200');
  });

  it('distinguishes mentions and direct messages, and delivers a mention and its channel post separately', async () => {
    const mention = (await provider.normalizeEnvelope(
      eventsEnvelope({ type: 'app_mention', channel: 'C42', user: 'U7', text: '<@UBOT> help', ts: '1712345678.000200' }),
      {},
      noFetch,
    )).records[0];
    const post = (await provider.normalizeEnvelope(
      eventsEnvelope({ type: 'message', channel: 'C42', channel_type: 'channel', user: 'U7', text: '<@UBOT> help', ts: '1712345678.000200' }),
    )).records[0];
    expect(mention.event).toBe('mention');
    expect(post.event).toBe('message');
    expect(mention.nativeId).toBe(post.nativeId);
    expect(mention.version).not.toBe(post.version);
    // A top-level mention is about itself: no target, and nothing read from Slack.
    expect(mention.payload.target).toBeUndefined();
    const dm = (await provider.normalizeEnvelope(
      eventsEnvelope({ type: 'message', channel: 'D1', channel_type: 'im', user: 'U7', text: 'hi', ts: '1712345678.000300' }),
    )).records[0];
    expect(dm.event).toBe('dm');
  });

  it("carries a mention inside a thread with the thread's opening message as its target", async () => {
    const { seen, fetchSlack } = fakeSlack({ [`C42:${REPORTED_TS}`]: { text: 'Checkout spins forever', user: 'U3' } });
    const [record] = (await provider.normalizeEnvelope(
      eventsEnvelope({ type: 'app_mention', channel: 'C42', user: 'U7', text: '<@UBOT> this is a bug', ts: '1712345700.000100', thread_ts: REPORTED_TS }),
      {},
      fetchSlack,
    )).records;
    expect(record).toMatchObject({ event: 'mention', nativeId: 'C42:1712345700.000100' });
    expect(record.payload).toMatchObject({
      sender: 'U7',
      text: '<@UBOT> this is a bug',
      threadId: REPORTED_TS,
      target: { channelId: 'C42', ts: REPORTED_TS, sender: 'U3', text: 'Checkout spins forever' },
    });
    expect(seen).toHaveLength(1);
    const read = new URL(seen[0].url);
    expect(read.origin + read.pathname).toBe('https://slack.com/api/conversations.replies');
    expect(read.searchParams.get('channel')).toBe('C42');
    expect(read.searchParams.get('ts')).toBe(REPORTED_TS);
    expect(validateDatatypePayload(CHAT_MESSAGE_SCHEMA, record.payload).ok).toBe(true);
  });

  it('records a reaction as a record of the reacted message, with the reactor in gesture', async () => {
    const { seen, fetchSlack } = fakeSlack({ [`C42:${REPORTED_TS}`]: { text: 'Export 500s on big CSVs', user: 'U3' } });
    const reaction = {
      type: 'reaction_added',
      user: 'U5',
      reaction: 'bug::skin-tone-2',
      item: { type: 'message', channel: 'C42', ts: REPORTED_TS },
      item_user: 'U3',
      event_ts: '1712345800.000100',
    };
    const [record] = (await provider.normalizeEnvelope(eventsEnvelope(reaction), { botUserId: 'U0' }, fetchSlack)).records;
    expect(record).toMatchObject({
      datatype: 'chat-message',
      event: 'reaction',
      // The same message a channel post of it would be: one record, a new version per reactor.
      nativeId: `C42:${REPORTED_TS}`,
      version: `reaction:bug:U5:C42:${REPORTED_TS}`,
    });
    expect(record.payload).toMatchObject({
      channelId: 'C42',
      threadId: REPORTED_TS,
      sender: 'U3',
      text: 'Export 500s on big CSVs',
      gesture: { kind: 'reaction', by: 'U5', reaction: 'bug' },
      occurredAt: '2024-04-05T19:36:40.000Z',
      extensions: { slack: { ts: REPORTED_TS, eventType: 'reaction_added', teamId: 'T1' } },
    });
    expect(validateDatatypePayload(CHAT_MESSAGE_SCHEMA, record.payload).ok).toBe(true);
    // The daemon never handles a token: host.fetch injects the bot token for slack.com.
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0].headers ?? {}).map((h) => h.toLowerCase())).not.toContain('authorization');
  });

  it("ignores the app's own reactions, reactions in DMs and reactions on files, without reading Slack", async () => {
    const base = { type: 'reaction_added', user: 'U5', reaction: 'bug', item: { type: 'message', channel: 'C42', ts: REPORTED_TS } };
    for (const event of [
      { ...base, user: 'U0' }, // the app's own bot user
      { ...base, item: { ...base.item, channel: 'D42' } },
      { ...base, item: { type: 'file', file: 'F1' } },
      { ...base, item: { ...base.item, ts: 'nope' } },
      { ...base, reaction: '' },
      { ...base, user: '' },
    ]) {
      expect((await provider.normalizeEnvelope(eventsEnvelope(event), { botUserId: 'U0' }, noFetch)).records).toEqual([]);
    }
  });

  it('fails loudly when the message a gesture is about cannot be read', async () => {
    const reaction = { type: 'reaction_added', user: 'U5', reaction: 'bug', item: { type: 'message', channel: 'C42', ts: REPORTED_TS } };
    await expect(provider.normalizeEnvelope(eventsEnvelope(reaction), {}, fakeSlack().fetchSlack)).rejects.toThrow(
      `slack_message_unavailable:C42:${REPORTED_TS}`,
    );
    await expect(
      provider.normalizeEnvelope(eventsEnvelope(reaction), {}, async () => json({ ok: false, error: 'missing_scope' })),
    ).rejects.toMatchObject({ message: 'slack_conversations_replies_missing_scope', data: { kind: 'auth' } });
    await expect(provider.normalizeEnvelope(eventsEnvelope(reaction), {})).rejects.toThrow('slack_message_fetch_unavailable');
  });

  it('opens the report form for a "Report a bug" shortcut click and records nothing for the click', async () => {
    const { seen, fetchSlack } = fakeSlack();
    const result = await provider.normalizeEnvelope(
      interactiveEnvelope({
        type: 'message_action',
        callback_id: provider.SLACK_REPORT_SHORTCUT_CALLBACK_ID,
        trigger_id: 'trig-9',
        user: { id: 'U5' },
        channel: { id: 'C42' },
        message: { ts: REPORTED_TS, text: 'Export 500s on big CSVs' },
        team: { id: 'T1' },
      }),
      {},
      fetchSlack,
    );
    expect(result.records).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ url: 'https://slack.com/api/views.open', method: 'POST' });
    const body = JSON.parse(seen[0].body ?? '{}');
    expect(body.trigger_id).toBe('trig-9');
    expect(body.view).toEqual(provider.reportFormView({ channelId: 'C42', ts: REPORTED_TS }));
    expect(body.view.callback_id).toBe(provider.SLACK_REPORT_FORM_CALLBACK_ID);
    expect(JSON.parse(body.view.private_metadata)).toEqual({ channelId: 'C42', ts: REPORTED_TS });
    // A refused views.open (an expired trigger) surfaces by Slack's own code.
    await expect(
      provider.normalizeEnvelope(
        interactiveEnvelope({ type: 'message_action', callback_id: 'report_bug', trigger_id: 'trig-9', user: { id: 'U5' }, channel: { id: 'C42' }, message: { ts: REPORTED_TS } }),
        {},
        async () => json({ ok: false, error: 'expired_trigger_id' }),
      ),
    ).rejects.toThrow('slack_views_open_expired_trigger_id');
  });

  it("records the form's submission as a report of the reported message, with the reporter's note", async () => {
    const { seen, fetchSlack } = fakeSlack({ [`C42:${REPORTED_TS}`]: { text: 'Export 500s on big CSVs', user: 'U3', thread_ts: REPORTED_TS } });
    const submission = (values: Record<string, unknown>, view: Record<string, unknown> = {}) =>
      interactiveEnvelope({
        type: 'view_submission',
        user: { id: 'U5' },
        team: { id: 'T1' },
        view: {
          id: 'V1',
          callback_id: provider.SLACK_REPORT_FORM_CALLBACK_ID,
          private_metadata: JSON.stringify({ channelId: 'C42', ts: REPORTED_TS }),
          state: { values },
          ...view,
        },
      });
    const [record] = (await provider.normalizeEnvelope(submission({ note: { note: { type: 'plain_text_input', value: '  Every time, since Monday.  ' } } }), {}, fetchSlack)).records;
    expect(record).toMatchObject({ datatype: 'chat-message', event: 'report', nativeId: `C42:${REPORTED_TS}`, version: 'report:V1' });
    expect(record.payload).toMatchObject({
      channelId: 'C42',
      threadId: REPORTED_TS,
      sender: 'U3',
      text: 'Export 500s on big CSVs',
      gesture: { kind: 'report', by: 'U5', note: 'Every time, since Monday.' },
      extensions: { slack: { ts: REPORTED_TS, eventType: 'view_submission', teamId: 'T1' } },
    });
    expect(validateDatatypePayload(CHAT_MESSAGE_SCHEMA, record.payload).ok).toBe(true);
    expect(seen).toHaveLength(1);

    // An empty note is left out; an over-long one is cut to the form's limit.
    const [bare] = (await provider.normalizeEnvelope(submission({ note: { note: { value: '   ' } } }), {}, fetchSlack)).records;
    expect(bare.payload.gesture).toEqual({ kind: 'report', by: 'U5' });
    const [long] = (await provider.normalizeEnvelope(submission({ note: { note: { value: 'x'.repeat(5_000) } } }), {}, fetchSlack)).records;
    expect(long.payload.gesture.note).toHaveLength(provider.SLACK_REPORT_NOTE_MAX_LENGTH);

    // Another app's view, a mangled form, and other interactions record nothing and read nothing.
    for (const envelope of [
      submission({}, { callback_id: 'some_other_form' }),
      submission({}, { private_metadata: 'not json' }),
      submission({}, { private_metadata: JSON.stringify({ channelId: 'C42' }) }),
      submission({}, { id: '' }),
      interactiveEnvelope({ type: 'block_actions', user: { id: 'U5' }, actions: [] }),
      interactiveEnvelope({ type: 'message_action', callback_id: 'another_shortcut', trigger_id: 't', user: { id: 'U5' }, channel: { id: 'C42' }, message: { ts: REPORTED_TS } }),
      interactiveEnvelope({ type: 'message_action', callback_id: 'report_bug', user: { id: 'U5' }, channel: { id: 'C42' }, message: { ts: REPORTED_TS } }),
    ]) {
      expect((await provider.normalizeEnvelope(envelope, {}, noFetch)).records).toEqual([]);
    }
  });

  it('ignores bot and app posts, edits and other subtypes, group DMs, and control envelopes', async () => {
    const base = { type: 'message', channel: 'C42', user: 'U7', text: 'x', ts: '1712345678.000200' };
    for (const event of [
      { ...base, bot_id: 'B1' },
      { ...base, app_id: 'A1' },
      { ...base, subtype: 'message_changed' },
      { ...base, subtype: 'channel_join' },
      { ...base, channel: 'G1', channel_type: 'mpim' },
      { ...base, type: 'reaction_added' },
      { ...base, text: '' },
      { ...base, user: '' },
      { ...base, ts: 'not-a-ts' },
    ]) {
      expect((await provider.normalizeEnvelope(eventsEnvelope(event), {}, noFetch)).records).toEqual([]);
    }
    expect((await provider.normalizeEnvelope({ type: 'hello', num_connections: 1 })).records).toEqual([]);
    expect((await provider.normalizeEnvelope({ type: 'disconnect', reason: 'refresh_requested' })).records).toEqual([]);
    expect((await provider.normalizeEnvelope(null)).records).toEqual([]);
    expect((await provider.normalizeEnvelope('{"type":"events_api"}')).records).toEqual([]);
  });

  it("records the source's declared drill bot, and only it, as a plain channel message (D-023)", async () => {
    const allowance = { botId: 'B9', appId: 'A9', userId: 'U9', channelId: 'C42' };
    const config = { botId: 'B0', botUserId: 'U0', channels: ['C42', 'C43'], testBotAllowance: allowance };
    const drill = { type: 'message', channel: 'C42', channel_type: 'channel', user: 'U9', bot_id: 'B9', app_id: 'A9', text: 'checkout is broken', ts: '1712345678.000300' };

    const [admitted] = (await provider.normalizeEnvelope(eventsEnvelope(drill), config)).records;
    expect(admitted).toMatchObject({ datatype: 'chat-message', event: 'message', nativeId: 'C42:1712345678.000300' });
    expect(admitted.payload).toMatchObject({ channelId: 'C42', sender: 'U9', text: 'checkout is broken' });
    // The same allowance reaches the package through invokeCapability's args.sourceConfig.
    return provider.invokeCapability({ capability: 'ingress.normalize', args: { envelope: eventsEnvelope(drill), sourceConfig: config } })
      .then(async (result: { records: unknown[] }) => {
        expect(result.records).toHaveLength(1);
        for (const [event, cfg] of [
          [drill, {}], // no allowance declared: the in-app default, every bot post dropped
          [drill, { ...config, testBotAllowance: { ...allowance, appId: '' } }], // incomplete identity
          [{ ...drill, bot_id: 'B8' }, config], // another bot
          [{ ...drill, app_id: 'A8' }, config], // another app
          [{ ...drill, user: 'U8' }, config], // another bot user
          [{ ...drill, channel: 'C43' }, config], // a watched channel, but not the drill's
          [drill, { ...config, channels: ['C43'] }], // the drill's channel is not watched
          [{ ...drill, type: 'app_mention' }, config], // a mention, not a channel message
          [{ ...drill, channel: 'D42', channel_type: 'im' }, { ...config, testBotAllowance: { ...allowance, channelId: 'D42' }, channels: ['D42'] }],
          [{ ...drill, subtype: 'bot_message' }, config],
          [drill, { ...config, botId: 'B9' }], // the allowance can never name this app's own bot
          [drill, { ...config, botUserId: 'U9' }],
        ] as Array<[Record<string, unknown>, Record<string, unknown>]>) {
          expect((await provider.normalizeEnvelope(eventsEnvelope(event), cfg, noFetch)).records).toEqual([]);
        }
      });
  });

  it('records the /papercusp command as a slash-command chat message', async () => {
    const [record] = (await provider.normalizeEnvelope({
      envelope_id: 'env-9',
      type: 'slash_commands',
      payload: { trigger_id: 'trig-1', command: '/papercusp', text: 'triage the export bug', user_id: 'U7', channel_id: 'C42', team_id: 'T1' },
    })).records;
    expect(record).toMatchObject({ event: 'slash-command', nativeId: 'command:trig-1', version: 'slash-command:trig-1' });
    expect(record.payload).toMatchObject({ id: 'trig-1', channelId: 'C42', sender: 'U7', text: '/papercusp triage the export bug' });
    expect(validateDatatypePayload(CHAT_MESSAGE_SCHEMA, record.payload).ok).toBe(true);
  });
});

describe('chat.channels', () => {
  it('pages conversations.list through host.fetch into sorted picker options', async () => {
    const seen: HostFetchRequest[] = [];
    const fetchSlack = async (request: HostFetchRequest) => {
      seen.push(request);
      const cursor = new URL(request.url).searchParams.get('cursor');
      if (!cursor) {
        return json({ ok: true, channels: [{ id: 'C2', name: 'bugs', purpose: { value: 'Bug reports' } }, { id: 'C9', name: 'zz-private', is_private: true }], response_metadata: { next_cursor: 'page2' } });
      }
      return json({ ok: true, channels: [{ id: 'C1', name: 'announcements' }, { id: '', name: 'broken' }], response_metadata: { next_cursor: '' } });
    };
    const result = await provider.listChannels(fetchSlack, {});
    expect(result).toEqual({
      options: [
        { value: 'C1', label: '#announcements' },
        { value: 'C2', label: '#bugs', description: 'Bug reports' },
        { value: 'C9', label: '#zz-private', description: 'Private channel' },
      ],
    });
    expect(seen).toHaveLength(2);
    const first = new URL(seen[0].url);
    expect(first.origin + first.pathname).toBe('https://slack.com/api/conversations.list');
    expect(first.searchParams.get('types')).toBe('public_channel,private_channel');
    expect(first.searchParams.get('exclude_archived')).toBe('true');
    // The daemon never handles a token: host.fetch injects the bot token for slack.com.
    for (const request of seen) expect(Object.keys(request.headers ?? {}).map((h) => h.toLowerCase())).not.toContain('authorization');
  });

  it('stops after the page limit instead of following an endless cursor', async () => {
    let calls = 0;
    const fetchSlack = async () => {
      calls += 1;
      return json({ ok: true, channels: [{ id: `C${calls}`, name: `c${calls}` }], response_metadata: { next_cursor: 'again' } });
    };
    const result = await provider.listChannels(fetchSlack, { types: 'public' });
    expect(calls).toBe(provider.SLACK_CHANNEL_PAGE_LIMIT);
    expect(result.options).toHaveLength(provider.SLACK_CHANNEL_PAGE_LIMIT);
  });

  it('reports a revoked token as an auth error and a 429 as rate-limited', async () => {
    await expect(provider.listChannels(async () => json({ ok: false, error: 'invalid_auth' }))).rejects.toMatchObject({
      message: 'slack_conversations_list_invalid_auth',
      data: { kind: 'auth' },
    });
    await expect(provider.listChannels(async () => json({}, 429, { 'retry-after': '30' }))).rejects.toMatchObject({
      data: { kind: 'rate-limited', retryAfterSeconds: 30 },
    });
  });
});

describe('chat.reply', () => {
  it('posts the text in the thread through host.fetch and returns the new message ts', async () => {
    const seen: HostFetchRequest[] = [];
    const result = await provider.replyInThread(
      async (request: HostFetchRequest) => {
        seen.push(request);
        return json({ ok: true, channel: 'C42', ts: '1712345999.000100' });
      },
      { channelId: 'C42', threadId: '1712345678.000200', text: '  Filed as ASANA-12.  ' },
    );
    expect(result).toEqual({ channelId: 'C42', threadId: '1712345678.000200', messageTs: '1712345999.000100' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ url: 'https://slack.com/api/chat.postMessage', method: 'POST' });
    expect(JSON.parse(seen[0].body ?? '{}')).toEqual({ channel: 'C42', thread_ts: '1712345678.000200', text: 'Filed as ASANA-12.' });
  });

  it('refuses bad coordinates or text before any request', async () => {
    const never = async () => {
      throw new Error('fetched');
    };
    await expect(provider.replyInThread(never, { channelId: '', threadId: '1.2', text: 'x' })).rejects.toThrow('slack_reply_channel_invalid');
    await expect(provider.replyInThread(never, { channelId: 'C1', threadId: 'abc', text: 'x' })).rejects.toThrow('slack_reply_thread_invalid');
    await expect(provider.replyInThread(never, { channelId: 'C1', threadId: '1.2', text: '   ' })).rejects.toThrow('slack_reply_text_invalid');
    await expect(provider.replyInThread(never, { channelId: 'C1', threadId: '1.2', text: 'x'.repeat(4_001) })).rejects.toThrow('slack_reply_text_invalid');
  });

  it('surfaces Slack refusals by their own error code', async () => {
    await expect(
      provider.replyInThread(async () => json({ ok: false, error: 'channel_not_found' }), { channelId: 'C1', threadId: '1.2', text: 'x' }),
    ).rejects.toThrow('slack_chat_post_message_channel_not_found');
  });

  it('refuses a capability it does not declare', async () => {
    await expect(provider.invokeCapability({ capability: 'ticket.create', args: {} }, async () => json({ ok: true }))).rejects.toThrow(
      'provider_capability_unsupported:slack:ticket.create',
    );
  });
});

describe('daemon.mjs (JSON-RPC over stdio)', () => {
  it('describes the manifest provider and routes chat.reply through host.fetch with its call token and source', async () => {
    const child = spawn(process.execPath, ['daemon.mjs'], { cwd: PACKAGE_DIR, stdio: ['pipe', 'pipe', 'inherit'] });
    const replies = new Map<number, (m: { result?: unknown; error?: unknown }) => void>();
    const hostFetches: Array<{ callToken: string; source: string; request: HostFetchRequest }> = [];
    const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + '\n');
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      const message = JSON.parse(line);
      if (message.method === 'host.fetch') {
        hostFetches.push(message.params);
        send({ jsonrpc: '2.0', id: message.id, result: json({ ok: true, channel: 'C42', ts: '1712345999.000100' }) });
        return;
      }
      replies.get(message.id)?.(message);
    });
    const call = (id: number, method: string, params?: unknown) =>
      new Promise<{ result?: unknown; error?: unknown }>((resolveCall) => {
        replies.set(id, resolveCall);
        send({ jsonrpc: '2.0', id, method, params });
      });
    try {
      expect((await call(1, 'papercup.ping')).result).toBe('pong');
      expect((await call(2, 'provider.describe')).result).toEqual(manifest.provider);
      const reply = await call(3, 'provider.invoke', {
        callToken: 'call-123',
        request: { source: 'src-1', capability: 'chat.reply', args: { channelId: 'C42', threadId: '1712345678.000200', text: 'ok' } },
      });
      expect(reply.result).toEqual({ channelId: 'C42', threadId: '1712345678.000200', messageTs: '1712345999.000100' });
      expect(hostFetches).toHaveLength(1);
      expect(hostFetches[0]).toMatchObject({ callToken: 'call-123', source: 'src-1', request: { url: 'https://slack.com/api/chat.postMessage' } });
      const refused = await call(4, 'provider.invoke', { callToken: 'call-124', request: { source: 'src-1', capability: 'mail.send', args: {} } });
      expect(refused.error).toMatchObject({ message: 'provider_capability_unsupported:slack:mail.send' });
      const page = await call(5, 'provider.syncPage', { callToken: 'call-125', request: { source: 'src-1', cursor: null, mode: 'backfill' } });
      expect(page.result).toEqual({ records: [], nextCursor: null, hasMore: false });
      // ingress.normalize gets the call's host.fetch too: a shortcut click opens its form through it.
      const click = await call(6, 'provider.invoke', {
        callToken: 'call-126',
        request: {
          source: 'src-1',
          capability: 'ingress.normalize',
          args: {
            envelope: interactiveEnvelope({ type: 'message_action', callback_id: 'report_bug', trigger_id: 'trig-9', user: { id: 'U5' }, channel: { id: 'C42' }, message: { ts: REPORTED_TS } }),
            sourceConfig: {},
          },
        },
      });
      expect(click.result).toEqual({ records: [] });
      expect(hostFetches).toHaveLength(2);
      expect(hostFetches[1]).toMatchObject({ callToken: 'call-126', source: 'src-1', request: { url: 'https://slack.com/api/views.open', method: 'POST' } });
    } finally {
      child.kill();
    }
  });
});
