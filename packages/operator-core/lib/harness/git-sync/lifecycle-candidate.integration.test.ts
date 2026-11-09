/** Real-Git capture and frozen-publication contracts in the maintained integration router. */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureGitSyncCandidate, readGitSyncCandidate, publishGitSyncCandidate, prepareGeneratedGitSyncCandidateTree, prepareGitSyncMetadataRepair,
  SOURCE_CUSTODY_REF_PREFIX, type RunGit, type GitSyncGeneratedLockTreeRequest } from './run-git-sync';
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

describe('P003 generated custody', () => {
  async function generatedCustodyFixture(configure?: (f: ReturnType<typeof fixture>) => void) {
    const f = fixture();
    const manifest = { name: 'closed-generated-custody', version: '1.0.0', workspaces: ['packages/*'],
      dependencies: { target: 'file:./target' } };
    mkdirSync(join(f.repo, 'target'));
    mkdirSync(join(f.repo, 'packages/one'), { recursive: true });
    writeFileSync(join(f.repo, 'target/package.json'), '{"name":"target","version":"1.0.0"}');
    writeFileSync(join(f.repo, 'packages/one/package.json'), '{"name":"one","version":"1.0.0"}');
    writeFileSync(join(f.repo, 'package.json'), JSON.stringify(manifest));
    writeFileSync(join(f.repo, 'package-lock.json'), JSON.stringify({ name: manifest.name, version: manifest.version,
      lockfileVersion: 3, packages: { '': manifest } }));
    writeFileSync(join(f.repo, '.npmrc'), 'legacy-peer-deps=false\n');
    configure?.(f);
    f.git('add', '-A');
    f.git('commit', '-m', 'selected resolver population');
    // Pending lock and unrelated staged source belong to the original caller.
    writeFileSync(join(f.repo, 'a.txt'), 'unrelated pre-staged source\n');
    f.git('add', '--', 'a.txt');
    writeFileSync(join(f.repo, 'package-lock.json'), '{"pending":"different raw bytes"}\n');
    const base = f.git('rev-parse', 'HEAD');
    const contentSource = await prepareGitSyncMetadataRepair(f.runGit, f.repo,
      { requestId: 'closed-repair', generation: 1, base }, { log: () => {} });
    return { ...f, request: { requestId: 'closed-repair', generation: 1, base,
      paths: ['package-lock.json'], contentSource } };
  }

  it('refuses the caller pending-lock mismatch before npm without changing raw work or the shared index', async () => {
    const f = await generatedCustodyFixture();
    const index = readFileSync(join(f.repo, '.git/index'));
    const pending = readFileSync(join(f.repo, 'package-lock.json'));
    const launched: string[] = [];
    await expect(prepareGitSyncMetadataRepair(f.runGit, f.repo,
      { requestId: 'stale-pending-request', generation: 1, base: f.request.base },
      { expectedPendingLockSha256: 'f'.repeat(64), log: line => launched.push(line) }))
      .rejects.toThrow('generated-lock-request-pending-mismatch');
    expect(launched).toEqual([]);
    expect(readFileSync(join(f.repo, '.git/index'))).toEqual(index);
    expect(readFileSync(join(f.repo, 'package-lock.json'))).toEqual(pending);
    expect(f.git('rev-parse', 'HEAD')).toBe(f.request.base);
    expect(f.git('for-each-ref', '--format=%(refname)', SOURCE_CUSTODY_REF_PREFIX)).toBe('');
  }, 90_000);

  it('refuses unrelated generated graph churn even with self-consistent blob and resolver digests', async () => {
    const f = await generatedCustodyFixture();
    const state = candidateState(f);
    // Real npm commonly omits a directory target's redundant name; identity is
    // bound to its exact selected manifest/path, not an invented lock field.
    const actual = JSON.parse(Buffer.from(f.request.contentSource.bytes).toString());
    expect(actual.packages.target.version).toBe('1.0.0');
    const contentSource = structuredClone(f.request.contentSource);
    const lock = JSON.parse(Buffer.from(contentSource.bytes).toString());
    lock.packages['node_modules/unrelated-injected'] = { version: '9.0.0' };
    const bytes = Buffer.from(JSON.stringify(lock));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const blobOid = createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
    const registry = Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b)).map(([path, value]) => {
      const entry = value as { resolved?: string; integrity?: string };
      return { path, resolved: entry.resolved ?? null, integrity: entry.integrity ?? null };
    });
    contentSource.bytes = bytes;
    Object.assign(contentSource.fingerprint.output, { sha256, blobOid, registry });
    Object.assign(contentSource.fingerprint.output.resolution.output, { sha256, registry });
    const refused = await captureGitSyncCandidate(f.runGit, f.repo, { ...f.request, contentSource }, pilotChecks);
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining('generated-lock-graph:') });
    expect(f.git('for-each-ref', '--format=%(refname)', SOURCE_CUSTODY_REF_PREFIX)).toBe('');
    expect(candidateState(f)).toEqual(state);
    expect(await captureGitSyncCandidate(f.runGit, f.repo, f.request, pilotChecks)).toMatchObject({ ok: true });
  }, 90_000);

  it.each([{ mask: 0o077, outputMode: 0o600 }, { mask: 0o002, outputMode: 0o664 }])(
    'retains the complete independently expected input population and generated lock bytes with umask $mask', async ({ mask, outputMode }) => {
    const umask = process.umask(mask);
    let f: Awaited<ReturnType<typeof generatedCustodyFixture>>;
    try { f = await generatedCustodyFixture(); } finally { process.umask(umask); }
    const source = f.request.contentSource;
    expect(source.fingerprint.output.resolution.output.mode).toBe(outputMode);
    expect(Object.keys(source.fingerprint).sort()).toEqual(['baseCommit', 'baseTree', 'command', 'environment', 'generation',
      'output', 'projectConfig', 'repositoryRealpath', 'requestId', 'runtime', 'schemaVersion', 'selectedInputs']);
    // This oracle is enumerated from the fixture, without asking the builder.
    const expected = ['.npmrc', 'npm-shrinkwrap.json', 'package-lock.json', 'package.json',
      'packages/one/.npmrc', 'packages/one/package.json', 'target/.npmrc', 'target/package.json'].sort();
    expect(source.fingerprint.selectedInputs.map(row => row.path)).toEqual(expected);
    for (const row of source.fingerprint.selectedInputs) {
      const expectedObject = spawnSync('git', ['rev-parse', '--verify', `${f.request.base}:${row.path}`],
        { cwd: f.repo, encoding: 'utf8', timeout: 30_000 });
      if (expectedObject.status === 0) {
        expect(row).toMatchObject({ kind: 'blob', oid: expectedObject.stdout.trim(), owner: '',
          selectedOid: f.request.base, mode: '100644' });
        const raw = spawnSync('git', ['cat-file', 'blob', row.oid!], { cwd: f.repo, timeout: 30_000 });
        expect(row.sha256).toBe(createHash('sha256').update(raw.stdout).digest('hex'));
      } else expect(row).toMatchObject({ kind: 'absent', mode: null, oid: null, sha256: null });
    }
    expect(Object.keys(source.fingerprint.environment).sort()).toEqual(['HOME', 'LANG', 'PATH', 'TMPDIR', 'TZ']);
    expect(source.fingerprint.output.resolution.cache).toMatchObject({ emptyBeforeLaunch: true,
      attemptId: source.fingerprint.output.resolution.attemptId });
    const index = readFileSync(join(f.repo, '.git/index'));
    const pending = readFileSync(join(f.repo, 'package-lock.json'));
    const captured = await captureGitSyncCandidate(f.runGit, f.repo, f.request, pilotChecks);
    if (!captured.ok) throw new Error(captured.error);
    expect(captured.candidate.version).toBe(3);
    expect(f.git('diff-tree', '--no-commit-id', '--name-only', '-r', f.request.base, captured.candidate.tree)).toBe('package-lock.json');
    expect(f.git('show', `${captured.candidate.tree}:a.txt`)).toBe('baseline a');
    expect(f.git('show', `${captured.candidate.tree}:package-lock.json`)).toBe(source.bytes.toString().trim());
    expect(await readGitSyncCandidate(f.runGit, f.repo, { requestId: f.request.requestId, generation: 1 })).toEqual(captured);
    expect(readFileSync(join(f.repo, '.git/index'))).toEqual(index);
    expect(readFileSync(join(f.repo, 'package-lock.json'))).toEqual(pending);
    expect(readdirSync(join(f.repo, '.git')).filter(name => name.startsWith('papercusp-'))).toEqual([]);
  }, 90_000);

  for (const stop of ['before-capture', 'after-capture', 'before-CAS', 'after-CAS'] as const) {
    it(`recovers an interruption ${stop} with exact retained objects and owned cleanup`, async () => {
      const f = await generatedCustodyFixture();
      const index = readFileSync(join(f.repo, '.git/index'));
      const pending = readFileSync(join(f.repo, 'package-lock.json'));
      if (stop === 'before-capture') {
        expect(await captureGitSyncCandidate(f.runGit, f.repo, f.request,
          { assertHeld: () => { throw new Error('stop before capture'); } })).toMatchObject({ ok: false });
        expect(f.git('for-each-ref', '--format=%(refname)', SOURCE_CUSTODY_REF_PREFIX)).toBe('');
      }
      const capture = await captureGitSyncCandidate(f.runGit, f.repo, f.request, pilotChecks);
      if (!capture.ok) throw new Error(capture.error);
      if (stop === 'before-CAS') {
        let held = true;
        expect(await publishGitSyncCandidate(f.runGit, f.repo, f.request, {
          assertHeld: () => { if (!held) throw new Error('lease lost in beforePublish'); },
          beforePublish: async () => { held = false; return { ok: true }; },
        })).toMatchObject({ status: 'error' });
        expect(f.git('rev-parse', 'HEAD')).toBe(f.request.base);
      }
      let lostReceipt = false;
      const runner: RunGit = async (args, cwd, options) => {
        const result = await f.runGit(args, cwd, options);
        if (stop === 'after-CAS' && args[0] === 'update-ref' && args.includes('HEAD') && result.code === 0) {
          lostReceipt = true;
          throw new Error('stop after successful CAS');
        }
        return result;
      };
      const published = await publishGitSyncCandidate(runner, f.repo, f.request, pilotChecks);
      expect(published.status, JSON.stringify(published)).toBe(stop === 'after-CAS' ? 'error' : 'committed');
      expect(lostReceipt).toBe(stop === 'after-CAS');
      const replay = await publishGitSyncCandidate(f.runGit, f.repo, f.request, pilotChecks);
      expect(replay).toMatchObject({ status: 'already-published', tree: capture.candidate.tree,
        commit: f.git('rev-parse', 'HEAD') });
      expect(readFileSync(join(f.repo, '.git/index'))).toEqual(index);
      expect(readFileSync(join(f.repo, 'package-lock.json'))).toEqual(pending);
      expect(readdirSync(join(f.repo, '.git')).filter(name => name.startsWith('papercusp-'))).toEqual([]);
    }, 90_000);
  }

  it('publishes through the existing CAS and replays after later HEAD without touching pending/index bytes', async () => {
    const f = await generatedCustodyFixture();
    const index = readFileSync(join(f.repo, '.git/index'));
    const pending = readFileSync(join(f.repo, 'package-lock.json'));
    expect(await captureGitSyncCandidate(f.runGit, f.repo, f.request, pilotChecks)).toMatchObject({ ok: true });
    const retained = await readGitSyncCandidate(f.runGit, f.repo, f.request);
    if (!retained.ok) throw new Error(retained.error);
    const identity = retained.candidate.contentSource!.fingerprint;
    const environment = identity.environment;
    const digest = (env: Record<string, string>) => createHash('sha256').update(JSON.stringify({
      node: identity.command.executable, argv: identity.command.argv, cwd: identity.command.cwd, env,
    })).digest('hex');
    // Independent launch oracle: canonical custody reorders the keys but may
    // not change the fixed launch values or invalidate the original receipt.
    expect(Object.keys(environment)).toEqual(['HOME', 'LANG', 'PATH', 'TMPDIR', 'TZ']);
    expect(digest(environment)).not.toBe(identity.output.resolution.cache.launchSha256);
    expect(digest({ HOME: environment.HOME, TMPDIR: environment.TMPDIR, PATH: environment.PATH,
      LANG: environment.LANG, TZ: environment.TZ })).toBe(identity.output.resolution.cache.launchSha256);
    const published = await publishGitSyncCandidate(f.runGit, f.repo, f.request, pilotChecks);
    expect(published, JSON.stringify(published)).toMatchObject({ status: 'committed' });
    if (published.status !== 'committed') throw new Error(JSON.stringify(published));
    const later = f.git('commit-tree', published.tree, '-p', published.commit, '-m', 'unrelated later HEAD');
    f.git('update-ref', 'HEAD', later, published.commit);
    expect(await publishGitSyncCandidate(f.runGit, f.repo, f.request, pilotChecks)).toEqual({
      status: 'already-published', commit: published.commit, tree: published.tree,
    });
    expect(f.git('rev-parse', 'HEAD')).toBe(later);
    expect(readFileSync(join(f.repo, '.git/index'))).toEqual(index);
    expect(readFileSync(join(f.repo, 'package-lock.json'))).toEqual(pending);
  }, 90_000);

  it.each(['callback-pending', 'final-tree-pending', 'post-validation-lease'] as const)(
    'rechecks generated authority and raw custody at %s before HEAD dispatch', async point => {
      const f = await generatedCustodyFixture();
      const capture = await captureGitSyncCandidate(f.runGit, f.repo, f.request, pilotChecks);
      if (!capture.ok) throw new Error(capture.error);
      const index = readFileSync(join(f.repo, '.git/index'));
      const pending = readFileSync(join(f.repo, 'package-lock.json'));
      let callbackFinished = false;
      let pinned = false;
      let held = true;
      let triggered = false;
      let headWrites = 0;
      const runner: RunGit = async (args, cwd, options) => {
        if (args[0] === 'update-ref' && args.includes('HEAD')) headWrites++;
        const result = await f.runGit(args, cwd, options);
        if (args[0] === 'update-ref' && args[1]!.endsWith('-publication') && result.code === 0) pinned = true;
        if (point === 'final-tree-pending' && callbackFinished && pinned && args[0] === 'write-tree') {
          triggered = true;
          writeFileSync(join(f.repo, 'package-lock.json'), 'pending moved after callback');
        }
        if (point === 'post-validation-lease' && pinned && args[0] === 'rev-parse' && args[1] === '--shared-index-path') {
          triggered = true;
          held = false;
        }
        return result;
      };
      const result = await publishGitSyncCandidate(runner, f.repo, f.request, {
        assertHeld: () => { if (!held) throw new Error('lease lost after generated validation'); },
        beforePublish: async () => {
          callbackFinished = true;
          if (point === 'callback-pending') {
            triggered = true;
            writeFileSync(join(f.repo, 'package-lock.json'), 'pending moved in callback');
          }
          return { ok: true };
        },
      });
      expect(triggered, JSON.stringify(result)).toBe(true);
      expect(result.status).toBe('error');
      expect(headWrites).toBe(0);
      expect(f.git('rev-parse', 'HEAD')).toBe(f.request.base);
      expect(readFileSync(join(f.repo, '.git/index'))).toEqual(index);
      expect(readFileSync(join(f.repo, 'package-lock.json'))).toEqual(point === 'post-validation-lease'
        ? pending : Buffer.from(point === 'callback-pending' ? 'pending moved in callback' : 'pending moved after callback'));
      expect(await readGitSyncCandidate(f.runGit, f.repo, f.request)).toEqual(capture);
      expect(readdirSync(join(f.repo, '.git')).filter(name => name.startsWith('papercusp-'))).toEqual([]);
    }, 90_000);

  for (const control of ['pending-lock', 'pending-manifest', 'pending-config', 'shared-index', 'new-workspace', 'base', 'lease', 'output'] as const) {
    it(`refuses changed ${control} after capture without publication`, async () => {
      const f = await generatedCustodyFixture();
      expect(await captureGitSyncCandidate(f.runGit, f.repo, f.request, pilotChecks)).toMatchObject({ ok: true });
      const beforeHead = f.git('rev-parse', 'HEAD');
      const beforeRefs = f.git('for-each-ref', '--format=%(refname) %(objectname)', SOURCE_CUSTODY_REF_PREFIX);
      if (control === 'pending-lock') writeFileSync(join(f.repo, 'package-lock.json'), 'new pending lock');
      if (control === 'pending-manifest') writeFileSync(join(f.repo, 'target/package.json'), '{"name":"moved"}');
      if (control === 'pending-config') writeFileSync(join(f.repo, 'target/.npmrc'), 'strict-peer-deps=true\n');
      if (control === 'shared-index') { writeFileSync(join(f.repo, 'b.txt'), 'later staged'); f.git('add', '--', 'b.txt'); }
      if (control === 'new-workspace') {
        mkdirSync(join(f.repo, 'packages/two'));
        writeFileSync(join(f.repo, 'packages/two/package.json'), '{"name":"new","version":"1.0.0"}');
      }
      if (control === 'base') f.git('update-ref', 'HEAD', f.git('commit-tree', f.git('rev-parse', 'HEAD^{tree}'), '-p', beforeHead, '-m', 'later'));
      if (control === 'output') f.request.contentSource.bytes.fill(0);
      const state = candidateState(f);
      const result = await publishGitSyncCandidate(f.runGit, f.repo, f.request, control === 'lease'
        ? { ...pilotChecks, assertHeld: () => { throw new Error('lost lease'); } } : pilotChecks);
      expect(['error', 'cas-refused']).toContain(result.status);
      expect(candidateState(f)).toEqual(state);
      expect(f.git('for-each-ref', '--format=%(refname) %(objectname)', SOURCE_CUSTODY_REF_PREFIX)).toBe(beforeRefs);
    }, 90_000);
  }

  it('rejects missing, unknown, duplicated and altered fingerprint members under one generation', async () => {
    const f = await generatedCustodyFixture();
    const mutations: Array<(value: any) => void> = [];
    for (const key of Object.keys(f.request.contentSource.fingerprint)) mutations.push(value => { delete value.fingerprint[key]; });
    for (const section of ['command', 'runtime', 'environment', 'output']) {
      for (const key of Object.keys((f.request.contentSource.fingerprint as any)[section])) {
        mutations.push(value => { delete value.fingerprint[section][key]; });
      }
    }
    mutations.push(value => { value.fingerprint.extra = 'unrecorded input'; },
      value => { value.fingerprint.environment.NODE_OPTIONS = '--require=other'; },
      value => { value.fingerprint.selectedInputs.push(value.fingerprint.selectedInputs[0]); },
      value => { value.fingerprint.projectConfig[0].values['ignore-scripts'] = 'false'; },
      value => { value.fingerprint.command.argv.push('--force'); },
      value => { value.fingerprint.runtime.resolution.libc.version = 'different'; },
      ...[0, 0o755, 0o1000].map(mode => (value: any) => { value.fingerprint.output.resolution.output.mode = mode; }),
      value => { value.fingerprint.output.resolution.cache.launchSha256 = '0'.repeat(64); },
      value => { value.fingerprint.output.resolution.cache.emptyBeforeLaunch = false; });
    for (const key of ['registry', 'legacy-peer-deps', 'strict-peer-deps', 'install-links', 'engine-strict']) {
      mutations.push(value => {
        const config = value.fingerprint.projectConfig.find((row: any) => row.path === '.npmrc');
        config.values[key] = key === 'registry' ? 'https://registry.npmjs.org/' : 'true';
        value.fingerprint.output.resolution.projectConfig = structuredClone(value.fingerprint.projectConfig);
      });
    }
    const state = candidateState(f);
    for (const mutate of mutations) {
      const contentSource = structuredClone(f.request.contentSource);
      mutate(contentSource);
      expect(await captureGitSyncCandidate(f.runGit, f.repo, { ...f.request, contentSource }, pilotChecks)).toMatchObject({ ok: false });
      expect(f.git('for-each-ref', '--format=%(refname)', SOURCE_CUSTODY_REF_PREFIX)).toBe('');
    }
    expect(candidateState(f)).toEqual(state);
    // A pre-existing capture would refuse every mutation as an identity clash,
    // concealing missing validation. Retain the positive only after the controls.
    expect(await captureGitSyncCandidate(f.runGit, f.repo, f.request, pilotChecks)).toMatchObject({ ok: true });
  }, 90_000);

  it('independently binds nested selected pins, config and local archive bytes while preserving newer checkouts', async () => {
    const child = fixture();
    const nested = fixture();
    writeFileSync(join(nested.repo, 'package.json'), '{"name":"nested-pin","version":"1.0.0"}');
    writeFileSync(join(nested.repo, '.npmrc'), 'engine-strict=false\n');
    nested.git('add', '-A'); nested.git('commit', '-m', 'selected nested metadata');
    const nestedOid = nested.git('rev-parse', 'HEAD');
    writeFileSync(join(child.repo, 'package.json'), '{"name":"child-pin","version":"1.0.0"}');
    writeFileSync(join(child.repo, '.npmrc'), 'strict-peer-deps=false\n');
    child.git('-c', 'protocol.file.allow=always', 'submodule', 'add', nested.repo, 'nested');
    child.git('add', '-A'); child.git('commit', '-m', 'selected child metadata');
    const childOid = child.git('rev-parse', 'HEAD');
    const f = await generatedCustodyFixture(f => {
      f.git('-c', 'protocol.file.allow=always', 'submodule', 'add', child.repo, 'libs/child');
      f.git('-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive');
      const manifest = JSON.parse(readFileSync(join(f.repo, 'package.json'), 'utf8'));
      manifest.workspaces.push('libs/child', 'libs/child/nested');
      manifest.dependencies['archive-pin'] = 'file:./archive.tgz';
      writeFileSync(join(f.repo, 'package.json'), JSON.stringify(manifest));
      const archiveRoot = mkdtempSync(join(tmpdir(), 'git-sync-archive-')); roots.push(archiveRoot);
      mkdirSync(join(archiveRoot, 'package'));
      writeFileSync(join(archiveRoot, 'package/package.json'), '{"name":"archive-pin","version":"1.0.0"}');
      const tar = spawnSync('tar', ['-czf', join(f.repo, 'archive.tgz'), '-C', archiveRoot, 'package'], { timeout: 30_000 });
      expect(tar.status).toBe(0);
    });
    const expected = ['.gitmodules', '.npmrc', 'archive.tgz', 'npm-shrinkwrap.json', 'package-lock.json', 'package.json',
      'packages/one/.npmrc', 'packages/one/package.json', 'target/.npmrc', 'target/package.json',
      'libs/child', 'libs/child/.gitmodules', 'libs/child/.npmrc', 'libs/child/package.json',
      'libs/child/nested', 'libs/child/nested/.npmrc', 'libs/child/nested/package.json'].sort();
    const vector = f.request.contentSource.fingerprint.selectedInputs;
    expect(vector.map(row => row.path)).toEqual(expected);
    const at = (path: string) => vector.find(row => row.path === path)!;
    expect(at('libs/child')).toMatchObject({ kind: 'gitlink', oid: childOid, owner: '', selectedOid: f.request.base, mode: '160000' });
    expect(at('libs/child/nested')).toMatchObject({ kind: 'gitlink', oid: nestedOid, owner: 'libs/child', selectedOid: childOid, mode: '160000' });
    for (const path of ['.gitmodules', 'archive.tgz', 'libs/child/.gitmodules', 'libs/child/.npmrc',
      'libs/child/package.json', 'libs/child/nested/.npmrc', 'libs/child/nested/package.json']) {
      const owner = path.startsWith('libs/child/nested/') ? 'libs/child/nested' : path.startsWith('libs/child/') ? 'libs/child' : '';
      const oid = owner === 'libs/child/nested' ? nestedOid : owner === 'libs/child' ? childOid : f.request.base;
      const relative = owner ? path.slice(owner.length + 1) : path;
      const raw = spawnSync('git', ['show', `${oid}:${relative}`], { cwd: join(f.repo, owner), timeout: 30_000 });
      expect(raw.status).toBe(0);
      const blob = spawnSync('git', ['rev-parse', `${oid}:${relative}`], { cwd: join(f.repo, owner), encoding: 'utf8' });
      expect(at(path)).toMatchObject({ kind: 'blob', owner, selectedOid: oid, mode: '100644',
        oid: blob.stdout.trim(), sha256: createHash('sha256').update(raw.stdout).digest('hex') });
    }
    const capture = await captureGitSyncCandidate(f.runGit, f.repo, f.request, pilotChecks);
    if (!capture.ok) throw new Error(capture.error);
    const refs = f.git('for-each-ref', '--format=%(refname) %(objectname)', SOURCE_CUSTODY_REF_PREFIX);
    // New checkout bytes are custody predicates, never substitutes for selected pins.
    for (const path of ['libs/child/nested/package.json', 'libs/child/.npmrc', 'archive.tgz']) {
      const absolute = join(f.repo, path);
      const before = readFileSync(absolute);
      writeFileSync(absolute, path.endsWith('package.json') ? '{"name":"nested-pin","version":"2.0.0"}' : 'changed pending input');
      const pending = readFileSync(absolute);
      expect(await publishGitSyncCandidate(f.runGit, f.repo, f.request, pilotChecks)).toMatchObject({ status: 'error' });
      expect(readFileSync(absolute)).toEqual(pending);
      expect(f.git('for-each-ref', '--format=%(refname) %(objectname)', SOURCE_CUSTODY_REF_PREFIX)).toBe(refs);
      writeFileSync(absolute, before);
    }
    expect(f.git('rev-parse', 'HEAD:libs/child')).toBe(childOid);
    expect(f.git('rev-parse', 'HEAD')).toBe(f.request.base);
  }, 90_000);
});

