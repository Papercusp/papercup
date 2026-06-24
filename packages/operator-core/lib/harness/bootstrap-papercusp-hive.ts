/**
 * Clone-on-first-boot of the Papercusp dogfood hive (owner decision 2026-06-23:
 * ship the desktop with `papercusp` as the single default hive — Papercusp
 * building itself).
 *
 * The repo is far too large to bundle (~5GB tree + 6.2GB .git + 27 submodules),
 * so a PACKAGED install CLONES github.com/Papercusp/papercup on first boot, using
 * the user's `gh` credential helper for the private repo (the established auth
 * path — see clone-github.ts), then hands the checkout to ensurePapercuspHive()
 * (the existing single-`papercusp`-entry creator). Finally it makes
 * `papercusp-workspace` the active/home workspace so the hive is VISIBLE:
 * ensurePapercuspWorkspace() deliberately never hijacks `registry.current`, so a
 * packaged install that already homed on `default` would otherwise create the
 * hive in a workspace the user never sees (host-bootstrap BUG-1: the baked home
 * slug `papercusp` "doesn't resolve in the default workspace until setup").
 *
 * Idempotent · best-effort · non-fatal. A missing gh auth (auth_required), no
 * network, or an already-present hive all no-op cleanly, and the NEXT boot retries
 * until it succeeds — so a user who signs into gh after first launch gets the hive
 * on the following operator boot. A local checkout (dev box) is used in place and
 * never cloned. Submodules (the bulk of the 5GB) are initialised best-effort in the
 * BACKGROUND after the hive is created, so the hive appears promptly and fills in.
 */

import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { cloneGithubRepo, isCloneError, defaultClonesDir } from './clone-github';
import { ensurePapercuspHive, PAPERCUSP_HIVE_SLUG } from './ensure-papercusp-hive';
import { detectPapercupRoot } from './register-papercusp';
import { PAPERCUSP_WORKSPACE_ID } from './papercusp-workspace';
import { loadHarnessRegistry } from '../harness-registry';
import { readRegistry, writeRegistry } from '../workspace-registry';

/** The dogfood repo cloned on first boot when no local checkout is present. */
export const PAPERCUP_DOGFOOD_REPO_URL = 'https://github.com/Papercusp/papercup';

export interface BootstrapPapercuspHiveResult {
  state: 'already-present' | 'newly-created' | 'cloned-and-created' | 'skipped';
  slug: string | null;
  /** The repo path used (detected local checkout or fresh clone). */
  path?: string;
  reason?: string;
}

/** Injectable seams (lib/ DI-for-tests pattern). Production defaults to real impls. */
export interface BootstrapPapercuspHiveDeps {
  detectRoot?: () => string | null;
  loadRegistry?: (ws: string) => Promise<{ projects: Array<{ slug: string }> }>;
  clone?: typeof cloneGithubRepo;
  ensureHive?: typeof ensurePapercuspHive;
  /** Make `ws` the active/home workspace (so the hive is visible). */
  setHomeWorkspace?: (ws: string) => void;
  /** Best-effort submodule init for a fresh clone; fired (not awaited) in prod. */
  initSubmodules?: (repoPath: string) => void;
  /** Shallow superproject clone (--depth 1). Default false (full history). */
  cloneShallow?: boolean;
}

/** Set `registry.current` to `ws` (idempotent). The deliberate counterpart to
 *  ensurePapercuspWorkspace's "never hijack current" rule — used ONLY when we have
 *  actually created the home hive and want the user to land on it. */
function defaultSetHomeWorkspace(ws: string): void {
  const reg = readRegistry();
  if (reg.current !== ws) {
    reg.current = ws;
    writeRegistry(reg);
  }
}

/** Best-effort `git submodule update --init --recursive` (the 27 submodules are the
 *  bulk of the 5GB; the hive is created before this so it appears promptly). */
function defaultInitSubmodules(repoPath: string): void {
  execFile(
    'git',
    ['submodule', 'update', '--init', '--recursive'],
    { cwd: repoPath, timeout: 2 * 60 * 60 * 1000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
    (err) => {
      if (err) {
        console.warn(`[papercusp-hive] submodule init best-effort failed (non-fatal): ${err.message}`);
      } else {
        console.log('[papercusp-hive] submodules initialised');
      }
    },
  );
}

/**
 * Ensure the `papercusp` dogfood hive exists, cloning the repo first when there's
 * no local checkout (packaged install). Idempotent + best-effort + non-fatal.
 */
export async function bootstrapPapercuspHive(
  deps: BootstrapPapercuspHiveDeps = {},
): Promise<BootstrapPapercuspHiveResult> {
  const detectRoot = deps.detectRoot ?? detectPapercupRoot;
  const loadRegistry = deps.loadRegistry ?? loadHarnessRegistry;
  const clone = deps.clone ?? cloneGithubRepo;
  const ensureHive = deps.ensureHive ?? ensurePapercuspHive;
  const setHome = deps.setHomeWorkspace ?? defaultSetHomeWorkspace;
  const initSubmodules = deps.initSubmodules ?? defaultInitSubmodules;

  // 1. Idempotent: the `papercusp` hive already exists → ensure it's the home and done.
  try {
    const reg = await loadRegistry(PAPERCUSP_WORKSPACE_ID);
    if (reg.projects.some((p) => p.slug === PAPERCUSP_HIVE_SLUG)) {
      setHome(PAPERCUSP_WORKSPACE_ID);
      return { state: 'already-present', slug: PAPERCUSP_HIVE_SLUG };
    }
  } catch {
    /* registry not ready yet — fall through; ensureHive re-checks idempotently */
  }

  // 2. Resolve the repo: a local checkout (dev box / a prior clone on PATH) wins;
  //    otherwise CLONE the dogfood repo (packaged install). auth_required just means
  //    "gh isn't signed in yet" — no-op and let the next boot retry.
  let root = detectRoot();
  let cloned = false;
  if (!root) {
    const res = await clone(PAPERCUP_DOGFOOD_REPO_URL, {
      destName: PAPERCUSP_HIVE_SLUG,
      shallow: deps.cloneShallow ?? false,
      timeoutMs: 60 * 60 * 1000, // 1h — a multi-GB private clone is slow.
    });
    if (isCloneError(res)) {
      // A prior (complete) clone is already on disk → adopt it rather than refusing.
      if (res.code === 'dest_exists') {
        root = join(defaultClonesDir(), PAPERCUSP_HIVE_SLUG);
        cloned = true;
      } else {
        return { state: 'skipped', slug: null, reason: `clone ${res.code}: ${res.message}`.slice(0, 200) };
      }
    } else {
      root = res.path;
      cloned = true;
    }
  }

  // 3. Create the single `papercusp` hive linked to the repo in place.
  const hiveRes = await ensureHive({ pathOverride: root });
  if (hiveRes.state === 'skipped') {
    return { state: 'skipped', slug: null, path: root, reason: hiveRes.reason };
  }

  // 4. Make papercusp-workspace the home so the hive is VISIBLE (see header).
  setHome(PAPERCUSP_WORKSPACE_ID);

  // 5. Fresh clone → fill in submodules in the background (non-blocking).
  if (cloned) initSubmodules(root);

  return {
    state: cloned
      ? 'cloned-and-created'
      : hiveRes.state === 'already-present'
        ? 'already-present'
        : 'newly-created',
    slug: PAPERCUSP_HIVE_SLUG,
    path: root,
  };
}
