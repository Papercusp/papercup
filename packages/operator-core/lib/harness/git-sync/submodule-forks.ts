/**
 * submodule-forks — working-copy (review) mode for repositories WITH submodules
 * (plan slack-asana-reproduced-bug-fix-pr-workflow-2026-10-08 P-014, decision D-017;
 * WI-10006416, which replaced the fail-closed refusal shipped by WI-10006107).
 *
 * A working copy keeps unreviewed work OUT of the main repository. A submodule is its
 * own main repository, so the same rule applies one level down: a submodule's commits
 * go to the POT'S FORK OF THAT SUBMODULE, never to the submodule's `origin`.
 *
 *   - Storage: one fork per submodule path (recursive, superproject-relative), in the
 *     federated hive_settings key {@link SUBMODULE_FORKS_SETTING_KEY}. `.gitmodules` is
 *     never rewritten: a rewrite would ride the standing PR into the main repository.
 *   - git-sync: each submodule checkout gets the same `pot-fork` remote name the
 *     superproject uses, so git-sync's shared `remote` reaches the right fork at every
 *     level. Its fork's integration branch is seeded at the submodule's LOCAL HEAD
 *     (the fork's own main would fast-forward the checkout and silently bump the pin).
 *   - Publication: a gitlink is UNPUBLISHED while its commit is not an ancestor of its
 *     submodule's main-repository default branch ({@link findUnpublishedGitlinks}).
 *     Promotion opens a submodule standing PR for each, and the merge gate refuses the
 *     superproject PR until none remain.
 *
 * Fail direction is the working copy's: anything unknown or unset means commit-only,
 * never a push to a main repository.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Sql } from 'postgres';
import { getHiveSetting, setHiveSetting } from '../../hive-settings-store';
import { parseGithubUrl } from '../clone-github';
import type { EnsureForkOpts, EnsureForkResult } from '../ensure-fork';
import { parseGitlinkDiff, type GitlinkRef } from './gitlinks';
import {
  ensurePotForkGitRemote,
  ensureWorkingCopyIntegrationBranch,
  POT_FORK_REMOTE_NAME,
  WORKING_COPY_INTEGRATION_BRANCH,
  type RunGit,
} from './pot-integration-mode';

/** The federated hive_settings key holding `{ "<submodule path>": "<fork url>" }` (D-017). */
export const SUBMODULE_FORKS_SETTING_KEY = 'hiveGit.submoduleForks';

/** Superproject-relative submodule path → the pot's fork URL of that submodule. */
export type SubmoduleForks = Record<string, string>;

export type SubmoduleForksRead =
  | { source: 'set' | 'absent'; forks: SubmoduleForks }
  | { source: 'malformed' | 'error'; forks: SubmoduleForks };

/** PURE: a stored value is usable only as a flat object of non-empty strings. */
export function coerceSubmoduleForks(value: unknown): SubmoduleForks | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: SubmoduleForks = {};
  for (const [path, url] of Object.entries(value as Record<string, unknown>)) {
    if (!path || typeof url !== 'string' || !url.trim()) return null;
    out[path] = url.trim();
  }
  return out;
}

/** Read the pot's submodule forks. Never throws; `malformed`/`error` must be treated as unusable. */
export async function readSubmoduleForks(
  workspaceId: string,
  potHomeSlug: string,
  sql?: Sql,
): Promise<SubmoduleForksRead> {
  let rec: Awaited<ReturnType<typeof getHiveSetting>>;
  try {
    rec = await getHiveSetting(workspaceId, potHomeSlug, SUBMODULE_FORKS_SETTING_KEY, sql);
  } catch {
    return { source: 'error', forks: {} };
  }
  if (!rec || rec.value == null) return { source: 'absent', forks: {} };
  const forks = coerceSubmoduleForks(rec.value);
  return forks ? { source: 'set', forks } : { source: 'malformed', forks: {} };
}

