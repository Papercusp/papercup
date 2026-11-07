/** Real-Git capture and frozen-publication contracts in the maintained integration router. */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureGitSyncCandidate, publishGitSyncCandidate, SOURCE_CUSTODY_REF_PREFIX, type RunGit } from './run-git-sync';
import { createGitSyncLeaseFence } from './git-sync-lease-fence';
import { runWithGitSyncPerInstallLease } from './git-sync-action';
import { startDedicatedNativePg } from '@papercusp/test-config/pg';
import { getOrgPg, _resetForTests as resetOrgPg } from '@papercusp/db-org';
import { configureLocks, locksHost, _resetForTests as resetLocks, getTxPool } from '../../agent-tools/locks/su-lock-store';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(unborn = false) {
  const repo = mkdtempSync(join(tmpdir(), 'git-sync-candidate-'));
  roots.push(repo);
  const git = (...args: string[]): string => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 30_000 });
    if (result.status !== 0) throw new Error(String(result.stderr || result.stdout));
    return String(result.stdout).trim();
  };
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@papercusp.local');
  git('config', 'user.name', 'candidate test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'a.txt'), 'baseline a\n');
  writeFileSync(join(repo, 'b.txt'), 'baseline b\n');
  if (!unborn) {
    git('add', '-A');
    git('commit', '-m', 'baseline');
  }
  const runGit: RunGit = async (args, cwd, options) => {
    const result = spawnSync('git', args, {
      cwd, encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...options?.env },
    });
    if (result.status !== 0 && args[0] === 'add') {
      const flags = spawnSync('git', ['ls-files', '-v'], {
        cwd, encoding: 'utf8', env: { ...process.env, ...options?.env }, timeout: 30_000,
      });
      console.error('candidate fixture stage failed', { args, code: result.status,
        stderr: result.stderr, privateFlags: flags.stdout });
    }
    return { code: result.status ?? -1, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
  };
  return { repo, git, runGit };
}

/** Read raw bytes: status may itself rewrite the index stat cache. */
function candidateState(f: ReturnType<typeof fixture>) {
  let index: string | null = null;
  try { index = readFileSync(join(f.repo, '.git/index')).toString('base64'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const files = ['a.txt', 'b.txt', 'new.txt'].map(path => {
    try {
      const stat = lstatSync(join(f.repo, path));
      return { path, mode: stat.mode, value: stat.isSymbolicLink()
        ? readlinkSync(join(f.repo, path)) : readFileSync(join(f.repo, path)).toString('base64') };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { path, absent: true };
    }
  });
  const head = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: f.repo, encoding: 'utf8' });
  return { index, entries: f.git('ls-files', '--stage', '--debug'), files,
    head: head.status === 0 ? head.stdout.trim() : null };
}

function unmerge(f: ReturnType<typeof fixture>) {
  const one = f.git('rev-parse', 'HEAD:a.txt');
  const two = f.git('rev-parse', 'HEAD:b.txt');
  f.git('update-index', '--force-remove', '--', 'a.txt');
  const staged = spawnSync('git', ['update-index', '--index-info'], { cwd: f.repo,
    input: `100644 ${one} 1\ta.txt\n100644 ${two} 2\ta.txt\n100644 ${one} 3\ta.txt\n`, encoding: 'utf8' });
  expect(staged.status).toBe(0);
}

