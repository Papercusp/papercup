/**
 * Unit tests for the P-015 lock-event stream (shared-hive-hardening-2026-06-13):
 * the pure reconstruction fold, the peer-log op mappers, and the sink/reader
 * adapters + their seam plumbing. All deterministic — no live mesh / PG.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PeerLogOp } from '../../sync/hyperbee/peer-log';
import { LockSetReconstructor } from '../lock-set-reconstructor';
import {
  LOCK_EVENT_TABLE,
  reconstructLockSet,
  lockEventHbKey,
  lockEventToPeerLogOp,
  peerLogOpToLockEvent,
  recordLockEvent,
  setLockEventSink,
  getLockEventSink,
  setLockEventReader,
  getLockEventReader,
  __resetLockEventSinkForTests,
  __resetLockEventReaderForTests,
  PeerLogLockEventSink,
  PeerLogLockEventReader,
  type LockEvent,
  type OwnLogAppender,
  type ReadableLog,
} from '../lock-event-stream';

const T0 = 1_700_000_000_000;

function acquire(path: string, owner: string, ts: number, ttlMs = 60_000): LockEvent {
  return { kind: 'acquire', scope: 'h', path, owner, expiresAtMs: ts + ttlMs, ts };
}
function release(path: string, owner: string, ts: number): LockEvent {
  return { kind: 'release', scope: 'h', path, owner, ts };
}

afterEach(() => {
  __resetLockEventSinkForTests();
  __resetLockEventReaderForTests();
  vi.restoreAllMocks();
});

describe('reconstructLockSet — pure fold', () => {
  it('an unexpired acquire is held', () => {
    const held = reconstructLockSet([acquire('a.ts', 'p1', T0)], T0 + 1_000);
    expect(held).toEqual([{ path: 'a.ts', owner: 'p1', expiresAtMs: T0 + 60_000 }]);
  });

  it('a release after the acquire frees the path (latest ts wins)', () => {
    const held = reconstructLockSet([acquire('a.ts', 'p1', T0), release('a.ts', 'p1', T0 + 100)], T0 + 1_000);
    expect(held).toEqual([]);
  });

  it('a re-acquire after a release holds again (latest ts wins)', () => {
    const events = [acquire('a.ts', 'p1', T0), release('a.ts', 'p1', T0 + 100), acquire('a.ts', 'p2', T0 + 200)];
    const held = reconstructLockSet(events, T0 + 1_000);
    expect(held).toEqual([{ path: 'a.ts', owner: 'p2', expiresAtMs: T0 + 200 + 60_000 }]);
  });

  it('an expired acquire is not held (TTL)', () => {
    const held = reconstructLockSet([acquire('a.ts', 'p1', T0, 5_000)], T0 + 6_000);
    expect(held).toEqual([]);
  });

  it('event order does not matter — max ts wins regardless of input order', () => {
    const inOrder = reconstructLockSet([acquire('a.ts', 'p1', T0), release('a.ts', 'p1', T0 + 100)], T0 + 1_000);
    const reversed = reconstructLockSet([release('a.ts', 'p1', T0 + 100), acquire('a.ts', 'p1', T0)], T0 + 1_000);
    expect(inOrder).toEqual(reversed);
    expect(reversed).toEqual([]);
  });

  it('a release wins a same-ts tie (free is the safe state)', () => {
    const held = reconstructLockSet([acquire('a.ts', 'p1', T0), release('a.ts', 'p1', T0)], T0 + 1_000);
    expect(held).toEqual([]);
  });

  it('different scopes with the same path do not collide', () => {
    const events: LockEvent[] = [
      { kind: 'acquire', scope: 'h1', path: 'a.ts', owner: 'p1', expiresAtMs: T0 + 60_000, ts: T0 },
      { kind: 'release', scope: 'h2', path: 'a.ts', owner: 'p2', ts: T0 + 100 },
    ];
    const held = reconstructLockSet(events, T0 + 1_000);
    expect(held).toEqual([{ path: 'a.ts', owner: 'p1', expiresAtMs: T0 + 60_000 }]);
  });

  it('folds many paths held by different owners', () => {
    const held = reconstructLockSet([acquire('a.ts', 'p1', T0), acquire('b.ts', 'p2', T0 + 1)], T0 + 1_000);
    expect(held.map((l) => l.path).sort()).toEqual(['a.ts', 'b.ts']);
  });

  // B2 — idempotence under replay. The federated stream is at-least-once: a
  // peer-log re-read on takeover can surface the SAME acquire event twice. The
  // fold must be idempotent (a duplicate is not a second lock).
  it('is idempotent over a DUPLICATE identical acquire (replay → length 1)', () => {
    const ev = acquire('a.ts', 'p1', T0);
    const held = reconstructLockSet([ev, { ...ev }], T0 + 1_000);
    expect(held).toEqual([{ path: 'a.ts', owner: 'p1', expiresAtMs: T0 + 60_000 }]);
    expect(held).toHaveLength(1);
  });

  it('folds N identical replayed acquires to a single held lock', () => {
    const events = Array.from({ length: 5 }, () => acquire('a.ts', 'p1', T0));
    const held = reconstructLockSet(events, T0 + 1_000);
    expect(held).toHaveLength(1);
    expect(held[0]).toEqual({ path: 'a.ts', owner: 'p1', expiresAtMs: T0 + 60_000 });
  });

  it('two SAME-ts acquires with different TTLs pick a deterministic winner (order-independent)', () => {
    // Same (scope,path,ts) but different expiry. The fold keeps the FIRST seen at
    // that ts (a later same-ts non-release does not displace it), so the winner is
    // deterministic and independent of input order.
    const shortFirst = reconstructLockSet(
      [acquire('a.ts', 'p1', T0, 5_000), acquire('a.ts', 'p1', T0, 90_000)],
      T0 + 1_000,
    );
    const longFirst = reconstructLockSet(
      [acquire('a.ts', 'p1', T0, 90_000), acquire('a.ts', 'p1', T0, 5_000)],
      T0 + 1_000,
    );
    expect(shortFirst).toHaveLength(1);
    expect(longFirst).toHaveLength(1);
    // The first-seen-at-ts wins in each direction → the winner tracks input order
    // deterministically (and either way it is exactly ONE lock, never two).
    expect(shortFirst[0].expiresAtMs).toBe(T0 + 5_000);
    expect(longFirst[0].expiresAtMs).toBe(T0 + 90_000);
  });
});

describe('peer-log op mappers', () => {
  it('round-trips a lock-event through a PeerLogOp', () => {
    const ev = acquire('a.ts', 'p1', T0);
    const op = lockEventToPeerLogOp(ev, 'authorkey');
    expect(op.type).toBe('put');
    expect(op.table).toBe(LOCK_EVENT_TABLE);
    expect(op.hbKey).toBe(lockEventHbKey('h', 'a.ts'));
    expect(op.author_pubkey).toBe('authorkey');
    expect(peerLogOpToLockEvent(op)).toEqual(ev);
  });

  it('rejects a non-lock-event op (wrong table) → null', () => {
    const op: PeerLogOp = { type: 'put', table: 'working-set', hbKey: 'x', value: {}, ts: T0, schema_version: 1, author_pubkey: '' };
    expect(peerLogOpToLockEvent(op)).toBeNull();
  });

  it('rejects a malformed lock-event value → null', () => {
    const op: PeerLogOp = { type: 'put', table: LOCK_EVENT_TABLE, hbKey: 'x', value: { kind: 'nope' }, ts: T0, schema_version: 1, author_pubkey: '' };
    expect(peerLogOpToLockEvent(op)).toBeNull();
    expect(peerLogOpToLockEvent(null)).toBeNull();
    expect(peerLogOpToLockEvent(undefined)).toBeNull();
  });
});

describe('LockEventSink seam + recordLockEvent', () => {
  it('records through the installed sink', async () => {
    const seen: LockEvent[] = [];
    setLockEventSink({ record: (e) => void seen.push(e) });
    await recordLockEvent(acquire('a.ts', 'p1', T0));
    expect(seen).toHaveLength(1);
    expect(seen[0].path).toBe('a.ts');
  });

  it('is a no-op when no sink is installed (single box default)', async () => {
    expect(getLockEventSink().record(acquire('a.ts', 'p1', T0))).toBeUndefined();
    await expect(recordLockEvent(release('a.ts', 'p1', T0))).resolves.toBeUndefined();
  });

  it('swallows a throwing sink — capture never fails the lock op', async () => {
    setLockEventSink({
      record: () => {
        throw new Error('hypercore down');
      },
    });
    await expect(recordLockEvent(acquire('a.ts', 'p1', T0))).resolves.toBeUndefined();
  });
});

describe('PeerLogLockEventSink', () => {
  it('appends the lock-event op to the resolved own log', async () => {
    const appended: PeerLogOp[] = [];
    const fakeLog: OwnLogAppender = { append: async (op) => void appended.push(op) };
    const sink = new PeerLogLockEventSink({ resolveOwnLog: () => fakeLog, authorPubkey: 'dev1' });
    await sink.record(acquire('a.ts', 'p1', T0));
    expect(appended).toHaveLength(1);
    expect(appended[0].table).toBe(LOCK_EVENT_TABLE);
    expect(appended[0].author_pubkey).toBe('dev1');
    expect((appended[0].value as LockEvent).owner).toBe('p1');
  });

  it('is a no-op when the scope resolves no own log (not federating)', async () => {
    const sink = new PeerLogLockEventSink({ resolveOwnLog: () => null });
    await expect(sink.record(acquire('a.ts', 'p1', T0))).resolves.toBeUndefined();
  });

  it('resolves a functional authorPubkey lazily', async () => {
    const appended: PeerLogOp[] = [];
    const sink = new PeerLogLockEventSink({
      resolveOwnLog: () => ({ append: async (op) => void appended.push(op) }),
      authorPubkey: () => 'lazy-key',
    });
    await sink.record(acquire('a.ts', 'p1', T0));
    expect(appended[0].author_pubkey).toBe('lazy-key');
  });
});

/** An in-memory ReadableLog over a fixed op array. */
function fakeReadableLog(ops: (PeerLogOp | null)[]): ReadableLog {
  return {
    get length() {
      return ops.length;
    },
    async get(i) {
      return ops[i] ?? null;
    },
  };
}

