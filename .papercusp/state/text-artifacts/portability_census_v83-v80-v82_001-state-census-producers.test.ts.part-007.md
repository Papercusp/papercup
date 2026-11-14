---
rel_path: "portability/census/v83-v80-v82/001-state-census-producers.test.ts.part-007"
updated_at: 1794268279628
_body: "content"
---

ile(join(packet, 'objects', saved.locator.manifest.ref), '{}', { mode: 0o600 });
          if (corruption === 'expected') await writeFile(join(packet, 'expected.json'), JSON.stringify({ identity: {}, expected: [] }));
          if (corruption === 'locator') await writeFile(join(packet, 'locator.json'), '{}');
          if (corruption === 'public-metadata') await chmod(join(packet, 'expected.json'), 0o644);
          if (corruption === 'missing-locator') await rm(join(packet, 'locator.json'));
          if (corruption === 'linked-packet') { await rename(packet, `${packet}-target`); await symlink(`${packet}-target`, packet); }
          if (corruption === 'linked-metadata') {
            await rename(join(packet, 'expected.json'), join(home, 'expected.json'));
            await symlink(join(home, 'expected.json'), join(packet, 'expected.json'));
          }
          expect((await native(home)).declarations).toEqual([]);
        } finally { await rm(home, { recursive: true, force: true }); }
      });
    it('preserves partial custody without treating it as native proof or acceptance', async () => {
      const home = await mkdtemp(join(tmpdir(), 'partial-native-census-'));
      try {
        const { saved } = await fixture(join(home, '.papercusp'), true);
        expect(saved.status).toBe('partial');
        expect(saved.manifest.verdicts).toMatchObject({ nativeProof: 'unqualified', acceptance: 'unmeasured' });
        expect((await native(home)).declarations.some(entry => entry.name.endsWith('/locator.json'))).toBe(true);
      } finally { await rm(home, { recursive: true, force: true }); }
    });
    it('preserves moved proof bytes while leaving changed original streams unresolved', async () => {
      const home = await mkdtemp(join(tmpdir(), 'moved-native-census-'));
      try {
        const { packet, container } = await fixture(join(home, '.papercusp'));
        await writeFile(join(packet, 'group-0.stdout'), 'changed original stream');
        let result = await native(home);
        expect(result.declarations.some(entry => entry.name.endsWith('/group-0.stdout'))).toBe(false);
        expect(result.declarations.some(entry => entry.name.endsWith('/group-0.stderr'))).toBe(true);
        await rename(container, `${container}-moved`);
        result = await native(home);
        expect(result.declarations.some(entry => entry.name.endsWith('/locator.json'))).toBe(true);
        expect(result.declarations.some(entry => entry.name.endsWith('/group-0.stderr'))).toBe(false);
      } finally { await rm(home, { recursive: true, force: true }); }
    });
    it('does not follow linked artifact containers or runtime homes', async () => {
      const home = await mkdtemp(join(tmpdir(), 'redirected-native-census-'));
      try {
        const runtimeHome = join(home, '.papercusp');
        const { container } = await fixture(runtimeHome);
        await rename(container, join(home, 'retained-container'));
        await symlink(join(home, 'retained-container'), container);
        expect((await native(home)).declarations).toEqual([]);
        await rename(runtimeHome, `${runtimeHome}-target`);
        await symlink(`${runtimeHome}-target`, runtimeHome);
        expect((await native(home)).declarations).toEqual([]);
      } finally { await rm(home, { recursive: true, force: true }); }
    });
  });
  it('retains runtime writer directories under the relocated active workspace without pruning credentials or diagnostics', async () => {
    const result = runtimeRetainedCensusProducer();
    expect(result.roots).toEqual([{ id: 'runtime-retained', path: '/relocated/workspaces/registered-project/.papercusp' }]);
    expect(result.declarations.map(entry => [entry.name, entry.classification, entry.prune])).toEqual([
      ['deploy-credentials', 'state', undefined], ['crash-reports', 'state', undefined], ['snapshot-fold-checkpoints', 'state', undefined],
      ['env-switcher-prefs.json', 'config', undefined],
    ]);
    const writers = [
      ['../deployment/account-link-cli.ts', "papercuspPath('deploy-credentials'"],
      ['../process-supervision/fatal-diagnostics.ts', "papercuspPath('crash-reports')"],
      ['../sync/hyperbee/boot.ts', "'snapshot-fold-checkpoints'"],
      ['../harness/env-switcher-prefs.ts', "const FILE = 'env-switcher-prefs.json'"],
    ];
    for (const [path, marker] of writers) expect(await readFile(new URL(path, import.meta.url), 'utf8')).toContain(marker);
    const installed = installedRootCensusProducers();
    expect(installed.declarations.find(entry => entry.producer === 'deployment-account-link')).toMatchObject({
      root: 'install-root-0', name: 'registered-project/.papercusp/deploy-credentials', classification: 'state',
    });
    expect(installed.declarations.find(entry => entry.producer === 'deployment-account-link')?.descendants).toBeUndefined();
  });
  it('uses the anchor producer path without resolving a backend or reading private key bytes', () => {
    expect(anchorSecretCensusProducer()).toEqual({ roots: [{ id: 'anchor-key-parent', path: '/fixture/sensitive' }],
      declarations: [{ kind: 'path', root: 'anchor-key-parent', name: 'anchor-key', classification: 'secret', producer: 'ledger-anchor-key' }] });
  });
  it('retains the keychain writer directory as sensitive state without pruning it', () => {
    expect(identityKeychainCensusProducer()).toEqual({ roots: [{ id: 'identity-keychain-parent', path: '/fixture/sensitive' }],
      declarations: [{ kind: 'path', root: 'identity-keychain-parent', name: 'identity', classification: 'secret', producer: 'identity-keychain', descendants: true }] });
  });
  it('derives retained database schema footprints from literal migration arrays without executing source', () => {
    const tables = migrationProducerTables('// CREATE TABLE fake (id text)\nexport const APP_MIGRATIONS = [`CREATE TABLE IF NOT EXISTS records (id text)`, `CREATE TABLE receipts (id text)`] as const;\nthrow new Error("must not execute");');
    expect(tables).toEqual(['public.records', 'public.receipts']);
    const entry = { kind: 'database' as const, root: 'postgres-cluster:123', name: 'arbitrary' };
    const sources = [{ producer: 'fixture:migrations', tables }];
    expect(migrationDatabaseCensusDeclarations(entry, ['public.records'], sources)).toEqual([]);
    expect(migrationDatabaseCensusDeclarations(entry, tables, sources)[0]).toMatchObject({ name: 'arbitrary', classification: 'state', producer: 'fixture:migrations' });
    expect(migrationDatabaseCensusDeclarations(entry, tables, [{ producer: 'fixture:migrations', tables: [...tables, 'public.new_feature'] }])[0])
      .toMatchObject({ classification: 'state', producer: 'fixture:migrations:migration-prefix:2/3' });
  });
  it('retains canonical consult schema only with matching column names and types', async () => {
    const source = (await canonicalSqlMigrationCensusSources()).find(source => source.producer === 'canonical-sql-migration:834-consult-threads.sql');
    expect(source).toBeDefined();
    expect(source!.tables).toEqual(['harness_shared.consult_state', 'harness_shared.consult_post_meta']);
    const entry = { kind: 'database' as const, root: 'postgres-cluster:123', name: 'arbitrary' };
    const columns = source!.columns!;
    expect(migrationDatabaseCensusDeclarations(entry, source!.tables, [source!], columns)[0])
      .toMatchObject({ classification: 'state', producer: source!.producer });
    expect(migrationDatabaseCensusDeclarations(entry, source!.tables, [source!])).toEqual([]);
    expect(migrationDatabaseCensusDeclarations(entry, source!.tables, [source!], columns.filter(column => column.name !== 'routing'))).toEqual([]);
    expect(migrationDatabaseCensusDeclarations(entry, source!.tables, [source!], columns.map(column => column.name === 'routing' ? { ...column, type: 'text' } : column))).toEqual([]);
    expect(migrationDatabaseCensusDeclarations(entry, source!.tables.map(table => table.replace('harness_shared.', 'public.')), [source!], columns)).toEqual([]);
    expect(migrationDatabaseCensusDeclarations(entry, source!.tables, [source!], [...columns, { table: source!.tables[0], name: 'dispatch_attempts', type: 'integer' }])[0]?.classification).toBe('state');
  });
  it('ignores SQL prose and rejects unsupported or unterminated schema evidence', () => {
    expect(sqlMigrationCensusSource("-- CREATE TABLE fake.first (id text);\nSELECT $$CREATE TABLE fake.second (id text);$$;", 'fixture')).toBeNull();
    expect(sqlMigrationCensusSource('CREATE TABLE x.first (id text); CREATE TABLE x.second (id unsupported);', 'fixture')).toBeNull();
    expect(sqlMigrationCensusSource('CREATE TABLE x.first (id text); CREATE TABLE x.second (id text', 'fixture')).toBeNull();
    expect(sqlMigrationCensusSource("CREATE TABLE x.first (id text DEFAULT 'a,b)'); CREATE TABLE x.second (id bigint, CHECK (id > 0));", 'fixture')?.tables).toEqual(['x.first', 'x.second']);
  });
  it('matches declared enum identities and rejects missing, wrong-case or wrong-schema metadata', () => {
    const source = sqlMigrationCensusSource('CREATE TYPE public."Role" AS ENUM(\'BUYER\'); CREATE TABLE first (role public."Role"); CREATE TABLE second (role public."Role" NOT NULL);', 'enum');
    expect(source?.columns).toHaveLength(2);
    expect(source?.columns?.[0]).toMatchObject({ type: 'USER-DEFINED', udtSchema: 'public', udtName: 'Role' });
    const entry = { kind: 'database' as const, root: 'postgres-cluster:123', name: 'app' };
    expect(migrationDatabaseCensusDeclarations(entry, source!.tables, [source!], source!.columns)).toHaveLength(1);
    for (const patch of [{ udtName: 'role' }, { udtSchema: 'other' }, { udtName: undefined }, { type: 'text' }]) {
      expect(migrationDatabaseCensusDeclarations(entry, source!.tables, [source!], source!.columns!.map(column => ({ ...column, ...patch })))).toEqual([]);
    }
    expect(sqlMigrationCensusSource('CREATE TABLE first (id text); CREATE TABLE second (role "Role");', 'missing')).toBeNull();
    expect(sqlMigrationCensusSource('CREATE TABLE first (id text[]); CREATE TABLE second (id text);', 'array')).toBeNull();
    expect(sqlMigrationCensusSource('CREATE TABLE first (id timestamp nonsense); CREATE TABLE second (id text);', 'unsupported')).toBeNull();
  });
  it('distinguishes timestamp zones and matches double precision metadata', () => {
    const source = sqlMigrationCensusSource('CREATE TABLE "Records" ("Created" timestamp without time zone, score double precision); CREATE TABLE receipts (created timestamp, received timestamptz, updated timestamp with time zone);', 'drizzle');
    expect(source?.columns?.map(column => column.type)).toEqual([
      'timestamp without time zone', 'double precision', 'timestamp without time zone',
      'timestamp with time zone', 'timestamp with time zone',
    ]);
    const entry = { kind: 'database' as const, root: 'postgres-cluster:123', name: 'app' };
    expect(migrationDatabaseCensusDeclarations(entry, source!.tables, [source!], source!.columns)).toHaveLength(1);
    expect(migrationDatabaseCensusDeclarations(entry, source!.tables, [source!], source!.columns!.map(column =>
      column.name === 'Created' ? { ...column, type: 'timestamp with time zone' } : column))).toEqual([]);
    expect(migrationDatabaseCensusDeclarations(entry, source!.tables, [source!], source!.columns!.map(column =>
      column.name === 'score' ? { ...column, type: 'real' } : column))).toEqual([]);
  });
  it('preserves quoted identifier case while rejecting SQL-looking identifier prose', () => {
    const source = sqlMigrationCensusSource('CREATE TABLE "Records" ("Id" text); CREATE TABLE public."Receipts" (id bigint);', 'quoted');
    expect(source?.tables).toEqual(['public.Records', 'public.Receipts']);
    expect(source?.columns).toEqual([{ table: 'public.Records', name: 'Id', type: 'text' }, { table: 'public.Receipts', name: 'id', type: 'bigint' }]);
    const entry = { kind: 'database' as const, root: 'postgres-cluster:123', name: 'app' };
    expect(migrationDatabaseCensusDeclarations(entry, source!.tables, [source!], source!.columns)).toHaveLength(1);
    expect(migrationDatabaseCensusDeclarations(entry, source!.tables.map(name => name.toLowerCase()), [source!], source!.columns)).toEqual([]);
    expect(sqlMigrationCensusSource('SELECT "CREATE TABLE x.first (id text); CREATE TABLE x.second (id text)";', 'spoof')).toBeNull();
    expect(sqlMigrationCensusSource('/* outer /* CREATE TABLE x.first (id text) */ CREATE TABLE x.second (id text) */', 'spoof')).toBeNull();
  });
  it.skipIf(process.getuid?.() === 0)('does not classify unreadable installed source roots or abort readable source discovery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'unreadable-migration-census-'));
    const privateRoot = join(directory, 'private');
    const app = join(directory, 'app');
    try {
      await mkdir(privateRoot);
      await mkdir(join(app, 'drizzle'), { recursive: true });
      await writeFile(join(app, 'drizzle.config.ts'), "export default defineConfig({ out: './drizzle' });");
      await writeFile(join(app, 'drizzle/0000.sql'), 'CREATE TABLE public.first (id text); CREATE TABLE public.second (id text);');
      await chmod(privateRoot, 0);
      const sources = await registeredProjectMigrationSources([{ slug: 'private', path: privateRoot }, { slug: 'app', path: app }]);
      expect(sources).toHaveLength(1);
      expect(sources[0].producer).toContain('registry:app:');
    } finally { await chmod(privateRoot, 0o700); await rm(directory, { recursive: true, force: true }); }
  });
  it('discovers registered sibling migrations while excluding linked and missing sources', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'registered-migration-census-'));
    try {
      const app = join(directory, 'sibling');
      const linked = join(directory, 'linked');
      for (const path of [app, linked]) await mkdir(join(path, 'packages/data/src'), { recursive: true });
      const source = join(app, 'packages/data/src/migrations.ts');
      await writeFile(source, 'export const CALENDAR_MIGRATIONS = [`CREATE TABLE calendars (id text)`, `CREATE TABLE calendar_events (id text)`]; throw new Error("must not execute");');
      await symlink(source, join(linked, 'packages/data/src/migrations.ts'));
      const result = await registeredProjectMigrationSources([
        { slug: 'calendar', path: app }, { slug: 'duplicate', path: app },
        { slug: 'linked', path: linked }, { slug: 'missing', path: join(directory, 'absent') },
      ]);
      expect(result).toEqual([{ producer: `app-migrations:registry:calendar:${app}`, tables: ['public.calendars', 'public.calendar_events'] }]);
      expect(migrationDatabaseCensusDeclarations({ kind: 'database', root: 'postgres-cluster:123', name: 'calendar_app' }, result[0].tables, result)[0])
        .toMatchObject({ classification: 'state', producer: result[0].producer });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('proves an older migration schema after an earlier table insertion from exact-path Git history', async () => {
    const app = await mkdtemp(join(tmpdir(), 'historical-migration-census-'));
    try {
      const git = (...args: string[]) => execFileSync('git', ['-C', app, ...args]);
      const name = 'packages/data/src/migrations.ts';
      await mkdir(join(app, 'packages/data/src'), { recursive: true });
      const old = 'export const APP_MIGRATIONS = [`CREATE TABLE calls (id text, search_document tsvector)`, `CREATE TABLE segments (id text)`];';
      await writeFile(join(app, name), old);
      await writeFile(join(app, 'unrelated.ts'), 'export const APP_MIGRATIONS = [`CREATE TABLE impostor (id text)`, `CREATE TABLE unrelated (id text)`];');
      git('init', '-q');
      git('add', '.');
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'old');
      const blob = git('rev-parse', `HEAD:${name}`).toString().trim();
      await writeFile(join(app, name), old.replace('`, `CREATE TABLE segments', '`, `CREATE TABLE preparations (id text)`, `CREATE TABLE segments'));
      git('add', '.');
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'insert earlier table');
      const sources = await registeredProjectMigrationSources([{ slug: 'app', path: app }]);
      const entry = { kind: 'database' as const, root: 'postgres-cluster:123', name: 'arbitrary' };
      const tables = ['public.calls', 'public.segments'];
      const columns = [{ table: tables[0], name: 'id', type: 'text' },
        { table: tables[0], name: 'search_document', type: 'tsvector' },
        { table: tables[1], name: 'id', type: 'text' }];
      expect(migrationDatabaseCensusDeclarations(entry, tables, [sources[0]], columns)).toEqual([]);
      expect(migrationDatabaseCensusDeclarations(entry, tables, sources, columns)).toEqual([
        { ...entry, classification: 'state', producer: `app-migrations:registry:app:${app}:git-blob:${blob}:${name}` },
      ]);
      expect(migrationDatabaseCensusDeclarations(entry, tables, sources, columns.slice(1))).toEqual([]);
      expect(migrationDatabaseCensusDeclarations(entry, ['public.impostor', 'public.unrelated'], sources, columns)).toEqual([]);
      // A linked current source cannot confer access to any historical schema.
      await rm(join(app, name));
      await symlink(join(app, 'unrelated.ts'), join(app, name));
      expect(await registeredProjectMigrationSources([{ slug: 'linked', path: app }])).toEqual([]);
      expect(migrationProducerTables('export const APP_MIGRATIONS = [`CREATE TABLE a (id text)`, ...extra, `CREATE TABLE b (id text)`]')).toEqual([]);
    } finally { await rm(app, { recursive: true, force: true }); }
  });
  it('discovers literal Drizzle SQL from registered and installed-unit roots without executing config', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'drizzle-census-'));
    try {
      const app = join(directory, 'app');
      await mkdir(join(app, 'drizzle'), { recursive: true });
      const config = join(app, 'drizzle.config.ts');
      await writeFile(config, "export default defineConfig({ out: './drizzle' }); throw new Error('must not execute');");
      await writeFile(join(app, 'drizzle/0000_init.sql'), 'CREATE TABLE "Records" ("Id" text); CREATE TABLE "Receipts" (id bigint);');
      await writeFile(join(directory, 'app.service'), `[Unit]\nWorkingDirectory=/not/source\n[Service]\nWorkingDirectory=${app}\nEnvironmentFile=/must/not/read\n`);
      const units = await unitCensusDeclarations(directory, 'user');
      const registered = await registeredProjectMigrationSources([{ slug: 'app', path: app }]);
      expect(registered[0]?.tables).toEqual(['public.Records', 'public.Receipts']);
      const installed = await registeredProjectMigrationSources([], units);
      expect(installed[0]?.tables).toEqual(registered[0].tables);
      expect(installed[0]?.producer).toContain('unit:systemd-user:app.service');
      for (const out of ["process.env.OUT", "'../outside'", "'./linked'", "'./drizzle', ...overrides"]) {
        await writeFile(config, `export default defineConfig({ out: ${out} });`);
        expect(await registeredProjectMigrationSources([], units)).toEqual([]);
      }
      await symlink(join(app, 'drizzle'), join(app, 'linked'));
      await writeFile(config, "export default defineConfig({ out: './linked' });");
      expect(await registeredProjectMigrationSources([], units)).toEqual([]);
      await rm(config);
      await writeFile(join(directory, 'external-config.ts'), "export default defineConfig({ out: './drizzle' });");
      await symlink(join(directory, 'external-config.ts'), config);
      expect(await registeredProjectMigrationSources([], units)).toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('derives only active exact service environment files without reading their values', async () => {
    const home = await mkdtemp(join(tmpdir(), 'unit-env-census-'));
    try {
      const root = { id: 'state', path: join(home, '.papercusp') };
      await mkdir(root.path);
      for (const name of ['reset.env', 'wrong-section.env', 'private value.env', 'percent%.env', 'unproven.env']) {
        await writeFile(join(root.path, name), 'credential bytes are never parsed', { mode: 0o000 });
      }
      await writeFile(join(home, 'app.service'), `[Unit]\nEnvironmentFile=%h/.papercusp/wrong-section.env\n[Service]\nEnvironmentFile=%h/.papercusp/reset.env\nEnvironmentFile=\nEnvironmentFile="%h/.papercusp/private value.env"\nEnvironmentFile='%h/.papercusp/percent%%.env'\nEnvironmentFile=-%h/.papercusp/missing.env\nEnvironmentFile=%h/.papercusp/*.env\nEnvironmentFile=%h/.papercusp/%u.env\nEnvironmentFile=%h/.papercusp/unproven.env \\\nEnvironmentFile=%h/.papercusp/unproven.env\n`);
      const units = await unitCensusDeclarations(home, 'user');
      const declarations = await unitEnvironmentFileCensusDeclarations(units, [root], home);
      expect(declarations.map(entry => entry.name)).toEqual(['private value.env', 'percent%.env']);
      expect(declarations.every(entry => entry.classification === 'secret' && !entry.descendants)).toBe(true);
      expect(JSON.stringify(declarations)).not.toContain('credential bytes');
      const census = await collectStateCensus({ roots: [root], declarations, readCatalogs: async () => [] });
      expect(census.residue.map(entry => entry.name).sort()).toEqual(['reset.env', 'unproven.env', 'wrong-section.env']);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it('retains exact environment links but excludes linked parents, directories and out-of-root paths', async () => {
    const home = await mkdtemp(join(tmpdir(), 'unit-env-links-'));
    try {
      const root = { id: 'state', path: join(home, 'state') };
      const outside = join(home, 'outside');
      await mkdir(root.path); await mkdir(outside);
      await writeFile(join(outside, 'private.env'), 'must not be opened', { mode: 0o000 });
      await symlink(join(outside, 'private.env'), join(root.path, 'mounted.env'));
      await symlink(join(outside, 'missing.env'), join(root.path, 'dangling.env'));
      await symlink(outside, join(root.path, 'linked-parent'));
      await mkdir(join(root.path, 'directory.env'));
      const paths = [join(root.path, 'mounted.env'), join(root.path, 'dangling.env'),
        join(root.path, 'linked-parent', 'private.env'), join(root.path, 'directory.env'),
        join(outside, 'private.env'), join(root.path, '..', 'outside', 'private.env'), root.path];
      await writeFile(join(home, 'app.service'), `[Service]\n${paths.map(path => `EnvironmentFile=${path}`).join('\n')}\n`);
      const units = await unitCensusDeclarations(home, 'user');
      expect((await unitEnvironmentFileCensusDeclarations(units, [root], home)).map(entry => entry.name))
        .toEqual(['mounted.env', 'dangling.env']);
      expect(await readlink(join(root.path, 'mounted.env'))).toBe(join(outside, 'private.env'));
      expect(await unitEnvironmentFileCensusDeclarations([{ ...units[0], producer: 'forged' }], [root], home)).toEqual([]);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it('accepts same-name installed links without following aliases, masks or shadow definitions', async () => {
    const home = await mkdtemp(join(tmpdir(), 'unit-env-shadow-'));
    try {
      const root = { id: 'home', path: home };
      const shadow = join(home, 'shadow'); await mkdir(shadow);
      await writeFile(join(home, 'private.env'), 'private');
      const definition = '[Service]\nEnvironmentFile=%h/private.env\n';
      await writeFile(join(shadow, 'app.service'), definition);
      await symlink(join(shadow, 'app.service'), join(home, 'app.service'));
      const units = [...await unitCensusDeclarations(home, 'user'), ...await 
