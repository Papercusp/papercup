#!/usr/bin/env node
/**
 * Shared embedding sidecar — DEV entrypoint (P-002, plan
 * shared-embedding-sidecar-and-enrichment-2026-07-10).
 *
 * Thin shim. The HTTP server (/embed + /healthz, D-004) lives in operator-core
 * (`memory/embed-sidecar-server.ts` → runEmbedSidecarServer), which wraps the
 * REAL @papercusp/memory embedder builders inside the sidecar process. This
 * file exists so a dev tree can run the sidecar directly via
 * `tsx apps/operator/bin/embed-sidecar.ts`.
 *
 * The PACKAGED operator ships only the bundled `serve.mjs` (no separate bin to
 * `npx tsx`), so there the spawner re-execs serve.mjs with
 * PAPERCUSP_EMBED_SIDECAR_MODE=1 and serve.ts calls the SAME
 * runEmbedSidecarServer() (see embed-sidecar-spawn.ts + serve.ts). The server
 * logic deliberately does NOT live here — esbuild bundles every module into
 * serve.mjs, so an auto-running guard in a bundled bin would resolve
 * `import.meta.url === argv[1]` TRUE on every boot and start a stray sidecar.
 *
 * Reached ONLY on hosts that opt in via PAPERCUSP_EMBED_SIDECAR=1 (or a direct
 * dev run).
 *
 * Environment:
 *   PAPERCUSP_EMBED_SIDECAR_PORT — loopback port (default 3384).
 */

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runEmbedSidecarServer } from '@papercusp/operator-core/lib/memory/embed-sidecar-server';

// Auto-run only when invoked directly (dev: tsx apps/operator/bin/embed-sidecar.ts).
// The packaged path calls runEmbedSidecarServer() from serve.ts instead.
// Symlink-robust (WI-1443): also compare argv[1]'s realpath (papercup -> papercusp).
const invokedDirectly = ((): boolean => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  if (import.meta.url === pathToFileURL(argv1).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
})();
if (invokedDirectly) runEmbedSidecarServer();
