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

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { cloneGithubRepo, isCloneError, defaultClonesDir, parseGitProgressLine } from './clone-github';
import { ensurePapercuspHive, PAPERCUSP_HIVE_SLUG } from './ensure-papercusp-hive';
import { detectPapercupRoot } from './register-papercusp';
import { PAPERCUSP_WORKSPACE_ID } from './papercusp-workspace';
import { loadHarnessRegistry } from '../harness-registry';
import { readRegistry, writeRegistry } from '../workspace-registry';
import { recordFromRepoStep } from './from-repo-progress';

/** The dogfood repo cloned on first boot when no local checkout is present. */
export const PAPERCUP_DOGFOOD_REPO_URL = 'https://github.com/Papercusp/papercup';

/**
 * Fixed, well-known progressId the boot-time bootstrap records under (it has no
 * UI to mint one), so the desktop banner + setup-finish gate can subscribe with
 * `useSyncQuery({ queryName: 'hiveFromRepo.progress', args: { progressId } })`
 * without the boot step handing them an id. Reuses the create-from-URL progress
 * channel (same `clone` phase; `submodules` is bootstrap-only).
 */
export const BOOTSTRAP_PROGRESS_ID = 'bootstrap-papercusp-hive';

/** The two phases the dogfood bootstrap reports. */
export type BootstrapProgressStep = 'clone' | 'submodules';
export type BootstrapProgressStatus = 'running' | 'done' | 'error' | 'skipped';

/** Pin ref (branch OR tag) baked into a release build so the dogfood hive
 *  matches the desktop binary exactly. Unset (dev builds) ⇒ the remote default
 *  branch (main). See bin/release-local.sh (stage 3). */
function dogfoodRef(explicit?: string): string | undefined {
  return explicit ?? (process.env.PAPERCUP_DOGFOOD_REPO_REF || undefined);
}

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
  /** Best-effort submodule init for a fresh clone; fired (not awaited) in prod.
   *  `onProgress(done, total)` streams completion; `onDone(ok)` fires once at the
   *  end (success/fail) so the bootstrap can record the terminal step. */
  initSubmodules?: (
    repoPath: string,
    opts?: {
      shallow?: boolean;
      onProgress?: (done: number, total: number) => void;
      onDone?: (ok: boolean) => void;
    },
  ) => void;
  /** Shallow superproject + submodule clone (--depth 1). Default TRUE — fast
   *  first boot; the bulk is submodules. (`git fetch --unshallow` backfills.) */
  cloneShallow?: boolean;
  /** Pin the clone to this branch/tag. Default: env PAPERCUP_DOGFOOD_REPO_REF
   *  (the release pin) else the remote default branch. */
  ref?: string;
  /** Record a progress step (default → from-repo-progress under BOOTSTRAP_PROGRESS_ID).
   *  Injectable so tests assert the recorded sequence without the store. */
  recordProgress?: (
    step: BootstrapProgressStep,
    status: BootstrapProgressStatus,
    extra?: { percent?: number; detail?: string },
  ) => void;
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

/** Count top-level submodules from `.gitmodules` (best-effort) — the progress
 *  total. `--recursive` can exceed this (nested submodules), so callers clamp. */
function countSubmodules(repoPath: string): Promise<number> {
  return new Promise((resolve) => {
    let out = '';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        'git',
        ['config', '-f', join(repoPath, '.gitmodules'), '--get-regexp', '^submodule\\..*\\.path$'],
        { cwd: repoPath },
      );
    } catch {
      resolve(0);
      return;
    }
    child.stdout?.on('data', (b: Buffer) => (out += b.toString()));
    child.on('error', () => resolve(0));
    child.on('close', () => resolve(out.split('\n').filter((l) => l.trim()).length));
  });
}

/** Matches git's per-submodule completion line: `Submodule path '…': checked out …`. */
const SUBMODULE_DONE_RE = /Submodule path .*: checked out/;

/** Best-effort `git submodule update --init --recursive --progress` (the 27
 *  submodules are the bulk of the ~5GB). Streams completion to `onProgress` and
 *  fires `onDone(ok)` once. Fired (not awaited) in prod; the hive is created
 *  before this so it appears promptly and fills in. */
function defaultInitSubmodules(
  repoPath: string,
  opts: {
    shallow?: boolean;
    onProgress?: (done: number, total: number) => void;
    onDone?: (ok: boolean) => void;
  } = {},
): void {
  void (async () => {
    const total = await countSubmodules(repoPath);
    const args = ['submodule', 'update', '--init', '--recursive', '--progress'];
    if (opts.shallow) args.push('--depth', '1');
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('git', args, { cwd: repoPath, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    } catch (e) {
      console.warn(`[papercusp-hive] submodule init spawn failed (non-fatal): ${(e as Error).message}`);
      opts.onDone?.(false);
      return;
    }
    // 2h ceiling — background, but never hang a wedged fetch forever.
    const kill = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* */ } }, 2 * 60 * 60 * 1000);
    kill.unref?.();
    let done = 0;
    child.stderr?.on('data', (b: Buffer) => {
      for (const line of b.toString().split(/[\r\n]+/)) {
        if (SUBMODULE_DONE_RE.test(line)) {
          done += 1;
          opts.onProgress?.(done, total);
        }
      }
    });
    child.on('error', (e) => {
      clearTimeout(kill);
      console.warn(`[papercusp-hive] submodule init failed (non-fatal): ${e.message}`);
      opts.onDone?.(false);
    });
    child.on('close', (code) => {
      clearTimeout(kill);
      if (code === 0) console.log('[papercusp-hive] submodules initialised');
      else console.warn(`[papercusp-hive] submodule init exited ${code} (non-fatal)`);
      opts.onDone?.(code === 0);
    });
  })();
}

