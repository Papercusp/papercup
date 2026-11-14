---
rel_path: "portability/census/v55/02-source-preview.mjs.part-000"
updated_at: 1794250602744
_body: "content"
---

#!/usr/bin/env node
// scripts/source-preview.mjs — the private source preview (plan dhh-source-preview-2026-09-28).
//
// WHAT IT IS. Invited individuals get READ access to one private GitHub repo,
// Papercusp/papercusp-preview, holding the PUBLIC-SAFE source cut: exactly what every
// desktop installer already ships as sidecar/source.tar.zst (D-003/D-004), minus
// node_modules. It is never the real Papercusp/papercup repo, never its private
// submodule repos, and never git history.
//
// WHAT IT REUSES — there is no second exporter and no second secret list (D-002):
//   selection  papercusp-desktop/bin/lib/source-tree-selection.sh (shared with the
//              installer's bin/stage-source-tree.sh), run through
//              papercusp-desktop/bin/source-tree-select.sh (same GNU tar engine,
//              same audit-owned identity scrub);
//   gate       papercusp-desktop/bin/audit-release-bundle.py — the full bundle audit
//              over a packed copy (forbidden paths + identity + credentials) plus
//              --scan-dir over the directory — with gitleaks and trufflehog as
//              additional detectors. Any finding refuses; a scanner that cannot run
//              refuses (a gate that looked at nothing is not a pass).
//
// WHAT IT ADDS: a CLEAN export of one pinned commit (git archive of the superproject
// and every submodule at its gitlink — no working-tree debris), MANIFEST.json,
// NOTICE, README.md, and a drift-checked, gated, single-commit publish.
//
// Usage:
//   node scripts/source-preview.mjs export [--ref main] [--out <dir>]
//   node scripts/source-preview.mjs gate <dir>
//   node scripts/source-preview.mjs check [--ref main] [--remote <url>]
//   node scripts/source-preview.mjs push  [--ref main] [--remote <url>] [--confirm]
//   node scripts/source-preview.mjs licenses [--json <file>]
// npm: preview:export · preview:gate · preview:check · preview:push
// Every command takes --target preview|public (default preview). The public target
// (plan open-source-release-2026-09-29) publishes to Papercusp/papercusp-app under the
// Sustainable Use License 1.0, APPEND-ONLY; the preview is replaced wholesale. See TARGETS.
//
// PAPERCUSP_RELEASE_OWNER_NAME (and _EMAIL) must be exported — read at run time, never
// written anywhere — exactly as for a release cut: the scrub and the gate refuse
// without them.
//
// PAPERCUSP_UPDATE_BASE_URL names the release host whose index.html is the releases
// page README.md links to. It is deployment state, never committed here: the CLI fills
// it from ~/.papercusp/release-host.env (the file the release scripts load) when unset,
// and the export refuses without it rather than publish a README with no download link.
//
// Exit: 0 ok / in sync · 1 finding / drift / refused · 2 usage or cannot check.
import assert from 'node:assert/strict';
import { assertCommittedWorkspaceLockMatches, committedWorkRootDependencyDonor } from './lint-as-committed.mjs';
import { assertRootLockManifestMatches } from './npm-install-safe.mjs';
import { admitTaskDeadline, readTaskDeadlineEpochMs } from './lib/task-deadline.mjs';
import { PRIVATE_TEST_PG_RELEASE_TOKEN_ENV, requestPrivateTestPgRelease } from './lib/with-test-pg-cleanup.mjs';
import { createProgressAwareWatchdog } from './lib/batch-watchdog.mjs';
import { processGroupLifetime } from '@papercusp/operator-core/lib/fleet/process-group-lifetime';
import { readProcessIdentity } from '@papercusp/operator-core/lib/process-identity';
import { sealRuntimeSourceHandle } from '@papercusp/operator-core/lib/blind-review-source-seal';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs, appendFileSync, closeSync, existsSync, fstatSync, ftruncateSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { papercuspHome } from '@papercusp/host-platform/home';
import { mkdtemp, rm } from 'node:fs/promises';
import { constants, homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, posix as posixPath, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createRequire, isBuiltin } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { compileFunction } from 'node:vm';
import { require as tsxRequire } from 'tsx/cjs/api';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import { verifierSourceFiles, verifierGitCheckoutSync, verifyVerifierSourceSync as verifyArchivedSourceSync, VerifierSourceError, writeVerifierTaskReceipt, verifierResourceInventory } from '@papercusp/operator-core/lib/verifier-source';
import { NOTICES_FILE, collectThirdPartyNotices } from './check-licenses.mjs';
import { runTreeRestrictedHoldPreflight, formatTreeRestrictedHoldRefusal,
  RESTRICTED_HOLD_PREFLIGHT_ENV, RESTRICTED_HOLD_PREFLIGHT_ADMITTED_BY_ROUTER } from './lib/restricted-hold-preflight.mjs';
import { applyEnvLocal, PG_URL_ENV_VARS } from './lib/pg-url.mjs';
import { findUnusableRuntimeDeps, formatRuntimeFailures } from './check-declared-deps-extracted.mjs';
import { writeOperatorArtifactManifest } from '@papercusp/operator-core/lib/release/operator-artifact';
import { bindRuntimeSourcePopulation } from '../packages/operator-core/lib/memory/bench/runtime-source-capture.mjs';
import { bindRuntimeProcessTree } from '../packages/operator-core/lib/memory/bench/runtime-file-opens.mjs';
import { bindFrozenDependencyGeneration } from '@papercusp/operator-core/lib/dependency-generation-proof';

