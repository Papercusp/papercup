/**
 * Substrate sidecar HOST — the RPC method implementations the substrate sidecar
 * process serves, extracted from `apps/operator/bin/substrate-sidecar.ts` so the
 * logic is unit-testable in-process (no `npx tsx` child, no Unix socket) and can
 * import the real operator-core engine.
 *
 * Why this module exists (substrate-sidecar-store-relocation-2026-06-23, P-001):
 * Corestore 7.x holds a PROCESS-LEVEL file lock per storage path, so the harness
 * store can live in EXACTLY ONE process. The relocation moves the store — and
 * therefore the own-log + (later phases) the merge loop + projections + swarm +
 * outbox-drain — into the sidecar; the main process routes every
 * `handle.append()` over IPC and reads PG-only. This host owns the relocated
 * stores and serves:
 *
 *   - the EXISTING replication-offload methods (openStore / prepareSocketHandoff
 *     / attachSocket / getCoreInfo, the Option-B socket-handoff the live swarm
 *     path calls by name — preserved byte-for-byte) AND
 *   - the NEW full-store methods this plan adds: `bootHarness` opens the store +
 *     own-log and returns the own-log key; `substrate:appendOp` HLC-stamps a
 *     `LocalWriteOp` and appends it to the relocated own-log — the IPC twin of
 *     `boot.ts` `handle.append`. `getStoreStatus.ownLogLength` reports the real
 *     own-log length.
 *
 * The merge loop, PG projections, swarm join, and outbox-drain relocation are
 * P-002/P-003 — their methods are present as faithful (documented) stubs so the
 * RemoteBootedHarnessHandle proxy has a stable surface to grow into.
 *
 * Everything here is reached ONLY when the OFF-by-default `papercusp-substrate-
 * sidecar` flag is ON; the OFF path never spawns the sidecar.
 */

/// <reference path="./holepunch.d.ts" />

import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { Duplex } from 'node:stream';
import Corestore from 'corestore';
import type { HlcClock } from '@papercusp/locks-core';
import { openOwnLog, type OwnLog, type PeerLogOp } from './peer-log';
import { stampOpHlc } from './hlc-stamp';
import type { LocalWriteOp } from './boot';

/**
 * Minimal Hypercore surface used by the observability methods. corestore's
 * `.get()` return type is loosely typed across builds; we pin only the members
 * we touch so tsc stays honest without an `any`.
 */
interface HypercoreLike {
  ready(): Promise<void>;
  update(opts?: { wait?: boolean }): Promise<unknown>;
  get(index: number, opts?: { wait?: boolean }): Promise<Buffer>;
  download(range: { start: number; end: number }): { done(): Promise<void> } | Promise<void>;
  length: number;
  byteLength: number;
  key: Buffer;
}

/** One opened corestore + its own-log + live replication connections. */
interface StoreRecord {
  workspaceId: string;
  harnessSlug: string;
  storagePath: string;
  store: Corestore | null;
  /** The peer's OWN writable log. Opened by `bootHarness` (and lazily by
   *  `appendOp`); null until then. The append seam writes here. */
  ownLog: OwnLog | null;
  connections: Set<string>;
}

/** A pending socket handoff awaiting its out-of-band handle. */
interface HandoffEntry {
  storeId: string;
  peerId?: string;
  handle: Duplex | null;
  used: boolean;
  createdAt: number;
  onHandle: ((handle: Duplex) => void) | null;
}

/** How long attachSocket waits for the out-of-band handle to arrive. */
const HANDOFF_HANDLE_TIMEOUT_MS = 10_000;
/** Idle prepared handoffs expire so a never-completed token can't leak. */
const HANDOFF_TTL_MS = 60_000;

/** JSON-RPC error carrying a specific code (defaults to -32603 otherwise). */
export class RpcMethodError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
  ) {
    super(message);
    this.name = 'RpcMethodError';
  }
}

