/**
 * Resolve the harness-admin Postgres URL the operator should connect to.
 *
 * Resolution order:
 *   1. Explicit env (HARNESS_ADMIN_DATABASE_URL > DATABASE_URL > PAPERCUSP_PG_URL)
 *      — operator inside the desktop sidecar always hits this path because
 *      Tauri main injects HARNESS_ADMIN_DATABASE_URL with the embedded port.
 *   2. Discovery file at ~/.papercusp/embedded-pg.json — written by the
 *      desktop's Rust main when embedded-pg comes up. Lets a `npm run dev`
 *      operator share state with a running desktop.
 *   3. Fallback: native PG on :5432 with the standard harness_admin creds.
 *      Same string as before; preserves zero-config dev for users who
 *      don't run the desktop.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const NATIVE_FALLBACK = 'postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp';

let cached: { url: string; source: string } | null = null;

export function getHarnessAdminUrl(): string {
  return getHarnessAdminUrlWithSource().url;
}

export function getHarnessAdminUrlWithSource(): { url: string; source: string } {
  if (cached) return cached;

  const fromEnv =
    process.env.HARNESS_ADMIN_DATABASE_URL ??
    process.env.DATABASE_URL ??
    process.env.PAPERCUSP_PG_URL;
  if (fromEnv) {
    cached = { url: fromEnv, source: 'env' };
    return cached;
  }

  const discoveryPath = path.join(os.homedir(), '.papercusp', 'embedded-pg.json');
  try {
    const raw = fs.readFileSync(discoveryPath, 'utf8');
    const parsed = JSON.parse(raw) as { url?: string; port?: number };
    if (parsed?.url) {
      cached = { url: parsed.url, source: 'discovery-file' };
      return cached;
    }
  } catch {
    // file missing or unparseable — fall through
  }

  cached = { url: NATIVE_FALLBACK, source: 'native-fallback' };
  return cached;
}

/** Test-only — clears the in-process cache between tests. */
export function _resetHarnessAdminUrlCacheForTests(): void {
  cached = null;
}
