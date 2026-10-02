/**
 * Plan personal-data-reader-set-labels-2026-10-01 P-014 (WI-10005571), BAR R-10:
 * a path a session edited while it held an active disclosure is excluded from
 * git-sync's staging pathspecs until that disclosure is released.
 *
 * The SQL predicate itself runs against real Postgres in
 * git-sync-hold.integration.test.ts; this file pins the mapping, the fail-closed
 * contract, and the end-to-end effect on a real git repository via runGitSync.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  RESTRICTED_HOLD_INTENT,
  RESTRICTED_WINDOW_INTENT,
  RESTRICTED_WINDOW_OWNER,
  isRestrictedHoldIntent,
  listDirtyFilesRecursive,
  ownerHasActiveDisclosure,
  readGitSyncCensusStrict,
  readRestrictedEditHoldings,
  readRestrictedWindowHoldings,
  recordRestrictedEditBeforeRelease,
  restrictedHoldingsFromRows,
  type HoldRunGit,
  type RestrictedEditRow,
} from './git-sync-hold';

const execFileAsync = promisify(execFile);
import { DisclosureRefused } from './disclosure-ledger';
import { runGitSync } from '../harness/git-sync/run-git-sync';

type FakeSql = NonNullable<Parameters<typeof readRestrictedEditHoldings>[0]>;

/** A tagged-template fake that records the statement text and answers with `rows`. */
function fakeSql(answer: () => unknown[]): { sql: FakeSql; statements: string[] } {
  const statements: string[] = [];
  const fn = (strings: TemplateStringsArray) => {
    statements.push(strings.join('?'));
    return Promise.resolve().then(answer);
  };
  return { sql: fn as unknown as FakeSql, statements };
}

const ROW: RestrictedEditRow = {
  repo_root: '/srv/papercup-release',
  file: 'notes/secret.md',
  agent_id: 'su-restricted',
  work_item_id: 'WI-1',
};

describe('restrictedHoldingsFromRows', () => {
  it('maps a ledger row to a census holding in the lock domain it was edited under', () => {
    expect(restrictedHoldingsFromRows([ROW])).toEqual([
      {
        path: 'notes/secret.md',
        owner: 'su-restricted',
        intent: RESTRICTED_HOLD_INTENT,
        goalRef: 'WI-1',
        coordinationDomain: '/srv/papercup-release',
      },
    ]);
  });

  it('keeps one holding per (domain, path), and drops rows with no path or no editor', () => {
    const out = restrictedHoldingsFromRows([
      ROW,
      { ...ROW, agent_id: 'su-other' },
      { ...ROW, repo_root: '/srv/papercusp' },
      { ...ROW, file: '  ' },
      { ...ROW, file: 'x.md', agent_id: null },
    ]);
    expect(out.map((h) => [h.coordinationDomain, h.path])).toEqual([
      ['/srv/papercup-release', 'notes/secret.md'],
      ['/srv/papercusp', 'notes/secret.md'],
    ]);
  });

  it('omits goalRef and coordinationDomain when the ledger has none', () => {
    const [h] = restrictedHoldingsFromRows([{ ...ROW, repo_root: null, work_item_id: null }]);
    expect(h).toEqual({ path: 'notes/secret.md', owner: 'su-restricted', intent: RESTRICTED_HOLD_INTENT });
  });

  it('marks its own rows, and only its own rows, as restricted holds', () => {
    expect(isRestrictedHoldIntent(RESTRICTED_HOLD_INTENT)).toBe(true);
    expect(isRestrictedHoldIntent('PreToolUse:Edit')).toBe(false);
    expect(isRestrictedHoldIntent('editing now')).toBe(false);
    expect(isRestrictedHoldIntent(undefined)).toBe(false);
  });
});

describe('readRestrictedEditHoldings', () => {
  it('selects edits made at or after an UNRELEASED disclosure was delivered to the same agent', async () => {
    const { sql, statements } = fakeSql(() => [ROW]);
    await expect(readRestrictedEditHoldings(sql)).resolves.toHaveLength(1);
    const text = statements.join('\n').replace(/\s+/g, ' ');
    expect(text).toContain('FROM harness_shared.personal_disclosures d');
    expect(text).toContain('JOIN harness_shared.edit_attribution_ledger l');
    expect(text).toContain('l.agent_id = d.agent_owner_id');
    expect(text).toContain('l.ts >= d.delivered_at');
    expect(text).toContain('d.released_at IS NULL');
  });

  it('fails closed: an unreadable ledger is a disclosure_ledger_unavailable refusal, never an empty census', async () => {
    const { sql } = fakeSql(() => {
      throw new Error('connection refused');
    });
    const err = await readRestrictedEditHoldings(sql).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DisclosureRefused);
    expect((err as DisclosureRefused).code).toBe('disclosure_ledger_unavailable');
  });
});

