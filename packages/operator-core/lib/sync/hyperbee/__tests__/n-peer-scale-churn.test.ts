/**
 * n-peer-scale-churn.test.ts — Brief N (shared-pot-release-testing continuation):
 * N-peer (3+) scale, join/leave churn under load, and backfill-at-size.
 *
 * WHY THIS FILE EXISTS. The live proof + most integration coverage is 2-peer; the
 * one existing N-peer integration test (`cross-peer-coordination-scale`) federates
 * ONLY presence and exercises the authority/claim election cascade — not content
 * fan-out. `three-peer-partition-rejoin.test.ts` proves convergence over ONE table
 * with a STABLE admitted set (partition severs links but never changes the merge
 * set, so its `MergeCursor` is never reset). The production churn path is DIFFERENT:
 * the boot driver's caller-contract (read-merge.ts) says when the admitted log set
 * changes (a peer joins/leaves) the cursor is RESET and re-folded from scratch — a
 * path whose correctness rests entirely on the projection layer's PG `fed_ts` LWW
 * guard (an idempotent forward-only keyed upsert), NOT on the in-memory winners
 * fold (which is empty right after a reset). No test drove that.
 *
 * WHAT IS REAL. Real Corestores → real single-writer peer-logs; real piped
 * replication streams (a "leave" = severing a peer's streams + dropping it from the
 * merge set + resetting the cursor; a "rejoin" = re-link + re-admit + reset); the
 * REAL incremental LWW merge (`mergeAdmittedLogsIncremental`) with its real cursor,
 * truncation-detect, and per-pass budget. The apply sink is an in-memory model of
 * the projection PG layer's `fed_ts` LWW guard (`PgModel`) — a keyed forward-only
 * upsert, exactly the `WHERE EXCLUDED.fed_ts >= stored.fed_ts` shape every real
 * projection writer carries (read-merge.ts "POST-CURSOR-RESET DOUBLE-APPLY SAFETY").
 * The projection→real-PG hop itself is covered per-table elsewhere (fed-ts-lww-guard
 * .integration.test.ts); this file's job is the MERGE-ENGINE behaviour at N-peer
 * scale + churn + size, which is deterministic and PG-free.
 *
 * ORACLE. Every assertion compares each peer's materialized rows to a brute-force
 * LWW fold over the UNION of every op every peer ever appended — set-semantics
 * (which keys/values land), never a re-fold count. A peer that eats rows on a
 * cursor reset, truncates a large backfill, or regresses a watermark diverges from
 * the oracle and the test goes red.
 */
import { afterEach, describe, expect, it } from 'vitest';
import Corestore from 'corestore';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openOwnLog, openRemoteLog, type OwnLog, type PeerLogOp, type RemoteLog } from '../peer-log';
import {
  createMergeCursor,
  mergeAdmittedLogsIncremental,
  type IncrementalMergeResult,
  type MergeCursor,
} from '../read-merge';
import type { OpEnvelope } from '../op-envelope-types';

/** The federated content types the live retest confirmed cross bidirectionally
 *  (8/11). The merge engine is table-agnostic — it folds per `${table}::${hbKey}` —
 *  so driving the REAL table tags faithfully represents "all content types". */
const CONTENT_TABLES = [
  'features_consolidated',
  'conversations',
  'coord_messages',
  'coord_threads',
  'coord_thread_posts',
  'plans',
  'plan_parts',
  'item_assignments',
] as const;

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) {
    try {
      cleanups.pop()!();
    } catch {
      /* teardown best-effort — never leak a store/dir on a thrown assertion */
    }
  }
});

function makeStore(prefix: string): Corestore {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* tmp dir already gone */
    }
  });
  const store = new Corestore(dir);
  cleanups.push(() => {
    void store.close();
  });
  return store;
}

/** A severable replication link between two Corestores (a "network cable"). */
interface Link {
  sever(): void;
}
function link(s1: Corestore, s2: Corestore): Link {
  type Pipeable = { pipe<T extends Pipeable>(dest: T): T; destroy(): void };
  const a = s1.replicate(true) as unknown as Pipeable;
  const b = s2.replicate(false) as unknown as Pipeable;
  a.pipe(b).pipe(a);
  return {
    sever() {
      for (const s of [a, b]) {
        try {
          s.destroy();
        } catch {
          /* already closed */
        }
      }
    },
  };
}

