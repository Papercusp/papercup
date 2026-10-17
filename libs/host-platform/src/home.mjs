import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolve the host-level Papercusp home. Workspace-aware state must use the
 * operator-core papercuspRoot() seam; this helper only answers the host-home
 * question and preserves the PAPERCUSP_HOME isolation pin for scripts and
 * other host-bound code that cannot depend on operator-core.
 */
export function papercuspHome(env = process.env, fallbackHome = homedir()) {
  const scoped = typeof env?.PAPERCUSP_HOME === 'string'
    ? env.PAPERCUSP_HOME.trim()
    : '';
  return scoped || join(fallbackHome, '.papercusp');
}

/** Resolve a path below the host-level Papercusp home. */
export function papercuspPath(...parts) {
  return join(papercuspHome(), ...parts);
}
