---
rel_path: "portability/census/v40/03-state-census-cli.test.ts.part-001"
updated_at: 1794240916945
_body: "content"
---

ith('unproven.json'))).toBe(true);
      expect(report.inventory.find(entry => entry.name === 'spills')?.classification).toBe('cache');
      expect(report.inventory.some(entry => entry.name.startsWith('spills/'))).toBe(false);
      expect(report.inventory.find(entry => entry.name === '.papercusp/fs-mutex-locks')?.classification).toBe('cache');
      expect(report.wholeInstallVerified).toBe(false);
      expect(stages[0]).toBe('installed-roots');
      expect(stages.at(-1)).toBe('complete');
      expect(stages).toContain('collect-state-census');
      expect(stages).not.toContain('host-catalogs');
      const inputs = JSON.parse(JSON.stringify(await discoverRootCensusInputs({
        checkpointLogDir: join(fixtureHome, 'checkpoint-history'), historicalWriterEvidence: evidence,
      })));
      expect(inputs).not.toHaveProperty('ok');
      const staged = await collectStateCensus({ roots: inputs.roots, declarations: inputs.declarations,
        readCatalogs: async () => inputs.catalogEntries, representUnknownSubtrees: true });
      expect(staged.inventory).toEqual(report.inventory);
      expect(staged.residue).toEqual(report.residue);
    } finally {
      producer.mockRestore(); rmSync(owned, { force: true }); rmSync(unknown, { force: true });
      rmSync(registry, { recursive: true, force: true });
      rmSync(spills, { recursive: true, force: true });
      rmSync(mutex, { recursive: true, force: true });
    }
  });
  it('retains inactive workspace runtime state without owning copied foreign files or unregistered homes', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'workspace-setup-census-'));
    try {
      const active = join(parent, 'active');
      const inactive = join(parent, 'inactive');
      const unregistered = join(parent, 'unregistered');
      const name = 'deploy-credentials/.codex-setup-account-1234abcd';
      for (const home of [active, inactive, unregistered]) {
        mkdirSync(join(home, name), { recursive: true });
        writeFileSync(join(home, name, 'auth.json'), 'opaque');
        writeFileSync(join(home, name, 'foreign-source.ts'), 'foreign');
        writeFileSync(join(home, 'deploy-credentials', 'unreferenced.json'), 'unproven credential');
        mkdirSync(join(home, 'crash-reports'), { recursive: true });
        writeFileSync(join(home, 'crash-reports', 'report.json'), 'retained diagnostic');
        mkdirSync(join(home, 'snapshot-fold-checkpoints', 'nested'), { recursive: true });
        writeFileSync(join(home, 'snapshot-fold-checkpoints', 'nested', 'checkpoint.json'), 'retained checkpoint');
        writeFileSync(join(home, 'foreign-source.ts'), 'unrelated sibling');
      }
      const result = await readWorkspaceSetupHomes([{ id: 'active' }, { id: 'inactive' }, { id: 'inactive' }],
        workspace => join(parent, workspace), active, parent);
      expect(result.roots.map(root => root.path)).toEqual([active, inactive]);
      expect(result.roots.some(root => root.path === unregistered)).toBe(false);
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      for (const root of result.roots) {
        const inventory = census.inventory.filter(entry => entry.root === root.id);
        expect(inventory.filter(entry => entry.classification === 'state').map(entry => entry.name).sort())
          .toEqual(['deploy-credentials', name, 'crash-reports', 'crash-reports/report.json',
            'snapshot-fold-checkpoints', 'snapshot-fold-checkpoints/nested',
            'snapshot-fold-checkpoints/nested/checkpoint.json'].sort());
        expect(inventory.filter(entry => entry.classification === 'secret').map(entry => entry.name))
          .toEqual([`${name}/auth.json`]);
        expect(census.residue.filter(entry => entry.root === root.id).map(entry => entry.name).sort())
          .toEqual([`${name}/foreign-source.ts`, 'deploy-credentials/unreferenced.json', 'foreign-source.ts'].sort());
      }
      expect(result.declarations.every(entry => !entry.prune)).toBe(true);
      expect(result.declarations.filter(entry => entry.descendants).map(entry => entry.name))
        .toEqual(['crash-reports', 'snapshot-fold-checkpoints', 'crash-reports', 'snapshot-fold-checkpoints']);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });

  it('includes the legacy default writer home without registering arbitrary sibling homes', async () => {
    const registry = join(fixtureHome, 'registry');
    const legacy = join(registry, 'default', '.papercusp');
    const foreign = join(registry, 'unregistered', '.papercusp');
    const marker = '.papercup-console-active.123';
    try {
      for (const directory of [legacy, foreign]) {
        mkdirSync(join(directory, 'crash-reports'), { recursive: true });
        writeFileSync(join(directory, marker), '');
        writeFileSync(join(directory, 'crash-reports', 'report.json'), 'retained diagnostic');
        writeFileSync(join(directory, 'foreign-source.ts'), 'unrelated sibling');
      }
      writeFileSync(join(legacy, '.papercup-console-active.124'), 'retained data');
      for (const directory of [legacy, foreign]) {
        writeFileSync(join(directory, 'endpoint-ipc.3170.json'), '{}');
        writeFileSync(join(directory, 'operator-port.json'), JSON.stringify({ port: 3170, updatedAt: 1730000000000 }));
      }
      const report = await runRootCensus({ checkpointLogDir: join(fixtureHome, 'checkpoint-history') });
      expect(report.inventory.find(entry => entry.name.endsWith(`default/.papercusp/${marker}`)))
        .toMatchObject({ classification: 'cache', producers: ['console-spawn-legacy-sentinel'] });
      expect(report.inventory.find(entry => entry.name.endsWith('default/.papercusp/crash-reports/report.json')))
        .toMatchObject({ classification: 'state', producers: ['fatal-diagnostics'] });
      expect(report.inventory.find(entry => entry.name.endsWith('default/.papercusp/endpoint-ipc.3170.json')))
        .toMatchObject({ classification: 'cache', producers: ['endpoint-ipc-discovery'] });
      expect(report.inventory.find(entry => entry.name.endsWith('default/.papercusp/operator-port.json')))
        .toMatchObject({ classification: 'config', producers: ['operator-server-discovery'] });
      expect(report.residue.some(entry => entry.name.endsWith('default/.papercusp/foreign-source.ts'))).toBe(true);
      expect(report.residue.some(entry => entry.name.endsWith('default/.papercusp/.papercup-console-active.124'))).toBe(true);
      expect(report.inventory.filter(entry => entry.name.includes('unregistered') && entry.classification)).toEqual([]);
      expect(report.wholeInstallVerified).toBe(false);
    } finally { rmSync(registry, { recursive: true, force: true }); }
  });

  it('does not follow a linked legacy default writer home or invent an absent one', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'legacy-workspace-census-'));
    const active = join(parent, 'active');
    const legacy = join(parent, 'default');
    const foreign = join(parent, 'foreign');
    const resolveRoot = (workspace: string) => join(parent, workspace);
    try {
      mkdirSync(active);
      mkdirSync(foreign);
      writeFileSync(join(foreign, 'env-switcher-prefs.json'), '{"disabled":["staging"]}');
      expect((await readWorkspaceSetupHomes([], resolveRoot, active, parent)).roots.map(root => root.path)).toEqual([active]);
      symlinkSync(foreign, legacy);
      const result = await readWorkspaceSetupHomes([], resolveRoot, active, parent);
      expect(result.roots.map(root => root.path)).toEqual([active]);
      expect(result.declarations.some(entry => entry.name === 'env-switcher-prefs.json' && entry.root !== result.roots[0].id)).toBe(false);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });

  it('preserves the legacy host runtime home while leaving unrelated files and linked fallbacks unclassified', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'legacy-host-runtime-census-'));
    const hostHome = join(parent, 'host');
    const legacy = join(hostHome, '.papercusp');
    const active = join(parent, 'active');
    const foreign = join(parent, 'foreign');
    const resolveRoot = (workspace: string) => join(parent, 'registry', workspace, '.papercusp');
    try {
      mkdirSync(active, { recursive: true });
      for (const directory of [legacy, foreign]) {
        mkdirSync(join(directory, 'crash-reports'), { recursive: true });
        writeFileSync(join(directory, 'crash-reports', 'report.json'), 'retained diagnostic');
        mkdirSync(join(directory, 'snapshot-fold-checkpoints'), { recursive: true });
        writeFileSync(join(directory, 'snapshot-fold-checkpoints', 'checkpoint.json'), 'retained checkpoint');
        mkdirSync(join(directory, 'deploy-credentials', '.codex-setup-account-1234abcd'), { recursive: true });
        writeFileSync(join(directory, 'deploy-credentials', '.codex-setup-account-1234abcd', 'auth.json'), 'opaque');
        writeFileSync(join(directory, 'deploy-credentials', 'unproven.json'), 'unproven credential');
        writeFileSync(join(directory, 'foreign-source.ts'), 'unrelated sibling');
        setEnvEnabled('staging', false, { filePath: join(directory, 'env-switcher-prefs.json') });
      }
      const result = await readWorkspaceSetupHomes([], resolveRoot, active, hostHome);
      expect(result.roots.map(root => root.path)).toEqual([active, legacy]);
      const legacyId = result.roots[1].id;
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      expect(census.inventory.find(entry => entry.root === legacyId && entry.name === 'crash-reports/report.json'))
        .toMatchObject({ classification: 'state', producers: ['fatal-diagnostics'] });
      expect(census.inventory.find(entry => entry.root === legacyId && entry.name === 'snapshot-fold-checkpoints/checkpoint.json'))
        .toMatchObject({ classification: 'state', producers: ['hyperbee-own-compaction'] });
      expect(census.inventory.find(entry => entry.root === legacyId && entry.name.endsWith('/auth.json')))
        .toMatchObject({ classification: 'secret' });
      expect(census.inventory.find(entry => entry.root === legacyId && entry.name === 'env-switcher-prefs.json'))
        .toMatchObject({ classification: 'config', producers: ['env-switcher-prefs'] });
      expect(census.residue.map(entry => entry.name).sort()).toEqual(['deploy-credentials/unproven.json', 'foreign-source.ts']);
      expect(census.ok).toBe(false);
      const alreadyActive = await readWorkspaceSetupHomes([], resolveRoot, legacy, hostHome);
      expect(alreadyActive.roots.map(root => root.path)).toEqual([legacy]);
      rmSync(legacy, { recursive: true });
      symlinkSync(foreign, legacy);
      expect((await readWorkspaceSetupHomes([], resolveRoot, active, hostHome)).roots.map(root => root.path))
        .toEqual([active]);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });

  it('keeps environment preferences in registered workspaces without claiming host logs or lookalikes', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'workspace-runtime-files-census-'));
    try {
      const active = join(parent, 'active');
      const inactive = join(parent, 'inactive');
      const unknown = ['env-switcher-prefs.json.bak', 'gateway.log', 'gateway.log.1', 'gateway.log.2', 'gateway.log.backup'];
      for (const home of [active, inactive, join(parent, 'unregistered')]) {
        mkdirSync(home, { recursive: true });
        setEnvEnabled('staging', false, { filePath: join(home, 'env-switcher-prefs.json') });
        for (const name of unknown) writeFileSync(join(home, name), 'unproven sibling');
      }
      const result = await readWorkspaceSetupHomes([{ id: 'inactive' }, { id: 'inactive' }],
        workspace => join(parent, workspace), active, parent);
      expect(result.roots.map(root => root.path)).toEqual([active, inactive]);
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      for (const root of result.roots) {
        expect(census.inventory.filter(entry => entry.root === root.id && entry.classification === 'config'))
          .toEqual([expect.objectContaining({ name: 'env-switcher-prefs.json', producers: ['env-switcher-prefs'] })]);
        expect(census.inventory.filter(entry => entry.root === root.id && entry.classification === 'state')).toEqual([]);
        expect(census.residue.filter(entry => entry.root === root.id).map(entry => entry.name).sort())
          .toEqual(unknown.sort());
        expect(JSON.parse(readFileSync(join(root.path, 'env-switcher-prefs.json'), 'utf8')))
          .toEqual({ disabled: ['staging'] });
      }
      expect(result.declarations.every(entry => !entry.prune)).toBe(true);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });

  it('retains credential references from inactive workspace pools and fails on an unreadable pool', async () => {
    const readPool = vi.fn(async (workspace: string) => ({ accounts: [
      { credentialRef: `token:/fixture/${workspace}/credential` },
    ] }));
    expect(await readWorkspaceCensusAccounts([{ id: 'active' }, { id: 'inactive' }, { id: 'active' }], readPool))
      .toEqual([{ credentialRef: 'token:/fixture/active/credential' },
        { credentialRef: 'token:/fixture/inactive/credential' }]);
    expect(readPool.mock.calls).toEqual([['active'], ['inactive']]);
    await expect(readWorkspaceCensusAccounts([{ id: 'unreadable' }], async () => {
      throw new Error('pool unavailable');
    })).rejects.toThrow('pool unavailable');
    expect(await readWorkspaceCensusAccounts([], readPool)).toEqual([]);
    expect(await readWorkspaceCensusAccounts([])).toEqual([]);
    await expect(readWorkspaceCensusAccounts([{ id: 'active' }])).rejects.toThrow();
  });

  it('limits schema reads to exact source tables and preserves the overflow guard', async () => {
    const sources = [{ producer: 'fixture', tables: ['harness_shared.consult_state', 'public.records'] }];
    const matching = [{ table_schema: 'harness_shared', table_name: 'consult_state', column_name: 'routing', data_type: 'jsonb' }];
    const query = vi.fn(async (strings: TemplateStringsArray, tables: string[]) => {
      // A catalog with 20,001 unrelated columns must never enter the result.
      const catalog = [...matching, ...Array.from({ length: 20001 }, () => ({ table_schema: 'unrelated', table_name: 'records', column_name: 'id', data_type: 'text' }))];
      expect(strings.join('?')).toContain("(table_schema || '.' || table_name) = ANY(?)");
      expect(strings.join('?')).toContain('data_type, udt_schema, udt_name');
      return catalog.filter(row => tables.includes(`${row.table_schema}.${row.table_name}`));
    });
    expect(await readMigrationCensusColumns(query as never, sources)).toEqual(matching);
    expect(await readMigrationCensusColumns(query as never, [])).toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
    await expect(readMigrationCensusColumns(vi.fn(async () => Array(20001).fill(matching[0])) as never, sources))
      .rejects.toThrow('Database schema census bound exceeded');
  });
  it('root diagnostic explicitly reports partial scope and fails unknown filesystem ownership', async () => {
    const directory = fixtureHome;
    try {
      mkdirSync(join(directory, 'registry'));
      mkdirSync(join(directory, 'spills'));
      mkdirSync(join(directory, 'analysis-cache'));
      mkdirSync(join(directory, 'affected-cache'));
      writeFileSync(join(directory, 'affected-cache', 'unowned-cache-entry'), 'fixture');
      mkdirSync(join(directory, 'checkpoint-history'));
      mkdirSync(join(directory, '.config', 'papercusp'), { recursive: true });
      const peer = join(directory, 'registry', 'fixture', '.papercusp', 'harness', 'hyperbee');
      mkdirSync(join(peer, 'db'), { recursive: true });
      writeFileSync(join(pee
