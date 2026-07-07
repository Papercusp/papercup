/**
 * self-describing-store — the shared READ core of the local content stores
 * (template-store.ts, rubric-store.ts). Extracted per su-bbf8a's Q2 consult answer
 * on local-first-party-rubric-bundling-2026-07-07: the read half (env → dev-fallback
 * resolution, layered bundled/user roots, self-describing-dir enumeration with
 * user-shadows-bundled dedupe) is domain-free and was the fiddly part — share it;
 * the WRITE halves (templates: overlay into an app dir; rubrics: seed into plan
 * rows) are deliberately NOT generalized.
 *
 * Kind-parameterized by a small config + an injected per-dir reader: a store is
 * `{ envVar, devFallbackDir, userSubdir }` plus a `readDir(dir, ref, layer)` that
 * parses one self-describing subdir (listing.json + the kind's manifest) into the
 * kind's own type — or null to skip a non-store dir. Extraction is ADDITIVE: both
 * stores keep their public APIs byte-compatible. (Candidate for a later lift to a
 * generic lib if a third kind appears.)
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { papercuspPath } from '../papercusp-root';

/** One resolved store root. Later roots shadow earlier ones on a ref collision. */
export interface SelfDescribingRoot {
  dir: string;
  layer: 'bundled' | 'user';
}

export interface SelfDescribingRootsConfig {
  /** Env var naming the bundled (read-only) dir in a packaged install. */
  envVar: string;
  /** In-repo fallback for the bundled layer when the env var is unset (dev). */
  devFallbackDir: string;
  /** <papercuspRoot> subdir of the writable user layer (the v2 install target). */
  userSubdir: string;
}

/** The bundled (read-only) dir: env override → in-repo dev fallback. */
export function bundledDirFromEnv(envVar: string, devFallbackDir: string): string {
  const fromEnv = process.env[envVar];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return devFallbackDir;
}

/**
 * The layered roots, in RESOLUTION order — later layers shadow earlier ones on a
 * ref collision, so the writable user layer wins over the bundled first-party set.
 */
export function selfDescribingRoots(cfg: SelfDescribingRootsConfig): SelfDescribingRoot[] {
  return [
    { dir: bundledDirFromEnv(cfg.envVar, cfg.devFallbackDir), layer: 'bundled' },
    { dir: papercuspPath(cfg.userSubdir), layer: 'user' },
  ];
}

/**
 * Enumerate every self-describing subdir across the layered roots. A user-layer
 * ref shadows a bundled one. Non-dir entries (README.md) and dirs the reader
 * rejects (no manifest) are skipped. Sorted by ref for stable output.
 */
export function enumerateSelfDescribingDirs<T>(
  roots: SelfDescribingRoot[],
  readDir: (dir: string, ref: string, layer: 'bundled' | 'user') => T | null,
): T[] {
  const byRef = new Map<string, T>();
  for (const root of roots) {
    if (!existsSync(root.dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(root.dir);
    } catch {
      continue;
    }
    for (const ref of entries) {
      const dir = join(root.dir, ref);
      let isDir = false;
      try {
        isDir = statSync(dir).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) continue;
      const entry = readDir(dir, ref, root.layer);
      if (entry) byRef.set(ref, entry); // later root (user) overwrites earlier (bundled)
    }
  }
  return [...byRef.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
}
