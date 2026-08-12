/**
 * session-archive substrate tests (session-db-archive-retire-dirs-2026-07-10
 * P-002/P-003). Pure FS + injected in-memory store — no PG (pattern:
 * session-dir-gc's injected-dependency core). The invariants pinned here are
 * the ones that make delete-at-death SAFE:
 *   - collectors NEVER follow symlinks (per-session claude dirs are symlink
 *     farms into shared ~/.claude);
 *   - delete refuses when disk bytes drifted from the archived sha;
 *   - archive → delete → rematerialize is byte-exact (sha round-trip);
 *   - rematerialize never clobbers a differing existing file (disk wins).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  archiveAndDeleteSession,
  archiveSession,
  collectSessionFiles,
  deleteArchivedSessionFiles,
  listClaudeSessionIds,
  rematerializeSession,
  sha256Hex,
  type ArchiveFileRow,
  type ArchiveStampRow,
  type SessionArchiveStore,
} from './session-archive';

const SID = 'aaaaaaaa-1111-2222-3333-444444444444';
const OTHER = 'bbbbbbbb-5555-6666-7777-888888888888';

class MemStore implements SessionArchiveStore {
  files = new Map<string, ArchiveFileRow>();
  stamps = new Map<string, ArchiveStampRow>();
  advStamps: number[] = [];
  upsertCalls = 0;

  private sk(kind: string, id: string) {
    return `${kind}:${id}`;
  }

  async upsertArchive(files: ArchiveFileRow[], stamp: ArchiveStampRow): Promise<void> {
    this.upsertCalls++;
    const keep = new Set(stamp.manifest.map((m) => m.relpath));
    for (const [k, v] of this.files) {
      if (v.source_kind === stamp.source_kind && v.session_id === stamp.session_id && !keep.has(v.relpath)) {
        this.files.delete(k);
      }
    }
    for (const f of files) this.files.set(`${f.source_kind}:${f.session_id}:${f.relpath}`, f);
    this.stamps.set(this.sk(stamp.source_kind, stamp.session_id), stamp);
  }

  async readStamp(kind: string, id: string): Promise<ArchiveStampRow | null> {
    return this.stamps.get(this.sk(kind, id)) ?? null;
  }

  async readFiles(kind: string, id: string): Promise<ArchiveFileRow[]> {
    return [...this.files.values()].filter((f) => f.source_kind === kind && f.session_id === id);
  }

  async stampAdvSessionArchived(advSessionId: number): Promise<void> {
    this.advStamps.push(advSessionId);
  }
}

/**
 * A store that keys stamps by (workspace, kind, id) EXACTLY as Postgres does
 * (`WHERE workspace_id = $1 AND source_kind = $2 AND session_id = $3`).
 *
 * `MemStore` above deliberately IGNORES the workspace argument — which is
 * precisely why the WI-38236 key mismatch survived every unit test: a double
 * that ignores a key cannot detect a caller passing the wrong one. Any test
 * about WHICH workspace key a caller uses must run against this store.
 */
class WorkspaceKeyedStore implements SessionArchiveStore {
  files = new Map<string, ArchiveFileRow>();
  stamps = new Map<string, ArchiveStampRow>();

  async upsertArchive(files: ArchiveFileRow[], stamp: ArchiveStampRow): Promise<void> {
    for (const f of files) {
      this.files.set(`${f.workspace_id}:${f.source_kind}:${f.session_id}:${f.relpath}`, f);
    }
    this.stamps.set(`${stamp.workspace_id}:${stamp.source_kind}:${stamp.session_id}`, stamp);
  }

  // Mirrors pgSessionArchiveStore: `workspaceId = WS_DEFAULT` when omitted.
  async readStamp(kind: string, id: string, workspaceId = 'default'): Promise<ArchiveStampRow | null> {
    return this.stamps.get(`${workspaceId}:${kind}:${id}`) ?? null;
  }

  async readFiles(kind: string, id: string, workspaceId = 'default'): Promise<ArchiveFileRow[]> {
    return [...this.files.values()].filter(
      (f) => f.workspace_id === workspaceId && f.source_kind === kind && f.session_id === id,
    );
  }