// Keep the synchronous qualification API and the host's import graph free of
// top-level await. esbuild owns the literal require in a host bundle; the
// documented plain-Node CLI needs scoped TS resolution for extensionless imports.
/** @type {typeof import('../packages/operator-core/lib/memory/bench/measurement-manifest.ts').bindNativeLoaderClosure} */
const bindNativeLoaderClosure = (...args) => {
  // @ts-ignore -- bundle-host defines this marker; plain Node takes the scoped loader.
  const nativeLoader = typeof __PAPERCUSP_BUNDLED_SIDECAR__ !== 'undefined'
    ? require('../packages/operator-core/lib/memory/bench/measurement-manifest.ts')
    : tsxRequire('../packages/operator-core/lib/memory/bench/measurement-manifest.ts', import.meta.url);
  return nativeLoader.bindNativeLoaderClosure(...args);
};

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const PREVIEW_REPO = 'Papercusp/papercusp-preview';
// NOT 'Papercusp/papercusp': that name is the private libs/papercusp library repo
// (open-source-release-2026-09-29 D-016), and an append push there would stack the export
// on top of the library's own history.
export const PUBLIC_REPO = 'Papercusp/papercusp-app';
export const SOURCE_REPO = 'Papercusp/papercup';
export const DEFAULT_REMOTE = `https://github.com/${PREVIEW_REPO}.git`;
export const DEFAULT_REF = 'main';
/** The public application's license (owner-approved SUL transition, 2026-10-26). */
export const PUBLIC_LICENSE_PATH = join(ROOT, 'scripts', 'public-release', 'LICENSE');
export const PUBLIC_LICENSE_ID = 'LicenseRef-Sustainable-Use-1.0';

/**
 * Where an export is published (plan open-source-release-2026-09-29 P-002/P-003).
 * - preview: the private, invite-only evaluation snapshot. Replaced WHOLESALE by one
 *   parentless commit on every push, so no history accumulates there.
 * - public: the open-source repository. APPEND-ONLY: every export is committed on top of
 *   the current public main and pushed without --force, so forks, clones and pull
 *   requests keep a history they can rebase onto. It must never be the preview repo:
 *   the preview's earlier force-pushed snapshots stay fetchable by SHA.
 * @typedef {{ key: 'preview' | 'public', repo: string, history: 'replace' | 'append', purpose: string, email: string }} Target
 * @type {Record<'preview' | 'public', Target>}
 */
export const TARGETS = {
  preview: { key: 'preview', repo: PREVIEW_REPO, history: 'replace', purpose: 'private source preview — public-safe cut (plan dhh-source-preview-2026-09-28)', email: 'source-preview@papercusp.invalid' },
  public: { key: 'public', repo: PUBLIC_REPO, history: 'append', purpose: 'public source release — public-safe cut (plan open-source-release-2026-09-29)', email: 'public-export@papercusp.invalid' },
};

/** @param {string} [name] @returns {Target} */
export function resolveTarget(name = 'preview') {
  const t = TARGETS[/** @type {'preview' | 'public'} */ (name)];
  if (!t) throw new PreviewError(`unknown target ${name} (expected ${Object.keys(TARGETS).join(' | ')})`, 2);
  return t;
}

/** @param {Target} target */
export const defaultRemote = (target) => `https://github.com/${target.repo}.git`;

/**
 * Refuse a remote that names the OTHER target's repository: pushing the public cut into the
 * preview would flip nothing but mislabel it, and the preview's --force replace would erase
 * the public history everyone forked from.
 * @param {Target} target @param {string} remote
 */
export function assertRemoteMatchesTarget(target, remote) {
  const repoOf = (r) => r.replace(/\.git$/, '').replace(/\/+$/, '').split(/[/:]/).slice(-2).join('/').toLowerCase();
  const named = repoOf(remote);
  // Private repositories no target may ever publish to: the source superproject and the
  // libs/papercusp library repo, which owns the name 'Papercusp/papercusp' (D-016).
  for (const privateRepo of [SOURCE_REPO, 'Papercusp/papercusp']) {
    if (named === privateRepo.toLowerCase()) {
      throw new PreviewError(`remote ${remote} is the private repository ${privateRepo} — refusing to publish the ${target.key} target there`, 2);
    }
  }
  for (const other of Object.values(TARGETS)) {
    if (other.key !== target.key && named === other.repo.toLowerCase()) {
      throw new PreviewError(`remote ${remote} is the ${other.key} repository (${other.repo}) — refusing to publish the ${target.key} target there`, 2);
    }
  }
}
const DESKTOP_BIN = join(ROOT, 'papercusp-desktop', 'bin');
export const SELECT_SCRIPT = join(DESKTOP_BIN, 'source-tree-select.sh');
export const SELECTION_LIB = join(DESKTOP_BIN, 'lib', 'source-tree-selection.sh');
export const AUDIT_SCRIPT = join(DESKTOP_BIN, 'audit-release-bundle.py');
/** Files this script adds at the export root, outside the shared selection. */
export const ADDED_FILES = ['NOTICE', 'README.md', 'MANIFEST.json'];
/** The Tauri desktop shell, shipped only by the public target (P-004). */
export const DESKTOP_DIR = 'papercusp-desktop';
/**
 * What the public target leaves out of the desktop shell (GNU tar patterns, relative to
 * the shell root): generated sidecar copies, build output, local agent state and stray
 * files, and the internal VM/cloud test rigs, which drive the maintainers' own machines.
 */
export const DESKTOP_PUBLIC_EXCLUDES = [
  './src-tauri/env-sidecars',
  './src-tauri/target',
  './node_modules',
  './.papercusp',
  './.papercup-console-active.*',
  './b',
  './bin/vm-rig',
  './bin/deb-hetzner-*',
  './bin/mac-vm-*',
  './scripts/linux-test-vm',
  './scripts/windows-vm',
];
/**
 * Community-health files the public target copies verbatim from scripts/public-release/
 * (plan open-source-release-2026-09-29 P-007). Every one is required: a public repo
 * without a disclosure path or contribution terms is not recoverable once cloned.
 */
export const PUBLIC_COMMUNITY_FILES = [
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
  // P-011: the agreement CONTRIBUTING.md promises, and the bot that asks for it.
  'CLA.md',
  '.github/workflows/cla.yml',
  // P-009: the public repository's own CI — the private repo's workflows never ship.
  '.github/workflows/ci.yml',
];
/** The public target also adds its LICENSE, the community files, and THIRD-PARTY-NOTICES.md
 *  (generated from the export's own lockfiles by check-licenses.mjs — P-017 step 5). */
export const PUBLIC_ADDED_FILES = [...ADDED_FILES, 'LICENSE', ...PUBLIC_COMMUNITY_FILES, NOTICES_FILE];
/** Top-level entries the added files create (`.github` for the workflows) — the README's
 *  tree listing describes the development tree, not these. */
