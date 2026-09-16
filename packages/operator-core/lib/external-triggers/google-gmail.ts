/**
 * Replay-safe Gmail adapter (external-triggers P-010 / D-011).
 *
 * Pub/Sub notifications are only doorbells. The durable source cursor owns the
 * Gmail historyId, and advances only after every message delivery succeeds.
 *
 * Initial backfill (EI-23378389605835281): a mailbox with no history cursor is
 * pinned to the profile historyId FIRST, so incremental sync and the watch
 * start on the very first poll, and the historical walk runs as a resumable,
 * quota-budgeted chunk per sync (`cursor.backfill`) instead of one whole-mailbox
 * walk that a per-user quota kills and the next poll restarts from zero.
 */
import type postgres from 'postgres';
import {
  ingestExternalTriggerEvent,
  type IngestExternalTriggerInput,
  type IngestExternalTriggerResult,
} from './ingestion';
import { type ExternalTriggerSourceRow, updateExternalTriggerSourceSyncState } from './source-store';
import { createPersonalVaultExternalSinkForSource, type PersonalVaultExternalSink } from '../personal-vault/live-sink';
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

const GMAIL_API_ORIGIN = 'https://gmail.googleapis.com';
const DEFAULT_RENEW_BEFORE_MS = 24 * 60 * 60 * 1_000;
const MAX_PAGES = 10_000;
/** messages.list pages are capped at 500 by Gmail. */
const MAX_LIST_PAGE_SIZE = 500;
/**
 * Historical messages walked per sync (the CEILING of the adaptive budget).
 * The poll routine fires every minute and each messages.get costs 5 quota
 * units. The prior default of 200 exceeded what this project's per-user
 * per-minute quota actually allows: a 158-message chunk tripped it live
 * (WI-10001549), so the budget starts at 100 and halves per consecutive
 * throttle (see `googleGmailBackfillBudget`) down to the floor below.
 */
export const DEFAULT_BACKFILL_MESSAGES_PER_SYNC = 100;
const MAX_BACKFILL_MESSAGES_PER_SYNC = 5_000;
/** The adaptive budget never shrinks below this (unless the ceiling is smaller). */
export const MIN_BACKFILL_MESSAGES_PER_SYNC = 25;
/**
 * messages.list page size inside a chunk. The continuation token checkpoints
 * per PAGE, so a quota trip mid-page re-walks that page's already-delivered
 * messages on resume (delivery is dedupe-keyed but the gets still cost quota).
 * Small pages bound that waste to <25 gets per throttle; a list call costs 5 units.
 */
const BACKFILL_LIST_PAGE_SIZE = 25;
const BACKFILL_THROTTLE_BASE_MS = 60_000;
const BACKFILL_THROTTLE_MAX_MS = 15 * 60_000;

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

/**
 * Resumable initial-backfill progress, persisted under `cursor.backfill`.
 * `pageToken` is the messages.list continuation the NEXT sync resumes from;
 * `pending` sources are re-synced by every poll until `complete`.
 */
export interface GoogleGmailBackfillState {
  status: 'pending' | 'throttled' | 'complete';
  pageToken: string | null;
  pages: number;
  messages: number;
  startedAt: string;
  completedAt: string | null;
  throttledUntil: string | null;
  throttleCount: number;
}

export interface GoogleGmailSyncResult {
  mode: 'incremental' | 'full';
  messages: number;
  historyPages: number;
  messagePages: number;
  historyId: string;
  /** null for a mailbox that was cursored before resumable backfill existed. */
  backfill: GoogleGmailBackfillState | null;
}

export interface GoogleGmailDraftInput {
  to: string;
  subject: string;
  text: string;
  threadId: string;
  inReplyTo: string;
  references?: string | null;
}

/**
 * A create-shaped outbound message: no thread to reply into, so `threadId` and
 * `inReplyTo` are absent rather than empty. Used by the provider-neutral
 * `mail:send` verb (D-019 Tier 1) whose recipients cleared the D-020 rail-2
 * addressee check before reaching this seam.
 */
export interface GoogleGmailOutboundInput {
  to: string | readonly string[];
  cc?: readonly string[];
  subject: string;
  text: string;
  threadId?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
}

export interface GoogleGmailDraftResult {
  draftId: string;
  messageId: string;
  threadId: string;
}

export interface GoogleGmailSendResult {
  messageId: string;
  threadId: string;
}

