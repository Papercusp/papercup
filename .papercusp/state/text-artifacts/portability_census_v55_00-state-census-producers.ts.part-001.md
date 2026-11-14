---
rel_path: "portability/census/v55/00-state-census-producers.ts.part-001"
updated_at: 1794250602744
_body: "content"
---

.code === 'ENOENT') continue; throw error; }
    declarations.push({ kind: 'path', root: root.id, name: directory, classification, producer });
    for (const entry of entries) {
      const atomic = directory === 'provider-pacing' && entry.name.startsWith(`${pacingFile}.tmp-`) &&
        /^[0-9]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(entry.name.slice(`${pacingFile}.tmp-`.length));
      const queryTemporary = directory === 'cache' && /^\.plans-list-standard-v1\.[0-9]+\.tmp$/.test(entry.name);
      const bundle = directory === 'cache/bundle-free-refs' && /^[0-9a-f]{64}\.json(?:\.[0-9]+\.tmp)?$/.test(entry.name);
      if (entry.isFile() && ((files as readonly string[]).includes(entry.name) || atomic || queryTemporary || bundle)) {
        declarations.push({ kind: 'path', root: root.id, name: `${directory}/${entry.name}`, classification, producer });
      }
    }
  }
  // These writers use host-home resolution, not the active-workspace registry.
  // Include the ordinary home as well as the configured home: a relocation
  // does not remove older cache files from the whole-install inventory.
  // The embedding worker uses ||, while the co-change host helper trims the
  // pin; preserve both writer contracts rather than substituting papercuspRoot.
  const ordinaryHome = join(home, '.papercusp');
  // Console/spawn selects PAPERCUSP_HOME for a particular workspace. Retain
  // discovery left in registered or legacy homes after switching workspaces;
  // arbitrary launch working directories are not runtime-home evidence.
  const discoveryHomes = new Set([ordinaryHome, papercuspHome(environment, home), ...runtimeHomes]);
  for (const directory of discoveryHomes) {
    if (!(await lstat(directory).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    }))?.isDirectory() || await realpath(directory) !== resolve(directory)) continue;
    let evidenceRoot = roots.find(candidate => candidate.path === directory);
    if (!evidenceRoot) { evidenceRoot = { id: `runtime-native-evidence-${roots.length}`, path: directory }; }
    const native = await nativeRouterCensusDeclarations(directory, evidenceRoot.id);
    const verifier = await verifierOriginalCensusDeclarations(directory, evidenceRoot.id);
    if (native.length || verifier.length) {
      if (!roots.includes(evidenceRoot)) roots.push(evidenceRoot);
      declarations.push(...native, ...verifier);
    }
  }
  // Reuse the test runner's resolver for reports, executed inputs and native
  // proof. A path switch leaves earlier packets in known runtime homes.
  // Only the testing-run subtree is opaque retained state; siblings still
  // need their own producer, and redirected roots prove no ownership.
  const evidenceLocations = new Map<string, string | undefined>();
  for (const directory of discoveryHomes) {
    evidenceLocations.set(defaultTestRunArtifactBase({ PAPERCUSP_HOME: directory }, home), directory);
  }
  const selectedEvidence = defaultTestRunArtifactBase(environment, home);
  if (!evidenceLocations.has(selectedEvidence)) evidenceLocations.set(selectedEvidence, undefined);
  for (const [base, runtimeHome] of evidenceLocations) {
    try {
      if (!(await lstat(base)).isDirectory() || await realpath(base) !== resolve(base)) continue;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    const directory = runtimeHome ?? dirname(base);
    let evidenceRoot = roots.find(candidate => candidate.path === directory);
    if (!evidenceRoot) { evidenceRoot = { id: `runtime-test-evidence-${roots.length}`, path: directory }; roots.push(evidenceRoot); }
    const name = relative(directory, base).split(sep).join('/');
    const producer = 'testing-run-retained-evidence';
    if (runtimeHome) declarations.push({ kind: 'path', root: evidenceRoot.id,
      name: dirname(name).split(sep).join('/'), classification: 'state', producer });
    declarations.push({ kind: 'path', root: evidenceRoot.id, name, classification: 'state', producer,
      descendants: true, retainedSubtree: {
        evidenceRef: 'source:packages/operator-core/lib/agent-tools/testing/run-artifacts.ts#defaultTestRunArtifactBase',
      } });
  }
  // serve.ts and embedded-postgres-server write these exact host-home files.
  // Discovery includes bearer/DSN credentials, even though its process address
  // will need regeneration after transfer. Never downgrade it to disposable cache.
  for (const directory of discoveryHomes) {
    try {
      if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== resolve(directory)) continue;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    let operatorRoot = roots.find(candidate => candidate.path === directory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const match = /^(operator|operator-port|embedded-pg(?:\.([1-9][0-9]{0,4}))?|embedded-pg-credentials)\.json(?:\.tmp\.([1-9][0-9]{0,9}))?$/.exec(entry.name);
      if (!entry.isFile() || !match || (match[2] && Number(match[2]) > 65535)
        || (match[3] && Number(match[3]) > 2147483647)) continue;
      let handle;
      try {
        handle = await open(join(directory, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const metadata = await handle.stat();
        if (!metadata.isFile() || metadata.size > 65_536) continue;
        const record = JSON.parse(await handle.readFile('utf8'));
        if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
        const port = (value: unknown) => Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65535;
        const timestamp = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0;
        const pid = (value: unknown) => Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 2147483647;
        const only = (keys: string[]) => Object.keys(record).every(key => keys.includes(key));
        const url = (value: unknown, protocols: string[], username?: string) => {
          if (typeof value !== 'string') return false;
          const parsed = new URL(value);
          return protocols.includes(parsed.protocol) && !!parsed.hostname && !parsed.search && !parsed.hash
            && Number(parsed.port || (parsed.protocol === 'https:' ? 443 : parsed.protocol === 'http:' ? 80 : 5432)) === record.port
            && (username === undefined ? !parsed.username && !parsed.password && parsed.pathname === '/' : parsed.username === username);
        };
        let valid = false;
        if (match[1] === 'embedded-pg-credentials') {
          // Reuse the writer's maintained strength/default-password contract.
          const { isValidRoleCredentials } = await import('@papercusp/embedded-postgres-server');
          valid = only(['schemaVersion', 'owner', 'admin', 'app', 'zero'])
            && (record.schemaVersion === undefined || record.schemaVersion === 1) && isValidRoleCredentials(record);
        } else if (match[1] === 'operator-port') {
          valid = only(['port', 'updatedAt']) && port(record.port) && timestamp(record.updatedAt);
        } else if (match[1] === 'operator') {
          valid = only(['httpUrl', 'port', 'token', 'pid', 'processIdentity', 'startedAt', 'version', 'sha'])
            && port(record.port) && pid(record.pid) && timestamp(record.startedAt)
            && typeof record.version === 'string' && record.version.length > 0
            && (record.token === null || typeof record.token === 'string')
            && (record.sha === undefined || record.sha === null || typeof record.sha === 'string')
            && (record.processIdentity === undefined || record.processIdentity === null || typeof record.processIdentity === 'string')
            && url(record.httpUrl, ['http:', 'https:']);
        } else {
          valid = only(['url', 'appUrl', 'port', 'pid', 'startedAt']) && port(record.port)
            && pid(record.pid) && timestamp(record.startedAt) && (!match[2] || Number(match[2]) === record.port)
            && url(record.url, ['postgres:', 'postgresql:'], 'harness_admin')
            && (record.appUrl === undefined || url(record.appUrl, ['postgres:', 'postgresql:'], 'harness_app'));
        }
        if (!valid) continue;
        if (!operatorRoot) { operatorRoot = { id: `runtime-operator-${roots.length}`, path: directory }; roots.push(operatorRoot); }
        declarations.push({ kind: 'path', root: operatorRoot.id, name: entry.name,
          classification: match[1] === 'operator-port' ? 'config' : 'secret',
          producer: match[1] === 'embedded-pg-credentials' ? 'embedded-postgres-role-credentials' : 'operator-server-discovery' });
      } catch (error) {
        if (!(error instanceof SyntaxError) && !(error instanceof TypeError)
          && !['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      } finally { await handle?.close(); }
    }
  }
  // endpoint-ipc-discovery uses host-platform/home, including its override;
  // these advertisements and interrupted atomic writes describe live processes
  // and must be regenerated on the destination rather than transported.
  for (const directory of discoveryHomes) {
    try {
      if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== resolve(directory)) continue;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    let endpointRoot = roots.find(candidate => candidate.path === directory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const match = /^endpoint-ipc(?:\.(\d{1,5}))?\.json(?:\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp)?$/.exec(entry.name);
      if (!entry.isFile() || !match || (match[1] && (Number(match[1]) < 1 || Number(match[1]) > 65535))) continue;
      // An existing directory alone is not provenance for another census root.
      if (!endpointRoot) { endpointRoot = { id: `runtime-endpoint-${roots.length}`, path: directory }; roots.push(endpointRoot); }
      declarations.push({ kind: 'path', root: endpointRoot.id, name: entry.name,
        classification: 'cache', producer: 'endpoint-ipc-discovery' });
    }
  }
  // The desktop version reporter writes under shared_sidecar_home(), not
  // PAPERCUSP_HOME or the workspace registry. `home` is the sidecar's actual
  // HOME (including a baked channel subhome); also retain the GUI's real home.
  // Do not guess other channel homes from arbitrary directory names or env stamps.
  const desktopHome = environment.HOME ?? environment.USERPROFILE;
  for (const directory of new Set([ordinaryHome, ...(desktopHome === undefined ? [] : [resolve(desktopHome, '.papercusp')])])) {
    try { if (!(await lstat(directory)).isDirectory()) continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    let desktopRoot = roots.find(candidate => candidate.path === directory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (environment.HOME !== undefined && directory === resolve(environment.HOME, '.papercusp') && entry.name === 'desktop-build-target.json') {
        if (!desktopRoot) { desktopRoot = { id: `runtime-desktop-${roots.length}`, path: directory }; roots.push(desktopRoot); }
        declarations.push({ kind: 'path', root: desktopRoot.id, name: entry.name,
          classification: 'config', producer: 'desktop-env-switch-target' });
      }
      if (!/^desktop-app-version(?:-[^/\\:.\0]+)?\.json$/.test(entry.name)) continue;
      let handle;
      try {
        handle = await open(join(directory, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW);
        const metadata = await handle.stat();
        if (!metadata.isFile() || metadata.size > 64 * 1024) continue;
        const report = JSON.parse(await handle.readFile('utf8'));
        if (!report || typeof report.display !== 'string' || typeof report.version !== 'string' ||
          !Number.isSafeInteger(report.pid) || report.pid < 1 || !Number.isFinite(report.startedAtMs) ||
          typeof report.role !== 'string' || typeof report.isDev !== 'boolean') continue;
        const expected = report.display === '' ? 'desktop-app-version.json' :
          `desktop-app-version-${report.display.replaceAll(':', '').replaceAll('.', '_')}.json`;
        if (entry.name !== expected) continue;
        if (!desktopRoot) { desktopRoot = { id: `runtime-desktop-${roots.length}`, path: directory }; roots.push(desktopRoot); }
        declarations.push({ kind: 'path', root: desktopRoot.id, name: entry.name,
          classification: 'cache', producer: 'desktop-app-version-report' });
      } catch (error) {
        if (!(error instanceof SyntaxError) && !['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      } finally { await handle?.close(); }
    }
  }
  // sidecar-main resolves through host-platform/home, not the workspace
  // registry. Preserve the old default after relocation, the configured home,
  // and an explicit log override. Its writer retains exactly one rotation.
  const gatewayLogs = new Set([join(ordinaryHome, 'gateway.log'),
    join(papercuspHome(environment, home), 'gateway.log')]);
  if (environment.PAPERCUSP_GATEWAY_LOG) gatewayLogs.add(resolve(environment.PAPERCUSP_GATEWAY_LOG));
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
    { path: oauthStateKeyFilePath(), producer: 'oauth-state-signing-key' },
    { path: fleetClaudeTokenPath(), producer: 'fleet-claude-token' },
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
    { path: process.env.PAPERCUSP_CLOUD_PORTAL_HOSTED_ENV_FILE || join(config, 'papercusp', 'hosted-control-plane.env'), classification: 'secret' as const, producer: 'deploy-cloud-portal' },
    { path: process.env.PUI_PORTAL_LINKS_ENV || join(homedir(), '.config', 'papercusp', 'portal-public-links.env'), classification: 'config' as const, producer: 'publish-tui-release' },
  ];
  const roots: CensusRoot[] = [];
  const declarations: CensusDeclaration[] = [];
  for (const entry of paths) {
    let root = roots.find(candidate => candidate.path === dirname(entry.path));
    if (!root) { root = { id: `hosted-config-${roots.length}`, path: dirname(entry.path) }; roots.push(root); }
    declarations.push({ kind: 'path', root: root.id, name: basename(entry.path), classification: entry.classification, producer: entry.producer });
  }
  return { roots, declarations };
}

/** One measured historical writer dialect. Whole-program matching prevents a
 * later overwrite, reassignment or unrelated call from masquerading as proof.
 * Only the three AST-derived path/URL literals may vary; nothing is evaluated.
 */
const hostedProfileWriter = `import {readFileSync,writeFileSync,existsSync,statSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createCipheriv,scryptSync,randomBytes} from 'node:crypto';
import {hostname,userInfo} from 'node:os';
import {runInNewContext} from 'node:vm';
const fixture=resolve(userInfo().homedir,'FIXTURE');
const destination=resolve(userInfo().homedir,'DESTINATION');
if(existsSync(destination)) throw new Error('Destination exists: inspect before overwrite');
if((statSync(fixture).mode&0o777)!==0o600) throw new Error('Fixture must remain private');
const source=readFileSync('node_modules/verdict-cli/src/server.mjs','utf8');
const start=source.indexOf('const MACHINE_KEY =');
const end=source.indexOf('function decryptData',start);
const encrypt=runInNewContext(source.slice(start,end)+'\\nencryptData;', {hostname,userInfo,scryptSync,randomBytes,createCipheriv,Buffer});
const state=JSON.parse(readFileSync(fixture,'utf8'));
writeFileSync(destination,encrypt({cookies:state.cookies,storage:{localStorage:{},sessionStorage:{}},url:'URL',savedAt:new Date().toISOString()}),{mode:0o600,flag:'wx'});
console.log(JSON.stringify({profile:destination,mode:'0600',cookieCount:state.cookies.length,expirationPreserved:true,valuesPrinted:false}));`;

function sourceTokens(source: string, replacements = new Map<string, string>()) {
  const parsed = ts.createSourceFile('evidence.js', source, ts.ScriptTarget.Latest, true);
  const transformed = ts.transform(parsed, [context => node => {
    const visit: ts.Visitor = child => ts.isStringLiteral(child)
      ? ts.factory.createStringLiteral(replacements.get(child.text) ?? child.text)
      : ts.visitEachChild(child, visit, context);
    return ts.visitNode(node, visit) as ts.SourceFile;
  }]);
  const normalized = ts.createPrinter({ removeComments: true }).printFile(transformed.transformed[0]);
  transformed.dispose();
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, normalized);
  const tokens: string[] = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    const value = token === ts.SyntaxKind.StringLiteral ? scanner.getTokenValue() : scanner.getTokenText();
    tokens.push(JSON.stringify([token, value]));
  }
  return tokens.join('|');
}

export function historicalHostedProfileConstruction(toolInput: string, home = homedir()) {
  if (toolInput.length > 65_536) return null;
  const outer = ts.createSourceFile('tool.js', toolInput, ts.ScriptTarget.Latest, true);
  const commands: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(outer) === 'tools.exec_command' &&
      node.arguments.length === 1 && ts.isObjectLiteralExpression(node.arguments[0])) {
      for (const property of node.arguments[0].properties) {
        if (ts.isPropertyAssignment(property) && property.name.getText(outer) === 'cmd' && ts.isStringLiteralLike(property.initializer)) commands.push(property.initializer.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(outer);
  // A native exec input can batch the writer with a subsequent browser snapshot.
  // Select the supported quoted program, not the last cmd property in the AST.
  const candidates = commands.map(command => command.match(/^node --input-type=module <<'JS'\n([\s\S]*)\nJS$/)).filter(match => match !== null);
  if (candidates.length !== 1) return null;
  const match = candidates[0];
  const program = ts.createSourceFile('writer.js', match[1], ts.ScriptTarget.Latest, true);
  const literals = new Map<string, string>();
  for (const statement of program.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !['fixture', 'destination'].includes(declaration.name.text) ||
        !declaration.initializer || !ts.isCallExpression(declaration.initializer)) continue;
      const value = declaration.initializer.arguments[1];
      if (value && ts.isStringLiteralLike(value)) literals.set(declaration.name.text, value.text);
    }
  }
  let url: string | undefined;
  const findUrl = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(program) === 'url' && ts.isStringLiteralLike(node.initializer)) url = node.initializer.text;
    ts.forEachChild(node, findUrl);
  };
  findUrl(program);
  const fixture = literals.get('fixture');
  const destination = literals.get('destination');
  if (!fixture || !destination || !url || new Set([fixture, destination, url]).size !== 3) return null;
  if (commands.some(command => !command.match(/^node --input-type=module <<'JS'\n([\s\S]*)\nJS$/) &&
    (command.includes(fixture) || command.includes(destination)))) return null;
  const replacements = new Map([[fixture, 'FIXTURE'], [destination, 'DESTINATION'], [url, 'URL']]);
  if (sourceTokens(match[1], replacements) !== sourceTokens(hostedProfileWriter)) return null;
  // Historical evidence grants inspection of exact Papercusp configuration files,
  // not arbitrary paths mentioned in a transcript or linked destinations.
  const config = join(home, '.config', 'papercusp');
  const input = resolve(home, fixture);
  const output = resolve(home, destination);
  if (dirname(input) !== config || dirname(output) !== config || input === output) return null;
  return { input, output, url };
}

export interface HostedProfileWriterEvidence { ref: string; toolInput: string; startedAt: string; finishedAt: string }

// Archived call_dQMd66bJTVYVPiteJs6wlHg9, 2026-09-05. Only path literals vary.
// This program is evidence to parse, never a command to execute.
const playwrightStateWriter = String.raw`const { chromium }=require('./node_modules/@playwright/test');
const fs=require('fs');
const identity=JSON.parse(fs.readFileSync('IDENTITY','utf8'));
const password=fs.readFileSync('PASSWORD','utf8').trim();
const statePath='DESTINATION';
(async()=>{
  const browser=await chromium.launch({headless:true,proxy:{server:'socks5://127.0.0.1:18029'}});
  const c=await browser.newContext({serviceWorkers:'block'});const p=await c.newPage();
  await p.goto('https://app.papercusp.com/api/hosted/auth/sign-in?returnTo=%2Fcloud-workspaces',{waitUntil:'domcontentloaded',timeout:60000});
  for(let i=0;i<3;i++){
    const pw=p.locator('input[type=password],input[name=password]').first();if(await pw.isVisible().catch(()=>false))break;
    const em=p.locator('input[name=email],input[type=email]').first();await em.waitFor({state:'visible',timeout:30000});await em.fill(identity.email);
    await p.getByRole('button',{name:/continue with email|continue|sign in/i}).first().click();await p.waitForTimeout(2500);
  }
  const pw=p.locator('input[type=password],input[name=password]').first();await pw.waitFor({state:'visible',timeout:30000});await pw.fill(password);
  await p.getByRole('button',{name:/sign in|continue/i}).first().click();
  await p.waitForURL(u=>u.hostname==='app.papercusp.com'&&u.pathname!=='/api/hosted/auth/callback',{timeout:60000,waitUntil:'domcontentloaded'});
  const session=await p.evaluate(async()=>{const r=await fetch('/api/hosted/auth/session',{cache:'no-store'});const b=await r.json().catch(()=>null);return{status:r.status,ok:b?.ok===true,session:b?.session?{workspaceId:b.session.workspaceId??null,organizationId:b.session.organizationId??null,expiresAtMs:b.session.expiresAtMs??null,sessionVersion:b.session.sessionVersion??null}:null,error:b?.error??null}});
  await c.storageState({path:statePath});fs.chmodSync(statePath,0o600);const st=fs.statSync(statePath);
  console.log(JSON.stringify({final:{host:new URL(p.url()).host,path:new URL(p.url()).pathname},session,storageState:{path:statePath,mode:(st.mode&0o777).toString(8),bytes:st.size}},null,2));
  await browser.close();
})().catch(e=>{console.error(JSON.stringify({error:String(e),name:e?.name||null}));process.exit(1)});`;

// Exact inner program from SHA-verified codex archive 01a07742, line 614.
// Authentication metadata is a receipt, not a digest of the complete saved file.
const playwrightStateWriterSept6 = "const { chromium } = require('./node_modules/@playwright/test');\nconst fs = require('fs');\nconst crypto = require('crypto');\nconst identity = JSON.parse(fs.readFileSync('IDENTITY', 'utf8'));\nconst password = fs.readFileSync('PASSWORD', 'utf8').trim();\nconst statePath = 'DESTINATION';\n(async () => {\n  const startedAt = Date.now();\n  const browser = await chromium.launch({ headless: true, proxy: { server: 'socks5://127.0.0.1:18029' } });\n  try {\n    const context = await browser.newContext({ serviceWorkers: 'block' });\n    const page = await context.newPage();\n    await page.goto('https://app.papercusp.com/api/hosted/auth/sign-in?returnTo=%2Fcloud-workspaces', { waitUntil: 'domcontentloaded', timeout: 60000 });\n    const editableEmail = page.locator('input[name=email]:not([readonly]),input[type=email]:not([readonly])').first();\n    const passwordInput = page.locator('input[type=password],input[name=password]').first();\n    await Promise.race([editableEmail.waitFor({ state: 'visible', timeout: 30000 }), passwordInput.waitFor({ state: 'visible', timeout: 30000 })]);\n    if (await editableEmail.isVisible().catch(() => false)) {\n      await editableEmail.fill(identity.email);\n      await page.getByRole('button', { name: /continue with email|continue|sign in/i }).first().click();\n    }\n    await passwordInput.waitFor({ state: 'visible', timeout: 30000 });\n    await passwordInput.fill(password);\n    await page.getByRole('button', { name: /sign in|continue/i }).first().click();\n    await page.waitForURL((url) => url.hostname === 'app.papercusp.com', { timeout: 60000 });\n    let session = null;\n    for (let attempt = 0; attempt < 30; attempt += 1) {\n      const response = await context.request.get('https://app.papercusp.com/api/hosted/auth/session', { failOnStatusCode: false });\n      const body = await response.json().catch(() => null);\n      if (response.status() === 200 && body?.ok === true && body?.session?.sessionId && body?.session?.userId && body?.session?.organizationId) {\n        session = body.session;\n        break;\n      }\n      await page.waitForTimeout(1000);\n    }\n    if (!session) throw new Error('authenticated session metadata did not become available');\n    await context.storageState({ path: statePath });\n    fs.chmodSync(statePath, 0o600);\n    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));\n    const appCookie = saved.cookies.find((cookie) => cookie.name === '__Host-papercusp_session');\n    console.log(JSON.stringify({\n      ok: true,\n      statePath,\n      mode: (fs.statSync(statePath).mode & 0o777).toString(8),\n      sessionHash: crypto.createHash('sha256').update(session.sessionId).digest('hex').slice(0, 12),\n      userPresent: Boolean(session.userId),\n      organizationPresent: Boolean(session.organizationId),\n      workspaceBound: Boolean(session.workspaceId),\n      cookiePresent: Boolean(appCookie),\n      cookieExpires: appCookie?.expires ?? null,\n      durationMs: Date.now() - startedAt,\n    }));\n  } finally {\n    await browser.close();\n  }\n})().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });";

export function historicalPlaywrightStateConstruction(toolInput: string, home = homedir()) {
  if (toolInput.length > 65_536) return null;
  const outer = ts.createSourceFile('tool.js', toolInput, ts.ScriptTarget.Latest, true);
  const commands: string[] = [];
  // September 6 uses a top-level const and prints the terminal envelope. Resolve
  // that binding only for the complete measured wrapper, never arbitrary JS.
  const commandDeclaration = outer.statements[0];
  if (commandDeclaration && ts.isVariableStatement(commandDeclaration) &&
    (commandDeclaration.declarationList.flags & ts.NodeFlags.Const) !== 0 &&
    commandDeclaration.declarationList.declarations.length === 1) {
    const declaration = commandDeclaration.declarationList.declarations[0];
    if (ts.isIdentifier(declaration.name) && declaration.name.text === 'cmd' &&
      declaration.initializer && ts.isStringLiteral(declaration.initializer)) {
      const wrapper = `const cmd = 'COMMAND';
let r=await tools.exec_command({cmd,workdir:'WORKDIR',yield_time_ms:30000,max_output_tokens:3000});
while('session_id'in r&&!Object.prototype.hasOwnProperty.call(r,'exit_code'))r=await tools.write_stdin({session_id:r.session_id,chars:'',yield_time_ms:30000,max_output_tokens:3000});
text(r);`;
      if (sourceTokens(toolInput, new Map([[declaration.initializer.text, 'COMMAND'],
        [join(home, 'papercupai-workspace', 'papercusp'), 'WORKDIR']])) !== sourceTokens(wrapper)) return null;
      commands.push(declaration.initializer.text);
    }
  }
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(outer) === 'tools.exec_command' &&
      node.arguments.length === 1 && ts.isObjectLiteralExpression(node.arguments[0])) {
      for (const property of node.arguments[0].properties) {
        if (ts.isPropertyAssignment(property) && property.name.getText(outer) === 'cmd' && ts.isStringLiteralLike(property.initializer)) commands.push(property.initializer.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(outer);
  if (commands.length !== 1) return null;
  const match = commands[0].match(/^node - <<'NODE'\n([\s\S]*)\nNODE$/);
  if (!match) return null;
  const program = ts.createSourceFile('writer.js', match[1], ts.ScriptTarget.Latest, true);
  const paths = new Map<string, string>();
  const findPaths = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (node.name.text === 'statePath' && ts.isStringLiteral(node.initializer)) paths.set('DESTINATION', node.initializer.text);
      if (['identity', 'password'].includes(node.name.text)) {
        const literals: string[] = [];
        const findRead = (child: ts.Node) => {
          if (ts.isCallExpression(child) && child.expression.getText(program) === 'fs.readFileSync' &&
            child.arguments[0] && ts.isStringLiteral(child.arguments[0])) literals.push(child.arguments[0].text);
          ts.forEachChild(child, findRead);
        };
        findRead(node.initializer);
        if (literals.length === 1) paths.set(node.name.text.toUpperCase(), literals[0]);
      }
    }
    ts.forEachChild(node, findPaths);
  };
  findPaths(program);
  const output = paths.get('DESTINATION'); const identity = paths.get('IDENTITY'); const password = paths.get('PASSWORD');
  if (!output || !identity || !password || new Set(paths.values()).size !== 3 ||
    dirname(output) !== join(home, '.config', 'papercusp') ||
    !/^\/run\/user\/\d+\//.test(identity) || dirname(identity) !== dirname(password)) return null;
  const normalized = sourceTokens(match[1], new Map([...paths].map(([key, value]) => [value, key])));
  if (![playwrightStateWriter, playwrightStateWriterSept6].some(writer => normalized === sourceTokens(writer))) return null;
  return { output };
}

export interface PlaywrightStateWriterEvidence extends HostedProfileWriterEvidence { receipt: string; indexedRef?: string }

export interface IndexedCensusWriterEvidence extends HostedProfileWriterEvidence { sessionId: string }

/** Locate writers independently of receipt layout. An adjacent result is only
 * the legacy fallback timestamp; canonical archive recovery pairs by call_id.
 */
export async function readHistoricalCensusWriterCandidates(sql: Sql) {
  const candidates = await sql<IndexedCensusWriterEvidence[]>`
    SELECT 'session-part:' || writer.source_kind || ':' || writer.session_id || ':' || writer.part_idx AS ref,
      writer.session_id AS "sessionId", writer.text AS "toolInput", writer.ts::text AS "startedAt",
      COALESCE(receipt.ts::text, '') AS "finishedAt"
    FROM harness_shared.session_turn_parts writer
    LEFT JOIN harness_shared.session_turn_parts receipt
      ON receipt.workspace_id = writer.workspace_id AND receipt.source_kind = writer.source_kind
      AND receipt.session_id = writer.session_id AND receipt.part_idx = writer.part_idx + 1
      AND receipt.part_kind = 'tool_result'
    WHERE writer.workspace_id = 'default' AND writer.source_kind = 'codex' AND writer.part_kind = 'tool_use'
      AND (writer.text LIKE '%writeFileSync(destination,encrypt(%'
        OR (writer.text LIKE '%chromium%' AND writer.text LIKE '%statePath%')
        OR writer.text LIKE '%securewrite(%')
    ORDER BY writer.session_id, writer.part_idx
    LIMIT 101
  `;
  if (candidates.length > 100) throw new Error('Historical census evidence bound exceeded');
  return candidates;
}

/** Attest the complete measured Python dialect without executing archived code.
 * Only its three private path literals vary. The hash covers securewrite, test
 * account checks, result construction, the final write and printed receipt.
 */
export function historicalStripeConfigConstruction(toolInput: string, home = homedir()) {
  if (toolInput.length > 65_536) return null;
  const outer = ts.createSourceFile('tool.js', toolInput, ts.ScriptTarget.Latest, true);
  const commands: string[] = [];
  for (const statement of outer.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression) ||
      statement.expression.expression.getText(outer) !== 'text' || statement.expression.arguments.length !== 1) return null;
    const awaited = statement.expression.arguments[0];
    if (!ts.isAwaitExpression(awaited) || !ts.isCallExpression(awaited.expression)) return null;
    const call = awaited.expression;
    if (call.arguments.length !== 1 || !ts.isObjectLiteralExpression(call.arguments[0])) return null;
    const properties = call.arguments[0].properties;
    const literal = (name: string) => {
      const matches = properties.filter(property => ts.isPropertyAssignment(property) && property.name.getText(outer) === name);
      return matches.length === 1 && ts.isPropertyAssignment(matches[0]) && ts.isStringLiteralLike(matches[0].initializer)
        ? matches[0].initializer.text : null;
    };
    switch (call.expression.getText(outer)) {
      case 'tools.exec_command': {
        const command = literal('cmd');
        if (command === null) return null;
        commands.push(command);
        break;
      }
      case 'tools.write_stdin': if (literal('chars') !== '') return null; break;
      case 'tools.mcp__papercusp_su__tools_invoke':
        if (!['rubrics:propose', 'locks:acquire'].includes(literal('name') ?? '')) return null;
        break;
      default: return null;
    }
  }
  if (commands.length !== 1) return null;
  const program = commands[0].match(/^python3 - <<'PY'\n([\s\S]*)\nPY$/)?.[1];
  if (!program) return null;
  const key = program.match(/^key=Path\('([^'\n]+)'\)\.read_text\(\)\.strip\(\)$/m)?.[1];
  const secret = program.match(/^securewrite\('([^'\n]+)',hook\['secret'\]\+'\\n'\)$/m)?.[1];
  const output = program.match(/^securewrite\('([^'\n]+)',json\.dumps\(result,indent=2\