const publicationStates = ['staged', 'unstaged', 'split', 'deletion', 'executable', 'symlink', 'intent-to-add'] as const;
function laterState(f: ReturnType<typeof fixture>, state: typeof publicationStates[number]) {
  writeFileSync(join(f.repo, 'a.txt'), 'B1 later\n');
  if (state === 'staged' || state === 'split') f.git('add', '--', 'a.txt');
  if (state === 'split') writeFileSync(join(f.repo, 'a.txt'), 'B2 unstaged\n');
  if (state === 'deletion') f.git('rm', '-f', '--', 'a.txt');
  if (state === 'executable') { chmodSync(join(f.repo, 'a.txt'), 0o755); f.git('add', '--', 'a.txt'); }
  if (state === 'symlink') {
    rmSync(join(f.repo, 'a.txt')); symlinkSync('B1-link', join(f.repo, 'a.txt')); f.git('add', '--', 'a.txt');
  }
  if (state === 'intent-to-add') { writeFileSync(join(f.repo, 'new.txt'), 'B1 new\n'); f.git('add', '-N', '--', 'new.txt'); }
}
function unpublishedState(f: ReturnType<typeof fixture>) {
  const { head: _head, ...state } = candidateState(f);
  return state;
}
// Dedicated fixture repositories have no shared platform writer. Production
// callers must supply the existing git-sync lease's assertHeld method.
const pilotChecks = { assertHeld: () => {}, beforePublish: async () => ({ ok: true as const }) };

