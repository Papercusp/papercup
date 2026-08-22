import { describe, expect, it, vi } from 'vitest';
import {
  decodeGoogleGmailNotification,
  ensureGoogleGmailWatch,
  normalizeGoogleGmailMessage,
  syncGoogleGmailSource,
  type GoogleGmailMessage,
} from './google-gmail';
import type { ExternalTriggerSourceRow } from './source-store';

const NOW = new Date('2026-08-22T12:00:00.000Z');

function source(cursor: Record<string, unknown> = {}): ExternalTriggerSourceRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    workspaceId: 'papercusp-workspace',
    kind: 'gmail',
    ownerUserId: '22222222-2222-4222-8222-222222222222',
    credentialRef: 'google-workspace:owner',
    status: 'connected',
    config: {},
    cursor,
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function encoded(value: string): string {
  return Buffer.from(value).toString('base64url');
}

function message(id: string): GoogleGmailMessage {
  return {
    id,
    threadId: `thread-${id}`,
    labelIds: ['INBOX'],
    snippet: `snippet-${id}`,
    internalDate: String(NOW.getTime()),
    payload: {
      mimeType: 'multipart/alternative',
      headers: [
        { name: 'From', value: 'Ada <ada@example.com>' },
        { name: 'To', value: 'Bob <bob@example.com>, "Doe, Jane" <jane@example.com>' },
        { name: 'Subject', value: `Subject ${id}` },
      ],
      parts: [
        { mimeType: 'text/plain', body: { data: encoded(`plain ${id}`) } },
        { mimeType: 'text/html', body: { data: encoded(`<p>html ${id}</p>`) } },
      ],
    },
  };
}

function syncDeps(fetchImpl: typeof fetch) {
  const ingested: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  return {
    ingested,
    updates,
    value: {
      fetch: fetchImpl,
      now: () => NOW,
      apiOrigin: 'https://gmail.test',
      createPersonalSink: vi.fn(async () => ({
        kind: 'personal-vault' as const,
        ref: 'user:owner',
        deliver: async () => undefined,
      })),
      ingest: vi.fn(async (_sql, input) => {
        ingested.push(input as unknown as Record<string, unknown>);
        return { ok: true, event: {} as never, deliveries: [] };
      }),
      updateSource: vi.fn(async (_sql, _workspaceId, _sourceId, input) => {
        updates.push(input as unknown as Record<string, unknown>);
        return source((input.cursor as Record<string, unknown> | undefined) ?? {});
      }),
    },
  };
}

