/**
 * _multi-peer-harness.ts — the in-process multi-peer acceptance harness for the
 * p2p v1 core (plan p2p-v1-core-release-2026-11-13, item P-002).
 *
 * WHAT IT IS. N real substrate peers of ONE hive in ONE process: each peer is a
 * real `bootHarnessSubstrate` over its own persistent corestore directory, a real
 * Hyperswarm/Noise connection over a loopback testnet DHT, real capture triggers
 * into its own throwaway Postgres, the real outbox drain, the real read-merge, and
 * the real LWW-guarded projections. It is built on the two-peer hive rig
 * (`sync/hyperbee/__tests__/_hive-substrate-rig.ts`) — schema, identities and the
 * peer boot are reused from there, not copied.
 *
 * FAULTS. Every fault leaves a receipt in `harness.receipts`, so a test can prove a
 * configured fault actually acted on that case's traffic (R-2's falsifier):
 *   - partition   — a connection filter on each peer's real swarm refuses sockets
 *                   between the two sides and drops the live ones. Heal lifts the
 *                   filter (its receipt lists the own-log entries each blocked
 *                   receiver still lacked); the substrate's own self-heal loop re-peers.
 *   - delay       — the receiving peer holds incoming ops at the apply seam until
 *                   `flush`; later ops can overtake them.
 *   - reorder     — a flush delivers the held batch in reverse arrival order.
 *   - duplicate   — each delivered op is applied twice.
 *   - clock-skew  — a peer's hybrid logical clock is pushed ahead, so every op it
 *                   captures afterwards carries the skewed HLC; receivers record a
 *                   receipt when such an op reaches their apply seam.
 *   - revoke-during-sync — the other peers revoke a device while it still has
 *                   replication work in flight; refused if nothing is in flight.
 *   - restart     — the peer instance and all in-memory state are destroyed and a
 *                   fresh instance is built from the same storage directory.
 *
 * WHY THE APPLY SEAM. Hypercore logs are signed and indexed, so the wire cannot
 * reorder or duplicate ops within one log; what a receiving peer's state machine
 * actually sees reordered or repeated is the stream of ops handed to its
 * projections (logs merged in arbitrary interleavings, re-folds after restart,
 * late downloads). Faults are therefore injected exactly there.
 *
 * OBSERVATIONS. Besides receipts, the harness records every op reaching an apply
 * seam (`arrivals`, before any fault acts) and every read-admission check a peer
 * makes of a remote's member id and device key (`admissionChecks`). Give every
 * harness of one acceptance run the same `run` ledger and its receipts are stamped
 * with the run id and collected in one place.
 *
 * SETTLE. `settle()` drives drain → merge → flush on every live peer until a round
 * changes nothing and every live, non-revoked peer holds every other such peer's
 * full own log. It is bounded by progress (rounds without change), not by a fixed
 * time window, and on failure it throws the per-peer pending breakdown.
 *
 * NOT YET MODELLED (tracked by later plan items): the product's join-complete
 * state (P-004) and fail-closed merge rules (P-003). Admission is the rig's
 * GitHub-binding stand-in, decided by the harness roster.
 */
import createTestnet from 'hyperdht/testnet.js';
import { randomBytes } from 'node:crypto';
import type postgres from 'postgres';
import type { EpochKey } from '../../sync/hyperbee/hive-epoch-crypto';
import type { EpochKeyProvider } from '../../sync/hyperbee/hive-epoch-serving';
import { EpochKeyUnavailableError } from '../../sync/hyperbee/hive-epoch-key-provider';
import { closeHarnessStore } from '../../sync/hyperbee/corestore';
import { drainRefusesOutboxTable } from '../../sync/hyperbee/feature-issue-op-keys';
import type { OpEnvelope } from '../../sync/hyperbee/op-envelope-types';
import type { HyperswarmLike } from '../../sync/hyperbee/swarm';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { runWithCellSql } from '../../shared-pot-loop/cell-scope';
import {
  bootHivePeer,
  buildHivePeerRekeyDeps,
  cleanups,
  HIVE_SLUG,
  makeIdentity,
  seedHive,
  setupHivePeerSchema,
  WORKSPACE_ID,
  type HivePeer,
  type HivePeerApply,
  type SwarmTimingOverride,
} from '../../sync/hyperbee/__tests__/_hive-substrate-rig';

export { rigAfterEach as harnessAfterEach } from '../../sync/hyperbee/__tests__/_hive-substrate-rig';

export type FaultKind =
  | 'partition'
  | 'heal'
  | 'delay'
  | 'reorder'
  | 'duplicate'
  | 'clock-skew'
  | 'revoke-during-sync'
  | 'restart';

