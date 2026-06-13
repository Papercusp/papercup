/**
 * Unit tests for the P-015 lock-event stream (shared-hive-hardening-2026-06-13):
 * the pure reconstruction fold, the peer-log op mappers, and the sink/reader
 * adapters + their seam plumbing. All deterministic — no live mesh / PG.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PeerLogOp } from '../../sync/hyperbee/peer-log';
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