type Ingest = (sql: postgres.Sql, input: IngestExternalTriggerInput) => Promise<IngestExternalTriggerResult>;

export interface GoogleGmailDeps {
  fetch?: typeof fetch;
  now?: () => Date;
  apiOrigin?: string;
  ingest?: Ingest;
  createPersonalSink?: (sql: postgres.Sql, workspaceId: string, sourceId: string) => Promise<PersonalVaultExternalSink>;
  /**
   * P-011 app-delivery sink factory. Returning null means "this deployment is
   * not configured to deliver to the Email app", which is the normal state for
   * an install with no owner mapping — not an error.
   */
  createAppSink?: (
    sql: postgres.Sql,
    workspaceId: string,
    sourceId: string,
  ) => Promise<AppDeliveryExternalSink | null>;
  updateSource?: typeof updateExternalTriggerSourceSyncState;
  /** Historical messages walked per sync while a backfill is pending. */
  backfillMessagesPerSync?: number;
}

export class GoogleGmailApiError extends Error {
  constructor(
    readonly status: number,
    readonly operation: string,
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

export function googleGmailSourceHistoryId(source: ExternalTriggerSourceRow): string | null {
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

/** Epoch ms the persisted users.watch expires at; null when no watch was ever recorded. */
export function googleGmailWatchExpiresAt(source: ExternalTriggerSourceRow): number | null {
  const raw = nonEmpty(source.cursor.watchExpiration) ?? nonEmpty(source.cursor.watch_expiration);
  if (!raw) return null;
  const parsed = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function cursorWithoutHistory(cursor: Record<string, unknown>): Record<string, unknown> {
  const cleared = { ...cursor };
  delete cleared.historyId;
  delete cleared.history_id;
  // An expired history cursor means changes were lost; the re-bootstrap walks
  // the mailbox again (delivery is dedupe-keyed, so already-seen mail is a no-op).
  delete cleared.backfill;
  return cleared;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

/** Parse the persisted backfill progress; null when the source never recorded one. */
export function googleGmailBackfillState(source: ExternalTriggerSourceRow): GoogleGmailBackfillState | null {
  const raw = source.cursor.backfill;
  if (!raw || typeof raw !== 'object') return null;
  const state = raw as Record<string, unknown>;
  const status = state.status === 'complete' || state.status === 'throttled' ? state.status : 'pending';
  return {
    status,
    pageToken: nonEmpty(state.pageToken),
    pages: nonNegativeInteger(state.pages),
    messages: nonNegativeInteger(state.messages),
    startedAt: nonEmpty(state.startedAt) ?? new Date(0).toISOString(),
    completedAt: nonEmpty(state.completedAt),
    throttledUntil: nonEmpty(state.throttledUntil),
    throttleCount: nonNegativeInteger(state.throttleCount),
  };
}

/** True while the initial historical walk still has pages (or a throttle) ahead of it. */
export function googleGmailBackfillPending(source: ExternalTriggerSourceRow): boolean {
  const state = googleGmailBackfillState(source);
  return state !== null && state.status !== 'complete';
}

/**
 * True while the backfill is parked on a quota cool-down that has not elapsed.
 * The per-user quota is shared by every Gmail call for that mailbox, so a
 * parked backfill also means "do not spend quota on optional work right now".
 */
export function googleGmailBackfillParked(source: ExternalTriggerSourceRow, now: Date): boolean {
  const state = googleGmailBackfillState(source);
  if (!state || state.status !== 'throttled' || !state.throttledUntil) return false;
  const parkedUntil = Date.parse(state.throttledUntil);
  return Number.isFinite(parkedUntil) && parkedUntil > now.getTime();
}

/** history.list rejecting the stored startHistoryId — the ONLY legitimate full-resync trigger. */
export function isGoogleGmailHistoryExpiredError(cause: unknown): boolean {
  return cause instanceof GoogleGmailApiError && cause.status === 404 && cause.operation === 'history_list';
}

/** messages.get 404: the message was deleted between being listed and being fetched. */
export function isGoogleGmailMessageGoneError(cause: unknown): boolean {
  return cause instanceof GoogleGmailApiError && cause.status === 404 && cause.operation === 'message_get';
}

/** Quota exhaustion is a pause signal for the backfill, never a source failure. */
export function isGoogleGmailQuotaError(cause: unknown): boolean {
  if (!(cause instanceof GoogleGmailApiError)) return false;
  if (cause.status === 429) return true;
  return cause.status === 403 && /quota|rate ?limit|usage ?limit|too many/i.test(cause.message);
}

function backfillBudget(value: number | undefined): number {
  if (value === undefined) return DEFAULT_BACKFILL_MESSAGES_PER_SYNC;
  if (!Number.isInteger(value) || value < 1 || value > MAX_BACKFILL_MESSAGES_PER_SYNC) {
    throw new Error('google_gmail_backfill_messages_per_sync_invalid');
  }
  return value;
}

/**
 * Messages the NEXT chunk may walk: the configured ceiling halved once per
 * consecutive quota throttle, floored at `MIN_BACKFILL_MESSAGES_PER_SYNC`.
 * `throttleCount` resets to 0 on a clean chunk, which restores the ceiling.
 */
export function googleGmailBackfillBudget(ceiling: number, throttleCount: number): number {
  const floor = Math.min(MIN_BACKFILL_MESSAGES_PER_SYNC, ceiling);
  const halvings = Math.min(Math.max(0, Math.trunc(throttleCount)), 10);
  return Math.max(floor, Math.floor(ceiling / 2 ** halvings));
}

function backfillThrottleMs(throttleCount: number): number {
  return Math.min(BACKFILL_THROTTLE_BASE_MS * 2 ** Math.min(throttleCount, 10), BACKFILL_THROTTLE_MAX_MS);
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
  const currentHistoryId = googleGmailSourceHistoryId(source);
  const currentExpiration = googleGmailWatchExpiresAt(source);
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
  const messageId = header(message.payload, 'Message-ID');
  const references = header(message.payload, 'References');
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
  if (messageId) normalized.messageId = messageId;
  if (references) normalized.references = references;
  if (texts.length) normalized.text = [...new Set(texts)].join('\n');
  if (html.length) normalized.html = [...new Set(html)].join('\n');
  const snippet = nonEmpty(message.snippet);
  if (snippet) normalized.snippet = snippet;
  if (time) normalized.occurredAt = time;
  if (message.labelIds?.length) {
    normalized.labels = [...message.labelIds];
    normalized.direction = message.labelIds.some((label) => label === 'SENT' || label === 'DRAFT')
      ? 'outbound'
      : 'inbound';
  }
  return normalized;
}

function safeHeader(value: string, field: string, maxLength = 8_000): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\r\n]/.test(normalized)) {
    throw new Error(`google_gmail_draft_${field}_invalid`);
  }
  return normalized;
}

/**
 * `Re:`-prefix a subject exactly once. Mail-protocol knowledge, so it belongs
 * with the adapter rather than being re-implemented by each caller.
 */
export function replySubjectFor(subject: string): string {
  const normalized = String(subject ?? '').trim();
  return /^re\s*:/i.test(normalized) ? normalized : `Re: ${normalized}`;
}

function replyReferences(references: string | null | undefined, inReplyTo: string): string {
  const prior = references?.trim() ?? '';
  const combined = prior ? `${prior} ${inReplyTo}` : inReplyTo;
  return safeHeader(combined, 'references');
}

export interface GoogleGmailEncodedMessage {
  raw: string;
  to: string;
  subject: string;
  threadId: string | null;
}

/**
 * Encode one outbound message as base64url RFC 2822.
 *
 * Shared by the draft and send seams so threading is implemented exactly once.
 * Reply threading is the part callers get wrong: Gmail needs BOTH the
 * `threadId` on the API request AND `In-Reply-To`/`References` headers in the
 * MIME body. Supplying only one of them produces a message that sends fine and
 * lands OUTSIDE the thread — a silent failure, which is why no agent-facing
 * verb is allowed to assemble this itself.
 */
export function buildGoogleGmailRawMessage(input: GoogleGmailOutboundInput): GoogleGmailEncodedMessage {
  const recipients = (Array.isArray(input.to) ? input.to : [input.to])
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
  if (!recipients.length) throw new Error('google_gmail_to_required');
  const to = safeHeader(recipients.join(', '), 'to', 2_000);
  const cc = (input.cc ?? []).map((value) => String(value ?? '').trim()).filter(Boolean);
  const subject = safeHeader(input.subject, 'subject', 998);
  const text = input.text.trim();
  if (!text || text.length > 100_000) throw new Error('google_gmail_draft_text_invalid');
  const threadId = input.threadId?.trim() ? safeHeader(input.threadId, 'thread_id', 512) : null;
  const inReplyTo = input.inReplyTo?.trim() ? safeHeader(input.inReplyTo, 'in_reply_to', 998) : null;

  const headers = [`To: ${to}`];
  if (cc.length) headers.push(`Cc: ${safeHeader(cc.join(', '), 'cc', 2_000)}`);
  headers.push(`Subject: ${subject}`);
  if (inReplyTo) {
    headers.push(`In-Reply-To: ${inReplyTo}`);
    headers.push(`References: ${replyReferences(input.references, inReplyTo)}`);
  }
  headers.push(
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    text,
  );
  return { raw: Buffer.from(headers.join('\r\n'), 'utf8').toString('base64url'), to, subject, threadId };
}

/** Create one RFC 2822 draft reply; this seam never sends the message. */
export async function createGoogleGmailDraft(
  accessToken: string,
  input: GoogleGmailDraftInput,
  provided: Pick<GoogleGmailDeps, 'fetch' | 'apiOrigin'> = {},
): Promise<GoogleGmailDraftResult> {
  const token = accessToken.trim();
  if (!token) throw new Error('google_gmail_access_token_required');
  const encoded = buildGoogleGmailRawMessage(input);
  const threadId = encoded.threadId;
  if (!threadId) throw new Error('google_gmail_draft_thread_id_invalid');
  const raw = encoded.raw;
  const body = await gmailRequest<{
    id?: string;
    message?: { id?: string; threadId?: string };
  }>(
    provided.fetch ?? fetch,
    (provided.apiOrigin ?? GMAIL_API_ORIGIN).replace(/\/$/, ''),
    token,
    '/gmail/v1/users/me/drafts',
    'draft_create',
    {
      method: 'POST',
      body: { message: { raw, threadId } },
    },
  );
  const draftId = nonEmpty(body.id);
  const messageId = nonEmpty(body.message?.id);
  const createdThreadId = nonEmpty(body.message?.threadId);
  if (!draftId || !messageId || !createdThreadId) throw new Error('google_gmail_draft_response_invalid');
  if (createdThreadId !== threadId) throw new Error('google_gmail_draft_thread_mismatch');
  return { draftId, messageId, threadId: createdThreadId };
}

/**
 * Send one message. Reply-shaped when `threadId`/`inReplyTo` are present,
 * create-shaped when they are not.
 *
 * D-020: reaching this seam means the destination was either server-resolved
 * from a stored canonical object (rail 1) or cleared the trusted-addressee
 * check (rail 2). This function performs NEITHER check — it is the transport,
 * and calling it directly from a tool handler would bypass both rails.
 */
export async function sendGoogleGmailMessage(
  accessToken: string,
  input: GoogleGmailOutboundInput,
  provided: Pick<GoogleGmailDeps, 'fetch' | 'apiOrigin'> = {},
): Promise<GoogleGmailSendResult> {
  const token = accessToken.trim();
  if (!token) throw new Error('google_gmail_access_token_required');
  const encoded = buildGoogleGmailRawMessage(input);
  const body = await gmailRequest<{ id?: string; threadId?: string }>(
    provided.fetch ?? fetch,
    (provided.apiOrigin ?? GMAIL_API_ORIGIN).replace(/\/$/, ''),
    token,
    '/gmail/v1/users/me/messages/send',
    'message_send',
    {
      method: 'POST',
      body: encoded.threadId ? { raw: encoded.raw, threadId: encoded.threadId } : { raw: encoded.raw },
    },
  );
  const messageId = nonEmpty(body.id);
  const threadId = nonEmpty(body.threadId);
  if (!messageId || !threadId) throw new Error('google_gmail_send_response_invalid');
  if (encoded.threadId && threadId !== encoded.threadId) {
    throw new Error('google_gmail_send_thread_mismatch');
  }
  return { messageId, threadId };
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

/**
 * A listed message can be deleted (a discarded draft, purged spam) before it
 * is fetched. That is a fact about ONE message, never about the mailbox
 * cursor: skip it — dedupe keys make a later re-list harmless.
 */
async function getMessageIfPresent(
  fetchImpl: typeof fetch,
  apiOrigin: string,
  accessToken: string,
  messageId: string,
): Promise<GoogleGmailMessage | null> {
  try {
    return await getMessage(fetchImpl, apiOrigin, accessToken, messageId);
  } catch (cause) {
    if (isGoogleGmailMessageGoneError(cause)) return null;
    throw cause;
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
  sinks: IngestSink[],
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
    additionalSinks: [...sinks],
  });
  if (!result.ok) throw new Error(`google_gmail_delivery_failed:${id}`);
}

async function incrementalSync(
  sql: postgres.Sql,
  source: ExternalTriggerSourceRow,
  accessToken: string,
  startHistoryId: string,
  sinks: IngestSink[],
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
        const fetched = await getMessageIfPresent(deps.fetch, deps.apiOrigin, accessToken, id);
        if (!fetched) continue;
        await deliver(sql, deps.ingest, sinks, source, fetched);
        delivered.add(id);
      }
    }
    nextHistoryId = nonEmpty(body.historyId) ?? nextHistoryId;
    pageToken = nonEmpty(body.nextPageToken);
  } while (pageToken);
  if (!nextHistoryId) throw new Error('google_gmail_next_history_id_missing');
  return { messages: delivered.size, pages, historyId: nextHistoryId };
}