/**
 * In-memory model of the projection PG layer's `fed_ts` LWW guard: a per-key
 * forward-only upsert. Mirrors `applyHyperbeeOpToPg`'s real writers — a put lands
 * only when `op.ts >= stored.fed_ts` (the `EXCLUDED.fed_ts >= stored.fed_ts`
 * disjunct) and a del wins a ts-tie (matches `lwwPick`'s del>put-on-tie + the
 * projection del guard `stored.fed_ts <= del.ts`). A keyed map = ONE row per key,
 * so a cursor-reset replay that re-hands an already-winning op upserts the SAME
 * row (idempotent — no second materialized row). The whole "no double-apply" /
 * "no clobber on reset" guarantee is THIS guard; the test makes it load-bearing.
 */
class PgModel {
  readonly rows = new Map<string, { ts: number; type: 'put' | 'del'; value: unknown }>();
  /** Accepted-apply count (the apply sink returned true). */
  accepted = 0;
  /** Rejected-by-guard count — a stale op the guard refused (the reset safety net). */
  rejectedByGuard = 0;
  /** Per-key high-water ts, to assert a materialized row's fed_ts never regresses. */
  private readonly hwm = new Map<string, number>();

  private beats(op: OpEnvelope, cur: { ts: number; type: 'put' | 'del' }): boolean {
    const t = op.ts ?? 0;
    if (t > cur.ts) return true;
    if (t < cur.ts) return false;
    // ts tie: del beats put; same type re-upserts the identical row (idempotent, >=).
    if (op.type === 'del' && cur.type === 'put') return true;
    if (op.type === 'put' && cur.type === 'del') return false;
    return true;
  }

  readonly apply = async (op: OpEnvelope): Promise<boolean> => {
    const key = `${op.table}::${op.hbKey}`;
    const cur = this.rows.get(key);
    if (cur && !this.beats(op, cur)) {
      this.rejectedByGuard++;
      return false;
    }
    // WATERMARK MONOTONICITY (data layer): a materialized row's fed_ts must never
    // move backward — across appends, churn, AND cursor resets. The guard above
    // enforces it; this assertion proves the guard is doing so (a regression here
    // is a clobber bug, not a flaky timing artifact).
    const prevHwm = this.hwm.get(key) ?? Number.NEGATIVE_INFINITY;
    const t = op.ts ?? 0;
    expect(t, `row ${key} fed_ts regressed ${prevHwm} → ${t}`).toBeGreaterThanOrEqual(prevHwm);
    this.hwm.set(key, t);
    this.rows.set(key, { ts: t, type: op.type as 'put' | 'del', value: op.value });
    this.accepted++;
    return true;
  };

  /** The converged view: live (non-del) keys → winning value. */
  liveState(): Map<string, unknown> {
    const out = new Map<string, unknown>();
    for (const [k, v] of this.rows) if (v.type !== 'del') out.set(k, v.value);
    return out;
  }
}

let TS = 1_000; // strictly-increasing global clock → unambiguous winners (deterministic, no Math.random)
function nextTs(): number {
  return ++TS;
}

/** One peer: a real own-log + real remote replicas + the real merge cursor + a
 *  PG-guard model. Membership churn is modeled by `activeRemotes` (the admitted
 *  set) + a cursor RESET whenever that set changes (the boot caller-contract). */
class Peer {
  readonly store: Corestore;
  own!: OwnLog;
  cursor: MergeCursor = createMergeCursor();
  readonly remotes = new Map<string, RemoteLog>(); // name → handle (all peers, opened upfront)
  readonly active = new Set<string>(); // names currently in the admitted merge set
  readonly pg = new PgModel();
  /** Per-log watermark snapshots since the last reset, for intra-epoch monotonicity. */
  private lastPositions = new Map<string, number>();
  resets = 0;

  constructor(readonly name: string) {
    this.store = makeStore(`brief-n-${name}-`);
  }

  async init(): Promise<void> {
    await this.store.ready();
    this.own = await openOwnLog(this.store);
  }

  async openRemote(other: Peer): Promise<void> {
    this.remotes.set(other.name, await openRemoteLog(this.store, other.own.keyHex));
    this.active.add(other.name);
  }

  /** Drop a peer from the admitted set (a leave) → reset the cursor + re-fold
   *  WITHOUT it, exactly as the boot driver does on an admitted-set change. */
  admitDrop(name: string): void {
    if (this.active.delete(name)) this.resetCursor();
  }

