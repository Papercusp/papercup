/**
 * Superuser-mode bearer token validation.
 *
 * Loopback alone can't distinguish a user-shell `omp` invocation from a
 * Papercusp-orchestrator-spawned child agent — both run on the same
 * machine, same user, same loopback. So `?superuser=1` requires an
 * additional `Authorization: Bearer <token>` whose value matches the
 * file at `~/.papercusp/superuser-token` (mode 0600).
 *
 * The CLI installer (`apps/operator/scripts/install-standalone-mcp.sh`)
 * generates the token and writes it to the file; orchestrator-spawned
 * agents never receive the token in their MCP URLs.
 *
 * This is friction, not enforcement: any process running as the same
 * user can read the token file. See plan §"Honest enforcement" — if you
 * want true isolation, run shell-omp under a different OS user.
 */

import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';

const TOKEN_PATH = join(homedir(), '.papercusp', 'superuser-token');

let _cached: { token: string; mtimeMs: number } | null = null;

function loadToken(): string | null {
  try {
    const st = statSync(TOKEN_PATH);
    if (_cached && _cached.mtimeMs === st.mtimeMs) return _cached.token;
    const tok = readFileSync(TOKEN_PATH, 'utf8').trim();
    if (tok.length < 16) return null; // sanity: refuse short tokens
    _cached = { token: tok, mtimeMs: st.mtimeMs };
    return tok;
  } catch {
    _cached = null;
    return null;
  }
}

/**
 * Read the on-disk superuser bearer token, or null if not yet installed.
 * The single shared reader — `console-launcher` and `buildLaunchSpec`'s
 * `su` branch both use this so the "where's the token" logic (path,
 * mtime cache, short-token sanity) lives in exactly one place.
 */
export function readSuperuserToken(): string | null {
  return loadToken();
}

/** Returns true if the bearer matches the on-disk superuser token. */
export function isValidSuperuserBearer(bearer: string | null | undefined): boolean {
  if (!bearer) return false;
  const expected = loadToken();
  if (!expected) return false;
  const a = Buffer.from(bearer);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Loopback check — refuses superuser unless origin is 127.0.0.1 / ::1 / localhost. */
export function isLoopbackRequest(headers: Headers): boolean {
  const host = (headers.get('host') ?? '').toLowerCase().split(':')[0];
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1') {
    return true;
  }
  const fwd = (headers.get('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (fwd.length > 0) {
    return fwd.every((ip) => ip === '127.0.0.1' || ip === '::1' || ip === 'localhost');
  }
  return true;
}

export const SUPERUSER_TOKEN_PATH = TOKEN_PATH;
