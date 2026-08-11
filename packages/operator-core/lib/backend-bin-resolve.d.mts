/**
 * Types for the shared backend-bin resolver (WI-37920 / P-001, P-005).
 *
 * `backend-bin-resolve.mjs` must stay plain ESM so `apps/operator/scripts/psu-launcher.mjs`
 * (bare `node`, unbundled) can import the same definition the TypeScript operator path
 * uses. This declaration keeps the TypeScript callers type-checked without forcing a
 * build step on the launcher. Same shape as `su-tier-roles.d.mts`.
 */

export interface BackendResolveOpts {
  /** Home directory to resolve `~`-relative install roots against. Default: os.homedir(). */
  home?: string;
  /** Environment to read PATH / USERPROFILE / APPDATA / PATHEXT from. Default: process.env. */
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  /** Platform to resolve for. Default: process.platform. */
  platform?: NodeJS.Platform;
  /** Test seam: return the first bytes of a file (for shebang parsing). */
  readHead?: (path: string) => string;
}

export interface ResolvedBackendLaunch {
  agent: string;
  /** Absolute path to the backend CLI. */
  bin: string;
  /** Whether the OPERATOR's PATH resolved it (informational — the spawned PATH differs). */
  onPath: boolean;
  /** Shebang interpreter as written (`bun`, `/usr/bin/python3`), or null. */
  interpreter: string | null;
  /** Absolute path to the interpreter, or null when there is none / it is unresolvable. */
  interpreterBin: string | null;
  /** The shebang named an interpreter that could NOT be resolved — the launch will fail. */
  interpreterMissing: boolean;
}

export interface SpawnPathDirs {
  /** Deduped, existing directories to inject into the spawned terminal's PATH. */
  dirs: string[];
  resolved: ResolvedBackendLaunch[];
  /** Agents that could not be resolved at all. */
  missing: string[];
}

export const BACKEND_AGENTS: readonly string[];

/** Ordered PATH-independent install dirs for this platform. Order is precedence. */
export function backendSearchDirs(opts?: BackendResolveOpts): string[];

/** Candidate file names for an executable (PATHEXT-aware on win32). */
export function executableNames(
  bin: string,
  opts?: Pick<BackendResolveOpts, 'env' | 'platform'>,
): string[];

/** Resolve a bin against a PATH string — pure node, no `which`/`where` subprocess. */
export function resolveOnPath(
  bin: string,
  opts?: Pick<BackendResolveOpts, 'env' | 'platform'>,
): string | null;

/** Search the well-known dirs (PATH-independent) for a bin. */
export function resolveInWellKnownDirs(bin: string, opts?: BackendResolveOpts): string | null;

/** Well-known install location for a BACKEND. Absolute path or null. */
export function wellKnownBackendBin(
  agent: string | null | undefined,
  opts?: BackendResolveOpts,
): string | null;

/** Parse a file's `#!` interpreter (`/usr/bin/env bun` → `bun`). Null on win32. */
export function readShebangInterpreter(
  binPath: string,
  opts?: Pick<BackendResolveOpts, 'platform' | 'readHead'>,
): string | null;

/** Resolve one backend AND the shebang interpreter it needs to actually execute. */
export function resolveBackendLaunch(
  agent: string,
  opts?: BackendResolveOpts,
): ResolvedBackendLaunch | null;

/** The dirs to inject into a spawned terminal's PATH so its command is self-sufficient. */
export function resolveSpawnPathDirs(
  opts?: BackendResolveOpts & { agents?: readonly string[] },
): SpawnPathDirs;

/** Env key carrying the resolved dirs to every spawner (server-side and Tauri). */
export const SPAWN_PATH_DIRS_ENV: string;

export function encodeSpawnPathDirs(dirs: readonly string[] | null | undefined): string;

export function decodeSpawnPathDirs(
  value: string | null | undefined,
  opts?: { pathDelimiter?: string },
): string[];
