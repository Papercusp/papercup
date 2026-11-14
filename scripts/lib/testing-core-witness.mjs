/** Producing-build custody for the shared testing-core compiler door.
 * onLoad binds actual buffers; the ORIGINAL whole candidate census also binds
 * native resolver metadata, failed probes and symlinks. A metafile alone does
 * not establish those inputs. Publication retains this interval across parent
 * compilation; a restored file still has a changed ctime and is refused.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync,
  readFileSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createRequire, isBuiltin } from 'node:module';
import { compileFunction } from 'node:vm';
import { spawn, spawnSync } from 'node:child_process';
import { compilerOptionsFromArgs, createCompilerInputCustody } from './compiler-input-custody.mjs';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const identityKeys = ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'];
const controls = ['package-lock.json', 'apps/operator/bin/bundle-host-common.sh',
  'apps/operator/bin/bundle-host.sh', 'apps/operator/bin/ascii-escape-bundle.mjs',
  'scripts/lib/testing-core-witness.mjs', 'scripts/lib/compiler-input-custody.mjs',
  'packages/operator-core/lib/util/cli-entry.ts',
  'packages/operator-core/lib/retained-replay-sources.json'];
// Build products are not a source universe. A selected input in one of these
// trees is refused by the first onLoad plugin rather than silently admitted.
const productDirs = new Set(['.git', '.papercusp', '.next', 'dist-host', 'dist-verify',
  'dist-sidecar', 'dist', 'build', 'out', 'coverage', 'target', 'sidecar', 'env-sidecars', '_retired', '.cache']);
const stateDirs = new Set(['.git', '.papercusp', '.cache', '.next', '.turbo']);

function identity(path) {
  const stat = lstatSync(path, { bigint: true });
  return { ...Object.fromEntries(identityKeys.map(key => [key, String(stat[key])])),
    kind: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'link' : 'other',
    ...(stat.isSymbolicLink() ? { target: readlinkSync(path) } : {}) };
}

function pinFile(path) {
  const original = identity(path), physical = realpathSync(path), fd = openSync(physical, 'r');
  let contents;
  try {
    const before = fstatSync(fd, { bigint: true });
    assert.ok(before.isFile(), `Testing core requires a regular input: ${path}`);
    contents = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    assert.ok(identityKeys.every(key => before[key] === after[key]), `Testing core input changed while read: ${path}`);
  } finally { closeSync(fd); }
  assert.deepEqual(identity(path), original, `Testing core input changed while read: ${path}`);
  assert.equal(realpathSync(path), physical, `Testing core input target changed: ${path}`);
  return { path, physical, original, sha256: digest(contents), contents };
}

function verifyPins(pins) {
  for (const row of pins) {
    assert.deepEqual(identity(row.path), row.original, `Testing core original input identity changed: ${row.path}`);
    assert.equal(realpathSync(row.path), row.physical, `Testing core original target changed: ${row.path}`);
  }
}

function resolverMounts(universe) {
  const parents = new Set(universe.ancestors.filter(row => row.original.kind === 'directory').map(row => row.path));
  return [universe.root,
    ...universe.rows.filter(row => basename(row.path) === 'node_modules' && parents.has(dirname(row.path)))
      .map(row => row.path),
    ...universe.ancestors.filter(row => row.sha256).map(row => row.path)].sort();
}

/** Reuse the host's native namespace primitive, keeping the original source
 * mounts and metadata pins. Missing ancestor candidates remain absent inside
 * the compiler even if another agent creates them in the host's shared HOME.
 * Hosts without a working mount namespace retain the stricter legacy fence. */
export function createTestingCoreResolverNamespace(universe) {
  const path = '/usr/bin/bwrap';
  if (process.platform !== 'linux' || !existsSync(path)) return undefined;
  const launcher = pinFile(path);
  // This is a native capability probe. Starting Node here would inherit test
  // and launcher preloads, turning their Git/import requirements into a false
  // namespace refusal even though the native compiler needs none of them.
  const probe = spawnSync(launcher.physical, ['--unshare-user', '--ro-bind', '/', '/', '--',
    launcher.physical, '--version'], { stdio: 'ignore', timeout: 10_000 });
  verifyPins([launcher]);
  if (probe.status !== 0) return undefined;
  for (const row of universe.ancestors.filter(row => row.sha256))
    assert.equal(row.original.kind, 'file', `Testing core enclosing metadata must be physical: ${row.path}`);
  return { schemaVersion: 'testing-core-resolver-namespace-v1',
    root: universe.root, mounts: resolverMounts(universe), launcher: withoutBuffers(launcher) };
}

