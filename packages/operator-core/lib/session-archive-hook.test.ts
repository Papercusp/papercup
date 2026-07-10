/**
 * End-of-session fast-path tests (session-db-archive-retire-dirs-2026-07-10
 * P-004): the adv-row → archive-ref resolver, and the full run pass with
 * injected deps (no PG): final ingest fires for the transcript, the archive
 * is stamped, the file is deleted, adv gets its archived stamp.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveArchiveRefForAdvRow,
  runArchiveForAdvSession,
  type AdvRowForArchive,
  type ArchiveRoots,
} from './session-archive-hook';
import type { ArchiveFileRow, ArchiveStampRow, SessionArchiveStore } from './session-archive';

const SID = 'cccccccc-1111-2222-3333-444444444444';

const ROOTS: ArchiveRoots = {
  claudeSessionRoot: '/sc',
  codexHomeFor: (id) => `/codex-homes/session-${id}`,
  ompRoot: '/omp-sessions',
};

function row(over: Partial<AdvRowForArchive> = {}): AdvRowForArchive {
  return {
    id: 9,
    agent: 'claude',
    mode: 'console',
    cwd: '/repo',
    coord_owner_id: 'su-t',
    session_id: SID,
    ...over,
  };
}

class MiniStore implements SessionArchiveStore {
  files: ArchiveFileRow[] = [];
  stamps = new Map<string, ArchiveStampRow>();
  advStamps: number[] = [];
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
  async stampAdvSessionArchived(advSessionId: number): Promise<void> {
    this.advStamps.push(advSessionId);
  }
}

describe('resolveArchiveRefForAdvRow', () => {
  it('claude → per-owner config dir under the session-claude root', () => {
    const ref = resolveArchiveRefForAdvRow(row(), ROOTS);
    expect(ref).toMatchObject({
      sourceKind: 'claude',
      sessionId: SID,
      sessionRoot: join('/sc', 'su-t'),
      owner: 'su-t',
      advSessionId: 9,
      archivedBy: 'exit-hook',
    });
  });

  it('claude without an owner is unresolvable (disk-side reconciler catches it)', () => {
    expect(resolveArchiveRefForAdvRow(row({ coord_owner_id: null }), ROOTS)).toBeNull();
  });

  it('codex → the per-adv-session CODEX_HOME', () => {
    const ref = resolveArchiveRefForAdvRow(row({ agent: 'codex', id: 7 }), ROOTS);
    expect(ref).toMatchObject({ sourceKind: 'codex', sessionRoot: '/codex-homes/session-7' });
  });

  it('omp → the shared omp sessions root; mode=omp fallback when agent is null', () => {
    expect(resolveArchiveRefForAdvRow(row({ agent: 'omp' }), ROOTS)).toMatchObject({
      sourceKind: 'omp',
      sessionRoot: '/omp-sessions',
    });
    expect(resolveArchiveRefForAdvRow(row({ agent: null, mode: 'omp' }), ROOTS)).toMatchObject({
      sourceKind: 'omp',
    });
  });

  it('no native session id or unknown agent → null', () => {
    expect(resolveArchiveRefForAdvRow(row({ session_id: null }), ROOTS)).toBeNull();
    expect(resolveArchiveRefForAdvRow(row({ agent: 'gemini' }), ROOTS)).toBeNull();
  });
});

describe('runArchiveForAdvSession (injected deps, no PG)', () => {
  let tmp: string | null = null;
  afterEach(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
    tmp = null;
  });

  it('ingests the transcript tail, archives, deletes, stamps adv', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'sa-hook-'));
    await mkdir(join(tmp, 'su-t', 'projects', '-repo'), { recursive: true });
    const abs = join(tmp, 'su-t', 'projects', '-repo', `${SID}.jsonl`);
    await writeFile(abs, '{"type":"user"}\n');

    const store = new MiniStore();
    const ingested: string[] = [];
    const r = await runArchiveForAdvSession(9, {
      loadRow: async () => row(),
      roots: { ...ROOTS, claudeSessionRoot: tmp },
      store,
      ingestFile: async (p) => {
        ingested.push(p);
      },
    });

    expect(r.ok).toBe(true);
    expect(r.archive?.fileCount).toBe(1);
    expect(r.delete?.deleted).toBe(1);
    expect(ingested).toEqual([abs]);
    expect(store.stamps.has(`claude:${SID}`)).toBe(true);
    expect(store.advStamps).toEqual([9]);
    expect(existsSync(abs)).toBe(false);
  });

  it('row_not_found / unresolvable are reported, never throw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); // the unresolvable path warns by design
    expect(await runArchiveForAdvSession(1, { loadRow: async () => null })).toMatchObject({
      ok: false,
      reason: 'row_not_found',
    });
    expect(
      await runArchiveForAdvSession(2, {
        loadRow: async () => row({ session_id: null }),
        roots: ROOTS,
      }),
    ).toMatchObject({ ok: false, reason: 'unresolvable' });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('an ingest failure never blocks archival (the archive preserves the bytes)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); // per-file ingest failure warns by design
    tmp = await mkdtemp(join(tmpdir(), 'sa-hook2-'));
    await mkdir(join(tmp, 'su-t', 'projects', '-repo'), { recursive: true });
    await writeFile(join(tmp, 'su-t', 'projects', '-repo', `${SID}.jsonl`), 'x\n');
    const store = new MiniStore();
    const r = await runArchiveForAdvSession(9, {
      loadRow: async () => row(),
      roots: { ...ROOTS, claudeSessionRoot: tmp },
      store,
      ingestFile: async () => {
        throw new Error('pg down');
      },
    });
    expect(r.ok).toBe(true);
    expect(store.stamps.size).toBe(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