describe('P003 generated lock tree preparation', () => {
  function generatedFixture(path: 'package-lock.json' | 'npm-shrinkwrap.json' = 'package-lock.json') {
    const f = fixture();
    const manifest = { name: 'generated-fixture', version: '1.0.0' };
    const lock = { ...manifest, lockfileVersion: 3, packages: { '': manifest } };
    writeFileSync(join(f.repo, 'package.json'), JSON.stringify(manifest));
    writeFileSync(join(f.repo, path), JSON.stringify(lock));
    f.git('add', '--', 'package.json', path);
    f.git('commit', '-m', 'selected metadata');
    const base = f.git('rev-parse', 'HEAD');
    const bytes = Buffer.from(JSON.stringify({ ...lock, requires: true }));
    // Independent raw Git oracle; do not obtain the expected blob from the
    // implementation or through its private-index runner.
    const blob = spawnSync('git', ['hash-object', '--no-filters', '--stdin'], {
      cwd: f.repo, input: bytes, encoding: 'utf8', timeout: 30_000,
    });
    expect(blob.status).toBe(0);
    const request: GitSyncGeneratedLockTreeRequest = { base, path, bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'), blobOid: blob.stdout.trim() };
    return { ...f, request };
  }

  for (const path of ['package-lock.json', 'npm-shrinkwrap.json'] as const) {
    it(`admits only generated ${path} from the base and preserves raw pending/index bytes`, async () => {
      const f = generatedFixture(path);
      writeFileSync(join(f.repo, 'a.txt'), 'unrelated staged source\n');
      f.git('add', '--', 'a.txt');
      writeFileSync(join(f.repo, path), 'pending lock differs from generated output\n');
      const index = readFileSync(join(f.repo, '.git/index'));
      const pending = readFileSync(join(f.repo, path));
      const result = await prepareGeneratedGitSyncCandidateTree(f.runGit, f.repo, f.request);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error);
      expect(f.git('diff-tree', '--no-commit-id', '--name-only', '-r', f.request.base, result.tree)).toBe(path);
      expect(f.git('show', `${result.tree}:a.txt`)).toBe('baseline a');
      expect(f.git('show', `${result.tree}:${path}`)).toBe(f.request.bytes.toString());
      expect(result).toMatchObject({ mode: '100644', blobOid: f.request.blobOid, sha256: f.request.sha256 });
      expect(readFileSync(join(f.repo, '.git/index'))).toEqual(index);
      expect(readFileSync(join(f.repo, path))).toEqual(pending);
      expect(f.git('rev-parse', 'HEAD')).toBe(f.request.base);
      expect(f.git('for-each-ref', '--format=%(refname)', SOURCE_CUSTODY_REF_PREFIX)).toBe('');
      expect(readdirSync(join(f.repo, '.git')).filter(name => name.startsWith('papercusp-'))).toEqual([]);
    });
  }

  it('owns descriptor identity and raw output bytes before the first asynchronous Git read', async () => {
    const f = generatedFixture();
    const expected = { ...f.request, bytes: Buffer.from(f.request.bytes) };
    let mutated = false;
    const runner: RunGit = async (args, cwd, options) => {
      if (!mutated) {
        mutated = true;
        f.request.path = 'npm-shrinkwrap.json';
        f.request.sha256 = '0'.repeat(64);
        f.request.blobOid = '0'.repeat(40);
        f.request.bytes.fill(0);
      }
      return f.runGit(args, cwd, options);
    };
    const result = await prepareGeneratedGitSyncCandidateTree(runner, f.repo, f.request);
    expect(result).toMatchObject({ ok: true, path: expected.path, sha256: expected.sha256, blobOid: expected.blobOid });
    if (!result.ok) throw new Error(result.error);
    expect(f.git('show', `${result.tree}:${expected.path}`)).toBe(expected.bytes.toString());
  });

  for (const control of ['digest', 'blob', 'path', 'base', 'unchanged', 'unmerged', 'symlink', 'transform', 'invalid-metadata', 'wrong-index-runner'] as const) {
    it(`refuses ${control} without changing pending source, index or HEAD`, async () => {
      const f = generatedFixture();
      const request = { ...f.request };
      let runner = f.runGit;
      if (control === 'digest') request.sha256 = '0'.repeat(64);
      if (control === 'blob') request.blobOid = '0'.repeat(40);
      if (control === 'path') {
        writeFileSync(join(f.repo, 'npm-shrinkwrap.json'), f.request.bytes);
        f.git('add', '--', 'npm-shrinkwrap.json');
        f.git('commit', '-m', 'effective shrinkwrap');
        request.base = f.git('rev-parse', 'HEAD');
      }
      if (control === 'base') request.base = f.git('rev-parse', 'HEAD^{tree}');
      if (control === 'unmerged') unmerge(f);
      if (control === 'symlink') {
        rmSync(join(f.repo, request.path));
        symlinkSync('a.txt', join(f.repo, request.path));
        f.git('add', '--', request.path);
        f.git('commit', '-m', 'unsupported selected mode');
        request.base = f.git('rev-parse', 'HEAD');
      }
      if (control === 'transform') {
        writeFileSync(join(f.repo, '.gitattributes'), 'package-lock.json text\n');
        f.git('add', '--', '.gitattributes');
        f.git('commit', '-m', 'selected transformation');
        request.base = f.git('rev-parse', 'HEAD');
      }
      if (control === 'unchanged' || control === 'invalid-metadata') {
        request.bytes = control === 'unchanged' ? readFileSync(join(f.repo, request.path)) : Buffer.from('{bad json');
        request.sha256 = createHash('sha256').update(request.bytes).digest('hex');
        request.blobOid = spawnSync('git', ['hash-object', '--no-filters', '--stdin'], {
          cwd: f.repo, input: request.bytes, encoding: 'utf8', timeout: 30_000,
        }).stdout.trim();
      }
      if (control === 'wrong-index-runner') runner = (args, cwd) => f.runGit(args, cwd);
      const before = candidateState(f);
      const lock = readFileSync(join(f.repo, request.path));
      expect(await prepareGeneratedGitSyncCandidateTree(runner, f.repo, request)).toMatchObject({ ok: false });
      expect(candidateState(f)).toEqual(before);
      expect(readFileSync(join(f.repo, request.path))).toEqual(lock);
      expect(f.git('for-each-ref', '--format=%(refname)', SOURCE_CUSTODY_REF_PREFIX)).toBe('');
    });
  }
});