export async function recordSubmoduleForks(
  workspaceId: string,
  potHomeSlug: string,
  forks: SubmoduleForks,
  sql?: Sql,
): Promise<void> {
  await setHiveSetting({ workspaceId, potHomeSlug, settingKey: SUBMODULE_FORKS_SETTING_KEY, value: forks }, sql);
}

/** One submodule as `.gitmodules` declares it. */
export interface SubmoduleEntry {
  /** Superproject-relative path (nested submodules are prefixed by their parent's path). */
  path: string;
  /** The submodule's main repository URL, exactly as `.gitmodules` records it. */
  url: string;
}

/** PURE: parse `git config --get-regexp '^submodule\..*\.(path|url)$'` output. */
export function parseGitmodulesConfig(stdout: string): Array<{ path: string; url: string }> {
  const byName = new Map<string, { path?: string; url?: string }>();
  for (const line of stdout.split('\n')) {
    const m = /^submodule\.(.+)\.(path|url) (.*)$/.exec(line.trim());
    if (!m) continue;
    const entry = byName.get(m[1]!) ?? {};
    entry[m[2] as 'path' | 'url'] = m[3]!.trim();
    byName.set(m[1]!, entry);
  }
  return [...byName.values()]
    .filter((e): e is { path: string; url: string } => Boolean(e.path && e.url))
    .map((e) => ({ path: e.path.replace(/\/+$/, ''), url: e.url }));
}

/** Code-returning git, as git-sync and sync-back run it (never throws on a git failure). */
export type CodeRunGit = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;

/**
 * Every submodule of the checkout, recursively, from the working tree's `.gitmodules`
 * files. A nested submodule is listed only when its parent is checked out (its
 * `.gitmodules` is only readable then); one that is not checked out has no local
 * commits for git-sync to push.
 */
