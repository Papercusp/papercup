/**
 * Replay-safe Gmail adapter (external-triggers P-010 / D-011).
 *
 * Pub/Sub notifications are only doorbells. The durable source cursor owns the
 * Gmail historyId, and advances only after every message delivery succeeds.
 */
import type postgres from 'postgres';
import {
  ingestExternalTriggerEvent,
  type IngestExternalTriggerInput,
  type IngestExternalTriggerResult,
} from './ingestion';
import { type ExternalTriggerSourceRow, updateExternalTriggerSourceSyncState } from './source-store';
import { createPersonalVaultExternalSinkForSource, type PersonalVaultExternalSink } from '../personal-vault/live-sink';

const GMAIL_API_ORIGIN = 'https://gmail.googleapis.com';
const DEFAULT_RENEW_BEFORE_MS = 24 * 60 * 60 * 1_000;
const MAX_PAGES = 10_000;

export interface GoogleGmailHeader {
  name?: string;
  value?: string;
}

export interface GoogleGmailMessagePart {
  mimeType?: string;
  filename?: string;
  headers?: GoogleGmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GoogleGmailMessagePart[];
}

export interface GoogleGmailMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  payload?: GoogleGmailMessagePart;
  [key: string]: unknown;
}

interface GoogleGmailProfile {
  emailAddress?: string;
  historyId?: string;
}

interface GoogleGmailWatchResponse {
  historyId?: string;
  expiration?: string;
}

interface GoogleGmailHistoryResponse {
  history?: Array<{
    id?: string;
    messagesAdded?: Array<{ message?: GoogleGmailMessage }>;
  }>;
  nextPageToken?: string;
  historyId?: string;
}

interface GoogleGmailMessagesListResponse {
  messages?: GoogleGmailMessage[];
  nextPageToken?: string;
}

export interface GoogleGmailWatchResult {
  renewed: boolean;
  emailAddress: string;
  historyId: string;
  expiration: string;
  source: ExternalTriggerSourceRow;
}

export interface GoogleGmailSyncResult {
  mode: 'incremental' | 'full';
  messages: number;
  historyPages: number;
  messagePages: number;
  historyId: string;
}

type Ingest = (sql: postgres.Sql, input: IngestExternalTriggerInput) => Promise<IngestExternalTriggerResult>;

export interface GoogleGmailDeps {
  fetch?: typeof fetch;
  now?: () => Date;
  apiOrigin?: string;
  ingest?: Ingest;
  createPersonalSink?: (sql: postgres.Sql, workspaceId: string, sourceId: string) => Promise<PersonalVaultExternalSink>;
  updateSource?: typeof updateExternalTriggerSourceSyncState;
}

