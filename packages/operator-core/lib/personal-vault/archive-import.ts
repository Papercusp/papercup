import AdmZip from 'adm-zip';
import type { PersonalDocumentInput } from './types';
import { dedupeKeyFor, normalizeParticipant, normalizePersonalSource } from './store';

const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 50_000;

export interface ParsedPersonalArchive {
  documents: PersonalDocumentInput[];
  sources: string[];
  warnings: string[];
}

function unfoldLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function headerMap(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = raw.replace(/\r\n/g, '\n').replace(/\n[ \t]+/g, ' ').split('\n');
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    out.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  return out;
}

function addresses(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(',').map(normalizeParticipant).filter(Boolean);
}

export function parseMbox(text: string): PersonalDocumentInput[] {
  const chunks = text.replace(/\r\n/g, '\n').split(/\n(?=From [^\n]+\n)/g);
  return chunks.flatMap((chunk, index) => {
    const withoutEnvelope = chunk.replace(/^From [^\n]*\n/, '');
    const split = withoutEnvelope.search(/\n\n/);
    if (split < 0) return [];
    const headers = headerMap(withoutEnvelope.slice(0, split));
    const body = withoutEnvelope.slice(split + 2).trim();
    const externalId = headers.get('message-id')?.replace(/[<>]/g, '') ?? null;
    const doc: PersonalDocumentInput = {
      source: 'gmail',
      kind: 'message',
      externalId,
      occurredAt: headers.get('date') ?? null,
      participants: [...addresses(headers.get('from')), ...addresses(headers.get('to')), ...addresses(headers.get('cc'))],
      title: headers.get('subject') ?? '(no subject)',
      text: body,
      metadata: { from: headers.get('from') ?? null, to: headers.get('to') ?? null },
    };
    doc.dedupeKey = externalId ? `gmail:${externalId}` : `gmail:mbox:${index}:${dedupeKeyFor(doc)}`;
    return [doc];
  });
}

function icalValue(lines: string[], key: string): string | undefined {
  const line = lines.find((l) => l.toUpperCase().startsWith(`${key.toUpperCase()}:`) || l.toUpperCase().startsWith(`${key.toUpperCase()};`));
  return line?.slice(line.indexOf(':') + 1).replace(/\\n/g, '\n').replace(/\\,/g, ',').trim();
}

function icalDate(raw: string | undefined): string | null {
  if (!raw) return null;
  if (/^\d{8}T\d{6}Z$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(9, 11)}:${raw.slice(11, 13)}:${raw.slice(13, 15)}Z`;
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T00:00:00Z`;
  return raw;
}

export function parseIcs(text: string): PersonalDocumentInput[] {
  const lines = unfoldLines(text);
  const blocks: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') current = [];
    else if (line === 'END:VEVENT' && current) { blocks.push(current); current = null; }
    else if (current) current.push(line);
  }
  return blocks.map((block, index) => {
    const uid = icalValue(block, 'UID') ?? `event-${index}`;
    const participantLines = block.filter((l) => /^(ATTENDEE|ORGANIZER)[;:]/i.test(l));
    const participants = participantLines.map((l) => normalizeParticipant(l.slice(l.indexOf(':') + 1))).filter(Boolean);
    return {
      source: 'calendar', kind: 'event', externalId: uid,
      occurredAt: icalDate(icalValue(block, 'DTSTART')),
      participants,
      title: icalValue(block, 'SUMMARY') ?? '(untitled event)',
      text: icalValue(block, 'DESCRIPTION') ?? '',
      metadata: { location: icalValue(block, 'LOCATION') ?? null, end: icalDate(icalValue(block, 'DTEND')) },
      dedupeKey: `calendar:${uid}`,
    };
  });
}

export function parseVcard(text: string): PersonalDocumentInput[] {
  const lines = unfoldLines(text);
  const blocks: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (line === 'BEGIN:VCARD') current = [];
    else if (line === 'END:VCARD' && current) { blocks.push(current); current = null; }
    else if (current) current.push(line);
  }
  return blocks.map((block, index) => {
    const value = (key: string) => block.find((l) => l.toUpperCase().startsWith(`${key}:`) || l.toUpperCase().startsWith(`${key};`))?.slice(block.find((l) => l.toUpperCase().startsWith(`${key}:`) || l.toUpperCase().startsWith(`${key};`))!.indexOf(':') + 1).trim();
    const email = value('EMAIL')?.toLowerCase() ?? null;
    const name = value('FN') ?? email ?? `Contact ${index + 1}`;
    return {
      source: 'contacts', kind: 'contact', externalId: value('UID') ?? email,
      participants: email ? [email] : [], title: name,
      text: [email, value('TEL'), value('ORG')].filter(Boolean).join('\n'),
      metadata: { email, phone: value('TEL') ?? null, organization: value('ORG') ?? null },
      dedupeKey: `contacts:${value('UID') ?? email ?? dedupeKeyFor({ source: 'contacts', kind: 'contact', title: name })}`,
    };
  });
}

