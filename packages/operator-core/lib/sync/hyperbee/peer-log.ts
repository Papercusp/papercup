/**
 * peer-log.ts — per-peer single-writer Hypercore op-log (Model B, Stage 1).
 *
 * The lowest layer of the Model B substrate rewrite: it replaces the
 * multi-writer Autobase with one signed, append-only log PER PEER plus a
 * read-merge over the others (later stages). This module exposes:
 *
 *   - `openOwnLog(store)`   — the peer's OWN writable log (`writable === true`).
 *     Appends carry a `PeerLogOp` (a single-writer op envelope); reads decode
 *     back to a plain object via `valueEncoding: 'json'`.
 *
 *   - `openRemoteLog(store, keyHex)` — a READ-ONLY replica handle to another
 *     peer's log, addressed by its hypercore key hex (`writable === false`).
 *     `update()` blocks until the writer's length is known; `get(i)` blocks
 *     until the block downloads. Replication itself is wired in Stage 4 — this
 *     stage only exposes the handle + `update()`.
 *
 * Pure over an injected `Corestore` so it unit-tests without the network.
 * Mirrors `corestore.ts` conventions: `store.get({ name | key, valueEncoding })`.
 *
 * Stage-0-VERIFIED API notes (do not deviate without re-probing):
 *  - Own log: `store.get({ name: 'peer-log', valueEncoding: 'json' })`; with
 *    `valueEncoding:'json'`, `append(obj)` takes an object and `get(i)` returns
 *    a DECODED object — no manual encode/decode.
 *  - `core.key` is a 32-byte Buffer; `keyHex = core.key.toString('hex')` is the
 *    64-char lowercase `log_core_key` used to replicate. It is DISTINCT from the
 *    device-identity pubkey (`PeerLogOp.author_pubkey`); do not conflate them.
 *  - Remote: `store.get({ key, valueEncoding: 'json' })`; a remote needs
 *    `await core.update({ wait: true })` before `core.length` reflects the
 *    writer's appends, and `core.get(i, { wait: true })` to block on download.
 */

import type Corestore from 'corestore';
// Imported for the compile-time field-compat guard below. `PeerLogOp` is
// defined explicitly so this module doesn't depend on the (retiring) Autobase;
// `OpEnvelope` now lives in its own types module (Stage 4d).
import type { OpEnvelope } from './op-envelope-types';

/**
 * A single-writer op envelope. This is the `OpEnvelope` shape MINUS the
 * `addWriter` variant (single-writer logs never carry admission ops) PLUS a
 * required `author_pubkey` — the device-identity pubkey of the writer,
 * caller-supplied and DISTINCT from the hypercore `keyHex`.
 */
export interface PeerLogOp {
  type: 'put' | 'del';
  table: string;
  hbKey: string;
  value?: unknown;
  ts: number;
  schema_version: number;
  /**
   * Hex device-identity pubkey of the writer. Caller-supplied; NOT the
   * hypercore key (see `keyHex`). Used by later read-merge/admission stages to
   * attribute an op to a peer identity independent of which core carried it.
   */
  author_pubkey: string;
  /**
   * Hybrid Logical Clock stamp (D-003), `encodeHlc`-encoded (sortable string).
   * Stamped at the append seam (`boot.ts` `handle.append`, P-010) for every
   * LWW-federated write, so `lwwPick` orders cross-peer conflicts by causal HLC
   * instead of bare wall-clock `ts` (skew-robust + happens-before across
   * machines). Optional + additive: ops written without it (e.g. the
   * append-only, never-LWW claim path, or pre-P-010 history) fall back to `ts`.
   * Round-trips through `valueEncoding:'json'` like every other field.
   */
  hlc?: string;
}

