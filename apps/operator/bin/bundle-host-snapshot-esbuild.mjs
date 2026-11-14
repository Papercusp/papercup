/**
 * Frozen-source compile for a snapshot-labelled bundle (WI-6554700010048234).
 *
 * bundle_host_snapshot_commit names the working tree with a content-addressed
 * commit, but the esbuild CLI then reads the LIVE shared tree for minutes while
 * peers keep editing it. The post-build fence (bundle-host-snapshot-fence.ts)
 * can only REFUSE such a bundle, and on a busy tree every retry loses the same
 * race (2026-11-14: three attempts exhausted by peers' scratch-gc.ts and
 * p2p/microcharge.ts edits). This helper removes the race instead of detecting
 * it: it runs the SAME pinned esbuild through its JS API with one onLoad plugin
 * that serves every path tracked in the snapshot commit (descending through
 * submodule gitlinks) from that commit's blobs. Untracked/ignored paths and
 * node_modules keep the normal filesystem read, exactly as for a clean HEAD
 * build. The bundle therefore equals the label by construction, and the fence
 * becomes a confirmation over the served-input receipt this writes.
 *
 * Not frozen (resolver metadata esbuild reads natively, never through onLoad):
 * tsconfig.json and package.json files. They change rarely; the fence still
 * checks every metafile input.
 *
 * CLI, called by bundle_host_esbuild under the pinned compiler's cache lease:
 *   node bundle-host-snapshot-esbuild.mjs <repo root> <compiler binary> <required version>
 *     <snapshot sha> <served receipt | -> -- <esbuild CLI args...>
 * The esbuild args are the maintained recipe, translated by the same
 * compilerOptionsFromArgs the BG compiler uses (an off-recipe switch refuses).
 * Exit 0 = built · 1 = compile failed (esbuild diagnostics above) · 78 = toolchain
 * or configuration refusal (wrong compiler, unknown snapshot, off-recipe switch).
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, relative, sep } from 'node:path';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import { compilerOptionsFromArgs } from '../../../scripts/lib/compiler-input-custody.mjs';

export const SNAPSHOT_COMPILE_EXIT_REFUSED = 78;

/** esbuild's default loaders. A plugin that returns contents must name the
 * loader (esbuild defaults it to js), and the recipe passes no --loader. */
const DEFAULT_LOADERS = Object.freeze({
  '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'jsx',
  '.ts': 'ts', '.mts': 'ts', '.cts': 'ts', '.tsx': 'tsx',
  '.json': 'json', '.css': 'css', '.txt': 'text',
});

class RefusedError extends Error {}

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args],
  { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, timeout: 120_000 });

/** Map every regular file tracked in <commit> (and in the commits its
 * initialized submodule gitlinks pin) from its absolute path to its blob. */
export function snapshotBlobIndex(root, commit) {
  const index = new Map();
  const visit = (dir, rev) => {
    for (const entry of git(dir, ['ls-tree', '-r', '-z', '--full-tree', rev]).split('\0')) {
      if (!entry) continue;
      const tab = entry.indexOf('\t');
      const [mode, type, sha] = entry.slice(0, tab).split(' ');
      const path = join(dir, entry.slice(tab + 1));
      // An uninitialized submodule has no bytes on disk for esbuild to reach.
      if (type === 'commit') { if (existsSync(join(path, '.git'))) visit(path, sha); continue; }
      // esbuild loads a symlink's real target, never the link path itself.
      if (type === 'blob' && mode !== '120000') index.set(path, { repo: dir, blob: sha });
    }
  };
  let rev;
  try { rev = git(root, ['rev-parse', '--verify', `${commit}^{commit}`]).trim(); } catch {
    throw new RefusedError(`snapshot ${commit} is not a commit in ${root}`);
  }
  visit(root, rev);
  return index;
}

