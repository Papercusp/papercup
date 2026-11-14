---
rel_path: "portability/census/v83-v80-v82/001-state-census-producers.test.ts.part-009"
updated_at: 1794268279628
_body: "content"
---

ons('user', async () => ['relative'])).rejects.toThrow('Invalid systemd unit source paths');
      await expect(installedUnitCensusDeclarations('user', async () => { throw new Error('resolver unavailable'); }))
        .rejects.toThrow('resolver unavailable');
    } finally {
      vi.unstubAllEnvs();
      await rm(runtime, { recursive: true, force: true });
    }
  });
  it('uses the registry writer root without blanket-classifying sibling workspaces', () => {
    const producer = workspaceRegistryCensusProducer();
    expect(producer.roots).toEqual([{ id: 'workspace-registry', path: '/relocated/workspaces' }]);
    expect(producer.declarations).toEqual([{
      kind: 'path', root: 'workspace-registry', name: 'registry.json',
      classification: 'config', producer: 'workspace-registry',
    }, {
      kind: 'path', root: 'workspace-registry', name: 'registered-project',
      classification: 'state', producer: 'workspace-registry',
    }]);
  });
  it('verifies filesystem and all catalogs together and fails on a new host entry', async () => {
    const path = await mkdtemp(join(tmpdir(), 'host-census-'));
    try {
      await writeFile(join(path, 'config'), 'fixture');
      const declarations: CensusDeclaration[] = [
        { kind: 'path', root: 'home', name: 'config', classification: 'config', producer: 'fixture' },
        { kind: 'database', root: 'cluster', name: 'db', classification: 'state', producer: 'fixture' },
        { kind: 'unit', root: 'systemd-user', name: 'app.service', classification: 'config', producer: 'fixture' },
        { kind: 'secret', root: 'vault', name: 'key', classification: 'secret', producer: 'fixture' },
      ];
      const input = { roots: [{ id: 'home', path }], declarations,
        readDatabases: async () => declarations.filter(entry => entry.kind === 'database'),
        readUnits: async () => declarations.filter(entry => entry.kind === 'unit'),
        readSecrets: async () => declarations.filter(entry => entry.kind === 'secret'),
      };
      expect((await verifyHostStateCensus(input)).inventory).toHaveLength(4);
      await writeFile(join(path, 'unowned'), 'new state');
      await expect(verifyHostStateCensus(input)).rejects.toThrow('unclassified:path:home:unowned');
    } finally { await rm(path, { recursive: true, force: true }); }
  });
  it('inventories disabled installed units and distinguishes system/user scopes', async () => {
    const read = async () => '[{"unit_file":"backup.service","state":"disabled"}]';
    expect(await unitCensusEntries('user', read)).toEqual([
      { kind: 'unit', root: 'systemd-user', name: 'backup.service' },
    ]);
    expect((await unitCensusEntries('system', read))[0].root).toBe('systemd-system');
  });
  it('rejects malformed or failed unit catalogs instead of treating them as empty', async () => {
    for (const body of ['{}', '[{}]', 'not-json']) {
      await expect(unitCensusEntries('user', async () => body)).rejects.toThrow();
    }
    await expect(unitCensusEntries('user', async () => { throw new Error('systemd unavailable'); }))
      .rejects.toThrow('systemd unavailable');
  });
  it('inventories every returned database without silently classifying unexpected databases', async () => {
    const sql = vi.fn(async (_query: TemplateStringsArray) => [{ datname: 'papercusp' }, { datname: 'unexpected' }]);
    const entries = await databaseCensusEntries(sql as unknown as Sql, 'cluster-123');
    expect(entries).toEqual([
      { kind: 'database', root: 'cluster-123', name: 'papercusp' },
      { kind: 'database', root: 'cluster-123', name: 'unexpected' },
    ]);
    expect(sql.mock.calls[0][0].join('')).toContain('WHERE NOT datistemplate');
  });

  it('propagates catalog failures and refuses unqualified cluster identity', async () => {
    const sql = vi.fn(async () => { throw new Error('unavailable'); });
    await expect(databaseCensusEntries(sql as unknown as Sql, 'cluster-123')).rejects.toThrow('unavailable');
    await expect(databaseCensusEntries(sql as unknown as Sql, '')).rejects.toThrow('cluster identity');
  });
  it('uses producer-resolved paths rather than assuming secrets live in the default home', () => {
    vi.stubEnv('PAPERCUSP_OAUTH_STATE_KEY_FILE', '/mounted/secrets/oauth-key');
    vi.stubEnv('PAPERCUSP_CLAUDE_TOKEN_PATH', '/mounted/secrets/fleet-token');
    try {
      const result = secretCensusProducers();
      expect(result.roots.map(root => root.path)).toEqual(['/mounted/secrets', '/scoped/home', '/fixture/config/papercusp']);
      expect(result.declarations.map(entry => [entry.name, entry.classification, entry.producer]))
        .toEqual([['db-key', 'secret', 'db-encryption'], ['superuser-token', 'secret', 'superuser-token'],
          ['google-oauth-client.json', 'secret', 'google-oauth-desktop-client'],
          ['oauth-key', 'secret', 'oauth-state-signing-key'],
          ['fleet-token', 'secret', 'fleet-claude-token']]);
    } finally { vi.unstubAllEnvs(); }
  });
});

