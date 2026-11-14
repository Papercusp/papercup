#!/usr/bin/env node
// Dependency-free verifier source checks. The committed native verifier runs
// these against a source-only checkout before its private dependency snapshot
// exists, so this entrypoint and its relative CLI guard use only Node built-ins.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { isCliEntry } from '../packages/operator-core/lib/util/cli-entry.ts';

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
  'scripts/verifier-source-preflight.mjs',
  'packages/operator-core/lib/util/cli-entry.ts',
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

const REBUILT_OUTPUTS = [
  'apps/operator/dist-verify',
  'papercusp-desktop/src-tauri/resources/workbench@papercusp.ai.shell-extension.zip',
  'papercusp-desktop/src-tauri/resources/workbench-install.js',
];

class PreflightError extends Error {
  constructor(message) {
    super(message);
    this.exitCode = 2;
  }
}

function git(repo, args) {
  const rootArgs = args[0] === 'ls-tree' && !args.includes('--full-tree')
    ? [args[0], '--full-tree', ...args.slice(1)] : args;
  try {
    return execFileSync('git', ['-C', repo, ...rootArgs], {
      encoding: 'utf8', maxBuffer: 128 * 1024 * 1024,
    });
  } catch (error) {
    const stderr = error?.stderr?.toString().trim();
    throw new PreflightError(stderr || error?.message || String(error));
  }
}

function gitSucceeds(repo, args) {
  return spawnSync('git', ['-C', repo, ...args], { stdio: 'ignore' }).status === 0;
}

function resolveCommit(repo, ref) {
  return git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim();
}

function treeForCommit(repo, sha, trees) {
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
  return trees.get(key);
}

function materializedSubmodule(repo, link, fullPath) {
  const subRepo = join(repo, link.path);
  let known = false;
  if (existsSync(subRepo)) {
    try {
      known = git(subRepo, ['rev-parse', '--show-toplevel']).trim() === realpathSync(subRepo)
        && gitSucceeds(subRepo, ['cat-file', '-e', `${link.sha}^{commit}`]);
    } catch {
      known = false;
    }
  }
  if (!known) {
    throw new PreflightError(
      `unresolvable gitlink ${fullPath} @ ${link.sha} — its commit is not present in ${subRepo}; run \`git submodule update --init\` or fetch it, then retry`,
    );
  }
  return subRepo;
}

function committedInputBlob(repo, sha, path, trees) {
  const { entries, links } = treeForCommit(repo, sha, trees);
  const link = links.find((entry) => path.startsWith(`${entry.path}/`));
  if (link) {
    return committedInputBlob(materializedSubmodule(repo, link, link.path),
      link.sha, path.slice(link.path.length + 1), trees);
  }
  const [mode, type, blob] = entries.get(path) ?? [];
  if (type !== 'blob' || !['100644', '100755'].includes(mode)) {
    throw new PreflightError(`tested input is not a regular committed file: ${path}`);
  }
  return blob;
}

export async function normalizeVerifierInputs({ inputs = [], inputsFile, tauriInputs = false } = {}) {
  if (inputsFile !== undefined) {
    const listed = JSON.parse(await readFile(inputsFile, 'utf8'));
    if (!Array.isArray(listed) || !listed.length || listed.some((path) => typeof path !== 'string')) {
      throw new PreflightError('verification inputs file must contain a non-empty JSON array of paths');
    }
    inputs = [...inputs, ...listed];
  }
  if (!inputs.length) throw new PreflightError('verification export needs explicit tested inputs');
  if (tauriInputs) inputs = [...inputs, ...TAURI_VERIFIER_INPUTS];
  const paths = [...new Set(inputs)].sort();
  for (const path of paths) {
    if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\0')
      || path.split('/').some((part) => part === '..' || part === '.' || !part)) {
      throw new PreflightError(`invalid tested input: ${path}`);
    }
    if (REBUILT_OUTPUTS.some((output) => path === output || path.startsWith(output + '/'))) {
      throw new PreflightError(`generated verifier runtime output cannot be a tested source input: ${path}`);
    }
  }
  return paths;
}

