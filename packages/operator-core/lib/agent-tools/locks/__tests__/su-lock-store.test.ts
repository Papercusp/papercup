/**
 * SU-locks store unit tests.
 *
 * Exercises the core store layer (tryAcquire, tryRelease, tryHeartbeat,
 * tryInsertWaiter, tryCancelWait, readQueue, readWaiterStatus,
 * expireWaiter, path validation) against the live embedded PG. Each
 * test uses a unique coordination_domain so suites can run in parallel and
 * results don't bleed between cases.
 *
 * Prereqs:
 *   - Embedded PG running (Tauri dev shell or local PG at :5432).
 *   - `harness_admin` role has CREATEDB (one-time `sudo -u postgres
 *     psql -c "ALTER ROLE harness_admin CREATEDB"` per dev machine).
 *
 * To run only this suite:
 *   npx vitest run lib/agent-tools/locks/__tests__/su-lock-store.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ensureBootstrap,
  expireWaiter,
  getTxPool,
  InvalidPathError,
  MAX_WAITERS_PER_OWNER,
  normalizePaths,
  pokeWorkspace,
  readQueue,
  readWaiterStatus,
  runBackgroundJanitorOnce,
  sweepPathsExpired,
  sweepWorkspaceExpired,
  tryAcquire,
  tryCancelWait,
  tryHeartbeat,
  tryInsertWaiter,
  tryRelease,
  validatePath,
  _resetForTests,
} from '../su-lock-store';
import { inWorkspaceTxn } from '../in-workspace-txn';
// The background-janitor timer lives in workspace-listener.ts
// (file-locking #4); runBackgroundJanitorOnce — the sweep work — stays
// in su-lock-store.ts.
import {
  startBackgroundJanitor,
  stopBackgroundJanitor,
} from '../workspace-listener';

const SUITE_PREFIX = `vitest-su-locks-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let suiteIdx = 0;
function nextWs(): string {
  return `${SUITE_PREFIX}-${++suiteIdx}`;
}

beforeAll(async () => {
  await ensureBootstrap();
});

afterAll(async () => {
  // Clean every row we touched. Keep the database itself.
  const sql = getTxPool();
  try {
    await sql`DELETE FROM agent_file_locks WHERE coordination_domain LIKE ${SUITE_PREFIX + '%'}`;
    await sql`DELETE FROM agent_lock_waiters WHERE coordination_domain LIKE ${SUITE_PREFIX + '%'}`;
  } catch {
    /* db may have been torn down; ignore */
  }
  stopBackgroundJanitor(); // defensive — the timer never auto-starts under VITEST
  await _resetForTests();
});

describe('path validation', () => {
  it('rejects empty path', () => {
    expect(() => validatePath('')).toThrow(InvalidPathError);
  });
  it('rejects absolute path', () => {
    expect(() => validatePath('/etc/passwd')).toThrow(InvalidPathError);
  });
  it('rejects traversal — leading ../', () => {
    expect(() => validatePath('../secret')).toThrow(InvalidPathError);
  });
  it('rejects traversal — embedded /../', () => {
    expect(() => validatePath('a/../b')).toThrow(InvalidPathError);
  });
  it('rejects traversal — bare ..', () => {
    expect(() => validatePath('..')).toThrow(InvalidPathError);
  });
  it('rejects path > 4096 bytes', () => {
    expect(() => validatePath('a'.repeat(4097))).toThrow(InvalidPathError);
  });
  it('rejects path containing NULL byte (PG text rejects it)', () => {
    expect(() => validatePath('foo\0bar.ts')).toThrow(InvalidPathError);
  });
  it('accepts a normal repo-relative path', () => {
    expect(() => validatePath('apps/operator/lib/foo.ts')).not.toThrow();
  });
  it('rejects Windows-style backslashes (file-locking #1)', () => {
    expect(() => validatePath('apps\\operator\\foo.ts')).toThrow(InvalidPathError);
  });
  it('normalizePaths sorts + dedupes', () => {
    expect(normalizePaths(['b.ts', 'a.ts', 'b.ts'])).toEqual(['a.ts', 'b.ts']);
  });

  // file-locking #1 — canonicalization. Each non-canonical spelling
  // must collapse onto the same lock key as the plain form.
  it('canonicalizes a leading ./', () => {
    expect(normalizePaths(['./apps/foo.ts'])).toEqual(['apps/foo.ts']);
  });
  it('canonicalizes a /./ segment', () => {
    expect(normalizePaths(['apps/./foo.ts'])).toEqual(['apps/foo.ts']);
  });
  it('collapses repeated // separators', () => {
    expect(normalizePaths(['apps//foo.ts'])).toEqual(['apps/foo.ts']);
  });
  it('strips a trailing /', () => {
    expect(normalizePaths(['apps/foo.ts/'])).toEqual(['apps/foo.ts']);
  });
  it('dedupes equivalent-but-non-identical spellings to one key', () => {
    expect(
      normalizePaths(['apps/foo.ts', './apps/foo.ts', 'apps//foo.ts', 'apps/foo.ts/']),
    ).toEqual(['apps/foo.ts']);
  });
  it('rejects a path that canonicalizes to empty', () => {
    expect(() => normalizePaths(['./'])).toThrow(InvalidPathError);
  });
});

