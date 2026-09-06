/**
 * Deterministic lock keys for authorized files outside a repository.
 *
 * The lock store intentionally accepts only relative POSIX keys. Home-directory
 * configuration and the current user's XDG runtime directory are still shared
 * mutable state, though, and previously bypassed coordination entirely. Map
 * absolute paths under either root to reserved logical keys; the Claude/Codex
 * hook implements this exact mapping.
 */
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const EXTERNAL_HOME_LOCK_PREFIX = '@external/home';
export const EXTERNAL_RUNTIME_LOCK_PREFIX = '@external/runtime';
export const EXTERNAL_LOCK_PREFIXES = [
  EXTERNAL_HOME_LOCK_PREFIX,
  EXTERNAL_RUNTIME_LOCK_PREFIX,
] as const;

export interface ExternalPathRoots {
  home?: string;
  /** `null` disables runtime mapping for compatibility helpers/tests. */
  runtimeDir?: string | null;
}

function defaultRuntimeDir(): string | undefined {
  const configured = process.env.XDG_RUNTIME_DIR?.trim();
  if (configured) return configured;
  if (process.platform !== 'linux') return undefined;
  const uid = process.getuid?.();
  return uid === undefined ? undefined : `/run/user/${uid}`;
}

function relativeFile(root: string | undefined, absolute: string): string | undefined {
  if (!root || !isAbsolute(root)) return undefined;
  const rel = relative(resolve(root), absolute);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return undefined;
  }
  return rel;
}

/**
 * Map an absolute path below the current user's XDG runtime directory or home
 * directory to the lock namespace shared with the client edit hooks.
 *
 * The runtime root is checked first so a test/runtime directory nested below
 * HOME still gets the more precise `@external/runtime/*` namespace.
 */
export function externalPathToLockKey(
  input: string,
  roots: ExternalPathRoots = {},
): string {
  if (!isAbsolute(input)) {
    throw new Error(`external path must be absolute (received ${JSON.stringify(input)})`);
  }
  if (input.includes('\u0000')) throw new Error('external path contains a NUL byte');
  const absolute = resolve(input);

  const runtimeRoot = roots.runtimeDir === undefined ? defaultRuntimeDir() : roots.runtimeDir;
  const runtimeRel = relativeFile(runtimeRoot, absolute);
  if (runtimeRel) {
    return `${EXTERNAL_RUNTIME_LOCK_PREFIX}/${runtimeRel.split(sep).join('/')}`;
  }

  const homeRoot = resolve(roots.home ?? homedir());
  const homeRel = relativeFile(homeRoot, absolute);
  if (homeRel) {
    return `${EXTERNAL_HOME_LOCK_PREFIX}/${homeRel.split(sep).join('/')}`;
  }

  throw new Error(
    `external path must name a file below the current user's XDG runtime directory or home (${homeRoot})`,
  );
}

/**
 * Backward-compatible home-only helper for callers/tests that intentionally
 * model the pre-runtime namespace. New lock surfaces should use
 * `externalPathToLockKey` so acquire and queue share runtime parity.
 */
export function externalHomePathToLockKey(input: string, home = homedir()): string {
  return externalPathToLockKey(input, { home, runtimeDir: null });
}

export function isExternalLockKey(path: string): boolean {
  return EXTERNAL_LOCK_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}
