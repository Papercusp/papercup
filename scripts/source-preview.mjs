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
// npm: preview:export · preview:gate · preview:check · preview:push
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
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs, existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const PREVIEW_REPO = 'Papercusp/papercusp-preview';
export const SOURCE_REPO = 'Papercusp/papercup';
export const DEFAULT_REMOTE = `https://github.com/${PREVIEW_REPO}.git`;
export const DEFAULT_REF = 'main';
const DESKTOP_BIN = join(ROOT, 'papercusp-desktop', 'bin');
export const SELECT_SCRIPT = join(DESKTOP_BIN, 'source-tree-select.sh');
export const SELECTION_LIB = join(DESKTOP_BIN, 'lib', 'source-tree-selection.sh');
export const AUDIT_SCRIPT = join(DESKTOP_BIN, 'audit-release-bundle.py');
/** Files this script adds at the export root, outside the shared selection. */
export const ADDED_FILES = ['NOTICE', 'README.md', 'MANIFEST.json'];
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

const git = (repo, args, opts) => run('git', ['-C', repo, ...args], opts);

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
    const subRepo = join(repo, link.path);
    // The submodule must be its OWN checkout: an uninitialised submodule is an
    // empty dir inside the parent, where `git -C` would silently answer for the
    // parent repository instead.
    const known = existsSync(subRepo)
      && spawnSync('git', ['-C', subRepo, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim() === realpathSync(subRepo)
      && spawnSync('git', ['-C', subRepo, 'cat-file', '-e', `${link.sha}^{commit}`]).status === 0;
    if (!known) {
      throw new PreviewError(`unresolvable gitlink ${full} @ ${link.sha} — its commit is not present in ${subRepo}; run \`git submodule update --init\` or fetch it, then retry`);
    }
    const target = join(dest, full);
    // git archive leaves the gitlink as an empty directory; make sure it exists.
    run('mkdir', ['-p', target]);
    subs.push({ path: full, sha: link.sha });
    subs.push(...materializeCommit({ repo: subRepo, sha: link.sha, dest, allow, prefix: full }));
  }
  return subs;
}

async function listFiles(dir) {
  const out = [];
  async function walk(d) {
    for (const ent of await fs.readdir(d, { withFileTypes: true })) {
      const p = join(d, ent.name);
      if (ent.isDirectory()) await walk(p);
      else out.push(relative(dir, p).split(sep).join('/'));
    }
  }
  await walk(dir);
  return out.sort();
}

export function noticeText(manifest) {
  return [
    'Papercusp — private source preview',
    '',
    `Copyright (c) ${manifest.year} Papercusp. All rights reserved.`,
    '',
    'This source is shared privately, by invitation, for EVALUATION ONLY.',
    '',
    'You may read it and run it on your own machines to evaluate Papercusp.',
    'You may not redistribute, publish, sublicense or sell it, in whole or in part,',
    'or use it to build or train a competing product or model.',
    '',
    'No license is granted beyond this evaluation permission. Access can be',
    'revoked at any time, and this notice applies to every copy you keep.',
    '',
    `Snapshot: ${manifest.source.repo} @ ${manifest.source.commit}`,
    '',
  ].join('\n');
}