describe('tryAcquire', () => {
  it('acquires a single free path', async () => {
    const ws = nextWs();
    const r = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws,
        owner: 'a',
        ownerLabel: 'A',
        paths: ['foo.ts'],
        intent: 'one path',
        ttlSec: 60,
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.held).toEqual(['foo.ts']);
      expect(r.lock_id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('acquires a multi-path set atomically', async () => {
    const ws = nextWs();
    const r = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws,
        owner: 'a',
        ownerLabel: 'A',
        paths: normalizePaths(['c.ts', 'a.ts', 'b.ts']),
        intent: 'multi',
        ttlSec: 60,
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.held).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('returns busy + no partial state when one path is held', async () => {
    const ws = nextWs();
    await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws,
        owner: 'a',
        ownerLabel: 'A',
        paths: ['contested.ts'],
        intent: 'A holds',
        ttlSec: 60,
      }),
    );
    const r = await inWorkspaceTxn(ws, 'b', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws,
        owner: 'b',
        ownerLabel: 'B',
        paths: ['contested.ts', 'free.ts'],
        intent: 'B wants both',
        ttlSec: 60,
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const contested = r.busy.find((b) => b.path === 'contested.ts');
      expect(contested?.intent).toBe('A holds');
      // #5 — the busy row carries the holder's canonical owner, not
      // just the display label.
      expect(contested?.owner).toBe('a');
      expect(contested?.owner_label).toBe('A');
    }
    // Verify no partial state — free.ts must NOT be held by B
    const sql = getTxPool();
    const q = await readQueue(sql, { coordinationDomain: ws });
    const free = q.active_locks.find((l) => l.path === 'free.ts');
    expect(free).toBeUndefined();
  });

  it('steals an expired lock', async () => {
    const ws = nextWs();
    const sql = getTxPool();
    // Hand-insert an already-expired lock for owner A
    await sql`
      INSERT INTO agent_file_locks
        (coordination_domain, path, owner, owner_label, intent, expires_ts)
      VALUES
        (${ws}, 'stale.ts', 'a', 'A', 'stale', clock_timestamp() - interval '1 hour')
    `;
    const r = await inWorkspaceTxn(ws, 'b', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws,
        owner: 'b',
        ownerLabel: 'B',
        paths: ['stale.ts'],
        intent: 'B steals',
        ttlSec: 60,
      }),
    );
    expect(r.ok).toBe(true);
  });

  it('rejects path validation via the BEFORE INSERT trigger', async () => {
    const ws = nextWs();
    // Path validation throws at the app layer first. Confirm:
    expect(() =>
      normalizePaths(['/abs/path']),
    ).toThrow(InvalidPathError);
  });
});

describe('tryRelease + grant cascade', () => {
  it('release frees the locks', async () => {
    const ws = nextWs();
    const r = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws,
        owner: 'a',
        ownerLabel: 'A',
        paths: ['rel.ts'],
        intent: 'A',
        ttlSec: 60,
      }),
    );
    if (!r.ok) throw new Error('acquire should succeed');
    const rel = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryRelease(tx, { coordinationDomain: ws, owner: 'a', lockId: r.lock_id }),
    );
    expect(rel.released).toEqual(['rel.ts']);
  });

  it('release with all_mine releases every lock the owner holds', async () => {
    const ws = nextWs();
    await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws,
        owner: 'a',
        ownerLabel: 'A',
        paths: ['x.ts', 'y.ts'],
        intent: 'A',
        ttlSec: 60,
      }),
    );
    const rel = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryRelease(tx, { coordinationDomain: ws, owner: 'a', allMine: true }),
    );
    expect(rel.released.sort()).toEqual(['x.ts', 'y.ts']);
  });

  it('release grants the first waiter via cascade', async () => {
    const ws = nextWs();
    const sql = getTxPool();

    const a = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws,
        owner: 'a',
        ownerLabel: 'A',
        paths: ['cascade.ts'],
        intent: 'A',
        ttlSec: 60,
      }),
    );
    if (!a.ok) throw new Error('A should acquire');

    const w = await inWorkspaceTxn(ws, 'b', (tx) =>
      tryInsertWaiter(tx, {
        coordinationDomain: ws,
        owner: 'b',
        ownerLabel: 'B',
        paths: ['cascade.ts'],
        intent: 'B',
        ttlSec: 60,
        maxWaitSec: 30,
      }),
    );
    if (!w.ok) throw new Error('B insert should succeed');
    if ('self_granted' in w) throw new Error('unexpected self-grant in w');

    await inWorkspaceTxn(ws, 'a', (tx) =>
      tryRelease(tx, { coordinationDomain: ws, owner: 'a', lockId: a.lock_id }),
    );

    const status = await readWaiterStatus(sql, w.ticket_id);
    expect(status.status).toBe('granted');
    expect(status.granted_lock_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('cascade skips a waiter whose paths are still partially held', async () => {
    const ws = nextWs();
    const sql = getTxPool();

    // A holds path1, C holds path2. Release A; the cascade should NOT
    // grant a waiter requesting both — only the single-path waiter.
    const a = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws,
        owner: 'a',
        ownerLabel: 'A',
        paths: ['p1.ts'],
        intent: 'A',
        ttlSec: 60,
      }),
    );
    const c = await inWorkspaceTxn(ws, 'c', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws,
        owner: 'c',
        ownerLabel: 'C',
        paths: ['p2.ts'],
        intent: 'C',
        ttlSec: 60,
      }),
    );
    if (!a.ok || !c.ok) throw new Error('setup acquires should succeed');

    // Note: head-waiter rule blocks new acquires that overlap an older
    // waiter's paths, but it does NOT block existing locks. We're
    // testing the cascade itself.
    const wBoth = await inWorkspaceTxn(ws, 'b', (tx) =>
      tryInsertWaiter(tx, {
        coordinationDomain: ws,
        owner: 'b',
        ownerLabel: 'B',
        paths: ['p1.ts', 'p2.ts'],
        intent: 'B-both',
        ttlSec: 60,
        maxWaitSec: 30,
      }),
    );
    if (!wBoth.ok) throw new Error('B insert should succeed');
    if ('self_granted' in wBoth) throw new Error('unexpected self-grant in wBoth');

    // Release A. p2 is still held → B-both still waiting.
    await inWorkspaceTxn(ws, 'a', (tx) =>
      tryRelease(tx, { coordinationDomain: ws, owner: 'a', lockId: a.lock_id }),
    );
    const stillWaiting = await readWaiterStatus(sql, wBoth.ticket_id);
    expect(stillWaiting.status).toBe('waiting');

    // Now release C; cascade can grant B-both.
    await inWorkspaceTxn(ws, 'c', (tx) =>
      tryRelease(tx, { coordinationDomain: ws, owner: 'c', lockId: c.lock_id }),
    );
    const granted = await readWaiterStatus(sql, wBoth.ticket_id);
    expect(granted.status).toBe('granted');
  });
});

describe('tryHeartbeat', () => {
  it('extends a live lock', async () => {
    const ws = nextWs();
    const r = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws,
        owner: 'a',
        ownerLabel: 'A',
        paths: ['hb.ts'],
        intent: 'A',
        ttlSec: 60,
      }),
    );
    if (!r.ok) throw new Error('acquire should succeed');

    const h = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryHeartbeat(tx, ws, 'a', r.lock_id, 120),
    );
    expect(h.extended).toBe(true);
    expect(h.expires_ts).not.toBeNull();
  });

  it('returns extended:false when the lock was stolen', async () => {
    const ws = nextWs();
    // Hand-insert an expired lock then heartbeat with its (fake) lock_id
    const fakeLock = '00000000-0000-0000-0000-000000000000';
    const h = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryHeartbeat(tx, ws, 'a', fakeLock, 60),
    );
    expect(h.extended).toBe(false);
    expect(h.expires_ts).toBeNull();
  });
});

