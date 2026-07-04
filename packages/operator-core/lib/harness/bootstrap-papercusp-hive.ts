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
import {
  adoptSharedHiveIdentity,
  goSharedHive,
  shareExistingHive,
  type SharedHiveState,
} from './papercusp-hive-share';
import {
  bakedCanonicalHiveInvite,
  joinCanonicalPapercuspHive,
  type CanonicalHiveInvite,
} from './papercusp-hive-join';
import { AWAITING_GH_SIGNIN_DETAIL } from './bootstrap-papercusp-hive-detail';
import { restoreHiveSeed, resolveSeedDir, type RestoreHiveSeedResult } from '../sync/hyperbee/restore-hive-seed';
import { triggerDeferredGitRestore, type TriggerDeferredGitRestoreResult } from '../sync/hyperbee/deferred-git-restore';
import { buildMemberEpochKeyProvider } from '../sync/hyperbee/hive-epoch-boot-deps';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';

/**
 * P-011 kill-switch: the seed-bundle feature master gate (FLAGS.HIVE_SEED_BUNDLE,
 * DEFAULT ON — finished work never ships dark). OFF ⇒ both restore paths no-op and
 * the pure COLD join runs, byte-identical to a no-seed build (the runtime escape
 * hatch if a seed restore ever misbehaves). Fail-open to ON: getFlag already returns
 * the ON default when PostHog is unreachable, and the restore itself is
 * safe-by-construction (any restore failure falls back to the cold path — P-008), so
 * a flag-read hiccup must not silently force cold.
 */
export async function seedBundleEnabled(
  readFlag: () => Promise<boolean> = () => getFlag(FLAGS.HIVE_SEED_BUNDLE, 'system'),
): Promise<boolean> {
  try {
    return await readFlag();
  } catch {
    return true;
  }
}

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

/** Re-exported from ./bootstrap-papercusp-hive-detail (shared with the join path,
 *  papercusp-hive-join.ts, without an import cycle). */
export { AWAITING_GH_SIGNIN_DETAIL };

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
  loadRegistry?: (ws: string) => Promise<{ projects: Array<{ slug: string; path?: string }> }>;
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
  /** Solution C (DOGFOOD_PAPERCUSP_HIVE_SHARE, default-on/reversible): adopt the owner's
   *  SHARED hive identity from their per-owner gist BEFORE the hive is created.
   *  Default: adoptSharedHiveIdentity (returns null — sharing skipped — when the
   *  flag is off / gh unauth). */
  adoptShare?: () => Promise<SharedHiveState | null>;
  /** Solution C: AFTER create, publish the identity gist (first device) + announce
   *  (invite) + set the owner-only allowlist policy. Default: goSharedHive (a no-op
   *  when adoptShare returned null). */
  goShare?: (state: SharedHiveState | null) => Promise<void>;
  /** Solution C: share an ALREADY-PRESENT hive (flag enabled after create, or a
   *  re-boot). Default: shareExistingHive (no-op when the flag is off). */
  shareExisting?: () => Promise<void>;
  /** JOIN-the-canonical pivot: the baked canonical hive invite (pubkey+secret). When
   *  present, JOIN the canonical hive instead of clone+create. Default:
   *  bakedCanonicalHiveInvite() (null on dev builds → per-owner create fallback). */
  canonicalInvite?: CanonicalHiveInvite | null;
  /** The join orchestration. Default: joinCanonicalPapercuspHive. */
  joinCanonical?: typeof joinCanonicalPapercuspHive;
  /** P-005 fire-once latch: resolve whether THIS box already joined the canonical hive
   *  (a hives row keyed on the canonical pubkey, written by joinHiveAsView on a prior
   *  boot). Default: getHiveByPubkey. Returns the joined view slug, or null. */
  findJoinedCanonical?: (pubkeyBase64: string) => Promise<{ slug: string } | null>;
  /** Inspect whether a repo's submodules still need init/update. */
  submodulesNeedUpdate?: (repoPath: string) => Promise<boolean>;
  /** P-007 restore-before-join: pre-position the installer-bundled seed (corestore
   *  federated state now; encrypted git deferred to post-admission) BEFORE the
   *  unchanged join runs, so the join transfers only the delta. Default:
   *  {@link defaultRestoreHiveSeed} — a SAFE no-op (ran:false) until a build ships a
   *  seed and sets PAPERCUSP_SEED_DIR. Best-effort: any failure degrades to the
   *  cold path and never breaks the join. */
  restoreSeed?: (record: BootstrapPapercuspHiveDeps['recordProgress']) => Promise<RestoreHiveSeedResult>;
  /** P-010 live-wire 2 post-admission git-restore trigger: once the join admits this
   *  device + delivers the epoch keys, restore the git seed that the pre-join restore
   *  DEFERRED (encrypted at rest; key = the hive epoch key at cutAtEpoch). Default:
   *  {@link defaultRestoreDeferredGitSeed} — best-effort, called only when the pre-join
   *  restore deferred a git store AND the join succeeded. */
  restoreDeferredGitSeed?: (
    record: BootstrapPapercuspHiveDeps['recordProgress'],
  ) => Promise<TriggerDeferredGitRestoreResult>;
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