export interface FaultReceipt {
  kind: FaultKind;
  /** The peer the fault acted on (the receiver for delivery faults). */
  peer: string;
  at: number;
  /** The acceptance run this receipt belongs to (set when the harness is given `run`). */
  runId?: string;
  detail: Record<string, unknown>;
}

/**
 * A receipt ledger shared by every harness of one acceptance run. Each harness
 * stamps the run id on its receipts and appends them here as well as to its own
 * `receipts`, so one run-level check can read every fault the run's cases produced.
 */
export interface RunLedger {
  readonly id: string;
  readonly receipts: FaultReceipt[];
}

/** One op reaching a peer's apply seam, recorded before any delivery fault acts on it. */
export interface Arrival {
  receiver: string;
  receiverIncarnation: number;
  /** The peer whose own log the op came from (null when the log is not a harness peer's). */
  from: string | null;
  op: string;
  writerPubkey: string | null;
  sourceLogKeyHex: string | null;
  at: number;
}

/** One read-admission check a peer made of the member id and device key a remote presented. */
export interface AdmissionCheck {
  verifier: string;
  verifierIncarnation: number;
  /** The member id (GitHub user id) the remote presented. */
  userId: number;
  /** The device public key the remote presented with it. */
  devicePubkey: string;
  /** The harness peer that member id belongs to (null when unknown). */
  member: string | null;
  verdict: 'verified' | 'pending' | 'fail';
  at: number;
}

export interface DeliveryFaults {
  /** Hold incoming ops until `flush` (delay). */
  hold: boolean;
  /** Deliver a flushed batch in reverse arrival order. */
  reorder: boolean;
  /** Apply every delivered op twice. */
  duplicate: boolean;
}

const NO_FAULTS: DeliveryFaults = { hold: false, reorder: false, duplicate: false };

/** Fast self-heal cadence (the WI-1534 integration timings) so a healed partition
 *  re-peers in well under a second. */
export const HARNESS_SWARM_TIMING: SwarmTimingOverride = {
  refreshMs: 40,
  fastWindowMs: 250,
  slowRefreshMs: 60_000,
  stalledMaxRefreshMs: 500,
};

interface HeldOp {
  op: OpEnvelope;
  inner: HivePeerApply;
}

export interface HarnessPeer {
  readonly name: string;
  readonly userId: number;
  readonly identity: ReturnType<typeof makeIdentity>;
  /** The peer's own durable database (survives a restart). */
  readonly db: FreshPgDb;
  /** This peer's fixture grant, retained across its restarts; never reads host credentials. */
  readonly epochKeyProvider: EpochKeyProvider;
  /** The peer's persistent storage directory (set at first boot). */
  root: string | null;
  /** The live instance, or null while stopped. */
  current: HivePeer | null;
  /** How many times this peer has been booted (1 after the first boot). */
  incarnation: number;
  faults: DeliveryFaults;
  held: HeldOp[];
  /** This peer's HLC skew in ms (0 = none). */
  skewMs: number;
}

export interface PendingWork {
  total: number;
  /** Peer pairs currently partitioned; their mutual lag is excluded from `total`. */
  partitionedPairs: string[];
  /**
   * `undrained` counts only rows the drain will take. `refusedUndrained` counts rows the
   * drain leaves undrained by design (P-003: unmapped, or no v1 simple rule); they are
   * reported here and excluded from `total`, because no amount of settling drains them.
   */
  perPeer: Record<
    string,
    { held: number; undrained: number; refusedUndrained: number; lagBehind: Record<string, number> }
  >;
}

export interface RevocationFrontier {
  target: string;
  devicePubkey: string;
  at: number;
  /** Each non-revoked peer's own-log length when the revocation was committed. */
  ownLogLengths: Record<string, number>;
  /** The target's pending work at the moment of revocation (always > 0). */
  pendingAtRevocation: number;
}

export interface CanonicalDump {
  settings: Array<{ key: string; value: unknown }>;
  memberUserIds: number[];
}

function keyHex(k: unknown): string | null {
  if (!k) return null;
  if (typeof k === 'string') return k;
  if (k instanceof Uint8Array) return Buffer.from(k).toString('hex');
  return null;
}

function hlcMs(hlc: string | undefined): number | null {
  if (!hlc) return null;
  const ms = Number.parseInt(hlc.split(':')[0] ?? '', 10);
  return Number.isFinite(ms) ? ms : null;
}

function opIdentity(op: OpEnvelope): string {
  return `${op.table ?? '?'}:${op.hbKey ?? op.key ?? '?'}@${op.hlc ?? op.ts ?? '?'}`;
}

