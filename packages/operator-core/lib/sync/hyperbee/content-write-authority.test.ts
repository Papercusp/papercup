import { describe, it, expect } from 'vitest';
import {
  decideContentWriteAuthority,
  resolveContentWriteMode,
  type WriteAuthorityInput,
} from './content-write-authority';

const base: Omit<WriteAuthorityInput, 'mode'> = {
  ownerIdentity: null,
  opIdentity: null,
};

describe('decideContentWriteAuthority', () => {
  it('member mode always allows and never binds (today trusted-hive behavior)', () => {
    expect(decideContentWriteAuthority({ ...base, mode: 'member', opIdentity: 'A', ownerIdentity: 'B' }))
      .toEqual({ decision: 'allow', bindOwner: false, reason: 'member-mode' });
    // even an unidentified op in member mode is allowed
    expect(decideContentWriteAuthority({ ...base, mode: 'member' }).decision).toBe('allow');
  });

  describe('author-scoped mode', () => {
    it('first identified writer claims ownership (allow + bindOwner)', () => {
      expect(
        decideContentWriteAuthority({ mode: 'author-scoped', ownerIdentity: null, opIdentity: 'A' }),
      ).toEqual({ decision: 'allow', bindOwner: true, reason: 'first-write-bind' });
    });

    it('an UNIDENTIFIED op on an unbound key is rejected fail-closed', () => {
      expect(
        decideContentWriteAuthority({ mode: 'author-scoped', ownerIdentity: null, opIdentity: null }),
      ).toEqual({ decision: 'reject', reason: 'unidentified' });
    });

    it('the owner may overwrite/delete their own row', () => {
      expect(
        decideContentWriteAuthority({ mode: 'author-scoped', ownerIdentity: 'A', opIdentity: 'A' }),
      ).toEqual({ decision: 'allow', bindOwner: false, reason: 'owner' });
    });

    it('a NON-owner member is rejected (the core D-012 fix — no deleting others plans)', () => {
      expect(
        decideContentWriteAuthority({ mode: 'author-scoped', ownerIdentity: 'A', opIdentity: 'B' }),
      ).toEqual({ decision: 'reject', reason: 'not-owner' });
    });

    it('a privileged identity (hive owner / moderator) may override — takedown/repair', () => {
      expect(
        decideContentWriteAuthority({
          mode: 'author-scoped',
          ownerIdentity: 'A',
          opIdentity: 'MOD',
          privilegedIdentities: new Set(['MOD']),
        }),
      ).toEqual({ decision: 'allow', bindOwner: false, reason: 'privileged' });
    });

    it('privileged check takes precedence even on an unbound key (no spurious bind)', () => {
      expect(
        decideContentWriteAuthority({
          mode: 'author-scoped',
          ownerIdentity: null,
          opIdentity: 'MOD',
          privilegedIdentities: new Set(['MOD']),
        }),
      ).toEqual({ decision: 'allow', bindOwner: false, reason: 'privileged' });
    });
  });
});

describe('resolveContentWriteMode', () => {
  it('explicit policy field wins', () => {
    expect(resolveContentWriteMode({ contentWriteAuthority: 'author-scoped' })).toBe('author-scoped');
    expect(resolveContentWriteMode({ contentWriteAuthority: 'member', membership: 'open' })).toBe('member');
  });
  it('an open hive defaults to author-scoped (public-hive safety, D-012)', () => {
    expect(resolveContentWriteMode({ membership: 'open' })).toBe('author-scoped');
  });
  it('trusted / no-policy hives default to member (today behavior)', () => {
    expect(resolveContentWriteMode({ membership: 'allowlist' })).toBe('member');
    expect(resolveContentWriteMode({ membership: 'approval' })).toBe('member');
    expect(resolveContentWriteMode(null)).toBe('member');
    expect(resolveContentWriteMode({})).toBe('member');
  });
});