describe('lifecycle P004 capture recovery', () => {
  it('pins dependency edges in custody and refuses changed ancestry under the same generation', async () => {
    const f = fixture();
    const dependency = { requestId: 'A1', generation: 1, paths: ['a.txt'], tree: 'a'.repeat(40) };
    const request = { requestId: 'B1', generation: 1, paths: ['a.txt'], base: f.git('rev-parse', 'HEAD'),
      dependencies: [dependency] };
    const captured = await captureGitSyncCandidate(f.runGit, f.repo, request);
    if (!captured.ok) throw new Error(captured.error);
    const before = candidateState(f);
    expect(await readGitSyncCandidate(f.runGit, f.repo, { requestId: 'B1', generation: 1 })).toEqual(captured);
    expect(await captureGitSyncCandidate(f.runGit, f.repo, { ...request, dependencies: [{ ...dependency, tree: 'b'.repeat(40) }] }))
      .toEqual({ ok: false, error: 'source-custody-refused:candidate-input-mismatch' });
    expect(await captureGitSyncCandidate(f.runGit, f.repo, { ...request, dependencies: [] }))
      .toEqual({ ok: false, error: 'source-custody-refused:candidate-input-mismatch' });
    expect(candidateState(f)).toEqual(before);
  });

  it('recovers the original pinned generation after a receipt loss and moving HEAD', async () => {
    const f = fixture();
    writeFileSync(join(f.repo, 'a.txt'), 'A1 preserved\n');
    const request = { requestId: 'lost-db-receipt', generation: 1, base: f.git('rev-parse', 'HEAD'), paths: ['a.txt'] };
    const captured = await captureGitSyncCandidate(f.runGit, f.repo, request);
    if (!captured.ok) throw new Error(captured.error);
    const laterCommit = f.git('commit-tree', captured.candidate.baseTree, '-p', request.base, '-m', 'unrelated advance');
    f.git('update-ref', 'HEAD', laterCommit, request.base);
    laterState(f, 'split');
    const before = candidateState(f);
    expect(await readGitSyncCandidate(f.runGit, f.repo, request)).toEqual(captured);
    expect(candidateState(f)).toEqual(before);
    expect(f.git('show', `${captured.ref}:payload/a.txt`)).toBe('A1 preserved');
    expect(await readGitSyncCandidate(f.runGit, f.repo, { ...request, paths: ['b.txt'] }))
      .toEqual({ ok: false, error: 'source-custody-refused:candidate-input-mismatch' });
  });

  it('never recreates an absent acknowledged capture from successor bytes', async () => {
    const f = fixture();
    writeFileSync(join(f.repo, 'a.txt'), 'B1 successor\n');
    const before = candidateState(f);
    expect(await readGitSyncCandidate(f.runGit, f.repo, { requestId: 'absent', generation: 1, paths: ['a.txt'] }))
      .toEqual({ ok: false, error: 'source-custody-refused:candidate-not-captured' });
    expect(f.git('for-each-ref', '--format=%(refname)', SOURCE_CUSTODY_REF_PREFIX)).toBe('');
    expect(candidateState(f)).toEqual(before);
  });
});