/** Percent for a submodule phase (clamped; total 0 ⇒ indeterminate 0). */
function submodulePercent(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.round((done / total) * 100));
}

/** Process single-flight for the dogfood bootstrap (see startBootstrapPapercuspHive). */
let bootstrapInFlight: Promise<BootstrapPapercuspHiveResult> | null = null;

/**
 * Single-flight trigger for "start the dogfood clone NOW" — used by BOTH the
 * boot path and the setup-wizard's post-gh-auth "start" endpoint, so they share
 * ONE run instead of racing two clones. Returns the `progressId` immediately (the
 * UI subscribes to it) and a `done` promise that resolves when the hive is created
 * (the clone finished; submodules keep filling in the background).
 *
 * A SUCCESS is cached for the process (idempotent; never re-run racing the
 * background submodule fill). A `skipped` result (e.g. auth_required because gh
 * isn't signed in yet at boot) RELEASES the latch so the next trigger — the
 * wizard, after the user completes the GitHub step — re-runs and actually clones.
 */
export function startBootstrapPapercuspHive(deps: BootstrapPapercuspHiveDeps = {}): {
  progressId: string;
  done: Promise<BootstrapPapercuspHiveResult>;
} {
  if (!bootstrapInFlight) {
    bootstrapInFlight = bootstrapPapercuspHive(deps).then(
      (res) => {
        if (res.state === 'skipped') bootstrapInFlight = null; // allow a retry
        return res;
      },
      (err) => {
        bootstrapInFlight = null;
        throw err;
      },
    );
  }
  return { progressId: BOOTSTRAP_PROGRESS_ID, done: bootstrapInFlight };
}

/** Test seam — clear the single-flight latch between cases. */
export function __resetBootstrapInFlight(): void {
  bootstrapInFlight = null;
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
  const record =
    deps.recordProgress ??
    ((step, status, extra) => recordFromRepoStep(BOOTSTRAP_PROGRESS_ID, step, status, extra));
  const shallow = deps.cloneShallow ?? true;
  const ref = dogfoodRef(deps.ref);

  // 1. Idempotent: the `papercusp` hive already exists → home + done. Nothing to
  //    download, so BOTH phases are already terminal (the setup gate is satisfied).
  try {
    const reg = await loadRegistry(PAPERCUSP_WORKSPACE_ID);
    if (reg.projects.some((p) => p.slug === PAPERCUSP_HIVE_SLUG)) {
      setHome(PAPERCUSP_WORKSPACE_ID);
      record('clone', 'done', { detail: 'already present' });
      record('submodules', 'done');
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
  if (root) {
    // Local checkout → nothing to download; the hive is ready immediately.
    record('clone', 'done', { detail: 'local checkout' });
  } else {
    record('clone', 'running', { percent: 0 });
    // Throttle the percent stream — forward only on a >=2pt move or phase change.
    let lastPct = -1;
    let lastPhase = '';
    const res = await clone(PAPERCUP_DOGFOOD_REPO_URL, {
      destName: PAPERCUSP_HIVE_SLUG,
      shallow,
      ...(ref ? { ref } : {}),
      timeoutMs: 60 * 60 * 1000, // 1h — a multi-GB private clone is slow.
      onProgress: ({ phase, percent }) => {
        if (phase === lastPhase && Math.abs(percent - lastPct) < 2) return;
        lastPhase = phase;
        lastPct = percent;
        record('clone', 'running', {
          percent,
          detail: phase === 'receiving' ? 'downloading' : 'resolving',
        });
      },
    });
    if (isCloneError(res)) {
      // A prior (complete) clone is already on disk → adopt it rather than refusing.
      if (res.code === 'dest_exists') {
        root = join(defaultClonesDir(), PAPERCUSP_HIVE_SLUG);
        cloned = true;
        record('clone', 'done', { detail: 'adopted existing clone' });
      } else {
        record('clone', 'error', { detail: res.code });
        return { state: 'skipped', slug: null, reason: `clone ${res.code}: ${res.message}`.slice(0, 200) };
      }
    } else {
      root = res.path;
      cloned = true;
      record('clone', 'done');
    }
  }

  // 3. Create the single `papercusp` hive linked to the repo in place.
  const hiveRes = await ensureHive({ pathOverride: root });
  if (hiveRes.state === 'skipped') {
    record('clone', 'error', { detail: hiveRes.reason ?? 'hive create failed' });
    return { state: 'skipped', slug: null, path: root, reason: hiveRes.reason };
  }

  // 4. Make papercusp-workspace the home so the hive is VISIBLE (see header).
  setHome(PAPERCUSP_WORKSPACE_ID);

  // 5. Submodules. A fresh clone fills them in the BACKGROUND (non-blocking) and
  //    records the terminal `submodules` step when done — that (plus the hive
  //    existing) is what the setup-finish gate waits on. A local checkout has no
  //    submodule phase, so mark it skipped → the gate is already satisfied.
  if (cloned) {
    record('submodules', 'running', { percent: 0 });
    initSubmodules(root, {
      shallow,
      onProgress: (d, total) =>
        record('submodules', 'running', {
          percent: submodulePercent(d, total),
          detail: total > 0 ? `${Math.min(d, total)}/${total} submodules` : `${d} submodules`,
        }),
      onDone: (ok) => record('submodules', ok ? 'done' : 'error'),
    });
  } else {
    record('submodules', 'skipped', { detail: 'local checkout' });
  }

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
