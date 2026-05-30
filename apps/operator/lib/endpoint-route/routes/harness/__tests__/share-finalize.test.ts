/**
 * share-finalize.test.ts — unit tests for finalizeShare (P-077).
 *
 * Exercises the core finalize logic with all deps injected (no fs / registry):
 * asserts it writes a structurally-valid shared.json, flips state to match
 * privacy, generates a topic when absent, honors an explicit topic, builds the
 * harness link, and rejects bad input.
 */

import { describe, it, expect, vi } from 'vitest';
import { finalizeShare, type FinalizeShareDeps } from '../share-finalize';
import { isSharedHarnessConfig } from '@/lib/harness/harness-shared-config-types';

function deps(over: Partial<FinalizeShareDeps> = {}) {
  const writeShared = vi.fn(async () => {});
  const setState = vi.fn(async () => {});
  const d: FinalizeShareDeps = {
    resolveProjectDir: async () => '/repo/papercup',
    writeShared,
    setState,
    genTopic: () => 'a'.repeat(64),
    nowIso: () => '2026-05-30T00:00:00.000Z',
    ...over,
  };
  return { d, writeShared, setState };
}

const INPUT = { slug: 'papercup', github_remote: 'Papercusp/papercup', github_repository_id: 12345 };

describe('finalizeShare', () => {
  it('writes a structurally-valid shared.json and returns the link', async () => {
    const { d, writeShared, setState } = deps();
    const r = await finalizeShare(INPUT, d);
    expect(writeShared).toHaveBeenCalledTimes(1);
    const [projectDir, config] = writeShared.mock.calls[0]!;
    expect(projectDir).toBe('/repo/papercup');
    expect(isSharedHarnessConfig(config)).toBe(true); // passes the boot-side predicate
    expect(config.github_repository_id).toBe(12345);
    expect(config.github_remote).toBe('Papercusp/papercup');
    expect(config.privacy).toBe('shared-private');
    expect(config.claim_status).toBe('unclaimed');
    expect(config.schema_version).toBe(1);
    expect(setState).toHaveBeenCalledWith('papercup', 'shared-private');
    expect(r.harnessLink).toContain('repo_id=12345');
    expect(r.harnessLink).toContain('github=Papercusp%2Fpapercup');
    expect(r.topic).toBe('a'.repeat(64));
    expect(r.state).toBe('shared-private');
  });

  it('generates a 64-char hex topic when none is supplied', async () => {
    const { d, writeShared } = deps({ genTopic: () => 'b'.repeat(64) });
    await finalizeShare(INPUT, d);
    expect(writeShared.mock.calls[0]![1].topic).toBe('b'.repeat(64));
  });

  it('honors a valid explicit topic and ignores an invalid one', async () => {
    const { d: d1, writeShared: w1 } = deps();
    await finalizeShare({ ...INPUT, topic: 'c'.repeat(64) }, d1);
    expect(w1.mock.calls[0]![1].topic).toBe('c'.repeat(64));

    const { d: d2, writeShared: w2 } = deps({ genTopic: () => 'd'.repeat(64) });
    await finalizeShare({ ...INPUT, topic: 'not-hex' }, d2); // invalid → generated
    expect(w2.mock.calls[0]![1].topic).toBe('d'.repeat(64));
  });

  it('flips registry state to shared-public when privacy is shared-public', async () => {
    const { d, setState, writeShared } = deps();
    const r = await finalizeShare({ ...INPUT, privacy: 'shared-public' }, d);
    expect(setState).toHaveBeenCalledWith('papercup', 'shared-public');
    expect(writeShared.mock.calls[0]![1].privacy).toBe('shared-public');
    expect(r.state).toBe('shared-public');
  });

  it('includes discord_channel_url only when provided', async () => {
    const { d: d1, writeShared: w1 } = deps();
    await finalizeShare(INPUT, d1);
    expect('discord_channel_url' in w1.mock.calls[0]![1]).toBe(false);

    const { d: d2, writeShared: w2 } = deps();
    await finalizeShare({ ...INPUT, discord_channel_url: 'https://discord.gg/x' }, d2);
    expect(w2.mock.calls[0]![1].discord_channel_url).toBe('https://discord.gg/x');
  });

  it('throws on a missing github_remote (cannot share without a repo)', async () => {
    const { d } = deps();
    await expect(finalizeShare({ ...INPUT, github_remote: '  ' }, d)).rejects.toThrow(/github_remote/);
  });

  it('throws on a non-positive / non-integer github_repository_id', async () => {
    const { d } = deps();
    await expect(finalizeShare({ ...INPUT, github_repository_id: 0 }, d)).rejects.toThrow(/repository_id/);
    await expect(
      finalizeShare({ ...INPUT, github_repository_id: 1.5 as number }, d),
    ).rejects.toThrow(/repository_id/);
  });

  it('throws (no write) when the harness is unknown', async () => {
    const { d, writeShared } = deps({ resolveProjectDir: async () => null });
    await expect(finalizeShare(INPUT, d)).rejects.toThrow(/unknown harness/);
    expect(writeShared).not.toHaveBeenCalled();
  });
});
