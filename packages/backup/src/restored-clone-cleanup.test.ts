import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureBackup } from './config';
import {
  DEFAULT_RESTORED_CLONE_MAX_AGE_MS,
  sweepRestoredClones,
} from './restored-clone-cleanup';

const sql = vi.fn();
let root: string;
let workspace: string;

async function age(path: string, msAgo: number): Promise<void> {
  const time = new Date(Date.now() - msAgo);
  await utimes(path, time, time);
}

async function clone(snapshot = 'snapshot-1', slug = 'live'): Promise<string> {
  const path = join(workspace, '.restored', snapshot, slug);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'payload.txt'), 'restored');
  return path;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'restored-clone-sweep-'));
  workspace = join(root, 'default');
  await mkdir(workspace, { recursive: true });
  sql.mockReset().mockResolvedValue([]);
  configureBackup({
    getSql: () => sql,
    workspacesRoot: () => root,
    ensureSchema: async () => {},
    getHarnessAdminUrl: () => ({ url: 'postgres://test', source: 'test' }),
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('sweepRestoredClones', () => {
  it('previews aged direct clones by default without deleting them', async () => {
    const path = await clone();
    await age(path, DEFAULT_RESTORED_CLONE_MAX_AGE_MS + 1_000);

    const result = await sweepRestoredClones(root);

    expect(result).toMatchObject({
      candidates: [path],
      removed: [],
      dryRun: true,
    });
    await expect(readFile(join(path, 'payload.txt'), 'utf8')).resolves.toBe('restored');
  });

  it('removes an aged clone only when the explicit real pass is requested', async () => {
    const path = await clone();
    await age(path, DEFAULT_RESTORED_CLONE_MAX_AGE_MS + 1_000);

    const result = await sweepRestoredClones(root, { dryRun: false });

    expect(result.removed).toEqual([path]);
    expect(result.bytesFreed).toBeGreaterThan(0);
    await expect(lstat(path)).rejects.toThrow();
  });

  it('keeps recent clones and never descends past the direct slug', async () => {
    const recent = await clone('snapshot-recent', 'live');
    const nested = join(recent, 'nested');
    await mkdir(nested);
    await writeFile(join(nested, 'payload.txt'), 'nested');
    const result = await sweepRestoredClones(root, { dryRun: false });

    expect(result.candidates).toEqual([]);
    expect(result.protected).toEqual([{ path: recent, reason: 'recent' }]);
    await expect(readFile(join(nested, 'payload.txt'), 'utf8')).resolves.toBe('nested');
  });

  it('does not follow symlinks in snapshot or clone positions', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'restored-clone-outside-'));
    const target = await clone('snapshot-real', 'real');
    await age(target, DEFAULT_RESTORED_CLONE_MAX_AGE_MS + 1_000);
    const linkSnapshot = join(workspace, '.restored', 'snapshot-link');
    const linkClone = join(workspace, '.restored', 'snapshot-real', 'clone-link');
    await symlink(join(workspace, '.restored', 'snapshot-real'), linkSnapshot, 'dir');
    await symlink(outside, linkClone, 'dir');

    const result = await sweepRestoredClones(root, { dryRun: false });

    expect(result.removed).toEqual([target]);
    await expect(lstat(linkSnapshot)).resolves.toBeDefined();
    await expect(lstat(linkClone)).resolves.toBeDefined();
    await rm(outside, { recursive: true, force: true });
  });

  it('fails closed for an active restore event', async () => {
    const path = await clone();
    await age(path, DEFAULT_RESTORED_CLONE_MAX_AGE_MS + 1_000);
    sql.mockResolvedValue([{ target: path, phase: 'started' }]);

    const result = await sweepRestoredClones(root, { dryRun: false });

    expect(result.protected).toEqual([{ path, reason: 'active-restore' }]);
    await expect(lstat(path)).resolves.toBeDefined();
  });

  it('fails closed for a promotion sidecar reference', async () => {
    const path = await clone();
    await age(path, DEFAULT_RESTORED_CLONE_MAX_AGE_MS + 1_000);
    await writeFile(
      join(workspace, '.broken-op-live.meta.json'),
      JSON.stringify({ broken: '/broken', live: workspace, promotedFrom: path }),
    );

    const result = await sweepRestoredClones(root, { dryRun: false });

    expect(result.protected).toEqual([{ path, reason: 'promotion-reference' }]);
    await expect(lstat(path)).resolves.toBeDefined();
  });

  it('fails closed when either proof source is unreadable or malformed', async () => {
    const path = await clone();
    await age(path, DEFAULT_RESTORED_CLONE_MAX_AGE_MS + 1_000);
    await writeFile(join(workspace, '.broken-op-live.meta.json'), '{not-json');
    sql.mockRejectedValue(new Error('database unavailable'));

    const result = await sweepRestoredClones(root, { dryRun: false });

    expect(result.protected).toEqual([{ path, reason: 'proof-unavailable' }]);
    await expect(lstat(path)).resolves.toBeDefined();
  });
});