describe('lifecycle P003 frozen publication', () => {
  it.each(publicationStates)('publishes A1 preserving the real %s index and later working state', async state => {
    const f = fixture();
    writeFileSync(join(f.repo, 'a.txt'), 'A1 frozen\n');
    const request = { requestId: 'publish', generation: 1, base: f.git('rev-parse', 'HEAD'), paths: ['a.txt'] };
    const captured = await captureGitSyncCandidate(f.runGit, f.repo, request);
    if (!captured.ok) throw new Error(captured.error);
    laterState(f, state);
    const before = unpublishedState(f);
    const result = await publishGitSyncCandidate(f.runGit, f.repo, request, pilotChecks);
    expect(result).toMatchObject({ status: 'committed', tree: captured.candidate.tree });
    expect(f.git('show', 'HEAD:a.txt')).toBe('A1 frozen');
    expect(unpublishedState(f)).toEqual(before);
    const published = f.git('rev-parse', 'HEAD');
    expect(await publishGitSyncCandidate(f.runGit, f.repo, request, pilotChecks))
      .toMatchObject({ status: 'already-published', commit: published });
    // A duplicate after another writer's descendant must never rewind HEAD.
    const descendant = f.git('commit-tree', captured.candidate.tree, '-p', published, '-m', 'later commit');
    f.git('update-ref', 'HEAD', descendant, published);
    expect(await publishGitSyncCandidate(f.runGit, f.repo, request, pilotChecks))
      .toMatchObject({ status: 'already-published', commit: published });
    expect(f.git('rev-parse', 'HEAD')).toBe(descendant);
    expect(unpublishedState(f)).toEqual(before);
  });

  it.each(publicationStates.flatMap(state => ['pin', 'before-cas', 'after-cas'].map(point => ({ state, point }))))(
    'recovers $state after a stop at $point with the original commit and B1 intact', async ({ state, point }) => {
      const f = fixture();
      writeFileSync(join(f.repo, 'a.txt'), 'A1 frozen\n');
      const request = { requestId: 'crash', generation: 1, base: f.git('rev-parse', 'HEAD'), paths: ['a.txt'] };
      expect(await captureGitSyncCandidate(f.runGit, f.repo, request)).toMatchObject({ ok: true });
      laterState(f, state);
      const before = unpublishedState(f);
      let stopped = false;
      const interrupted: RunGit = async (args, cwd, options) => {
        const headCas = args[0] === 'update-ref' && args.includes('HEAD');
        if (!stopped && point === 'before-cas' && headCas) { stopped = true; throw new Error('stop'); }
        const result = await f.runGit(args, cwd, options);
        if (!stopped && ((point === 'after-cas' && headCas) ||
            (point === 'pin' && args[0] === 'update-ref' && args[1].endsWith('-publication')))) {
          stopped = true; throw new Error('stop');
        }
        return result;
      };
      expect(await publishGitSyncCandidate(interrupted, f.repo, request, pilotChecks)).toMatchObject({ status: 'error' });
      expect(stopped).toBe(true);
      expect(unpublishedState(f)).toEqual(before);
      const ref = f.git('for-each-ref', '--format=%(refname)', SOURCE_CUSTODY_REF_PREFIX).split('\n')
        .find(path => path.endsWith('-publication'))!;
      const pinned = f.git('rev-parse', ref);
      expect(await publishGitSyncCandidate(f.runGit, f.repo, request, pilotChecks))
        .toMatchObject({ status: point === 'after-cas' ? 'already-published' : 'committed', commit: pinned });
      expect(f.git('rev-parse', 'HEAD')).toBe(pinned);
      expect(f.git('show', 'HEAD:a.txt')).toBe('A1 frozen');
      expect(unpublishedState(f)).toEqual(before);
    },
  );

  it('refuses missing capture, failed checks and an unresolved candidate without changing caller state', async () => {
    const f = fixture();
    const request = { requestId: 'refuse', generation: 1, base: f.git('rev-parse', 'HEAD'), paths: ['a.txt'] };
    const before = candidateState(f);
    expect(await publishGitSyncCandidate(f.runGit, f.repo, request, pilotChecks))
      .toEqual({ status: 'error', error: 'source-custody-refused:candidate-not-captured' });
    expect(candidateState(f)).toEqual(before);
    writeFileSync(join(f.repo, 'a.txt'), 'A1\n');
    expect(await captureGitSyncCandidate(f.runGit, f.repo, request)).toMatchObject({ ok: true });
    laterState(f, 'split');
    const later = candidateState(f);
    expect(await publishGitSyncCandidate(f.runGit, f.repo, request, {
      ...pilotChecks, beforePublish: async () => ({ ok: false, error: 'candidate checks failed' }),
    })).toEqual({ status: 'error', error: 'candidate checks failed' });
    expect(candidateState(f)).toEqual(later);
    unmerge(f);
    const conflicted = candidateState(f);
    const unresolved = { ...request, requestId: 'conflict' };
    expect(await captureGitSyncCandidate(f.runGit, f.repo, unresolved))
      .toEqual({ ok: false, error: 'source-custody-refused:candidate-unmerged-index' });
    expect(await publishGitSyncCandidate(f.runGit, f.repo, unresolved, pilotChecks))
      .toMatchObject({ status: 'error' });
    expect(candidateState(f)).toEqual(conflicted);
  });

  it.each(publicationStates)('refuses a competing HEAD change at CAS without overwriting it or %s B1', async state => {
    const f = fixture();
    writeFileSync(join(f.repo, 'a.txt'), 'A1\n');
    const request = { requestId: 'cas', generation: 1, base: f.git('rev-parse', 'HEAD'), paths: ['a.txt'] };
    expect(await captureGitSyncCandidate(f.runGit, f.repo, request)).toMatchObject({ ok: true });
    laterState(f, state);
    const before = unpublishedState(f);
    const competitor = f.git('commit-tree', request.base + '^{tree}', '-p', request.base, '-m', 'other writer');
    const raced = await publishGitSyncCandidate(f.runGit, f.repo, request, {
      ...pilotChecks, beforePublish: async () => { f.git('update-ref', 'HEAD', competitor, request.base); return { ok: true }; },
    });
    expect(raced).toMatchObject({ status: 'cas-refused' });
    expect(f.git('rev-parse', 'HEAD')).toBe(competitor);
    expect(unpublishedState(f)).toEqual(before);
    expect(await publishGitSyncCandidate(f.runGit, f.repo, request, pilotChecks))
      .toEqual({ status: 'cas-refused', detail: 'candidate-publication-base-moved' });
    expect(unpublishedState(f)).toEqual(before);
  });
});

