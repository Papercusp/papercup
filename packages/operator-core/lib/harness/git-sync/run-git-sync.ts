/**
 * The git-sync pipeline — git-sync-auto-commit. The pure-ish unit (inject `runGit`
 * + `repoPath` to test); `git-sync-action.ts` wraps it with locks, conflict
 * escalation + resolver, and routine-metadata recording.
 *
 * Syncs the WHOLE repo to origin — dynamically + recursively, no hardcoded list:
 *   - `syncOneRepo` is the per-repo primitive: commit dirty (whole-tree `git add -A`)
 *     → fetch → merge (handles diverged / non-fast-forward) → push. On a merge
 *     conflict it aborts to a CLEAN tree and reports the conflict (agents must never
 *     see a half-merged tree).
 *   - Submodules are discovered at runtime via `git submodule status --recursive`
 *     (auto-adjusts to whatever submodules exist, to any nesting depth — add/remove
 *     one and it's picked up with no code change) and synced **deepest-first**, so a
 *     child's commit is on its origin before any parent's pointer to it is pushed →
 *     a fresh clone of pushed `main` always resolves the entire tree. Each level's
 *     pointer bump shows up as a dirty change when its parent is synced.
 *   - The superproject is synced last.
 *   - EI-18689553108460319: whether the SUPERPROJECT pushes (`GitSyncConfig.push`) and
 *     whether SUBMODULES push to their own origins (`GitSyncConfig.pushSubmoduleOrigins`)
 *     are INDEPENDENT knobs. A bridged/p2p-only hive sets `push:false` so its bridge
 *     writer stays the sole pusher of the hive's own canonical superproject refs — that
 *     never implies submodules (unrelated, independently-hosted GitHub libs) should also
 *     go commit-only; nothing else ever pushes them, so doing so silently strands their
 *     history forever (8 days / 65 commits observed on `libs/generic/sync` before this fix).
 *
 * git-sync DELIBERATELY `git add -A`s each repo (unlike the SCOPED git-export
 * committer in `git-committer.ts`) — owning the whole-tree commit is its entire
 * purpose (it's why agents stop committing).
 *
 * WI-1416: the pass is CHECKPOINTABLE — three phases (`git-sync:submodules` →
 * `git-sync:pointer-bump` → `git-sync:push`) run under the injectable
 * `RunGitSyncOpts.step` seam so a durable caller records one DBOS
 * operation_output per phase, and every git subprocess is time-bounded (the hang
 * guard below). See GitSyncStepRunner for the replay-safety contract.
 */
import { spawn } from 'node:child_process';
import { collectChildOutput } from '../../child-output.js';
import { lstat, readFile, readlink, readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectDirForSlug } from '../../operator-notes';
import { gitSidecarEnabled, noteSidecarFallback, runGitViaSpawnerSidecar } from '../../fleet/git-via-sidecar';
import { detectContentOffenders, parseDirtyPaths, type ContentOffender } from './content-guard';
import { detectUnsafeDeletions, normalizeModulePath, RESOLVABLE_EXTS } from './deletion-import-guard';
import { detectWholesaleDeletion } from './wholesale-deletion-guard';
import { detectQuarantineImporters } from './quarantine-import-guard';
import { DEFAULT_CONTENT_DETECTORS, type ContentDetector } from '../../content-lint/registry';
import {
  groupFilesForAttribution,
  attributionMapForRepo,
  diffDerivedSubject,
  parseNumstat,
  DEFAULT_GIT_SYNC_SUBJECT,
  type FileAttribution,
  type AttributionRosterEntry,
} from './git-sync-attribution';

export type RunGit = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;

const envMs = (name: string, dflt: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

/** Subcommands that touch the network (a hung remote must fail fast, not stall the fire). */
const GIT_NETWORK_SUBCOMMANDS = new Set(['fetch', 'push', 'pull', 'ls-remote', 'clone']);

/**
 * WI-5111: git-sync commits under the box's GLOBAL git identity, which on every
 * shared dev box is the OWNER's own `user.name`/`user.email` (agents never commit
 * under their own identity — CLAUDE.md "git-sync owns commit + push — you do
 * neither"). The result: `git blame` / `git log --format=%an` on EVERY line of
 * EVERY file returns the owner's name, indistinguishable from the owner having
 * typed the change himself. This is not a harmless dead end (an agent that trusts
 * blame just gets "unknown") — it is a FALSE-POSITIVE generator (an agent gets a
 * confident, wrong, and highly plausible answer). Observed harm: a release-fixer's
 * blame-the-regression triage escalated an AGENT's own incomplete migration to the
 * owner as a blocker, in the second person ("YOUR migration ... YOU updated"),
 * entirely on the strength of `git blame` (escalation mro7nmi5, 2026-07-17).
 *
 * Fix: EVERY git-sync commit is made under this bot identity via `-c user.name=`
 * / `-c user.email=` (per-invocation override — never touches the box's global git
 * config, so an interactive `git commit` elsewhere on the box is unaffected).
 * Blame now visibly shows a bot, an agent cannot form "the owner wrote this", and
 * a REAL owner commit (there are none on this tree going forward, but historical
 * ones stay as-is) is trivially distinguishable from the automation. Prepended
 * BEFORE the subcommand in the argv (gitSubcommand already special-cases `-c`
 * pairs when reading past them for the timeout/network classification above).
 */
export const GIT_SYNC_BOT_NAME = 'papercusp-git-sync';
/**
 * GitHub rejects pushes whose commit author email is not verified on the
 * authenticated account. Keep the bot name for attribution, but use the
 * papercupai no-reply identity already used by the repository's publishing
 * path so automated superproject pushes are accepted.
 */
export const GIT_SYNC_BOT_EMAIL = 'papercupai@users.noreply.github.com';
const GIT_SYNC_IDENTITY_ARGS = ['-c', `user.name=${GIT_SYNC_BOT_NAME}`, '-c', `user.email=${GIT_SYNC_BOT_EMAIL}`];

/** The git SUBCOMMAND in an argv — skipping leading global flags AND the separate
 *  value a `-c`/`-C` option consumes (`['-c','x=y','fetch']` → 'fetch', not 'x=y'). */
const gitSubcommandIndex = (args: string[]): number => {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-c' || a === '-C') {
      i++; // the option's value rides in the NEXT token
      continue;
    }
    if (a.startsWith('-')) continue;
    return i;
  }
  return -1;
};

const gitSubcommand = (args: string[]): string => {
  const index = gitSubcommandIndex(args);
  return index >= 0 ? args[index] : '';
};

/** Network commands whose native progress stream can drive the idle watchdog.
 * Git suppresses progress when stderr is not a TTY unless `--progress` is explicit;
 * git-sync always pipes stderr, so without this flag a healthy multi-GB fetch looks
 * exactly like a wedged child until it finishes. */
const GIT_PROGRESS_SUBCOMMANDS = new Set(['fetch', 'push', 'pull', 'clone']);

const withGitProgress = (args: string[]): string[] => {
  const index = gitSubcommandIndex(args);
  if (index < 0 || !GIT_PROGRESS_SUBCOMMANDS.has(args[index])) return args;
  if (args.includes('--progress') || args.includes('--no-progress')) return args;
  return [...args.slice(0, index + 1), '--progress', ...args.slice(index + 1)];
};

/**
 * WI-1416 hang guard: the idle ceiling for one git subprocess. Local commands retain
 * the original wall-clock behavior. Network commands refresh this deadline whenever
 * their forced progress stream advances, so a healthy large transfer may outlive four
 * minutes while a silent/wedged remote still fails fast. The independent hard ceiling
 * below prevents an endlessly-chatty broken child from living forever.
 *
 * Env-tunable: PAPERCUSP_GIT_SYNC_NETWORK_TIMEOUT_MS (idle),
 * PAPERCUSP_GIT_SYNC_NETWORK_HARD_TIMEOUT_MS, PAPERCUSP_GIT_SYNC_LOCAL_TIMEOUT_MS.
 */
export const gitTimeoutMsFor = (args: string[]): number =>
  GIT_NETWORK_SUBCOMMANDS.has(gitSubcommand(args))
    ? envMs('PAPERCUSP_GIT_SYNC_NETWORK_TIMEOUT_MS', 4 * 60_000)
    : envMs('PAPERCUSP_GIT_SYNC_LOCAL_TIMEOUT_MS', 6 * 60_000);

export const gitHardTimeoutMsFor = (args: string[], idleTimeoutMs = gitTimeoutMsFor(args)): number =>
  GIT_NETWORK_SUBCOMMANDS.has(gitSubcommand(args))
    ? Math.max(idleTimeoutMs, envMs('PAPERCUSP_GIT_SYNC_NETWORK_HARD_TIMEOUT_MS', 60 * 60_000))
    : idleTimeoutMs;

/** Spawn `git <args>` in `cwd`, capturing exit code + output, bounded by `timeoutMs`
 *  (never throws, never hangs). Exported so the hang guard is directly testable.
 *  WI-3793: now backed by the shared, defensively-guarded
 *  `isSidecarEnabledFromEnv` (same enable/mode-var pattern every node-child
 *  sidecar shares) instead of a hand-rolled inline check — behavior is
 *  unchanged (this was already the ONE call site with the `_MODE` guard). */
export function gitSyncSidecarEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return gitSidecarEnabled('PAPERCUSP_GIT_SYNC_SPAWN_SIDECAR', env);
}

const runGitLocalBounded = (
  args: string[],
  cwd: string,
  idleTimeoutMs: number,
  hardTimeoutMs: number,
  progressAware: boolean,
): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    // P-011 (git-sync-dx-hardening): pin a C/English locale so git's human-readable
    // output (push-rejection markers like "[rejected]" / "non-fast-forward", merge text)
    // is DETERMINISTIC regardless of the host's LANG — the non-FF detection + other output
    // parsing is then reliable at the root, rather than depending on the operator's locale.
    //
    // PAPERCUSP_GIT_SYNC_PUSH=1: mark EVERY git invocation from the git-sync runner so the
    // local pre-push hook (bin/git-hooks/pre-push) recognizes the automated git-sync push and
    // SKIPS its `test:affected` author-warning gate. git-sync must stay fast + non-blocking
    // (it commits with `--no-verify`, but `push` is NOT exempted from pre-push), so without
    // this marker the hook would run the affected suite on the scheduled push and wedge
    // git-sync. Mirrors green-checkpoint's PAPERCUSP_MAIN_PUSH_OK=1 push-marker pattern. The
    // hook only acts on `push`, so setting it on all git-sync git calls is harmless.
    const child = spawn('git', args, {
      cwd,
      env: {
        ...process.env,
        LC_ALL: 'C',
        LANG: 'C',
        PAPERCUSP_GIT_SYNC_PUSH: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
    });
    const out = collectChildOutput(child);
    let settled = false;
    let terminating = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let hardTimer: ReturnType<typeof setTimeout> | null = null;
    const clearTimers = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      if (hardTimer) clearTimeout(hardTimer);
    };
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve({ code, stdout: out.stdout.text(), stderr: out.stderr.text() });
    };
    const terminate = (reason: string): void => {
      if (settled || terminating) return;
      terminating = true;
      clearTimers();
      out.stderr.append(
        `${out.stderr.peek() ? '\n' : ''}git ${args.join(' ')} ${reason} — killed by the git-sync hang guard`,
      );
      // WI-1416: SIGTERM first (git traps it and cleans its lock files), SIGKILL
      // after a grace, and a last-resort resolve if `close` never fires.
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 10_000).unref?.();
      setTimeout(() => finish(-1), 20_000).unref?.();
    };
    const armIdleTimer = (): void => {
      if (!progressAware || settled || terminating) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => terminate(`made no output progress for ${idleTimeoutMs}ms`), idleTimeoutMs);
      idleTimer.unref?.();
    };

    if (progressAware) {
      // `collectChildOutput` owns decoding; these listeners only observe byte
      // arrival and therefore cannot split/corrupt a multi-byte character.
      child.stdout?.on('data', armIdleTimer);
      child.stderr?.on('data', armIdleTimer);
      armIdleTimer();
      hardTimer = setTimeout(
        () => terminate(`exceeded the ${hardTimeoutMs}ms hard ceiling despite output progress`),
        hardTimeoutMs,
      );
      hardTimer.unref?.();
    } else {
      hardTimer = setTimeout(() => terminate(`timed out after ${hardTimeoutMs}ms`), hardTimeoutMs);
      hardTimer.unref?.();
    }
    child.on('error', (e) => {
      out.stderr.append(String(e));
      finish(-1);
    });
    child.on('close', (code) => finish(code ?? -1));
  });