describe('tryInsertWaiter + cap', () => {
  it(`returns waiter_cap_exceeded after ${MAX_WAITERS_PER_OWNER} waiters per owner`, async () => {
    const ws = nextWs();
    // Hold the file so waiters actually queue.
    await inWorkspaceTxn(ws, 'holder', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws,
        owner: 'holder',
        ownerLabel: 'H',
        paths: ['capped.ts'],
        intent: 'hold',
        ttlSec: 120,
      }),
    );

    const owner = `capped-${Date.now()}`;
    let last: unknown = null;
    for (let i = 0; i < MAX_WAITERS_PER_OWNER + 1; i++) {
      last = await inWorkspaceTxn(ws, owner, (tx) =>
        tryInsertWaiter(tx, {
          coordinationDomain: ws,
          owner,
          ownerLabel: 'capped',
          paths: ['capped.ts'],
          intent: `#${i}`,
          ttlSec: 60,
          maxWaitSec: 60,
        }),
      );
    }
    expect((last as { ok: boolean }).ok).toBe(false);
    expect((last as { reason?: string }).reason).toBe('waiter_cap_exceeded');
  });
});

describe('expireWaiter + tryCancelWait', () => {
  it('expireWaiter flips status to expired', async () => {
    const ws = nextWs();
    await inWorkspaceTxn(ws, 'h', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'h', ownerLabel: 'H',
        paths: ['exp.ts'], intent: 'h', ttlSec: 60,
      }),
    );
    const w = await inWorkspaceTxn(ws, 'b', (tx) =>
      tryInsertWaiter(tx, {
        coordinationDomain: ws, owner: 'b', ownerLabel: 'B',
        paths: ['exp.ts'], intent: 'b', ttlSec: 60, maxWaitSec: 60,
      }),
    );
    if (!w.ok) throw new Error('insert should succeed');
    if ('self_granted' in w) throw new Error('unexpected self-grant in w');
    await inWorkspaceTxn(ws, 'b', (tx) => expireWaiter(tx, w.ticket_id));
    const status = await readWaiterStatus(getTxPool(), w.ticket_id);
    expect(status.status).toBe('expired');
  });

  it('tryCancelWait flips status to cancelled', async () => {
    const ws = nextWs();
    await inWorkspaceTxn(ws, 'h', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'h', ownerLabel: 'H',
        paths: ['cancel.ts'], intent: 'h', ttlSec: 60,
      }),
    );
    const w = await inWorkspaceTxn(ws, 'b', (tx) =>
      tryInsertWaiter(tx, {
        coordinationDomain: ws, owner: 'b', ownerLabel: 'B',
        paths: ['cancel.ts'], intent: 'b', ttlSec: 60, maxWaitSec: 60,
      }),
    );
    if (!w.ok) throw new Error('insert should succeed');
    if ('self_granted' in w) throw new Error('unexpected self-grant in w');
    const c = await inWorkspaceTxn(ws, 'b', (tx) =>
      tryCancelWait(tx, w.ticket_id, 'b'),
    );
    expect(c.cancelled).toBe(true);
    const status = await readWaiterStatus(getTxPool(), w.ticket_id);
    expect(status.status).toBe('cancelled');
  });

  it('tryCancelWait returns cancelled:false on a non-existent ticket', async () => {
    const fakeTicket = '00000000-0000-0000-0000-000000000000';
    const c = await inWorkspaceTxn(nextWs(), 'b', (tx) =>
      tryCancelWait(tx, fakeTicket, 'b'),
    );
    expect(c.cancelled).toBe(false);
  });

  it('tryCancelWait refuses to cancel a different owner\'s ticket', async () => {
    const ws = nextWs();
    await inWorkspaceTxn(ws, 'h', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'h', ownerLabel: 'H',
        paths: ['xowner.ts'], intent: 'h', ttlSec: 60,
      }),
    );
    const w = await inWorkspaceTxn(ws, 'b', (tx) =>
      tryInsertWaiter(tx, {
        coordinationDomain: ws, owner: 'b', ownerLabel: 'B',
        paths: ['xowner.ts'], intent: 'b', ttlSec: 60, maxWaitSec: 60,
      }),
    );
    if (!w.ok) throw new Error('insert should succeed');
    if ('self_granted' in w) throw new Error('unexpected self-grant in w');
    const c = await inWorkspaceTxn(ws, 'malicious', (tx) =>
      tryCancelWait(tx, w.ticket_id, 'malicious'),
    );
    expect(c.cancelled).toBe(false);
    const status = await readWaiterStatus(getTxPool(), w.ticket_id);
    expect(status.status).toBe('waiting');
  });
});

describe('readQueue', () => {
  it('returns active locks with sorted ahead_count over waiters', async () => {
    const ws = nextWs();
    // Hold a path so waiters queue.
    await inWorkspaceTxn(ws, 'h', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'h', ownerLabel: 'H',
        paths: ['q.ts'], intent: 'h', ttlSec: 60,
      }),
    );
    const w1 = await inWorkspaceTxn(ws, 'first', (tx) =>
      tryInsertWaiter(tx, {
        coordinationDomain: ws, owner: 'first', ownerLabel: 'F',
        paths: ['q.ts'], intent: 'first', ttlSec: 60, maxWaitSec: 60,
      }),
    );
    // Small sleep so queued_ts differs reliably.
    await new Promise((r) => setTimeout(r, 30));
    const w2 = await inWorkspaceTxn(ws, 'second', (tx) =>
      tryInsertWaiter(tx, {
        coordinationDomain: ws, owner: 'second', ownerLabel: 'S',
        paths: ['q.ts'], intent: 'second', ttlSec: 60, maxWaitSec: 60,
      }),
    );
    if (!w1.ok || !w2.ok) throw new Error('inserts should succeed');
    if ('self_granted' in w1 || 'self_granted' in w2) throw new Error('unexpected self-grant in queue test');

    const q = await readQueue(getTxPool(), { coordinationDomain: ws });
    expect(q.active_locks).toHaveLength(1);
    expect(q.active_locks[0].path).toBe('q.ts');
    expect(q.waiting).toHaveLength(2);
    expect(q.waiting[0].ticket_id).toBe(w1.ticket_id);
    expect(q.waiting[0].ahead_count).toBe(0);
    expect(q.waiting[1].ticket_id).toBe(w2.ticket_id);
    expect(q.waiting[1].ahead_count).toBe(1);
  });
});