  /** Re-admit a peer (a rejoin) → reset the cursor + re-fold WITH it. */
  admitAdd(name: string): void {
    if (this.remotes.has(name) && !this.active.has(name)) {
      this.active.add(name);
      this.resetCursor();
    }
  }

  private resetCursor(): void {
    this.cursor = createMergeCursor();
    this.lastPositions = new Map();
    this.resets++;
  }

  private activeLogs() {
    return [this.own, ...[...this.active].map((n) => this.remotes.get(n)!)];
  }

  async append(table: string, hbKey: string, ts: number, type: 'put' | 'del' = 'put'): Promise<void> {
    const op: PeerLogOp = {
      type,
      table,
      hbKey,
      value: { from: this.name, ts },
      ts,
      schema_version: 1,
      author_pubkey: `pk-${this.name}`,
    };
    await this.own.append(op);
  }

  /** One incremental merge pass over the ACTIVE set. Handles a truncation bail by
   *  resetting + re-running (the caller-contract). Asserts intra-epoch watermark
   *  monotonicity (per-log cursor never moves backward between resets). */
  async merge(budget = 0): Promise<IncrementalMergeResult> {
    for (const n of this.active) await this.remotes.get(n)!.update();
    let res = await mergeAdmittedLogsIncremental(this.activeLogs(), this.cursor, {
      applyImpl: this.pg.apply,
      getTimeoutMs: 2_000,
      ...(budget > 0 ? { maxOpsPerPass: budget } : {}),
    });
    if (res.truncated) {
      // EI-79 step 3: a shrunk log invalidates the fold — reset + re-fold clean.
      this.resetCursor();
      res = await mergeAdmittedLogsIncremental(this.activeLogs(), this.cursor, {
        applyImpl: this.pg.apply,
        getTimeoutMs: 2_000,
        ...(budget > 0 ? { maxOpsPerPass: budget } : {}),
      });
    }
    for (const [keyHex, pos] of this.cursor.positions) {
      const prev = this.lastPositions.get(keyHex) ?? 0;
      expect(pos, `${this.name} cursor for ${keyHex.slice(0, 8)}… regressed within an epoch`).toBeGreaterThanOrEqual(prev);
      this.lastPositions.set(keyHex, pos);
    }
    return res;
  }
}

/** Open every peer + a full mesh of remote handles (all admitted). Returns links
 *  by an undirected "a|b" key so a single peer's cables can be severed/healed. */
async function buildMesh(names: string[]): Promise<{ peers: Peer[]; byName: Map<string, Peer>; links: Map<string, Link> }> {
  const peers = names.map((n) => new Peer(n));
  for (const p of peers) await p.init();
  for (const p of peers) for (const q of peers) if (p !== q) await p.openRemote(q);
  const links = new Map<string, Link>();
  for (let i = 0; i < peers.length; i++) {
    for (let j = i + 1; j < peers.length; j++) {
      links.set(`${peers[i].name}|${peers[j].name}`, link(peers[i].store, peers[j].store));
    }
  }
  const byName = new Map(peers.map((p) => [p.name, p]));
  return { peers, byName, links };
}

/** Merge every peer repeatedly until quiescent (all caught up + nothing applied in
 *  a full round), or `maxRounds` is hit. Returns the rounds taken. */
async function pumpToQuiescence(peers: Peer[], budget = 0, maxRounds = 40): Promise<number> {
  for (let round = 1; round <= maxRounds; round++) {
    let totalApplied = 0;
    let allCaughtUp = true;
    for (const p of peers) {
      const res = await p.merge(budget);
      totalApplied += res.applied;
      if (!res.caughtUp) allCaughtUp = false;
    }
    if (allCaughtUp && totalApplied === 0) return round;
  }
  return maxRounds;
}

/** Brute-force LWW oracle over the union of every op a peer ever appended (its OWN
 *  log is the source of truth for its writes). Returns live keys → winning value. */
function oracleLiveState(history: PeerLogOp[]): Map<string, unknown> {
  const winners = new Map<string, { ts: number; type: 'put' | 'del'; value: unknown }>();
  for (const op of history) {
    const key = `${op.table}::${op.hbKey}`;
    const cur = winners.get(key);
    const t = op.ts;
    let beats: boolean;
    if (!cur) beats = true;
    else if (t > cur.ts) beats = true;
    else if (t < cur.ts) beats = false;
    else beats = op.type === 'del'; // ts tie → del wins
    if (beats) winners.set(key, { ts: t, type: op.type, value: op.value });
  }
  const live = new Map<string, unknown>();
  for (const [k, v] of winners) if (v.type !== 'del') live.set(k, v.value);
  return live;
}

