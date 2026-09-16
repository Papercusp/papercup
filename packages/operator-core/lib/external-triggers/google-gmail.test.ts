import { describe, expect, it, vi } from 'vitest';
import {
  buildGoogleGmailRawMessage,
  createGoogleGmailDraft,
  DEFAULT_BACKFILL_MESSAGES_PER_SYNC,
  decodeGoogleGmailNotification,
  ensureGoogleGmailWatch,
  googleGmailBackfillBudget,
  googleGmailBackfillParked,
  MIN_BACKFILL_MESSAGES_PER_SYNC,
  normalizeGoogleGmailMessage,
  syncGoogleGmailSource,
  updateGoogleGmailDraft,
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
    providerAccountId: 'owner@example.com',
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
        { name: 'Message-ID', value: `<${id}@example.com>` },
        { name: 'References', value: '<root@example.com>' },
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
      // Unconfigured for app delivery, stated explicitly: these cases are about
      // paging and cursors. Registration coverage lives in
      // app-data-producer/adapter-registration.test.ts.
      createAppSink: vi.fn(async () => null),
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
      messageId: '<m-1@example.com>',
      references: '<root@example.com>',
      text: 'plain m-1',
      html: '<p>html m-1</p>',
      snippet: 'snippet-m-1',
      occurredAt: NOW.toISOString(),
      labels: ['INBOX'],
      direction: 'inbound',
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

  it('creates an RFC 2822 Gmail draft in the originating thread and never calls send', async () => {
    const fetchImpl = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const url = new URL(request instanceof Request ? request.url : request.toString());
      expect(url.pathname).toBe('/gmail/v1/users/me/drafts');
      expect(init?.method).toBe('POST');
      const posted = JSON.parse(String(init?.body)) as { message: { raw: string; threadId: string } };
      expect(posted.message.threadId).toBe('thread-m-1');
      const raw = Buffer.from(posted.message.raw, 'base64url').toString('utf8');
      expect(raw).toContain('To: Ada <ada@example.com>\r\n');
      expect(raw).toContain('Subject: Re: Subject m-1\r\n');
      expect(raw).toContain('In-Reply-To: <m-1@example.com>\r\n');
      expect(raw).toContain('References: <root@example.com> <m-1@example.com>\r\n');
      expect(raw).toContain('\r\n\r\nDraft response');
      return json({ id: 'draft-1', message: { id: 'draft-message-1', threadId: 'thread-m-1' } });
    }) as unknown as typeof fetch;

    await expect(
      createGoogleGmailDraft(
        'access-token',
        {
          to: 'Ada <ada@example.com>',
          subject: 'Re: Subject m-1',
          text: 'Draft response',
          threadId: 'thread-m-1',
          inReplyTo: '<m-1@example.com>',
          references: '<root@example.com>',
        },
        { fetch: fetchImpl, apiOrigin: 'https://gmail.test' },
      ),
    ).resolves.toEqual({
      draftId: 'draft-1',
      messageId: 'draft-message-1',
      threadId: 'thread-m-1',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('revises an existing draft in place via PUT, preserving its draft id', async () => {
    const fetchImpl = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const url = new URL(request instanceof Request ? request.url : request.toString());
      // The id belongs in the PATH — a POST to the collection would create a
      // SECOND draft and leave the original untouched.
      expect(url.pathname).toBe('/gmail/v1/users/me/drafts/draft-1');
      expect(init?.method).toBe('PUT');
      const put = JSON.parse(String(init?.body)) as { id: string; message: { raw: string } };
      expect(put.id).toBe('draft-1');
      const raw = Buffer.from(put.message.raw, 'base64url').toString('utf8');
      expect(raw).toContain('Subject: Revised subject\r\n');
      expect(raw).toContain('\r\n\r\nRevised body');
      return json({ id: 'draft-1', message: { id: 'draft-message-1', threadId: 'thread-m-1' } });
    }) as unknown as typeof fetch;

    await expect(
      updateGoogleGmailDraft(
        'access-token',
        'draft-1',
        {
          to: 'Ada <ada@example.com>',
          subject: 'Revised subject',
          text: 'Revised body',
          threadId: 'thread-m-1',
        },
        { fetch: fetchImpl, apiOrigin: 'https://gmail.test' },
      ),
    ).resolves.toEqual({
      draftId: 'draft-1',
      messageId: 'draft-message-1',
      threadId: 'thread-m-1',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('carries an attachment onto an updated draft through the shared multipart encoder', async () => {
    // The reason this seam exists: 20 real drafts were written by the
    // text/plain-only encoder and are missing their resume. Revising one must
    // gain the attachment without a separate attachment code path.
    const fetchImpl = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const put = JSON.parse(String(init?.body)) as { message: { raw: string } };
      const raw = Buffer.from(put.message.raw, 'base64url').toString('utf8');
      expect(raw).toContain('Content-Type: multipart/mixed; boundary=');
      // RFC 2045 permits an unquoted token here, which is what the MailComposer
      // encoder emits; the old hand-rolled one always quoted. Assert the
      // FILENAME reaches the part, not one encoder's quoting style.
      expect(raw).toMatch(/name="?resume\.pdf"?/);
      expect(raw).toContain('Content-Transfer-Encoding: base64');
      // The PDF bytes must survive the round trip intact.
      expect(raw).toContain(Buffer.from('%PDF-1.7 fixture').toString('base64'));
      return json({ id: 'draft-9', message: { id: 'msg-9', threadId: 'thread-9' } });
    }) as unknown as typeof fetch;

    await expect(
      updateGoogleGmailDraft(
        'access-token',
        'draft-9',
        {
          to: 'hiring@example.com',
          subject: 'Application',
          text: 'Body',
          attachments: [
            {
              filename: 'resume.pdf',
              contentType: 'application/pdf',
              content: Buffer.from('%PDF-1.7 fixture'),
            },
          ],
        },
        { fetch: fetchImpl, apiOrigin: 'https://gmail.test' },
      ),
    ).resolves.toMatchObject({ draftId: 'draft-9' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws rather than returning a plausible result when the API names a different draft', async () => {
    // A response naming another draft means a new one was created and the
    // original is still sitting in the mailbox unedited. Returning it would
    // report a successful in-place edit that never happened.
    const fetchImpl = vi.fn(async () =>
      json({ id: 'some-other-draft', message: { id: 'msg-x', threadId: 'thread-x' } }),
    ) as unknown as typeof fetch;

    await expect(
      updateGoogleGmailDraft(
        'access-token',
        'draft-1',
        { to: 'ada@example.com', subject: 'S', text: 'T' },
        { fetch: fetchImpl, apiOrigin: 'https://gmail.test' },
      ),
    ).rejects.toThrow('google_gmail_draft_id_mismatch');
  });

  it('refuses a blank draft id without issuing a request', async () => {
    const fetchImpl = vi.fn(async () => json({})) as unknown as typeof fetch;

    await expect(
      updateGoogleGmailDraft(
        'access-token',
        '   ',
        { to: 'ada@example.com', subject: 'S', text: 'T' },
        { fetch: fetchImpl, apiOrigin: 'https://gmail.test' },
      ),
    ).rejects.toThrow('google_gmail_draft_id_required');
    expect(fetchImpl).not.toHaveBeenCalled();
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
      backfill: null,
      messagesGone: 0,
      resyncReason: null,
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

  it('skips a message deleted between history.list and messages.get instead of full-resyncing (EI-23429618437235533)', async () => {
    const fetchImpl = vi.fn(async (request: string | URL | Request) => {
      const url = new URL(request instanceof Request ? request.url : request.toString());
      if (url.pathname.endsWith('/history')) {
        return json({
          history: [{ messagesAdded: [{ message: { id: 'm-gone' } }, { message: { id: 'm-2' } }] }],
          historyId: 'history-new',
        });
      }
      // A discarded draft: listed in history, gone by the time it is fetched.
      if (url.pathname.endsWith('/messages/m-gone')) return json({ error: { message: 'Requested entity was not found.' } }, 404);
      if (url.pathname.endsWith('/messages/m-2')) return json(message('m-2'));
      throw new Error(`unexpected request ${url}`);
    }) as unknown as typeof fetch;
    const d = syncDeps(fetchImpl);
    const backfill = { status: 'pending', pageToken: 'page-4', pages: 3, messages: 666, startedAt: '2026-09-16T02:02:51.000Z', throttledUntil: NOW.toISOString(), throttleCount: 1 };

    const result = await syncGoogleGmailSource(
      {} as never,
      source({ historyId: 'history-old', emailAddress: 'owner@example.com', backfill: { ...backfill, throttledUntil: new Date(NOW.getTime() + 60_000).toISOString(), status: 'throttled' } }),
      'access-token',
      d.value,
    );

    // The old code caught ANY 404 as "history too old", cleared the cursor and
    // restarted the resumable backfill from zero every few minutes.
    expect(result).toMatchObject({ mode: 'incremental', messages: 1, messagesGone: 1, resyncReason: null, historyId: 'history-new' });
    expect(d.ingested.map((input) => input.dedupeKey)).toEqual(['gmail:m-2:message.received']);
    expect(d.updates).toHaveLength(1);
    expect((d.updates[0]!.cursor as Record<string, unknown>).backfill).toMatchObject({ status: 'throttled', pages: 3, messages: 666, startedAt: '2026-09-16T02:02:51.000Z' });
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

    const completeBackfill = {
      status: 'complete',
      pageToken: null,
      pages: 1,
      messages: 1,
      startedAt: NOW.toISOString(),
      completedAt: NOW.toISOString(),
      throttledUntil: null,
      throttleCount: 0,
    };
    expect(result).toEqual({
      mode: 'full',
      messages: 1,
      historyPages: 0,
      messagePages: 1,
      historyId: 'history-after-full',
      backfill: completeBackfill,
      messagesGone: 0,
      resyncReason: { operation: 'history_list', status: 404 },
    });
    expect(d.updates[0]).toEqual({
      status: 'connecting',
      cursor: { watchExpiration: '2026-08-28T12:00:00.000Z', keep: 'yes' },
      lastError: null,
    });
    // The profile historyId is pinned BEFORE the historical walk begins.
    expect(d.updates[1]).toEqual({
      status: 'connecting',
      cursor: {
        watchExpiration: '2026-08-28T12:00:00.000Z',
        keep: 'yes',
        emailAddress: 'owner@example.com',
        historyId: 'history-after-full',
        backfill: { ...completeBackfill, status: 'pending', pages: 0, messages: 0, completedAt: null },
      },
      lastError: null,
    });
    expect(d.updates[2]).toEqual(
      expect.objectContaining({ status: 'connecting', cursor: expect.objectContaining({ backfill: completeBackfill }) }),
    );
    expect(d.updates[3]).toEqual(
      expect.objectContaining({
        status: 'connected',
        cursor: {
          watchExpiration: '2026-08-28T12:00:00.000Z',
          keep: 'yes',
          emailAddress: 'owner@example.com',
          historyId: 'history-after-full',
          backfill: completeBackfill,
          lastSyncAt: NOW.toISOString(),
        },
      }),
    );
  });

  it('resumes an interrupted initial backfill from its checkpointed page instead of restarting (EI-23378389605835281)', async () => {
    const listCalls: URLSearchParams[] = [];
    const fetchImpl = vi.fn(async (request: string | URL | Request) => {
      const url = new URL(request instanceof Request ? request.url : request.toString());
      if (url.pathname.endsWith('/profile')) return json({ emailAddress: 'owner@example.com', historyId: 'h-1' });
      if (url.pathname.endsWith('/history')) return json({ historyId: 'h-2' });
      if (url.pathname.endsWith('/messages')) {
        listCalls.push(url.searchParams);
        return url.searchParams.get('pageToken') === 'page-2'
          ? json({ messages: [{ id: 'm3' }] })
          : json({ messages: [{ id: 'm1' }, { id: 'm2' }], nextPageToken: 'page-2' });
      }
      const id = url.pathname.split('/').pop() ?? '';
      if (/^m\d$/.test(id)) return json(message(id));
      throw new Error(`unexpected request ${url}`);
    }) as unknown as typeof fetch;
    const d = syncDeps(fetchImpl);
    const deps = { ...d.value, backfillMessagesPerSync: 2 };

    const first = await syncGoogleGmailSource({} as never, source({}), 'access-token', deps);
    expect(first).toMatchObject({ mode: 'full', messages: 2, historyId: 'h-1' });
    expect(first.backfill).toMatchObject({ status: 'pending', pageToken: 'page-2', pages: 1, messages: 2 });
    expect(listCalls.map((p) => p.get('maxResults'))).toEqual(['2']);

    // Simulate the interruption: the next poll starts from the persisted cursor only.
    const persisted = d.updates.at(-1)?.cursor as Record<string, unknown>;
    expect(persisted).toMatchObject({ historyId: 'h-1', backfill: { pageToken: 'page-2' } });
    const second = await syncGoogleGmailSource({} as never, source(persisted), 'access-token', deps);
    expect(second).toMatchObject({ mode: 'incremental', messages: 1, historyId: 'h-2' });
    expect(second.backfill).toMatchObject({ status: 'complete', pageToken: null, pages: 2, messages: 3 });
    expect(listCalls.map((p) => p.get('pageToken'))).toEqual([null, 'page-2']);
    expect(d.ingested.map((input) => input.externalId)).toEqual(['m1', 'm2', 'm3']);
  });

  it('halves the backfill budget per consecutive quota throttle and restores the ceiling on a clean chunk (WI-10001549)', async () => {
    // A 158-message chunk tripped the live per-user per-minute quota, so the
    // 200 default was above what the project allows; 100 is the new ceiling.
    expect(DEFAULT_BACKFILL_MESSAGES_PER_SYNC).toBe(100);
    expect(MIN_BACKFILL_MESSAGES_PER_SYNC).toBe(25);
    expect([0, 1, 2, 3, 9].map((count) => googleGmailBackfillBudget(100, count))).toEqual([100, 50, 25, 25, 25]);
    expect(googleGmailBackfillBudget(10, 1)).toBe(10); // a ceiling below the floor is never raised
    expect(googleGmailBackfillBudget(200, 1)).toBe(100);

    const listCalls: URLSearchParams[] = [];
    const fetchImpl = vi.fn(async (request: string | URL | Request) => {
      const url = new URL(request instanceof Request ? request.url : request.toString());
      if (url.pathname.endsWith('/history')) return json({ historyId: 'h-1' });
      if (url.pathname.endsWith('/messages')) {
        listCalls.push(url.searchParams);
        const size = Number(url.searchParams.get('maxResults'));
        const page = url.searchParams.get('pageToken') ?? 'p0';
        return json({
          messages: Array.from({ length: size }, (_, i) => ({ id: `m-${page}-${i}` })),
          nextPageToken: `${page}n`,
        });
      }
      const id = url.pathname.split('/').pop() ?? '';
      if (id.startsWith('m-')) return json(message(id));
      throw new Error(`unexpected request ${url}`);
    }) as unknown as typeof fetch;
    const d = syncDeps(fetchImpl);
    // Ceiling 50 halves to exactly one 25-message page; a ceiling under the
    // floor (as in the earlier resume test's budget of 2) is never halved.
    const deps = { ...d.value, backfillMessagesPerSync: 50 };
    const afterThrottle = {
      status: 'throttled',
      pageToken: 'p0',
      pages: 0,
      messages: 0,
      startedAt: NOW.toISOString(),
      completedAt: null,
      throttledUntil: new Date(NOW.getTime() - 1_000).toISOString(), // cool-down just lifted
      throttleCount: 1,
    };
    expect(googleGmailBackfillParked(source({ backfill: afterThrottle }), NOW)).toBe(false);
    expect(
      googleGmailBackfillParked(
        source({ backfill: { ...afterThrottle, throttledUntil: new Date(NOW.getTime() + 1_000).toISOString() } }),
        NOW,
      ),
    ).toBe(true);

    // One throttle behind us: this chunk walks HALF the ceiling (50 → 25), one page...
    const shrunk = await syncGoogleGmailSource({} as never, source({ historyId: 'h-1', backfill: afterThrottle }), 'access-token', deps);
    expect(shrunk.messages).toBe(25);
    expect(listCalls.map((p) => p.get('maxResults'))).toEqual(['25']);
    expect(shrunk.backfill).toMatchObject({ status: 'pending', pageToken: 'p0n', throttleCount: 0 });

    // ...and a clean chunk resets throttleCount, so the next one is back at the
    // ceiling — walked as two 25-message pages so a mid-chunk trip re-walks ≤24 gets.
    const restored = await syncGoogleGmailSource(
      {} as never,
      source(d.updates.at(-1)?.cursor as Record<string, unknown>),
      'access-token',
      deps,
    );
    expect(restored.messages).toBe(50);
    expect(listCalls.map((p) => p.get('maxResults'))).toEqual(['25', '25', '25']);
    expect(listCalls.map((p) => p.get('pageToken'))).toEqual(['p0', 'p0n', 'p0nn']);
  });

  it('parks the backfill with a cool-down on a per-user quota 403 and keeps the source connected', async () => {
    let listCalls = 0;
    const fetchImpl = vi.fn(async (request: string | URL | Request) => {
      const url = new URL(request instanceof Request ? request.url : request.toString());
      if (url.pathname.endsWith('/history')) return json({ historyId: 'h-1' });
      if (url.pathname.endsWith('/messages')) {
        listCalls += 1;
        return json(
          { error: { message: "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user'" } },
          403,
        );
      }
      throw new Error(`unexpected request ${url}`);
    }) as unknown as typeof fetch;
    const d = syncDeps(fetchImpl);
    const pending = {
      status: 'pending',
      pageToken: 'page-9',
      pages: 1,
      messages: 5,
      startedAt: NOW.toISOString(),
      completedAt: null,
      throttledUntil: null,
      throttleCount: 0,
    };

    const throttled = await syncGoogleGmailSource(
      {} as never,
      source({ historyId: 'h-1', backfill: pending }),
      'access-token',
      d.value,
    );
    expect(throttled.backfill).toEqual({
      ...pending,
      status: 'throttled',
      throttledUntil: new Date(NOW.getTime() + 60_000).toISOString(),
      throttleCount: 1,
    });
    expect(d.updates.at(-1)).toEqual(expect.objectContaining({ status: 'connected', lastError: null }));
    expect(listCalls).toBe(1);

    // Still inside the cool-down: the chunk is skipped, nothing else changes.
    const parked = await syncGoogleGmailSource(
      {} as never,
      source(d.updates.at(-1)?.cursor as Record<string, unknown>),
      'access-token',
      d.value,
    );
    expect(parked.backfill?.status).toBe('throttled');
    expect(listCalls).toBe(1);
  });
});

describe('buildGoogleGmailRawMessage attachments', () => {
  const decode = (raw: string) => Buffer.from(raw, 'base64url').toString('utf8');
  const BASE = { to: ['hiring@company.example'], subject: 'Senior Engineer', text: 'Hello.' };
  const pdf = (content = '%PDF-1.7 bytes') => ({
    filename: 'resume.pdf',
    contentType: 'application/pdf',
    content: Buffer.from(content),
  });

  it('stays single-part text/plain when no attachment is supplied', async () => {
    const without = await buildGoogleGmailRawMessage(BASE);
    const empty = await buildGoogleGmailRawMessage({ ...BASE, attachments: [] });

    expect(decode(without.raw)).toMatch(/Content-Type: text\/plain; charset=utf-8/i);
    expect(decode(without.raw)).not.toContain('multipart/mixed');
    // An empty array must not flip the encoding — that is what makes the field
    // safe to add. Asserted as the INVARIANT rather than byte-equality: since
    // the encoder became MailComposer, each build carries its own random
    // Message-ID, so two builds of the same input are no longer byte-identical
    // (Gmail discards that header and substitutes its own — verified live).
    expect(decode(empty.raw)).not.toContain('multipart/mixed');
    expect(decode(empty.raw)).toContain('Hello.');
  });

  it('encodes multipart/mixed with the body first and the file base64 after it', async () => {
    const { raw } = await buildGoogleGmailRawMessage({ ...BASE, attachments: [pdf()] });
    const mime = decode(raw);

    const boundary = /boundary="([^"]+)"/.exec(mime)?.[1];
    expect(boundary).toBeTruthy();
    expect(mime).toContain(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    // RFC 2045 lets a filename that is a bare token go unquoted, so accept either.
    expect(mime).toMatch(/Content-Disposition: attachment; filename="?resume\.pdf"?/);
    expect(mime).toContain('Content-Transfer-Encoding: base64');
    expect(mime).toContain(Buffer.from('%PDF-1.7 bytes').toString('base64'));
    // The text part must precede the file, and the envelope must terminate.
    expect(mime.indexOf('Hello.')).toBeLessThan(mime.indexOf('resume.pdf'));
    expect(mime.trimEnd().endsWith(`--${boundary}--`)).toBe(true);
    // CRLF line endings are required by RFC 2822; a bare \n corrupts the parts.
    expect(mime).toContain(`\r\n--${boundary}\r\n`);
  });

  it('wraps base64 at 76 columns so a strict receiving MTA cannot reject the line', async () => {
    const { raw } = await buildGoogleGmailRawMessage({
      ...BASE,
      attachments: [pdf('x'.repeat(5_000))],
    });
    const mime = decode(raw);
    // Scoped to the ENCODED PAYLOAD lines: the boundary header legitimately runs
    // past 76 (RFC 2045 caps the encoded body, not headers), so asserting over
    // every line would fail on a correct message.
    const payloadLines = mime
      .split('\r\n')
      .filter((line) => line.length > 20 && /^[A-Za-z0-9+/]+={0,2}$/.test(line));

    expect(payloadLines.length).toBeGreaterThan(1);
    expect(Math.max(...payloadLines.map((line) => line.length))).toBeLessThanOrEqual(76);
  });

  it('refuses a filename that would break out of its own header parameter', async () => {
    for (const filename of ['evil".pdf', 'a;b.pdf', 'back\\slash.pdf']) {
      await expect(
        buildGoogleGmailRawMessage({ ...BASE, attachments: [{ ...pdf(), filename }] }),
      ).rejects.toThrow(/attachment_filename_invalid/);
    }
    // A CRLF is header injection proper, and safeHeader rejects it first.
    await expect(
      buildGoogleGmailRawMessage({ ...BASE, attachments: [{ ...pdf(), filename: 'a\r\nBcc: x@y.z' }] }),
    ).rejects.toThrow(/attachment_filename_invalid/);
  });

  it('refuses a malformed content type, an empty file, and an over-long list', async () => {
    await expect(
      buildGoogleGmailRawMessage({ ...BASE, attachments: [{ ...pdf(), contentType: 'not-a-mime' }] }),
    ).rejects.toThrow(/attachment_content_type_invalid/);

    await expect(
      buildGoogleGmailRawMessage({
        ...BASE,
        attachments: [{ ...pdf(), content: Buffer.alloc(0) }],
      }),
    ).rejects.toThrow(/attachment_content_invalid/);

    await expect(
      buildGoogleGmailRawMessage({ ...BASE, attachments: Array.from({ length: 11 }, () => pdf()) }),
    ).rejects.toThrow(/attachments_too_many/);
  });

  it('RFC 2047-encodes a non-ASCII subject instead of shipping raw UTF-8 bytes', async () => {
    // The hand-rolled encoder this replaced emitted the subject verbatim, so a
    // non-ASCII one went out as raw 8-bit bytes in a header — an RFC 5322
    // violation that some MTAs mangle or reject. Verified against live Gmail on
    // 2026-09-16: the encoded form round-trips back to the original text.
    const { raw } = await buildGoogleGmailRawMessage({
      ...BASE,
      subject: 'Café — naïve résumé ✓',
    });
    const mime = decode(raw);

    expect(mime).toMatch(/^Subject: =\?UTF-8\?/m);
    expect(mime).not.toContain('Subject: Café');
  });

  it('declares a real transfer-encoding for a non-ASCII body rather than blanket 8bit', async () => {
    const { raw } = await buildGoogleGmailRawMessage({ ...BASE, text: 'Bonjour — café ✓' });
    const mime = decode(raw);

    // Any of quoted-printable/base64 is correct; what must NOT survive is the
    // previous unconditional `8bit`, which declares bytes no 7-bit MTA may relay.
    expect(mime).toMatch(/Content-Transfer-Encoding: (quoted-printable|base64)/);
    expect(mime).not.toContain('Content-Transfer-Encoding: 8bit');
  });

  it('still threads a reply that carries an attachment', async () => {
    const { raw, threadId } = await buildGoogleGmailRawMessage({
      ...BASE,
      threadId: 'thread-9',
      inReplyTo: '<prior@mail.example>',
      attachments: [pdf()],
    });
    const mime = decode(raw);

    // Both halves of threading must survive the multipart branch (see the
    // builder's own note: supplying only one lands the message outside the thread).
    expect(threadId).toBe('thread-9');
    expect(mime).toContain('In-Reply-To: <prior@mail.example>');
    expect(mime).toContain('References: <prior@mail.example>');
    expect(mime).toContain('multipart/mixed');
  });
});
