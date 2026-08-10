/**
 * EI-20042650315152947 — the PRODUCTION reader's source wiring.
 *
 * `holds-a-lock-on` was wired on the `coord:presence` path (11 calls ever) and
 * NOT on the `coord:send` divergence path — the only coupling path that runs at
 * volume. Result: 0 edges in 14 days. The cause was not a bad value but a
 * MISSING ARGUMENT: `couplingSourcesFor` omits the `heldFiles` source entirely
 * when `coordinationDomain` is absent (coupling-sources.ts:201-206), so the
 * relation was structurally underivable rather than merely empty.
 *
 * That distinction is why this file exists at all. An "is the relation ever
 * produced?" test passes vacuously against the broken code — no lock fixture
 * means no edge either way — so the only non-vacuous assertion is on the CALL
 * ITSELF: did the reader hand `couplingSourcesFor` a domain?
 *
 * These tests live in their own file rather than in
 * `coupling-divergence-stamp.test.ts` deliberately: that suite exercises the
 * INJECTED `PeerRelationsReader` and declares no module mocks, and adding
 * hoisted `vi.mock` calls to it would silently re-scope all four of its existing
 * describes (the mock-ordering trap this repo has been bitten by before).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const couplingSourcesFor = vi.fn(() => ({}));
const lockCoordinationDomain = vi.fn(() => '/repo/root');

vi.mock('./coupling-sources', () => ({
  couplingSourcesFor: (...args: unknown[]) => couplingSourcesFor(...(args as [])),
}));
vi.mock('../locks/coordination-domain', () => ({
  lockCoordinationDomain: () => lockCoordinationDomain(),
}));
vi.mock('./presence-snapshot', () => ({
  resolvePresenceScope: async () => ({}),
  assemblePresenceSnapshot: async () => ({ active: [{ ownerId: 'peer-1' }] }),
}));
vi.mock('../../coord/coupling-derivation', () => ({
  deriveCouplings: async () => [],
}));
vi.mock('../../coord/couplings', () => ({
  listCouplingsFor: async () => [],
  resolveCoupledPeers: () => [],
}));

const { readPeerRelations } = await import('./coupling-divergence-stamp');

const firstCallOpts = () =>
  couplingSourcesFor.mock.calls[0]?.[0] as { coordinationDomain?: string } | undefined;

describe('EI-20042650315152947 — the send path must request the lock-hold source', () => {
  beforeEach(() => {
    couplingSourcesFor.mockClear();
    lockCoordinationDomain.mockClear();
    lockCoordinationDomain.mockReturnValue('/repo/root');
  });

  it('passes a coordinationDomain, so heldFiles is actually built', async () => {
    await readPeerRelations('self-owner', { workspaceId: 'ws', harnessSlug: 'papercusp' });

    // The whole bug in one assertion: pre-fix this key was absent, which made
    // `holds-a-lock-on` impossible to derive on the only path that runs.
    expect(couplingSourcesFor).toHaveBeenCalledTimes(1);
    expect(firstCallOpts()?.coordinationDomain).toBe('/repo/root');
  });

  it('still passes the scope it already passed (no regression in the fix)', async () => {
    await readPeerRelations('self-owner', { workspaceId: 'ws', harnessSlug: 'papercusp' });

    expect(firstCallOpts()).toMatchObject({
      selfOwnerId: 'self-owner',
      workspaceId: 'ws',
      harnessSlug: 'papercusp',
      rosterOwnerIds: ['peer-1'],
    });
  });

  it('degrades fail-soft when the domain cannot be resolved — never fails a send', async () => {
    lockCoordinationDomain.mockImplementation(() => {
      throw new Error('no repo root');
    });

    // Must RESOLVE, not reject: this runs inside coord:send, where a thrown
    // measurement would eat a message.
    await expect(
      readPeerRelations('self-owner', { workspaceId: 'ws', harnessSlug: 'papercusp' }),
    ).resolves.toBeInstanceOf(Map);

    // ...and it degrades to the OLD behaviour (no lock signal) rather than
    // passing a bogus domain that would key the lock read to the wrong tree.
    expect(firstCallOpts()?.coordinationDomain).toBeUndefined();
  });
});