export class GoogleGmailApiError extends Error {
  constructor(
    readonly status: number,
    operation: string,
    detail?: string,
  ) {
    super(`google_gmail_${operation}_${status}${detail ? `:${detail}` : ''}`);
    this.name = 'GoogleGmailApiError';
  }
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function assertSource(source: ExternalTriggerSourceRow, accessToken: string): void {
  if (source.kind !== 'gmail') throw new Error(`google_gmail_source_kind_mismatch:${source.kind}`);
  if (!source.ownerUserId) throw new Error(`external_trigger_source_owner_required:${source.id}`);
  if (!accessToken.trim()) throw new Error('google_gmail_access_token_required');
}

function sourceHistoryId(source: ExternalTriggerSourceRow): string | null {
  return nonEmpty(source.cursor.historyId) ?? nonEmpty(source.cursor.history_id);
}

export function googleGmailSourceEmail(source: ExternalTriggerSourceRow): string | null {
  return (
    nonEmpty(source.cursor.emailAddress) ??
    nonEmpty(source.cursor.email_address) ??
    nonEmpty(source.config.emailAddress) ??
    nonEmpty(source.config.email_address)
  );
}

function watchExpiration(source: ExternalTriggerSourceRow): number | null {
  const raw = nonEmpty(source.cursor.watchExpiration) ?? nonEmpty(source.cursor.watch_expiration);
  if (!raw) return null;
  const parsed = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function cursorWithoutHistory(cursor: Record<string, unknown>): Record<string, unknown> {
  const cleared = { ...cursor };
  delete cleared.historyId;
  delete cleared.history_id;
  return cleared;
}

async function parseResponse<T>(response: Response, operation: string): Promise<T> {
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
    const detail =
      body && typeof body === 'object' ? nonEmpty((body as { error?: { message?: unknown } }).error?.message) : null;
    throw new GoogleGmailApiError(response.status, operation, detail ?? undefined);
  }
  return body as T;
}

async function gmailRequest<T>(
  fetchImpl: typeof fetch,
  apiOrigin: string,
  accessToken: string,
  path: string,
  operation: string,
  input: { method?: string; params?: URLSearchParams; body?: unknown } = {},
): Promise<T> {
  const url = new URL(path, apiOrigin);
  if (input.params) url.search = input.params.toString();
  const response = await fetchImpl(url, {
    method: input.method ?? 'GET',
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
      ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });
  return parseResponse<T>(response, operation);
}

async function profile(
  fetchImpl: typeof fetch,
  apiOrigin: string,
  accessToken: string,
): Promise<{ emailAddress: string; historyId: string }> {
  const body = await gmailRequest<GoogleGmailProfile>(
    fetchImpl,
    apiOrigin,
    accessToken,
    '/gmail/v1/users/me/profile',
    'profile',
  );
  const emailAddress = nonEmpty(body.emailAddress);
  const historyId = nonEmpty(body.historyId);
  if (!emailAddress) throw new Error('google_gmail_profile_email_missing');
  if (!historyId) throw new Error('google_gmail_profile_history_id_missing');
  return { emailAddress, historyId };
}

function watchExpirationIso(expiration: string | null): string {
  if (!expiration || !/^\d+$/.test(expiration)) {
    throw new Error('google_gmail_watch_expiration_invalid');
  }
  const parsed = Number(expiration);
  if (!Number.isFinite(parsed)) throw new Error('google_gmail_watch_expiration_invalid');
  return new Date(parsed).toISOString();
}

/** Renew users.watch when due, preserving an existing replay cursor. */
export async function ensureGoogleGmailWatch(
  sql: postgres.Sql,
  source: ExternalTriggerSourceRow,
  accessToken: string,
  topicName: string,
  input: { renewBeforeMs?: number } = {},
  provided: GoogleGmailDeps = {},
): Promise<GoogleGmailWatchResult> {
  assertSource(source, accessToken);
  if (!topicName.trim()) throw new Error('google_gmail_topic_name_required');
  const fetchImpl = provided.fetch ?? fetch;
  const apiOrigin = (provided.apiOrigin ?? GMAIL_API_ORIGIN).replace(/\/$/, '');
  const now = (provided.now ?? (() => new Date()))();
  if (!Number.isFinite(now.getTime())) throw new Error('google_gmail_now_invalid');
  const renewBeforeMs = input.renewBeforeMs ?? DEFAULT_RENEW_BEFORE_MS;
  if (!Number.isFinite(renewBeforeMs) || renewBeforeMs < 0) {
    throw new Error('google_gmail_renew_before_ms_invalid');
  }
  const currentHistoryId = sourceHistoryId(source);
  const currentExpiration = watchExpiration(source);
  const currentEmail = googleGmailSourceEmail(source);
  const shouldRenew =
    !currentHistoryId || currentExpiration === null || currentExpiration <= now.getTime() + renewBeforeMs;
  if (!shouldRenew && currentEmail) {
    return {
      renewed: false,
      emailAddress: currentEmail,
      historyId: currentHistoryId,
      expiration: new Date(currentExpiration).toISOString(),
      source,
    };
  }

  const mailbox = currentEmail
    ? { emailAddress: currentEmail, historyId: currentHistoryId ?? '' }
    : await profile(fetchImpl, apiOrigin, accessToken);
  let nextHistoryId = currentHistoryId;
  let expiration = currentExpiration === null ? null : new Date(currentExpiration).toISOString();
  if (shouldRenew) {
    const watched = await gmailRequest<GoogleGmailWatchResponse>(
      fetchImpl,
      apiOrigin,
      accessToken,
      '/gmail/v1/users/me/watch',
      'watch',
      { method: 'POST', body: { topicName } },
    );
    nextHistoryId ??= nonEmpty(watched.historyId);
    if (!nextHistoryId) throw new Error('google_gmail_watch_history_id_missing');
    expiration = watchExpirationIso(nonEmpty(watched.expiration));
  }
  if (!nextHistoryId || !expiration) throw new Error('google_gmail_watch_state_incomplete');
  const cursor = {
    ...source.cursor,
    emailAddress: mailbox.emailAddress,
    historyId: nextHistoryId,
    watchExpiration: expiration,
  };
  const updated = await (provided.updateSource ?? updateExternalTriggerSourceSyncState)(
    sql,
    source.workspaceId,
    source.id,
    { status: 'connected', cursor, lastError: null, connected: true },
  );
  return {
    renewed: shouldRenew,
    emailAddress: mailbox.emailAddress,
    historyId: nextHistoryId,
    expiration,
    source: updated,
  };
}

function decodeBase64Url(data: string | undefined): string | null {
  const normalized = nonEmpty(data);
  if (!normalized) return null;
  try {
    return Buffer.from(normalized.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function header(part: GoogleGmailMessagePart | undefined, name: string): string | null {
  const found = part?.headers?.find((candidate) => candidate.name?.toLowerCase() === name.toLowerCase());
  return nonEmpty(found?.value);
}

function addressList(value: string | null): string[] {
  if (!value) return [];
  const values: string[] = [];
  let current = '';
  let quoted = false;
  let angleDepth = 0;
  for (const character of value) {
    if (character === '"') quoted = !quoted;
    if (!quoted && character === '<') angleDepth += 1;
    if (!quoted && character === '>') angleDepth = Math.max(0, angleDepth - 1);
    if (character === ',' && !quoted && angleDepth === 0) {
      if (current.trim()) values.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  if (current.trim()) values.push(current.trim());
  return values;
}

function collectBodies(part: GoogleGmailMessagePart | undefined, texts: string[], html: string[]): void {
  if (!part) return;
  const mimeType = part.mimeType?.toLowerCase();
  if (!part.filename && mimeType === 'text/plain') {
    const decoded = decodeBase64Url(part.body?.data);
    if (decoded) texts.push(decoded);
  } else if (!part.filename && mimeType === 'text/html') {
    const decoded = decodeBase64Url(part.body?.data);
    if (decoded) html.push(decoded);
  }
  for (const child of part.parts ?? []) collectBodies(child, texts, html);
}

function occurredAt(message: GoogleGmailMessage): string | null {
  const internalDate = nonEmpty(message.internalDate);
  if (internalDate && /^\d+$/.test(internalDate)) {
    const parsed = Number(internalDate);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  const date = header(message.payload, 'Date');
  if (!date) return null;
  const parsed = Date.parse(date);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/** Normalize one Gmail API message into the canonical email-message datatype. */
export function normalizeGoogleGmailMessage(message: GoogleGmailMessage): Record<string, unknown> {
  const id = nonEmpty(message.id);
  if (!id) throw new Error('google_gmail_message_id_required');
  const texts: string[] = [];
  const html: string[] = [];
  collectBodies(message.payload, texts, html);
  const normalized: Record<string, unknown> = { id };
  const threadId = nonEmpty(message.threadId);
  const from = header(message.payload, 'From');
  const subject = header(message.payload, 'Subject');
  const time = occurredAt(message);
  if (threadId) normalized.threadId = threadId;
  if (from) normalized.from = from;
  const to = addressList(header(message.payload, 'To'));
  const cc = addressList(header(message.payload, 'Cc'));
  const bcc = addressList(header(message.payload, 'Bcc'));
  if (to.length) normalized.to = to;
  if (cc.length) normalized.cc = cc;
  if (bcc.length) normalized.bcc = bcc;
  if (subject) normalized.subject = subject;
  if (texts.length) normalized.text = [...new Set(texts)].join('\n');
  if (html.length) normalized.html = [...new Set(html)].join('\n');
  const snippet = nonEmpty(message.snippet);
  if (snippet) normalized.snippet = snippet;
  if (time) normalized.occurredAt = time;
  if (message.labelIds?.length) normalized.labels = [...message.labelIds];
  return normalized;
}

/** Decode the Gmail JSON envelope carried in Pub/Sub message.data. */
export function decodeGoogleGmailNotification(
  data: string | undefined,
): { emailAddress: string; historyId: string | null } | null {
  const decoded = decodeBase64Url(data);
  if (!decoded) return null;
  try {
    const parsed = JSON.parse(decoded) as { emailAddress?: unknown; historyId?: unknown };
    const emailAddress = nonEmpty(parsed.emailAddress);
    if (!emailAddress) return null;
    return { emailAddress, historyId: nonEmpty(parsed.historyId) };
  } catch {
    return null;
  }
}

async function getMessage(
  fetchImpl: typeof fetch,
  apiOrigin: string,
  accessToken: string,
  messageId: string,
): Promise<GoogleGmailMessage> {
  const params = new URLSearchParams({ format: 'full' });
  return gmailRequest<GoogleGmailMessage>(
    fetchImpl,
    apiOrigin,
    accessToken,
    `/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`,
    'message_get',
    { params },
  );
}

async function deliver(
  sql: postgres.Sql,
  ingest: Ingest,
  sink: PersonalVaultExternalSink,
  source: ExternalTriggerSourceRow,
  message: GoogleGmailMessage,
): Promise<void> {
  const id = nonEmpty(message.id);
  if (!id) throw new Error('google_gmail_message_id_required');
  const normalized = normalizeGoogleGmailMessage(message);
  const result = await ingest(sql, {
    workspaceId: source.workspaceId,
    sourceId: source.id,
    source: 'gmail',
    event: 'message.received',
    externalId: id,
    datatypeId: 'email-message',
    adapterPayload: message,
    normalize: () => normalized,
    occurredAt: nonEmpty(normalized.occurredAt),
    dedupeKey: `gmail:${id}:message.received`,
    additionalSinks: [sink],
  });
  if (!result.ok) throw new Error(`google_gmail_delivery_failed:${id}`);
}

async function incrementalSync(
  sql: postgres.Sql,
  source: ExternalTriggerSourceRow,
  accessToken: string,
  startHistoryId: string,
  sink: PersonalVaultExternalSink,
  deps: Required<Pick<GoogleGmailDeps, 'fetch' | 'apiOrigin' | 'ingest'>>,
): Promise<{ messages: number; pages: number; historyId: string }> {
  let pageToken: string | null = null;
  let pages = 0;
  let nextHistoryId: string | null = null;
  const delivered = new Set<string>();
  do {
    if (++pages > MAX_PAGES) throw new Error('google_gmail_history_page_limit_exceeded');
    const params = new URLSearchParams({
      startHistoryId,
      historyTypes: 'messageAdded',
      maxResults: '500',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const body = await gmailRequest<GoogleGmailHistoryResponse>(
      deps.fetch,
      deps.apiOrigin,
      accessToken,
      '/gmail/v1/users/me/history',
      'history_list',
      { params },
    );
    for (const history of body.history ?? []) {
      for (const added of history.messagesAdded ?? []) {
        const id = nonEmpty(added.message?.id);
        if (!id || delivered.has(id)) continue;
        await deliver(sql, deps.ingest, sink, source, await getMessage(deps.fetch, deps.apiOrigin, accessToken, id));
        delivered.add(id);
      }
    }
    nextHistoryId = nonEmpty(body.historyId) ?? nextHistoryId;
    pageToken = nonEmpty(body.nextPageToken);
  } while (pageToken);
  if (!nextHistoryId) throw new Error('google_gmail_next_history_id_missing');
  return { messages: delivered.size, pages, historyId: nextHistoryId };
}

async function fullSync(
  sql: postgres.Sql,
  source: ExternalTriggerSourceRow,
  accessToken: string,
  sink: PersonalVaultExternalSink,
  deps: Required<Pick<GoogleGmailDeps, 'fetch' | 'apiOrigin' | 'ingest'>>,
): Promise<{ messages: number; pages: number }> {
  let pageToken: string | null = null;
  let pages = 0;
  let messages = 0;
  do {
    if (++pages > MAX_PAGES) throw new Error('google_gmail_message_page_limit_exceeded');
    const params = new URLSearchParams({ maxResults: '500' });
    if (pageToken) params.set('pageToken', pageToken);
    const body = await gmailRequest<GoogleGmailMessagesListResponse>(
      deps.fetch,
      deps.apiOrigin,
      accessToken,
      '/gmail/v1/users/me/messages',
      'messages_list',
      { params },
    );
    for (const listed of body.messages ?? []) {
      const id = nonEmpty(listed.id);
      if (!id) continue;
      await deliver(sql, deps.ingest, sink, source, await getMessage(deps.fetch, deps.apiOrigin, accessToken, id));
      messages += 1;
    }
    pageToken = nonEmpty(body.nextPageToken);
  } while (pageToken);
  return { messages, pages };
}

/** Reconcile one owned source and commit its history cursor after ingestion. */
export async function syncGoogleGmailSource(
  sql: postgres.Sql,
  source: ExternalTriggerSourceRow,
  accessToken: string,
  provided: GoogleGmailDeps = {},
): Promise<GoogleGmailSyncResult> {
  assertSource(source, accessToken);
  const deps = {
    fetch: provided.fetch ?? fetch,
    apiOrigin: (provided.apiOrigin ?? GMAIL_API_ORIGIN).replace(/\/$/, ''),
    ingest: provided.ingest ?? ((db, event) => ingestExternalTriggerEvent(db, event)),
  };
  const updateSource = provided.updateSource ?? updateExternalTriggerSourceSyncState;
  const createSink = provided.createPersonalSink ?? createPersonalVaultExternalSinkForSource;
  const sink = await createSink(sql, source.workspaceId, source.id);
  const now = (provided.now ?? (() => new Date()))();
  if (!Number.isFinite(now.getTime())) throw new Error('google_gmail_now_invalid');
  let workingSource = source;
  let historyId = sourceHistoryId(source);
  let mode: GoogleGmailSyncResult['mode'] = historyId ? 'incremental' : 'full';
  let messages = 0;
  let historyPages = 0;
  let messagePages = 0;

  if (historyId) {
    try {
      const synced = await incrementalSync(sql, source, accessToken, historyId, sink, deps);
      messages = synced.messages;
      historyPages = synced.pages;
      historyId = synced.historyId;
    } catch (cause) {
      if (!(cause instanceof GoogleGmailApiError) || cause.status !== 404) throw cause;
      const clearedCursor = cursorWithoutHistory(source.cursor);
      workingSource = await updateSource(sql, source.workspaceId, source.id, {
        status: 'connecting',
        cursor: clearedCursor,
        lastError: null,
      });
      historyId = null;
      mode = 'full';
    }
  }

  if (!historyId) {
    const synced = await fullSync(sql, workingSource, accessToken, sink, deps);
    const mailbox = await profile(deps.fetch, deps.apiOrigin, accessToken);
    messages = synced.messages;
    messagePages = synced.pages;
    historyId = mailbox.historyId;
    workingSource = {
      ...workingSource,
      cursor: { ...workingSource.cursor, emailAddress: mailbox.emailAddress },
    };
  }

  const cursor = {
    ...workingSource.cursor,
    historyId,
    lastSyncAt: now.toISOString(),
  };
  await updateSource(sql, source.workspaceId, source.id, {
    status: 'connected',
    cursor,
    lastError: null,
    connected: true,
  });
  return { mode, messages, historyPages, messagePages, historyId };
}
