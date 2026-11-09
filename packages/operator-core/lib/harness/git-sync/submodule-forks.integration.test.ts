/**
 * submodule-forks.integration.test.ts — plan slack-asana-reproduced-bug-fix-pr-workflow-2026-10-08
 * P-014 (decision D-017; WI-10006416): a working copy of a repository WITH submodules.
 *
 * The recurrence guard the plan item names: after a real git-sync tick through the
 * production seam (resolveIntegrationPushRemote → applyIntegrationPushTarget → runGitSync),
 * the gitlink the superproject published to ITS fork resolves on the SUBMODULE'S fork,
 * and neither main repository (superproject nor submodule) moved. Four REAL bare repos:
 * both main repositories and the pot's fork of each.
 */
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectChildOutput } from '../../child-output';
import { runGitSync, type GitSyncConfig, type RunGit } from './run-git-sync';
import {
  applyIntegrationPushTarget,
  POT_FORK_REMOTE_NAME,
  resolveIntegrationPushRemote,
  WORKING_COPY_INTEGRATION_BRANCH,
  type PotIntegrationModeRead,
} from './pot-integration-mode';
import { applySubmoduleForkRemotes, findUnpublishedGitlinks, inspectObservedGitlinkContainment,
  observeGitlinkOrigin, type SubmoduleForksRead } from './submodule-forks';

/** Real git, fleet hooks off; file transport allowed so local submodules can be cloned. */
const testRunGit: RunGit = (args, cwd, options) =>
  new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', ...options?.env };
    delete env.GIT_CONFIG;
    const child = spawn('git', ['-c', 'core.hooksPath=/nonexistent', '-c', 'protocol.file.allow=always', ...args], { cwd, env });
    const output = collectChildOutput(child);
    child.on('error', (e) => resolve({ code: -1, stdout: output.stdout.text(), stderr: output.stderr.text() + String(e) }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout: output.stdout.text(), stderr: output.stderr.text() }));
  });