describe('lifecycle P003 common writer', () => {
  it('serializes competing fires through the production per-install lease and releases it', async () => {
    const pg = await startDedicatedNativePg();
    const previousHost = locksHost();
    const dbEnvKeys = ['DATABASE_URL', 'HARNESS_ADMIN_DATABASE_URL', 'HARNESS_DATABASE_URL',
      'PAPERCUSP_SKIP_PG_DISCOVERY', 'PAPERCUSP_PGBOUNCER'] as const;
    const previousDbEnv = Object.fromEntries(dbEnvKeys.map(key => [key, process.env[key]]));
    const privateUrl = pg.getConnectionUri();
    const slug = 'lifecycle-p003-fixture';
    const workspace = 'lifecycle-p003-private';
    try {
      // Contention also consults the real session-liveness reader. Route its
      // org pool to the owned cluster along with the separate locks database.
      process.env.DATABASE_URL = privateUrl;
      process.env.HARNESS_ADMIN_DATABASE_URL = privateUrl;
      process.env.HARNESS_DATABASE_URL = privateUrl;
      process.env.PAPERCUSP_SKIP_PG_DISCOVERY = '1';
      process.env.PAPERCUSP_PGBOUNCER = '0';
      await resetOrgPg();
      await resetLocks();
      configureLocks({ getAdminBaseUrl: () => privateUrl });
      const target = new URL(privateUrl);
      const [orgTarget] = await getOrgPg().sql`SELECT current_database() AS database, inet_server_port() AS port`;
      expect(orgTarget).toEqual({ database: decodeURIComponent(target.pathname.slice(1)), port: Number(target.port) });
      const f = fixture();
      writeFileSync(join(f.repo, 'a.txt'), 'A1 frozen\n');
      const request = { requestId: 'common-writer', generation: 1, base: f.git('rev-parse', 'HEAD'), paths: ['a.txt'] };
      expect(await captureGitSyncCandidate(f.runGit, f.repo, request)).toMatchObject({ ok: true });
      laterState(f, 'split');
      const before = unpublishedState(f);
      let competingWrites = 0;
      const quietRelease = { onExclusiveResourceReleased: () => {} };
      const first = await runWithGitSyncPerInstallLease(slug, workspace, async lease => {
        const held = await getTxPool()`SELECT owner FROM agent_resource_locks
          WHERE coordination_domain = ${workspace} AND resource = ${'git-sync:' + slug} AND status = 'held'`;
        expect(held).toHaveLength(1);
        return publishGitSyncCandidate(f.runGit, f.repo, request, {
          assertHeld: lease.assertHeld,
          beforePublish: async () => {
            const competing = await runWithGitSyncPerInstallLease(slug, workspace, async () => {
              competingWrites++;
              return 'must not run';
            }, undefined, quietRelease);
            expect(competing).toMatchObject({ state: 'skipped', reason: 'held_exclusive', blockedOn: 'git-sync:' + slug });
            expect(competingWrites).toBe(0);
            expect(unpublishedState(f)).toEqual(before);
            expect(f.git('rev-parse', 'HEAD')).toBe(request.base);
            return { ok: true };
          },
        });
      }, undefined, quietRelease);
      expect(first).toMatchObject({ state: 'ran', value: { status: 'committed' } });
      const published = f.git('rev-parse', 'HEAD');
      const second = await runWithGitSyncPerInstallLease(slug, workspace,
        lease => publishGitSyncCandidate(f.runGit, f.repo, request, { ...pilotChecks, assertHeld: lease.assertHeld }),
        undefined, quietRelease);
      expect(second).toMatchObject({ state: 'ran', value: { status: 'already-published', commit: published } });
      expect(f.git('rev-list', '--count', request.base + '..HEAD')).toBe('1');
      expect(f.git('show', 'HEAD:a.txt')).toBe('A1 frozen');
      expect(unpublishedState(f)).toEqual(before);
      expect(await getTxPool()`SELECT owner FROM agent_resource_locks WHERE coordination_domain = ${workspace}`).toHaveLength(0);
    } finally {
      try { await resetLocks(); }
      finally {
        try { await resetOrgPg(); }
        finally {
          configureLocks(previousHost);
          for (const key of dbEnvKeys) {
            if (previousDbEnv[key] === undefined) delete process.env[key];
            else process.env[key] = previousDbEnv[key];
          }
          await pg.stop();
        }
      }
    }
  }, 180_000);
});