export interface SubstrateSidecarHostDeps {
  /** Override the Corestore factory (tests inject an in-memory / temp store).
   *  Default: `new Corestore(storagePath)`. */
  createStore?: (storagePath: string) => Corestore;
  /** Override own-log open (tests). Default: peer-log `openOwnLog`. */
  openOwnLogImpl?: (store: Corestore) => Promise<OwnLog>;
  /** Override the process HLC clock used by the append seam (tests want a
   *  deterministic clock). Default: the sidecar's process-global HLC. */
  hlcClock?: HlcClock;
}

export type RpcHandler = (params: unknown) => unknown | Promise<unknown>;

export interface SubstrateSidecarHost {
  /** The JSON-RPC method table the socket server dispatches to. */
  readonly methods: Record<string, RpcHandler>;
  /** Receive a Duplex handle transferred from the main process over the child
   *  IPC channel, correlated to a prepared handoff by token. Called by the bin's
   *  `process.on('message')`. */
  receiveHandle(handoffToken: string, handle: Duplex): void;
  /** Number of opened stores (tests / diagnostics). */
  storeCount(): number;
  /** Close every opened store. Idempotent. */
  closeAll(): Promise<void>;
}

// ─── store path resolution ──────────────────────────────────────────────────

interface OpenStoreRequest {
  workspaceId: string;
  harnessSlug: string;
  workspaceRoot?: string;
  storagePath?: string;
}

/** Mirror corestore.ts: `<workspaceRoot>/.papercusp/<harness>/hyperbee`. */
function resolveStoragePath(p: OpenStoreRequest): string {
  if (p.storagePath) return p.storagePath;
  const workspaceRoot = p.workspaceRoot || process.cwd();
  return path.join(workspaceRoot, '.papercusp', p.harnessSlug, 'hyperbee');
}

interface AppendOpRequest {
  storeId: string;
  op: LocalWriteOp | PeerLogOp;
  /**
   * RAW append: skip the HLC SEND stamp and append the op verbatim (the op is a
   * fully-formed `PeerLogOp` carrying its own `author_pubkey`). The append-only
   * claim path (`handle.ownLog.append`) is distinct-key per attempt + never LWW,
   * so it correctly carries no HLC — mirrors `boot.ts` using raw `ownLog.append`
   * for claims while `handle.append` stamps. Default false (the LWW seam).
   */
  raw?: boolean;
}

interface BootHarnessRequest {
  workspaceId: string;
  harnessSlug: string;
  workspaceRoot?: string;
  storagePath?: string;
  swarmBinding?: { kind: string; value: string };
}

/**
 * Build a substrate sidecar host. Owns the relocated stores + the handoff table;
 * returns the JSON-RPC method map + the out-of-band handle receiver. Pure over
 * its deps so it unit-tests without a process/socket.
 */