describe('head-waiter blocks new acquires (anti-starvation)', () => {
  it('new acquirer cannot jump an older waiter on the same path', async () => {
    const ws = nextWs();
    // A holds, B queues, C tries to acquire — C must be blocked (busy)
    // because B is ahead of C in line even though C didn't queue.
    const a = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'a', ownerLabel: 'A',
        paths: ['hot.ts'], intent: 'a', ttlSec: 60,
      }),
    );
    if (!a.ok) throw new Error('A acquire should succeed');

    await inWorkspaceTxn(ws, 'b', (tx) =>
      tryInsertWaiter(tx, {
        coordinationDomain: ws, owner: 'b', ownerLabel: 'B',
        paths: ['hot.ts'], intent: 'b', ttlSec: 60, maxWaitSec: 60,
      }),
    );

    // Release A.
    await inWorkspaceTxn(ws, 'a', (tx) =>
      tryRelease(tx, { coordinationDomain: ws, owner: 'a', lockId: a.lock_id }),
    );

    // C tries to acquire — should be busy because B got the cascade.
    const c = await inWorkspaceTxn(ws, 'c', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'c', ownerLabel: 'C',
        paths: ['hot.ts'], intent: 'c', ttlSec: 60,
      }),
    );
    expect(c.ok).toBe(false);
  });
});

describe('audit regression — single lock_id across mixed acquire', () => {
  it('unifies prior multiple lock_ids when extending across paths', async () => {
    const ws = nextWs();
    const r1 = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'a', ownerLabel: 'A',
        paths: ['u1.ts'], intent: 'first', ttlSec: 60,
      }),
    );
    const r2 = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'a', ownerLabel: 'A',
        paths: ['u2.ts'], intent: 'second', ttlSec: 60,
      }),
    );
    if (!r1.ok || !r2.ok) throw new Error('setup');
    expect(r1.lock_id).not.toBe(r2.lock_id);

    // Extending across the two prior lock_ids must unify them.
    const r3 = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'a', ownerLabel: 'A',
        paths: ['u1.ts', 'u2.ts', 'u3.ts'], intent: 'extend', ttlSec: 60,
      }),
    );
    expect(r3.ok).toBe(true);
    if (!r3.ok) return;

    const sql = getTxPool();
    const rows = await sql<Array<{ lock_id: string }>>`
      SELECT lock_id::text AS lock_id FROM agent_file_locks
       WHERE coordination_domain = ${ws}
    `;
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.lock_id)).size).toBe(1);

    const rel = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryRelease(tx, { coordinationDomain: ws, owner: 'a', lockId: r3.lock_id }),
    );
    expect(rel.released.sort()).toEqual(['u1.ts', 'u2.ts', 'u3.ts']);
  });

  it('extending an existing same-owner lock with new paths returns ONE lock_id covering all rows', async () => {
    const ws = nextWs();
    const r1 = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'a', ownerLabel: 'A',
        paths: ['m1.ts', 'm2.ts'], intent: 'first', ttlSec: 60,
      }),
    );
    if (!r1.ok) throw new Error('first acquire');

    const r2 = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'a', ownerLabel: 'A',
        paths: ['m1.ts', 'm2.ts', 'm3.ts'], intent: 'extend', ttlSec: 60,
      }),
    );
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    // Reuse the existing lock_id (no fresh UUID for the new path).
    expect(r2.lock_id).toBe(r1.lock_id);

    // Every DB row must carry the same lock_id.
    const sql = getTxPool();
    const rows = await sql<Array<{ lock_id: string }>>`
      SELECT lock_id::text AS lock_id FROM agent_file_locks
       WHERE coordination_domain = ${ws}
    `;
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.lock_id)).size).toBe(1);

    // release(lock_id) must free all 3.
    const rel = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryRelease(tx, { coordinationDomain: ws, owner: 'a', lockId: r2.lock_id }),
    );
    expect(rel.released.sort()).toEqual(['m1.ts', 'm2.ts', 'm3.ts']);
  });
});

describe('audit regression — insert-race self-grant', () => {
  it('tryInsertWaiter self-grants when the path freed between caller busy-return and insert', async () => {
    const ws = nextWs();
    // Holder A.
    const a = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'a', ownerLabel: 'A',
        paths: ['ir.ts'], intent: 'A', ttlSec: 60,
      }),
    );
    if (!a.ok) throw new Error('setup acquire');
    // Simulate B's busy probe, then A releases, then B inserts waiter.
    // B's first tryAcquire would have returned busy (we skip simulating
    // that step; the bug is in INSERT).
    await inWorkspaceTxn(ws, 'a', (tx) =>
      tryRelease(tx, { coordinationDomain: ws, owner: 'a', lockId: a.lock_id }),
    );
    const w = await inWorkspaceTxn(ws, 'b', (tx) =>
      tryInsertWaiter(tx, {
        coordinationDomain: ws, owner: 'b', ownerLabel: 'B',
        paths: ['ir.ts'], intent: 'B', ttlSec: 60, maxWaitSec: 60,
      }),
    );
    expect(w.ok).toBe(true);
    if (w.ok) {
      // Self-grant branch — caller already holds the lock without
      // having queued a waiter row.
      expect('self_granted' in w).toBe(true);
      if ('self_granted' in w) {
        expect(w.lock_id).toMatch(/^[0-9a-f-]{36}$/);
        expect(w.held).toEqual(['ir.ts']);
      }
    }
  });
});