function jsonAfterAssignment(text: string): unknown {
  const trimmed = text.trim().replace(/^window\.YTD\.[^=]+\s*=\s*/, '').replace(/;\s*$/, '');
  return JSON.parse(trimmed);
}

function parseSocialJson(path: string, text: string): PersonalDocumentInput[] {
  let parsed: unknown;
  try { parsed = jsonAfterAssignment(text); } catch { return []; }
  const lower = path.toLowerCase();
  if (lower.includes('tweet')) {
    const rows = Array.isArray(parsed) ? parsed : [];
    return rows.flatMap((entry) => {
      const tweet = (entry as { tweet?: Record<string, unknown> }).tweet ?? entry as Record<string, unknown>;
      if (!tweet || typeof tweet !== 'object') return [];
      const id = String(tweet.id_str ?? tweet.id ?? '');
      return [{
        source: 'x', kind: 'post', externalId: id || null,
        occurredAt: typeof tweet.created_at === 'string' ? tweet.created_at : null,
        participants: typeof tweet.in_reply_to_screen_name === 'string' ? [tweet.in_reply_to_screen_name] : [],
        title: 'Post on X', text: String(tweet.full_text ?? tweet.text ?? ''), metadata: tweet,
        dedupeKey: `x:${id || dedupeKeyFor({ source: 'x', kind: 'post', text: String(tweet.full_text ?? '') })}`,
      } satisfies PersonalDocumentInput];
    });
  }
  const root = parsed as { participants?: Array<{ name?: string }>; messages?: Array<Record<string, unknown>> };
  if (Array.isArray(root?.messages)) {
    const source = lower.includes('instagram') ? 'instagram' : 'facebook';
    const threadParticipants = (root.participants ?? []).map((p) => p.name ?? '').filter(Boolean);
    return root.messages.map((m, index) => ({
      source, kind: 'message', externalId: String(m.id ?? `${m.timestamp_ms ?? 'unknown'}-${index}`),
      occurredAt: typeof m.timestamp_ms === 'number' ? new Date(m.timestamp_ms).toISOString() : null,
      participants: [...threadParticipants, String(m.sender_name ?? '')].filter(Boolean),
      title: `Conversation with ${threadParticipants.join(', ') || 'unknown'}`,
      text: String(m.content ?? ''), metadata: m,
      dedupeKey: `${source}:${String(m.id ?? `${m.timestamp_ms ?? 'unknown'}-${index}`)}`,
    }));
  }
  return [];
}

function parseEntry(path: string, data: Buffer): PersonalDocumentInput[] {
  const lower = path.toLowerCase();
  const text = data.toString('utf8');
  if (lower.endsWith('.mbox')) return parseMbox(text);
  if (lower.endsWith('.ics')) return parseIcs(text);
  if (lower.endsWith('.vcf')) return parseVcard(text);
  if (lower.endsWith('.json') || lower.endsWith('.js')) return parseSocialJson(path, text);
  return [];
}

export function parsePersonalArchive(filename: string, bytes: Buffer): ParsedPersonalArchive {
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error('personal_archive_too_large');
  const warnings: string[] = [];
  let documents: PersonalDocumentInput[] = [];
  if (filename.toLowerCase().endsWith('.zip')) {
    const zip = new AdmZip(bytes);
    const entries = zip.getEntries().filter((e) => !e.isDirectory);
    if (entries.length > MAX_ARCHIVE_ENTRIES) throw new Error('personal_archive_too_many_entries');
    const total = entries.reduce((n, e) => n + Number(e.header.size), 0);
    if (total > MAX_ARCHIVE_BYTES) throw new Error('personal_archive_uncompressed_too_large');
    for (const entry of entries) {
      try { documents.push(...parseEntry(entry.entryName, entry.getData())); }
      catch (err) { warnings.push(`${entry.entryName}: ${(err as Error).message}`); }
    }
  } else {
    documents = parseEntry(filename, bytes);
  }
  documents = documents.map((d) => ({ ...d, source: normalizePersonalSource(d.source), dedupeKey: dedupeKeyFor(d) }));
  if (!documents.length) warnings.push('No supported Gmail/Calendar/Contacts, Facebook/Instagram, or X records were found.');
  return { documents, sources: [...new Set(documents.map((d) => d.source))].sort(), warnings };
}