export function createSubstrateSidecarHost(deps: SubstrateSidecarHostDeps = {}): SubstrateSidecarHost {
  const createStore = deps.createStore ?? ((storagePath: string) => new Corestore(storagePath));
  const openOwnLogImpl = deps.openOwnLogImpl ?? openOwnLog;
  const hlcClock = deps.hlcClock;

  const storeMap = new Map<string, StoreRecord>();
  const handoffs = new Map<string, HandoffEntry>();
  let nextStoreId = 1;
  let nextConnId = 1;
  let nextHandoffId = 1;

  function findExisting(workspaceId: string, harnessSlug: string): string | null {
    const key = `${workspaceId}::${harnessSlug}`;
    for (const [id, rec] of storeMap) {
      if (`${rec.workspaceId}::${rec.harnessSlug}` === key) return id;
    }
    return null;
  }

  /** Open (idempotently) the harness store. Does NOT open the own-log — the
   *  offload path only replicates. `bootHarness`/`appendOp` open the own-log. */
  async function ensureStore(p: OpenStoreRequest): Promise<{ storeId: string; isNew: boolean }> {
    if (!p.workspaceId || !p.harnessSlug) {
      throw new RpcMethodError(-32602, 'Missing workspaceId or harnessSlug');
    }
    const existing = findExisting(p.workspaceId, p.harnessSlug);
    if (existing) return { storeId: existing, isNew: false };

    const storagePath = resolveStoragePath(p);
    await mkdir(storagePath, { recursive: true });
    const store = createStore(storagePath);
    await store.ready();

    const storeId = `store-${nextStoreId++}`;
    storeMap.set(storeId, {
      workspaceId: p.workspaceId,
      harnessSlug: p.harnessSlug,
      storagePath,
      store,
      ownLog: null,
      connections: new Set(),
    });
    return { storeId, isNew: true };
  }

  /** Open the own-log on a record if not already open. Returns it. */
  async function ensureOwnLog(rec: StoreRecord): Promise<OwnLog> {
    if (rec.ownLog) return rec.ownLog;
    if (!rec.store) throw new RpcMethodError(-32000, 'Store is closed');
    rec.ownLog = await openOwnLogImpl(rec.store);
    return rec.ownLog;
  }

  function requireRecord(storeId: string): StoreRecord {
    const rec = storeMap.get(storeId);
    if (!rec) throw new RpcMethodError(-32000, 'Store not found');
    return rec;
  }

  // ── methods ────────────────────────────────────────────────────────────────

  function handleHealthz(): unknown {
    return { status: 'ready', uptime_ms: process.uptime() * 1000, timestamp: new Date().toISOString() };
  }

  async function handleOpenStore(params: unknown): Promise<unknown> {
    return ensureStore(params as OpenStoreRequest);
  }

  async function handleCloseStore(params: unknown): Promise<unknown> {
    const p = params as { storeId: string };
    const rec = storeMap.get(p.storeId);
    if (rec?.store) {
      try {
        await rec.store.close();
      } catch {
        // best-effort: a store that already closed shouldn't fail the RPC
      }
    }
    storeMap.delete(p.storeId);
    return { ok: true };
  }

  function handleGetStoreStatus(params: unknown): unknown {
    const rec = requireRecord((params as { storeId: string }).storeId);
    return {
      isOpen: !!rec.store,
      ownLogLength: rec.ownLog?.length ?? 0,
      ownLogKey: rec.ownLog?.keyHex ?? null,
      admittedPeerCount: rec.connections.size,
      lastMergeAt: null,
    };
  }

  /** Full-store boot: open the store + own-log and return the own-log key the
   *  main-side proxy needs immediately (outbox-drain clobber attribution +
   *  presence identity). Swarm join + merge loop are P-002/P-003. */
  async function handleBootHarness(params: unknown): Promise<unknown> {
    const p = params as BootHarnessRequest;
    const open = await ensureStore(p);
    const rec = requireRecord(open.storeId);
    const ownLog = await ensureOwnLog(rec);
    return {
      storeId: open.storeId,
      ownLogKey: ownLog.keyHex,
      ownLogLength: ownLog.length,
      // Set once P-002/P-003 land; the proxy treats null as "not yet hosted".
      swarmTopicHex: null,
      mergeLoopStarted: false,
    };
  }

  /**
   * The IPC append seam — the twin of `boot.ts` `handle.append`. HLC-stamps the
   * op on the sidecar's own process clock (correct: a real peer is a separate
   * process with an independent clock) and appends it to the relocated own-log.
   */
  async function handleAppendOp(params: unknown): Promise<unknown> {
    const p = params as AppendOpRequest;
    if (!p || !p.storeId || !p.op) {
      throw new RpcMethodError(-32602, 'appendOp requires { storeId, op }');
    }
    const rec = requireRecord(p.storeId);
    const ownLog = await ensureOwnLog(rec);

    if (p.raw) {
      // Raw claim-path append: the op is already a fully-formed PeerLogOp.
      const raw = p.op as PeerLogOp;
      await ownLog.append({
        type: raw.type,
        table: raw.table,
        hbKey: raw.hbKey,
        value: raw.value,
        ts: raw.ts,
        schema_version: raw.schema_version,
        hlc: raw.hlc,
        author_pubkey: raw.author_pubkey ?? '',
      });
      return { ok: true, ownLogLength: ownLog.length, hlc: raw.hlc ?? null };
    }

    const stamped = stampOpHlc(p.op as LocalWriteOp, hlcClock ?? undefined);
    const peerOp: PeerLogOp = {
      type: stamped.type,
      table: stamped.table,
      hbKey: stamped.hbKey,
      value: stamped.value,
      ts: stamped.ts,
      schema_version: stamped.schema_version,
      hlc: stamped.hlc,
      // STAGE-5 (mirrors boot.ts): thread the real device pubkey when the claim
      // rewrite lands; until then attribute to the write's clobber pubkey.
      author_pubkey: stamped.writerPubkey ?? '',
    };
    await ownLog.append(peerOp);
    return { ok: true, ownLogLength: ownLog.length, hlc: stamped.hlc };
  }

  // ── merge / admission / swarm — P-002/P-003 stubs (stable proxy surface) ────

  function handleOnAnnounce(params: unknown): unknown {
    const p = params as { announce: { logKey: string } };
    // Admission decision relocates with the swarm (P-003). Until then admit so
    // the offload convergence proof keeps replicating.
    return { decision: 'admit', remoteLogKey: p.announce.logKey };
  }
  function handleTriggerMergeNow(_params: unknown): unknown {
    return { mergedOps: 0, durationMs: 0 };
  }
  function handleGetMergeStatus(_params: unknown): unknown {
    return { lastMergeAt: null, lastMergeDurationMs: 0, totalOpsProcessed: 0, admittedPeerCount: 0, nextMergeIn: 1000 };
  }
  function handleGetAdmittedLogs(_params: unknown): unknown {
    return { logs: [] };
  }
  function handleRevoke(_params: unknown): unknown {
    // Revocation relocates with admission (P-003). No-op until then.
    return { ok: true, revoked: false };
  }
  function handleRekey(_params: unknown): unknown {
    // Re-key relocates with the swarm (P-003). No-op until then.
    return { ok: true, rekeyed: false };
  }

  // ── socket handoff (Option B replication-offload, preserved) ────────────────

  function handlePrepareSocketHandoff(params: unknown): unknown {
    const p = params as { storeId: string; peerId?: string };
    requireRecord(p.storeId);
    sweepExpiredHandoffs();
    const handoffToken = `hoff-${nextHandoffId++}-${crypto.randomBytes(8).toString('hex')}`;
    handoffs.set(handoffToken, {
      storeId: p.storeId,
      peerId: p.peerId,
      handle: null,
      used: false,
      createdAt: Date.now(),
      onHandle: null,
    });
    return { handoffToken };
  }

  async function handleAttachSocket(params: unknown): Promise<unknown> {
    const p = params as { storeId: string; handoffToken: string; initiator?: boolean };
    const entry = handoffs.get(p.handoffToken);
    if (!entry || entry.used) {
      throw new RpcMethodError(-32002, 'Socket handoff failed: unknown or already-used token');
    }
    if (entry.storeId !== p.storeId) {
      throw new RpcMethodError(-32002, 'Socket handoff failed: storeId mismatch for token');
    }
    const rec = storeMap.get(p.storeId);
    if (!rec || !rec.store) throw new RpcMethodError(-32000, 'Store not found');

    const handle = entry.handle ?? (await waitForHandle(entry, HANDOFF_HANDLE_TIMEOUT_MS));
    if (!handle) {
      throw new RpcMethodError(-32002, 'Socket handoff failed: handle did not arrive over IPC');
    }

    entry.used = true;
    handoffs.delete(p.handoffToken);

    const connectionId = `conn-${nextConnId++}`;
    replicateOverTransport(rec.store, handle, Boolean(p.initiator));
    rec.connections.add(connectionId);
    handle.on('close', () => rec.connections.delete(connectionId));
    return { ok: true, connectionId };
  }

  function waitForHandle(entry: HandoffEntry, timeoutMs: number): Promise<Duplex | null> {
    if (entry.handle) return Promise.resolve(entry.handle);
    return new Promise<Duplex | null>((resolve) => {
      const t = setTimeout(() => {
        entry.onHandle = null;
        resolve(null);
      }, timeoutMs);
      entry.onHandle = (handle: Duplex) => {
        clearTimeout(t);
        resolve(handle);
      };
    });
  }

  function sweepExpiredHandoffs(): void {
    const now = Date.now();
    for (const [token, entry] of handoffs) {
      if (!entry.used && now - entry.createdAt > HANDOFF_TTL_MS) {
        try {
          entry.handle?.destroy?.();
        } catch {
          // best-effort
        }
        handoffs.delete(token);
      }
    }
  }

  async function handleGetCoreInfo(params: unknown): Promise<unknown> {
    const p = params as { storeId: string; coreKeyHex: string; fetchBlock?: number; download?: boolean };
    const rec = storeMap.get(p.storeId);
    if (!rec || !rec.store) throw new RpcMethodError(-32000, 'Store not found');

    const core = rec.store.get({ key: Buffer.from(p.coreKeyHex, 'hex') }) as unknown as HypercoreLike;
    await core.ready();
    try {
      await core.update({ wait: true });
    } catch {
      // no peer / nothing to learn yet — return whatever length we have
    }
    if (p.download && core.length > 0) await downloadAll(core);

    let blockBase64: string | undefined;
    if (typeof p.fetchBlock === 'number' && core.length > p.fetchBlock) {
      try {
        const block = await core.get(p.fetchBlock, { wait: true });
        blockBase64 = Buffer.from(block).toString('base64');
      } catch {
        // block not retrievable (peer gone) — omit it
      }
    }
    return { length: core.length, byteLength: core.byteLength, blockBase64 };
  }

  const methods: Record<string, RpcHandler> = {
    'sidecar:healthz': () => handleHealthz(),
    'substrate:openStore': handleOpenStore,
    'substrate:closeStore': handleCloseStore,
    'substrate:getStoreStatus': handleGetStoreStatus,
    'substrate:bootHarness': handleBootHarness,
    'substrate:appendOp': handleAppendOp,
    'substrate:onAnnounce': handleOnAnnounce,
    'substrate:triggerMergeNow': handleTriggerMergeNow,
    'substrate:getMergeStatus': handleGetMergeStatus,
    'substrate:getAdmittedLogs': handleGetAdmittedLogs,
    'substrate:revoke': handleRevoke,
    'substrate:rekey': handleRekey,
    'substrate:prepareSocketHandoff': handlePrepareSocketHandoff,
    'substrate:attachSocket': handleAttachSocket,
    'substrate:getCoreInfo': handleGetCoreInfo,
  };

  function receiveHandle(handoffToken: string, handle: Duplex): void {
    const entry = handoffs.get(handoffToken);
    if (!entry) {
      try {
        (handle as { destroy?: () => void } | null)?.destroy?.();
      } catch {
        // best-effort
      }
      return;
    }
    entry.handle = handle;
    if (entry.onHandle) {
      const cb = entry.onHandle;
      entry.onHandle = null;
      cb(handle);
    }
  }

  async function closeAll(): Promise<void> {
    for (const [, rec] of storeMap) {
      if (rec.store) {
        try {
          await rec.store.close();
        } catch {
          // best-effort
        }
      }
    }
    storeMap.clear();
    handoffs.clear();
  }

  return {
    methods,
    receiveHandle,
    storeCount: () => storeMap.size,
    closeAll,
  };
}

/** Dumb-pipe a raw transport into a corestore replication protocol stream. */
function replicateOverTransport(store: Corestore, transport: Duplex, initiator: boolean): void {
  const repl = store.replicate(initiator) as unknown as Duplex;
  transport.on('error', () => {});
  repl.on('error', () => {});
  transport.pipe(repl).pipe(transport);
}

/** Download every block of a core (the merkle-verify CPU + I/O of a catch-up). */
async function downloadAll(core: HypercoreLike): Promise<void> {
  try {
    const range = core.download({ start: 0, end: core.length });
    if (range && typeof (range as { done?: unknown }).done === 'function') {
      await (range as { done(): Promise<void> }).done();
      return;
    }
    await (range as Promise<void>);
    return;
  } catch {
    // fall through to a sequential fetch
  }
  for (let i = 0; i < core.length; i++) {
    try {
      await core.get(i, { wait: true });
    } catch {
      // best-effort per block
    }
  }
}
