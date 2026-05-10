/**
 * Single source of truth for the operator's "Papercusp root" path.
 *
 * The substrate moved from ~/.papercusp/ to per-workspace storage at
 * ~/.papercusp-workspaces/<id>/.papercusp/. Callers should never join
 * `homedir() + '.papercusp'` directly — use {@link papercuspRoot} so the
 * workspace migration stays transparent.
 *
 * Resolution order:
 *   1. PAPERCUSP_HOME env var (escape hatch)
 *   2. Active workspace per ~/.papercusp-workspaces/registry.json `current`
 *   3. Default workspace (~/.papercusp-workspaces/default/.papercusp)
 *   4. Legacy ~/.papercusp/ (pre-workspaces installs)
 *
 * Resolution is cached per request (the same call within a tight loop
 * reuses the result), but invalidates on any input change — so a
 * registry.json edit, a workspace dir creation, or a PAPERCUSP_HOME env
 * flip is reflected on the next call. A naive lifetime cache (the
 * pre-2026-05-02 implementation) caused stale paths under Next dev when
 * registry.json changed mid-session: routes that had cached the old
 * workspace served data from it until the operator was restarted.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface CacheKey {
  env: string | undefined;
  registryMtime: number;
  registryContent: string | null;
}
let cached: { key: CacheKey; value: string } | null = null;

function currentKey(): CacheKey {
  const idx = join(homedir(), '.papercusp-workspaces', 'registry.json');
  let mtime = 0;
  let content: string | null = null;
  try {
    mtime = statSync(idx).mtimeMs;
    content = readFileSync(idx, 'utf8');
  } catch { /* missing/unreadable — both fields stay zero/null */ }
  return { env: process.env.PAPERCUSP_HOME, registryMtime: mtime, registryContent: content };
}

function keysEqual(a: CacheKey, b: CacheKey): boolean {
  return a.env === b.env && a.registryMtime === b.registryMtime && a.registryContent === b.registryContent;
}

export function papercuspRoot(): string {
  const key = currentKey();
  if (cached && keysEqual(cached.key, key)) return cached.value;
  const value = resolve();
  cached = { key, value };
  return value;
}

/** Test-only: clear the cache so a different env can be picked up. */
export function _resetPapercuspRootForTests(): void {
  cached = null;
}

function resolve(): string {
  if (process.env.PAPERCUSP_HOME) return process.env.PAPERCUSP_HOME;

  const wsIndex = join(homedir(), '.papercusp-workspaces', 'registry.json');
  if (existsSync(wsIndex)) {
    try {
      const parsed = JSON.parse(readFileSync(wsIndex, 'utf8')) as { current?: string };
      if (parsed.current) {
        const cand = join(homedir(), '.papercusp-workspaces', parsed.current, '.papercusp');
        if (existsSync(cand)) return cand;
      }
    } catch { /* fall through */ }
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DEFAULT_WORKSPACE_ID } = require('./workspace-registry') as typeof import('./workspace-registry');
  const def = join(homedir(), '.papercusp-workspaces', DEFAULT_WORKSPACE_ID, '.papercusp');
  if (existsSync(def)) return def;

  return join(homedir(), '.papercusp');
}

/** Convenience for "give me a path under the papercusp root". */
export function papercuspPath(...parts: string[]): string {
  return join(papercuspRoot(), ...parts);
}
