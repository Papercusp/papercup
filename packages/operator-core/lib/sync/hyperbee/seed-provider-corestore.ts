/**
 * seed-provider-corestore — the corestore SeedProvider (plan
 * hive-seed-bundle-2026-07-04 P-003; design memo agent-insights/hive-seed-bundle-design).
 *
 * Carries the FEDERATED hive state (plans, work-items, features, issues,
 * coordination, settings, members — everything a peer replicates as admitted
 * author logs) as a CHECKPOINT so a fresh install pre-positions the blocks and
 * the unmodified swarm replication then transfers only the delta (blocks past
 * the seeded length).
 *
 * TWO correctness properties this module is built around — a naive
 * "copy the store directory" gets BOTH wrong:
 *
 *  1. NO SECRET-KEY LEAK. The owner's store holds its OWN writable log, whose
 *     storage includes the owner's signing secret. Shipping that in a public
 *     installer would leak the owner's identity. So `cut` never copies the
 *     source store — it opens each admitted log by KEY (read-only, no secret)
 *     into a fresh REPLICA store and downloads the blocks. The replica has
 *     ciphertext blocks + merkle trees + public keys, and NO secrets.
 *
 *  2. NO PRIMARY-KEY COLLISION. A corestore's NAME-derived cores (a peer's own
 *     writable log = `store.get({ name:'peer-log' })`) hash off the store's
 *     primary key. If the seed carried a primary key, EVERY install restoring
 *     the same seed would derive the SAME own-log key and collide as writers.
 *     So `restore` does NOT copy the seed's store dir into B — it opens B's OWN
 *     fresh store (B mints its own primary), and INJECTS the seeded read-only
 *     cores into it by replicating from a throwaway store opened on the seed.
 *     B's own log stays unique; the seeded cores (addressed by their own public
 *     keys, independent of any primary) land in B's store ready to serve the
 *     boot read-merge and to delta-replicate forward.
 *
 * The seed is UNTRUSTED CACHE: every seeded block is author-signed and
 * merkle-verified by hypercore on read, and the hive content is epoch-ciphertext
 * (hive-epoch-content-ops) — useless until admission delivers the key. `verify`
 * additionally gates on a content hash of the payload before restore.
 */

import Corestore from 'corestore';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import type {
  SeedProvider,
  SeedStoreEntry,
  SeedCutContext,
  SeedCutOutput,
  SeedRestoreContext,
  SeedPayload,
  VerifyResult,
} from '@papercusp/seed-bundle';
import type { PeerLogOp } from './peer-log';
import { findLatestCompleteSnapshot, type AdmittedLog } from './read-merge';

export const CORESTORE_SEED_KIND = 'corestore';

/** `.replicate()` is typed loosely upstream; it returns a duplex stream. */
type Pipeable = { pipe<T extends Pipeable>(dest: T): T; destroy(): void };

/** `store.get()` is typed loosely upstream (`unknown`); narrow at the boundary. */
interface ReadableCore {
  readonly length: number;
  ready(): Promise<void>;
  update(opts?: { wait?: boolean }): Promise<void>;
  get(i: number, opts?: { wait?: boolean }): Promise<unknown>;
}

/** Context for {@link createCorestoreSeedProvider}.cut (build/release time). */
export interface CorestoreCutContext {
  /** The live/quiescent source store to cut from (the owner's store). */
  readonly sourceStore: Corestore;
  /** Hex keys of the admitted author logs to seed (read-only). */
  readonly coreKeys: readonly string[];
  /** Directory the read-only replica is materialized into — becomes the payload. */
  readonly stagingDir: string;
  /**
   * seed-history-trim-public-builds-2026-07-07 P-004 — SPARSE cut. When true,
   * each core ships only `[seedIndex, length)` where `seedIndex` is the chunk-0
   * index of its latest COMPLETE snapshot set (per read-merge's
   * `findLatestCompleteSnapshot`, the SAME locator the joiner's cursor seeds to,
   * so cut + reader agree by construction). The summarized-and-superseded prefix
   * `[0, seedIndex)` (the ~2GB of churn/history) is DROPPED. Projection-equivalent
   * (P-002): the snapshot rows reconstitute current state, so a snapshot-aware
   * reader (SUBSTRATE_LOG_SNAPSHOT ON — P-005, REQUIRED for a sparse seed) folds
   * from `seedIndex` forward to the identical PG read model.
   *
   * A core with NO complete snapshot within read-merge's `SNAPSHOT_SCAN_LOOKBACK`
   * of its tail ships FULL (`seedIndex = 0`) + warns — the reader couldn't seed
   * past a prefix it can't locate anyway, so a full ship is the safe fallback.
   * The caller SHOULD append a fresh head snapshot (produceLogSnapshot, P-003)
   * AFTER any large pre-cut drain, or the last snapshot falls outside the scan
   * window and every core degrades to a full ship.
   *
   * Omitted / false ⇒ full ship (`downloadCoreRange` from 0), byte-identical to
   * the pre-P-004 behavior.
   */
  readonly sparse?: boolean;
}