const PUBLIC_ADDED_TOPS = new Set(PUBLIC_ADDED_FILES.map((f) => f.split('/')[0]));
/** The env var holding the release host base URL; `${base}/index.html` is the releases page. */
export const RELEASE_BASE_ENV = 'PAPERCUSP_UPDATE_BASE_URL';
/** Where the release scripts keep that value (papercusp-desktop/bin/lib/release-host.sh). */
export const RELEASE_HOST_ENV_PATH = join(homedir(), '.papercusp', 'release-host.env');

/** @typedef {{ name: string, ok: boolean, status: string, detail: string }} GateResult */
/** @typedef {{ detector: string, rule: string, path: string, line: number, sha256: string, allowlisted?: boolean }} GateFinding */
/** @typedef {{ ok: boolean, exitCode: number, results: GateResult[], findings?: GateFinding[] }} GateVerdict */
/** @typedef {(dir: string, opts: { env?: NodeJS.ProcessEnv }) => Promise<GateVerdict>} Gate */
/** @typedef {(message: string) => void} Log */

export class PreviewError extends Error {
  /** @param {string} message @param {number} [exitCode] */
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

/** Run a command, returning stdout; throw PreviewError with stderr on failure. */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
  if (r.error) throw new PreviewError(`${cmd} failed to start: ${r.error.message}`, 2);
  if (r.status !== 0) {
    throw new PreviewError(`${cmd} ${args.join(' ')} exited ${r.status}: ${(r.stderr || r.stdout || '').trim().slice(-2000)}`);
  }
  return r.stdout;
}

const git = (repo, args, opts) => {
  // Verifier snapshots can live below the Git worktree they attest. Our paths
  // are repository-root relative, so keep ls-tree from silently scoping itself
  // to that nested current-directory prefix.
  const rootScopedArgs = args[0] === 'ls-tree' && !args.includes('--full-tree')
    ? [args[0], '--full-tree', ...args.slice(1)] : args;
  return run('git', ['-C', repo, ...rootScopedArgs], opts);
};

/** Read GitHub JSON plus pagination headers without requiring a recent gh CLI. */
function githubPage(endpoint) {
  const raw = run('gh', ['api', '--include', endpoint]).replace(/\r\n/g, '\n');
  const boundary = raw.indexOf('\n\n');
  if (boundary < 0) throw new PreviewError('GitHub response has no HTTP header boundary', 2);
  const headers = Object.fromEntries(raw.slice(0, boundary).split('\n').slice(1).map((line) => {
    const colon = line.indexOf(':');
    return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
  }));
  return { headers, body: JSON.parse(raw.slice(boundary + 2)) };
}

/**
 * R13: inspect the current public population and actual default-branch license bytes.
 * Reuses the public export's canonical SUL, existing components' ELv2, and Apache text.
 * Unknown text, an API failure, incomplete pagination or a changed population refuses.
 * GitHub's license metadata is supplementary; it is never the license oracle.
 * @typedef {{ path: string, gitBlob: string, sha256: string, license: string | null, url: string }} PublicRepositoryLicense
 * @typedef {{ repo: string, defaultBranch: string, metadataSpdx: string | null, head: string | null, licenses: PublicRepositoryLicense[], errors: string[] }} PublicRepositoryLicenseRow
 */
/**
 * @param {{ api?: (endpoint: string) => Promise<{ headers: Record<string, string>, body: any }> | { headers: Record<string, string>, body: any }, licenseHashes?: Record<string, string>, libraryRepositories?: string[], log?: Log }} [options]
 */
