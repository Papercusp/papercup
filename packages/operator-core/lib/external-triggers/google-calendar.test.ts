import { describe, expect, it, vi } from 'vitest';
import {
  createGoogleCalendarEvent,
  deleteGoogleCalendarEvent,
  normalizeGoogleCalendarEvent,
  syncGoogleCalendarSource,
  updateGoogleCalendarEvent,
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
      // Unconfigured for app delivery, stated explicitly: these cases are about
      // paging and cursors. Registration coverage lives in
      // app-data-producer/adapter-registration.test.ts.
      createAppSink: vi.fn(async () => null),
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

describe('Google Calendar write contract', () => {
  it('creates an event on the selected calendar and requests invitation delivery', async () => {
    const fetchSpy = vi.fn(async () =>
      json({
        id: 'event-created',
        htmlLink: 'https://calendar.test/event-created',
        status: 'confirmed',
        attendees: [{ email: 'ada@example.com' }],
      }),
    );
    const fetchImpl = fetchSpy as unknown as typeof fetch;

    const result = await createGoogleCalendarEvent(
      'access-token',
      {
        calendarId: 'team/calendar',
        summary: 'Design review',
        description: 'Review the trigger contract',
        start: '2026-08-24T14:00:00.000Z',
        end: '2026-08-24T14:30:00.000Z',
        attendees: ['ada@example.com'],
      },
      { fetch: fetchImpl, apiOrigin: 'https://calendar.test' },
    );

    const [request, init] = fetchSpy.mock.calls[0] as unknown as [URL, RequestInit];
    expect(request.pathname).toBe('/calendar/v3/calendars/team%2Fcalendar/events');
    expect(request.searchParams.get('sendUpdates')).toBe('all');
    expect(init.method).toBe('POST');
    // gaxios normalizes headers into a Headers instance, so own-enumerable key
    // matching no longer sees them. Reading the value is STRONGER than the
    // objectContaining this replaces: it asserts the exact token, and a missing
    // header yields null and fails rather than silently matching nothing.
    expect(new Headers(init.headers as HeadersInit).get('authorization')).toBe(
      'Bearer access-token',
    );
    expect(JSON.parse(String(init.body))).toEqual({
      summary: 'Design review',
      description: 'Review the trigger contract',
      start: { dateTime: '2026-08-24T14:00:00.000Z' },
      end: { dateTime: '2026-08-24T14:30:00.000Z' },
      attendees: [{ email: 'ada@example.com' }],
    });
    expect(result).toEqual({
      id: 'event-created',
      htmlLink: 'https://calendar.test/event-created',
      status: 'confirmed',
      attendees: ['ada@example.com'],
    });
  });

  it('patches only supplied fields and supports all-day dates', async () => {
    const fetchSpy = vi.fn(async () => json({ id: 'event-1', status: 'confirmed' }));
    const fetchImpl = fetchSpy as unknown as typeof fetch;

    await updateGoogleCalendarEvent(
      'access-token',
      'event/1',
      {
        calendarId: 'primary',
        summary: 'Updated review',
        start: '2026-08-25',
      },
      { fetch: fetchImpl, apiOrigin: 'https://calendar.test' },
    );

    const [request, init] = fetchSpy.mock.calls[0] as unknown as [URL, RequestInit];
    expect(request.pathname).toBe('/calendar/v3/calendars/primary/events/event%2F1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({
      summary: 'Updated review',
      start: { date: '2026-08-25' },
    });
  });

  it("deletes an event and accepts Google's empty 204 response", async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }));
    const fetchImpl = fetchSpy as unknown as typeof fetch;

    const result = await deleteGoogleCalendarEvent(
      'access-token',
      'event/1',
      { calendarId: 'team/calendar' },
      { fetch: fetchImpl, apiOrigin: 'https://calendar.test' },
    );

    const [request, init] = fetchSpy.mock.calls[0] as unknown as [URL, RequestInit];
    expect(request.pathname).toBe('/calendar/v3/calendars/team%2Fcalendar/events/event%2F1');
    expect(request.searchParams.get('sendUpdates')).toBe('all');
    expect(init.method).toBe('DELETE');
    expect(new Headers(init.headers as HeadersInit).get('authorization')).toBe(
      'Bearer access-token',
    );
    expect(result).toEqual({ id: 'event/1', deleted: true });
  });

  it('rejects invalid write requests before touching the provider', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      createGoogleCalendarEvent(
        'access-token',
        {
          summary: 'Missing start',
          start: '',
          end: '2026-08-24T14:30:00.000Z',
        },
        { fetch: fetchImpl },
      ),
    ).rejects.toThrow('google_calendar_event_time_required');
    await expect(updateGoogleCalendarEvent('access-token', 'event-1', {}, { fetch: fetchImpl })).rejects.toThrow(
      'google_calendar_event_patch_empty',
    );
    await expect(deleteGoogleCalendarEvent('access-token', '', {}, { fetch: fetchImpl })).rejects.toThrow(
      'google_calendar_event_id_required',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('calendar transport retry policy', () => {
  // The policy is a CORRECTNESS decision, not an inherited default. Every write
  // here carries sendUpdates=all, so a replayed write does not just duplicate
  // state — it re-emails real attendees. These pin the policy so a later
  // "simplify the retry config" cannot quietly reintroduce that.
  //
  // Read the 429 case FIRST: it is the calibration control. Without it, every
  // "not retried" assertion below would pass just as cleanly if retrying were
  // broken or disabled outright, which is the exact reading a dead transport
  // produces.

  function countingFetch(respond: () => Response) {
    let attempts = 0;
    const impl = (async () => {
      attempts += 1;
      return respond();
    }) as unknown as typeof fetch;
    return { impl, attempts: () => attempts };
  }

  const writeInput = {
    calendarId: 'primary',
    summary: 'Design review',
    start: '2026-08-24T14:00:00.000Z',
    end: '2026-08-24T14:30:00.000Z',
  };

  it('CALIBRATION: retries a POST on 429, proving retry is live rather than dead', async () => {
    const { impl, attempts } = countingFetch(() => json({ error: { message: 'rate' } }, 429));

    await expect(
      createGoogleCalendarEvent('access-token', writeInput, {
        fetch: impl,
        apiOrigin: 'https://calendar.test',
      }),
    ).rejects.toThrow(/google_calendar_event_create_429/);

    // A rate-limited request was provably NOT performed, so replaying it is safe.
    expect(attempts()).toBeGreaterThan(1);
  });

  it('never retries a POST on 5xx — an ambiguous error must not duplicate an event or re-invite attendees', async () => {
    const { impl, attempts } = countingFetch(() => json({ error: { message: 'boom' } }, 503));

    await expect(
      createGoogleCalendarEvent('access-token', writeInput, {
        fetch: impl,
        apiOrigin: 'https://calendar.test',
      }),
    ).rejects.toThrow(/google_calendar_event_create_503/);

    expect(attempts()).toBe(1);
  });

  it('never retries a DELETE on 5xx — gaxios retries DELETE by default and this widening is deliberate', async () => {
    const { impl, attempts } = countingFetch(() => json({ error: { message: 'boom' } }, 503));

    await expect(
      deleteGoogleCalendarEvent(
        'access-token',
        'event-1',
        {},
        { fetch: impl, apiOrigin: 'https://calendar.test' },
      ),
    ).rejects.toThrow(/google_calendar_event_delete_503/);

    // A replayed DELETE re-sends the cancellation notice to every attendee.
    expect(attempts()).toBe(1);
  });

  it('never retries a PATCH on 5xx — a replayed update re-sends the change notice', async () => {
    const { impl, attempts } = countingFetch(() => json({ error: { message: 'boom' } }, 503));

    await expect(
      updateGoogleCalendarEvent(
        'access-token',
        'event-1',
        { summary: 'Updated' },
        { fetch: impl, apiOrigin: 'https://calendar.test' },
      ),
    ).rejects.toThrow(/google_calendar_event_update_503/);

    expect(attempts()).toBe(1);
  });

  it('DOES retry a read on 5xx — a GET has no side effect to duplicate', async () => {
    const { impl, attempts } = countingFetch(() => json({ error: { message: 'boom' } }, 503));

    await expect(
      syncGoogleCalendarSource(
        {} as never,
        source({ syncToken: 'sync-old' }),
        'access-token',
        {},
        {
          fetch: impl,
          apiOrigin: 'https://calendar.test',
          now: () => NOW,
          ingest: (async () => ({ eventId: 'e', delivered: false })) as never,
          updateSource: (async () => undefined) as never,
          createPersonalSink: (async () => ({}) as never) as never,
          createAppSink: (async () => null) as never,
        },
      ),
    ).rejects.toThrow(/google_calendar_.*_503/);

    expect(attempts()).toBeGreaterThan(1);
  });
});
