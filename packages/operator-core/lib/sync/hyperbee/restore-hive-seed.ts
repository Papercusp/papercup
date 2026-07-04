/**
 * restore-hive-seed — the "restore-before-join" orchestration (plan
 * hive-seed-bundle-2026-07-04 P-007; design memo agent-insights/hive-seed-bundle-design).
 *
 * Runs at first boot BEFORE the (UNMODIFIED) canonical-hive join. It pre-positions
 * the seeded bytes so the join's clone + swarm delta-replication transfer only the
 * delta on top — never re-transferring the whole ~5 GB repo + full author-log
 * history. The join, admission, epoch-key delivery, and merge all run afterward,
 * exactly as today; a seed is UNTRUSTED CACHE (every block is re-verified natively).
 *
 * THE ADMISSION-TIMING SPLIT (the load-bearing subtlety):
 *
 *  • The CORESTORE seed is a plaintext CONTAINER (its blocks are epoch-CIPHERTEXT,
 *    decrypted later when admission delivers the epoch key — same as any replicated
 *    block). It needs NO key to RESTORE, so it restores PRE-JOIN unconditionally.
 *
 *  • The GIT seed of the PRIVATE repo is ENCRYPTED AT REST, and its key
 *    (`seed-key-op`) is delivered only POST-ADMISSION. So `git clone` from the
 *    bundle CANNOT run before the join hands over the key. When no key is present
 *    we DEFER that store (the host cold-paths it / re-invokes restore with the key
 *    after admission); when the key IS present (a later invocation, or an
 *    unencrypted seed) it restores too.
 *
 * Failure-isolating + cold-safe: a missing seed ⇒ `ran:false` (pure cold path); any
 * one store's failure never aborts the others (that store just cold-catches). This
 * is what keeps the dogfood's real join exercised end-to-end (D-007).
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  decodeManifest,
  restoreSeed,
  SeedProviderRegistry,
  type SeedManifest,
  type SeedStoreEntry,
  type SeedPayload,
  type StoreRestoreOutcome,
} from '@papercusp/seed-bundle';
import { createGitSeedProvider } from './seed-provider-git';
import { createCorestoreSeedProvider } from './seed-provider-corestore';

export const SEED_MANIFEST_FILE = 'manifest.json';

export interface RestoreHiveSeedCtx {
  /** The installed seed resource dir (holds manifest.json + per-store subdirs).
   *  Absent/empty ⇒ no seed shipped ⇒ pure cold path. */
  readonly seedDir: string;
  /** Where the git seed's checkout is restored (the repo working dir). */
  readonly targetRepoDir: string;
  /** The fresh install's corestore dir (`.papercusp/<hive>/hyperbee`). */
  readonly targetStoreDir: string;
  /** The git-seed decryption key — present ONLY post-admission. When absent, an
   *  encrypted git store is DEFERRED (not restored) rather than failing. */
  readonly decryptionKey?: Uint8Array;
  /** Override the origin the restored clone re-points at (else the seed's own). */
  readonly originUrl?: string;
  /** The `--no-seed` escape hatch: force-skip restore entirely and take the pure
   *  cold path (ran:false), even when a valid seed is present. The bootstrap default
   *  wires this from the PAPERCUSP_NO_SEED env — the operator's kill-switch if a
   *  shipped seed ever misbehaves, and how the cold-join canary forces a real join. */
  readonly disabled?: boolean;
  /** Seams (tests inject; defaults are the real filesystem + providers). */
  readonly readManifest?: (seedDir: string) => Promise<SeedManifest | null>;
  readonly registry?: SeedProviderRegistry;
  readonly log?: (msg: string) => void;
}