// Compile-time guard that catches field-REMOVAL drift only: if a field named
// here is dropped from OpEnvelope, the `Pick` stops compiling. It does NOT
// catch a type change on those fields — they're all optional on OpEnvelope, so
// a `PeerLogOp` (with its required versions) still satisfies the `Pick`. Purely
// structural; no runtime cost. Keeps the per-peer-log op aligned with the
// projection-layer `OpEnvelope` (op-envelope-types.ts).
type _PeerLogOpSharesEnvelope = Pick<OpEnvelope, 'table' | 'hbKey' | 'value' | 'ts' | 'schema_version'>;
const _opEnvelopeCompat: (op: PeerLogOp) => _PeerLogOpSharesEnvelope = (op) => op;
void _opEnvelopeCompat;

/** The peer's own writable log handle. */
export interface OwnLog {
  /** Append a single op to the end of the log. */
  append(op: PeerLogOp): Promise<void>;
  /**
   * Append many ops in one Hypercore batch (one signing + flush instead of
   * one per op). Semantically identical to awaiting `append` per op; exists
   * because bulk corpus loads (the p2p-perf suite seeds 10k-1M-op histories)
   * are ~2 orders of magnitude faster batched.
   */
  appendBatch(ops: PeerLogOp[]): Promise<void>;
  /** Read the op at index `i` (decoded), or `null` if out of range. */
  get(i: number): Promise<PeerLogOp | null>;
  /** Number of ops appended so far. */
  readonly length: number;
  /** 64-char lowercase hex hypercore key — the `log_core_key` to replicate. */
  readonly keyHex: string;
}

/** A read-only replica handle to another peer's log. */
export interface RemoteLog {
  /**
   * Read the op at index `i`. Returns `null` if `i` is out of the replica's
   * known range (negative, or `>= length` — call `update()` first to refresh
   * `length`); otherwise blocks until the in-range block downloads from the
   * peer, then returns the decoded op.
   */
  get(i: number): Promise<PeerLogOp | null>;
  /** Block until the writer's current length is known to this replica. */
  update(): Promise<void>;
  /**
   * Fire-and-forget RANGED download request for blocks [start, end). Makes the
   * peer stream the whole range continuously instead of paying one round trip
   * per sequential `get(i)` — without it, WAN merge ingest is RTT-bound at
   * ~1/RTT ops/sec per log (EI-92). Never throws and never blocks: subsequent
   * `get(i)` calls resolve as blocks arrive.
   */
  prefetch(start: number, end: number): void;
  /** True iff block `i` is downloaded locally (Hypercore `has`). A snapshot-seeded
   *  joiner never requests blocks before its snapshot index, so this is false there —
   *  the sparse-fetch the compaction buys (substrate-peer-log-compaction P-008). */
  has(i: number): boolean;
  /** Length of the contiguous downloaded prefix from index 0 (Hypercore
   *  `contiguousLength`); 0 when block 0 is absent — i.e. a sparse-from-snapshot replica. */
  readonly contiguousLength: number;
  /** Known length of the remote log (call `update()` first to refresh). */
  readonly length: number;
  /** 64-char lowercase hex hypercore key this replica tracks. */
  readonly keyHex: string;
}

/**
 * Minimal structural view of the bits of a Hypercore we touch. Corestore's
 * `.get()` is typed loosely upstream, so we narrow at the boundary rather than
 * leaking `any` through the module.
 */
interface CoreLike {
  ready(): Promise<void>;
  append(value: unknown): Promise<number>;
  get(index: number, opts?: { wait?: boolean }): Promise<unknown>;
  update(opts?: { wait?: boolean }): Promise<boolean>;
  /** Hypercore ranged download — returns a Range whose `done()` resolves when
   *  the range is local. Optional in the structural view (present on real cores). */
  download?(range: { start: number; end: number }): { done(): Promise<void> };
  /** Whether block `index` is downloaded locally. Present on real cores. */
  has?(index: number): boolean;
  /** Length of the contiguous downloaded prefix from 0. Present on real cores. */
  readonly contiguousLength?: number;
  readonly length: number;
  readonly key: Buffer;
  readonly writable: boolean;
}

