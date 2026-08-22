import { describe, expect, it, vi } from 'vitest';
import {
  normalizeGoogleCalendarEvent,
  syncGoogleCalendarSource,
  type GoogleCalendarEvent,
} from './google-calendar';
import type { ExternalTriggerSourceRow } from './source-store';

const NOW = new Date('2026-08-22T12:00:00.000Z');

function source(cursor: Record<string, unknown> = {}): ExternalTriggerSourceRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    workspaceId: 'papercusp-workspace',
    kind: 'gcal',
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

function deps(fetchImpl: typeof fetch) {
  const ingested: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  return {
    ingested,
    updates,
    value: {
      fetch: fetchImpl,
      now: () => NOW,
      apiOrigin: 'https://calendar.test',
      createPersonalSink: vi.fn(async () => ({
        kind: 'personal-vault' as const,
        ref: 'user:owner',
        deliver: async () => undefined,
      })),
      ingest: vi.fn(async (_sql, input) => {
        ingested.push(input as unknown as Record<string, unknown>);
        return {
          ok: true,
          event: {} as never,
          deliveries: [],
        };
      }),
      updateSource: vi.fn(async (_sql, _workspaceId, _sourceId, input) => {
        updates.push(input as unknown as Record<string, unknown>);
        return source((input.cursor as Record<string, unknown> | undefined) ?? {});
      }),
    },
  };
}

describe('Google Calendar incremental adapter', () => {
  it('walks incremental pages without forbidden window params, classifies changes, and emits the due window', async () => {
    const urls: URL[] = [];
    const fetchImpl = vi.fn(async (request: string | URL | Request) => {
      const url = new URL(request instanceof Request ? request.url : request.toString());
      urls.push(url);
      if (url.searchParams.get('syncToken') === 'sync-old' && !url.searchParams.has('pageToken')) {
        return json({
          items: [{
            id: 'created-1',
            created: '2026-08-22T11:59:30.000Z',
            updated: '2026-08-22T11:59:40.000Z',
            summary: 'New meeting',
            start: { dateTime: '2026-08-22T16:00:00.000Z' },
            end: { dateTime: '2026-08-22T16:30:00.000Z' },
          }],
          nextPageToken: 'page-2',
        });
      }
      if (url.searchParams.get('pageToken') === 'page-2') {
        return json({
          items: [{
            id: 'updated-1',
            created: '2026-08-20T08:00:00.000Z',
            updated: '2026-08-22T11:58:00.000Z',
            summary: 'Changed meeting',
          }],
          nextSyncToken: 'sync-new',
        });
      }
      expect(url.searchParams.get('singleEvents')).toBe('true');
      return json({
        items: [{
          id: 'due-1',
          updated: '2026-08-22T11:00:00.000Z',
          summary: 'Due meeting',
          organizer: { email: 'owner@example.com' },
          attendees: [{ email: 'ada@example.com', displayName: 'Ada' }],
          start: { dateTime: '2026-08-22T12:14:00.000Z' },
          end: { dateTime: '2026-08-22T12:44:00.000Z' },
        }],
      });
    }) as unknown as typeof fetch;
    const d = deps(fetchImpl);

    const result = await syncGoogleCalendarSource(
      {} as never,
      source({ syncToken: 'sync-old', lastSyncAt: '2026-08-22T11:59:00.000Z' }),
      'access-token',
      {},
      d.value,
    );

    expect(result).toEqual({
      mode: 'incremental',
      created: 1,
      updated: 1,
      upcoming: 1,
      changePages: 2,
      upcomingPages: 1,
      syncToken: 'sync-new',
    });
    for (const url of urls.slice(0, 2)) {
      expect(url.searchParams.has('timeMin')).toBe(false);
      expect(url.searchParams.has('timeMax')).toBe(false);
      expect(url.searchParams.has('orderBy')).toBe(false);
    }
    expect(urls[2].searchParams.get('timeMin')).toBe(NOW.toISOString());
    expect(urls[2].searchParams.get('timeMax')).toBe('2026-08-22T12:15:00.000Z');
    expect(d.ingested.map((input) => input.event)).toEqual([
      'event-created',
      'event-updated',
      'event-upcoming',
    ]);
    expect(d.ingested.map((input) => input.dedupeKey)).toEqual([
      'gcal:created-1:event-created:2026-08-22T11:59:40.000Z',
      'gcal:updated-1:event-updated:2026-08-22T11:58:00.000Z',
      'gcal:due-1:event-upcoming:2026-08-22T12:14:00.000Z',
    ]);
    expect(d.updates).toEqual([
      expect.objectContaining({
        status: 'connected',
        cursor: {
          syncToken: 'sync-new',
          lastSyncAt: NOW.toISOString(),
        },
        connected: true,
      }),
    ]);
  });

  it('clears an expired sync token on 410 and performs one full resync', async () => {
    const urls: URL[] = [];
    const fetchImpl = vi.fn(async (request: string | URL | Request) => {
      const url = new URL(request instanceof Request ? request.url : request.toString());
      urls.push(url);
      if (urls.length === 1) return json({ error: { message: 'Sync token is no longer valid' } }, 410);
      if (urls.length === 2) {
        return json({
          items: [{ id: 'full-1', updated: '2026-08-21T10:00:00.000Z' }],
          nextSyncToken: 'sync-after-full',
        });
      }
      return json({ items: [] });
    }) as unknown as typeof fetch;
    const d = deps(fetchImpl);

    const result = await syncGoogleCalendarSource(
      {} as never,
      source({ syncToken: 'expired', lastSyncAt: '2026-08-22T11:00:00.000Z', keep: 'yes' }),
      'access-token',
      {},
      d.value,
    );

    expect(result).toMatchObject({ mode: 'full', created: 1, updated: 0, syncToken: 'sync-after-full' });
    expect(urls[0].searchParams.get('syncToken')).toBe('expired');
    expect(urls[1].searchParams.has('syncToken')).toBe(false);
    expect(d.updates[0]).toEqual({
      status: 'connecting',
      cursor: { lastSyncAt: '2026-08-22T11:00:00.000Z', keep: 'yes' },
      lastError: null,
    });
    expect(d.updates[1]).toEqual(expect.objectContaining({
      status: 'connected',
      cursor: {
        lastSyncAt: NOW.toISOString(),
        keep: 'yes',
        syncToken: 'sync-after-full',
      },
    }));
  });

  it('normalizes provider fields into the canonical calendar-event shape', () => {
    const event: GoogleCalendarEvent = {
      id: 'event-1',
      summary: 'Design review',
      organizer: { email: 'owner@example.com' },
      attendees: [{ email: 'ada@example.com', displayName: 'Ada', responseStatus: 'accepted' }],
      start: { date: '2026-08-23' },
      end: { date: '2026-08-24' },
      conferenceData: { entryPoints: [{ uri: 'https://meet.google.com/example' }] },
    };
    expect(normalizeGoogleCalendarEvent(event)).toEqual(expect.objectContaining({
      id: 'event-1',
      summary: 'Design review',
      organizer: 'owner@example.com',
      attendees: [expect.objectContaining({ email: 'ada@example.com', displayName: 'Ada' })],
      start: '2026-08-23',
      end: '2026-08-24',
      conferenceData: event.conferenceData,
    }));
  });
});
