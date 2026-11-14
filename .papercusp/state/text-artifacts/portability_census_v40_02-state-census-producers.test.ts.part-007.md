---
rel_path: "portability/census/v40/02-state-census-producers.test.ts.part-007"
updated_at: 1794240912951
_body: "content"
---

ymlink(join(directory, 'db-disk-history'), join(directory, 'missing-pg-papercusp-state'));
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
        await mkdir(snapshots, { recursive: true });
        for (const name of ['0123456789abcdef.json', '0123456789abcdef.json.123.tmp',
          '0123456789abcdef.json.bad.tmp', 'ABCDEF0123456789.json', 'unknown.json']) await writeFile(join(snapshots, name), '{}');
        await symlink(join(snapshots, 'unknown.json'), join(snapshots, '1111111111111111.json'));
        await mkdir(join(snapshots, '2222222222222222.json'));
        await mkdir(join(base, 'cache', 'transformers', 'Xenova', 'model'), { recursive: true });
        await writeFile(join(base, 'cache', 'transformers', 'Xenova', 'model', 'config.json'), '{}');
        await writeFile(join(base, 'cache', 'foreign'), 'unowned');
      }
      const defaults = await runtimeSidefileCensusProducer(home, {});
      expect(defaults.roots.every(root => root.path !== relocated)).toBe(true);
      expect(defaults.roots[0].path).toBe(ordinary);
      const result = await runtimeSidefileCensusProducer(home, { PAPERCUSP_HOME: relocated });
      expect(result.roots.map(root => root.path)).toContain(relocated);
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      for (const base of [ordinary, relocated]) {
        const root = result.roots.find(root => root.path === base)!;
        const names = result.declarations.filter(entry => entry.root === root.id).map(entry => entry.name);
        expect(names).toEqual(expect.arrayContaining(['cache/cochange-index/0123456789abcdef.json',
          'cache/cochange-index/0123456789abcdef.json.123.tmp', 'cache/transformers']));
        const residue = census.residue.filter(entry => entry.root === root.id).map(entry => entry.name);
        expect(residue).toEqual(expect.arrayContaining(['cache/foreign', 'cache/cochange-index/unknown.json',
          'cache/cochange-index/0123456789abcdef.json.bad.tmp', 'cache/cochange-index/ABCDEF0123456789.json',
          'cache/cochange-index/1111111111111111.json', 'cache/cochange-index/2222222222222222.json']));
        expect(census.inventory.find(entry => entry.root === root.id && entry.name === 'cache/transformers'))
          .toMatchObject({ classification: 'cache', producers: ['local-embedder-worker-cache'] });
        expect(census.inventory.some(entry => entry.name.endsWith('/config.json'))).toBe(false);
      }
      await rename(join(relocated, 'cache', 'transformers'), join(home, 'model-target'));
      await symlink(join(home, 'model-target'), join(relocated, 'cache', 'transformers'));
      await rename(join(relocated, 'cache', 'cochange-index'), join(home, 'snapshot-target'));
      await symlink(join(home, 'snapshot-target'), join(relocated, 'cache', 'cochange-index'));
      const linked = await runtimeSidefileCensusProducer(home, { PAPERCUSP_HOME: relocated });
      expect(linked.declarations.filter(entry => linked.roots.find(root => root.id === entry.root)?.path === relocated)).toEqual([]);
      await rename(join(relocated, 'cache'), join(home, 'cache-target'));
      await symlink(join(home, 'cache-target'), join(relocated, 'cache'));
      expect((await runtimeSidefileCensusProducer(home, { PAPERCUSP_HOME: relocated })).roots.some(root => root.path === relocated)).toBe(false);
      const hostWriter = await readFile(new URL('../code-intelligence/warm-cochange-index.ts', import.meta.url), 'utf8');
      expect(hostWriter).toContain("from '@papercusp/host-platform/home'");
      expect(hostWriter).toContain("papercuspPath('cache', 'cochange-index')");
      expect(hostWriter).toContain(".digest('hex').slice(0, 16)");
      expect(await readFile(new URL('../code-intelligence/warm-cochange-index.worker.ts', import.meta.url), 'utf8'))
        .toContain('`${snapshotPath}.${process.pid}.tmp`');
      const modelWriter = await readFile(new URL('../../../../libs/generic/memory/src/local-embedder-worker.script.mjs', import.meta.url), 'utf8');
      expect(modelWriter).toContain("process.env.PAPERCUSP_HOME || join(homedir(), '.papercusp')");
      expect(modelWriter).toContain("join(papercuspHome, 'cache', 'transformers')");
    } finally { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
  });
  it('inventories referenced auth and atomic refresh files without importing unrelated CLI state', async () => {
    const home = await mkdtemp(join(tmpdir(), 'account-census-'));
    try {
      await mkdir(join(home, 'build'));
      await mkdir(join(home, '__pycache__'));
      for (const name of ['auth.json', 'auth.json.123.tmp', 'auth.json.unknown.tmp', 'unknown']) await writeFile(join(home, name), 'must not read');
      await writeFile(join(home, 'build', 'template.ts'), 'source');
      await writeFile(join(home, '__pycache__', 'module.pyc'), 'bytecode');
      const result = await accountCredentialCensusProducer([{ credentialRef: `codex-cli:${home}` }, { credentialRef: `codex-cli:${home}` }, { credentialRef: 'keychain:external' }]);
      expect(result.declarations.map(entry => entry.name).sort()).toEqual(['auth.json', 'auth.json.123.tmp']);
      expect(result.declarations.every(entry => entry.classification === 'secret' && !entry.descendants && !entry.prune)).toBe(true);
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      expect(census.ok).toBe(true);
      expect(census.inventory.map(entry => entry.name).sort()).toEqual(['auth.json', 'auth.json.123.tmp']);
      const full = mergeNestedCensusRoots({ roots: [...result.roots, { id: 'installed', path: home }], declarations: result.declarations });
      expect(full.roots).toEqual([{ id: 'installed', path: home }]);
      expect((await collectStateCensus({ ...full, readCatalogs: async () => [] })).residue.map(entry => entry.name)).toContain('unknown');
      const writer = await readFile(new URL('../inference-gateway/codex-oauth-proxy.ts', import.meta.url), 'utf8');
      expect(writer).toContain('`${target}.${process.pid}.tmp`');
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it('retains exact databases and their live companions in registered durable Codex homes without changing bytes', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'codex-account-census-'));
    const name = 'account.name.codex-cli';
    const home = join(parent, 'deploy-credentials', name);
    const databases = ['state_5.sqlite', 'logs_2.sqlite', 'goals_1.sqlite', 'memories_1.sqlite',
      'memories_v2_1.sqlite', 'queue_1.sqlite', 'thread_history_1.sqlite'];
    const relativeNames = ['auth.json', 'auth.json.123.tmp', 'installation_id', ...databases.flatMap(file => [file, `${file}-wal`, `${file}-shm`])];
    try {
      await mkdir(home, { recursive: true });
      await writeFile(join(home, 'auth.json'), 'credential bytes must not be parsed');
      await writeFile(join(home, 'auth.json.123.tmp'), 'refresh credential');
      await writeFile(join(home, 'installation_id'), 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      for (const file of databases) {
        await writeFile(join(home, file), Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(84)]));
        for (const suffix of ['-wal', '-shm']) await writeFile(join(home, `${file}${suffix}`), `live ${suffix} bytes`);
      }
      const before = await Promise.all(relativeNames.map(file => readFile(join(home, file))));
      const result = await accountCredentialCensusProducer([{ credentialRef: `codex-cli:${home}` }, { credentialRef: `codex-cli:${home}` }]);
      expect(result.roots).toEqual([{ id: 'account-credential-0', path: dirname(home) }]);
      expect(result.declarations.map(entry => entry.name).sort()).toEqual([name, ...relativeNames.map(file => `${name}/${file}`)].sort());
      expect(result.declarations.filter(entry => entry.producer === 'codex-sqlite-runtime')).toHaveLength(21);
      expect(result.declarations.find(entry => entry.name === `${name}/installation_id`)?.classification).toBe('config');
      expect(result.declarations.filter(entry => entry.classification === 'secret')).toHaveLength(2);
      expect(result.declarations.every(entry => !entry.descendants && !entry.prune)).toBe(true);
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      expect(census.residue).toEqual([]);
      expect(await Promise.all(relativeNames.map(file => readFile(join(home, file))))).toEqual(before);
    } finally { aw
