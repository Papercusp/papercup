/**
 * release-cut-reclaim (EI-23968726111761920): the pure planner's protection matrix, the
 * lease/status parsers, and the executor against a REAL temporary git repo — including an
 * offloaded (moved + symlinked) worktree. No test touches a real release tree.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AUTHORED_UNCHECKED,
  executeCutReclaim,
  gatherCutReclaimPlan,
  isLeaseLive,
  machineWrittenRule,
  parsePorcelainV2,
  parseRetentionLease,
  parseWorktreePorcelain,
  planCutReclaim,
  resolveReclaimTargets,
  type HolderScan,
  type ReclaimPlanInput,
  type ReclaimWorktree,
  type RetentionLease,
  type TreeProbe,
} from './release-cut-reclaim';

const NOW = Date.parse('2026-09-30T04:00:00Z');
const DAY = 86_400_000;
const VERSION_PATHS = ['package.json', 'src-tauri/Cargo.toml', 'src-tauri/tauri.conf.json'] as const;

const wt = (p: string, extra: Partial<ReclaimWorktree> = {}): ReclaimWorktree => ({
  path: p,
  head: 'a'.repeat(40),
  detached: true,
  prunable: false,
  locked: false,
  ...extra,
});
const probe = (extra: Partial<TreeProbe> = {}): TreeProbe => ({
  realPath: null,
  offloaded: false,
  onRootFs: true,
  adminDir: '/repo/.git/worktrees/x',
  createdAtMs: NOW - 10 * DAY,
  lastHeadMoveMs: NOW - 10 * DAY,
  desktopVersion: '0.0.22',
  ...extra,
});
const lease = (tag: string, paths: string[], expiresNs: bigint): RetentionLease => ({
  file: `/ret/lease-${tag}.tsv`,
  tag,
  version: /v(\d+\.\d+\.\d+)/.exec(tag)?.[1] ?? null,
  expiresNs,
  paths,
});
const expired = BigInt(NOW - DAY) * 1_000_000n;
const verified: HolderScan = { verified: true, holders: new Map() };

function input(over: Partial<ReclaimPlanInput> & { trees: Array<[ReclaimWorktree, TreeProbe]> }): ReclaimPlanInput {
  const probes = new Map(over.trees.map(([w, p]) => [w.path, { ...p, realPath: p.realPath ?? w.path }]));
  const clean = new Map(over.trees.map(([w]) => [w.path, { ok: true as const, authored: [], machineWritten: 3 }]));
  return {
    nowMs: NOW,
    minIdleHours: 24,
    worktrees: [wt('/w/papercusp', { detached: false }), ...over.trees.map(([w]) => w)],
    isAutoManaged: (p) => ['papercusp', 'papercup-release', 'papercusp-staging'].includes(path.basename(p)),
    leases: [],
    leaseErrors: [],
    releases: [
      { version: '0.0.25', gitSha: 'f'.repeat(40), cutAtMs: NOW - 2 * DAY, publishedAtMs: NOW - DAY },
      { version: '0.0.24', gitSha: 'e'.repeat(40), cutAtMs: NOW - 3 * DAY, publishedAtMs: NOW - 3 * DAY },
    ],
    probes,
    holders: verified,
    authored: clean,
    ...over,
  };
}
const verdict = (plan: ReturnType<typeof planCutReclaim>, p: string) => plan.verdicts.find((v) => v.path === p)!;

describe('parsers', () => {
  it('reads worktree porcelain with head/detached/locked/prunable', () => {
    const list = parseWorktreePorcelain(
      `worktree /w/papercusp\nHEAD ${'1'.repeat(40)}\nbranch refs/heads/staging\n\nworktree /w/relcut-0022\nHEAD ${'2'.repeat(40)}\ndetached\nlocked reason\n\nworktree /tmp/gone\nHEAD ${'3'.repeat(40)}\ndetached\nprunable gitdir file points to non-existent location\n`,
    );
    expect(list.map((w) => [w.path, w.detached, w.locked, w.prunable])).toEqual([
      ['/w/papercusp', false, false, false],
      ['/w/relcut-0022', true, true, false],
      ['/tmp/gone', true, false, true],
    ]);
  });

  it('parses a lease and fails CLOSED on malformed ones, like the bash guard', () => {
    const good = parseRetentionLease('f', 'schema=papercusp-release-retention/v1\ntag=desktop-v0.0.25-alpha\ncreated_ns=1\nexpires_ns=0\npath=/w/relcut-0025/x\n');
    expect(good.ok && good.lease.version).toBe('0.0.25');
    expect(parseRetentionLease('f', 'schema=papercusp-release-retention/v1\ntag=t\nexpires_ns=soon\n').ok).toBe(false);
    expect(parseRetentionLease('f', 'schema=papercusp-release-retention/v1\ntag=t\nexpires_ns=0\nbogus\n').ok).toBe(false);
    expect(parseRetentionLease('f', 'schema=v0\ntag=t\nexpires_ns=0\n').ok).toBe(false);
  });

  it('treats expires_ns=0 as never-expiring', () => {
    expect(isLeaseLive(lease('t', [], 0n), NOW)).toBe(true);
    expect(isLeaseLive(lease('t', [], expired), NOW)).toBe(false);
    expect(isLeaseLive(lease('t', [], BigInt(NOW + DAY) * 1_000_000n), NOW)).toBe(true);
  });

  it('parses porcelain v2 -z: prefixes submodule paths, flags gitlinks, consumes rename origins', () => {
    const z = [
      `1 .M S.M. 160000 160000 160000 ${'a'.repeat(40)} ${'a'.repeat(40)} papercusp-desktop`,
      `1 .M N... 100644 100644 100644 ${'b'.repeat(40)} ${'b'.repeat(40)} src/has space.ts`,
      `2 R. N... 100644 100644 100644 ${'c'.repeat(40)} ${'c'.repeat(40)} R100 new.ts`,
      'old.ts',
      '? notes.txt',
      '',
    ].join('\0');
    expect(parsePorcelainV2(z, 'libs/x')).toEqual([
      { path: 'libs/x/papercusp-desktop', submodule: true },
      { path: 'libs/x/src/has space.ts', submodule: false },
      { path: 'libs/x/new.ts', submodule: false },
      { path: 'libs/x/notes.txt', submodule: false },
    ]);
  });

  it('allows only the measured machine-written residue of a finished cut', () => {
    expect(machineWrittenRule('papercusp-desktop/src-tauri/env-sidecars/staging/db-sql/1.sql', VERSION_PATHS)).toBe('sidecar-build-output');
    expect(machineWrittenRule('papercusp-desktop/src-tauri/Cargo.toml', VERSION_PATHS)).toBe('release-version-bump');
    expect(machineWrittenRule('package-lock.json', VERSION_PATHS)).toBe('lockfile');
    expect(machineWrittenRule('papercusp-desktop/src-tauri/Cargo.lock', VERSION_PATHS)).toBe('lockfile');
    expect(machineWrittenRule('packages/operator-core/lib/x.ts', VERSION_PATHS)).toBeNull();
    expect(machineWrittenRule('src-tauri/Cargo.toml', VERSION_PATHS)).toBeNull(); // not under papercusp-desktop
  });
});

describe('planCutReclaim — the protected set', () => {
  it('reclaims a lease-identified cut whose lease lapsed, keeps live leases, skips managed + prunable', () => {
    const plan = planCutReclaim(
      input({
        trees: [
          [wt('/w/relcut-0022'), probe()],
          [wt('/w/relcut-0024'), probe({ desktopVersion: '0.0.24' })],
          [wt('/w/papercup-release'), probe()],
          [wt('/tmp/gone', { prunable: true }), probe()],
        ],
        leases: [
          lease('desktop-v0.0.22-alpha', ['/w/relcut-0022/papercusp-desktop/src-tauri/target/release'], expired),
          lease('desktop-v0.0.24-alpha', ['/w/relcut-0024/papercusp-desktop/src-tauri/target/release'], 0n),
        ],
      }),
    );
    expect(verdict(plan, '/w/relcut-0022').disposition).toBe('reclaimable');
    expect(verdict(plan, '/w/relcut-0024').reasons).toContain('lease:desktop-v0.0.24-alpha');
    expect(plan.skipped).toEqual({ autoManaged: ['/w/papercup-release'], prunable: 1 });
    expect(plan.latestPublished).toBe('0.0.25');
  });

  it('keeps the latest PUBLISHED release tree by HEAD sha or by its lease tag, even after the lease lapses', () => {
    const plan = planCutReclaim(
      input({
        trees: [
          [wt('/w/by-head', { head: 'f'.repeat(40) }), probe({ desktopVersion: '0.0.25' })],
          [wt('/w/by-lease'), probe({ desktopVersion: '0.0.25' })],
        ],
        leases: [lease('desktop-v0.0.25-alpha', ['/w/by-lease/papercusp-desktop/target'], expired)],
      }),
    );
    expect(verdict(plan, '/w/by-head').reasons).toContain('latest-published:0.0.25');
    expect(verdict(plan, '/w/by-lease').reasons).toContain('latest-published:0.0.25');
  });

  it('keeps the NEXT cut (0.0.26) before it has any lease: created after the latest cut, or a newer version', () => {
    const plan = planCutReclaim(
      input({
        trees: [
          [wt('/w/relcut-0026'), probe({ createdAtMs: NOW - 3_600_000, desktopVersion: '0.0.25' })],
          [wt('/w/bumped'), probe({ desktopVersion: '0.0.26' })],
          [wt('/w/ageless'), probe({ createdAtMs: null })],
        ],
      }),
    );
    expect(verdict(plan, '/w/relcut-0026').reasons).toContain('newer-than-latest-release');
    expect(verdict(plan, '/w/bumped').reasons).toContain('unreleased-version:0.0.26');
    expect(verdict(plan, '/w/ageless').reasons).toContain('unknown-age');
  });

  it('keeps trees held by a process, recently checked out, locked, or containing another worktree', () => {
    const plan = planCutReclaim(
      input({
        trees: [
          [wt('/w/held'), probe()],
          [wt('/w/fresh'), probe({ lastHeadMoveMs: NOW - 2 * 3_600_000 })],
          [wt('/w/locked', { locked: true }), probe()],
          [wt('/w/outer'), probe()],
          [wt('/w/outer/inner'), probe()],
        ],
        holders: { verified: true, holders: new Map([['/w/held', ['pid 42 cwd']]]) },
      }),
    );
    expect(verdict(plan, '/w/held').reasons).toEqual(['in-use:pid 42 cwd']);
    expect(verdict(plan, '/w/fresh').reasons).toEqual(['recent-checkout:2h']);
    expect(verdict(plan, '/w/locked').reasons).toEqual(['locked']);
    expect(verdict(plan, '/w/outer').reasons).toEqual(['contains-worktree:/w/outer/inner']);
    expect(verdict(plan, '/w/outer/inner').disposition).toBe('named-only');
  });

  it('keeps trees with AUTHORED work (incl. inside submodules), unverifiable work, or an unchecked read', () => {
    const base = input({ trees: [[wt('/w/a'), probe()], [wt('/w/b'), probe()], [wt('/w/c'), probe()]] });
    const plan = planCutReclaim({
      ...base,
      authored: new Map([
        ['/w/a', { ok: true, authored: ['libs/papercusp/src/fix.ts'], machineWritten: 0 }],
        ['/w/b', { ok: false, reason: 'git status timed out' }],
      ]),
    });
    expect(verdict(plan, '/w/a').reasons).toEqual(['authored:libs/papercusp/src/fix.ts']);
    expect(verdict(plan, '/w/b').reasons).toEqual(['authored-work-unverified:git status timed out']);
    expect(verdict(plan, '/w/c').reasons).toEqual([AUTHORED_UNCHECKED]);
  });

  it('covers an OFFLOADED tree through its realpath, and labels a lease-less tree named-only', () => {
    const plan = planCutReclaim(
      input({
        trees: [
          [wt('/w/relcut-0023-win'), probe({ realPath: '/mnt/off/w/relcut-0023-win', offloaded: true })],
          [wt('/w/desktop-release-0.0.19'), probe({ desktopVersion: '0.0.19' })],
        ],
        leases: [lease('desktop-v0.0.23-alpha', ['/mnt/off/w/relcut-0023-win/papercusp-desktop/target'], 0n)],
      }),
    );
    expect(verdict(plan, '/w/relcut-0023-win').reasons).toEqual(['lease:desktop-v0.0.23-alpha']);
    expect(verdict(plan, '/w/desktop-release-0.0.19').disposition).toBe('named-only');
  });

  it.each([
    ['a malformed lease', { leaseErrors: ['lease-x.tsv:invalid expires_ns'] }, 'malformed-lease:lease-x.tsv:invalid expires_ns'],
    ['an unverified holder scan', { holders: { verified: false, reason: 'nested-pid-namespace(9/1)', holders: new Map() } }, 'holder-scan-unverified:nested-pid-namespace(9/1)'],
    ['unreadable release records', { releases: { error: 'db down' } }, 'release-records-unavailable:db down'],
    ['no published release', { releases: [{ version: '0.0.1', gitSha: null, cutAtMs: 0, publishedAtMs: null }] }, 'no-published-release'],
  ])('fails CLOSED on %s — every tree protected', (_label, over, reason) => {
    const plan = planCutReclaim(input({ trees: [[wt('/w/relcut-0022'), probe()]], ...(over as Partial<ReclaimPlanInput>) }));
    expect(plan.failClosed).toContain(reason);
    expect(verdict(plan, '/w/relcut-0022').disposition).toBe('protected');
  });

  it('accepts targets by registered or real path, all-or-nothing', () => {
    const plan = planCutReclaim(
      input({
        trees: [
          [wt('/w/ok'), probe({ realPath: '/mnt/off/w/ok', offloaded: true })],
          [wt('/w/held'), probe()],
        ],
        holders: { verified: true, holders: new Map([['/w/held', ['pid 7 fd']]]) },
      }),
    );
    expect(resolveReclaimTargets(plan, ['/mnt/off/w/ok'])).toMatchObject({ ok: true });
    const refused = resolveReclaimTargets(plan, ['/w/ok', '/w/held', '/w/nope']);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.problems).toHaveLength(2);
    expect(resolveReclaimTargets(plan, []).ok).toBe(false);
  });
});

// ---------------------------------------------------------------- real git

const g = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

describe('gather + execute against a real temporary repo', () => {
  let tmp: string;
  let repo: string;
  let ret: string;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim-')));
    repo = path.join(tmp, 'papercusp');
    ret = path.join(tmp, 'retention');
    fs.mkdirSync(repo);
    fs.mkdirSync(ret);
    g(repo, 'init', '-q', '-b', 'staging');
    g(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'root');
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const gather = (extra: Partial<Parameters<typeof gatherCutReclaimPlan>[0]> = {}) =>
    gatherCutReclaimPlan({
      repoPath: repo,
      retentionDir: ret,
      isAutoManaged: (p) => path.basename(p) === 'papercusp',
      releaseVersionPaths: VERSION_PATHS,
      minIdleHours: 0,
      // the tmp worktrees are brand new; place the latest cut after them
      loadReleases: async () => [{ version: '0.0.25', gitSha: null, cutAtMs: Date.now() + DAY, publishedAtMs: Date.now() }],
      scanHolders: () => ({ verified: true, holders: new Map() }),
      ...extra,
    });

  it('only runs the git-heavy authored read for trees that survive the cheap checks', async () => {
    g(repo, 'worktree', 'add', '-q', '--detach', path.join(tmp, 'relcut-a'));
    g(repo, 'worktree', 'add', '-q', '--detach', path.join(tmp, 'relcut-held'));
    const authoredWork = vi.fn(() => ({ ok: true as const, authored: [], machineWritten: 0 }));
    const plan = await gather({
      authoredWork,
      scanHolders: () => ({ verified: true, holders: new Map([[path.join(tmp, 'relcut-held'), ['pid 1 cwd']]]) }),
    });
    expect(authoredWork).toHaveBeenCalledTimes(1);
    expect(authoredWork).toHaveBeenCalledWith(path.join(tmp, 'relcut-a'), repo);
    expect(plan.verdicts.find((v) => v.path.endsWith('relcut-a'))?.disposition).toBe('named-only');
  });

  it('detects an authored file with the real git read and protects the tree', async () => {
    const tree = path.join(tmp, 'relcut-dirty');
    g(repo, 'worktree', 'add', '-q', '--detach', tree);
    fs.writeFileSync(path.join(tree, 'handwritten.ts'), 'export {}\n');
    const plan = await gather();
    expect(plan.verdicts[0]?.reasons).toEqual(['authored:handwritten.ts']);
  });

  it('removes a named tree + its admin dir, archives first, audits, and leaves the canonical repo intact', async () => {
    const tree = path.join(tmp, 'relcut-0019');
    g(repo, 'worktree', 'add', '-q', '--detach', tree);
    const plan = await gather();
    const audit: string[] = [];
    const res = await executeCutReclaim(plan, [tree], {
      scanHolders: () => ({ verified: true, holders: new Map() }),
      archiveDir: path.join(ret, 'archive'),
      appendAudit: (l) => audit.push(l),
    });
    expect(res).toMatchObject({ ok: true, results: [{ path: tree, removed: true }] });
    expect(fs.existsSync(tree)).toBe(false);
    expect(fs.readdirSync(path.join(repo, '.git', 'worktrees'))).toEqual([]);
    expect(g(repo, 'worktree', 'list', '--porcelain')).not.toContain('relcut-0019');
    expect(fs.readdirSync(path.join(ret, 'archive'))).toHaveLength(1);
    expect(audit[0]).toContain('deleter=release:cut-reclaim');
    expect(g(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('staging');
    expect(fs.readdirSync(tmp).filter((n) => n.startsWith('.reclaim-trash-'))).toEqual([]);
  });

  it('removes an OFFLOADED tree: the real directory and the symlink both go', async () => {
    const tree = path.join(tmp, 'relcut-0023-win');
    const offload = path.join(tmp, 'offload');
    g(repo, 'worktree', 'add', '-q', '--detach', tree);
    fs.mkdirSync(offload);
    fs.renameSync(tree, path.join(offload, 'relcut-0023-win'));
    fs.symlinkSync(path.join(offload, 'relcut-0023-win'), tree);
    const plan = await gather();
    const res = await executeCutReclaim(plan, [tree], {
      scanHolders: () => ({ verified: true, holders: new Map() }),
      archiveDir: path.join(ret, 'archive'),
      appendAudit: () => {},
    });
    expect(res).toMatchObject({ ok: true, results: [{ removed: true }] });
    expect(fs.existsSync(path.join(offload, 'relcut-0023-win'))).toBe(false);
    expect(() => fs.lstatSync(tree)).toThrow();
  });

  it('refuses a protected target and removes nothing; a fresh holder hit aborts that tree', async () => {
    const tree = path.join(tmp, 'relcut-live');
    g(repo, 'worktree', 'add', '-q', '--detach', tree);
    fs.writeFileSync(
      path.join(ret, 'lease-desktop-v0.0.24-alpha.tsv'),
      `schema=papercusp-release-retention/v1\ntag=desktop-v0.0.24-alpha\ncreated_ns=1\nexpires_ns=0\npath=${tree}/target\n`,
    );
    const refused = await executeCutReclaim(await gather(), [tree]);
    expect(refused).toMatchObject({ ok: false, refused: true });
    fs.rmSync(path.join(ret, 'lease-desktop-v0.0.24-alpha.tsv'));
    const held = await executeCutReclaim(await gather(), [tree], {
      scanHolders: () => ({ verified: true, holders: new Map([[tree, ['pid 9 cwd']]]) }),
    });
    expect(held).toMatchObject({ ok: true, results: [{ removed: false, reason: 'in use: pid 9 cwd' }] });
    expect(fs.existsSync(tree)).toBe(true);
  });
});
