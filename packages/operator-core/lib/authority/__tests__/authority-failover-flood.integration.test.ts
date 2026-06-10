/**
 * Authority failover UNDER FLOOD (P-003 of coord-system-e2e-testing-2026-06-10).
 *
 * Sustained lock traffic (holder heartbeats + contender acquires + worker
 * acquire/release churn) runs across an authority CRASH mid-flood:
 *
 *   rounds 0–9   X is the authority — contenders refused at X's store, workers
 *                granted under epoch 1;
 *   round 10     X crashes (server unreachable) but its presence is not yet
 *                stale — every routed op FAILS OPEN (D-004: local advisory,
 *                loud), which is the designed degradation, never a block;
 *   round ~24    X's presence ages past the staleness window → re-election:
 *                ops land at Y (epoch 2). The holder's heartbeat re-assert
 *                reaches Y before any contender that round (the one-heartbeat-
 *                interval D-005 guarantee), so mutual exclusion HOLDS through
 *                the whole handover.
 *
 * Invariants asserted over the whole flood:
 *   - ZERO authority grants of the contended path to any contender — in every
 *     round the contender is either refused remotely or failed open (advisory);
 *   - the fail-open window is bounded by the staleness window (re-election
 *     within it — the compressed-config analog of the 90s production window);
 *   - fencing: every remote grant's epoch is non-decreasing over rounds
 *     (no stale-epoch grant appears after the takeover);
 *   - liveness: workers keep getting granted whenever an authority is
 *     reachable (X before the crash, Y after the election).
 *
 * Deterministic: injected clock (no sleeps), fixed round count, no randomness.
 * Hermetic: loopback HTTP only, no PG, no LLM.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { routeFileLockOp } from '../file-lock-routing';
import { routeToAuthority } from '../lock-authority';
import { FILE_LOCK_OP_KINDS, type FileLockAcquireParams } from '../file-lock-authority-ops';
import { TwoInstanceAuthorityRig, type GrantResult } from './_two-instance-authority-rig';

const DOMAIN = '/repo/flood-failover';
const PATH_P = 'libs/contended.ts';
const HOLDER = 'holder-A';

const ROUNDS = 30;
const ROUND_MS = 200;
const CRASH_ROUND = 10;
const CONTENDERS = 3;
const WORKERS = 2;
const ASSERT_TTL_MS = 2_000;

const rig = new TwoInstanceAuthorityRig({ harness: 'flood-failover-harness' });

function acquireOp(owner: string, paths: string[]) {
  const local = vi.fn(async (): Promise<GrantResult> => ({ ok: true, lockId: 'LOCAL-ADVISORY' }));
  return {
    local,
    run: routeFileLockOp<GrantResult>(
      DOMAIN,
      {
        local,
        remote: {
          kind: FILE_LOCK_OP_KINDS.acquire,
          payload: {
            owner,
            paths,
            intent: 'flood',
            ttlSec: 600,
            coordinationDomain: DOMAIN,
          } satisfies FileLockAcquireParams,
          decode: (raw) => raw as GrantResult,
        },
      },
      rig.requesterDeps(DOMAIN),
    ),
  };
}

function releaseOp(owner: string, lockId: string) {
  return routeToAuthority<{ ok: boolean }>(
    rig.harness,
    {
      local: async () => ({ ok: false }),
      remote: {
        kind: FILE_LOCK_OP_KINDS.release,
        payload: { owner, lockId, coordinationDomain: DOMAIN },
        decode: (raw) => raw as { ok: boolean },
      },
    },
    rig.requesterAuthorityDeps(),
  );
}

function reassertOp() {
  return routeToAuthority<{ ok: boolean }>(
    rig.harness,
    {
      local: async () => ({ ok: false }),
      remote: {
        kind: 'lock.assert',
        payload: { path: PATH_P, owner: HOLDER, ttlMs: ASSERT_TTL_MS },
        decode: (raw) => raw as { ok: boolean },
      },
    },
    rig.requesterAuthorityDeps(),
  );
}

interface RoundLog {
  round: number;
  contenderRemoteGrants: number;
  contenderRemoteRefusals: number;
  failOpens: number;
  workerGrants: Array<{ epoch: number }>;
}

describe('authority failover under flood (P-003)', () => {
  const log: RoundLog[] = [];

  beforeAll(async () => {
    await rig.start();
    // Pre-flood: the holder takes the contended path at X (epoch 1).
    const first = await acquireOp(HOLDER, [PATH_P]).run;
    expect(first.via).toBe('remote-authority');
    expect(first.value.ok).toBe(true);
    expect(first.value.epoch).toBe(1);
  });

  afterAll(async () => {
    await rig.stop();
  });

  it('sustains the flood across the crash with zero contender grants and bounded fail-open', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      rig.clock += ROUND_MS;
      if (round < CRASH_ROUND) {
        rig.beat(rig.X.pubkey, rig.Y.pubkey, rig.requesterPubkey);
      } else {
        if (round === CRASH_ROUND) rig.xCrashed = true; // the box dies mid-flood
        rig.beatAllButX(); // its presence heartbeats stop with it
      }

      // The holder's TTL heartbeat re-asserts FIRST each round (heartbeat
      // cadence ≥ contender cadence — the D-005 one-interval guarantee).
      await reassertOp();

      // Then the round's traffic, genuinely concurrent over the wire.
      const contenderRuns = Array.from({ length: CONTENDERS }, (_, i) =>
        acquireOp(`contender-${i}`, [PATH_P]).run,
      );
      const workerRuns = Array.from({ length: WORKERS }, (_, i) =>
        acquireOp(`worker-${i}`, [`work/r${round}-w${i}.ts`]).run,
      );
      const [contenders, workers] = await Promise.all([
        Promise.all(contenderRuns),
        Promise.all(workerRuns),
      ]);

      const entry: RoundLog = {
        round,
        contenderRemoteGrants: 0,
        contenderRemoteRefusals: 0,
        failOpens: 0,
        workerGrants: [],
      };
      for (const c of contenders) {
        if (c.via === 'fail-open') entry.failOpens++;
        else if (c.via === 'remote-authority' && c.value.ok) entry.contenderRemoteGrants++;
        else if (c.via === 'remote-authority') entry.contenderRemoteRefusals++;
      }
      for (const w of workers) {
        if (w.via === 'fail-open') entry.failOpens++;
        else if (w.via === 'remote-authority') {
          expect(w.value.ok).toBe(true); // liveness: a reachable authority grants
          entry.workerGrants.push({ epoch: w.value.epoch ?? 0 });
          // Churn: release so worker paths never accumulate.
          await releaseOp(`worker-${entry.workerGrants.length - 1}`, w.value.lockId!);
        }
      }
      log.push(entry);
    }

    // ── THE invariant: no contender ever got an authority grant on the
    //    contended path — not before, during, or after the failover.
    const totalContenderGrants = log.reduce((n, r) => n + r.contenderRemoteGrants, 0);
    expect(totalContenderGrants).toBe(0);

    // Every round either refused the contenders remotely or failed open.
    for (const r of log) {
      expect(r.contenderRemoteRefusals + r.failOpens).toBeGreaterThan(0);
    }

    // ── Re-election within the staleness window: the fail-open window starts
    //    at the crash and ends when X ages out (staleMs after its last beat).
    const failOpenRounds = log.filter((r) => r.failOpens > 0).map((r) => r.round);
    expect(failOpenRounds.length).toBeGreaterThan(0); // the gap is real…
    expect(Math.min(...failOpenRounds)).toBe(CRASH_ROUND);
    const maxFailOpenWindow = Math.ceil(rig.staleMs / ROUND_MS) + 1;
    expect(Math.max(...failOpenRounds)).toBeLessThan(CRASH_ROUND + maxFailOpenWindow);
    // …and bounded: after the window, every op lands at Y again.
    const postElection = log.filter((r) => r.round > Math.max(...failOpenRounds));
    expect(postElection.length).toBeGreaterThan(0);
    for (const r of postElection) {
      expect(r.failOpens).toBe(0);
      expect(r.contenderRemoteRefusals).toBe(CONTENDERS);
      expect(r.workerGrants.length).toBe(WORKERS);
    }

    // ── Fencing: remote grant epochs are non-decreasing over the flood, and
    //    the takeover is visible as exactly one epoch step (1 → 2).
    const epochsInOrder = log.flatMap((r) => r.workerGrants.map((g) => g.epoch));
    for (let i = 1; i < epochsInOrder.length; i++) {
      expect(epochsInOrder[i]).toBeGreaterThanOrEqual(epochsInOrder[i - 1]);
    }
    expect(new Set(epochsInOrder)).toEqual(new Set([1, 2]));
    expect(rig.Y.epoch).toBe(2);

    // ── Mutual exclusion held end-to-end: the holder still owns the contended
    //    path at the post-election authority; no contender slipped in.
    expect(rig.Y.held.get(PATH_P)).toBeUndefined(); // never granted at Y…
    expect(rig.Y.reconstructor?.isHeldByOther(PATH_P, 'contender-0', rig.clock)).toBe(true); // …because the re-assert holds it
  });

  it('after the flood: the holder releases at Y and a contender finally wins under epoch 2', async () => {
    // The holder stops re-asserting; its last assert ages out.
    rig.clock += ASSERT_TTL_MS + 1;
    rig.beatAllButX();
    rig.Y.reconstructor?.prune(rig.clock);

    const res = await acquireOp('contender-0', [PATH_P]).run;
    expect(res.via).toBe('remote-authority');
    expect(res.value.ok).toBe(true);
    expect(res.value.epoch).toBe(2);
    expect(rig.Y.held.get(PATH_P)?.owner).toBe('contender-0');
  });
});
