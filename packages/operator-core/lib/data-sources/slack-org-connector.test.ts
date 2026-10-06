/**
 * Slack's report facts (slack-messages-to-bug-reports-2026-10-05 P-005, D-012): what only Slack
 * can say about a reported message — its link, its files as Slack page links, the channel's name
 * and the reporter's and author's display names. Each Slack call that fails costs its own fact.
 */
import { describe, expect, it } from 'vitest';
import type { ExternalTriggerSourceRow } from '../external-triggers/source-store';
import { createSlackChatAdmissionAdapter, SLACK_ORG_DISABLED_ERROR, type SlackOrgDeps } from './slack-org-connector';

const BOT = 'xoxb-secret';
const TS = '1790000000.000100';
const SOURCE = { config: { teamId: 'T1' } } as unknown as ExternalTriggerSourceRow;
const SUBJECT = { channelId: 'CBUGS', ts: TS, threadTs: null, text: null };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const ANSWERS: Record<string, unknown> = {
  'chat.getPermalink': { ok: true, permalink: 'https://acme.slack.com/archives/CBUGS/p1790000000000100' },
  'conversations.history': {
    ok: true,
    messages: [{
      ts: TS,
      user: 'UAUTHOR',
      text: 'checkout is broken',
      user_profile: { display_name: '', real_name: 'Ada Author' },
      files: [
        {
          name: 'trace.png',
          mimetype: 'image/png',
          size: 2048,
          permalink: 'https://acme.slack.com/files/UAUTHOR/F1/trace.png',
          url_private: 'https://files.slack.com/files-pri/T1-F1/trace.png',
        },
        // A file Slack gives no page link for is left out, never linked by its private url.
        { name: 'hidden.log', url_private: 'https://files.slack.com/files-pri/T1-F2/hidden.log' },
      ],
    }],
  },
  'conversations.info': { ok: true, channel: { id: 'CBUGS', name: 'bugs' } },
  'users.info': { ok: true, user: { name: 'rita', real_name: 'Rita Reporter', profile: { display_name: 'rita.r' } } },
};

function fakeSlack(refuse: string[] = [], history?: unknown) {
  const calls: string[] = [];
  const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const authed = new Headers(init?.headers).get('authorization') === `Bearer ${BOT}`;
    // A file download: Slack serves url_private bytes to the bot token only.
    if (url.hostname !== 'slack.test') {
      calls.push(`download ${url.hostname}${url.pathname}${authed ? ' (token)' : ''}`);
      if (!authed) return new Response('not_authed', { status: 403 });
      return new Response(new TextEncoder().encode(`bytes of ${url.pathname.split('/').at(-1)}`), { status: 200 });
    }
    const method = url.pathname.replace(/^\/api\//, '');
    calls.push(method);
    if (!authed) return json({ ok: false, error: 'not_authed' });
    if (refuse.includes(method)) return json({ ok: false, error: 'missing_scope' });
    if (method === 'conversations.history' && history) return json(history);
    if (method === 'conversations.history') expect(url.searchParams.get('latest')).toBe(TS);
    if (method === 'users.info') expect(url.searchParams.get('user')).toBe('UREPORTER');
    return ANSWERS[method] ? json(ANSWERS[method]) : json({ ok: false, error: 'unknown_method' }, 404);
  }) as typeof fetch;
  return { calls, fetch: fetchFake };
}

function adapterFor(slack: ReturnType<typeof fakeSlack>, extra: Partial<SlackOrgDeps> = {}) {
  return createSlackChatAdmissionAdapter(SOURCE, async () => BOT, {
    fetch: slack.fetch,
    apiOrigin: 'https://slack.test',
    isEnabled: async () => true,
    ...extra,
  });
}