export async function auditPublicRepositoryLicenses({ api = githubPage, licenseHashes, libraryRepositories, log = () => {} } = {}) {
  const startedAt = new Date().toISOString();
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const reviewed = licenseHashes ?? {
    [digest(readFileSync(PUBLIC_LICENSE_PATH))]: PUBLIC_LICENSE_ID,
    // Independently released components retain ELv2 and their previously granted rights.
    [digest(readFileSync(join(ROOT, 'apps/operator-public/cupboard-actions/LICENSE')))]: 'ELv2',
    [digest(readFileSync(join(ROOT, 'libs/generic/cache/LICENSE')))]: 'Apache-2.0',
    // Existing SideStage-mobile MIT declaration, read and reviewed in the R13 census.
    '84ea0f54f720885e4e0a6d2e45baca5a7d6e30aa26db12eabbeda4b3b48c3ea7': 'MIT',
  };
  if (!libraryRepositories) {
    // Derive the library policy from the existing registry, never a remembered count.
    const modules = new Map();
    const config = run('git', ['config', '--file', join(ROOT, '.gitmodules'), '--get-regexp', '^submodule\\..*\\.(path|url)$']);
    for (const line of config.trim().split('\n')) {
      const space = line.indexOf(' ');
      const key = line.slice(0, space);
      const dot = key.lastIndexOf('.');
      const name = key.slice(0, dot);
      const module = modules.get(name) ?? {};
      module[key.slice(dot + 1)] = line.slice(space + 1);
      modules.set(name, module);
    }
    libraryRepositories = [...modules.values()].filter((module) => module.path?.startsWith('libs/generic/') || ['libs/agent-chat', 'libs/testing-shell', 'libs/test-config'].includes(module.path)).map((module) => module.url.replace(/^git@github\.com:/, '').replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, ''));
  }
  const libraries = new Set(libraryRepositories.map((repo) => repo.toLowerCase()));
  async function population() {
    const repositories = [];
    const pages = [];
    const seen = new Set();
    let endpoint = 'orgs/Papercusp/repos?type=public&per_page=100&page=1';
    while (endpoint) {
      if (seen.has(endpoint)) throw new PreviewError('GitHub pagination repeated a page', 2);
      seen.add(endpoint);
      const { headers, body } = await api(endpoint);
      if (!Array.isArray(body)) throw new PreviewError('GitHub population is not an array', 2);
      for (const repo of body) {
        if (!/^Papercusp\/[A-Za-z0-9._-]+$/i.test(repo.full_name ?? '') || repo.private !== false || !repo.default_branch) {
          throw new PreviewError('GitHub population contains an invalid public repository', 2);
        }
        if (repositories.some((r) => r.full_name.toLowerCase() === repo.full_name.toLowerCase())) {
          throw new PreviewError(`GitHub population repeats ${repo.full_name}`, 2);
        }
        repositories.push(repo);
      }
      const link = headers.link ?? '';
      const next = link.split(',').find((part) => /rel="next"/.test(part));
      const url = next?.match(/<([^>]+)>/)?.[1];
      if (next && !url?.startsWith('https://api.github.com/orgs/Papercusp/repos?')) {
        throw new PreviewError('GitHub next-page link is missing or outside the population endpoint', 2);
      }
      pages.push({ endpoint, size: body.length, next: url ?? null });
      endpoint = url ? url.slice('https://api.github.com/'.length) : '';
    }
    if (!repositories.length) throw new PreviewError('GitHub public population is empty', 2);
    return { repositories, pages };
  }
  const first = await population();
  /** @type {PublicRepositoryLicenseRow[]} */
  const rows = [];
  /** @type {Record<string, string>} */
  const licenseTexts = {};
  for (const repo of first.repositories) {
    log(`license census: ${repo.full_name} default=${repo.default_branch}`);
    /** @type {PublicRepositoryLicenseRow} */
    const row = { repo: repo.full_name, defaultBranch: repo.default_branch, metadataSpdx: repo.license?.spdx_id ?? null, head: null, licenses: [], errors: [] };
    try {
      const { body: commit } = await api(`repos/${row.repo}/commits/${encodeURIComponent(row.defaultBranch)}`);
      if (!/^[a-f0-9]{40}$/.test(commit.sha ?? '')) throw new Error('default branch has no measured commit');
      row.head = commit.sha;
      const { body: root } = await api(`repos/${row.repo}/contents?ref=${row.head}`);
      if (!Array.isArray(root)) throw new Error('default-branch root was not measured');
      const candidates = root.filter((f) => f.type === 'file' && /^(?:licen[cs]e|copying)(?:\.(?:md|txt))?$/i.test(f.name));
      if (!candidates.length) throw new Error('default branch has no root license file');
      for (const file of candidates) {
        const { body: content } = await api(`repos/${row.repo}/contents/${encodeURIComponent(file.path)}?ref=${row.head}`);
        if (content.encoding !== 'base64' || typeof content.content !== 'string') throw new Error(`license bytes unavailable: ${file.path}`);
        const bytes = Buffer.from(content.content, 'base64');
        if (bytes.toString('base64') !== content.content.replace(/\s/g, '')) throw new Error(`invalid license base64: ${file.path}`);
        const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
        if (blob !== content.sha || blob !== file.sha) throw new Error(`license blob mismatch: ${file.path}`);
        const sha256 = digest(bytes);
        const license = reviewed[sha256] ?? null;
        licenseTexts[sha256] = bytes.toString('utf8');
        row.licenses.push({ path: file.path, gitBlob: blob, sha256, license, url: `https://github.com/${row.repo}/blob/${row.head}/${file.path}` });
        if (!license) row.errors.push(`unreviewed license text: ${file.path}`);
        if (license && libraries.has(row.repo.toLowerCase()) && license !== 'Apache-2.0' && license !== 'MIT') {
          row.errors.push(`D-003 requires a permissive library license: ${file.path}`);
        }
        if (license && row.repo.toLowerCase() === PUBLIC_REPO.toLowerCase() && license !== PUBLIC_LICENSE_ID) {
          row.errors.push(`Application release requires SUL 1.0: ${file.path}`);
        }
        if (license && ['goals', 'cupboard-actions', 'blueprints', 'sidestage', 'scout-runtime', 'recipes', 'plans', 'scout-chat', 'drawer-stack', 'cart-drawer', 'data-fetch'].includes(row.repo.split('/')[1].toLowerCase()) && license !== 'ELv2') {
          row.errors.push(`D-011/D-023 require ELv2: ${file.path}`);
        }
      }
    } catch (error) {
      row.errors.push(error instanceof Error ? error.message : String(error));
    }
    rows.push(row);
  }
  const last = await population();
  const identity = (repos) => repos.map((r) => `${r.full_name}:${r.default_branch}`).sort().join('\n');
  const stablePopulation = identity(first.repositories) === identity(last.repositories);
  const assertions = [
    { id: 'complete-stable-population', passed: stablePopulation, evidence: 'Both population reads followed every next-page link to a terminal page. Exact page receipts are in pagination; both repository/default-branch populations must agree.' },
    { id: 'actual-default-branch-license-bytes', passed: rows.every((row) => !row.errors.length), evidence: 'Every repository is enumerated in rows with its measured default-branch commit, root license blob and SHA-256. Any missing/unreadable/unreviewed/mismatched license fails this assertion; full errors remain on the affected row.' },
  ];
  const exitCode = assertions.every((assertion) => assertion.passed) ? 0 : 1;
  return { schemaVersion: 1, kind: 'operational-test-evidence', name: 'Public repository default-branch license census', framework: 'operational', command: ['node --import tsx scripts/source-preview.mjs licenses'], startedAt, finishedAt: new Date().toISOString(), exitCode, evidencePlane: 'live', summary: `${rows.length} public repositories; ${rows.filter((row) => row.errors.length).length} license failures; population ${stablePopulation ? 'stable' : 'changed'}`, assertions, pagination: { first: first.pages, last: last.pages }, rows, licenseTexts };
}

/** Resolve a ref to a full commit SHA in `repo`. */
export function resolveCommit(repo, ref) {
  return git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim();
}

/** Every gitlink (submodule pin) recorded in `sha`'s tree: [{ path, sha }]. */
export function listGitlinks(repo, sha) {
  const out = git(repo, ['ls-tree', '-r', '-z', sha]);
  const links = [];
  for (const entry of out.split('\0')) {
    if (!entry) continue;
    const tab = entry.indexOf('\t');
    const [mode, type, obj] = entry.slice(0, tab).split(' ');
    if (mode === '160000' && type === 'commit') links.push({ path: entry.slice(tab + 1), sha: obj });
  }
  return links;
}

/** The shared top-level allowlist, read from the selection library itself. */
export function allowlistTops(selectionLib = SELECTION_LIB) {
  const out = run('bash', ['-c', '. "$1"; printf "%s\\n" $SOURCE_TREE_ALLOWLIST', '_', selectionLib]);
  const tops = out.split('\n').map((s) => s.trim()).filter(Boolean);
  if (tops.length === 0) throw new PreviewError(`empty allowlist from ${selectionLib}`, 2);
  return new Set(tops);
}