/** P-005 default: has THIS box already joined the canonical hive? joinHiveAsView's
 *  identity upsert writes a hives row keyed on the hive pubkey; a row keyed on the
 *  baked canonical pubkey means a prior boot already joined. Best-effort → null. */
async function defaultFindJoinedCanonical(pubkeyBase64: string): Promise<{ slug: string } | null> {
  try {
    const { getHiveByPubkey } = await import('../hive-store');
    const row = await getHiveByPubkey(PAPERCUSP_WORKSPACE_ID, pubkeyBase64);
    return row ? { slug: row.homeSlug } : null;
  } catch {
    return null;
  }
}

/**
 * P-007 default restore-before-join. SAFE by construction: when no seed is shipped
 * (PAPERCUSP_SEED_DIR unset AND no bundled manifest) `restoreHiveSeed` returns
 * `ran:false`, so this is a pure no-op on dev boxes + current packaged builds — the
 * cold join is unchanged. A release that bundles a seed sets PAPERCUSP_SEED_DIR to
 * the Tauri resource dir. The corestore (federated hive state) restores now; the
 * ENCRYPTED git seed defers (its key arrives post-admission — see restore-hive-seed).
 */
async function defaultRestoreHiveSeed(
  record?: BootstrapPapercuspHiveDeps['recordProgress'],
): Promise<RestoreHiveSeedResult> {
  // P-011 master gate: the seed-bundle feature flag (DEFAULT ON). OFF ⇒ pure cold join.
  if (!(await seedBundleEnabled())) {
    record?.('clone', 'running', { detail: 'seed: disabled (flag off) — cold join' });
    return { ran: false, outcomes: [], deferred: [] };
  }
  // Resolve the bundled seed dir: --no-seed escape hatch, then PAPERCUSP_SEED_DIR
  // override, then Tauri bundled-resource autodetect (<resourceRoot>/seed). A
  // wrong/empty candidate resolves to null → the unchanged cold path.
  const resolved = resolveSeedDir();
  if (resolved.disabled) {
    record?.('clone', 'running', { detail: 'seed: disabled (PAPERCUSP_NO_SEED) — cold join' });
    return { ran: false, outcomes: [], deferred: [] };
  }
  const seedDir = resolved.seedDir;
  if (!seedDir) return { ran: false, outcomes: [], deferred: [] };
  record?.('clone', 'running', { detail: `seed: found (${resolved.source}) — restoring before join` });
  // Restore the corestore into the canonical hive's store dir; the git checkout into
  // the clones dir the join would otherwise populate (same dirs the post-admission
  // deferred-git restore targets — see seedTargetDirs).
  const { targetStoreDir, targetRepoDir } = seedTargetDirs();
  const res = await restoreHiveSeed({
    seedDir,
    targetStoreDir,
    targetRepoDir,
    // decryptionKey is intentionally absent pre-admission → the git seed defers.
    log: (msg) => record?.('clone', 'running', { detail: msg.replace(/^\[seed\]\s*/, 'seed: ') }),
  });
  return res;
}