function newBackfillState(now: Date): GoogleGmailBackfillState {
  return {
    status: 'pending',
    pageToken: null,
    pages: 0,
    messages: 0,
    startedAt: now.toISOString(),
    completedAt: null,
    throttledUntil: null,
    throttleCount: 0,
  };
}

/**
 * Walk at most `budget` historical messages (newest first, as messages.list
 * orders them), checkpointing the continuation token after every page so an
 * interrupted walk resumes where it stopped instead of restarting from zero.
 * Quota exhaustion parks the walk with an exponential cool-down; delivery is
 * dedupe-keyed, so re-listing a partially delivered page is harmless.
 */
async function backfillChunk(
  sql: postgres.Sql,
  source: ExternalTriggerSourceRow,
  accessToken: string,
  sinks: IngestSink[],
  deps: Required<Pick<GoogleGmailDeps, 'fetch' | 'apiOrigin' | 'ingest'>>,
  updateSource: typeof updateExternalTriggerSourceSyncState,
  initial: GoogleGmailBackfillState,
  budget: number,
  now: Date,
): Promise<{ messages: number; pages: number; state: GoogleGmailBackfillState; source: ExternalTriggerSourceRow }> {
  let state: GoogleGmailBackfillState = { ...initial, status: 'pending', throttledUntil: null };
  let workingSource = source;
  let messages = 0;
  let pages = 0;
  const pageSize = Math.min(budget, BACKFILL_LIST_PAGE_SIZE, MAX_LIST_PAGE_SIZE);
  const persist = async (next: GoogleGmailBackfillState): Promise<void> => {
    state = next;
    workingSource = await updateSource(sql, source.workspaceId, source.id, {
      status: 'connecting',
      cursor: { ...workingSource.cursor, backfill: next },
      lastError: null,
    });
  };
  while (messages < budget) {
    if (state.pages + 1 > MAX_PAGES) throw new Error('google_gmail_message_page_limit_exceeded');
    const params = new URLSearchParams({ maxResults: String(pageSize) });
    if (state.pageToken) params.set('pageToken', state.pageToken);
    let delivered = 0;
    let nextPageToken: string | null = null;
    try {
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
        const fetched = await getMessageIfPresent(deps.fetch, deps.apiOrigin, accessToken, id);
        if (!fetched) continue;
        await deliver(sql, deps.ingest, sinks, source, fetched);
        delivered += 1;
      }
      nextPageToken = nonEmpty(body.nextPageToken);
    } catch (cause) {
      if (!isGoogleGmailQuotaError(cause)) throw cause;
      const throttleCount = state.throttleCount + 1;
      await persist({
        ...state,
        status: 'throttled',
        messages: state.messages + delivered,
        throttledUntil: new Date(now.getTime() + backfillThrottleMs(state.throttleCount)).toISOString(),
        throttleCount,
      });
      return { messages: messages + delivered, pages, state, source: workingSource };
    }
    messages += delivered;
    pages += 1;
    const complete = nextPageToken === null;
    await persist({
      ...state,
      status: complete ? 'complete' : 'pending',
      pageToken: nextPageToken,
      pages: state.pages + 1,
      messages: state.messages + delivered,
      completedAt: complete ? now.toISOString() : null,
      throttleCount: 0,
    });
    if (complete) break;
  }
  return { messages, pages, state, source: workingSource };
}