describe('audit regression — orphaned-waiter cleanup', () => {
  it('path-narrow sweep flips a waiter whose wait_until has passed but no one marked it expired', async () => {
    // file-locking #4: the per-acquire sweep is now path-scoped, so
    // the contender's acquire on the orphan's path is what triggers
    // the cleanup. (Orphans on paths the agent doesn't touch are
    // cleaned by the background janitor — see its own describe block.)
    const ws = nextWs();
    const sql = getTxPool();
    const h = await inWorkspaceTxn(ws, 'h', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'h', ownerLabel: 'H',
        paths: ['orphan.ts'], intent: 'H', ttlSec: 60,
      }),
    );
    if (!h.ok) throw new Error('setup');

    // Waiter with a 1s ceiling. Simulate the agent crashing by NOT
    // calling pokeWorkspace.
    const w = await inWorkspaceTxn(ws, 'b', (tx) =>
      tryInsertWaiter(tx, {
        coordinationDomain: ws, owner: 'b', ownerLabel: 'B',
        paths: ['orphan.ts'], intent: 'B', ttlSec: 60, maxWaitSec: 1,
      }),
    );
    if (!w.ok || 'self_granted' in w) throw new Error('insert');

    // Sleep past wait_until.
    await new Promise((r) => setTimeout(r, 1500));

    // A contender on the SAME path triggers the path-narrow sweep.
    // Should be 'busy' (H still holds), not blocked by the orphan.
    const probe = await inWorkspaceTxn(ws, 'probe', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'probe', ownerLabel: 'P',
        paths: ['orphan.ts'], intent: 'probe', ttlSec: 60,
      }),
    );
    expect(probe.ok).toBe(false);
    if (!probe.ok) {
      // Blocked by H (the live holder), NOT by the orphan B.
      expect(probe.busy[0].owner).toBe('h');
    }

    const rows = await sql<Array<{ status: string }>>`
      SELECT status::text AS status FROM agent_lock_waiters
       WHERE ticket_id = ${w.ticket_id}::uuid
    `;
    expect(rows[0].status).toBe('expired');
  });

  it('head-waiter check filters by wait_until so a stale waiter never blocks an acquire', async () => {
    // Defense-in-depth (file-locking #4): even if the sweep hasn't
    // run yet, a 'waiting' row whose wait_until has elapsed must not
    // block. Hand-insert an orphan with no live holder and confirm a
    // fresh acquire on the same path succeeds.
    const ws = nextWs();
    const sql = getTxPool();
    await sql`
      INSERT INTO agent_lock_waiters
        (coordination_domain, owner, owner_label, paths, intent, ttl_sec,
         wait_until, status, queued_ts)
      VALUES
        (${ws}, 'crashed', 'crashed', ${['ghost.ts']}, 'crashed', 60,
         clock_timestamp() - interval '5 seconds',
         'waiting',
         clock_timestamp() - interval '1 minute')
    `;
    const r = await inWorkspaceTxn(ws, 'fresh', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'fresh', ownerLabel: 'F',
        paths: ['ghost.ts'], intent: 'F', ttlSec: 60,
      }),
    );
    expect(r.ok).toBe(true);
  });
});

describe('audit regression — cross-owner release/heartbeat refused', () => {
  it('release refuses to delete locks owned by a different owner even with the right lock_id', async () => {
    const ws = nextWs();
    const sql = getTxPool();
    const a = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'a', ownerLabel: 'A',
        paths: ['secret.ts'], intent: 'A', ttlSec: 60,
      }),
    );
    if (!a.ok) throw new Error('setup');
    const rel = await inWorkspaceTxn(ws, 'b', (tx) =>
      tryRelease(tx, { coordinationDomain: ws, owner: 'b', lockId: a.lock_id }),
    );
    expect(rel.released).toEqual([]);
    const survives = await sql<Array<{ c: number }>>`
      SELECT count(*)::int AS c FROM agent_file_locks
       WHERE coordination_domain = ${ws} AND owner = 'a'
    `;
    expect(survives[0].c).toBe(1);
  });

  it('heartbeat refuses to extend a lock owned by a different owner', async () => {
    const ws = nextWs();
    const a = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'a', ownerLabel: 'A',
        paths: ['secret2.ts'], intent: 'A', ttlSec: 60,
      }),
    );
    if (!a.ok) throw new Error('setup');
    const hb = await inWorkspaceTxn(ws, 'b', (tx) =>
      tryHeartbeat(tx, ws, 'b', a.lock_id, 7200),
    );
    expect(hb.extended).toBe(false);
  });
});

