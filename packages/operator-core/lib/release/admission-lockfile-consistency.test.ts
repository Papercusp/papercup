/**
 * WI-10004232: the admit door refuses an admission that leaves a lockfile workspace entry out of
 * agreement with its manifest (the 90015e13 shape: lock hunk admitted, package.json hunk not).
 * Real git throughout, including a workspace behind a submodule gitlink (the WI-10003229 shape).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  chainAdmissionPreflights,
  checkLockfileManifestConsistency,
  lockEntryDisagreement,
  lockfileManifestConsistencyPreflight,
  manifestPathForLockKey,
} from './admission-lockfile-consistency';
import { admitPathsOntoRepairHead, type AdmissionGitRunner } from './repair-head-admission';

const TEMP: string[] = [];
afterEach(() => {
  while (TEMP.length > 1) rmSync(TEMP.pop()!, { recursive: true, force: true });
});

const HOME = mkdtempSync(join(tmpdir(), 'admit-lock-home-'));
TEMP.push(HOME);
const GIT_ENV = {
  ...process.env,
  HOME,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@test.local',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@test.local',
};

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: GIT_ENV,
    timeout: 30_000,
    killSignal: 'SIGKILL',
  }).trim();
}
function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}
function sweep(root: string, edits: Record<string, string>, msg: string): string {
  for (const [rel, content] of Object.entries(edits)) write(root, rel, content);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', msg]);
  return git(root, ['rev-parse', 'HEAD']);
}

const manifest = (name: string, deps: Record<string, string> = {}, version = '0.0.0') =>
  JSON.stringify({ name, version, dependencies: deps }, null, 2) + '\n';
const lock = (entries: Record<string, Record<string, string>>) =>
  JSON.stringify(
    {
      name: 'root',
      lockfileVersion: 3,
      packages: {
        '': { name: 'root', workspaces: ['packages/*'] },
        ...Object.fromEntries(
          Object.entries(entries).map(([key, deps]) => [
            key,
            { name: key.split('/').pop(), version: '0.0.0', ...(Object.keys(deps).length ? { dependencies: deps } : {}) },
          ]),
        ),
        'node_modules/left-pad': { version: '1.3.0', dependencies: { unrelated: '*' } },
      },
    },
    null,
    2,
  ) + '\n';

/**
 * Candidate: two workspaces. Staging adds `left-pad` to packages/a on BOTH sides. With
 * `preexistingDrift`, packages/b already disagrees at the candidate (its manifest has `extra`, its
 * lock entry does not) and staging only bumps b's version, so b stays in disagreement.
 */
function repo(opts: { preexistingDrift?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'admit-lock-repo-'));
  TEMP.push(root);
  git(root, ['init', '-q', '-b', 'staging']);
  const bDeps = opts.preexistingDrift ? { extra: '*' } : {};
  const candidate = sweep(
    root,
    {
      'package.json': JSON.stringify({ name: 'root', workspaces: ['packages/*'] }) + '\n',
      'packages/a/package.json': manifest('a'),
      'packages/b/package.json': manifest('b', bDeps),
      'package-lock.json': lock({ 'packages/a': {}, 'packages/b': {} }),
    },
    'candidate',
  );
  sweep(
    root,
    {
      'packages/a/package.json': manifest('a', { 'left-pad': '^1.3.0' }),
      'packages/b/package.json': manifest('b', bDeps, '0.0.1'),
      'package-lock.json': lock({ 'packages/a': { 'left-pad': '^1.3.0' }, 'packages/b': {} }),
    },
    'staging adds left-pad to a',
  );
  return { root, candidate };
}

const T0 = 1_800_000_000_000;
const admit = (root: string, candidate: string, paths: string[], dryRun = true) =>
  admitPathsOntoRepairHead({
    root,
    candidate,
    repairHead: candidate,
    paths,
    source: { ref: 'staging' },
    actor: 'su-test',
    nowMs: T0,
    dryRun,
    preflight: lockfileManifestConsistencyPreflight({ root, probeRef: 'staging' }),
  });

describe('lockEntryDisagreement — npm’s own comparison', () => {
  it('names only the maps that differ, treating absent and empty as equal', () => {
    expect(lockEntryDisagreement({ dependencies: { x: '1' } }, { dependencies: { x: '1' }, devDependencies: {} })).toEqual([]);
    expect(lockEntryDisagreement({ dependencies: { x: '1' } }, { dependencies: {} })).toEqual(['dependencies']);
    expect(lockEntryDisagreement({ devDependencies: { y: '2' } }, { devDependencies: { y: '3' } })).toEqual(['devDependencies']);
    expect(lockEntryDisagreement({}, null)).toEqual([]);
  });

  it('maps a lock key to the manifest it describes, relative to the lockfile', () => {
    expect(manifestPathForLockKey('package-lock.json', 'packages/a')).toBe('packages/a/package.json');
    expect(manifestPathForLockKey('package-lock.json', '')).toBe('package.json');
    expect(manifestPathForLockKey('tools/x/package-lock.json', '')).toBe('tools/x/package.json');
  });
});

