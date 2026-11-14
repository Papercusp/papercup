---
rel_path: "portability/census/v83-v80-v82/000-state-census-producers.ts.part-001"
updated_at: 1794268279628
_body: "content"
---

=> entry.root === root!.id && entry.name === name)) {
        declarations.push({ kind: 'path', root: root!.id, name, classification, producer });
      }
    };
    if (durable) add(basename(directory), 'state', 'account-link-cli-completed-home');
    add(`${prefix}${basename(path)}`);
    if (home) {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      // persistCodexAuth's exact atomic writer; do not read token contents.
      for (const entry of entries ?? []) {
        if (entry.isFile() && /^auth\.json\.[0-9]+\.tmp$/.test(entry.name)) add(`${prefix}${entry.name}`);
      }
      if (!durable) continue;
      const files = new Set((entries ?? []).filter(entry => entry.isFile()).map(entry => entry.name));
      // Codex rust-v0.167.0 state/src/sqlite.rs RuntimeDbSpec. Preserve the
      // database and its SQLite WAL/SHM companions together, never as cache.
      // Check only the bounded header; do not open a live database via SQLite
      // (even a read-only connection can create or mutate its shared memory).
      for (const database of ['state_5.sqlite', 'logs_2.sqlite', 'goals_1.sqlite', 'memories_1.sqlite',
        'memories_v2_1.sqlite', 'queue_1.sqlite', 'thread_history_1.sqlite']) {
        if (!files.has(database)) continue;
        let handle;
        try {
          handle = await open(join(directory, database), constants.O_RDONLY | constants.O_NOFOLLOW);
          if (!(await handle.stat()).isFile()) continue;
          const header = Buffer.alloc(16);
          const { bytesRead } = await handle.read(header, 0, header.length, 0);
          if (bytesRead !== header.length || header.toString('ascii') !== 'SQLite format 3\0') continue;
          add(`${prefix}${database}`, 'state', 'codex-sqlite-runtime');
          for (const suffix of ['-wal', '-shm']) if (files.has(`${database}${suffix}`)) {
            add(`${prefix}${database}${suffix}`, 'state', 'codex-sqlite-runtime');
          }
        } catch (error) {
          if (!['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        } finally { await handle?.close(); }
      }
      // core/src/installation_id.rs persists a UUID, with no newline required.
      if (files.has('installation_id')) {
        let handle;
        try {
          handle = await open(join(directory, 'installation_id'), constants.O_RDONLY | constants.O_NOFOLLOW);
          const info = await handle.stat();
          if (!info.isFile() || info.size > 128) continue;
          const value = (await handle.readFile('utf8')).trim();
          if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
            add(`${prefix}installation_id`, 'config', 'codex-installation-id');
          }
        } catch (error) {
          if (!['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        } finally { await handle?.close(); }
      }
    }
  }
  return { roots, declarations };
}

/** Resolve an installed CLI without executing its launcher or native helper. */
async function nativeCodexCli(selectedCli: string | null) {
  let nativeCodex: string | null = null;
  try {
    const cli = await realpath(selectedCli ?? '');
    const handle = await open(cli, 'r');
    let header: Buffer;
    try { header = Buffer.alloc(4); await handle.read(header, 0, 4, 0); }
    finally { await handle.close(); }
    if (header.subarray(0, 2).toString() !== '#!') nativeCodex = cli;
    else if (basename(cli) === 'codex.js') {
      const packageRoot = dirname(dirname(cli));
      const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
      if (manifest.name === '@openai/codex' && manifest.bin?.codex === 'bin/codex.js') {
        const cpu = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : null;
        const os = process.platform === 'linux' ? 'unknown-linux-musl' : process.platform === 'darwin' ? 'apple-darwin' : process.platform === 'win32' ? 'pc-windows-msvc' : null;
        if (cpu && os) {
          let vendor = join(packageRoot, 'vendor');
          try {
            const packageName = `@openai/codex-${process.platform}-${process.arch}`;
            const packageJson = createRequire(cli).resolve(`${packageName}/package.json`);
            // Node caches resolution paths; existence and identity must still
            // be checked after an optional package is removed or replaced.
            const optional = JSON.parse(await readFile(packageJson, 'utf8'));
            // npm aliases retain the published package's name. Bind that
            // identity to the owning CLI's exact dependency and target rather
            // than trusting either the alias directory or package name alone.
            const aliased = optional.name === '@openai/codex'
              && typeof optional.version === 'string' && optional.version.length > 0
              && manifest.optionalDependencies?.[packageName] === `npm:@openai/codex@${optional.version}`
              && Array.isArray(optional.os) && optional.os.length === 1 && optional.os[0] === process.platform
              && Array.isArray(optional.cpu) && optional.cpu.length === 1 && optional.cpu[0] === process.arch;
            if (optional.name !== packageName && !aliased) return null;
            vendor = join(dirname(packageJson), 'vendor');
          }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error; }
          nativeCodex = await realpath(join(vendor, `${cpu}-${os}`, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex'));
        }
      }
    }
    if (nativeCodex && !(await lstat(nativeCodex)).isFile()) nativeCodex = null;
  } catch { nativeCodex = null; } // Missing/unrecognized install leaves helpers visibly unclassified.
  return nativeCodex;
}

/** account-link-cli preserves completed setup homes when registration fails. */
export async function cliSetupHomeCensusProducer(path = papercuspRoot(), codexCli?: string | null) {
  const root: CensusRoot = { id: 'cli-setup-homes', path };
  const declarations: CensusDeclaration[] = [];
  let entries;
  try {
    if (!(await lstat(join(path, 'deploy-credentials'))).isDirectory()) return { roots: [root], declarations };
    entries = await readdir(join(path, 'deploy-credentials'), { withFileTypes: true });
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { roots: [root], declarations }; throw error; }
  // Keep explicit selection authoritative. Default discovery also proves older
  // npm installs: login-shell and operator PATHs may select different copies.
  let selectedCli = codexCli ?? null;
  if (codexCli === undefined) {
    try { selectedCli = (await import('../deployment/account-cli-bin')).resolveCliBin('codex'); }
    catch { /* Independently verified npm installs can still own their helpers. */ }
  }
  const nativeCodex = await nativeCodexCli(selectedCli);
  const installedTargets = new Map<string, boolean>();
  async function ownsHelper(target: string) {
    if (target === nativeCodex) return true;
    if (codexCli !== undefined) return false;
    if (!installedTargets.has(target)) {
      const boundaries = [
        `${sep}node_modules${sep}@openai${sep}codex${sep}`,
        `${sep}node_modules${sep}@openai${sep}codex-${process.platform}-${process.arch}${sep}`,
      ];
      // The package manifest and its actual optional/bundled native resolution
      // must agree with the target, including npm's sibling (hoisted) optional
      // package layout. A package-looking path alone proves nothing.
      let proven = false;
      for (const boundary of boundaries) {
        const offset = target.indexOf(boundary);
        if (offset < 0) continue;
        const launcher = join(target.slice(0, offset), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
        if (await nativeCodexCli(launcher) === target) { proven = true; break; }
      }
      installedTargets.set(target, proven);
    }
    return installedTargets.get(target)!;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\.(?:codex-)?setup-[A-Za-z0-9._-]+-[0-9a-f]{8}$/.test(entry.name)) continue;
    const name = `deploy-credentials/${entry.name}`;
    declarations.push({ kind: 'path', root: root.id, name, classification: 'state', producer: 'account-link-cli-setup-home' });
    const files = await readdir(join(path, name), { withFileTypes: true });
    if (!entry.name.startsWith('.codex-setup-')) {
      // account-link-cli selects CLAUDE_CONFIG_DIR for these homes. Claude's
      // config writer retains .claude.json and exact timestamped backup or
      // corruption copies under backups (including its legacy adjacent copy).
      // Config can embed MCP credentials: preserve every such copy as secret.
      const configCopy = /^\.claude\.json\.(?:backup|corrupted)\.[0-9]{13}$/;
      const addSecret = (file: string) => declarations.push({ kind: 'path', root: root.id,
        name: `${name}/${file}`, classification: 'secret', producer: 'claude-cli-setup-config' });
      for (const file of files) {
        if (file.isFile() && (file.name === '.claude.json' || file.name === '.claude.json.backup' || configCopy.test(file.name))) addSecret(file.name);
        if (file.name !== 'backups' || !file.isDirectory()) continue;
        declarations.push({ kind: 'path', root: root.id, name: `${name}/backups`,
          classification: 'state', producer: 'claude-cli-setup-config' });
        for (const backup of await readdir(join(path, name, 'backups'), { withFileTypes: true })) {
          if (backup.isFile() && configCopy.test(backup.name)) addSecret(`backups/${backup.name}`);
        }
      }
      continue;
    }
    if (files.some(file => file.name === 'auth.json' && file.isFile())) {
      declarations.push({ kind: 'path', root: root.id, name: `${name}/auth.json`, classification: 'secret', producer: 'account-link-cli-completed-login' });
    }
    // Installed Codex device-auth startup writes this exact log even when the
    // network request fails. Preserve it; neither foreign siblings nor tmp
    // descendants inherit ownership from the setup directory.
    if (files.some(file => file.name === 'log' && file.isDirectory())) {
      declarations.push({ kind: 'path', root: root.id, name: `${name}/log`, classification: 'state', producer: 'account-link-cli-device-auth-log' });
      const logs = await readdir(join(path, name, 'log'), { withFileTypes: true });
      if (logs.some(file => file.name === 'codex-login.log' && file.isFile())) {
        declarations.push({ kind: 'path', root: root.id, name: `${name}/log/codex-login.log`, classification: 'state', producer: 'account-link-cli-device-auth-log' });
      }
    }
    // Codex arg0 startup owns these exact directories and regular lock files.
    // Helper symlinks need separate executable identity proof; do not claim
    // them or arbitrary descendants merely because their parent is known.
    if (files.some(file => file.name === 'tmp' && file.isDirectory())) {
      const temporary = await readdir(join(path, name, 'tmp'), { withFileTypes: true });
      declarations.push({ kind: 'path', root: root.id, name: `${name}/tmp`, classification: 'cache', producer: 'codex-arg0-dispatch' });
      if (temporary.some(file => file.name === 'arg0' && file.isDirectory())) {
        const arg0 = `${name}/tmp/arg0`;
        declarations.push({ kind: 'path', root: root.id, name: arg0, classification: 'cache', producer: 'codex-arg0-dispatch' });
        for (const directory of await readdir(join(path, arg0), { withFileTypes: true })) {
          if (!directory.isDirectory() || !/^codex-arg0[A-Za-z0-9]{6}$/.test(directory.name)) continue;
          const session = `${arg0}/${directory.name}`;
          declarations.push({ kind: 'path', root: root.id, name: session, classification: 'cache', producer: 'codex-arg0-dispatch' });
          const children = await readdir(join(path, session), { withFileTypes: true });
          if (children.some(file => file.name === '.lock' && file.isFile())) {
            declarations.push({ kind: 'path', root: root.id, name: `${session}/.lock`, classification: 'cache', producer: 'codex-arg0-dispatch' });
          }
          for (const child of children) {
            if (!child.isSymbolicLink() || !['apply_patch', 'applypatch', 'codex-linux-sandbox', 'codex-execve-wrapper'].includes(child.name)) continue;
            try {
              if (await ownsHelper(await realpath(join(path, session, child.name)))) {
                declarations.push({ kind: 'path', root: root.id, name: `${session}/${child.name}`, classification: 'cache', producer: 'codex-arg0-dispatch' });
              }
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ELOOP') throw error; }
          }
        }
      }
    }
  }
  return { roots: [root], declarations };
}

/** Prove bytes against one source path's reachable Git history, never another path. */
export function historicalGitBlobIdentityResolver(repository: string) {
  const histories = new Map<string, Promise<Set<string>>>();
  return async (source: string, bytes: Buffer): Promise<boolean> => {
    const name = relative(repository, source).split(sep).join('/');
    if (!name || name === '..' || name.startsWith('../') || isAbsolute(name)) return false;
    let history = histories.get(name);
    if (!history) {
      history = (async () => {
        // Raw path-scoped changes contain the same regular-file blob identities
        // in one Git read, instead of one subprocess for every revision.
        const { stdout } = await execFileAsync('git', ['-C', repository, 'log', '--all', '--format=',
          '--raw', '--no-abbrev', '--no-renames', '-z', '--', name], { maxBuffer: 16 * 1024 * 1024 });
        const blobs = new Set<string>();
        const fields = stdout.split('\0');
        for (let index = 0; index + 1 < fields.length; index += 2) {
          const match = /^:\d{6} (100(?:644|755)) [0-9a-f]+ ([0-9a-f]+) [AMT]$/.exec(fields[index].trim());
          if (match && fields[index + 1] === name) blobs.add(match[2]);
        }
        return blobs;
      })();
      histories.set(name, history);
    }
    const hash = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    return (await history).has(hash);
  };
}

/** Installer/store metadata owns exact files, not arbitrary bundle descendants. */
export async function templateStoreCensusProducer(path = papercuspRoot(), expected: ReadonlyMap<string, string> = new Map(), historicalIdentity?: (source: string, bytes: Buffer) => Promise<boolean>) {
  const root: CensusRoot = { id: 'template-store', path };
  const declarations: CensusDeclaration[] = [];
  let entries;
  try { entries = await readdir(join(path, 'templates'), { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { roots: [root], declarations }; throw error; }
  const add = (name: string) => declarations.push({ kind: 'path', root: root.id, name, classification: 'state', producer: 'cupboard-installed-template-store' });
  add('templates');
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[A-Za-z0-9._-]+$/.test(entry.name)) continue;
    const name = `templates/${entry.name}`;
    const files = await readdir(join(path, name), { withFileTypes: true });
    // Historical Save Template wrote <slug>/<semver>/papercusp.json.
    // Validate its identity before declaring only the writer's exact metadata.
    if (/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(entry.name)) for (const version of files) {
      if (!version.isDirectory() || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version.name)) continue;
      const bundle = `${name}/${version.name}`;
      const children = await readdir(join(path, bundle), { withFileTypes: true });
      if (!children.some(child => child.name === 'papercusp.json' && child.isFile())) continue;
      let manifest;
      try { manifest = JSON.parse(await readFile(join(path, bundle, 'papercusp.json'), 'utf8')); }
      catch (error) { if (error instanceof SyntaxError) continue; throw error; }
      if (manifest?.name !== entry.name || manifest?.version !== version.name || manifest?.kind !== 'template') continue;
      if (!declarations.some(declaration => declaration.name === name)) add(name);
      add(bundle);
      for (const child of children) {
        if (child.isFile() && ['papercusp.json', 'SPEC.md', 'AGENTS.md', 'README.md', '.published.json'].includes(child.name)) add(`${bundle}/${child.name}`);
        if (child.name !== '.harness' || !child.isDirectory()) continue;
        add(`${bundle}/.harness`);
        for (const config of await readdir(join(path, bundle, '.harness'), { withFileTypes: true })) {
          if (config.isFile() && ['config.json', 'validation-contract.md'].includes(config.name)) add(`${bundle}/.harness/${config.name}`);
        }
      }
    }
    // install-template-core requires this manifest before copying into the store.
    if (!files.some(file => file.name === 'template.yaml' && file.isFile())) continue;
    add(name);
    for (const file of files) {
      if (file.isFile() && ['template.yaml', 'listing.json', 'GUIDE.md', 'COMPONENT_CATALOG.md'].includes(file.name)) add(`${name}/${file.name}`);
    }
    // The existing mirror map proves individual source identity. Never infer
    // ownership of a whole subtree from its manifest or installation receipt.
    for (const [mirrorName, source] of expected) {
      if (!mirrorName.startsWith(`${entry.name}/`)) continue;
      const parts = mirrorName.split('/');
      if (parts.some(part => !part || part === '.' || part === '..')) continue;
      let regular = true;
      for (let index = 1; index <= parts.length; index++) {
        try {
          const metadata = await lstat(join(path, 'templates', ...parts.slice(0, index)));
          if (index === parts.length ? !metadata.isFile() : !metadata.isDirectory()) { regular = false; break; }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error;
          regular = false; break;
        }
      }
      if (!regular) continue;
      const bytes = await readFile(join(path, 'templates', mirrorName));
      if (!bytes.equals(await readFile(source)) && !(await historicalIdentity?.(source, bytes))) continue;
      for (let index = 2; index <= parts.length; index++) {
        const installedName = `templates/${parts.slice(0, index).join('/')}`;
        if (!declarations.some(declaration => declaration.name === installedName)) add(installedName);
      }
    }
  }
  return { roots: [root], declarations };
}

/** Workspace homes use the same store writer, including homes no longer in the registry. */
export async function workspaceTemplateStoreCensusProducer(path = workspacesRoot(), expected: ReadonlyMap<string, string> = new Map(), historicalIdentity?: (source: string, bytes: Buffer) => Promise<boolean>) {
  const roots: CensusRoot[] = [];
  const declarations: CensusDeclaration[] = [];
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const home = join(path, entry.name, '.papercusp');
    try { if (!(await lstat(home)).isDirectory()) continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    const store = await templateStoreCensusProducer(home, expected, historicalIdentity);
    const id = `workspace-template-store:${entry.name}`;
    roots.push({ id, path: home });
    declarations.push(...store.declarations.map(declaration => ({ ...declaration, root: id })));
  }
  return { roots, declarations };
}

/** The plan-template writer owns its parsed manifest and storefront metadata only. */
export async function planTemplateStoreCensusProducer(path = papercuspRoot()) {
  const root: CensusRoot = { id: 'plan-template-store', path };
  const declarations: CensusDeclaration[] = [];
  let entries;
  try { entries = await readdir(join(path, 'plan-templates'), { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { roots: [root], declarations }; throw error; }
  const add = (name: string) => declarations.push({ kind: 'path', root: root.id, name, classification: 'state', producer: 'cupboard-plan-template-writer' });
  add('plan-templates');
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[A-Za-z0-9._-]+$/.test(entry.name)) continue;
    const name = `plan-templates/${entry.name}`;
    const files = await readdir(join(path, name), { withFileTypes: true });
    if (!files.some(file => file.name === 'plan.md' && file.isFile())) continue;
    // The shared installer reader rejects legacy/unstructured manifests.
    if (!readPlanTemplateDirForInstall(join(path, name), entry.name)) continue;
    add(name);
    for (const file of files) {
      if (file.isFile() && ['plan.md', 'listing.json'].includes(file.name)) add(`${name}/${file.name}`);
    }
  }
  return { roots: [root], declarations };
}

/** Exact runtime sidefile writers; siblings require separate provenance. */
export async function runtimeSidefileCensusProducer(home = homedir(), environment: NodeJS.ProcessEnv = process.env,
  workingDirectories: readonly string[] = [], runtimeHomes: readonly string[] = []) {
  const root: CensusRoot = { id: 'runtime-sidefiles', path: join(home, '.papercusp') };
  const roots = [root];
  const declarations: CensusDeclaration[] = [];
  // console-spawn preserves the displaced project config and writes an atomic
  // replacement; psu-launcher parks role configs before installing an empty
  // stub. They can contain bearer credentials, so retain them as secrets.
  // Only inspect explicit writer roots and exact names; arbitrary backups and
  // other MCP servers are not evidence of a Papercusp writer.
  for (const directory of new Set([root.path, papercuspHome(environment, home), ...workingDirectories])) {
    try {
      if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== resolve(directory)) continue;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
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
            || typeof server.url !== 'string' || (server.type !== undefined && server.type !== 'http