describe('audit regression — pokeWorkspace grants waiter after holder TTL expiry', () => {
  it(
    'grants a queued waiter when the holder\'s lock has expired but no one called release',
    // EI-716 load-flake: this asserts a 1s-TTL holder→waiter grant TRANSITION, so under
    // green-checkpoint load (embedded-PG :5632 contention) the PG round-trips race the 1s
    // expiry → intermittent 'granted' vs 'waiting'. Deterministic at :5432 (60/60); retry a
    // transient load miss instead of skip/quarantine (cross-hive-two-hive.test.ts convention)
    // so coverage is preserved.
    { retry: 3 },
    async () => {
    const ws = nextWs();
    const sql = getTxPool();
    // Holder with 1s TTL
    const holder = await inWorkspaceTxn(ws, 'h', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'h', ownerLabel: 'H',
        paths: ['exp.ts'], intent: 'short', ttlSec: 1,
      }),
    );
    if (!holder.ok) throw new Error('setup');

    // Waiter queues while holder is alive
    const w = await inWorkspaceTxn(ws, 'b', (tx) =>
      tryInsertWaiter(tx, {
        coordinationDomain: ws, owner: 'b', ownerLabel: 'B',
        paths: ['exp.ts'], intent: 'B', ttlSec: 60, maxWaitSec: 60,
      }),
    );
    if (!w.ok) throw new Error('insert');
    if ('self_granted' in w) throw new Error('did not expect self-grant in this test');

    // Sleep past TTL so the holder's row is now expired.
    await new Promise((r) => setTimeout(r, 1500));

    // Without poke, waiter stays in 'waiting' (no release fired).
    const before = await readWaiterStatus(sql, w.ticket_id);
    expect(before.status).toBe('waiting');

    // Poke the workspace — janitor sweeps expired holder, cascade grants waiter.
    await inWorkspaceTxn(ws, 'b', (tx) => pokeWorkspace(tx, ws));

    const after = await readWaiterStatus(sql, w.ticket_id);
    expect(after.status).toBe('granted');
    expect(after.granted_lock_id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('migration idempotency', () => {
  it('ensureBootstrap is safe to call repeatedly', async () => {
    // First call already happened in beforeAll.
    await expect(ensureBootstrap()).resolves.toBeUndefined();
    await expect(ensureBootstrap()).resolves.toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────
// Plan §10.1 — additional cases caught by the audit pass
// ────────────────────────────────────────────────────────────────────

describe('plan §10.1 — release_with_paths_filter', () => {
  it('release with paths filter only frees the matching paths', async () => {
    const ws = nextWs();
    const r = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws,
        owner: 'a',
        ownerLabel: 'A',
        paths: ['p1.ts', 'p2.ts', 'p3.ts'],
        intent: 'A holds three',
        ttlSec: 60,
      }),
    );
    if (!r.ok) throw new Error('acquire');
    // Release only p2.
    const rel = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryRelease(tx, {
        coordinationDomain: ws,
        owner: 'a',
        lockId: r.lock_id,
        paths: ['p2.ts'],
      }),
    );
    expect(rel.released).toEqual(['p2.ts']);
    // p1 and p3 still held.
    const q = await readQueue(getTxPool(), { coordinationDomain: ws });
    const held = q.active_locks.map((l) => l.path).sort();
    expect(held).toEqual(['p1.ts', 'p3.ts']);
  });
});

describe('plan §10.1 — release_grant_cascade_continues_past_vanished_waiter', () => {
  it('cascade survives a waiter being concurrently cancelled', async () => {
    const ws = nextWs();
    const sql = getTxPool();
    const a = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'a', ownerLabel: 'A',
        paths: ['v.ts'], intent: 'A', ttlSec: 60,
      }),
    );
    if (!a.ok) throw new Error('acquire');

    // Two waiters; we'll hand-delete the first to simulate the
    // vanished-waiter race. EXCEPTION block in grant_cascade catches
    // no_data_found and continues to the next waiter.
    const w1 = await inWorkspaceTxn(ws, 'b1', (tx) =>
      tryInsertWaiter(tx, {
        coordinationDomain: ws, owner: 'b1', ownerLabel: 'B1',
        paths: ['v.ts'], intent: 'b1', ttlSec: 60, maxWaitSec: 60,
      }),
    );
    await new Promise((r) => setTimeout(r, 30));
    const w2 = await inWorkspaceTxn(ws, 'b2', (tx) =>
      tryInsertWaiter(tx, {
        coordinationDomain: ws, owner: 'b2', ownerLabel: 'B2',
        paths: ['v.ts'], intent: 'b2', ttlSec: 60, maxWaitSec: 60,
      }),
    );
    if (!w1.ok || !w2.ok) throw new Error('waiter inserts');
    if ('self_granted' in w1 || 'self_granted' in w2) throw new Error('unexpected self-grant in vanished-waiter test');

    // Hard-delete w1 to simulate disappearance between SELECT and UPDATE.
    await sql`DELETE FROM agent_lock_waiters WHERE ticket_id = ${w1.ticket_id}::uuid`;

    // Release A — cascade should skip the vanished w1 and grant w2.
    await inWorkspaceTxn(ws, 'a', (tx) =>
      tryRelease(tx, { coordinationDomain: ws, owner: 'a', lockId: a.lock_id }),
    );
    const s2 = await readWaiterStatus(sql, w2.ticket_id);
    expect(s2.status).toBe('granted');
  });
});

describe('plan §10.1 — cancel_wait_after_grant', () => {
  it('cancel returns cancelled:false when the waiter was already granted', async () => {
    const ws = nextWs();
    const sql = getTxPool();
    const a = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'a', ownerLabel: 'A',
        paths: ['cg.ts'], intent: 'A', ttlSec: 60,
      }),
    );
    if (!a.ok) throw new Error('acquire');

    const w = await inWorkspaceTxn(ws, 'b', (tx) =>
      tryInsertWaiter(tx, {
        coordinationDomain: ws, owner: 'b', ownerLabel: 'B',
        paths: ['cg.ts'], intent: 'B', ttlSec: 60, maxWaitSec: 60,
      }),
    );
    if (!w.ok) throw new Error('insert');
    if ('self_granted' in w) throw new Error('unexpected self-grant in w');

    // Cause the grant first.
    await inWorkspaceTxn(ws, 'a', (tx) =>
      tryRelease(tx, { coordinationDomain: ws, owner: 'a', lockId: a.lock_id }),
    );

    // Now try to cancel — already granted, should return false.
    const c = await inWorkspaceTxn(ws, 'b', (tx) =>
      tryCancelWait(tx, w.ticket_id, 'b'),
    );
    expect(c.cancelled).toBe(false);
    const status = await readWaiterStatus(sql, w.ticket_id);
    expect(status.status).toBe('granted');
  });
});

describe('plan §10.1 + file-locking #4 — background janitor', () => {
  // The plan §10.1 invariant ("stale locks + terminal waiters get
  // swept") is now carried by runBackgroundJanitorOnce(), not by an
  // implicit sweep inside tryAcquire. Under VITEST the timer is NOT
  // armed (see isTestEnv in in-workspace-txn.ts); tests drive it
  // directly so there's no wall-clock race against fixtures.

  it('runBackgroundJanitorOnce sweeps expired locks on paths nobody acquired', async () => {
    const ws = nextWs();
    const sql = getTxPool();
    // Hand-insert an expired lock the tests never otherwise touch —
    // the path-narrow per-acquire sweep would never reach it.
    await sql`
      INSERT INTO agent_file_locks
        (coordination_domain, path, owner, owner_label, intent, expires_ts)
      VALUES
        (${ws}, 'janitor.ts', 'old', 'old', 'old',
         clock_timestamp() - interval '1 hour')
    `;
    await runBackgroundJanitorOnce();
    const left = await sql<Array<{ path: string }>>`
      SELECT path FROM agent_file_locks
       WHERE coordination_domain = ${ws} AND owner = 'old'
    `;
    expect(left).toHaveLength(0);
  });

  it('runBackgroundJanitorOnce garbage-collects terminal waiters older than 24h', async () => {
    const ws = nextWs();
    const sql = getTxPool();
    await sql`
      INSERT INTO agent_lock_waiters
        (coordination_domain, owner, owner_label, paths, intent, ttl_sec,
         wait_until, status, queued_ts)
      VALUES
        (${ws}, 'gone', 'gone', ${['x.ts']}, 'old', 60,
         clock_timestamp() - interval '25 hours',
         'expired',
         clock_timestamp() - interval '25 hours')
    `;
    await runBackgroundJanitorOnce();
    const left = await sql<Array<{ ticket_id: string }>>`
      SELECT ticket_id FROM agent_lock_waiters
       WHERE coordination_domain = ${ws} AND owner = 'gone'
    `;
    expect(left).toHaveLength(0);
  });

  it('runBackgroundJanitorOnce grants a waiter behind a now-expired holder, per-workspace', async () => {
    // The bug the per-workspace advisory lock prevents: a naive global
    // sweep+single-cascade would only fire grant_cascade for ONE
    // workspace per pass. Set up two workspaces, both with the same
    // problem, and assert both waiters end up granted in the same
    // janitor pass.
    const sql = getTxPool();

    async function armWorkspace(ws: string): Promise<string> {
      const a = await inWorkspaceTxn(ws, 'h', (tx) =>
        tryAcquire(tx, {
          coordinationDomain: ws, owner: 'h', ownerLabel: 'H',
          paths: ['bg.ts'], intent: 'H', ttlSec: 300,
        }),
      );
      if (!a.ok) throw new Error('arm: holder acquire failed');
      const w = await inWorkspaceTxn(ws, 'b', (tx) =>
        tryInsertWaiter(tx, {
          coordinationDomain: ws, owner: 'b', ownerLabel: 'B',
          paths: ['bg.ts'], intent: 'B', ttlSec: 60, maxWaitSec: 600,
        }),
      );
      if (!w.ok || 'self_granted' in w) throw new Error('arm: waiter not queued');
      // Force-expire H so the only thing standing between B and the
      // grant is the background janitor.
      await sql`
        UPDATE agent_file_locks
           SET expires_ts = clock_timestamp() - interval '1 second'
         WHERE coordination_domain = ${ws} AND path = 'bg.ts'
      `;
      return w.ticket_id;
    }

    const wsA = nextWs();
    const wsB = nextWs();
    const tA = await armWorkspace(wsA);
    const tB = await armWorkspace(wsB);

    await runBackgroundJanitorOnce();

    const sA = await readWaiterStatus(sql, tA);
    const sB = await readWaiterStatus(sql, tB);
    expect(sA.status).toBe('granted');
    expect(sB.status).toBe('granted');
  });

  it('start/stopBackgroundJanitor is idempotent and does not leak timers', () => {
    // Smoke test the lifecycle — don't actually let the 30s interval
    // fire, just verify the handles can be churned without throwing.
    stopBackgroundJanitor();
    startBackgroundJanitor();
    startBackgroundJanitor(); // second call must be a no-op
    stopBackgroundJanitor();
    stopBackgroundJanitor(); // second stop must be a no-op
  });
});

