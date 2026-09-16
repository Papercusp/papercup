/**
 * Offline-safe Google Calendar adapter (external-triggers P-019 / D-010).
 *
 * Calendar changes use events.list + the provider's syncToken. Upcoming-event
 * delivery is intentionally a second bounded list request: push channels need a
 * public webhook, while this local time-wheel works behind NAT and reuses the
 * trigger-delivery ledger for per-event/start dedupe.
 */
import type { calendar_v3 } from '@googleapis/calendar';
import { Gaxios, type GaxiosError } from 'gaxios';
import type postgres from 'postgres';
import {
  ingestExternalTriggerEvent,
  type IngestExternalTriggerInput,
  type IngestExternalTriggerResult,
} from './ingestion';
import {
  type ExternalTriggerSourceRow,
  updateExternalTriggerSourceSyncState,
} from './source-store';
import {
  createPersonalVaultExternalSinkForSource,
  type PersonalVaultExternalSink,
} from '../personal-vault/live-sink';
import {
  createAppDeliverySinkIfConfigured,
  reportAppSinkGateError,
  type AppDeliveryExternalSink,
} from '../app-data-producer/live-sink';

/**
 * Every sink this adapter hands to ingestion. The personal vault is always
 * present; the app-delivery sink (P-011) appears only when this deployment has
 * an owner mapping for the source's user, so an unconfigured deployment sees
 * exactly the previous single-sink behaviour.
 */
type IngestSink = PersonalVaultExternalSink | AppDeliveryExternalSink;

const GOOGLE_CALENDAR_API_ORIGIN = 'https://www.googleapis.com';
const DEFAULT_LEAD_MINUTES = 15;
const MAX_LEAD_MINUTES = 24 * 60;
const MAX_PAGES = 10_000;