/**
 * Return `target` with every method call run inside `sql`'s cell scope. A peer's
 * merge pass, drain and revoke reach getOrgPg(); a call made from the test body
 * after boot is outside the boot scope, so without this the strict db-org mock
 * refuses it (and production code would fall back to the live Postgres target).
 * AsyncLocalStorage.run passes a synchronous return value through unchanged, so
 * sync methods keep their sync result. Properties are returned as-is.
 */
function bindToCell<T extends object>(sql: postgres.Sql, target: T): T {
  return new Proxy(target, {
    get(t, prop) {
      const value: unknown = Reflect.get(t, prop);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) =>
        runWithCellSql(sql, () => (value as (...a: unknown[]) => Promise<unknown>).apply(t, args));
    },
  });
}

/**
 * Make every listener later registered on `emitter` (a peer's connection socket) run in
 * `sql`'s cell scope. The socket's data callbacks come from native UDX code, which does
 * not carry AsyncLocalStorage context, so an announce or replication message would
 * otherwise run outside any peer's scope and its getOrgPg() calls (the merge pass's
 * policy read, the roster read) would escape the peer's own database. The emitter keeps
 * its identity (patched in place, not proxied) because corestore and protomux key state
 * on the stream object. Removal maps the original listener to its wrapper.
 */
function scopeListeners(sql: postgres.Sql, emitter: unknown): void {
  if (!emitter || typeof emitter !== 'object') return;
  const e = emitter as Record<string, unknown>;
  const wrappers = new WeakMap<object, (...a: unknown[]) => unknown>();
  const wrap = (fn: unknown) => {
    if (typeof fn !== 'function') return fn;
    let w = wrappers.get(fn);
    if (!w) {
      w = function (this: unknown, ...args: unknown[]) {
        // runWithCellSql is typed for async bodies but AsyncLocalStorage.run returns the
        // callback's value unchanged, so a synchronous listener keeps its own return value.
        return runWithCellSql(sql, () => (fn as (...a: unknown[]) => Promise<unknown>).apply(this, args));
      };
      wrappers.set(fn, w);
    }
    return w;
  };
  for (const m of ['on', 'addListener', 'once', 'prependListener', 'prependOnceListener']) {
    const orig = e[m];
    if (typeof orig !== 'function') continue;
    e[m] = function (this: unknown, event: unknown, fn: unknown) {
      return (orig as (...a: unknown[]) => unknown).call(this, event, wrap(fn));
    };
  }
  for (const m of ['off', 'removeListener']) {
    const orig = e[m];
    if (typeof orig !== 'function') continue;
    e[m] = function (this: unknown, event: unknown, fn: unknown) {
      const w = typeof fn === 'function' ? wrappers.get(fn) : undefined;
      return (orig as (...a: unknown[]) => unknown).call(this, event, w ?? fn);
    };
  }
}

/** A peer whose own methods and handle methods all run in that peer's cell scope. */
function scopePeerToCell(sql: postgres.Sql, hp: HivePeer): HivePeer {
  const handle = bindToCell(sql, hp.handle);
  const drain = () => runWithCellSql(sql, () => hp.drain());
  return { ...hp, handle, drain };
}

/**
 * Production capture stamps `op_hlc` at capture time (mig 314 onward); the rig's
 * archive-102 generic capture predates that. Stamp it at outbox insert so every
 * captured op carries this peer's HLC, the clock a skew acts on.
 */
const STAMP_OP_HLC_DDL = `
  CREATE OR REPLACE FUNCTION harness_shared.harness_stamp_op_hlc() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
  BEGIN
    IF NEW.op_hlc IS NULL THEN NEW.op_hlc := harness_shared.hlc_now(); END IF;
    RETURN NEW;
  END;
  $fn$;
  DROP TRIGGER IF EXISTS harness_stamp_op_hlc ON harness_shared.substrate_outbox;
  CREATE TRIGGER harness_stamp_op_hlc BEFORE INSERT ON harness_shared.substrate_outbox
    FOR EACH ROW EXECUTE FUNCTION harness_shared.harness_stamp_op_hlc();
`;