export const runGitBounded = async (
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> => {
  // P-011 (git-sync-dx-hardening): pin a C/English locale so git's human-readable
  // output (push-rejection markers like "[rejected]" / "non-fast-forward", merge text)
  // is DETERMINISTIC regardless of the host's LANG — the non-FF detection + other output
  // parsing is then reliable at the root, rather than depending on the operator's locale.
  //
  // PAPERCUSP_GIT_SYNC_PUSH=1: mark EVERY git invocation from the git-sync runner so the
  // local pre-push hook (bin/git-hooks/pre-push) recognizes the automated git-sync push and
  // SKIPS its `test:affected` author-warning gate. git-sync must stay fast + non-blocking
  // (it commits with `--no-verify`, but `push` is NOT exempted from pre-push), so without
  // this marker the hook would run the affected suite on the scheduled push and wedge
  // git-sync. Mirrors green-checkpoint's PAPERCUSP_MAIN_PUSH_OK=1 push-marker pattern. The
  // hook only acts on `push`, so setting it on all git-sync git calls is harmless.
  const network = GIT_NETWORK_SUBCOMMANDS.has(gitSubcommand(args));
  const effectiveArgs = network ? withGitProgress(args) : args;
  const hardTimeoutMs = gitHardTimeoutMsFor(args, timeoutMs);
  // git-sync is unattended. A credential helper may answer, but an interactive
  // prompt can never make progress and would otherwise survive until the network
  // hang guard fires.
  const env = {
    ...process.env,
    LC_ALL: 'C',
    LANG: 'C',
    PAPERCUSP_GIT_SYNC_PUSH: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  if (gitSyncSidecarEnabled()) {
    try {
      return await runGitViaSpawnerSidecar(effectiveArgs, cwd, hardTimeoutMs, env, {
        idleTimeoutMs: network ? timeoutMs : undefined,
      });
    } catch (e) {
      // Was a console.warn PER CALL — the opposite failure from warn-once, and
      // just as unhelpful: a sustained outage buries the log without ever
      // stating a rate. The shared seam bounds the cadence and carries the
      // cumulative count.
      noteSidecarFallback('git-sync', e);
    }
  }
  return runGitLocalBounded(effectiveArgs, cwd, timeoutMs, hardTimeoutMs, network);
};

/** Spawn `git <args>` in `cwd` with the default per-subcommand ceiling (never throws). */
const defaultRunGit: RunGit = (args, cwd) => runGitBounded(args, cwd, gitTimeoutMsFor(args));

const TOOL_CATALOG_GENERATOR_PATH = 'scripts/gen-tool-catalog.ts';
const TOOL_CATALOG_ARTIFACT_PATH = '.papercusp/tool-catalog.json';
const TOOL_CATALOG_TRACKED_PATHS = [TOOL_CATALOG_GENERATOR_PATH, TOOL_CATALOG_ARTIFACT_PATH] as const;

/** The exact source surface guarded by affected-tests.mjs's gen:tool-catalog:check entry. */
export function affectsToolCatalog(path: string): boolean {
  return (
    (path.startsWith('packages/operator-core/lib/agent-tools/') && !path.endsWith('.test.ts')) ||
    (path.startsWith('packages/agent-mcp/src/') && !path.endsWith('.test.ts')) ||
    (path.startsWith('libs/generic/tooldef/src/') && !path.endsWith('.test.ts')) ||
    path === TOOL_CATALOG_GENERATOR_PATH ||
    path === TOOL_CATALOG_ARTIFACT_PATH
  );
}

export interface ToolCatalogGeneratorResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type RunToolCatalogGenerator = (repoPath: string) => Promise<ToolCatalogGeneratorResult>;

export interface ToolCatalogRegeneratorContext {
  runGit: RunGit;
  repoPath: string;
  log: (message: string) => void;
}

export type ToolCatalogRegenerator = (context: ToolCatalogRegeneratorContext) => Promise<void>;

/**
 * Run the catalog writer in a bounded child. The generator cold-imports the full
 * registry, so a peer's half-written tool module can make that import hang or
 * fail; neither condition may wedge the fleet-wide git-sync commit path.
 */
const defaultRunToolCatalogGenerator: RunToolCatalogGenerator = (repoPath) =>
  new Promise((resolve) => {
    const timeoutMs = envMs('PAPERCUSP_GIT_SYNC_TOOL_CATALOG_TIMEOUT_MS', 60_000);
    const child = spawn(join(repoPath, 'node_modules', '.bin', 'tsx'), [TOOL_CATALOG_GENERATOR_PATH], {
      cwd: repoPath,
      env: process.env,
    });
    const out = collectChildOutput(child);
    let settled = false;
    let timedOut = false;
    let closeFallback: ReturnType<typeof setTimeout> | null = null;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      if (closeFallback) clearTimeout(closeFallback);
      resolve({ code, stdout: out.stdout.text(), stderr: out.stderr.text() });
    };
    const killer = setTimeout(() => {
      timedOut = true;
      out.stderr.append(`${out.stderr.peek() ? '\n' : ''}tool-catalog regeneration timed out after ${timeoutMs}ms`);
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      // A broken child implementation must not defeat the timeout by never
      // emitting close after the kill.
      closeFallback = setTimeout(() => finish(-1), 5_000);
      closeFallback.unref?.();
    }, timeoutMs);
    killer.unref?.();
    child.on('error', (e) => {
      out.stderr.append(`${out.stderr.peek() ? '\n' : ''}${String(e)}`);
      finish(-1);
    });
    child.on('close', (code) => finish(timedOut ? -1 : (code ?? -1)));
  });

/**
 * Regenerate the tracked tool catalog immediately before the superproject
 * commit when a dirty source path can affect it. This is intentionally
 * FAIL-SOFT: status/tracking checks, generator throws, nonzero exits, and
 * timeouts are logged and return normally so a transient registry refactor can
 * never stop git-sync from committing the rest of the shared tree.
 */
export async function regenerateToolCatalogBeforeCommit(
  context: ToolCatalogRegeneratorContext,
  runGenerator: RunToolCatalogGenerator = defaultRunToolCatalogGenerator,
): Promise<void> {
  const { runGit, repoPath, log } = context;
  try {
    const status = await runGit(['status', '--porcelain', '-z', '-uall'], repoPath);
    if (status.code !== 0) {
      log(`[git-sync] ${repoPath}: could not inspect dirty paths for tool-catalog regeneration — skipping fail-soft`);
      return;
    }
    const affected = parseDirtyPaths(status.stdout).filter(affectsToolCatalog);
    if (affected.length === 0) return;

    // Do not run this papercusp-specific generator in arbitrary repositories
    // that merely happen to contain a similarly named dirty path.
    const tracked = await runGit(['ls-files', '--', ...TOOL_CATALOG_TRACKED_PATHS], repoPath);
    const trackedPaths = new Set(
      tracked.stdout
        .split('\n')
        .map((p) => p.trim())
        .filter(Boolean),
    );
    if (tracked.code !== 0 || !TOOL_CATALOG_TRACKED_PATHS.every((path) => trackedPaths.has(path))) return;

    const artifactPath = join(repoPath, TOOL_CATALOG_ARTIFACT_PATH);
    let original: string | null = null;
    try {
      original = await readFile(artifactPath, 'utf8');
    } catch {
      /* missing artifact is restored to missing if the writer fails */
    }

    let result: ToolCatalogGeneratorResult;
    try {
      result = await runGenerator(repoPath);
    } catch (e) {
      result = { code: -1, stdout: '', stderr: String(e) };
    }
    if (result.code !== 0) {
      // A synchronous write can truncate before throwing. Restore the pre-run
      // artifact so a failed repair never turns a merely stale catalog into a
      // corrupt one that the catch-all commit could publish.
      try {
        if (original == null) await unlink(artifactPath).catch(() => {});
        else await writeFile(artifactPath, original, 'utf8');
      } catch (e) {
        log(`[git-sync] ${repoPath}: failed to restore tool catalog after generator failure: ${String(e)}`);
      }
      const detail = (result.stderr || result.stdout || `exit ${result.code}`).trim().slice(0, 300);
      log(
        `[git-sync] ${repoPath}: tool-catalog regeneration failed (${detail}) — continuing with the commit fail-soft; the downstream catalog check remains the detector`,
      );
      return;
    }
    log(
      `[git-sync] ${repoPath}: regenerated ${TOOL_CATALOG_ARTIFACT_PATH} before commit (${affected.length} catalog-affecting dirty path(s))`,
    );
  } catch (e) {
    log(
      `[git-sync] ${repoPath}: tool-catalog pre-commit repair threw (${String(e)}) — continuing with the commit fail-soft`,
    );
  }
}

const GITHUB_HTTPS_INSTEAD_OF_ARGS = ['-c', 'url.https://github.com/.insteadOf=git@github.com:'] as const;

/**
 * The one SSH-auth failure for which git-sync has an equivalent configured
 * credential plane to try. Keep this exact: network failures, repository
 * authorization failures, and non-GitHub SSH hosts need their original error.
 */
export const isGitHubSshPublicKeyFailure = (result: { stdout: string; stderr: string }): boolean =>
  /git@github\.com:\s*Permission denied \(publickey\)\.?/i.test(`${result.stdout}\n${result.stderr}`);

/** GitHub can authenticate an SSH key successfully and still reject every write because the
 *  account behind that key has no verified email. The configured HTTPS credential may belong to
 *  a different, write-capable automation account, so this is the same credential-plane failure
 *  class as a missing SSH key — but only after the configured remote is proven to be GitHub SSH. */
export const isGitHubSshEmailVerificationFailure = (result: {
  stdout: string;
  stderr: string;
}): boolean => /(?:remote:\s*)?You must verify your email address\.?/i.test(`${result.stdout}\n${result.stderr}`);

const isGitHubSshRemoteUrl = (url: string): boolean =>
  /^(?:git@github\.com:|ssh:\/\/git@github\.com\/)/i.test(url.trim());

/**
 * Retry one GitHub fetch/push through the existing HTTPS credential helper when
 * SSH has no usable public key. The -c override is process-local: canonical
 * remotes and .gitmodules remain untouched, and no credential is put in argv.
 */
const runNetworkGitWithGitHubHttpsFallback = async (
  runGit: RunGit,
  args: string[],
  cwd: string,
  log: (message: string) => void,
): ReturnType<RunGit> => {
  const first = await runGit(args, cwd);
  const command = gitSubcommand(args);
  const publicKeyFailure = isGitHubSshPublicKeyFailure(first);
  const emailVerificationFailure = isGitHubSshEmailVerificationFailure(first);
  if (
    first.code === 0 ||
    (command !== 'fetch' && command !== 'push') ||
    (!publicKeyFailure && !emailVerificationFailure)
  ) {
    return first;
  }

  // Unlike the public-key error, GitHub's email-policy response does not name the SSH host.
  // Prove the remote before applying the process-local insteadOf rewrite; an HTTPS or non-GitHub
  // account-policy failure must retain its original result rather than retrying the same plane.
  if (emailVerificationFailure && !publicKeyFailure) {
    const remote = args[1];
    if (!remote) return first;
    const remoteUrl = isGitHubSshRemoteUrl(remote)
      ? remote
      : (await runGit(['remote', 'get-url', remote], cwd)).stdout.trim();
    if (!isGitHubSshRemoteUrl(remoteUrl)) return first;
  }

  log(
    `[git-sync] ${cwd}: GitHub SSH ${
      publicKeyFailure ? 'publickey authentication failed' : 'account requires email verification'
    } during ${command}; retrying once through configured HTTPS credentials`,
  );
  return runGit([...GITHUB_HTTPS_INSTEAD_OF_ARGS, ...args], cwd);
};

/** GitHub hard-rejects blobs ≥100MB (pre-receive) — a committed oversized blob makes
 *  the whole unpushed range PERMANENTLY unpushable (EI-18: 10.4GB of Rust target/
 *  artifacts wedged the push for 20h). Stay safely under. */
export const DEFAULT_MAX_BLOB_BYTES = 95 * 1024 * 1024;
/**
 * WI-5738: cap on the CUMULATIVE size of one auto-commit's dirty set. Set well
 * under the publish guard's DEFAULT_MAX_PUBLISH_TOTAL_BYTES (500 MB) so the
 * commit-side gate — where the response is a cheap exclusion — always fires
 * BEFORE the publish-side one, where the only response was a terminal refusal.
 * The headroom also absorbs several commits accumulating between publish ticks.
 */
export const DEFAULT_MAX_COMMIT_TOTAL_BYTES = 250 * 1024 * 1024;

export interface GitSyncConfig {
  /** Push the SUPERPROJECT to its origin after committing/merging (default true).
   *  Does NOT control submodule pushes — see `pushSubmoduleOrigins` (EI-18689553108460319:
   *  these used to share one flag, so a bridged/p2p-only hive setting this false to keep
   *  the bridge writer the sole pusher of the hive's own canonical refs silently ALSO
   *  stranded every submodule's commits — unrelated vendored libraries with their own
   *  GitHub origins that nothing else ever pushes). */
  push?: boolean;
  /** Sync submodules too (default true). When true, ALL submodules are synced
   *  recursively — discovery is dynamic, never a fixed list. */
  pushSubmodules?: boolean;
  /** Push SUBMODULE repos to THEIR OWN origins (default true) — independent of `push`,
   *  which now controls the superproject only (EI-18689553108460319). A bridged/p2p-only
   *  hive's `push:false` exists so the bridge writer stays the sole pusher of the hive's
   *  own canonical superproject refs (github-bridge-hive-egress P-003/S-1); that rationale
   *  does not extend to submodules, each an independent GitHub repo the bridge never
   *  touches — so they keep pushing normally unless this is explicitly set false too. */
  pushSubmoduleOrigins?: boolean;
  /** Reconcile the SUPERPROJECT worktree with its configured Git remote
   *  (fetch + merge) before an optional push. Default true.
   *
   *  Non-legacy P2P hives set this false: their dedicated GitHub-ingress leg
   *  imports GitHub heads into the bare P2P store and their worktree-bridge leg
   *  advances the checkout from the admitted canonical staging ref. Running a
   *  second direct origin merge here bypasses that admission path and makes an
   *  installer seed look perpetually unconverted when the two histories are
   *  intentionally unrelated. Submodule origin syncing remains independent. */
  reconcileSuperprojectOrigin?: boolean;
  /**
   * Reconcile a fully represented release `main` commit into a commit-only
   * `staging` worktree without importing any GitHub content (default false).
   *
   * Bridged hives deliberately disable `reconcileSuperprojectOrigin`: GitHub
   * ingress/admission and the P2P worktree bridge own content flow. Frozen
   * repair promotion can nevertheless leave `main` as a sibling whose exact
   * tree changes are already present on staging. When this explicit knob is
   * enabled, git-sync may record only that proven ancestry with an `ours`
   * merge. The helper declines on an unrelated lineage or any differing tree
   * entry, so this never bypasses admission for new content.
   */
  bridgeContainedReleaseMainOnCommitOnly?: boolean;
  /** Branch to sync when a repo is on a branch / for the superproject (default 'main'). */
  branch?: string;
  /** Remote name (default 'origin'). */
  remote?: string;
  /** Commit subject (a default is used otherwise). */
  message?: string;
  /** Dirty files larger than this are EXCLUDED from the auto-commit and reported
   *  (`oversized` on the outcome) instead of wedging the push forever
   *  (default DEFAULT_MAX_BLOB_BYTES). */
  maxBlobBytes?: number;
  /** WI-5738: dirty files are excluded largest-first once the CUMULATIVE dirty
   *  set exceeds this (default DEFAULT_MAX_COMMIT_TOTAL_BYTES) — the gate that
   *  catches a bulk accident whose individual files are all under maxBlobBytes. */
  maxCommitTotalBytes?: number;
}

/** One (sub)repo that hit a merge conflict during a pass. */
export interface RepoConflict {
  /** Which repo conflicted: 'superproject' or a submodule path (repo-relative). */
  scope: string;
  conflictedFiles: string[];
}
/** One (sub)repo that errored (e.g. a push that wasn't a recoverable non-ff). */
export interface RepoError {
  scope: string;
  message: string;
}
/** A dirty file excluded from the auto-commit because it exceeds maxBlobBytes. */
export interface OversizedFile {
  path: string;
  sizeBytes: number;
}
/** An oversized file, qualified by which repo it sits in. */
export interface ScopedOversized extends OversizedFile {
  /** 'superproject' or a submodule path (repo-relative). */
  scope: string;
}
/** A content-guard offender (EI-438), qualified by which repo it sits in. The
 *  action layer escalates these + dispatches a content-fixer (git-sync-action). */
export interface ScopedContentError extends ContentOffender {
  /** 'superproject' or a submodule path (repo-relative). */
  scope: string;
}

/**
 * EI-20402093158205519: a submodule that is POPULATED on disk and holds uncommitted
 * TRACKED changes, but is absent from `.git/config` (`git submodule init` never ran).
 * `git submodule status` marks it '-', discovery skips it, and git-sync therefore never
 * visits the repo at all — so the edits are invisible to every tick, forever, with no
 * error anywhere. Measured on the sidestage hive 2026-08-14: 7 of 8 submodules '-'-flagged
 * but fully populated; discovery returned 1 path; 3 tracked files sat stranded across two
 * repos while the routine reported a clean 'synced' every tick.
 *
 * This is NOT an error the pass can fix, and deliberately does NOT make the pass
 * `status:'error'` — that would defer the superproject push on EVERY tick and wedge the
 * whole hive over a condition git-sync must not auto-resolve (registering a deliberately
 * pinned worktree would fetch/merge/push it and UNPIN it). It rides its own escalation
 * row instead: visible and queryable, non-blocking, self-clearing.
 */
export interface StrandedSubmodule {
  /** Repo-relative submodule path, e.g. 'libs/papergrid'. */
  path: string;
  /** Count of TRACKED modified files. Untracked scratch (.vitest-tmp/ &c.) is excluded
   *  on purpose — counting it would cry wolf on every tick a test run is in flight. */
  trackedFiles: number;
  /** The tracked porcelain paths, capped for the escalation body. */
  files: string[];
}

/**
 * The aggregate result of one whole-repo pass. `pushed`/`merged` name the scopes
 * ('superproject' or submodule paths) that were pushed to / merged from origin, so
 * a caller can report exactly what moved. A pass NO LONGER stops at the first
 * conflict: it reconciles every submodule it can, COLLECTS conflicts/errors, and
 * only defers the superproject (see runGitSync). `status` is the worst outcome:
 * any conflict → 'conflict', else any error → 'error', else 'synced'/'nothing'.
 */
export type GitSyncOutcome = {
  /** Dirty files excluded from this pass's auto-commits for exceeding maxBlobBytes
   *  (EI-18). Non-empty = someone must gitignore/remove them — this NEVER self-heals;
   *  the caller escalates. Present on every status ('nothing' included: an
   *  oversized-only dirty tree commits nothing but still reports). */
  oversized: ScopedOversized[];
  /** Dirty files EXCLUDED from this pass's auto-commits because a content detector
   *  flagged them (EI-438 — e.g. an .mdx that won't compile). Like `oversized`, the
   *  rest of the tree still commits (D-001 quarantine-don't-stall); the action layer
   *  escalates these + dispatches a content-fixer, which self-heals on a later tick.
   *  Present on every status. */
  contentErrors: ScopedContentError[];
  /** EI-20402093158205519: populated-but-unregistered submodules holding uncommitted
   *  tracked work this pass could not see (see StrandedSubmodule). Present on every
   *  status — a strand is orthogonal to whether the visible tree synced, and reporting
   *  it ONLY on failure is precisely the silence that let it run for hours: the pass
   *  that strands work is otherwise a perfectly clean 'synced'.
   *
   *  `null` means NOT MEASURED this pass (discovery failed, or a submodulePaths override
   *  bypassed it) and is deliberately distinct from `[]` (measured, nothing stranded).
   *  Collapsing the two would let an unmeasured pass retire a live warning — the exact
   *  failure mode this whole field exists to prevent, reintroduced one level up. The
   *  nullable type forces every consumer to decide which it is. */
  strandedSubmodules: StrandedSubmodule[] | null;
  /**
   * Scopes whose fetch+merge stage completed successfully this pass, even when a
   * later push failed. This is distinct from `merged`: it proves that the merge
   * stage ran without a conflict and is safe for escalation clearing.
   */
  mergeCompleted?: string[];
} & (
  | { status: 'nothing' }
  | { status: 'synced'; headSha: string; pushed: string[]; merged: string[] }
  | { status: 'conflict'; conflicts: RepoConflict[]; errors: RepoError[]; pushed: string[]; merged: string[] }
  | { status: 'error'; errors: RepoError[]; pushed: string[]; merged: string[] }
);

/**
 * WI-1416: the seam a durable caller (git-sync-action inside a DBOS routineFire)
 * threads checkpointing through. Each pipeline PHASE (`git-sync:submodules` →
 * `git-sync:pointer-bump` → `git-sync:push`) runs under `step(name, fn)` so the
 * workflow records one operation_output per phase: the executor reaper sees genuine
 * progress (function_id > 0), and a crashed/resumed fire REPLAYS completed phases
 * from their checkpoints instead of re-running them. Defaults to a passthrough
 * (unit tests / fireGitSyncNow outside any workflow).
 *
 * REPLAY SAFETY (the hard constraint): every phase is idempotent against a re-run —
 * a replayed commit finds a clean tree (`nothing to commit` is benign), a replayed
 * push is `Everything up-to-date`, a replayed merge re-fetches — so neither a DBOS
 * step retry nor a reaped-and-requeued fire can double-commit.
 */
export type GitSyncStepRunner = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

export interface RunGitSyncOpts {
  /**
   * Override the repo path (manual-fire pin + tests); else resolve via
   * `projectDirForSlug(slug)`. An explicit null is authoritative: the caller
   * already performed a scoped lookup and found no registered tree.
   */
  repoPath?: string | null;
  /** Inject the git runner (tests). */
  runGit?: RunGit;
  /** WI-1416: run each pipeline phase as a checkpointed durable step (see
   *  GitSyncStepRunner). Default: plain passthrough execution. */
  step?: GitSyncStepRunner;
  config?: GitSyncConfig;
  /** Override submodule discovery (tests). Repo-relative paths. */
  submodulePaths?: string[];
  /**
   * Caller-supplied paths that must remain outside this tick's commits. Paths are
   * superproject-root-relative, matching the live roster/current_files contract;
   * submodule paths are mapped to that repo's relative coordinate space below.
   */
  excludePaths?: string[];
  /** Override the content-guard detector registry (tests / future extension).
   *  Defaults to DEFAULT_CONTENT_DETECTORS (mdx + smart-quotes). Pass [] to disable. */
  contentDetectors?: ContentDetector[];
  /** EI-17: the deletion-import guard (kill-switch: FLAGS.GIT_SYNC_DELETION_GUARD).
   *  Default true. When false, a dirty deletion is never checked against surviving
   *  imports — byte-identical to pre-EI-17 behavior (the instant off-switch on this
   *  shared commit path, no deploy needed, mirroring GIT_SYNC_CONTENT_GUARD). */
  deletionGuard?: boolean;
  /** Read a repo-relative file's working-tree text for the content guard (tests).
   *  Defaults to fs read; null on any error. */
  readText?: (repoPath: string, relPath: string) => Promise<string | null>;
  /** Write a repo-relative file's working-tree text for deterministic content repairs (tests).
   *  Defaults to fs write; the content guard re-checks its CAS before calling this. */
  writeText?: (repoPath: string, relPath: string, text: string) => Promise<void>;
  log?: (m: string) => void;
  /** P-004 (flag GIT_SYNC_DERIVED_ATTRIBUTION): the caller supplies the live roster of active
   *  agents + their declared files (built flag-gated from coord presence). When present, git-sync
   *  derives a per-repo attribution map and peels per-agent commits; when absent (flag OFF / no
   *  caller) commits are unchanged (today's single whole-tree commit). DERIVED, never authored. */
  loadRoster?: () => Promise<AttributionRosterEntry[]>;
  /** WI-38594 (flag GIT_SYNC_DIFF_SUBJECTS, default ON): commit subjects are DIFF-derived
   *  (`sync(<areas>): <what> (<n> files, +A/-D)`) with the agent's intent line demoted to
   *  the commit body. false = the pre-WI-38594 subjects (intent line / message stem). */
  diffSubjects?: boolean;
  /** WI-EI-20224214315801764: override the age floor for crash-left `tmp_pack_*` files. */
  staleTempPackMs?: number;
  /** Test seam for proving whether a candidate temp pack is still open by a process.
   *  `null` means the state is unknown; unknown is always preserved. */
  isTempPackOpen?: (path: string) => Promise<boolean | null>;
  /** WI-39922: pre-superproject-commit repair for the tracked tool catalog.
   *  Defaults to the conditional, bounded, fail-soft regenerator above. */
  toolCatalogRegenerator?: ToolCatalogRegenerator;
}

/** Default content-guard file reader — the working-tree bytes that `add -A` would
 *  commit; null on any error (gone/binary/permission) so the guard fails open. */
const defaultReadText = async (repoPath: string, relPath: string): Promise<string | null> => {
  try {
    return await readFile(join(repoPath, relPath), 'utf8');
  } catch {
    return null;
  }
};

/** Default content-guard writer — UTF-8 working-tree text for deterministic repairs. */
const defaultWriteText = async (repoPath: string, relPath: string, text: string): Promise<void> => {
  await writeFile(join(repoPath, relPath), text, 'utf8');
};

const isDirty = async (runGit: RunGit, repo: string): Promise<boolean> => {
  const r = await runGit(['status', '--porcelain'], repo);
  return r.code === 0 && r.stdout.trim().length > 0;
};

/** Candidate HEAD paths for the same module resolution key used by the
 * quarantine-import guard. The exact path is checked first, then the normal JS/
 * TS extensions and directory index forms so a quarantined `foo.ts` does not
 * infect an importer when a committed `foo.js` or `foo/index.ts` still resolves. */
function headModuleCandidates(relPath: string): string[] {
  const normalized = normalizeModulePath(relPath);
  return [
    ...new Set([
      relPath,
      ...RESOLVABLE_EXTS.map((ext) => `${normalized}${ext}`),
      ...RESOLVABLE_EXTS.map((ext) => `${normalized}/index${ext}`),
    ]),
  ];
}

async function isModuleResolvableAtHead(
  runGit: RunGit,
  repoPath: string,
  relPath: string,
  log: (m: string) => void,
): Promise<boolean> {
  for (const candidate of headModuleCandidates(relPath)) {
    try {
      const result = await runGit(['cat-file', '-e', `HEAD:${candidate}`], repoPath);
      if (result.code === 0) return true;
    } catch (e) {
      // A HEAD probe is a safety refinement, not a reason to wedge git-sync. If
      // it cannot be measured, retain the guard's conservative quarantine.
      log(`[quarantine-import-guard] HEAD probe failed for ${relPath}: ${String(e)}`);
      return false;
    }
  }
  return false;
}

/** Current branch name, or null when HEAD is detached. */
const currentBranch = async (runGit: RunGit, repo: string): Promise<string | null> => {
  const r = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], repo);
  return r.code === 0 ? r.stdout.trim() : null;
};

