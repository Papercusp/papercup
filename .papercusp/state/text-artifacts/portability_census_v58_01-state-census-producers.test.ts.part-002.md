---
rel_path: "portability/census/v58/01-state-census-producers.test.ts.part-002"
updated_at: 1794252348729
_body: "content"
---

!entry.prune)).toBe(true);
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      expect(census.residue.map(entry => entry.name)).toEqual(expect.arrayContaining([
        'cache/unknown.json', 'cache/.plans-list-standard-v1.456.tmp',
        'cache/bundle-free-refs/unknown.json', `cache/bundle-free-refs/${'b'.repeat(64)}.json`,
        `cache/bundle-free-refs/${'c'.repeat(64)}.json`,
      ]));
      // A recognized directory name never licenses following a directory link.
      await rename(bundle, join(home, 'bundle-target'));
      await symlink(join(home, 'bundle-target'), bundle);
      expect((await runtimeSidefileCensusProducer(home, {})).declarations.some(entry => entry.name.startsWith('cache/bundle-free-refs'))).toBe(false);
      await rename(cache, join(home, 'cache-target'));
      await symlink(join(home, 'cache-target'), cache);
      expect((await runtimeSidefileCensusProducer(home, {})).declarations).toEqual([]);
      const writer = await readFile(new URL('../../../../scripts/check-bundle-free-refs.mjs', import.meta.url), 'utf8');
      expect(writer).toContain("join(homedir(), '.papercusp', 'cache', 'bundle-free-refs')");
      expect(writer).toContain('`${file}.${process.pid}.tmp`');
      const queryWriter = await readFile(new URL('../../../../apps/tui/src/shared_cache.rs', import.meta.url), 'utf8');
      expect(queryWriter).toContain('h.join(".papercusp").join("cache")');
      expect(queryWriter).toContain('format!(".{key}.{}.tmp", std::process::id())');
      expect(await readFile(new URL('../../../../apps/tui/src/client.rs', import.meta.url), 'utf8')).toContain('"plans-list-standard-v1"');
    } finally { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
  });
  it('retains exact project MCP writer files as secrets at explicit homes and workspace roots', async () => {
    const home = await mkdtemp(join(tmpdir(), 'project-mcp-census-'));
    const ordinary = join(home, '.papercusp');
    const relocated = join(home, 'relocated');
    const workspace = join(home, 'workspace', '.papercusp');
    const unknown = join(home, 'unknown');
    const linked = join(home, 'linked');
    const superuser = JSON.stringify({ mcpServers: { papercusp: {
      url: 'http://localhost:3070/api/mcp?superuser=1&workspace=fixture', headers: { Authorization: 'Bearer fixture' },
    } } });
    const role = JSON.stringify({ mcpServers: { papercusp: { type: 'http',
      url: 'https://operator.example/api/mcp?workspace=fixture&role=test&run=r&spawn=s&client=c&exp=1&sig=fixture',
    } } });
    const names = ['.mcp.json', '.mcp.json.papercusp.bak', '.mcp.json.su-parked',
      '.mcp.json.tmp-123-1234567890-aabbccddeeff', '.mcp.json.su-stub.123.12345678-1234-4234-8234-123456789abc.tmp'];
    try {
      for (const directory of [ordinary, relocated, workspace, unknown]) {
        await mkdir(directory, { recursive: true });
        for (const name of names) await writeFile(join(directory, name), name.includes('su-stub')
          ? JSON.stringify({ mcpServers: {} }) : name.endsWith('su-parked') ? role : superuser);
      }
      await symlink(workspace, linked);
      const result = await runtimeSidefileCensusProducer(home, { PAPERCUSP_HOME: relocated }, [workspace, workspace, linked]);
      const entries = result.declarations.filter(entry => entry.producer === 'console-project-mcp-writer');
      expect(entries).toHaveLength(names.length * 3);
      expect(entries.every(entry => entry.classification === 'secret' && !entry.descendants && !entry.prune)).toBe(true);
      expect(result.roots.map(root => root.path).sort()).toEqual([ordinary, relocated, workspace].sort());
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      expect(census.residue).toEqual([]);
      expect((await runtimeSidefileCensusProducer(home, {})).roots.map(root => root.path)).toEqual([ordinary]);
      const consoleWriter = await readFile(new URL('../console-spawn.ts', import.meta.url), 'utf8');
      const launcher = await readFile(new URL('../../../../apps/operator/scripts/psu-launcher.mjs', import.meta.url), 'utf8');
      expect(consoleWriter).toContain("'.mcp.json.papercusp.bak'");
      expect(consoleWriter).toContain('`.mcp.json.tmp-${process.pid}-${Date.now()}-${randomBytes(6).toString(\'hex\')}`');
      expect(launcher).toContain('".mcp.json.su-parked"');
      expect(launcher).toContain('`.mcp.json.su-stub.${process.pid}.${randomUUID()}.tmp`');
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it('leaves malformed, foreign, oversized and linked project MCP files in census residue', async () => {
    const home = await mkdtemp(join(tmpdir(), 'foreign-project-mcp-census-'));
    const workspace = join(home, 'workspace');
    const valid = JSON.stringify({ mcpServers: { papercusp: { url: 'http://localhost/api/mcp?superuser=1&workspace=fixture' } } });
    try {
      await mkdir(workspace);
      const unknownNames = ['.mcp.json.stale-role-bak-20260629-153755', '.mcp.json.pre-papercusp',
        '.mcp.json.tmp-123-1234567890-not-hex', '.mcp.json.su-stub.123.not-a-uuid.tmp'];
      for (const name of unknownNames) await writeFile(join(workspace, name), valid);
      await writeFile(join(workspace, '.mcp.json'), '{');
      await symlink(join(workspace, '.mcp.json'), join(workspace, '.mcp.json.papercusp.bak'));
      await mkdir(join(workspace, '.mcp.json.su-parked'));
      const directories: string[] = [];
      const bodies = [JSON.stringify({ mcpServers: { foreign: {} } }),
        valid.replace('/api/mcp?', '/other?'), valid.replace('superuser=1&', ''),
        valid.replace('http:', 'file:'), JSON.stringify({ mcpServers: { papercusp: { command: 'foreign' } } }),
        JSON.stringify({ mcpServers: [] }), JSON.stringify({ mcpServers: {}, unrelated: true }),
        valid + ' '.repeat(65_536)];
      for (const [index, body] of bodies.entries()) {
        const directory = join(home, `negative-${index}`); directories.push(directory);
        await mkdir(directory); await writeFile(join(directory, '.mcp.json'), body);
      }
      const parent = join(home, 'parent-link');
      await mkdir(join(home, 'real', 'child'), { recursive: true });
      await writeFile(join(home, 'real', 'child', '.mcp.json'), valid);
      await symlink(join(home, 'real'), parent);
      directories.push(join(parent, 'child'));
      const result = await runtimeSidefileCensusProducer(home, {}, [workspace, ...directories]);
      expect(result.declarations.filter(entry => entry.producer === 'console-project-mcp-writer')).toEqual([]);
      const census = await collectStateCensus({ roots: [{ id: 'workspace', path: workspace }],
        declarations: result.declarations, readCatalogs: async () => [] });
      expect(census.residue.map(entry => entry.name).sort()).toEqual([
        ...unknownNames, '.mcp.json', '.mcp.json.papercusp.bak', '.mcp.json.su-parked',
      ].sort());
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it('classifies empty legacy console leases only at explicit writer roots and preserves foreign residue', async () => {
    const home = await mkdtemp(join(tmpdir(), 'console-sentinel-census-'));
    const ordinary = join(home, '.papercusp');
    const relocated = join(home, 'relocated');
    const workspace = join(home, 'workspace', '.papercusp');
    const linked = join(home, 'linked');
    const marker = '.papercup-console-active.123';
    try {
      for (const directory of [ordinary, relocated, workspace]) {
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, marker), '');
      }
      const foreign = ['.papercup-console-active.0', '.papercup-console-active.01',
        '.papercup-console-active.2147483648', '.papercup-console-active.$',
        '.papercup-console-active.124', '.papercup-console-active.125', 'owner-data'];
      for (const name of foreign) await writeFile(join(workspace, name), name.endsWith('.124') ? 'retained data' : '');
      await rm(join(workspace, '.papercup-console-active.125'));
      await symlink(join(ordinary, marker), join(workspace, '.papercup-console-active.125'));
      await mkdir(join(workspace, 'nested'));
      await writeFile(join(workspace, 'nested', marker), '');
      await mkdir(join(workspace, '.papercup-console-active.126'));
      await symlink(workspace, linked);
      const result = await runtimeSidefileCensusProducer(home, { PAPERCUSP_HOME: relocated }, [workspace, workspace, linked]);
      const sentinels = result.declarations.filter(entry => entry.producer === 'console-spawn-legacy-sentinel');
      expect(sentinels).toHaveLength(3);
      expect(sentinels.every(entry => entry.name === marker && entry.classification === 'cache'
        && !entry.descendants && !entry.prune)).toBe(true);
      expect(result.roots.map(root => root.path).sort()).toEqual([ordinary, relocated, workspace].sort());
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      const workspaceRoot = result.roots.find(root => root.path === workspace)!.id;
      expect(census.inventory.find(entry => entry.root === workspaceRoot && entry.name === marker)?.classification).toBe('cache');
      expect(census.residue.filter(entry => entry.root === workspaceRoot).map(entry => entry.name).sort())
        .toEqual([...foreign, 'nested', `nested/${marker}`, '.papercup-console-active.126'].sort());
      expect((await runtimeSidefileCensusProducer(home, {})).roots.map(root => root.path)).toEqual([ordinary]);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it('censuses hook session records at default and relocated paths without owning foreign files or links', async () => {
    const home = await mkdtemp(join(tmpdir(), 'session-record-census-'));
    const ordinary = join(home, '.papercusp');
    const relocated = join(home, 'configured-home');
    const override = join(home, 'ledger-override');
    const advisory = join(ordinary, 'advisory-seen');
    const ledgers = [join(ordinary, 'artifact-url-ledger'), join(relocated, 'artifact-url-ledger'), override];
    try {
      vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(home, 'absent-mutex'));
      await mkdir(advisory, { recursive: true });
      await writeFile(join(advisory, 'nested-session_1'), 'adv-fixture');
      await writeFile(join(advisory, 'bad key'), 'foreign');
      await writeFile(join(advisory, 'x'.repeat(121)), 'foreign');
      await mkdir(join(advisory, 'copied-source'));
      await writeFile(join(advisory, 'copied-source', 'index.ts'), 'foreign');
      await symlink(join(advisory, 'nested-session_1'), join(advisory, 'linked-session'));
      const { ledgerPathFor, appendLedger } = await import('../../../../apps/operator/scripts/hooks/cc/artifact-url-delivery-guard.mjs');
      for (const directory of ledgers) {
        const path = ledgerPathFor('session /1', { PAPERCUSP_ARTIFACT_LEDGER_DIR: directory });
        appendLedger(path, ['fixture-artifact-id']);
        await writeFile(join(directory, 'unknown.json'), 'foreign');
        await writeFile(join(directory, `${'x'.repeat(121)}.ids`), 'foreign');
        await mkdir(join(directory, 'copied.ids'));
        await writeFile(join(directory, 'copied.ids', 'source.ts'), 'foreign');
        await symlink(path, join(directory, 'linked.ids'));
      }
      const environment = { PAPERCUSP_HOME: relocated, PAPERCUSP_ARTIFACT_LEDGER_DIR: override };
      const result = await runtimeSidefileCensusProducer(home, environment);
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      const state = census.inventory.filter(entry => entry.classification === 'state');
      expect(state.map(entry => entry.name).sort()).toEqual([
        'advisory-seen', 'advisory-seen/nested-session_1', 'artifact-url-ledger',
        'artifact-url-ledger/session__1.ids', 'session__1.ids', 'session__1.ids',
      ].sort());
      expect(result.declarations.every(entry => !entry.descendants && !entry.prune)).toBe(true);
      expect(census.residue.map(entry => entry.name)).toEqual(expect.arrayContaining([
        'advisory-seen/bad key', 'advisory-seen/linked-session', 'advisory-seen/copied-source/index.ts',
        'artifact-url-ledger/unknown.json', 'linked.ids', 'copied.ids/source.ts',
      ]));
      expect(await readFile(join(ledgers[0], 'session__1.ids'), 'utf8')).toBe('fixture-artifact-id\n');
      await rename(ledgers[0], join(home, 'ledger-target'));
      await symlink(join(home, 'ledger-target'), ledgers[0]);
      await rename(advisory, join(home, 'advisory-target'));
      await symlink(join(home, 'advisory-target'), advisory);
      await rename(override, join(home, 'override-target'));
      await symlink(join(home, 'override-target'), override);
      const linked = await runtimeSidefileCensusProducer(home, environment);
      expect(linked.declarations.some(entry => entry.name.startsWith('advisory-seen') || entry.name.startsWith('artifact-url-ledger'))).toBe(false);
      expect(linked.roots.some(entry => entry.path === override)).toBe(false);
      const writer = await readFile(new URL('../../../../apps/operator/scripts/hooks/cc/pretooluse-bash-resource-gate.sh', import.meta.url), 'utf8');
      expect(writer).toContain("return os.path.join(os.path.expanduser('~'), '.papercusp', 'advisory-seen')");
      expect(writer).toContain("return re.sub(r'[^A-Za-z0-9_.-]', '_', str(sid))[:120]");
    } finally { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
  });
  it('excludes exact endpoint advertisements across host relocation while exposing hostile neighbors', async () => {
    const home = await mkdtemp(join(tmpdir(), 'endpoint-census-'));
    const ordinary = join(home, '.papercusp');
    const relocated = join(home, 'isolated-host');
    const uuid = '12345678-1234-4123-8123-123456789abc';
    const names = ['endpoint-ipc.json', 'endpoint-ipc.3170.json', `endpoint-ipc.3170.json.${uuid}.tmp`];
    const unknown = ['endpoint-ipc.65536.json', 'endpoint-ipc.0.json', 'endpoint-ipc.foo.json',
      'endpoint-ipc.json.backup', 'endpoint-ipc.json.invalid.tmp', 'unproven.json'];
    try {
      for (const directory of [ordinary, relocated]) {
        await mkdir(directory);
        for (const name of [...names, ...unknown]) await writeFile(join(directory, name), 'process advertisement fixture');
        await symlink(join(directory, names[0]), join(directory, 'endpoint-ipc.3070.json'));
        await mkdir(join(directory, 'endpoint-ipc.4000.json'));
      }
      const result = await runtimeSidefileCensusProducer(home, { PAPERCUSP_HOME: relocated });
      const owned = result.declarations.filter(entry => entry.producer === 'endpoint-ipc-discovery');
      expect(owned).toHaveLength(6);
      expect(owned.every(entry => names.includes(entry.name) && entry.classification === 'cache' && !entry.descendants)).toBe(true);
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      expect(census.inventory.filter(entry => entry.classification === 'cache')).toHaveLength(6);
      for (const name of [...unknown, 'endpoint-ipc.3070.json', 'endpoint-ipc.4000.json']) {
        expect(census.residue.filter(entry => entry.name === name)).toHaveLength(2);
      }
      await rename(relocated, `${relocated}-target`);
      await symlink(`${relocated}-target`, relocated);
      expect((await runtimeSidefileCensusProducer(home, { PAPERCUSP_HOME: relocated })).declarations
        .filter(entry => entry.producer === 'endpoint-ipc-discovery')).toHaveLength(3);
      const writer = await readFile(new URL('../endpoint-ipc-discovery.ts', import.meta.url), 'utf8');
      for (const source of ['return papercuspHome()', "const REL_FILE = 'endpoint-ipc.json'",
        '`endpoint-ipc.${port}.json`', '`${path}.${randomUUID()}.tmp`']) expect(writer).toContain(source);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('classifies desktop process markers and durable target using their actual homes and display payloads', async () => {
    const home = await mkdtemp(join(tmpdir(), 'desktop-census-'));
    const real = join(home, 'real-user');
    const channel = join(real, '.papercusp-nightly');
    const override = join(home, 'host-override');
    const ordinary = join(real, '.papercusp');
    const channelState = join(channel, '.papercusp');
    const report = (display: string) => JSON.stringify({ version: '0.0.1', pid: 42, startedAtMs: 123,
      display, role: 'gui', isDev: false });
    try {
      for (const directory of [ordinary, channelState, override]) await mkdir(directory, { recursive: true });
      for (const directory of [ordinary, channelState]) {
        await writeFile(join(directory, 'desktop-app-version.json'), report(''));
        await writeFile(join(directory, 'desktop-app-version-110_0.json'), report(':110.0'));
        await writeFile(join(directory, 'desktop-app-version-foreign.json'), report(':other'));
        await writeFile(join(directory, 'desktop-app-version-invalid.json'), '{}');
        await writeFile(join(directory, 'desktop-build-target.json'), '{"name":"staging","port":3170}');
        await writeFile(join(directory, 'desktop-build-target.json.bak'), 'unknown');
        await symlink(join(directory, 'desktop-app-version.json'), join(directory, 'desktop-app-version-link.json'));
      }
      // PAPERCUSP_HOME does not relocate either Rust desktop writer.
      await writeFile(join(override, 'desktop-build-target.json'), 'unknown');
      await writeFile(join(override, 'desktop-app-version.json'), report(''));
      const result = await runtimeSidefileCensusProducer(channel, { HOME: real, PAPERCUSP_HOME: override });
      const reports = result.declarations.filter(entry => entry.producer === 'desktop-app-version-report');
      expect(reports).toHaveLength(4);
      expect(reports.every(entry => entry.classification === 'cache' && !entry.descendants)).toBe(true);
      const targets = result.declarations.filter(entry => entry.producer === 'desktop-env-switch-target');
      expect(targets).toHaveLength(1);
      expect(result.roots.find(root => root.id === targets[0].root)?.path).toBe(ordinary);
      expect(targets[0].classification).toBe('config');
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      for (const name of ['desktop-app-version-foreign.json', 'desktop-app-version-invalid.json',
        'desktop-app-version-link.json', 'desktop-build-target.json.bak']) expect(census.residue.some(entry => entry.name === name)).toBe(true);
      const fallback = await runtimeSidefileCensusProducer(channel, { USERPROFILE: real, PAPERCUSP_HOME: override });
      expect(fallback.declarations.filter(entry => entry.producer === 'desktop-app-version-report')).toHaveLength(4);
      expect(fallback.declarations.filter(entry => entry.producer === 'desktop-env-switch-target')).toHaveLength(0);
      const desktop = await readFile(new URL('../../../../papercusp-desktop/src-tauri/src/main.rs', import.meta.url), 'utf8');
      expect(desktop).toContain('let ver_path = workspaces::shared_sidecar_home()');
      expect(desktop).toContain('disp.replace(\':\', "").replace(\'.\', "_")');
      const workspaces = await readFile(new URL('../../../../papercusp-desktop/src-tauri/src/workspaces.rs', import.meta.url), 'utf8');
      expect(workspaces).toContain('home_for(real_home(), data_home_dir_name())');
      expect(workspaces).toContain('real.join(data_home_dir_name)');
      expect(workspaces).toContain('std::env::var("HOME")');
      expect(workspaces).toContain('std::env::var("USERPROFILE")');
      const target = await readFile(new URL('../../../../papercusp-desktop/src-tauri/src/env_switch.rs', import.meta.url), 'utf8');
      expect(target).toContain('let home = std::env::var_os("HOME")?');
      expect(target).toContain('.join(".papercusp/desktop-build-target.json")');
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('retains discovery in explicit workspace runtime homes without following links or claiming copied working directories', async () => {
    const home = await mkdtemp(join(tmpdir(), 'workspace-discovery-census-'));
    const active = join(home, 'active');
    const inactive = join(home, 'inactive');
    const copied = join(home, 'project');
    const linked = join(home, 'linked');
    const records = {
      'operator.json': { httpUrl: 'http://127.0.0.1:3170', port: 3170, token: 'fixture-bearer', pid: 123,
        startedAt: 1730000000000, version: '0.1.0' },
      'operator-port.json': { port: 3170, updatedAt: 1730000000000 },
      'endpoint-ipc.3170.json': {},
      'endpoint-ipc.json.2f8f5ba0-d4ba-4c88-8884-2f2a7969683a.tmp': {},
    };
    try {
      for (const directory of [join(home, '.papercusp'), active, inactive, copied]) {
        await mkdir(directory);
        for (const [name, record] of Object.entries(records)) await writeFile(join(directory, name), JSON.stringify(record));
        await writeFile(join(directory, 'operator.json.bak'), '{}');
        await writeFile(join(directory, 'endpoint-ipc.65536.json'), '{}');
      }
      await symlink(copied, linked);
      const result = await runtimeSidefileCensusProducer(home, { PAPERCUSP_HOME: active }, [copied],
        [active, inactive, inactive, linked]);
      for (const directory of [active, inactive]) {
        const root = result.roots.find(entry => entry.path === directory)!;
        const entries = result.declarations.filter(entry => entry.root === root.id);
        expect(entries.map(entry => entry.name).sort()).toEqual(Object.keys(records).sort());
        expect(entries.find(entry => entry.name === 'operator.json')).toMatchObject({ classification: 'secret' });
        expect(entries.find(entry => entry.name === 'operator-port.json')).toMatchObject({ classification: 'config' });
        expect(entries.filter(entry => entry.name.startsWith('endpoint-ipc')).every(entry => entry.classification === 'cache')).toBe(true);
      }
      expect(result.roots.some(entry => entry.path === linked || entry.path === copied)).toBe(false);
      expect(await readFile(join(inactive, 'operator.json'), 'utf8')).toBe(JSON.stringify(records['operator.json']));
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('retains validated operator discovery credentials and port memory across host-home relocation', async () => {
    const home = await mkdtemp(join(tmpdir(), 'operator-discovery-census-'));
    const ordinary = join(home, '.papercusp');
    const relocated = join(home, 'relocated');
    const cwd = join(home, 'project');
    const operator = { httpUrl: 'http://127.0.0.1:3170', port: 3170, token: 'test-bearer', pid: 123,
      processIdentity: 'test-boot:123', startedAt: 1730000000000, version: '0.1.0', sha: null };
    const pg = { url: 'postgresql://harness_admin:test@127.0.0.1:5432/harness',
      appUrl: 'postgresql://harness_app:test@127.0.0.1:5432/harness', port: 5432, pid: 123, startedAt: 1730000000000 };
    const credentials = { schemaVersion: 1, owner: 'a'.repeat(43), admin: 'b'.repeat(43), app: 'c'.repeat(43), zero: 'd'.repeat(43) };
    const records = { 'operator.json': operator, 'operator-port.json': { port: 3170, updatedAt: 1730000000000 },
      'embedded-pg.json': pg, 'embedded-pg.5432.json': pg, 'embedded-pg-credentials.json': credentials };
    try {
      for (const directory of [ordinary, relocated, cwd]) {
        await mkdir(directory);
        for (const [name, record] of Object.entries(records)) {
          await writeFile(join(directory, name), JSON.stringify(record));
          await writeFile(join(directory, `${name}.tmp.123`), JSON.stringify(record));
        }
      }
      const result = await runtimeSidefileCensusProducer(home, { PAPERCUSP_HOME: relocated }, [cwd]);
      const owned = result.declarations.filter(entry => ['operator-server-discovery', 'embedded-postgres-role-credentials'].includes(entry.producer));
      expect(owned).toHaveLength(20);
      expect(owned.filter(entry => entry.classification === 'secret')).toHaveLength(16);
      expect(owned.filter(entry => entry.classification === 'config')).toHaveLength(4);
      expect(owned.every(entry => !entry.descendants && !entry.prune)).toBe(true);
      expect(owned.every(entry => result.roots.find(root => root.id === entry.root)?.path !== cwd)).toBe(true);
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      expect(census.residue.filter(entry => entry.name.startsWith('operator') || entry.name.startsWith('embedded-pg'))).toEqual([]);
      expect(await readFile(join(relocated, 'embedded-pg-credentials.json'), 'utf8')).toBe(JSON.stringify(credentials));
      const writer = await readFile(new URL('../../../../apps/operator/bin/serve.ts', import.meta.url), 'utf8');
      expect(writer).toContain('const PAPERCUSP_DIR = papercuspHome()');
      expect(writer).toContain('`embedded-pg.${pg.port}.json`');
      expect(writer).toContain('const tmp = `${path}.tmp.${process.pid}`');
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('leaves foreign, malformed, mismatched, oversized and linked operator records unresolved', async () => {
    const home = await mkdtemp(join(tmpdir(), 'operator-discovery-invalid-'));
    const ordinary = join(home, '.papercusp');
    const linked = join(home, 'linked');
    const pg = { url: 'postgresql://harness_admin:test@127.0.0.1:5432/harness', port: 5432, pid: 123, startedAt: 1730000000000 };
    const invalid = {
      'operator.json': { httpUrl: 'https://foreign.example:3170', port: 3070, token: 'bearer', pid: 123, startedAt: 1, version: '1' },
      'operator-port.json': { port: 3170, updatedAt: 1, foreign: true },
      'embedded-pg.json': { ...pg, url: 'file:///foreign' },
      'embedded-pg.5433.json': pg,
      'embedded-pg.65536.json': pg,
      'embedded-pg-credentials.json': { owner: 'short', admin: 'short', app: 'short', zero: 'short' },
      'embedded-pg-credentials.json.tmp.123': { schemaVersion: 2, owner: 'a'.repeat(43), admin: 'b'.repeat(43), app: 'c'.repeat(43), zero: 'd'.repeat(43) },
      'operator-port.json.tmp.0': { port: 3170, updatedAt: 1 },
      'operator-port.json.tmp.2147483648': { port: 3170, updatedAt: 1 },
      'operator-port.json.bak': { port: 3170, updatedAt: 1 },
      'embedded-pg.5440.json': { ...pg, port: 5440 },
    };
    try {
      await mkdir(ordinary);
      for (const [name, record] of Object.entries(invalid)) await writeFile(join(ordinary, name), JSON.stringify(record));
      await writeFile(join(ordinary, 'operator.json.tmp.123'), '{');
      await writeFile(join(ordinary, 'operator-port.json.tmp.124'), ' '.repeat(65_537));
      await symlink(join(ordinary, 'operator-port.json'), join(ordinary, 'operator-port.json.tmp.125'));
      await mkdir(join(ordinary, 'embedded-pg.5432.json'));
      await symlink(ordinary, linked);
      const result = await runtimeSidefileCensusProducer(home, { PAPERCUSP_HOME: linked });
      expect(result.declarations.some(entry => ['operator-server-discovery', 'embedded-postgres-role-credentials'].includes(entry.producer))).toBe(false);
      expect(result.roots.some(root => root.path === linked)).toBe(false);
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      expect(census.residue.map(entry => entry.name)).toEqual(expect.arrayContaining(Object.keys(invalid)));
      expect(await readFile(join(ordinary, 'operator.json.tmp.123'), 'utf8')).toBe('{');
      await rename(ordinary, join(home, 'target'));
      await symlink(join(home, 'target'), ordinary);
      expect((await runtimeSidefileCensusProducer(home, {})).declarations
        .some(entry => ['operator-server-discovery', 'embedded-postgres-role-credentials'].includes(entry.producer))).toBe(false);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('retains host gateway logs and one rotation across relocation without trusting workspace names or links', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gateway-log-census-'));
    const ordinary = join(home, '.papercusp');
    const relocated = join(home, 'relocated');
    const override = join(home, 'override', 'lifecycle.txt');
    const logs = [join(ordinary, 'gateway.log'), join(relocated, 'gateway.log'), override];
    const environment = { PAPERCUSP_HOME: relocated, PAPERCUSP_GATEWAY_LOG: override };
    try {
      for (const directory of [ordinary, relocated, join(home, 'override')]) await mkdir(directory);
      for (const log of logs) {
        await writeFile(log, 'retained gateway lifecycle');
        await writeFile(`${log}.1`, 'retained gateway rotation');
        await writeFile(`${log}.2`, 'unproven sibling');
      }
      const result = await runtimeSidefileCensusProducer(home, environment);
      const declarations = result.declarations.filter(entry => entry.producer === 'inference-gateway-lifecycle-log');
      expect(declarations).toHaveLength(6);
      expect(declarations.every(entry => entry.classification === 'state' && !entry.descendants && !entry.prune)).toBe(true);
      expect(result.roots.find(root => root.path === join(home, 'override'))?.fileNames?.sort())
        .toEqual(['lifecycle.txt', 'lifecycle.txt.1']);
      const merged = mergeNestedCensusRoots({ roots: [...result.roots, { id: 'relocated', path: relocated }],
        declarations: result.declarations });
      const census = await collectStateCensus({ ...merged, readCatalogs: async () => [] });
      expect(census.inventory.filter(entry => entry.classification === 'state')).toHaveLength(6);
      expect(census.residue.map(entry => entry.name)).toEqual(['gateway.log.2', 'gateway.log.2']);
      expect(await readFile(override, 'utf8')).toBe('retained gateway lifecycle');
      await rm(override);
      await symlink(`${override}.1`, override);
      await rename(relocated, join(home, 'relocated-target'));
      await symlink(join(home, 'relocated-target'), relocated);
      const linked = await runtimeSidefileCensusProducer(home, environment);
      const owned = linked.declarations.filter(entry => entry.producer === 'inference-gateway-lifecycle-log');
      expect(owned).toHaveLength(3);
      expect(owned.filter(entry => entry.name.startsWith('lifecycle'))).toEqual([
        expect.objectContaining({ name: 'lifecycle.txt.1' }),
      ]);
      const writer = await readFile(new URL('../inference-gateway/sidecar-main.ts', import.meta.url), 'utf8');
      expect(writer).toContain("import { papercuspPath } from '@papercusp/host-platform/home'");
      expect(writer).toContain("process.env.PAPERCUSP_GATEWAY_LOG || papercuspPath('gateway.log')");
      expect(writer).toContain('const rotatedPath = `${path}.1`');
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('retains backup-health writer histories and exact configured markers while exposing unknown files and links', async () => {
    const home = await mkdtemp(join(tmpdir(), 'backup-health-census-'));
    const ordinary = join(home, '.papercusp', 'backup-health');
    const override = join(home, 'health-override');
    try {
      vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(home, 'absent-mutex'));
      const owned = ['db-disk-history', 'db-disk-history.tmp', 'backup-volume-history', 'backup-volume-history.tmp',
        'db-disk-red-ei-filed', 'db-relation-bloat-ei-filed', 'backup-volume-red-ei-filed',
        'workspace-dead-dump-tmp', 'consecutive-fails', 'stale-tmp', 'stale-pg-papercusp-state',
        'missing-pg-restart', 'tmpdir-entries-red-tmp', 'tmpdir-entries-red-tmp-pcv'];
      for (const directory of [ordinary, override]) {
        await mkdir(directory, { recursive: true });
        for (const name of [...owned, 'missing-pg-custom', 'stale--scratch-dump.sql', 'tmpdir-entries-red-scratch---',
          'unknown.json', 'stale-pg-foreign', 'tmpdir-entries-red-foreign']) await writeFile(join(directory, name), 'baseline');
        await mkdir(join(directory, 'copied-source'));
        await writeFile(join(directory, 'copied-source', 'index.ts'), 'foreign');
        await symlink(join(directory, 'db-disk-history'), join(directory, 'missing-pg-papercusp-state'));
      }
      const defaults = await runtimeSidefileCensusProducer(home, {});
      expect(defaults.roots.some(root => root.path === override)).toBe(false);
      expect(defaults.declarations.filter(entry => entry.producer === 'backup-health-probe').map(entry => entry.name).sort())
        .toEqual(['backup-health', ...owned.map(name => `backup-health/${name}`)].sort());
      const environment = { BACKUP_STATE_DIR: override, BACKUP_ARTIFACTS: 'pg/custom',
        BACKUP_OPTIONAL_ARTIFACTS: '/scratch/dump.sql /unexpanded/*/dump.sql', BACKUP_TMPDIR_WATCH: '/scratch/é' };
      const result = await runtimeSidefileCensusProducer(home, environment);
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      const classified = census.inventory.filter(entry => entry.producers.includes('backup-health-probe'));
      expect(classified.every(entry => entry.classification === 'state')).toBe(true);
      expect(classified.map(entry => entry.name)).toEqual(expect.arrayContaining([
        'backup-health/missing-pg-custom', 'backup-health/stale--scratch-dump.sql', 'backup-health/tmpdir-entries-red-scratch---',
        'missing-pg-custom', 'stale--scratch-dump.sql', 'tmpdir-entries-red-scratch---',
      ]));
      expect(census.residue.map(entry => entry.name)).toEqual(expect.arrayContaining([
        'backup-health/unknown.json', 'backup-health/stale-pg-foreign', 'backup-health/tmpdir-entries-red-foreign',
        'backup-health/missing-pg-papercusp-state', 'backup-health/copied-source/index.ts',
        'unknown.json', 'stale-pg-foreign', 'tmpdir-entries-red-foreign', 'copied-source/index.ts',
      ]));
      expect(result.declarations.filter(entry => entry.producer === 'backup-health-probe')
        .every(entry => !entry.descendants && !entry.prune)).toBe(true);
      expect(await readFile(join(ordinary, 'db-disk-history'), 'utf8')).toBe('baseline');
      for (const [directory, target] of [[ordinary, join(home, 'ordinary-target')], [override, join(home, 'override-target')]]) {
        await rename(directory, target);
        await symlink(target, directory);
      }
      const linked = await runtimeSidefileCensusProducer(home, environment);
      expect(linked.declarations.some(entry => entry.producer === 'backup-health-probe')).toBe(false);
      expect(linked.roots.some(root => root.path === override)).toBe(false);
      const writer = await readFile(new URL('../../../../apps/operator/scripts/papercup-backup-health-check.sh', import.meta.url), 'utf8');
      expect(writer).toContain('STATE_DIR="${BACKUP_STATE_DIR:-$HOME/.papercusp/backup-health}"');
      for (const name of owned.slice(0, 10).filter(name => !name.endsWith('.tmp'))) expect(writer).toContain(name);
      expect(writer).toContain('"$hist.tmp"');
      expect(writer).toContain("tr -c 'A-Za-z0-9' '-'");
    } finally { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
  });
  it('keeps Kopia alert state independent of backup probe relocation and rejects unowned neighbors and links', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kopia-health-census-'));
    const ordinary = join(home, '.papercusp', 'backup-health');
    const probe = join(home, 'probe');
    const kopia = join(home, 'kopia');
    try {
      vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(home, 'absent-mutex'));
      for (const directory of [ordinary, probe, kopia]) {
        await mkdir(join(directory, 'copied-source'), { recursive: true });
        await writeFile(join(directory, 'last-alert'), '1730000000\n');
        await writeFile(join(directory, 'db-disk-history'), 'baseline');
        await writeFile(join(directory, 'last-alert.tmp'), 'foreign');
        await writeFile(join(directory, 'copied-source', 'index.ts'), 'foreign');
      }
      const environment = { BACKUP_STATE_DIR: probe, HEALTHCHECK_STATE_DIR: kopia,
        PAPERCUSP_HOME: join(home, 'unrelated-home') };
      const result = await runtimeSidefileCensusProducer(home, environment);
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      expect(census.inventory.filter(entry => entry.producers.includes('kopia-healthcheck'))
        .every(entry => entry.classification === 'state')).toBe(true);
      expect(result.declarations.filter(entry => entry.producer === 'kopia-healthcheck').map(entry => entry.name).sort())
        .toEqual(['backup-health', 'backup-health/last-alert', 'last-alert']);
      const rootFor = (path: string) => result.roots.find(root => root.path === path)!.id;
      expect(census.residue).toEqual(expect.arrayContaining([
        expect.objectContaining({ root: rootFor(probe), name: 'last-alert' }),
        expect.objectContaining({ root: rootFor(kopia), name: 'db-disk-history' }),
        expect.objectContaining({ root: rootFor(kopia), name: 'last-alert.tmp' }),
        expect.objectContaining({ root: rootFor(kopia), name: 'copied-source/index.ts' }),
      ]));
      expect(result.declarations.filter(entry => entry.producer === 'kopia-healthcheck')
        .every(entry => !entry.descendants && !entry.prune)).toBe(true);
      const shared = await runtimeSidefileCensusProducer(home, { BACKUP_STATE_DIR: kopia, HEALTHCHECK_STATE_DIR: kopia });
      expect(shared.roots.filter(root => root.path === kopia)).toHaveLength(1);
      const sharedCensus = await collectStateCensus({ ...shared, readCatalogs: async () => [] });
      expect(sharedCensus.residue.some(entry => entry.root === shared.roots.find(root => root.path === kopia)!.id
        && ['last-alert', 'db-disk-history'].includes(entry.name))).toBe(false);
      expect(await readFile(join(kopia, 'last-alert'), 'utf8')).toBe('1730000000\n');
      await rm(join(kopia, 'last-alert'));
      await symlink(join(probe, 'last-alert'), join(kopia, 'last-alert'));
      const linkedFile = await runtimeSidefileCensusProducer(home, environment);
      expect(linkedFile.declarations.some(entry => entry.producer === 'kopia-healthcheck'
        && entry.name === 'last-alert')).toBe(false);
      for (const directory of [ordinary, kopia]) {
        await rename(directory, `${directory}-target`);
        await symlink(`${directory}-target`, directory);
      }
      const linkedDirectories = await runtimeSidefileCensusProducer(home, environment);
      expect(linkedDirectories.declarations.some(entry => entry.producer === 'kopia-healthcheck')).toBe(false);
      expect(linkedDirectories.roots.some(root => root.path === kopia)).toBe(false);
      const writer = await readFile(new URL('../../../../apps/operator/scripts/systemd/kopia-healthcheck.sh', import.meta.url), 'utf8');
      expect(writer).toContain('HEALTHCHECK_STATE_DIR="${HEALTHCHECK_STATE_DIR:-$HOME/.papercusp/backup-health}"');
      expect(writer).toContain('local marker="$HEALTHCHECK_STATE_DIR/last-alert"');
      expect(writer).toContain('echo "$now" > "$marker"');
    } finally { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
  });
  it('uses actual default and relocated co-change/model cache writers without following links or owning neighbors', async () => {
    const home = await mkdtemp(join(tmpdir(), 'host-cache-census-'));
    const ordinary = join(home, '.papercusp');
    const relocated = join(home, 'configured-home');
    try {
      vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(home, 'absent-mutex'));
      for (const base of [ordinary, relocated]) {
        const snapshots = join(base, 'cache', 'cochange-index');
        await mkd
