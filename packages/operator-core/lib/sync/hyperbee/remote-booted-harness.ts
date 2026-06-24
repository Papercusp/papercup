/**
 * RemoteBootedHarnessHandle — the main-process proxy for a harness substrate
 * RELOCATED into the sidecar (substrate-sidecar-store-relocation-2026-06-23,
 * P-001).
 *
 * After the relocation the corestore + own-log + merge loop + swarm live in the
 * sidecar (Corestore's process-level file lock forbids the store living in two
 * processes). The main operator therefore holds NO corestore: it reads PG
 * projections (written by the sidecar's merge loop) and routes the few WRITE +
 * control calls over IPC. This proxy implements `BootedHarnessHandle` so it is a
 * drop-in for `getBootedHarness` (the P-004 cutover) without touching the 5
 * log-first producers / control callers.
 *
 * Routing:
 *   - `append(op)`          → `substrate:appendOp` (HLC-stamped in the sidecar).
 *   - `ownLog.append(op)`   → `substrate:appendOp { raw:true }` (the append-only
 *                             claim path; no HLC, op is a fully-formed PeerLogOp).
 *   - `ownLog.keyHex`       → the key the sidecar returned at boot (data; used by
 *                             the outbox-drain's clobber attribution + presence).
 *   - `mergeNow()`          → `substrate:triggerMergeNow`.
 *   - `revoke()` / `rekey()`→ `substrate:revoke` / `substrate:rekey`.
 *   - `close()`             → run local close-hooks, then `substrate:closeStore`.
 *
 * Sidecar-internal members (`store`, `swarm`, `admitted`, `onAnnounce`) are NOT
 * consumed by the main process once the swarm relocates (P-003): `store` throws
 * a precise error (surfacing any stray main-process reader to fix in P-004),
 * `swarm` is null, `admitted` is empty, `onAnnounce` throws.
 */

import type Corestore from 'corestore';
import type { BootedHarnessHandle, LocalWriteOp } from './boot';
import type { OwnLog, PeerLogOp } from './peer-log';
import type { AdmittedLog } from './read-merge';
import type { SwarmHandle } from './swarm';
import type { SignedAnnounce } from './announce';
import type { AdmissionResult } from './read-admission';
import type { SwarmBinding } from './derive-swarm-topic';

/** The subset of the IPC client this proxy needs (injectable for tests). */
export interface SubstrateRpcCaller {
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
}

export interface RemoteBootedHarnessOpts {
  workspaceId: string;
  harnessSlug: string;
  /** The sidecar store id returned by `substrate:bootHarness`. */
  storeId: string;
  /** The own-log key the sidecar returned at boot (64-hex). */
  ownLogKey: string;
  /** Own-log length at boot (seeds the locally-tracked length). */
  ownLogLength?: number;
  /** The IPC client (defaults to the process-global substrate IPC client). */
  client: SubstrateRpcCaller;
}

interface AppendOpResponse {
  ok: boolean;
  ownLogLength: number;
  hlc: string | null;
}

/** A mutable own-log length, shared by the handle's `append` (LWW seam) and the
 *  own-log shim's `append` (raw claim path) so both report one length. */
interface LengthHolder {
  length: number;
}

/** Own-log shim backed by IPC. Exposes the relocated own-log's key + length and
 *  routes raw appends; reads are sidecar-internal. */
class RemoteOwnLog implements OwnLog {
  constructor(
    private readonly storeId: string,
    private readonly client: SubstrateRpcCaller,
    private readonly keyHexValue: string,
    private readonly lengthHolder: LengthHolder,
  ) {}

  async append(op: PeerLogOp): Promise<void> {
    const r = await this.client.call<AppendOpResponse>('substrate:appendOp', {
      storeId: this.storeId,
      op,
      raw: true,
    });
    if (typeof r?.ownLogLength === 'number') this.lengthHolder.length = r.ownLogLength;
  }

  async appendBatch(ops: PeerLogOp[]): Promise<void> {
    for (const op of ops) await this.append(op);
  }

  async get(_i: number): Promise<PeerLogOp | null> {
    throw new Error(
      'RemoteOwnLog.get is not available on the main process — own-log reads are ' +
        'sidecar-internal (the store lives in the sidecar after relocation).',
    );
  }

  get length(): number {
    return this.lengthHolder.length;
  }

  get keyHex(): string {
    return this.keyHexValue;
  }
}

