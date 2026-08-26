import { afterEach, describe, expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseIcs,
  parseMbox,
  parsePersonalArchive,
  parseVcard,
  streamPersonalArchiveFile,
} from './archive-import';
import { PersonalArchiveEncryptedWriter } from './archive-encryption';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

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

  it('streams Meta message arrays one record at a time and resumes from a record checkpoint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'papercusp-meta-import-'));
    tempDirs.push(dir);
    const path = join(dir, 'archive.bin');
    const messages = Array.from({ length: 250 }, (_, index) => ({
      id: `message-${index}`,
      sender_name: index % 2 ? 'Ada' : 'Bob',
      timestamp_ms: 1_787_000_000_000 + index,
      content: `Message ${index}`,
    }));
    const zip = new AdmZip();
    zip.addFile(
      'facebook/messages/inbox/thread/message_1.json',
      Buffer.from(JSON.stringify({ participants: [{ name: 'Ada' }, { name: 'Bob' }], messages })),
    );
    const writer = await PersonalArchiveEncryptedWriter.create('workspace-a', path, {
      chunkBytes: 1024,
    });
    await writer.write(zip.toBuffer());
    await writer.finish();

    const first: string[] = [];
    for await (const record of streamPersonalArchiveFile(
      'workspace-a',
      'facebook.zip',
      path,
      {},
    )) {
      if (record.document) first.push(record.document.externalId!);
      if (first.length === 125) break;
    }
    const resumed: string[] = [];
    for await (const record of streamPersonalArchiveFile(
      'workspace-a',
      'facebook.zip',
      path,
      { entryIndex: 0, recordIndex: 125 },
    )) {
      if (record.document) resumed.push(record.document.externalId!);
    }
    expect(first).toEqual(messages.slice(0, 125).map(({ id }) => id));
    expect(resumed).toEqual(messages.slice(125).map(({ id }) => id));
  });
});