/** Context for {@link createCorestoreSeedProvider}.restore (first-boot time). */
export interface CorestoreRestoreContext {
  /** The fresh install's hyperbee store dir (`.papercusp/<harness>/hyperbee`). */
  readonly targetStoreDir: string;
}

interface CorestoreSeedMeta {
  readonly coreKeys: string[];
  readonly coreLengths: Record<string, number>;
  /**
   * P-004 — per-core sparse-suffix start: the index of the first block the seed
   * SHIPS (`0` for a full ship). RESTORE MUST download only `[coreSparseFrom, len)`
   * — a sparse seed only SERVES that suffix, so a full-range download (or any
   * `get(i, {wait:true})` for `i < coreSparseFrom`) HANGS on the absent prefix in
   * an offline restore (no other peer holds those blocks). Absent ⇒ a legacy
   * full-ship seed ⇒ restore reads from 0 (unchanged).
   */
  readonly coreSparseFrom?: Record<string, number>;
}

async function walkFiles(root: string, dir: string = root, acc: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) await walkFiles(root, full, acc);
    else if (e.isFile()) acc.push(relative(root, full));
  }
  return acc;
}

/** Deterministic sha256 over a directory's file paths + bytes (sorted). */
async function hashDir(root: string): Promise<string> {
  const h = createHash('sha256');
  const rels = (await walkFiles(root)).sort();
  for (const rel of rels) {
    h.update(rel + '\0');
    h.update(await readFile(join(root, rel)));
  }
  return h.digest('hex');
}

async function dirSize(root: string): Promise<number> {
  let total = 0;
  for (const rel of await walkFiles(root)) total += (await stat(join(root, rel))).size;
  return total;
}

/**
 * Open a core by key in `store` and pull blocks `[from, length)` into local
 * storage. `from = 0` (the default) materializes the whole core (the pre-P-004
 * behavior). A sparse `from > 0` pulls only the suffix — the seed then SERVES only
 * that suffix, so the RESTORE side must call with the SAME `from` (from
 * `meta.coreSparseFrom`) or `get(i, {wait:true})` for `i < from` hangs on a block
 * no offline peer holds. Returns the core's full `length` (the authenticated head
 * length, independent of how many blocks were downloaded).
 */
async function downloadCoreRange(store: Corestore, keyHex: string, from = 0): Promise<number> {
  const core = store.get({ key: Buffer.from(keyHex, 'hex'), valueEncoding: 'json' }) as unknown as ReadableCore;
  await core.ready();
  await core.update({ wait: true });
  const len: number = core.length;
  for (let i = Math.max(0, from); i < len; i++) await core.get(i, { wait: true });
  return len;
}

/** Adapt a corestore core (read via replication from the FULL source) to the
 *  {@link AdmittedLog} shape `findLatestCompleteSnapshot` scans. */
function coreAsAdmittedLog(core: ReadableCore, keyHex: string): AdmittedLog {
  return {
    keyHex,
    get length() {
      return core.length;
    },
    get: async (i: number) => (await core.get(i, { wait: true })) as PeerLogOp | null,
  };
}

/**
 * P-004 — the sparse-suffix start for a core: the chunk-0 index of its latest
 * COMPLETE snapshot set, via read-merge's `findLatestCompleteSnapshot` (the SAME
 * locator the joiner's cursor seeds to, so a `[seedIndex, len)` ship lines up with
 * where the reader folds from). `0` ⇒ no complete snapshot within the reader's scan
 * window ⇒ ship FULL (the reader can't seed past a prefix it can't find, so trimming
 * it would break restore). Scans only the tail — reads no prefix block.
 */
async function computeSparseFrom(store: Corestore, keyHex: string): Promise<number> {
  const core = store.get({ key: Buffer.from(keyHex, 'hex'), valueEncoding: 'json' }) as unknown as ReadableCore;
  await core.ready();
  await core.update({ wait: true });
  const seed = await findLatestCompleteSnapshot(coreAsAdmittedLog(core, keyHex));
  return seed && seed.seedIndex > 0 ? seed.seedIndex : 0;
}

function pipeReplicate(a: Corestore, b: Corestore): { streams: Pipeable[]; teardown: () => void } {
  const sa = a.replicate(true) as unknown as Pipeable;
  const sb = b.replicate(false) as unknown as Pipeable;
  // Swallow post-teardown errors so a destroy() can't reject the run.
  for (const s of [sa, sb]) (s as unknown as { on(ev: string, cb: () => void): void }).on('error', () => {});
  sa.pipe(sb).pipe(sa);
  return { streams: [sa, sb], teardown: () => { for (const s of [sa, sb]) s.destroy(); } };
}

/**
 * The corestore SeedProvider. Register it in a
 * {@link import('@papercusp/seed-bundle').SeedProviderRegistry}.
 */
