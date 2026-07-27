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
    expect(v).toEqual({ run: true, reason: 'authority', potSlug: 'the-hive', liveCount: 1 });
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
  // `runs_routines` defaults TRUE here: these fixtures model nodes that genuinely
  // run the pot's cadence loop, which is the only setting in which the
  // duplicate-prevention assertions below mean anything. The capability filter
  // itself (EI-18761517980514694) is exercised by its own describe block.
  const row = (pk: string, ageMs = 0, runsRoutines: boolean | null = true) => ({
    device_pubkey: pk,
    github_user_id: pk === PK_A ? 1 : 2,
    machine_label: pk,
    last_seen_ms: NOW - ageMs,
    runs_routines: runsRoutines,
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
    expect(onA).toMatchObject({ run: true, reason: 'authority', potSlug: HIVE, liveCount: 2 });
    expect(onB).toMatchObject({ run: false, reason: 'remote-runner', potSlug: HIVE, liveCount: 2 });
    expect(onB.runnerLabel).toBe(PK_A);

    // The load-bearing invariant: across the Hive's nodes, runners sum to ONE.
    expect([onA.run, onB.run].filter(Boolean)).toHaveLength(1);
  });

  it('liveness failover: a stale leader (A) hands the runner role to the next-lowest (B)', async () => {
    // A last heartbeat 200s ago — past the 90s staleness window — so it drops out
    // of candidacy and B (the only live node) becomes the runner. No coordination.
    const roster = [row(PK_A, 200_000), row(PK_B, 0)];
    const onB = await checkHiveSingleRunner(WS, HIVE, nodeDeps(PK_B, roster));
    expect(onB).toMatchObject({ run: true, reason: 'authority', potSlug: HIVE });
  });

  it('a single-Swarm Hive (no remote presence) runs — standalone behaviour preserved', async () => {
    const onlyA = await checkHiveSingleRunner(WS, HIVE, nodeDeps(PK_A, []));
    expect(onlyA).toEqual({ run: true, reason: 'authority', potSlug: HIVE, liveCount: 1 });
  });

  // ── EI-18761517980514694: the election must not hand the runner role to a node
  // that does not run the loop. Measured on the papercusp pot: a peer whose routine
  // host never fires `gym-cycle` won every tick (lowest pubkey + a ~10s heartbeat),
  // so the node holding the gym stack, the enabled autoloop and the budget stood
  // down as `remote-runner` on ~89% of fires and the gym was dark for hours. Nothing
  // errored — the election succeeded and elected a node that does not do the work,
  // which is exactly why it never self-corrected.
  describe('capability-filtered candidacy (runs_routines)', () => {
    it('THE BUG: an INCAPABLE peer wins the argmin but is excluded ⇒ this node runs', async () => {
      // PK_A sorts below PK_B and heartbeats fresh, so pre-fix it won every tick.
      // It does not run cadence loops, so it must not be a runner candidate.
      const roster = [row(PK_A, 0, null), row(PK_B, 0, true)];
      const onB = await checkHiveSingleRunner(WS, HIVE, nodeDeps(PK_B, roster));
      expect(onB).toMatchObject({ run: true, reason: 'authority', potSlug: HIVE });
    });

    it('is NON-VACUOUS: the SAME roster still starves the capable node when the filter is off', async () => {
      // Pins the pre-fix behaviour, so the assertion above can only pass because of
      // the capability filter — not because the fixture happens to elect PK_B.
      const roster = [row(PK_A, 0, null), row(PK_B, 0, true)];
      const deps = nodeDeps(PK_B, roster);
      const onB = await checkHiveSingleRunner(WS, HIVE, {
        ...deps,
        authorityDeps: { ...deps.authorityDeps, routineHostsOnly: false },
      });
      expect(onB).toMatchObject({ run: false, reason: 'remote-runner' });
      expect(onB.runnerLabel).toBe(PK_A);
    });

    it('duplicate prevention SURVIVES: two CAPABLE nodes still yield exactly one runner', async () => {
      const roster = [row(PK_A, 0, true), row(PK_B, 0, true)];
      const onA = await checkHiveSingleRunner(WS, HIVE, nodeDeps(PK_A, roster));
      const onB = await checkHiveSingleRunner(WS, HIVE, nodeDeps(PK_B, roster));
      expect([onA.run, onB.run].filter(Boolean)).toHaveLength(1);
      expect(onA.run).toBe(true); // the lowest CAPABLE pubkey is still the runner
      expect(onB.runnerLabel).toBe(PK_A);
    });

    it('can never go DARK: with no capable node anywhere, every node runs its own loop', async () => {
      // The upgrade window — nobody publishes the bit yet. Eligibility constrains
      // PEERS only and the selector adds SELF unconditionally, so the worst case is
      // a duplicate cycle (the price D-004 explicitly accepts), never a stall.
      const roster = [row(PK_A, 0, null), row(PK_B, 0, null)];
      const onA = await checkHiveSingleRunner(WS, HIVE, nodeDeps(PK_A, roster));
      const onB = await checkHiveSingleRunner(WS, HIVE, nodeDeps(PK_B, roster));
      expect(onA.run).toBe(true);
      expect(onB.run).toBe(true);
    });

    it('SELF-HEALS: a node that stops advertising the bit stops taking the runner role', async () => {
      // Why the publisher re-resolves per announce instead of pinning the bit at
      // wire time: a node that DISARMS its cadence routine must lose candidacy, or
      // it keeps winning the argmin and the loop goes dark exactly as before.
      const armed = [row(PK_A, 0, true), row(PK_B, 0, true)];
      expect((await checkHiveSingleRunner(WS, HIVE, nodeDeps(PK_B, armed))).run).toBe(false);

      const disarmed = [row(PK_A, 0, null), row(PK_B, 0, true)];
      expect((await checkHiveSingleRunner(WS, HIVE, nodeDeps(PK_B, disarmed))).run).toBe(true);
    });

    it('an incapable SELF still runs — capability constrains peers, never self (D-004)', async () => {
      // A node that knows itself incapable must simply not call the gate; the gate
      // must never answer "nobody runs".
      const roster = [row(PK_A, 0, true), row(PK_B, 0, null)];
      const onB = await checkHiveSingleRunner(WS, HIVE, nodeDeps(PK_B, roster));
      expect(onB.run).toBe(false); // a capable peer legitimately holds the role
      const soloRoster = [row(PK_B, 0, null)];
      const soloB = await checkHiveSingleRunner(WS, HIVE, nodeDeps(PK_B, soloRoster));
      expect(soloB.run).toBe(true); // ...but alone it is still the runner
    });
  });
});