/**
 * A `BootedHarnessHandle` whose engine lives in the substrate sidecar. Routes
 * writes + control over IPC and reads PG-only.
 */
export class RemoteBootedHarnessHandle implements BootedHarnessHandle {
  readonly workspaceId: string;
  readonly harnessSlug: string;
  private readonly storeId: string;
  private readonly client: SubstrateRpcCaller;
  private readonly _ownLog: RemoteOwnLog;
  private readonly lengthHolder: LengthHolder;
  private readonly closeHooks = new Set<() => void | Promise<void>>();
  private closed = false;

  // The main process has no admitted set / swarm — they relocate to the sidecar.
  readonly admitted = new Map<string, AdmittedLog>();

  constructor(opts: RemoteBootedHarnessOpts) {
    this.workspaceId = opts.workspaceId;
    this.harnessSlug = opts.harnessSlug;
    this.storeId = opts.storeId;
    this.client = opts.client;
    this.lengthHolder = { length: opts.ownLogLength ?? 0 };
    this._ownLog = new RemoteOwnLog(opts.storeId, opts.client, opts.ownLogKey, this.lengthHolder);
  }

  /** The corestore lives in the sidecar — there is no in-process store. A read
   *  here is a relocation bug (a main-process consumer still reaching for the raw
   *  store); the throw names it precisely for the P-004 audit. */
  get store(): Corestore {
    throw new Error(
      `RemoteBootedHarnessHandle.store: the corestore for ${this.harnessSlug} lives in the ` +
        `substrate sidecar (file-lock relocation) — main-process consumers must read PG ` +
        `projections or route over IPC, never the raw store.`,
    );
  }

  get ownLog(): OwnLog {
    return this._ownLog;
  }

  /** The LWW SEND seam — HLC-stamped in the sidecar (its own process clock). */
  async append(op: LocalWriteOp): Promise<void> {
    const r = await this.client.call<AppendOpResponse>('substrate:appendOp', {
      storeId: this.storeId,
      op,
    });
    if (typeof r?.ownLogLength === 'number') this.lengthHolder.length = r.ownLogLength;
  }

  async mergeNow(): Promise<number> {
    const r = await this.client.call<{ mergedOps: number }>('substrate:triggerMergeNow', {
      storeId: this.storeId,
    });
    return r?.mergedOps ?? 0;
  }

  onAnnounce(_frame: SignedAnnounce): Promise<AdmissionResult> {
    // Announces are accepted + decided inside the sidecar once the swarm
    // relocates (P-003) — the main process never receives them.
    throw new Error(
      'RemoteBootedHarnessHandle.onAnnounce: peer announces are handled inside the ' +
        'substrate sidecar; the main process does not run the swarm after relocation.',
    );
  }

  onAdmitted(_listener: (info: { logKeyHex: string; admittedSize: number }) => void): () => void {
    // Admission events fire in the sidecar; a main-process listener is a no-op
    // until a sidecar→main admission push is wired (P-003). Returns a no-op
    // unsubscribe so callers (audit/perf rigs) don't break.
    return () => {};
  }

  async revoke(devicePubkey: string): Promise<void> {
    await this.client.call('substrate:revoke', { storeId: this.storeId, devicePubkey });
  }

  async reverifyAdmitted(): Promise<void> {
    // Channel-2 re-verification runs inside the sidecar's merge loop. Best-effort
    // no-op on the main side.
  }

  get swarm(): SwarmHandle | null {
    // The swarm lives in the sidecar.
    return null;
  }

  async rekey(binding: SwarmBinding): Promise<void> {
    await this.client.call('substrate:rekey', { storeId: this.storeId, binding });
  }

  registerCloseHook(hook: () => void | Promise<void>): () => void {
    this.closeHooks.add(hook);
    return () => {
      this.closeHooks.delete(hook);
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Run close-hooks first (mirrors boot.ts: hooks before the store tears down).
    for (const hook of this.closeHooks) {
      try {
        await hook();
      } catch (e) {
        // best-effort: a throwing hook never blocks the rest of teardown.
        // eslint-disable-next-line no-console
        console.warn('[remote-booted-harness] close hook failed:', e instanceof Error ? e.message : String(e));
      }
    }
    this.closeHooks.clear();
    try {
      await this.client.call('substrate:closeStore', { storeId: this.storeId });
    } catch {
      // best-effort: the sidecar may already be gone.
    }
  }
}
