/**
 * Superuser-mode bearer token validation.
 *
 * Loopback alone can't distinguish a user-shell `omp` invocation from a
 * Papercusp-orchestrator-spawned child agent — both run on the same
 * machine, same user, same loopback. So `?superuser=1` requires an
 * additional `Authorization: Bearer <token>` whose value matches the
 * file at `$PAPERCUSP_HOME/superuser-token`, or
 * `~/.papercusp/superuser-token` when no scoped home is set (mode 0600).
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

function tokenPath(): string {
  return join(process.env.PAPERCUSP_HOME || join(homedir(), '.papercusp'), 'superuser-token');
}

let _cached: { path: string; token: string; mtimeMs: number } | null = null;

function loadToken(): string | null {
  try {
    const path = tokenPath();
    const st = statSync(path);
    if (_cached?.path === path && _cached.mtimeMs === st.mtimeMs) return _cached.token;
    const tok = readFileSync(path, 'utf8').trim();
    if (tok.length < 16) return null; // sanity: refuse short tokens
    _cached = { path, token: tok, mtimeMs: st.mtimeMs };
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

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Extract the hostname from a `Host` header value, dropping the port.
 * Handles bracketed IPv6 (`[::1]:3070` → `[::1]`), bare IPv6 (`::1`, kept
 * whole — it has no port), and the IPv4/hostname `name:port` form. A naive
 * `split(':')[0]` mangles both IPv6 shapes, which is why the `[::1]`/`::1`
 * loopback branches used to be unreachable.
 */
function hostnameOf(rawHost: string): string {
  const host = rawHost.toLowerCase().trim();
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end >= 0 ? host.slice(0, end + 1) : host;
  }
  const colonCount = (host.match(/:/g) ?? []).length;
  return colonCount === 1 ? host.slice(0, host.indexOf(':')) : host;
}

/** Loopback check — refuses superuser unless origin is 127.0.0.1 / ::1 / localhost. */
export function isLoopbackRequest(headers: Headers): boolean {
  const host = hostnameOf(headers.get('host') ?? '');
  if (LOOPBACK_HOSTS.has(host)) {
    return true;
  }
  const fwd = (headers.get('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (fwd.length > 0) {
    return fwd.every((ip) => ip === '127.0.0.1' || ip === '::1' || ip === 'localhost');
  }
  // Fail closed: a request whose Host is non-loopback and that carries no
  // x-forwarded-for is NOT provably loopback. The previous `return true`
  // here contradicted this function's contract ("refuses unless loopback")
  // and would admit a direct connection to a non-loopback interface. The
  // desktop's local superuser path always carries a loopback Host
  // (127.0.0.1/localhost) or rides the separate IPC server, so this does
  // not affect it. (Bearer validation is a second gate either way.)
  return false;
}

export const SUPERUSER_TOKEN_PATH = tokenPath();
