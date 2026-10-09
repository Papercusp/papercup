/**
 * Unit tests for capability:git's runGit spawn (P-010; EI-1617 env-scrub fix).
 *
 * runGit spawns the real `git` binary directly (no shell), so an env-leak
 * regression test can't just `printf "$SECRET"`. Git's `!`-prefixed custom
 * aliases DO run through a shell, though (`git -c alias.x='!cmd' x`), which
 * gives an honest end-to-end probe of the CHILD PROCESS's actual env without
 * mocking anything — the exact vector a bee's `capability:git` would have had.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import capabilityGit, { createScratchClone, emptyPathspecNote, runGit } from './git';

const STATE = mkdtempSync(join(tmpdir(), 'cap-git-'));
const never = new AbortController().signal;
const cleanup: string[] = [];

afterAll(() => rmSync(STATE, { recursive: true, force: true }));

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function repository(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(root);
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.name', 'Scratch Clone Test']);
  git(root, ['config', 'user.email', 'scratch-clone@example.invalid']);
  writeFileSync(join(root, 'tracked.txt'), `${prefix}\n`);
  git(root, ['add', 'tracked.txt']);
  git(root, ['commit', '--quiet', '-m', 'initial']);
  return root;
}

describe('runGit', () => {
  it('runs a plain git subcommand', async () => {
    const r = await runGit(['--version'], STATE, STATE, never);
    expect(r.code).toBe(0);
    expect(r.output).toContain('git version');
  });
});

describe('scratchClone — guarded cheap local materialisation (WI-38848)', () => {
  it('keeps the existing argv form and exposes a mutually-exclusive scratch form', () => {
    const schema = (capabilityGit as unknown as { args: { safeParse(value: unknown): { success: boolean } } }).args;
    expect(schema.safeParse({ args: ['status', '--porcelain'] }).success).toBe(true);
    expect(schema.safeParse({ scratchClone: { ref: 'HEAD' } }).success).toBe(true);
    expect(schema.safeParse({ args: ['status'], scratchClone: {} }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('borrows the object store, pins a detached commit, strips origin, and skips untracked node_modules', async () => {
    const source = repository('cap-git-scratch-source-');
    mkdirSync(join(source, 'node_modules'), { recursive: true });
    writeFileSync(join(source, 'node_modules', 'large-untracked-model.bin'), 'never copy me');
    const sha = git(source, ['rev-parse', 'HEAD']);

    const result = await createScratchClone({ source, signal: never });
    cleanup.push(result.path);

    expect(result.sha).toBe(sha);
    expect(result.borrowedRepositories).toBe(1);
    expect(git(result.path, ['rev-parse', 'HEAD'])).toBe(sha);
    expect(git(result.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD');
    expect(git(result.path, ['remote'])).toBe('');
    expect(existsSync(join(result.path, 'node_modules'))).toBe(false);
    expect(readFileSync(join(result.path, '.git', 'objects', 'info', 'alternates'), 'utf8').trim()).not.toBe('');
  });

  it('materialises local submodules at their exact pins with shared objects and no origins', async () => {
    const child = repository('cap-git-scratch-child-');
    const source = repository('cap-git-scratch-parent-');
    git(source, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', child, 'modules/child']);
    git(source, ['commit', '--quiet', '-am', 'add child']);
    const childPin = git(source, ['rev-parse', 'HEAD:modules/child']);

    const result = await createScratchClone({ source, signal: never });
    cleanup.push(result.path);
    const clonedChild = join(result.path, 'modules', 'child');

    expect(result.submodules).toBe(1);
    expect(result.borrowedRepositories).toBe(2);
    expect(git(result.path, ['ls-files', '--recurse-submodules'])).toContain('modules/child/tracked.txt');
    expect(git(clonedChild, ['rev-parse', 'HEAD'])).toBe(childPin);
    expect(git(clonedChild, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD');
    expect(git(clonedChild, ['remote'])).toBe('');
    expect(readFileSync(join(clonedChild, '.git', 'objects', 'info', 'alternates'), 'utf8').trim()).not.toBe('');
  });

  it('fails closed and removes the destination it created when a local submodule is unavailable', async () => {
    const child = repository('cap-git-scratch-missing-child-');
    const source = repository('cap-git-scratch-missing-parent-');
    git(source, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', child, 'modules/child']);
    git(source, ['commit', '--quiet', '-am', 'add child']);
    rmSync(join(source, 'modules', 'child'), { recursive: true, force: true });
    const destination = join(tmpdir(), `cap-git-scratch-fail-${crypto.randomUUID()}`);

    await expect(createScratchClone({ source, destination, signal: never })).rejects.toThrow(/local submodule modules\/child/);
    expect(existsSync(destination)).toBe(false);
  });

  it('materialises nested exact gitlinks without inventing .gitmodules mappings', async () => {
    const leaf = repository('cap-git-unlisted-leaf-');
    const child = repository('cap-git-unlisted-child-');
    const source = repository('cap-git-unlisted-parent-');
    const addUnlisted = (parent: string, donor: string, path: string): string => {
      git(parent, ['clone', '--quiet', '--shared', '--', donor, path]);
      const pin = git(join(parent, path), ['rev-parse', 'HEAD']);
      git(parent, ['update-index', '--add', '--cacheinfo', `160000,${pin},${path}`]);
      git(parent, ['commit', '--quiet', '-m', 'add unlisted gitlink']);
      return pin;
    };
    const leafPin = addUnlisted(child, leaf, 'leaf');
    const childPin = addUnlisted(source, child, 'unlisted');
    // A plain clone leaves nested gitlinks empty; provide the actual local donor
    // checkout that the guarded clone requires rather than bypassing its check.
    git(join(source, 'unlisted'), ['clone', '--quiet', '--shared', '--', leaf, 'leaf']);
    const result = await createScratchClone({ source, signal: never });
    cleanup.push(result.path);

    expect(result.submodules).toBe(2);
    expect(result.borrowedRepositories).toBe(3);
    expect(git(join(result.path, 'unlisted'), ['rev-parse', 'HEAD'])).toBe(childPin);
    expect(git(join(result.path, 'unlisted', 'leaf'), ['rev-parse', 'HEAD'])).toBe(leafPin);
    expect(readFileSync(join(result.path, 'unlisted', 'leaf', 'tracked.txt'), 'utf8'))
      .toBe(readFileSync(join(leaf, 'tracked.txt'), 'utf8'));
    for (const root of [result.path, join(result.path, 'unlisted'), join(result.path, 'unlisted', 'leaf')]) {
      expect(existsSync(join(root, '.gitmodules'))).toBe(false);
      expect(git(root, ['remote'])).toBe('');
      expect(readFileSync(join(root, '.git', 'objects', 'info', 'alternates'), 'utf8').trim()).not.toBe('');
    }
  });

  it('refuses an unavailable unlisted pin and cleans only its owned destination', async () => {
    const child = repository('cap-git-unlisted-missing-child-');
    const source = repository('cap-git-unlisted-missing-parent-');
    const pin = git(child, ['rev-parse', 'HEAD']);
    git(source, ['update-index', '--add', '--cacheinfo', `160000,${pin},missing`]);
    git(source, ['commit', '--quiet', '-m', 'unavailable unlisted gitlink']);
    const destination = join(tmpdir(), `cap-git-unlisted-fail-${crypto.randomUUID()}`);
    await expect(createScratchClone({ source, destination, signal: never })).rejects.toThrow('local submodule missing');
    expect(existsSync(destination)).toBe(false);
    expect(git(source, ['rev-parse', 'HEAD:missing'])).toBe(pin);
  });

  it('never deletes or enters a caller-owned destination', async () => {
    const source = repository('cap-git-scratch-preserve-source-');
    const destination = mkdtempSync(join(tmpdir(), 'cap-git-scratch-preserve-dest-'));
    cleanup.push(destination);
    const sentinel = join(destination, 'peer-work.txt');
    writeFileSync(sentinel, 'keep');

    await expect(createScratchClone({ source, destination, signal: never })).rejects.toThrow(/must not already exist/);
    expect(readFileSync(sentinel, 'utf8')).toBe('keep');
  });
});

/**
 * EI-20881501070735530 — `git … -- <pathspec>` that matches nothing prints nothing and
 * exits 0, which is byte-identical to a genuine "no commits touch this file". The cwd
 * bug that produced the original false absence is fixed, but the ambiguous SHAPE is
 * git's, not ours, so the tool names which reading it cannot distinguish.
 *
 * The teeth are in the negatives: a note on a legitimately-empty `git diff` would train
 * agents to ignore it, which is worse than not having it.
 */
