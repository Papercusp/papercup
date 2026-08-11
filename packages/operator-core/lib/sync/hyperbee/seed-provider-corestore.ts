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
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
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
import { tmpdir } from 'node:os';
import { openNamedLog, type PeerLogOp } from './peer-log';
import { isSnapshotOp, produceFilteredSnapshotIntoLog } from './log-snapshot';
import { CURRENT_SCHEMA_VERSION } from './schema-version';
import {
  findLatestCompleteSnapshotDetailed,
  SNAPSHOT_SCAN_LOOKBACK,
  type AdmittedLog,
  type SnapshotScanOutcome,
} from './read-merge';

export const CORESTORE_SEED_KIND = 'corestore';

/**
 * The seed's table-exclusion policy. DEFINED in `./seed-excluded-tables` (a
 * dependency-free module) and re-exported here, because `boot.ts` — the live operator
 * that appends the head snapshot a no-outage cut actually ships — needs the same list
 * and must not take a runtime dependency on this module to get it. Read that file for
 * the policy and its ⛔ caveats before changing what is excluded.
 */
export { SEED_EXCLUDED_TABLES } from './seed-excluded-tables';
import { SEED_EXCLUDED_TABLES } from './seed-excluded-tables';

/** What {@link mintFilteredSeedContentCore} produced, for the manifest. */
export interface MintedSeedCore {
  /** Public key of the synthetic content core, as it must appear in `meta.coreKeys`. */
  readonly keyHex: string;
  /** Blocks landed in the staging store — `meta.coreLengths[keyHex]`. */
  readonly length: number;
  /** Rows carried by the filtered snapshot (diagnostic). */
  readonly rowCount: number;
}

/**
 * Public seed content must not carry email-shaped identity values from private plan
 * metadata or prose. This is deliberately shape-based: the release cutter cannot know
 * every address a person has used, while a generic email is still private data. Opaque
 * binary / encrypted values are left untouched; valid UTF-8 JSON values are projected too,
 * because the corestore JSON boundary can surface encoded JSON as bytes.
 */
const SEED_EMAIL_PATTERN = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/g;

function redactEncodedJson(value: Uint8Array | ArrayBuffer): unknown {
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return value;
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(text) as unknown;
  } catch {
    return value;
  }

  const redacted = redactSeedValue(decoded);
  // Preserve the original bytes when no sensitive value was found. This keeps opaque
  // and already-sanitized encoded values byte-for-byte unchanged.
  return redacted === decoded ? value : redacted;
}

export function redactSeedValue(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(SEED_EMAIL_PATTERN, '[email]');
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return redactEncodedJson(value);
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const redacted = redactSeedValue(item);
      changed ||= redacted !== item;
      return redacted;
    });
    return changed ? out : value;
  }

  const out: Record<string, unknown> = {};
  let changed = false;
  for (const [key, child] of Object.entries(value)) {
    const redacted = redactSeedValue(child);
    changed ||= redacted !== child;
    out[key] = redacted;
  }
  return changed ? out : value;
}

/**
 * Mint the seed's CONTENT core: one filtered snapshot of the owner's log, in a core
 * the owner never wrote (EI-20108164746219771).
 *
 * ── WHY MINT-THEN-REPLICATE INSTEAD OF WRITING STRAIGHT INTO `stagingDir` ──
 * Writing a core directly into the staging store would make it WRITABLE there, and a
 * writable hypercore's storage contains its SIGNING SECRET — which then ships inside
 * the installer. That is precisely the failure this module's header calls its first
 * correctness property ("NO SECRET-KEY LEAK ... `cut` never copies the source store").
 * A privacy fix that shipped a signing secret would be a worse leak than the one it
 * removes, so the core is minted in a THROWAWAY store and only its BLOCKS are
 * replicated into staging — the same read-only path the owner's admitted logs already
 * take. The staging copy is a replica: blocks, merkle trees and a public key, no secret.
 *
 * The throwaway store also supplies a fresh primary key, so the minted core's
 * name-derived key differs per cut. That is fine and intended: the manifest names the
 * key explicitly and restore addresses cores by public key (property 2 in the header) —
 * nothing derives it, so nothing collides.
 */