/** The seed's canonical restore target dirs (shared by the pre-join restore and the
 *  post-admission deferred-git restore so both point at the SAME checkout / store). */
function seedTargetDirs(): { targetStoreDir: string; targetRepoDir: string } {
  const workspaceRoot = process.env.PAPERCUSP_WORKSPACE_ROOT;
  return {
    targetStoreDir: join(workspaceRoot ?? defaultClonesDir(), '.papercusp', PAPERCUSP_HIVE_SLUG, 'hyperbee'),
    targetRepoDir: join(defaultClonesDir(), PAPERCUSP_HIVE_SLUG),
  };
}

/**
 * P-010 live-wire 2 default: after the join admits this device and delivers the hive
 * epoch keys, restore the git seed that {@link defaultRestoreHiveSeed} DEFERRED (its
 * bundles are encrypted at rest; the key = the hive epoch key at cutAtEpoch, which a
 * fresh member now holds — Q-4). Resolves the member EpochKeyProvider and hands it to
 * the trigger, which unwraps the key + re-restores just the git store. Best-effort +
 * safe: no seed / --no-seed / no local device identity ⇒ the store stays deferred and
 * the join's normal cold clone fills the repo in — never a boot failure.
 */
async function defaultRestoreDeferredGitSeed(
  record?: BootstrapPapercuspHiveDeps['recordProgress'],
): Promise<TriggerDeferredGitRestoreResult> {
  // P-011 master gate (DEFAULT ON): OFF ⇒ nothing was restored pre-join, so nothing
  // is deferred — no-op (belt-and-suspenders; the pre-join restore already no-op'd).
  if (!(await seedBundleEnabled())) return { ran: false, restored: [], stillDeferred: [] };
  const resolved = resolveSeedDir();
  if (resolved.disabled || !resolved.seedDir) return { ran: false, restored: [], stillDeferred: [] };
  const { targetStoreDir, targetRepoDir } = seedTargetDirs();
  const epochKeyProvider = await buildMemberEpochKeyProvider({
    workspaceId: PAPERCUSP_WORKSPACE_ID,
    hiveHomeSlug: PAPERCUSP_HIVE_SLUG,
  });
  if (!epochKeyProvider) {
    // No device identity / crypto yet ⇒ can't unwrap the epoch key this boot; the git
    // store stays deferred and the join's cold clone back-fills the repo.
    return { ran: false, restored: [], stillDeferred: ['git'] };
  }
  return triggerDeferredGitRestore({
    seedDir: resolved.seedDir,
    targetStoreDir,
    targetRepoDir,
    epochKeyProvider,
    log: (msg) => record?.('clone', 'running', { detail: msg.replace(/^\[seed\]\s*/, 'seed: ') }),
  });
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

/**
 * Matches git's failure-shaped stderr so a non-zero exit can name the cause:
 * `fatal: …`, `error: …`, `Failed to clone '…'`, `remote: Repository not found`,
 * `Authentication failed`, `Could not read from remote`, `Permission denied`.
 */
const SUBMODULE_FAIL_RE =
  /^(fatal|error):|Failed to clone|Repository not found|Authentication failed|Could not read|Permission denied|remote: /i;

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
    // Keep a bounded tail of failure-shaped stderr so a non-zero exit can name
    // WHICH submodule failed and why (a bare "exited 128" cost a full live-debug
    // round to trace a stale .gitmodules URL → 404). See agent-insights/
    // setup-wizard-submodule-url-mismatch.
    const failTail: string[] = [];
    child.stderr?.on('data', (b: Buffer) => {
      for (const line of b.toString().split(/[\r\n]+/)) {
        if (SUBMODULE_DONE_RE.test(line)) {
          done += 1;
          opts.onProgress?.(done, total);
        } else if (SUBMODULE_FAIL_RE.test(line)) {
          failTail.push(line.trim());
          if (failTail.length > 12) failTail.shift();
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
      else {
        const detail = failTail.length ? ` — ${failTail.join(' | ')}` : '';
        console.warn(
          `[papercusp-hive] submodule init exited ${code} (${done}/${total} done, non-fatal)${detail}`,
        );
      }
      opts.onDone?.(code === 0);
    });
  })();
}