export function createCorestoreSeedProvider(): SeedProvider {
  return {
    kind: CORESTORE_SEED_KIND,

    async cut(ctx: SeedCutContext): Promise<SeedCutOutput> {
      const { sourceStore, coreKeys, stagingDir, sparse } = ctx as unknown as CorestoreCutContext;
      await mkdir(stagingDir, { recursive: true });
      // P-004 — sparse: resolve each core's suffix start from the FULL source
      // (all blocks local, no replication for the scan) BEFORE downloading. The
      // reader seeds its cursor to the SAME index (findLatestCompleteSnapshot), so
      // `[from, len)` is exactly the span a snapshot-aware joiner folds.
      const coreSparseFrom: Record<string, number> = {};
      if (sparse) {
        for (const keyHex of coreKeys) {
          const from = await computeSparseFrom(sourceStore, keyHex);
          coreSparseFrom[keyHex] = from;
          if (from === 0) {
            console.warn(
              `[seed:corestore] sparse cut: no complete snapshot within the reader scan window ` +
                `for ${keyHex.slice(0, 12)}… → shipping FULL history for this core (append a fresh ` +
                `head snapshot via produceLogSnapshot after the pre-cut drain to trim it).`,
            );
          }
        }
      }
      const replica = new Corestore(stagingDir);
      await replica.ready();
      const { teardown } = pipeReplicate(sourceStore, replica);
      const coreLengths: Record<string, number> = {};
      try {
        for (const keyHex of coreKeys) {
          coreLengths[keyHex] = await downloadCoreRange(replica, keyHex, coreSparseFrom[keyHex] ?? 0);
        }
      } finally {
        teardown();
        await replica.close();
      }
      const hash = await hashDir(stagingDir);
      const sizeBytes = await dirSize(stagingDir);
      const entry: SeedStoreEntry = {
        kind: CORESTORE_SEED_KIND,
        hash,
        sizeBytes,
        source: { type: 'resource', path: stagingDir },
        meta: { coreKeys: [...coreKeys], coreLengths, ...(sparse ? { coreSparseFrom } : {}) },
      };
      return { entry, payload: { path: stagingDir } };
    },

    async verify(entry: SeedStoreEntry, payload: SeedPayload): Promise<VerifyResult> {
      const path = (payload as { path?: string })?.path;
      if (!path || !existsSync(path)) return { ok: false, reason: `payload path missing: ${String(path)}` };
      const hash = await hashDir(path);
      if (hash !== entry.hash) {
        return { ok: false, reason: `hash mismatch (expected ${entry.hash.slice(0, 12)}…, got ${hash.slice(0, 12)}…)` };
      }
      return { ok: true };
    },

    /**
     * Inject the seeded read-only cores into B's OWN fresh store (idempotent —
     * re-downloading already-present blocks is a no-op). Never copies the seed's
     * primary key, so B's own log stays unique.
     */
    async restore(entry: SeedStoreEntry, payload: SeedPayload, ctx: SeedRestoreContext): Promise<void> {
      const { targetStoreDir } = ctx as unknown as CorestoreRestoreContext;
      const seedPath = (payload as { path: string }).path;
      const meta = entry.meta as CorestoreSeedMeta | undefined;
      const coreKeys = meta?.coreKeys ?? [];
      // P-004 — a sparse seed only SERVES `[coreSparseFrom, len)`. Restore MUST
      // range-limit to the SAME start, or `downloadCoreRange`'s `get(i,{wait:true})`
      // for a block in the dropped prefix hangs forever (offline restore → no peer
      // holds it). Absent meta ⇒ 0 ⇒ full read (legacy full-ship seed, unchanged).
      const coreSparseFrom = meta?.coreSparseFrom ?? {};
      await mkdir(targetStoreDir, { recursive: true });
      const target = new Corestore(targetStoreDir);
      // WI-2902: the SEED store MUST open `readOnly` — a bundled seed is a COPIED
      // payload (built into the .deb, dpkg-extracted to a root-owned read-only
      // `/usr/lib/<Product>/seed`), and corestore 7.x's storage layer guards every
      // writable open with a `device-file` (the `CORESTORE` header + a
      // `user.device-file` xattr). A copy loses the xattr and changes the inode, so
      // a default (writable) open throws "Invalid device file, was moved unsafely"
      // BEFORE it even hits the EACCES from the read-only dir — which is exactly why
      // every packaged install logged `restored=[]`. `readOnly:true` skips both the
      // device-file guard and the RocksDB LOCK/LOG writes (hypercore-storage gates
      // them on `!readOnly`), so the seed opens read-only and still serves its blocks
      // over replication. Proven: a moved+read-only seed replicates all 108633 blocks
      // into a fresh target. (Do NOT use `writable:false` — corestore forwards only
      // `readOnly` to Hypercore.defaultStorage, not `writable`.)
      const seedStore = new Corestore(seedPath, { readOnly: true });
      await target.ready();
      await seedStore.ready();
      // Pre-open each core in the seed store so it is served over replication.
      for (const keyHex of coreKeys) {
        const c = seedStore.get({ key: Buffer.from(keyHex, 'hex'), valueEncoding: 'json' }) as unknown as ReadableCore;
        await c.ready();
      }
      const { teardown } = pipeReplicate(seedStore, target);
      try {
        for (const keyHex of coreKeys) {
          await downloadCoreRange(target, keyHex, coreSparseFrom[keyHex] ?? 0);
        }
      } finally {
        teardown();
        await seedStore.close();
        await target.close();
      }
    },
  };
}
