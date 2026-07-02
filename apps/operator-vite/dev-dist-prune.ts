/**
 * Dev-watch dist chunk retention + prune (Option-1 build-churn cure;
 * plan `adv-build-churn-retain-chunks-2026-06-03`).
 *
 * Why this exists
 * ---------------
 * `dev:nohmr` runs `vite build --watch`, and on this shared box every fleet
 * edit triggers a rebuild. With Vite's default `emptyOutDir`, each rebuild
 * DELETES the prior hashed chunks (verified: an incremental rebuild removes the
 * old `lazy-<hash>.js`). A long-open Tauri webview still holds the old build's
 * lazy-import URLs (vditor, code-split routes); when it fetches one,
 * `host-spa.ts` 404s and the pane goes blank.
 *
 * The cure (in `vite.config.ts`) is `emptyOutDir:false` for watch builds, which
 * RETAINS old chunks so the running page keeps resolving the build it loaded.
 * The only cost is that `dist/assets/` then grows without bound — that's what
 * this plugin handles: after each rebuild it deletes asset files that have been
 * sitting untouched longer than a TTL (default 60 min). Files written by the
 * current build have fresh mtimes, so they are never pruned; the TTL is the
 * grace window for an idle webview that hasn't yet loaded one of its chunks
 * (the existing `ChunkReloadPrompt` recovery covers the rare beyond-TTL miss).
 *
 * The age policy is a pure function (`selectStaleChunks`) so it is unit-tested
 * in isolation; the plugin is the thin disk glue around it (verified live).
 */
import type { Plugin } from 'vite';
import { readdir, stat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** A file in `dist/assets/` reduced to what the age policy needs. */
export interface DistFile {
  /** name relative to the assets dir (e.g. `vditor-CfHiDFoY.js`) */
  name: string;
  /** last-modified time in epoch ms */
  mtimeMs: number;
}

const DEFAULT_TTL_MIN = 60;

/**
 * Names of files last modified strictly MORE than `ttlMs` ago — safe to delete.
 * Pure: no disk access, no clock read. A file exactly on the boundary is kept
 * (conservative — we never over-prune a chunk a live page might still need).
 */
export function selectStaleChunks(files: DistFile[], nowMs: number, ttlMs: number): string[] {
  return files.filter((f) => nowMs - f.mtimeMs > ttlMs).map((f) => f.name);
}

/**
 * Resolve the prune TTL (ms) from the environment. `PAPERCUSP_DIST_CHUNK_TTL_MIN`
 * overrides the 60-minute default; a non-numeric or non-positive value falls
 * back to the default rather than disabling/over-aggressive pruning.
 */
export function resolveTtlMs(env: Record<string, string | undefined>): number {
  const raw = env.PAPERCUSP_DIST_CHUNK_TTL_MIN;
  const n = raw === undefined ? NaN : Number(raw);
  const minutes = Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_MIN;
  return minutes * 60_000;
}

/**
 * Should this build RETAIN old hashed chunks (emptyOutDir:false + age-prune)
 * instead of emptying `dist/`? True for a `vite build --watch`, AND for a
 * ONE-SHOT build that opts in via `PAPERCUSP_RETAIN_DIST_CHUNKS=1`.
 *
 * Why the opt-in (WI-1484): the desktop dev bundle (:3270) is refreshed by a
 * one-shot `npm run build` on a ~2-min timer, NOT by a `--watch` singleton — so
 * the original `--watch`-only gate never fired for it, and each tick emptied
 * `dist/` and 404'd the lazy chunks an open webview was pinned to. The timer
 * sets this env so its rebuilds retain+prune like a watch build. A release/CI
 * build sets neither → stays clean-empty (and keeps the dist-wipe guard).
 * Pure; exported for tests + reuse by vite.config.
 */
export function shouldRetainDistChunks(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): boolean {
  return argv.includes('--watch') || env.PAPERCUSP_RETAIN_DIST_CHUNKS === '1';
}

/**
 * Vite plugin: after each watch rebuild, prune stale chunks from `dist/assets/`.
 * Active only when building in watch mode — a no-op for one-shot/production
 * builds (which empty the dir anyway). Register it from `vite.config.ts` only
 * for the watch build.
 */
export function devDistPrunePlugin(opts: { ttlMs?: number } = {}): Plugin {
  let assetsDir = '';
  let active = false;
  return {
    name: 'papercusp-dev-dist-prune',
    apply: 'build',
    configResolved(config) {
      // Prune whenever we're in a retain regime — a real `--watch`, OR a
      // one-shot build that opted into retention (PAPERCUSP_RETAIN_DIST_CHUNKS);
      // without this the env-gated one-shot retain path would keep old chunks
      // forever (emptyOutDir:false) with nothing to bound the growth.
      active = Boolean(config.build.watch) || shouldRetainDistChunks(process.argv, process.env);
      assetsDir = resolve(config.root, config.build.outDir, config.build.assetsDir || 'assets');
    },
    async writeBundle() {
      if (!active) return;
      const ttlMs = opts.ttlMs ?? resolveTtlMs(process.env);
      const now = Date.now();
      let entries: string[];
      try {
        entries = await readdir(assetsDir);
      } catch {
        return; // assets dir not present yet (first build) — nothing to prune
      }
      const files: DistFile[] = [];
      for (const name of entries) {
        try {
          const s = await stat(join(assetsDir, name));
          if (s.isFile()) files.push({ name, mtimeMs: s.mtimeMs });
        } catch {
          // file vanished between readdir and stat (concurrent rebuild) — skip
        }
      }
      for (const name of selectStaleChunks(files, now, ttlMs)) {
        try {
          await unlink(join(assetsDir, name));
        } catch {
          // already gone / locked — best effort
        }
      }
    },
  };
}
