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
}

/** Context for {@link createCorestoreSeedProvider}.restore (first-boot time). */
export interface CorestoreRestoreContext {
  /** The fresh install's hyperbee store dir (`.papercusp/<harness>/hyperbee`). */
  readonly targetStoreDir: string;
}

interface CorestoreSeedMeta {
  readonly coreKeys: string[];
  readonly coreLengths: Record<string, number>;
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

/** Open a core by key in `store` and pull every block into local storage. */
async function downloadFullCore(store: Corestore, keyHex: string): Promise<number> {
  const core = store.get({ key: Buffer.from(keyHex, 'hex'), valueEncoding: 'json' }) as unknown as ReadableCore;
  await core.ready();
  await core.update({ wait: true });
  const len: number = core.length;
  for (let i = 0; i < len; i++) await core.get(i, { wait: true });
  return len;
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
      const { sourceStore, coreKeys, stagingDir } = ctx as unknown as CorestoreCutContext;
      await mkdir(stagingDir, { recursive: true });
      const replica = new Corestore(stagingDir);
      await replica.ready();
      const { teardown } = pipeReplicate(sourceStore, replica);
      const coreLengths: Record<string, number> = {};
      try {
        for (const keyHex of coreKeys) coreLengths[keyHex] = await downloadFullCore(replica, keyHex);
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
        meta: { coreKeys: [...coreKeys], coreLengths },
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
      const coreKeys = (entry.meta as CorestoreSeedMeta | undefined)?.coreKeys ?? [];
      await mkdir(targetStoreDir, { recursive: true });
      const target = new Corestore(targetStoreDir);
      const seedStore = new Corestore(seedPath);
      await target.ready();
      await seedStore.ready();
      // Pre-open each core in the seed store so it is served over replication.
      for (const keyHex of coreKeys) {
        const c = seedStore.get({ key: Buffer.from(keyHex, 'hex'), valueEncoding: 'json' }) as unknown as ReadableCore;
        await c.ready();
      }
      const { teardown } = pipeReplicate(seedStore, target);
      try {
        for (const keyHex of coreKeys) await downloadFullCore(target, keyHex);
      } finally {
        teardown();
        await seedStore.close();
        await target.close();
      }
    },
  };
}