export interface RestoreHiveSeedResult {
  /** False ⇒ no seed present (cold path); true ⇒ a manifest was found + processed. */
  readonly ran: boolean;
  /** Per-store restore verdicts (empty when `ran:false`). */
  readonly outcomes: readonly StoreRestoreOutcome[];
  /** Store kinds intentionally NOT restored this pass (e.g. an encrypted git store
   *  awaiting its post-admission key) — the host restores them later / cold-paths them. */
  readonly deferred: readonly string[];
}

/** Default manifest reader — returns null (⇒ cold path) when no seed is shipped. */
async function defaultReadManifest(seedDir: string): Promise<SeedManifest | null> {
  const p = join(seedDir, SEED_MANIFEST_FILE);
  if (!seedDir || !existsSync(p)) return null;
  try {
    return decodeManifest(await readFile(p, 'utf8'));
  } catch {
    return null; // a corrupt/invalid manifest ⇒ cold path, never a boot failure
  }
}

/** The default provider registry: the git + corestore substrate adapters. */
export function defaultSeedRegistry(): SeedProviderRegistry {
  return new SeedProviderRegistry().register(createGitSeedProvider()).register(createCorestoreSeedProvider());
}

/** A store must be DEFERRED when it is encrypted at rest and we have no key yet. */
function isDeferred(entry: SeedStoreEntry, hasKey: boolean): boolean {
  return Boolean(entry.encryption) && !hasKey;
}

/**
 * Restore whatever the seed can pre-position right now, honoring the
 * admission-timing split. Returns per-store outcomes + the deferred set. NEVER
 * throws — a missing/corrupt seed or a per-store failure degrades to the cold path.
 */
export async function restoreHiveSeed(ctx: RestoreHiveSeedCtx): Promise<RestoreHiveSeedResult> {
  const log = ctx.log ?? (() => {});
  const readManifest = ctx.readManifest ?? defaultReadManifest;

  if (ctx.disabled) {
    log('[seed] restore disabled (--no-seed) — forcing the cold join path');
    return { ran: false, outcomes: [], deferred: [] };
  }

  const manifest = await readManifest(ctx.seedDir).catch(() => null);
  if (!manifest) {
    log('[seed] no seed present — cold path (full join)');
    return { ran: false, outcomes: [], deferred: [] };
  }

  const hasKey = Boolean(ctx.decryptionKey);
  const restoreNow: SeedStoreEntry[] = [];
  const deferred: string[] = [];
  for (const entry of manifest.stores) {
    if (isDeferred(entry, hasKey)) {
      deferred.push(entry.kind);
      log(`[seed] deferring ${entry.kind} store — encrypted, key not yet available (post-admission)`);
    } else {
      restoreNow.push(entry);
    }
  }

  if (restoreNow.length === 0) {
    log('[seed] nothing to restore pre-key; all stores deferred to post-admission / cold path');
    return { ran: true, outcomes: [], deferred };
  }

  const registry = ctx.registry ?? defaultSeedRegistry();
  // Resolve each entry's RELATIVE source.path (git|corestore) against the seed dir.
  const resolvePayload = async (entry: SeedStoreEntry): Promise<SeedPayload> => {
    const src = entry.source;
    const rel = src.type === 'resource' ? src.path : entry.kind;
    return { path: join(ctx.seedDir, rel) };
  };

  const subManifest: SeedManifest = { ...manifest, stores: restoreNow };
  const restoreCtx = {
    targetRepoDir: ctx.targetRepoDir,
    targetStoreDir: ctx.targetStoreDir,
    ...(ctx.decryptionKey ? { decryptionKey: ctx.decryptionKey } : {}),
    ...(ctx.originUrl ? { originUrl: ctx.originUrl } : {}),
  };
  const result = await restoreSeed(subManifest, registry, resolvePayload, restoreCtx);
  for (const o of result.outcomes) {
    log(o.ok ? `[seed] restored ${o.kind}` : `[seed] ${o.kind} restore failed (cold-pathing): ${o.reason ?? 'unknown'}`);
  }
  return { ran: true, outcomes: result.outcomes, deferred };
}
