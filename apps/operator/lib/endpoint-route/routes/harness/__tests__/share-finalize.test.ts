/**
 * share-finalize.test.ts — unit tests for finalizeShare (P-077).
 *
 * All deps injected (no fs / registry): asserts it writes a structurally-valid
 * shared.json (passing the boot-side isHarnessSharedConfig predicate), honors
 * privacy + discord, and rejects bad input / unknown slugs.
 */

import { describe, it, expect, vi } from 'vitest';
import { finalizeShare, FinalizeShareError, type FinalizeShareDeps } from '../share-finalize';
import { isHarnessSharedConfig } from '@/lib/harness/harness-shared-config-types';

const TOPIC = 'a'.repeat(64);

function deps(over: Partial<FinalizeShareDeps> = {}) {
  const writeFileUtf8 = vi.fn(async (_absPath: string, _contents: string) => {});
  const mkdirp = vi.fn(async (_dir: string) => {});
  const d: FinalizeShareDeps = {
    resolvePaths: async () => ({ projectDir: '/repo/papercup', stateDir: '/repo/papercup/.harness' }),
    mkdirp,
    writeFileUtf8,
    now: () => 1_700_000_000_000,
    ...over,
  };
  return { d, writeFileUtf8, mkdirp };
}

const INPUT = {
  slug: 'papercup',
  topic: TOPIC,
  github_remote: 'git@github.com:Papercusp/papercup.git',
  github_repository_id: 12345,
};

function writtenConfig(writeFileUtf8: ReturnType<typeof vi.fn>) {
  return JSON.parse(writeFileUtf8.mock.calls[0]![1] as string);
}