interface GoogleCalendarDate {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

interface GoogleCalendarPerson {
  email?: string;
  displayName?: string;
  self?: boolean;
  responseStatus?: string;
}

export interface GoogleCalendarEvent {
  id?: string;
  etag?: string;
  status?: string;
  htmlLink?: string;
  created?: string;
  updated?: string;
  summary?: string;
  description?: string;
  location?: string;
  organizer?: GoogleCalendarPerson;
  attendees?: GoogleCalendarPerson[];
  start?: GoogleCalendarDate;
  end?: GoogleCalendarDate;
  recurringEventId?: string;
  originalStartTime?: GoogleCalendarDate;
  sequence?: number;
  attachments?: Array<Record<string, unknown>>;
  conferenceData?: Record<string, unknown>;
  [key: string]: unknown;
}

interface GoogleCalendarListResponse {
  items?: GoogleCalendarEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

export interface GoogleCalendarSyncResult {
  mode: 'full' | 'incremental';
  created: number;
  updated: number;
  upcoming: number;
  changePages: number;
  upcomingPages: number;
  syncToken: string;
}

type Ingest = (
  sql: postgres.Sql,
  input: IngestExternalTriggerInput,
) => Promise<IngestExternalTriggerResult>;

export interface GoogleCalendarSyncDeps {
  fetch?: typeof fetch;
  now?: () => Date;
  apiOrigin?: string;
  ingest?: Ingest;
  createPersonalSink?: (
    sql: postgres.Sql,
    workspaceId: string,
    sourceId: string,
  ) => Promise<PersonalVaultExternalSink>;
  /**
   * P-011 app-delivery sink factory. Returning null means "this deployment is
   * not configured to deliver to the Calendar app", which is the normal state
   * for an install with no owner mapping — not an error.
   */
  createAppSink?: (
    sql: postgres.Sql,
    workspaceId: string,
    sourceId: string,
  ) => Promise<AppDeliveryExternalSink | null>;
  updateSource?: typeof updateExternalTriggerSourceSyncState;
}

export class GoogleCalendarApiError extends Error {
  constructor(
    readonly status: number,
    operation: string,
    detail?: string,
  ) {
    super(`google_calendar_${operation}_${status}${detail ? `:${detail}` : ''}`);
    this.name = 'GoogleCalendarApiError';
  }
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function calendarDate(value: GoogleCalendarDate | undefined): string | null {
  return nonEmpty(value?.dateTime) ?? nonEmpty(value?.date);
}

function appendDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined && value !== null && value !== '') target[key] = value;
}

/** Normalize one Google response into the canonical calendar-event datatype. */
export function normalizeGoogleCalendarEvent(event: GoogleCalendarEvent): Record<string, unknown> {
  const id = nonEmpty(event.id);
  if (!id) throw new Error('google_calendar_event_id_required');
  const normalized: Record<string, unknown> = { id };
  appendDefined(normalized, 'summary', event.summary);
  appendDefined(normalized, 'description', event.description);
  appendDefined(normalized, 'organizer', event.organizer?.email ?? event.organizer?.displayName);
  if (event.attendees) {
    normalized.attendees = event.attendees.map((attendee) => ({
      ...(attendee.email ? { email: attendee.email } : {}),
      ...(attendee.displayName ? { displayName: attendee.displayName } : {}),
      ...(attendee.responseStatus ? { responseStatus: attendee.responseStatus } : {}),
      ...(attendee.self === undefined ? {} : { self: attendee.self }),
    }));
  }
  appendDefined(normalized, 'start', calendarDate(event.start));
  appendDefined(normalized, 'end', calendarDate(event.end));
  appendDefined(normalized, 'location', event.location);
  appendDefined(normalized, 'status', event.status);
  appendDefined(normalized, 'htmlLink', event.htmlLink);
  appendDefined(normalized, 'created', event.created);
  appendDefined(normalized, 'updated', event.updated);
  appendDefined(normalized, 'recurringEventId', event.recurringEventId);
  appendDefined(normalized, 'originalStart', calendarDate(event.originalStartTime));
  appendDefined(normalized, 'sequence', event.sequence);
  appendDefined(normalized, 'attachments', event.attachments);
  appendDefined(normalized, 'conferenceData', event.conferenceData);
  return normalized;
}

function positiveLeadMinutes(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(MAX_LEAD_MINUTES, parsed)
    : DEFAULT_LEAD_MINUTES;
}

function sourceCalendarId(source: ExternalTriggerSourceRow): string {
  return nonEmpty(source.config.calendarId) ?? nonEmpty(source.config.calendar_id) ?? 'primary';
}

function sourceLeadMinutes(source: ExternalTriggerSourceRow, fallback?: number): number {
  return positiveLeadMinutes(
    source.config.leadMinutes ?? source.config.lead_minutes ?? fallback ?? DEFAULT_LEAD_MINUTES,
  );
}

function sourceSyncToken(source: ExternalTriggerSourceRow): string | null {
  return nonEmpty(source.cursor.syncToken) ?? nonEmpty(source.cursor.sync_token);
}

function sourceLastSyncAt(source: ExternalTriggerSourceRow): number | null {
  const raw = nonEmpty(source.cursor.lastSyncAt) ?? nonEmpty(source.cursor.last_sync_at);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function eventVersion(event: GoogleCalendarEvent): string {
  return nonEmpty(event.updated)
    ?? nonEmpty(event.etag)
    ?? `sequence-${Number.isInteger(event.sequence) ? event.sequence : 0}`;
}

function createdAfter(event: GoogleCalendarEvent, lastSyncAt: number | null): boolean {
  if (lastSyncAt === null) return false;
  const created = event.created ? Date.parse(event.created) : NaN;
  return Number.isFinite(created) && created > lastSyncAt;
}

async function parseResponse(response: Response, operation: string): Promise<GoogleCalendarListResponse> {
  const text = await response.text();
  let body: unknown = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: { message: text.slice(0, 500) } };
    }
  }
  if (!response.ok) {
    const detail = body && typeof body === 'object'
      ? nonEmpty((body as { error?: { message?: unknown } }).error?.message)
      : null;
    throw new GoogleCalendarApiError(response.status, operation, detail ?? undefined);
  }
  return body as GoogleCalendarListResponse;
}

