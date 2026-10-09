/**
 * Guarded local scratch checkout shared by capability:git and source verification.
 * Only Node builtins belong here: importing a CLI helper must not register tools
 * or pull the operator compiler graph. The capability supplies its sandbox runner.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export type ScratchGitRunner = (argv: string[], cwd: string, signal: AbortSignal) =>
  Promise<{ code: number | null; output: string }>;

/** Standalone local-only runner: bounded, no shell, no inherited credentials. */
function runLocalGit(argv: string[], cwd: string, signal: AbortSignal):
Promise<{ code: number | null; output: string }> {
  return new Promise(resolvePromise => {
    execFile('git', argv, {
      cwd, signal, timeout: 60_000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8',
      env: { PATH: process.env.PATH, LANG: 'C.UTF-8',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
    }, (error, stdout, stderr) => {
      resolvePromise({ code: error ? (typeof error.code === 'number' ? error.code : null) : 0,
        output: stdout + stderr + (error ? '\n' + error.message : '') });
    });
  });
}

export interface ScratchCloneResult {
  path: string;
  source: string;
  requestedRef: string;
  sha: string;
  submodules: number;
  borrowedRepositories: number;
}

export interface ScratchCloneOptions {
  source: string;
  ref?: string;
  destination?: string;
  includeSubmodules?: boolean;
  signal?: AbortSignal;
  runGit?: ScratchGitRunner;
}

interface ScratchCloneContext {
  signal: AbortSignal;
  submodules: number;
  runGit: ScratchGitRunner;
}

interface ScratchSubmodule {
  path: string;
}

const MAX_SCRATCH_SUBMODULES = 256;
const MAX_SCRATCH_SUBMODULE_DEPTH = 8;

function strictlyWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function parseScratchGitmodules(text: string): ScratchSubmodule[] {
  const out: ScratchSubmodule[] = [];
  let current: ScratchSubmodule | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (/^\[submodule\s+"[^"]+"\]$/.test(line)) {
      current = { path: '' };
      out.push(current);
      continue;
    }
    if (!current || line.startsWith('#') || line.startsWith(';')) continue;
    const match = /^path\s*=\s*(.*)$/.exec(line);
    if (match) current.path = match[1].trim();
  }
  return out.filter((entry) => entry.path.length > 0);
}

function scratchError(label: string, output: string): Error {
  const detail = output.trim();
  return new Error(`${label}${detail ? `: ${detail}` : ''}`);
}

async function gitStep(
  argv: string[],
  cwd: string,
  ctx: ScratchCloneContext,
  label: string,
): Promise<string> {
  const result = await ctx.runGit(argv, cwd, ctx.signal);
  if (result.code !== 0) throw scratchError(label, result.output);
  return result.output.trim();
}

async function localRepositoryRoot(path: string, ctx: ScratchCloneContext, label: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute local path.`);
  let canonical: string;
  try {
    canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) throw new Error('not a directory');
  } catch (error) {
    throw new Error(`${label} is not an existing local directory: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = await gitStep(['rev-parse', '--show-toplevel'], canonical, ctx, `${label} is not a Git working tree`);
  const canonicalRoot = await realpath(root);
  if (!isAbsolute(canonicalRoot)) throw new Error(`${label} resolved to a non-absolute Git root.`);
  return canonicalRoot;
}

async function createOwnedTempDestination(requested?: string): Promise<string> {
  const tempRoot = await realpath(tmpdir());
  if (!requested) return mkdtemp(join(tempRoot, 'papercusp-git-scratch-'));
  if (!isAbsolute(requested)) throw new Error('scratchClone.destination must be absolute.');

  const parent = await realpath(dirname(requested));
  const destination = resolve(parent, basename(requested));
  if (!strictlyWithin(tempRoot, destination)) {
    throw new Error(`scratchClone.destination must be below the OS temp directory (${tempRoot}).`);
  }
  try {
    // Atomic ownership boundary: cleanup is allowed only after THIS mkdir succeeds.
    // An existing path (including a symlink) is never entered, modified, or removed.
    await mkdir(destination, { mode: 0o700 });
  } catch (error) {
    throw new Error(`scratchClone.destination must not already exist: ${error instanceof Error ? error.message : String(error)}`);
  }
  return destination;
}

async function verifyBorrowedObjects(destination: string): Promise<void> {
  const alternates = await readFile(join(destination, '.git', 'objects', 'info', 'alternates'), 'utf8').catch(() => '');
  if (!alternates.trim()) {
    throw new Error(`git clone did not create an object-store alternate for ${destination}; refusing a clone that may have copied its pack.`);
  }
}