describe('emptyPathspecNote — the empty-at-exit-0 pathspec ambiguity', () => {
  const CWD = '/tree';

  it('fires when an explicit -- pathspec produced nothing at exit 0', () => {
    const note = emptyPathspecNote(['log', '-3', '--', 'pkg/a.ts'], 0, '', CWD);
    expect(note).toContain('pathspec matched nothing');
    expect(note).toContain('pkg/a.ts');
    expect(note).toContain(CWD); // the cwd IS the disambiguator — never omit it
  });

  it('does NOT fire on a clean `git diff` — an empty result there is the true answer', () => {
    expect(emptyPathspecNote(['diff', '--stat'], 0, '', CWD)).toBe('');
  });

  it('does NOT fire when the command produced output', () => {
    expect(emptyPathspecNote(['log', '--', 'pkg/a.ts'], 0, 'abc123 subject\n', CWD)).toBe('');
  });

  it('does NOT fire on a non-zero exit — git already said what went wrong', () => {
    expect(emptyPathspecNote(['log', '--', 'pkg/a.ts'], 128, '', CWD)).toBe('');
  });

  it('does NOT fire on a bare `--` with no operands', () => {
    expect(emptyPathspecNote(['log', '--'], 0, '', CWD)).toBe('');
  });

  it('names the submodule case — the one where the path exists but can never match', () => {
    expect(emptyPathspecNote(['log', '--', 'libs/papercusp-shared/package.json'], 0, '', CWD))
      .toContain('SUBMODULE');
  });
});

describe('operator secrets are NOT inherited by the git subprocess (EI-1617)', () => {
  it('a fake operator secret in process.env never reaches a git shell-alias command', async () => {
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://user:pw@host/db-should-not-leak';
    try {
      const r = await runGit(
        ['-c', 'alias.leak=!printf "[%s]" "${DATABASE_URL:-unset}"', 'leak'],
        STATE,
        STATE,
        never,
      );
      expect(r.code).toBe(0);
      expect(r.output).toBe('[unset]');
    } finally {
      if (prev === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prev;
    }
  });

  it('a plain allowlisted var (PATH) still reaches the git shell-alias command', async () => {
    const r = await runGit(
      ['-c', 'alias.leak=!test -n "$PATH" && printf has-path', 'leak'],
      STATE,
      STATE,
      never,
    );
    expect(r.code).toBe(0);
    expect(r.output).toBe('has-path');
  });
});
