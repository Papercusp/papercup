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
// NOTICE, START-HERE.md, and a drift-checked, gated, single-commit publish.
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
// Exit: 0 ok / in sync · 1 finding / drift / refused · 2 usage or cannot check.
import { spawnSync } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
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
export const ADDED_FILES = ['NOTICE', 'START-HERE.md', 'MANIFEST.json'];

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
    const known = existsSync(subRepo)
      && spawnSync('git', ['-C', subRepo, 'cat-file', '-e', `${link.sha}^{commit}`]).status === 0
      && spawnSync('git', ['-C', subRepo, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim() === subRepo;
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

export async function startHereText(dir, manifest) {
  const tops = (await fs.readdir(dir, { withFileTypes: true }))
    .filter((e) => !ADDED_FILES.includes(e.name))
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort();
  const ws = await describeWorkspaces(dir);
  const lines = [
    '# Papercusp — start here',
    '',
    'Papercusp is a desktop workspace where coding agents work alongside you, coordinated',
    'through shared plans, work items, locks and memory. This repository is a private,',
    'read-only snapshot of its source, shared for evaluation (see NOTICE).',
    '',
    `- Snapshot of \`${manifest.source.repo}\` at \`${manifest.source.commit}\`, with`,
    `  ${manifest.submodules.length} submodule(s) flattened in at their pinned commits (MANIFEST.json).`,
    '- It is the same public-safe source cut every desktop installer carries, without',
    '  `node_modules` (run `npm ci` to install dependencies from `package-lock.json`)',
    '  and without the Tauri desktop shell or git history.',
    '- It is replaced wholesale on each update: re-clone or `git fetch && git reset --hard origin/main`.',
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
 * Export one pinned commit as the public-safe cut into `out` (must not exist).
 * Deterministic for a given commit — no timestamps — so a drift check compares
 * content, not clock.
 */
export async function exportSnapshot({
  repoRoot = ROOT,
  ref = DEFAULT_REF,
  out,
  selectScript = SELECT_SCRIPT,
  selectionLib = SELECTION_LIB,
  env = process.env,
  log = () => {},
} = {}) {
  if (!out) throw new PreviewError('exportSnapshot: out is required', 2);
  if (existsSync(out)) throw new PreviewError(`refusing to overwrite existing ${out}`, 2);
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
      year: Number(git(repoRoot, ['show', '-s', '--format=%cd', '--date=format:%Y', commit]).trim()),
      source: { repo: SOURCE_REPO, ref, commit },
      submodules: shipped,
      notShipped: submodules.filter((s) => !shipped.includes(s)).map((s) => s.path),
      fileCount: files.length,
      generatedBy: 'scripts/source-preview.mjs',
    };
    await fs.writeFile(join(partial, 'NOTICE'), noticeText(manifest));
    await fs.writeFile(join(partial, 'START-HERE.md'), await startHereText(partial, manifest));
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
 * @returns {{ ok: boolean, exitCode: number, results: { name: string, ok: boolean, status: string, detail: string }[] }}
 */
export async function runGate(dir, { env = process.env, auditScript = AUDIT_SCRIPT } = {}) {
  const results = [];
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
    // 3. gitleaks, default rules, redacted report.
    const report = join(work, 'gitleaks.json');
    const g = spawnSync(tools.gitleaks, ['dir', dir, '--no-banner', '--redact', '--exit-code', '1', '--report-format', 'json', '--report-path', report], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
    let gDetail = `${g.stdout}\n${g.stderr}`;
    if (g.status === 1 && existsSync(report)) {
      try {
        const found = JSON.parse(await fs.readFile(report, 'utf8'));
        gDetail = found.slice(0, 50).map((f) => `${f.RuleID}  ${f.File}:${f.StartLine}`).join('\n') + (found.length > 50 ? `\n… ${found.length - 50} more` : '');
      } catch { /* keep raw output */ }
    }
    record('gitleaks', g.status === 0 ? 'clean' : g.status === 1 ? 'finding' : 'cannot-check', gDetail);
    // 4. trufflehog, detection only: --no-verification, because verifying would send
    //    each candidate secret to its provider's API.
    const t = spawnSync(tools.trufflehog, ['filesystem', dir, '--no-update', '--no-verification', '--json', '--fail'], { encoding: 'utf8', env, maxBuffer: 256 * 1024 * 1024 });
    let tDetail = t.stderr;
    if (t.status === 183) {
      tDetail = t.stdout.split('\n').filter(Boolean).slice(0, 50).map((l) => {
        try {
          const j = JSON.parse(l);
          return `${j.DetectorName}  ${j.SourceMetadata?.Data?.Filesystem?.file ?? '?'}:${j.SourceMetadata?.Data?.Filesystem?.line ?? '?'}`;
        } catch { return l.slice(0, 200); }
      }).join('\n');
    }
    record('trufflehog', t.status === 0 ? 'clean' : t.status === 183 ? 'finding' : 'cannot-check', tDetail);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  const ok = results.every((r) => r.ok);
  const exitCode = ok ? 0 : results.some((r) => r.status === 'finding') ? 1 : 2;
  return { ok, exitCode, results };
}

/** The git tree SHA a directory would commit as (every file, ignore rules overridden). */
export function treeShaOf(dir) {
  const gitDir = join(tmpdir(), `source-preview-tree-${process.pid}-${Date.now()}`);
  try {
    run('git', ['init', '-q', '--bare', gitDir]);
    const base = ['--git-dir', gitDir, '--work-tree', dir, '-c', 'core.autocrlf=false', '-c', 'core.fileMode=true'];
    run('git', [...base, 'add', '-A', '-f', '.']);
    return run('git', [...base, 'write-tree']).trim();
  } finally {
    spawnSync('rm', ['-rf', gitDir]);
  }
}

/** The tree SHA at `branch` of `remote`, or null when the branch does not exist. */
export function remoteTreeSha(remote, branch = 'main') {
  const gitDir = join(tmpdir(), `source-preview-remote-${process.pid}-${Date.now()}`);
  try {
    run('git', ['init', '-q', '--bare', gitDir]);
    const heads = run('git', ['--git-dir', gitDir, 'ls-remote', remote, `refs/heads/${branch}`]).trim();
    if (!heads) return null;
    run('git', ['--git-dir', gitDir, 'fetch', '-q', '--depth', '1', remote, `refs/heads/${branch}`]);
    return run('git', ['--git-dir', gitDir, 'rev-parse', 'FETCH_HEAD^{tree}']).trim();
  } finally {
    spawnSync('rm', ['-rf', gitDir]);
  }
}

/** Compare the remote preview with a fresh export of `ref`. */
export async function checkDrift({ repoRoot = ROOT, ref = DEFAULT_REF, remote = DEFAULT_REMOTE, env = process.env, selectScript, log = () => {} } = {}) {
  const work = await mkdtemp(join(tmpdir(), 'source-preview-check-'));
  try {
    const { out, manifest } = await exportSnapshot({ repoRoot, ref, out: join(work, 'export'), env, selectScript, log });
    const expected = treeShaOf(out);
    const actual = remoteTreeSha(remote);
    return { inSync: expected === actual, expected, actual, commit: manifest.source.commit };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * Re-export, re-gate, and (with confirm) replace the preview with ONE commit.
 * The gate runs before anything is committed; a failing gate pushes nothing.
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
    const tree = treeShaOf(out);
    const current = remoteTreeSha(remote);
    if (current === tree) return { pushed: false, reason: 'in-sync', verdict, tree, commit: manifest.source.commit };
    if (!confirm) return { pushed: false, reason: 'dry-run', verdict, tree, commit: manifest.source.commit };
    const gitDir = join(work, 'repo.git');
    run('git', ['init', '-q', '--bare', gitDir]);
    const base = ['--git-dir', gitDir, '--work-tree', out, '-c', 'core.autocrlf=false', '-c', 'core.fileMode=true'];
    run('git', [...base, 'add', '-A', '-f', '.']);
    const written = run('git', [...base, 'write-tree']).trim();
    const identity = { GIT_AUTHOR_NAME: 'Papercusp', GIT_AUTHOR_EMAIL: 'source-preview@papercusp.invalid', GIT_COMMITTER_NAME: 'Papercusp', GIT_COMMITTER_EMAIL: 'source-preview@papercusp.invalid' };
    const commit = run('git', ['--git-dir', gitDir, 'commit-tree', written, '-m', `Source preview of ${SOURCE_REPO}@${manifest.source.commit.slice(0, 12)}\n\nPublic-safe source cut, gated. See MANIFEST.json and NOTICE.`], { env: { ...process.env, ...identity } }).trim();
    run('git', ['--git-dir', gitDir, 'push', '-q', '--force', remote, `${commit}:refs/heads/main`]);
    const after = remoteTreeSha(remote);
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
    else if (a === '--ref' || a === '--out' || a === '--remote') opts[a.slice(2)] = rest[++i];
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
    console.log(verdict.ok ? 'GATE: clean' : `GATE: refused (exit ${verdict.exitCode})`);
    return verdict.exitCode;
  }
  if (cmd === 'check') {
    const r = await checkDrift({ ref: opts.ref ?? DEFAULT_REF, remote: opts.remote ?? DEFAULT_REMOTE, log });
    console.log(r.inSync
      ? `in sync: ${PREVIEW_REPO} matches ${SOURCE_REPO}@${r.commit} (tree ${r.expected})`
      : `DRIFT: ${PREVIEW_REPO} tree ${r.actual ?? '(no main branch)'} ≠ fresh export of ${r.commit} (tree ${r.expected}) — run npm run preview:push`);
    return r.inSync ? 0 : 1;
  }
  if (cmd === 'push') {
    const r = await pushSnapshot({ ref: opts.ref ?? DEFAULT_REF, remote: opts.remote ?? DEFAULT_REMOTE, confirm: Boolean(opts.confirm), log });
    printGate(r.verdict);
    if (r.reason === 'gate') { console.log('REFUSED: the gate found problems — nothing was pushed'); return r.verdict.exitCode; }
    if (r.reason === 'in-sync') { console.log(`already in sync with ${SOURCE_REPO}@${r.commit} — nothing to push`); return 0; }
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
