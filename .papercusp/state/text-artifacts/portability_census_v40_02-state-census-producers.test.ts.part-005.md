---
rel_path: "portability/census/v40/02-state-census-producers.test.ts.part-005"
updated_at: 1794240912951
_body: "content"
---

,
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
    const o
