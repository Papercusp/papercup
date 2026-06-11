/**
 * The file-lock **coordination domain** — the canonical, symlink-resolved root of
 * the repo whose files the locks protect.
 *
 * File locking exists to prevent two actors from editing the same PHYSICAL FILE at
 * once, so the lock namespace is a property of the file on disk — NOT of the
 * logical Papercusp workspace the editor came through (dbos-system-completion
 * D-015). Multiple workspaces can import the same harness (same repo on disk), and
 * SU agents + autonomous workers editing the same physical file must serialize
 * regardless of workspace. Keying the domain by `workspaceId` (the prior design)
 * silently split those into separate namespaces → no serialization → clobber.
 *
 * Every SU agent on this operator edits THIS papercup checkout, so the domain is a
 * single constant: the realpath of the repo root. A worker editing a managed
 * harness uses the realpath of ITS repo (`deps.repoPath`); the papercup-dogfood
 * harness resolves to the same realpath as the operator → it serializes with SU
 * agents on the same files. Two genuinely-different checkouts realpath-differ →
 * different domains → independent (they are different files), which is correct.
 *
 * `PAPERCUSP_LOCK_DOMAIN` overrides (tests / packaged builds with no repo on disk).
 */
import { realpathSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let _domain: string | null = null;

/** Walk up from `start` to the nearest ancestor containing a `.git` entry. */
function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 16; i++) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

/**
 * The lock coordination domain for an arbitrary project dir — the canonical
 * (realpath) repo root containing it. Used by spawn paths that launch agents
 * into a managed harness's checkout (operator-spawn, agent-chat runs), where
 * the domain is a property of the CHILD's repo, not the operator's.
 */
export function lockDomainForProjectDir(projectDir: string): string {
  const override = process.env.PAPERCUSP_LOCK_DOMAIN;
  if (override && override.trim()) return override.trim();
  const root = findRepoRoot(projectDir);
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

/** The lock coordination domain for the operator (cached). */
export function lockCoordinationDomain(): string {
  if (_domain) return _domain;
  const override = process.env.PAPERCUSP_LOCK_DOMAIN;
  if (override && override.trim()) {
    _domain = override.trim();
    return _domain;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const root = findRepoRoot(here);
  try {
    _domain = realpathSync(root);
  } catch {
    _domain = root;
  }
  return _domain;
}

/** Reset the cache — test-only. */
export function __resetLockCoordinationDomain(): void {
  _domain = null;
}
