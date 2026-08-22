import type { Sql } from 'postgres';
import type { PersonalDocumentInput } from './types';
import { setPersonalSyncState, upsertPersonalDocuments } from './store';

export interface NormalizedExternalEvent {
  key: string;
  externalId: string;
  occurredAt?: string | null;
  payload: Record<string, unknown>;
}

const strings = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((v): v is string => typeof v === 'string')
  : typeof value === 'string' ? [value] : [];

export function personalDocumentFromExternalEvent(event: NormalizedExternalEvent): PersonalDocumentInput {
  const p = event.payload;
  if (event.key.startsWith('ext:gmail:')) {
    return {
      source: 'gmail', kind: 'message', externalId: event.externalId, occurredAt: event.occurredAt,
      participants: [...strings(p.from), ...strings(p.to), ...strings(p.cc)],
      title: String(p.subject ?? '(no subject)'), text: String(p.text ?? p.snippet ?? ''),
      metadata: p, dedupeKey: `gmail:${event.externalId}`,
    };
  }
  if (event.key.startsWith('ext:gcal:')) {
    const attendees = Array.isArray(p.attendees)
      ? p.attendees.flatMap((a) => typeof a === 'string' ? [a] : strings((a as { email?: unknown }).email))
      : [];
    return {
      source: 'calendar', kind: 'event', externalId: event.externalId, occurredAt: event.occurredAt,
      participants: [...strings(p.organizer), ...attendees],
      title: String(p.summary ?? '(untitled event)'), text: String(p.description ?? ''),
      metadata: p, dedupeKey: `calendar:${event.externalId}`,
    };
  }
  throw new Error(`unsupported_personal_event:${event.key}`);
}

/** Second-sink seam consumed by the external-trigger adapters: normalization is
 * done once, then the same event feeds ext:* and this local Personal Vault row. */
export async function ingestPersonalExternalEvent(
  sql: Sql,
  workspaceId: string,
  userId: string,
  event: NormalizedExternalEvent,
): Promise<{ insertedOrUpdated: number; ids: string[] }> {
  return upsertPersonalDocuments(sql, workspaceId, userId, [personalDocumentFromExternalEvent(event)]);
}

export async function syncGoogleContacts(
  sql: Sql,
  input: {
    workspaceId: string;
    userId: string;
    accessToken: string;
    fetchImpl?: typeof fetch;
    pageToken?: string | null;
  },
): Promise<{ contacts: number; pages: number; nextPageToken: string | null }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  let pageToken = input.pageToken ?? null;
  let contacts = 0;
  let pages = 0;
  do {
    const url = new URL('https://people.googleapis.com/v1/people/me/connections');
    url.searchParams.set('personFields', 'names,emailAddresses,phoneNumbers,organizations');
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${input.accessToken}` } });
    if (!response.ok) throw new Error(`google_people_${response.status}`);
    const body = await response.json() as {
      connections?: Array<Record<string, unknown>>;
      nextPageToken?: string;
      totalPeople?: number;
    };
    const docs = (body.connections ?? []).map((person): PersonalDocumentInput => {
      const names = person.names as Array<{ displayName?: string }> | undefined;
      const emails = person.emailAddresses as Array<{ value?: string }> | undefined;
      const phones = person.phoneNumbers as Array<{ value?: string }> | undefined;
      const resourceName = String(person.resourceName ?? '');
      const primaryEmail = emails?.map((e) => e.value).find(Boolean) ?? null;
      return {
        source: 'contacts', kind: 'contact', externalId: resourceName || primaryEmail,
        participants: emails?.map((e) => e.value ?? '').filter(Boolean) ?? [],
        title: names?.map((n) => n.displayName).find(Boolean) ?? primaryEmail ?? '(unnamed contact)',
        text: [...(emails?.map((e) => e.value) ?? []), ...(phones?.map((p) => p.value) ?? [])].filter(Boolean).join('\n'),
        metadata: person,
        dedupeKey: `contacts:${resourceName || primaryEmail || JSON.stringify(person)}`,
      };
    });
    if (docs.length) await upsertPersonalDocuments(sql, input.workspaceId, input.userId, docs);
    contacts += docs.length;
    pages += 1;
    pageToken = body.nextPageToken ?? null;
    await setPersonalSyncState(sql, input.workspaceId, input.userId, 'contacts', { pageToken, totalPeople: body.totalPeople ?? null });
  } while (pageToken);
  return { contacts, pages, nextPageToken: pageToken };
}