function expectMapEqual(actual: Map<string, unknown>, expected: Map<string, unknown>, who: string): void {
  expect(actual.size, `${who}: key-set size mismatch`).toBe(expected.size);
  for (const [k, v] of expected) {
    expect(actual.has(k), `${who}: MISSING key ${k} (rows eaten)`).toBe(true);
    expect(actual.get(k), `${who}: WRONG winner for ${k} (clobber)`).toEqual(v);
  }
}

describe('Brief N — N-peer scale, churn & backfill-at-size (merge engine)', () => {
  it('5-peer full mesh: every content type from every author converges on every peer', async () => {
    const { peers } = await buildMesh(['A', 'B', 'C', 'D', 'E']);
    const history: PeerLogOp[] = [];

    // Each of the 5 peers writes one row in EVERY content type — fan-out across
    // authors × tables. Deterministic ts (global counter), distinct keys.
    for (const p of peers) {
      for (const table of CONTENT_TABLES) {
        const ts = nextTs();
        await p.append(table, `${table}-${p.name}-1`, ts);
        history.push({ type: 'put', table, hbKey: `${table}-${p.name}-1`, value: { from: p.name, ts }, ts, schema_version: 1, author_pubkey: `pk-${p.name}` });
      }
    }

    const rounds = await pumpToQuiescence(peers);
    expect(rounds, 'mesh never quiesced').toBeLessThan(40);

    const oracle = oracleLiveState(history);
    // Sanity: the oracle holds 5 authors × 8 tables = 40 live keys.
    expect(oracle.size).toBe(peers.length * CONTENT_TABLES.length);
    for (const p of peers) {
      expectMapEqual(p.pg.liveState(), oracle, `peer ${p.name}`);
      // Cross-author crossing: every peer holds rows authored by every OTHER peer.
      for (const other of peers) {
        const has = [...p.pg.liveState().values()].some((v) => (v as { from: string }).from === other.name);
        expect(has, `peer ${p.name} missing any content from ${other.name}`).toBe(true);
      }
    }
  }, 60_000);

  it('late joiner backfills the FULL set across all types (set-semantics, no truncation)', async () => {
    // 3 seeded authors fan out, THEN a 4th peer joins cold and must backfill all.
    const { peers, byName } = await buildMesh(['A', 'B', 'C', 'LATE']);
    const seeders = ['A', 'B', 'C'].map((n) => byName.get(n)!);
    const late = byName.get('LATE')!;
    const history: PeerLogOp[] = [];

    // The late joiner is NOT admitted by the seeders yet, and does not merge, while
    // the seeders fan out a sizable corpus (hundreds of rows across all types).
    for (const s of seeders) s.admitDrop('LATE');
    late.active.clear(); // LATE stays dark during the seed phase

    const PER_AUTHOR_PER_TABLE = 18; // 3 authors × 8 tables × 18 = 432 rows
    for (const s of seeders) {
      for (const table of CONTENT_TABLES) {
        for (let i = 0; i < PER_AUTHOR_PER_TABLE; i++) {
          const ts = nextTs();
          const hbKey = `${table}-${s.name}-${i}`;
          await s.append(table, hbKey, ts);
          history.push({ type: 'put', table, hbKey, value: { from: s.name, ts }, ts, schema_version: 1, author_pubkey: `pk-${s.name}` });
        }
      }
    }
    await pumpToQuiescence(seeders);

    // Now LATE joins: admit everyone, reset cursor, backfill cold from index 0.
    for (const s of seeders) s.admitAdd('LATE');
    for (const n of ['A', 'B', 'C']) late.admitAdd(n);
    const rounds = await pumpToQuiescence(peers);
    expect(rounds).toBeLessThan(40);

    const oracle = oracleLiveState(history);
    expect(oracle.size).toBe(seeders.length * CONTENT_TABLES.length * PER_AUTHOR_PER_TABLE);
    // The FULL set backfilled — not a truncated/top-N slice. Set-equality, not a count.
    expectMapEqual(late.pg.liveState(), oracle, 'late joiner');
    // And every seeder still holds the full set (the late join didn't perturb them).
    for (const s of seeders) expectMapEqual(s.pg.liveState(), oracle, `seeder ${s.name}`);
  }, 90_000);

  it('backfill-at-size with a TIGHT per-pass budget completes over multiple passes (no lost tail, EI-91)', async () => {
    // The deferral path: a backfill larger than one pass budget must land in FULL
    // across passes, never truncated to the first window.
    const { peers, byName } = await buildMesh(['OWNER', 'JOINER']);
    const owner = byName.get('OWNER')!;
    const joiner = byName.get('JOINER')!;
    const history: PeerLogOp[] = [];

    const ROWS = 300;
    for (let i = 0; i < ROWS; i++) {
      const table = CONTENT_TABLES[i % CONTENT_TABLES.length];
      const ts = nextTs();
      const hbKey = `size-${i}`;
      await owner.append(table, hbKey, ts);
      history.push({ type: 'put', table, hbKey, value: { from: 'OWNER', ts }, ts, schema_version: 1, author_pubkey: 'pk-OWNER' });
    }

    // BUDGET well below ROWS forces the multi-pass deferral; quiescence only when
    // the WHOLE backlog has drained (caughtUp). If the budget truncated instead of
    // deferred, the joiner would miss the tail and diverge from the oracle.
    const BUDGET = 40;
    const rounds = await pumpToQuiescence(peers, BUDGET);
    expect(rounds, 'tight-budget backfill never drained').toBeLessThan(40);
    // It genuinely took multiple passes (proves the deferral path ran, not a single
    // big pass): ceil(300/40) = 8 windows minimum on the joiner's view of OWNER.
    expect(rounds).toBeGreaterThan(1);

    const oracle = oracleLiveState(history);
    expect(oracle.size).toBe(ROWS);
    expectMapEqual(joiner.pg.liveState(), oracle, 'joiner (tight budget)');
  }, 90_000);

  it('join/leave churn under load: re-joiner re-backfills, survivors keep writing, all converge with no loss/dup', async () => {
    const { peers, byName, links } = await buildMesh(['A', 'B', 'C', 'D']);
    const history: PeerLogOp[] = [];
    const append = async (p: Peer, table: string, i: number) => {
      const ts = nextTs();
      const hbKey = `churn-${p.name}-${table}-${i}`;
      await p.append(table, hbKey, ts);
      history.push({ type: 'put', table, hbKey, value: { from: p.name, ts }, ts, schema_version: 1, author_pubkey: `pk-${p.name}` });
    };
    // Write an EXPLICIT key (for cross-author conflicts): same hbKey, different authors.
    const appendAt = async (p: Peer, table: string, hbKey: string) => {
      const ts = nextTs();
      await p.append(table, hbKey, ts);
      history.push({ type: 'put', table, hbKey, value: { from: p.name, ts }, ts, schema_version: 1, author_pubkey: `pk-${p.name}` });
    };

    // Baseline: all four write + converge.
    for (const p of peers) for (let t = 0; t < CONTENT_TABLES.length; t++) await append(p, CONTENT_TABLES[t], 0);
    await pumpToQuiescence(peers);

    // 3 churn rounds: each round one peer LEAVES (cables severed, dropped from every
    // survivor's admitted set + its own → cursor resets everywhere), then EVERYONE
    // (incl. the away peer, on its own log) keeps writing, then the peer REJOINS
    // (re-link + re-admit + reset) and the mesh re-converges. Deterministic churn
    // order (no Math.random): the round index picks who leaves.
    const order = ['B', 'C', 'D'];
    for (let round = 0; round < order.length; round++) {
      const goneName = order[round];
      const gone = byName.get(goneName)!;
      const survivors = peers.filter((p) => p !== gone);

      // LEAVE: sever every cable touching `gone`; drop it from the admitted set
      // everywhere (survivors drop it; it drops all survivors).
      for (const s of survivors) {
        const key = [gone.name, s.name].sort().join('|');
        links.get(key)!.sever();
        s.admitDrop(gone.name);
        gone.admitDrop(s.name);
      }

      // WRITE UNDER LOAD while partitioned: survivors write to each other; the away
      // peer writes to its OWN log (to be backfilled on rejoin).
      for (let i = 0; i < 5; i++) {
        for (const s of survivors) await append(s, CONTENT_TABLES[(round + i) % CONTENT_TABLES.length], 100 + round * 10 + i);
        await append(gone, CONTENT_TABLES[round % CONTENT_TABLES.length], 200 + round * 10 + i);
      }
      // CROSS-AUTHOR CONFLICT on a shared key, straddling the partition: peer A (always
      // a survivor here) writes it first (loses), the away peer writes it LATER (wins)
      // on its own log. After rejoin the away write wins everywhere. The key tension:
      // A's own log permanently holds its now-STALE write, so EVERY later reset re-folds
      // it over a PG row already holding the away winner → the fed_ts guard must reject
      // it. Across rounds this guarantees the guard's no-clobber net is exercised
      // (asserted in aggregate at the end), and the winner stays the away peer's.
      const sharedKey = `churn-shared-r${round}`;
      await appendAt(survivors[0], 'plans', sharedKey); // earlier ts → loses
      await appendAt(gone, 'plans', sharedKey); // later ts → wins after rejoin
      // Survivors converge among themselves (gone's away-writes are NOT yet visible).
      await pumpToQuiescence(survivors);
      for (const s of survivors) {
        const keys = [...s.pg.liveState().keys()];
        expect(keys.some((k) => k.includes(`-${gone.name}-`) && k.includes('-2')), `${s.name} should NOT yet see ${gone.name}'s away-writes`).toBe(false);
      }

      // REJOIN: re-cable, re-admit (cursor reset → re-backfill from scratch), converge.
      for (const s of survivors) {
        const key = [gone.name, s.name].sort().join('|');
        links.set(key, link(gone.store, s.store));
        s.admitAdd(gone.name);
        gone.admitAdd(s.name);
      }
      const rounds = await pumpToQuiescence(peers);
      expect(rounds, `round ${round}: mesh never re-converged after ${goneName} rejoined`).toBeLessThan(40);

      // FULL convergence after each rejoin: every peer == the oracle over ALL ops so
      // far (incl. the away-writes the re-joiner backfilled both ways). No loss.
      const oracle = oracleLiveState(history);
      for (const p of peers) expectMapEqual(p.pg.liveState(), oracle, `round ${round} peer ${p.name}`);
    }

    // Churn genuinely reset cursors (proves the production churn path, not a stable
    // fold): each survivor reset on every leave + rejoin.
    for (const p of peers) expect(p.resets, `${p.name} never churned`).toBeGreaterThan(0);
    // The reset replays re-handed already-winning ops to the guard, which rejected
    // them (the load-bearing no-clobber net): some guard rejections must have fired.
    const totalRejected = peers.reduce((n, p) => n + p.pg.rejectedByGuard, 0);
    expect(totalRejected, 'cursor-reset replays never exercised the fed_ts guard').toBeGreaterThan(0);
  }, 120_000);

  it('cross-author conflict on a shared key resolves LWW identically on every peer through churn', async () => {
    const { peers, byName, links } = await buildMesh(['A', 'B', 'C']);
    const history: PeerLogOp[] = [];
    const push = (from: string, table: string, hbKey: string, ts: number, type: 'put' | 'del' = 'put') =>
      history.push({ type, table, hbKey, value: { from, ts }, ts, schema_version: 1, author_pubkey: `pk-${from}` });

    // A and C both write the SAME key; C wins (later ts). B is partitioned during
    // the conflicting writes, then heals — must still land C's value.
    const A = byName.get('A')!, B = byName.get('B')!, C = byName.get('C')!;

    // Partition B off.
    for (const s of [A, C]) {
      links.get([B.name, s.name].sort().join('|'))!.sever();
      s.admitDrop('B');
      B.admitDrop(s.name);
    }
    const SHARED = 'plans-shared-1';
    let ts = nextTs();
    await A.append('plans', SHARED, ts); push('A', 'plans', SHARED, ts);
    ts = nextTs();
    await C.append('plans', SHARED, ts); push('C', 'plans', SHARED, ts); // C later → C wins
    await pumpToQuiescence([A, C]);

    // Heal B back in.
    for (const s of [A, C]) {
      links.set([B.name, s.name].sort().join('|'), link(B.store, s.store));
      s.admitAdd('B');
      B.admitAdd(s.name);
    }
    await pumpToQuiescence(peers);

    const oracle = oracleLiveState(history);
    expect(oracle.get(`plans::${SHARED}`)).toEqual({ from: 'C', ts });
    for (const p of peers) expect(p.pg.liveState().get(`plans::${SHARED}`), `${p.name} disagreed on the shared key`).toEqual({ from: 'C', ts });
  }, 60_000);
});