describe('lifecycle P003 frozen publication', () => {
  it('validates the exact selected metadata tree after callbacks and before the real publication CAS', async () => {
    const f = fixture();
    writeFileSync(join(f.repo, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { next: '1.0.0' } }));
    writeFileSync(join(f.repo, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3,
      packages: { '': { dependencies: { next: '1.0.0' } } } }));
    f.git('add', 'package.json', 'package-lock.json');
    f.git('commit', '-m', 'coherent metadata');
    writeFileSync(join(f.repo, 'a.txt'), 'exact selected source\n');
    const request = { requestId: 'exact-final-oid', generation: 1, base: f.git('rev-parse', 'HEAD'), paths: ['a.txt'] };
    const captured = await captureGitSyncCandidate(f.runGit, f.repo, request);
    if (!captured.ok) throw new Error(captured.error);
    const before = unpublishedState(f);
    const validated: string[] = [];
    let callbackFinished = false;
    let casTree: string | undefined;
    const observed: RunGit = async (args, cwd, options) => {
      if (args[0] === 'update-ref' && args.includes('HEAD')) {
        expect(callbackFinished).toBe(true);
        casTree = f.git('rev-parse', `${args[args.indexOf('HEAD') + 1]}^{tree}`);
        expect(validated).toEqual([casTree, casTree]);
        expect(casTree).toBe(captured.candidate.tree);
      }
      const result = await f.runGit(args, cwd, options);
      if (args[0] === 'cat-file' && args[1] === '-t' && result.stdout.trim() === 'tree') validated.push(args[2]!);
      return result;
    };
    const result = await publishGitSyncCandidate(observed, f.repo, request, {
      assertHeld: () => {}, beforePublish: async () => { callbackFinished = true; return { ok: true }; },
    });
    expect(result).toMatchObject({ status: 'committed', tree: casTree });
    expect(casTree).toBeTruthy();
    expect(f.git('rev-parse', 'HEAD^{tree}')).toBe(casTree);
    expect(unpublishedState(f)).toEqual(before);
  });

  it.each(['coherent', 'incoherent'])('refuses a %s private-tree mutation after the last publication callback', async mutation => {
    const f = fixture();
    writeFileSync(join(f.repo, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { next: '1.0.0' } }));
    const lock = (version: string) => JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { next: version } } } });
    writeFileSync(join(f.repo, 'package-lock.json'), lock('1.0.0'));
    f.git('add', 'package.json', 'package-lock.json');
    f.git('commit', '-m', 'coherent npm metadata');
    const base = f.git('rev-parse', 'HEAD');
    writeFileSync(join(f.repo, 'a.txt'), 'A1 frozen\n');
    const request = { requestId: `late-tree-${mutation}`, generation: 1, base, paths: ['a.txt'] };
    expect((await captureGitSyncCandidate(f.runGit, f.repo, request)).ok).toBe(true);
    const before = candidateState(f);
    let privateIndex: string | undefined;
    const observed: RunGit = async (args, cwd, options) => {
      if (options?.env?.GIT_INDEX_FILE) privateIndex = options.env.GIT_INDEX_FILE;
      return f.runGit(args, cwd, options);
    };
    const result = await publishGitSyncCandidate(observed, f.repo, request, { assertHeld: () => {}, beforePublish: async () => {
      expect(privateIndex).toBeTruthy();
      const hashed = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: f.repo, encoding: 'utf8',
        input: mutation === 'incoherent' ? lock('2.0.0') : 'late unrelated source\n' });
      expect(hashed.status).toBe(0);
      const path = mutation === 'incoherent' ? 'package-lock.json' : 'late.txt';
      const updated = await f.runGit(['update-index', '--add', '--cacheinfo', `100644,${hashed.stdout.trim()},${path}`], f.repo,
        { env: { GIT_INDEX_FILE: privateIndex! } });
      expect(updated.code).toBe(0);
      return { ok: true };
    } });
    expect(result).toMatchObject({ status: 'error', error: expect.stringContaining(mutation === 'incoherent'
      ? 'NPM_INSTALL_SAFE_WORKSPACE_LOCK_DRIFT' : 'private tree changed before publication') });
    expect(candidateState(f)).toEqual(before);
    expect(f.git('rev-parse', 'HEAD')).toBe(base);
  });

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
  it.each(['ignored', 'absent'] as const)('captures an unchanged tree for %s requested cache paths', async state => {
    const f = fixture();
    const paths = ['.next-build/cache', '.next-build/cache-offload-tmp', '.next-build/cache-original-aside'];
    writeFileSync(join(f.repo, '.gitignore'), '.next-build/\n');
    if (state === 'ignored') {
      mkdirSync(join(f.repo, paths[0]!), { recursive: true });
      writeFileSync(join(f.repo, paths[0]!, 'generated.bin'), 'generated cache\n');
    }
    const before = candidateState(f);
    const calls: string[][] = [];
    const observed: RunGit = async (args, cwd, options) => {
      calls.push([...args]);
      return f.runGit(args, cwd, options);
    };
    const request = { requestId: `cache-${state}`, generation: 1, base: before.head!, paths };
    const captured = await captureGitSyncCandidate(observed, f.repo, request);
    expect(captured).toMatchObject({ ok: true });
    if (!captured.ok) throw new Error(captured.error);
    expect(captured.candidate.paths).toEqual([...paths].sort());
    expect(captured.candidate.tree).toBe(captured.candidate.baseTree);
    expect(calls.some(args => args[0] === 'add')).toBe(false);
    expect(await readGitSyncCandidate(f.runGit, f.repo, request)).toEqual(captured);
    expect(candidateState(f)).toEqual(before);
  });

  it('captures eligible source and staged deletions alongside ignored and missing requests', async () => {
    const f = fixture();
    writeFileSync(join(f.repo, '.gitignore'), '.next-build/\n');
    mkdirSync(join(f.repo, '.next-build/cache'), { recursive: true });
    writeFileSync(join(f.repo, '.next-build/cache/generated.bin'), 'generated cache\n');
    mkdirSync(join(f.repo, 'source'), { recursive: true });
    writeFileSync(join(f.repo, 'source/new[1].txt'), 'new source\n');
    writeFileSync(join(f.repo, 'a.txt'), 'captured source\n');
    f.git('rm', '--', 'b.txt');
    const before = candidateState(f);
    const request = { requestId: 'mixed-cache-source', generation: 1, base: before.head!,
      paths: ['a.txt', 'b.txt', 'source', '.next-build/cache', '.next-build/cache-original-aside', 'missing.txt'] };
    const captured = await captureGitSyncCandidate(f.runGit, f.repo, request);
    expect(captured).toMatchObject({ ok: true });
    if (!captured.ok) throw new Error(captured.error);
    expect(f.git('show', `${captured.ref}:payload/a.txt`)).toBe('captured source');
    expect(f.git('show', `${captured.ref}:payload/source/new[1].txt`)).toBe('new source');
    expect(f.git('ls-tree', captured.candidate.tree, '--', 'b.txt', '.next-build', 'missing.txt')).toBe('');
    expect(readFileSync(join(f.repo, '.next-build/cache/generated.bin'), 'utf8')).toBe('generated cache\n');
    expect(candidateState(f)).toEqual(before);
  });

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