export function testingCoreResolverNamespaceIdentity(namespace) {
  return namespace && { schemaVersion: namespace.schemaVersion, root: namespace.root, mounts: namespace.mounts,
    launcherSha256: namespace.launcher.sha256 };
}

/** Only the native service enters this namespace; the API/onLoad host retains
 * original buffers and file identities. BG may supply its already sealed fd,
 * whose bytes are copied read-only into the same isolated executable path. */
export function spawnTestingCoreCompiler(namespace, command, args, options, binaryFd) {
  if (!namespace) return binaryFd === undefined ? spawn(command, args, options)
    : spawn('/proc/self/fd/3', args, { ...options, stdio: ['pipe', 'pipe', 'inherit', binaryFd] });
  verifyPins([namespace.launcher]);
  assert.ok(isAbsolute(namespace.root) && namespace.mounts.includes(namespace.root),
    'Testing core native working directory must be an original source mount');
  const native = '/.papercusp-native-compiler';
  const argv = ['--unshare-user', '--unshare-pid', '--unshare-net', '--die-with-parent', '--new-session',
    '--proc', '/proc', '--dev', '/dev'];
  for (const path of namespace.mounts) argv.push('--ro-bind', path, path);
  if (binaryFd === undefined) argv.push('--ro-bind', command, native);
  else argv.push('--perms', '0500', '--ro-bind-data', '3', native);
  // The API can inherit its host's cwd (a Vitest worker or the operator), which
  // is deliberately absent here. Build absWorkingDir already names this root.
  argv.push('--chdir', namespace.root, '--', native, ...args);
  return spawn(namespace.launcher.physical, argv, { ...options,
    ...(binaryFd === undefined ? {} : { stdio: ['pipe', 'pipe', 'inherit', binaryFd] }) });
}

export function captureTestingCoreInputUniverse(root, outputDir) {
  const rows = [], visited = new Set();
  const omittedOutput = relative(root, outputDir).split(sep).join('/');
  assert.ok(omittedOutput, 'Testing core output cannot be the source root');
  const walk = (path, dependency = false) => {
    if (visited.has(path)) return;
    visited.add(path);
    const local = relative(root, path).split(sep).join('/'), original = identity(path);
    if (path !== root && (local === omittedOutput || stateDirs.has(basename(path))
      || (!dependency && productDirs.has(basename(path))))) return;
    rows.push({ path, original });
    if (original.kind === 'directory') {
      for (const child of readdirSync(path).sort()) walk(join(path, child), dependency || basename(path) === 'node_modules');
    }
    // Internal links are already covered at their physical target by the full
    // walk. The compiler plugin refuses escaping or excluded physical inputs.
  };
  walk(root);
  // Native resolution searches above the selected root. Census existing
  // enclosing dependency trees too, and bind absence through their parents.
  const ancestors = [];
  let domainRoot = root;
  for (let parent = dirname(root); ; parent = dirname(parent)) {
    const modules = join(parent, 'node_modules');
    if (existsSync(modules)) {
      assert.equal(realpathSync(modules), modules, 'Testing core enclosing dependency tree must be physical');
      walk(modules, true);
      domainRoot = parent;
    }
    ancestors.push({ path: parent, original: identity(parent) });
    for (const name of ['package.json', 'tsconfig.json', 'jsconfig.json']) {
      const path = join(parent, name);
      if (existsSync(path)) ancestors.push(pinFile(path));
    }
    if (parent === dirname(parent)) break;
  }
  const files = new Map(rows.filter(row => row.original.kind === 'file').map(row => [
    relative(domainRoot, row.path).split(sep).join('/'), { kind: 'file',
      originalIdentity: { physical: row.path, ...Object.fromEntries(identityKeys.map(key => [key, BigInt(row.original[key])])) } },
  ]));
  return { root, domainRoot, rows, files, ancestors };
}