describe('lifecycle P003 refusal boundaries', () => {
  it.each(['before-checks', 'after-checks'] as const)('stops on lease loss %s before any further Git command', async point => {
    const f = fixture();
    writeFileSync(join(f.repo, 'a.txt'), 'A1\n');
    const request = { requestId: 'lease-loss', generation: 1, base: f.git('rev-parse', 'HEAD'), paths: ['a.txt'] };
    expect(await captureGitSyncCandidate(f.runGit, f.repo, request)).toMatchObject({ ok: true });
    laterState(f, 'split');
    const before = candidateState(f);
    const fence = createGitSyncLeaseFence({ slug: 'fixture', acquiredAt: Date.now(), unconfirmedLimitMs: 60_000 });
    const commandsAfterLoss: string[][] = [];
    const observed: RunGit = async (args, cwd, options) => {
      if (fence.lost) commandsAfterLoss.push(args);
      return f.runGit(args, cwd, options);
    };
    if (point === 'before-checks') fence.markLost('refused', 'other writer acquired the lease');
    expect(await publishGitSyncCandidate(observed, f.repo, request, {
      assertHeld: () => fence.assertHeld(),
      beforePublish: async () => { fence.markLost('refused', 'refresh refused during checks'); return { ok: true }; },
    })).toMatchObject({ status: 'error' });
    expect(commandsAfterLoss).toEqual([]);
    expect(candidateState(f)).toEqual(before);
    expect(f.git('for-each-ref', '--format=%(refname)', SOURCE_CUSTODY_REF_PREFIX)).not.toContain('-publication');
  });

  it.each(['tree', 'parent'] as const)('refuses a publication pin with the wrong %s', async changed => {
    const f = fixture();
    writeFileSync(join(f.repo, 'a.txt'), 'A1\n');
    const request = { requestId: 'pin-mismatch', generation: 1, base: f.git('rev-parse', 'HEAD'), paths: ['a.txt'] };
    const captured = await captureGitSyncCandidate(f.runGit, f.repo, request);
    if (!captured.ok) throw new Error(captured.error);
    const tree = changed === 'tree' ? f.git('rev-parse', 'HEAD^{tree}') : captured.candidate.tree;
    const pin = f.git('commit-tree', tree, ...(changed === 'tree' ? ['-p', request.base] : []), '-m', 'invalid pin');
    f.git('update-ref', captured.ref + '-publication', pin);
    laterState(f, 'split');
    const before = candidateState(f);
    expect(await publishGitSyncCandidate(f.runGit, f.repo, request, pilotChecks))
      .toEqual({ status: 'error', error: 'candidate-publication-pin-mismatch' });
    expect(candidateState(f)).toEqual(before);
    expect(f.git('rev-parse', captured.ref + '-publication')).toBe(pin);
  });

  it('refuses changed publication inputs under the same captured generation', async () => {
    const f = fixture();
    writeFileSync(join(f.repo, 'a.txt'), 'A1\n');
    const request = { requestId: 'publish-inputs', generation: 1, base: f.git('rev-parse', 'HEAD'), paths: ['a.txt'] };
    expect(await captureGitSyncCandidate(f.runGit, f.repo, request)).toMatchObject({ ok: true });
    laterState(f, 'split');
    const before = candidateState(f);
    expect(await publishGitSyncCandidate(f.runGit, f.repo, { ...request, paths: ['b.txt'] }, pilotChecks))
      .toEqual({ status: 'error', error: 'source-custody-refused:candidate-input-mismatch' });
    expect(candidateState(f)).toEqual(before);
  });
});