export interface MultiPeerHarness {
  readonly peers: Map<string, HarnessPeer>;
  readonly receipts: FaultReceipt[];
  /** The run id stamped on every receipt (null when no `run` was given). */
  readonly runId: string | null;
  /** Every op that reached any peer's apply seam, in arrival order. */
  readonly arrivals: Arrival[];
  /** Every read-admission check any peer made of a remote, in order. */
  readonly admissionChecks: AdmissionCheck[];
  peer(name: string): HarnessPeer;
  live(name: string): HivePeer;
  /** Add a peer to the roster and boot it into the hive (a join). */
  addPeer(name: string): Promise<HarnessPeer>;
  stop(name: string): Promise<void>;
  start(name: string): Promise<HivePeer>;
  /** Destroy the instance and all in-memory state, then boot fresh from storage. */
  restart(name: string): Promise<HivePeer>;
  writeSetting(name: string, key: string, value: unknown): Promise<void>;
  deleteSetting(name: string, key: string): Promise<void>;
  dump(name: string): Promise<CanonicalDump>;
  setDeliveryFaults(name: string, faults: Partial<DeliveryFaults>): void;
  flush(name: string): Promise<number>;
  skewClock(name: string, skewMs: number): Promise<void>;
  partition(sideA: string[], sideB: string[]): void;
  heal(): void;
  isPartitioned(a: string, b: string): boolean;
  revokeDuringSync(target: string): Promise<RevocationFrontier>;
  isRevoked(name: string): boolean;
  pendingWork(): Promise<PendingWork>;
  settle(opts?: { maxIdleRounds?: number; intervalMs?: number }): Promise<{ rounds: number }>;
  receiptsOf(kind: FaultKind): FaultReceipt[];
}

/**
 * Create a harness with `names` peers booted and mutually admitted. Register
 * `harnessAfterEach` as the test file's afterEach.
 */