/** Percent for a submodule phase (clamped; total 0 ⇒ indeterminate 0). */
function submodulePercent(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.round((done / total) * 100));
}

/** True when `git submodule status --recursive` reports any uninitialized,
 *  wrong-SHA, or conflicted submodule. The already-present hive path must use
 *  this: the hive row can exist before the background submodule fill completed,
 *  and retries must resume that work instead of declaring setup done. */
function defaultSubmodulesNeedUpdate(repoPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    let out = '';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('git', ['submodule', 'status', '--recursive'], { cwd: repoPath });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      resolve(false);
    }, 20_000);
    timer.unref?.();
    child.stdout?.on('data', (b: Buffer) => (out += b.toString()));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out.split('\n').some((line) => /^[-+U]/.test(line.trimStart())));
    });
  });
}

/** Run a best-effort Solution-C share step, swallowing any error (EI-3548).
 *  These steps call the GitHub API (gist publish/read + announce); a transient
 *  api.github.com timeout there must never reject the bootstrap and turn an
 *  otherwise-complete workspace setup into a hard "failed". Warn and proceed —
 *  the next operator boot re-runs the share idempotently. */
async function bestEffortShare(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.warn(`[papercusp-hive] ${label} failed (non-fatal): ${(e as Error)?.message ?? e}`);
  }
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
  const adoptShare = deps.adoptShare ?? adoptSharedHiveIdentity;
  const goShare = deps.goShare ?? goSharedHive;
  const shareExisting = deps.shareExisting ?? shareExistingHive;
  const submodulesNeedUpdate = deps.submodulesNeedUpdate ?? defaultSubmodulesNeedUpdate;

  const startSubmodulePhase = (repoPath: string): void => {
    record('submodules', 'running', { percent: 0 });
    initSubmodules(repoPath, {
      shallow,
      onProgress: (d, total) =>
        record('submodules', 'running', {
          percent: submodulePercent(d, total),
          detail: total > 0 ? `${Math.min(d, total)}/${total} submodules` : `${d} submodules`,
        }),
      onDone: (ok) => {
        record('submodules', ok ? 'done' : 'error');
        if (!ok) bootstrapInFlight = null;
      },
    });
  };

  // 1. Idempotent: the `papercusp` hive already exists → home it, then verify the
  //    repo's submodules. The hive row can be created before the background
  //    submodule fill finishes; retries must resume that fill instead of treating
  //    existence as setup-complete.
  try {
    const reg = await loadRegistry(PAPERCUSP_WORKSPACE_ID);
    const existing = reg.projects.find((p) => p.slug === PAPERCUSP_HIVE_SLUG);
    if (existing) {
      setHome(PAPERCUSP_WORKSPACE_ID);
      record('clone', 'done', { detail: 'already present' });
      if (existing.path && (await submodulesNeedUpdate(existing.path))) {
        startSubmodulePhase(existing.path);
      } else {
        record('submodules', 'done');
      }
      // Solution C: share an already-present hive (flag enabled after create / re-boot).
      // BEST-EFFORT (EI-3548): this calls the GitHub API (per-owner gist publish +
      // announce). A transient api.github.com timeout here must NOT fail an
      // otherwise-complete workspace setup — warn and proceed; the next boot re-shares.
      await bestEffortShare('shareExisting', shareExisting);
      return { state: 'already-present', slug: PAPERCUSP_HIVE_SLUG, path: existing.path };
    }
  } catch {
    /* registry not ready yet — fall through; ensureHive re-checks idempotently */
  }

  // 1b. JOIN-the-canonical pivot: when the build baked the canonical hive invite
  //     (pubkey+secret, no private key), JOIN the ONE canonical `papercusp` hive
  //     (clones the member repos + federates the owner's plans/work-items) INSTEAD of
  //     the clone+create+Solution-C path below. Per-owner create is the no-invite
  //     fallback. Best-effort: a skip (gh unauth / owner offline) retries next boot.
  const canonicalInvite = bakedCanonicalHiveInvite(deps.canonicalInvite);
  if (canonicalInvite) {
    // P-005 fire-once latch: if this box ALREADY joined the canonical hive on a prior
    // boot (a hives row keyed on the canonical pubkey exists from joinHiveAsView's
    // identity upsert), short-circuit. Re-running the join would re-pay the ~25s
    // confirmInviteAnnounce wait AND then spuriously SKIP — confirmInviteAnnounce only
    // fires on a FRESH appearance, but on a reboot the canonical hive is already in the
    // discovered set, so the join would report "not announcing yet" every boot forever.
    // (The OWNER box never reaches here: step 1 finds its own slug:'papercusp' hive.)
    const findJoinedCanonical = deps.findJoinedCanonical ?? defaultFindJoinedCanonical;
    const alreadyJoined = await findJoinedCanonical(canonicalInvite.pubkeyBase64).catch(() => null);
    if (alreadyJoined) {
      setHome(PAPERCUSP_WORKSPACE_ID);
      record('clone', 'done', { detail: 'already joined the Papercusp hive' });
      record('submodules', 'done');
      return { state: 'already-present', slug: alreadyJoined.slug };
    }
    // P-007: RESTORE-BEFORE-JOIN. Pre-position the installer-bundled seed so the
    // join's clone + federation delta-replication transfer only the delta on top.
    // The join below is UNCHANGED. Best-effort: any failure degrades to the cold
    // path and never breaks the join (a seed is untrusted cache).
    let gitDeferred = false; // P-010 live-wire 2: the encrypted git seed awaits its post-admission key.
    try {
      const restore = deps.restoreSeed ?? defaultRestoreHiveSeed;
      const seedRes = await restore(record);
      if (seedRes.deferred.includes('git')) gitDeferred = true;
      if (seedRes.ran) {
        const restored = seedRes.outcomes.filter((o) => o.ok).map((o) => o.kind);
        console.warn(
          `[papercusp-hive] seed restore: restored=[${restored.join(',')}] deferred=[${seedRes.deferred.join(',')}]`,
        );
      }
    } catch (e) {
      console.warn(`[papercusp-hive] seed restore failed (non-fatal; cold path): ${(e as Error)?.message ?? e}`);
    }

    const joinCanonical = deps.joinCanonical ?? joinCanonicalPapercuspHive;
    const joinRes = await joinCanonical(canonicalInvite, { record });

    // P-010 live-wire 2: POST-ADMISSION git-restore. The join above admitted this
    // device + delivered the hive epoch keys, so the deferred (encrypted) git seed is
    // now decryptable — restore it so the repo is pre-positioned and its later fetch
    // carries only the delta. Best-effort: only when the join succeeded AND the git
    // store was deferred; a failure degrades to the join's normal cold clone.
    if (joinRes.state === 'joined' && gitDeferred) {
      try {
        const restoreDeferred = deps.restoreDeferredGitSeed ?? defaultRestoreDeferredGitSeed;
        const gitRes = await restoreDeferred(record);
        if (gitRes.restored.length || gitRes.stillDeferred.length) {
          console.warn(
            `[papercusp-hive] post-admission seed restore: restored=[${gitRes.restored.join(',')}] stillDeferred=[${gitRes.stillDeferred.join(',')}]`,
          );
        }
      } catch (e) {
        console.warn(
          `[papercusp-hive] post-admission git seed restore failed (non-fatal; cold clone): ${(e as Error)?.message ?? e}`,
        );
      }
    }

    return joinRes.state === 'joined'
      ? { state: 'cloned-and-created', slug: joinRes.slug }
      : { state: 'skipped', slug: joinRes.slug, reason: joinRes.reason };
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
      } else if (res.code === 'auth_required') {
        // Not a failure — GitHub just isn't signed in yet. Keep the clone step at
        // 0% `running` with the sign-in prompt (banner stays visible, no error),
        // and skip; the wizard's GitHub step re-triggers the bootstrap after sign-in.
        record('clone', 'running', { percent: 0, detail: AWAITING_GH_SIGNIN_DETAIL });
        return { state: 'skipped', slug: null, reason: 'clone auth_required: awaiting GitHub sign-in' };
      } else {
        // Log the REAL failure (code + git's message) — the progress row only
        // carries the short code, so without this the operator log had no record
        // of WHY a fresh-machine clone failed (cost a full live debugging round
        // on the owner's Mac VM, 2026-06-25). `git_missing` on macOS is the
        // CLT-stub case (no bundled git); its message carries the install hint.
        console.warn(`[papercusp-hive] clone failed: ${res.code} — ${res.message}`);
        record('clone', 'error', { detail: res.code });
        return { state: 'skipped', slug: null, reason: `clone ${res.code}: ${res.message}`.slice(0, 200) };
      }
    } else {
      root = res.path;
      cloned = true;
      record('clone', 'done');
    }
  }

  // 2b. Solution C (flag-gated, default-on/reversible): adopt the owner's SHARED hive identity
  //     from their per-owner private gist BEFORE create, so the hive is created
  //     under the OWNER's identity (one federation topic across their devices)
  //     rather than a fresh per-device one. No-op when the flag is off / gh unauth /
  //     no gist yet (then this device is the creator and publishes it in step 4b).
  // BEST-EFFORT (EI-3548): adopting the owner's shared identity hits the GitHub
  // API (per-owner gist read). A transient timeout here must degrade to "this
  // device is the creator" (null), never reject the whole bootstrap.
  let sharedState: SharedHiveState | null = null;
  try {
    sharedState = await adoptShare();
  } catch (e) {
    console.warn(
      `[papercusp-hive] adoptShare failed (non-fatal; creating per-device): ${(e as Error)?.message ?? e}`,
    );
  }

  // 3. Create the single `papercusp` hive linked to the repo in place.
  const hiveRes = await ensureHive({ pathOverride: root });
  if (hiveRes.state === 'skipped') {
    record('clone', 'error', { detail: hiveRes.reason ?? 'hive create failed' });
    return { state: 'skipped', slug: null, path: root, reason: hiveRes.reason };
  }

  // 4. Make papercusp-workspace the home so the hive is VISIBLE (see header).
  setHome(PAPERCUSP_WORKSPACE_ID);

  // 4b. Solution C (flag-gated): go shared — publish the per-owner identity gist
  //     (first device only), announce on the invite topic (go-live on the
  //     federation topic), and set the owner-only allowlist policy. No-op when
  //     sharedState is null (sharing skipped this boot).
  // BEST-EFFORT (EI-3548): a GitHub-API timeout publishing the gist / announcing
  // must not fail a setup whose hive + workspace already landed — warn, proceed.
  await bestEffortShare('goShare', () => goShare(sharedState));

  // 5. Submodules. A fresh clone fills them in the BACKGROUND (non-blocking) and
  //    records the terminal `submodules` step when done — that (plus the hive
  //    existing) is what the setup-finish gate waits on. A local checkout has no
  //    submodule phase, so mark it skipped → the gate is already satisfied.
  if (cloned) {
    startSubmodulePhase(root);
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