/** The remote's default branch — `git rev-parse --abbrev-ref <remote>/HEAD` →
 *  "<remote>/main" → "main". Resolves the sync branch for a DETACHED HEAD (P-004):
 *  a fresh `git submodule update` leaves submodules detached, and they must sync to
 *  their OWN default (main), not the superproject's branch. Null when <remote>/HEAD
 *  isn't set. */
const remoteDefaultBranch = async (runGit: RunGit, repo: string, remote: string): Promise<string | null> => {
  const r = await runGit(['rev-parse', '--abbrev-ref', `${remote}/HEAD`], repo);
  if (r.code !== 0) return null;
  const ref = r.stdout.trim();
  if (!ref || ref.endsWith('/HEAD')) return null; // unset → the literal "<remote>/HEAD"
  return ref.startsWith(`${remote}/`) ? ref.slice(remote.length + 1) : ref;
};

const headSha = async (runGit: RunGit, repo: string): Promise<string> => {
  const r = await runGit(['rev-parse', 'HEAD'], repo);
  return r.stdout.trim();
};

const conflictedFiles = async (runGit: RunGit, repo: string): Promise<string[]> => {
  const r = await runGit(['diff', '--name-only', '--diff-filter=U'], repo);
  return r.code === 0 ? r.stdout.trim().split('\n').filter(Boolean) : [];
};

type SeedSnapshotTransplant =
  | { status: 'not-seed' }
  | { status: 'transplanted'; backupRef: string; replayedCommits: number }
  | { status: 'error'; message: string };

/**
 * WI-37969 / WI-6824: a depth=1 installer seed is intentionally a synthetic,
 * one-commit ROOT history. After restore, `origin` is repointed at the real
 * repository, so the first fetch necessarily produces two unrelated histories.
 * Treating that as an ordinary merge wedges every seeded install before its P2P
 * legs (`fatal: refusing to merge unrelated histories`).
 *
 * The seed provider's contract has always been "restore offline, then replace the
 * snapshot with the fetched delta" (its integration test previously did a manual
 * `reset --hard FETCH_HEAD`). This is the production-safe form of that conversion:
 *
 *  - require BOTH the exact synthetic-root subject and the bundle clone's retained
 *    `origin/papercusp-seed-snapshot-*` ref pointing at that root; an arbitrary
 *    unrelated-history rewrite therefore stays a loud error;
 *  - create a recovery ref before changing history;
 *  - with no post-restore commits, adopt the fetched branch exactly;
 *  - otherwise rebase every post-restore commit onto the fetched branch, preserving
 *    local work. A conflict aborts cleanly and leaves the recovery ref + old branch
 *    intact; it never falls through to `--allow-unrelated-histories`.
 */
async function transplantInstallerSeedSnapshot(
  runGit: RunGit,
  repo: string,
  remoteRef: string,
  remote: string,
  log: (m: string) => void,
): Promise<SeedSnapshotTransplant> {
  const roots = await runGit(['rev-list', '--max-parents=0', 'HEAD'], repo);
  const rootShas = roots.code === 0 ? roots.stdout.trim().split('\n').filter(Boolean) : [];
  if (rootShas.length !== 1) return { status: 'not-seed' };
  const seedRoot = rootShas[0];

  const subject = await runGit(['show', '-s', '--format=%s', seedRoot], repo);
  if (subject.code !== 0 || !/^papercusp seed snapshot (?:HEAD|[0-9a-f]{7,64})$/.test(subject.stdout.trim())) {
    return { status: 'not-seed' };
  }

  const snapshotRefs = await runGit(
    ['for-each-ref', '--format=%(objectname)', `refs/remotes/${remote}/papercusp-seed-snapshot-*`],
    repo,
  );
  if (snapshotRefs.code !== 0 || !snapshotRefs.stdout.split('\n').some((sha) => sha.trim() === seedRoot)) {
    return { status: 'not-seed' };
  }

  const head = await runGit(['rev-parse', '--verify', 'HEAD'], repo);
  if (head.code !== 0 || !head.stdout.trim()) {
    return { status: 'error', message: 'seed snapshot transplant could not resolve HEAD' };
  }
  const originalHead = head.stdout.trim();
  const count = await runGit(['rev-list', '--count', `${seedRoot}..HEAD`], repo);
  if (count.code !== 0) {
    return {
      status: 'error',
      message: `seed snapshot transplant could not enumerate post-restore commits: ${count.stderr.trim() || count.stdout.trim()}`,
    };
  }
  const replayedCommits = Number.parseInt(count.stdout.trim(), 10) || 0;
  const backupRef = `refs/papercusp/seed-recovery/${originalHead}`;
  const backup = await runGit(['update-ref', backupRef, originalHead], repo);
  if (backup.code !== 0) {
    return {
      status: 'error',
      message: `seed snapshot transplant could not create recovery ref ${backupRef}: ${backup.stderr.trim() || backup.stdout.trim()}`,
    };
  }

  if (replayedCommits === 0) {
    const adopt = await runGit(['reset', '--hard', remoteRef], repo);
    if (adopt.code !== 0) {
      return {
        status: 'error',
        message: `seed snapshot transplant could not adopt ${remoteRef} (recovery ref ${backupRef}): ${adopt.stderr.trim() || adopt.stdout.trim()}`,
      };
    }
  } else {
    const replay = await runGit(['rebase', '--rebase-merges', '--onto', remoteRef, seedRoot], repo);
    if (replay.code !== 0) {
      const replayOut = `${replay.stdout}\n${replay.stderr}`.trim();
      await runGit(['rebase', '--abort'], repo);
      return {
        status: 'error',
        message: `seed snapshot transplant could not replay ${replayedCommits} post-restore commit(s) onto ${remoteRef} (aborted clean; recovery ref ${backupRef}): ${replayOut.slice(0, 300)}`,
      };
    }
  }

  const related = await runGit(['merge-base', '--is-ancestor', remoteRef, 'HEAD'], repo);
  if (related.code !== 0) {
    return {
      status: 'error',
      message: `seed snapshot transplant did not produce a descendant of ${remoteRef} (recovery ref ${backupRef})`,
    };
  }
  log(
    `[git-sync] ${repo}: converted installer seed snapshot ${seedRoot.slice(0, 12)} to ${remoteRef}; ` +
      `${replayedCommits === 0 ? 'no post-restore commits' : `replayed ${replayedCommits} post-restore commit(s)`}; recovery ref ${backupRef}`,
  );
  return { status: 'transplanted', backupRef, replayedCommits };
}

/** WI-6824: a merge that fails with ZERO conflicted paths is classified `error`, and that
 *  message is the ONLY record of it — git-sync NULLs `last_error` on the next healthy tick,
 *  so an INTERMITTENT failure leaves nothing to correlate against afterwards (a fault that
 *  alarmed the fleet for ~10h across 39 sweeps left zero occurrences in 12h of journald, and
 *  was consequently not reproducible from any on-disk state).
 *
 *  Resolve the ref pair the merge ACTUALLY used, so the next flap identifies which pair was
 *  unrelated instead of being unfixable-by-inspection. `merge-base` is the discriminator:
 *  it exits non-zero with no output exactly when the histories are unrelated, which is the
 *  reported failure. `git-dir` + `url` are here because the cheapest way to get a genuine
 *  unrelated-history refusal between two healthy repos is to resolve the WRONG repository —
 *  a stale submodule git-dir path (libs/generic/chat-protocol still resolves its git-dir
 *  through the pre-move `.git/modules/libs/chat-protocol`) would present exactly this way,
 *  and no amount of after-the-fact inspection of the intended repo can distinguish it. */
const describeFailedMerge = async (
  runGit: RunGit,
  repo: string,
  remote: string,
  branch: string,
  attempt: 'initial' | 'non-ff-retry',
): Promise<string> => {
  const read = async (args: string[]): Promise<string> => {
    const r = await runGit(args, repo);
    const out = r.stdout.trim();
    return r.code === 0 && out ? out : '<none>';
  };
  const remoteRef = `${remote}/${branch}`;
  const head = await read(['rev-parse', '--short', 'HEAD']);
  const remoteSha = await read(['rev-parse', '--short', '--verify', remoteRef]);
  // exits 1 with empty stdout when there is NO common ancestor — i.e. the refusal itself.
  const rawBase = await read(['merge-base', 'HEAD', remoteRef]);
  const base = rawBase === '<none>' ? 'NONE(unrelated)' : rawBase.slice(0, 12);
  const gitDir = await read(['rev-parse', '--absolute-git-dir']);
  const url = await read(['config', '--get', `remote.${remote}.url`]);
  return `attempt=${attempt} HEAD=${head} ${remoteRef}=${remoteSha} merge-base=${base} git-dir=${gitDir} url=${url}`;
};

// Exported for the non-FF detection table test (test-coverage-gap G21): a git
// wording change must fail a test, not silently turn retriable rejections into
// hard escalations.
export function rejectedNonFastForward(r: { stdout: string; stderr: string }): boolean {
  return /non-fast-forward|\[rejected\]|fetch first|Updates were rejected/i.test(`${r.stdout}\n${r.stderr}`);
}

/** A non-zero `git commit` that simply had nothing staged (e.g. every dirty file was
 *  excluded as oversized) — benign, NOT a real commit failure. Anything else (index.lock
 *  race, corrupt index, hook abort) IS a failure we must surface (P-002). */
function nothingToCommit(r: { stdout: string; stderr: string }): boolean {
  return /nothing to commit|no changes added to commit|nothing added to commit/i.test(`${r.stdout}\n${r.stderr}`);
}

/** Repo-relative paths that made `git add` FATAL because they are embedded git repos with no
 *  commit ("error: '<path>' does not have a commit checked out"). Extracted so git-sync can
 *  EXCLUDE them + retry rather than silently stranding the WHOLE tree (2026-06-30 root cause:
 *  one nested no-commit .git under .papercusp/.vitest-tmpdir fatal-ed `git add -A`, so nothing
 *  committed for ~7h). Exported for unit testing. */
export function addFailureStrayPaths(output: string): string[] {
  const out: string[] = [];
  const re = /error: '([^']+)' does not have a commit checked out/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    out.push(m[1].replace(/\/+$/, '')); // git prints a trailing slash for a dir; pathspec wants it clean
  }
  return [...new Set(out)];
}

/** Protected paths that made `git add` fatal because they are already ignored.
 *
 * `git add -A -- . :(exclude,literal)<path>` normally lets a live editor keep a
 * dirty path out of git-sync's catch-all commit. Git still treats that negative
 * pathspec as an explicit mention, though, and refuses the whole add when the path
 * is ignored (for example a transient nested `package-lock.json`). The ignore rule
 * already protects the file, so the safe retry is to omit ONLY that redundant
 * exclusion pathspec — never `-f` the ignored artifact into the commit.
 */
export function addFailureIgnoredPaths(output: string): string[] {
  const match = output.match(
    /The following paths are ignored by one of your \.gitignore files:\s*\n([\s\S]*?)(?:\nhint:|$)/i,
  );
  if (!match) return [];
  return [
    ...new Set(
      match[1]
        .split(/\r?\n/)
        .map((line) => line.trim().replace(/^"(.*)"$/, '$1'))
        .filter(Boolean),
    ),
  ];
}

/**
 * Return the protected paths that are currently ignored and UNTRACKED.
 *
 * `git check-ignore` intentionally does not report tracked paths unless
 * `--no-index` is supplied. That default is load-bearing here: a tracked file
 * may still be covered by a later ignore rule, but its exclusion pathspec must
 * remain in the staging command so git-sync does not commit the protected
 * mutation. Conversely, an ignored untracked path is already excluded by Git's
 * normal ignore handling; passing it as a negative pathspec makes `git add`
 * reject the entire command. Exit code 1 means "none matched"; any other
 * non-zero result fails open by returning no matches and preserving all
 * exclusions for the existing add-failure recovery path.
 */
export async function ignoredUntrackedSubset(
  runGit: RunGit,
  repoPath: string,
  paths: readonly string[],
): Promise<Set<string>> {
  const ignored = new Set<string>();
  for (let i = 0; i < paths.length; i += 500) {
    const chunk = paths.slice(i, i + 500);
    const result = await runGit(['check-ignore', '-z', '--', ...chunk], repoPath);
    if (result.code !== 0 && result.code !== 1) return new Set<string>();
    for (const path of result.stdout.split('\0')) if (path) ignored.add(path);
  }
  return ignored;
}

/** The `git add`/`git commit` fatal for a held index lock ("Unable to create
 *  '….git/index.lock': File exists"). Exported for unit testing (a git wording
 *  change must fail a test, not silently disable the self-heal below). */
export function isIndexLockFailure(output: string): boolean {
  return /Unable to create '[^']*index\.lock': File exists/i.test(output);
}

/** The `git submodule sync` fatal for a held repository config lock. Git names
 * the destination config file in the error even though the sentinel on disk is
 * its `.lock` sibling. Exported so wording drift fails a focused test. */
export function isConfigLockFailure(output: string): boolean {
  return /could not lock config file [^\r\n]*[/\\]config: File exists/i.test(output);
}

/** The `git add -A` fatal for a path that vanished between git's tree-walk
 *  enumeration and its stat call ("fatal: unable to stat '<path>': No such file or
 *  directory") — a benign race with ANY process in this heavily-concurrent fleet
 *  that writes atomically (write `<file>.tmp.<pid>.<hash>` sibling, then
 *  rename/remove over the real file): git enumerates the tmp sibling right before
 *  the writer renames/removes it, so the subsequent stat 404s even though the file
 *  legitimately existed a moment earlier. The window is a handful of milliseconds
 *  wide (EI-18094449017685490), so a bounded immediate retry resolves it instead of
 *  stranding the whole tick's commit on one transient, already-gone path. Exported
 *  for unit testing (a git wording change must fail a test, not silently disable
 *  the retry below). */
export function isTransientStatFailure(output: string): boolean {
  return /fatal: unable to stat '[^']*': No such file or directory/i.test(output);
}

/** Bounded retry budget for {@link isTransientStatFailure} — the race window is a
 *  few ms wide (one process's write-tmp+rename), so this is generous, not a
 *  long-poll. Exported so the unit test doesn't hardcode a magic number twice. */
export const TRANSIENT_STAT_FAILURE_MAX_RETRIES = 3;
const TRANSIENT_STAT_FAILURE_RETRY_DELAY_MS = 150;

/** A live git writer can hold `.git/index.lock` only briefly while it replaces the
 * index. Retry that specific contention before surfacing an error, but keep the
 * budget small so a genuinely wedged writer still reaches the stale-lock guard. */
export const INDEX_LOCK_CONTENTION_MAX_RETRIES = 3;
export const INDEX_LOCK_CONTENTION_RETRY_BASE_DELAY_MS = 100;

/** `git submodule sync` writes repository config through `.git/config.lock`, so
 * it can race the same short-lived local git writers as the index path above.
 * Keep the retry budget deliberately small: a live writer normally releases in
 * milliseconds, while a persistent lock still reaches the stale-lock guard and
 * the loud error path in this same tick. */
export const CONFIG_LOCK_CONTENTION_MAX_RETRIES = 3;
export const CONFIG_LOCK_CONTENTION_RETRY_BASE_DELAY_MS = 100;

/** A lock YOUNGER than this is treated as live contention (git rewrites the lock
 *  file as it builds the new index, so an in-flight writer keeps the mtime fresh);
 *  older = the writer is dead and the lock is an orphan. git-sync ticks run ~2min
 *  apart, so a real writer is never this old between ticks. */
