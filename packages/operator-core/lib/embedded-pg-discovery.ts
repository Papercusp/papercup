/**
 * Resolve the harness-admin Postgres URL the operator should connect to.
 *
 * Resolution order (delegated to @papercusp/embedded-pg-discovery):
 *   1. Explicit env (HARNESS_ADMIN_DATABASE_URL > DATABASE_URL > PAPERCUSP_PG_URL)
 *      — operator inside the desktop sidecar always hits this path because
 *      Tauri main injects HARNESS_ADMIN_DATABASE_URL with the embedded port.
 *   2. Discovery file at ~/.papercusp/embedded-pg.json — written by the
 *      desktop's Rust main when embedded-pg comes up. Lets a `npm run dev`
 *      operator share state with a running desktop.
 *   3. Fallback: native PG on :5432 with the standard harness_admin creds.
 *      Preserves zero-config dev for users who don't run the desktop.
 *
 * This module is the Papercusp-specific *configuration* of the generic
 * @papercusp/embedded-pg-discovery resolver (P-003 of
 * papercusp-systems-abstraction-2026-05-29) plus the in-process cache.
 */
import { resolvePgUrl } from '@papercusp/embedded-pg-discovery';

const NATIVE_FALLBACK = 'postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp';

let cached: { url: string; source: string } | null = null;

export function getHarnessAdminUrl(): string {
  return getHarnessAdminUrlWithSource().url;
}

export function getHarnessAdminUrlWithSource(): { url: string; source: string } {
  // The FALLBACK is never pinned: a module-scope caller (e.g. sync-sse's
  // invalidation bus) can resolve at IMPORT time — before serve.ts boots
  // embedded PG and injects HARNESS_ADMIN_DATABASE_URL — and a cached fallback
  // would then wedge every later consumer onto dead :5432 for the process
  // lifetime (live-found on the WI-1544 rig: append-heavy-invalidator
  // ECONNREFUSED 127.0.0.1:5432 every tick while embedded PG served :39532).
  // Re-resolving until a real source appears self-heals post-injection calls;
  // on a genuine native-:5432 dev box the re-resolve returns the same fallback.
  if (cached && cached.source !== 'native-fallback') return cached;

  const { url, source } = resolvePgUrl({
    envVars: ['HARNESS_ADMIN_DATABASE_URL', 'DATABASE_URL', 'PAPERCUSP_PG_URL'],
    discoveryFile: { path: '.papercusp/embedded-pg.json' },
    fallbackUrl: NATIVE_FALLBACK,
  });

  // Preserve the historical source label for the native fallback so any
  // diagnostics/log assertions keyed on 'native-fallback' keep working.
  cached = { url, source: source === 'fallback' ? 'native-fallback' : source };
  return cached;
}

/** Test-only — clears the in-process cache between tests. */
export function _resetHarnessAdminUrlCacheForTests(): void {
  cached = null;
}