  async stampAdvSessionArchived(): Promise<void> {}
}

let roots: string[] = [];
async function tmp(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  roots.push(d);
  return d;
}
afterEach(async () => {
  for (const d of roots) await rm(d, { recursive: true, force: true });
  roots = [];
});

/** A realistic per-session CLAUDE_CONFIG_DIR: real projects/, SYMLINKED todos/. */
async function claudeFixture(): Promise<{ root: string; transcript: string }> {
  const root = await tmp('sa-claude-');
  const shared = await tmp('sa-shared-');
  await mkdir(join(root, 'projects', '-home-repo'), { recursive: true });
  const transcript = JSON.stringify({ type: 'user', message: { content: 'hello' } }) + '\n';
  await writeFile(join(root, 'projects', '-home-repo', `${SID}.jsonl`), transcript);
  await writeFile(join(root, 'projects', '-home-repo', `${OTHER}.jsonl`), 'other\n');
  // shared todos reachable ONLY through a symlink — must never be collected
  await mkdir(join(shared, 'todos'), { recursive: true });
  await writeFile(join(shared, 'todos', `${SID}-agent.json`), '{}');
  await symlink(join(shared, 'todos'), join(root, 'todos'));
  return { root, transcript };
}

describe('archive workspace key — the WRITER and every READER must agree (WI-38236)', () => {
  // Found 2026-08-12 by "why isn't psu --resume working like it used to?": the
  // /adv/sessions/resumable enrichment read stamps with `s.workspaceId`
  // ('papercusp-workspace'), while archive-at-death writes every row under
  // WS_DEFAULT. Measured: 17,147 archive rows, 100% 'default' — so the lookup
  // matched NOTHING and `hasArchive` was false for every archived session (live
  // :3070: 29 claude/codex rows, 0 flagged). The picker then hid every off-disk
  // session as an unresumable "ghost" — the exact bug that enrichment was added
  // to fix. These two cases pin the key from both sides.

  it('a stamp written by archive-at-death IS found by the reader shape that omits the workspace', async () => {
    const { root } = await claudeFixture();
    const store = new WorkspaceKeyedStore();
    // archive-at-death builds its ref from the adv row and sets no workspaceId.
    await archiveSession({ sourceKind: 'claude', sessionId: SID, sessionRoot: root }, store);
    expect(await store.readStamp('claude', SID)).not.toBeNull();
  });

  it('CONTROL: reading that same stamp with a workspace SLUG misses — the defect this pins', async () => {
    // Permanent wrong-implementation control: if this ever starts finding the
    // stamp, the store double has stopped honouring the key and the test above
    // has quietly become unfalsifiable.
    const { root } = await claudeFixture();
    const store = new WorkspaceKeyedStore();
    await archiveSession({ sourceKind: 'claude', sessionId: SID, sessionRoot: root }, store);
    expect(await store.readStamp('claude', SID, 'papercusp-workspace')).toBeNull();
  });
});