async function describeWorkspaces(dir) {
  const rows = [];
  for (const top of ['apps', 'libs', 'packages']) {
    const base = join(dir, top);
    if (!existsSync(base)) continue;
    const walk = async (rel, depth) => {
      const abs = join(dir, rel);
      const pkg = join(abs, 'package.json');
      if (existsSync(pkg)) {
        let name = rel;
        let description = '';
        try {
          const j = JSON.parse(await fs.readFile(pkg, 'utf8'));
          name = j.name || rel;
          description = typeof j.description === 'string' ? j.description : '';
        } catch { /* unparsable package.json: list the path only */ }
        rows.push({ rel, name, description });
        return;
      }
      if (depth === 0) return;
      for (const ent of await fs.readdir(abs, { withFileTypes: true })) {
        if (ent.isDirectory()) await walk(`${rel}/${ent.name}`, depth - 1);
      }
    };
    for (const ent of (await fs.readdir(base, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (ent.isDirectory()) await walk(`${top}/${ent.name}`, 1);
    }
  }
  return rows;
}

/**
 * The releases page README.md links to: `${PAPERCUSP_UPDATE_BASE_URL}/index.html`.
 * Reads `env` only — never a file — so a test's verdict cannot depend on the home
 * directory it runs in; the CLI fills `env` first (loadReleaseHost).
 * @param {NodeJS.ProcessEnv} env
 */
export function releasesPageUrl(env) {
  const base = (env[RELEASE_BASE_ENV] ?? '').trim().replace(/\/+$/, '');
  if (!/^https:\/\/\S+$/.test(base)) {
    throw new PreviewError(`${RELEASE_BASE_ENV} is ${base ? `not an https URL (${base})` : 'unset'} — README.md must link the releases page; export it or provide ${RELEASE_HOST_ENV_PATH}`, 2);
  }
  return `${base}/index.html`;
}

/**
 * Fill PAPERCUSP_UPDATE_BASE_URL from the release scripts' own config file when the
 * environment is silent. An exported value always wins, as in release-host.sh.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [path]
 */
export function loadReleaseHost(env = process.env, path = RELEASE_HOST_ENV_PATH) {
  if (env[RELEASE_BASE_ENV] || !existsSync(path)) return;
  const value = parseEnv(readFileSync(path, 'utf8'))[RELEASE_BASE_ENV];
  if (value) env[RELEASE_BASE_ENV] = value;
}

export async function readmeText(dir, manifest, releasesUrl) {
  const tops = (await fs.readdir(dir, { withFileTypes: true }))
    .filter((e) => !ADDED_FILES.includes(e.name))
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort();
  const ws = await describeWorkspaces(dir);
  const lines = [
    '# Papercusp — source preview',
    '',
    'Papercusp is a desktop workspace where coding agents work alongside you, coordinated',
    'through shared plans, work items, locks and memory. This repository is a private,',
    'read-only snapshot of its source, shared for evaluation (see NOTICE).',
    '',
    `- Snapshot of \`${manifest.source.repo}\` at \`${manifest.source.commit}\`, with`,
    `  ${manifest.submodules.length} submodule(s) flattened in at their pinned commits (MANIFEST.json).`,
    '- It is the same public-safe source cut the Papercusp Server installer carries, without',
    '  `node_modules` (run `npm ci` to install dependencies from `package-lock.json`)',
    '  and without the Tauri desktop shell or git history.',
    '- It is replaced wholesale on each update: re-clone or `git fetch && git reset --hard origin/main`.',
    '',
    '## Download Papercusp',
    '',
    `Installers for every published version, with release notes and install instructions, are on`,
    `the **[Papercusp releases page](${releasesUrl})**. Install both apps: **Papercusp Server**`,
    'runs the operator, its embedded database and your agents on your machine, and **Papercusp GUI**',
    'is the desktop window onto it.',
    '',
    '## How this source ships inside every release',
    '',
    'The Papercusp Server installer carries this same source tree as one compressed resource,',
    '`sidecar/source.tar.zst`:',
    '',
    '- **What is in it.** The code you are reading plus its already-installed `node_modules`. The',
    '  release build selects it with the same allowlist, and checks it with the same audit, that',
    '  produced this snapshot. Both refuse git history, internal plans, agent transcripts and',
    '  state, and credentials, and both redact personal identity. The only difference here is that',
    '  `node_modules` is left out.',
    '- **Where it goes.** On first launch the app extracts the archive into a writable folder in',
    '  its own data directory (on Windows, inside the `papercup-runtime` WSL distro). Later',
    '  launches skip the extract.',
    '- **What runs from it.** Two of the environments in the app\'s environment switcher run',
    '  Papercusp from that extracted source instead of from the prebuilt server: **dev**',
    '  (port 3270) runs the API host straight from TypeScript (`tsx apps/operator/bin/hono-host.ts`),',
    '  and **local** (port 3055) runs the Vite dev server over the UI in `apps/operator-vite`.',
    '  Both run on the Node.js bundled in the app with the tree\'s own `tsx` and `vite`, because',
    '  an installed machine has no npm.',
    '',
    '## Why the release carries its own source',
    '',
    'So that the Papercusp you installed can run a Papercusp you changed. Papercusp is developed',
    'with Papercusp, and shipping the runnable source means any install can do what the',
    'development machine does: open the tree, edit it (by hand or with agents), and run the edited',
    'build side by side with the installed one, without cloning a repository or installing a',
    'toolchain. Two design choices follow from that:',
    '',
    '- **Extracted to a writable folder, not run in place.** The install directory is read-only,',
    '  and a source tree you cannot edit defeats the purpose.',
    '- **One archive, not loose files.** The tree with its `node_modules` runs to several',
    '  gigabytes of small files. Copying them one by one through the app bundler\'s resource',
    '  pipeline is slow, and the `node_modules/.bin` symlinks survive `tar` but not that copy.',
    '',
    'This repository is the same source without `node_modules`, so you can read it before you install.',
    '',
    '## Where to read first',
    '',
    '- `CLAUDE.md` / `AGENTS.md` — the conventions every agent in this codebase works under.',
    '- `docs/` — design and architecture notes.',
    '- `apps/operator/` — the operator: API host, agent tools, coordination.',
    '- `libs/papercusp/` — the core platform libraries (database schema and migrations live in `libs/papercusp/libs/db/`).',
    '',
    '## Top-level layout',
    '',
    ...tops.map((t) => `- \`${t}\``),
    '',
    '## Workspaces',
    '',
    '| path | package | description |',
    '|---|---|---|',
    ...ws.map((w) => `| \`${w.rel}\` | \`${w.name}\` | ${w.description.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()} |`),
    '',
  ];
  return lines.join('\n');
}

/**
 * The copyright year of `commit`: the newest commit date in its recent first-parent history.
 * The commit's own date is unusable — repair-queue admission commits carry a fixed 2000-01-01.
 * @param {string} repo
 * @param {string} commit
 */
export function sourceYear(repo, commit) {
  const stamps = git(repo, ['log', '-n', '200', '--first-parent', '--format=%ct', commit]).trim().split('\n').map(Number);
  return new Date(Math.max(...stamps) * 1000).getUTCFullYear();
}

/**
 * Export one pinned commit as the public-safe cut into `out` (must not exist).
 * Deterministic for a given commit — no timestamps — so a drift check compares
 * content, not clock.
 * @param {{ repoRoot?: string, ref?: string, out: string, selectScript?: string, selectionLib?: string, env?: NodeJS.ProcessEnv, log?: Log }} opts
 */
export async function exportSnapshot({
  repoRoot = ROOT,
  ref = DEFAULT_REF,
  out,
  selectScript = SELECT_SCRIPT,
  selectionLib = SELECTION_LIB,
  env = process.env,
  log = () => {},
}) {
  if (!out) throw new PreviewError('exportSnapshot: out is required', 2);
  if (existsSync(out)) throw new PreviewError(`refusing to overwrite existing ${out}`, 2);
  const releasesUrl = releasesPageUrl(env);
  const commit = resolveCommit(repoRoot, ref);
  const allow = allowlistTops(selectionLib);
  const work = await mkdtemp(join(tmpdir(), 'source-preview-'));
  const partial = `${out}.partial-${process.pid}`;
  try {
    const mono = join(work, 'mono');
    await fs.mkdir(mono);
    log(`materializing ${commit} (+ submodules at their gitlinks)`);
    const submodules = materializeCommit({ repo: repoRoot, sha: commit, dest: mono, allow });
    await fs.mkdir(dirname(partial), { recursive: true });
    log('selecting the public-safe cut (shared with the installer)');
    const sel = spawnSync('bash', [selectScript, '--mono', mono, '--into', partial, '--mode', 'preview'], {
      encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024,
    });
    if (sel.status !== 0) {
      throw new PreviewError(`source-tree-select refused (exit ${sel.status}): ${(sel.stderr || sel.stdout).trim().slice(-2000)}`, sel.status === 2 ? 2 : 1);
    }
    const files = await listFiles(partial);
    const vcs = files.filter((f) => f === '.git' || f.startsWith('.git/') || f.includes('/.git/') || f.endsWith('/.git'));
    if (vcs.length) throw new PreviewError(`export contains git metadata: ${vcs.slice(0, 5).join(', ')}`);
    const collisions = files.filter((f) => ADDED_FILES.includes(f));
    if (collisions.length) throw new PreviewError(`the selection already ships ${collisions.join(', ')} — refusing to overwrite`);
    const shipped = submodules.filter((s) => existsSync(join(partial, s.path)));
    const manifest = {
      schema: 1,
      purpose: 'private source preview — public-safe cut (plan dhh-source-preview-2026-09-28)',
      year: sourceYear(repoRoot, commit),
      source: { repo: SOURCE_REPO, ref, commit },
      submodules: shipped,
      notShipped: submodules.filter((s) => !shipped.includes(s)).map((s) => s.path),
      fileCount: files.length,
      generatedBy: 'scripts/source-preview.mjs',
    };
    await fs.writeFile(join(partial, 'NOTICE'), noticeText(manifest));
    await fs.writeFile(join(partial, 'README.md'), await readmeText(partial, manifest, releasesUrl));
    await fs.writeFile(join(partial, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await fs.rename(partial, out);
    return { out, manifest };
  } catch (err) {
    await rm(partial, { recursive: true, force: true });
    throw err;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function which(bin, env) {
  const r = spawnSync('bash', ['-c', 'command -v "$1"', '_', bin], { encoding: 'utf8', env });
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * The fail-closed gate. Every detector must RUN and come back clean; a finding
 * refuses (exit 1) and a detector that cannot run refuses too (exit 2).
 * @param {string} dir
 * @param {{ env?: NodeJS.ProcessEnv, auditScript?: string, allowlistPath?: string }} [opts]
 * @returns {Promise<GateVerdict>}
 */
export async function runGate(dir, { env = process.env, auditScript = AUDIT_SCRIPT, allowlistPath = ALLOWLIST_PATH } = {}) {
  const results = [];
  const allFindings = [];
  const allowlist = await loadAllowlist(allowlistPath);
  const record = (name, status, detail) => results.push({ name, ok: status === 'clean', status, detail: detail.trim().slice(-3000) });
  if (!existsSync(dir)) throw new PreviewError(`gate: ${dir} does not exist`, 2);
  const tools = { python3: which('python3', env), tar: which('tar', env), zstd: which('zstd', env), gitleaks: which('gitleaks', env), trufflehog: which('trufflehog', env) };
  const missing = Object.entries(tools).filter(([, p]) => !p).map(([n]) => n);
  if (missing.length) {
    for (const m of missing) record(m, 'cannot-check', `${m} not found on PATH — the gate refuses rather than skip a detector`);
    return { ok: false, exitCode: 2, results };
  }
  const work = await mkdtemp(join(tmpdir(), 'source-preview-gate-'));
  try {
    // 1. The installer's own audit over a packed copy: forbidden paths, identity, credentials.
    const bundle = join(work, 'preview.tar.zst');
    run('bash', ['-c', 'set -euo pipefail; tar --sort=name --numeric-owner --owner=0 --group=0 -C "$1" -cf - . | zstd -q -3 -f -o "$2"', '_', dir, bundle], { env });
    const a = spawnSync(tools.python3, [auditScript, bundle], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
    record('audit-release-bundle', a.status === 0 ? 'clean' : a.status === 1 ? 'finding' : 'cannot-check', `${a.stdout}\n${a.stderr}`);
    // 2. Its directory backstop (honors no path-exclude).
    const s = spawnSync(tools.python3, [auditScript, '--scan-dir', dir], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
    record('audit-release-bundle --scan-dir', s.status === 0 ? 'clean' : s.status === 1 ? 'finding' : 'cannot-check', `${s.stdout}\n${s.stderr}`);
    // 3. gitleaks, default rules. The report holds raw secrets, so it stays in the
    //    temp dir (removed below) and only SHA-256 fingerprints leave this function.
    const report = join(work, 'gitleaks.json');
    const g = spawnSync(tools.gitleaks, ['dir', dir, '--no-banner', '--exit-code', '1', '--report-format', 'json', '--report-path', report], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
    if (g.status === 0 || g.status === 1) {
      let raw = [];
      if (g.status === 1) {
        try { raw = JSON.parse(await fs.readFile(report, 'utf8')); } catch (e) { record('gitleaks', 'cannot-check', `unreadable report: ${e.message}`); raw = null; }
      }
      if (raw) {
        const found = raw.map((f) => fingerprint('gitleaks', f.RuleID, relPath(dir, f.File), f.StartLine, f.Secret ?? f.Match ?? ''));
        if (g.status === 1 && found.length === 0) record('gitleaks', 'cannot-check', 'gitleaks exited 1 but its report lists no findings');
        else recordFindings('gitleaks', found);
      }
    } else {
      record('gitleaks', 'cannot-check', `${g.stdout}\n${g.stderr}`);
    }
    // 4. trufflehog, detection only: --no-verification, because verifying would send
    //    each candidate secret to its provider's API.
    const t = spawnSync(tools.trufflehog, ['filesystem', dir, '--no-update', '--no-verification', '--json', '--fail'], { encoding: 'utf8', env, maxBuffer: 256 * 1024 * 1024 });
    if (t.status === 0 || t.status === 183) {
      const found = [];
      let unparsable = 0;
      for (const l of t.stdout.split('\n').filter(Boolean)) {
        try {
          const j = JSON.parse(l);
          const fsMeta = j.SourceMetadata?.Data?.Filesystem ?? {};
          found.push(fingerprint('trufflehog', j.DetectorName, relPath(dir, fsMeta.file ?? '?'), fsMeta.line ?? 0, j.Raw ?? j.RawV2 ?? ''));
        } catch { unparsable += 1; }
      }
      if (unparsable || (t.status === 183 && found.length === 0)) record('trufflehog', 'cannot-check', `${unparsable} unparsable output line(s); exit ${t.status}`);
      else recordFindings('trufflehog', found);
    } else {
      record('trufflehog', 'cannot-check', `exit ${t.status}: ${t.stderr}`);
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  const ok = results.every((r) => r.ok);
  const exitCode = ok ? 0 : results.some((r) => r.status === 'finding') ? 1 : 2;
  return { ok, exitCode, results, findings: allFindings };

  function recordFindings(name, found) {
    const open = found.filter((f) => !isAllowlisted(allowlist, f));
    allFindings.push(...found.map((f) => ({ ...f, allowlisted: !open.includes(f) })));
    const accepted = found.length - open.length;
    const detail = open.slice(0, 60).map((f) => `${f.rule}  ${f.path}:${f.line}  sha256:${f.sha256.slice(0, 12)}`).join('\n')
      + (open.length > 60 ? `\n… ${open.length - 60} more` : '')
      + (accepted ? `\n(${accepted} reviewed false positive(s) accepted by ${relative(ROOT, allowlistPath)})` : '');
    record(name, open.length ? 'finding' : 'clean', detail);
  }
}

function relPath(dir, file) {
  const rel = relative(dir, file);
  return (rel.startsWith('..') ? file : rel).split(sep).join('/');
}

/** A finding without its secret: rule, path, line, and the SHA-256 of the matched value. */
function fingerprint(detector, rule, path, line, secret) {
  return { detector, rule: String(rule), path, line: Number(line) || 0, sha256: createHash('sha256').update(String(secret)).digest('hex') };
}

export const ALLOWLIST_PATH = join(ROOT, 'scripts', 'source-preview-allowlist.json');

/**
 * Reviewed false positives of the ADDITIONAL detectors (gitleaks, trufflehog) —
 * never of the release audit, whose BENIGN_ERE stays the one vendor-key rule.
 * An entry matches one exact (detector, rule, path, secret-hash): a changed or new
 * value in the same file is a new finding. Every entry must carry a reason.
 * @returns {Promise<{ detector: string, rule: string, path: string, sha256: string, reason: string }[]>}
 */
export async function loadAllowlist(path = ALLOWLIST_PATH) {
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(await fs.readFile(path, 'utf8'));
  const entries = Array.isArray(parsed) ? parsed : parsed.entries;
  if (!Array.isArray(entries)) throw new PreviewError(`${path}: expected { entries: [...] }`, 2);
  for (const e of entries) {
    for (const k of ['detector', 'rule', 'path', 'sha256', 'reason']) {
      if (typeof e[k] !== 'string' || !e[k].trim()) throw new PreviewError(`${path}: every entry needs a non-empty ${k} (${JSON.stringify(e).slice(0, 200)})`, 2);
    }
    if (!/^[0-9a-f]{64}$/.test(e.sha256)) throw new PreviewError(`${path}: sha256 must be 64 hex chars (${e.path})`, 2);
  }
  return entries;
}

export function isAllowlisted(entries, f) {
  return entries.some((e) => e.detector === f.detector && e.rule === f.rule && e.path === f.path && e.sha256 === f.sha256);
}

/**
 * The tree a drift check compares, written into `gitDir` from `tree`: the snapshot with
 * its identity neutralized — MANIFEST.json dropped, and the source commit that NOTICE
 * and README.md name replaced by a placeholder. So a superproject commit that
 * changes nothing the preview ships is not drift (git-sync commits every few minutes),
 * while a changed shipped file, NOTICE or README text, or a hand edit on the
 * preview still is. A tree without a readable MANIFEST.json compares as-is. All three
 * files sit at the root, so only the root tree is rewritten.
 * @returns {{ comparable: string, sourceCommit: string | null }}
 */
function comparableTree(gitDir, tree) {
  const g = (args, opts) => run('git', ['--git-dir', gitDir, ...args], opts);
  const entries = g(['ls-tree', '-z', tree]).split('\0').filter(Boolean).map((line) => {
    const tab = line.indexOf('\t');
    const [mode, type, sha] = line.slice(0, tab).split(' ');
    return { mode, type, sha, name: line.slice(tab + 1) };
  });
  const manifest = entries.find((e) => e.name === 'MANIFEST.json' && e.type === 'blob');
  let sourceCommit = null;
  try { sourceCommit = manifest ? JSON.parse(g(['cat-file', 'blob', manifest.sha]))?.source?.commit ?? null : null; } catch { sourceCommit = null; }
  if (typeof sourceCommit !== 'string' || !/^[0-9a-f]{40}$/.test(sourceCommit)) return { comparable: tree, sourceCommit: null };
  const kept = entries.filter((e) => e !== manifest).map((e) => {
    if (e.type !== 'blob' || !['NOTICE', 'README.md'].includes(e.name)) return e;
    const text = g(['cat-file', 'blob', e.sha]);
    return { ...e, sha: g(['hash-object', '-w', '--stdin'], { input: text.split(sourceCommit).join('<source-commit>') }).trim() };
  });
  const comparable = g(['mktree', '-z'], { input: kept.map((e) => `${e.mode} ${e.type} ${e.sha}\t${e.name}\0`).join('') }).trim();
  return { comparable, sourceCommit };
}

/** The git tree a directory would commit as (every file, ignore rules overridden), and its comparable tree. */
export function exportTrees(dir) {
  const gitDir = join(tmpdir(), `source-preview-tree-${process.pid}-${Date.now()}`);
  try {
    run('git', ['init', '-q', '--bare', gitDir]);
    const base = ['--git-dir', gitDir, '--work-tree', dir, '-c', 'core.autocrlf=false', '-c', 'core.fileMode=true'];
    run('git', [...base, 'add', '-A', '-f', '.']);
    const tree = run('git', [...base, 'write-tree']).trim();
    return { tree, ...comparableTree(gitDir, tree) };
  } finally {
    spawnSync('rm', ['-rf', gitDir]);
  }
}

/** The tree at `branch` of `remote` and its comparable tree, or null when the branch does not exist. */
export function remoteTrees(remote, branch = 'main') {
  const gitDir = join(tmpdir(), `source-preview-remote-${process.pid}-${Date.now()}`);
  try {
    run('git', ['init', '-q', '--bare', gitDir]);
    const heads = run('git', ['--git-dir', gitDir, 'ls-remote', remote, `refs/heads/${branch}`]).trim();
    if (!heads) return null;
    run('git', ['--git-dir', gitDir, 'fetch', '-q', '--depth', '1', remote, `refs/heads/${branch}`]);
    const tree = run('git', ['--git-dir', gitDir, 'rev-parse', 'FETCH_HEAD^{tree}']).trim();
    return { tree, ...comparableTree(gitDir, tree) };
  } finally {
    spawnSync('rm', ['-rf', gitDir]);
  }
}

/**
 * Compare the remote preview with a fresh export of `ref`.
 * @param {{ repoRoot?: string, ref?: string, remote?: string, env?: NodeJS.ProcessEnv, selectScript?: string, log?: Log }} [opts]
 */
export async function checkDrift({ repoRoot = ROOT, ref = DEFAULT_REF, remote = DEFAULT_REMOTE, env = process.env, selectScript, log = () => {} } = {}) {
  const work = await mkdtemp(join(tmpdir(), 'source-preview-check-'));
  try {
    const { out, manifest } = await exportSnapshot({ repoRoot, ref, out: join(work, 'export'), env, selectScript, log });
    const expected = exportTrees(out).comparable;
    const current = remoteTrees(remote);
    const actual = current?.comparable ?? null;
    return { inSync: expected === actual, expected, actual, commit: manifest.source.commit, previewCommit: current?.sourceCommit ?? null };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * Re-export, re-gate, and (with confirm) replace the preview with ONE commit.
 * The gate runs before anything is committed; a failing gate pushes nothing.
 * @param {{ repoRoot?: string, ref?: string, remote?: string, confirm?: boolean, env?: NodeJS.ProcessEnv, selectScript?: string, gate?: Gate, log?: Log }} [opts]
 */
export async function pushSnapshot({
  repoRoot = ROOT, ref = DEFAULT_REF, remote = DEFAULT_REMOTE, confirm = false,
  env = process.env, selectScript, gate = runGate, log = () => {},
} = {}) {
  const work = await mkdtemp(join(tmpdir(), 'source-preview-push-'));
  try {
    const { out, manifest } = await exportSnapshot({ repoRoot, ref, out: join(work, 'export'), env, selectScript, log });
    log('gating the export');
    const verdict = await gate(out, { env });
    if (!verdict.ok) return { pushed: false, reason: 'gate', verdict, commit: manifest.source.commit };
    const { tree, comparable } = exportTrees(out);
    const current = remoteTrees(remote);
    if (current?.comparable === comparable) {
      return { pushed: false, reason: 'in-sync', verdict, tree, commit: manifest.source.commit, previewCommit: current.sourceCommit };
    }
    if (!confirm) return { pushed: false, reason: 'dry-run', verdict, tree, commit: manifest.source.commit };
    const gitDir = join(work, 'repo.git');
    run('git', ['init', '-q', '--bare', gitDir]);
    const base = ['--git-dir', gitDir, '--work-tree', out, '-c', 'core.autocrlf=false', '-c', 'core.fileMode=true'];
    run('git', [...base, 'add', '-A', '-f', '.']);
    const written = run('git', [...base, 'write-tree']).trim();
    const identity = { GIT_AUTHOR_NAME: 'Papercusp', GIT_AUTHOR_EMAIL: 'source-preview@papercusp.invalid', GIT_COMMITTER_NAME: 'Papercusp', GIT_COMMITTER_EMAIL: 'source-preview@papercusp.invalid' };
    const commit = run('git', ['--git-dir', gitDir, 'commit-tree', written, '-m', `Source preview of ${SOURCE_REPO}@${manifest.source.commit.slice(0, 12)}\n\nPublic-safe source cut, gated. See MANIFEST.json and NOTICE.`], { env: { ...process.env, ...identity } }).trim();
    run('git', ['--git-dir', gitDir, 'push', '-q', '--force', remote, `${commit}:refs/heads/main`]);
    const after = remoteTrees(remote)?.tree ?? null;
    if (after !== written) throw new PreviewError(`push verification failed: remote tree ${after} ≠ ${written}`);
    return { pushed: true, verdict, tree: written, pushedCommit: commit, commit: manifest.source.commit };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = { _: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '--confirm') opts.confirm = true;
    else if (a === '--ref' || a === '--out' || a === '--remote' || a === '--json') opts[a.slice(2)] = rest[++i];
    else if (a.startsWith('--')) throw new PreviewError(`unknown flag ${a}`, 2);
    else opts._.push(a);
  }
  return { cmd, opts };
}

function printGate(verdict) {
  for (const r of verdict.results) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}: ${r.status}`);
    if (!r.ok && r.detail) console.log(r.detail.split('\n').map((l) => `      ${l}`).join('\n'));
  }
}

async function main(argv) {
  const { cmd, opts } = parseArgs(argv);
  const log = (m) => console.error(`==> ${m}`);
  loadReleaseHost();
  if (cmd === 'export') {
    const out = opts.out ?? join(ROOT, '.papercusp', 'scratch', 'source-preview', `export-${Date.now()}`);
    const { manifest } = await exportSnapshot({ ref: opts.ref ?? DEFAULT_REF, out, log });
    console.log(`exported ${manifest.fileCount} files of ${SOURCE_REPO}@${manifest.source.commit} (+${manifest.submodules.length} submodules) → ${out}`);
    return 0;
  }
  if (cmd === 'gate') {
    const dir = opts._[0];
    if (!dir) throw new PreviewError('usage: gate <dir>', 2);
    const verdict = await runGate(dir);
    printGate(verdict);
    // --json writes every finding (rule, path, line, sha256 — never the secret) for
    // reviewing new false positives into scripts/source-preview-allowlist.json.
    if (opts.json) await fs.writeFile(opts.json, `${JSON.stringify(verdict.findings ?? [], null, 2)}\n`);
    console.log(verdict.ok ? 'GATE: clean' : `GATE: refused (exit ${verdict.exitCode})`);
    return verdict.exitCode;
  }
  if (cmd === 'check') {
    const r = await checkDrift({ ref: opts.ref ?? DEFAULT_REF, remote: opts.remote ?? DEFAULT_REMOTE, log });
    console.log(r.inSync
      ? `in sync: ${PREVIEW_REPO} (snapshot of ${r.previewCommit}) ships the same content as a fresh export of ${SOURCE_REPO}@${r.commit}`
      : `DRIFT: ${PREVIEW_REPO} ${r.actual ? `(snapshot of ${r.previewCommit ?? 'unknown'})` : '(no main branch)'} differs from a fresh export of ${SOURCE_REPO}@${r.commit} — run npm run preview:push`);
    return r.inSync ? 0 : 1;
  }
  if (cmd === 'push') {
    const r = await pushSnapshot({ ref: opts.ref ?? DEFAULT_REF, remote: opts.remote ?? DEFAULT_REMOTE, confirm: Boolean(opts.confirm), log });
    printGate(r.verdict);
    if (r.reason === 'gate') { console.log('REFUSED: the gate found problems — nothing was pushed'); return r.verdict.exitCode; }
    if (r.reason === 'in-sync') { console.log(`already in sync: the preview (snapshot of ${r.previewCommit}) ships the same content as ${SOURCE_REPO}@${r.commit} — nothing to push`); return 0; }
    if (r.reason === 'dry-run') { console.log(`dry run: would replace ${PREVIEW_REPO} main with tree ${r.tree} (${SOURCE_REPO}@${r.commit}). Re-run with --confirm.`); return 0; }
    console.log(`pushed ${r.pushedCommit} (tree ${r.tree}) = ${SOURCE_REPO}@${r.commit} → ${PREVIEW_REPO}`);
    return 0;
  }
  console.error('usage: source-preview.mjs export|gate|check|push [--ref <ref>] [--out <dir>] [--remote <url>] [--confirm]');
  return 2;
}

if (isCliEntry(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
    console.error(`ERROR: ${err.message}`);
    process.exit(err instanceof PreviewError ? err.exitCode : 2);
  });
}

export { main as runCli };
