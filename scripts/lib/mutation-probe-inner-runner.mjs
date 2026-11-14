#!/usr/bin/env node
/**
 * Subject-agnostic bootstrap for a committed test-files router in a mutation
 * probe. The probe starts this small file with committed-source-loader active,
 * then this file starts test-files.mjs as a fresh child without that loader.
 * The loader therefore pins this bootstrap while the contained test process
 * can import the intentionally mutated subject from the overlay.
 *
 * Usage from the repository root:
 *   NODE_OPTIONS="--import=./scripts/lib/committed-source-loader.mjs" \
 *     node scripts/lib/mutation-probe-inner-runner.mjs scripts/test-files.mjs <test-file>
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const BOOTSTRAP_ENTRY = 'scripts/lib/mutation-probe-inner-runner.mjs';
const TEST_FILES_ENTRY = 'scripts/test-files.mjs';
const LOADER_ENTRY = 'scripts/lib/committed-source-loader.mjs';

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonical(path) {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function git(root, args, encoding = 'utf8') {
  return execFileSync('git', ['-C', root, ...args], {
    encoding,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function gitRoot(path) {
  return canonical(String(git(path, ['rev-parse', '--show-toplevel'])).trim());
}

function within(parent, child) {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function parseNodeOptions(value) {
  const tokens = [];
  let start = -1;
  let token = '';
  let quote = null;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (start < 0 && /\s/.test(char)) continue;
    if (start < 0) start = index;
    if (escaped) {
      token += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      tokens.push({ value: token, start, end: index });
      start = -1;
      token = '';
      continue;
    }
    token += char;
  }
  if (escaped || quote) throw new Error('NODE_OPTIONS is malformed; refusing an unpinned child launch');
  if (start >= 0) tokens.push({ value: token, start, end: value.length });
  return tokens;
}

function importSpecifiers(tokens) {
  const imports = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (value === '--import' && tokens[index + 1]) imports.push(tokens[index + 1].value);
    else if (value.startsWith('--import=')) imports.push(value.slice('--import='.length));
  }
  return imports;
}

function resolveModuleSpecifier(specifier, cwd) {
  try {
    if (specifier.startsWith('file:')) return canonical(fileURLToPath(specifier));
    if (specifier.startsWith('.') || isAbsolute(specifier)) return canonical(resolve(cwd, specifier));
  } catch {
    return null;
  }
  return null;
}

function stripCommittedLoader(nodeOptions, cwd, loaderPaths) {
  const tokens = parseNodeOptions(nodeOptions);
  const remove = [];
  let removed = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    let specifier = null;
    let end = token.end;
    if (token.value === '--import' && tokens[index + 1]) {
      specifier = tokens[index + 1].value;
      end = tokens[index + 1].end;
      index += 1;
    } else if (token.value.startsWith('--import=')) {
      specifier = token.value.slice('--import='.length);
    }
    if (specifier && loaderPaths.includes(resolveModuleSpecifier(specifier, cwd))) {
      remove.push([token.start, end]);
      removed = true;
    }
  }
  let cleaned = nodeOptions;
  for (const [start, end] of remove.reverse()) cleaned = cleaned.slice(0, start) + cleaned.slice(end);
  return { value: cleaned.trim(), removed };
}

function sourceNoticeRecords(path) {
  const text = readFileSync(path, 'utf8');
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function matchesPinnedLoaderNotice(records, { root, entry, pid }) {
  return records.some((record) => record?.schemaVersion === 'committed-source-notice-v1'
    && record.kind === 'substituted' && record.via === 'esm'
    && record.rel === entry && record.entry === entry && record.pid === pid
    && typeof record.top === 'string' && canonical(record.top) === root);
}

function pinnedBytes(path, entry, sourceRoot, notices, allowLoaderSubstitution) {
  const committed = git(sourceRoot, ['show', `HEAD:${entry}`], null);
  const actual = readFileSync(path);
  const committedHash = digest(committed);
  if (digest(actual) === committedHash) return { sha256: committedHash, source: 'HEAD' };
  if (allowLoaderSubstitution
    && matchesPinnedLoaderNotice(notices, { root: sourceRoot, entry, pid: process.pid })) {
    return { sha256: committedHash, source: 'committed-source-loader' };
  }
  throw new Error(`${entry} is not proven to be the committed bootstrap source`);
}

function main() {
  const env = process.env;
  if (env.PAPERCUSP_MUTATION_PROBE !== '1') throw new Error('mutation probe context is required');
  const descriptorText = env.PAPERCUSP_MUTATION_DESCRIPTOR?.trim();
  if (!descriptorText) throw new Error('immutable mutation descriptor is missing');
  const descriptor = JSON.parse(descriptorText);
  if (descriptor?.schemaVersion !== 1 || typeof descriptor.subjectPath !== 'string'
    || !descriptor.subjectPath || isAbsolute(descriptor.subjectPath) || descriptor.subjectPath.includes('\\')) {
    throw new Error('immutable mutation descriptor has no safe subject path');
  }
  const noticePath = env.PAPERCUSP_COMMITTED_SOURCE_NOTICES?.trim();
  const receiptPath = env.PAPERCUSP_TEST_RUN_RECEIPT_FILE?.trim();
  if (!noticePath || !receiptPath) throw new Error('source-notice channel or test receipt path is missing');

  const currentRoot = gitRoot(process.cwd());
  const sourceRoot = canonical(env.PAPERCUSP_MUTATION_PROBE_ORIGIN_ROOT?.trim() || currentRoot);
  const bootstrapPath = canonical(fileURLToPath(import.meta.url));
  const bootstrapRelative = relative(currentRoot, bootstrapPath).split(sep).join('/');
  if (bootstrapRelative !== BOOTSTRAP_ENTRY) throw new Error('bootstrap is outside its registered repository path');

  const args = process.argv.slice(2);
  const runnerArgument = args.shift();
  if (!runnerArgument) throw new Error('scripts/test-files.mjs and at least one test path are required');
  const runnerPath = canonical(resolve(currentRoot, runnerArgument));
  if (relative(currentRoot, runnerPath).split(sep).join('/') !== TEST_FILES_ENTRY || args.length === 0) {
    throw new Error('only the committed scripts/test-files.mjs router is supported');
  }

  const currentLoader = canonical(resolve(currentRoot, LOADER_ENTRY));
  const originLoader = canonical(resolve(sourceRoot, LOADER_ENTRY));
  const loaderPaths = [...new Set([currentLoader, originLoader])];
  const nodeOptionTokens = parseNodeOptions(env.NODE_OPTIONS ?? '');
  const execArgvTokens = parseNodeOptions(process.execArgv.join(' '));
  const loaderSpecifiers = [...importSpecifiers(nodeOptionTokens), ...importSpecifiers(execArgvTokens)];
  const activeLoaderPaths = loaderSpecifiers.map((specifier) => resolveModuleSpecifier(specifier, currentRoot));
  const loaderPath = activeLoaderPaths.find((path) => loaderPaths.includes(path));
  if (!loaderPath) throw new Error('committed-source-loader must pin the subject-agnostic bootstrap');

  const notices = sourceNoticeRecords(noticePath);
  const bootstrapPin = pinnedBytes(bootstrapPath, BOOTSTRAP_ENTRY, sourceRoot, notices, true);
  const runnerBytes = readFileSync(runnerPath);
  const committedRunnerBytes = git(sourceRoot, ['show', `HEAD:${TEST_FILES_ENTRY}`], null);
  if (digest(runnerBytes) !== digest(committedRunnerBytes)) {
    throw new Error('scripts/test-files.mjs must match HEAD before the loader-free child starts');
  }
  if (digest(readFileSync(loaderPath)) !== digest(git(sourceRoot, ['show', `HEAD:${LOADER_ENTRY}`], null))) {
    throw new Error('committed-source-loader does not match HEAD');
  }

  const subjectArgument = env.PAPERCUSP_MUTATION_PROBE_SUBJECT?.trim();
  const subjectPath = subjectArgument
    ? resolve(subjectArgument)
    : resolve(currentRoot, descriptor.subjectPath);
  if (!isAbsolute(subjectPath)) throw new Error('mutation subject path must be absolute after resolution');
  const subjectHashBefore = digest(readFileSync(subjectPath));
  const clean = stripCommittedLoader(env.NODE_OPTIONS ?? '', currentRoot, loaderPaths);
  const childEnv = { ...env };
  if (clean.value) childEnv.NODE_OPTIONS = clean.value;
  else delete childEnv.NODE_OPTIONS;

  const child = spawn(process.execPath, [runnerPath, ...args], {
    cwd: currentRoot,
    env: childEnv,
    stdio: 'inherit',
  });
  console.log('MUTATION_PROBE_INNER_RUNNER ' + JSON.stringify({
    schemaVersion: 'mutation-probe-inner-runner-v1',
    bootstrapPid: process.pid,
    childPid: child.pid ?? null,
    runner: TEST_FILES_ENTRY,
    bootstrapSource: bootstrapPin.source,
    runnerSha256: digest(committedRunnerBytes),
    subjectPath: descriptor.subjectPath,
    subjectSha256Before: subjectHashBefore,
    descriptorSha256: digest(descriptorText),
    committedLoaderRemovedFromNodeOptions: !importSpecifiers(parseNodeOptions(childEnv.NODE_OPTIONS ?? ''))
      .map((specifier) => resolveModuleSpecifier(specifier, currentRoot)).some((path) => loaderPaths.includes(path)),
    loaderOptionRemoved: clean.removed,
  }));

  const forwardSignal = (signal) => { if (child.pid) child.kill(signal); };
  process.on('SIGINT', forwardSignal);
  process.on('SIGTERM', forwardSignal);
  child.once('error', (error) => {
    console.error(`MUTATION_PROBE_INNER_RUNNER_ERROR reason=child-start-failed message=${String(error.message).slice(0, 300)}`);
    process.exitCode = 2;
  });
  child.once('exit', (code, signal) => {
    process.off('SIGINT', forwardSignal);
    process.off('SIGTERM', forwardSignal);
    let subjectHashAfter = null;
    try { subjectHashAfter = digest(readFileSync(subjectPath)); } catch { /* reported as unstable below */ }
    const subjectStable = subjectHashAfter === subjectHashBefore;
    console.log('MUTATION_PROBE_INNER_RUNNER_RESULT ' + JSON.stringify({
      schemaVersion: 'mutation-probe-inner-runner-v1',
      bootstrapPid: process.pid,
      childPid: child.pid ?? null,
      childExitCode: code,
      childSignal: signal,
      subjectSha256Before: subjectHashBefore,
      subjectSha256After: subjectHashAfter,
      subjectStable,
    }));
    if (!subjectStable) process.exitCode = 2;
    else if (signal) process.exitCode = signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 2;
    else process.exitCode = Number.isInteger(code) ? code : 2;
  });
}

main();