function verifyUniverse(universe) {
  const namespace = universe.resolverNamespace;
  if (namespace) {
    assert.equal(namespace.schemaVersion, 'testing-core-resolver-namespace-v1');
    assert.equal(namespace.root, universe.root, 'Testing core resolver source root changed');
    assert.deepEqual(namespace.mounts, resolverMounts(universe), 'Testing core resolver mount population changed');
    verifyPins([namespace.launcher]);
  }
  for (const row of [...universe.rows, ...universe.ancestors.filter(row =>
    !namespace || row.original.kind !== 'directory')])
    assert.deepEqual(identity(row.path), row.original, `Testing core resolver/input interval changed: ${row.path}`);
}

/** Native resolution can inspect enclosing package metadata even though the
 * module loader still refuses every module outside its original generation.
 * Bind those metadata bytes BEFORE native compilation, against the ORIGINAL
 * census. These pins grant no module-input or compiler-toolchain authority. */
export function retainTestingCoreResolverMetadata(universe) {
  return universe.rows.filter(row => basename(row.path) === 'package.json').map(row => {
    assert.equal(row.original.kind, 'file', `Testing core resolver metadata must be physical: ${row.path}`);
    const pinned = pinFile(row.path);
    assert.deepEqual(pinned.original, row.original, `Testing core original resolver metadata changed: ${row.path}`);
    return withoutBuffers(pinned);
  });
}

const withoutBuffers = row => { const { contents, ...saved } = row; return saved; };
const sortedRecords = rows => [...new Map(rows.map(row => [row.path, row])).values()]
  .sort((a, b) => a.path.localeCompare(b.path));

function configurationObject(bytes, path) {
  // tsconfig is JSON with comments and trailing commas. Preserve string tokens
  // (including escaped property names) before stripping either extension; JSON
  // itself still rejects executable expressions and every unsupported syntax.
  const text = bytes.toString('utf8').replace(/^\uFEFF/, '')
    .replace(/"(?:\\[\s\S]|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g,
      token => token.startsWith('"') ? token : ' ')
    .replace(/"(?:\\[\s\S]|[^"\\])*"|,(?=\s*[}\]])/g,
      token => token === ',' ? '' : token);
  const value = JSON.parse(text);
  assert.ok(value && typeof value === 'object' && !Array.isArray(value),
    `Testing core configuration must be an object: ${path}`);
  return value;
}

export function qualifyTestingCoreConfigurationClosure(universe, consumed, retain, sourceRecords) {
  const original = new Map(universe.rows.map(row => [row.path, row]));
  const ancestors = new Map(universe.ancestors.filter(row => row.contents).map(row => [row.path, row]));
  const visited = new Set(), active = new Set();
  const read = path => {
    assert.notEqual(original.get(path)?.original.kind, 'link',
      `Testing core configuration symlink is outside qualified recipe: ${path}`);
    const enclosing = ancestors.get(path);
    if (enclosing) {
      verifyPins([enclosing]);
      sourceRecords.push({ path: relative(universe.root, path).split(sep).join('/'), sha256: enclosing.sha256 });
      return enclosing.contents;
    }
    assert.ok(['file', 'link'].includes(original.get(path)?.original.kind),
      `Testing core configuration input is outside original census: ${path}`);
    return retain(relative(universe.root, path));
  };
  const visit = path => {
    assert.ok(!active.has(path), `Testing core configuration extends cycle: ${path}`);
    if (visited.has(path)) return;
    active.add(path);
    const config = configurationObject(read(path), path);
    const extensions = config.extends === undefined ? []
      : Array.isArray(config.extends) ? config.extends : [config.extends];
    for (const extension of extensions) {
      // Package extends may use compiler-specific package/exports resolution.
      // Refuse that unqualified mode rather than guessing its native reads.
      assert.ok(typeof extension === 'string' && (isAbsolute(extension)
        || extension.startsWith('./') || extension.startsWith('../')),
      `Testing core configuration package extends is outside qualified recipe: ${path}`);
      const target = resolve(dirname(path), extension);
      const candidates = [target, target + '.json'].filter(candidate =>
        ['file', 'link'].includes(original.get(candidate)?.original.kind) || ancestors.has(candidate));
      assert.ok(candidates.length, `Testing core configuration input is outside original census: ${target}`);
      for (const candidate of candidates) visit(candidate);
    }
    active.delete(path);
    visited.add(path);
  };
  const directories = new Set();
  for (const row of consumed) {
    const physical = join(universe.domainRoot, row.path);
    // Pinned esbuild 0.25 does not apply implicit tsconfigs inside dependencies.
    // A maintained native behavior control guards that boundary. Symlinked
    // workspace sources have their physical source path here, not this prefix.
    if (physical.split(sep).includes('node_modules')) continue;
    for (let parent = dirname(physical); ; parent = dirname(parent)) {
      directories.add(parent);
      if (parent === dirname(parent)) break;
    }
  }
  for (const directory of directories) for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const path = join(directory, name);
    if (original.has(path) || ancestors.has(path)) visit(path);
  }
}