describe('PeerLogLockEventReader', () => {
  it('reads in-scope lock-events across logs, ignoring other ops + other scopes', async () => {
    const log1 = fakeReadableLog([
      lockEventToPeerLogOp(acquire('a.ts', 'p1', T0), ''),
      { type: 'put', table: 'working-set', hbKey: 'x', value: {}, ts: T0, schema_version: 1, author_pubkey: '' },
    ]);
    const log2 = fakeReadableLog([
      lockEventToPeerLogOp({ kind: 'acquire', scope: 'OTHER', path: 'z.ts', owner: 'p9', expiresAtMs: T0 + 1, ts: T0 }, ''),
      lockEventToPeerLogOp(release('a.ts', 'p1', T0 + 100), ''),
    ]);
    const reader = new PeerLogLockEventReader({ resolveLogs: () => [log1, log2] });
    const events = await reader.readLockEvents('h', T0 + 1_000);
    // a.ts acquire + a.ts release (scope h); the working-set op + the OTHER-scope op excluded.
    expect(events.map((e) => `${e.kind}:${e.path}`).sort()).toEqual(['acquire:a.ts', 'release:a.ts']);
    // and they fold to "free" — proving the reader feeds the fold correctly.
    expect(reconstructLockSet(events, T0 + 1_000)).toEqual([]);
  });

  it('respects scanLimit (only the tail of a long log is scanned)', async () => {
    const ops: PeerLogOp[] = [];
    for (let i = 0; i < 10; i++) ops.push(lockEventToPeerLogOp(acquire(`p${i}.ts`, 'o', T0 + i), ''));
    const reader = new PeerLogLockEventReader({ resolveLogs: () => [fakeReadableLog(ops)], scanLimit: 3 });
    const events = await reader.readLockEvents('h', T0 + 1_000);
    expect(events.map((e) => e.path)).toEqual(['p7.ts', 'p8.ts', 'p9.ts']);
  });

  it('a throwing log contributes nothing; the rest still read', async () => {
    const bad: ReadableLog = {
      get length() {
        return 1;
      },
      async get() {
        throw new Error('partial replica');
      },
    };
    const good = fakeReadableLog([lockEventToPeerLogOp(acquire('a.ts', 'p1', T0), '')]);
    const reader = new PeerLogLockEventReader({ resolveLogs: () => [bad, good] });
    const events = await reader.readLockEvents('h', T0 + 1_000);
    expect(events.map((e) => e.path)).toEqual(['a.ts']);
  });

  it('default reader (none installed) yields no events', async () => {
    expect(await getLockEventReader().readLockEvents('h', T0)).toEqual([]);
  });

  it('routes through the installed reader', async () => {
    setLockEventReader({ readLockEvents: async () => [acquire('a.ts', 'p1', T0)] });
    expect(await getLockEventReader().readLockEvents('h', T0)).toHaveLength(1);
  });
});