async function listPage(
  fetchImpl: typeof fetch,
  apiOrigin: string,
  accessToken: string,
  calendarId: string,
  params: URLSearchParams,
  operation: string,
): Promise<GoogleCalendarListResponse> {
  const url = new URL(
    `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    apiOrigin,
  );
  url.search = params.toString();
  const response = await fetchImpl(url, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
    },
  });
  return parseResponse(response, operation);
}

export interface GoogleCalendarWriteInput {
  calendarId?: string;
  summary: string;
  description?: string | null;
  location?: string | null;
  /** RFC3339 instant or a YYYY-MM-DD all-day date. */
  start: string;
  end: string;
  timeZone?: string | null;
  attendees?: readonly string[];
}

export interface GoogleCalendarWriteResult {
  id: string;
  htmlLink: string | null;
  status: string | null;
  attendees: string[];
}

function eventDate(value: string, timeZone: string | null | undefined): Record<string, unknown> {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error('google_calendar_event_time_required');
  // An all-day event is a bare date; anything else must be a real instant.
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return { date: normalized };
  if (!Number.isFinite(Date.parse(normalized))) throw new Error(`google_calendar_event_time_invalid:${normalized}`);
  return timeZone ? { dateTime: normalized, timeZone } : { dateTime: normalized };
}

function writeBody(input: GoogleCalendarWriteInput): Record<string, unknown> {
  const summary = String(input.summary ?? '').trim();
  if (!summary || summary.length > 1_024) throw new Error('google_calendar_event_summary_invalid');
  const body: Record<string, unknown> = {
    summary,
    start: eventDate(input.start, input.timeZone),
    end: eventDate(input.end, input.timeZone),
  };
  if (input.description?.trim()) body.description = input.description.trim().slice(0, 8_192);
  if (input.location?.trim()) body.location = input.location.trim().slice(0, 1_024);
  if (input.attendees?.length) body.attendees = input.attendees.map((email) => ({ email }));
  return body;
}

async function calendarWrite(
  fetchImpl: typeof fetch,
  apiOrigin: string,
  accessToken: string,
  path: string,
  method: 'POST' | 'PATCH',
  body: Record<string, unknown>,
  operation: string,
): Promise<GoogleCalendarEvent> {
  const url = new URL(path, apiOrigin);
  // Google only emails invitations when explicitly asked to.
  url.searchParams.set('sendUpdates', 'all');
  const response = await fetchImpl(url, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return (await parseResponse(response, operation)) as unknown as GoogleCalendarEvent;
}

function writeResult(event: GoogleCalendarEvent): GoogleCalendarWriteResult {
  const id = nonEmpty(event.id);
  if (!id) throw new Error('google_calendar_event_response_invalid');
  return {
    id,
    htmlLink: nonEmpty(event.htmlLink),
    status: nonEmpty(event.status),
    attendees: (event.attendees ?? [])
      .map((person) => nonEmpty(person?.email))
      .filter((email): email is string => Boolean(email)),
  };
}

/**
 * Create one calendar event (P-022 write path). Requires the
 * `calendar.events` scope on the SAME Google Workspace OAuth source per D-010
 * — there is deliberately no second credential path.
 *
 * D-020: attendee addresses reaching here have already cleared the rail-2
 * trusted-addressee check. This seam performs no such check itself.
 */
export async function createGoogleCalendarEvent(
  accessToken: string,
  input: GoogleCalendarWriteInput,
  provided: { fetch?: typeof fetch; apiOrigin?: string } = {},
): Promise<GoogleCalendarWriteResult> {
  const token = accessToken.trim();
  if (!token) throw new Error('google_calendar_access_token_required');
  const calendarId = input.calendarId?.trim() || 'primary';
  const event = await calendarWrite(
    provided.fetch ?? fetch,
    (provided.apiOrigin ?? GOOGLE_CALENDAR_API_ORIGIN).replace(/\/$/, ''),
    token,
    `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    'POST',
    writeBody(input),
    'event_create',
  );
  return writeResult(event);
}

