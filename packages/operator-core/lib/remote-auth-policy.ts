/**
 * Native remote-operator exposure policy.
 *
 * Loopback remains the zero-config default (including an SSH local forward).
 * An off-loopback listener is accepted only when the existing remote-admin
 * opt-in is accompanied by an exact HTTPS browser-origin allowlist.  This
 * turns PAPERCUSP_ALLOW_REMOTE_ADMIN from a request-time bypass into one part
 * of a complete, fail-fast listener contract.
 */
import { isLoopbackHost } from './endpoint-route/loopback-guard';

export const REMOTE_ORIGINS_ENV = 'PAPERCUSP_REMOTE_ORIGINS';

export interface RemoteAuthPolicy {
  remote: boolean;
  origins: readonly string[];
}

function canonicalOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Exact, canonical HTTPS origins configured for direct remote browsers. */
export function configuredRemoteOrigins(
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const values = (env[REMOTE_ORIGINS_ENV] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const origins: string[] = [];
  for (const value of values) {
    const origin = canonicalOrigin(value);
    if (!origin) {
      throw new Error(
        `${REMOTE_ORIGINS_ENV} entries must be exact HTTPS origins without paths, credentials, query strings, or fragments (invalid: ${value})`,
      );
    }
    if (!origins.includes(origin)) origins.push(origin);
  }
  return origins;
}

/** Fail before listen when an off-loopback bind lacks a complete auth policy. */
export function assertRemoteAuthReady(
  bindHost: string,
  env: NodeJS.ProcessEnv = process.env,
): RemoteAuthPolicy {
  if (isLoopbackHost(bindHost)) return { remote: false, origins: [] };
  if (env.PAPERCUSP_ALLOW_REMOTE_ADMIN !== '1') {
    throw new Error(
      `Refusing off-loopback bind ${bindHost}: set PAPERCUSP_ALLOW_REMOTE_ADMIN=1 only together with ${REMOTE_ORIGINS_ENV}.`,
    );
  }
  const origins = configuredRemoteOrigins(env);
  if (origins.length === 0) {
    throw new Error(
      `Refusing off-loopback bind ${bindHost}: ${REMOTE_ORIGINS_ENV} must contain at least one exact HTTPS origin.`,
    );
  }
  return { remote: true, origins };
}

/** Whether an Origin is one of the configured direct-remote browser origins. */
export function isConfiguredRemoteOrigin(
  origin: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  try {
    return configuredRemoteOrigins(env).includes(new URL(origin).origin) && new URL(origin).origin === origin;
  } catch {
    return false;
  }
}

/** True for requests arriving through the direct remote surface. */
export function isRemoteRequest(req: Request): boolean {
  try {
    return !isLoopbackHost(new URL(req.url).host);
  } catch {
    return !isLoopbackHost(req.headers.get('host'));
  }
}

/** Remote cookies are always Secure; forwarded HTTPS also opts in explicitly. */
export function requestNeedsSecureCookie(req: Request): boolean {
  const forwardedProto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  if (forwardedProto === 'https') return true;
  try {
    const url = new URL(req.url);
    return url.protocol === 'https:' || !isLoopbackHost(url.host);
  } catch {
    return true;
  }
}
