/** Shared exact-buffer compiler input and file/directory interval custody.
 * Callers own the original population and compiler/toolchain qualification.
 * This leaf does not infer resolver metadata from an esbuild metafile.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const frozenRows = rows => Object.freeze(rows.map(row => Object.freeze({ ...row })));

/** @param {{ root: string, files: Map<string, {kind: string, sha256?: string}>,
 * label?: string, verifyBoundary: () => void, retainBuffers?: boolean, discoverInputs?: boolean,
 * verifyReadOnly?: boolean, syntheticDirectories?: string[] }} input */
export function createCompilerInputCustody({ root, files, label = 'compiler', verifyBoundary,
  retainBuffers = false, discoverInputs = false, verifyReadOnly = false, syntheticDirectories = [] }) {
  const originalFiles = new Map(files);
  const inputIdentity = local => {
    const path = join(root, local), stat = lstatSync(path, { bigint: true });
    return { physical: realpathSync(path), dev: stat.dev, ino: stat.ino,
      mode: stat.mode, nlink: stat.nlink, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
  };
  const identities = new Map([...originalFiles].map(([local, row]) =>
    [local, row.originalIdentity ?? inputIdentity(local)]));
  const directories = new Set(['.']);
  for (const [local, identity] of identities) {
    const physical = relative(root, identity.physical).split(sep).join('/');
    assert.ok(physical && physical !== '..' && !physical.startsWith('../') && !isAbsolute(physical),
      `${label} original input escaped selected generation`);
    for (const path of [local, physical]) {
      let directory = dirname(path);
      while (directory !== '.') { directories.add(directory); directory = dirname(directory); }
    }
  }
  // A caller with a closed native resolver namespace may synthesize enclosing
  // directories instead of exposing their host entries. All mounted source and
  // dependency directories still retain their complete original identities.
  const synthetic = new Set(syntheticDirectories);
  const directoryIdentities = new Map([...directories]
    .filter(local => !synthetic.has(resolve(root, local)))
    .map(local => [local, inputIdentity(local)]));
  const consumed = new Map(), buffers = new Map(), readPaths = new Set();
  const readInput = path => {
    const physical = realpathSync(path), local = relative(root, physical).split(sep).join('/');
    assert.ok(local && local !== '..' && !local.startsWith('../') && !isAbsolute(local),
      `${label} input escaped selected generation`);
    const expected = originalFiles.get(local);
    assert.ok(expected?.kind === 'file', `${label} input is outside original census: ${local}`);
    readPaths.add(local);
    if (retainBuffers && buffers.has(local)) {
      assert.deepEqual(inputIdentity(local), identities.get(local), `${label} original input identity changed: ${local}`);
      return buffers.get(local);
    }
    const fd = openSync(physical, 'r');
    let contents;
    try {
      const before = fstatSync(fd, { bigint: true });
      assert.ok(before.isFile(), `${label} input must be regular`);
      contents = readFileSync(fd);
      const after = fstatSync(fd, { bigint: true });
      assert.ok(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => before[key] === after[key])
        && realpathSync(path) === physical, `${label} input changed while reading: ${local}`);
    } finally { closeSync(fd); }
    const sha256 = createHash('sha256').update(contents).digest('hex');
    // A discovery read is qualified by its already captured original identity.
    // BG keeps requiring its independently pre-hashed original population.
    if (!discoverInputs || expected.sha256 !== undefined)
      assert.equal(sha256, expected.sha256, `${label} consumed bytes mismatch: ${local}`);
    assert.deepEqual(inputIdentity(local), identities.get(local), `${label} original input identity changed: ${local}`);
    const retained = { contents, identity: { path: local, realpath: physical, sha256 } };
    if (retainBuffers) buffers.set(local, retained);
    return retained;
  };
  const plugin = { name: `${label.toLowerCase().replaceAll(' ', '-')}-original-input-custody`, setup(build) {
    assert.equal(build.initialOptions.plugins?.[0], plugin, `${label} custody must be the first plugin`);
    assert.equal(build.initialOptions.stdin, undefined, `${label} stdin is outside original census`);
    build.onLoad({ filter: /.*/ }, ({ path, namespace }) => {
      assert.equal(namespace, 'file', `${label} virtual input is outside original census`);
      const { contents, identity } = readInput(path);
      const loaders = { js: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx', ts: 'ts', mts: 'ts', cts: 'ts',
        tsx: 'tsx', json: 'json', css: 'css', txt: 'text' };
      const extension = identity.path.split('.').at(-1);
      const loader = build.initialOptions.loader?.['.' + extension] ?? loaders[extension];
      assert.ok(loader, `${label} input loader is UNKNOWN: ${identity.path}`);
      consumed.set(identity.path, identity);
      return { contents, loader, resolveDir: dirname(identity.realpath) };
    });
  } };
  const verifyInputs = () => {
    verifyBoundary();
    for (const [local, expected] of identities) {
      if (verifyReadOnly && !readPaths.has(local)) continue;
      assert.deepEqual(inputIdentity(local), expected, `${label} original input identity changed: ${local}`);
    }
    for (const [local, expected] of directoryIdentities)
      assert.deepEqual(inputIdentity(local), expected, `${label} original directory identity changed: ${local}`);
  };
  const rows = () => frozenRows([...consumed.values()].sort((a, b) => a.path.localeCompare(b.path)));
  return { plugin, readToolchainInput: readInput, consumed: rows, verifyInputs,
    readPaths: () => [...readPaths],
    fileCount: identities.size, directoryCount: directoryIdentities.size,
    beginPass() { verifyInputs(); consumed.clear(); },
    verifyBeforePublication() {
      verifyInputs();
      assert.ok(consumed.size > 0, `${label} consumed input proof is UNKNOWN`);
      return rows();
    } };
}

