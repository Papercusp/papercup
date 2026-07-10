/**
 * Reconciler backstop tests (session-db-archive-retire-dirs-2026-07-10
 * P-006). All deps injected — no PG. Pins the safety contract:
 *  - protected identities (live owner / open adv) are NEVER touched;
 *  - nothing-to-archive adv rows are stamped out of the scan set only after
 *    the grace period;
 *  - already-archived leftovers get the sha-checked delete;
 *  - a fresh (recently-written) omp transcript is left alone.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSessionArchiveReconcileOnce, type ReconcilerDb } from './session-archive-reconciler';
import { archiveSession, type ArchiveFileRow, type ArchiveStampRow, type SessionArchiveStore } from './session-archive';

const SID_DEAD = 'dddddddd-1111-2222-3333-444444444444';
const SID_LIVE = 'eeeeeeee-1111-2222-3333-444444444444';
const SID_CODEX = 'ffffffff-1111-2222-3333-444444444444';
const SID_OMP_OLD = 'aaaa1111-1111-2222-3333-444444444444';
const SID_OMP_FRESH = 'bbbb2222-1111-2222-3333-444444444444';

class MiniStore implements SessionArchiveStore {
  files: ArchiveFileRow[] = [];
  stamps = new Map<string, ArchiveStampRow>();
  advStamps: number[] = [];
  async upsertArchive(files: ArchiveFileRow[], stamp: ArchiveStampRow): Promise<void> {
    this.files = this.files.filter((f) => !(f.source_kind === stamp.source_kind && f.session_id === stamp.session_id));
    this.files.push(...files);
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

function fakeDb(rows: Array<{ id: number; endedAtMs: number }>): ReconcilerDb & { stamped: number[] } {
  const stamped: number[] = [];
  return {
    stamped,
    async listEndedUnarchived() {
      return rows;
    },
    async stampArchivedAt(id) {
      stamped.push(id);
    },
    async countEndedUnarchived() {
      return rows.length - stamped.length;
    },
  };
}

let tmps: string[] = [];
async function tmp(p: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), p));
  tmps.push(d);
  return d;
}
afterEach(async () => {
  for (const d of tmps) await rm(d, { recursive: true, force: true });
  tmps = [];
});

async function claudeOwnerDir(root: string, owner: string, sid: string): Promise<string> {
  const p = join(root, owner, 'projects', '-repo');
  await mkdir(p, { recursive: true });
  const abs = join(p, `${sid}.jsonl`);
  await writeFile(abs, `{"o":"${owner}"}\n`);
  return abs;
}

describe('runSessionArchiveReconcileOnce', () => {
  it('db-side: archives resolvable rows; stamps nothing-to-archive rows only past the grace', async () => {
    const nowMs = Date.now();
    const db = fakeDb([
      { id: 1, endedAtMs: nowMs - 3 * 3600_000 }, // resolvable → archived
      { id: 2, endedAtMs: nowMs - 3 * 3600_000 }, // no_files, old → stamped out
      { id: 3, endedAtMs: nowMs - 60_000 }, // no_files, FRESH → left alone
    ]);
    const stats = await runSessionArchiveReconcileOnce({
      db,
      store: new MiniStore(),
      dirRoots: [],
      ompRoot: await tmp('sar-none-'),
      protectedIdentity: { ownerIds: new Set(), sessionKeys: new Set() },
      nowMs,
      runAdvArchive: async (id) =>
        id === 1
          ? { ok: true, archive: { ok: true, fileCount: 1, bytesRaw: 1, bytesStored: 1 } }
          : { ok: false, reason: 'no_files', archive: { ok: false, reason: 'no_files', fileCount: 0, bytesRaw: 0, bytesStored: 0 } },
    });
    expect(stats.dbArchived).toBe(1);
    expect(stats.dbStampedEmpty).toBe(1);
    expect(db.stamped).toEqual([2]);
  });

  it('disk-side: archives+deletes dead owner dirs, never touches protected ones', async () => {
    const claudeRoot = await tmp('sar-claude-');
    const deadAbs = await claudeOwnerDir(claudeRoot, 'su-dead', SID_DEAD);
    const liveAbs = await claudeOwnerDir(claudeRoot, 'su-live', SID_LIVE);
    const codexRoot = await tmp('sar-codex-');
    const codexHome = join(codexRoot, 'session-5');
    await mkdir(join(codexHome, 'sessions', '2026', '07', '10'), { recursive: true });
    const codexAbs = join(codexHome, 'sessions', '2026', '07', '10', `rollout-x-${SID_CODEX}.jsonl`);
    await writeFile(codexAbs, 'r\n');
    await writeFile(join(codexHome, 'config.toml'), 'm\n');

    const store = new MiniStore();
    const stats = await runSessionArchiveReconcileOnce({
      db: fakeDb([]),
      store,
      dirRoots: [
        { root: claudeRoot, keyKind: 'owner', label: 'session-claude' },
        { root: codexRoot, keyKind: 'session', label: 'su-codex-homes' },
      ],
      ompRoot: await tmp('sar-noomp-'),
      protectedIdentity: { ownerIds: new Set(['su-live']), sessionKeys: new Set() },
      nowMs: Date.now(),
    });

    expect(stats.diskSessionsArchived).toBe(2); // su-dead claude + codex home
    expect(existsSync(deadAbs)).toBe(false);
    expect(existsSync(codexAbs)).toBe(false);
    expect(existsSync(liveAbs)).toBe(true); // protected — untouched
    expect(store.stamps.has(`claude:${SID_DEAD}`)).toBe(true);
    expect(store.stamps.has(`codex:${SID_CODEX}`)).toBe(true);
    expect(store.stamps.has(`claude:${SID_LIVE}`)).toBe(false);
    // codex home-level state rode along in the archive
    expect(store.stamps.get(`codex:${SID_CODEX}`)!.manifest.map((m) => m.relpath)).toContain('config.toml');
  });

  it('disk-side: already-archived leftovers get the sha-checked delete', async () => {
    const claudeRoot = await tmp('sar-left-');
    const abs = await claudeOwnerDir(claudeRoot, 'su-gone', SID_DEAD);
    const store = new MiniStore();
    // archive WITHOUT deleting (simulates a fast path that archived then crashed)
    await archiveSession(
      { sourceKind: 'claude', sessionId: SID_DEAD, sessionRoot: join(claudeRoot, 'su-gone') },
      store,
    );
    expect(existsSync(abs)).toBe(true);

    const stats = await runSessionArchiveReconcileOnce({
      db: fakeDb([]),
      store,
      dirRoots: [{ root: claudeRoot, keyKind: 'owner', label: 'session-claude' }],
      ompRoot: await tmp('sar-noomp2-'),
      protectedIdentity: { ownerIds: new Set(), sessionKeys: new Set() },
      nowMs: Date.now(),
    });
    expect(stats.diskLeftoversDeleted).toBe(1);
    expect(existsSync(abs)).toBe(false);
  });

  it('omp: takes only transcripts past the mtime grace', async () => {
    const ompRoot = await tmp('sar-omp-');
    await mkdir(join(ompRoot, '-repo'), { recursive: true });
    const oldAbs = join(ompRoot, '-repo', `100_${SID_OMP_OLD}.jsonl`);
    const freshAbs = join(ompRoot, '-repo', `200_${SID_OMP_FRESH}.jsonl`);
    await writeFile(oldAbs, 'old\n');
    await writeFile(freshAbs, 'fresh\n');
    const old = new Date(Date.now() - 25 * 3600_000);
    await utimes(oldAbs, old, old);

    const store = new MiniStore();
    const stats = await runSessionArchiveReconcileOnce({
      db: fakeDb([]),
      store,
      dirRoots: [],
      ompRoot,
      protectedIdentity: { ownerIds: new Set(), sessionKeys: new Set() },
      nowMs: Date.now(),
    });
    expect(stats.ompFilesArchived).toBe(1);
    expect(existsSync(oldAbs)).toBe(false);
    expect(existsSync(freshAbs)).toBe(true);
    expect(store.stamps.has(`omp:${SID_OMP_OLD}`)).toBe(true);
  });
});
