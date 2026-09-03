import { describe, expect, it, vi } from 'vitest';

import {
  decideTerminalOwnerOriginHeal,
  selfHealTerminalOwnerOriginIfStranded,
} from './work-items-terminal-owner-origin-heal';

/**
 * EI-22189521072988065 — a locally-closed row that federates to `origin:'remote'`
 * could never be upgraded from `completionAuthority:'proposed'`, because the
 * existing self-heal (`selfHealAuthorOriginIfStranded`) exempts only the row's
 * `created_by`, not the different peer who actually claimed and CLOSED it
 * (`terminal_owner`).
 *
 * Mirrors `work-items-orphan-author.test.ts`'s shape: the pure policy is tested
 * directly (no database), and each SAFETY case is asserted explicitly so a future
 * edit that widens the hatch fails loudly here first.
 */
describe('decideTerminalOwnerOriginHeal', () => {
  const CALLER = 'su-4a6e2255-f324-4774-a05e-c3bc87e643ac';

  it('permits when the caller is the row\'s recorded terminal_owner on an already-settled remote row', () => {
    expect(
      decideTerminalOwnerOriginHeal({
        origin: 'remote',
        wasAlreadySettled: true,
        terminalOwner: CALLER,
        callerOwnerId: CALLER,
      }),
    ).toEqual({ permit: true, reason: 'terminal-owner-match' });
  });

  it('leaves a local-origin row untouched by this policy', () => {
    expect(
      decideTerminalOwnerOriginHeal({
        origin: 'local',
        wasAlreadySettled: true,
        terminalOwner: CALLER,
        callerOwnerId: CALLER,
      }),
    ).toEqual({ permit: false, reason: 'not-remote' });
  });

  it('SCOPING: refuses a fresh (not-yet-settled) completion — this is never a fresh-completion bypass', () => {
    // The whole point of the guard is to re-affirm evidence on a row that was
    // ALREADY terminal before this call. A row still becoming terminal in THIS
    // call must go through the ordinary completion path, not this hatch.
    expect(
      decideTerminalOwnerOriginHeal({
        origin: 'remote',
        wasAlreadySettled: false,
        terminalOwner: CALLER,
        callerOwnerId: CALLER,
      }),
    ).toEqual({ permit: false, reason: 'not-already-settled' });
  });

  it('a row with no recorded terminal_owner is not provably re-closeable by anyone', () => {
    for (const terminalOwner of [null, undefined, '']) {
      expect(
        decideTerminalOwnerOriginHeal({
          origin: 'remote',
          wasAlreadySettled: true,
          terminalOwner,
          callerOwnerId: CALLER,
        }),
      ).toEqual({ permit: false, reason: 'no-recorded-terminal-owner' });
    }
  });

  it('SAFETY: refuses when the caller is neither the creator nor the recorded terminal_owner', () => {
    // The failure this guards against: opening the hatch to ANY caller on an
    // already-settled remote row would let a stranger re-write evidence on work
    // a different peer actually did. Only the row's OWN recorded closer qualifies.
    expect(
      decideTerminalOwnerOriginHeal({
        origin: 'remote',
        wasAlreadySettled: true,
        terminalOwner: CALLER,
        callerOwnerId: 'su-some-other-peer',
      }),
    ).toEqual({ permit: false, reason: 'caller-not-terminal-owner' });
  });

  it('SAFETY: an absent caller identity is refused, never treated as a match', () => {
    for (const callerOwnerId of [null, undefined, '']) {
      expect(
        decideTerminalOwnerOriginHeal({
          origin: 'remote',
          wasAlreadySettled: true,
          terminalOwner: CALLER,
          callerOwnerId,
        }),
      ).toEqual({ permit: false, reason: 'caller-not-terminal-owner' });
    }
  });
});

describe('selfHealTerminalOwnerOriginIfStranded', () => {
  const CALLER = 'su-4a6e2255-f324-4774-a05e-c3bc87e643ac';

  it('no-ops without touching the database when the policy refuses', async () => {
    const sql = vi.fn(async () => [] as { feature_id: string }[]);
    vi.doMock('@papercusp/db-org', async (orig) => ({
      ...(await orig<typeof import('@papercusp/db-org')>()),
      getOrgPg: () => ({ sql }),
    }));
    vi.resetModules();
    const { selfHealTerminalOwnerOriginIfStranded: heal } = await import(
      './work-items-terminal-owner-origin-heal'
    );
    const healed = await heal('EI-1', 'su-not-the-owner', {
      origin: 'remote',
      wasAlreadySettled: true,
      terminalOwner: CALLER,
    });
    expect(healed).toBe(false);
    expect(sql).not.toHaveBeenCalled();
    vi.doUnmock('@papercusp/db-org');
    vi.resetModules();
  });

  it('returns false without a call when `id` is falsy, even for an otherwise-permitted caller', async () => {
    const healed = await selfHealTerminalOwnerOriginIfStranded('', CALLER, {
      origin: 'remote',
      wasAlreadySettled: true,
      terminalOwner: CALLER,
    });
    expect(healed).toBe(false);
  });

  it('writes origin back to local, scoped to feature_id + terminal_owner, and reports true on a matched row', async () => {
    const sql = vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      // The caller (opts.by / terminal_owner) must be interpolated into the WHERE
      // clause — asserting the actual bound values, not just that SOME query ran.
      expect(values).toContain('EI-1');
      expect(values).toContain(CALLER);
      return [{ feature_id: 'EI-1' }];
    });
    vi.doMock('@papercusp/db-org', async (orig) => ({
      ...(await orig<typeof import('@papercusp/db-org')>()),
      getOrgPg: () => ({ sql }),
    }));
    vi.resetModules();
    const { selfHealTerminalOwnerOriginIfStranded: heal } = await import(
      './work-items-terminal-owner-origin-heal'
    );
    const healed = await heal('EI-1', CALLER, {
      origin: 'remote',
      wasAlreadySettled: true,
      terminalOwner: CALLER,
    });
    expect(healed).toBe(true);
    expect(sql).toHaveBeenCalledTimes(1);
    vi.doUnmock('@papercusp/db-org');
    vi.resetModules();
  });

  it('reports false when the scoped UPDATE matches no row (e.g. terminal_owner changed underneath it)', async () => {
    const sql = vi.fn(async () => [] as { feature_id: string }[]);
    vi.doMock('@papercusp/db-org', async (orig) => ({
      ...(await orig<typeof import('@papercusp/db-org')>()),
      getOrgPg: () => ({ sql }),
    }));
    vi.resetModules();
    const { selfHealTerminalOwnerOriginIfStranded: heal } = await import(
      './work-items-terminal-owner-origin-heal'
    );
    const healed = await heal('EI-1', CALLER, {
      origin: 'remote',
      wasAlreadySettled: true,
      terminalOwner: CALLER,
    });
    expect(healed).toBe(false);
    expect(sql).toHaveBeenCalledTimes(1);
    vi.doUnmock('@papercusp/db-org');
    vi.resetModules();
  });
});