async function materialiseLocalSubmodules(
  sourceRoot: string,
  destinationRoot: string,
  parentSha: string,
  ctx: ScratchCloneContext,
  depth: number,
): Promise<void> {
  const gitmodules = await readFile(join(destinationRoot, '.gitmodules'), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const declared = new Set(parseScratchGitmodules(gitmodules).map(entry => entry.path));
  // Gitlinks are commit objects whether or not .gitmodules names them. The
  // source exporter already exports this exact tree population.
  const tree = await gitStep(['ls-tree', '-r', '-z', parentSha], sourceRoot, ctx,
    'cannot enumerate exact local submodule pins');
  const entries = tree.split('\0').flatMap(row => {
    const tab = row.indexOf('\t');
    if (tab < 0) return [];
    const [mode, type, pin] = row.slice(0, tab).split(' ');
    return mode === '160000' && type === 'commit' ? [{ path: row.slice(tab + 1), pin }] : [];
  });
  for (const path of declared) {
    if (!entries.some(entry => entry.path === path)) {
      throw new Error('cannot resolve submodule pin for declared path ' + path);
    }
  }
  if (entries.length === 0) return;
  if (depth >= MAX_SCRATCH_SUBMODULE_DEPTH) {
    throw new Error(`scratchClone submodule nesting exceeds the safe depth limit (${MAX_SCRATCH_SUBMODULE_DEPTH}).`);
  }
  if (ctx.submodules + entries.length > MAX_SCRATCH_SUBMODULES) {
    throw new Error(`scratchClone submodule count exceeds the safe limit (${MAX_SCRATCH_SUBMODULES}).`);
  }

  // Preflight the whole level before cloning any child. A partial submodule tree
  // can make a test/lint produce a confident false answer, so there is no network
  // fallback and no "best effort" branch here.
  const ready: Array<{ source: string; destination: string; pin: string; path: string }> = [];
  for (const entry of entries) {
    if (isAbsolute(entry.path) || entry.path.split(/[\\/]+/).includes('..')) {
      throw new Error(`scratchClone refuses unsafe submodule path: ${entry.path}`);
    }
    const sourceCandidate = resolve(sourceRoot, entry.path);
    const destination = resolve(destinationRoot, entry.path);
    if (!strictlyWithin(sourceRoot, sourceCandidate) || !strictlyWithin(destinationRoot, destination)) {
      throw new Error(`scratchClone submodule path escapes its repository: ${entry.path}`);
    }
    const source = await localRepositoryRoot(sourceCandidate, ctx, `local submodule ${entry.path}`);
    if (source !== await realpath(sourceCandidate)) {
      throw new Error(`local submodule ${entry.path} is not checked out at its declared path.`);
    }
    const pin = entry.pin;
    await gitStep(
      ['rev-parse', '--verify', '--end-of-options', `${pin}^{commit}`],
      source,
      ctx,
      `local submodule ${entry.path} does not contain pinned commit ${pin}`,
    );
    ready.push({ source, destination, pin, path: entry.path });
  }

  ctx.submodules += ready.length;
  for (const child of ready) {
    // Checkout materialises a gitlink as an empty directory. It is inside the
    // root directory this tool atomically created, so replacing it is safe.
    await rm(child.destination, { recursive: true, force: true });
    await gitStep(
      ['clone', '--local', '--shared', '--no-checkout', '--quiet', '--', child.source, child.destination],
      destinationRoot,
      ctx,
      `failed to clone local submodule ${child.path}`,
    );
    await verifyBorrowedObjects(child.destination);
    await gitStep(
      ['-c', 'advice.detachedHead=false', 'checkout', '--detach', '--quiet', child.pin],
      child.destination,
      ctx,
      `failed to check out local submodule ${child.path} at ${child.pin}`,
    );
    await gitStep(['remote', 'remove', 'origin'], child.destination, ctx, `failed to remove origin from submodule ${child.path}`);
    await materialiseLocalSubmodules(child.source, child.destination, child.pin, ctx, depth + 1);
  }
  // Local clones contain each gitlink's bytes, but Git only recurses into an
  // active submodule. Register the existing local checkouts without fetching.
  const mapped = ready.filter(child => declared.has(child.path));
  if (mapped.length) await gitStep(['submodule', 'init', '--', ...mapped.map(child => child.path)],
    destinationRoot, ctx, 'failed to initialize local submodule index semantics');
}

/**
 * Create a disposable, exact-ref local clone without copying the source pack.
 *
 * This is the guarded counterpart to ad-hoc agent shell clones (WI-38848). It
 * deliberately reuses the real-Git recipe proven by lint-as-committed:
 * `clone --local --shared --no-checkout` followed by detached checkout. Every
 * destination is atomically created by this function, so the failure cleanup
 * can never delete a caller/peer-owned directory.
 */
export async function createScratchClone(options: ScratchCloneOptions): Promise<ScratchCloneResult> {
  const ctx: ScratchCloneContext = {
    signal: options.signal ?? new AbortController().signal,
    submodules: 0,
    runGit: options.runGit ?? runLocalGit,
  };
  const source = await localRepositoryRoot(options.source, ctx, 'scratchClone.source');
  const requestedRef = options.ref ?? 'HEAD';
  const sha = await gitStep(
    ['rev-parse', '--verify', '--end-of-options', `${requestedRef}^{commit}`],
    source,
    ctx,
    `scratchClone.ref does not resolve to a commit (${requestedRef})`,
  );

  const destination = await createOwnedTempDestination(options.destination);
  if (strictlyWithin(source, destination) || strictlyWithin(destination, source) || source === destination) {
    await rm(destination, { recursive: true, force: true });
    throw new Error('scratchClone source and destination must not contain one another.');
  }

  let complete = false;
  try {
    await gitStep(
      ['clone', '--local', '--shared', '--no-checkout', '--quiet', '--', source, destination],
      dirname(destination),
      ctx,
      'scratchClone failed to borrow the source repository',
    );
    await verifyBorrowedObjects(destination);
    await gitStep(
      ['-c', 'advice.detachedHead=false', 'checkout', '--detach', '--quiet', sha],
      destination,
      ctx,
      `scratchClone failed to check out ${sha}`,
    );
    await gitStep(['remote', 'remove', 'origin'], destination, ctx, 'scratchClone failed to remove origin');
    if (options.includeSubmodules !== false) {
      await materialiseLocalSubmodules(source, destination, sha, ctx, 0);
    }
    complete = true;
    return {
      path: destination,
      source,
      requestedRef,
      sha,
      submodules: ctx.submodules,
      borrowedRepositories: 1 + ctx.submodules,
    };
  } finally {
    if (!complete) await rm(destination, { recursive: true, force: true });
  }
}
