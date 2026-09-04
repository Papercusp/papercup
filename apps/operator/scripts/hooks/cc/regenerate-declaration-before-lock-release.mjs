#!/usr/bin/env node
/**
 * Collapse the generated-declaration staleness window while an edit lock is held.
 *
 * The lock hooks pass either their native PostToolUse payload or an exact
 * (repo root, path[]) pair. This helper keeps path discovery, enrollment checks,
 * and generator invocation identical across Claude, Codex, and OMP. It is a
 * no-op unless an edited path is one of tsconfig.declarations.json's explicit
 * `.mjs` inputs. A real generator failure exits non-zero so the caller can record
 * it, but callers always continue to release the lock.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

const CONFIG = 'tsconfig.declarations.json';
const GENERATOR = join('scripts', 'gen-declarations.ts');
const EDIT_TOOLS = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'apply_patch',
  'write_file',
  'edit_file',
]);

function validRepoRoot(root) {
  return existsSync(join(root, CONFIG)) && existsSync(join(root, GENERATOR));
}

function findRepoRoot(filePath) {
  let dir = resolve(filePath);
  try {
    if (!statSync(dir).isDirectory()) dir = dirname(dir);
  } catch {
    dir = dirname(dir);
  }
  for (;;) {
    if (validRepoRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function patchPaths(value) {
  const source =
    typeof value === 'string'
      ? value
      : value && typeof value === 'object'
        ? Object.values(value).find((entry) => typeof entry === 'string' && entry.includes('*** ')) ?? ''
        : '';
  const paths = [];
  for (const match of source.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
    paths.push(match[1].trim());
  }
  for (const match of source.matchAll(/^\*\*\* Move to: (.+)$/gm)) paths.push(match[1].trim());
  return paths;
}

function hookPaths(payload) {
  const tool = payload?.tool_name ?? '';
  const input = payload?.tool_input;
  if (!EDIT_TOOLS.has(tool)) return [];
  if (tool === 'apply_patch') return patchPaths(input);
  if (!input || typeof input !== 'object') return [];
  if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
    return input.edits
      .map((edit) => edit?.file_path ?? edit?.path)
      .filter((path) => typeof path === 'string' && path.length > 0);
  }
  const path = input.file_path ?? input.filePath ?? input.path;
  return typeof path === 'string' && path.length > 0 ? [path] : [];
}

function resultSucceeded(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const text = value.trim();
    return text.length > 0 && !/^(?:error|failed|failure|denied|permission denied)\b/i.test(text);
  }
  if (Array.isArray(value)) return value.length > 0 && value.every(resultSucceeded);
  if (typeof value !== 'object') return false;
  if (value.is_error === true || value.isError === true || value.ok === false || value.success === false) {
    return false;
  }
  if (value.error) return false;
  const status = typeof value.status === 'string' ? value.status.toLowerCase() : '';
  if (['error', 'failed', 'failure', 'denied'].includes(status)) return false;
  if (
    value.ok === true ||
    value.success === true ||
    value.is_error === false ||
    value.isError === false ||
    ['ok', 'success', 'succeeded', 'completed', 'applied'].includes(status)
  ) {
    return true;
  }
  for (const key of [
    'content', 'result', 'output', 'message', 'filePath', 'file_path',
    'structuredPatch', 'oldString', 'newString', 'path',
  ]) {
    const entry = value[key];
    if (entry !== undefined && entry !== null && entry !== '' && (!Array.isArray(entry) || entry.length > 0)) {
      return true;
    }
  }
  return (value.type === 'text' || value.type === 'tool_result') && Boolean(value.text);
}

function enrolledInputs(repoRoot) {
  const raw = readFileSync(join(repoRoot, CONFIG), 'utf8');
  const parsed = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
  if (!Array.isArray(parsed.files)) return [];
  return parsed.files.filter((path) => typeof path === 'string' && path.endsWith('.mjs'));
}

function selectedInputs(repoRoot, paths) {
  const wanted = new Set(
    paths.map((path) => relative(repoRoot, resolve(repoRoot, path)).split(sep).join('/')),
  );
  return enrolledInputs(repoRoot).filter((path) =>
    wanted.has(relative(repoRoot, resolve(repoRoot, path)).split(sep).join('/')),
  );
}

function groupByRepo(paths, cwd) {
  const groups = new Map();
  for (const path of paths) {
    if (typeof path !== 'string' || path.length === 0) continue;
    const absolute = isAbsolute(path) ? path : resolve(cwd, path);
    const root = findRepoRoot(absolute);
    if (!root) continue;
    const list = groups.get(root) ?? [];
    list.push(absolute);
    groups.set(root, list);
  }
  return groups;
}

function runGenerator(repoRoot, inputs) {
  if (inputs.length === 0) return;
  execFileSync(
    'npm',
    ['run', '--silent', 'gen:declarations', '--', `--files=${inputs.join(',')}`],
    { cwd: repoRoot, stdio: 'ignore', timeout: 120_000 },
  );
}

export function regenerateForPaths(repoRoot, paths) {
  const root = resolve(repoRoot);
  if (!validRepoRoot(root)) return 0;
  const selected = selectedInputs(root, paths);
  runGenerator(root, selected);
  return selected.length;
}

export function regenerateForHookPayload(payload) {
  const tool = payload?.tool_name ?? '';
  const response = payload?.tool_response ?? payload?.toolResponse;
  if (!EDIT_TOOLS.has(tool) || !resultSucceeded(response)) return 0;
  const cwd = typeof payload?.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
  let count = 0;
  for (const [root, paths] of groupByRepo(hookPaths(payload), cwd)) {
    count += regenerateForPaths(root, paths);
  }
  return count;
}

function args(argv) {
  const out = { repoRoot: null, paths: [], hookPayload: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--hook-payload') out.hookPayload = true;
    else if (argv[i] === '--repo-root') out.repoRoot = argv[++i] ?? null;
    else if (argv[i] === '--path') out.paths.push(argv[++i] ?? '');
  }
  return out;
}

async function main() {
  const parsed = args(process.argv.slice(2));
  if (parsed.hookPayload) {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    try {
      regenerateForHookPayload(JSON.parse(raw || '{}'));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
    return;
  }
  if (!parsed.repoRoot) return;
  try {
    regenerateForPaths(parsed.repoRoot, parsed.paths);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && basename(process.argv[1]) === 'regenerate-declaration-before-lock-release.mjs') {
  await main();
}
