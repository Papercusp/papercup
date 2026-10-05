/**
 * pot-integration-mode.integration.test.ts — plan pot-review-integration-mode-2026-10-05,
 * P-014 (spec SPEC-P-014-fork-push; decisions D-005, D-006).
 *
 * The INTEGRATION leg of "a working-copy pot's git-sync pushes to its own fork, never
 * the main repository". The unit tests in pot-integration-mode.test.ts pin the pure
 * decision; this file proves the decision reaches real git. Each case composes the
 * same production seam git-sync-action.ts uses on a tick:
 *
 *   resolveIntegrationPushRemote(read, forkRemote)        — the pure decision
 *     → applyIntegrationPushTarget(slug, cfg, decision, repoPath)
 *         (with the REAL ensurePotForkGitRemote — a real `git remote add/set-url`)
 *     → runGitSync(slug, { repoPath, config: cfg })       — the real commit/fetch/push
 *
 * against two REAL bare repositories: the main repository ("upstream", the clone's
 * `origin`) and the pot's fork (a bare clone of upstream). The observable is where the
 * agent's commit actually lands: which bare repo's `main` tip moves.
 *
 * No database is needed: the mode READ is supplied as a PotIntegrationModeRead (the
 * store-backed readPotIntegrationMode is covered by the unit tests), and runGitSync is
 * DB-free when no routine/lock deps are injected (as in multi-peer-convergence.test.ts).
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runGitSync, type GitSyncConfig, type RunGit } from './run-git-sync';
import {
  applyIntegrationPushTarget,
  POT_FORK_REMOTE_NAME,
  resolveIntegrationPushRemote,
  type PotIntegrationModeRead,
} from './pot-integration-mode';

// ── real-git helpers (subprocess; mirrors multi-peer-convergence) ───────────────

/** runGitSync's git: fleet hooks disabled so the shared pre-push hook never fires here. */
const testRunGit: RunGit = (args, cwd) =>
  new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' };
    delete env.GIT_CONFIG;
    const child = spawn('git', ['-c', 'core.hooksPath=/nonexistent', ...args], { cwd, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', (e) => resolve({ code: -1, stdout, stderr: stderr + String(e) }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });

async function git(args: string[], cwd: string): Promise<string> {
  const r = await testRunGit(args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed (${r.code}): ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

async function configRepo(dir: string): Promise<void> {
  await git(['config', 'user.email', 'pim-it@example.com'], dir);
  await git(['config', 'user.name', 'pim integration'], dir);
  await git(['config', 'commit.gpgsign', 'false'], dir);
  await git(['config', 'core.hooksPath', '/nonexistent'], dir);
}

const tipOf = (bare: string): Promise<string> => git(['rev-parse', 'main'], bare);
const headOf = (dir: string): Promise<string> => git(['rev-parse', 'HEAD'], dir);
const filesAt = (bare: string): Promise<string> => git(['ls-tree', '-r', '--name-only', 'main'], bare);

interface Topology {
  /** The main repository — the pot clone's `origin`. */
  upstream: string;
  /** The pot's own fork — a bare clone of upstream (same history, separate repo). */
  fork: string;
  /** The pot's shared working tree (a clone of upstream). */
  work: string;
  /** The seed commit both bare repos start at. */
  seed: string;
}

let tmpRoot: string;

async function makeTopology(name: string): Promise<Topology> {
  const upstream = join(tmpRoot, `${name}-upstream.git`);
  await mkdir(upstream, { recursive: true });
  await git(['init', '--bare', '-b', 'main'], upstream);
  const seedDir = join(tmpRoot, `${name}-seed`);
  await git(['clone', upstream, seedDir], tmpRoot);
  await configRepo(seedDir);
  await writeFile(join(seedDir, 'shared.txt'), 'seed\n');
  await git(['add', '-A'], seedDir);
  await git(['commit', '--no-verify', '-m', 'seed'], seedDir);
  await git(['push', '--no-verify', '-u', 'origin', 'main'], seedDir);
  await rm(seedDir, { recursive: true, force: true });

  const fork = join(tmpRoot, `${name}-fork.git`);
  await git(['clone', '--bare', upstream, fork], tmpRoot);

  const work = join(tmpRoot, `${name}-work`);
  await git(['clone', upstream, work], tmpRoot);
  await configRepo(work);
  const seed = await tipOf(upstream);
  return { upstream, fork, work, seed };
}

/** An agent edit left in the shared tree, as git-sync finds it on a tick. */
async function agentEdit(work: string, file: string): Promise<void> {
  await writeFile(join(work, file), `agent work in ${file}\n`);
}

/** One git-sync tick through the production seam: decide → apply → sync. */
async function tick(
  slug: string,
  t: Topology,
  read: PotIntegrationModeRead,
  forkRemote: string | undefined,
): Promise<{ commitOnly: string | null; cfg: GitSyncConfig; status: string }> {
  const decision = resolveIntegrationPushRemote({ read, forkRemote });
  const cfg: GitSyncConfig = { branch: 'main', push: true };
  const commitOnly = await applyIntegrationPushTarget(slug, cfg, decision, t.work);
  const outcome = await runGitSync(slug, { runGit: testRunGit, repoPath: t.work, config: cfg });
  return { commitOnly, cfg, status: outcome.status };
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'pot-integration-mode-it-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('pot integration mode — where a real git-sync tick pushes (P-014, SPEC-P-014-fork-push)', () => {
  it('review (working copy) with a fork: the commit lands on the fork and the main repository does not move', async () => {
    const t = await makeTopology('review');
    await agentEdit(t.work, 'agent.txt');

    const r = await tick('pim-review', t, { mode: 'review', source: 'set' }, t.fork);

    expect(r.commitOnly).toBeNull();
    expect(r.status).toBe('synced');
    expect(r.cfg.remote).toBe(POT_FORK_REMOTE_NAME);
    expect(r.cfg.pushSubmoduleOrigins).toBe(false);
    // the real `pot-fork` git remote now points at the fork
    expect(await git(['remote', 'get-url', POT_FORK_REMOTE_NAME], t.work)).toBe(t.fork);

    const head = await headOf(t.work);
    expect(head).not.toBe(t.seed);
    expect(await tipOf(t.fork)).toBe(head);
    expect(await filesAt(t.fork)).toContain('agent.txt');
    // the main repository is untouched — unreviewed work never reaches it
    expect(await tipOf(t.upstream)).toBe(t.seed);
    expect(await filesAt(t.upstream)).not.toContain('agent.txt');
  });

  it('direct (default, no setting) pushes the main repository exactly as before, and the fork does not move', async () => {
    const t = await makeTopology('direct');
    await agentEdit(t.work, 'agent.txt');

    // a fork URL is present but must be ignored in direct mode
    const r = await tick('pim-direct', t, { mode: 'direct', source: 'absent' }, t.fork);

    expect(r.commitOnly).toBeNull();
    expect(r.status).toBe('synced');
    expect(r.cfg.remote).toBeUndefined();
    const head = await headOf(t.work);
    expect(await tipOf(t.upstream)).toBe(head);
    expect(await filesAt(t.upstream)).toContain('agent.txt');
    expect(await tipOf(t.fork)).toBe(t.seed);
    // direct mode never creates the pot-fork remote
    const remotes = (await git(['remote'], t.work)).split('\n');
    expect(remotes).not.toContain(POT_FORK_REMOTE_NAME);
  });

  it('explicit direct behaves the same as the default', async () => {
    const t = await makeTopology('direct-set');
    await agentEdit(t.work, 'agent.txt');

    const r = await tick('pim-direct-set', t, { mode: 'direct', source: 'set' }, t.fork);

    expect(r.status).toBe('synced');
    expect(await tipOf(t.upstream)).toBe(await headOf(t.work));
    expect(await tipOf(t.fork)).toBe(t.seed);
  });

  it('review re-points a drifted pot-fork remote, so the push reaches the CURRENT fork only', async () => {
    const t = await makeTopology('drift');
    const staleFork = join(tmpRoot, 'drift-stale-fork.git');
    await git(['clone', '--bare', t.upstream, staleFork], tmpRoot);
    await git(['remote', 'add', POT_FORK_REMOTE_NAME, staleFork], t.work);
    await agentEdit(t.work, 'agent.txt');

    const r = await tick('pim-drift', t, { mode: 'review', source: 'set' }, t.fork);

    expect(r.status).toBe('synced');
    expect(await git(['remote', 'get-url', POT_FORK_REMOTE_NAME], t.work)).toBe(t.fork);
    expect(await tipOf(t.fork)).toBe(await headOf(t.work));
    expect(await tipOf(staleFork)).toBe(t.seed);
    expect(await tipOf(t.upstream)).toBe(t.seed);
  });

  it('review with no fork configured commits locally and pushes NOWHERE (never falls back to the main repository)', async () => {
    const t = await makeTopology('nofork');
    await agentEdit(t.work, 'agent.txt');

    const r = await tick('pim-nofork', t, { mode: 'review', source: 'set' }, undefined);

    expect(r.commitOnly).toBe('working_copy_fork_missing');
    expect(r.cfg.push).toBe(false);
    const head = await headOf(t.work);
    expect(head).not.toBe(t.seed); // the work is committed locally, not lost
    expect(await tipOf(t.upstream)).toBe(t.seed);
    expect(await tipOf(t.fork)).toBe(t.seed);
  });

  it.each([
    ['error' as const, 'integration_mode_unknown'],
    ['malformed' as const, 'integration_mode_malformed'],
  ])(
    'an unreadable mode (source=%s) commits locally and pushes nowhere, even with a fork configured',
    async (source, reason) => {
      const t = await makeTopology(`fail-${source}`);
      await agentEdit(t.work, 'agent.txt');

      const r = await tick(`pim-fail-${source}`, t, { mode: 'direct', source }, t.fork);

      expect(r.commitOnly).toBe(reason);
      expect(r.cfg.push).toBe(false);
      expect(await headOf(t.work)).not.toBe(t.seed);
      expect(await tipOf(t.upstream)).toBe(t.seed);
      expect(await tipOf(t.fork)).toBe(t.seed);
    },
  );
});
