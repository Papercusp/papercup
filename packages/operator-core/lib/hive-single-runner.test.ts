/**
 * hive-single-runner.test.ts — the per-Hive SINGLE-RUNNER gate for node-local
 * cadence loops (domain-generic-hive-architecture-2026-06-18 P-019 / P-020).
 *
 * Two layers of coverage:
 *  1. the resolution shape over an INJECTED `hiveAuthority` (mirrors the sibling
 *     steering-lease.test): not-in-hive / authority / remote-runner / fail-open;
 *  2. the genuine MULTI-NODE election driven through the REAL `lockAuthorityForHive`
 *     (`authorityDeps` = a fake presence roster + self identity + clock — the exact
 *     seam the 2-swarm composition rig wires): two nodes of one Hive, exactly ONE
 *     runs; the lowest live device_pubkey is the runner; a stale leader fails over
 *     to the next-lowest with zero coordination (D-014's "lease-current-first else
 *     lowest-pubkey" liveness property), proven deterministically without a network.
 */
import { describe, expect, it } from 'vitest';
import { checkHiveSingleRunner, isHiveSingleRunner } from './hive-single-runner';
import type { LockAuthorityDeps } from './authority/lock-authority';

const WS = 'ws-runner';

describe('checkHiveSingleRunner — resolution over the per-Hive authority', () => {
  it('a harness in NO Hive always runs (gate does not apply — standalone path)', async () => {
    const v = await checkHiveSingleRunner(WS, 'lone-harness', {
      resolveHive: async () => null,
      hiveAuthority: async () => {
        throw new Error('must not be called');
      },
    });
    expect(v).toEqual({ run: true, reason: 'not-in-hive' });
  });

  it('the authority Swarm runs (incl. trivially at N=1)', async () => {
    const v = await checkHiveSingleRunner(WS, 'the-hive', {
      resolveHive: async () => 'the-hive',
      hiveAuthority: async () => ({ isSelf: true, liveCount: 1 }),
    });
    expect(v).toEqual({ run: true, reason: 'authority', hiveSlug: 'the-hive', liveCount: 1 });
  });

  it('a remote authority ⇒ this node stands down, labelled by machine (pubkey fallback)', async () => {
    const v = await checkHiveSingleRunner(WS, 'member', {
      resolveHive: async () => 'the-hive',
      hiveAuthority: async () => ({
        isSelf: false,
        liveCount: 2,
        peer: { devicePubkey: 'pk-abcdef1234567890', githubUserId: 7, machineLabel: 'box-b' },
      }),
    });
    expect(v.run).toBe(false);
    expect(v.reason).toBe('remote-runner');
    expect(v.runnerLabel).toBe('box-b');

    const noLabel = await checkHiveSingleRunner(WS, 'member', {
      resolveHive: async () => 'the-hive',
      hiveAuthority: async () => ({
        isSelf: false,
        liveCount: 2,
        peer: { devicePubkey: 'pk-abcdef1234567890', githubUserId: 7, machineLabel: '' },
      }),
    });
    expect(noLabel.runnerLabel).toBe('pk-abcdef123…');
  });

  it('FAILS OPEN (runs) on resolution errors — hive lookup and election alike (D-004)', async () => {
    const hiveThrows = await checkHiveSingleRunner(WS, 'member', {
      resolveHive: async () => {
        throw new Error('fixture has no hives table');
      },
    });
    expect(hiveThrows).toEqual({ run: true, reason: 'fail-open' });

    const electionThrows = await checkHiveSingleRunner(WS, 'member', {
      resolveHive: async () => 'the-hive',
      hiveAuthority: async () => {
        throw new Error('presence outage');
      },
    });
    expect(electionThrows).toEqual({ run: true, reason: 'fail-open' });
  });

  it('isHiveSingleRunner is the bare-boolean convenience', async () => {
    expect(await isHiveSingleRunner(WS, 'h', { resolveHive: async () => null })).toBe(true);
    expect(
      await isHiveSingleRunner(WS, 'h', {
        resolveHive: async () => 'the-hive',
        hiveAuthority: async () => ({ isSelf: false, liveCount: 2 }),
      }),
    ).toBe(false);
  });
});

// ── The genuine multi-node proof: drive the REAL lockAuthorityForHive election ──
// via authorityDeps (the same fetchHivePresenceRows + resolveSelf + now seam the
// 2-swarm composition rig wires). This exercises the actual argmin/staleness core
// every production node computes from the federated presence roster.
describe('checkHiveSingleRunner — MULTI-NODE single-runner via the real election', () => {
  const NOW = 1_700_000_000_000;
  const HIVE = 'shared-hive';
  // Two nodes of one shared Hive. Node A's device_pubkey sorts below node B's.
  const PK_A = 'aaa-node';
  const PK_B = 'bbb-node';
  const row = (pk: string, ageMs = 0) => ({
    device_pubkey: pk,
    github_user_id: pk === PK_A ? 1 : 2,
    machine_label: pk,
    last_seen_ms: NOW - ageMs,
  });

  /** A node's gate deps: it resolves itself + reads the SHARED Hive presence roster. */
  const nodeDeps = (
    selfPk: string,
    roster: ReturnType<typeof row>[],
  ): { resolveHive: () => Promise<string>; authorityDeps: LockAuthorityDeps } => ({
    resolveHive: async () => HIVE,
    authorityDeps: {
      fetchHivePresenceRows: async (h) => {
        expect(h).toBe(HIVE);
        return roster;
      },
      resolveSelf: async () => ({ githubUserId: selfPk === PK_A ? 1 : 2, devicePubkey: selfPk }),
      now: () => NOW,
      // Disable the global eviction monitor so the test is hermetic (staleness only).
      evictionMonitor: null,
    },
  });

  it('two live nodes of one Hive ⇒ EXACTLY ONE runs (the lowest live pubkey)', async () => {
    const roster = [row(PK_A), row(PK_B)];
    const onA = await checkHiveSingleRunner(WS, HIVE, nodeDeps(PK_A, roster));
    const onB = await checkHiveSingleRunner(WS, HIVE, nodeDeps(PK_B, roster));

    // Node A (lowest pubkey) is the single runner; node B stands down.
    expect(onA).toMatchObject({ run: true, reason: 'authority', hiveSlug: HIVE, liveCount: 2 });
    expect(onB).toMatchObject({ run: false, reason: 'remote-runner', hiveSlug: HIVE, liveCount: 2 });
    expect(onB.runnerLabel).toBe(PK_A);

    // The load-bearing invariant: across the Hive's nodes, runners sum to ONE.
    expect([onA.run, onB.run].filter(Boolean)).toHaveLength(1);
  });

  it('liveness failover: a stale leader (A) hands the runner role to the next-lowest (B)', async () => {
    // A last heartbeat 200s ago — past the 90s staleness window — so it drops out
    // of candidacy and B (the only live node) becomes the runner. No coordination.
    const roster = [row(PK_A, 200_000), row(PK_B, 0)];
    const onB = await checkHiveSingleRunner(WS, HIVE, nodeDeps(PK_B, roster));
    expect(onB).toMatchObject({ run: true, reason: 'authority', hiveSlug: HIVE });
  });

  it('a single-Swarm Hive (no remote presence) runs — standalone behaviour preserved', async () => {
    const onlyA = await checkHiveSingleRunner(WS, HIVE, nodeDeps(PK_A, []));
    expect(onlyA).toEqual({ run: true, reason: 'authority', hiveSlug: HIVE, liveCount: 1 });
  });
});
