---
rel_path: "portability/census/v58/01-state-census-producers.test.ts.part-003"
updated_at: 1794252348729
_body: "content"
---

ir(snapshots, { recursive: true });
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
  it.each([
    ['API key file', (home: string) => `apikey:file:${join(home, 'selected')}`],
    ['API key home file', () => 'apikey:file:~/selected'],
    ['absolute file', (home: string) => join(home, 'selected')],
    ['home file', () => '~/selected'],
    ['legacy file', (home: string) => `file:${join(home, 'selected')}`],
    ['legacy home file', () => 'file:~/selected'],
    ['legacy token', (home: string) => `token:${join(home, 'selected')}`],
    ['legacy home token', () => 'token:~/selected'],
  ])('inventories an exact %s reference once and leaves unrelated siblings as residue', async (_label, reference) => {
    const home = await mkdtemp(join(tmpdir(), 'file-account-census-'));
    try {
      vi.stubEnv('HOME', home);
      await writeFile(join(home, 'selected'), 'opaque credential; not a JSON bundle');
      await writeFile(join(home, 'unrelated'), 'owner data');
      const credentialRef = reference(home);
      const result = await accountCredentialCensusProducer([{ credentialRef }, { credentialRef }]);
      expect(result.roots).toHaveLength(1);
      expect(result.roots[0]).toMatchObject({ path: home, fileNames: ['selected'] });
      expect(result.declarations).toEqual([{
        kind: 'path', root: result.roots[0].id, name: 'selected', classification: 'secret',
        producer: 'account-pool-credential-reference',
      }]);
      const selected = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      expect(selected.ok).toBe(true);
      expect(selected.inventory.map(entry => entry.name)).toEqual(['selected']);
      const full = mergeNestedCensusRoots({ roots: [...result.roots, { id: 'installed', path: home }], declarations: result.declarations });
      const census = await collectStateCensus({ ...full, readCatalogs: async () => [] });
      expect(census.inventory.find(entry => entry.name === 'selected')?.classification).toBe('secret');
      expect(census.residue.map(entry => entry.name)).toEqual(['unrelated']);
    } finally { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
  });
  it.each([
    'env:ACCOUNT_TOKEN', 'keychain:external', 'apikey:env:ACCOUNT_KEY', 'apikey:credentials',
    'relative', 'file:relative', 'token:relative', 'apikey:file:relative', 'unknown:/credential',
    'apikey:unknown:/credential', 'apikey:file:', 'apikey:env:invalid-name', 'codex-cli:',
  ])('declares no filesystem ownership for unsupported or non-file reference %s', async credentialRef => {
    expect(await accountCredentialCensusProducer([{ credentialRef }])).toEqual({ roots: [], declarations: [] });
  });
  it('surfaces credential directory IO failures after parsing a valid reference', async () => {
    const home = await mkdtemp(join(tmpdir(), 'credential-io-census-'));
    try {
      await writeFile(join(home, 'not-directory'), 'owner data');
      await expect(accountCredentialCensusProducer([
        { credentialRef: `apikey:file:${join(home, 'not-directory', 'nested', 'secret')}` },
      ])).rejects.toMatchObject({ code: 'ENOTDIR' });
    } finally { await rm(home, { recursive: true, force: true }); }
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
    } finally { await rm(parent, { recursive: true, force: true }); }
  });
  it('leaves unknown accounts, malformed databases, orphan companions, backups and links unresolved', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'codex-account-negative-'));
    const home = join(parent, 'deploy-credentials', 'known.codex-cli');
    try {
      await mkdir(home, { recursive: true });
      await writeFile(join(home, 'auth.json'), 'opaque');
      for (const file of ['state_5.sqlite', 'state_5.sqlite-wal', 'goals_1.sqlite-shm', 'state_6.sqlite',
        'state_5.sqlite.backup', 'installation_id', 'foreign.ts']) await writeFile(join(home, file), 'foreign bytes');
      await writeFile(join(parent, 'external.sqlite'), 'SQLite format 3\0');
      await symlink(join(parent, 'external.sqlite'), join(home, 'logs_2.sqlite'));
      await writeFile(join(home, 'logs_2.sqlite-wal'), 'orphan');
      await mkdir(join(home, 'memories_1.sqlite'));
      await mkdir(join(parent, 'deploy-credentials', 'unknown.codex-cli'));
      await writeFile(join(parent, 'deploy-credentials', 'unknown.codex-cli', 'state_5.sqlite'), 'SQLite format 3\0');
      const result = await accountCredentialCensusProducer([{ credentialRef: `codex-cli:${home}` }]);
      expect(result.declarations.map(entry => entry.name)).toEqual(['known.codex-cli', 'known.codex-cli/auth.json']);
      const direct = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      expect(direct.residue.map(entry => entry.name)).toEqual(expect.arrayContaining([
        'known.codex-cli/foreign.ts', 'unknown.codex-cli', 'unknown.codex-cli/state_5.sqlite',
      ]));
      const merged = mergeNestedCensusRoots({ roots: [...result.roots, { id: 'all', path: parent }], declarations: result.declarations });
      const census = await collectStateCensus({ ...merged, readCatalogs: async () => [] });
      expect(census.residue.map(entry => entry.name)).toEqual(expect.arrayContaining([
        'deploy-credentials/known.codex-cli/state_5.sqlite', 'deploy-credentials/known.codex-cli/state_5.sqlite-wal',
        'deploy-credentials/known.codex-cli/goals_1.sqlite-shm', 'deploy-credentials/known.codex-cli/logs_2.sqlite',
        'deploy-credentials/unknown.codex-cli/state_5.sqlite',
      ]));
      await rm(join(home, 'installation_id'));
      await symlink(join(parent, 'external.sqlite'), join(home, 'installation_id'));
      expect((await accountCredentialCensusProducer([{ credentialRef: `codex-cli:${home}` }])).declarations)
        .toEqual(result.declarations);
      await rename(home, `${home}.retained`);
      await symlink(`${home}.retained`, home);
      expect((await accountCredentialCensusProducer([{ credentialRef: `codex-cli:${home}` }])).declarations
        .some(entry => entry.producer === 'codex-sqlite-runtime' || entry.producer === 'account-link-cli-completed-home')).toBe(false);
    } finally { await rm(parent, { recursive: true, force: true }); }
  });
  it('does not treat an arbitrary referenced CLI home as a managed account container', async () => {
    const home = await mkdtemp(join(tmpdir(), 'external-codex-account-'));
    try {
      await writeFile(join(home, 'auth.json'), 'opaque');
      await writeFile(join(home, 'state_5.sqlite'), 'SQLite format 3\0');
      await writeFile(join(home, 'installation_id'), 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      const result = await accountCredentialCensusProducer([{ credentialRef: `codex-cli:${home}` }]);
      expect(result.roots[0].fileNames).toEqual(['auth.json']);
      expect(result.declarations.map(entry => entry.name)).toEqual(['auth.json']);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it('unions external references without allowing a selected parent to hide an installed child', () => {
    const result = mergeNestedCensusRoots({ roots: [
      { id: 'a', path: '/external', fileNames: ['auth.json'] },
      { id: 'b', path: '/external', fileNames: ['token'] },
      { id: 'child', path: '/external/installed' },
    ], declarations: [] });
    expect(result.roots).toEqual([
      { id: 'a', path: '/external', fileNames: ['auth.json', 'token'] },
      { id: 'child', path: '/external/installed' },
    ]);
  });
  it('recognizes exact affected-test cache writers without claiming unrelated files or symlinks', async () => {
    const home = await mkdtemp(join(tmpdir(), 'affected-cache-census-'));
    try {
      const directory = join(home, '.papercusp', 'cache');
      await mkdir(directory, { recursive: true });
      const ordinary = 'papercusp-affected-passing-verdicts-v2-0123456789abcdef.json';
      const committed = 'papercusp-affected-passing-verdicts-v2-committed-fedcba9876543210.json';
      await writeFile(join(directory, ordinary), '{}');
      await writeFile(join(directory, committed), '{}');
      for (const name of [ordinary, committed]) await writeFile(closureDigestManifestPath(join(directory, name)), '{}');
      const orphanSidecar = closureDigestManifestPath('papercusp-affected-passing-verdicts-v2-1111111111111111.json');
      await writeFile(join(directory, orphanSidecar), '{}');
      await writeFile(join(directory, 'unknown.json'), '{}');
      await writeFile(closureDigestManifestPath(join(directory, 'unknown.json')), '{}');
      await symlink(join(directory, 'unknown.json'), join(directory, 'papercusp-affected-passing-verdicts-v2-aaaaaaaaaaaaaaaa.json'));
      await symlink(join(directory, 'unknown.json'), closureDigestManifestPath(join(directory, 'papercusp-affected-passing-verdicts-v2-bbbbbbbbbbbbbbbb.json')));
      vi.stubEnv('AFFECTED_TASK_HISTORY_PATH', join(home, 'history', 'custom.json'));
      vi.stubEnv('AFFECTED_TASK_VERDICT_CACHE_PATH', join(home, 'verdict', 'custom.json'));
      vi.stubEnv('AFFECTED_PARTIAL_RESUME_CACHE_DIR', '');
      await mkdir(join(home, 'history'));
      await writeFile(join(home, 'history', 'custom.json'), '{}');
      await mkdir(join(home, 'verdict'));
      await writeFile(join(home, 'verdict', 'custom.json'), '{}');
      await writeFile(closureDigestManifestPath(join(home, 'verdict', 'custom.json')), '{}');
      const result = await affectedTestCacheCensusProducer(home);
      expect(result.declarations.map(entry => entry.name).sort()).toEqual(['custom.json', 'custom.json',
        closureDigestManifestPath('custom.json'), ordinary, committed,
        closureDigestManifestPath(ordinary), closureDigestManifestPath(committed), orphanSidecar].sort());
      expect(result.declarations.every(entry => entry.classification === 'cache' && !entry.descendants && !entry.prune)).toBe(true);
      expect(result.declarations.filter(entry => entry.producer === 'affected-tests-closure-manifest')).toHaveLength(4);
      expect(result.roots.map(root => root.path)).toContain(join(home, 'history'));
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      expect(census.inventory.find(entry => entry.name === 'custom.json.closure-manifest.json')?.classification).toBe('cache');
      expect(census.residue.map(entry => entry.name)).toEqual(expect.arrayContaining(['unknown.json', 'unknown.json.closure-manifest.json']));
      const writer = await readFile(new URL('../../../../scripts/affected-tests.mjs', import.meta.url), 'utf8');
      expect(writer).toContain('papercusp-affected-task-durations-v1.json');
      expect(writer).toContain('papercusp-affected-passing-verdicts-v2-${TASK_VERDICT_CACHE_ROOT_SCOPE}.json');
      const committedWriter = await readFile(new URL('../../../../scripts/lint-as-committed.mjs', import.meta.url), 'utf8');
      expect(committedWriter).toContain('papercusp-affected-passing-verdicts-v2-committed-${scope}.json');
    } finally { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
  });
  it.each([false, true])('censuses exact partial checkpoints with relocated=%s and preserves unrelated files', async (relocated) => {
    const home = await mkdtemp(join(tmpdir(), 'affected-partial-census-'));
    try {
      const directory = join(home, '.papercusp', 'cache');
      const partialDirectory = relocated ? join(home, 'partial') : directory;
      vi.stubEnv('AFFECTED_PARTIAL_RESUME_CACHE_DIR', relocated ? partialDirectory : '');
      vi.stubEnv('AFFECTED_TASK_HISTORY_PATH', join(directory, 'papercusp-affected-task-durations-v1.json'));
      vi.stubEnv('AFFECTED_TASK_VERDICT_CACHE_PATH', '');
      await mkdir(directory, { recursive: true });
      await mkdir(partialDirectory, { recursive: true });
      const checkpoint = partialTaskCheckpointPath(partialDirectory, '/repo', 'operator-core :: test');
      const unrelated = ['unknown.json', 'papercusp-affected-partial-v999-0123456789abcdef01234567.json',
        'papercusp-affected-partial-v1-not-a-scope.json'];
      await writeFile(checkpoint, '{}');
      for (const name of unrelated) await writeFile(join(partialDirectory, name), '{}');
      const linked = partialTaskCheckpointPath(partialDirectory, '/repo', 'linked');
      await symlink(checkpoint, linked);
      const result = await affectedTestCacheCensusProducer(home);
      expect(result.declarations.filter(entry => entry.producer === 'affected-tests-partial-checkpoint'))
        .toEqual([{ kind: 'path', root: expect.any(String), name: checkpoint.split('/').at(-1),
          classification: 'cache', producer: 'affected-tests-partial-checkpoint' }]);
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      expect(census.inventory.find(entry => entry.name === checkpoint.split('/').at(-1))?.classification).toBe('cache');
      expect(census.residue.map(entry => entry.name)).toEqual(expect.arrayContaining([...unrelated, linked.split('/').at(-1)]));
      expect(result.declarations.every(entry => !entry.descendants && !entry.prune)).toBe(true);
    } finally { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
  });
  it('leaves explicit cache symlinks and symlinked partial directories unclassified', async () => {
    const home = await mkdtemp(join(tmpdir(), 'affected-linked-cache-census-'));
    try {
      const target = join(home, 'target.json');
      const verdict = join(home, 'verdict.json');
      await writeFile(target, '{}');
      await symlink(target, verdict);
      await symlink(target, closureDigestManifestPath(verdict));
      const partialDirectory = join(home, 'partial-target');
      await mkdir(partialDirectory);
      await writeFile(partialTaskCheckpointPath(partialDirectory, '/repo', 'test'), '{}');
      const linkedDirectory = join(home, 'linked-partial');
      await symlink(partialDirectory, linkedDirectory);
      vi.stubEnv('AFFECTED_TASK_HISTORY_PATH', target);
      vi.stubEnv('AFFECTED_TASK_VERDICT_CACHE_PATH', verdict);
      vi.stubEnv('AFFECTED_PARTIAL_RESUME_CACHE_DIR', linkedDirectory);
      const result = await affectedTestCacheCensusProducer(home);
      expect(result.declarations.map(entry => entry.producer)).toEqual(['affected-tests-duration-history']);
    } finally { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
  });
  it('preserves real test-run packets in known homes and the pinned evidence root without claiming siblings', async () => {
    const home = await mkdtemp(join(tmpdir(), 'testing-evidence-census-'));
    const ordinary = join(home, '.papercusp');
    const registered = join(home, 'registered');
    const unregistered = join(home, 'unregistered');
    const environment = { PAPERCUSP_HOME: ordinary, VH_EVIDENCE_ROOT_BASE: join(home, 'offload') };
    try {
      const bases = [ordinary, registered, unregistered].map(directory =>
        defaultTestRunArtifactBase({ PAPERCUSP_HOME: directory }, home));
      bases.push(defaultTestRunArtifactBase(environment, home));
      const packets = bases.map((base, index) => new TestRunArtifactPacket(`fixture-${index}`, home, testRunDeadline(1000), base));
      for (const packet of packets) packet.write('proof.json', { opaque: 'retained fixture' });
      const before = await Promise.all(packets.map(packet => readFile(join(packet.paths.directory, 'proof.json'), 'utf8')));
      await writeFile(join(ordinary, 'test-artifacts', 'foreign.txt'), 'unproven sibling');
      await mkdir(join(ordinary, 'test-artifacts-copy'));
      await writeFile(join(ordinary, 'test-artifacts-copy', 'manifest.json'), '{}');
      const result = await runtimeSidefileCensusProducer(home, environment, [], [registered, registered]);
      const evidence = result.declarations.filter(entry => entry.producer === 'testing-run-retained-evidence');
      expect(evidence.filter(entry => entry.retainedSubtree)).toHaveLength(3);
      expect(evidence.every(entry => entry.classification === 'state' && !entry.prune)).toBe(true);
      expect(result.roots.some(root => root.path.startsWith(unregistered))).toBe(false);
      const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
      expect(census.representedSubtrees).toHaveLength(3);
      expect(census.residue.map(entry => entry.name).sort()).toEqual([
        'test-artifacts-copy', 'test-artifacts-copy/manifest.json', 'test-artifacts/foreign.txt',
      ]);
      expect(await Promise.all(packets.map(packet => readFile(join(packet.paths.directory, 'proof.json'), 'utf8')))).toEqual(before);
      expect(census.ok).toBe(false);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it('does not infer test evidence ownership through linked roots or absent directories', async () => {
    const home = await mkdtemp(join(tmpdir(), 'linked-testing-evidence-census-'));
    const ordinary = join(home, '.papercusp');
    const target = join(home, 'target');
    const owned = async () => (await runtimeSidefileCensusProducer(home, {})).declarations
      .filter(entry => entry.producer === 'testing-run-retained-evidence');
    try {
      await mkdir(ordinary);
      expect(await owned()).toEqual([]);
      await mkdir(join(target, 'testing-run'), { recursive: true });
      await symlink(target, join(ordinary, 'test-artifacts'));
      expect(await owned()).toEqual([]);
      await rm(join(ordinary, 'test-artifacts'));
      await mkdir(join(ordinary, 'test-artifacts'));
      await symlink(join(target, 'testing-run'), join(ordinary, 'test-artifacts', 'testing-run'));
      expect(await owned()).toEqual([]);
      await rm(join(ordinary, 'test-artifacts'), { recursive: true });
      await mkdir(join(ordinary, 'test-artifacts', 'testing-run'), { recursive: true });
      await rename(ordinary, `${ordinary}-retained`);
      await symlink(`${ordinary}-retained`, ordinary);
      expect(await owned()).toEqual([]);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  describe('source preview original census evidence', () => {
    const fixture = async (runtimeHome: string) => {
      const { archiveVerifierTaskEvidence } = await import('../../../../scripts/source-preview.mjs');
      const container = join(runtimeHome, 'test-artifacts');
      await mkdir(container, { recursive: true });
      const owned = await mkdtemp(join(dirname(runtimeHome), 'verifier-command-'));
      const receiptPath = join(container, 'arbitrary-name.json');
      const taskReceiptPath = `${receiptPath}.task.json`;
      const taskId = 'fixture-verifier-task';
      const receipt = writeVerifierTaskReceipt(owned, dirname(runtimeHome),
        { PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID: taskId }, taskReceiptPath);
      const runId = createHash('sha256').update(receiptPath).digest('hex');
      const evidenceRoot = join(runtimeHome, 'checkpoint-logs', `verifier-task-${taskId}`, runId);
      await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
      const manifestPath = join(evidenceRoot, 'manifest.json');
      await writeFile(taskReceiptPath, JSON.stringify({ ...receipt, cleanup: 'completed', evidenceManifestPath: manifestPath }) + '\n');
      const suffixes = ['', '.snapshot.txt', '.dependencies.json', '.dependencies.after.json', '.child.json', '.stdout.log', '.stderr.log', '.resources.jsonl', '.phases.jsonl'];
      for (const suffix of suffixes) await writeFile(`${receiptPath}${suffix}`, `writer output ${suffix}\n`, { mode: 0o600 });
      archiveVerifierTaskEvidence({ evidenceRoot, taskId, sourceCommit: 'a'.repeat(40), receiptPath,
        taskReceiptPath, phaseArchivePath: `${receiptPath}.phases.jsonl`, cleanup: 'completed', childExitCode: 0 });
      return { container, receiptPath, taskReceiptPath, evidenceRoot, manifestPath, suffixes };
    };
    const originals = async (home: string, runtimeHomes: string[] = []) => {
      const result = await runtimeSidefileCensusProducer(home, {}, [], runtimeHomes);
      return { ...result, declarations: result.declarations.filter(entry => entry.producer === 'source-preview-verifier-original') };
    };
    it('uses actual retained writer bytes in ordinary and registered homes, leaving unknown siblings unresolved', async () => {
      const home = await mkdtemp(join(tmpdir(), 'verifier-census-'));
      try {
        const first = await fixture(join(home, '.papercusp'));
        await fixture(join(home, 'registered'));
        await fixture(join(home, 'unregistered'));
        const unknown = join(first.container, 'request.json');
        await writeFile(unknown, 'unproven input');
        const before = await readFile(first.taskReceiptPath);
        const result = await originals(home, [join(home, 'registered')]);
        expect(result.declarations.filter(entry => entry.name.endsWith('.task.json'))).toHaveLength(2);
        expect(result.declarations.every(entry => entry.classification === 'state' && !entry.descendants && !entry.prune)).toBe(true);
        expect(result.roots.some(root => root.path === join(home, 'unregistered'))).toBe(false);
        for (const suffix of first.suffixes) expect(result.declarations.some(entry => entry.name === `test-artifacts/arbitrary-name.json${suffix}`)).toBe(true);
        const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
        expect(census.residue.some(entry => entry.name === 'test-artifacts/request.json')).toBe(true);
        expect(census.ok).toBe(false);
        expect(await readFile(first.taskReceiptPath)).toEqual(before);
      } finally { await rm(home, { recursive: true, force: true }); }
    });
    it.each(['missing-manifest', 'partial-bundle', 'retained-bytes', 'retained-task', 'manifest-task', 'manifest-run',
      'manifest-path', 'artifact-path', 'unknown-role', 'pending-task', 'linked-manifest', 'linked-retained', 'linked-root', 'linked-container'])
      ('rejects %s custody without adopting any originals', async corruption => {
        const home = await mkdtemp(join(tmpdir(), 'invalid-verifier-census-'));
        try {
          const f = await fixture(join(home, '.papercusp'));
          const manifest = JSON.parse(await readFile(f.manifestPath, 'utf8'));
          if (corruption === 'missing-manifest') await rm(f.manifestPath);
          if (corruption === 'partial-bundle') await rm(join(f.evidenceRoot, 'phases.jsonl'));
          if (corruption === 'retained-bytes') await writeFile(join(f.evidenceRoot, 'stdout.log'), 'corrupt');
          if (corruption === 'retained-task') {
            const bytes = Buffer.from((await readFile(f.taskReceiptPath, 'utf8')).replace('completed', 'deferred'));
            await writeFile(join(f.evidenceRoot, 'task.json'), bytes);
            manifest.artifacts['task.json'].sha256 = createHash('sha256').update(bytes).digest('hex');
            manifest.artifacts['task.json'].sizeBytes = bytes.length;
          }
          if (corruption === 'manifest-task') manifest.taskId = 'foreign-task';
          if (corruption === 'manifest-run') manifest.runId = 'f'.repeat(64);
          if (corruption === 'artifact-path') manifest.artifacts['source.json'].path = f.receiptPath;
          if (corruption === 'unknown-role') manifest.artifacts['request.json'] = manifest.artifacts['source.json'];
          if (['retained-task', 'manifest-task', 'manifest-run', 'artifact-path', 'unknown-role'].includes(corruption))
            await writeFile(f.manifestPath, JSON.stringify(manifest));
          if (corruption === 'manifest-path' || corruption === 'pending-task') {
            const receipt = JSON.parse(await readFile(f.taskReceiptPath, 'utf8'));
            if (corruption === 'manifest-path') receipt.evidenceManifestPath = join(home, 'manifest.json');
            else receipt.cleanup = 'pending';
            await writeFile(f.taskReceiptPath, JSON.stringify(receipt));
          }
          const link = async (path: string) => { await rename(path, `${path}-target`); await symlink(`${path}-target`, path); };
          if (corruption === 'linked-manifest') await link(f.manifestPath);
          if (corruption === 'linked-retained') await link(join(f.evidenceRoot, 'source.json'));
          if (corruption === 'linked-root') await link(f.evidenceRoot);
          if (corruption === 'linked-container') await link(f.container);
          expect((await originals(home)).declarations).toEqual([]);
        } finally { await rm(home, { recursive: true, force: true }); }
      });
    it.each(['changed', 'linked', 'missing'])('leaves %s originals unknown while retaining independently proven siblings', async corruption => {
      const home = await mkdtemp(join(tmpdir(), 'changed-verifier-census-'));
      try {
        const f = await fixture(join(home, '.papercusp'));
        const path = `${f.receiptPath}.stdout.log`;
        if (corruption === 'changed') await writeFile(path, 'changed stream');
        if (corruption === 'missing') await rm(path);
        if (corruption === 'linked') { await rename(path, `${path}-target`); await symlink(`${path}-target`, path); }
        const result = await originals(home);
        expect(result.declarations.some(entry => entry.name.endsWith('.stdout.log'))).toBe(false);
        expect(result.declarations.some(entry => entry.name.endsWith('.stderr.log'))).toBe(true);
      } finally { await rm(home, { recursive: true, force: true }); }
    });
  });
  describe('native router retained census evidence', () => {
    const fixture = async (runtimeHome: string, partial = false) => {
      const container = join(runtimeHome, 'test-artifacts', 'arbitrary-run-name');
      await mkdir(container, { recursive: true, mode: 0o700 });
      const packet = await mkdtemp(join(container, 'native-router-'));
      const identity = { workspace: 'fixture-workspace', harness: 'fixture', runId: 'fixture-run' };
      const auxiliary = ['stdout', 'stderr', 'command-exit.json'].map(role => ({
        role, state: 'produced' as const, path: join(packet, `group-0.${role}`),
      }));
      for (const entry of auxiliary) await writeFile(entry.path, entry.role === 'command-exit.json'
        ? JSON.stringify({ writer: 'router-owned-child-close', status: 0 }) : `retained ${entry.role}`, { mode: 0o600 });
      const expected: NativeCustodyGroup[] = [{ id: 'group-0', attempt: 'primary', selected: ['/fixture/test.ts'], runner: 'vitest',
        armed: false, out: null, cwd: '/fixture', auxiliary: partial
          ? [...auxiliary, { role: 'report', state: 'unavailable', reason: 'fixture-missing-report' }] : auxiliary }];
      const contract = { identity, expected };
      await writeFile(join(packet, 'expected.json'), JSON.stringify(contract), { mode: 0o600 });
      const saved = retainNativeProofPacket(packet, { ...contract,
        observations: [{ id: 'group-0', out: null, captureComplete: true }], execution: 'router-settled' });
      await writeFile(join(packet, 'locator.json'), JSON.stringify(saved.locator), { mode: 0o600 });
      return { packet, container, saved };
    };
    const native = async (home: string, runtimeHomes: string[] = []) => {
      const result = await runtimeSidefileCensusProducer(home, {}, [], runtimeHomes);
      return { ...result, declarations: result.declarations.filter(entry => entry.producer === 'test-file-native-router-custody') };
    };
    it('uses verified custody in ordinary and registered homes while preserving unknown neighbors', async () => {
      const home = await mkdtemp(join(tmpdir(), 'native-census-'));
      try {
        const runtimeHome = join(home, '.papercusp');
        const registered = join(home, 'registered');
        const first = await fixture(runtimeHome);
        await fixture(registered);
        const unregistered = join(home, 'unregistered');
        await fixture(unregistered);
        const unknown = [join(first.container, 'owner.txt'), join(first.packet, 'owner.txt'),
          join(first.packet, 'objects', 'unreferenced.json')];
        for (const path of unknown) await writeFile(path, 'unknown retained input', { mode: 0o600 });
        const before = await readFile(join(first.packet, 'expected.json'));
        const result = await native(home, [registered]);
        expect(result.roots.some(root => root.path === unregistered)).toBe(false);
        expect(result.declarations.every(entry => entry.classification === 'state' && !entry.descendants && !entry.prune)).toBe(true);
        const census = await collectStateCensus({ ...result, readCatalogs: async () => [] });
        for (const path of unknown) expect(census.residue.some(entry => path.endsWith(entry.name))).toBe(true);
        expect(census.inventory.filter(entry => entry.name.endsWith('/locator.json')).every(entry => entry.classification === 'state')).toBe(true);
        expect(census.inventory.filter(entry => entry.name.endsWith('/locator.json'))).toHaveLength(2);
        expect(await readFile(join(first.packet, 'expected.json'))).toEqual(before);
        expect(census.ok).toBe(false);
      } finally { await rm(home, { recursive: true, force: true }); }
    });
    it.each(['object', 'expected', 'locator', 'linked-packet', 'linked-metadata', 'public-metadata', 'missing-locator'])(
      'leaves %s evidence unresolved', async corruption => {
        const home = await mkdtemp(join(tmpdir(), 'invalid-native-census-'));
        try {
          const { packet, saved } = await fixture(join(home, '.papercusp'));
          if (corruption === 'object') await writeFile(join(packet, 'objects', saved.locator.manifest.ref), '{}', { mode: 0o600 });
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
     