/** Shared translation of the maintained CLI profile. BG keeps contained
 * outputs; ordinary builds may emit to a private directory outside the root. */
export function compilerOptionsFromArgs(argv, root, { label = 'BG compiler', containOutputs = true } = {}) {
  const options = { absWorkingDir: root, entryPoints: [], write: false };
  let metafile;
  for (const arg of argv) {
    if (!arg.startsWith('-')) { options.entryPoints.push(arg); continue; }
    const flag = { '--bundle': 'bundle', '--minify-whitespace': 'minifyWhitespace',
      '--minify-syntax': 'minifySyntax', '--keep-names': 'keepNames' }[arg];
    if (flag) { options[flag] = true; continue; }
    const scalar = /^--(platform|format|target|outfile|log-level|log-limit)=(.+)$/s.exec(arg);
    if (scalar) {
      const key = { 'log-level': 'logLevel', 'log-limit': 'logLimit' }[scalar[1]] ?? scalar[1];
      options[key] = scalar[1] === 'log-limit' ? Number(scalar[2]) : scalar[2];
      continue;
    }
    if (arg.startsWith('--metafile=')) { metafile = arg.slice(11); options.metafile = true; continue; }
    if (arg.startsWith('--external:')) { (options.external ??= []).push(arg.slice(11)); continue; }
    const mapping = /^--(define|alias|banner):([^=]+)=(.*)$/s.exec(arg);
    if (mapping) { (options[mapping[1]] ??= {})[mapping[2]] = mapping[3]; continue; }
    throw new Error(`${label} switch is outside maintained recipe: ${arg}`);
  }
  assert.equal(options.entryPoints.length, 1, `${label} requires exactly one maintained entry`);
  assert.ok(options.outfile, `${label} output path is required`);
  const ownedPath = path => {
    const output = resolve(root, path), local = relative(root, output);
    if (!containOutputs) return output;
    assert.ok(local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`),
      `${label} output escaped selected generation`);
    let parent = dirname(output);
    while (!existsSync(parent)) parent = dirname(parent);
    const inside = relative(root, realpathSync(parent));
    assert.ok(inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside),
      `${label} output escaped selected generation`);
    return output;
  };
  options.outfile = ownedPath(options.outfile);
  if (metafile !== undefined) metafile = ownedPath(metafile);
  return { options, metafile };
}
