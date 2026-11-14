---
rel_path: "portability/census/v40/01-state-census-producers.ts.part-002"
updated_at: 1794240912951
_body: "content"
---

ror as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !/^(?:\.mcp\.json(?:\.papercusp\.bak|\.su-parked)?|\.mcp\.json\.tmp-[1-9][0-9]*-[0-9]+-[0-9a-f]{12}|\.mcp\.json\.su-stub\.[1-9][0-9]*\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp)$/.test(entry.name)) continue;
      let handle;
      try {
        handle = await open(join(directory, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const metadata = await handle.stat();
        if (!metadata.isFile() || metadata.size > 65_536) continue;
        const config = JSON.parse(await handle.readFile('utf8'));
        if (!config || typeof config !== 'object' || Array.isArray(config)
          || Object.keys(config).length !== 1 || !config.mcpServers
          || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)) continue;
        const servers = Object.keys(config.mcpServers);
        if (servers.length !== 0) {
          if (servers.length !== 1 || servers[0] !== 'papercusp') continue;
          const server = config.mcpServers.papercusp;
          if (!server || typeof server !== 'object' || Array.isArray(server)
            || Object.keys(server).some(key => !['url', 'headers', 'type'].includes(key))
            || typeof server.url !== 'string' || (server.type !== undefined && server.type !== 'http')) continue;
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
  if (environment.PAPERCUSP_GATEWAY_LOG) gatewayLogs.add(r