export const STALE_INDEX_LOCK_MS = 90_000;

/**
 * STALE-LOCK SELF-HEAL (2026-07-04): a git process killed mid-`add -A` leaves
 * `.git/index.lock` behind, and every subsequent tick then fails with the same
 * "File exists" fatal — FOREVER, until a human deletes the file (observed live:
 * 3 consecutive failed ticks + a fleet-wide alert for a 6.8MB orphaned lock).
 * This clears the lock ONLY when it is provably stale (mtime older than
 * `staleMs` — an active writer keeps it fresh), so a live racing git process is
 * never robbed of its lock; a fresh-lock failure stays an error and the NEXT
 * tick (by which time the orphan has aged past the threshold) heals it. Resolves
 * the git dir via `rev-parse --absolute-git-dir` so submodules (whose `.git` is
 * a file, not a dir) work too. Returns true when the caller should retry.
 */
async function clearStaleGitLock(
  runGit: RunGit,
  repoPath: string,
  lockName: 'index.lock' | 'config.lock',
  log: (m: string) => void,
  deps: {
    statMtimeMs?: (p: string) => Promise<number | null>;
    unlinkFile?: (p: string) => Promise<void>;
    now?: () => number;
    staleMs?: number;
  } = {},
): Promise<boolean> {
  const statMtimeMs =
    deps.statMtimeMs ??
    (async (p: string) => {
      try {
        return (await lstat(p)).mtimeMs;
      } catch {
        return null;
      }
    });
  const unlinkFile = deps.unlinkFile ?? unlink;
  const now = deps.now ?? Date.now;
  const staleMs = deps.staleMs ?? STALE_INDEX_LOCK_MS;
  const gd = await runGit(['rev-parse', '--absolute-git-dir'], repoPath);
  if (gd.code !== 0) return false;
  const lockPath = join(gd.stdout.trim(), lockName);
  const mtime = await statMtimeMs(lockPath);
  if (mtime === null) return true; // already gone (holder finished/cleaned up) — just retry
  const ageMs = now() - mtime;
  if (ageMs < staleMs) {
    log(
      `[git-sync] ${repoPath}: ${lockName} is FRESH (${Math.round(ageMs / 1000)}s old) — live contention, not touching it; this tick fails and the next one self-heals if the writer died`,
    );
    return false;
  }
  try {
    await unlinkFile(lockPath);
  } catch (e) {
    log(`[git-sync] ${repoPath}: could not unlink stale ${lockName}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  log(
    `[git-sync] ${repoPath}: cleared STALE ${lockName} (${Math.round(ageMs / 1000)}s old — its writer is dead) and retrying (previously: every tick failed until a human removed it)`,
  );
  return true;
}

export async function clearStaleIndexLock(
  runGit: RunGit,
  repoPath: string,
  log: (m: string) => void,
  deps: Parameters<typeof clearStaleGitLock>[4] = {},
): Promise<boolean> {
  return clearStaleGitLock(runGit, repoPath, 'index.lock', log, deps);
}

interface ConfigLockSnapshot {
  mtimeMs: number;
  size: number;
  dev?: number;
  ino?: number;
}

interface ClearStaleConfigLockDeps {
  inspectLock?: (p: string) => Promise<ConfigLockSnapshot | null>;
  isOpen?: (p: string) => Promise<boolean | null>;
  unlinkFile?: (p: string) => Promise<void>;
  now?: () => number;
  staleMs?: number;
}

/** Clear an orphaned `.git/config.lock` left by a dead config writer (including
 * a sandbox mount-point artifact). Config is more sensitive than the replaceable
 * index: age alone is insufficient evidence. Delete only a zero-byte lock that
 * is old, has no open descriptor, and has not changed during inspection. */
export async function clearStaleConfigLock(
  runGit: RunGit,
  repoPath: string,
  log: (m: string) => void,
  deps: ClearStaleConfigLockDeps = {},
): Promise<boolean> {
  const inspectLock =
    deps.inspectLock ??
    (async (p: string): Promise<ConfigLockSnapshot | null> => {
      try {
        const st = await lstat(p);
        return { mtimeMs: st.mtimeMs, size: st.size, dev: st.dev, ino: st.ino };
      } catch {
        return null;
      }
    });
  const isOpen = deps.isOpen ?? defaultOpenFileCheck;
  const unlinkFile = deps.unlinkFile ?? unlink;
  const now = deps.now ?? Date.now;
  const staleMs = deps.staleMs ?? STALE_INDEX_LOCK_MS;

  const gd = await runGit(['rev-parse', '--absolute-git-dir'], repoPath);
  if (gd.code !== 0) return false;
  const lockPath = join(gd.stdout.trim(), 'config.lock');
  const before = await inspectLock(lockPath);
  if (before === null) return true;

  const ageMs = now() - before.mtimeMs;
  if (ageMs < staleMs) {
    log(
      `[git-sync] ${repoPath}: config.lock is FRESH (${Math.round(ageMs / 1000)}s old) — live contention, not touching it`,
    );
    return false;
  }
  if (before.size !== 0) {
    log(
      `[git-sync] ${repoPath}: config.lock is old but NONEMPTY (${before.size} bytes) — cannot prove it is an orphan, not touching it`,
    );
    return false;
  }

  const open = await isOpen(lockPath);
  if (open !== false) {
    log(
      `[git-sync] ${repoPath}: config.lock is old and empty but ${open ? 'still OPEN' : 'holder state is UNKNOWN'} — not touching it`,
    );
    return false;
  }

  // Close the inspection-to-unlink race enough to catch replacement or a writer
  // touching the sentinel while the descriptor scan ran. A changed file is no
  // longer the empty orphan we proved above, so leave it for the next tick.
  const after = await inspectLock(lockPath);
  if (after === null) return true;
  if (
    after.mtimeMs !== before.mtimeMs ||
    after.size !== before.size ||
    after.dev !== before.dev ||
    after.ino !== before.ino
  ) {
    log(`[git-sync] ${repoPath}: config.lock changed during orphan inspection — not touching it`);
    return false;
  }

  try {
    await unlinkFile(lockPath);
  } catch (e) {
    log(`[git-sync] ${repoPath}: could not unlink stale config.lock: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  log(
    `[git-sync] ${repoPath}: cleared STALE empty holderless config.lock (${Math.round(ageMs / 1000)}s old) and retrying canonical submodule URL sync`,
  );
  return true;
}

/** A crash-left `index-pack` file is safe to consider only after this age floor. */
export const STALE_TEMP_PACK_MS = 30 * 60_000;

type TempPackEntry = { name: string; size: number; mtimeMs: number; nlink: number };

async function gitDirForRepo(runGit: RunGit, repoPath: string): Promise<string> {
  const gd = await runGit(['rev-parse', '--absolute-git-dir'], repoPath);
  return gd.code === 0 ? gd.stdout.trim() : '';
}

const ZERO_BYTE_LOOSE_OBJECT_REPORT_LIMIT = 20;

/**
 * A canonical loose object lives at `objects/<2 hex>/<38 hex>`. Git writes it
 * through a temporary file and atomically renames the completed payload, so a
 * regular zero-byte file at that final name is corruption, never an in-flight
 * writer. Detect it before fetch: otherwise Git's `bad object HEAD`/mmap error
 * is flattened into the generic "fetch failed; HEAD has unpushed commits"
 * branch and the same checkout can fail silently for dozens of routine ticks.
 *
 * Detection is deliberately non-destructive. The object may be a local-only
 * commit that no remote can restore, so automatic deletion would destroy the
 * only remaining identity needed for reflog/working-tree recovery.
 */
async function findZeroByteLooseObjects(runGit: RunGit, repoPath: string): Promise<string[]> {
  const gitDir = await gitDirForRepo(runGit, repoPath);
  if (!gitDir) return [];
  let fanouts: string[];
  try {
    fanouts = await readdir(join(gitDir, 'objects'));
  } catch {
    return [];
  }

  const corrupt: string[] = [];
  for (const fanout of fanouts.sort()) {
    if (!/^[0-9a-f]{2}$/i.test(fanout)) continue;
    let names: string[];
    try {
      names = await readdir(join(gitDir, 'objects', fanout));
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (!/^[0-9a-f]{38}$/i.test(name)) continue;
      try {
        const st = await lstat(join(gitDir, 'objects', fanout, name));
        if (st.isFile() && st.size === 0) corrupt.push(`${fanout}${name}`.toLowerCase());
      } catch {
        // A concurrent maintenance process may remove or repack the object.
      }
      if (corrupt.length >= ZERO_BYTE_LOOSE_OBJECT_REPORT_LIMIT) return corrupt;
    }
  }
  return corrupt;
}

async function listTempPackEntries(
  runGit: RunGit,
  repoPath: string,
): Promise<{ gitDir: string; entries: TempPackEntry[] }> {
  const gitDir = await gitDirForRepo(runGit, repoPath);
  if (!gitDir) return { gitDir: '', entries: [] };
  let names: string[];
  try {
    names = await readdir(join(gitDir, 'objects', 'pack'));
  } catch {
    return { gitDir, entries: [] };
  }
  const entries: TempPackEntry[] = [];
  for (const name of names) {
    if (!/^tmp_pack_[^/]+$/.test(name)) continue;
    try {
      const st = await lstat(join(gitDir, 'objects', 'pack', name));
      if (st.isFile()) entries.push({ name, size: st.size, mtimeMs: st.mtimeMs, nlink: st.nlink });
    } catch {
      // A concurrent fetch may have finalized or removed the temp file.
    }
  }
  return { gitDir, entries };
}

/**
 * A failed `git fetch` can leave `index-pack`'s incoming pack at
 * `.git/objects/pack/tmp_pack_*`. The temp name is deliberately not a valid
 * reachable pack ref; Git only renames it after the pack is complete. Snapshot
 * the names before fetch and remove ONLY new regular files after a failed fetch.
 * This avoids deleting an older leak (or a peer's pre-existing temp pack) while
 * reclaiming a large partial pack immediately instead of waiting for age-based GC.
 */
async function listTempPackFiles(runGit: RunGit, repoPath: string): Promise<Map<string, number>> {
  const { entries } = await listTempPackEntries(runGit, repoPath);
  const result = new Map<string, number>();
  for (const entry of entries) result.set(entry.name, entry.size);
  return result;
}

/**
 * `tmp_pack_*` has no Git index and therefore cannot be reached by a ref while it
 * retains its temporary name. Keep the additional checks explicit: an index/keep
 * sidecar, an advertised pack entry, or a hard link means another Git process may
 * have made the file reachable, so the scavenger must leave it alone.
 */
async function tempPackHasReferences(gitDir: string, entry: TempPackEntry): Promise<boolean> {
  if (entry.nlink > 1) return true;
  const packPath = join(gitDir, 'objects', 'pack', entry.name);
  for (const suffix of ['.idx', '.keep']) {
    try {
      await lstat(`${packPath}${suffix}`);
      return true;
    } catch {
      // No sidecar — keep checking the other proof surfaces.
    }
  }
  try {
    const advertised = await readFile(join(gitDir, 'objects', 'info', 'packs'), 'utf8');
    if (advertised.split('\n').some((line) => line.includes(entry.name))) return true;
  } catch {
    // `objects/info/packs` is optional; absence is not evidence of a reference.
  }
  return false;
}

/** Return true when `/proc` proves a descriptor currently names the candidate. */
async function procSeesOpenFile(path: string): Promise<boolean | null> {
  const canonical = await realpath(path).catch(() => null);
  if (!canonical) return null;
  let pids: string[];
  try {
    pids = await readdir('/proc');
  } catch {
    return null;
  }
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    let fds: string[];
    try {
      fds = await readdir(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        const target = await readlink(`/proc/${pid}/fd/${fd}`);
        if (target === canonical || target === `${canonical} (deleted)`) return true;
      } catch {
        // Processes can exit or close a descriptor while the directory is scanned.
      }
    }
  }
  return false;
}

/** macOS has no `/proc`; `lsof` is part of the base system and is read-only here. */
async function lsofSeesOpenFile(path: string): Promise<boolean | null> {
  return await new Promise<boolean | null>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (value: boolean | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const child = spawn('lsof', ['-t', path], { stdio: ['ignore', 'pipe', 'ignore'] });
    const stdout = collectChildOutput(child).stdout;
    child.once('error', () => finish(null));
    child.once('close', (code) => finish(code === 0 && stdout.text().trim().length > 0));
    timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(null);
    }, 1000);
    timer.unref?.();
  });
}

async function defaultOpenFileCheck(path: string): Promise<boolean | null> {
  if (process.platform === 'linux') return procSeesOpenFile(path);
  if (process.platform === 'darwin') return lsofSeesOpenFile(path);
  return null;
}

export interface TempPackScavengeDeps {
  now?: () => number;
  staleMs?: number;
  isOpen?: (path: string) => Promise<boolean | null>;
  unlinkFile?: (path: string) => Promise<void>;
}

/**
 * Remove only crash-left temp packs. Every deletion requires all of these proofs:
 * the entry is an old regular `tmp_pack_*` file, has no Git sidecar/reference or
 * hard link, no process has it open, and its size/mtime/type remain unchanged across
 * a second stat. Unknown open-state is fail-closed. This is intentionally separate
 * from failed-fetch cleanup: that path is same-attempt freshness based and remains
 * unchanged so it cannot delete a peer's pre-existing file.
 */