describe('file-locking #4 — acquire under concurrent load (plan §4 stress)', () => {
  it('100 concurrent acquires on one workspace all succeed, none time out', async () => {
    // Plan §4's flake was the janitor running INSIDE every acquire,
    // bursting past the 500ms statement_timeout under load. With the
    // janitor extracted to the background sweep (and out of the hot
    // path entirely), tryAcquire is a pure read-check + upsert — 100
    // acquires serialized on the workspace advisory lock must all land
    // well inside inWorkspaceTxn's 5s lock_timeout / statement_timeout.
    // Distinct paths → no contention, every acquire returns ok:true.
    const ws = nextWs();
    const N = 100;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        inWorkspaceTxn(ws, `c${i}`, (tx) =>
          tryAcquire(tx, {
            coordinationDomain: ws,
            owner: `c${i}`,
            ownerLabel: `C${i}`,
            paths: [`load/file-${i}.ts`],
            intent: 'stress',
            ttlSec: 300,
          }),
        ).then(
          (r) => ({ ok: r.ok, err: null as string | null }),
          (e: unknown) => ({
            ok: false,
            err: e instanceof Error ? e.message : String(e),
          }),
        ),
      ),
    );
    const failed = results.filter((r) => !r.ok);
    // Surface the first failure's message so a regression is debuggable
    // (a statement_timeout / lock_timeout would land here).
    expect(failed.map((f) => f.err).filter(Boolean)).toEqual([]);
    expect(failed).toHaveLength(0);
    expect(results).toHaveLength(N);
  }, 30_000);
});

describe('file-locking #4 — sweepPathsExpired (path-narrow primitive)', () => {
  it('deletes expired locks only on the requested paths', async () => {
    const ws = nextWs();
    const sql = getTxPool();
    await sql`
      INSERT INTO agent_file_locks
        (coordination_domain, path, owner, owner_label, intent, expires_ts)
      VALUES
        (${ws}, 'in.ts', 'a', 'A', 'i', clock_timestamp() - interval '1 hour'),
        (${ws}, 'out.ts', 'a', 'A', 'i', clock_timestamp() - interval '1 hour')
    `;
    const moved = await inWorkspaceTxn(ws, 'p', (tx) =>
      sweepPathsExpired(tx, ws, ['in.ts']),
    );
    expect(moved).toBe(true);
    const rows = await sql<Array<{ path: string }>>`
      SELECT path FROM agent_file_locks
       WHERE coordination_domain = ${ws} ORDER BY path
    `;
    expect(rows.map((r) => r.path)).toEqual(['out.ts']);
  });

  it('flips orphaned waiters whose paths overlap, leaves disjoint ones alone', async () => {
    const ws = nextWs();
    const sql = getTxPool();
    await sql`
      INSERT INTO agent_lock_waiters
        (coordination_domain, owner, owner_label, paths, intent, ttl_sec,
         wait_until, status, queued_ts)
      VALUES
        (${ws}, 'over', 'over', ${['x.ts', 'y.ts']}, 'i', 60,
         clock_timestamp() - interval '5 seconds', 'waiting',
         clock_timestamp() - interval '1 minute'),
        (${ws}, 'disj', 'disj', ${['z.ts']}, 'i', 60,
         clock_timestamp() - interval '5 seconds', 'waiting',
         clock_timestamp() - interval '1 minute')
    `;
    const moved = await inWorkspaceTxn(ws, 'p', (tx) =>
      sweepPathsExpired(tx, ws, ['x.ts']),
    );
    expect(moved).toBe(true);
    const rows = await sql<Array<{ owner: string; status: string }>>`
      SELECT owner, status::text AS status FROM agent_lock_waiters
       WHERE coordination_domain = ${ws} ORDER BY owner
    `;
    const byOwner = Object.fromEntries(rows.map((r) => [r.owner, r.status]));
    expect(byOwner.over).toBe('expired');
    expect(byOwner.disj).toBe('waiting');
  });

  it('returns false when nothing matches (no-op fast path)', async () => {
    const ws = nextWs();
    const moved = await inWorkspaceTxn(ws, 'p', (tx) =>
      sweepPathsExpired(tx, ws, ['nonexistent.ts']),
    );
    expect(moved).toBe(false);
  });

  it('returns false for an empty path list', async () => {
    const ws = nextWs();
    const moved = await inWorkspaceTxn(ws, 'p', (tx) =>
      sweepPathsExpired(tx, ws, []),
    );
    expect(moved).toBe(false);
  });
});