/** Patch one existing event; only the fields supplied are changed. */
export async function updateGoogleCalendarEvent(
  accessToken: string,
  eventId: string,
  input: Partial<GoogleCalendarWriteInput> & { calendarId?: string },
  provided: { fetch?: typeof fetch; apiOrigin?: string } = {},
): Promise<GoogleCalendarWriteResult> {
  const token = accessToken.trim();
  if (!token) throw new Error('google_calendar_access_token_required');
  const id = String(eventId ?? '').trim();
  if (!id) throw new Error('google_calendar_event_id_required');
  const calendarId = input.calendarId?.trim() || 'primary';
  const patch: Record<string, unknown> = {};
  if (input.summary !== undefined) patch.summary = String(input.summary).trim();
  if (input.description !== undefined) patch.description = input.description?.trim() ?? '';
  if (input.location !== undefined) patch.location = input.location?.trim() ?? '';
  if (input.start !== undefined) patch.start = eventDate(input.start, input.timeZone);
  if (input.end !== undefined) patch.end = eventDate(input.end, input.timeZone);
  if (input.attendees !== undefined) patch.attendees = (input.attendees ?? []).map((email) => ({ email }));
  if (!Object.keys(patch).length) throw new Error('google_calendar_event_patch_empty');
  const event = await calendarWrite(
    provided.fetch ?? fetch,
    (provided.apiOrigin ?? GOOGLE_CALENDAR_API_ORIGIN).replace(/\/$/, ''),
    token,
    `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(id)}`,
    'PATCH',
    patch,
    'event_update',
  );
  return writeResult(event);
}

/** Delete one existing event. Google returns an empty 204 response on success. */
export async function deleteGoogleCalendarEvent(
  accessToken: string,
  eventId: string,
  input: { calendarId?: string } = {},
  provided: { fetch?: typeof fetch; apiOrigin?: string } = {},
): Promise<{ id: string; deleted: true }> {
  const token = accessToken.trim();
  if (!token) throw new Error('google_calendar_access_token_required');
  const id = String(eventId ?? '').trim();
  if (!id) throw new Error('google_calendar_event_id_required');
  const calendarId = input.calendarId?.trim() || 'primary';
  const url = new URL(
    `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(id)}`,
    (provided.apiOrigin ?? GOOGLE_CALENDAR_API_ORIGIN).replace(/\/$/, ''),
  );
  url.searchParams.set('sendUpdates', 'all');
  const response = await (provided.fetch ?? fetch)(url, {
    method: 'DELETE',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
    },
  });
  if (!response.ok) await parseResponse(response, 'event_delete');
  return { id, deleted: true };
}

function cursorWithoutSyncToken(cursor: Record<string, unknown>): Record<string, unknown> {
  const cleared = { ...cursor };
  delete cleared.syncToken;
  delete cleared.sync_token;
  return cleared;
}

function assertSource(source: ExternalTriggerSourceRow, accessToken: string): void {
  if (source.kind !== 'gcal') throw new Error(`google_calendar_source_kind_mismatch:${source.kind}`);
  if (!source.ownerUserId) throw new Error(`external_trigger_source_owner_required:${source.id}`);
  if (!accessToken.trim()) throw new Error('google_calendar_access_token_required');
}