function extractArchive(repo, sha, dest) {
  run('bash', ['-c', 'set -euo pipefail; git -C "$1" archive --format=tar "$2" | tar -xf - -C "$3"', '_', repo, sha, dest]);
}

function materializedSubmodule(repo, link, full) {
  const subRepo = join(repo, link.path);
  const known = existsSync(subRepo)
    && spawnSync('git', ['-C', subRepo, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim() === realpathSync(subRepo)
    && spawnSync('git', ['-C', subRepo, 'cat-file', '-e', `${link.sha}^{commit}`]).status === 0;
  if (!known) {
    throw new PreviewError(`unresolvable gitlink ${full} @ ${link.sha} — its commit is not present in ${subRepo}; run \`git submodule update --init\` or fetch it, then retry`);
  }
  return subRepo;
}

// Resolve only the tested path's gitlinks, against their pinned commits. An
// unrelated unresolved gitlink must not hide an initial dirty-input refusal.
// Retain the object owner so contract readers can read pinned submodule bytes.
function committedInputObject(repo, sha, path, trees, optional = false) {
  const key = `${repo}\0${sha}`;
  if (!trees.has(key)) {
    const entries = new Map();
    const links = [];
    for (const row of git(repo, ['ls-tree', '-r', '-z', sha]).split('\0')) {
      if (!row) continue;
      const tab = row.indexOf('\t');
      const name = row.slice(tab + 1);
      const fields = row.slice(0, tab).split(' ');
      entries.set(name, fields);
      if (fields[0] === '160000') links.push({ path: name, sha: fields[2] });
    }
    trees.set(key, { entries, links });
  }
  const { entries, links } = trees.get(key);
  const link = links.find((entry) => path.startsWith(`${entry.path}/`));
  if (link) return committedInputObject(materializedSubmodule(repo, link, link.path),
    link.sha, path.slice(link.path.length + 1), trees, optional);
  if (optional && !entries.has(path)) return null;
  const [mode, type, blob] = entries.get(path) ?? [];
  if (type !== 'blob' || !['100644', '100755'].includes(mode)) {
    throw new PreviewError(`tested input is not a regular committed file: ${path}`, 2);
  }
  return { repo, blob };
}

function committedInputBlob(repo, sha, path, trees) {
  const input = committedInputObject(repo, sha, path, trees);
  assert.ok(input, 'Committed input must be present');
  return input.blob;
}

/** Conservative allocated source bytes for the exact recursive verifier export.
 * Count committed blobs, including desktop and private gitlinks, before creating
 * any destination. Per-file block rounding covers small-file allocation; the
 * existing disk reservation adds its separate dependency/metadata allowance.
 * export-ignore can only make the actual archive smaller than this census.
 * An archive without Git metadata instead requires its external receipt digest
 * and derives the same rounded census from the pinned archive entries.
 */
function readPinnedVerifierArchive(repo, ref, receiptSha256) {
  if (!/^[a-f0-9]{64}$/.test(receiptSha256 ?? ''))
    throw new PreviewError('verifier source receipt digest is required for archive verification', 2);
  const root = realpathSync(repo);
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(join(root, '.verifier-source.json'), 'utf8'));
  } catch (error) {
    throw new PreviewError('cannot read pinned verifier source receipt: ' + String(error?.message ?? error), 2);
  }
  const digest = createHash('sha256').update(JSON.stringify(receipt)).digest('hex');
  if (digest !== receiptSha256) throw new PreviewError('pinned verifier source receipt changed', 2);
  if (receipt.sourceCommit !== ref)
    throw new PreviewError('verifier source receipt differs from selected source ref', 2);
  verifyVerifierSourceSync(root, receipt, { runtimeArtifacts: true });
  return { root, receipt };
}

function measureVerifierArchiveSourceBytes({ repo, ref, receiptSha256 }) {
  const { root, receipt } = readPinnedVerifierArchive(repo, ref, receiptSha256);
  let bytes = 0;
  for (const file of receipt.files) {
    const info = lstatSync(join(root, file.path));
    if ((file.kind === 'file' && !info.isFile()) || (file.kind === 'symlink' && !info.isSymbolicLink()))
      throw new PreviewError('verifier archive source kind changed: ' + file.path, 2);
    if (!Number.isSafeInteger(info.size) || info.size < 0)
      throw new PreviewError('cannot measure verifier archive source bytes', 2);
    bytes += Math.ceil(info.size / 4096) * 4096;
    if (!Number.isSafeInteger(bytes))
      throw new PreviewError('verifier archive source size exceeds safe integer range', 2);
  }
  verifyVerifierSourceSync(root, receipt, { runtimeArtifacts: true });
  return bytes;
}

/** @param {{ repo: string, ref: string, receiptSha256?: string }} options */
export function measureVerifierSourceBytes({ repo, ref, receiptSha256 }) {
  if (receiptSha256 !== undefined) return measureVerifierArchiveSourceBytes({ repo, ref, receiptSha256 });
  const measure = (source, sha, prefix = '') => {
    let bytes = 0;
    for (const entry of git(source, ['ls-tree', '-r', '-z', '-l', sha]).split('\0')) {
      if (!entry) continue;
      const fields = entry.slice(0, entry.indexOf('\t')).trim().split(/\s+/);
      if (fields[1] !== 'blob') continue;
      const size = Number(fields[3]);
      if (!Number.isSafeInteger(size) || size < 0) throw new PreviewError('cannot measure committed source bytes', 2);
      bytes += Math.ceil(size / 4096) * 4096;
    }
    for (const link of listGitlinks(source, sha)) {
      const full = prefix ? `${prefix}/${link.path}` : link.path;
      bytes += measure(materializedSubmodule(source, link, full), link.sha, full);
    }
    if (!Number.isSafeInteger(bytes)) throw new PreviewError('committed source size exceeds safe integer range', 2);
    return bytes;
  };
  return measure(repo, resolveCommit(repo, ref));
}

/**
 * Materialize `sha` of `repo` into `dest` from git objects only (no working-tree
 * files), recursing into every submodule whose top-level entry the allowlist ships.
 * An unresolvable gitlink REFUSES: silently exporting a hole would publish a tree
 * that is not the commit the manifest names.
 * @returns {{ path: string, sha: string }[]} the submodules materialized
 */