describe('lifecycle P002 immutable candidate custody', () => {
  it.each(['staged', 'unstaged', 'split', 'deletion', 'executable', 'symlink', 'intent-to-add'] as const)(
    'captures A1 and replays it without changing a later %s shared index or B1', async state => {
      const f = fixture();
      const a1 = state === 'symlink' ? Buffer.from('A1-link-target') : Buffer.from([65, 49, 0, 255, 10]);
      writeFileSync(join(f.repo, 'a.txt'), a1);
      if (state === 'staged') f.git('add', '--', 'a.txt');
      if (state === 'split') {
        writeFileSync(join(f.repo, 'a.txt'), 'A0 staged\n'); f.git('add', '--', 'a.txt');
        writeFileSync(join(f.repo, 'a.txt'), a1);
      }
      if (state === 'deletion') f.git('rm', '--', 'b.txt');
      if (state === 'executable') { chmodSync(join(f.repo, 'a.txt'), 0o755); f.git('add', '--', 'a.txt'); }
      if (state === 'symlink') {
        rmSync(join(f.repo, 'a.txt')); symlinkSync(a1.toString(), join(f.repo, 'a.txt'));
        f.git('add', '--', 'a.txt');
      }
      if (state === 'intent-to-add') { writeFileSync(join(f.repo, 'new.txt'), 'A1 new\n'); f.git('add', '-N', '--', 'new.txt'); }
      const request = { requestId: 'operation-1', generation: 1, base: f.git('rev-parse', 'HEAD'),
        paths: state === 'intent-to-add' ? ['a.txt', 'new.txt'] : state === 'deletion' ? ['a.txt', 'b.txt'] : ['a.txt'] };
      const before = candidateState(f);
      const first = await captureGitSyncCandidate(f.runGit, f.repo, request);
      if (!first.ok) throw new Error(first.error);
      expect(candidateState(f)).toEqual(before);
      const payload = spawnSync('git', ['show', `${first.candidate.tree}:a.txt`], { cwd: f.repo });
      expect(payload.status).toBe(0);
      expect(payload.stdout).toEqual(a1);
      expect(f.git('ls-tree', first.candidate.tree, '--', 'a.txt')).toMatch(
        new RegExp('^' + (state === 'symlink' ? '120000' : state === 'executable' ? '100755' : '100644') + ' blob '));
      if (state === 'deletion') expect(f.git('ls-tree', first.candidate.tree, '--', 'b.txt')).toBe('');
      if (state === 'intent-to-add') expect(f.git('show', `${first.candidate.tree}:new.txt`)).toBe('A1 new');
      rmSync(join(f.repo, 'a.txt'), { force: true });
      writeFileSync(join(f.repo, 'a.txt'), 'B1 later source\n');
      if (state === 'staged' || state === 'split') f.git('add', '--', 'a.txt');
      if (state === 'split') writeFileSync(join(f.repo, 'a.txt'), 'B2 unstaged source\n');
      if (state === 'deletion') f.git('rm', '-f', '--', 'a.txt');
      if (state === 'executable') { chmodSync(join(f.repo, 'a.txt'), 0o755); f.git('add', '--', 'a.txt'); }
      if (state === 'symlink') {
        rmSync(join(f.repo, 'a.txt')); symlinkSync('B1-link-target', join(f.repo, 'a.txt'));
        f.git('add', '--', 'a.txt');
      }
      if (state === 'intent-to-add') {
        writeFileSync(join(f.repo, 'new.txt'), 'B1 intent to add\n'); f.git('add', '-N', '--', 'new.txt');
      }
      const later = candidateState(f);
      expect(await captureGitSyncCandidate(f.runGit, f.repo, request)).toEqual(first);
      expect(candidateState(f)).toEqual(later);
      expect(f.git('for-each-ref', '--format=%(refname)', SOURCE_CUSTODY_REF_PREFIX)).toBe(first.ref);
      expect(readdirSync(join(f.repo, '.git')).filter(path => path.startsWith('papercusp-git-sync-candidate-'))).toEqual([]);
    },
  );

  it('refuses a new unmerged candidate without changing index stages, working bytes or HEAD', async () => {
    const f = fixture();
    unmerge(f);
    const before = candidateState(f);
    expect(await captureGitSyncCandidate(f.runGit, f.repo, {
      requestId: 'unmerged', generation: 1, base: before.head, paths: ['a.txt'],
    })).toEqual({ ok: false, error: 'source-custody-refused:candidate-unmerged-index' });
    expect(candidateState(f)).toEqual(before);
    expect(f.git('for-each-ref', '--format=%(refname)', SOURCE_CUSTODY_REF_PREFIX)).toBe('');
  });

  it.each(['objects', 'ref'] as const)('recovers a stop after %s capture without recapturing B1', async point => {
    const f = fixture();
    writeFileSync(join(f.repo, 'a.txt'), 'A1\n');
    const request = { requestId: 'restart', generation: 1, base: f.git('rev-parse', 'HEAD'), paths: ['a.txt'] };
    const before = candidateState(f);
    let stopped = false;
    const stop: RunGit = async (args, cwd, options) => {
      const result = await f.runGit(args, cwd, options);
      if (!stopped && (point === 'objects' ? args[0] === 'write-tree' : args[0] === 'update-ref')) {
        stopped = true; throw new Error('injected stop');
      }
      return result;
    };
    expect((await captureGitSyncCandidate(stop, f.repo, request)).ok).toBe(false);
    expect(stopped).toBe(true);
    expect(candidateState(f)).toEqual(before);
    if (point === 'ref') writeFileSync(join(f.repo, 'a.txt'), 'B1\n');
    const later = candidateState(f);
    const recovered = await captureGitSyncCandidate(f.runGit, f.repo, request);
    if (!recovered.ok) throw new Error(recovered.error);
    expect(f.git('show', `${recovered.candidate.tree}:a.txt`)).toBe('A1');
    expect(candidateState(f)).toEqual(later);
  });

  it('refuses changed inputs under the same generation and accepts a new generation', async () => {
    const f = fixture();
    const request = { requestId: 'immutable', generation: 1, base: f.git('rev-parse', 'HEAD'), paths: ['a.txt'] };
    writeFileSync(join(f.repo, 'a.txt'), 'A1\n');
    expect(await captureGitSyncCandidate(f.runGit, f.repo, request)).toMatchObject({ ok: true });
    const before = candidateState(f);
    expect(await captureGitSyncCandidate(f.runGit, f.repo, { ...request, paths: ['b.txt'] }))
      .toEqual({ ok: false, error: 'source-custody-refused:candidate-input-mismatch' });
    expect(candidateState(f)).toEqual(before);
    expect(await captureGitSyncCandidate(f.runGit, f.repo, { ...request, generation: 2, paths: ['b.txt'] })).toMatchObject({ ok: true });
  });

  it.each(['assume-unchanged', 'skip-worktree'] as const)('captures working bytes beneath %s without changing shared flags', async flag => {
    const f = fixture();
    f.git('update-index', '--' + flag, '--', 'a.txt');
    writeFileSync(join(f.repo, 'a.txt'), 'A1 flagged\n');
    const before = candidateState(f);
    const result = await captureGitSyncCandidate(f.runGit, f.repo, {
      requestId: flag, generation: 1, base: before.head, paths: ['a.txt'],
    });
    if (!result.ok) throw new Error(result.error);
    expect(f.git('show', `${result.candidate.tree}:a.txt`)).toBe('A1 flagged');
    expect(candidateState(f)).toEqual(before);
  });

  it('retains an empty candidate tree when all tracked files are deleted', async () => {
    const f = fixture();
    f.git('rm', '--', 'a.txt', 'b.txt');
    const before = candidateState(f);
    const request = { requestId: 'empty', generation: 1, base: before.head, paths: ['a.txt', 'b.txt'] };
    const result = await captureGitSyncCandidate(f.runGit, f.repo, request);
    if (!result.ok) throw new Error(result.error);
    expect(f.git('ls-tree', result.candidate.tree)).toBe('');
    writeFileSync(join(f.repo, 'a.txt'), 'B1 new\n');
    const later = candidateState(f);
    expect(await captureGitSyncCandidate(f.runGit, f.repo, request)).toEqual(result);
    expect(candidateState(f)).toEqual(later);
  });

  it('captures an unborn repository without creating a shared index or branch commit', async () => {
    const f = fixture(true);
    writeFileSync(join(f.repo, 'a.txt'), 'A1 unborn\n');
    const before = candidateState(f);
    const result = await captureGitSyncCandidate(f.runGit, f.repo, {
      requestId: 'unborn', generation: 1, base: null, paths: ['a.txt'],
    });
    if (!result.ok) throw new Error(result.error);
    expect(f.git('show', `${result.candidate.tree}:a.txt`)).toBe('A1 unborn');
    expect(f.git('ls-tree', result.candidate.tree, '--', 'b.txt')).toBe('');
    expect(candidateState(f)).toEqual(before);
  });

  it('replays acknowledged A1 after the later shared index becomes unmerged', async () => {
    const f = fixture();
    writeFileSync(join(f.repo, 'a.txt'), 'A1\n');
    const request = { requestId: 'acknowledged', generation: 1, base: f.git('rev-parse', 'HEAD'), paths: ['a.txt'] };
    const first = await captureGitSyncCandidate(f.runGit, f.repo, request);
    if (!first.ok) throw new Error(first.error);
    unmerge(f);
    writeFileSync(join(f.repo, 'a.txt'), 'B1 conflict\n');
    const later = candidateState(f);
    expect(await captureGitSyncCandidate(f.runGit, f.repo, request)).toEqual(first);
    expect(candidateState(f)).toEqual(later);
  });

  it.each(['clean-filter', 'crlf', 'ident'] as const)('refuses %s conversion instead of acknowledging altered working bytes', async conversion => {
    const f = fixture();
    const raw = conversion === 'crlf' ? 'A1\r\n' : conversion === 'ident' ? '$Id: expanded-value $\n' : 'A1 lowercase\n';
    if (conversion === 'clean-filter') {
      writeFileSync(join(f.repo, '.gitattributes'), 'a.txt filter=fixture\n');
      f.git('config', 'filter.fixture.clean', 'tr a-z A-Z');
    } else if (conversion === 'crlf') {
      f.git('config', 'core.autocrlf', 'true');
    } else {
      writeFileSync(join(f.repo, '.gitattributes'), 'a.txt ident\n');
    }
    writeFileSync(join(f.repo, 'a.txt'), raw);
    // Calibrate against real Git: this fixture actually changes blob bytes.
    const normalized = f.git('hash-object', '-w', '--path=a.txt', '--', 'a.txt');
    const blob = spawnSync('git', ['cat-file', 'blob', normalized], { cwd: f.repo });
    expect(blob.status).toBe(0);
    expect(blob.stdout).not.toEqual(Buffer.from(raw));
    const before = candidateState(f);
    expect(await captureGitSyncCandidate(f.runGit, f.repo, {
      requestId: conversion, generation: 1, base: before.head, paths: ['a.txt'],
    })).toEqual({ ok: false, error: 'source-custody-refused:candidate-working-transform-unsupported' });
    expect(candidateState(f)).toEqual(before);
    expect(f.git('for-each-ref', '--format=%(refname)', SOURCE_CUSTODY_REF_PREFIX)).toBe('');
  });
});