async function deliver(
  sql: postgres.Sql,
  ingest: Ingest,
  sinks: IngestSink[],
  source: ExternalTriggerSourceRow,
  event: GoogleCalendarEvent,
  eventName: 'event-created' | 'event-updated' | 'event-upcoming',
  dedupeKey: string,
): Promise<void> {
  const id = nonEmpty(event.id);
  if (!id) throw new Error('google_calendar_event_id_required');
  const result = await ingest(sql, {
    workspaceId: source.workspaceId,
    sourceId: source.id,
    source: 'gcal',
    event: eventName,
    externalId: id,
    datatypeId: 'calendar-event',
    adapterPayload: event,
    normalize: (payload) => normalizeGoogleCalendarEvent(payload as GoogleCalendarEvent),
    occurredAt: calendarDate(event.start) ?? nonEmpty(event.updated) ?? nonEmpty(event.created),
    dedupeKey,
    additionalSinks: [...sinks],
  });
  if (!result.ok) throw new Error(`google_calendar_delivery_failed:${id}:${eventName}`);
}

async function syncChanges(
  sql: postgres.Sql,
  source: ExternalTriggerSourceRow,
  accessToken: string,
  sinks: IngestSink[],
  deps: Required<Pick<GoogleCalendarSyncDeps, 'fetch' | 'apiOrigin' | 'ingest'>>,
  syncToken: string | null,
): Promise<{
  created: number;
  updated: number;
  pages: number;
  nextSyncToken: string;
}> {
  let pageToken: string | null = null;
  let created = 0;
  let updated = 0;
  let pages = 0;
  const lastSyncAt = sourceLastSyncAt(source);
  do {
    if (++pages > MAX_PAGES) throw new Error('google_calendar_page_limit_exceeded');
    const params = new URLSearchParams({
      maxResults: '2500',
      showDeleted: 'true',
    });
    if (syncToken) params.set('syncToken', syncToken);
    if (pageToken) params.set('pageToken', pageToken);
    const body = await listPage(
      deps.fetch,
      deps.apiOrigin,
      accessToken,
      sourceCalendarId(source),
      params,
      syncToken ? 'incremental_list' : 'full_list',
    );
    for (const event of body.items ?? []) {
      const id = nonEmpty(event.id);
      if (!id) throw new Error('google_calendar_event_id_required');
      const isCreated = syncToken === null || createdAfter(event, lastSyncAt);
      const eventName = isCreated ? 'event-created' : 'event-updated';
      await deliver(
        sql,
        deps.ingest,
        sinks,
        source,
        event,
        eventName,
        `gcal:${id}:${eventName}:${eventVersion(event)}`,
      );
      if (isCreated) created += 1;
      else updated += 1;
    }
    pageToken = nonEmpty(body.nextPageToken);
    if (!pageToken) {
      const nextSyncToken = nonEmpty(body.nextSyncToken);
      if (!nextSyncToken) throw new Error('google_calendar_next_sync_token_missing');
      return { created, updated, pages, nextSyncToken };
    }
  } while (pageToken);
  throw new Error('google_calendar_sync_unreachable');
}

async function emitUpcoming(
  sql: postgres.Sql,
  source: ExternalTriggerSourceRow,
  accessToken: string,
  sinks: IngestSink[],
  deps: Required<Pick<GoogleCalendarSyncDeps, 'fetch' | 'apiOrigin' | 'ingest'>>,
  now: Date,
  leadMinutes: number,
): Promise<{ upcoming: number; pages: number }> {
  let pageToken: string | null = null;
  let upcoming = 0;
  let pages = 0;
  const timeMax = new Date(now.getTime() + leadMinutes * 60_000);
  do {
    if (++pages > MAX_PAGES) throw new Error('google_calendar_page_limit_exceeded');
    const params = new URLSearchParams({
      maxResults: '2500',
      orderBy: 'startTime',
      showDeleted: 'false',
      singleEvents: 'true',
      timeMin: now.toISOString(),
      timeMax: timeMax.toISOString(),
    });
    if (pageToken) params.set('pageToken', pageToken);
    const body = await listPage(
      deps.fetch,
      deps.apiOrigin,
      accessToken,
      sourceCalendarId(source),
      params,
      'upcoming_list',
    );
    for (const event of body.items ?? []) {
      const id = nonEmpty(event.id);
      if (!id) throw new Error('google_calendar_event_id_required');
      const start = calendarDate(event.start);
      if (!start) continue;
      await deliver(
        sql,
        deps.ingest,
        sinks,
        source,
        event,
        'event-upcoming',
        `gcal:${id}:event-upcoming:${start}`,
      );
      upcoming += 1;
    }
    pageToken = nonEmpty(body.nextPageToken);
  } while (pageToken);
  return { upcoming, pages };
}