export function materializeCommit({ repo, sha, dest, allow, prefix = '' }) {
  extractArchive(repo, sha, prefix ? join(dest, prefix) : dest);
  const subs = [];
  for (const link of listGitlinks(repo, sha)) {
    const full = prefix ? `${prefix}/${link.path}` : link.path;
    if (!allow.has(full.split('/')[0])) continue;
    // The submodule must be its OWN checkout: an uninitialised submodule is an
    // empty dir inside the parent, where `git -C` would silently answer for the
    // parent repository instead.
    const subRepo = materializedSubmodule(repo, link, full);
    const target = join(dest, full);
    // git archive leaves the gitlink as an empty directory; make sure it exists.
    run('mkdir', ['-p', target]);
    subs.push({ path: full, sha: link.sha });
    subs.push(...materializeCommit({ repo: subRepo, sha: link.sha, dest, allow, prefix: full }));
  }
  return subs;
}

/** Internal verification export: no public selection, scrub, publish or working-tree overlay.
 * The caller retains this receipt outside the export, then verifies it before execution.
 * @param {{repo: string, ref: string, dest: string, inputs?: string[], inputsFile?: string, gitCheckout?: boolean}} options
 */
// Shared by early e2e admission and the native snapshot. Explicit caller
// acceptance paths remain required; this tooling profile cannot replace them.
export const TAURI_VERIFIER_INPUTS = Object.freeze([
  'package.json',
  'package-lock.json',
  'papercusp-desktop/package.json',
  'papercusp-desktop/package-lock.json',
  'scripts/npm-install-safe.mjs',
  'scripts/verify-tauri-headless.sh',
  'scripts/run-operator-e2e-isolated.sh',
  'scripts/lib/operator-e2e-assertion.sh',
  'scripts/lib/verify-tauri-assertion-env.mjs',
  'scripts/lib/verify-tauri-screenshot.sh',
  'scripts/lib/run-in-isolated-netns.sh',
  'packages/operator-core/lib/testing-playwright-reporter.ts',
  'packages/operator-core/lib/testing-native-runtime.ts',
  'packages/operator-core/lib/process-identity.ts',
  'apps/operator/e2e/_fake-llm-fixture.ts',
  'apps/operator/e2e/_fake-llm-fixture-child.ts',
  'apps/operator/bin/bundle-host.sh',
  'apps/operator/bin/bundle-host-common.sh',
  'scripts/source-preview.mjs',
  'scripts/lib/committed-source-loader.mjs',
  'scripts/restricted-hold-tree-gate.mjs',
  'scripts/lib/spa-require-built.sh',
  'scripts/lib/budgeted-task-scheduler.mjs',
  'scripts/lib/task-cgroup-limits.mjs',
  'scripts/lib/task-deadline.mjs',
  'scripts/lib/verify-tauri-deadline.mjs',
  'scripts/pc-heavy.sh',
  'apps/operator/bin/release/dependency-generation.sh',
  'papercusp-desktop/bin/tauri-guarded',
  'papercusp-desktop/bin/lib/claim-target-dir.sh',
  'papercusp-desktop/bin/lib/cargo-target-root.sh',
  'papercusp-desktop/bin/lib/release-artifacts.sh',
  'papercusp-desktop/bin/lib/federation-asserts.sh',
  'papercusp-desktop/bin/lib/disk-preflight.sh',
  'papercusp-desktop/bin/lib/pinned-deps.sh',
  'papercusp-desktop/src-tauri/src/main.rs',
  'papercusp-desktop/src-tauri/src/native_console.rs',
  'papercusp-desktop/src-tauri/src/wsl_sidecar_staging.rs',
  'papercusp-desktop/test/native-console-gnome.test.mjs',
  'papercusp-desktop/test/monorepo-host-preflight.mjs',
  'scripts/lib/node-test-host-preflight.mjs',
  'packages/operator-core/lib/gnome-terminal-policy.json',
]);

// These exact outputs are rebuilt from the recorded source during verification.
// Older commits may track them; an archive must not seal their stale bytes as
// source, and a Git checkout cannot discard its tracked population.
const VERIFIER_REBUILT_OUTPUTS = [
  'apps/operator/dist-verify',
  'papercusp-desktop/src-tauri/resources/workbench@papercusp.ai.shell-extension.zip',
  'papercusp-desktop/src-tauri/resources/workbench-install.js',
];

function committedVerifierPathTracked(repo, sha, path) {
  const link = listGitlinks(repo, sha).find(entry => path.startsWith(entry.path + '/'));
  if (link) return committedVerifierPathTracked(materializedSubmodule(repo, link, link.path),
    link.sha, path.slice(link.path.length + 1));
  return Boolean(git(repo, ['ls-tree', sha, '--', path]).trim());
}

/** Validate the explicit tested source population against its pinned commit.
 * @param {{ repo: string, ref: string, inputs?: string[], inputsFile?: string, tauriInputs?: boolean, receiptSha256?: string }} options
 */
