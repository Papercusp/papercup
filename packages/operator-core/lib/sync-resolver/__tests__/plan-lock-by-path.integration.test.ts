// @vitest-environment node
/**
 * planLock.byPath — the plan-lock banner's read, end-to-end against the REAL
 * lock store (plan semantic-search-fingerprint-coverage-2026-08-03, P-025
 * step 4).
 *
 * WHY THIS EXISTS SEPARATELY FROM notify-lock-change.test.ts
 * ---------------------------------------------------------
 * That sibling covers the WRITE half at module level: which paths emit, and
 * that an acquire→release pair inside the bus's 90s window survives the
 * FIRST-WINS dedupe (D-042). It proves invalidations are SENT.
 *
 * It cannot prove anyone can READ the state those invalidations point at. The
 * banner only works if a subscriber, woken by that emit, then resolves
 * `planLock.byPath` and gets the CURRENT holder — so this drives the read leg
 * over real `agent_file_locks` rows in the real `papercusp_su` database:
 *
 *   acquire → resolve (holder present) → release → resolve (holder gone)
 *
 * P-025's step 4 asked for exactly this, "not just at module level", because
 * the migration deletes the 30s poll that used to paper over a broken read.
 *
 * ⚠ ACQUIRES IN THE PROCESS'S REAL COORDINATION DOMAIN, DELIBERATELY. The
 * resolver derives its domain from `lockCoordinationDomain()` — the repo root
 * of whichever process evaluates it — and takes no override, matching the HTTP
 * route it replaces. A test-only injection seam would make this pass without
 * exercising the domain the banner actually reads. Instead the lock is taken on
 * a UNIQUE, non-existent plan path (`__p025-e2e-<ts>-<rand>.md`) that no real
 * plan or peer can collide with, and released in a `finally`.
 */
import { describe, it, expect } from 'vitest';
import {
  ensureBootstrap,
  getTxPool,
  tryAcquire,
  tryRelease,
} from '../../agent-tools/locks/su-lock-store';
import { inWorkspaceTxn } from '../../agent-tools/locks/in-workspace-txn';
import { lockCoordinationDomain } from '../../agent-tools/locks/coordination-domain';
import { knownQueryNamesV2, resolveNamedQueryV2 } from '../index';

interface ResolvedLock {
  path: string;
  owner: string;
  owner_label: string | null;
  intent: string;
  acquired_ts: string;
  expires_ts: string;
}

async function dbLive(): Promise<boolean> {
  try {
    await getTxPool()`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

const uniquePlanPath = (tag: string) =>
  `apps/operator/docs/plans/__p025-e2e-${tag}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}.md`;

describe('planLock.byPath (P-025 step 4 — read leg, real lock store)', async () => {
  const live = await dbLive();

  it('is registered in the resolver registry', () => {
    // Cheap, DB-free, and the one assertion that fails loudly if the entry is
    // ever dropped: every other test here would merely skip.
    expect(knownQueryNamesV2()).toContain('planLock.byPath');
  });

  it.skipIf(!live)(
    'returns the holder after acquire and nothing after release',
    async () => {
      await ensureBootstrap();
      const domain = lockCoordinationDomain();
      const path = uniquePlanPath('main');
      const owner = `p025-e2e-${Date.now()}`;

      // Pre-condition: nobody holds this path. If this is non-empty the path
      // generator collided and every assertion below would be meaningless.
      const before = (await resolveNamedQueryV2('planLock.byPath', {
        path,
      })) as ResolvedLock[];
      expect(before).toEqual([]);

      try {
        const acquired = await inWorkspaceTxn(domain, owner, (tx) =>
          tryAcquire(tx, {
            coordinationDomain: domain,
            owner,
            ownerLabel: 'P-025 e2e',
            paths: [path],
            intent: 'p025 read-leg verification',
            ttlSec: 60,
          }),
        );
        expect(acquired.ok).toBe(true);

        const held = (await resolveNamedQueryV2('planLock.byPath', {
          path,
        })) as ResolvedLock[];

        expect(held).toHaveLength(1);
        expect(held[0]?.path).toBe(path);
        expect(held[0]?.owner).toBe(owner);
        expect(held[0]?.intent).toBe('p025 read-leg verification');
        expect(held[0]?.owner_label).toBe('P-025 e2e');

        // The banner renders these as dates and computes a TTL countdown from
        // them, so the ISO serialization is load-bearing, not cosmetic: the
        // route returned strings and a raw Date would reach the client as
        // something `new Date(...)` cannot parse the same way.
        expect(typeof held[0]?.acquired_ts).toBe('string');
        expect(typeof held[0]?.expires_ts).toBe('string');
        expect(Number.isNaN(Date.parse(held[0]!.acquired_ts))).toBe(false);
        expect(Number.isNaN(Date.parse(held[0]!.expires_ts))).toBe(false);
      } finally {
        await inWorkspaceTxn(domain, owner, (tx) =>
          // `allMine` rather than `paths`: tryRelease requires lockId or
          // allMine. Safe here because `owner` is a synthetic per-test id, so
          // "all mine" is exactly the one lock this test took.
          tryRelease(tx, { coordinationDomain: domain, owner, allMine: true }),
        );
      }

      // The half the deleted 30s poll used to cover for. If the release leg
      // does not clear the banner, a stale holder is displayed indefinitely —
      // the exact regression D-042 caught in the emit half.
      const after = (await resolveNamedQueryV2('planLock.byPath', {
        path,
      })) as ResolvedLock[];
      expect(after).toEqual([]);
    },
  );

  it.skipIf(!live)(
    'is scoped to the path it was asked for (a lock on another plan is invisible)',
    async () => {
      // CONTROL. readQueue with no `paths` returns every active lock in the
      // domain, so a resolver that dropped or mistyped its arg would still
      // return a plausible-looking row and the test above would still pass —
      // it would just show whichever plan happened to be locked. This is the
      // assertion that separates "reads the right lock" from "reads a lock".
      await ensureBootstrap();
      const domain = lockCoordinationDomain();
      const locked = uniquePlanPath('other');
      const queried = uniquePlanPath('queried');
      const owner = `p025-e2e-scope-${Date.now()}`;

      try {
        const acquired = await inWorkspaceTxn(domain, owner, (tx) =>
          tryAcquire(tx, {
            coordinationDomain: domain,
            owner,
            ownerLabel: 'P-025 e2e scope',
            paths: [locked],
            intent: 'p025 scoping control',
            ttlSec: 60,
          }),
        );
        expect(acquired.ok).toBe(true);

        // Calibration: the lock really is held, so an empty result for
        // `queried` below is scoping and not simply a failed acquire.
        expect(
          (await resolveNamedQueryV2('planLock.byPath', {
            path: locked,
          })) as ResolvedLock[],
        ).toHaveLength(1);

        expect(
          (await resolveNamedQueryV2('planLock.byPath', {
            path: queried,
          })) as ResolvedLock[],
        ).toEqual([]);
      } finally {
        await inWorkspaceTxn(domain, owner, (tx) =>
          tryRelease(tx, { coordinationDomain: domain, owner, allMine: true }),
        );
      }
    },
  );
});