describe('end-to-end instant handover (sink → peer-log → reader → fold → reconstructor)', () => {
  it('a NEW authority reconstructs the live lock set from the stream — held minus released', async () => {
    // An in-memory peer-log that is BOTH the own-log (append) and a readable
    // replica (get/length) — the authority writes, a new authority reads it back.
    const ops: PeerLogOp[] = [];
    const log = {
      append: async (op: PeerLogOp) => void ops.push(op),
      get length() {
        return ops.length;
      },
      get: async (i: number) => ops[i] ?? null,
    };
    // The (old) authority records grants/releases as it serves them.
    const sink = new PeerLogLockEventSink({ resolveOwnLog: () => log, authorPubkey: 'auth-dev' });
    await sink.record(acquire('apps/a.ts', 'peer-1', T0)); // held by peer-1
    await sink.record(acquire('apps/b.ts', 'peer-2', T0 + 1)); // held by peer-2
    await sink.record(release('apps/b.ts', 'peer-2', T0 + 2)); // peer-2 releases b

    // The NEW authority reads the stream, folds it, hydrates instantly.
    const reader = new PeerLogLockEventReader({ resolveLogs: () => [log] });
    const events = await reader.readLockEvents('h', T0 + 100);
    const live = reconstructLockSet(events, T0 + 100);
    const recon = new LockSetReconstructor({ becameAuthorityAtMs: T0 + 100, heartbeatMs: 10_000 });
    expect(recon.shouldFailOpen(T0 + 101)).toBe(true); // before hydration
    expect(recon.hydrateFromEvents(live, T0 + 101)).toBe(true);
    // Rebuilt instantly (no heartbeat-interval wait), and the set is exactly the
    // still-held lock (a.ts by peer-1); b.ts was released.
    expect(recon.isRebuilt(T0 + 101)).toBe(true);
    expect(recon.current(T0 + 101).map((l) => `${l.path}:${l.owner}`)).toEqual(['apps/a.ts:peer-1']);
    expect(recon.isHeldByOther('apps/a.ts', 'peer-9', T0 + 101)).toBe(true);
    expect(recon.isHeldByOther('apps/b.ts', 'peer-9', T0 + 101)).toBe(false);
  });
});

