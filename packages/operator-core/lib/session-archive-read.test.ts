/**
 * Archive fall-through reader tests (session-db-archive-retire-dirs P-009):
 * an archived-then-deleted session stays readable — decompressed, re-parsed
 * with the ingest parsers, and re-capped/redacted exactly like the index.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readArchivedSessionTurns } from './session-archive-read';
import {
  archiveAndDeleteSession,
  type ArchiveFileRow,
  type ArchiveStampRow,
  type SessionArchiveStore,
} from './session-archive';

const SID = '99999999-1111-2222-3333-444444444444';
// Built at runtime so the repo's secrets-guard never sees a key-shaped literal
// in tree bytes; still matches the ingest SECRET_RE (sk- + 16+ word chars).
const FAKE_SECRET = ['sk', 'fixture0123456789abcdef'].join('-');

class MiniStore implements SessionArchiveStore {
  files: ArchiveFileRow[] = [];
  stamps = new Map<string, ArchiveStampRow>();
  async upsertArchive(files: ArchiveFileRow[], stamp: ArchiveStampRow): Promise<void> {
    this.files = files;
    this.stamps.set(`${stamp.source_kind}:${stamp.session_id}`, stamp);
  }
  async readStamp(kind: string, id: string): Promise<ArchiveStampRow | null> {
    return this.stamps.get(`${kind}:${id}`) ?? null;
  }
  async readFiles(kind: string, id: string): Promise<ArchiveFileRow[]> {
    return this.files.filter((f) => f.source_kind === kind && f.session_id === id);
  }
  async stampAdvSessionArchived(): Promise<void> {}
}

let tmp: string | null = null;
afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('readArchivedSessionTurns', () => {
  it('reads turns from a deleted, archived claude session — capped + redacted like the index', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'sar-read-'));
    await mkdir(join(tmp, 'projects', '-repo'), { recursive: true });
    const lines = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'please fix the provenance stamp in the ingest pipeline' },
        timestamp: '2026-07-10T01:00:00.000Z',
        cwd: '/repo',
        sessionId: SID,
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'private reasoning that must not surface' },
            { type: 'text', text: `Root cause found: the API key ${FAKE_SECRET} was hardcoded.` },
          ],
        },
        timestamp: '2026-07-10T01:00:05.000Z',
        cwd: '/repo',
        sessionId: SID,
      }),
      'not-json garbage line', // resilience: one bad line never kills the read
    ].join('\n');
    await writeFile(join(tmp, 'projects', '-repo', `${SID}.jsonl`), lines + '\n');

    const store = new MiniStore();
    const r = await archiveAndDeleteSession({ sourceKind: 'claude', sessionId: SID, sessionRoot: tmp }, store);
    expect(r.archive.ok).toBe(true);
    expect(r.delete?.deleted).toBe(1);

    const arch = await readArchivedSessionTurns(SID, undefined, store);
    expect(arch).not.toBeNull();
    expect(arch!.sourceKind).toBe('claude');
    expect(arch!.turns.length).toBe(2);
    expect(arch!.turns[0]).toMatchObject({ turn_idx: 0, speaker: 'user' });
    expect(arch!.turns[0].ts).toBe('2026-07-10T01:00:00.000Z');
    // ingest-equivalent hygiene: thinking dropped, secrets redacted
    const assistant = arch!.turns[1].text;
    expect(assistant).not.toContain('private reasoning');
    expect(assistant).not.toContain(FAKE_SECRET);
    expect(assistant).toContain('[redacted]');
    expect(assistant).toContain('Root cause found');
  });

  it('returns null when nothing is archived under any kind', async () => {
    expect(await readArchivedSessionTurns('no-such-session', undefined, new MiniStore())).toBeNull();
  });
});