/**
 * Reconcile one owned source: replay history since the stored cursor, bootstrap
 * a cursorless mailbox onto its profile historyId, then advance the resumable
 * backfill by one budgeted chunk. The history cursor commits only after every
 * delivery of the incremental pass succeeds.
 */
export async function syncGoogleGmailSource(
  sql: postgres.Sql,
  source: ExternalTriggerSourceRow,
  accessToken: string,
  provided: GoogleGmailDeps = {},
): Promise<GoogleGmailSyncResult> {
  assertSource(source, accessToken);
  const budgetCeiling = backfillBudget(provided.backfillMessagesPerSync);
  const deps = {
    fetch: provided.fetch ?? fetch,
    apiOrigin: (provided.apiOrigin ?? GMAIL_API_ORIGIN).replace(/\/$/, ''),
    ingest: provided.ingest ?? ((db, event) => ingestExternalTriggerEvent(db, event)),
  };
  const updateSource = provided.updateSource ?? updateExternalTriggerSourceSyncState;
  const createSink = provided.createPersonalSink ?? createPersonalVaultExternalSinkForSource;
  const sink = await createSink(sql, source.workspaceId, source.id);
  // P-011: deliver into the Email app as messages land, but only where an owner
  // mapping configures it. Resolved ONCE per sync, not per message.
  const createAppSink = provided.createAppSink
    ?? ((db: postgres.Sql, workspaceId: string, sourceId: string) =>
      createAppDeliverySinkIfConfigured(db, workspaceId, sourceId, 'email', {
        // P-007: the gate swallows its own errors to protect the sync (D-013),
        // so without this a registration fault is invisible everywhere.
        onGateError: reportAppSinkGateError,
      }));
  const appSink = await createAppSink(sql, source.workspaceId, source.id);
  const sinks: IngestSink[] = appSink ? [sink, appSink] : [sink];
  const now = (provided.now ?? (() => new Date()))();
  if (!Number.isFinite(now.getTime())) throw new Error('google_gmail_now_invalid');
  let workingSource = source;
  let historyId = googleGmailSourceHistoryId(source);
  let mode: GoogleGmailSyncResult['mode'] = historyId ? 'incremental' : 'full';
  let messages = 0;
  let historyPages = 0;
  let messagePages = 0;

  if (historyId) {
    try {
      const synced = await incrementalSync(sql, source, accessToken, historyId, sinks, deps);
      messages = synced.messages;
      historyPages = synced.pages;
      historyId = synced.historyId;
    } catch (cause) {
      // ONLY history.list itself saying the cursor is too old justifies the
      // full re-bootstrap below (which discards the resumable backfill). A 404
      // from any other call — messages.get for a message deleted between the
      // history page and its fetch — used to land here too and restarted the
      // backfill from zero every few minutes (EI-23429618437235533).
      if (!isGoogleGmailHistoryExpiredError(cause)) throw cause;
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
    // Pin the incremental cursor BEFORE any historical walk: from here on new
    // mail is replayed via history and the watch can be established, while the
    // backfill below is free to take as many polls as the quota allows.
    const mailbox = await profile(deps.fetch, deps.apiOrigin, accessToken);
    historyId = mailbox.historyId;
    workingSource = await updateSource(sql, source.workspaceId, source.id, {
      status: 'connecting',
      cursor: {
        ...workingSource.cursor,
        emailAddress: mailbox.emailAddress,
        historyId,
        backfill: newBackfillState(now),
      },
      lastError: null,
    });
  }

  let backfill = googleGmailBackfillState(workingSource);
  if (backfill && backfill.status !== 'complete') {
    if (!googleGmailBackfillParked(workingSource, now)) {
      // A mailbox that just tripped its quota walks a smaller chunk this time;
      // the ceiling comes back once a chunk completes cleanly.
      const budget = googleGmailBackfillBudget(budgetCeiling, backfill.throttleCount);
      const chunk = await backfillChunk(sql, workingSource, accessToken, sinks, deps, updateSource, backfill, budget, now);
      messages += chunk.messages;
      messagePages += chunk.pages;
      backfill = chunk.state;
      workingSource = chunk.source;
    }
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
  return { mode, messages, historyPages, messagePages, historyId, backfill };
}
