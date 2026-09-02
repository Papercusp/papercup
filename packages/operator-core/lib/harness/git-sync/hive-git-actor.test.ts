/**
 * hive-git-actor.test.ts — P-203 Leg A: a git-sync hive leg must act as the
 * device its harness's swarm announce/hello carries, never as a separately
 * resolved gh-login device. The two split on the tower (gh=papercupai,
 * announce=aviynw) and every VM→tower dial missed for the pair's whole life.
 *
 * Pure unit test over `pickHiveGitActor`.
 */
import { describe, expect, it } from 'vitest';
import { pickHiveGitActor } from './hive-git-actor';

const keychain = (id: number) => `${id}:test-box`;

describe('pickHiveGitActor (P-203 Leg A identity split)', () => {
  it('prefers the booted swarm identity over a DIFFERENT gh-login device', () => {
    // The tower shape: swarm greets as aviynw's device, gh is logged in as papercupai.
    const actor = pickHiveGitActor(
      { devicePubkeyBase64: 'XPAsvso1-aviynw', githubUserId: 1567022, keychainId: '1567022:tower' },
      { githubUserId: 279242982, devicePubkey: 'IXfGu216-papercupai' },
      keychain,
    );
    expect(actor).toEqual({
      githubUserId: 1567022,
      devicePubkey: 'XPAsvso1-aviynw',
      keychainId: '1567022:tower',
      source: 'booted-swarm',
    });
  });

  it('uses the swarm identity even when gh is unauthenticated (identity must not ride on gh reachability)', () => {
    const actor = pickHiveGitActor(
      { devicePubkeyBase64: 'dev', githubUserId: 7, keychainId: '7:box' },
      null,
      keychain,
    );
    expect(actor?.source).toBe('booted-swarm');
    expect(actor?.devicePubkey).toBe('dev');
  });

  it('falls back to the gh-login actor, deriving its keychain, when no swarm identity exists', () => {
    const actor = pickHiveGitActor(null, { githubUserId: 42, devicePubkey: 'gh-dev' }, keychain);
    expect(actor).toEqual({
      githubUserId: 42,
      devicePubkey: 'gh-dev',
      keychainId: '42:test-box',
      source: 'gh-login',
    });
  });

  it('treats a swarm identity with no device or keychain as absent (fallback, not a half-identity)', () => {
    const actor = pickHiveGitActor(
      { devicePubkeyBase64: '', githubUserId: 7, keychainId: '' },
      { githubUserId: 42, devicePubkey: 'gh-dev' },
      keychain,
    );
    expect(actor?.source).toBe('gh-login');
  });

  it('returns null when neither identity exists — nothing to sign or dial as', () => {
    expect(pickHiveGitActor(null, null, keychain)).toBeNull();
    expect(pickHiveGitActor(undefined, undefined, keychain)).toBeNull();
  });
});
