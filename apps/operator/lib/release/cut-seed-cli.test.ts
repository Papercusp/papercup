/**
 * cut-seed-cli.test.ts — the git-seal key-selection branch of the seed cutter CLI
 * (plan hive-seed-bundle-2026-07-04 P-010 live-wire 2 completion). Pure: `deriveEpochKey`
 * is injected, so the correctness-critical branch (which keyRef + key seals the git
 * bundle) is verified with no keychain / native crypto / real hive. The full cut (git +
 * corestore I/O + real deriveEpochKey on the owner keychain) is owner-box/build-dependent
 * and out of scope for a headless unit test — only the branch selection is tested here.
 */

import { describe, it, expect, vi } from 'vitest';
import { pickGitEncryption } from './cut-seed-cli';

const EPOCH_KEY = Uint8Array.from(Array.from({ length: 32 }, (_, i) => (i * 7) % 256));
const HEX32 = 'ab'.repeat(32); // 64 hex chars = 32 bytes

describe('pickGitEncryption', () => {
  it('explicit keyHex ⇒ FIXTURE mode: seals via=seed-key-op with that key, never touches deriveEpochKey', async () => {
    const deriveEpochKey = vi.fn(async () => EPOCH_KEY);
    const enc = await pickGitEncryption({
      keyHex: HEX32,
      epochProvided: false,
      hive: 'papercusp',
      cutAtEpoch: 0,
      deriveEpochKey,
    });
    expect(enc?.keyRef).toEqual({ via: 'seed-key-op', hiveId: 'papercusp' });
    expect(enc?.key).toEqual(Uint8Array.from(Buffer.from(HEX32, 'hex')));
    expect(deriveEpochKey).not.toHaveBeenCalled(); // explicit key wins; no crypto touched
  });

  it('a bad-length keyHex ⇒ throws (32-byte requirement)', async () => {
    await expect(
      pickGitEncryption({ keyHex: 'abcd', epochProvided: false, hive: 'papercusp', cutAtEpoch: 0, deriveEpochKey: vi.fn(async () => EPOCH_KEY) }),
    ).rejects.toThrow(/must be 32 bytes/);
  });

  it('a live --workspace-id ⇒ RELEASE mode: seals via=epoch with the owner epoch key at cutAtEpoch', async () => {
    const deriveEpochKey = vi.fn(async () => EPOCH_KEY);
    const enc = await pickGitEncryption({
      workspaceId: 'papercusp-workspace',
      epochProvided: false,
      hive: 'papercusp',
      cutAtEpoch: 3,
      deriveEpochKey,
    });
    expect(enc?.keyRef).toEqual({ via: 'epoch', hiveId: 'papercusp', epoch: 3 });
    expect(enc?.key).toEqual(EPOCH_KEY);
    expect(deriveEpochKey).toHaveBeenCalledWith('papercusp', 3);
  });

  it('an explicit --epoch (no workspace) also takes the epoch path', async () => {
    const deriveEpochKey = vi.fn(async () => EPOCH_KEY);
    const enc = await pickGitEncryption({ epochProvided: true, hive: 'papercusp', cutAtEpoch: 5, deriveEpochKey });
    expect(enc?.keyRef).toEqual({ via: 'epoch', hiveId: 'papercusp', epoch: 5 });
    expect(deriveEpochKey).toHaveBeenCalledWith('papercusp', 5);
  });

  it('no key + no epoch context ⇒ PLAINTEXT (undefined), never mints from the bare cutAtEpoch=0 guess', async () => {
    const deriveEpochKey = vi.fn(async () => EPOCH_KEY);
    const warn = vi.fn();
    const enc = await pickGitEncryption({ epochProvided: false, hive: 'papercusp', cutAtEpoch: 0, deriveEpochKey, warn });
    expect(enc).toBeUndefined();
    expect(deriveEpochKey).not.toHaveBeenCalled(); // guarded: never mint a divergent key from nothing
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/PLAINTEXT/));
  });

  it('a wrong-size epoch key from deriveEpochKey ⇒ throws (fail closed, never seal with a bad key)', async () => {
    const deriveEpochKey = vi.fn(async () => Uint8Array.from([1, 2, 3]));
    await expect(
      pickGitEncryption({ workspaceId: 'ws', epochProvided: false, hive: 'papercusp', cutAtEpoch: 0, deriveEpochKey }),
    ).rejects.toThrow(/expected 32/);
  });
});