describe('OAuth signing-key census uses the real path resolver without loading keys', () => {
  it.each([undefined, '', ' \t '])('resolves a blank override (%j) through the relocated host home without creating it', async override => {
    const fixture = await mkdtemp(join(tmpdir(), 'oauth-key-census-'));
    const home = join(fixture, 'absent-home');
    vi.stubEnv('PAPERCUSP_HOME', home);
    vi.stubEnv('PAPERCUSP_OAUTH_STATE_KEY_FILE', override);
    try {
      const result = secretCensusProducers();
      const entry = result.declarations.find(row => row.producer === 'oauth-state-signing-key')!;
      expect(entry).toEqual({ kind: 'path', root: entry.root, name: 'oauth-state-key',
        classification: 'secret', producer: 'oauth-state-signing-key' });
      expect(result.roots.find(root => root.id === entry.root)?.path).toBe(home);
      await expect(lstat(home)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { vi.unstubAllEnvs(); await rm(fixture, { recursive: true, force: true }); }
  });

  it.each(['a'.repeat(64), '', 'not-a-valid-signing-key'])('classifies a relocated unreadable key without reading, repairing or exposing its contents (%#)', async contents => {
    const fixture = await mkdtemp(join(tmpdir(), 'oauth-key-census-'));
    const key = join(fixture, 'mounted-key');
    vi.stubEnv('PAPERCUSP_HOME', join(fixture, 'unused-home'));
    vi.stubEnv('PAPERCUSP_OAUTH_STATE_KEY_FILE', ` ${key} \t`);
    vi.stubEnv('PAPERCUSP_OAUTH_STATE_SECRET', 'environment-secret-must-not-appear-in-census');
    try {
      await writeFile(key, contents);
      await writeFile(join(fixture, 'unknown-key-sibling'), 'unowned');
      if (process.platform !== 'win32') {
        await chmod(key, 0);
        await expect(readFile(key)).rejects.toMatchObject({ code: 'EACCES' });
      }
      const before = await lstat(key);
      const result = secretCensusProducers();
      const entry = result.declarations.find(row => row.producer === 'oauth-state-signing-key')!;
      const root = result.roots.find(row => row.id === entry.root)!;
      expect(root.path).toBe(fixture);
      expect(entry.name).toBe('mounted-key');
      const census = await collectStateCensus({ roots: [root], declarations: [entry], readCatalogs: async () => [] });
      expect(census.inventory.find(row => row.name === 'mounted-key')).toMatchObject({
        classification: 'secret', producers: ['oauth-state-signing-key'], problem: null,
      });
      expect(census.residue.map(row => row.name)).toEqual(['unknown-key-sibling']);
      expect(await lstat(key)).toEqual(before);
      expect(JSON.stringify(result)).not.toContain('environment-secret-must-not-appear-in-census');
      if (contents) expect(JSON.stringify(result)).not.toContain(contents);
      await expect(lstat(join(fixture, 'unused-home'))).rejects.toMatchObject({ code: 'ENOENT' });
      await chmod(key, 0o600);
      expect(await readFile(key, 'utf8')).toBe(contents);
    } finally { vi.unstubAllEnvs(); await rm(fixture, { recursive: true, force: true }); }
  });

  it('declares an absent mounted key without creating the key or its parent', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'oauth-key-census-'));
    const mount = join(fixture, 'absent-mount');
    vi.stubEnv('PAPERCUSP_OAUTH_STATE_KEY_FILE', join(mount, 'signing.key'));
    try {
      const result = secretCensusProducers();
      const entry = result.declarations.find(row => row.producer === 'oauth-state-signing-key')!;
      expect(entry.name).toBe('signing.key');
      expect(result.roots.find(root => root.id === entry.root)?.path).toBe(mount);
      await expect(lstat(mount)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { vi.unstubAllEnvs(); await rm(fixture, { recursive: true, force: true }); }
  });
});

describe('fleet token census uses the real host token resolver without loading credentials', () => {
  it.each([undefined, ''])('keeps the default host token independent of a relocated workspace (%j)', override => {
    vi.stubEnv('PAPERCUSP_HOME', '/unused/relocated/workspace');
    vi.stubEnv('PAPERCUSP_CLAUDE_TOKEN_PATH', override);
    try {
      const result = secretCensusProducers();
      const entry = result.declarations.find(row => row.producer === 'fleet-claude-token')!;
      expect(entry).toEqual({ kind: 'path', root: entry.root, name: 'claude-token',
        classification: 'secret', producer: 'fleet-claude-token' });
      expect(result.roots.find(root => root.id === entry.root)?.path).toBe(join(homedir(), '.papercusp'));
    } finally { vi.unstubAllEnvs(); }
  });

  it.each(['sk-ant-oat01-retained-fixture', '', 'malformed-but-retained'])('retains an unreadable mounted token without reading or changing it (%#)', async contents => {
    const fixture = await mkdtemp(join(tmpdir(), 'fleet-token-census-'));
    const token = join(fixture, 'mounted-token');
    vi.stubEnv('PAPERCUSP_CLAUDE_TOKEN_PATH', token);
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'ambient-token-must-not-appear');
    try {
      await writeFile(token, contents);
      await writeFile(join(fixture, 'unowned-token-backup'), 'unowned');
      if (process.platform !== 'win32') {
        await chmod(token, 0);
        await expect(readFile(token)).rejects.toMatchObject({ code: 'EACCES' });
      }
      const before = await lstat(token);
      const result = secretCensusProducers();
      const entry = result.declarations.find(row => row.producer === 'fleet-claude-token')!;
      const root = result.roots.find(row => row.id === entry.root)!;
      expect(root.path).toBe(fixture);
      const census = await collectStateCensus({ roots: [root], declarations: [entry], readCatalogs: async () => [] });
      expect(census.inventory.find(row => row.name === 'mounted-token')).toMatchObject({
        classification: 'secret', producers: ['fleet-claude-token'], problem: null,
      });
      expect(census.residue.map(row => row.name)).toEqual(['unowned-token-backup']);
      expect(await lstat(token)).toEqual(before);
      expect(JSON.stringify(result)).not.toContain('ambient-token-must-not-appear');
      if (contents) expect(JSON.stringify(result)).not.toContain(contents);
      await chmod(token, 0o600);
      expect(await readFile(token, 'utf8')).toBe(contents);
    } finally { vi.unstubAllEnvs(); await rm(fixture, { recursive: true, force: true }); }
  });

  it('declares a missing mounted token without creating its directory or file', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'fleet-token-census-'));
    const mount = join(fixture, 'absent-mount');
    vi.stubEnv('PAPERCUSP_CLAUDE_TOKEN_PATH', join(mount, 'fleet-token'));
    try {
      const result = secretCensusProducers();
      const entry = result.declarations.find(row => row.producer === 'fleet-claude-token')!;
      expect(entry.name).toBe('fleet-token');
      expect(result.roots.find(row => row.id === entry.root)?.path).toBe(mount);
      await expect(lstat(mount)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { vi.unstubAllEnvs(); await rm(fixture, { recursive: true, force: true }); }
  });

  it('inventories the configured link without walking its target or creating a missing credential', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'fleet-token-census-'));
    const mount = join(fixture, 'mount');
    const target = join(fixture, 'absent-target');
    const token = join(mount, 'fleet-token');
    vi.stubEnv('PAPERCUSP_CLAUDE_TOKEN_PATH', token);
    try {
      await mkdir(mount);
      await symlink(target, token);
      const before = await lstat(token);
      const result = secretCensusProducers();
      const entry = result.declarations.find(row => row.producer === 'fleet-claude-token')!;
      const root = result.roots.find(row => row.id === entry.root)!;
      const census = await collectStateCensus({ roots: [root], declarations: [entry], readCatalogs: async () => [] });
      expect(census.inventory).toEqual([{ kind: 'path', root: root.id, name: 'fleet-token',
        classification: 'secret', producers: ['fleet-claude-token'], problem: null }]);
      expect(await lstat(token)).toEqual(before);
      await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { vi.unstubAllEnvs(); await rm(fixture, { recursive: true, force: true }); }
  });
});