function getCore(store: Corestore, opts: { name: string } | { key: Buffer }): CoreLike {
  // `valueEncoding: 'json'` makes append/get round-trip plain objects.
  return (store as unknown as {
    get(o: Record<string, unknown>): CoreLike;
  }).get({ ...opts, valueEncoding: 'json' });
}

/**
 * Open the peer's OWN writable single-writer log. The core is created lazily by
 * Corestore on first access under the fixed name `'peer-log'`, so every call on
 * a given store returns the same underlying writable core.
 */
export async function openOwnLog(store: Corestore): Promise<OwnLog> {
  const core = getCore(store, { name: 'peer-log' });
  await core.ready();
  const keyHex = core.key.toString('hex');

  return {
    async append(op: PeerLogOp): Promise<void> {
      await core.append(op);
    },
    async appendBatch(ops: PeerLogOp[]): Promise<void> {
      if (ops.length === 0) return;
      // Hypercore's append accepts an array of blocks — one batch, one flush.
      await core.append(ops);
    },
    async get(i: number): Promise<PeerLogOp | null> {
      // Out-of-range → null. The own core is writable with no peers, so an
      // unguarded `core.get(i)` for `i >= length` would block forever on
      // Hypercore's default `wait: true`, and a negative `i` would throw.
      if (i < 0 || i >= core.length) return null;
      // `wait: false`: a locally-absent block returns null rather than blocking
      // (the own log is the source of truth, so present in-range blocks resolve).
      const v = await core.get(i, { wait: false });
      return (v as PeerLogOp | null) ?? null;
    },
    get length(): number {
      return core.length;
    },
    get keyHex(): string {
      return keyHex;
    },
  };
}

/**
 * Open a READ-ONLY replica handle to another peer's log, addressed by its
 * hypercore key hex. The returned core is non-writable; `update()` /
 * `get(i, { wait: true })` block on the (Stage-4-wired) replication stream.
 */
export async function openRemoteLog(store: Corestore, keyHex: string): Promise<RemoteLog> {
  const core = getCore(store, { key: Buffer.from(keyHex, 'hex') });
  await core.ready();

  return {
    async get(i: number): Promise<PeerLogOp | null> {
      // Out-of-(known-)range → null: guard before the awaited get so a negative
      // or past-the-end index returns null instead of throwing/blocking. For an
      // in-range index `get(i, { wait: true })` blocks until the block downloads
      // from the peer, then returns the decoded op.
      if (i < 0 || i >= core.length) return null;
      const v = await core.get(i, { wait: true });
      return (v as PeerLogOp | null) ?? null;
    },
    async update(): Promise<void> {
      const before = core.length;
      await core.update({ wait: true });
      // EI-681 diag: surface the remote core's live replication state — does this
      // replica have a peer to pull from, and does update() advance the length?
      // peers=0 ⇒ the core has NO replication session (admitted but not wired to
      // the writer); len stuck with peers>0 ⇒ the writer isn't serving appends.
      const peers = (core as unknown as { peers?: unknown[] }).peers?.length ?? -1;
      console.log(
        `[ei681-diag] remoteLog ${keyHex.slice(0, 8)} update: len ${before}→${core.length} peers=${peers} contig=${core.contiguousLength ?? -1}`,
      );
    },
    prefetch(start: number, end: number): void {
      if (typeof core.download !== 'function') return;
      if (end <= start || start < 0) return;
      try {
        // Fire-and-forget: the range request rides the replication stream in
        // the background; `done()` is observed only to swallow rejection
        // (peer gone mid-range is normal churn, not an error).
        const range = core.download({ start, end });
        void range.done().catch(() => {});
      } catch {
        // A failed request degrades to per-op sequential fetch — still correct.
      }
    },
    has(i: number): boolean {
      return typeof core.has === 'function' ? !!core.has(i) : false;
    },
    get contiguousLength(): number {
      return core.contiguousLength ?? 0;
    },
    get length(): number {
      return core.length;
    },
    get keyHex(): string {
      return keyHex;
    },
  };
}
