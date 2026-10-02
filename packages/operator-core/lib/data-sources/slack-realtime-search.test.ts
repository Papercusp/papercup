/**
 * Slack Real-time Search adapter (plan enterprise-data-sources-2026-10-01 P-018,
 * owner ruling D-006). No network: fetch and token storage are injected.
 *
 * The properties under test:
 *   - the adapter calls assistant.search.context with the PRINCIPAL's own user
 *     token, resolved by their mapped provider identity, so Slack enforces what
 *     that person can see;
 *   - Slack's best-first results map to LiveSearchHits with a stable external id,
 *     the author as participant, the permalink as citation and a descending score;
 *   - no connected token, a Slack error or a missing install slug is an error the
 *     live-search layer turns into a per-source failure, never a silent empty hit;
 *   - tokens are stored per provider user id under the data source's credential
 *     field, and only xoxp- user tokens are accepted.
 */
import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { importGraph } from '../search/import-graph';
import type { TokenStorage } from '../oauth/token';
import type { LiveSearchInput } from './live-search-adapter';
import {
  SLACK_SEARCH_CONTEXT_URL,
  SLACK_SEARCH_MAX_LIMIT,
  createSlackRealtimeSearchAdapter,
  mapSlackSearchMessages,
  slackTokenStorageResolver,
  slackTsToIso,
  storeSlackSearchUserToken,
} from './slack-realtime-search';

const CREDENTIAL_REF = 'slack-socket:acme_app';

it('keeps live user-token search independent of trigger ingestion and work-item search', () => {
  const lib = resolve(dirname(new URL(import.meta.url).pathname), '..');
  const graph = importGraph(resolve(lib, 'data-sources/slack-realtime-search.ts'));
  expect(graph.modules.has(resolve(lib, 'external-triggers/slack-credential-ref.ts'))).toBe(true);
  expect(graph.modules.has(resolve(lib, 'external-triggers/ingestion.ts'))).toBe(false);
  expect(graph.modules.has(resolve(lib, 'work-items.ts'))).toBe(false);
});

