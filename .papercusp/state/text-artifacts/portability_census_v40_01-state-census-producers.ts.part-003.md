---
rel_path: "portability/census/v40/01-state-census-producers.ts.part-003"
updated_at: 1794240912951
_body: "content"
---

esolve(environment.PAPERCUSP_GATEWAY_LOG));
  for (const log of gatewayLogs) {
    try { if (!(await lstat(dirname(log))).isDirectory()) continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    for (const path of [log, `${log}.1`]) {
      try { if (!(await lstat(path)).isFile()) continue; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      const directory = dirname(path);
      let logRoot = roots.find(candidate => candidate.path === directory);
      if (!logRoot) {
        // An override authorizes these exact files, not their parent's other
        // contents (which may be outside the Papercusp data tree altogether).
        logRoot = { id: `runtime-gateway-log-${roots.length}`, path: directory, fileNames: [] };
        roots.push(logRoot);
      }
      if (logRoot.fileNames && !logRoot.fileNames.includes(basename(path))) logRoot.fileNames.push(basename(path));
      declarations.push({ kind: 'path', root: logRoot.id, name: basename(path),
        classification: 'state', producer: 'inference-gateway-lifecycle-log' });
    }
  }
  // Session hooks retain their own records, independently of workspace roots.
  // Match the writers' direct-file grammar rather than claiming whole trees:
  // arbitrary siblings, nested source and symlinks remain census residue.
  const ledgerDirectories = new Set([join(ordinaryHome, 'artifact-url-ledger'),
    join(papercuspHome(environment, home), 'artifact-url-ledger')]);
  if (environment.PAPERCUSP_ARTIFACT_LEDGER_DIR) ledgerDirectories.add(environment.PAPERCUSP_ARTIFACT_LEDGER_DIR);
  // papercup-backup-health-check.sh retains trend baselines and alert memory.
  // Its shell override is independent of PAPERCUSP_HOME. Keep the ordinary
  // directory in the inventory after relocation, without claiming arbitrary
  // marker-looking files or recursively hiding unknown contents.
  const backupHealthFiles = new Set([
    'db-disk-history', 'db-disk-history.tmp', 'backup-volume-history', 'backup-volume-history.tmp',
    'db-disk-red-ei-filed', 'db-relation-bloat-ei-filed', 'backup-volume-red-ei-filed',
    'workspace-dead-dump-tmp', 'consecutive-fails', 'stale-tmp',
  ]);
  const artifacts = (environment.BACKUP_ARTIFACTS || 'pg/papercusp-state pg/papercusp-transcript pg/restart').split(/[ \t\n]+/);
  // Explicit optional paths are usable evidence; unexpanded globs are not.
  const optionalArtifacts = (environment.BACKUP_OPTIONAL_ARTIFACTS || '').split(/[ \t\n]+/);
  for (const artifact of [...artifacts, ...optionalArtifacts]) {
    if (!artifact || /[*?\[]/.test(artifact)) continue;
    for (const prefix of ['missing', 'stale']) backupHealthFiles.add(`${prefix}-${artifact.replaceAll('/', '-')}`);
  }
  for (const directory of (environment.BACKUP_TMPDIR_WATCH || '/tmp:/tmp/pcv').split(':')) {
    if (!directory) continue;
    // `tr -c 'A-Za-z0-9' '-'` replaces bytes, including each UTF-8 byte.
    const suffix = Array.from(Buffer.from(directory), byte =>
      (byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122)
        ? String.fromCharCode(byte) : '-').join('');
    backupHealthFiles.add(`tmpdir-entries-red${suffix}`);
  }
  const backupHealthDirectories = new Set([join(ordinaryHome, 'backup-health')]);
  if (environment.BACKUP_STATE_DIR) backupHealthDirectories.add(environment.BACKUP_STATE_DIR);
  // Kopia shares the default directory, but has its own relocation contract
  // and owns only the alert-delivery timestamp, not the probe's other markers.
  const kopiaHealthDirectories = new Set([join(ordinaryHome, 'backup-health')]);
  if (environment.HEALTHCHECK_STATE_DIR) kopiaHealthDirectories.add(environment.HEALTHCHECK_STATE_DIR);
  const stateDirectories = [
    { path: join(ordinaryHome, 'advisory-seen'), producer: 'bash-resource-gate-advisory-seen',
      file: /^[A-Za-z0-9_.-]{1,120}$/ },
    ...[...ledgerDirectories].map(path => ({ path, producer: 'artifact-url-delivery-ledger',
      file: /^[A-Za-z0-9_.-]{1,120}\.ids$/ })),
    ...[...backupHealthDirectories].map(path => ({ path, producer: 'backup-health-probe',
      file: { test: (name: string) => backupHealthFiles.has(name) } })),
    ...[...kopiaHealthDirectories].map(path => ({ path, producer: 'kopia-healthcheck',
      file: { test: (name: string) => name === 'last-alert' } })),
  ];
  for (const directory of stateDirectories) {
    try {
      if (!(await lstat(directory.path)).isDirectory()) continue;
      if (dirname(directory.path) === ordinaryHome && !(await lstat(ordinaryHome)).isDirectory()) continue;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    const local = dirname(directory.path) === ordinaryHome;
    const sessionRoot = local ? root : roots.find(candidate => candidate.path === directory.path)
      ?? { id: `runtime-session-records-${roots.length}`, path: directory.path };
    if (!local && !roots.includes(sessionRoot)) roots.push(sessionRoot);
    const prefix = local ? `${basename(directory.path)}/` : '';
    if (local) declarations.push({ kind: 'path', root: root.id, name: basename(directory.path),
      classification: 'state', producer: directory.producer });
    for (const entry of await readdir(directory.path, { withFileTypes: true })) {
      if (entry.isFile() && directory.file.test(entry.name)) declarations.push({
        kind: 'path', root: sessionRoot.id, name: `${prefix}${entry.name}`,
        classification: 'state', producer: directory.producer,
      });
    }
  }
  const cacheHomes = new Set([ordinaryHome, papercuspHome(environment, home), environment.PAPERCUSP_HOME || ordinaryHome]);
  for (const cacheHome of cacheHomes) {
    try {
      if (!(await lstat(cacheHome)).isDirectory() || !(await lstat(join(cacheHome, 'cache'))).isDirectory()) continue;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    let cacheRoot = roots.find(entry => entry.path === cacheHome);
    if (!cacheRoot) { cacheRoot = { id: `runtime-cache-home-${roots.length}`, path: cacheHome }; roots.push(cacheRoot); }
    for (const [name, producer] of [
      ['cochange-index', 'warm-cochange-snapshot'],
      ['transformers', 'local-embedder-worker-cache'],
    ] as const) {
      const directory = join(cacheHome, 'cache', name);
      try { if (!(await lstat(directory)).isDirectory()) continue; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      declarations.push({ kind: 'path', root: cacheRoot.id, name: 'cache', classification: 'cache', producer });
      declarations.push({ kind: 'path', root: cacheRoot.id, name: `cache/${name}`, classification: 'cache', producer,
        ...(name === 'transformers' ? { descendants: true, prune: true } : {}) });
      if (name === 'cochange-index') {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (entry.isFile() && /^[0-9a-f]{16}\.json(?:\.[0-9]+\.tmp)?$/.test(entry.name)) {
            declarations.push({ kind: 'path', root: cacheRoot.id, name: `cache/${name}/${entry.name}`,
              classification: 'cache', producer });
          }
        }
      }
    }
  }
  // Mutex leases are host-local process metadata, recreated by the primitive.
  // Transporting them would copy stale ownership onto a different machine.
  // Resolve the writer's real root (including relocation), never inspect or
  // delete a live lease merely to establish this export classification.
  const mutex = resolveFsMutexLockRoot(process.env, { homeDir: home });
  let mutexExists = false;
  try { mutexExists = (await lstat(mutex)).isDirectory(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (mutexExists) {
    let parent = roots.find(entry => entry.path === dirname(mutex));
    if (!parent) { parent = { id: 'runtime-mutex-parent', path: dirname(mutex) }; roots.push(parent); }
    declarations.push({ kind: 'path', root: parent.id, name: basename(mutex), classification: 'cache',
      producer: 'filesystem-mutex-runtime', descendants: true, prune: true });
  }
  return { roots, declarations };
}

export function mergeNestedCensusRoots(input: { roots: CensusRoot[]; declarations: CensusDeclaration[] }) {
  const normalized = input.roots.map(root => ({ ...root, path: resolve(root.path) }));
  const contains = (parent: CensusRoot, child: CensusRoot) => {
    const suffix = relative(parent.path, child.path);
    return !suffix || (parent.fileNames === undefined &&
      !suffix.startsWith(`..${sep}`) && suffix !== '..' && !suffix.startsWith(sep));
  };
  const roots = normalized.filter((root, index) => !normalized.some((other, otherIndex) =>
    otherIndex !== index && contains(other, root) && (other.path !== root.path ||
      (other.fileNames === undefined && root.fileNames !== undefined) ||
      ((other.fileNames === undefined) === (root.fileNames === undefined) && otherIndex < index))));
  for (const root of roots) {
    if (root.fileNames !== undefined) root.fileNames = [...new Set(normalized
      .filter(other => other.path === root.path).flatMap(other => other.fileNames ?? []))].sort();
  }
  const declarations = input.declarations.map(declaration => {
    const source = normalized.find(root => root.id === declaration.root);
    if (!source) throw new Error('Census declaration has no root');
    const parent = roots.find(root => contains(root, source));
    if (!parent) throw new Error('Census root merge failed');
    const prefix = relative(parent.path, source.path).split(sep).join('/');
    return { ...declaration, root: parent.id, name: prefix ? `${prefix}/${declaration.name}` : declaration.name };
  });
  return { roots, declarations };
}

/** Result spills are rebuildable, using the actual relocated scratch writer root. */
export function scratchCensusProducer() {
  const path = scratchRoot();
  const root: CensusRoot = { id: 'scratch-parent', path: dirname(path) };
  const declaration: CensusDeclaration = {
    kind: 'path', root: root.id, name: basename(path), classification: 'cache',
    producer: 'scratch-uri', descendants: true, prune: true,
  };
  return { roots: [root], declarations: [declaration] };
}

/** Same relocated compile-analysis cache used by strip-comments-and-strings. */
export function stripRangeCacheCensusProducer(home = homedir()) {
  const path = process.env.PAPERCUSP_STRIP_CACHE_DIR || join(home, '.papercusp', 'cache', 'strip-ranges');
  return { roots: [{ id: 'strip-range-cache-parent', path: dirname(path) }], declarations: [{
    kind: 'path' as const, root: 'strip-range-cache-parent', name: basename(path),
    classification: 'cache' as const, producer: 'strip-comments-and-strings', descendants: true, prune: true,
  }] };
}

/** Exact affected-test writer files; unrelated cache contents remain residue. */
export async function affectedTestCacheCensusProducer(home = homedir()) {
  const directory = join(home, '.papercusp', 'cache');
  const paths = [{ path: process.env.AFFECTED_TASK_HISTORY_PATH ?? join(directory, 'papercusp-affected-task-durations-v1.json'), producer: 'affected-tests-duration-history' }];
  if (process.env.AFFECTED_TASK_VERDICT_CACHE_PATH) {
    paths.push({ path: process.env.AFFECTED_TASK_VERDICT_CACHE_PATH, producer: 'affected-tests-passing-verdict' });
    paths.push({ path: closureDigestManifestPath(process.env.AFFECTED_TASK_VERDICT_CACHE_PATH), producer: 'affected-tests-closure-manifest' });
  }
  const closureSuffix = closureDigestManifestPath('');
  const verdictName = /^papercusp-affected-passing-verdicts-v2-(?:committed-)?[0-9a-f]{16}\.json$/;
  const partialName = new RegExp(`^papercusp-affected-partial-v${PARTIAL_TASK_CHECKPOINT_SCHEMA}-[0-9a-f]{24}\\.json$`);
  const partialDirectory = process.env.AFFECTED_PARTIAL_RESUME_CACHE_DIR || directory;
  for (const cacheDirectory of new Set([directory, partialDirectory].map(path => resolve(path)))) {
    // A relocated writer directory is not authority to follow a symlink or own
    // all of its contents. Enumerate only exact regular writer files.
    try { if (!(await lstat(cacheDirectory)).isDirectory()) continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    for (const entry of await readdir(cacheDirectory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const closure = entry.name.endsWith(closureSuffix);
      const verdict = closure ? entry.name.slice(0, -closureSuffix.length) : entry.name;
      if (cacheDirectory === resolve(directory) && verdictName.test(verdict)) {
        paths.push({ path: join(cacheDirectory, entry.name),
          producer: closure ? 'affected-tests-closure-manifest' : 'affected-tests-passing-verdict' });
      } else if (partialName.test(entry.name)) {
        paths.push({ path: join(cacheDirectory, entry.name), producer: 'affected-tests-partial-checkpoint' });
      }
    }
  }
  const roots: CensusRoot[] = [];
  const declarations: CensusDeclaration[] = [];
  const seen = new Set<string>();
  for (const entry of paths) {
    const path = resolve(entry.path);
    if (seen.has(path)) continue;
    seen.add(path);
    try { if (!(await lstat(entry.path)).isFile()) continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const directory = dirname(resolve(entry.path));
    let root = roots.find(root => root.path === directory);
    if (!root) { root = { id: `affected-test-cache-${roots.length}`, path: directory }; roots.push(root); }
    declarations.push({ kind: 'path', root: root.id, name: basename(entry.path), classification: 'cache', producer: entry.producer });
  }
  return { roots, declarations };
}

/** Registry producer's real relocated root, not the operator's remapped HOME. */
export function workspaceRegistryCensusProducer() {
  const root: CensusRoot = { id: 'workspace-registry', path: workspacesRoot() };
  const declaration: CensusDeclaration = {
    kind: 'path', root: root.id, name: 'registry.json',
    classification: 'config', producer: 'workspace-registry',
  };
  // The registry is the producer authority for directory names. Classify only
  // directory entries here: their contents still require their own producers.
  const workspaceDirectories: CensusDeclaration[] = readRegistry().workspaces.map(workspace => ({
    kind: 'path', root: root.id, name: workspace.id,
    classification: 'state', producer: 'workspace-registry',
  }));
  return { roots: [root], declarations: [declaration, ...workspaceDirectories] };
}

/** Derive secret locations from their writers, including relocated mounted keys. */
export function secretCensusProducers() {
  const paths = [
    { path: dbEncryptionKeyFilePath(), producer: 'db-encryption' },
    { path: superuserTokenPath(), producer: 'superuser-token' },
    { path: googleOAuthClientPath(), producer: 'google-oauth-desktop-client' },
  ];
  const roots: CensusRoot[] = [];
  const declarations: CensusDeclaration[] = [];
  for (const { path, producer } of paths) {
    const directory = dirname(path);
    let root = roots.find(candidate => candidate.path === directory);
    if (!root) {
      root = { id: `secret-directory-${roots.length}`, path: directory };
      roots.push(root);
    }
    declarations.push({ kind: 'path', root: root.id, name: basename(path),
      classification: 'secret', producer });
  }
  return { roots, declarations };
}

/** Exact paths resolved by the hosted deploy and public-download publishers. */
export function hostedConfigurationCensusProducers() {
  const config = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  const paths = [
    { path: process.env.PAPERCUSP_HOSTED_CP_ENV_FILE || join(config, 'papercusp', 'hosted-control-plane.env'), classification: 'secret' as const, producer: 'deploy-hosted-control-plane' },
 