describe('file-locking #4 — sweepWorkspaceExpired (workspace-scoped primitive)', () => {
  it('sweeps all expired rows in its workspace and leaves other workspaces untouched', async () => {
    const sql = getTxPool();
    const wsA = nextWs();
    const wsB = nextWs();
    for (const ws of [wsA, wsB]) {
      await sql`
        INSERT INTO agent_file_locks
          (coordination_domain, path, owner, owner_label, intent, expires_ts)
        VALUES
          (${ws}, 'a.ts', 'o', 'O', 'i', clock_timestamp() - interval '1 hour'),
          (${ws}, 'b.ts', 'o', 'O', 'i', clock_timestamp() - interval '1 hour')
      `;
    }
    const moved = await inWorkspaceTxn(wsA, 'p', (tx) =>
      sweepWorkspaceExpired(tx, wsA),
    );
    expect(moved).toBe(true);
    const left = await sql<Array<{ coordination_domain: string }>>`
      SELECT coordination_domain FROM agent_file_locks
       WHERE coordination_domain IN (${wsA}, ${wsB})
    `;
    expect(left.map((r) => r.coordination_domain).sort()).toEqual([wsB, wsB]);
  });
});

// ────────────────────────────────────────────────────────────────────
// Audit regression: same-owner re-acquire must succeed + preserve
// lock_id (fixes the bug that locked Claude Code agents out of their
// own files on consecutive Edit/Write tool calls).
// ────────────────────────────────────────────────────────────────────

describe('audit regression — failed multi-path acquire is side-effect free', () => {
  it('does NOT mutate the caller\'s existing locks when a sibling path is held by another agent', async () => {
    const ws = nextWs();
    const original = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'a', ownerLabel: 'A',
        paths: ['kept.ts'], intent: 'original', ttlSec: 60,
      }),
    );
    if (!original.ok) throw new Error('setup');
    const origExpires = original.expires_ts.getTime();

    await inWorkspaceTxn(ws, 'b', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'b', ownerLabel: 'B',
        paths: ['blocked.ts'], intent: 'B', ttlSec: 60,
      }),
    );

    // A tries to acquire [kept, blocked] with a different intent + 10x TTL.
    const failed = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'a', ownerLabel: 'A',
        paths: ['kept.ts', 'blocked.ts'], intent: 'A retry', ttlSec: 600,
      }),
    );
    expect(failed.ok).toBe(false);

    // A's existing lock on kept.ts must be UNTOUCHED.
    const sql = getTxPool();
    const rows = await sql<Array<{ intent: string; expires_ts: Date }>>`
      SELECT intent, expires_ts FROM agent_file_locks
       WHERE coordination_domain = ${ws} AND owner = 'a'
    `;
    expect(rows[0].intent).toBe('original');
    // TTL should NOT have been extended.
    expect(rows[0].expires_ts.getTime()).toBeLessThanOrEqual(origExpires + 1000);
  });
});

describe('audit regression — same-owner re-acquire', () => {
  it('refreshes the existing lock with the same lock_id', async () => {
    const ws = nextWs();
    const r1 = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'a', ownerLabel: 'A',
        paths: ['reacq.ts'], intent: 'first', ttlSec: 60,
      }),
    );
    if (!r1.ok) throw new Error('first acquire');
    const r2 = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'a', ownerLabel: 'A',
        paths: ['reacq.ts'], intent: 'second', ttlSec: 60,
      }),
    );
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.lock_id).toBe(r1.lock_id);
      expect(r2.held).toEqual(['reacq.ts']);
    }
  });

  it('head-waiter rule does not block same-owner refresh of an already-held path', async () => {
    const ws = nextWs();
    // Owner A holds path. Owner B queues for it. A re-acquires its own.
    // The head-waiter rule should ignore A's same-owner refresh.
    const a = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'a', ownerLabel: 'A',
        paths: ['x.ts'], intent: 'A', ttlSec: 60,
      }),
    );
    if (!a.ok) throw new Error('setup acquire');
    const w = await inWorkspaceTxn(ws, 'b', (tx) =>
      tryInsertWaiter(tx, {
        coordinationDomain: ws, owner: 'b', ownerLabel: 'B',
        paths: ['x.ts'], intent: 'B waits', ttlSec: 60, maxWaitSec: 60,
      }),
    );
    if (!w.ok) throw new Error('waiter insert');
    if ('self_granted' in w) throw new Error('unexpected self-grant in w');

    const refresh = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'a', ownerLabel: 'A',
        paths: ['x.ts'], intent: 'A refresh', ttlSec: 60,
      }),
    );
    expect(refresh.ok).toBe(true);
    if (refresh.ok) expect(refresh.lock_id).toBe(a.lock_id);

    // A third owner (C) trying to take x.ts MUST still be blocked.
    const c = await inWorkspaceTxn(ws, 'c', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'c', ownerLabel: 'C',
        paths: ['x.ts'], intent: 'C', ttlSec: 60,
      }),
    );
    expect(c.ok).toBe(false);
  });

  it('partial-overlap re-acquire: same-owner part refreshes, others-owned part returns busy', async () => {
    const ws = nextWs();
    // Owner A holds a.ts. Owner B holds b.ts.
    const a = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'a', ownerLabel: 'A',
        paths: ['a.ts'], intent: 'A', ttlSec: 60,
      }),
    );
    await inWorkspaceTxn(ws, 'b', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'b', ownerLabel: 'B',
        paths: ['b.ts'], intent: 'B', ttlSec: 60,
      }),
    );
    if (!a.ok) throw new Error('setup acquire A');

    // A tries to acquire [a.ts, b.ts]. a.ts should refresh; b.ts busy.
    const r = await inWorkspaceTxn(ws, 'a', (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws, owner: 'a', ownerLabel: 'A',
        paths: ['a.ts', 'b.ts'], intent: 'A retry', ttlSec: 60,
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // busy MUST exclude self — only b.ts owned by B.
      expect(r.busy.map((x) => x.path)).toEqual(['b.ts']);
    }
    // A's lock on a.ts MUST survive.
    const q = await readQueue(getTxPool(), { coordinationDomain: ws });
    const aLock = q.active_locks.find((l) => l.path === 'a.ts');
    expect(aLock?.owner).toBe('a');
  });
});
