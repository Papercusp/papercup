import { describe, expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import { parseIcs, parseMbox, parsePersonalArchive, parseVcard } from './archive-import';

describe('Personal Vault archive importers', () => {
  it('parses Gmail mbox messages with stable ids and participants', () => {
    const docs = parseMbox('From sender@example.com Tue Jan 1 00:00:00 2026\nMessage-ID: <m1@example.com>\nDate: Tue, 01 Jan 2026 00:00:00 +0000\nFrom: Ada <ada@example.com>\nTo: Bob <bob@example.com>\nSubject: Planning\n\nBring the notes.');
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ source: 'gmail', externalId: 'm1@example.com', title: 'Planning', dedupeKey: 'gmail:m1@example.com' });
    expect(docs[0]!.participants).toEqual(['ada@example.com', 'bob@example.com']);
  });

  it('parses Calendar ICS and Contacts vCard exports', () => {
    const events = parseIcs('BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:e1\nDTSTART:20260822T120000Z\nSUMMARY:Review\nATTENDEE:mailto:ada@example.com\nDESCRIPTION:Agenda\nEND:VEVENT\nEND:VCALENDAR');
    expect(events[0]).toMatchObject({ source: 'calendar', externalId: 'e1', title: 'Review' });
    expect(events[0]!.participants).toEqual(['ada@example.com']);
    const contacts = parseVcard('BEGIN:VCARD\nFN:Ada Lovelace\nEMAIL:ada@example.com\nTEL:+1-555-0100\nEND:VCARD');
    expect(contacts[0]).toMatchObject({ source: 'contacts', title: 'Ada Lovelace', externalId: 'ada@example.com' });
  });

  it('parses Facebook/Instagram and X JSON inside one local ZIP', () => {
    const zip = new AdmZip();
    zip.addFile('facebook/messages/inbox/thread/message_1.json', Buffer.from(JSON.stringify({
      participants: [{ name: 'Ada' }, { name: 'Bob' }],
      messages: [{ sender_name: 'Ada', timestamp_ms: 1_787_000_000_000, content: 'Hello' }],
    })));
    zip.addFile('data/tweets.js', Buffer.from('window.YTD.tweets.part0 = [{"tweet":{"id_str":"42","created_at":"2026-08-21T00:00:00Z","full_text":"A post"}}];'));
    const parsed = parsePersonalArchive('exports.zip', zip.toBuffer());
    expect(parsed.sources).toEqual(['facebook', 'x']);
    expect(parsed.documents.map((d) => d.kind).sort()).toEqual(['message', 'post']);
    expect(parsed.warnings).toEqual([]);
  });
});