describe('finalizeShare', () => {
  it('writes a structurally-valid shared.json + returns it', async () => {
    const { d, writeFileUtf8, mkdirp } = deps();
    const r = await finalizeShare(INPUT, d);
    expect(mkdirp).toHaveBeenCalledWith('/repo/papercup/.harness');
    expect(writeFileUtf8).toHaveBeenCalledTimes(1);
    expect(writeFileUtf8.mock.calls[0]![0]).toBe('/repo/papercup/.harness/shared.json');
    const cfg = writtenConfig(writeFileUtf8);
    expect(isHarnessSharedConfig(cfg)).toBe(true); // the boot-side predicate
    expect(cfg.github_repository_id).toBe(12345);
    expect(cfg.github_remote).toBe('git@github.com:Papercusp/papercup.git');
    expect(cfg.topic).toBe(TOPIC);
    expect(cfg.privacy).toBe('shared-private');
    expect(cfg.claim_status).toBe('unclaimed');
    expect(cfg.schema_version).toBe(1);
    expect(cfg.created_at).toBe(1_700_000_000_000);
    expect(r.shared_config.github_repository_id).toBe(12345);
    expect(r.path).toBe('/repo/papercup/.harness/shared.json');
  });

  it('honors shared-public privacy', async () => {
    const { d, writeFileUtf8 } = deps();
    await finalizeShare({ ...INPUT, privacy: 'shared-public' }, d);
    expect(writtenConfig(writeFileUtf8).privacy).toBe('shared-public');
  });

  it('includes discord_channel only when provided', async () => {
    const { d: d1, writeFileUtf8: w1 } = deps();
    await finalizeShare(INPUT, d1);
    expect('discord_channel' in writtenConfig(w1)).toBe(false);

    const { d: d2, writeFileUtf8: w2 } = deps();
    await finalizeShare({ ...INPUT, discord_channel: '#eng' }, d2);
    expect(writtenConfig(w2).discord_channel).toBe('#eng');
  });

  it('rejects a bad topic (400, no write)', async () => {
    const { d, writeFileUtf8 } = deps();
    await expect(finalizeShare({ ...INPUT, topic: 'not-hex' }, d)).rejects.toMatchObject({
      status: 400,
    });
    expect(writeFileUtf8).not.toHaveBeenCalled();
  });

  it('rejects an empty github_remote (400)', async () => {
    const { d } = deps();
    await expect(finalizeShare({ ...INPUT, github_remote: '' }, d)).rejects.toBeInstanceOf(
      FinalizeShareError,
    );
  });

  it('rejects a non-positive github_repository_id (400)', async () => {
    const { d } = deps();
    await expect(finalizeShare({ ...INPUT, github_repository_id: 0 }, d)).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      finalizeShare({ ...INPUT, github_repository_id: NaN }, d),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects an invalid privacy (400)', async () => {
    const { d } = deps();
    await expect(
      finalizeShare({ ...INPUT, privacy: 'public' as never }, d),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('404s an unregistered slug (resolves under /tmp/papercusp-unresolved), no write', async () => {
    const { d, writeFileUtf8 } = deps({
      resolvePaths: async () => ({
        projectDir: '/tmp/papercusp-unresolved/ws/papercup',
        stateDir: '/tmp/papercusp-unresolved/ws/papercup/.harness',
      }),
    });
    await expect(finalizeShare(INPUT, d)).rejects.toMatchObject({ status: 404 });
    expect(writeFileUtf8).not.toHaveBeenCalled();
  });

  it('calls reboot(slug) after a successful write and surfaces it as swarm', async () => {
    const reboot = vi.fn(async (_slug: string) => ({
      rebooted: true as const,
      state: 'booted' as const,
    }));
    const { d, writeFileUtf8 } = deps({ reboot });
    const r = await finalizeShare(INPUT, d);
    expect(writeFileUtf8).toHaveBeenCalledTimes(1);
    expect(reboot).toHaveBeenCalledWith('papercup');
    expect(r.swarm).toEqual({ rebooted: true, state: 'booted' });
  });

  it('does NOT reboot when the write is rejected (bad input)', async () => {
    const reboot = vi.fn(async () => ({ rebooted: true as const, state: 'booted' as const }));
    const { d } = deps({ reboot });
    await expect(finalizeShare({ ...INPUT, topic: 'not-hex' }, d)).rejects.toMatchObject({
      status: 400,
    });
    expect(reboot).not.toHaveBeenCalled();
  });

  it('swallows a reboot throw — finalize still succeeds with swarm.rebooted=false', async () => {
    const reboot = vi.fn(async () => {
      throw new Error('boom');
    });
    const { d } = deps({ reboot });
    const r = await finalizeShare(INPUT, d);
    expect(r.ok).toBe(true);
    expect(r.swarm).toMatchObject({ rebooted: false, error: 'boom' });
  });

  it('omits swarm when no reboot dep is provided', async () => {
    const { d } = deps();
    const r = await finalizeShare(INPUT, d);
    expect(r.swarm).toBeUndefined();
  });

  it('calls createBinding(args) after a successful write and surfaces it as binding', async () => {
    const createBinding = vi.fn(async (_args: unknown) => ({
      created: true as const,
      claim_status: 'unclaimed' as const,
    }));
    const { d, writeFileUtf8 } = deps({ createBinding });
    const r = await finalizeShare(INPUT, d);
    expect(writeFileUtf8).toHaveBeenCalledTimes(1);
    expect(createBinding).toHaveBeenCalledWith({
      slug: 'papercup',
      github_remote: 'git@github.com:Papercusp/papercup.git',
      harness_topic: TOPIC,
      privacy: 'shared-private',
    });
    expect(r.binding).toEqual({ created: true, claim_status: 'unclaimed' });
  });

  it('does NOT create a binding when the write is rejected (bad input)', async () => {
    const createBinding = vi.fn(async () => ({ created: true as const }));
    const { d } = deps({ createBinding });
    await expect(finalizeShare({ ...INPUT, topic: 'not-hex' }, d)).rejects.toMatchObject({
      status: 400,
    });
    expect(createBinding).not.toHaveBeenCalled();
  });

  it('swallows a createBinding throw — finalize still succeeds with binding.created=false', async () => {
    const createBinding = vi.fn(async () => {
      throw new Error('no gh token');
    });
    const { d } = deps({ createBinding });
    const r = await finalizeShare(INPUT, d);
    expect(r.ok).toBe(true);
    expect(r.binding).toMatchObject({ created: false, error: 'no gh token' });
  });

  it('omits binding when no createBinding dep is provided', async () => {
    const { d } = deps();
    const r = await finalizeShare(INPUT, d);
    expect(r.binding).toBeUndefined();
  });
});