export async function scavengeStaleTempPacks(
  runGit: RunGit,
  repoPath: string,
  log: (m: string) => void,
  deps: TempPackScavengeDeps = {},
): Promise<{ removed: string[]; bytesReclaimed: number }> {
  const now = deps.now ?? Date.now;
  const staleMs = deps.staleMs ?? STALE_TEMP_PACK_MS;
  const isOpen = deps.isOpen ?? defaultOpenFileCheck;
  const unlinkFile = deps.unlinkFile ?? unlink;
  const { gitDir, entries } = await listTempPackEntries(runGit, repoPath);
  if (!gitDir) return { removed: [], bytesReclaimed: 0 };
  const packDir = join(gitDir, 'objects', 'pack');
  const removed: string[] = [];
  let bytesReclaimed = 0;
  const nowMs = now();

  for (const entry of entries) {
    if (entry.mtimeMs > nowMs - staleMs || entry.mtimeMs > nowMs) continue;
    const path = join(packDir, entry.name);
    try {
      if (await tempPackHasReferences(gitDir, entry)) continue;
      if ((await isOpen(path)) !== false) continue;
      const current = await lstat(path);
      if (
        !current.isFile() ||
        current.size !== entry.size ||
        current.mtimeMs !== entry.mtimeMs ||
        current.nlink > 1 ||
        (await tempPackHasReferences(gitDir, {
          ...entry,
          size: current.size,
          mtimeMs: current.mtimeMs,
          nlink: current.nlink,
        })) ||
        (await isOpen(path)) !== false
      )
        continue;
      await unlinkFile(path);
      removed.push(entry.name);
      bytesReclaimed += entry.size;
    } catch (e) {
      log(
        `[git-sync] ${repoPath}: could not prune stale temp pack ${entry.name}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return { removed, bytesReclaimed };
}

async function pruneFailedFetchTempPacks(
  runGit: RunGit,
  repoPath: string,
  beforeFetch: Map<string, number>,
  log: (m: string) => void,
): Promise<{ removed: string[]; bytesReclaimed: number }> {
  const afterFetch = await listTempPackFiles(runGit, repoPath);
  const removed: string[] = [];
  let bytesReclaimed = 0;
  const gd = await runGit(['rev-parse', '--absolute-git-dir'], repoPath);
  const gitDir = gd.code === 0 ? gd.stdout.trim() : '';
  if (!gitDir) return { removed, bytesReclaimed };
  const packDir = join(gitDir, 'objects', 'pack');

  for (const [name, size] of afterFetch) {
    if (beforeFetch.has(name)) continue;
    try {
      // `lstat` + the anchored name filter keep this unlink scoped to a regular
      // temp pack in THIS repo's object store; symlinks and directories are left.
      const current = await lstat(join(packDir, name));
      if (!current.isFile()) continue;
      await unlink(join(packDir, name));
      removed.push(name);
      bytesReclaimed += size;
    } catch (e) {
      log(
        `[git-sync] ${repoPath}: could not prune failed-fetch temp pack ${name}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return { removed, bytesReclaimed };
}

/**
 * Recursively discover submodule paths (repo-relative), DEEPEST-FIRST. Dynamic —
 * reads the live submodule tree (`git submodule status --recursive`), never a
 * hardcoded list. Skips uninitialized submodules (leading '-'). Deepest-first so a
 * child lands on its origin before a parent's pointer to it is pushed.
 */
// Exported for the stray-gitlink fallback regression test (2026-07-01).
export const discoverSubmodulesRecursive = async (
  runGit: RunGit,
  repo: string,
  log: (msg: string) => void = () => {},
  /** EI-20402093158205519: receives the strand census whenever this pass actually MEASURED
   *  it (the `git submodule status` exit-0 path), including the empty result — an empty
   *  census is a real all-clear the caller uses to clear a stale escalation. Deliberately
   *  NOT called on the discovery-failure fallback: we did not measure, and reporting an
   *  unmeasured [] there would read as an all-clear and silently retire a live warning. */
  onStrandCensus?: (stranded: StrandedSubmodule[]) => void,
): Promise<string[]> => {
  const r = await runGit(['submodule', 'status', '--recursive'], repo);
  if (r.code === 0) {
    const lines = r.stdout.split('\n').filter(Boolean);
    const rowPath = (l: string) => l.slice(1).trim().split(/\s+/)[1]; // "<flag><sha> <path> (<describe>)" → path
    const paths = lines
      .filter((l) => l[0] !== '-') // skip uninitialized
      .map(rowPath)
      .filter(Boolean);
    // EI-20402093158205519: a '-' row means only that `submodule.<name>.url` is absent from
    // .git/config (`git submodule init` never ran). It says NOTHING about whether the
    // worktree is POPULATED — and a populated one can hold real, uncommitted agent work.
    // This path's test is therefore strictly WEAKER than the .gitmodules fallback below,
    // which lstats `<path>/.git`; and because the fallback runs ONLY when discovery FAILS,
    // the weak test governs the normal (exit 0) case. Measured on the sidestage tree
    // 2026-08-14: 7 of 8 submodules '-'-prefixed but fully populated, discovery returned
    // exactly 1 path, and three tracked files sat uncommitted with no error on any tick —
    // git-sync never visited those repos at all. Silence is the defect: SAY SO. Reporting
    // (not auto-syncing) is deliberate — these worktrees are commonly parked on deliberate
    // detached pins, so pulling them into the normal path would fetch/merge/push and UNPIN
    // them. Registering is the operator's call; losing the work silently is not.
    const stranded: StrandedSubmodule[] = [];
    for (const l of lines) {
      if (l[0] !== '-') continue;
      const p = rowPath(l);
      if (!p) continue;
      try {
        await lstat(join(repo, p, '.git')); // populated worktree, just unregistered
      } catch {
        continue; // genuinely uninitialized — nothing on disk to strand
      }
      const dirty = await runGit(['status', '--porcelain=v1', '--untracked-files=no'], join(repo, p));
      // Count TRACKED modifications only: scratch/untracked churn (e.g. .vitest-tmp/) would
      // otherwise cry wolf on every tick that a test run happens to be in flight.
      const rows = dirty.code === 0 ? dirty.stdout.split('\n').filter(Boolean) : [];
      if (rows.length > 0) {
        stranded.push({
          path: p,
          trackedFiles: rows.length,
          // Porcelain v1 row is "XY <path>"; keep the paths so the escalation can name the
          // actual files a human must rescue, not just a count they then have to go find.
          files: rows.slice(0, 20).map((r) => r.slice(3).trim()),
        });
      }
    }
    if (stranded.length > 0) {
      const list = stranded.map((s) => `${s.path} (${s.trackedFiles} tracked file(s))`).join(', ');
      log(
        `[git-sync] ⚠ STRANDED WORK: ${stranded.length} POPULATED but UNREGISTERED submodule(s) hold uncommitted tracked changes ` +
          `that git-sync cannot see and will NEVER commit: ${list} — ` +
          `they are absent from .git/config (no submodule.<name>.url), so 'git submodule status' marks them '-' and discovery skips them. ` +
          `Fix with: git submodule init <path> (idempotent; copies the .gitmodules URL into .git/config), then re-check the pin before the next tick.`,
      );
    }
    // Fire even when EMPTY: the caller needs the all-clear to retire a stale escalation.
    // Only on this (measured) path — see the param doc.
    onStrandCensus?.(stranded);
    return paths.sort((a, b) => b.split('/').length - a.split('/').length);
  }
  // ONE stray index gitlink with no .gitmodules mapping (e.g. a test's temp repo swept in
  // by an auto-commit) makes `git submodule status --recursive` exit 128 — and a silent []
  // here strands EVERY submodule's commits, every tick, while the routine keeps reporting
  // "synced" (2026-07-01: `.papercusp/scratch/tmp/relgit-*` did exactly this for days).
  // Never silently skip the pass: SAY SO, then fall back to the .gitmodules mapping
  // (authoritative for top-level paths; nested submodules wait until the stray is removed —
  // `git rm --cached <stray-path>` is the operator fix, named in the log line).
  log(
    `[git-sync] submodule discovery FAILED (${(r.stderr || r.stdout || 'no output').trim().slice(0, 200)}) — ` +
      `falling back to .gitmodules top-level paths; if this names a stray gitlink, fix with: git rm --cached <path>`,
  );
  const cfg = await runGit(['config', '-f', '.gitmodules', '--get-regexp', String.raw`^submodule\..*\.path$`], repo);
  if (cfg.code !== 0) return [];
  const paths: string[] = [];
  for (const line of cfg.stdout.split('\n')) {
    const p = line.trim().split(/\s+/)[1];
    if (!p) continue;
    try {
      await lstat(join(repo, p, '.git')); // initialized submodules only (worktree has .git)
      paths.push(p);
    } catch {
      /* uninitialized — skip */
    }
  }
  return paths.sort((a, b) => b.split('/').length - a.split('/').length);
};

/** One `git stash` entry, identified by its underlying commit SHA (stable across
 *  ticks — unlike `stash@{N}`, which is purely POSITIONAL and shifts whenever an
 *  older entry is popped/dropped). */
export interface StashEntry {
  sha: string;
  subject: string;
  /** Committer date of the stash commit, ISO-8601 (`%cI`), or '' when git omitted it.
   *  EI-19449313204576061: WITHOUT this the detector can only report "not in my
   *  baseline", which it then RENDERED as "🚨 NEW" — a conclusion about creation time
   *  it had never observed. A stash's age is the decisive falsifier and costs one
   *  extra `--format` token, so it is carried on the entry rather than re-derived. */
  createdAt: string;
}

/**
 * WI-3072 (recurrence guard for the EI-7685 class — an agent ran `git stash` on the
 * shared staging tree and it silently sat there looking like vanished work): list
 * one repo's current stash entries. Read-only, never throws — a `git stash list`
 * failure (odd env, detached/bare repo) reads as empty, same fail-open posture as
 * the other best-effort git-sync primitives in this file.
 */
export async function listStashEntries(runGit: RunGit, repoPath: string): Promise<StashEntry[]> {
  const r = await runGit(['stash', 'list', '--format=%H%x1f%cI%x1f%s'], repoPath);
  if (r.code !== 0) return [];
  return r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      // Subject is LAST and may itself contain the separator in pathological cases —
      // take the first two fields positionally and rejoin the remainder.
      const parts = line.split('\x1f');
      const sha = parts[0] ?? '';
      const createdAt = parts[1] ?? '';
      const subject = parts.slice(2).join('\x1f');
      return { sha, createdAt, subject };
    })
    .filter((e) => e.sha.length > 0);
}

/** How recent a stash must be for the watchdog to treat it as live, at-risk work.
 *  git-sync ticks every few minutes, so anything stashed within a day is plausibly a
 *  current agent's in-flight work (the EI-7685 case the detector exists for); older
 *  than that is archaeology, and calling it "NEW" is what trained agents to reach for
 *  `stash pop`/`drop` on a shared tree. */
export const STASH_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Pure: split not-yet-known stash entries into the ones that are genuinely RECENT
 * (worth an urgent broadcast) and the ones that merely became VISIBLE to the detector
 * now despite predating it (worth a quiet notice at most).
 *
 * EI-19449313204576061: "not in my baseline" and "new" are different claims, and the
 * detector only ever observed the first. An entry with an unparseable/absent date is
 * treated as RECENT — fail toward surfacing, never toward silently swallowing a real
 * stash, since a missed genuine stash is the expensive direction (EI-7685).
 */
export function partitionStashEntriesByAge<T extends StashEntry>(
  entries: readonly T[],
  nowMs: number,
  recentWindowMs: number = STASH_RECENT_WINDOW_MS,
): { recent: T[]; preExisting: T[] } {
  const recent: T[] = [];
  const preExisting: T[] = [];
  for (const e of entries) {
    const t = e.createdAt ? Date.parse(e.createdAt) : Number.NaN;
    if (Number.isNaN(t) || nowMs - t <= recentWindowMs) recent.push(e);
    else preExisting.push(e);
  }
  return { recent, preExisting };
}

/** Human-readable age for an alarm line — the field whose absence let a 13-week-old
 *  stash read as an emergency. Returns 'unknown age' when the date is missing. */
export function describeStashAge(entry: StashEntry, nowMs: number): string {
  const t = entry.createdAt ? Date.parse(entry.createdAt) : Number.NaN;
  if (Number.isNaN(t)) return 'unknown age';
  const days = Math.floor((nowMs - t) / (24 * 60 * 60 * 1000));
  if (days >= 1) return `created ${entry.createdAt.slice(0, 10)}, ${days}d old`;
  const hours = Math.floor((nowMs - t) / (60 * 60 * 1000));
  return `created ${entry.createdAt.slice(0, 10)}, ${hours}h old`;
}

/** Pure: which of `current`'s stash entries were never in `knownShas` — i.e. genuinely
 *  NEW since the last check. Exported so the comparison logic is unit-testable with
 *  zero git subprocess involved (mirrors the other pure `*FromRows`/`*From*` helpers
 *  in this codebase). */
export function newStashEntries(current: StashEntry[], knownShas: readonly string[]): StashEntry[] {
  const known = new Set(knownShas);
  return current.filter((e) => !known.has(e.sha));
}

type RepoSyncResult = { oversized: OversizedFile[]; contentErrors: ContentOffender[]; mergeCompleted?: boolean } & (
  | { status: 'nothing' }
  | { status: 'synced'; pushed: boolean; merged: boolean }
  | { status: 'conflict'; conflictedFiles: string[] }
  | { status: 'error'; message: string }
);

/**
 * Dirty (modified/untracked) files exceeding maxBytes — detected BEFORE `add -A` so
 * the auto-commit can EXCLUDE them (EI-18: GitHub hard-rejects >100MB blobs, and one
 * committed oversized blob makes the unpushed range permanently unpushable; recovery
 * is manual history surgery). Uses `status --porcelain -z` (NUL-separated, unquoted —
 * robust to spaces/specials in paths) with `-uall` (P-001): WITHOUT it a brand-new
 * directory collapses to a single `?? dir/` entry whose `lstat` is a directory and is
 * skipped, hiding an oversized file INSIDE it — then `add -A` commits it and wedges the
 * push forever (the exact EI-18 incident class). `-uall` lists every untracked file
 * individually so each oversized blob is seen + excluded.
 */
// Exported for the exact-boundary table test (test-coverage-gap G22): the size
// comparison is strict `>` — a file AT maxBytes must be INCLUDED, not excluded.
export async function findOversizedDirtyFiles(
  runGit: RunGit,
  repoPath: string,
  maxBytes: number,
): Promise<OversizedFile[]> {
  const r = await runGit(['status', '--porcelain', '-z', '-uall'], repoPath);
  if (r.code !== 0) return [];
  const entries = r.stdout.split('\0').filter(Boolean);
  const out: OversizedFile[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.length < 4) continue;
    const xy = e.slice(0, 2);
    const path = e.slice(3);
    if (xy.includes('R') || xy.includes('C')) i++; // -z renames: "XY new\0old" — skip the origin path
    if (xy.includes('D')) continue; // deletions have no blob to size
    try {
      const st = await lstat(join(repoPath, path));
      if (st.isFile() && st.size > maxBytes) out.push({ path, sizeBytes: st.size });
    } catch {
      /* a racing build artifact vanished mid-pass — nothing to commit, skip */
    }
  }
  return out;
}

/**
 * WI-5738 — the CUMULATIVE sibling of `findOversizedDirtyFiles`, and the gate
 * that should have stopped the 2026-07-20 incident at source.
 *
 * `findOversizedDirtyFiles` is PER-FILE. On 2026-07-20 an extracted AppImage
 * was auto-committed as **2,261 MB across thousands of files** whose largest
 * single blob was 90.3 MB — comfortably under the 95 MB per-file cap. Every
 * file passed individually, the whole thing was committed, and the aggregate
 * then breached the publish guard's 500 MB TOTAL cap one layer downstream,
 * where the only available response was to refuse (terminally). The per-file
 * cap cannot see a bulk accident; the total cap can only see it too late.
 *
 * So: measure the aggregate HERE, where the response is still cheap and
 * correct — exclude the files from the commit and leave them dirty, exactly as
 * the oversized/content guards already do ("quarantine, don't stall"). Largest
 * -first, because a bulk accident is dominated by a few big artifacts while
 * genuine source edits are small: the offending tree is peeled off and the
 * fleet's real work still commits this tick.
 *
 * Deliberately NOT a hard failure: a legitimately large commit is possible, and
 * refusing to commit at all would just relocate the wedge upstream.
 */
export async function findBulkDirtyExcess(
  runGit: RunGit,
  repoPath: string,
  maxTotalBytes: number,
  alreadyExcluded: ReadonlySet<string> = new Set(),
): Promise<OversizedFile[]> {
  const paths = await dirtyFiles(runGit, repoPath);
  const sized: OversizedFile[] = [];
  let total = 0;
  for (const path of paths) {
    if (alreadyExcluded.has(path)) continue; // its bytes are not being committed
    try {
      const st = await lstat(join(repoPath, path));
      if (!st.isFile()) continue;
      sized.push({ path, sizeBytes: st.size });
      total += st.size;
    } catch {
      /* a racing build artifact vanished mid-pass — nothing to commit, skip */
    }
  }
  if (total <= maxTotalBytes) return [];
  // Peel the largest until the remainder fits.
  sized.sort((a, b) => b.sizeBytes - a.sizeBytes);
  const excluded: OversizedFile[] = [];
  for (const f of sized) {
    if (total <= maxTotalBytes) break;
    excluded.push(f);
    total -= f.sizeBytes;
  }
  return excluded;
}

/** Enumerate every dirty path (modified/added/deleted/untracked), repo-relative, in the
 *  same path-space as the oversized/content excludes. `-z` keeps paths with spaces/newlines
 *  intact; a rename/copy origin path (the 2nd `-z` field) is skipped. Exported for P-004 tests. */
export async function dirtyFiles(runGit: RunGit, repoPath: string): Promise<string[]> {
  const r = await runGit(['status', '--porcelain', '-z', '-uall'], repoPath);
  if (r.code !== 0) return [];
  const entries = r.stdout.split('\0').filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.length < 4) continue;
    const xy = e.slice(0, 2);
    if (xy.includes('R') || xy.includes('C')) i++; // -z rename/copy: skip the origin path that follows
    out.push(e.slice(3));
  }
  return out;
}

/** The CI-skip suffix git-sync's message carries (e.g. ` [skip ci]`), so every per-agent
 *  commit skips CI exactly like the catch-all. Empty when the message has no such marker. */
function skipCiSuffix(message: string): string {
  const m = message.match(/(\[skip ci\])\s*$/i);
  return m ? ` ${m[1]}` : '';
}

/**
 * P-004 (git-sync-dx-hardening): peel each declaring agent's dirty files into its OWN commit
 * (intent subject + a Co-Authored-By trailer), preserving the CI-skip marker. Excluded files
 * (oversized / content offenders) stay quarantined. The catch-all (agent=null) group is left
 * for the caller's existing whole-tree commit. Never throws; a real commit failure returns an
 * error. Exported for the P-004 commit-grouping test (injected runGit, no real repo).
 */
export async function commitAttributedGroups(
  runGit: RunGit,
  repoPath: string,
  attribution: Map<string, FileAttribution>,
  excludePaths: string[],
  message: string,
  opts: { diffSubjects?: boolean } = {},
): Promise<{ committedAny: boolean; error?: string }> {
  const excludeSet = new Set(excludePaths);
  const dirty = (await dirtyFiles(runGit, repoPath)).filter((f) => !excludeSet.has(f));
  const groups = groupFilesForAttribution(dirty, attribution);
  const suffix = skipCiSuffix(message);
  let committedAny = false;
  for (const g of groups) {
    if (g.agent === null || g.files.length === 0) continue; // catch-all handled by the caller's add -A
    await runGit(['add', '--', ...g.files], repoPath);
    // WI-38594 (flag GIT_SYNC_DIFF_SUBJECTS): the subject describes the DIFF (what this
    // commit actually contains — from the just-staged numstat); the agent's intent line
    // (the pre-WI-38594 subject) rides as the first BODY paragraph, ahead of the
    // provenance trailers, so it stays greppable without masquerading as a diff summary.
    // A failed numstat only drops the ±counts — never blocks the commit.
    let subject = g.subject;
    let intentBody: string | null = null;
    if (opts.diffSubjects !== false) {
      const ns = await runGit(['diff', '--cached', '--numstat', '--', ...g.files], repoPath);
      subject = diffDerivedSubject(g.files, ns.code === 0 ? parseNumstat(ns.stdout) : undefined);
      if (g.subject && g.subject !== DEFAULT_GIT_SYNC_SUBJECT) intentBody = g.subject;
    }
    const args = [...GIT_SYNC_IDENTITY_ARGS, 'commit', '--no-verify', '-m', `${subject}${suffix}`];
    if (intentBody) args.push('-m', intentBody);
    if (g.coAuthor) args.push('-m', `Co-Authored-By: ${g.coAuthor}`);
    // P-004 (deterministic-commit-workitem-attribution-2026-06-22): bounded provenance
    // trailers so the commit↔work-item link travels IN git history (and is read back
    // post-sync into git_sync_commit_attribution). Deterministic — from the ledger-derived
    // attribution, no LLM (D-004/D-006).
    if (g.agent) args.push('-m', `Papercusp-Agent: ${g.agent}`);
    if (g.workItems && g.workItems.length > 0) {
      args.push('-m', `Papercusp-Work-Item: ${g.workItems.slice(0, 20).join(', ')}`);
    }
    if (g.sessionId) args.push('-m', `Papercusp-Session: ${g.sessionId}`);
    if (g.planSlug) args.push('-m', `Papercusp-Plan: ${g.planSlug}`);
    const c = await runGit(args, repoPath);
    if (c.code === 0) committedAny = true;
    else if (!nothingToCommit(c)) {
      return { committedAny, error: `attributed commit failed: ${(c.stderr || c.stdout).trim().slice(0, 300)}` };
    }
  }
  return { committedAny };
}

/** The knobs the COMMIT half of one repo's sync needs (stage + content-guard + commit). */
interface CommitRepoOpts {
  message: string;
  maxBlobBytes: number;
  maxCommitTotalBytes: number;
  contentDetectors: ContentDetector[];
  deletionGuard: boolean;
  readText: (repoPath: string, relPath: string) => Promise<string | null>;
  writeText: (repoPath: string, relPath: string, text: string) => Promise<void>;
  log: (m: string) => void;
  staleTempPackMs: number;
  isTempPackOpen?: (path: string) => Promise<boolean | null>;
  /** Caller-supplied protected paths in THIS repo's relative coordinate space. */
  excludePaths: string[];
  /** P-004 (flag GIT_SYNC_DERIVED_ATTRIBUTION): path→agent map for THIS repo. When present
   *  + non-empty, dirty files are peeled into per-agent commits first; the catch-all
   *  `git add -A` commit (today's behavior) sweeps the remainder. Absent/empty = byte-identical
   *  to today's single commit. */
  attribution?: Map<string, FileAttribution>;
  /** WI-38594 (flag GIT_SYNC_DIFF_SUBJECTS): diff-derived commit subjects (see RunGitSyncOpts). */
  diffSubjects?: boolean;
}