describe('admit door — lockfile ⇄ manifest consistency (real git)', () => {
  it('REFUSES the 90015e13 shape: the lock admitted without its manifest, naming the manifest', () => {
    const { root, candidate } = repo();
    const r = admit(root, candidate, ['package-lock.json']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('admission-incomplete');
    expect(r.missing).toEqual([
      expect.objectContaining({
        from: 'package-lock.json',
        wanted: 'packages/a/package.json',
        tried: ['packages/a/package.json'],
        atProbeRef: 'present',
      }),
    ]);
    expect(r.detail).toMatch(/packages\["packages\/a"\] dependencies disagree with packages\/a\/package\.json/);
  });

  it('REFUSES the mirror image: the manifest admitted without the lock, naming the lock', () => {
    const { root, candidate } = repo();
    const r = admit(root, candidate, ['packages/a/package.json']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missing?.map((m) => m.wanted)).toEqual(['package-lock.json']);
  });

  it('ACCEPTS the pair admitted together, and publishes on confirm', () => {
    const { root, candidate } = repo();
    expect(admit(root, candidate, ['package-lock.json', 'packages/a/package.json']).ok).toBe(true);
    expect(admit(root, candidate, ['package-lock.json', 'packages/a/package.json'], false).ok).toBe(true);
  });

  it('does not refuse a disagreement that was already there at repairHead', () => {
    const { root, candidate } = repo({ preexistingDrift: true });
    const paths = ['package-lock.json', 'packages/a/package.json', 'packages/b/package.json'];
    // packages/b is IN scope (its manifest is admitted) and disagrees at the proved commit — but it
    // disagreed identically at repairHead, so this admission did not introduce it.
    const r = checkLockfileManifestConsistency({
      root,
      commit: git(root, ['rev-parse', 'staging']),
      repairHead: candidate,
      admitted: paths,
    });
    expect(r).toEqual({ ok: true, checked: 2 });
    expect(admit(root, candidate, paths).ok).toBe(true);
  });

  it('never runs git for an admission that touches no lockfile, manifest or gitlink', () => {
    const calls: string[][] = [];
    const spy: AdmissionGitRunner = (argv) => {
      calls.push([...argv]);
      return { status: 0, stdout: '', stderr: '' };
    };
    const r = checkLockfileManifestConsistency({
      root: '/nonexistent',
      commit: 'c'.repeat(40),
      repairHead: 'h'.repeat(40),
      admitted: ['lib/a.ts', 'docs/x.md'],
      git: spy,
    });
    expect(r).toEqual({ ok: true, checked: 0 });
    expect(calls).toEqual([]);
  });

  it('fails CLOSED when git cannot answer', () => {
    const broken: AdmissionGitRunner = () => ({ status: 128, stdout: '', stderr: 'fatal: bad object' });
    const stop = lockfileManifestConsistencyPreflight({ root: '/nonexistent', git: broken })({
      commit: 'c'.repeat(40),
      tree: 't'.repeat(40),
      admitted: ['package-lock.json'],
      sourceCommit: 's'.repeat(40),
      repairHead: 'h'.repeat(40),
    });
    expect(stop).toMatchObject({ code: 'git-failed' });
  });

  it('chains preflights in order and stops at the first refusal', () => {
    const seen: string[] = [];
    const hook = (name: string, refuse: boolean) => () => {
      seen.push(name);
      return refuse ? ({ code: 'git-failed', step: name, detail: name } as const) : null;
    };
    const built = { commit: 'c', tree: 't', admitted: [], sourceCommit: 's', repairHead: 'h' };
    expect(chainAdmissionPreflights(hook('a', false), hook('b', true), hook('c', true))(built)).toMatchObject({ step: 'b' });
    expect(seen).toEqual(['a', 'b']);
  });
});

describe('workspace behind a submodule gitlink (the WI-10003229 shape)', () => {
  function repoWithSubmodule() {
    const sub = mkdtempSync(join(tmpdir(), 'admit-lock-sub-'));
    TEMP.push(sub);
    git(sub, ['init', '-q', '-b', 'main']);
    const pin0 = sweep(sub, { 'pkg/package.json': manifest('shared') }, 'sub v0');
    const root = mkdtempSync(join(tmpdir(), 'admit-lock-super-'));
    TEMP.push(root);
    git(root, ['init', '-q', '-b', 'staging']);
    write(root, 'package.json', JSON.stringify({ name: 'root', workspaces: ['libs/shared/pkg'] }) + '\n');
    write(root, 'package-lock.json', lock({ 'libs/shared/pkg': {} }));
    git(root, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'libs/shared']);
    git(join(root, 'libs/shared'), ['checkout', '-q', pin0]);
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'candidate']);
    const candidate = git(root, ['rev-parse', 'HEAD']);
    // Staging: the submodule's manifest gains a dependency and the superproject lock follows it.
    const pin1 = sweep(sub, { 'pkg/package.json': manifest('shared', { 'left-pad': '^1.3.0' }) }, 'sub v1');
    git(join(root, 'libs/shared'), ['-c', 'protocol.file.allow=always', 'fetch', '-q', 'origin']);
    git(join(root, 'libs/shared'), ['checkout', '-q', pin1]);
    sweep(root, { 'package-lock.json': lock({ 'libs/shared/pkg': { 'left-pad': '^1.3.0' } }) }, 'staging bumps shared + lock');
    return { root, candidate };
  }

  it('reads the manifest THROUGH the gitlink and names the gitlink to admit', () => {
    const { root, candidate } = repoWithSubmodule();
    const r = admit(root, candidate, ['package-lock.json']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missing).toEqual([
      expect.objectContaining({ wanted: 'libs/shared', tried: ['libs/shared/pkg/package.json'], atProbeRef: 'present' }),
    ]);
  });

  it('refuses the gitlink bump without the lock, and accepts the pair', () => {
    const { root, candidate } = repoWithSubmodule();
    const alone = admit(root, candidate, ['libs/shared']);
    expect(alone.ok).toBe(false);
    if (!alone.ok) expect(alone.missing?.map((m) => m.wanted)).toEqual(['package-lock.json']);
    expect(admit(root, candidate, ['libs/shared', 'package-lock.json']).ok).toBe(true);
  });
});
