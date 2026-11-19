import { mkdir, mkdtemp, rm, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withBlueprintSourceMutation } from './source-lock';

let temp: string;
let priorLockRoot: string | undefined;
let priorDisabled: string | undefined;
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), 'blueprint-source-lock-'));
  priorLockRoot = process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
  priorDisabled = process.env.PAPERCUSP_DISABLE_FS_MUTEX;
  process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = join(temp, 'locks');
  delete process.env.PAPERCUSP_DISABLE_FS_MUTEX;
});
afterEach(async () => {
  if (priorLockRoot === undefined) delete process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
  else process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = priorLockRoot;
  if (priorDisabled === undefined) delete process.env.PAPERCUSP_DISABLE_FS_MUTEX;
  else process.env.PAPERCUSP_DISABLE_FS_MUTEX = priorDisabled;
  await rm(temp, { recursive: true, force: true });
});

describe('physical blueprint root mutation custody', () => {
  it('serializes an absent subtree through a physical ancestor alias', async () => {
    const real = join(temp, 'real');
    const alias = join(temp, 'alias');
    await mkdir(real);
    await symlink(real, alias);
    const root = join(real, 'absent', 'blueprints');
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const held = withBlueprintSourceMutation([root], async () => {
      entered();
      await new Promise<void>(resolve => { release = resolve; });
    });
    await ready;
    let ran = false;
    const pending = withBlueprintSourceMutation([join(alias, 'absent', 'blueprints')], async () => { ran = true; });
    try {
      await new Promise(resolve => setTimeout(resolve, 80));
      expect(ran).toBe(false);
    } finally { release(); await held; }
    await pending;
    expect(ran).toBe(true);
  });

  it('releases every root after a failed effect, irrespective of caller root order', async () => {
    const roots = [join(temp, 'a'), join(temp, 'b')];
    await expect(withBlueprintSourceMutation(roots, async () => { throw new Error('effect refused'); }))
      .rejects.toThrow('effect refused');
    await expect(withBlueprintSourceMutation([...roots].reverse(), async () => 'next')).resolves.toBe('next');
  });

  it('refuses an alias retargeted while waiting rather than mutating the unheld root', async () => {
    const oldRoot = join(temp, 'old');
    const newRoot = join(temp, 'new');
    const alias = join(temp, 'alias');
    await mkdir(oldRoot); await mkdir(newRoot); await symlink(oldRoot, alias);
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const held = withBlueprintSourceMutation([oldRoot], async () => {
      entered(); await new Promise<void>(resolve => { release = resolve; });
    });
    await ready;
    let ran = false;
    const pending = withBlueprintSourceMutation([alias], async () => { ran = true; });
    const refused = expect(pending).rejects.toThrow(/root changed/);
    try {
      await new Promise(resolve => setTimeout(resolve, 80));
      await unlink(alias); await symlink(newRoot, alias);
    } finally { release(); await held; }
    await refused;
    expect(ran).toBe(false);
  });

  it('refuses disabled custody before running an effect', async () => {
    process.env.PAPERCUSP_DISABLE_FS_MUTEX = '1';
    let ran = false;
    await expect(withBlueprintSourceMutation([join(temp, 'blueprints')], async () => { ran = true; }))
      .rejects.toThrow('required filesystem mutex cannot be disabled');
    expect(ran).toBe(false);
  });

  it.each([{ roots: [] }, { roots: ['relative/root'] }, { roots: [''] }])('refuses unresolved roots $roots', async ({ roots }) => {
    await expect(withBlueprintSourceMutation(roots, async () => 'unsafe')).rejects.toThrow(/absolute library roots/);
  });
});