describe('Slack report facts (P-005)', () => {
  it('maps the permalink, channel name, reporter and author names, and files as Slack page links', async () => {
    const slack = fakeSlack();
    const facts = await adapterFor(slack).reportFacts!({ subject: SUBJECT, reporterExternalId: 'UREPORTER' });
    expect(facts).toEqual({
      permalink: 'https://acme.slack.com/archives/CBUGS/p1790000000000100',
      channelName: 'bugs',
      reporterDisplayName: 'rita.r',
      author: { externalUserId: 'UAUTHOR', displayName: 'Ada Author' },
      attachments: [{
        name: 'trace.png',
        mimetype: 'image/png',
        size: 2048,
        url: 'https://acme.slack.com/files/UAUTHOR/F1/trace.png',
      }],
    });
    expect(JSON.stringify(facts)).not.toContain('files-pri');
    expect([...slack.calls].sort()).toEqual(['chat.getPermalink', 'conversations.history', 'conversations.info', 'users.info']);
  });

  it('leaves out only the facts whose Slack call is refused', async () => {
    const slack = fakeSlack(['users.info', 'conversations.info']);
    const facts = await adapterFor(slack).reportFacts!({ subject: SUBJECT, reporterExternalId: 'UREPORTER' });
    expect(facts.reporterDisplayName).toBeUndefined();
    expect(facts.channelName).toBeUndefined();
    expect(facts.permalink).toBe('https://acme.slack.com/archives/CBUGS/p1790000000000100');
    expect(facts.author).toEqual({ externalUserId: 'UAUTHOR', displayName: 'Ada Author' });
    expect(facts.attachments).toHaveLength(1);
  });

  it('asks nothing about a reporter it does not know', async () => {
    const slack = fakeSlack();
    const facts = await adapterFor(slack).reportFacts!({ subject: SUBJECT, reporterExternalId: null });
    expect(slack.calls).not.toContain('users.info');
    expect(facts.reporterDisplayName).toBeUndefined();
  });

  it('reads the message once when the facts and the consented files both need it', async () => {
    const slack = fakeSlack();
    const adapter = adapterFor(slack);
    await adapter.fetch(SUBJECT);
    await adapter.reportFacts!({ subject: SUBJECT, reporterExternalId: null });
    expect(slack.calls.filter((call) => call === 'conversations.history')).toHaveLength(1);
  });

  it('makes no Slack call while the org connector is switched off', async () => {
    const slack = fakeSlack();
    await expect(
      adapterFor(slack, { isEnabled: async () => false }).reportFacts!({ subject: SUBJECT, reporterExternalId: 'UREPORTER' }),
    ).rejects.toThrow(SLACK_ORG_DISABLED_ERROR);
    expect(slack.calls).toEqual([]);
  });
});

describe('Slack consented files (P-005; unified D-013, D-048)', () => {
  const file = (id: string, extra: Record<string, unknown>) => ({
    id, name: `${id}.bin`, mimetype: 'application/octet-stream', size: 100,
    url_private: `https://files.slack.com/files-pri/T1-${id}/${id}.bin`, ...extra,
  });
  const historyWith = (files: unknown[]) => ({ ok: true, messages: [{ ts: TS, user: 'UAUTHOR', text: 'see attached', files }] });

  it('downloads each file from Slack with the bot token, tagged for the shared store', async () => {
    const slack = fakeSlack([], historyWith([file('F1', { name: 'trace.log', mimetype: 'text/plain' }), file('F2', { mimetype: 'image/png' })]));
    const files = await adapterFor(slack).consentedFiles!({ subject: SUBJECT, maxBytes: 1_000, limit: 5 });
    expect(files.map((f) => ({ door: f.door, externalId: f.externalId, name: f.name, mime: f.mime, text: new TextDecoder().decode(f.bytes) }))).toEqual([
      { door: 'slack', externalId: 'slack:F1', name: 'trace.log', mime: 'text/plain', text: 'bytes of F1.bin' },
      { door: 'slack', externalId: 'slack:F2', name: 'F2.bin', mime: 'image/png', text: 'bytes of F2.bin' },
    ]);
    expect(slack.calls.filter((call) => call.startsWith('download'))).toEqual([
      'download files.slack.com/files-pri/T1-F1/F1.bin (token)',
      'download files.slack.com/files-pri/T1-F2/F2.bin (token)',
    ]);
  });

  it('never downloads a file over the cap, or past the limit, and never sends the token off Slack', async () => {
    const slack = fakeSlack([], historyWith([
      file('BIG', { size: 5_000 }),
      file('EVIL', { url_private: 'https://attacker.example/steal.bin' }),
      file('PLAIN', { url_private: 'http://files.slack.com/files-pri/T1-PLAIN/plain.bin' }),
      file('OK1', {}),
      file('OK2', {}),
      file('OK3', {}),
    ]));
    const files = await adapterFor(slack).consentedFiles!({ subject: SUBJECT, maxBytes: 1_000, limit: 5 });
    expect(files.map((f) => f.externalId)).toEqual(['slack:OK1', 'slack:OK2']);
    const downloads = slack.calls.filter((call) => call.startsWith('download'));
    expect(downloads).toEqual(['download files.slack.com/files-pri/T1-OK1/OK1.bin (token)', 'download files.slack.com/files-pri/T1-OK2/OK2.bin (token)']);
    expect(slack.calls.join('\n')).not.toContain('attacker.example');
  });

  it('makes no Slack call while the org connector is switched off', async () => {
    const slack = fakeSlack([], historyWith([file('F1', {})]));
    await expect(
      adapterFor(slack, { isEnabled: async () => false }).consentedFiles!({ subject: SUBJECT, maxBytes: 1_000, limit: 5 }),
    ).rejects.toThrow(SLACK_ORG_DISABLED_ERROR);
    expect(slack.calls).toEqual([]);
  });
});