export async function listSubmodules(repoPath: string, runGit: CodeRunGit, prefix = '', depth = 0): Promise<SubmoduleEntry[]> {
  if (depth > 8 || !existsSync(join(repoPath, '.gitmodules'))) return [];
  const r = await runGit(['config', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.(path|url)$'], repoPath);
  // `git config --get-regexp` exits 1 when nothing matches: an empty .gitmodules.
  if (r.code !== 0 && r.code !== 1) throw new Error(`could not read ${join(repoPath, '.gitmodules')}: ${r.stderr.trim()}`);
  const out: SubmoduleEntry[] = [];
  for (const e of parseGitmodulesConfig(r.stdout)) {
    const path = prefix ? `${prefix}/${e.path}` : e.path;
    out.push({ path, url: e.url });
    out.push(...(await listSubmodules(join(repoPath, e.path), runGit, path, depth + 1)));
  }
  return out;
}

/** Submodule paths with no recorded fork: the working copy cannot carry them. */
export function missingSubmoduleForks(submodules: readonly SubmoduleEntry[], forks: SubmoduleForks): string[] {
  return submodules.filter((s) => !forks[s.path]).map((s) => s.path);
}

// ─── git-sync: point each submodule at its fork ─────────────────────────────

export type SubmoduleForkSetupResult =
  | {
      ok: true;
      configured: string[];
      /** WI-6554700010018380: checked-out submodules with no recorded fork whose HEAD is
       *  already contained in a remote ref. git-sync leaves them untouched (no commit,
       *  merge or push inside them), so the superproject's gitlink keeps resolving. */
      unforked: string[];
    }
  | {
      ok: false;
      reason: 'working_copy_submodule_fork_missing' | 'working_copy_submodule_setup_failed';
      path: string;
      message: string;
      /** Submodules with no recorded fork, when known. git-sync skips them even on a
       *  commit-only tick, so it never adds local commits nothing can publish. */
      unforked?: string[];
    };

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Make sure the submodule's fork has the working-copy integration branch. Seeded at the
 * submodule's LOCAL HEAD: that is the commit the superproject pins, so git-sync's next
 * fetch finds nothing to merge. Seeding at the fork's main (as the superproject does)
 * would fast-forward the checkout past its pin and bump the gitlink in the PR.
 */
export async function ensureSubmoduleForkBranch(
  subDir: string,
  runGit: RunGit,
): Promise<{ kind: 'present' } | { kind: 'seeded' } | { kind: 'unknown'; message: string } | { kind: 'failed'; message: string }> {
  const branch = WORKING_COPY_INTEGRATION_BRANCH;
  try {
    await runGit(['rev-parse', '--verify', '--quiet', `refs/remotes/${POT_FORK_REMOTE_NAME}/${branch}`], subDir);
    return { kind: 'present' };
  } catch {
    /* not fetched yet — ask the fork */
  }
  let listed: string;
  try {
    listed = (await runGit(['ls-remote', POT_FORK_REMOTE_NAME, `refs/heads/${branch}`], subDir)).stdout;
  } catch (err) {
    return { kind: 'unknown', message: errText(err) };
  }
  if (listed.trim()) return { kind: 'present' };
  try {
    await runGit(['push', POT_FORK_REMOTE_NAME, `HEAD:refs/heads/${branch}`], subDir);
  } catch (err) {
    return { kind: 'failed', message: `could not create the submodule fork's '${branch}': ${errText(err)}` };
  }
  return { kind: 'seeded' };
}

/**
 * git-sync's working-copy leg for submodules: each checked-out submodule with a recorded
 * fork gets its `pot-fork` remote pointed at it, its checkout attached to the integration
 * branch, and that branch created on the fork. A submodule with NO fork is returned in
 * `unforked` when its HEAD is already published, and refuses the tick (commit-only) when
 * it is not (WI-6554700010018380). The first failure stops the tick's pushes, naming the
 * submodule. Missing forks are judged for EVERY submodule before any submodule is
 * touched, so a refusal leaves no remote or fork changed.
 */
export async function applySubmoduleForkRemotes(
  repoPath: string,
  forks: SubmoduleForks,
  deps: { runGit: RunGit; codeRunGit: CodeRunGit; log?: (line: string) => void },
): Promise<SubmoduleForkSetupResult> {
  let submodules: SubmoduleEntry[];
  try {
    submodules = await listSubmodules(repoPath, deps.codeRunGit);
  } catch (err) {
    return { ok: false, reason: 'working_copy_submodule_setup_failed', path: '.gitmodules', message: errText(err) };
  }
  // Not checked out: nothing local to push.
  const checkedOut = submodules.filter((sub) => existsSync(join(repoPath, sub.path, '.git')));
  const missing = missingSubmoduleForks(checkedOut, forks);
  // WI-6554700010018380: a submodule can have no fork for a legitimate reason (its main
  // repository is owned by the fork account itself, so GitHub cannot fork it). If its
  // HEAD is already in a remote ref, the gitlink resolves without a fork: git-sync
  // leaves that submodule untouched and the rest of the pot still pushes. Only a
  // submodule carrying commits no remote holds refuses the tick (commit-only).
  const unpublished: string[] = [];
  for (const path of missing) {
    const contained = await deps.codeRunGit(
      ['for-each-ref', '--contains', 'HEAD', '--count=1', '--format=%(refname)', 'refs/remotes/'],
      join(repoPath, path),
    );
    if (contained.code !== 0 || !contained.stdout.trim()) unpublished.push(path);
  }
  if (unpublished.length) {
    return {
      ok: false,
      reason: 'working_copy_submodule_fork_missing',
      path: unpublished[0],
      unforked: missing,
      message:
        `submodule${unpublished.length > 1 ? 's' : ''} ${unpublished.map((p) => `'${p}'`).join(', ')} ` +
        `ha${unpublished.length > 1 ? 've' : 's'} no fork recorded for this working copy (${SUBMODULE_FORKS_SETTING_KEY}) ` +
        'and a HEAD that no remote ref contains (unpublished commits)',
    };
  }
  if (missing.length) {
    deps.log?.(
      `submodule${missing.length > 1 ? 's' : ''} ${missing.map((p) => `'${p}'`).join(', ')} ` +
        `ha${missing.length > 1 ? 've' : 's'} no fork but a published HEAD — left untouched (no commit, merge or push inside)`,
    );
  }
  const configured: string[] = [];
  for (const sub of checkedOut.filter((s) => !missing.includes(s.path))) {
    const subDir = join(repoPath, sub.path);
    const fork = forks[sub.path];
    try {
      await ensurePotForkGitRemote(subDir, fork, deps.runGit);
    } catch (err) {
      return {
        ok: false,
        reason: 'working_copy_submodule_setup_failed',
        path: sub.path,
        message: `could not set the ${POT_FORK_REMOTE_NAME} remote: ${errText(err)}`,
      };
    }
    const layout = await ensureWorkingCopyIntegrationBranch(subDir, deps.runGit);
    if (layout.kind === 'conflict') {
      return { ok: false, reason: 'working_copy_submodule_setup_failed', path: sub.path, message: layout.message };
    }
    const seed = await ensureSubmoduleForkBranch(subDir, deps.runGit);
    if (seed.kind === 'failed') {
      return { ok: false, reason: 'working_copy_submodule_setup_failed', path: sub.path, message: seed.message };
    }
    if (seed.kind === 'seeded') {
      deps.log?.(`submodule '${sub.path}': created its fork's '${WORKING_COPY_INTEGRATION_BRANCH}' at the pinned commit`);
    }
    configured.push(sub.path);
  }
  return { ok: true, configured, unforked: missing };
}

// ─── mode switch: create the submodule forks ─────────────────────────────────

export type CreateSubmoduleForksResult =
  | { ok: true; forks: SubmoduleForks; created: string[] }
  | {
      ok: false;
      error: 'submodules_unreadable' | 'submodule_not_github' | 'submodule_fork_is_main_repository' | 'submodule_fork_create_failed';
      message: string;
    };

/**
 * The guided switch into a working copy (D-017 §3): create (or find) the pot's fork of
 * every GitHub submodule and return the complete path → fork map. A recorded fork is
 * kept. Refuses — creating nothing further — on a submodule that is not on GitHub, or
 * whose "fork" would be its own main repository (the signed-in account owns it).
 */
export async function createSubmoduleForks(input: {
  checkoutPath: string;
  existing: SubmoduleForks;
  ensureFork: (opts: EnsureForkOpts) => Promise<EnsureForkResult>;
  codeRunGit: CodeRunGit;
}): Promise<CreateSubmoduleForksResult> {
  let submodules: SubmoduleEntry[];
  try {
    submodules = await listSubmodules(input.checkoutPath, input.codeRunGit);
  } catch (err) {
    return { ok: false, error: 'submodules_unreadable', message: errText(err) };
  }
  // Validate every submodule BEFORE creating any fork, so a refused switch creates nothing.
  const pending: Array<{ sub: SubmoduleEntry; owner: string; repo: string }> = [];
  for (const sub of submodules) {
    if (input.existing[sub.path]) continue;
    const upstream = parseGithubUrl(sub.url);
    if (!upstream) {
      return {
        ok: false,
        error: 'submodule_not_github',
        message: `submodule '${sub.path}' (${sub.url}) is not a GitHub repository, so the working copy cannot fork it`,
      };
    }
    pending.push({ sub, owner: upstream.owner, repo: upstream.repo });
  }
  const forks: SubmoduleForks = {};
  for (const sub of submodules) if (input.existing[sub.path]) forks[sub.path] = input.existing[sub.path]!;
  const created: string[] = [];
  for (const { sub, owner, repo } of pending) {
    const upstream = { owner, repo };
    let fork: EnsureForkResult;
    try {
      fork = await input.ensureFork({ upstreamOwner: upstream.owner, upstreamRepo: upstream.repo });
    } catch (err) {
      return { ok: false, error: 'submodule_fork_create_failed', message: `submodule '${sub.path}': ${errText(err)}` };
    }
    if (fork.forkFullName.toLowerCase() === `${upstream.owner}/${upstream.repo}`.toLowerCase()) {
      return {
        ok: false,
        error: 'submodule_fork_is_main_repository',
        message:
          `the signed-in GitHub account owns ${upstream.owner}/${upstream.repo} (submodule '${sub.path}'), so it ` +
          'cannot fork it; configure a fork owned by another account or organization',
      };
    }
    forks[sub.path] = `https://github.com/${fork.forkFullName}.git`;
    if (fork.created) created.push(sub.path);
  }
  return { ok: true, forks, created };
}

// ─── publication: which gitlinks has no main repository received yet? ────────

export { parseGitlinkDiff, type GitlinkRef };

export interface UnpublishedGitlink extends GitlinkRef {
  /** The submodule's main repository URL (from `.gitmodules` at the commit). */
  url: string;
  /** The main repository's branch the commit must reach (its default branch). */
  branch: string;
}

/** Direct, read-only remote evidence. Never a local tracking-ref observation. */
export interface GitlinkOriginObservation {
  schemaVersion: 1;
  policy: 'isolated-git-origin-v1';
  observationId: string;
  observedAt: string;
  url: string;
  authority: { kind: 'branch' | 'default-head'; ref: string };
  tip: string;
}

const originExecFile = promisify(execFile);
const originOid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

/**
 * Observe the caller-authorized URL, outside every checkout and without inherited
 * Git config, URL rewrites, includes, proxy variables or command overrides. This
 * only reads advertised refs; it never fetches objects or updates child refs.
 * The caller owns URL eligibility and binds each new invocation to its writer phase.
 */
export async function observeGitlinkOrigin(input: {
  url: string;
  /** Exact refs/heads authority; omission requires a symbolic remote HEAD. */
  fullRef?: string;
}): Promise<GitlinkOriginObservation> {
  if (!input.url || input.url.startsWith('-') || /[\0\r\n]/.test(input.url)) {
    throw new Error('gitlink-origin-url');
  }
  const root = await mkdtemp(join(tmpdir(), 'gitlink-origin-'));
  try {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root, XDG_CONFIG_HOME: root,
      LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0',
      GIT_TERMINAL_PROMPT: '0', GIT_SSH_VARIANT: 'ssh',
      GIT_SSH_COMMAND: 'ssh -F /dev/null -o BatchMode=yes',
      // Reuse the existing agent socket, without admitting SSH commands/config.
      ...(process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}),
    };
    const run = (args: string[]) => originExecFile('git', [
      '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
      '-c', 'protocol.ssh.allow=always', '-c', 'protocol.file.allow=always', ...args,
    ], { cwd: root, env, timeout: 30_000, maxBuffer: 64 * 1024, encoding: 'utf8' });
    if (input.fullRef !== undefined) {
      if (!input.fullRef.startsWith('refs/heads/')) throw new Error('gitlink-origin-authority');
      await run(['check-ref-format', input.fullRef]);
    }
    const { stdout } = await run(['ls-remote', '--symref', '--exit-code', '--', input.url, input.fullRef ?? 'HEAD']);
    const lines = stdout.trimEnd().split('\n').map(line => line.split('\t'));
    let ref = input.fullRef;
    let tip: string;
    if (ref !== undefined) {
      if (lines.length !== 1 || lines[0]?.length !== 2 || lines[0][1] !== ref) {
        throw new Error('gitlink-origin-advertisement');
      }
      tip = lines[0][0]!;
    } else {
      if (lines.length !== 2 || lines.some(line => line.length !== 2) ||
          lines[0]![1] !== 'HEAD' || !lines[0]![0]!.startsWith('ref: refs/heads/') || lines[1]![1] !== 'HEAD') {
        throw new Error('gitlink-origin-authority');
      }
      ref = lines[0]![0]!.slice('ref: '.length);
      await run(['check-ref-format', ref]);
      tip = lines[1]![0]!;
    }
    if (!originOid.test(tip)) throw new Error('gitlink-origin-tip');
    return Object.freeze({ schemaVersion: 1, policy: 'isolated-git-origin-v1',
      observationId: randomUUID(), observedAt: new Date().toISOString(), url: input.url,
      authority: Object.freeze({ kind: input.fullRef === undefined ? 'default-head' : 'branch', ref }), tip });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Reuse publication containment against exact observed OIDs, never tracking refs. */
export async function inspectObservedGitlinkContainment(input: {
  runGit: CodeRunGit; repoDir: string; selectedCommit: string; observation: GitlinkOriginObservation;
}): Promise<{ selectedTree: string; tipTree: string; contained: boolean }> {
  const { runGit, repoDir, selectedCommit, observation } = input;
  if (observation.schemaVersion !== 1 || observation.policy !== 'isolated-git-origin-v1' ||
      !originOid.test(selectedCommit) || !originOid.test(observation.tip) ||
      !observation.authority.ref.startsWith('refs/heads/')) throw new Error('gitlink-origin-observation');
  const tree = async (oid: string) => {
    const type = await runGit(['--no-replace-objects', 'cat-file', '-t', oid], repoDir);
    if (type.code !== 0 || type.stdout.trim() !== 'commit') throw new Error('gitlink-origin-commit-unavailable');
    const result = await runGit(['--no-replace-objects', 'rev-parse', '--verify', `${oid}^{tree}`], repoDir);
    if (result.code !== 0 || !originOid.test(result.stdout.trim())) throw new Error('gitlink-origin-tree-unavailable');
    return result.stdout.trim();
  };
  const selectedTree = await tree(selectedCommit);
  const tipTree = await tree(observation.tip);
  const ancestor = await runGit(['--no-replace-objects', 'merge-base', '--is-ancestor', selectedCommit, observation.tip], repoDir);
  if (ancestor.code !== 0 && ancestor.code !== 1) throw new Error('gitlink-origin-ancestry-unavailable');
  return { selectedTree, tipTree, contained: ancestor.code === 0 };
}

/** The submodule's default branch on `origin` (origin/HEAD), else `main`. */
async function originDefaultBranch(runGit: CodeRunGit, subDir: string): Promise<string> {
  const r = await runGit(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], subDir);
  const name = r.code === 0 ? r.stdout.trim().replace(/^origin\//, '') : '';
  return name || 'main';
}

/**
 * Which gitlinks in `commit` (relative to `baseCommit`, the main repository's target the
 * PR merges into) point at commits their submodule's main repository does not have on
 * its default branch yet. `fetch` refreshes each submodule's `origin` first (on by
 * default; tests and repeated callers may skip it). Nested submodules are checked under
 * every unpublished parent gitlink. A commit the check cannot resolve counts as
 * unpublished: the answer must never let an unreachable gitlink through.
 */
export async function findUnpublishedGitlinks(input: {
  repoDir: string;
  commit: string;
  baseCommit: string;
  runGit: CodeRunGit;
  /** Network leg (fetch); defaults to `runGit`. */
  runNetworkGit?: CodeRunGit;
  fetch?: boolean;
  /** Phase-fresh direct observations; when supplied, tracking refs/fetch are never used. */
  originObservations?: Readonly<Record<string, GitlinkOriginObservation>>;
  prefix?: string;
  depth?: number;
}): Promise<{ ok: true; unpublished: UnpublishedGitlink[] } | { ok: false; error: string }> {
  const { repoDir, runGit } = input;
  const network = input.runNetworkGit ?? runGit;
  const prefix = input.prefix ?? '';
  const depth = input.depth ?? 0;
  const diff = await runGit(['diff', '--raw', '--no-abbrev', '--no-renames', input.baseCommit, input.commit], repoDir);
  if (diff.code !== 0) {
    return { ok: false, error: `could not compare ${input.baseCommit.slice(0, 12)}..${input.commit.slice(0, 12)}: ${diff.stderr.trim()}` };
  }
  const changed = parseGitlinkDiff(diff.stdout);
  if (changed.length === 0) return { ok: true, unpublished: [] };
  const modules = await runGit(
    ['config', '--blob', `${input.commit}:.gitmodules`, '--get-regexp', '^submodule\\..*\\.(path|url|branch)$'],
    repoDir,
  );
  const urls = new Map(parseGitmodulesConfig(modules.code === 0 ? modules.stdout : '').map((e) => [e.path, e.url]));
  const unpublished: UnpublishedGitlink[] = [];
  for (const link of changed) {
    const subDir = join(repoDir, link.path);
    const fullPath = prefix ? `${prefix}/${link.path}` : link.path;
    const url = urls.get(link.path) ?? '';
    if (input.originObservations !== undefined) {
      const observation = input.originObservations[fullPath];
      const records = modules.stdout.split('\n').map(row => /^submodule\.(.+)\.(path|url|branch) (.*)$/.exec(row))
        .filter((row): row is RegExpExecArray => row !== null);
      const mapping = records.filter(row => row[2] === 'path' && row[3] === link.path);
      const fields = mapping.length === 1 ? records.filter(row => row[1] === mapping[0]![1]) : [];
      const branch = fields.filter(row => row[2] === 'branch');
      const branchRef = branch[0]?.[3]?.startsWith('refs/heads/') ? branch[0][3] : `refs/heads/${branch[0]?.[3]}`;
      if (!observation || observation.url !== url ||
          mapping.length !== 1 || fields.filter(row => row[2] === 'path').length !== 1 ||
          fields.filter(row => row[2] === 'url').length !== 1 || branch.length > 1 ||
          (branch.length === 1 && (observation.authority.kind !== 'branch' || observation.authority.ref !== branchRef)) ||
          (branch.length === 0 && observation.authority.kind !== 'default-head')) {
        return { ok: false, error: `missing or mismatched direct origin observation for ${fullPath}` };
      }
      try {
        const proof = await inspectObservedGitlinkContainment({ runGit, repoDir: subDir,
          selectedCommit: link.sha, observation });
        if (!proof.contained) unpublished.push({ path: fullPath, sha: link.sha, url,
          branch: observation.authority.ref.slice('refs/heads/'.length) });
      } catch (error) {
        return { ok: false, error: `unavailable direct origin proof for ${fullPath}: ${errText(error)}` };
      }
      continue;
    }
    if (!existsSync(join(subDir, '.git'))) {
      unpublished.push({ path: fullPath, sha: link.sha, url, branch: 'main' });
      continue;
    }
    const branch = await originDefaultBranch(runGit, subDir);
    if (input.fetch !== false) {
      // No recursion: a nested unpublished pin would fail the fetch instead of being reported.
      const fetched = await network(
        ['fetch', '--no-tags', '--no-recurse-submodules', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
        subDir,
      );
      if (fetched.code !== 0) {
        return { ok: false, error: `could not fetch ${fullPath}'s main repository (${branch}): ${fetched.stderr.trim().slice(0, 200)}` };
      }
    }
    const contained = await runGit(['merge-base', '--is-ancestor', link.sha, `refs/remotes/origin/${branch}`], subDir);
    if (contained.code === 0) continue;
    unpublished.push({ path: fullPath, sha: link.sha, url, branch });
    // Nested pins can only be read from a pinned commit this checkout has. A checkout that
    // never received it (the main repository's own checkout, at the merge gate) has nothing
    // to recurse into, and the entry above already blocks.
    const present = await runGit(['cat-file', '-e', `${link.sha}^{commit}`], subDir);
    if (present.code === 0 && depth < 8) {
      const nested = await findUnpublishedGitlinks({
        ...input,
        repoDir: subDir,
        commit: link.sha,
        baseCommit: `refs/remotes/origin/${branch}`,
        prefix: fullPath,
        depth: depth + 1,
      });
      if (!nested.ok) return nested;
      unpublished.push(...nested.unpublished);
    }
  }
  return { ok: true, unpublished };
}
