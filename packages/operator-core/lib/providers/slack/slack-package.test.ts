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
      expect.arrayContaining(['chat:write', 'channels:read', 'groups:read', 'channels:history', 'app_mentions:read']),
    );
    expect(definition.settings.event_subscriptions.bot_events).toEqual(
      expect.arrayContaining(['app_mention', 'message.channels', 'message.groups', 'message.im']),
    );
  });
});

describe('ingress.normalize', () => {
  it('records a channel post as a chat-message with its channel, author and text', () => {
    const result = provider.normalizeEnvelope(
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

  it('keeps a reply in its thread and names the thread root', () => {
    const [record] = provider.normalizeEnvelope(
      eventsEnvelope({ type: 'message', channel: 'C42', user: 'U7', text: 'Still broken', ts: '1712345700.000100', thread_ts: '1712345678.000200' }),
    ).records;
    expect(record.payload.threadId).toBe('1712345678.000200');
    expect(record.payload.extensions.slack.threadTs).toBe('1712345678.000200');
  });

  it('distinguishes mentions and direct messages, and delivers a mention and its channel post separately', () => {
    const mention = provider.normalizeEnvelope(
      eventsEnvelope({ type: 'app_mention', channel: 'C42', user: 'U7', text: '<@UBOT> help', ts: '1712345678.000200' }),
    ).records[0];
    const post = provider.normalizeEnvelope(
      eventsEnvelope({ type: 'message', channel: 'C42', channel_type: 'channel', user: 'U7', text: '<@UBOT> help', ts: '1712345678.000200' }),
    ).records[0];
    expect(mention.event).toBe('mention');
    expect(post.event).toBe('message');
    expect(mention.nativeId).toBe(post.nativeId);
    expect(mention.version).not.toBe(post.version);
    const dm = provider.normalizeEnvelope(
      eventsEnvelope({ type: 'message', channel: 'D1', channel_type: 'im', user: 'U7', text: 'hi', ts: '1712345678.000300' }),
    ).records[0];
    expect(dm.event).toBe('dm');
  });

  it('ignores bot and app posts, edits and other subtypes, group DMs, and control envelopes', () => {
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
      expect(provider.normalizeEnvelope(eventsEnvelope(event)).records).toEqual([]);
    }
    expect(provider.normalizeEnvelope({ type: 'hello', num_connections: 1 }).records).toEqual([]);
    expect(provider.normalizeEnvelope({ type: 'disconnect', reason: 'refresh_requested' }).records).toEqual([]);
    expect(provider.normalizeEnvelope(null).records).toEqual([]);
    expect(provider.normalizeEnvelope('{"type":"events_api"}').records).toEqual([]);
  });

  it('records the /papercusp command as a slash-command chat message', () => {
    const [record] = provider.normalizeEnvelope({
      envelope_id: 'env-9',
      type: 'slash_commands',
      payload: { trigger_id: 'trig-1', command: '/papercusp', text: 'triage the export bug', user_id: 'U7', channel_id: 'C42', team_id: 'T1' },
    }).records;
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
    } finally {
      child.kill();
    }
  });
});