describe('archive key — CLASS guard: no production reader may key by a workspace SLUG (WI-38236)', () => {
  // Fixing the /adv/sessions/resumable call site was not enough: re-probing every
  // archive-store call site found the SAME mismatch in session-port/source.ts,
  // where the archive branch runs exactly when the source session has ENDED — so
  // a cross-backend port of an ended session always threw "canonical Claude
  // archive not found". Two instances of one class means the class needs the
  // guard, not each instance. Writers key by (source_kind, session_id) under
  // WS_DEFAULT; any reader passing a workspace slug silently matches nothing.
  const readerFiles = [
    'endpoint-route/routes/adv/sessions.ts',
    'session-port/source.ts',
    'session-archive-read.ts',
    'session-archive-reconciler.ts',
    'session-dir-gc.ts',
  ];

  it('no reader passes a workspace slug to readStamp/readFiles', () => {
    const offenders: string[] = [];
    for (const rel of readerFiles) {
      const src = readFileSync(join(__dirname, rel), 'utf8');
      for (const m of src.matchAll(/\.(readStamp|readFiles)\(([^)]*)\)/g)) {
        const args = m[2].split(',').map((a) => a.trim());
        // A third argument is only legitimate when it is explicitly defaulted to
        // WS_DEFAULT by the caller (the writer-symmetric form used inside
        // session-archive.ts itself, which is not in this reader set).
        if (args.length >= 3 && !/WS_DEFAULT/.test(args[2])) {
          offenders.push(`${rel}: ${m[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('CONTROL: the same scan DOES flag a workspace-slug third argument', () => {
    // Falsifiability: proves the matcher above can actually see the defect,
    // rather than passing because the regex never matches anything.
    const sample = `const stamp = await store.readStamp('claude', key.sessionId, key.workspaceId);`;
    const hits = [...sample.matchAll(/\.(readStamp|readFiles)\(([^)]*)\)/g)].filter((m) => {
      const args = m[2].split(',').map((a) => a.trim());
      return args.length >= 3 && !/WS_DEFAULT/.test(args[2]);
    });
    expect(hits).toHaveLength(1);
  });
});

describe('collectors — symlink safety + per-CLI shapes', () => {
  it('claude: collects only this session transcript; never through symlinked todos; ignores other uuids', async () => {
    const { root } = await claudeFixture();
    const got = await collectSessionFiles({ sourceKind: 'claude', sessionId: SID, sessionRoot: root });
    expect(got.map((f) => f.rel)).toEqual([join('projects', '-home-repo', `${SID}.jsonl`)]);
  });

  it('claude: a REAL todos dir does contribute session-keyed files', async () => {
    const root = await tmp('sa-claude-real-');
    await mkdir(join(root, 'projects', '-x'), { recursive: true });
    await writeFile(join(root, 'projects', '-x', `${SID}.jsonl`), 't\n');
    await mkdir(join(root, 'todos'), { recursive: true });
    await writeFile(join(root, 'todos', `${SID}-agent.json`), '{}');
    await writeFile(join(root, 'todos', `${OTHER}-agent.json`), '{}');
    const rels = (await collectSessionFiles({ sourceKind: 'claude', sessionId: SID, sessionRoot: root }))
      .map((f) => f.rel)
      .sort();
    expect(rels).toEqual([join('projects', '-x', `${SID}.jsonl`), join('todos', `${SID}-agent.json`)]);
  });

  it('codex per-session home: rollout + memories/goals sqlite + config.toml; symlinked sqlite skipped', async () => {
    const home = await tmp('sa-codex-home-');
    const elsewhere = await tmp('sa-codex-elsewhere-');
    await mkdir(join(home, 'sessions', '2026', '07', '10'), { recursive: true });
    await writeFile(join(home, 'sessions', '2026', '07', '10', `rollout-2026-07-10T01-00-00-${SID}.jsonl`), 'r\n');
    await writeFile(join(home, 'sessions', '2026', '07', '10', `rollout-2026-07-10T01-00-00-${OTHER}.jsonl`), 'x\n');
    await writeFile(join(home, 'memories_1.sqlite'), Buffer.from([0x53, 0x51, 0x4c, 0x00]));
    await writeFile(join(home, 'goals_1.sqlite'), Buffer.from([0x01]));
    await writeFile(join(home, 'config.toml'), 'model = "gpt"\n');
    await writeFile(join(elsewhere, 'memories_9.sqlite'), Buffer.from([0x02]));
    await symlink(join(elsewhere, 'memories_9.sqlite'), join(home, 'memories_9.sqlite'));
    const rels = (await collectSessionFiles({ sourceKind: 'codex', sessionId: SID, sessionRoot: home }))
      .map((f) => f.rel)
      .sort();
    expect(rels).toEqual([
      'config.toml',
      'goals_1.sqlite',
      'memories_1.sqlite',
      join('sessions', '2026', '07', '10', `rollout-2026-07-10T01-00-00-${SID}.jsonl`),
    ]);
  });

  it('codex SHARED ~/.codex: only the rollout — home-level state is not per-session', async () => {
    const parent = await tmp('sa-codex-shared-');
    const home = join(parent, '.codex');
    await mkdir(join(home, 'sessions', '2026', '07', '10'), { recursive: true });
    await writeFile(join(home, 'sessions', '2026', '07', '10', `rollout-x-${SID}.jsonl`), 'r\n');
    await writeFile(join(home, 'memories_1.sqlite'), Buffer.from([0x03]));
    const rels = (await collectSessionFiles({ sourceKind: 'codex', sessionId: SID, sessionRoot: home })).map(
      (f) => f.rel,
    );
    expect(rels).toEqual([join('sessions', '2026', '07', '10', `rollout-x-${SID}.jsonl`)]);
  });

  it('omp: <munged-cwd>/<ts>_<uuid>.jsonl matched by uuid tail', async () => {
    const root = await tmp('sa-omp-');
    await mkdir(join(root, '-home-repo'), { recursive: true });
    await writeFile(join(root, '-home-repo', `1783669989_${SID}.jsonl`), 'o\n');
    await writeFile(join(root, '-home-repo', `1783669989_${OTHER}.jsonl`), 'x\n');
    const rels = (await collectSessionFiles({ sourceKind: 'omp', sessionId: SID, sessionRoot: root })).map(
      (f) => f.rel,
    );
    expect(rels).toEqual([join('-home-repo', `1783669989_${SID}.jsonl`)]);
  });

  it('listClaudeSessionIds enumerates every uuid in the config dir', async () => {
    const { root } = await claudeFixture();
    expect((await listClaudeSessionIds(root)).sort()).toEqual([SID, OTHER].sort());
  });
});

describe('archive → delete → rematerialize (the safety core)', () => {
  it('round-trips byte-exactly and restores the file after deletion', async () => {
    const { root, transcript } = await claudeFixture();
    const store = new MemStore();
    const ref = { sourceKind: 'claude' as const, sessionId: SID, sessionRoot: root, advSessionId: 42 };

    const { archive, delete: del } = await archiveAndDeleteSession(ref, store);
    expect(archive.ok).toBe(true);
    expect(archive.fileCount).toBe(1);
    expect(store.advStamps).toEqual([42]);
    expect(del?.ok).toBe(true);
    expect(del?.deleted).toBe(1);

    const abs = join(root, 'projects', '-home-repo', `${SID}.jsonl`);
    expect(existsSync(abs)).toBe(false);
    // compression actually happened
    const row = [...store.files.values()][0];
    expect(row.bytes_stored).toBeGreaterThan(0);
    expect(row.blob.length).toBe(row.bytes_stored);

    const remat = await rematerializeSession({ sourceKind: 'claude', sessionId: SID }, store);
    expect(remat.ok).toBe(true);
    expect(remat.written).toBe(1);
    const restored = await readFile(abs);
    expect(restored.toString()).toBe(transcript);
    expect(sha256Hex(restored)).toBe(store.stamps.get(`claude:${SID}`)!.manifest[0].sha256);
  });

  it('delete REFUSES a file modified after archiving (sha drift) and leaves it on disk', async () => {
    const { root } = await claudeFixture();
    const store = new MemStore();
    const ref = { sourceKind: 'claude' as const, sessionId: SID, sessionRoot: root };
    expect((await archiveSession(ref, store)).ok).toBe(true);

    const abs = join(root, 'projects', '-home-repo', `${SID}.jsonl`);
    await writeFile(abs, 'appended-after-archive\n', { flag: 'a' });

    const del = await deleteArchivedSessionFiles(ref, store);
    expect(del.ok).toBe(false);
    expect(del.deleted).toBe(0);
    expect(del.refused).toEqual([join('projects', '-home-repo', `${SID}.jsonl`)]);
    expect(existsSync(abs)).toBe(true);
  });

  it('delete without a stamp row refuses outright (never delete unarchived work)', async () => {
    const { root } = await claudeFixture();
    const del = await deleteArchivedSessionFiles(
      { sourceKind: 'claude', sessionId: SID, sessionRoot: root },
      new MemStore(),
    );
    expect(del).toMatchObject({ ok: false, reason: 'not_archived', deleted: 0 });
  });

  it('re-archive is idempotent (upsert; one stamp; rows converge)', async () => {
    const { root } = await claudeFixture();
    const store = new MemStore();
    const ref = { sourceKind: 'claude' as const, sessionId: SID, sessionRoot: root };
    await archiveSession(ref, store);
    await archiveSession(ref, store);
    expect(store.upsertCalls).toBe(2);
    expect(store.stamps.size).toBe(1);
    expect((await store.readFiles('claude', SID)).length).toBe(1);
  });

  it('rematerialize never clobbers a DIFFERING existing file (disk wins, conflict reported)', async () => {
    const { root } = await claudeFixture();
    const store = new MemStore();
    const ref = { sourceKind: 'claude' as const, sessionId: SID, sessionRoot: root };
    await archiveAndDeleteSession(ref, store);

    const abs = join(root, 'projects', '-home-repo', `${SID}.jsonl`);
    await mkdir(join(root, 'projects', '-home-repo'), { recursive: true });
    await writeFile(abs, 'newer-on-disk\n');

    const remat = await rematerializeSession({ sourceKind: 'claude', sessionId: SID }, store);
    expect(remat.ok).toBe(true);
    expect(remat.written).toBe(0);
    expect(remat.conflicts).toEqual([join('projects', '-home-repo', `${SID}.jsonl`)]);
    expect((await readFile(abs)).toString()).toBe('newer-on-disk\n');
  });

  it('rematerialize to an explicit targetRoot (resume into a fresh dir)', async () => {
    const { root, transcript } = await claudeFixture();
    const store = new MemStore();
    await archiveAndDeleteSession({ sourceKind: 'claude', sessionId: SID, sessionRoot: root }, store);
    const target = await tmp('sa-target-');
    const remat = await rematerializeSession(
      { sourceKind: 'claude', sessionId: SID, targetRoot: target },
      store,
    );
    expect(remat.ok).toBe(true);
    expect(remat.written).toBe(1);
    expect((await readFile(join(target, 'projects', '-home-repo', `${SID}.jsonl`))).toString()).toBe(transcript);
  });

  it('a session with no files is not archived (no stamp) — the D-004 no-persistence class', async () => {
    const empty = await tmp('sa-empty-');
    const store = new MemStore();
    const r = await archiveSession({ sourceKind: 'claude', sessionId: SID, sessionRoot: empty }, store);
    expect(r).toMatchObject({ ok: false, reason: 'no_files' });
    expect(store.stamps.size).toBe(0);
  });
});

describe('adversarial: poisoned manifests + symlink attacks (WI-3859)', () => {
  // A stamp row is DATA, not trusted code: a corrupt/poisoned manifest relpath
  // must never turn deleteArchivedSessionFiles into an arbitrary unlink or
  // rematerializeSession into an arbitrary write outside the session root.

  it('delete NEVER unlinks a ../ relpath outside the session root (poisoned manifest)', async () => {
    const { root } = await claudeFixture();
    const store = new MemStore();
    const ref = { sourceKind: 'claude' as const, sessionId: SID, sessionRoot: root };
    expect((await archiveSession(ref, store)).ok).toBe(true);

    const outside = await tmp('sa-victim-');
    const victim = join(outside, 'victim.txt');
    await writeFile(victim, 'precious\n');
    const rel = relative(root, victim); // ../sa-victim-XXX/victim.txt
    const stamp = store.stamps.get(`claude:${SID}`)!;
    stamp.manifest.push({ relpath: rel, sha256: sha256Hex(Buffer.from('precious\n')), bytes_raw: 9 });

    const del = await deleteArchivedSessionFiles(ref, store);
    expect(existsSync(victim)).toBe(true); // the file outside the root MUST survive
    expect(del.refused).toContain(rel);
  });

  it('rematerialize NEVER writes a ../ relpath outside the target root (poisoned manifest)', async () => {
    const { root } = await claudeFixture();
    const store = new MemStore();
    await archiveAndDeleteSession({ sourceKind: 'claude', sessionId: SID, sessionRoot: root }, store);

    const outside = await tmp('sa-evil-');
    const evilAbs = join(outside, 'evil.txt');
    const rel = relative(root, evilAbs);
    const row = [...store.files.values()][0];
    store.files.set(`claude:${SID}:${rel}`, { ...row, relpath: rel });
    const stamp = store.stamps.get(`claude:${SID}`)!;
    stamp.manifest.push({ relpath: rel, sha256: row.sha256, bytes_raw: row.bytes_raw });

    const remat = await rematerializeSession({ sourceKind: 'claude', sessionId: SID }, store);
    expect(existsSync(evilAbs)).toBe(false); // MUST NOT be created outside the root
    expect(remat.ok).toBe(false);
    expect(remat.reason).toBe('bad_relpath');
  });

  it('rematerialize refuses to write THROUGH a symlink at the target relpath (per-session dirs are symlink farms)', async () => {
    const { root } = await claudeFixture();
    const store = new MemStore();
    await archiveAndDeleteSession({ sourceKind: 'claude', sessionId: SID, sessionRoot: root }, store);

    // the launcher (or an adversary) re-created the path as a symlink to shared state
    const shared = await tmp('sa-shared2-');
    const target = join(shared, 'shared-state.jsonl');
    await writeFile(target, 'SHARED — must not be clobbered\n');
    const rel = join('projects', '-home-repo', `${SID}.jsonl`);
    await mkdir(join(root, 'projects', '-home-repo'), { recursive: true });
    await symlink(target, join(root, rel));

    const remat = await rematerializeSession({ sourceKind: 'claude', sessionId: SID }, store);
    expect((await readFile(target)).toString()).toBe('SHARED — must not be clobbered\n'); // untouched
    expect(remat.written).toBe(0);
    expect(remat.conflicts).toContain(rel);
  });

  it('rematerialize refuses when an INTERMEDIATE dir is now a symlink escaping the root', async () => {
    const store = new MemStore();
    const root = await tmp('sa-claude2-');
    await mkdir(join(root, 'projects', '-x'), { recursive: true });
    await writeFile(join(root, 'projects', '-x', `${SID}.jsonl`), 't\n');
    await mkdir(join(root, 'todos'), { recursive: true });
    await writeFile(join(root, 'todos', `${SID}-agent.json`), '{"t":1}');
    await archiveAndDeleteSession({ sourceKind: 'claude', sessionId: SID, sessionRoot: root }, store);

    // the launcher re-created todos/ as a SYMLINK into shared ~/.claude
    const sharedTodos = await tmp('sa-sharedtodos-');
    await rm(join(root, 'todos'), { recursive: true, force: true });
    await symlink(sharedTodos, join(root, 'todos'));

    const remat = await rematerializeSession({ sourceKind: 'claude', sessionId: SID }, store);
    expect(existsSync(join(sharedTodos, `${SID}-agent.json`))).toBe(false); // never written into shared
    expect(remat.conflicts).toContain(join('todos', `${SID}-agent.json`));
  });

  it('delete refuses to unlink THROUGH an intermediate symlink escaping the root', async () => {
    const store = new MemStore();
    const root = await tmp('sa-claude3-');
    await mkdir(join(root, 'projects', '-x'), { recursive: true });
    await writeFile(join(root, 'projects', '-x', `${SID}.jsonl`), 't\n');
    await mkdir(join(root, 'todos'), { recursive: true });
    await writeFile(join(root, 'todos', `${SID}-agent.json`), '{"t":1}');
    const ref = { sourceKind: 'claude' as const, sessionId: SID, sessionRoot: root };
    expect((await archiveSession(ref, store)).ok).toBe(true);

    // swap todos/ for a symlink to a shared dir holding an IDENTICAL file (same sha)
    const sharedTodos = await tmp('sa-sharedtodos2-');
    const sharedFile = join(sharedTodos, `${SID}-agent.json`);
    await writeFile(sharedFile, '{"t":1}');
    await rm(join(root, 'todos'), { recursive: true, force: true });
    await symlink(sharedTodos, join(root, 'todos'));

    const del = await deleteArchivedSessionFiles(ref, store);
    expect(existsSync(sharedFile)).toBe(true); // the SHARED target must survive
    expect(del.refused).toContain(join('todos', `${SID}-agent.json`));
  });

  it('rematerialize reports sha_mismatch on a blob whose bytes drifted from the manifest (writes nothing new)', async () => {
    const root = await tmp('sa-drift-');
    await mkdir(join(root, 'projects', '-x'), { recursive: true });
    const abs = join(root, 'projects', '-x', `${SID}.jsonl`);
    await writeFile(abs, 'v1\n');
    const store = new MemStore();
    const ref = { sourceKind: 'claude' as const, sessionId: SID, sessionRoot: root };
    await archiveSession(ref, store);
    const v1Row = { ...(await store.readFiles('claude', SID))[0] };

    await writeFile(abs, 'v2 — different bytes\n');
    await archiveAndDeleteSession(ref, store); // manifest + rows now v2

    // poison: the blob row silently reverts to v1 while the manifest expects v2
    const v2Key = [...store.files.keys()].find((k) => k.startsWith(`claude:${SID}:`))!;
    store.files.set(v2Key, { ...store.files.get(v2Key)!, blob: v1Row.blob });

    const remat = await rematerializeSession({ sourceKind: 'claude', sessionId: SID }, store);
    expect(remat.ok).toBe(false);
    expect(remat.reason).toBe('sha_mismatch');
    expect(existsSync(abs)).toBe(false); // nothing written from a corrupt archive
  });

  it('rematerialize restores mtimes even when the store returns them as STRINGS (the real PG client does — F6)', async () => {
    const root = await tmp('sa-mtime-');
    await mkdir(join(root, 'projects', '-x'), { recursive: true });
    const abs = join(root, 'projects', '-x', `${SID}.jsonl`);
    await writeFile(abs, 'm\n');
    const store = new MemStore();
    await archiveAndDeleteSession({ sourceKind: 'claude', sessionId: SID, sessionRoot: root }, store);

    // simulate the PG round-trip: timestamptz comes back as a string
    const key = [...store.files.keys()][0];
    const row = store.files.get(key)!;
    const want = new Date('2026-07-01T01:02:03Z');
    store.files.set(key, { ...row, mtime: want.toISOString() as unknown as Date });

    const remat = await rematerializeSession({ sourceKind: 'claude', sessionId: SID }, store);
    expect(remat.ok).toBe(true);
    const { stat } = await import('node:fs/promises');
    const st = await stat(abs);
    expect(Math.abs(st.mtimeMs - want.getTime())).toBeLessThan(1500);
  });

  it('bounds: >64 files → too_many_files; >256MB raw → too_large (malformed input, not an archive job)', async () => {
    const many = await tmp('sa-many-');
    for (let i = 0; i < 65; i++) {
      await mkdir(join(many, `d${i}`), { recursive: true });
      await writeFile(join(many, `d${i}`, `${SID}.jsonl`), 'x\n');
    }
    const rMany = await archiveSession({ sourceKind: 'omp', sessionId: SID, sessionRoot: many }, new MemStore());
    expect(rMany).toMatchObject({ ok: false, reason: 'too_many_files' });

    const big = await tmp('sa-big-');
    await mkdir(join(big, 'projects', '-x'), { recursive: true });
    const bigAbs = join(big, 'projects', '-x', `${SID}.jsonl`);
    await writeFile(bigAbs, 'seed\n');
    await truncate(bigAbs, 257 * 1024 * 1024); // sparse — costs no real disk
    const rBig = await archiveSession({ sourceKind: 'claude', sessionId: SID, sessionRoot: big }, new MemStore());
    expect(rBig).toMatchObject({ ok: false, reason: 'too_large' });
  });
});