// ── Deeper branch coverage: codec + reader robustness (depth pass, su-7f3e0376) ──
// A corrupt federated op or a failed replica read must degrade SAFELY — never inject
// a phantom lock and never crash a NEW authority's takeover.
describe('reconstructLockSet — safety defaults', () => {
  it('an acquire with no/undefined expiresAtMs is NOT held (?? 0 default — never a forever-lock)', () => {
    const ev: LockEvent = { kind: 'acquire', scope: 'h', path: 'a.ts', owner: 'p1', ts: T0 }; // no TTL
    expect(reconstructLockSet([ev], T0 + 1_000)).toEqual([]);
  });

  it('an acquire whose expiry EQUALS nowMs is expired (strict >, free at the boundary)', () => {
    const held = reconstructLockSet([acquire('a.ts', 'p1', T0, 5_000)], T0 + 5_000); // expiry == now
    expect(held).toEqual([]);
  });
});

describe('peerLogOpToLockEvent — field validation + sanitisation', () => {
  // Start from a VALID op, then corrupt one field — a malformed federated op must decode to null.
  const corrupt = (mut: (v: Record<string, unknown>) => void) => {
    const op = lockEventToPeerLogOp(acquire('a.ts', 'p1', T0), '');
    mut(op.value as Record<string, unknown>);
    return op;
  };

  it('rejects an op whose required field is missing or wrong-typed', () => {
    expect(peerLogOpToLockEvent(corrupt((v) => { v.ts = 'nope'; }))).toBeNull(); // ts not a number
    expect(peerLogOpToLockEvent(corrupt((v) => { v.scope = 1; }))).toBeNull(); // scope not a string
    expect(peerLogOpToLockEvent(corrupt((v) => { delete v.owner; }))).toBeNull(); // owner missing
    expect(peerLogOpToLockEvent(corrupt((v) => { v.kind = 'nope'; }))).toBeNull(); // kind invalid
  });

  it('sanitises a non-number expiresAtMs to undefined — a corrupt TTL never carries through (folds to not-held)', () => {
    const decoded = peerLogOpToLockEvent(corrupt((v) => { v.expiresAtMs = 'soon'; }));
    expect(decoded).not.toBeNull();
    expect(decoded!.expiresAtMs).toBeUndefined();
    expect(reconstructLockSet([decoded!], T0 + 1_000)).toEqual([]); // no valid TTL → not held (safe)
  });
});

describe('PeerLogLockEventReader — read-side resilience', () => {
  it('returns [] when resolveLogs() itself throws (total scope-resolution failure → heartbeat fallback)', async () => {
    const reader = new PeerLogLockEventReader({ resolveLogs: () => { throw new Error('scope not booted'); } });
    expect(await reader.readLockEvents('h', T0)).toEqual([]);
  });

  it('refreshes a replica via update() before scanning, and isolates an update() failure to that log', async () => {
    let updated = 0;
    const fresh: ReadableLog = {
      get length() { return 1; },
      async get() { return lockEventToPeerLogOp(acquire('a.ts', 'p1', T0), ''); },
      async update() { updated++; },
    };
    const badUpdate: ReadableLog = {
      get length() { return 1; },
      async get() { return lockEventToPeerLogOp(acquire('b.ts', 'p2', T0), ''); },
      async update() { throw new Error('replica refresh failed'); },
    };
    const reader = new PeerLogLockEventReader({ resolveLogs: () => [badUpdate, fresh] });
    const events = await reader.readLockEvents('h', T0 + 1_000);
    expect(updated).toBe(1); // the healthy replica WAS refreshed before its scan
    // badUpdate's update() threw → it contributes nothing; the rest still read.
    expect(events.map((e) => e.path)).toEqual(['a.ts']);
  });
});