/** JSON-serializable — checkpointed as the superproject `git-sync:pointer-bump` step output. */
interface CommitRepoResult {
  committedLocal: boolean;
  oversized: OversizedFile[];
  contentErrors: ContentOffender[];
  /** A REAL add/commit failure (index.lock race, corrupt index, embedded-repo fatal) —
   *  surfaced by the caller as a repo error. `nothing to commit` is NOT an error. */
  error?: string;
}

/**
 * WI-1416: the COMMIT half of one repo's sync — stage (`add -A` with oversized +
 * content-guard excludes) + commit. Replay-safe by construction: on an
 * already-committed (clean) tree it is a no-op (`nothing to commit` is benign), so
 * a durable-step re-run or a reaped-and-requeued fire cannot double-commit.
 */
async function commitOneRepo(runGit: RunGit, repoPath: string, o: CommitRepoOpts): Promise<CommitRepoResult> {
  const { message } = o;
  let committedLocal = false;
  let oversized: OversizedFile[] = [];
  let contentErrors: ContentOffender[] = [];
  if (await isDirty(runGit, repoPath)) {
    // EI-18 guard: never bake an unpushable blob into the range. Oversized dirty
    // files are excluded from the commit (`:(exclude,literal)` pathspecs) and
    // reported; everything else still syncs this tick.
    oversized = await findOversizedDirtyFiles(runGit, repoPath, o.maxBlobBytes);
    // WI-5738: the CUMULATIVE gate. Individually-fine files can still add up to
    // an accident (2,261 MB of extracted AppImage in files all < 95 MB, on
    // 2026-07-20) that the downstream publish guard could then only refuse,
    // terminally. Catch it here, where excluding is enough.
    const bulk = await findBulkDirtyExcess(
      runGit,
      repoPath,
      o.maxCommitTotalBytes,
      new Set(oversized.map((f) => f.path)),
    );
    if (bulk.length > 0) {
      o.log(
        `[git-sync] cumulative dirty set exceeds ${o.maxCommitTotalBytes} bytes — excluding ${bulk.length} large file(s) ` +
          `from this commit (left dirty): ${bulk
            .slice(0, 5)
            .map((f) => `${f.path} (${f.sizeBytes}B)`)
            .join('; ')}`,
      );
      oversized = [...oversized, ...bulk];
    }
    // EI-438 content guard (P-001/P-002, D-001): a dirty file that fails a content
    // detector (an .mdx that won't compile, a curly quote used as code) is EXCLUDED
    // from this commit and left dirty for the content-fixer — so one broken file
    // never stalls the rest of the tree's commit (quarantine, don't stall). Fails
    // OPEN: a throwing detector is skipped, never a blocker.
    contentErrors = await detectContentOffenders({
      runGit,
      repoPath,
      readText: (rel) => o.readText(repoPath, rel),
      writeText: (rel, text) => o.writeText(repoPath, rel, text),
      detectors: o.contentDetectors,
      log: o.log,
    });
    // EI-19932544083689229 quarantine-import guard (remedy #1 — ATOMICITY): a file
    // quarantined above (oversized, or excluded by a content detector — i.e. a file
    // that will have ZERO history in HEAD this tick) must not be committed WITHOUT
    // also holding back any OTHER dirty file — e.g. its own `*.test.*` sibling — that
    // imports it. Otherwise the importer commits alone and HEAD carries an
    // unresolvable relative import forever (an isolated checkout, e.g.
    // green-checkpoint's candidate build, gets the importer without its subject and
    // fails deterministically on every run). Quarantine the PAIR, never just the
    // broken half. Runs to a fixed point (a chain of dirty importers is caught too).
    //
    // Deliberately computed BEFORE the deletion guard below (not merged with its
    // output): a deletion-guard offender is a DIFFERENT shape — it excludes the
    // DELETION, so the file stays PRESENT in HEAD with its prior content, and a
    // dirty file importing it resolves FINE. Folding deletion offenders into this
    // guard's "infectious" set would falsely quarantine an unrelated clean importer.
    const preDeletionQuarantined = [...new Set([...oversized.map((f) => f.path), ...contentErrors.map((c) => c.file)])];
    // EI-17: a dirty DELETION whose module a surviving file still (relatively)
    // imports is excluded exactly like a content offender — see
    // deletion-import-guard.ts for why this can't be folded into the per-file
    // content-detector registry above (it's a cross-file check on the deletion
    // SET, not a single file's own text).
    // WI-39377: BEFORE the per-deletion import check, ask whether the deletion SET is a
    // wipe at all. detectUnsafeDeletions looks for a SURVIVING importer, so it is
    // structurally blind to a total wipe (no survivors => no finding) — which is exactly
    // how four SideStage submodules were committed down to zero-file trees and pushed.
    // Shares the deletionGuard flag: both are "should this deletion be committed?".
    if (o.deletionGuard) {
      const wipeErrors = await detectWholesaleDeletion({ runGit, repoPath, log: o.log });
      if (wipeErrors.length > 0) contentErrors = [...contentErrors, ...wipeErrors];
    }
    if (o.deletionGuard) {
      const deletionErrors = await detectUnsafeDeletions({
        runGit,
        repoPath,
        readText: (rel) => o.readText(repoPath, rel),
        log: o.log,
      });
      if (deletionErrors.length > 0) contentErrors = [...contentErrors, ...deletionErrors];
    }
    if (preDeletionQuarantined.length > 0) {
      const dirtyForScan = await dirtyFiles(runGit, repoPath);
      const importerErrors = await detectQuarantineImporters({
        readText: (rel) => o.readText(repoPath, rel),
        dirtyFiles: dirtyForScan,
        alreadyQuarantined: preDeletionQuarantined,
        isResolvableAtHead: (rel) => isModuleResolvableAtHead(runGit, repoPath, rel, o.log),
        log: o.log,
      });
      if (importerErrors.length > 0) contentErrors = [...contentErrors, ...importerErrors];
    }
    // Exclude BOTH oversized + content offenders (incl. unsafe deletions + quarantined
    // importers) from the auto-commit (deduped — a file can be both). Everything else
    // still syncs this tick.
    const excludePaths = [
      ...new Set([
        ...o.excludePaths,
        ...oversized.map((f) => f.path),
        ...contentErrors.map((c) => c.file),
      ]),
    ];
    // EI-21026041751032400: a live protected-path lock can name an ignored
    // untracked artifact. Git already omits that artifact from `add -A`, but
    // rejects the whole command when the artifact is also mentioned as a
    // negative pathspec. Filter only that population before either the
    // attribution path-specific adds or the catch-all stage; tracked ignored
    // paths remain protected by their exclusion pathspec.
    const ignoredUntrackedExcludes = await ignoredUntrackedSubset(runGit, repoPath, excludePaths);
    const stagingExcludePaths = excludePaths.filter((path) => !ignoredUntrackedExcludes.has(path));
    if (ignoredUntrackedExcludes.size > 0) {
      o.log(
        `[git-sync] ${repoPath}: pre-filtering ignored untracked protected path(s) ` +
          `[${[...ignoredUntrackedExcludes].join(', ')}] from staging pathspecs — Git already excludes them`,
      );
    }
    let committedAny = false;
    // P-004: when an attribution map is supplied (flag GIT_SYNC_DERIVED_ATTRIBUTION on), peel
    // each declaring agent's dirty files into its OWN commit (intent subject + Co-Authored-By)
    // BEFORE the catch-all. Absent/empty → no-op, so the flag-OFF path stays byte-identical.
    if (o.attribution && o.attribution.size > 0) {
      const res = await commitAttributedGroups(runGit, repoPath, o.attribution, stagingExcludePaths, message, {
        diffSubjects: o.diffSubjects,
      });
      if (res.error) {
        // STRANDING GUARD (2026-06-30): a failed per-agent attributed commit — e.g. an
        // index.lock race under heavy fleet contention — must NEVER short-circuit the
        // catch-all `git add -A` sweep below. Returning here strands the unattributed
        // REMAINDER: untracked NEW files (a new tool/module) whose `import` was already
        // committed in an earlier tick. The result is an UNBUILDABLE tree — "the agent's
        // code went missing", and every deploy preflight dies on `Cannot find module`.
        // Log it and FALL THROUGH; the catch-all commits everything still dirty (the
        // failed group's files + the remainder), so no file is ever left behind.
        o.log(
          `[git-sync] ${repoPath}: attributed-commit phase errored (${res.error}); falling through to the catch-all 'git add -A' sweep so no file strands`,
        );
      }
      committedAny = res.committedAny;
    }
    // Catch-all = today's single whole-tree commit: sweeps the unattributed remainder (or
    // EVERYTHING when no attribution), including anything a path-specific add missed (rename
    // origin-sides, etc.). Byte-identical to the pre-P-004 commit path.
    const buildAddArgs = (extraExcludes: string[], omittedExcludes: readonly string[] = []): string[] => {
      const omitted = new Set(omittedExcludes);
      const ex = [...new Set([...stagingExcludePaths, ...extraExcludes])].filter((path) => !omitted.has(path));
      return ex.length === 0 ? ['add', '-A'] : ['add', '-A', '--', '.', ...ex.map((p) => `:(exclude,literal)${p}`)];
    };
    // STRANDING GUARD (2026-06-30 ROOT CAUSE): a stray EMBEDDED git repo with no commit
    // ("error: '<path>' does not have a commit checked out") makes `git add -A` FATAL
    // (exit 128) → stages NOTHING → `git commit` reports "nothing" → the WHOLE tree strands
    // silently, every tick, for hours (a green-checkpoint test left a nested .git under
    // .papercusp/.vitest-tmpdir/). The add's exit code was previously UNCHECKED, so the fatal
    // was invisible. Now: check it; on that specific failure, parse the offending path(s),
    // EXCLUDE them, and retry ONCE so one stray repo can't strand everyone's work; if it STILL
    // fails, return a LOUD 'error' (caught by the git-sync-stall watchdog + escalation) instead
    // of silently reporting 'nothing'.
    let omittedIgnoredExcludes: string[] = [];
    let addRes = await runGit(buildAddArgs([]), repoPath);
    if (addRes.code !== 0) {
      // WI-40170: a protected path may ALSO be ignored. Git treats even a
      // negative pathspec as an explicit ignored-path mention and aborts the
      // entire add. The ignore rule already excludes it, so remove only those
      // redundant pathspecs and retry; never force-add the ignored file.
      const ignored = addFailureIgnoredPaths(`${addRes.stdout}\n${addRes.stderr}`).filter((path) =>
        excludePaths.includes(path),
      );
      if (ignored.length > 0) {
        omittedIgnoredExcludes = ignored;
        o.log(
          `[git-sync] ${repoPath}: 'git add -A' rejected ignored protected path(s) [${ignored.join(', ')}] — ` +
            'omitting those redundant exclusion pathspecs and retrying without force-adding ignored files',
        );
        addRes = await runGit(buildAddArgs([], omittedIgnoredExcludes), repoPath);
      }
      const stray = addFailureStrayPaths(`${addRes.stdout}\n${addRes.stderr}`);
      if (stray.length > 0) {
        o.log(
          `[git-sync] ${repoPath}: 'git add -A' FAILED on embedded/uncommitted repo(s) [${stray.join(', ')}] — excluding + retrying so the rest of the tree still commits (previously: silent strand)`,
        );
        addRes = await runGit(buildAddArgs(stray, omittedIgnoredExcludes), repoPath);
      }
      // TRANSIENT-ENOENT SELF-HEAL (EI-18094449017685490): git's tree-walk
      // enumerated a path an instant before some other process's atomic
      // write-tmp+rename made it vanish. This is NOT a stray embedded repo and NOT
      // a held index lock — it's a benign, fast-resolving race, so retry the exact
      // same add a bounded few times (immediate; the writer's rename completes in
      // milliseconds) rather than failing the whole tick's commit on one
      // already-gone temp file.
      for (
        let attempt = 1;
        addRes.code !== 0 &&
        isTransientStatFailure(`${addRes.stdout}\n${addRes.stderr}`) &&
        attempt <= TRANSIENT_STAT_FAILURE_MAX_RETRIES;
        attempt++
      ) {
        o.log(
          `[git-sync] ${repoPath}: 'git add -A' hit a transient ENOENT (a concurrent atomic-write race enumerated a path that vanished before stat) — retrying (attempt ${attempt}/${TRANSIENT_STAT_FAILURE_MAX_RETRIES})`,
        );
        await new Promise((resolve) => setTimeout(resolve, TRANSIENT_STAT_FAILURE_RETRY_DELAY_MS));
        addRes = await runGit(buildAddArgs(stray, omittedIgnoredExcludes), repoPath);
      }
      // STALE-LOCK SELF-HEAL (2026-07-04): a dead git process's orphaned index.lock
      // otherwise fails EVERY tick until a human clears it. Provably-stale only —
      // see clearStaleIndexLock.
      if (addRes.code !== 0 && isIndexLockFailure(`${addRes.stdout}\n${addRes.stderr}`)) {
        const cleared = await clearStaleIndexLock(runGit, repoPath, o.log);
        if (cleared) addRes = await runGit(buildAddArgs(stray, omittedIgnoredExcludes), repoPath);

        // LIVE-LOCK CONTENTION SELF-HEAL: another git process may be rebuilding the
        // index right now. The stale-lock helper deliberately refuses to touch a fresh
        // lock, but failing the whole tick immediately strands every agent's work for
        // a predictable, short-lived race. Retry the exact add with bounded exponential
        // backoff; if the writer remains live after the budget, the existing loud error
        // path still reports it and the next tick can re-check for an orphan.
        for (
          let attempt = 1;
          addRes.code !== 0 &&
          isIndexLockFailure(`${addRes.stdout}\n${addRes.stderr}`) &&
          attempt <= INDEX_LOCK_CONTENTION_MAX_RETRIES;
          attempt++
        ) {
          const delayMs = INDEX_LOCK_CONTENTION_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
          o.log(
            `[git-sync] ${repoPath}: 'git add -A' hit live index.lock contention — retrying after ${delayMs}ms (attempt ${attempt}/${INDEX_LOCK_CONTENTION_MAX_RETRIES})`,
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          addRes = await runGit(buildAddArgs(stray, omittedIgnoredExcludes), repoPath);
        }

        // A lock that was live at the first check may have become orphaned while the
        // bounded retries ran. Re-use the existing age-checked, unlink-only-when-stale
        // helper rather than ever deleting a still-fresh writer's lock.
        if (addRes.code !== 0 && isIndexLockFailure(`${addRes.stdout}\n${addRes.stderr}`)) {
          const clearedAfterRetry = await clearStaleIndexLock(runGit, repoPath, o.log);
          if (clearedAfterRetry) addRes = await runGit(buildAddArgs(stray, omittedIgnoredExcludes), repoPath);
        }
      }
      if (addRes.code !== 0) {
        return {
          committedLocal: false,
          error: `git add -A failed — the tree would strand uncommitted: ${(addRes.stderr || addRes.stdout).trim().slice(0, 300)}`,
          oversized,
          contentErrors,
        };
      }
    }
    // WI-38594 (flag GIT_SYNC_DIFF_SUBJECTS): the catch-all subject too is derived from
    // what is ACTUALLY staged (numstat over the staged set); the original message (the
    // sweep's intent/default stem, incl. its own [skip ci]) is demoted to the body for
    // traceability. Numstat failure or an empty staged set falls back to `message` alone
    // — byte-identical to the pre-WI-38594 commit.
    const commitArgs = [...GIT_SYNC_IDENTITY_ARGS, 'commit', '--no-verify'];
    let catchAllSubjected = false;
    if (o.diffSubjects !== false) {
      const ns = await runGit(['diff', '--cached', '--numstat'], repoPath);
      if (ns.code === 0) {
        const stats = parseNumstat(ns.stdout);
        if (stats.length > 0) {
          const subject = diffDerivedSubject(
            stats.map((s) => s.file),
            stats,
          );
          commitArgs.push('-m', `${subject}${skipCiSuffix(message)}`, '-m', message);
          catchAllSubjected = true;
        }
      }
    }
    if (!catchAllSubjected) commitArgs.push('-m', message);
    const c = await runGit(commitArgs, repoPath);
    if (c.code === 0) {
      committedAny = true;
    } else if (!nothingToCommit(c)) {
      // P-002: a real commit failure (index.lock race, corrupt index, a hook) is NOT
      // a merge conflict. If the still-dirty tree fell through to the merge phase it
      // would abort as a phantom 'conflict' with zero conflicted files and dispatch a
      // merge-resolver at nothing, while the true failure (agents' work not landing)
      // stayed invisible. Surface it as an error.
      return {
        committedLocal: false,
        error: `commit failed: ${(c.stderr || c.stdout).trim().slice(0, 300)}`,
        oversized,
        contentErrors,
      };
    }
    committedLocal = committedAny;
  }
  return { committedLocal, oversized, contentErrors };
}

/** JSON-serializable — checkpointed as the superproject `git-sync:push` step output. */
type ReconcilePushResult =
  | { status: 'nothing'; mergeCompleted?: boolean }
  | { status: 'synced'; pushed: boolean; merged: boolean; mergeCompleted?: boolean }
  | { status: 'conflict'; conflictedFiles: string[] }
  | { status: 'error'; message: string; mergeCompleted?: boolean };

export type ContainedAncestryBridgeResult =
  | { status: 'not-needed' }
  | { status: 'bridged'; sourceRef: string; joinedSha: string; changedPaths: string[] }
  | { status: 'declined'; reason: string }
  | { status: 'error'; message: string };

export type ContainedReleaseMainBridgeResult = ContainedAncestryBridgeResult;

const CONTAINED_ANCESTRY_BRIDGE_MAX_PATHS = 200;

/**
 * Join an arbitrary source commit into the current branch's ancestry without
 * changing the current branch's tree.
 *
 * This bridge is deliberately fail-closed. It runs only for the staging branch,
 * and only when EVERY path changed exclusively on the source has the exact same
 * Git tree entry (mode + object id, including deletions and gitlinks) at local
 * HEAD. Once proven, an `ours` merge records the source as a parent while
 * preserving the current tree. A mismatch is a no-op: callers never fabricate
 * ancestry over unrepresented content.
 *
 * Frozen-repair verification calls this with its local `repairHead` BEFORE any
 * main advance. git-sync's recovery wrapper below calls it with `origin/main`
 * when an older gate already promoted a sibling repair head.
 */
export async function bridgeContainedCommitIntoCurrentBranch(
  runGit: RunGit,
  repoPath: string,
  sourceRef: string,
  opts: { log: (message: string) => void },
): Promise<ContainedAncestryBridgeResult> {
  const exists = await runGit(['rev-parse', '--verify', '--quiet', sourceRef], repoPath);
  if (exists.code !== 0) return { status: 'not-needed' };

  const alreadyContained = await runGit(['merge-base', '--is-ancestor', sourceRef, 'HEAD'], repoPath);
  if (alreadyContained.code === 0) return { status: 'not-needed' };
  if (alreadyContained.code !== 1) {
    return { status: 'error', message: `could not compare HEAD with ${sourceRef}` };
  }

  const base = await runGit(['merge-base', 'HEAD', sourceRef], repoPath);
  const mergeBase = base.stdout.trim();
  if (base.code !== 0 || !mergeBase) {
    return { status: 'declined', reason: `${sourceRef} has no merge base with HEAD` };
  }

  const changed = await runGit(
    ['diff', '--name-only', '--no-renames', '-z', `${mergeBase}..${sourceRef}`],
    repoPath,
  );
  if (changed.code !== 0) {
    return { status: 'error', message: `could not enumerate ${sourceRef}-only paths` };
  }
  const changedPaths = changed.stdout.split('\0').filter(Boolean);
  if (changedPaths.length > CONTAINED_ANCESTRY_BRIDGE_MAX_PATHS) {
    return {
      status: 'declined',
      reason: `${sourceRef} changes ${changedPaths.length} paths (cap ${CONTAINED_ANCESTRY_BRIDGE_MAX_PATHS})`,
    };
  }

  for (const file of changedPaths) {
    const [onSource, onHead] = await Promise.all([
      runGit(['ls-tree', sourceRef, '--', file], repoPath),
      runGit(['ls-tree', 'HEAD', '--', file], repoPath),
    ]);
    if (onSource.code !== 0 || onHead.code !== 0) {
      return { status: 'error', message: `could not compare '${file}' across ${sourceRef} and HEAD` };
    }
    if (onSource.stdout.trim() !== onHead.stdout.trim()) {
      return {
        status: 'declined',
        reason: `${sourceRef}-only path '${file}' is not represented exactly on HEAD`,
      };
    }
  }

  const merge = await runGit(
    [...GIT_SYNC_IDENTITY_ARGS, 'merge', '--no-edit', '-s', 'ours', sourceRef],
    repoPath,
  );
  if (merge.code !== 0) {
    await runGit(['merge', '--abort'], repoPath);
    return {
      status: 'error',
      message: `contained ${sourceRef} ancestry bridge failed: ${(merge.stderr || merge.stdout).trim().slice(0, 300)}`,
    };
  }
  const joined = await runGit(['rev-parse', 'HEAD'], repoPath);
  const joinedSha = joined.stdout.trim();
  if (joined.code !== 0 || !joinedSha) {
    return { status: 'error', message: `contained ${sourceRef} bridge committed but HEAD could not be resolved` };
  }

  opts.log(
    `[git-sync] ${repoPath}: bridged fully-represented ${sourceRef} into current ancestry ` +
      `without changing the current tree (${changedPaths.length} source-only path(s))`,
  );
  return { status: 'bridged', sourceRef, joinedSha, changedPaths };
}

/** Refresh and reconcile the release gate's `main` lineage into canonical
 * staging. This is the post-incident wrapper; pre-promotion repair verification
 * reuses {@link bridgeContainedCommitIntoCurrentBranch} with its local head. */
export async function bridgeContainedReleaseMain(
  runGit: RunGit,
  repoPath: string,
  opts: { remote: string; branch: string; log: (message: string) => void },
): Promise<ContainedReleaseMainBridgeResult> {
  if (opts.branch !== 'staging') return { status: 'not-needed' };

  const mainRef = `${opts.remote}/main`;
  const fetched = await runNetworkGitWithGitHubHttpsFallback(
    runGit,
    ['fetch', opts.remote, 'main'],
    repoPath,
    opts.log,
  );
  if (fetched.code !== 0) {
    return {
      status: 'declined',
      reason: `could not refresh ${mainRef}: ${(fetched.stderr || fetched.stdout).trim().slice(0, 240)}`,
    };
  }
  return bridgeContainedCommitIntoCurrentBranch(runGit, repoPath, mainRef, {
    log: opts.log,
  });
}

/**
 * WI-1416: the RECONCILE+PUSH half of one repo's sync — resolve branch → fetch →
 * merge (handles diverged/behind) → push (one non-FF retry). Replay-safe: a re-run
 * re-fetches, proves an already-pushed HEAD is aligned, and skips the authenticated no-op push.
 */
async function reconcileAndPushOneRepo(
  runGit: RunGit,
  repoPath: string,
  o: CommitRepoOpts & { remote: string; defaultBranch: string; doPush: boolean },
  /** whether the commit half made a local commit this pass (drives the fetch-failure
   *  classification + the final nothing/synced verdict). */
  committedLocal: boolean,
): Promise<ReconcilePushResult> {
  const { remote, doPush } = o;
  // P-004: a detached HEAD (a fresh `git submodule update` leaves submodules detached)
  // must sync to the repo's OWN remote default branch (origin/HEAD → e.g. 'main'), NOT
  // the superproject's configured branch — o.defaultBranch carries 'staging' for the
  // live superproject, and using it for a detached submodule would push that submodule's
  // commits to the wrong branch and fail every tick with no clear cause. origin/HEAD
  // resolves the right branch; o.defaultBranch is only the last resort when even that is
  // unknown (and is now passed per-repo: 'main' for submodules, cfg.branch for the super).
  // P-011: HEAD's branch → the remote default (origin/HEAD) → the per-repo last-resort
  // default. If we reach the last resort the branch is a GUESS — make it LOUD (a wrong
  // guess would otherwise surface only as an opaque "push failed" escalation).
  const resolvedBranch =
    (await currentBranch(runGit, repoPath)) ?? (await remoteDefaultBranch(runGit, repoPath, remote));
  const branch = resolvedBranch ?? o.defaultBranch;
  if (!resolvedBranch) {
    o.log(
      `[git-sync] ${repoPath}: could not resolve a branch from HEAD or ${remote}/HEAD — falling back to '${o.defaultBranch}' (a wrong guess will fail the push; P-011)`,
    );
  }

  const stale = await scavengeStaleTempPacks(runGit, repoPath, o.log, {
    staleMs: o.staleTempPackMs,
    isOpen: o.isTempPackOpen,
  });
  if (stale.removed.length > 0) {
    o.log(
      `[git-sync] ${repoPath}: stale tmp_pack cleanup; pruned ${stale.removed.length} unopened unreferenced file(s), reclaimed ${stale.bytesReclaimed} bytes`,
    );
  }
  const zeroByteLooseObjects = await findZeroByteLooseObjects(runGit, repoPath);
  if (zeroByteLooseObjects.length > 0) {
    return {
      status: 'error',
      message:
        `local Git object database corrupt: ${zeroByteLooseObjects.length} zero-byte loose object(s): ` +
        `${zeroByteLooseObjects.join(', ')}; repair required before fetch`,
    };
  }
  const tempPacksBeforeFetch = await listTempPackFiles(runGit, repoPath);
  const fetch = await runNetworkGitWithGitHubHttpsFallback(runGit, ['fetch', remote, branch], repoPath, o.log);
  if (fetch.code !== 0) {
    const reclaimed = await pruneFailedFetchTempPacks(runGit, repoPath, tempPacksBeforeFetch, o.log);
    const cleanupNote =
      reclaimed.removed.length > 0
        ? `; pruned ${reclaimed.removed.length} newly-created unreferenced tmp_pack file(s), reclaimed ${reclaimed.bytesReclaimed} bytes`
        : '';
    if (cleanupNote) o.log(`[git-sync] ${repoPath}: failed fetch cleanup${cleanupNote}`);
    // Fetch failed (offline / transient). GAP-4: when we're meant to push and HEAD has
    // commits not on the last-known origin tip, those commits are NOT on origin — return
    // 'error' so runGitSync DEFERS the superproject. Otherwise the superproject would
    // commit + push a gitlink pointing at an unpushed submodule commit, which a fresh
    // clone can't resolve (this actually corrupted origin once). With push disabled, a
    // local commit is the expected local-only result.
    if (doPush) {
      const rl = await runGit(['rev-list', '--count', `${remote}/${branch}..HEAD`], repoPath);
      const aheadCount = rl.code === 0 ? Number.parseInt(rl.stdout.trim(), 10) || 0 : 1; // ref missing → assume unpushed
      if (committedLocal || aheadCount > 0) {
        return {
          status: 'error',
          message: `fetch failed; HEAD has unpushed commits not on ${remote}/${branch} (cannot reconcile)${cleanupNote}`,
        };
      }
      return { status: 'nothing' };
    }
    return committedLocal ? { status: 'synced', pushed: false, merged: false } : { status: 'nothing' };
  }

  const remoteRef = `${remote}/${branch}`;
  let seedTransplanted = false;
  const base = await runGit(['merge-base', 'HEAD', remoteRef], repoPath);
  if (base.code !== 0) {
    const seed = await transplantInstallerSeedSnapshot(runGit, repoPath, remoteRef, remote, o.log);
    if (seed.status === 'error') return { status: 'error', message: seed.message };
    seedTransplanted = seed.status === 'transplanted';
  }

  // WI-5111: a non-fast-forward merge creates its own commit under the box's git
  // identity too — same bot-identity override as the commit calls above, so a
  // merge commit git-sync makes is never misattributed to the owner either.
  const merge = await runGit([...GIT_SYNC_IDENTITY_ARGS, 'merge', '--no-edit', `${remote}/${branch}`], repoPath);
  if (merge.code !== 0) {
    const conflicted = await conflictedFiles(runGit, repoPath);
    const mergeOut = `${merge.stdout}\n${merge.stderr}`.trim();
    await runGit(['merge', '--abort'], repoPath); // clean tree
    // P-002: a failed merge with NO unmerged paths is not a content conflict a
    // merge-resolver can fix (e.g. "local changes would be overwritten", "not
    // something we can merge") — surface as error, don't dispatch a resolver at it.
    if (conflicted.length === 0) {
      // WI-6824: the ref pair rides in the MESSAGE, not a second log call — runGitSync's
      // `absorb` already logs every error verbatim, so the message is what reaches both
      // the journal and `last_error`. One channel, no divergence between the two records.
      const diag = await describeFailedMerge(runGit, repoPath, remote, branch, 'initial');
      return { status: 'error', message: `merge failed (no conflicted paths) [${diag}]: ${mergeOut.slice(0, 300)}` };
    }
    return { status: 'conflict', conflictedFiles: conflicted };
  }
  // A successful merge is evidence that this repo's merge stage completed cleanly,
  // even when it produced no merge commit. Keep that proof alive if a later push
  // fails: conflict resolution and push success are independent facts.
  let mergeCompleted = true;
  let mergedNew = seedTransplanted || !/Already up to date/i.test(merge.stdout);

  // Frozen repair heads are allowed to prove a patch, but canonical staging remains
  // the only branch git-sync publishes. If a previously-promoted repair head is a
  // sibling whose exact content is already represented here, join only its ancestry
  // before pushing staging. The helper declines on any content uncertainty.
  if (doPush && branch === 'staging') {
    const releaseBridge = await bridgeContainedReleaseMain(runGit, repoPath, {
      remote,
      branch,
      log: o.log,
    });
    if (releaseBridge.status === 'error') {
      return { status: 'error', message: releaseBridge.message, mergeCompleted };
    }
    if (releaseBridge.status === 'bridged') mergedNew = true;
    if (releaseBridge.status === 'declined') {
      o.log(`[git-sync] ${repoPath}: release-main ancestry bridge declined — ${releaseBridge.reason}`);
    }
  }

  let pushed = false;
  if (doPush) {
    // The successful fetch + merge gives us a current remote-tracking ref. When
    // HEAD has no commits beyond it, an authenticated push can move nothing and
    // should not be allowed to fail the whole harness on an unrelated credential
    // policy (EI-20328688606935149). If the comparison itself fails, retain the
    // existing push behavior so uncertainty can never strand a real commit.
    const ahead = await runGit(['rev-list', '--count', `${remoteRef}..HEAD`], repoPath);
    const aheadText = ahead.stdout.trim();
    const aheadCount = ahead.code === 0 && /^\d+$/.test(aheadText) ? Number.parseInt(aheadText, 10) : null;
    if (aheadCount !== 0) {
      let push = await runNetworkGitWithGitHubHttpsFallback(
        runGit,
        ['push', remote, `HEAD:${branch}`],
        repoPath,
        o.log,
      );
      if (push.code !== 0 && rejectedNonFastForward(push)) {
        // A peer pushed between our fetch and push — re-fetch + re-merge once.
        await runNetworkGitWithGitHubHttpsFallback(runGit, ['fetch', remote, branch], repoPath, o.log);
        const m2 = await runGit([...GIT_SYNC_IDENTITY_ARGS, 'merge', '--no-edit', `${remote}/${branch}`], repoPath);
        if (m2.code !== 0) {
          const conflicted = await conflictedFiles(runGit, repoPath);
          const m2Out = `${m2.stdout}\n${m2.stderr}`.trim();
          await runGit(['merge', '--abort'], repoPath);
          if (conflicted.length === 0) {
            const diag = await describeFailedMerge(runGit, repoPath, remote, branch, 'non-ff-retry');
            return { status: 'error', message: `merge failed (no conflicted paths) [${diag}]: ${m2Out.slice(0, 300)}` };
          }
          return { status: 'conflict', conflictedFiles: conflicted };
        }
        // The retry merge also completed cleanly; retain the positive proof for a
        // subsequent push error. A retry conflict/error returns above without proof.
        mergeCompleted = true;
        mergedNew = mergedNew || !/Already up to date/i.test(m2.stdout);
        push = await runNetworkGitWithGitHubHttpsFallback(runGit, ['push', remote, `HEAD:${branch}`], repoPath, o.log);
      }
      if (push.code !== 0) {
        return {
          status: 'error',
          message: `push failed: ${push.stderr.trim() || push.stdout.trim()}`,
          mergeCompleted,
        };
      }
      pushed = !/Everything up-to-date/i.test(`${push.stdout}\n${push.stderr}`);
    }
  }

  if (!committedLocal && !mergedNew && !pushed) return { status: 'nothing', mergeCompleted };
  return { status: 'synced', pushed, merged: mergedNew, mergeCompleted };
}

/**
 * Sync ONE repo (superproject or a single submodule) to origin: commit dirty →
 * fetch → merge (reconciling a diverged/behind remote) → push. Never throws.
 * Composed from the two halves above (each independently checkpointable for the
 * superproject; submodules run both halves inside one phase step).
 */
async function syncOneRepo(
  runGit: RunGit,
  repoPath: string,
  o: CommitRepoOpts & { remote: string; defaultBranch: string; doPush: boolean },
): Promise<RepoSyncResult> {
  const c = await commitOneRepo(runGit, repoPath, o);
  if (c.error) {
    return { status: 'error', message: c.error, oversized: c.oversized, contentErrors: c.contentErrors };
  }
  const r = await reconcileAndPushOneRepo(runGit, repoPath, o, c.committedLocal);
  return { ...r, oversized: c.oversized, contentErrors: c.contentErrors };
}

/**
 * Run one git-sync pass for `slug`. Syncs all submodules (recursively, deepest-first)
 * then the superproject. Returns a structured outcome; never throws. The caller
 * (git-sync-action) handles `conflict` (escalation + resolver, scoped to each repo
 * that conflicted) and records metadata.
 *
 * A conflict in ONE submodule no longer aborts the whole pass: every other submodule
 * still gets reconciled + pushed (a wedged libs/X must not block libs/Y). Conflicts +
 * errors are COLLECTED. The superproject, however, is only synced when EVERY submodule
 * reconciled — pushing the superproject while a submodule's local commits aren't yet on
 * its origin would publish a gitlink a fresh clone can't resolve. So a single
 * unreconciled submodule defers the superproject push to a later (clean) tick.
 */
export async function runGitSync(slug: string, opts: RunGitSyncOpts = {}): Promise<GitSyncOutcome> {
  const runGit = opts.runGit ?? defaultRunGit;
  const cfg = opts.config ?? {};
  const remote = cfg.remote ?? 'origin';
  const branch = cfg.branch ?? 'main';
  const doPush = cfg.push !== false;
  // EI-18689553108460319: submodule origin-push is INDEPENDENT of the superproject's
  // `push` flag — see the GitSyncConfig doc comment for why they must not share one knob.
  //
  // WI-6016: but that independence is OPT-IN, not the default. Defaulting it to `true`
  // regardless of `push` made the knob fail-OPEN and silently regressed the S0
  // no-direct-push invariant (AH-6, code-plane-federation.test.ts, 2026-06-20): a
  // JOINER — `decideGitSyncPush({ joinerSide: true })`, a read-only member clone whose
  // contribution path is fork-PR — carries push:false for a completely different reason
  // than a bridged hive does, and it must push NOTHING, ANYWHERE. A bare `push:false`
  // does not say WHICH reason applies, so the safe default is to follow `push` and let
  // the one caller that genuinely wants the split (git-sync-action's hive-mode override,
  // where the bridge owns only the SUPERPROJECT's canonical refs — never an
  // independently-hosted submodule library) opt back in EXPLICITLY.
  const doSubPush = cfg.pushSubmoduleOrigins !== undefined ? cfg.pushSubmoduleOrigins : doPush;
  const doSub = cfg.pushSubmodules !== false;
  const reconcileSuperprojectOrigin = cfg.reconcileSuperprojectOrigin !== false;
  const bridgeContainedReleaseMainOnCommitOnly = cfg.bridgeContainedReleaseMainOnCommitOnly === true;
  const message = cfg.message ?? `chore(git-sync): auto-commit ${slug} [skip ci]`;
  const maxBlobBytes = cfg.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES;
  const maxCommitTotalBytes = cfg.maxCommitTotalBytes ?? DEFAULT_MAX_COMMIT_TOTAL_BYTES;
  // WI-6824: this default was `() => {}`, and the SOLE production caller
  // (git-sync-action.ts) passes no `log` — so every line below was discarded in
  // production: oversized exclusions, content quarantines, merge conflicts, merge
  // ERRORS, and the P-011 branch-guess warning whose own comment says "make it LOUD".
  // That is why an unrelated-history merge failure could alarm the fleet for ~10h
  // across 39 sweeps while leaving ZERO occurrences in journald, recorded only in
  // routine metadata that the next healthy tick nulls. Defaulting to a REAL sink fixes
  // the class rather than one call site: a caller can no longer go dark by omission,
  // only by explicitly passing a silent log. Every call site here is an exceptional
  // event — a healthy tick still logs nothing.
  const log = opts.log ?? ((m: string) => console.warn(m));
  // WI-1416: the checkpoint seam — each phase below runs under `step` so a durable
  // caller records one operation_output per phase (see GitSyncStepRunner).
  const step: GitSyncStepRunner = opts.step ?? (async (_name, fn) => fn());
  // EI-438 content guard seams (default registry + fs reader; injectable for tests).
  const contentDetectors = opts.contentDetectors ?? DEFAULT_CONTENT_DETECTORS;
  const deletionGuard = opts.deletionGuard ?? true;
  const readText = opts.readText ?? defaultReadText;
  const writeText = opts.writeText ?? defaultWriteText;
  const toolCatalogRegenerator = opts.toolCatalogRegenerator ?? regenerateToolCatalogBeforeCommit;
  const protectedPaths = [...new Set((opts.excludePaths ?? []).map((path) => path.trim()).filter(Boolean))];
  const repoO = {
    remote,
    message,
    doPush,
    maxBlobBytes,
    maxCommitTotalBytes,
    contentDetectors,
    deletionGuard,
    readText,
    writeText,
    log,
    staleTempPackMs: opts.staleTempPackMs ?? STALE_TEMP_PACK_MS,
    isTempPackOpen: opts.isTempPackOpen,
    diffSubjects: opts.diffSubjects ?? true,
    excludePaths: protectedPaths,
  };

  const repo = opts.repoPath === undefined ? await projectDirForSlug(slug) : opts.repoPath;
  if (!repo) {
    return {
      status: 'error',
      errors: [{ scope: 'superproject', message: `no repo path registered for harness '${slug}'` }],
      pushed: [],
      merged: [],
      mergeCompleted: [],
      oversized: [],
      contentErrors: [],
      // No repo to inspect: nothing was measured, so null (never []) — an all-clear we
      // did not earn would retire a live strand escalation.
      strandedSubmodules: null,
    };
  }

  // P-004: the live roster (active agents + their declared files) for THIS tick, supplied by
  // the caller flag-gated. Empty when the flag is OFF (or no caller) → no attribution, today's
  // single-commit behavior. Read ONCE; per-repo maps are derived below (super + each submodule).
  const roster = opts.loadRoster ? await opts.loadRoster() : [];

  /** One phase's collected results — JSON-serializable so it checkpoints as a step output. */
  interface PhaseCollect {
    conflicts: RepoConflict[];
    errors: RepoError[];
    pushed: string[];
    merged: string[];
    mergeCompleted: string[];
    oversized: ScopedOversized[];
    contentErrors: ScopedContentError[];
    /** Checkpoint the census with the phase. Outer mutable state disappears on replay,
     *  turning a measured [] into null and changing the reconstructed outcome. */
    strandedSubmodules: StrandedSubmodule[] | null;
    /** Persist the discovered repo coordinates so a resumed pointer-bump can still
     * filter submodule-relative protected paths out of the superproject stage. */
    submodulePaths: string[];
    didSomething: boolean;
  }
  const emptyPhase = (): PhaseCollect => ({
    conflicts: [],
    errors: [],
    pushed: [],
    merged: [],
    mergeCompleted: [],
    oversized: [],
    contentErrors: [],
    strandedSubmodules: null,
    submodulePaths: [],
    didSomething: false,
  });

  const absorb = (into: PhaseCollect, scope: string, r: RepoSyncResult): void => {
    if (r.mergeCompleted) into.mergeCompleted.push(scope);
    if (r.oversized.length > 0) {
      into.oversized.push(...r.oversized.map((f) => ({ scope, ...f })));
      log(
        `[git-sync] ${scope}: EXCLUDED ${r.oversized.length} oversized file(s) from the auto-commit (${r.oversized.map((f) => `${f.path} ${(f.sizeBytes / 1048576).toFixed(1)}MB`).join(', ')}) — gitignore or remove them (${slug})`,
      );
    }
    if (r.contentErrors.length > 0) {
      // EI-438 (D-001): broken files were EXCLUDED from this commit + left dirty for the
      // content-fixer; the rest of the tree still committed. Like oversized, this does
      // NOT defer the superproject (the (sub)repo's commit WITHOUT the broken file IS on
      // its origin, so the parent gitlink resolves).
      into.contentErrors.push(...r.contentErrors.map((c) => ({ scope, ...c })));
      log(
        `[git-sync] ${scope}: QUARANTINED ${r.contentErrors.length} broken file(s) from the auto-commit (${r.contentErrors.map((c) => `${c.file} [${c.detectorKey}]`).join(', ')}) — content-fixer dispatched (${slug})`,
      );
    }
    if (r.status === 'conflict') {
      into.conflicts.push({ scope, conflictedFiles: r.conflictedFiles });
      log(
        `[git-sync] ${scope}: merge conflict (${r.conflictedFiles.join(', ')}) — aborted clean, continuing (${slug})`,
      );
    } else if (r.status === 'error') {
      into.errors.push({ scope, message: r.message });
      log(`[git-sync] ${scope}: ${r.message} — continuing (${slug})`);
    } else if (r.status === 'synced') {
      into.didSomething = true;
      if (r.pushed) into.pushed.push(scope);
      if (r.merged) into.merged.push(scope);
    }
  };

  // PHASE `git-sync:submodules` — every submodule, deepest-first (dynamic recursive
  // discovery). Each is independent: a conflict/error in one is collected; the rest
  // still sync. Runs as ONE checkpointed step: the expensive multi-repo half of the
  // pass, after which a resumed fire never re-commits/re-pushes the submodules.
  const sub = await step('git-sync:submodules', async (): Promise<PhaseCollect> => {
    const out = emptyPhase();
    let subPaths: string[] = [];
    if (doSub) {
      // EI-20329530284626235: `.gitmodules` is the canonical transport declaration,
      // but an initialized submodule keeps a copied URL in its own `remote.origin.url`.
      // That copy survives later `.gitmodules` changes, so git-sync could keep pushing
      // through a stale HTTPS credential path even after the canonical URL moved to SSH.
      // Reconcile the copies before discovery or any submodule fetch/push. A failure is
      // correctness-relevant: continuing would knowingly use an unverified transport,
      // so report it and defer the superproject push like every other submodule error.
      let urlSync = await runGit(['submodule', 'sync', '--recursive'], repo);
      // EI-20345390379109755: an interrupted config writer (or a fleet-sandbox
      // mask artifact) can strand a zero-byte `.git/config.lock`. The index
      // phase already self-heals its equivalent lock; apply the same age guard
      // here, then retry once. A fresh lock is never touched.
      if (urlSync.code !== 0 && isConfigLockFailure(`${urlSync.stdout}\n${urlSync.stderr}`)) {
        const cleared = await clearStaleConfigLock(runGit, repo, log);
        if (cleared) urlSync = await runGit(['submodule', 'sync', '--recursive'], repo);

        // EI-20347384139844425: a fresh config.lock is live contention, not an
        // orphan we may delete. It is nevertheless normally gone within a few
        // milliseconds. Retry the exact idempotent sync with the same bounded
        // exponential-backoff pattern as live index.lock contention; persistent
        // failures still surface and the next guard can remove only a lock that
        // has since become provably stale.
        for (
          let attempt = 1;
          urlSync.code !== 0 &&
          isConfigLockFailure(`${urlSync.stdout}\n${urlSync.stderr}`) &&
          attempt <= CONFIG_LOCK_CONTENTION_MAX_RETRIES;
          attempt++
        ) {
          const delayMs = CONFIG_LOCK_CONTENTION_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
          log(
            `[git-sync] ${repo}: canonical submodule URL sync hit live config.lock contention — retrying after ${delayMs}ms (attempt ${attempt}/${CONFIG_LOCK_CONTENTION_MAX_RETRIES})`,
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          urlSync = await runGit(['submodule', 'sync', '--recursive'], repo);
        }

        if (urlSync.code !== 0 && isConfigLockFailure(`${urlSync.stdout}\n${urlSync.stderr}`)) {
          const clearedAfterRetry = await clearStaleConfigLock(runGit, repo, log);
          if (clearedAfterRetry) urlSync = await runGit(['submodule', 'sync', '--recursive'], repo);
        }
      }
      if (urlSync.code !== 0) {
        const detail = (urlSync.stderr || urlSync.stdout || 'no output').trim().slice(0, 300);
        const message = `canonical submodule URL sync failed: ${detail}`;
        out.errors.push({ scope: 'submodule-config', message });
        log(`[git-sync] submodule-config: ${message} — deferring submodule work and superproject push (${slug})`);
        return out;
      }
      subPaths = opts.submodulePaths
        ? [...opts.submodulePaths].sort((a, b) => b.split('/').length - a.split('/').length)
        : await discoverSubmodulesRecursive(runGit, repo, log, (census) => {
            // EI-20402093158205519: record the strand census measured by THIS pass. An
            // explicit submodulePaths override (tests) skips discovery entirely and so
            // measures nothing — this stays null, and null never implies an all-clear.
            out.strandedSubmodules = census;
          });
      out.submodulePaths = [...subPaths];
    }
    for (const s of subPaths) {
      // P-004: a submodule's last-resort default is its own 'main' (resolved via
      // origin/HEAD first), never the superproject's branch (cfg.branch = 'staging').
      // EI-18689553108460319: submodules push under `doSubPush`, NOT the superproject's
      // `doPush` — a bridged/p2p-only hive's push:false must not silently strand every
      // submodule's commits too (see GitSyncConfig.pushSubmoduleOrigins).
      absorb(
        out,
        s,
        await syncOneRepo(runGit, join(repo, s), {
          ...repoO,
          doPush: doSubPush,
          defaultBranch: 'main',
          // The caller supplies workspace/superproject-root-relative paths, while
          // git commands inside a submodule use that submodule's own root. This is
          // the same coordinate mapping used by git-sync attribution.
          excludePaths: protectedPaths
            .filter((path) => path.startsWith(`${s}/`))
            .map((path) => path.slice(s.length + 1))
            .filter(Boolean),
          attribution: attributionMapForRepo(roster, s, repo),
        }),
      );
    }
    return out;
  });
  const strandedSubmodules = sub.strandedSubmodules;
  // `submodulePaths` is part of the checkpointed phase output. The fallback keeps
  // compatibility with an older in-flight checkpoint created before that field
  // existed when the caller supplied an explicit path list.
  const submodulePaths = sub.submodulePaths ?? opts.submodulePaths ?? [];

  // Superproject last. An unreconciled submodule defers its PUSH — and ONLY its push.
  // (Oversized exclusions defer nothing: the submodule's commit — without the big
  // file — IS on its origin, so the parent gitlink resolves fine.)
  //
  // EI-20182436053613562: the deferral used to gate the local COMMIT as well, which is
  // strictly more than the invariant needs. Publishing a superproject commit whose
  // gitlinks reference unpushed submodule commits is what breaks a fresh clone, so the
  // PUSH must wait. A local commit publishes nothing, cannot strand a gitlink, and is
  // what the release gate cuts its candidate from (it reads local `staging` and never
  // fetches). Gating it too meant ONE permanently-failing submodule push — a GitHub 403
  // that no retry can ever clear — froze every agent's ordinary, non-submodule work in
  // the shared dirty tree indefinitely: measured at 12h and 24 dirty paths, including
  // untracked files that existed on no other disk and were therefore not even
  // recoverable from the reflog. This log line always SAID "deferring superproject
  // push"; now the code does only that.
  const supr = emptyPhase();
  let superHeadSha: string | undefined;
  const pushBlocked = sub.conflicts.length > 0 || sub.errors.length > 0;
  // A submodule-relative protected path is valid for `git add` inside that
  // submodule, but Git rejects the same pathspec from the superproject with
  // "Pathspec ... is in submodule". Keep only paths in the superproject's own
  // coordinate space for its catch-all stage; each submodule received its mapped
  // exclusions above.
  const superprojectExcludePaths = protectedPaths.filter(
    (path) => !submodulePaths.some((s) => path === s || path.startsWith(`${s}/`)),
  );

  // PHASE `git-sync:pointer-bump` — superproject stage + content-guard + commit (this
  // commit is what bakes the bumped submodule pointers in). ALWAYS runs.
  const commitRes = await step('git-sync:pointer-bump', async () => {
    // WI-39922: close the edit→auto-commit window that let a stale tracked catalog
    // reach the green gate hours later. Keep the catch HERE even though the default
    // implementation is defensive: an injected/future regenerator must never turn
    // this repair into a fleet-wide commit wedge.
    try {
      await toolCatalogRegenerator({ runGit, repoPath: repo, log });
    } catch (e) {
      log(
        `[git-sync] ${repo}: tool-catalog pre-commit repair threw (${String(e)}) — continuing with the commit fail-soft`,
      );
    }
    return commitOneRepo(runGit, repo, {
      ...repoO,
      excludePaths: superprojectExcludePaths,
      attribution: attributionMapForRepo(roster, '', repo),
    });
  });
  let repoResult: RepoSyncResult;
  if (commitRes.error) {
    repoResult = {
      status: 'error',
      message: commitRes.error,
      oversized: commitRes.oversized,
      contentErrors: commitRes.contentErrors,
    };
  } else if (pushBlocked) {
    // Committed locally (or there was nothing to commit); the network half waits for a
    // tick on which every submodule reconciled. Same shape reconcileAndPushOneRepo
    // returns for its own committed-but-did-not-push case (the offline path).
    superHeadSha = await headSha(runGit, repo);
    repoResult = commitRes.committedLocal
      ? {
          status: 'synced',
          pushed: false,
          merged: false,
          oversized: commitRes.oversized,
          contentErrors: commitRes.contentErrors,
        }
      : { status: 'nothing', oversized: commitRes.oversized, contentErrors: commitRes.contentErrors };
    log(
      `[git-sync] ${sub.conflicts.length} conflict(s) + ${sub.errors.length} error(s) in submodules — superproject ${commitRes.committedLocal ? 'COMMITTED locally' : 'had nothing to commit'}, deferring only its push (${slug})`,
    );
  } else if (!reconcileSuperprojectOrigin) {
    // EI-20232774599730947: a bridged/p2p-only member is truly commit-only at
    // this layer. GitHub ingress + admission and the P2P worktree bridge own
    // remote-to-worktree flow; fetching/merging origin here is both redundant
    // and unsafe for an installer seed whose local P2P lineage intentionally
    // remains unrelated to GitHub main.
    //
    // WI-40066: a frozen repair may still have advanced release main on a
    // sibling commit after its exact patch already landed through canonical
    // staging. Legacy mode repairs that ancestry inside reconcileAndPushOneRepo,
    // but this branch deliberately never calls the origin/staging reconciler.
    // A bridged caller can opt into the same fail-closed proof as a standalone
    // checkpointed phase: fetch main, require every main-only tree entry to be
    // byte-identical, then record only the ancestry. The later P2P legs publish
    // and integrate this HEAD; this phase itself still pushes nothing.
    const releaseBridge = bridgeContainedReleaseMainOnCommitOnly
      ? await step('git-sync:push', () =>
          bridgeContainedReleaseMain(runGit, repo, {
            remote,
            branch,
            log,
          }),
        )
      : { status: 'not-needed' as const };
    superHeadSha = await headSha(runGit, repo);
    if (releaseBridge.status === 'error') {
      repoResult = {
        status: 'error',
        message: releaseBridge.message,
        oversized: commitRes.oversized,
        contentErrors: commitRes.contentErrors,
      };
    } else {
      if (releaseBridge.status === 'declined') {
        log(`[git-sync] ${repo}: release-main ancestry bridge declined — ${releaseBridge.reason}`);
      }
      const bridged = releaseBridge.status === 'bridged';
      repoResult = commitRes.committedLocal || bridged
        ? {
            status: 'synced',
            pushed: false,
            merged: bridged,
            oversized: commitRes.oversized,
            contentErrors: commitRes.contentErrors,
          }
        : { status: 'nothing', oversized: commitRes.oversized, contentErrors: commitRes.contentErrors };
    }
  } else {
    // PHASE `git-sync:push` — superproject fetch + merge + push (the network half).
    const pushRes = await step('git-sync:push', async () => ({
      ...(await reconcileAndPushOneRepo(runGit, repo, { ...repoO, defaultBranch: branch }, commitRes.committedLocal)),
      headSha: await headSha(runGit, repo),
    }));
    superHeadSha = pushRes.headSha;
    repoResult = { ...pushRes, oversized: commitRes.oversized, contentErrors: commitRes.contentErrors };
  }
  absorb(supr, 'superproject', repoResult);

  const conflicts = [...sub.conflicts, ...supr.conflicts];
  const errors = [...sub.errors, ...supr.errors];
  const pushed = [...sub.pushed, ...supr.pushed];
  const merged = [...sub.merged, ...supr.merged];
  const mergeCompleted = [...sub.mergeCompleted, ...supr.mergeCompleted];
  const oversized = [...sub.oversized, ...supr.oversized];
  const contentErrors = [...sub.contentErrors, ...supr.contentErrors];
  const didSomething = sub.didSomething || supr.didSomething;

  if (conflicts.length > 0)
    return { status: 'conflict', conflicts, errors, pushed, merged, mergeCompleted, oversized, contentErrors, strandedSubmodules };
  if (errors.length > 0)
    return { status: 'error', errors, pushed, merged, mergeCompleted, oversized, contentErrors, strandedSubmodules };
  // NOTE 'nothing' carries the census too. A tick that commits nothing is the MOST likely
  // one to be stranding work — the visible tree is clean precisely because the dirty repo
  // is invisible — so this is the last status that should omit it.
  if (!didSomething) return { status: 'nothing', mergeCompleted, oversized, contentErrors, strandedSubmodules };
  // superHeadSha comes from the push step's checkpoint; a 'synced' verdict implies that
  // step ran (blocked/commit-error passes return above). Fallback read for safety only.
  return {
    status: 'synced',
    headSha: superHeadSha ?? (await headSha(runGit, repo)),
    pushed,
    merged,
    mergeCompleted,
    oversized,
    contentErrors,
    strandedSubmodules,
  };
}