/**
 * Reconcile one owned Calendar source, advance its sync cursor only after all
 * change deliveries succeed, then run the local upcoming-event time-wheel.
 */
export async function syncGoogleCalendarSource(
  sql: postgres.Sql,
  source: ExternalTriggerSourceRow,
  accessToken: string,
  input: { leadMinutes?: number } = {},
  provided: GoogleCalendarSyncDeps = {},
): Promise<GoogleCalendarSyncResult> {
  assertSource(source, accessToken);
  const deps = {
    fetch: provided.fetch ?? fetch,
    apiOrigin: (provided.apiOrigin ?? GOOGLE_CALENDAR_API_ORIGIN).replace(/\/$/, ''),
    ingest: provided.ingest ?? ((db, event) => ingestExternalTriggerEvent(db, event)),
  };
  const updateSource = provided.updateSource ?? updateExternalTriggerSourceSyncState;
  const createSink = provided.createPersonalSink ?? createPersonalVaultExternalSinkForSource;
  const sink = await createSink(sql, source.workspaceId, source.id);
  // P-011: deliver into the Calendar app as events land, but only where an
  // owner mapping configures it. Resolved ONCE per sync, not per event.
  const createAppSink = provided.createAppSink
    ?? ((db: postgres.Sql, workspaceId: string, sourceId: string) =>
      createAppDeliverySinkIfConfigured(db, workspaceId, sourceId, 'calendar', {
        // P-007: the gate swallows its own errors to protect the sync (D-013),
        // so without this a registration fault is invisible everywhere.
        onGateError: reportAppSinkGateError,
      }));
  const appSink = await createAppSink(sql, source.workspaceId, source.id);
  const sinks: IngestSink[] = appSink ? [sink, appSink] : [sink];
  const now = (provided.now ?? (() => new Date()))();
  if (!Number.isFinite(now.getTime())) throw new Error('google_calendar_now_invalid');

  let token = sourceSyncToken(source);
  let mode: GoogleCalendarSyncResult['mode'] = token ? 'incremental' : 'full';
  let changes;
  try {
    changes = await syncChanges(sql, source, accessToken, sinks, deps, token);
  } catch (error) {
    if (!(error instanceof GoogleCalendarApiError) || error.status !== 410 || !token) throw error;
    const clearedCursor = cursorWithoutSyncToken(source.cursor);
    await updateSource(sql, source.workspaceId, source.id, {
      status: 'connecting',
      cursor: clearedCursor,
      lastError: null,
    });
    token = null;
    mode = 'full';
    changes = await syncChanges(
      sql,
      { ...source, cursor: clearedCursor },
      accessToken,
      sinks,
      deps,
      null,
    );
  }

  const cursor = {
    ...cursorWithoutSyncToken(source.cursor),
    syncToken: changes.nextSyncToken,
    lastSyncAt: now.toISOString(),
  };
  await updateSource(sql, source.workspaceId, source.id, {
    status: 'connected',
    cursor,
    lastError: null,
    connected: true,
  });

  const due = await emitUpcoming(
    sql,
    source,
    accessToken,
    sinks,
    deps,
    now,
    sourceLeadMinutes(source, input.leadMinutes),
  );
  return {
    mode,
    created: changes.created,
    updated: changes.updated,
    upcoming: due.upcoming,
    changePages: changes.pages,
    upcomingPages: due.pages,
    syncToken: changes.nextSyncToken,
  };
}
