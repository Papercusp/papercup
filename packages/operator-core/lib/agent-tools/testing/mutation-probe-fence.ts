/** Read the active file-lock lease that marks an in-tree mutation window. */
import { existsSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { build, type Metafile, type Plugin } from 'esbuild';
import { ensureBootstrap, getTxPool, readQueue } from '../locks/su-lock-store';

/**
 * Return active mutation-probe paths for one physical checkout. The lock is a
 * checkout-wide marker: which test files it fences is decided by
 * `mutationProbeRefusal` below, not by path overlap with the requested tests.
 */
export async function activeMutationProbePaths(checkoutRoot: string): Promise<string[]> {
  const coordinationDomain = await realpath(checkoutRoot);
  await ensureBootstrap();
  const queue = await readQueue(getTxPool(), { coordinationDomain });
  return queue.active_locks
    .filter((lock) => String(lock.intent ?? '').trim().toLowerCase() === 'mutation probe')
    .map((lock) => lock.path)
    .sort();
}

export type MutationProbeRefusal = {
  error: 'mutation_probe_active' | 'mutation_probe_state_unknown';
  hint: string;
};

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const CLOSURE_FILE_CAP = 20_000;
const CLOSURE_BUDGET_MS = 20_000;
/**
 * Test-side code that reaches source through the FILESYSTEM or a child process instead of an
 * import. The import closure cannot see those reads, so a match refuses the run. A heuristic
 * that can only over-refuse: a false hit costs a retry, a miss would admit a mutant.
 */
const OUT_OF_GRAPH_ACCESS =
  /(?<![\w$])(?:readdirSync|readdir|opendirSync|opendir|globSync|glob|fastGlob|spawn|spawnSync|execSync|execFile|execFileSync|execa|fork)\s*\(|(?<![\w$.])exec\s*\(|import\.meta\.glob/;
const TEST_SIDE_FILE = /(^|[\\/])(__tests__|tests?|fixtures?)[\\/]|\.(test|spec)\.|test-?(helpers?|utils?)/i;

/** esbuild resolves a bare specifier; anything that lands in node_modules is a package, not source. */
const externalPackages: Plugin = {
  name: 'mutation-probe-external-packages',
  setup(pluginBuild) {
    const nested = Symbol('nested');
    pluginBuild.onResolve({ filter: /^[^./]/ }, async (args) => {
      if (args.pluginData === nested || isAbsolute(args.path)) return undefined;
      if (isBuiltin(args.path)) return { path: args.path, external: true };
      const resolved = await pluginBuild.resolve(args.path, {
        kind: args.kind, resolveDir: args.resolveDir, importer: args.importer, pluginData: nested,
      });
      if (resolved.errors.length > 0) return { errors: resolved.errors };
      if (resolved.external) return { path: args.path, external: true };
      return resolved.path.split(sep).includes('node_modules') ? { path: args.path, external: true } : { path: resolved.path };
    });
  },
};

type Closure = { status: 'complete'; files: Map<string, Set<string>> } | { status: 'incomplete'; reason: string };

/**
 * An import esbuild could not follow. esbuild inlines every literal import it resolves and
 * keeps a quoted specifier for an external package, so an `import(`/`require(` left in the
 * bundle without a plain string literal is an edge the metafile graph does not contain.
 * Comments before a literal are trivia, while template literals can interpolate runtime paths.
 * esbuild does not warn for a non-literal `import()` in ESM output, so this scan is the signal.
 */
const IMPORT_CALL = /(?<![\w$.])(?:import|__require|require)\s*\(/g;
const CREATE_REQUIRE = /\bcreateRequire\s*\(/;

/** Skip comments as well as whitespace before classifying an import argument. */
function importArgumentStart(text: string, start: number): number {
  let at = start;
  for (;;) {
    while (/\s/.test(text[at] ?? '')) at++;
    if (text.startsWith('/*', at)) {
      const end = text.indexOf('*/', at + 2);
      if (end < 0) return at;
      at = end + 2;
    } else if (text.startsWith('//', at)) {
      const end = text.indexOf('\n', at + 2);
      if (end < 0) return at;
      at = end + 1;
    } else {
      return at;
    }
  }
}

function unfollowedImportAt(text: string): number | null {
  const createRequire = CREATE_REQUIRE.exec(text);
  if (createRequire) return createRequire.index;
  IMPORT_CALL.lastIndex = 0;
  for (const match of text.matchAll(IMPORT_CALL)) {
    const at = importArgumentStart(text, match.index + match[0].length);
    // esbuild keeps resolved external package imports as quoted specifiers.
    if (text[at] !== '"' && text[at] !== "'") return match.index;
  }
  return null;
}

/**
 * The static module closure of each requested test file (absolute paths), computed by bundling
 * with esbuild and walking the metafile's import graph from each entry. The graph is walked
 * rather than read from the outputs because tree-shaking drops side-effect-free modules from
 * an output, while Vitest still evaluates them.
 */
async function testImportClosures(root: string, tests: string[]): Promise<Closure> {
  let metafile: Metafile;
  try {
    const outdir = join(tmpdir(), 'mutation-probe-closure');
    const result = await Promise.race([
      build({
        entryPoints: tests, absWorkingDir: root, bundle: true, write: false, metafile: true,
        // Tree-shaking off so the unfollowed-import scan below sees every module's code.
        outdir, platform: 'node', format: 'esm', treeShaking: false,
        logLevel: 'silent', plugins: [externalPackages],
        loader: {
          '.json': 'json', '.md': 'text', '.sql': 'text', '.txt': 'text', '.html': 'text', '.yaml': 'text', '.yml': 'text',
          '.css': 'empty', '.scss': 'empty', '.svg': 'empty', '.png': 'empty', '.jpg': 'empty', '.gif': 'empty',
          '.woff': 'empty', '.woff2': 'empty', '.wasm': 'empty', '.node': 'empty',
        },
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`closure exceeded ${CLOSURE_BUDGET_MS}ms`)), CLOSURE_BUDGET_MS).unref()),
    ]);
    // An import esbuild could not follow is an edge this walk cannot see.
    const unfollowed = result.warnings.find((w) => w.id === 'unsupported-dynamic-import' || w.id === 'unsupported-require-call');
    if (unfollowed) {
      const at = unfollowed.location ? ` (${unfollowed.location.file}:${unfollowed.location.line})` : '';
      return { status: 'incomplete', reason: `non-literal import${at}` };
    }
    for (const output of result.outputFiles) {
      const matchAt = unfollowedImportAt(output.text);
      if (matchAt === null) continue;
      const entry = result.metafile.outputs[relative(root, output.path)]?.entryPoint ?? relative(outdir, output.path);
      return { status: 'incomplete', reason: `${entry} reaches an import esbuild cannot follow: ${JSON.stringify(output.text.slice(matchAt, matchAt + 60))}` };
    }
    metafile = result.metafile;
  } catch (error) {
    const first = (error as { errors?: Array<{ text: string }> }).errors?.[0]?.text;
    return { status: 'incomplete', reason: (first ?? (error instanceof Error ? error.message : String(error))).slice(0, 200) };
  }
  const inputs = Object.keys(metafile.inputs);
  if (inputs.length > CLOSURE_FILE_CAP) return { status: 'incomplete', reason: `closure exceeds ${CLOSURE_FILE_CAP} files` };
  const edges = new Map(inputs.map((key) => [resolve(root, key),
    metafile.inputs[key]!.imports.filter((edge) => !edge.external).map((edge) => resolve(root, edge.path))]));
  const files = new Map<string, Set<string>>();
  for (const test of tests) {
    const seen = new Set<string>([test]);
    const queue = [test];
    while (queue.length > 0) {
      for (const next of edges.get(queue.pop()!) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
    files.set(test, seen);
  }
  return { status: 'complete', files };
}

/** Why one test file may observe a probed source, or null when its closure provably cannot. */
async function reachReason(closure: Set<string>, test: string, probes: string[]): Promise<string | null> {
  const hit = probes.find((probe) => closure.has(probe));
  if (hit) return `imports ${hit}`;
  // The extension-less stem also catches a path assembled at runtime (`name + '.ts'`).
  const names = probes.map((probe) => basename(probe, extname(probe)));
  for (const file of closure) {
    if (!CODE_EXTENSIONS.has(extname(file))) continue;
    const text = await readFile(file, 'utf8').catch(() => null);
    if (text === null) return `could not read ${file}`;
    // esbuild can expand a template import into a generated glob and erase the
    // original call from its output. The raw reachable source must still refuse it.
    if (unfollowedImportAt(text) !== null) return `${file} has an import esbuild cannot follow exactly`;
    const named = names.find((name) => text.includes(name));
    if (named) return `${file} names ${named}`;
    if ((file === test || TEST_SIDE_FILE.test(file)) && OUT_OF_GRAPH_ACCESS.test(text)) {
      return `${file} reads the filesystem or spawns a process`;
    }
  }
  return null;
}

/**
 * The mutation-probe preflight for one checkout, or null when the run may proceed. Called
 * BEFORE anything durable is written for the run (EI-24100872054224181): a refusal that
 * starts no test process must not leave evidence rows behind.
 *
 * An in-tree probe holds its subject mutated for the dirty window. A requested test file is
 * admitted only when its whole static import closure resolves, excludes every probed path,
 * never names one, and does no filesystem walk or spawn from test-side code. Anything the walk
 * cannot establish refuses the run, as does a probed path that is not a code module (only the
 * filesystem reaches it). The lock read is fail-closed: without a current answer this runner
 * cannot claim it avoided a mutant.
 */
export async function mutationProbeRefusal(
  root: string,
  files: string[],
  deps: { probePaths?: typeof activeMutationProbePaths } = {},
): Promise<MutationProbeRefusal | null> {
  if (!existsSync(root)) return null;
  let probePaths: string[];
  let realRoot: string;
  try {
    realRoot = await realpath(root);
    probePaths = await (deps.probePaths ?? activeMutationProbePaths)(root);
  } catch (error) {
    return {
      error: 'mutation_probe_state_unknown',
      hint: `could not verify whether an in-tree mutation probe is active; no test process was started (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  if (probePaths.length === 0) return null;
  const refuse = (why: string): MutationProbeRefusal => ({
    error: 'mutation_probe_active',
    hint: `no test process was started because this checkout has an active mutation probe on ${probePaths.join(', ')} and ${why}; retry after the probe restores its source`,
  });
  const probes = probePaths.map((path) => resolve(realRoot, path));
  const nonModule = probePaths.find((path) => !CODE_EXTENSIONS.has(extname(path)));
  if (nonModule) return refuse(`${nonModule} is not a code module, so only a filesystem read can reach it`);
  const tests: string[] = [];
  for (const file of files) {
    const absolute = resolve(realRoot, file);
    if (!existsSync(absolute)) return refuse(`${file} could not be resolved for an import-closure check`);
    tests.push(await realpath(absolute));
  }
  const closure = await testImportClosures(realRoot, tests);
  if (closure.status === 'incomplete') return refuse(`the import closure could not be established (${closure.reason})`);
  for (const test of tests) {
    const reason = await reachReason(closure.files.get(test)!, test, probes);
    if (reason) return refuse(`${test.startsWith(realRoot + sep) ? test.slice(realRoot.length + 1) : test} may observe it: ${reason}`);
  }
  return null;
}
