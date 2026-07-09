/**
 * seed-log-admission — WI-3288 (the offline "full pot"): resolve the SEED's author-log
 * core keys so boot can ADMIT them into the read-merge WITHOUT a swarm.
 *
 * Why this exists: boot.ts's admitted-set gains logs in exactly two ways — the own log
 * (structural) and swarm announce frames (runtime). A packaged install that cannot join
 * the swarm (fresh offline box, `gh` unauthenticated → `swarm_join_failed` forever)
 * therefore merges NOTHING: the WI-3232 seed restore faithfully replicates the hive's
 * cores into the local store, but no admission ever names them, so the read-merge reads
 * only the own (empty) log and every projection stays empty — the owner-reported
 * "pot visible but empty" Windows VM state.
 *
 * Trust anchor: the installer-shipped seed manifest. The seed already ships the hive
 * EPOCH KEY readable (bundled-epoch-key-provider.ts, owner-authorised for alpha), so the
 * content-trust decision for everything the manifest names was made at cut time; the
 * hash-verified manifest's `coreKeys` list is the same authority. Admission is gated on
 * `manifest.potId === <this boot's hive home>` so a seed never leaks logs into an
 * unrelated hive/harness boot.
 *
 * Member-content note (why admission alone suffices for the dogfood pot): the WI-259
 * member-content guard's own-slug fast path (`rowHarnessSlug === opts.harnessSlug` →
 * 'apply', member-content-guard.ts:73) means hive-home content applies with NO
 * source-log identity; only CROSS-member-slug ops would need `admittedIdentities`
 * entries, which announce frames supply online. A seed-admitted log without an
 * identity entry degrades exactly to the online no-announce behavior (defer/drop of
 * cross-member ops), never worse.
 *
 * Fail-soft by contract: any missing/unreadable/mismatched manifest resolves to []
 * (a boot must never fail because a seed is absent — that IS the common cold path).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeManifest } from '@papercusp/seed-bundle';
import { resolveSeedDir, SEED_MANIFEST_FILE } from './restore-hive-seed';

/** 32-byte hypercore key as hex — the shape of manifest `meta.coreKeys` entries. */
const CORE_KEY_HEX = /^[0-9a-f]{64}$/i;

export interface ResolveSeedLogKeysOpts {
  /** The hive home this boot is peered on; admission requires manifest.potId to match. */
  readonly hiveHomeSlug: string;
  /** Injected for tests; defaults to the real filesystem read. */
  readonly readFileImpl?: (path: string) => Promise<string>;
  /** Injected for tests; defaults to the real env-based seed-dir resolution. */
  readonly resolveSeedDirImpl?: () => { seedDir: string | null; disabled: boolean };
}

/**
 * The seed's author-log core keys (lowercased hex), or [] when there is no applicable
 * seed: no seed dir, seed disabled, unreadable/invalid manifest, hive mismatch, or a
 * manifest without a corestore entry. Malformed key entries are dropped individually
 * (a partial list still merges the well-formed logs).
 */
export async function resolveSeedLogKeys(opts: ResolveSeedLogKeysOpts): Promise<string[]> {
  try {
    const resolved = (opts.resolveSeedDirImpl ?? resolveSeedDir)();
    if (resolved.disabled || !resolved.seedDir) return [];
    const readFileImpl = opts.readFileImpl ?? ((p: string) => readFile(p, 'utf8'));
    const raw = await readFileImpl(join(resolved.seedDir, SEED_MANIFEST_FILE));
    const manifest = decodeManifest(raw); // throws on structural invalidity → catch → []
    if (manifest.potId !== opts.hiveHomeSlug) return [];
    const entry = manifest.stores.find((s) => s.kind === 'corestore');
    const keys = (entry?.meta as { coreKeys?: unknown } | undefined)?.coreKeys;
    if (!Array.isArray(keys)) return [];
    return keys
      .filter((k): k is string => typeof k === 'string' && CORE_KEY_HEX.test(k))
      .map((k) => k.toLowerCase());
  } catch {
    return []; // no seed / bad seed ⇒ the cold path, never a boot failure
  }
}