export async function validateCommittedVerifierInputs({ repo, ref, paths }) {
  const sha = resolveCommit(repo, ref);
  const trees = new Map();
  for (const path of paths) {
    const live = join(repo, path);
    if (!(await lstat(live)).isFile()) {
      throw new PreflightError(`tested input is not a regular file: ${path}`);
    }
    const blob = committedInputBlob(repo, sha, path, trees);
    const bytes = await readFile(live);
    const digest = createHash(blob.length === 64 ? 'sha256' : 'sha1')
      .update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (digest !== blob) throw new PreflightError(`dirty tested-input mismatch: ${path}`);
  }
  return { sha, paths };
}

export async function validateVerifierInputsFromGit(options) {
  const paths = await normalizeVerifierInputs(options);
  return validateCommittedVerifierInputs({ repo: options.repo, ref: options.ref, paths });
}

function listGitlinks(repo, sha) {
  const links = [];
  for (const entry of git(repo, ['ls-tree', '-r', '-z', sha]).split('\0')) {
    if (!entry) continue;
    const tab = entry.indexOf('\t');
    const [mode, type, object] = entry.slice(0, tab).split(' ');
    if (mode === '160000' && type === 'commit') links.push({ path: entry.slice(tab + 1), sha: object });
  }
  return links;
}

function measureCommittedTree(repo, sha, prefix = '') {
  let bytes = 0;
  for (const entry of git(repo, ['ls-tree', '-r', '-z', '-l', sha]).split('\0')) {
    if (!entry) continue;
    const fields = entry.slice(0, entry.indexOf('\t')).trim().split(/\s+/);
    if (fields[1] !== 'blob') continue;
    const size = Number(fields[3]);
    if (!Number.isSafeInteger(size) || size < 0) throw new PreflightError('cannot measure committed source bytes');
    bytes += Math.ceil(size / 4096) * 4096;
  }
  for (const link of listGitlinks(repo, sha)) {
    const fullPath = prefix ? `${prefix}/${link.path}` : link.path;
    bytes += measureCommittedTree(materializedSubmodule(repo, link, fullPath), link.sha, fullPath);
  }
  if (!Number.isSafeInteger(bytes)) throw new PreflightError('committed source size exceeds safe integer range');
  return bytes;
}

export function measureVerifierSourceBytesFromGit({ repo, ref }) {
  return measureCommittedTree(repo, resolveCommit(repo, ref));
}

function parseCliOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--tauri-inputs') {
      options.tauriInputs = true;
      continue;
    }
    if (!['--repo', '--ref', '--inputs', '--inputs-file'].includes(arg) || args[index + 1] === undefined) {
      throw new PreflightError(`unknown or incomplete verifier preflight option: ${arg}`);
    }
    options[arg.slice(2)] = args[++index];
  }
  return options;
}

async function main(argv) {
  const [command, ...args] = argv;
  const options = parseCliOptions(args);
  if (command === 'verifier-inputs-check') {
    if (!options.repo || !options.ref || !(options.inputs || options['inputs-file'])) {
      throw new PreflightError('verifier input check requires --repo, --ref and --inputs or --inputs-file');
    }
    const result = await validateVerifierInputsFromGit({
      repo: options.repo,
      ref: options.ref,
      inputs: options.inputs?.split(',').filter(Boolean) ?? [],
      inputsFile: options['inputs-file'],
      tauriInputs: options.tauriInputs === true,
    });
    console.log(JSON.stringify(result));
    return 0;
  }
  if (command === 'verifier-measure') {
    if (!options.repo || !options.ref) throw new PreflightError('verifier measurement requires explicit --repo and --ref');
    console.log(measureVerifierSourceBytesFromGit({ repo: options.repo, ref: options.ref }));
    return 0;
  }
  throw new PreflightError('usage: verifier-source-preflight.mjs verifier-inputs-check|verifier-measure [options]');
}

// A relative import keeps the source-only entry independent of node_modules.
if (isCliEntry(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }, (error) => {
    console.error(`ERROR: ${error?.message ?? String(error)}`);
    process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 2;
  });
}
