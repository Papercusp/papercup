import { describe, it, expect, vi } from 'vitest';
import {
  isHiveContributorRevoked,
  isPrAuthorRevoked,
  resolveHarnessPotHomeSlug,
} from './contribution-admission';

const WS = 'ws-1';
const HOME = 'papercusp-platform-hive';
const GH = 4242;

describe('isHiveContributorRevoked (PR-5 code-plane revocation)', () => {
  it('TEETH: a member whose only device is revoked IS revoked', async () => {
    const revoked = await isHiveContributorRevoked({
      workspaceId: WS,
      potHomeSlug: HOME,
      githubUserId: GH,
      loadDevicePubkeys: async () => ['pk-A'],
      loadRevoked: async () => new Set(['pk-A']),
    });
    expect(revoked).toBe(true);
  });

  it('TEETH: neutering the gate (treat revoked author as not-revoked) would re-open admission — every device revoked ⇒ true', async () => {
    const revoked = await isHiveContributorRevoked({
      workspaceId: WS,
      potHomeSlug: HOME,
      githubUserId: GH,
      loadDevicePubkeys: async () => ['pk-A', 'pk-B'],
      loadRevoked: async () => new Set(['pk-A', 'pk-B']),
    });
    expect(revoked).toBe(true);
  });

  it('a member with at least one ACTIVE (non-revoked) device is NOT revoked', async () => {
    const revoked = await isHiveContributorRevoked({
      workspaceId: WS,
      potHomeSlug: HOME,
      githubUserId: GH,
      loadDevicePubkeys: async () => ['pk-A', 'pk-B'],
      loadRevoked: async () => new Set(['pk-A']), // pk-B still active
    });
    expect(revoked).toBe(false);
  });

  it('a member with no revoked devices is NOT revoked', async () => {
    const revoked = await isHiveContributorRevoked({
      workspaceId: WS,
      potHomeSlug: HOME,
      githubUserId: GH,
      loadDevicePubkeys: async () => ['pk-A'],
      loadRevoked: async () => new Set<string>(),
    });
    expect(revoked).toBe(false);
  });

  it('a non-member / no bound devices is NOT revoked (the trust gate owns unknowns)', async () => {
    const revoked = await isHiveContributorRevoked({
      workspaceId: WS,
      potHomeSlug: HOME,
      githubUserId: GH,
      loadDevicePubkeys: async () => [],
      loadRevoked: async () => new Set(['pk-A']),
    });
    expect(revoked).toBe(false);
  });

  it('an invalid github id is NOT revoked (and reads nothing)', async () => {
    const loadDevicePubkeys = vi.fn();
    const revoked = await isHiveContributorRevoked({
      workspaceId: WS,
      potHomeSlug: HOME,
      githubUserId: 0,
      loadDevicePubkeys,
      loadRevoked: async () => new Set(),
    });
    expect(revoked).toBe(false);
    expect(loadDevicePubkeys).not.toHaveBeenCalled();
  });

  it('an empty workspace / hive slug is NOT revoked', async () => {
    expect(
      await isHiveContributorRevoked({ workspaceId: '', potHomeSlug: HOME, githubUserId: GH }),
    ).toBe(false);
    expect(
      await isHiveContributorRevoked({ workspaceId: WS, potHomeSlug: '', githubUserId: GH }),
    ).toBe(false);
  });

  it('FAIL-SAFE: a read error yields false (the trust gate still protects) + logs', async () => {
    const log = vi.fn();
    const revoked = await isHiveContributorRevoked({
      workspaceId: WS,
      potHomeSlug: HOME,
      githubUserId: GH,
      loadDevicePubkeys: async () => {
        throw new Error('pg down');
      },
      loadRevoked: async () => new Set(['pk-A']),
      log,
    });
    expect(revoked).toBe(false);
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toContain('revocation read failed');
  });
});

describe('resolveHarnessPotHomeSlug', () => {
  it('returns the project hive_slug (the hive home slug a member is registered under)', async () => {
    const home = await resolveHarnessPotHomeSlug('papercusp-platform', async () => ({
      hive_slug: HOME,
    }));
    expect(home).toBe(HOME);
  });

  it('returns null for a solo/unbound harness (no hive_slug)', async () => {
    expect(await resolveHarnessPotHomeSlug('solo', async () => ({}))).toBeNull();
    expect(await resolveHarnessPotHomeSlug('missing', async () => null)).toBeNull();
  });

  it('returns null (never throws) when resolution fails', async () => {
    const home = await resolveHarnessPotHomeSlug('boom', async () => {
      throw new Error('registry read failed');
    });
    expect(home).toBeNull();
  });
});

describe('isPrAuthorRevoked (harness→hive→revocation chokepoint)', () => {
  it('TEETH: a revoked author on the harness hive is refused', async () => {
    const revoked = await isPrAuthorRevoked({
      workspaceId: WS,
      harnessSlug: 'papercusp-platform',
      githubUserId: GH,
      resolveProject: async () => ({ hive_slug: HOME }),
      loadDevicePubkeys: async () => ['pk-A'],
      loadRevoked: async () => new Set(['pk-A']),
    });
    expect(revoked).toBe(true);
  });

  it('a solo/unbound harness (no hive) ⇒ no revocation applies', async () => {
    const loadDevicePubkeys = vi.fn();
    const revoked = await isPrAuthorRevoked({
      workspaceId: WS,
      harnessSlug: 'solo',
      githubUserId: GH,
      resolveProject: async () => ({}), // no hive_slug
      loadDevicePubkeys,
      loadRevoked: async () => new Set(['pk-A']),
    });
    expect(revoked).toBe(false);
    expect(loadDevicePubkeys).not.toHaveBeenCalled();
  });

  // ── Design-boundary observability (GAP review 2026-06-20, option b) ──
  it('OBSERVABILITY: a non-hive harness WITH substrate revocations → loud log, decision still false', async () => {
    const log = vi.fn();
    const revoked = await isPrAuthorRevoked({
      workspaceId: WS,
      harnessSlug: 'non-hive-shared',
      githubUserId: GH,
      resolveProject: async () => ({}), // hive_slug null → non-hive path
      probeLegacyRevocation: async () => new Set(['legacy-pk-1', 'legacy-pk-2']),
      log,
    });
    expect(revoked).toBe(false); // merge decision UNCHANGED (fail-safe by design)
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toContain('HIVE-ONLY by design');
  });

  it('a non-hive harness with NO substrate revocations → no log (quiet)', async () => {
    const log = vi.fn();
    const revoked = await isPrAuthorRevoked({
      workspaceId: WS,
      harnessSlug: 'non-hive-shared',
      githubUserId: GH,
      resolveProject: async () => ({}),
      probeLegacyRevocation: async () => new Set<string>(),
      log,
    });
    expect(revoked).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });

  it('the observability probe never throws / never affects the decision', async () => {
    const log = vi.fn();
    const revoked = await isPrAuthorRevoked({
      workspaceId: WS,
      harnessSlug: 'non-hive-shared',
      githubUserId: GH,
      resolveProject: async () => ({}),
      probeLegacyRevocation: async () => {
        throw new Error('contributors table read failed');
      },
      log,
    });
    expect(revoked).toBe(false);
    expect(log).not.toHaveBeenCalled(); // swallowed; no spurious warning
  });
});
