import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the committed constant to a non-null value so we can assert the fallback ORDER.
vi.mock('./canonical-hive-invite', () => ({
  CANONICAL_PAPERCUSP_HIVE_INVITE: { pubkeyBase64: 'CONST_PUB', inviteSecret: 'const_sec' },
}));

const { bakedCanonicalHiveInvite } = await import('./papercusp-hive-join');

describe('bakedCanonicalHiveInvite — precedence: explicit → env → committed constant (P-003)', () => {
  const prevPub = process.env.PAPERCUP_DOGFOOD_HIVE_PUBKEY;
  const prevSec = process.env.PAPERCUP_DOGFOOD_HIVE_INVITE_SECRET;
  beforeEach(() => {
    delete process.env.PAPERCUP_DOGFOOD_HIVE_PUBKEY;
    delete process.env.PAPERCUP_DOGFOOD_HIVE_INVITE_SECRET;
  });
  afterEach(() => {
    if (prevPub === undefined) delete process.env.PAPERCUP_DOGFOOD_HIVE_PUBKEY;
    else process.env.PAPERCUP_DOGFOOD_HIVE_PUBKEY = prevPub;
    if (prevSec === undefined) delete process.env.PAPERCUP_DOGFOOD_HIVE_INVITE_SECRET;
    else process.env.PAPERCUP_DOGFOOD_HIVE_INVITE_SECRET = prevSec;
  });

  it('falls back to the committed constant when there is no env + no explicit', () => {
    expect(bakedCanonicalHiveInvite()).toEqual({ pubkeyBase64: 'CONST_PUB', inviteSecret: 'const_sec' });
  });

  it('env OVERRIDES the committed constant (build-time staging override)', () => {
    process.env.PAPERCUP_DOGFOOD_HIVE_PUBKEY = 'ENV_PUB';
    process.env.PAPERCUP_DOGFOOD_HIVE_INVITE_SECRET = 'env_sec';
    expect(bakedCanonicalHiveInvite()).toEqual({ pubkeyBase64: 'ENV_PUB', inviteSecret: 'env_sec' });
  });

  it('an EMPTY env (the untracked --define default) does NOT shadow the constant', () => {
    process.env.PAPERCUP_DOGFOOD_HIVE_PUBKEY = '';
    process.env.PAPERCUP_DOGFOOD_HIVE_INVITE_SECRET = '';
    expect(bakedCanonicalHiveInvite()).toEqual({ pubkeyBase64: 'CONST_PUB', inviteSecret: 'const_sec' });
  });

  it('explicit overrides everything (test seam)', () => {
    process.env.PAPERCUP_DOGFOOD_HIVE_PUBKEY = 'ENV_PUB';
    process.env.PAPERCUP_DOGFOOD_HIVE_INVITE_SECRET = 'env_sec';
    expect(bakedCanonicalHiveInvite({ pubkeyBase64: 'X', inviteSecret: 'Y' })).toEqual({
      pubkeyBase64: 'X',
      inviteSecret: 'Y',
    });
  });
});
