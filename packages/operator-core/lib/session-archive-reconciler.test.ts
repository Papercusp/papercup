/**
 * Reconciler backstop tests (session-db-archive-retire-dirs-2026-07-10
 * P-006). All deps injected — no PG. Pins the safety contract:
 *  - protected identities (live owner / open adv) are NEVER touched;
 *  - nothing-to-archive adv rows are stamped out of the scan set only after
 *    the grace period;
 *  - already-archived leftovers get the sha-checked delete;
 *  - a fresh (recently-written) omp transcript is left alone.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runCodexHomeConfigInvariant,
  runSessionArchiveReconcileOnce,
  type ReconcilerDb,
} from './session-archive-reconciler';
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

/** Age a file past the disk-sweep quiet grace (a fresh mtime = possibly a live
 *  session still writing — the sweep must leave it alone until it goes quiet). */
async function ageFile(abs: string, hours = 2): Promise<void> {
  const old = new Date(Date.now() - hours * 3600_000);
  await utimes(abs, old, old);
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
    // quiet-grace: the sweep only takes files that stopped changing
    await ageFile(deadAbs);
    await ageFile(liveAbs);
    await ageFile(codexAbs);
    await ageFile(join(codexHome, 'config.toml'));

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
    // WI-38706 — this used to assert the OPPOSITE ("codex home-level state rode
    // along in the archive"). That is the exact behaviour that broke `codex
    // resume` fleet-wide: a CODEX_HOME holds MANY sessions (codex mints a new
    // rollout uuid per thread/resume), so archiving the home's shared
    // config.toml under whichever session the reconciler swept first, then
    // deleting it, left every sibling thread resolving a provider that no longer
    // existed. This is the end-to-end pin: the reconciler is the production path
    // that did it.
    expect(store.stamps.get(`codex:${SID_CODEX}`)!.manifest.map((m) => m.relpath)).not.toContain('config.toml');
    expect(existsSync(join(codexHome, 'config.toml'))).toBe(true); // survives the sweep
  });

  it('disk-side: already-archived leftovers get the sha-checked delete', async () => {
    const claudeRoot = await tmp('sar-left-');
    const abs = await claudeOwnerDir(claudeRoot, 'su-gone', SID_DEAD);
    await ageFile(abs);
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

  it('DEGRADED protected-set: the disk-side sweep is SKIPPED entirely (never trusts an incomplete set)', async () => {
    // gatherProtectedSessionIdentity fails OPEN per-source — a partial presence
    // read with a WORKING archive PG would otherwise let the sweep archive and
    // DELETE a live session's files mid-flight. Mirror session-dir-gc's abort.
    const claudeRoot = await tmp('sar-degraded-');
    const abs = await claudeOwnerDir(claudeRoot, 'su-live-but-unknown', SID_DEAD);
    await ageFile(abs); // stale enough that only the degraded-abort protects it
    const store = new MiniStore();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const stats = await runSessionArchiveReconcileOnce({
        db: fakeDb([]),
        store,
        dirRoots: [{ root: claudeRoot, keyKind: 'owner', label: 'session-claude' }],
        ompRoot: await tmp('sar-noomp3-'),
        protectedIdentity: { ownerIds: new Set(), sessionKeys: new Set(), degraded: true },
        nowMs: Date.now(),
      });
      expect(stats.skippedDisk).toBe('degraded-protected-set');
      expect(stats.diskSessionsArchived).toBe(0);
      expect(existsSync(abs)).toBe(true); // the live-but-unknown session survives
      expect(store.stamps.size).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('QUIET GRACE: a fresh (still-changing) claude transcript is left alone this tick', async () => {
    // A raw/untracked resumed session has no adv row and no presence — the
    // protected set cannot see it. Its only signal is a fresh mtime: the sweep
    // must not archive+delete a transcript that is still being appended to.
    const claudeRoot = await tmp('sar-fresh-');
    const abs = await claudeOwnerDir(claudeRoot, 'su-raw-live', SID_LIVE); // just written → fresh
    const store = new MiniStore();
    const stats = await runSessionArchiveReconcileOnce({
      db: fakeDb([]),
      store,
      dirRoots: [{ root: claudeRoot, keyKind: 'owner', label: 'session-claude' }],
      ompRoot: await tmp('sar-noomp4-'),
      protectedIdentity: { ownerIds: new Set(), sessionKeys: new Set() },
      nowMs: Date.now(),
    });
    expect(existsSync(abs)).toBe(true); // untouched
    expect(store.stamps.size).toBe(0);
    expect(stats.diskSkippedFresh).toBe(1);
  });

  it('FAILURE INJECTION: PG dying mid-sweep fails CLOSED — counted, nothing deleted', async () => {
    const claudeRoot = await tmp('sar-pgdown-');
    const abs = await claudeOwnerDir(claudeRoot, 'su-dead', SID_DEAD);
    await ageFile(abs);
    const store: SessionArchiveStore = {
      async upsertArchive() {
        throw new Error('pg down');
      },
      async readStamp() {
        throw new Error('pg down');
      },
      async readFiles() {
        throw new Error('pg down');
      },
      async stampAdvSessionArchived() {
        throw new Error('pg down');
      },
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const stats = await runSessionArchiveReconcileOnce({
        db: fakeDb([]),
        store,
        dirRoots: [{ root: claudeRoot, keyKind: 'owner', label: 'session-claude' }],
        ompRoot: await tmp('sar-noomp5-'),
        protectedIdentity: { ownerIds: new Set(), sessionKeys: new Set() },
        nowMs: Date.now(),
      });
      expect(stats.diskFailed).toBe(1);
      expect(existsSync(abs)).toBe(true); // no archive commit ⇒ no deletion, ever
    } finally {
      warn.mockRestore();
    }
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

/**
 * EI-20419472483823685 — the codex-home config.toml invariant.
 *
 * WI-38706 deleted the SHARED per-home config.toml, breaking `codex resume`
 * fleet-wide. The CAUSE was fixed, but nothing DETECTED the damage: one home
 * sat unresumable for up to ~4 days and was found only because a hand-run
 * census happened. These pin the detector — and in particular pin WHY it does
 * not ride the archive sweep.
 */
describe('runCodexHomeConfigInvariant', () => {
  async function codexHome(root: string, name: string, withConfig: boolean): Promise<string> {
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    if (withConfig) {
      await writeFile(join(dir, 'config.toml'), 'model_provider = "papercusp-codex-gateway"\n');
    }
    return dir;
  }

  it('counts every codex home and names the ones missing config.toml', async () => {
    const codexRoot = await tmp('sar-codex-');
    await codexHome(codexRoot, 'session-1', true);
    await codexHome(codexRoot, 'session-2', true);
    const broken = await codexHome(codexRoot, 'session-3', false);

    const inv = await runCodexHomeConfigInvariant([
      { root: codexRoot, keyKind: 'session', label: 'su-codex-homes' },
    ]);

    expect(inv.scanned).toBe(3);
    expect(inv.missing).toBe(1);
    expect(inv.missingDirs).toEqual([broken]);
  });

  it('ignores owner-kind roots — config.toml is a codex-home artifact, not a claude one', async () => {
    const ownerRoot = await tmp('sar-owner-');
    await mkdir(join(ownerRoot, 'some-owner'), { recursive: true });

    const inv = await runCodexHomeConfigInvariant([
      { root: ownerRoot, keyKind: 'owner', label: 'session-claude' },
    ]);

    // Not "0 missing out of 1": the dir must not be SCANNED at all, or every
    // claude owner dir reports as a false positive forever.
    expect(inv.scanned).toBe(0);
    expect(inv.missing).toBe(0);
  });

  it('reports the TRUE missing count even when the named list is capped', async () => {
    const codexRoot = await tmp('sar-codex-many-');
    for (let i = 0; i < 5; i++) await codexHome(codexRoot, `session-${i}`, false);

    const inv = await runCodexHomeConfigInvariant(
      [{ root: codexRoot, keyKind: 'session', label: 'su-codex-homes' }],
      2,
    );

    // A capped census rendered as a total is how a floor gets read as a verdict.
    expect(inv.missing).toBe(5);
    expect(inv.missingDirs).toHaveLength(2);
  });

  it('CONTROL: sees a home the ARCHIVE SWEEP skips — the whole reason it does not ride that loop', async () => {
    // The home that actually broke (WI-38706, session-14801) was LIVE, so the
    // archive loop skipped it as protected. A home with no archivable rollout
    // ids is skipped by that same loop for an equivalent reason — it `continue`s
    // before diskDirsScanned++. If someone "simplifies" this by moving the
    // check inside that loop, this test fails. That is the point of it.
    const codexRoot = await tmp('sar-codex-skipped-');
    await mkdir(join(codexRoot, 'session-14801'), { recursive: true });
    // No config.toml, and no rollout files => invisible to the archive sweep.

    const stats = await runSessionArchiveReconcileOnce({
      db: fakeDb([]),
      store: new MiniStore(),
      dirRoots: [{ root: codexRoot, keyKind: 'session', label: 'su-codex-homes' }],
      ompRoot: await tmp('sar-none-'),
      protectedIdentity: { ownerIds: new Set(), sessionKeys: new Set() },
    });

    expect(stats.diskDirsScanned).toBe(0); // the archive sweep never counted it
    expect(stats.codexHomesScanned).toBe(1); // the invariant did
    expect(stats.codexHomesMissingConfig).toBe(1);
    expect(stats.codexHomeInvariantError).toBeUndefined();
  });
});
