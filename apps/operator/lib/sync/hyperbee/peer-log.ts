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
// Imported for reference only — `PeerLogOp` is defined explicitly below so this
// module does not depend on autobase-setup being kept (it is on the way out).
import type { OpEnvelope } from './autobase-setup';

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
}

// Compile-time guard that PeerLogOp stays a faithful subset of OpEnvelope's
// put/del fields (minus addWriter, plus author_pubkey). Purely structural; no
// runtime cost. If autobase-setup's OpEnvelope drifts, this surfaces it here.
type _PeerLogOpSharesEnvelope = Pick<OpEnvelope, 'table' | 'hbKey' | 'value' | 'ts' | 'schema_version'>;
const _opEnvelopeCompat: (op: PeerLogOp) => _PeerLogOpSharesEnvelope = (op) => op;
void _opEnvelopeCompat;

/** The peer's own writable log handle. */
export interface OwnLog {
  /** Append a single op to the end of the log. */
  append(op: PeerLogOp): Promise<void>;
  /** Read the op at index `i` (decoded), or `null` if out of range. */
  get(i: number): Promise<PeerLogOp | null>;
  /** Number of ops appended so far. */
  readonly length: number;
  /** 64-char lowercase hex hypercore key — the `log_core_key` to replicate. */
  readonly keyHex: string;
}

/** A read-only replica handle to another peer's log. */
export interface RemoteLog {
  /** Read the op at index `i` (blocks until downloaded), or `null`. */
  get(i: number): Promise<PeerLogOp | null>;
  /** Block until the writer's current length is known to this replica. */
  update(): Promise<void>;
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
    async get(i: number): Promise<PeerLogOp | null> {
      const v = await core.get(i);
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
      const v = await core.get(i, { wait: true });
      return (v as PeerLogOp | null) ?? null;
    },
    async update(): Promise<void> {
      await core.update({ wait: true });
    },
    get length(): number {
      return core.length;
    },
    get keyHex(): string {
      return keyHex;
    },
  };
}
