---
rel_path: "portability/census/v83-v80-v82/000-state-census-producers.ts.part-002"
updated_at: 1794268279628
_body: "content"
---

')) continue;
          const url = new URL(server.url);
          if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/api/mcp'
            || !url.searchParams.get('workspace') || (url.searchParams.get('superuser') !== '1'
              && !['role', 'run', 'spawn', 'client', 'exp', 'sig'].every(key => url.searchParams.get(key)))) continue;
        }
        let mcpRoot = roots.find(candidate => candidate.path === directory);
        if (!mcpRoot) { mcpRoot = { id: `runtime-mcp-${roots.length}`, path: directory }; roots.push(mcpRoot); }
        declarations.push({ kind: 'path', root: mcpRoot.id, name: entry.name,
          classification: 'secret', producer: 'console-project-mcp-writer' });
      } catch (error) {
        if (!(error instanceof SyntaxError) && !(error instanceof TypeError)
          && !['ENOENT', 'ELOOP', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      } finally { await handle?.close(); }
    }
  }
  // Before console-spawn moved sentinels into scratch, its interactive shell
  // used `touch .papercup-console-active.$$` in the launch cwd (2b9578d44c^).
  // These empty process leases are regenerated on the destination. Do not
  // infer ownership of nonempty files, linked directories or neighboring data.
  for (const directory of new Set([root.path, papercuspHome(environment, home), ...workingDirectories])) {
    try { if (!(await lstat(directory)).isDirectory()) continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const match = /^\.papercup-console-active\.([1-9][0-9]{0,9})$/.exec(entry.name);
      if (!entry.isFile() || !match || Number(match[1]) > 2147483647) continue;
      let handle;
      try {
        handle = await open(join(directory, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const metadata = await handle.stat();
        if (!metadata.isFile() || metadata.size !== 0) continue;
        let consoleRoot = roots.find(candidate => candidate.path === directory);
        if (!consoleRoot) { consoleRoot = { id: `runtime-console-${roots.length}`, path: directory }; roots.push(consoleRoot); }
        declarations.push({ kind: 'path', root: consoleRoot.id, name: entry.name,
          classification: 'cache', producer: 'console-spawn-legacy-sentinel' });
      } catch (error) {
        if (!['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      } finally { await handle?.close(); }
    }
  }
  const pacingFile = 'google-vertex-gemini-3.1-pro-preview.json';
  for (const [directory, producer, files, classification] of [
    ['provider-pacing', 'omp-vertex-request-start', [pacingFile, `${pacingFile}.lock`], 'state'],
    ['template-gym', 'template-gym-runner', ['last-run.json', 'runs.jsonl'], 'state'],
    ['cache', 'tui-shared-query-cache', ['plans-list-standard-v1.json'], 'cache'],
    ['cache/bundle-free-refs', 'bundle-free-reference-analysis', [], 'cache'],
  ] as const) {
    let entries;
    try {
      if (!(await lstat(join(root.path, directory))).isDirectory()) continue;
      // A symlinked cache container cannot establish ownership of its target.
      if (directory.startsWith('cache/') && !(await lstat(join(root.path, 'cache'))).isDirectory()) continue;
      entries = await readdir(join(root.path, directory), { withFileTypes: true });
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
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
      if (name ===