export async function createMultiPeerHarness(
  names: string[],
  opts: {
    swarmTiming?: SwarmTimingOverride;
    run?: RunLedger;
    joinProgressNow?: () => number;
    mergePollMs?: number;
    /** Hold the actual projection apply, without inventing another delivery fault kind. */
    beforeApply?: (peer: string, op: OpEnvelope) => Promise<void>;
  } = {},
): Promise<MultiPeerHarness> {
  const swarmTiming = opts.swarmTiming ?? HARNESS_SWARM_TIMING;
  // One fresh epoch per harness; each peer receives its own copy as a fixture grant.
  // Distribution/rotation is covered by the epoch suites, not this core protocol rig.
  const epochKey = randomBytes(32);
  const testnet = await createTestnet(3);
  cleanups.push(async () => {
    try {
      await testnet.destroy();
    } catch {
      /* ignore */
    }
  });

  const peers = new Map<string, HarnessPeer>();
  const receipts: FaultReceipt[] = [];
  const runId = opts.run?.id ?? null;
  const arrivals: Arrival[] = [];
  const admissionChecks: AdmissionCheck[] = [];
  /** github user ids admitted to the hive (the admission stand-in). */
  const roster = new Set<number>();
  /** Revoked device pubkeys, shared by every peer and every incarnation. */
  const revokedPubkeys = new Set<string>();
  const revokedNames = new Set<string>();
  /** Unordered peer-name pairs currently partitioned ("a|b", sorted). */
  const blockedPairs = new Set<string>();
  /** Swarm public key (hex) → peer name, refreshed at every boot. */
  const swarmKeyToName = new Map<string, string>();
  /** Own-log key (hex) → peer name. Stable across restarts (same storage). */
  const logKeyToName = new Map<string, string>();
  let nextUserId = 101;

  const record = (kind: FaultKind, peer: string, detail: Record<string, unknown>) => {
    const receipt: FaultReceipt = { kind, peer, at: Date.now(), detail };
    if (runId !== null) receipt.runId = runId;
    receipts.push(receipt);
    opts.run?.receipts.push(receipt);
  };
  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const isPartitioned = (a: string, b: string) => blockedPairs.has(pairKey(a, b));

  function peer(name: string): HarnessPeer {
    const p = peers.get(name);
    if (!p) throw new Error(`multi-peer harness: no peer named ${name}`);
    return p;
  }
  function live(name: string): HivePeer {
    const p = peer(name);
    if (!p.current) throw new Error(`multi-peer harness: peer ${name} is stopped`);
    return p.current;
  }

  /** Deliver one op through the real projection, twice when duplicate is on. */
  async function deliver(p: HarnessPeer, item: HeldOp): Promise<boolean> {
    const first = await item.inner(item.op);
    if (p.faults.duplicate) {
      const second = await item.inner(item.op);
      record('duplicate', p.name, { op: opIdentity(item.op), firstApplied: first, secondApplied: second });
    }
    return first;
  }

  function wrapApplyFor(p: HarnessPeer) {
    return (inner: HivePeerApply): HivePeerApply =>
      async (op) => {
        const src = op.sourceLogKeyHex ? logKeyToName.get(op.sourceLogKeyHex) : undefined;
        const srcPeer = src ? peers.get(src) : undefined;
        // Recorded before any delivery fault acts, so a held, reordered or duplicated
        // op still shows exactly when (and to which incarnation) it first arrived.
        arrivals.push({
          receiver: p.name,
          receiverIncarnation: p.incarnation,
          from: src ?? null,
          op: opIdentity(op),
          writerPubkey: op.writerPubkey ?? null,
          sourceLogKeyHex: op.sourceLogKeyHex ?? null,
          at: Date.now(),
        });
        const ms = hlcMs(op.hlc);
        if (srcPeer && srcPeer.name !== p.name && srcPeer.skewMs > 0 && ms !== null) {
          const aheadMs = ms - Date.now();
          if (aheadMs >= srcPeer.skewMs / 2) {
            record('clock-skew', p.name, { op: opIdentity(op), from: srcPeer.name, skewMs: srcPeer.skewMs, aheadMs });
          }
        }
        if (p.faults.hold) {
          p.held.push({ op, inner });
          record('delay', p.name, { op: opIdentity(op), from: src ?? null, heldCount: p.held.length });
          return true;
        }
        await opts.beforeApply?.(p.name, op);
        return deliver(p, { op, inner });
      };
  }

  function wrapSwarmFor(p: HarnessPeer) {
    return (raw: HyperswarmLike & { connections: Set<unknown> }): HyperswarmLike =>
      new Proxy(raw, {
        get(target, prop, receiver) {
          if (prop === 'on') {
            return (event: string, listener: (socket: unknown, info?: unknown) => void) => {
              const scoped = (...args: unknown[]) =>
                runWithCellSql(p.db.sql, () => (listener as (...a: unknown[]) => Promise<unknown>)(...args));
              if (event !== 'connection') return (target.on as (e: string, l: unknown) => unknown)(event, scoped);
              return target.on('connection', (socket: unknown, info?: unknown) => {
                const remoteKey =
                  keyHex((info as { publicKey?: unknown } | undefined)?.publicKey) ??
                  keyHex((socket as { remotePublicKey?: unknown } | undefined)?.remotePublicKey);
                const remote = remoteKey ? swarmKeyToName.get(remoteKey) : undefined;
                if (remote && isPartitioned(p.name, remote)) {
                  (socket as { destroy?: () => void }).destroy?.();
                  record('partition', p.name, { refusedConnectionFrom: remote });
                  return;
                }
                scopeListeners(p.db.sql, socket);
                scoped(socket, info);
              });
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
  }

  /**
   * Register the hive in a peer's own database. Boot resolves the hive scope through
   * loadHarnessRegistry (hive-federation.ts potHomeSlugForHarness); without a row the
   * re-key boot dependencies fail closed and the peer never starts.
   */
  async function seedHiveRegistry(sql: postgres.Sql): Promise<void> {
    await sql.unsafe(
      'CREATE TABLE IF NOT EXISTS harness_shared.harness_registry (workspace_id text PRIMARY KEY, payload jsonb NOT NULL)',
    );
    const payload = { projects: [{ slug: HIVE_SLUG, harness_kind: 'hive' }] };
    await sql`
      INSERT INTO harness_shared.harness_registry (workspace_id, payload)
      VALUES (${WORKSPACE_ID}, ${sql.json(payload)})
      ON CONFLICT (workspace_id) DO UPDATE SET payload = EXCLUDED.payload
    `;
  }

  async function boot(p: HarnessPeer): Promise<HivePeer> {
    // Boot inside this peer's own cell scope. bootHarnessSubstrate reaches getOrgPg()
    // during boot (buildHiveRekeyBootDeps -> potHomeSlugForHarness), and the suite's
    // db-org mock routes that call to the current cell's throwaway database. Outside a
    // cell scope the mock throws, so no peer can touch the live Postgres target.
    // The incarnation advances BEFORE boot: ops and admission checks that arrive while
    // the instance is still booting belong to the new instance, not the destroyed one.
    p.incarnation += 1;
    const rekeyDeps = await buildHivePeerRekeyDeps(p.epochKeyProvider);
    const booted = await runWithCellSql(p.db.sql, () => bootHivePeer({
      testnetBootstrap: testnet.bootstrap,
      rootPrefix: `v1core-${p.name}-`,
      identity: p.identity,
      pg: p.db.sql,
      verify: (uid, pk) => {
        const verdict = roster.has(uid) ? 'verified' : 'fail';
        admissionChecks.push({
          verifier: p.name,
          verifierIncarnation: p.incarnation,
          userId: uid,
          devicePubkey: pk,
          member: [...peers.values()].find((x) => x.userId === uid)?.name ?? null,
          verdict,
          at: Date.now(),
        });
        return verdict;
      },
      swarmTiming,
      root: p.root ?? undefined,
      wrapSwarm: wrapSwarmFor(p),
      wrapApply: wrapApplyFor(p),
      loadRevoked: async () => new Set(revokedPubkeys),
      rekeyDeps,
      joinProgressNow: opts.joinProgressNow,
      mergePollMs: opts.mergePollMs,
      // This fixture captures only Hive members/settings, so its receipt census
      // is empty. Snapshot crypto still uses this peer's real isolated grant.
      loadOwnCompactionGovernorReceiptKeys: async () => [],
      loadOwnCompactionEnvelopeKeys: async () => ({
        potId: HIVE_SLUG,
        keys: [{ epoch: 1, key: await p.epochKeyProvider.keyForEpoch(HIVE_SLUG, 1) }],
      }),
    }));
    // Every later call on this peer (merge, drain, revoke, close) runs in its own
    // cell scope too, whoever makes it: the harness, P-005's suite or the test body.
    const hp = scopePeerToCell(p.db.sql, booted);
    p.root = hp.root;
    p.current = hp;
    const swarmKey = keyHex((hp.rawSwarm as unknown as { keyPair?: { publicKey?: unknown } }).keyPair?.publicKey);
    if (swarmKey) swarmKeyToName.set(swarmKey, p.name);
    logKeyToName.set(hp.handle.ownLog.keyHex, p.name);
    return hp;
  }

  async function addPeer(name: string): Promise<HarnessPeer> {
    if (peers.has(name)) throw new Error(`multi-peer harness: duplicate peer ${name}`);
    const userId = nextUserId++;
    const db = await createFreshPgDb(`v1core_${name}`);
    cleanups.push(() => db.cleanup());
    await setupHivePeerSchema(db.sql);
    await db.sql.unsafe(STAMP_OP_HLC_DDL);
    await seedHive(db.sql);
    await seedHiveRegistry(db.sql);
    const grantedKey = Uint8Array.from(epochKey) as EpochKey;
    const p: HarnessPeer = {
      name,
      userId,
      identity: makeIdentity(name, userId, `kc-${name}`),
      db,
      epochKeyProvider: {
        keyForEpoch: async (potId, epoch) => {
          if (potId !== HIVE_SLUG || epoch !== 1) throw new EpochKeyUnavailableError(potId, epoch);
          return grantedKey;
        },
      },
      root: null,
      current: null,
      incarnation: 0,
      faults: { ...NO_FAULTS },
      held: [],
      skewMs: 0,
    };
    peers.set(name, p);
    roster.add(userId);
    await boot(p);
    return p;
  }

  async function flush(name: string): Promise<number> {
    const p = peer(name);
    const batch = p.held.splice(0);
    if (batch.length === 0) return 0;
    const order = p.faults.reorder ? [...batch].reverse() : batch;
    if (p.faults.reorder && batch.length > 1) {
      record('reorder', p.name, {
        arrivalOrder: batch.map((h) => opIdentity(h.op)),
        deliveryOrder: order.map((h) => opIdentity(h.op)),
      });
    }
    for (const item of order) await deliver(p, item);
    return batch.length;
  }

  async function stop(name: string): Promise<void> {
    const p = peer(name);
    const hp = p.current;
    if (!hp) return;
    // Ops already handed to the delivery seam complete before shutdown, so a
    // restart never loses an op the merge cursor already counted as applied.
    await flush(name);
    p.current = null;
    await hp.handle.close();
    await closeHarnessStore({ workspaceRoot: hp.root, harnessSlug: HIVE_SLUG });
    try {
      await (hp.rawSwarm as unknown as { destroy(): Promise<void> }).destroy();
    } catch {
      /* ignore */
    }
  }

  async function restart(name: string): Promise<HivePeer> {
    const p = peer(name);
    const before = p.current ? p.current.handle.ownLog.keyHex : null;
    await stop(name);
    const hp = await boot(p);
    record('restart', name, {
      incarnation: p.incarnation,
      ownLogKeyBefore: before,
      ownLogKeyAfter: hp.handle.ownLog.keyHex,
      root: hp.root,
    });
    return hp;
  }

  async function writeSetting(name: string, key: string, value: unknown): Promise<void> {
    const p = peer(name);
    const now = Date.now();
    const v = JSON.stringify(value);
    await p.db.sql`
      INSERT INTO harness_shared.pot_settings (workspace_id, harness_slug, setting_key, value, created_at, updated_at)
      VALUES (${WORKSPACE_ID}, ${HIVE_SLUG}, ${key}, ${v}, ${now}, ${now})
      ON CONFLICT (workspace_id, harness_slug, setting_key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at, origin = 'local'
    `;
    await live(name).drain();
  }

  async function deleteSetting(name: string, key: string): Promise<void> {
    const p = peer(name);
    await p.db.sql`
      DELETE FROM harness_shared.pot_settings
       WHERE workspace_id = ${WORKSPACE_ID} AND harness_slug = ${HIVE_SLUG} AND setting_key = ${key}
    `;
    await live(name).drain();
  }

  async function dump(name: string): Promise<CanonicalDump> {
    const sql: postgres.Sql = peer(name).db.sql;
    const settings = await sql<Array<{ setting_key: string; value: string | null }>>`
      SELECT setting_key, value FROM harness_shared.pot_settings
       WHERE workspace_id = ${WORKSPACE_ID} AND harness_slug = ${HIVE_SLUG}
       ORDER BY setting_key
    `;
    const members = await sql<Array<{ github_user_id: number }>>`
      SELECT github_user_id FROM harness_shared.pot_members
       WHERE workspace_id = ${WORKSPACE_ID} AND pot_home_slug = ${HIVE_SLUG}
       ORDER BY github_user_id
    `;
    return {
      settings: settings.map((r) => ({ key: r.setting_key, value: r.value == null ? null : JSON.parse(r.value) })),
      memberUserIds: members.map((r) => Number(r.github_user_id)),
    };
  }

  function setDeliveryFaults(name: string, faults: Partial<DeliveryFaults>): void {
    const p = peer(name);
    p.faults = { ...p.faults, ...faults };
  }

  async function skewClock(name: string, skewMs: number): Promise<void> {
    if (!(skewMs > 0)) throw new Error('multi-peer harness: skewMs must be positive');
    const p = peer(name);
    p.skewMs = skewMs;
    const target = Date.now() + skewMs;
    await p.db.sql`
      UPDATE harness_shared.hlc_clock SET last_ms = GREATEST(last_ms, ${target}::bigint), last_count = 0 WHERE id = 1
    `;
    record('clock-skew', name, { configuredSkewMs: skewMs, clockAdvancedTo: target });
  }

  function partition(sideA: string[], sideB: string[]): void {
    let socketsDropped = 0;
    for (const a of sideA) for (const b of sideB) if (a !== b) blockedPairs.add(pairKey(a, b));
    for (const p of peers.values()) {
      const hp = p.current;
      if (!hp) continue;
      for (const conn of [...hp.rawSwarm.connections]) {
        const remote = swarmKeyToName.get(keyHex((conn as { remotePublicKey?: unknown }).remotePublicKey) ?? '');
        if (remote && isPartitioned(p.name, remote)) {
          (conn as { destroy?: () => void }).destroy?.();
          socketsDropped += 1;
        }
      }
    }
    record('partition', sideA.join(','), { sideA, sideB, socketsDropped });
  }

  /** How many of `from`'s own-log entries `receiver` does not yet hold (null if either is stopped). */
  function missingFrom(receiver: HarnessPeer, from: HarnessPeer): number | null {
    if (!receiver.current || !from.current) return null;
    const want = from.current.handle.ownLog.length;
    const have = receiver.current.handle.admitted.get(from.current.handle.ownLog.keyHex)?.length ?? 0;
    return Math.max(0, want - have);
  }

  function heal(): void {
    const pairs = [...blockedPairs];
    // What the partition was still blocking at the moment it lifts: per blocked pair and
    // direction, the own-log entries the receiver had not received. A non-empty list is
    // the causal proof that the partition held back a delivery (not just that it was set).
    const undeliveredAtHeal: Array<{ receiver: string; from: string; missing: number }> = [];
    for (const pair of pairs) {
      const [x, y] = pair.split('|') as [string, string];
      for (const [receiver, from] of [
        [x, y],
        [y, x],
      ] as const) {
        const missing = missingFrom(peer(receiver), peer(from));
        if (missing) undeliveredAtHeal.push({ receiver, from, missing });
      }
    }
    blockedPairs.clear();
    record('heal', '*', { pairs, undeliveredAtHeal });
  }

  async function lagOf(p: HarnessPeer): Promise<Record<string, number>> {
    const lag: Record<string, number> = {};
    const hp = p.current;
    if (!hp || revokedNames.has(p.name)) return lag;
    for (const other of peers.values()) {
      if (other.name === p.name || !other.current || revokedNames.has(other.name)) continue;
      // A partitioned pair cannot converge until heal; it is reported in
      // `PendingWork.partitionedPairs` instead of counting as pending work.
      if (isPartitioned(p.name, other.name)) continue;
      const want = other.current.handle.ownLog.length;
      if (want === 0) continue;
      const have = hp.handle.admitted.get(other.current.handle.ownLog.keyHex)?.length ?? 0;
      if (have < want) lag[other.name] = want - have;
    }
    return lag;
  }

  // Rows the drain refuses stay undrained on purpose (P-003 fail-closed), so counting
  // them as pending would make settle() wait forever. Split by the drain's own predicate.
  async function undrained(p: HarnessPeer): Promise<{ drainable: number; refused: number }> {
    const rows = await p.db.sql<Array<{ table_name: string; n: number }>>`
      SELECT table_name, count(*)::int AS n FROM harness_shared.substrate_outbox
       WHERE workspace_id = ${WORKSPACE_ID} AND harness_slug = ${HIVE_SLUG} AND drained_at IS NULL
       GROUP BY table_name
    `;
    const out = { drainable: 0, refused: 0 };
    for (const r of rows) {
      if (drainRefusesOutboxTable(r.table_name)) out.refused += r.n;
      else out.drainable += r.n;
    }
    return out;
  }

  async function pendingWork(): Promise<PendingWork> {
    const perPeer: PendingWork['perPeer'] = {};
    let total = 0;
    for (const p of peers.values()) {
      if (!p.current) continue;
      const lagBehind = await lagOf(p);
      const outbox = await undrained(p);
      const entry = {
        held: p.held.length,
        undrained: outbox.drainable,
        refusedUndrained: outbox.refused,
        lagBehind,
      };
      perPeer[p.name] = entry;
      total += entry.held + entry.undrained + Object.values(lagBehind).reduce((s, n) => s + n, 0);
    }
    return { total, partitionedPairs: [...blockedPairs], perPeer };
  }

  async function revokeDuringSync(target: string): Promise<RevocationFrontier> {
    const t = peer(target);
    if (!t.current) throw new Error(`multi-peer harness: cannot revoke stopped peer ${target}`);
    const lag = await lagOf(t);
    const pendingAtRevocation = t.held.length + Object.values(lag).reduce((s, n) => s + n, 0);
    if (pendingAtRevocation === 0) {
      throw new Error(
        `multi-peer harness: revoke-during-sync needs replication work in flight on ${target}; ` +
          'hold its delivery or write on another peer first',
      );
    }
    const devicePubkey = t.identity.devicePubkey;
    revokedPubkeys.add(devicePubkey);
    revokedNames.add(target);
    roster.delete(t.userId);
    const ownLogLengths: Record<string, number> = {};
    for (const p of peers.values()) {
      if (p.name === target || !p.current) continue;
      await p.current.handle.revoke(devicePubkey);
      ownLogLengths[p.name] = p.current.handle.ownLog.length;
    }
    const frontier: RevocationFrontier = { target, devicePubkey, at: Date.now(), ownLogLengths, pendingAtRevocation };
    record('revoke-during-sync', target, { ...frontier });
    return frontier;
  }

  async function settle(o: { maxIdleRounds?: number; intervalMs?: number } = {}): Promise<{ rounds: number }> {
    const maxIdleRounds = o.maxIdleRounds ?? 400;
    const intervalMs = o.intervalMs ?? 50;
    let idle = 0;
    let rounds = 0;
    let lastSignature = '';
    for (;;) {
      rounds += 1;
      let moved = 0;
      for (const p of peers.values()) if (p.current) moved += await p.current.drain();
      for (const p of peers.values()) if (p.current) moved += await p.current.handle.mergeNow();
      for (const p of peers.values()) if (p.current) moved += await flush(p.name);
      const pending = await pendingWork();
      if (moved === 0 && pending.total === 0) return { rounds };
      const signature = JSON.stringify(pending.perPeer);
      if (moved === 0 && signature === lastSignature) {
        idle += 1;
        if (idle >= maxIdleRounds) {
          throw new Error(
            `multi-peer harness: settle made no progress for ${idle} rounds; pending ${JSON.stringify(pending)}`,
          );
        }
      } else {
        idle = 0;
      }
      lastSignature = signature;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  const harness: MultiPeerHarness = {
    peers,
    receipts,
    runId,
    arrivals,
    admissionChecks,
    peer,
    live,
    addPeer,
    stop,
    start: async (name) => {
      const p = peer(name);
      if (p.current) return p.current;
      return boot(p);
    },
    restart,
    writeSetting,
    deleteSetting,
    dump,
    setDeliveryFaults,
    flush,
    skewClock,
    partition,
    heal,
    isPartitioned,
    revokeDuringSync,
    isRevoked: (name) => revokedNames.has(name),
    pendingWork,
    settle,
    receiptsOf: (kind) => receipts.filter((r) => r.kind === kind),
  };

  for (const name of names) await addPeer(name);
  return harness;
}
