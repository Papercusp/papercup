---
rel_path: "portability/census/v55/02-source-preview.mjs.part-002"
updated_at: 1794250602744
_body: "content"
---


  return { path, dev: String(stat.dev), ino: String(stat.ino) };
}

/** existsSync deliberately follows links, so separately reject a dangling leaf.
 * @param {string} path */
function isBgSymlink(path) {
  try { return lstatSync(path).isSymbolicLink(); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

/** @param {ReturnType<typeof prepareBgVerifierBuildTransaction>} transaction */
function validateBgVerifierBuildTransaction(transaction) {
  assert.equal(transaction.schemaVersion, 'bg-build-transaction-v1', 'BG transaction is UNKNOWN');
  const { contexts, bank, stage, outputs } = transaction;
  verifyBgVerifierBuildContexts(contexts, 'before-build');
  assert.deepEqual(readBgDirectoryIdentity(bank.path), bank, 'BG transaction bank identity changed');
  assert.equal(dirname(stage), bank.path, 'BG transaction stage escaped bank');
  assert.match(basename(stage), /^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'BG transaction stage leaf is invalid');
  if (transaction.publicationLeaf !== undefined) {
    assert.match(transaction.publicationLeaf, /^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'BG publication leaf is invalid');
    assert.notEqual(transaction.publicationLeaf, basename(stage), 'BG publication overlaps stage');
  }
  const safe = path => typeof path === 'string' && path && !isAbsolute(path)
    && !path.includes('\\') && !path.includes('\0')
    && path.split('/').every(part => part && part !== '.' && part !== '..');
  assert.ok(Array.isArray(outputs) && outputs.length > 0 && outputs.every(row =>
    safe(row.temporary) && safe(row.final) && !row.final.includes('@BG_PID@')),
  'BG transaction output membership is invalid');
  const assets = transaction.assets ?? [];
  assert.ok(Array.isArray(assets) && assets.every(row => safe(row.source) && safe(row.temporary) && safe(row.final)
    && !row.final.includes('@BG_PID@') && row.temporary === `${row.final}.new.@BG_PID@`),
  'BG transaction asset membership is invalid');
  for (const asset of assets) {
    const source = contexts.record.prepared.source.files.find(row => row.path === asset.source);
    assert.ok(source?.kind === 'file', 'BG asset source is outside original source census');
    assert.equal(realpathSync(join(contexts.record.prepared.root, asset.source)),
      join(contexts.record.prepared.root, asset.source), 'BG asset source must be physical');
  }
  const members = [...outputs, ...assets];
  const temporary = members.map(row => row.temporary), finals = members.map(row => row.final);
  assert.equal(new Set(temporary).size, temporary.length, 'BG transaction temporary output duplicated');
  assert.equal(new Set(finals).size, finals.length, 'BG transaction logical output duplicated');
  for (const paths of [temporary, finals]) {
    assert.ok(!paths.some(path => paths.some(other => other !== path && other.startsWith(`${path}/`))),
      'BG transaction file overlaps directory');
  }
  assert.ok(!temporary.some(path => finals.includes(path)), 'BG transaction temporary and logical outputs overlap');
  const compilerOutputs = [];
  for (const entry of contexts.invocations) {
    for (const arg of entry.original.argv) {
      if (arg.includes('@BG_PID@')) {
        const output = /^--(?:outfile|metafile)=(.+)$/.exec(arg)?.[1];
        assert.ok(output && !dirname(output).includes('@BG_PID@')
          && /\.(?:tmp|new)\.@BG_PID@(?:\.[A-Za-z0-9._-]+)?$/.test(basename(output))
          && output.split('@BG_PID@').length === 2,
        'BG transaction PID token is outside a temporary output leaf');
      }
    }
    const { options, metafile } = bgCompilerOptions(entry.original.argv, contexts.record.prepared.root);
    for (const path of [options.outfile, metafile].filter(Boolean)) {
      const local = relative(stage, path).split(sep).join('/');
      assert.ok(safe(local), 'BG transaction compiler output escaped stage');
      compilerOutputs.push(local);
    }
  }
  // Exact equality makes the original logical population authoritative.
  assert.deepEqual(compilerOutputs.sort(), outputs.map(row => row.temporary).sort(), 'BG transaction compiler output membership mismatch');
  // A full-output expectation must contain the main entry before any effects.
  // Explicit source-only authority protects its original subset; the separate
  // complete original source census must still contain the new main entry.
  const main = bgCompilerOptions(contexts.invocations[0].original.argv, contexts.record.prepared.root);
  const mainSource = relative(contexts.record.prepared.root,
    resolve(contexts.record.prepared.root, main.options.entryPoints[0])).split(sep).join('/');
  if (contexts.record.prepared.acceptedManifest.authorityKind === 'source-only') {
    assert.ok(contexts.record.prepared.source.files.some(row => row.path === mainSource && row.kind === 'file'),
      'BG main entry is outside original source census');
  } else assert.ok(Object.hasOwn(contexts.record.prepared.acceptedManifest.members, mainSource),
    'BG artifact accepted membership omits main entry');
  if (transaction.recipe) {
    const { entry, outfile, profile } = transaction.recipe;
    assert.ok(isAbsolute(entry) && dirname(outfile) === stage && ['development', 'release'].includes(profile),
      'BG recipe original command is invalid');
    assert.deepEqual(main.options.entryPoints, [entry], 'BG recipe entry differs from original main invocation');
    assert.equal(main.options.outfile, `${outfile}.tmp.@BG_PID@`, 'BG recipe output differs from original main invocation');
    assert.ok(outputs.some(row => row.temporary === `${basename(outfile)}.tmp.@BG_PID@`
      && row.final === basename(outfile)), 'BG recipe logical main output differs from original membership');
  }
}

/** Bind a PID supplied by the recipe preflight, before its first compile.
 * The original caller contract is preserved beside the resulting exact argv.
 * Stage creation is exclusive: attach an existing attempt instead of replaying.
 * @param {{ transaction: ReturnType<typeof prepareBgVerifierBuildTransaction>, ownerPid: number }} args
 */
export function beginBgVerifierBuildTransaction({ transaction, ownerPid }) {
  validateBgVerifierBuildTransaction(transaction);
  assert.ok(Number.isSafeInteger(ownerPid) && ownerPid > 0, 'BG transaction owner PID is invalid');
  assert.ok(!existsSync(transaction.stage) && !isBgSymlink(transaction.stage), 'BG transaction stage already exists');
  // Never use recursive mkdir: it could adopt another attempt's stage.
  mkdirSync(transaction.stage, { mode: 0o700 });
  assert.deepEqual(readBgDirectoryIdentity(transaction.bank.path), transaction.bank, 'BG transaction bank identity changed');
  const outputNamespace = { bank: transaction.bank, stage: readBgDirectoryIdentity(transaction.stage),
    transactionSha256: createHash('sha256').update(JSON.stringify(transaction)).digest('hex') };
  const contexts = prepareBgVerifierBuildContexts({ prepared: transaction.contexts.record.prepared,
    dependencies: transaction.contexts.record.dependencies,
    expectedHostManifest: transaction.contexts.record.expectedHostManifest?.authority,
    invocations: transaction.contexts.invocations.map(entry => ({ ...entry.invocation, outputNamespace,
      argv: entry.original.argv.map(arg => arg.replaceAll('@BG_PID@', String(ownerPid))) })) });
  return freezeBgExpectation({ schemaVersion: 'bg-build-transaction-binding-v1', transaction,
    transactionSha256: createHash('sha256').update(JSON.stringify(transaction)).digest('hex'),
    ownerPid, contexts, outputs: transaction.outputs.map(row => ({ ...row,
      temporary: row.temporary.replaceAll('@BG_PID@', String(ownerPid)) })) });
}

/** Expand directory copies from the retained source census, before a caller
 * freezes its transaction. Never discover membership from a mutable directory
 * walk. `sql` matches the maintained builder's immediate *.sql copy; recursive
 * includes every censused descendant and refuses links instead of following them.
 * @param {{ prepared: BgVerifierPreparation,
 *   trees: { source: string, final: string, selection: 'recursive' | 'sql' }[] }} args
 */
export function expandBgVerifierAssetTrees({ prepared, trees }) {
  verifyBgVerifierSource(prepared, 'before-build');
  const safe = path => typeof path === 'string' && path && !isAbsolute(path)
    && !path.includes('\\') && !path.includes('\0') && !path.includes('@BG_PID@')
    && path.split('/').every(part => part && part !== '.' && part !== '..');
  assert.ok(Array.isArray(trees) && trees.length > 0, 'BG asset tree population is empty');
  const assets = [];
  for (const tree of trees) {
    assert.ok(safe(tree.source) && safe(tree.final) && ['recursive', 'sql'].includes(tree.selection),
      'BG asset tree selection is invalid');
    const source = join(prepared.root, tree.source);
    assert.ok(lstatSync(source).isDirectory() && realpathSync(source) === source,
      'BG asset tree source must be physical and regular');
    const prefix = `${tree.source}/`;
    const files = prepared.source.files.filter(row => row.path.startsWith(prefix))
      .filter(row => tree.selection === 'recursive'
        || (!row.path.slice(prefix.length).includes('/') && !row.path.slice(prefix.length).startsWith('.')
          && row.path.endsWith('.sql')))
      .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    assert.ok(files.length > 0, 'BG asset tree has no original source members');
    for (const file of files) {
      assert.equal(file.kind, 'file', 'BG asset tree member must be a regular file');
      assert.equal(realpathSync(join(prepared.root, file.path)), join(prepared.root, file.path),
        'BG asset tree member must be physical');
      const final = `${tree.final}/${file.path.slice(prefix.length)}`;
      assert.ok(safe(final), 'BG asset tree output membership is invalid');
      assets.push({ source: file.path, temporary: `${final}.new.@BG_PID@`, final });
    }
  }
  const finals = assets.map(row => row.final);
  assert.equal(new Set(finals).size, finals.length, 'BG asset tree output duplicated');
  assert.ok(!finals.some(path => finals.some(other => other !== path && other.startsWith(`${path}/`))),
    'BG asset tree file overlaps directory');
  return freezeBgExpectation(assets);
}

/** Copy only the original transaction's source-censused ancillary files. The
 * very buffer checked against the original digest is written exclusively into
 * the owned stage; no hardlink, ambient directory tree or later read supplies
 * its bytes. Callers may expand retained directories with
 * expandBgVerifierAssetTrees before preparing the original transaction.
 * @param {ReturnType<typeof beginBgVerifierBuildTransaction>} binding
 */
export function stageBgVerifierAssetCopies(binding) {
  const { transaction, assets } = verifyBgVerifierOutputBinding(binding);
  const { root, source } = binding.contexts.record.prepared;
  for (const asset of assets) {
    const expected = source.files.find(row => row.path === asset.source);
    assert.ok(expected?.kind === 'file', 'BG asset source is outside original source census');
    const path = join(root, asset.source), fd = openSync(path, 'r');
    let contents;
    try {
      const before = fstatSync(fd, { bigint: true });
      assert.ok(before.isFile() && realpathSync(path) === path, 'BG asset source must be physical and regular');
      contents = readFileSync(fd);
      const after = fstatSync(fd, { bigint: true });
      assert.ok(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => before[key] === after[key])
        && realpathSync(path) === path, 'BG asset source changed while reading');
      assert.equal(createHash('sha256').update(contents).digest('hex'), expected.sha256,
        'BG asset consumed bytes mismatch');
    } finally { closeSync(fd); }
    let directory = transaction.stage;
    for (const part of dirname(asset.temporary).split('/').filter(part => part !== '.')) {
      directory = join(directory, part);
      try { mkdirSync(directory, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      readBgDirectoryIdentity(directory);
    }
    writeFileSync(join(transaction.stage, asset.temporary), contents, { flag: 'wx', mode: 0o600 });
  }
  // An empty asset set has no intervening copy effect to fence. Real copies
  // still require the closing source/dependency and namespace validation.
  if (assets.length > 0) verifyBgVerifierOutputBinding(binding);
}

/** Measure the COMPLETE temporary output population against the retained binding
 * and each compiler's receipt. This is a detached pre-publication fence: it
 * neither renames files nor authorizes service activation or runtime imports.
 * The caller must retain the returned record and recheck it at publication.
 * @param {{ binding: ReturnType<typeof beginBgVerifierBuildTransaction>,
 *   receipts: Awaited<ReturnType<typeof compileBgVerifierInvocation>>[] }} args
 */
export function qualifyBgVerifierBuildOutputSet({ binding, receipts }) {
  const { transaction, contexts, outputs, assets } = verifyBgVerifierOutputBinding(binding);
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  assert.ok(Array.isArray(receipts) && receipts.length === contexts.invocations.length,
    'BG output compiler receipt population mismatch');
  const commands = new Set();
  const identities = new Map();
  for (const entry of contexts.invocations) {
    const key = JSON.stringify(entry.original.argv);
    const matches = receipts.filter(receipt => JSON.stringify(receipt.argv) === key);
    assert.equal(matches.length, 1, 'BG output compiler receipt membership mismatch');
    const receipt = matches[0];
    assert.equal(receipt.schemaVersion, 'bg-compiler-invocation-v1', 'BG output compiler receipt is UNKNOWN');
    const record = { ...contexts.record, invocation: entry.original };
    assert.equal(receipt.buildRecordSha256, hash(record), 'BG output compiler original record changed');
    assert.equal(receipt.originalSourceReceiptSha256, record.originalSourceReceiptSha256,
      'BG output compiler original source receipt changed');
    const { options, metafile } = bgCompilerOptions(entry.original.argv, record.prepared.root);
    assert.equal(receipt.output.path, options.outfile, 'BG output compiler output path changed');
    assert.equal(receipt.metafile?.path, metafile, 'BG output compiler metafile path changed');
    for (const identity of [receipt.output, receipt.metafile].filter(Boolean)) {
      assert.deepEqual(readBgIndependentOutputIdentity(identity.path), identity, 'BG output compiler bytes changed');
      identities.set(relative(transaction.stage, identity.path).split(sep).join('/'), identity);
    }
    commands.add(key);
  }
  assert.equal(commands.size, receipts.length, 'BG output compiler command population mismatch');
  assert.deepEqual([...identities.keys()].sort(), binding.outputs.map(row => row.temporary).sort(),
    'BG output compiler file population mismatch');
  for (const asset of assets) {
    const expected = contexts.record.prepared.source.files.find(row => row.path === asset.source);
    const identity = readBgIndependentOutputIdentity(join(transaction.stage, asset.temporary));
    assert.equal(identity.sha256, expected?.sha256, 'BG output asset bytes differ from original source');
    identities.set(asset.temporary, identity);
  }
  const controls = new Map([
    ['.bg-build-binding.json', JSON.stringify(binding)],
    ['.bg-build-context.json', JSON.stringify(binding.contexts)],
  ]);
  const expected = new Set([...identities.keys(), ...[...controls.keys()].filter(path =>
    existsSync(join(transaction.stage, path)))]);
  assertBgOutputPopulation(transaction.stage, expected, controls);
  // Close the census with the same source, dependency and directory identities.
  verifyBgVerifierBuildContexts(contexts, 'before-publication');
  return freezeBgExpectation({ schemaVersion: 'bg-build-output-set-v1',
    transactionSha256: binding.transactionSha256, bindingSha256: hash(binding),
    compilerReceiptsSha256: hash(receipts), originalSourceReceiptSha256: contexts.record.originalSourceReceiptSha256,
    files: outputs.map(row => ({ ...row, identity: identities.get(row.temporary) })) });
}

/** @param {ReturnType<typeof beginBgVerifierBuildTransaction>} binding */
function verifyBgVerifierOutputBinding(binding) {
  assert.equal(binding.schemaVersion, 'bg-build-transaction-binding-v1', 'BG output binding is UNKNOWN');
  const { transaction, ownerPid } = binding;
  validateBgVerifierBuildTransaction(transaction);
  assert.ok(Number.isSafeInteger(ownerPid) && ownerPid > 0, 'BG output owner PID is invalid');
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  assert.equal(binding.transactionSha256, hash(transaction), 'BG output original transaction changed');
  const namespace = binding.contexts.record.invocation.outputNamespace;
  assert.ok(namespace && namespace.stage.path === transaction.stage, 'BG output original stage changed');
  assert.equal(namespace.transactionSha256, binding.transactionSha256, 'BG output compiler transaction changed');
  assert.deepEqual(namespace.bank, transaction.bank, 'BG output original bank changed');
  // Transaction validation refreshed the common census above. Reconstruct the
  // exact PID-bound commands and read all live identities without rescanning
  // those same common inputs during this synchronous binding check.
  const invocations = transaction.contexts.invocations.map(entry => ({ ...entry.invocation, outputNamespace: namespace,
    argv: entry.original.argv.map(arg => arg.replaceAll('@BG_PID@', String(ownerPid))) }));
  const contexts = readBgVerifierBuildContexts({ ...transaction.contexts.record,
    invocation: readBgBuildInvocation(transaction.contexts.record.prepared, invocations[0]) }, invocations);
  assert.deepEqual(binding.contexts, contexts, 'BG output original contexts changed');
  const compilerOutputs = transaction.outputs.map(row => ({ ...row,
    temporary: row.temporary.replaceAll('@BG_PID@', String(ownerPid)) }));
  assert.deepEqual(binding.outputs, compilerOutputs, 'BG output original membership changed');
  const assets = (transaction.assets ?? []).map(row => ({ ...row,
    temporary: row.temporary.replaceAll('@BG_PID@', String(ownerPid)) }));
  const outputs = [...compilerOutputs, ...assets.map(({ temporary, final }) => ({ temporary, final }))];
  return { transaction, contexts, outputs, assets };
}

/** @param {string} stage @param {Set<string>} expected @param {Map<string, string>} [controls] */
function assertBgOutputPopulation(stage, expected, controls = new Map()) {
  const actual = [];
  const visit = (directory, prefix = '') => {
    for (const name of readdirSync(directory).sort()) {
      const path = prefix + name, absolute = join(directory, name), stat = lstatSync(absolute);
      assert.ok(!stat.isSymbolicLink(), 'BG output population contains a symlink');
      if (stat.isDirectory()) {
        assert.ok([...expected].some(file => file.startsWith(path + '/')),
          'BG output population contains an unrecorded directory');
        visit(absolute, path + '/');
      } else {
        assert.ok(stat.isFile() && stat.nlink === 1, 'BG output population requires independent regular files');
        actual.push(path);
        if (controls.has(path)) assert.equal(readFileSync(absolute, 'utf8'), controls.get(path),
          'BG output control record changed');
      }
    }
  };
  visit(stage);
  assert.deepEqual(actual.sort(), [...expected].sort(), 'BG output file population mismatch');
}

/** Re-measure without replacing the retained qualification record.
 * @param {ReturnType<typeof qualifyBgVerifierBuildOutputSet>} output
 * @param {Parameters<typeof qualifyBgVerifierBuildOutputSet>[0]} args
 */
export function verifyBgVerifierBuildOutputSet(output, args) {
  assert.deepEqual(qualifyBgVerifierBuildOutputSet(args), output, 'BG qualified output set changed');
  return output;
}

/** Convert only the qualified temporary files to their ORIGINAL logical names
 * inside the private stage. Exclusive links preserve compiler-created inodes
 * without overwriting another file; unlinking the temporary names restores
 * independent-file custody. A failure leaves an unpublished attempt for diagnosis.
 * The maintained artifact writer qualifies the original main entry in place.
 * @param {{ output: ReturnType<typeof qualifyBgVerifierBuildOutputSet> } &
 *   Parameters<typeof qualifyBgVerifierBuildOutputSet>[0]} args
 * @returns {Promise<{ schemaVersion: string, outputSetSha256: string,
 *   directory: ReturnType<typeof readBgDirectoryIdentity>,
 *   artifact: Awaited<ReturnType<typeof qualifyBgVerifierOutput>>,
 *   controls: ReturnType<typeof readBgIndependentOutputIdentity>[],
 *   files: { temporary: string, final: string, identity: ReturnType<typeof readBgIndependentOutputIdentity> }[] }>}
 */
export async function qualifyBgVerifierLogicalOutputSet(args) {
  const { output, binding, receipts } = args;
  verifyBgVerifierBuildOutputSet(output, args);
  // The complete output fence just validated these same immutable records.
  const { transaction, contexts } = binding;
  const { stage } = transaction;
  const main = contexts.invocations[0];
  const mainOutput = bgCompilerOptions(main.original.argv, contexts.record.prepared.root).options.outfile;
  const entry = output.files.find(row => join(stage, row.temporary) === mainOutput);
  assert.ok(entry && transaction.recipe?.outfile === join(stage, entry.final), 'BG logical main output is UNKNOWN');
  for (const invocation of contexts.invocations) {
    const { options, metafile } = bgCompilerOptions(invocation.original.argv, contexts.record.prepared.root);
    const bundle = output.files.find(row => join(stage, row.temporary) === options.outfile);
    const meta = output.files.find(row => join(stage, row.temporary) === metafile);
    assert.ok(bundle && meta && meta.final === bundle.final + '.meta.json', 'BG logical metafile membership mismatch');
  }
  for (const row of output.files) {
    assert.equal(dirname(row.temporary), dirname(row.final), 'BG logical output directory changed');
    assert.ok(!existsSync(join(stage, row.final)) && !isBgSymlink(join(stage, row.final)),
      'BG logical output already exists');
  }
  for (const row of output.files) {
    linkSync(join(stage, row.temporary), join(stage, row.final));
    unlinkSync(join(stage, row.temporary));
  }
  const artifact = await qualifyBgVerifierOutput({ record: { ...contexts.record, invocation: main.original },
    invocation: main.invocation, entry: join(stage, entry.final),
    compilerReceipt: receipts.find(receipt => JSON.stringify(receipt.argv) === JSON.stringify(main.original.argv)) });
  const controls = ['.bg-build-binding.json', '.bg-build-context.json']
    .filter(path => existsSync(join(stage, path))).map(path => readBgIndependentOutputIdentity(join(stage, path)));
  const logical = freezeBgExpectation({ schemaVersion: 'bg-logical-output-set-v1',
    outputSetSha256: createHash('sha256').update(JSON.stringify(output)).digest('hex'),
    directory: readBgDirectoryIdentity(stage), artifact, controls,
    files: output.files.map(row => ({ temporary: row.temporary, final: row.final,
      identity: readBgIndependentOutputIdentity(join(stage, row.final)) })) });
  verifyBgVerifierLogicalOutputSet(logical, args);
  return logical;
}

/** Recheck retained logical outputs without regenerating a manifest or receipt.
 * @param {Awaited<ReturnType<typeof qualifyBgVerifierLogicalOutputSet>>} logical
 * @param {Parameters<typeof qualifyBgVerifierLogicalOutputSet>[0]} args
 */
export function verifyBgVerifierLogicalOutputSet(logical, { output, binding, receipts }) {
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const { transaction, contexts, outputs } = verifyBgVerifierOutputBinding(binding);
  assert.equal(logical.schemaVersion, 'bg-logical-output-set-v1', 'BG logical output record is UNKNOWN');
  assert.equal(logical.outputSetSha256, hash(output), 'BG logical original output record changed');
  assert.equal(output.bindingSha256, hash(binding), 'BG logical original binding changed');
  assert.equal(output.compilerReceiptsSha256, hash(receipts), 'BG logical compiler receipts changed');
  assert.deepEqual(logical.directory, readBgDirectoryIdentity(transaction.stage), 'BG logical stage changed');
  assert.deepEqual(logical.files.map(({ temporary, final }) => ({ temporary, final })), outputs,
    'BG logical output membership changed');
  for (const [index, row] of logical.files.entries()) {
    const original = output.files[index];
    assert.ok(original?.identity, 'BG logical original file is UNKNOWN');
    assert.equal(row.identity.path, join(transaction.stage, row.final), 'BG logical file path changed');
    // Renaming changes ctime; byte, inode and modification-time custody survive.
    for (const key of ['sha256', 'dev', 'ino', 'size', 'mtimeNs'])
      assert.equal(row.identity[key], original.identity[key], 'BG logical compiler file replaced');
    assert.deepEqual(readBgIndependentOutputIdentity(row.identity.path), row.identity, 'BG logical file changed');
  }
  const main = contexts.invocations[0];
  verifyBgVerifierOutputRecord(logical.artifact, { ...contexts.record, invocation: main.original }, main.invocation);
  const controls = new Map([['.bg-build-binding.json', JSON.stringify(binding)],
    ['.bg-build-context.json', JSON.stringify(binding.contexts)]]);
  for (const identity of logical.controls) {
    assert.ok(controls.has(relative(transaction.stage, identity.path)), 'BG logical control path changed');
    assert.deepEqual(readBgIndependentOutputIdentity(identity.path), identity, 'BG logical control changed');
  }
  assertBgOutputPopulation(transaction.stage, new Set([...outputs.map(row => row.final),
    ...logical.controls.map(row => relative(transaction.stage, row.path)),
    relative(transaction.stage, logical.artifact.manifest.path)]), controls);
  verifyBgVerifierBuildContexts(contexts, 'before-publication');
  return logical;
}

/** Publish one COMPLETE receipt at the pre-nominated bank leaf. Linking a fully
 * written private file is atomic and refuses an existing destination, including
 * dangling links. Keep artifact paths physical: moving this directory would
 * invalidate the maintained boot reader's manifest suffix check. This publishes
 * evidence only; activation must independently recheck the receipt and cohort.
 * @param {{ logical: Awaited<ReturnType<typeof qualifyBgVerifierLogicalOutputSet>> } &
 *   Parameters<typeof qualifyBgVerifierLogicalOutputSet>[0]} args
 */
export function publishBgVerifierLogicalOutputSet(args) {
  const { logical, binding, receipts, output } = args;
  const leaf = binding.transaction.publicationLeaf;
  assert.ok(leaf, 'BG publication destination was not originally nominated');
  assert.match(leaf, /^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'BG publication leaf is invalid');
  assert.deepEqual(readBgDirectoryIdentity(binding.transaction.bank.path), binding.transaction.bank,
    'BG publication bank changed');
  assert.deepEqual(readBgDirectoryIdentity(binding.transaction.stage), logical.directory,
    'BG publication stage changed');
  const path = join(binding.transaction.bank.path, leaf), temporary = path + '.tmp.' + binding.ownerPid;
  // Retain the original inputs needed by the publication verifier. A logical
  // output digest alone cannot reconstruct the compiler or transaction proof.
  const evidence = { schemaVersion: 'bg-build-publication-v1', logical, binding, receipts, output };
  const body = JSON.stringify(evidence);
  writeFileSync(temporary, body, { flag: 'wx', mode: 0o600 });
  try {
    verifyBgVerifierLogicalOutputSet(logical, args);
    linkSync(temporary, path);
  } finally { unlinkSync(temporary); }
  const publication = freezeBgExpectation({ ...evidence, identity: readBgIndependentOutputIdentity(path) });
  assert.equal(readFileSync(path, 'utf8'), body, 'BG publication content changed');
  return publication;
}

/** @param {ReturnType<typeof publishBgVerifierLogicalOutputSet>} publication
 * @param {Parameters<typeof publishBgVerifierLogicalOutputSet>[0]} args */
export function verifyBgVerifierPublication(publication, args) {
  assert.equal(publication.schemaVersion, 'bg-build-publication-v1', 'BG publication record is UNKNOWN');
  assert.equal(publication.identity.path, join(args.binding.transaction.bank.path,
    args.binding.transaction.publicationLeaf ?? ''), 'BG publication destination changed');
  assert.deepEqual(publication.logical, args.logical, 'BG publication logical record changed');
  for (const key of ['binding', 'receipts', 'output'])
    assert.deepEqual(publication[key], args[key], 'BG publication original evidence changed');
  assert.deepEqual(readBgIndependentOutputIdentity(publication.identity.path), publication.identity,
    'BG publication file changed');
  assert.equal(readFileSync(publication.identity.path, 'utf8'),
    JSON.stringify({ schemaVersion: publication.schemaVersion, logical: args.logical,
      binding: args.binding, receipts: args.receipts, output: args.output }), 'BG publication content changed');
  verifyBgVerifierLogicalOutputSet(args.logical, args);
  return publication;
}

/** Execute one retained recipe into an exclusively owned stage, then publish its
 * complete evidence. Re-entry always refuses the existing stage, including an
 * attempt whose compiler failed. There is no cache/fallback or service effect.
 * This does not establish the production runtime closure or authorize activation.
 * @param {Parameters<typeof beginBgVerifierBuildTransaction>[0] & { runPhase?: VerifierPhaseRunner,
 *   budget?: { measurements: Record<string, number>, env?: NodeJS.ProcessEnv, now?: () => number } }} args
 */
export async function runBgVerifierBuildRecipe(args) {
  const { transaction, budget, runPhase: tracePhase = async (_phase, operation) => operation() } = args;
  // Capture the caller's clock before the compiler replaces process.env. A
  // deadline-bearing run must forecast the whole recipe before any stage effect.
  const env = { ...(budget?.env ?? process.env) }, now = budget?.now ?? Date.now;
  assert.ok(budget || env.PAPERCUSP_TASK_DEADLINE_EPOCH_MS === undefined,
    'BG recipe deadline requires completed phase budget observations');
  const measurements = { ...budget?.measurements };
  /** @type {string[]} */
  const completedPhases = [];
  /** @type {{ phase: string, startedAtMs: number } | undefined} */
  let activePhase;
  const admit = () => {
    if (!budget) return;
    const estimate = estimateVerifierCommandBudget(measurements, 0, { bgRecipe: {
      invocationCount: transaction.contexts.invocations.length, completedPhases,
      ...(activePhase ? { activePhase: { phase: activePhase.phase,
        elapsedMs: Math.max(0, now() - activePhase.startedAtMs) } } : {}),
    } });
    admitVerifierCommandBudget(estimate, { env, nowMs: now() });
  };
  admit();
  /** @type {VerifierPhaseRunner} */
  const runPhase = async (phase, operation) => {
    const outer = phase.startsWith('bg.recipe.');
    // stop is unconditional cleanup, including when admission itself refuses.
    if (phase !== 'bg.compiler.stop') admit();
    const before = now();
    if (outer) activePhase = { phase, startedAtMs: before };
    try {
      const result = await tracePhase(phase, () => {
        if (phase !== 'bg.compiler.stop') admit();
        return operation();
      });
      measurements[phase] = Math.max(measurements[phase] ?? 0, Math.max(0, now() - before));
      if (outer) { completedPhases.push(phase); activePhase = undefined; }
      if (phase !== 'bg.compiler.stop') admit();
      return result;
    } finally {
      if (outer) activePhase = undefined;
    }
  };
  await runPhase('bg.recipe.validate', () => {
    validateBgVerifierBuildTransaction(transaction);
    assert.ok(transaction.publicationLeaf, 'BG recipe publication destination is UNKNOWN');
    const destination = join(transaction.bank.path, transaction.publicationLeaf);
    assert.ok(!existsSync(destination) && !isBgSymlink(destination), 'BG recipe publication already exists');
  });
  const binding = await runPhase('bg.recipe.begin', () => {
    const binding = beginBgVerifierBuildTransaction(args);
    writeBgVerifierBinding(binding);
    return binding;
  });
  const receipts = [];
  // Preserve original command order and record identity. A later compiler
  // failure leaves diagnostic temporary files but cannot publish a partial set.
  for (const entry of binding.contexts.invocations) {
    const record = { ...binding.contexts.record, invocation: entry.original };
    receipts.push(await runPhase(`bg.recipe.compiler.${receipts.length}`, () =>
      compileBgVerifierInvocation({ record, invocation: entry.invocation,
        argv: entry.invocation.argv, expectedVersion: '0.25.0', runPhase })));
  }
  await runPhase('bg.recipe.assets', () => stageBgVerifierAssetCopies(binding));
  const output = await runPhase('bg.recipe.output', () => qualifyBgVerifierBuildOutputSet({ binding, receipts }));
  const logical = await runPhase('bg.recipe.logical', () => qualifyBgVerifierLogicalOutputSet({ binding, receipts, output }));
  const retained = { binding, receipts, output, logical };
  const publication = await runPhase('bg.recipe.publish', () => publishBgVerifierLogicalOutputSet(retained));
  await runPhase('bg.recipe.verify', () => verifyBgVerifierPublication(publication, retained));
  return publication;
}

/** @param {ReturnType<typeof beginBgVerifierBuildTransaction>} binding */
function writeBgVerifierBinding(binding) {
  const stage = binding.transaction.stage;
  writeFileSync(join(stage, '.bg-build-binding.json'), JSON.stringify(binding), { flag: 'wx', mode: 0o600 });
  writeFileSync(join(stage, '.bg-build-context.json'), JSON.stringify(binding.contexts), { flag: 'wx', mode: 0o600 });
}

/** The shared shell recipe delegates one EXACT recorded compiler invocation
 * here. Use its private API and binary, pass the digest-checked buffers to
 * esbuild, then fence source/dependencies again before writing any output.
 * The compiler API is evaluated from its validated buffer with builtin-only
 * imports and no module cache. Its native service consumes a retained sealed
 * descriptor. Runtime imports, full host closure and service readiness remain separate.
 * @param {{ record: ReturnType<typeof prepareBgVerifierBuildRecord>,
 *   invocation: BgBuildInvocation, argv: string[], expectedVersion: string, runPhase?: VerifierPhaseRunner }} args
 */
export async function compileBgVerifierInvocation({ record, invocation, argv, expectedVersion,
  runPhase = async (_phase, operation) => operation() }) {
  await runPhase('bg.compiler.before-build', () => verifyBgVerifierBuildRecord(record, invocation, 'before-build'));
  assert.deepEqual(argv, record.invocation.argv, 'BG compiler argv differs from original invocation');
  const { options, metafile } = bgCompilerOptions(argv, record.prepared.root);
  const actualNode = await runPhase('bg.compiler.node', () => readBgFileIdentity(process.execPath));
  assert.ok(actualNode.realpath === record.invocation.node.realpath && actualNode.sha256 === record.invocation.node.sha256,
    'BG compiler actual Node differs from original invocation');
  const compilerRoot = dirname(dirname(invocation.compiler));
  assert.equal(invocation.compiler, join(compilerRoot, 'lib/main.js'), 'BG compiler requires its private esbuild API');
  const metadataPath = join(compilerRoot, 'package.json');
  const metadata = await runPhase('bg.compiler.metadata', () => JSON.parse(readFileSync(metadataPath, 'utf8')));
  assert.equal(metadata.name, 'esbuild', 'BG compiler package identity mismatch');
  assert.equal(metadata.version, expectedVersion, 'BG compiler package version mismatch');
  const binary = await runPhase('bg.compiler.binary', () => readBgFileIdentity(join(compilerRoot, 'bin/esbuild')));
  await runPhase('bg.compiler.toolchain-files', () => {
    for (const identity of [readBgFileIdentity(invocation.compiler), readBgFileIdentity(metadataPath), binary]) {
      const local = relative(record.prepared.root, identity.realpath).split(sep).join('/');
      const expected = record.dependencies.trees.flatMap(tree => tree.files.map(row =>
        ({ ...row, path: `${tree.path}/${row.path}` }))).find(row => row.path === local);
      assert.ok(expected?.kind === 'file' && expected.sha256 === identity.sha256,
        'BG compiler toolchain file is outside original dependency census');
    }
  });
  assert.equal(invocation.environment.ESBUILD_BINARY_PATH, binary.realpath, 'BG compiler binary must be explicitly pinned');
  assert.equal(invocation.environment.ESBUILD_WORKER_THREADS, '0', 'BG compiler requires its owned service process');
  const custody = await runPhase('bg.compiler.custody', () =>
    bgVerifierCompilerCustody({ prepared: record.prepared, dependencies: record.dependencies },
      (boundary, original) => verifyBgVerifierBuildRecord({ ...record, dependencies: original }, invocation, boundary)));
  const originalEnv = process.env;
  /** @type {typeof import('esbuild') | undefined} */
  let compiler;
  /** @type {import('node:fs/promises').FileHandle | undefined} */
  let sealedBinary;
  let binaryLaunches = 0;
  try {
    sealedBinary = await runPhase('bg.compiler.binary-seal', async () => {
      const original = await fs.open(binary.realpath, 'r');
      try {
        return await sealRuntimeSourceHandle(original, binary.sha256, Number((await original.stat()).size));
      } finally { await original.close(); }
    });
    const retainedBinary = sealedBinary;
    const sealedInfo = await retainedBinary.stat({ bigint: true });
    process.env = { ...invocation.environment };
    const compilerApi = await runPhase('bg.compiler.import', () => {
      const source = custody.readToolchainInput(invocation.compiler);
      const trustedRequire = createRequire(import.meta.url);
      // The pinned esbuild API needs only Node builtins when its native binary
      // is explicitly selected. Refuse package/ambient fallback before loading it.
      const builtinRequire = Object.assign(/** @param {string} name */ name => {
        assert.ok(isBuiltin(name), `BG compiler API import is outside Node builtins: ${name}`);
        if (name === 'child_process' || name === 'node:child_process') return {
          /** @param {string} command @param {string[]} args @param {import('node:child_process').SpawnOptions} spawnOptions */
          spawn(command, args, spawnOptions) {
            assert.equal(command, binary.realpath, 'BG compiler service command differs from original binary');
            assert.deepEqual(args, [`--service=${expectedVersion}`, '--ping'], 'BG compiler service argv differs');
            assert.deepEqual(spawnOptions.stdio, ['pipe', 'pipe', 'inherit'], 'BG compiler service stdio differs');
            assert.ok(!spawnOptions.shell, 'BG compiler service cannot use a shell');
            if (spawnOptions.env) assert.deepEqual(spawnOptions.env, invocation.environment,
              'BG compiler service environment differs');
            assert.equal(binaryLaunches++, 0, 'BG compiler service may launch only once');
            // fd 3 is explicitly inherited by the child. The pathname chosen by
            // esbuild stays bound above, but exec consumes the sealed A bytes even
            // if that original pathname temporarily names B during service startup.
            return spawn('/proc/self/fd/3', args, { ...spawnOptions,
              env: { ...invocation.environment }, stdio: ['pipe', 'pipe', 'inherit', retainedBinary.fd] });
          },
        };
        return trustedRequire(name);
      }, { resolve(/** @type {string} */ name) {
        assert.ok(isBuiltin(name), `BG compiler API resolution is outside Node builtins: ${name}`);
        return trustedRequire.resolve(name);
      } });
      const module = { exports: /** @type {typeof import('esbuild')} */ ({}) };
      // Do not reopen the path or consult Node's CJS/ESM caches after validation.
      compileFunction(source.contents.toString('utf8'), ['exports', 'require', 'module', '__filename', '__dirname'],
        { filename: invocation.compiler })(module.exports, builtinRequire, module,
        invocation.compiler, dirname(invocation.compiler));
      return { compiler: module.exports, identity: source.identity };
    });
    compiler = compilerApi.compiler;
    assert.equal(compiler.version, expectedVersion, 'BG compiler API version mismatch');
    const activeCompiler = compiler;
    const result = await runPhase('bg.compiler.build', () => activeCompiler.build({ ...options, plugins: [custody.plugin] }));
    const consumed = await runPhase('bg.compiler.verify', () => {
      assert.equal(binaryLaunches, 1, 'BG compiler native consumption is UNKNOWN');
      const consumed = custody.verifyBeforePublication();
      if (result.metafile) assert.deepEqual(Object.keys(result.metafile.inputs).map(path =>
        relative(record.prepared.root, resolve(record.prepared.root, path)).split(sep).join('/')).sort(),
      consumed.map(row => row.path).sort(), 'BG compiler complete consumption membership mismatch');
      return consumed;
    });
    return await runPhase('bg.compiler.output', async () => {
      // esbuild write:false leaves failed or incoherent attempts unpublished.
      for (const file of result.outputFiles ?? []) {
        assert.equal(file.path, options.outfile, 'BG compiler produced an unrecorded output');
        await fs.mkdir(dirname(file.path), { recursive: true });
        await fs.writeFile(file.path, file.contents, { flag: 'wx' });
      }
      assert.equal(result.outputFiles?.length, 1, 'BG compiler output is UNKNOWN');
      // Retain the actually evaluated API buffer and the native descriptor
      // alongside the input census. An argv naming a compiler is not evidence
      // that its API or native binary produced these output bytes.
      const compilerBinary = { kind: 'kernel-sealed-fd-v1', sha256: binary.sha256,
        bytes: String(sealedInfo.size), dev: String(sealedInfo.dev), ino: String(sealedInfo.ino), launches: binaryLaunches };
      const compilerExecution = { node: actualNode, api: compilerApi.identity, binary, compilerBinary };
      const consumption = freezeBgExpectation({ schemaVersion: 'bg-compiler-consumption-v1',
        ...bgCompilerConsumptionIdentity(record), consumed, compilerExecution });
      if (metafile) await fs.writeFile(metafile, JSON.stringify({ ...result.metafile,
        papercuspCompilerConsumption: consumption }), { flag: 'wx' });
      return freezeBgExpectation({ schemaVersion: 'bg-compiler-invocation-v1', argv: record.invocation.argv,
        buildRecordSha256: createHash('sha256').update(JSON.stringify(record)).digest('hex'),
        originalSourceReceiptSha256: record.originalSourceReceiptSha256, compilerVersion: activeCompiler.version,
        compilerApi: compilerApi.identity, binary,
        compilerBinary,
        consumed, consumption, output: readBgIndependentOutputIdentity(options.outfile),
        ...(metafile ? { metafile: readBgIndependentOutputIdentity(metafile) } : {}) });
    });
  } finally {
    try { await runPhase('bg.compiler.stop', async () => { await compiler?.stop(); }); }
    finally {
      try { await sealedBinary?.close(); }
      finally { process.env = originalEnv; }
    }
  }
}

/** Hash every byte without allocating a second copy of a toolchain executable.
 * Both identity readers retain their descriptor and metadata fences.
 * @param {number} fd
 * @param {bigint} size
 */
function hashBgFileDescriptor(fd, size) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(Math.min(4 * 1024 * 1024, Number(size)) || 1);
  for (;;) {
    const count = readSync(fd, buffer, 0, buffer.length, null);
    if (count === 0) break;
    hash.update(buffer.subarray(0, count));
  }
  return hash.digest('hex');
}

/** Outputs must retain the actual compiler-created file, even if replacement
 * bytes happen to hash identically. Keep link and inode custody on the same FD
 * used for hashing; the final path must still name that independent file.
 * @param {string} path
 */
function readBgIndependentOutputIdentity(path) {
  assert.ok(isAbsolute(path) && realpathSync(path) === path, 'BG output must be physical');
  const fd = openSync(path, 'r');
  try {
    const before = fstatSync(fd, { bigint: true });
    assert.ok(before.isFile() && before.nlink === 1n, 'BG output must be an independent regular file');
    const sha256 = hashBgFileDescriptor(fd, before.size);
    const after = fstatSync(fd, { bigint: true }), named = lstatSync(path, { bigint: true });
    const fields = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink'];
    assert.ok(named.isFile() && fields.every(key => before[key] === after[key] && after[key] === named[key])
      && realpathSync(path) === path, 'BG output changed while reading');
    return { path, realpath: path, sha256, dev: String(before.dev), ino: String(before.ino),
      size: String(before.size), mtimeNs: String(before.mtimeNs), ctimeNs: String(before.ctimeNs) };
  } finally { closeSync(fd); }
}

/** Read one physical file without reopening between validation and hashing.
 * @param {string} path
 */
function readBgFileIdentity(path) {
  assert.ok(isAbsolute(path), 'BG build identity requires an absolute path');
  const physical = realpathSync(path);
  const fd = openSync(physical, 'r');
  try {
    const before = fstatSync(fd, { bigint: true });
    assert.ok(before.isFile(), 'BG build identity must be a regular file');
    const sha256 = hashBgFileDescriptor(fd, before.size);
    const after = fstatSync(fd, { bigint: true });
    assert.ok(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => before[key] === after[key])
      && realpathSync(path) === physical, 'BG build identity changed while reading');
    return { path, realpath: physical, sha256 };
  } finally { closeSync(fd); }
}

/** Bind the complete consumption packet to the original invocation, including
 * the transaction frozen before stage creation. The packet is sealed inside
 * the compiler's already retained metafile, rather than a rewritten input record.
 * @param {ReturnType<typeof prepareBgVerifierBuildRecord>} record */
function bgCompilerConsumptionIdentity(record) {
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return { transactionSha256: record.invocation.outputNamespace?.transactionSha256 ?? null,
    entry: resolve(record.prepared.root, bgCompilerOptions(record.invocation.argv, record.prepared.root).options.entryPoints[0]),
    argv: record.invocation.argv,
    compilerToolchain: { compiler: record.invocation.compiler, node: record.invocation.node,
      packageManager: record.invocation.packageManager, environment: record.invocation.environment },
    sourceGeneration: hash(record.prepared), dependencyGeneration: hash(record.dependencies),
    buildRecordSha256: hash(record) };
}

/** Source-only parent authority never expands to bless new bundle membership.
 * Independently reconcile the compiler's complete sealed consumption packet
 * with the original source/dependency census and the maintained writer's map.
 * @param {BgVerifierOutputRecord} output
 * @param {ReturnType<typeof prepareBgVerifierBuildRecord>} record */
function verifyBgOutputAuthority(output, record, requireCompiler = false) {
  const accepted = record.prepared.acceptedManifest;
  if (accepted.authorityKind !== 'source-only') {
    assert.deepEqual(output.artifact.sourceBlobs, accepted.members, 'BG output accepted member census mismatch');
    if (!requireCompiler) return;
  }
  const receipt = output.compilerReceipt;
  assert.ok(receipt?.metafile && receipt.consumption, 'BG complete compiler consumption is UNKNOWN');
  const expected = bgCompilerConsumptionIdentity(record);
  assert.match(expected.transactionSha256 ?? '', /^[a-f0-9]{64}$/, 'BG compiler original transaction is UNKNOWN');
  for (const [key, value] of Object.entries(expected))
    assert.deepEqual(receipt.consumption[key], value, `BG compiler consumption ${key} mismatch`);
  assert.equal(receipt.buildRecordSha256, expected.buildRecordSha256, 'BG compiler consumption original record mismatch');
  assert.deepEqual(receipt.argv, expected.argv, 'BG compiler consumption argv mismatch');
  const meta = readBgFileIdentity(output.entry.path + '.meta.json');
  assert.equal(meta.sha256, receipt.metafile.sha256, 'BG sealed compiler consumption metafile changed');
  const sealed = JSON.parse(readFileSync(meta.path, 'utf8')).papercuspCompilerConsumption;
  assert.deepEqual(sealed, receipt.consumption, 'BG sealed compiler consumption receipt changed');
  const execution = sealed.compilerExecution;
  assert.ok(execution, 'BG original compiler execution is UNKNOWN');
  assert.ok(execution.node?.realpath === record.invocation.node.realpath
    && execution.node.sha256 === record.invocation.node.sha256, 'BG original compiler Node mismatch');
  assert.ok(execution.api?.path === relative(record.prepared.root, record.invocation.compiler.realpath).split(sep).join('/')
    && execution.api.realpath === record.invocation.compiler.realpath
    && execution.api.sha256 === record.invocation.compiler.sha256, 'BG original compiler API mismatch');
  assert.deepEqual(receipt.compilerApi, execution.api, 'BG retained compiler API changed');
  assert.deepEqual(receipt.binary, execution.binary, 'BG retained compiler binary changed');
  assert.deepEqual(receipt.compilerBinary, execution.compilerBinary, 'BG retained sealed compiler binary changed');
  assert.equal(execution.binary.path, record.invocation.environment.ESBUILD_BINARY_PATH,
    'BG original compiler binary path mismatch');
  assert.deepEqual(readBgFileIdentity(execution.binary.path), e
