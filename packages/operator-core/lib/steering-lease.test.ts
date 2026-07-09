/**
 * steering-lease.test.ts — the per-Hive single-steerer lease
 * (hive-network-surface-2026-06-11 P-011 / D-004).
 *
 * The lease rides the existing per-Hive lock authority: holder commits,
 * non-holders propose, EVERYTHING fails open. Unit-level with injected
 * resolution seams; the setWorkItemPriority gate's PG leg lives in
 * work-items-priority.integration.test.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  __setSteeringLeaseTestDeps,
  checkSteeringLease,
  recordSteeringProposal,
} from './steering-lease';

afterEach(() => __setSteeringLeaseTestDeps(null));

const WS = 'ws-lease';

describe('checkSteeringLease — holder resolution over the per-Hive authority', () => {
  it('a harness in NO Hive is always holder (lease does not apply)', async () => {
    const v = await checkSteeringLease(WS, 'lone-harness', {
      resolveHive: async () => null,
      hiveAuthority: async () => {
        throw new Error('must not be called');
      },
    });
    expect(v).toEqual({ holder: true, reason: 'not-in-hive' });
  });

  it('the authority Swarm holds the lease (incl. trivially at N=1)', async () => {
    const v = await checkSteeringLease(WS, 'member', {
      resolveHive: async () => 'the-hive',
      hiveAuthority: async () => ({ isSelf: true, liveCount: 1 }),
    });
    expect(v.holder).toBe(true);
    expect(v.reason).toBe('authority');
    expect(v.potSlug).toBe('the-hive');
    expect(v.liveCount).toBe(1);
  });

  it('a remote authority ⇒ non-holder, labelled by machine (pubkey fallback)', async () => {
    const v = await checkSteeringLease(WS, 'member', {
      resolveHive: async () => 'the-hive',
      hiveAuthority: async () => ({
        isSelf: false,
        liveCount: 2,
        peer: { devicePubkey: 'pk-abcdef1234567890', githubUserId: 7, machineLabel: 'box-b' },
      }),
    });
    expect(v.holder).toBe(false);
    expect(v.reason).toBe('remote-holder');
    expect(v.holderLabel).toBe('box-b');

    const noLabel = await checkSteeringLease(WS, 'member', {
      resolveHive: async () => 'the-hive',
      hiveAuthority: async () => ({
        isSelf: false,
        liveCount: 2,
        peer: { devicePubkey: 'pk-abcdef1234567890', githubUserId: 7, machineLabel: '' },
      }),
    });
    expect(noLabel.holderLabel).toBe('pk-abcdef123…');
  });

  it('FAILS OPEN on resolution errors — hive lookup and election alike (D-004)', async () => {
    const hiveThrows = await checkSteeringLease(WS, 'member', {
      resolveHive: async () => {
        throw new Error('fixture has no hives table');
      },
    });
    expect(hiveThrows).toEqual({ holder: true, reason: 'fail-open' });

    const electionThrows = await checkSteeringLease(WS, 'member', {
      resolveHive: async () => 'the-hive',
      hiveAuthority: async () => {
        throw new Error('presence outage');
      },
    });
    expect(electionThrows).toEqual({ holder: true, reason: 'fail-open' });
  });

  it('module-level test deps (the work-items gate seam) resolve like call deps', async () => {
    __setSteeringLeaseTestDeps({
      resolveHive: async () => 'injected-hive',
      hiveAuthority: async () => ({ isSelf: false, liveCount: 3 }),
    });
    const v = await checkSteeringLease(WS, 'member');
    expect(v.holder).toBe(false);
    expect(v.potSlug).toBe('injected-hive');
    expect(v.holderLabel).toBe('an unidentified peer Swarm'); // no peer ref resolved
  });
});

// P-021 (I2 / queen-guard D-008): a recorded queen-home device pubkey OVERRIDES the
// lock-authority election — the owner deployed the Queen on a chosen Swarm, so that
// Swarm steers regardless of incidental pubkey ordering. Unset (every Hive today) ⇒
// fall through to the election, so behaviour is unchanged until a home is recorded.
describe('checkSteeringLease — P-021 queen-home override of the election', () => {
  it('home == self ⇒ holder (reason queen-home), election NOT consulted', async () => {
    const v = await checkSteeringLease(WS, 'member', {
      resolveHive: async () => 'the-hive',
      resolveQueenHome: async () => 'pk-home',
      resolveSelfPubkey: async () => 'pk-home',
      hiveAuthority: async () => {
        throw new Error('election must not be consulted when home decides');
      },
    });
    expect(v).toMatchObject({ holder: true, reason: 'queen-home', potSlug: 'the-hive' });
  });

  it('home != self ⇒ non-holder (reason not-queen-home), labelled by the recorded home', async () => {
    const v = await checkSteeringLease(WS, 'member', {
      resolveHive: async () => 'the-hive',
      resolveQueenHome: async () => 'pk-home-abcdef0123456789',
      resolveSelfPubkey: async () => 'pk-other',
      hiveAuthority: async () => {
        throw new Error('election must not be consulted when home decides');
      },
    });
    expect(v.holder).toBe(false);
    expect(v.reason).toBe('not-queen-home');
    expect(v.holderLabel).toContain('pk-home-abcd'); // short form of the recorded home
  });

  it('home SET but self UNRESOLVED ⇒ falls through to the election (never strand a lone box)', async () => {
    const v = await checkSteeringLease(WS, 'member', {
      resolveHive: async () => 'the-hive',
      resolveQueenHome: async () => 'pk-home',
      resolveSelfPubkey: async () => null, // gh-unauthenticated / no device identity
      hiveAuthority: async () => ({ isSelf: true, liveCount: 1 }),
    });
    expect(v).toMatchObject({ holder: true, reason: 'authority' });
  });

  it('home UNSET ⇒ unchanged: the election decides (today’s universal state)', async () => {
    const v = await checkSteeringLease(WS, 'member', {
      resolveHive: async () => 'the-hive',
      resolveQueenHome: async () => null,
      resolveSelfPubkey: async () => {
        throw new Error('self must not be resolved when no home is recorded');
      },
      hiveAuthority: async () => ({ isSelf: false, liveCount: 2 }),
    });
    expect(v.holder).toBe(false);
    expect(v.reason).toBe('remote-holder');
  });
});

describe('recordSteeringProposal — the propose half (comment + escalation)', () => {
  it('lands both sinks with the request, the holder, and the dispose instruction', async () => {
    const comments: { featureId: string; harness: string; body: string }[] = [];
    const escalations: { summary: string; body: string }[] = [];
    await recordSteeringProposal(
      {
        workspaceId: WS,
        harnessSlug: 'member',
        featureId: 'F-042',
        requestedOrder: 3,
        potSlug: 'the-hive',
        holderLabel: 'box-b',
      },
      {
        comment: async (c) => {
          comments.push(c);
        },
        escalate: async (e) => {
          escalations.push(e);
        },
      },
    );
    expect(comments).toHaveLength(1);
    expect(comments[0].featureId).toBe('F-042');
    expect(comments[0].body).toContain('feature_order=3');
    expect(comments[0].body).toContain('box-b');
    expect(comments[0].body).toContain('NOT committed');
    expect(comments[0].body).toContain('work_items:set_priority');
    expect(escalations).toHaveLength(1);
    expect(escalations[0].summary).toContain('member/F-042');
    expect(escalations[0].summary).toContain('box-b');
  });

  it('a null requestedOrder reads as an unprioritize proposal', async () => {
    const escalations: { summary: string; body: string }[] = [];
    await recordSteeringProposal(
      {
        workspaceId: WS,
        harnessSlug: 'member',
        featureId: 'F-042',
        requestedOrder: null,
        potSlug: 'the-hive',
        holderLabel: 'box-b',
      },
      { comment: async () => {}, escalate: async (e) => void escalations.push(e) },
    );
    expect(escalations[0].summary).toContain('unprioritize');
  });

  it('one sink failing never fails the proposal (best-effort individually)', async () => {
    const escalations: { summary: string; body: string }[] = [];
    await expect(
      recordSteeringProposal(
        {
          workspaceId: WS,
          harnessSlug: 'member',
          featureId: 'F-042',
          requestedOrder: 1,
          potSlug: 'the-hive',
          holderLabel: 'box-b',
        },
        {
          comment: async () => {
            throw new Error('threads table missing');
          },
          escalate: async (e) => void escalations.push(e),
        },
      ),
    ).resolves.toBeUndefined();
    expect(escalations).toHaveLength(1);
  });
});
