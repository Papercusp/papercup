/**
 * sha-token-grant-wiring.test.ts — G-0 (P-033) wiring through the REAL
 * authority op handlers (buildFileLockAuthorityHandlers + a fake coordinator):
 * grants carry the sha-token stamp, releases with publishedSha feed the next
 * grant, expiry-reclaim flags unsyncedRisk, and the release LockEvent carries
 * publishedSha for failover reconstruction.
 *
 * Run: cd packages/operator-core && npx vitest run lib/authority/__tests__/sha-token-grant-wiring.test.ts
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  FILE_LOCK_OP_KINDS,
  buildFileLockAuthorityHandlers,
  type FileLockAcquireResult,
  type FileLockCoordinator,
} from '../file-lock-authority-ops';
import type { LockEvent } from '../lock-event-stream';
import { _shaTokenTesting } from '../sha-token-registry';

const DOM = '/repo/checkout';
const SHA1 = 'c'.repeat(40);

/** Always-grants fake store; release echoes the requested paths as released. */
function fakeCoordinator(ttlSecToExpiresTs?: (ttl: number) => string): FileLockCoordinator {
  return {
    async acquire(p) {
      return { ok: true, lockId: 'lock-1', expiresTs: ttlSecToExpiresTs?.(p.ttlSec) };
    },
    async release(p) {
      return { ok: true, released: p.paths ?? [] };
    },
    async queue() {
      return [];
    },
  };
}

describe('sha-token grant wiring (authority op handlers)', () => {
  beforeEach(() => _shaTokenTesting.reset());

  it('stamps grants, carries publish-then-release shas, and flags expiry-reclaim', async () => {
    let nowMs = 1_000;
    const events: LockEvent[] = [];
    const handlers = buildFileLockAuthorityHandlers(
      // expiresTs = now + ttl — deterministic via the injected clock.
      fakeCoordinator((ttl) => new Date(nowMs + ttl * 1000).toISOString()),
      { now: () => nowMs, emit: (e) => events.push(e) },
    );
    const acquire = handlers[FILE_LOCK_OP_KINDS.acquire];
    const release = handlers[FILE_LOCK_OP_KINDS.release];

    // First-ever grant: no prior sha, no risk.
    const g1 = (await acquire(
      { owner: 'agent-1', paths: ['x.ts'], intent: 'edit', ttlSec: 60, coordinationDomain: DOM },
      'hive-1',
    )) as FileLockAcquireResult;
    expect(g1.ok).toBe(true);
    expect(g1.shaToken).toEqual({ requiredSha: null, unsyncedRisk: false });

    // Publish-then-release: the holder hands the authority its published head.
    nowMs = 2_000;
    await release(
      { owner: 'agent-1', paths: ['x.ts'], coordinationDomain: DOM, publishedSha: SHA1 },
      'hive-1',
    );
    const rel = events.find((e) => e.kind === 'release');
    expect(rel?.publishedSha).toBe(SHA1); // failover-reconstruction rail

    // Next grant carries requiredSha, clean.
    nowMs = 3_000;
    const g2 = (await acquire(
      { owner: 'agent-2', paths: ['x.ts'], intent: 'edit', ttlSec: 60, coordinationDomain: DOM },
      'hive-1',
    )) as FileLockAcquireResult;
    expect(g2.shaToken).toEqual({ requiredSha: SHA1, unsyncedRisk: false });

    // agent-2 dies: no release; its TTL (60s from t=3s) lapses.
    nowMs = 70_000;
    const g3 = (await acquire(
      { owner: 'agent-3', paths: ['x.ts'], intent: 'edit', ttlSec: 60, coordinationDomain: DOM },
      'hive-1',
    )) as FileLockAcquireResult;
    expect(g3.shaToken).toEqual({ requiredSha: SHA1, unsyncedRisk: true });

    // agent-3 releases cleanly WITHOUT publishing: prior sha stands, risk clears.
    nowMs = 71_000;
    await release({ owner: 'agent-3', paths: ['x.ts'], coordinationDomain: DOM }, 'hive-1');
    nowMs = 72_000;
    const g4 = (await acquire(
      { owner: 'agent-4', paths: ['x.ts'], intent: 'edit', ttlSec: 60, coordinationDomain: DOM },
      'hive-1',
    )) as FileLockAcquireResult;
    expect(g4.shaToken).toEqual({ requiredSha: SHA1, unsyncedRisk: false });
    // No publishedSha on that release's event.
    const lastRel = [...events].reverse().find((e) => e.kind === 'release');
    expect(lastRel?.publishedSha).toBeUndefined();
  });
});