describe('Google Gmail adapter', () => {
  it('normalizes nested MIME bodies and provider headers into email-message', () => {
    expect(normalizeGoogleGmailMessage(message('m-1'))).toEqual({
      id: 'm-1',
      threadId: 'thread-m-1',
      from: 'Ada <ada@example.com>',
      to: ['Bob <bob@example.com>', '"Doe, Jane" <jane@example.com>'],
      subject: 'Subject m-1',
      text: 'plain m-1',
      html: '<p>html m-1</p>',
      snippet: 'snippet-m-1',
      occurredAt: NOW.toISOString(),
      labels: ['INBOX'],
    });
    expect(
      decodeGoogleGmailNotification(
        encoded(
          JSON.stringify({
            emailAddress: 'owner@example.com',
            historyId: '123',
          }),
        ),
      ),
    ).toEqual({ emailAddress: 'owner@example.com', historyId: '123' });
    expect(decodeGoogleGmailNotification(encoded('not-json'))).toBeNull();
  });

  it('renews users.watch while preserving an existing history cursor', async () => {
    const calls: URL[] = [];
    const fetchImpl = vi.fn(async (request: string | URL | Request) => {
      const url = new URL(request instanceof Request ? request.url : request.toString());
      calls.push(url);
      if (url.pathname.endsWith('/profile')) {
        return json({ emailAddress: 'owner@example.com', historyId: 'profile-history' });
      }
      return json({ historyId: 'watch-history', expiration: String(NOW.getTime() + 6 * 86_400_000) });
    }) as unknown as typeof fetch;
    const updates: Array<Record<string, unknown>> = [];

    const result = await ensureGoogleGmailWatch(
      {} as never,
      source({ historyId: 'keep-history', watchExpiration: NOW.toISOString() }),
      'access-token',
      'projects/project/topics/topic',
      {},
      {
        fetch: fetchImpl,
        now: () => NOW,
        apiOrigin: 'https://gmail.test',
        updateSource: vi.fn(async (_sql, _workspaceId, _sourceId, input) => {
          updates.push(input as unknown as Record<string, unknown>);
          return source(input.cursor ?? {});
        }),
      },
    );

    expect(result).toMatchObject({
      renewed: true,
      emailAddress: 'owner@example.com',
      historyId: 'keep-history',
    });
    expect(calls.map((url) => url.pathname)).toEqual(['/gmail/v1/users/me/profile', '/gmail/v1/users/me/watch']);
    expect(updates[0]).toEqual(
      expect.objectContaining({
        status: 'connected',
        cursor: expect.objectContaining({
          emailAddress: 'owner@example.com',
          historyId: 'keep-history',
        }),
        connected: true,
      }),
    );
  });

  it('walks history pages, fetches each added message once, then advances the cursor', async () => {
    const fetchImpl = vi.fn(async (request: string | URL | Request) => {
      const url = new URL(request instanceof Request ? request.url : request.toString());
      if (url.pathname.endsWith('/history') && !url.searchParams.has('pageToken')) {
        return json({
          history: [{ messagesAdded: [{ message: { id: 'm-1' } }] }],
          nextPageToken: 'page-2',
          historyId: 'history-mid',
        });
      }
      if (url.pathname.endsWith('/history')) {
        return json({
          history: [{ messagesAdded: [{ message: { id: 'm-1' } }, { message: { id: 'm-2' } }] }],
          historyId: 'history-new',
        });
      }
      if (url.pathname.endsWith('/messages/m-1')) return json(message('m-1'));
      if (url.pathname.endsWith('/messages/m-2')) return json(message('m-2'));
      throw new Error(`unexpected request ${url}`);
    }) as unknown as typeof fetch;
    const d = syncDeps(fetchImpl);

    const result = await syncGoogleGmailSource(
      {} as never,
      source({ historyId: 'history-old', emailAddress: 'owner@example.com' }),
      'access-token',
      d.value,
    );

    expect(result).toEqual({
      mode: 'incremental',
      messages: 2,
      historyPages: 2,
      messagePages: 0,
      historyId: 'history-new',
    });
    expect(d.ingested.map((input) => input.dedupeKey)).toEqual([
      'gmail:m-1:message.received',
      'gmail:m-2:message.received',
    ]);
    expect(d.updates).toEqual([
      expect.objectContaining({
        status: 'connected',
        cursor: {
          emailAddress: 'owner@example.com',
          historyId: 'history-new',
          lastSyncAt: NOW.toISOString(),
        },
        connected: true,
      }),
    ]);
  });

  it('clears an expired history cursor on 404, full-resyncs, then stores profile historyId', async () => {
    const fetchImpl = vi.fn(async (request: string | URL | Request) => {
      const url = new URL(request instanceof Request ? request.url : request.toString());
      if (url.pathname.endsWith('/history')) {
        return json({ error: { message: 'HistoryId too old' } }, 404);
      }
      if (url.pathname.endsWith('/messages') && !/\/messages\//.test(url.pathname)) {
        return json({ messages: [{ id: 'm-full' }] });
      }
      if (url.pathname.endsWith('/messages/m-full')) return json(message('m-full'));
      if (url.pathname.endsWith('/profile')) {
        return json({ emailAddress: 'owner@example.com', historyId: 'history-after-full' });
      }
      throw new Error(`unexpected request ${url}`);
    }) as unknown as typeof fetch;
    const d = syncDeps(fetchImpl);

    const result = await syncGoogleGmailSource(
      {} as never,
      source({ historyId: 'expired', watchExpiration: '2026-08-28T12:00:00.000Z', keep: 'yes' }),
      'access-token',
      d.value,
    );

    expect(result).toEqual({
      mode: 'full',
      messages: 1,
      historyPages: 0,
      messagePages: 1,
      historyId: 'history-after-full',
    });
    expect(d.updates[0]).toEqual({
      status: 'connecting',
      cursor: { watchExpiration: '2026-08-28T12:00:00.000Z', keep: 'yes' },
      lastError: null,
    });
    expect(d.updates[1]).toEqual(
      expect.objectContaining({
        status: 'connected',
        cursor: {
          watchExpiration: '2026-08-28T12:00:00.000Z',
          keep: 'yes',
          emailAddress: 'owner@example.com',
          historyId: 'history-after-full',
          lastSyncAt: NOW.toISOString(),
        },
      }),
    );
  });
});