export async function validateVerifierInputs({ repo, ref, inputs = [], inputsFile, tauriInputs = false, receiptSha256 }) {
  if (inputsFile !== undefined) {
    const listed = JSON.parse(await fs.readFile(inputsFile, 'utf8'));
    if (!Array.isArray(listed) || !listed.length || listed.some((path) => typeof path !== 'string')) {
      throw new PreviewError('verification inputs file must contain a non-empty JSON array of paths', 2);
    }
    inputs = [...inputs, ...listed];
  }
  if (!inputs.length) throw new PreviewError('verification export needs explicit tested inputs', 2);
  if (tauriInputs) inputs = [...inputs, ...TAURI_VERIFIER_INPUTS];
  const paths = [...new Set(inputs)].sort();
  for (const path of paths) {
    if (VERIFIER_REBUILT_OUTPUTS.some(output => path === output || path.startsWith(output + '/'))) {
      throw new PreviewError(`generated verifier runtime output cannot be a tested source input: ${path}`, 2);
    }
    if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\0')
      || path.split('/').some((p) => p === '..' || p === '.' || !p)) {
      throw new PreviewError(`invalid tested input: ${path}`, 2);
    }
  }
  if (receiptSha256 !== undefined) {
    const { root, receipt } = readPinnedVerifierArchive(repo, ref, receiptSha256);
    const receiptPaths = receipt.testedInputs.map(input => input.path).sort();
    if (paths.length !== receiptPaths.length || paths.some((path, index) => path !== receiptPaths[index]))
      throw new PreviewError('tested input membership differs from pinned verifier source receipt', 2);
    const pins = new Map(receipt.testedInputs.map(input => [input.path, input.sha256]));
    for (const path of paths) {
      let info;
      try { info = await fs.lstat(join(root, path)); }
      catch (error) {
        if (error.code === 'ENOENT') throw new PreviewError('tested input is missing from verifier archive: ' + path, 2);
        throw error;
      }
      if (!info.isFile()) throw new PreviewError('tested input is not a regular file: ' + path, 2);
      const digest = createHash('sha256').update(await fs.readFile(join(root, path))).digest('hex');
      if (digest !== pins.get(path)) throw new PreviewError('dirty tested-input mismatch: ' + path, 2);
    }
    verifyVerifierSourceSync(root, receipt, { runtimeArtifacts: true });
    return { sha: receipt.sourceCommit, paths };
  }
  const sha = resolveCommit(repo, ref);
  // Refuse initial mismatches before creating a destination, cloning or
  // archiving. Keep the post-copy comparison below as the race guard.
  const inputTrees = new Map();
  for (const path of paths) {
    const live = join(repo, path);
    if (!(await fs.lstat(live)).isFile()) {
      throw new PreviewError(`tested input is not a regular file: ${path}`, 2);
    }
    const blob = committedInputBlob(repo, sha, path, inputTrees);
    const bytes = await fs.readFile(live);
    // Git's raw blob identity includes its object header; do not apply filters.
    const digest = createHash(blob.length === 64 ? 'sha256' : 'sha1')
      .update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (digest !== blob) {
      throw new PreviewError(`dirty tested-input mismatch: ${path}`, 2);
    }
  }
  return { sha, paths };
}

/** Prepare a source snapshot only after all declared inputs match their pin.
 * `runtimeOutputs: 'preserve'` retains committed outputs in an independent Git
 * checkout for read-only consumers (for example a host build with an external
 * output directory). They remain recorded source: rebuilding them invalidates
 * the receipt. The default archive/rebuild contract is unchanged.
 * Dependency-executing callers require lock coherence before allocating source;
 * source-only archival also supports inspecting historically incoherent trees.
 * @param {{ repo: string, ref: string, dest: string, inputs?: string[], inputsFile?: string, gitCheckout?: boolean, runtimeOutputs?: 'rebuild' | 'preserve', tauriInputs?: boolean, requireDependencyCoherence?: boolean, sourceArchive?: { root: string, receiptSha256: string }, operatorApi?: { root: string, sourceReceiptPath: string, sourceReceiptSha256: string, inputReceiptPath: string, inputReceiptSha256: string, outputPath: string } }} options
 */