async function git(args: string[], cwd: string): Promise<string> {
  const r = await testRunGit(args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed (${r.code}): ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

const throwingRunGit = async (args: string[], cwd: string): Promise<{ stdout: string }> => ({ stdout: await git(args, cwd) });

async function configRepo(dir: string): Promise<void> {
  await git(['config', 'user.email', 'sf-it@example.com'], dir);
  await git(['config', 'user.name', 'submodule fork integration'], dir);
  await git(['config', 'commit.gpgsign', 'false'], dir);
}

/** Does `repo` hold `sha` as a commit? */
async function hasCommit(repo: string, sha: string): Promise<boolean> {
  return (await testRunGit(['cat-file', '-e', `${sha}^{commit}`], repo)).code === 0;
}

let tmpRoot: string;

interface Topology {
  superUpstream: string;
  superFork: string;
  subUpstream: string;
  subFork: string;
  work: string;
}

async function seedBare(name: string, file: string, extra?: (dir: string) => Promise<void>): Promise<string> {
  const bare = join(tmpRoot, `${name}.git`);
  await mkdir(bare, { recursive: true });
  await git(['init', '--bare', '-b', 'main'], bare);
  const seed = join(tmpRoot, `${name}-seed`);
  await git(['clone', bare, seed], tmpRoot);
  await configRepo(seed);
  await writeFile(join(seed, file), 'seed\n');
  if (extra) await extra(seed);
  await git(['add', '-A'], seed);
  await git(['commit', '--no-verify', '-m', `seed ${name}`], seed);
  await git(['push', '--no-verify', '-u', 'origin', 'main'], seed);
  await rm(seed, { recursive: true, force: true });
  return bare;
}

async function makeTopology(): Promise<Topology> {
  const subUpstream = await seedBare('sub-upstream', 'lib.txt');
  const superUpstream = await seedBare('super-upstream', 'app.txt', async (seed) => {
    await git(['submodule', 'add', subUpstream, 'libs/sub'], seed);
  });
  const subFork = join(tmpRoot, 'sub-fork.git');
  await git(['clone', '--bare', subUpstream, subFork], tmpRoot);
  const superFork = join(tmpRoot, 'super-fork.git');
  await git(['clone', '--bare', superUpstream, superFork], tmpRoot);
  const work = join(tmpRoot, 'work');
  await git(['clone', '--recurse-submodules', superUpstream, work], tmpRoot);
  await configRepo(work);
  await configRepo(join(work, 'libs/sub'));
  return { superUpstream, superFork, subUpstream, subFork, work };
}

/**
 * The main repositories move on their own: the submodule's main gets a commit writing
 * `file`, and the superproject's main pins it. Returns the new submodule commit.
 */
async function moveUpstreamSubmodulePin(t: Topology, file: string, content: string): Promise<string> {
  const subSeed = await mkdtemp(join(tmpRoot, 'sub-up-'));
  await git(['clone', t.subUpstream, subSeed], tmpRoot);
  await configRepo(subSeed);
  await writeFile(join(subSeed, file), content);
  await git(['add', '-A'], subSeed);
  await git(['commit', '--no-verify', '-m', `upstream ${file}`], subSeed);
  await git(['push', '--no-verify', 'origin', 'main'], subSeed);
  const pinned = await git(['rev-parse', 'HEAD'], subSeed);

  const superSeed = await mkdtemp(join(tmpRoot, 'super-up-'));
  await git(['clone', '--recurse-submodules', t.superUpstream, superSeed], tmpRoot);
  await configRepo(superSeed);
  await git(['fetch', 'origin'], join(superSeed, 'libs/sub'));
  await git(['checkout', '--detach', pinned], join(superSeed, 'libs/sub'));
  await git(['add', 'libs/sub'], superSeed);
  await git(['commit', '--no-verify', '-m', 'upstream bumps libs/sub'], superSeed);
  await git(['push', '--no-verify', 'origin', 'main'], superSeed);
  return pinned;
}

const isAncestor = async (repo: string, ancestor: string, of: string): Promise<boolean> =>
  (await testRunGit(['merge-base', '--is-ancestor', ancestor, of], repo)).code === 0;

const REVIEW: PotIntegrationModeRead = { mode: 'review', source: 'set' };

async function tick(t: Topology, submoduleForks: SubmoduleForksRead) {
  const decision = resolveIntegrationPushRemote({ read: REVIEW, forkRemote: t.superFork, submoduleForks });
  const cfg: GitSyncConfig = { branch: 'main', push: true };
  const setupGitCommands: Array<{ runner: 'runGit' | 'codeRunGit'; args: string[]; cwd: string }> = [];
  let setupInvocations = 0;
  const commitOnly = await applyIntegrationPushTarget('sf-it', cfg, decision, t.work, {
    setupSubmodules: async (repoPath, forks) => {
      setupInvocations += 1;
      return applySubmoduleForkRemotes(repoPath, forks, {
        runGit: async (args, cwd) => {
          setupGitCommands.push({ runner: 'runGit', args: [...args], cwd });
          return throwingRunGit(args, cwd);
        },
        codeRunGit: async (args, cwd) => {
          setupGitCommands.push({ runner: 'codeRunGit', args: [...args], cwd });
          return testRunGit(args, cwd);
        },
      });
    },
  });
  const outcome = await runGitSync('sf-it', { runGit: testRunGit, repoPath: t.work, config: cfg });
  return { commitOnly, cfg, outcome, setupInvocations, setupGitCommands };
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'submodule-forks-it-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('direct immutable gitlink origin evidence', () => {
  it('the real fixture runner preserves its private index binding and shared index bytes', async () => {
    const remote = await seedBare('index-binding', 'lib.txt');
    const local = join(tmpRoot, 'index-binding-local');
    await git(['clone', remote, local], tmpRoot);
    const before = await readFile(join(local, '.git/index'));
    const privateIndex = join(tmpRoot, 'owned-private.index');
    const options = { env: { GIT_INDEX_FILE: privateIndex, GIT_OPTIONAL_LOCKS: '0' } };
    expect((await testRunGit(['read-tree', 'HEAD'], local, options)).code).toBe(0);
    expect((await testRunGit(['rev-parse', '--git-path', 'index'], local, options)).stdout.trim()).toBe(privateIndex);
    expect((await readFile(privateIndex)).length).toBeGreaterThan(0);
    expect(await readFile(join(local, '.git/index'))).toEqual(before);
  });

  it('reads symbolic HEAD and exact branch authority anew without changing child refs', async () => {
    const remote = await seedBare('origin-proof', 'lib.txt');
    const local = join(tmpRoot, 'origin-local');
    await git(['clone', remote, local], tmpRoot);
    const refs = await git(['show-ref'], local);
    const expectedTip = await git(['rev-parse', 'refs/heads/main'], remote);
    const first = await observeGitlinkOrigin({ url: remote });
    expect(first).toMatchObject({ schemaVersion: 1, policy: 'isolated-git-origin-v1', url: remote,
      authority: { kind: 'default-head', ref: 'refs/heads/main' }, tip: expectedTip });
    const second = await observeGitlinkOrigin({ url: remote, fullRef: 'refs/heads/main' });
    expect(second.authority).toEqual({ kind: 'branch', ref: 'refs/heads/main' });
    expect(second.tip).toBe(expectedTip);
    expect(second.observationId).not.toBe(first.observationId);
    expect(Object.isFrozen(first)).toBe(true);
    expect(await inspectObservedGitlinkContainment({ runGit: testRunGit, repoDir: local,
      selectedCommit: expectedTip, observation: first })).toEqual({
      selectedTree: await git(['rev-parse', 'HEAD^{tree}'], local),
      tipTree: await git(['rev-parse', 'HEAD^{tree}'], local), contained: true,
    });
    expect(await git(['show-ref'], local)).toBe(refs);
  });

  it('ignores ambient include/URL rewrite and Git directory/command overrides', async () => {
    const remote = await seedBare('authorized', 'right.txt');
    const wrong = await seedBare('redirected', 'wrong.txt');
    const expected = await git(['rev-parse', 'HEAD'], remote);
    const wrongTip = await git(['rev-parse', 'HEAD'], wrong);
    expect(wrongTip).not.toBe(expected);
    const included = join(tmpRoot, 'included.gitconfig');
    await writeFile(included, `[url "${wrong}"]\n\tinsteadOf = ${remote}\n`);
    const config = join(tmpRoot, 'global.gitconfig');
    await writeFile(config, `[include]\n\tpath = ${included}\n`);
    vi.stubEnv('GIT_CONFIG_GLOBAL', config);
    vi.stubEnv('GIT_CONFIG', config);
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', `url.${wrong}.insteadOf`);
    vi.stubEnv('GIT_CONFIG_VALUE_0', remote);
    vi.stubEnv('GIT_CONFIG_PARAMETERS', 'invalid inherited config');
    vi.stubEnv('GIT_DIR', join(tmpRoot, 'missing.git'));
    vi.stubEnv('GIT_WORK_TREE', wrong);
    vi.stubEnv('GIT_SSH_COMMAND', 'false');
    vi.stubEnv('GIT_PROXY_COMMAND', 'false');
    expect((await observeGitlinkOrigin({ url: remote })).tip).toBe(expected);
  });

  it('ignores ambient executable lookup when observing the authorized origin', async () => {
    const remote = await seedBare('fixed-executable', 'lib.txt');
    const expected = await git(['rev-parse', 'HEAD'], remote);
    const tools = join(tmpRoot, 'ambient-bin');
    await mkdir(tools);
    const marker = join(tools, 'called');
    // A real executable in the inherited search path would replace the observer's
    // Git before any config isolation took effect. The system path must win.
    await writeFile(join(tools, 'git'), '#!/bin/sh\n: > "' + marker + '"\nexit 97\n');
    await chmod(join(tools, 'git'), 0o755);
    vi.stubEnv('PATH', tools + ':' + process.env.PATH);
    expect((await observeGitlinkOrigin({ url: remote })).tip).toBe(expected);
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses unavailable, non-head, malformed and detached default authority', async () => {
    const remote = await seedBare('authority', 'lib.txt');
    for (const fullRef of ['refs/tags/main', 'main', 'refs/heads/main:other', 'refs/heads/missing']) {
      await expect(observeGitlinkOrigin({ url: remote, fullRef })).rejects.toThrow();
    }
    const tip = await git(['rev-parse', 'HEAD'], remote);
    await git(['update-ref', '--no-deref', 'HEAD', tip], remote);
    await expect(observeGitlinkOrigin({ url: remote })).rejects.toThrow('gitlink-origin-authority');
    expect((await observeGitlinkOrigin({ url: remote, fullRef: 'refs/heads/main' })).tip).toBe(tip);
    await expect(observeGitlinkOrigin({ url: join(tmpRoot, 'absent') })).rejects.toThrow();
  });

  it('exposes changed advertised tips and changed symbolic HEAD even at an identical tip', async () => {
    const remote = await seedBare('moving', 'lib.txt');
    const initial = await observeGitlinkOrigin({ url: remote });
    await git(['update-ref', 'refs/heads/other', initial.tip], remote);
    await git(['symbolic-ref', 'HEAD', 'refs/heads/other'], remote);
    const redirected = await observeGitlinkOrigin({ url: remote });
    expect(redirected.tip).toBe(initial.tip);
    expect(redirected.authority.ref).toBe('refs/heads/other');
    const local = join(tmpRoot, 'moving-local');
    await git(['clone', remote, local], tmpRoot);
    await configRepo(local);
    await writeFile(join(local, 'new.txt'), 'new\n');
    await git(['add', '-A'], local);
    await git(['commit', '-m', 'move remote'], local);
    await git(['push', 'origin', 'HEAD:refs/heads/other'], local);
    const moved = await observeGitlinkOrigin({ url: remote });
    expect(moved.tip).not.toBe(initial.tip);
    expect(moved.authority).toEqual(redirected.authority);
    expect((await inspectObservedGitlinkContainment({ runGit: testRunGit, repoDir: local,
      selectedCommit: initial.tip, observation: moved })).contained).toBe(true);
  });

  it('refuses a directly advertised tip absent from the child object database without fetching it', async () => {
    const remote = await seedBare('missing-tip', 'lib.txt');
    const local = join(tmpRoot, 'missing-tip-local');
    const publisher = join(tmpRoot, 'publisher');
    await git(['clone', remote, local], tmpRoot);
    await git(['clone', remote, publisher], tmpRoot);
    await configRepo(publisher);
    const selectedCommit = await git(['rev-parse', 'HEAD'], local);
    const refs = await git(['show-ref'], local);
    await writeFile(join(publisher, 'new.txt'), 'new remote object\n');
    await git(['add', '-A'], publisher);
    await git(['commit', '-m', 'new tip'], publisher);
    await git(['push', 'origin', 'main'], publisher);
    const observation = await observeGitlinkOrigin({ url: remote });
    await expect(inspectObservedGitlinkContainment({ runGit: testRunGit, repoDir: local,
      selectedCommit, observation })).rejects.toThrow('gitlink-origin-commit-unavailable');
    expect(await hasCommit(local, observation.tip)).toBe(false);
    expect(await git(['show-ref'], local)).toBe(refs);
  });

  it('refuses non-commit selections and does not infer containment from a forged tracking ref', async () => {
    const remote = await seedBare('nonancestor', 'lib.txt');
    const local = join(tmpRoot, 'nonancestor-local');
    await git(['clone', remote, local], tmpRoot);
    await configRepo(local);
    const observation = await observeGitlinkOrigin({ url: remote });
    await writeFile(join(local, 'unpublished.txt'), 'not published\n');
    await git(['add', '-A'], local);
    await git(['commit', '-m', 'unpublished'], local);
    const selectedCommit = await git(['rev-parse', 'HEAD'], local);
    await git(['update-ref', 'refs/remotes/origin/main', selectedCommit], local);
    expect((await inspectObservedGitlinkContainment({ runGit: testRunGit, repoDir: local,
      selectedCommit, observation })).contained).toBe(false);
    for (const selectedCommit of [await git(['rev-parse', 'HEAD^{tree}'], local),
      await git(['rev-parse', 'HEAD:lib.txt'], local)]) {
      await expect(inspectObservedGitlinkContainment({ runGit: testRunGit, repoDir: local,
        selectedCommit, observation })).rejects.toThrow('gitlink-origin-commit-unavailable');
    }
  });

  it('uses direct publication evidence through the existing gitlink reader despite stale tracking refs', async () => {
    const t = await makeTopology();
    const baseCommit = await git(['rev-parse', 'HEAD'], t.work);
    const sub = join(t.work, 'libs/sub');
    const oldTracking = await git(['rev-parse', 'refs/remotes/origin/main'], sub);
    await writeFile(join(sub, 'published.txt'), 'published\n');
    await git(['add', '-A'], sub);
    await git(['commit', '-m', 'published selection'], sub);
    const selected = await git(['rev-parse', 'HEAD'], sub);
    // Publish by URL so the local origin/main remains stale.
    await git(['push', t.subUpstream, 'HEAD:refs/heads/main'], sub);
    await git(['add', 'libs/sub'], t.work);
    await git(['commit', '-m', 'select published child'], t.work);
    const commit = await git(['rev-parse', 'HEAD'], t.work);
    const observation = await observeGitlinkOrigin({ url: t.subUpstream });
    expect(observation.tip).toBe(selected);
    expect(await git(['rev-parse', 'refs/remotes/origin/main'], sub)).toBe(oldTracking);
    const refs = await git(['show-ref'], sub);
    const runNetworkGit = vi.fn(async () => { throw new Error('unexpected fetch'); });
    expect(await findUnpublishedGitlinks({ repoDir: t.work, commit, baseCommit, runGit: testRunGit,
      runNetworkGit, originObservations: { 'libs/sub': observation } })).toEqual({ ok: true, unpublished: [] });
    expect(runNetworkGit).not.toHaveBeenCalled();
    expect(await git(['show-ref'], sub)).toBe(refs);
    expect((await findUnpublishedGitlinks({ repoDir: t.work, commit, baseCommit, runGit: testRunGit,
      originObservations: {} })).ok).toBe(false);
    expect((await findUnpublishedGitlinks({ repoDir: t.work, commit, baseCommit, runGit: testRunGit,
      originObservations: { 'libs/sub': { ...observation, url: t.subFork } } })).ok).toBe(false);

    await git(['config', '-f', '.gitmodules', 'submodule.libs/sub.branch', 'main'], t.work);
    await git(['add', '.gitmodules'], t.work);
    await git(['commit', '-m', 'pin branch authority'], t.work);
    const branched = await git(['rev-parse', 'HEAD'], t.work);
    expect((await findUnpublishedGitlinks({ repoDir: t.work, commit: branched, baseCommit, runGit: testRunGit,
      originObservations: { 'libs/sub': observation } })).ok).toBe(false);
    const named = await observeGitlinkOrigin({ url: t.subUpstream, fullRef: 'refs/heads/main' });
    expect(await findUnpublishedGitlinks({ repoDir: t.work, commit: branched, baseCommit, runGit: testRunGit,
      originObservations: { 'libs/sub': named } })).toEqual({ ok: true, unpublished: [] });
    await git(['update-ref', 'refs/heads/other', selected], t.subUpstream);
    const other = await observeGitlinkOrigin({ url: t.subUpstream, fullRef: 'refs/heads/other' });
    expect((await findUnpublishedGitlinks({ repoDir: t.work, commit: branched, baseCommit, runGit: testRunGit,
      originObservations: { 'libs/sub': other } })).ok).toBe(false);

    await git(['config', '-f', '.gitmodules', 'submodule.alias.path', 'libs/sub'], t.work);
    await git(['config', '-f', '.gitmodules', 'submodule.alias.url', t.subUpstream], t.work);
    await git(['add', '.gitmodules'], t.work);
    await git(['commit', '-m', 'duplicate mapping control'], t.work);
    expect((await findUnpublishedGitlinks({ repoDir: t.work, commit: await git(['rev-parse', 'HEAD'], t.work),
      baseCommit, runGit: testRunGit, originObservations: { 'libs/sub': named } })).ok).toBe(false);
  });
});

describe('working copy WITH submodules (P-014 / D-017, WI-10006416)', () => {
  it('runs one per-submodule safety-check pass on an unchanged fork tick', async () => {
    const t = await makeTopology();
    const forks: SubmoduleForksRead = { source: 'set', forks: { 'libs/sub': t.subFork } };

    expect((await tick(t, forks)).commitOnly).toBeNull();
    const second = await tick(t, forks);
    expect(second.commitOnly).toBeNull();
    expect(second.setupInvocations).toBe(1);

    const subDir = join(t.work, 'libs/sub');
    expect(second.setupGitCommands.filter((call) => call.cwd === subDir)).toEqual([
      { runner: 'runGit', args: ['remote', 'get-url', POT_FORK_REMOTE_NAME], cwd: subDir },
      { runner: 'runGit', args: ['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd: subDir },
      {
        runner: 'runGit',
        args: ['rev-parse', '--verify', '--quiet', `refs/remotes/${POT_FORK_REMOTE_NAME}/${WORKING_COPY_INTEGRATION_BRANCH}`],
        cwd: subDir,
      },
    ]);
    expect(second.setupGitCommands.filter((call) => call.runner === 'codeRunGit')).toHaveLength(1);
  });

  it('the superproject fork’s gitlink resolves on the submodule fork; no main repository moves', async () => {
    const t = await makeTopology();
    const superMain = await git(['rev-parse', 'main'], t.superUpstream);
    const subMain = await git(['rev-parse', 'main'], t.subUpstream);
    await writeFile(join(t.work, 'libs/sub/fix.txt'), 'agent fix inside the submodule\n');
    await writeFile(join(t.work, 'app-fix.txt'), 'agent fix in the superproject\n');

    const r = await tick(t, { source: 'set', forks: { 'libs/sub': t.subFork } });
    expect(r.commitOnly).toBeNull();
    expect(r.cfg.pushSubmoduleOrigins).toBe(true);
    expect(r.outcome.status, JSON.stringify(r.outcome)).not.toBe('error');

    // The superproject published to ITS fork's integration branch…
    const published = await git(['rev-parse', WORKING_COPY_INTEGRATION_BRANCH], t.superFork);
    const gitlink = await git(['rev-parse', `${published}:libs/sub`], t.superFork);
    // …and that gitlink is a real commit on the SUBMODULE fork, carrying the agent's file.
    expect(await hasCommit(t.subFork, gitlink)).toBe(true);
    expect(await git(['show', `${gitlink}:fix.txt`], t.subFork)).toBe('agent fix inside the submodule');
    expect(await git(['rev-parse', WORKING_COPY_INTEGRATION_BRANCH], t.subFork)).toBe(gitlink);
    // The submodule's own checkout pushes through `pot-fork`, never its origin.
    expect(await git(['remote', 'get-url', POT_FORK_REMOTE_NAME], join(t.work, 'libs/sub'))).toBe(t.subFork);

    // Neither main repository moved, and the submodule's main never received the commit.
    expect(await git(['rev-parse', 'main'], t.superUpstream)).toBe(superMain);
    expect(await git(['rev-parse', 'main'], t.subUpstream)).toBe(subMain);
    expect(await hasCommit(t.subUpstream, gitlink)).toBe(false);
  });

  it('a submodule with no fork but a published HEAD is left untouched while the superproject still pushes (WI-6554700010018380)', async () => {
    const t = await makeTopology();
    const subDir = join(t.work, 'libs/sub');
    const subMain = await git(['rev-parse', 'main'], t.subUpstream);
    const pin = await git(['rev-parse', 'HEAD'], subDir);
    await writeFile(join(subDir, 'fix.txt'), 'install-generated file inside the unforked submodule\n');
    await writeFile(join(t.work, 'app-fix.txt'), 'agent fix in the superproject\n');

    const r = await tick(t, { source: 'absent', forks: {} });
    expect(r.commitOnly).toBeNull();
    expect(r.cfg.unforkedSubmodules).toEqual(['libs/sub']);
    expect(r.outcome.status, JSON.stringify(r.outcome)).not.toBe('error');
    // The superproject published to its fork, pinning the submodule at its PUBLISHED commit…
    const published = await git(['rev-parse', WORKING_COPY_INTEGRATION_BRANCH], t.superFork);
    expect(await git(['show', `${published}:app-fix.txt`], t.superFork)).toBe('agent fix in the superproject');
    expect(await git(['rev-parse', `${published}:libs/sub`], t.superFork)).toBe(pin);
    expect(await hasCommit(t.subUpstream, pin)).toBe(true);
    // …and nothing was committed inside the submodule: its edit is still untracked there.
    expect(await git(['rev-parse', 'HEAD'], subDir)).toBe(pin);
    expect(await git(['status', '--porcelain'], subDir)).toBe('?? fix.txt');
    expect(await git(['rev-parse', 'main'], t.subUpstream)).toBe(subMain);
    expect(await git(['for-each-ref', 'refs/heads'], t.subFork)).not.toContain('staging');
  });

  it('a submodule with no fork and UNPUBLISHED commits makes the tick commit-only, and git-sync adds no commit inside it', async () => {
    const t = await makeTopology();
    const subDir = join(t.work, 'libs/sub');
    const subMain = await git(['rev-parse', 'main'], t.subUpstream);
    await writeFile(join(subDir, 'local.txt'), 'a commit no remote holds\n');
    await git(['add', '-A'], subDir);
    await git(['commit', '--no-verify', '-m', 'local-only commit'], subDir);
    const localHead = await git(['rev-parse', 'HEAD'], subDir);
    await writeFile(join(subDir, 'fix.txt'), 'agent fix\n');

    const r = await tick(t, { source: 'absent', forks: {} });
    expect(r.commitOnly).toBe('working_copy_submodule_fork_missing');
    expect(r.cfg.push).toBe(false);
    expect(r.cfg.pushSubmoduleOrigins).toBe(false);
    expect(r.cfg.unforkedSubmodules).toEqual(['libs/sub']);
    expect((await testRunGit(['rev-parse', '--verify', 'staging'], t.superFork)).code).not.toBe(0);
    expect(await git(['rev-parse', 'main'], t.subUpstream)).toBe(subMain);
    expect(await git(['for-each-ref', 'refs/heads'], t.subFork)).not.toContain('staging');
    // The commit-only tick did not grow the unpublishable history inside the submodule.
    expect(await git(['rev-parse', 'HEAD'], subDir)).toBe(localHead);
    expect(await git(['status', '--porcelain'], subDir)).toBe('?? fix.txt');
  });

  it('an unreadable submodule-fork setting is commit-only too (fail closed)', async () => {
    const t = await makeTopology();
    await writeFile(join(t.work, 'libs/sub/fix.txt'), 'agent fix\n');
    const r = await tick(t, { source: 'error', forks: {} });
    expect(r.commitOnly).toBe('working_copy_submodule_forks_unreadable');
    expect(r.cfg.push).toBe(false);
  });

  it('a gitlink stays UNPUBLISHED until its commit reaches the submodule’s main repository', async () => {
    const t = await makeTopology();
    await writeFile(join(t.work, 'libs/sub/fix.txt'), 'agent fix inside the submodule\n');
    await tick(t, { source: 'set', forks: { 'libs/sub': t.subFork } });
    const head = await git(['rev-parse', 'HEAD'], t.work);
    const gitlink = await git(['rev-parse', 'HEAD:libs/sub'], t.work);
    await git(['fetch', 'origin', 'main'], t.work);

    const before = await findUnpublishedGitlinks({ repoDir: t.work, commit: head, baseCommit: 'origin/main', runGit: testRunGit });
    expect(before).toEqual({
      ok: true,
      unpublished: [{ path: 'libs/sub', sha: gitlink, url: t.subUpstream, branch: 'main' }],
    });

    // The submodule PR merges (its commit lands on the submodule's main): now published.
    await git(['push', t.subUpstream, `${gitlink}:refs/heads/main`], t.subFork);
    const after = await findUnpublishedGitlinks({ repoDir: t.work, commit: head, baseCommit: 'origin/main', runGit: testRunGit });
    expect(after).toEqual({ ok: true, unpublished: [] });
  });
});

describe('sync-back with submodules (P-014 / D-017 §4)', () => {
  const FORKS = (t: Topology): SubmoduleForksRead => ({ source: 'set', forks: { 'libs/sub': t.subFork } });

  it('absorbs an upstream submodule bump into the diverged submodule, holds the push one tick, then publishes a resolvable gitlink', async () => {
    const t = await makeTopology();
    await writeFile(join(t.work, 'libs/sub/fix.txt'), 'agent fix inside the submodule\n');
    await tick(t, FORKS(t));
    const agentPin = await git(['rev-parse', 'HEAD:libs/sub'], t.work);
    const publishedBefore = await git(['rev-parse', WORKING_COPY_INTEGRATION_BRANCH], t.superFork);

    const upstreamPin = await moveUpstreamSubmodulePin(t, 'upstream.txt', 'upstream change\n');
    const absorbTick = await tick(t, FORKS(t));
    expect(absorbTick.outcome.syncBack).toMatchObject({ status: 'merged', absorbedSubmodules: ['libs/sub'] });

    // The pin the superproject recorded is exactly what the checkout holds, and it carries both sides.
    const subHead = await git(['rev-parse', 'HEAD'], join(t.work, 'libs/sub'));
    expect(await git(['rev-parse', 'HEAD:libs/sub'], t.work)).toBe(subHead);
    expect(await isAncestor(join(t.work, 'libs/sub'), agentPin, subHead)).toBe(true);
    expect(await isAncestor(join(t.work, 'libs/sub'), upstreamPin, subHead)).toBe(true);
    expect(await git(['status', '--porcelain'], t.work)).toBe('');
    // Held: the superproject fork did not receive a gitlink its submodule fork cannot resolve.
    expect(await git(['rev-parse', WORKING_COPY_INTEGRATION_BRANCH], t.superFork)).toBe(publishedBefore);
    expect(await hasCommit(t.subFork, subHead)).toBe(false);

    // Next tick: the submodule fork gets the absorbed commit first, then the superproject publishes.
    await tick(t, FORKS(t));
    const published = await git(['rev-parse', WORKING_COPY_INTEGRATION_BRANCH], t.superFork);
    expect(published).toBe(await git(['rev-parse', 'HEAD'], t.work));
    expect(await git(['rev-parse', `${published}:libs/sub`], t.superFork)).toBe(subHead);
    expect(await hasCommit(t.subFork, subHead)).toBe(true);
    // The submodule's main repository still only has its own commit.
    expect(await git(['rev-parse', 'main'], t.subUpstream)).toBe(upstreamPin);
  });

  it('fast-forwards an untouched submodule checkout to the upstream pin', async () => {
    const t = await makeTopology();
    await writeFile(join(t.work, 'app-fix.txt'), 'agent fix in the superproject only\n');
    await tick(t, FORKS(t));

    const upstreamPin = await moveUpstreamSubmodulePin(t, 'upstream.txt', 'upstream change\n');
    const r = await tick(t, FORKS(t));
    expect(r.outcome.syncBack).toMatchObject({ status: 'merged', absorbedSubmodules: ['libs/sub'] });
    expect(await git(['rev-parse', 'HEAD'], join(t.work, 'libs/sub'))).toBe(upstreamPin);
    expect(await git(['rev-parse', 'HEAD:libs/sub'], t.work)).toBe(upstreamPin);
    expect(await git(['status', '--porcelain'], t.work)).toBe('');
  });

  it('a conflicting upstream submodule change is reported and changes neither repository', async () => {
    const t = await makeTopology();
    await writeFile(join(t.work, 'libs/sub/lib.txt'), 'agent rewrote the seed line\n');
    await tick(t, FORKS(t));
    const superHead = await git(['rev-parse', 'HEAD'], t.work);
    const subHead = await git(['rev-parse', 'HEAD'], join(t.work, 'libs/sub'));

    await moveUpstreamSubmodulePin(t, 'lib.txt', 'upstream rewrote the seed line\n');
    const r = await tick(t, FORKS(t));
    expect(r.outcome.syncBack).toMatchObject({ status: 'conflict', conflictedFiles: ['libs/sub/lib.txt'] });
    expect(await git(['rev-parse', 'HEAD'], t.work)).toBe(superHead);
    expect(await git(['rev-parse', 'HEAD'], join(t.work, 'libs/sub'))).toBe(subHead);
    expect(await git(['status', '--porcelain'], t.work)).toBe('');
  });
});