describe('readGitSyncCensusStrict', () => {
  const lock = { path: 'src/a.ts', owner: 'su-peer', intent: 'PreToolUse:Edit' };
  const hold = restrictedHoldingsFromRows([ROW])[0];

  it('is the union of live edit locks and restricted holds', async () => {
    const census = await readGitSyncCensusStrict({ locks: async () => [lock], restricted: async () => [hold] });
    expect(census).toEqual([lock, hold]);
  });

  it('throws when the restricted read fails, so git-sync skips the tick instead of staging', async () => {
    const refused = new DisclosureRefused('disclosure_ledger_unavailable', 'down');
    await expect(
      readGitSyncCensusStrict({ locks: async () => [lock], restricted: async () => Promise.reject(refused) }),
    ).rejects.toBe(refused);
  });

  it('throws when the lock read fails', async () => {
    await expect(
      readGitSyncCensusStrict({ locks: async () => Promise.reject(new Error('locks down')), restricted: async () => [] }),
    ).rejects.toThrow('locks down');
  });
});

describe('recordRestrictedEditBeforeRelease', () => {
  const input = { repoRoot: '/srv/papercusp', files: ['notes/secret.md'], ownerId: 'su-restricted' };

  it('writes nothing for an owner with no active disclosure', async () => {
    const recordStrict = vi.fn(async () => {});
    await expect(
      recordRestrictedEditBeforeRelease(input, { hasActiveDisclosure: async () => false, recordStrict }),
    ).resolves.toBe(false);
    expect(recordStrict).not.toHaveBeenCalled();
  });

  it('writes the ledger row for a restricted owner and reports that it did', async () => {
    const recordStrict = vi.fn(async () => {});
    await expect(
      recordRestrictedEditBeforeRelease(input, { hasActiveDisclosure: async () => true, recordStrict }),
    ).resolves.toBe(true);
    expect(recordStrict).toHaveBeenCalledWith(expect.objectContaining({ files: ['notes/secret.md'], ownerId: 'su-restricted' }));
  });

  it('refuses (so locks:release keeps the lock) when the row cannot be written', async () => {
    const err = await recordRestrictedEditBeforeRelease(input, {
      hasActiveDisclosure: async () => true,
      recordStrict: async () => {
        throw new Error('insert failed');
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DisclosureRefused);
    expect((err as DisclosureRefused).code).toBe('disclosure_ledger_unavailable');
  });

  it('refuses when the active-disclosure check itself cannot be read', async () => {
    const { sql } = fakeSql(() => {
      throw new Error('timeout');
    });
    const err = await ownerHasActiveDisclosure(sql, 'su-restricted').catch((e: unknown) => e);
    expect((err as DisclosureRefused).code).toBe('disclosure_ledger_unavailable');
  });
});

/** Run git synchronously for fixture setup; throws on failure. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' }).trim();
}
function configUser(repo: string): void {
  git(repo, 'config', 'user.email', 'test@papercusp.local');
  git(repo, 'config', 'user.name', 'git-sync hold test');
  git(repo, 'config', 'commit.gpgsign', 'false');
}

describe('git-sync holds a restricted session’s file until its disclosure is released (real git)', () => {
  let root: string;
  let originDir: string;
  let repo: string;
  let savedSidecar: string | undefined;
  let warnSpy: ReturnType<typeof vi.spyOn> | undefined;
  const cfg = { pushSubmodules: false } as const;
  const committed = () => git(originDir, 'ls-tree', '-r', '--name-only', 'main').split('\n');

  beforeAll(() => {
    // Exercise the in-process runner regardless of the host's sidecar setting.
    savedSidecar = process.env.PAPERCUSP_GIT_SYNC_SPAWN_SIDECAR;
    process.env.PAPERCUSP_GIT_SYNC_SPAWN_SIDECAR = '0';
  });
  afterAll(() => {
    if (savedSidecar === undefined) delete process.env.PAPERCUSP_GIT_SYNC_SPAWN_SIDECAR;
    else process.env.PAPERCUSP_GIT_SYNC_SPAWN_SIDECAR = savedSidecar;
  });

  beforeEach(() => {
    // runGitSync narrates through console.warn; that is expected here.
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    root = mkdtempSync(join(tmpdir(), 'git-sync-hold-'));
    originDir = join(root, 'origin.git');
    git(root, 'init', '--bare', '-b', 'main', originDir);
    const seed = join(root, 'seed');
    git(root, 'clone', originDir, seed);
    configUser(seed);
    writeFileSync(join(seed, 'README.md'), 'seed\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '--no-verify', '-m', 'init');
    git(seed, 'push', '-u', 'origin', 'main');
    repo = join(root, 'repo');
    git(root, 'clone', originDir, repo);
    configUser(repo);
  });
  afterEach(() => {
    warnSpy?.mockRestore();
    rmSync(root, { recursive: true, force: true });
  });

  /** The census git-sync gets while the disclosure is active: the ledger row for secret.md. */
  const activeHold = () => restrictedHoldingsFromRows([{ ...ROW, repo_root: null, file: 'secret.md', work_item_id: null }]);

  it('leaves the held path out of the commit and the push, and commits it once the hold lifts', async () => {
    writeFileSync(join(repo, 'secret.md'), 'quoted from a private email\n');
    writeFileSync(join(repo, 'normal.md'), 'ordinary work\n');

    const held = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      liveLockHoldings: activeHold(),
      refreshLiveLockHoldings: async () => activeHold(),
    });
    expect(held.status).toBe('synced');
    expect(committed()).toContain('normal.md');
    expect(committed()).not.toContain('secret.md');
    expect(held.skippedPaths).toEqual([
      { scope: 'superproject', path: 'secret.md', owner: 'su-restricted', intent: RESTRICTED_HOLD_INTENT },
    ]);
    expect(git(repo, 'status', '--porcelain', '--', 'secret.md')).toMatch(/secret\.md/);

    // The disclosure is released: the census no longer carries the hold.
    const released = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      liveLockHoldings: [],
      refreshLiveLockHoldings: async () => [],
    });
    expect(released.status).toBe('synced');
    expect(committed()).toContain('secret.md');
  });

  it('a hold that first appears at the final-commit-seam refresh still keeps the path out', async () => {
    writeFileSync(join(repo, 'secret.md'), 'quoted from a private email\n');
    writeFileSync(join(repo, 'normal.md'), 'ordinary work\n');

    const out = await runGitSync('test', {
      repoPath: repo,
      config: cfg,
      liveLockHoldings: [],
      refreshLiveLockHoldings: async () => activeHold(),
    });
    expect(['synced', 'skipped-locked']).toContain(out.status);
    expect(committed()).not.toContain('secret.md');
  });

  // WI-10005576: a write with NO ledger row (Bash redirect, sed -i, a script).
  describe('writes made without a native edit tool (window hold)', () => {
    const realGit: HoldRunGit = async (args, cwd) => {
      try {
        const { stdout, stderr } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
        return { code: 0, stdout, stderr };
      } catch (error) {
        const e = error as { code?: number; stdout?: string; stderr?: string };
        return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? String(error) };
      }
    };
    /** The ledger as seen while one disclosure is active since `sinceMs`. */
    const ledgerWith = (sinceMs: number, edits: Array<{ file: string; agent: string; tsMs: number }>) =>
      sequenceSql([
        [{ since: new Date(sinceMs), restricted: ['su-restricted'] }],
        edits.map((e) => ({ repo_root: repo, file: e.file, agent_id: e.agent, ts: new Date(e.tsMs) })),
      ]);

    it('holds a file written inside the window with no ledger row, and commits the attributed and pre-window ones', async () => {
      writeFileSync(join(repo, 'old.md'), 'changed before the disclosure\n');
      const past = new Date(Date.now() - 3_600_000);
      utimesSync(join(repo, 'old.md'), past, past);
      const sinceMs = Date.now() - 60_000;
      writeFileSync(join(repo, 'bash-secret.md'), 'echo "quoted from a private email" > bash-secret.md\n');
      writeFileSync(join(repo, 'peer-native.md'), 'a peer’s native edit\n');
      const peerMtime = statSync(join(repo, 'peer-native.md')).mtimeMs;

      const holds = await readRestrictedWindowHoldings({
        sql: ledgerWith(sinceMs, [{ file: 'peer-native.md', agent: 'su-peer', tsMs: peerMtime + 50 }]),
        listDirtyFiles: () => listDirtyFilesRecursive(realGit, repo),
      });
      expect(holds).toEqual([
        { path: 'bash-secret.md', owner: RESTRICTED_WINDOW_OWNER, intent: RESTRICTED_WINDOW_INTENT, coordinationDomain: repo },
      ]);
      expect(isRestrictedHoldIntent(RESTRICTED_WINDOW_INTENT)).toBe(true);

      const out = await runGitSync('test', { repoPath: repo, config: cfg, liveLockHoldings: holds, refreshLiveLockHoldings: async () => holds });
      expect(out.status).toBe('synced');
      expect(committed()).toEqual(expect.arrayContaining(['old.md', 'peer-native.md']));
      expect(committed()).not.toContain('bash-secret.md');
      expect(git(repo, 'status', '--porcelain', '--', 'bash-secret.md')).toMatch(/bash-secret\.md/);
    });

    it('holds a file whose latest native edit is by a restricted session, or predates the write', async () => {
      const sinceMs = Date.now() - 60_000;
      writeFileSync(join(repo, 'restricted-native.md'), 'x\n');
      writeFileSync(join(repo, 'stale-attribution.md'), 'y\n');
      const holds = await readRestrictedWindowHoldings({
        sql: ledgerWith(sinceMs, [
          { file: 'restricted-native.md', agent: 'su-restricted', tsMs: Date.now() },
          { file: 'stale-attribution.md', agent: 'su-peer', tsMs: sinceMs + 1 }, // edited natively, then rewritten later
        ]),
        listDirtyFiles: () => listDirtyFilesRecursive(realGit, repo),
      });
      expect(holds.map((h) => h.path).sort()).toEqual(['restricted-native.md', 'stale-attribution.md']);
    });

    it('lists files changed inside a submodule under the submodule’s own root', async () => {
      const subOrigin = join(root, 'sub.git');
      git(root, 'init', '--bare', '-b', 'main', subOrigin);
      const subSeed = join(root, 'sub-seed');
      git(root, 'clone', subOrigin, subSeed);
      configUser(subSeed);
      writeFileSync(join(subSeed, 'a.md'), 'a\n');
      git(subSeed, 'add', '-A');
      git(subSeed, 'commit', '--no-verify', '-m', 'sub init');
      git(subSeed, 'push', '-u', 'origin', 'main');
      git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', subOrigin, 'sub');
      git(repo, 'commit', '--no-verify', '-m', 'add sub');
      writeFileSync(join(repo, 'sub', 'secret.md'), 'private\n');
      rmSync(join(repo, 'sub', 'a.md'));

      const dirty = await listDirtyFilesRecursive(realGit, repo);
      expect(dirty).toContainEqual({ root: join(repo, 'sub'), path: 'secret.md' });
      expect(dirty.some((d) => d.path === 'a.md')).toBe(false); // a deletion is never held
    });

    it('costs one query and reads no tree when no disclosure is active', async () => {
      const listDirtyFiles = vi.fn(async () => [{ root: repo, path: 'x.md' }]);
      const sql = sequenceSql([[{ since: null, restricted: null }]]);
      expect(await readRestrictedWindowHoldings({ sql, listDirtyFiles })).toEqual([]);
      expect(listDirtyFiles).not.toHaveBeenCalled();
    });

    it('fails closed when the tree cannot be listed while a disclosure is active', async () => {
      const sql = sequenceSql([[{ since: new Date(), restricted: ['su-restricted'] }]]);
      const listDirtyFiles = async () => Promise.reject(new Error('git status failed'));
      await expect(readRestrictedWindowHoldings({ sql, listDirtyFiles })).rejects.toMatchObject({ code: 'disclosure_ledger_unavailable' });
    });
  });
});

/** A tagged-template fake that answers successive statements from `answers`. */
function sequenceSql(answers: unknown[][]): FakeSql {
  let i = 0;
  const fn = () => Promise.resolve(answers[Math.min(i++, answers.length - 1)] ?? []);
  return fn as unknown as FakeSql;
}
