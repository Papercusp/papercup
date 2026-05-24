import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InitLocalDirError,
  initLocalHarnessDir,
  isPathInside,
  isValidFolderName,
} from './init-local-dir';

describe('isValidFolderName', () => {
  it('accepts normal names', () => {
    expect(isValidFolderName('foo')).toBe(true);
    expect(isValidFolderName('foo-bar')).toBe(true);
    expect(isValidFolderName('foo_bar')).toBe(true);
    expect(isValidFolderName('foo.bar')).toBe(true);
    expect(isValidFolderName('foo123')).toBe(true);
    expect(isValidFolderName('a')).toBe(true);
    expect(isValidFolderName('1foo')).toBe(true);
  });

  it('rejects empty / dot / dotdot', () => {
    expect(isValidFolderName('')).toBe(false);
    expect(isValidFolderName('.')).toBe(false);
    expect(isValidFolderName('..')).toBe(false);
  });

  it('rejects names with slashes (path-traversal vector)', () => {
    expect(isValidFolderName('foo/bar')).toBe(false);
    expect(isValidFolderName('../foo')).toBe(false);
    expect(isValidFolderName('foo\\bar')).toBe(false);
  });

  it('rejects leading-dot (hidden dir) names', () => {
    expect(isValidFolderName('.git')).toBe(false);
    expect(isValidFolderName('.hidden')).toBe(false);
  });

  it('rejects names with disallowed chars', () => {
    expect(isValidFolderName('foo bar')).toBe(false);
    expect(isValidFolderName('foo;rm')).toBe(false);
    expect(isValidFolderName('foo$')).toBe(false);
    expect(isValidFolderName('foo*')).toBe(false);
    expect(isValidFolderName('foo:bar')).toBe(false);
  });

  it('rejects names over 100 chars', () => {
    expect(isValidFolderName('a'.repeat(100))).toBe(true);
    expect(isValidFolderName('a'.repeat(101))).toBe(false);
  });

  it('rejects non-string input defensively', () => {
    // @ts-expect-error — testing the runtime guard
    expect(isValidFolderName(null)).toBe(false);
    // @ts-expect-error — testing the runtime guard
    expect(isValidFolderName(undefined)).toBe(false);
    // @ts-expect-error — testing the runtime guard
    expect(isValidFolderName(123)).toBe(false);
  });
});

describe('isPathInside', () => {
  it('accepts a normal child path', () => {
    expect(isPathInside('/tmp', 'foo')).toBe(true);
  });

  it('rejects a folder name that escapes via .. (regardless — folderName regex forbids)', () => {
    expect(isPathInside('/tmp', '..')).toBe(false);
    expect(isPathInside('/tmp', '../etc')).toBe(false);
  });

  it('rejects a folder name with a slash', () => {
    expect(isPathInside('/tmp', 'foo/bar')).toBe(false);
  });

  it('handles parent with trailing slash', () => {
    expect(isPathInside('/tmp/', 'foo')).toBe(true);
  });

  it('handles parent with .. (normalized)', () => {
    // /tmp/../tmp = /tmp; child 'foo' is inside.
    expect(isPathInside('/tmp/../tmp', 'foo')).toBe(true);
  });
});

describe('InitLocalDirError', () => {
  it('is an Error subclass with .code + .detail', () => {
    const err = new InitLocalDirError('git_missing', 'msg', 'detail');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('InitLocalDirError');
    expect(err.code).toBe('git_missing');
    expect(err.message).toBe('msg');
    expect(err.detail).toBe('detail');
  });
});

describe('initLocalHarnessDir — integration against a tmp filesystem', () => {
  let work: string;

  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), 'init-local-test-'));
  });

  afterEach(async () => {
    if (work) await rm(work, { recursive: true, force: true });
  });

  it('creates dir + runs git init', async () => {
    const result = await initLocalHarnessDir({ parentDir: work, folderName: 'foo' });
    expect(result.initialized).toBe(true);
    expect(result.path).toBe(join(work, 'foo'));
    // Verify .git/ was created
    const gitStat = await stat(join(result.path, '.git'));
    expect(gitStat.isDirectory()).toBe(true);
  }, 15_000);

  it('is idempotent on second call', async () => {
    const first = await initLocalHarnessDir({ parentDir: work, folderName: 'foo' });
    expect(first.initialized).toBe(true);
    const second = await initLocalHarnessDir({ parentDir: work, folderName: 'foo' });
    expect(second.initialized).toBe(false);
    expect(second.path).toBe(first.path);
  }, 15_000);

  it('rejects folder name with .. (path-traversal)', async () => {
    await expect(
      initLocalHarnessDir({ parentDir: work, folderName: '../escapes' }),
    ).rejects.toThrow(InitLocalDirError);
    try {
      await initLocalHarnessDir({ parentDir: work, folderName: '../escapes' });
    } catch (err) {
      expect((err as InitLocalDirError).code).toBe('invalid_path');
    }
  });

  it('rejects when parentDir does not exist', async () => {
    const missing = join(work, 'no-such-dir');
    try {
      await initLocalHarnessDir({ parentDir: missing, folderName: 'foo' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(InitLocalDirError);
      expect((err as InitLocalDirError).code).toBe('parent_missing');
    }
  });

  it('rejects when parentDir exists but is a file', async () => {
    const fakeParent = join(work, 'not-a-dir');
    await writeFile(fakeParent, 'contents');
    try {
      await initLocalHarnessDir({ parentDir: fakeParent, folderName: 'foo' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(InitLocalDirError);
      expect((err as InitLocalDirError).code).toBe('parent_missing');
    }
  });

  it('rejects when destination already exists as a file', async () => {
    await writeFile(join(work, 'collision'), 'oops');
    try {
      await initLocalHarnessDir({ parentDir: work, folderName: 'collision' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(InitLocalDirError);
      expect((err as InitLocalDirError).code).toBe('dest_exists');
    }
  });

  it('initializes a pre-existing empty dir without .git/', async () => {
    // Pre-create empty dir; helper should fall through to git init in place.
    const emptyDir = join(work, 'pre-existing');
    await mkdir(emptyDir);
    const result = await initLocalHarnessDir({ parentDir: work, folderName: 'pre-existing' });
    expect(result.initialized).toBe(true);
    const gitStat = await stat(join(result.path, '.git'));
    expect(gitStat.isDirectory()).toBe(true);
  }, 15_000);
});