/** One `git cat-file --batch` per repository; replies arrive in request order. */
class BlobReader {
  constructor(repo) {
    this.pending = [];
    this.buffer = Buffer.alloc(0);
    this.child = spawn('git', ['-C', repo, 'cat-file', '--batch'], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.child.stdout.on('data', chunk => { this.buffer = Buffer.concat([this.buffer, chunk]); this.drain(); });
    const fail = reason => { for (const request of this.pending.splice(0)) request.reject(new Error(reason)); };
    this.child.on('error', error => fail(`git cat-file failed in ${repo}: ${error.message}`));
    this.child.on('exit', code => fail(`git cat-file exited ${code} in ${repo}`));
  }
  read(blob) {
    return new Promise((resolve, reject) => {
      this.pending.push({ blob, resolve, reject });
      this.child.stdin.write(`${blob}\n`);
    });
  }
  drain() {
    while (this.pending.length > 0) {
      const newline = this.buffer.indexOf(10);
      if (newline < 0) return;
      const [, type, size] = this.buffer.subarray(0, newline).toString('utf8').split(' ');
      if (type !== 'blob') {
        this.buffer = this.buffer.subarray(newline + 1);
        const request = this.pending.shift();
        request.reject(new Error(`snapshot object ${request.blob} is ${type ?? 'unreadable'}`));
        continue;
      }
      const end = newline + 1 + Number(size);
      if (this.buffer.length < end + 1) return;
      const contents = Buffer.from(this.buffer.subarray(newline + 1, end));
      this.buffer = this.buffer.subarray(end + 1);
      this.pending.shift().resolve(contents);
    }
  }
  close() { this.child.stdin.end(); }
}

/** Load the pinned esbuild API next to <compiler binary>, bound to that binary. */
export function loadPinnedEsbuild(compilerPath, requiredVersion) {
  const binary = realpathSync(compilerPath);
  const packageRoot = dirname(dirname(binary));
  let pkg;
  try { pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')); } catch {
    throw new RefusedError(`compiler ${binary} is not inside an esbuild package`);
  }
  const binaryVersion = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim();
  if (pkg.name !== 'esbuild' || pkg.version !== requiredVersion || binaryVersion !== requiredVersion) {
    throw new RefusedError(`snapshot compile requires esbuild ${requiredVersion}; resolved `
      + `${pkg.name}@${pkg.version} API with a ${binaryVersion} binary at ${binary}`);
  }
  process.env.ESBUILD_BINARY_PATH = binary;
  return createRequire(join(packageRoot, 'package.json'))('./lib/main.js');
}

/** The plugin: tracked snapshot paths come from blobs; everything else from disk. */
export function snapshotSourcePlugin(root, index, served, fallback) {
  const readers = new Map();
  const reader = repo => readers.get(repo) ?? readers.set(repo, new BlobReader(repo)).get(repo);
  const repoOwned = path => path.startsWith(`${root}${sep}`) && !path.split(sep).includes('node_modules');
  return {
    plugin: {
      name: 'bundle-host-snapshot-source',
      setup(build) {
        build.onLoad({ filter: /.*/, namespace: 'file' }, async args => {
          const entry = index.get(args.path);
          const loader = DEFAULT_LOADERS[extname(args.path)];
          if (!entry || !loader) {
            if (repoOwned(args.path)) fallback.add(relative(root, args.path));
            return undefined;
          }
          const contents = await reader(entry.repo).read(entry.blob);
          served.set(relative(root, args.path), entry.blob);
          return { contents, loader };
        });
      },
    },
    close() { for (const blobReader of readers.values()) blobReader.close(); },
  };
}

export async function snapshotCompile({ root, compilerPath, requiredVersion, commit, argv, receiptPath }) {
  root = realpathSync(root);
  let options, metafile;
  try {
    ({ options, metafile } = compilerOptionsFromArgs(argv, root,
      { label: 'Snapshot compiler', containOutputs: false }));
  } catch (error) {
    throw new RefusedError(error instanceof Error ? error.message : String(error));
  }
  const esbuild = loadPinnedEsbuild(compilerPath, requiredVersion);
  const index = snapshotBlobIndex(root, commit);
  const served = new Map(), fallback = new Set();
  const source = snapshotSourcePlugin(root, index, served, fallback);
  let result;
  try {
    result = await esbuild.build({ ...options, logLevel: options.logLevel ?? 'warning', plugins: [source.plugin] });
  } finally {
    source.close();
  }
  for (const output of result.outputFiles ?? []) {
    mkdirSync(dirname(output.path), { recursive: true });
    writeFileSync(output.path, output.contents);
  }
  if (metafile !== undefined) writeFileSync(metafile, JSON.stringify(result.metafile));
  const receipt = { sha: commit, served: Object.fromEntries([...served].sort(([a], [b]) => a.localeCompare(b))),
    fallback: [...fallback].sort() };
  if (receiptPath) writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
  return { outfile: options.outfile, servedCount: served.size, fallbackCount: fallback.size, receipt };
}

if (isCliEntry(import.meta.url)) {
  const separator = process.argv.indexOf('--');
  const [root, compilerPath, requiredVersion, commit, receipt] = process.argv.slice(2, separator < 0 ? undefined : separator);
  try {
    if (separator < 0 || !root || !compilerPath || !requiredVersion || !commit || !receipt) {
      throw new RefusedError('usage: <repo root> <compiler binary> <required version> <snapshot sha> '
        + '<served receipt | -> -- <esbuild args...>');
    }
    const built = await snapshotCompile({ root, compilerPath, requiredVersion, commit,
      argv: process.argv.slice(separator + 1), receiptPath: receipt === '-' ? undefined : receipt });
    console.error(`✓ snapshot compile: ${built.outfile} from source snapshot ${commit} `
      + `(${built.servedCount} inputs from snapshot blobs, ${built.fallbackCount} repo inputs from disk)`);
  } catch (error) {
    const refused = error instanceof RefusedError;
    // A rejected build already printed esbuild's own diagnostics at logLevel warning.
    if (refused || !Array.isArray(error?.errors)) {
      console.error(`ERROR: snapshot compile ${refused ? 'refused' : 'failed'}: `
        + `${error instanceof Error ? error.message : String(error)}`);
    }
    process.exitCode = refused ? SNAPSHOT_COMPILE_EXIT_REFUSED : 1;
  }
}