export async function mintFilteredSeedContentCore(inp: {
  readonly sourceStore: Corestore;
  /** The owner's own-log key — READ ONLY; this function never writes the source. */
  readonly ownerKeyHex: string;
  /** The seed's staging corestore (already created by the caller). */
  readonly stagingStore: Corestore;
  readonly excludeTables?: readonly string[];
  readonly now?: number;
}): Promise<MintedSeedCore> {
  const sourceCore = inp.sourceStore.get({
    key: Buffer.from(inp.ownerKeyHex, 'hex'),
    valueEncoding: 'json',
  }) as unknown as ReadableCore;
  await sourceCore.ready();
  await sourceCore.update({ wait: true });
  const sourceLog = coreAsAdmittedLog(sourceCore, inp.ownerKeyHex);

  const mintDir = await mkdtemp(join(tmpdir(), 'papercusp-seed-mint-'));
  try {
    const mintStore = new Corestore(mintDir);
    await mintStore.ready();
    try {
      const synthetic = await openNamedLog(mintStore, 'seed-content');
      const produced = await produceFilteredSnapshotIntoLog(sourceLog, synthetic, {
        now: inp.now ?? Date.now(),
        schemaVersion: CURRENT_SCHEMA_VERSION,
        excludeTables: inp.excludeTables ?? SEED_EXCLUDED_TABLES,
        transformValue: redactSeedValue,
      });
      if (!produced.appended) {
        throw new Error(
          `[seed:corestore] refusing to cut: the source log ${inp.ownerKeyHex.slice(0, 12)}… folded ` +
            `to no snapshot at all (length=${sourceLog.length}). A seed with no content core would ` +
            `restore as an empty hive while still looking like a successful cut.`,
        );
      }

      // Blocks only — see the secret-key note above.
      const { teardown } = pipeReplicate(mintStore, inp.stagingStore);
      let length: number;
      try {
        length = await downloadCoreRange(inp.stagingStore, synthetic.keyHex, 0);
      } finally {
        teardown();
      }
      return { keyHex: synthetic.keyHex, length, rowCount: produced.rowCount };
    } finally {
      await mintStore.close().catch(() => {});
    }
  } finally {
    // The throwaway store holds the synthetic core's SECRET. Remove it — never let it
    // outlive the cut, and never let it sit next to the artifacts being packaged.
    await rm(mintDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** WI-37553 — escalating read budgets for the CUTTER's snapshot scan.
 *
 *  read-merge's 5s default is tuned for a reader on a settled core. The cutter reads a
 *  LIVE corestore the operator is actively appending to, and there a single slow get used
 *  to collapse the entire sparse cut into shipping FULL history — measured: a 5.62 GB seed
 *  from a core whose snapshot sat 48 blocks from the tail, which the seed-degradation guard
 *  then (correctly) refused, failing a release cut 52 minutes in. Spend more patience before
 *  concluding the snapshot is not there; the retry is cheap next to a re-cut. */
const CUTTER_SNAPSHOT_SCAN_TIMEOUTS_MS: readonly number[] = [5_000, 20_000, 60_000];

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
  /**
   * Release-only privacy projection. The filtered snapshot is minted into a fresh
   * read-only core so the live source log is never rewritten or made unreachable.
   */
  readonly filtered?: boolean;
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

/**
 * RocksDB's info log (exactly `LOG`, rotated `LOG.old.<ts>`) is DIAGNOSTIC and is
 * rewritten on EVERY store open — it can never be part of the seed's content
 * identity. It is also scrubbed from the shipped seed because it embeds the build
 * box's hostname + absolute paths (WI-4736). Those two facts collide: hashing it
 * meant the cut hashed a LOG that the scrub then deleted, so `verify` re-hashed a
 * different directory and refused the restore — every install silently cold-pathed
 * to an EMPTY hive (EI-12881). Excluded here so the hash is stable whether or not a
 * LOG exists, on both the pack and verify sides. The numbered `<NNN>.log` WALs are
 * DATA and must keep participating.
 */
export const isRocksInfoLog = (rel: string): boolean => {
  const base = rel.split(/[\\/]/).pop() ?? '';
  return base === 'LOG' || base.startsWith('LOG.old');
};

async function walkFiles(root: string, dir: string = root, acc: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) await walkFiles(root, full, acc);
    else if (e.isFile() && !isRocksInfoLog(e.name)) acc.push(relative(root, full));
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

/**
 * Refuse to ship a suffix that still carries an excluded table (EI-20108164746219771).
 *
 * ── WHY FILTERING THE SNAPSHOT IS NOT SUFFICIENT ON ITS OWN ──
 * The head snapshot is filtered (boot.ts / cut-seed-cli.ts), but what SHIPS is
 * `[coreSparseFrom, len)` where `len` is the core length at the cutter's read-only OPEN —
 * which happens strictly AFTER the operator appends that snapshot. The live operator
 * re-announces `presence` on a 30s keep-alive (presence-announce.ts DEFAULT_REFRESH_MS),
 * so a heartbeat landing in that gap appends a RAW op inside the shipped span and the
 * leak returns. The shipped seed measured rawOps=0, but that is a race won, not a race
 * removed: filtering alone makes the fix PROBABILISTIC.
 *
 * So this asserts the property directly, on the blocks that actually landed in staging
 * rather than on the intent that produced them. Reading the replica (not the source) is
 * the point — it is the artifact that ships.
 *
 * THROWS rather than warns. A refused cut is recoverable in minutes; a published
 * installer carrying the build box's identity is not, and the last one took three weeks
 * to notice. The artifact-level identity gate (`audit-release-bundle.py`) remains the
 * backstop; this is the earlier, cheaper failure that names the exact block.
 */
async function assertShippedRangeCarriesNoExcludedTables(inp: {
  readonly store: Corestore;
  readonly keyHex: string;
  readonly from: number;
  readonly len: number;
  readonly excludeTables: readonly string[];
}): Promise<void> {
  const excluded = new Set(inp.excludeTables);
  if (excluded.size === 0) return;
  const core = inp.store.get({
    key: Buffer.from(inp.keyHex, 'hex'),
    valueEncoding: 'json',
  }) as unknown as ReadableCore;
  await core.ready();
  const offenders: string[] = [];
  for (let i = Math.max(0, inp.from); i < inp.len; i++) {
    const op = (await core.get(i, { wait: true })) as PeerLogOp | null;
    if (!op) continue;
    if (isSnapshotOp(op)) {
      // A snapshot block carries the rows themselves — the case that matters, since the
      // shipped suffix is normally ENTIRELY snapshot chunks.
      const payload = op.value as { rows?: Array<{ table?: string; hbKey?: string }> } | undefined;
      for (const r of payload?.rows ?? []) {
        if (r?.table && excluded.has(r.table)) offenders.push(`block ${i} snapshot row ${r.table}`);
      }
      continue;
    }
    if (op.table && excluded.has(op.table)) offenders.push(`block ${i} raw op ${op.table}`);
  }
  if (offenders.length) {
    const shown = offenders.slice(0, 5).join('; ');
    throw new Error(
      `[seed:corestore] REFUSING TO CUT: the shipped suffix [${inp.from}, ${inp.len}) of ` +
        `${inp.keyHex.slice(0, 12)}… still carries ${offenders.length} row(s) from an excluded ` +
        `table (${shown}${offenders.length > 5 ? '; …' : ''}). Excluded: ${[...excluded].join(', ')}. ` +
        'This is the EI-20108164746219771 identity leak. A RAW-op offender means an op was ' +
        'appended between the filtered head snapshot and this cut\'s read-only open (presence ' +
        're-announces every 30s) — re-cut to pick up a fresher snapshot. A SNAPSHOT-ROW offender ' +
        'means the head snapshot was produced WITHOUT the exclusion: check that the operator ' +
        'servicing /api/internal/substrate/head-snapshot is running a build that filters it.',
    );
  }
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
  const log = coreAsAdmittedLog(core, keyHex);
  const short = `${keyHex.slice(0, 12)}…`;
  const budgets = CUTTER_SNAPSHOT_SCAN_TIMEOUTS_MS;

  let last: SnapshotScanOutcome | undefined;
  for (let attempt = 0; attempt < budgets.length; attempt++) {
    const timeoutMs = budgets[attempt]!;
    const r = await findLatestCompleteSnapshotDetailed(log, SNAPSHOT_SCAN_LOOKBACK, timeoutMs);
    last = r;
    if (r.kind === 'found') {
      if (attempt > 0) {
        console.warn(
          `[seed:corestore] snapshot scan for ${short} succeeded on attempt ${attempt + 1} at a ` +
            `${timeoutMs}ms read budget — the earlier miss was SLOWNESS, not a missing snapshot.`,
        );
      }
      return r.seed.seedIndex > 0 ? r.seed.seedIndex : 0;
    }
    // `none-in-window` is a real answer: every block was read and none held a snapshot.
    // More patience cannot change it, so don't burn the remaining budgets.
    if (r.kind === 'none-in-window') break;
    console.warn(
      `[seed:corestore] snapshot scan for ${short} could not READ block ${r.atIndex} (${r.cause}) at a ` +
        `${timeoutMs}ms budget (attempt ${attempt + 1}/${budgets.length})` +
        (attempt + 1 < budgets.length ? ' — retrying with a longer budget.' : '.'),
    );
  }

  // Only now is FULL history the honest answer — and name WHICH cause it is. The old
  // single message always blamed the scan WINDOW, which sent readers off to "append a
  // fresh snapshot" that already existed (WI-37553). The two causes have opposite fixes.
  if (last?.kind === 'unreadable') {
    console.warn(
      `[seed:corestore] sparse cut: could NOT READ the tail of ${short} (${last.cause} at block ` +
        `${last.atIndex}) after ${budgets.length} attempts → shipping FULL history for this core. ` +
        'This is a READ/liveness problem, NOT a missing snapshot — appending another snapshot will ' +
        'not help. Re-cut when the source corestore is quieter.',
    );
  } else {
    console.warn(
      `[seed:corestore] sparse cut: no complete snapshot within the reader scan window ` +
        `for ${short} → shipping FULL history for this core (append a fresh ` +
        `head snapshot via produceLogSnapshot after the pre-cut drain to trim it).`,
    );
  }
  return 0;
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
      const { sourceStore, coreKeys, stagingDir, sparse, filtered } = ctx as unknown as CorestoreCutContext;
      await mkdir(stagingDir, { recursive: true });

      if (filtered) {
        const replica = new Corestore(stagingDir);
        await replica.ready();
        const filteredCoreKeys: string[] = [];
        const coreLengths: Record<string, number> = {};
        try {
          for (const ownerKeyHex of coreKeys) {
            const minted = await mintFilteredSeedContentCore({
              sourceStore,
              ownerKeyHex,
              stagingStore: replica,
            });
            filteredCoreKeys.push(minted.keyHex);
            coreLengths[minted.keyHex] = minted.length;
            await assertShippedRangeCarriesNoExcludedTables({
              store: replica,
              keyHex: minted.keyHex,
              from: 0,
              len: minted.length,
              excludeTables: SEED_EXCLUDED_TABLES,
            });
          }
        } finally {
          await replica.close();
        }

        const hash = await hashDir(stagingDir);
        const sizeBytes = await dirSize(stagingDir);
        const entry: SeedStoreEntry = {
          kind: CORESTORE_SEED_KIND,
          hash,
          sizeBytes,
          source: { type: 'resource', path: stagingDir },
          // This is a complete current-state projection, not a source-log suffix. Do not
          // label it sparse: a start index of 0 is honest here and must not trip the
          // history-degradation guard as though a private prefix had been dropped.
          meta: { coreKeys: filteredCoreKeys, coreLengths },
        };
        return { entry, payload: { path: stagingDir } };
      }

      // P-004 — sparse: resolve each core's suffix start from the FULL source
      // (all blocks local, no replication for the scan) BEFORE downloading. The
      // reader seeds its cursor to the SAME index (findLatestCompleteSnapshot), so
      // `[from, len)` is exactly the span a snapshot-aware joiner folds.
      const coreSparseFrom: Record<string, number> = {};
      if (sparse) {
        for (const keyHex of coreKeys) {
          // computeSparseFrom does its own reporting now — it is the only place that can
          // tell an UNREADABLE tail from a genuinely absent snapshot (WI-37553), and those
          // two have opposite remedies.
          const from = await computeSparseFrom(sourceStore, keyHex);
          coreSparseFrom[keyHex] = from;
        }
      }
      const replica = new Corestore(stagingDir);
      await replica.ready();
      const { teardown } = pipeReplicate(sourceStore, replica);
      const coreLengths: Record<string, number> = {};
      try {
        for (const keyHex of coreKeys) {
          const from = coreSparseFrom[keyHex] ?? 0;
          const len = await downloadCoreRange(replica, keyHex, from);
          coreLengths[keyHex] = len;
          // EI-20108164746219771 — verify the bytes that actually landed, before they are
          // hashed into a seed entry. Filtering the head snapshot is necessary but not
          // sufficient (see this function's note: a presence keep-alive can land a raw op
          // inside the shipped span after the snapshot was taken).
          await assertShippedRangeCarriesNoExcludedTables({
            store: replica,
            keyHex,
            from,
            len,
            excludeTables: SEED_EXCLUDED_TABLES,
          });
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
