/**
 * share-finalize.test.ts — unit tests for finalizeShare (P-077).
 *
 * All deps injected (no fs / registry): asserts it writes a structurally-valid
 * shared.json (passing the boot-side isHarnessSharedConfig predicate), honors
 * privacy + discord, and rejects bad input / unknown slugs.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  finalizeShare,
  FinalizeShareError,
  type FinalizeShareDeps,
  type EnsureBindingResult,
} from '../share-finalize';
import { isHarnessSharedConfig } from '../../../../harness/harness-shared-config-types';

const TOPIC = 'a'.repeat(64);

function deps(over: Partial<FinalizeShareDeps> = {}) {
  const writeFileUtf8 = vi.fn(async (_absPath: string, _contents: string) => {});
  const mkdirp = vi.fn(async (_dir: string) => {});
  const d: FinalizeShareDeps = {
    resolvePaths: async () => ({ projectDir: '/repo/papercup', stateDir: '/repo/papercup/.papercusp' }),
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
    expect(mkdirp).toHaveBeenCalledWith('/repo/papercup/.papercusp');
    expect(writeFileUtf8).toHaveBeenCalledTimes(1);
    expect(writeFileUtf8.mock.calls[0]![0]).toBe('/repo/papercup/.papercusp/shared.json');
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
    expect(r.path).toBe('/repo/papercup/.papercusp/shared.json');
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
        stateDir: '/tmp/papercusp-unresolved/ws/papercup/.papercusp',
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

  // ── ensureBinding (D-003 mutual binding) ─────────────────────────────────

  it('calls ensureBinding after shared.json is written with resolved repoOwner+repoName', async () => {
    const ensureBinding = vi.fn(async (_args: {
      repoOwner: string;
      repoName: string;
      defaultBranch: string;
      github_remote: string;
    }): Promise<EnsureBindingResult> => ({ devicePubkeyBase64: 'abc123' }));
    const { d, writeFileUtf8 } = deps({ ensureBinding });
    const r = await finalizeShare(INPUT, d);
    // shared.json was written before ensureBinding was called
    expect(writeFileUtf8).toHaveBeenCalledTimes(1);
    expect(ensureBinding).toHaveBeenCalledTimes(1);
    const callArg = ensureBinding.mock.calls[0]![0];
    expect(callArg.repoOwner).toBe('Papercusp');
    expect(callArg.repoName).toBe('papercup');
    expect(typeof callArg.defaultBranch).toBe('string');
    expect(callArg.defaultBranch.length).toBeGreaterThan(0);
    expect(r.bindingPublished).toBe(true);
    expect(r.bindingWarning).toBeUndefined();
  });

  it('ensureBinding called with non-empty attestationGistId-bearing args (HTTPS remote)', async () => {
    const ensureBinding = vi.fn(async (_args: unknown): Promise<EnsureBindingResult> => ({
      devicePubkeyBase64: 'pubkey64',
    }));
    const { d } = deps({ ensureBinding });
    const httpsInput = {
      ...INPUT,
      github_remote: 'https://github.com/myorg/myrepo.git',
    };
    const r = await finalizeShare(httpsInput, d);
    expect(ensureBinding).toHaveBeenCalledTimes(1);
    const arg = ensureBinding.mock.calls[0]![0] as { repoOwner: string; repoName: string };
    expect(arg.repoOwner).toBe('myorg');
    expect(arg.repoName).toBe('myrepo');
    expect(r.bindingPublished).toBe(true);
  });

  it('ensureBinding failure → finalize still succeeds with bindingWarning set; reboot still happens', async () => {
    const ensureBinding = vi.fn(async () => {
      throw new Error('github timeout');
    });
    const reboot = vi.fn(async (_slug: string) => ({
      rebooted: true as const,
      state: 'booted' as const,
    }));
    const { d } = deps({ ensureBinding, reboot });
    const r = await finalizeShare(INPUT, d);
    expect(r.ok).toBe(true);
    expect(r.bindingPublished).toBeUndefined();
    expect(r.bindingWarning).toContain('github timeout');
    // reboot must still happen despite ensureBinding failure
    expect(reboot).toHaveBeenCalledWith('papercup');
    expect(r.swarm).toMatchObject({ rebooted: true, state: 'booted' });
  });

  it('gh_auth_required during binding → non-fatal warning, share succeeds', async () => {
    // Simulate what happens when the real ensureBinding throws due to missing gh auth
    const ensureBinding = vi.fn(async () => {
      throw new Error('gh auth required — publisher binding skipped; re-share after `gh auth login`');
    });
    const { d } = deps({ ensureBinding });
    const r = await finalizeShare(INPUT, d);
    expect(r.ok).toBe(true);
    expect(r.bindingWarning).toMatch(/gh auth required/);
    expect(r.bindingPublished).toBeUndefined();
  });

  it('ensureBinding called AFTER shared.json write (ordering)', async () => {
    const callOrder: string[] = [];
    const writeFileUtf8 = vi.fn(async () => { callOrder.push('write'); });
    const ensureBinding = vi.fn(async (): Promise<EnsureBindingResult> => {
      callOrder.push('ensureBinding');
      return { devicePubkeyBase64: 'pub' };
    });
    const reboot = vi.fn(async (_slug: string) => {
      callOrder.push('reboot');
      return { rebooted: true as const, state: 'booted' as const };
    });
    const { d: baseDeps } = deps({ ensureBinding, reboot });
    const d: FinalizeShareDeps = { ...baseDeps, writeFileUtf8 };
    await finalizeShare(INPUT, d);
    // shared.json write must precede ensureBinding, which must precede reboot
    expect(callOrder.indexOf('write')).toBeLessThan(callOrder.indexOf('ensureBinding'));
    expect(callOrder.indexOf('ensureBinding')).toBeLessThan(callOrder.indexOf('reboot'));
  });

  it('omits bindingPublished and bindingWarning when ensureBinding dep is not provided', async () => {
    const { d } = deps();
    const r = await finalizeShare(INPUT, d);
    expect(r.bindingPublished).toBeUndefined();
    expect(r.bindingWarning).toBeUndefined();
  });

  it('ensureBinding NOT called when the write is rejected (bad input)', async () => {
    const ensureBinding = vi.fn(async (): Promise<EnsureBindingResult> => ({ devicePubkeyBase64: 'pub' }));
    const { d } = deps({ ensureBinding });
    await expect(finalizeShare({ ...INPUT, topic: 'not-hex' }, d)).rejects.toMatchObject({ status: 400 });
    expect(ensureBinding).not.toHaveBeenCalled();
  });

  // ── commitSharedJson (#2 follow-up: git-commit the file at finalize) ──────

  it('calls commitSharedJson({projectDir,absPath}) after the write and surfaces it as commit', async () => {
    const commitSharedJson = vi.fn(async (_a: { projectDir: string; absPath: string }) => ({
      committed: true as const,
      commit_sha: 'deadbeef',
    }));
    const { d, writeFileUtf8 } = deps({ commitSharedJson });
    const r = await finalizeShare(INPUT, d);
    expect(writeFileUtf8).toHaveBeenCalledTimes(1);
    expect(commitSharedJson).toHaveBeenCalledWith({
      projectDir: '/repo/papercup',
      absPath: '/repo/papercup/.papercusp/shared.json',
    });
    expect(r.commit).toEqual({ committed: true, commit_sha: 'deadbeef' });
  });

  it('does NOT commit when the write is rejected (bad input)', async () => {
    const commitSharedJson = vi.fn(async () => ({ committed: true as const }));
    const { d } = deps({ commitSharedJson });
    await expect(finalizeShare({ ...INPUT, topic: 'not-hex' }, d)).rejects.toMatchObject({ status: 400 });
    expect(commitSharedJson).not.toHaveBeenCalled();
  });

  it('swallows a commitSharedJson throw — finalize still succeeds with commit.committed=false', async () => {
    const commitSharedJson = vi.fn(async () => {
      throw new Error('not a git repo');
    });
    const { d } = deps({ commitSharedJson });
    const r = await finalizeShare(INPUT, d);
    expect(r.ok).toBe(true);
    expect(r.commit).toMatchObject({ committed: false, reason: 'not a git repo' });
  });

  it('omits commit when no commitSharedJson dep is provided', async () => {
    const { d } = deps();
    const r = await finalizeShare(INPUT, d);
    expect(r.commit).toBeUndefined();
  });

  it('commitSharedJson is called AFTER the shared.json write (ordering)', async () => {
    const callOrder: string[] = [];
    const writeFileUtf8 = vi.fn(async () => {
      callOrder.push('write');
    });
    const commitSharedJson = vi.fn(async () => {
      callOrder.push('commit');
      return { committed: true as const };
    });
    const { d: baseDeps } = deps({ commitSharedJson });
    const d: FinalizeShareDeps = { ...baseDeps, writeFileUtf8 };
    await finalizeShare(INPUT, d);
    expect(callOrder.indexOf('write')).toBeLessThan(callOrder.indexOf('commit'));
  });
});