export async function prepareVerifierSource({ repo, ref, dest, inputs = [], inputsFile, gitCheckout = false, runtimeOutputs = 'rebuild', tauriInputs = false, requireDependencyCoherence = false, sourceArchive, operatorApi }) {
  repo = realpathSync(repo);
  if (!['rebuild', 'preserve'].includes(runtimeOutputs) || (runtimeOutputs === 'preserve' && !gitCheckout))
    throw new PreviewError('preserving verifier runtime outputs requires an independent Git checkout', 2);
  if (existsSync(dest)) throw new PreviewError('verification export destination already exists', 2);
  // Git remains the export authority. A separately pinned archive may supply
  // the input observation when the shared checkout has advanced during a build.
  const authority = sourceArchive
    ? readPinnedVerifierArchive(sourceArchive.root, resolveCommit(repo, ref), sourceArchive.receiptSha256)
    : undefined;
  if (authority?.root === repo)
    throw new PreviewError('verifier source archive must be independent from the Git repository', 2);
  const { sha, paths } = await validateVerifierInputs({ repo: authority?.root ?? repo,
    ref: authority?.receipt.sourceCommit ?? ref, inputs, inputsFile, tauriInputs,
    ...(sourceArchive ? { receiptSha256: sourceArchive.receiptSha256 } : {}) });
  if (requireDependencyCoherence) assertCommittedWorkspaceLockMatches(repo, sha);
  // Observations come from a separately selected root, never this exporter.
  const planned = operatorApi ? readOperatorApiHandoff(operatorApi, sha) : undefined;
  if (operatorApi) {
    if (realpathSync(operatorApi.root) === realpathSync(repo))
      throw new PreviewError('operator-api inputs require an independent selected root', 2);
    if (existsSync(operatorApi.outputPath)) throw new PreviewError('operator-api handoff destination already exists', 2);
    assertOutsideArchive(dest, operatorApi.outputPath);
    for (const path of paths) assert.ok(planned.source.testedInputs.some(input => input.path === path),
      `Operator-api selected tested input missing: ${path}`);
  }
  if (gitCheckout) {
    // Reuse the guarded local clone: detached exact ref, borrowed objects, local
    // submodule pins, no origins, and cleanup only of its own new destination.
    const { createScratchClone } = await import('@papercusp/operator-core/lib/scratch-git-clone');
    // Private dependency copies still borrow their original source's Git
    // objects. Clone that source at the already validated exact pin so removing
    // the intermediate reader cannot invalidate the verifier's object store.
    await createScratchClone({ source: committedWorkRootDependencyDonor(repo, { sourceObjects: true }), ref: sha,
      destination: dest, includeSubmodules: true });
  } else await fs.mkdir(dest, { recursive: !operatorApi });
  let handoffIdentity;
  try {
    // Unlike the public export, verification includes desktop/helper gitlinks too.
    const allow = new Set(git(repo, ['ls-tree', '--name-only', sha]).trim().split('\n'));
    const submodules = gitCheckout
      ? [...function* collect(source, commit, prefix = '') {
        for (const link of listGitlinks(source, commit)) {
          const path = prefix ? `${prefix}/${link.path}` : link.path;
          yield { path, sha: link.sha };
          yield* collect(join(source, link.path), link.sha, path);
        }
      }(repo, sha)]
      : materializeCommit({ repo, sha, dest, allow });
    // The verifier rebuilds this private runtime with the maintained bundler.
    // Older commits may contain generated output despite today's gitignore.
    // Never record those mutable artifacts as immutable source in an archive.
    // A Git checkout must retain its tracked population, so refuse that route
    // rather than removing tracked files or weakening its source attestation.
    for (const path of VERIFIER_REBUILT_OUTPUTS) {
      if (runtimeOutputs === 'preserve') continue;
      const runtimeOutput = join(dest, path);
      const info = await fs.lstat(runtimeOutput).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (gitCheckout && info && (!info.isDirectory() || (await fs.readdir(runtimeOutput)).length)) {
        throw new PreviewError('committed verifier runtime output requires archive export, not Git checkout', 2);
      }
      if (!gitCheckout) await fs.rm(runtimeOutput, { recursive: true, force: true });
    }
    const testedInputs = [];
    for (const path of paths) {
      const archived = join(dest, path);
      const live = join(authority?.root ?? repo, path);
      if (!(await fs.lstat(archived)).isFile() || !(await fs.lstat(live)).isFile()) {
        throw new PreviewError(`tested input is not a regular file: ${path}`, 2);
      }
      const digest = createHash('sha256').update(await fs.readFile(archived)).digest('hex');
      if (digest !== createHash('sha256').update(await fs.readFile(live)).digest('hex')) {
        throw new PreviewError(`dirty tested-input mismatch: ${path}`, 2);
      }
      testedInputs.push({ path, sha256: digest });
    }
    const checkout = gitCheckout ? verifierGitCheckoutSync(dest, sha, submodules) : undefined;
    const gitMetadataPaths = checkout ? ['.git', ...submodules.map(row => `${row.path}/.git`)] : [];
    const sourceManifest = { schemaVersion: 'verifier-source-v1', sourceCommit: sha, submodules,
      ...(checkout ? { gitCheckout: checkout } : {}), testedInputs, files: verifierSourceFiles(dest, { gitMetadataPaths }) };
    if (authority) {
      // Re-read the original pin and census after asynchronous materialization.
      // Matching tested inputs alone cannot attest unrelated exported source.
      const current = readPinnedVerifierArchive(authority.root, sha, sourceArchive.receiptSha256).receipt;
      assert.deepEqual(sourceManifest.files, current.files, 'Pinned source archive census differs from Git export');
      assert.deepEqual(sourceManifest.submodules, current.submodules, 'Pinned source archive submodules differ from Git export');
      assert.deepEqual(sourceManifest.testedInputs, current.testedInputs, 'Pinned source archive tested inputs differ from Git export');
    }
    // Declared, not inferred: the operator-api branch below adds operatorApiInputs after
    // construction, and JS inference would otherwise drop it from the returned receipt type.
    /** @type {typeof sourceManifest & { operatorApiInputs?: { path: string, sha256: string } }} */
    const manifest = sourceManifest;
    if (planned) {
      assert.deepEqual(manifest.files, planned.source.files, 'Operator-api selected source census differs');
      assert.deepEqual(manifest.submodules, planned.source.submodules, 'Operator-api selected submodules differ');
      assert.deepEqual(manifest.testedInputs, planned.source.testedInputs, 'Operator-api selected tested inputs differ');
      // Copy already-materialized bytes. Never install, borrow ambient modules,
      // dereference links or replace a dependency tree recorded as source.
      assert.ok(!existsSync(join(dest, 'node_modules')), 'Operator-api archive already contains dependencies');
      await fs.cp(join(operatorApi.root, 'node_modules'), join(dest, 'node_modules'),
        { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false });
      assert.deepEqual(verifierSourceFiles(join(dest, 'node_modules')), planned.inputs.dependencyFiles,
        'Operator-api copied materialized dependency census differs');
      readOperatorApiHandoff(operatorApi, sha); // Pins and donor bytes must survive the copy.
      manifest.operatorApiInputs = { path: resolve(operatorApi.outputPath), sha256: operatorApi.inputReceiptSha256 };
    }
    await fs.writeFile(join(dest, '.verifier-source.json'), `${JSON.stringify(manifest)}\n`, { flag: 'wx' });
    if (gitCheckout) {
      // This exporter owns the independent Git directory. Ignore only its
      // generated receipt, keeping arbitrary untracked source visible to the
      // ordinary test reporters' before/after Git probes. Receipt integrity is
      // still checked independently by verifyVerifierSource.
      await fs.appendFile(join(dest, '.git/info/exclude'), '\n/.verifier-source.json\n');
    }
    if (planned) {
      // Check the complete archive again after asynchronous copying, before
      // publishing any handoff. The earlier census is not a copy-time guard.
      verifyArchivedSourceSync(dest, manifest, { runtimeArtifacts: true });
      assertOutsideArchive(dest, operatorApi.outputPath);
      const output = await fs.open(operatorApi.outputPath, 'wx', 0o600);
      try {
        handoffIdentity = await output.stat();
        await output.writeFile(planned.bytes);
      } finally { await output.close(); }
      verifyVerifierSourceSync(dest, manifest);
      readOperatorApiHandoff(operatorApi, sha);
    }
    return manifest;
  } catch (error) {
    // A failed write or final attestation must not leave our partial handoff.
    // Never unlink an existing file that lost the exclusive-create race, or a
    // replacement with a different identity.
    if (handoffIdentity) {
      const current = await fs.lstat(operatorApi.outputPath).catch(error => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (current?.dev === handoffIdentity.dev && current?.ino === handoffIdentity.ino)
        await fs.unlink(operatorApi.outputPath);
    }
    await fs.rm(dest, { recursive: true, force: true });
    if (error instanceof VerifierSourceError) throw new PreviewError(error.message, 2);
    throw error;
  }
}

/** @typedef {{ completedTrees: number, totalTrees: number, currentTree: string, cacheHit?: boolean }} VerifierDependencyProgress */
/** @typedef {{ copyMode: 'copy' | 'hardlink', generationSnapshotSupported: boolean, explicitGeneration?: boolean,
 *   command: 'snapshot-locked' | 'snapshot-generation-locked' }} VerifierSnapshotSelection */
/** @typedef {{ snapshotSelection?: VerifierSnapshotSelection }} VerifierPhaseMetadata */
/** @typedef {(<T>(phase: string, operation: () => T | Promise<T>, metadata?: VerifierPhaseMetadata) => Promise<T>)