/** The shell calls this THROUGH bundle_host_esbuild under its existing cache
 * lease. The pinned API is evaluated from its retained buffer, with builtins
 * only; its single native service must name the pinned 0.25 binary. */
export async function prepareTestingCore({ root, compilerPath, argv,
  phase = async (_name, operation) => operation() }) {
  root = realpathSync(root);
  const { options, metafile } = compilerOptionsFromArgs(argv, root,
    { label: 'Testing core compiler', containOutputs: false });
  assert.equal(realpathSync(resolve(root, options.entryPoints[0])),
    join(root, 'packages/operator-core/lib/agent-tools/testing/testing-core.worker.ts'),
    'Testing core compiler requires the maintained entry');
  assert.ok(options.bundle && options.platform === 'node' && options.format === 'esm',
    'Testing core compiler requires the shared plain-Node profile');
  assert.ok(!options.define?.__PAPERCUSP_TESTING_CORE_SOURCE_SHA256__
    && !options.define?.__PAPERCUSP_TESTING_CORE_WITNESS__, 'Testing core cannot accept a caller-supplied witness');
  const outputDir = dirname(options.outfile);
  mkdirSync(outputDir, { recursive: true });
  const universe = await phase('input-census', () => captureTestingCoreInputUniverse(root, realpathSync(outputDir)));
  universe.resolverNamespace = createTestingCoreResolverNamespace(universe);
  const custody = createCompilerInputCustody({ root: universe.domainRoot, files: universe.files,
    label: 'Testing core compiler', retainBuffers: true, discoverInputs: true, verifyReadOnly: true,
    syntheticDirectories: universe.resolverNamespace ? universe.ancestors.filter(row =>
      row.original.kind === 'directory').map(row => row.path) : [],
    verifyBoundary: () => verifyUniverse({ ...universe, rows: universe.rows.filter(row => row.original.kind !== 'file') }) });
  const sourceRecords = [];
  const retain = local => {
    const read = custody.readToolchainInput(resolve(root, local));
    sourceRecords.push({ path: local, sha256: read.identity.sha256 });
    return read.contents;
  };
  for (const row of universe.rows.filter(row => row.original.kind === 'file')) {
    const local = relative(root, row.path).split(sep).join('/');
    // Native package resolution reads package.json. Module JSON comes through
    // onLoad; native configuration's recursive closure is qualified below.
    // Unrelated application/state JSON is neither compiler metadata nor input.
    if (basename(local) === 'package.json'
      || ['.npmrc', 'yarn.lock', 'pnpm-lock.yaml'].includes(basename(local))) retain(local);
  }
  for (const local of controls) retain(local);
  const replayPaths = JSON.parse(retain('packages/operator-core/lib/retained-replay-sources.json').toString('utf8'));
  const replaySources = replayPaths.map(path => [path, digest(retain(path))]);
  const replaySha256 = digest(JSON.stringify({ version: 1, sources: replaySources }));
  assert.equal(options.define?.__PAPERCUSP_RETAINED_REPLAY_SOURCE_SHA256__, JSON.stringify(replaySha256),
    'Testing core replay define differs from original input buffers');

  const binaryPath = realpathSync(compilerPath), compilerRoot = dirname(dirname(binaryPath));
  const pins = [pinFile(join(compilerRoot, 'lib/main.js')), pinFile(join(compilerRoot, 'package.json')),
    pinFile(binaryPath), pinFile(process.execPath)];
  const [api, metadata, binary] = pins;
  const pkg = JSON.parse(metadata.contents.toString('utf8'));
  assert.ok(pkg.name === 'esbuild' && pkg.version === '0.25.0', 'Testing core requires the pinned esbuild 0.25.0 API');
  const version = spawnSync(binary.physical, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  assert.ok(version.status === 0 && version.stdout.trim() === pkg.version, 'Testing core pinned API/binary version mismatch');
  const originalEnv = process.env;
  let compiler, launches = 0;
  try {
    process.env = { ...originalEnv, NODE_PATH: '', ESBUILD_BINARY_PATH: binary.physical, ESBUILD_WORKER_THREADS: '0' };
    const trustedRequire = createRequire(import.meta.url);
    const builtins = Object.assign(name => {
      assert.ok(isBuiltin(name), `Testing core compiler API requires an unqualified package: ${name}`);
      if (name === 'child_process' || name === 'node:child_process') return { spawn(command, args, opts) {
        assert.equal(command, binary.physical, 'Testing core compiler service binary differs');
        assert.deepEqual(args, ['--service=0.25.0', '--ping'], 'Testing core compiler service argv differs');
        assert.equal(launches++, 0, 'Testing core compiler must use one owned native service');
        verifyPins(pins);
        return spawnTestingCoreCompiler(universe.resolverNamespace, command, args, opts);
      } };
      return trustedRequire(name);
    }, { resolve(name) { assert.ok(isBuiltin(name)); return trustedRequire.resolve(name); } });
    const module = { exports: {} };
    compileFunction(api.contents.toString('utf8'), ['exports', 'require', 'module', '__filename', '__dirname'],
      { filename: api.path })(module.exports, builtins, module, api.path, dirname(api.path));
    compiler = module.exports;
    assert.equal(compiler.version, '0.25.0', 'Testing core evaluated API version differs');
    const buildOptions = { ...options, metafile: true, plugins: [custody.plugin] };
    await phase('discovery', () => compiler.build({ ...buildOptions,
      define: { ...options.define, __PAPERCUSP_TESTING_CORE_SOURCE_SHA256__: JSON.stringify('0'.repeat(64)) } }));
    const discovered = custody.verifyBeforePublication();
    // Native config reads are absent from onLoad/metafile. Qualify their full
    // recursive closure against identities captured BEFORE the discovery pass.
    // Arbitrary extensions are retained too; escaping/unsupported inputs refuse
    // publication even if discovery itself could read them successfully.
    qualifyTestingCoreConfigurationClosure(universe, discovered, retain, sourceRecords);
    custody.verifyInputs();
    const { outfile, ...profile } = options;
    const input = { schemaVersion: 1, sources: sortedRecords([...sourceRecords,
      ...discovered.map(({ path, sha256 }) => ({ path: relative(root, join(universe.domainRoot, path)).split(sep).join('/'), sha256 }))]),
      resolutionPopulation: universe.rows.map(row => ({ path: relative(root, row.path).split(sep).join('/'),
        kind: row.original.kind, ...(row.original.target ? { target: row.original.target } : {}) })),
      enclosingMetadata: universe.ancestors.filter(row => row.sha256).map(row => ({ path: row.path, sha256: row.sha256 })),
      ...(universe.resolverNamespace ? {
        resolverNamespace: testingCoreResolverNamespaceIdentity(universe.resolverNamespace) } : {}),
      profile, toolchain: { node: process.versions.node, platform: process.platform, arch: process.arch,
        files: pins.map((row, i) => ({ role: ['api', 'package', 'binary', 'node'][i], sha256: row.sha256 })) } };
    const sourceSha256 = digest(JSON.stringify(input));
    custody.beginPass();
    const result = await phase('final', () => compiler.build({ ...buildOptions,
      define: { ...options.define, __PAPERCUSP_TESTING_CORE_SOURCE_SHA256__: JSON.stringify(sourceSha256) } }));
    const consumed = custody.verifyBeforePublication();
    assert.deepEqual(consumed, discovered, 'Testing core final input population differs from discovery');
    assert.deepEqual(Object.keys(result.metafile.inputs).map(path =>
      relative(universe.domainRoot, resolve(root, path)).split(sep).join('/')).sort(), consumed.map(row => row.path).sort(),
    'Testing core complete compiler consumption membership differs');
    assert.equal(launches, 1, 'Testing core native compiler consumption is unknown');
    verifyPins(pins);
    assert.equal(result.outputFiles.length, 1, 'Testing core produced an unknown output set');
    const temporary = outfile + '.new.' + randomUUID();
    try {
      writeFileSync(temporary, result.outputFiles[0].contents, { flag: 'wx' });
      const escaped = spawnSync(process.execPath, [join(root, 'apps/operator/bin/ascii-escape-bundle.mjs'),
        temporary, '--check'], { encoding: 'utf8', timeout: 30_000 });
      assert.equal(escaped.status, 0, `Testing core final bytes failed syntax/ASCII qualification: ${escaped.stderr}`);
      await phase('before-publication', async () => { custody.verifyInputs(); verifyPins(pins); });
      const artifactSha256 = digest(readFileSync(temporary));
      renameSync(temporary, outfile);
      if (metafile) writeFileSync(metafile, JSON.stringify(result.metafile));
      const readPaths = new Set(custody.readPaths());
      return { schemaVersion: 'testing-core-producing-build-v1', root, output: outfile,
        witness: { schemaVersion: 1, sourceSha256, artifactSha256 }, input,
        interval: { rows: universe.rows.filter(row => row.original.kind !== 'file'
          || readPaths.has(relative(universe.domainRoot, row.path).split(sep).join('/'))),
          ancestors: universe.ancestors.map(withoutBuffers),
          ...(universe.resolverNamespace ? { resolverNamespace: universe.resolverNamespace } : {}),
          toolchain: pins.map(withoutBuffers) } };
    } finally { rmSync(temporary, { force: true }); }
  } finally {
    try { await compiler?.stop(); }
    finally { process.env = originalEnv; }
  }
}

/** Read ORIGINAL identities from the producing receipt, never take a new
 * endpoint census and call it an interval. The independent receipt digest and
 * worker witness are retained by the shell before compiling its parent. */
export function verifyTestingCoreInputs(receipt, expected) {
  assert.equal(receipt.schemaVersion, 'testing-core-producing-build-v1');
  assert.deepEqual(receipt.witness, expected, 'Testing core producing expectation changed');
  assert.equal(digest(JSON.stringify(receipt.input)), expected.sourceSha256, 'Testing core source/profile witness changed');
  assert.deepEqual(testingCoreResolverNamespaceIdentity(receipt.interval.resolverNamespace),
    receipt.input.resolverNamespace, 'Testing core producing resolver namespace changed');
  verifyUniverse({ root: receipt.root, ...receipt.interval });
  verifyPins(receipt.interval.toolchain);
  verifyPins(receipt.interval.resolverMetadata ?? []);
  return expected;
}

export function verifyTestingCoreReceipt(receipt, expected) {
  verifyTestingCoreInputs(receipt, expected);
  assert.equal(digest(readFileSync(receipt.output)), expected.artifactSha256, 'Testing core final artifact changed');
  return expected;
}

async function main(argv) {
  const [command, rootOrReceipt, compilerOrBinding, receiptPath, marker, ...compilerArgs] = argv;
  if (command === 'prepare') {
    assert.equal(marker, '--', 'Testing core prepare requires the shared compiler argv');
    const receipt = await prepareTestingCore({ root: rootOrReceipt, compilerPath: compilerOrBinding, argv: compilerArgs });
    const body = JSON.stringify(receipt);
    writeFileSync(receiptPath, body, { mode: 0o600 });
    process.stdout.write(JSON.stringify({ witness: receipt.witness, receiptSha256: digest(body) }));
  } else if (command === 'verify' || command === 'define') {
    const binding = JSON.parse(compilerOrBinding), bytes = readFileSync(rootOrReceipt);
    assert.equal(digest(bytes), binding.receiptSha256, 'Testing core original receipt changed');
    verifyTestingCoreReceipt(JSON.parse(bytes.toString('utf8')), binding.witness);
    if (command === 'define') process.stdout.write('--define:__PAPERCUSP_TESTING_CORE_WITNESS__=' + JSON.stringify(binding.witness));
  } else throw new Error('Unknown testing core witness command');
}

if (isCliEntry(import.meta.url))
  main(process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 78; });