function input(overrides: Partial<LiveSearchInput> = {}): LiveSearchInput {
  return {
    record: {
      id: 'ds-1', workspaceId: 'ws', kind: 'slack', credentialRef: CREDENTIAL_REF,
      config: { installSlug: 'acme' },
    },
    principalUserId: 'user-alice',
    providerUserId: 'T1:UALICE',
    query: 'cobalt roadmap',
    limit: 4,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function memoryStorage(initial: Record<string, Record<string, unknown>> = {}): TokenStorage & {
  data: Record<string, Record<string, unknown>>;
} {
  const data: Record<string, Record<string, unknown>> = { ...initial };
  return {
    data,
    async read(plugin, harness) { return { ...(data[`${plugin}/${harness}`] ?? {}) }; },
    async update(plugin, harness, patch) {
      data[`${plugin}/${harness}`] = { ...(data[`${plugin}/${harness}`] ?? {}), ...patch };
    },
  };
}

interface Recorded { url: string; init: RequestInit }

function fakeFetch(status: number, body: unknown, recorded: Recorded[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    recorded.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

const MESSAGES = [
  {
    author_user_id: 'UALICE', team_id: 'T1', channel_id: 'CROADMAP', channel_name: 'roadmap',
    message_ts: '1727780000.000100', content: '  The cobalt roadmap review moved to Thursday.  ',
    permalink: 'https://acme.slack.com/archives/CROADMAP/p1727780000000100',
  },
  { author_user_id: 'UBOB', team_id: 'T1', channel_id: 'DBOB', message_ts: '1727780100.000200', content: 'cobalt?' },
  { team_id: 'T1', channel_id: 'CEMPTY', message_ts: '1727780200.000300', content: '   ' },
  { team_id: 'T1', channel_id: 'CNOTS', content: 'no timestamp' },
];

describe('createSlackRealtimeSearchAdapter', () => {
  it('queries assistant.search.context as the principal\'s own user token', async () => {
    const recorded: Recorded[] = [];
    const resolved: LiveSearchInput[] = [];
    const adapter = createSlackRealtimeSearchAdapter({
      fetch: fakeFetch(200, { ok: true, results: { messages: MESSAGES } }, recorded),
      resolveUserToken: async (i) => { resolved.push(i); return 'xoxp-alice'; },
    });
    const hits = await adapter.search(input({ limit: 50 }));

    expect(adapter.kind).toBe('slack');
    expect(resolved[0]).toMatchObject({ principalUserId: 'user-alice', providerUserId: 'T1:UALICE' });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.url).toBe(SLACK_SEARCH_CONTEXT_URL);
    expect(recorded[0]!.init.method).toBe('POST');
    expect((recorded[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer xoxp-alice');
    const sent = JSON.parse(String(recorded[0]!.init.body));
    expect(sent).toMatchObject({
      query: 'cobalt roadmap',
      channel_types: ['public_channel', 'private_channel', 'mpim', 'im'],
      content_types: ['messages'],
      sort: 'score',
    });
    // The caller's limit is clamped to Slack's own maximum.
    expect(sent.limit).toBe(SLACK_SEARCH_MAX_LIMIT);

    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({
      externalId: 'T1:CROADMAP:1727780000.000100',
      title: '#roadmap',
      text: 'The cobalt roadmap review moved to Thursday.',
      occurredAt: '2024-10-01T10:53:20.000Z',
      participants: ['UALICE'],
      permalink: 'https://acme.slack.com/archives/CROADMAP/p1727780000000100',
      score: 1,
    });
    expect(hits[1]).toMatchObject({ externalId: 'T1:DBOB:1727780100.000200', title: 'channel DBOB', permalink: null });
    expect(hits[1]!.score).toBeLessThan(hits[0]!.score);
  });

  it('refuses without calling Slack when the principal has no connected token', async () => {
    const recorded: Recorded[] = [];
    const adapter = createSlackRealtimeSearchAdapter({
      fetch: fakeFetch(200, { ok: true }, recorded),
      resolveUserToken: async () => null,
    });
    await expect(adapter.search(input())).rejects.toThrow('slack_search_user_token_not_connected');
    expect(recorded).toHaveLength(0);
  });

  it('surfaces a Slack error instead of returning an empty hit list', async () => {
    const adapter = createSlackRealtimeSearchAdapter({
      fetch: fakeFetch(200, { ok: false, error: 'missing_scope' }, []),
      resolveUserToken: async () => 'xoxp-alice',
    });
    await expect(adapter.search(input())).rejects.toThrow('slack_search_200:missing_scope');

    const http = createSlackRealtimeSearchAdapter({
      fetch: fakeFetch(429, {}, []),
      resolveUserToken: async () => 'xoxp-alice',
    });
    await expect(http.search(input())).rejects.toThrow('slack_search_429:request_failed');
  });
});

describe('slack user-token storage', () => {
  it('stores per provider user id and resolves only that principal\'s xoxp- token', async () => {
    const storage = memoryStorage();
    await storeSlackSearchUserToken('acme', CREDENTIAL_REF, 'T1:UALICE', ' xoxp-alice ', storage);
    await storeSlackSearchUserToken('acme', CREDENTIAL_REF, 'T1:UBOB', 'xoxp-bob', storage);
    expect(storage.data['slack-socket/acme']).toEqual({
      acme_app_search_user_tokens: { 'T1:UALICE': 'xoxp-alice', 'T1:UBOB': 'xoxp-bob' },
    });

    const resolve = slackTokenStorageResolver(storage);
    expect(await resolve(input())).toBe('xoxp-alice');
    expect(await resolve(input({ providerUserId: 'T1:UCAROL' }))).toBeNull();
  });

  it('rejects a non-user token', async () => {
    const storage = memoryStorage();
    await expect(storeSlackSearchUserToken('acme', CREDENTIAL_REF, 'T1:UALICE', 'xoxb-bot', storage))
      .rejects.toThrow('slack_search_user_token_invalid');
    await expect(storeSlackSearchUserToken('acme', CREDENTIAL_REF, 'T1:UALICE', 'xoxp-', storage))
      .rejects.toThrow('slack_search_user_token_invalid');
    expect(storage.data).toEqual({});
  });

  it('ignores a stored value that is not an xoxp- token', async () => {
    const storage = memoryStorage({ 'slack-socket/acme': { acme_app_search_user_tokens: { 'T1:UALICE': 'xoxb-bot' } } });
    expect(await slackTokenStorageResolver(storage)(input())).toBeNull();
  });

  it('requires the data source to name its Slack install', async () => {
    const resolve = slackTokenStorageResolver(memoryStorage());
    const record = { ...input().record, config: {} };
    await expect(resolve(input({ record }))).rejects.toThrow('slack_search_install_slug_missing');
  });
});

describe('slack message mapping', () => {
  it('drops messages without a channel, timestamp or content', () => {
    expect(mapSlackSearchMessages(MESSAGES).map((h) => h.externalId)).toEqual([
      'T1:CROADMAP:1727780000.000100',
      'T1:DBOB:1727780100.000200',
    ]);
  });

  it('converts a Slack ts to an ISO instant, or null', () => {
    expect(slackTsToIso('1727780000.000100')).toBe('2024-10-01T10:53:20.000Z');
    expect(slackTsToIso('not-a-ts')).toBeNull();
    expect(slackTsToIso(undefined)).toBeNull();
    expect(slackTsToIso('0')).toBeNull();
  });
});
