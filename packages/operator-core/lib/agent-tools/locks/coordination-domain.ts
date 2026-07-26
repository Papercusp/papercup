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
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { hasValidGitEntry } from './valid-git-entry';

let _domain: string | null = null;

/** Walk up from `start` to the nearest ancestor containing a VALID `.git` entry
 *  (gitlink file OR git dir with HEAD — see valid-git-entry.ts: a stray empty
 *  `.git` dir must not collapse lock domains). */
function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 16; i++) {
    if (hasValidGitEntry(dir)) return dir;
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

/**
 * EI-18674647773291145 (Defect 2): the FIXED domain for genuinely HOST-GLOBAL
 * resources — ones that name a single shared subsystem on this host (e.g. the
 * one shared release checkout `release-deploy` guards) rather than a physical
 * file tree. `lockCoordinationDomain()` above is deliberately keyed by the
 * CALLER's own repo root (correct for file-locking, D-015) — but that means a
 * host-global resource acquired from two DIFFERENT physical checkouts of the
 * same logical repo (e.g. the release checkout vs the staging/integration
 * tree deploy-cli is often run from manually) silently lands in two different
 * domains: the single-flight guarantee the resource exists for stops holding
 * across trees, and any diagnostic (`locks:list`) run from yet another tree
 * reports "no holders" for a lock that is genuinely held elsewhere (observed
 * live 2026-07-26: `locks:list { resource: 'release-deploy' }` returned
 * `holders: []` while a lock row provably existed). A resource that means
 * "this one host-wide subsystem" must resolve to the SAME domain regardless
 * of which tree loaded the calling code. `PAPERCUSP_LOCK_DOMAIN` still
 * overrides, same as `lockCoordinationDomain()` (tests / no-repo builds).
 */
export function hostGlobalLockDomain(): string {
  const override = process.env.PAPERCUSP_LOCK_DOMAIN;
  if (override && override.trim()) return override.trim();
  return 'papercusp-host-global';
}

/**
 * Resource names whose acquirers use {@link hostGlobalLockDomain} instead of
 * {@link lockCoordinationDomain} — kept as a single source of truth so a
 * diagnostic reader (`locks:list`) can resolve the SAME fixed domain a
 * host-global acquirer used. Currently just `release-deploy` (EI-18674647773291145
 * Defect 2's concrete incident); `dev-server` has the identical cross-tree
 * defect but is deliberately NOT included here yet — it has more call sites
 * (dev:restart, system-health) that need their own dedicated review before
 * migrating, tracked separately so this fix stays narrowly scoped to the
 * incident it closes.
 */
export const HOST_GLOBAL_RESOURCES: ReadonlySet<string> = new Set(['release-deploy']);
