/**
 * WI-38328 — presence must resolve its announce identity DURABLE-FIRST.
 *
 * The regression these guard: `defaultResolvePresenceIdentity` used to call
 * `resolveLocalAnnounceIdentity` unconditionally, which resolves an attestation
 * GIST via a live GitHub write — and then discarded it, because `PresenceIdentity`
 * carries no gist field. So presence hard-depended on a call whose result it threw
 * away, and a GitHub account that simply CANNOT create gists (no verified email →
 * 422, an account-level condition that no retry clears) went invisible to peers
 * forever. Observed on the local-matrix rig: 8/8 retries, both topics, 0 membership
 * rows converged to the joiner.
 *
 * Hermetic: the identity + hive-roster modules are mocked, so no gh, no keychain,
 * no PG. `swarm: {}` carries no `topicHex`, so the gossip-writer branch (and its
 * flag read) is never entered.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const resolveLocalAnnounceIdentity = vi.fn();
const resolveLocalAnnounceIdentityFromHiveMembers = vi.fn();
const listHiveMembersForLocalPot = vi.fn();

vi.mock('../local-announce-identity', () => ({
  resolveLocalAnnounceIdentity: (...a: unknown[]) => resolveLocalAnnounceIdentity(...a),
  resolveLocalAnnounceIdentityFromHiveMembers: (...a: unknown[]) =>
    resolveLocalAnnounceIdentityFromHiveMembers(...a),
}));

vi.mock('../../../federated-pot-scope', () => ({
  listHiveMembersForLocalPot: (...a: unknown[]) => listHiveMembersForLocalPot(...a),
}));

import { wirePresenceAnnounceForHarness, type PresenceWireHandle } from '../wire-presence';
import type { LocalWriteOp } from '../boot';

/** The shape `resolveLocalAnnounceIdentity`/`…FromHiveMembers` both return. */
const DURABLE_ID = {
  keychainId: '42:machine',
  devicePubkeyBase64: 'durable-pk',
  githubUserId: 42,
  githubLogin: 'owner',
  // Deliberately EMPTY — the whole point is that presence needs no gist. The rig's
  // owner frame carries exactly this in its pot_members attestation.
  attestationGistId: '',
};

const LIVE_ID = {
  keychainId: '7:machine',
  devicePubkeyBase64: 'live-pk',
  githubUserId: 7,
  githubLogin: 'joiner',
  attestationGistId: 'gist-abc',
};

/** The real GitHub refusal, verbatim from the rig's serve-a log. */
const GIST_422 = new Error(
  'GitHub API returned 422: {"message":"Validation Failed","errors":[{"resource":"Gist",' +
    '"code":"custom","field":"user","message":"user must have a verified email"}]}',
);

function mockHandle(): { handle: PresenceWireHandle; appended: LocalWriteOp[] } {
  const appended: LocalWriteOp[] = [];
  return {
    appended,
    handle: {
      workspaceId: 'ws',
      harnessSlug: 'repo-a',
      ownLog: { keyHex: 'abc' },
      append: async (op) => {
        appended.push(op);
      },
      swarm: {},
      registerCloseHook: () => () => {},
    },
  };
}

const noTick = () => 0 as unknown as ReturnType<typeof setInterval>;

async function wire(handle: PresenceWireHandle, potSlug: string | null = 'my-hive') {
  return wirePresenceAnnounceForHarness(handle, {
    resolvePotSlug: async () => potSlug,
    setIntervalFn: noTick,
    now: () => 1000,
  });
}

describe('WI-38328 — presence resolves its announce identity durable-first', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listHiveMembersForLocalPot.mockResolvedValue([{ githubUserId: 42 }]);
    resolveLocalAnnounceIdentityFromHiveMembers.mockResolvedValue(DURABLE_ID);
    resolveLocalAnnounceIdentity.mockResolvedValue(LIVE_ID);
  });

  it('announces from the durable Hive binding WITHOUT any live GitHub round-trip', async () => {
    const { handle, appended } = mockHandle();
    const loop = await wire(handle);
    await loop!.tickOnce();

    expect(appended).toHaveLength(1);
    expect(String(appended[0].hbKey)).toMatch(/^42\//);
    // The property that matters: the gist-resolving path is never even reached.
    expect(resolveLocalAnnounceIdentity).not.toHaveBeenCalled();
    expect(listHiveMembersForLocalPot).toHaveBeenCalledWith('ws', 'my-hive');
  });

  it('THE REGRESSION: a gist-422 no longer silences presence for a known member', async () => {
    resolveLocalAnnounceIdentity.mockRejectedValue(GIST_422);
    const { handle, appended } = mockHandle();
    const loop = await wire(handle);
    await loop!.tickOnce();

    // Before the fix this appended NOTHING and logged "announcing NOTHING" forever.
    expect(appended).toHaveLength(1);
    expect(String(appended[0].hbKey)).toMatch(/^42\//);
  });

  it('still uses the LIVE resolver for a first-time member with no durable row', async () => {
    resolveLocalAnnounceIdentityFromHiveMembers.mockResolvedValue(null);
    const { handle, appended } = mockHandle();
    const loop = await wire(handle);
    await loop!.tickOnce();

    expect(resolveLocalAnnounceIdentity).toHaveBeenCalledTimes(1);
    expect(appended).toHaveLength(1);
    expect(String(appended[0].hbKey)).toMatch(/^7\//);
  });

  it('a non-Hive harness (no pot slug) skips the roster read entirely', async () => {
    const { handle, appended } = mockHandle();
    const loop = await wire(handle, null);
    await loop!.tickOnce();

    expect(listHiveMembersForLocalPot).not.toHaveBeenCalled();
    expect(resolveLocalAnnounceIdentity).toHaveBeenCalledTimes(1);
    expect(appended).toHaveLength(1);
  });

  it('an unreadable roster falls through to the live resolver instead of throwing', async () => {
    listHiveMembersForLocalPot.mockRejectedValue(new Error('projection unavailable'));
    const { handle, appended } = mockHandle();
    const loop = await wire(handle);
    await loop!.tickOnce();

    expect(resolveLocalAnnounceIdentity).toHaveBeenCalledTimes(1);
    expect(appended).toHaveLength(1);
  });

  it('when NEITHER path resolves, the warning names the real cause', async () => {
    resolveLocalAnnounceIdentityFromHiveMembers.mockResolvedValue(null);
    resolveLocalAnnounceIdentity.mockRejectedValue(GIST_422);
    const { handle, appended } = mockHandle();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const loop = await wire(handle);
      await loop!.tickOnce();

      expect(appended).toHaveLength(0);
      const msg = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(msg).toContain('no swarm identity');
      expect(msg).toContain('announcing NOTHING');
      // The diagnostic gap this closes: the old line could only GUESS
      // ("expected on a gh-unauthenticated box"), so a permanent GitHub-side
      // refusal was indistinguishable from a transient auth gap.
      expect(msg).toContain('user must have a verified email');
    } finally {
      warn.mockRestore();
    }
  });
});
